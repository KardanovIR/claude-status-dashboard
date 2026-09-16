import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hookInstallPath, settingsPath } from '../settings';
import { codexHookInstallPath, codexHooksPath } from '../codex';
import {
  BIN_NAMES,
  BOARD_URL_RE,
  agstatusJsonPath,
  boardBase,
  boardUrlCandidates,
  defaultStateDir,
  machineKey,
  machineLabel,
  machinePath,
  mergeAgstatusJson,
  publicId,
  readAgstatusJson,
  readMachine,
  resolveBins,
  resumeEnabled,
  writeMachine,
  type ConfigSource,
  type ResolvedValue,
} from './config';
import {
  installPrefix,
  launcherPath,
  launcherResolves,
  launcherStateDir,
  launcherTarget,
  layoutCliPath,
  readShim,
  removeLauncher,
  renderShim,
  scriptProblem,
  shimPath,
  usableLauncher,
  writeLauncher,
  writeShim,
} from './resume';
import type { MachineState } from './types';

/**
 * `agstatus listener install | uninstall | status | doctor` — the LaunchAgent
 * side of the Focus listener (docs/design/focus-protocol.md §5.4). The
 * installer is the only writer of `"focus": true`; it creates machine.json,
 * registers the LaunchAgent and prints exactly what the hook will now put on
 * the wire. Every launchctl call goes through an injectable exec so tests
 * never touch launchd; nothing here ever runs through a shell.
 */

export const LAUNCH_AGENT_LABEL = 'com.agstatus.listener';

/** Fixed system binary; never resolved via PATH. */
const LAUNCHCTL = '/bin/launchctl';

const NAME_FALLBACK = 'Mac';

export function plistPath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

const xml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export interface PlistOptions {
  label: string;
  /**
   * argv[0], and the whole reason the shim exists: launchd resolves this
   * against launchd's OWN default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) and
   * never against the `EnvironmentVariables.PATH` below — a program name whose
   * only directory was in that dict exits 78 (EX_CONFIG) without running,
   * proved with real `launchctl` probes. So this is always
   * `<prefix>/bin/agstatus`, an absolute path AgStatus owns, and never `node`.
   */
  program: string;
  args: string[];
  /**
   * The installer's PATH. It is still here because §5.1 resolves tools —
   * agtermctl, kitten, tmux, codex — inside the listener, and a LaunchAgent's
   * own PATH is only those four system directories. It does nothing whatever
   * for `program` above; nothing in this file should imply that it does.
   */
  path: string;
  logFile: string;
  /** Extra environment (e.g. AGSTATUS_STATE_DIR when the install ran with one). */
  env?: Record<string, string>;
}

/**
 * The LaunchAgent: RunAtLoad + KeepAlive, throttled restarts, stdout and
 * stderr into the listener log.
 *
 * KeepAlive + ThrottleInterval is also the self-heal: the shim resolves Node
 * at every start, so a `nvm install 22 && nvm uninstall 20` (or a `brew
 * upgrade node`) kills the running interpreter, launchd restarts the job 10 s
 * later, the shim finds the Node that exists now, and no reinstall is needed.
 * The plist used to name `.../v20.9.0/bin/node` here, which needed one.
 */
export function renderPlist(opts: PlistOptions): string {
  const argv = [opts.program, ...opts.args];
  const env: Record<string, string> = { PATH: opts.path, ...(opts.env ?? {}) };
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(opts.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argv.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`),
    '  </dict>',
    `  <key>StandardOutPath</key><string>${xml(opts.logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(opts.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

/** The ProgramArguments of a rendered plist, unescaped — what launchd would exec. */
export function plistProgramArguments(xmlText: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xmlText)?.[1] ?? '';
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  );
}

/** The `--url` the agent was installed with, when its plist carries one that is a board URL. */
export function plistUrlFlag(xmlText: string): string | undefined {
  const args = plistProgramArguments(xmlText);
  const at = args.indexOf('--url');
  const url = at === -1 ? undefined : args[at + 1];
  return url !== undefined && BOARD_URL_RE.test(url) ? url : undefined;
}

/**
 * A plist from before the launcher shim — which is every install up to 1.3.0,
 * and so the commonest state there is the day this ships. Its
 * ProgramArguments are `[<node>, <cli.js>, "listener", "run"]`: argv[0] is
 * whatever Node the install happened to run under, and the subcommand sits at
 * index 2. What this version writes is `[<prefix>/bin/agstatus, "listener",
 * "run"]`, with the subcommand at index 1 (design §5.4).
 *
 * The shapes are told apart by that index and by nothing else. Asking instead
 * whether argv[0] "looks like node" is a guess, and the cost of guessing
 * wrong is the entire report: read as new-style, an old plist points every
 * check in doctor at the user's node binary, which is then reported as a
 * launcher that is not 0700 and as an install with no entry point — on a
 * machine whose listener is running perfectly — while the one diagnosis worth
 * printing, that the plist itself is the old shape, never appears.
 */
function legacyPlist(argv: string[]): boolean {
  return argv[1] !== 'listener' && argv[2] === 'listener';
}

/** The installed plist's text, or undefined when there is none we can read. */
function readPlist(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
}
/**
 * argv-only process launch; `file` is always an absolute path from a fixed
 * table. `env`, when given, REPLACES this process's environment rather than
 * adding to it — the one caller that passes it is doctor's Node probe, which
 * has to run under the environment launchd hands the agent and not under this
 * shell's (see probeNode).
 */
export type Exec = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<ExecResult>;

const defaultExec: Exec = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, ...(env ? { env } : {}) }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

export interface ListenerCommandOptions {
  /** Label shown on the board (install only). */
  name?: string;
  /** Board URL override (install only). */
  url?: string;
  /** Also remove the session records, the log and the resume launcher (uninstall only). */
  purge?: boolean;
  /** `--no-resume` at install time: false writes `"resume": false`; undefined leaves the default (on). */
  resume?: boolean;
  log?: (line: string) => void;
  exec?: Exec;
  platform?: NodeJS.Platform;
  stateDir?: string;
  uid?: number;
  /** Compiled entry point the shim runs; defaults to this package's dist/cli.js. */
  cliPath?: string;
  /**
   * The Node baked into the shim as a *hint* — tried after `$AGSTATUS_NODE`
   * and before the well-known install locations, never the only answer.
   * Defaults to the Node running the install, which is the best guess there
   * is and costs nothing when it later disappears.
   */
  nodePath?: string;
}

interface Context {
  log: (line: string) => void;
  exec: Exec;
  platform: NodeJS.Platform;
  stateDir: string;
  uid: number;
}

const currentUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 0);

function context(opts: ListenerCommandOptions): Context {
  return {
    log: opts.log ?? console.log,
    exec: opts.exec ?? defaultExec,
    platform: opts.platform ?? process.platform,
    stateDir: opts.stateDir ?? defaultStateDir(),
    uid: opts.uid ?? currentUid(),
  };
}

const domain = (uid: number): string => `gui/${uid}`;
const serviceTarget = (uid: number): string => `${domain(uid)}/${LAUNCH_AGENT_LABEL}`;

type PickedUrl = { url: string; source: ConfigSource | 'flag' };

/**
 * The board this machine reports to. `--url` wins; otherwise the same
 * precedence the hook uses. When settings.json and the Codex hook name two
 * different boards there is no right answer, so refuse rather than guess.
 */
function pickBoardUrl(flag: string | undefined, log: (line: string) => void): PickedUrl | null {
  if (flag) {
    if (!BOARD_URL_RE.test(flag)) {
      log('✖ --url must be an http(s) URL without spaces or quotes.');
      return null;
    }
    return { url: flag, source: 'flag' };
  }
  const candidates = boardUrlCandidates();
  const settings = candidates.find((c) => c.source === 'settings');
  const codex = candidates.find((c) => c.source === 'codex');
  if (settings && codex && boardBase(settings.url) !== boardBase(codex.url)) {
    log('✖ Claude Code and Codex are configured for different boards:');
    log(`    ${settingsPath()}: ${settings.url}`);
    log(`    ${codexHooksPath()}: ${codex.url}`);
    log('  Re-run `agstatus init` so both point at one board, or pass --url <board> to choose.');
    return null;
  }
  const picked = candidates[0];
  if (!picked) {
    log('✖ No board URL configured — run `agstatus init` first, or pass --url <board>.');
    return null;
  }
  if (!BOARD_URL_RE.test(picked.url)) {
    log(`✖ The configured board URL (${describeSource(picked)}) is not a plain http(s) URL.`);
    return null;
  }
  return picked;
}

function describeSource(v: { source: ConfigSource | 'flag' }): string {
  switch (v.source) {
    case 'env':
      return 'CLAUDE_STATUS_URL in the environment';
    case 'settings':
      return settingsPath();
    case 'codex':
      return codexHooksPath();
    case 'file':
      return agstatusJsonPath();
    default:
      return '--url';
  }
}

/**
 * The settings.json or hooks.json board a `--url` disagrees with, if any:
 * the hook follows those files, so its machine id would not be the one
 * this listener answers to. A file that cannot be read is no disagreement.
 */
function urlDisagreement(picked: PickedUrl): ResolvedValue | undefined {
  if (picked.source !== 'flag') return undefined;
  let candidates: ResolvedValue[];
  try {
    candidates = boardUrlCandidates();
  } catch {
    return undefined;
  }
  const base = boardBase(picked.url);
  return candidates.find((c) => (c.source === 'settings' || c.source === 'codex') && boardBase(c.url) !== base);
}

/** Why resume is off, for the one line that says so — the env override outranks the file. */
const resumeOffReason = (): string =>
  process.env.AGSTATUS_RESUME === 'off'
    ? 'AGSTATUS_RESUME=off in this environment'
    : `"resume": false in ${agstatusJsonPath()}`;

/** The `EnvironmentVariables` dict of a rendered plist, unescaped. */
export function plistEnv(xmlText: string): Record<string, string> {
  const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xmlText)?.[1] ?? '';
  const env: Record<string, string> = {};
  for (const m of block.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    env[unxml(m[1])] = unxml(m[2]);
  }
  return env;
}

const unxml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * What resume looks like **to the listener that would act on a tap**, which
 * is not what this shell sees: the LaunchAgent's environment is the one the
 * installer baked into the plist, so `export AGSTATUS_RESUME=off` in a shell
 * rc does not reach it (design §11). The verdict is therefore the file, plus
 * the agent's own environment when there is an agent; `shellOnly` is the
 * case worth saying out loud — off here, on there.
 */
interface ResumeState {
  on: boolean;
  /** Why it is off, in the listener's terms. Empty when it is on. */
  reason: string;
  /** AGSTATUS_RESUME=off in this shell, while the installed agent does not carry it. */
  shellOnly: boolean;
  /** The state dir this install uses is one the launcher could never find again. */
  stateDirLost: boolean;
}

function resumeState(stateDir: string, platform: NodeJS.Platform): ResumeState {
  const plistText = readPlist(plistPath());
  const agentEnv = plistText ? plistEnv(plistText) : undefined;
  const envOff = process.env.AGSTATUS_RESUME === 'off';
  // With an agent installed its environment decides; without one, whatever
  // runs `listener run` inherits this shell's.
  const runtimeEnvOff = agentEnv ? agentEnv.AGSTATUS_RESUME === 'off' : envOff;
  let fileOff = false;
  try {
    fileOff = readAgstatusJson().resume === false;
  } catch {
    /* an unparseable file is not a "no"; doctor reports it separately */
  }
  const stateDirLost = !launcherResolves(stateDir, platform);
  const reason = fileOff
    ? `"resume": false in ${agstatusJsonPath()}`
    : runtimeEnvOff
      ? `AGSTATUS_RESUME=off in ${agentEnv ? "the LaunchAgent's environment" : 'this environment'}`
      : '';
  return { on: !fileOff && !runtimeEnvOff, reason, shellOnly: envOff && !runtimeEnvOff, stateDirLost };
}

/** Why AGSTATUS_RESUME in this shell says nothing about the running listener. Callers pad. */
const shellOnlyNote = (): string[] => [
  `AGSTATUS_RESUME=off is set in this shell, but the LaunchAgent's environment is the one`,
  `in ${plistPath()} — it does not apply to the running listener.`,
];

/**
 * Why a state directory of its own costs an install the Resume button: the
 * launcher carries one baked-in path — the shim — and is handed no
 * environment, so it reads the platform default whatever AGSTATUS_STATE_DIR
 * said at install.
 */
const stateDirNote = (stateDir: string): string[] => [
  'the resume launcher is handed no environment, so it would read',
  `${launcherStateDir()}, not ${stateDir} — Resume taps answer unsupported-host`,
];

/** The launcher as a directory entry, symlink and all — `existsSync` would call a dangling one missing. */
const launcherPresent = (dir: string): boolean =>
  fs.lstatSync(launcherPath(dir), { throwIfNoEntry: false }) !== undefined;

/**
 * Why `usableLauncher()` said no, in a phrase — undefined when it said yes.
 *
 * The launcher is two files, not one: the script itself and the shim its
 * single `exec` line delegates to (design §5.1), and "not 0700, not yours" is
 * only ever true of the first. Two of the three ways this can fail have
 * nothing to do with the launcher's own mode — a shim that went missing, and
 * the pre-shim launcher (`exec "<node>" "<cli.js>" listener resume-exec "$1"`)
 * that every install predating the shim still has on disk, 0700 and owned by
 * its user. Saying "not a 0700 regular file owned by you" of those is a
 * falsehood about a file the reader can go and `ls -l` themselves.
 */
function launcherProblem(dir: string): string | undefined {
  const own = scriptProblem(launcherPath(dir));
  if (own) return own;
  const shim = launcherTarget(dir);
  if (shim === undefined) {
    return 'not the one-line launcher this version writes (it predates the launcher shim)';
  }
  const trouble = scriptProblem(shim);
  return trouble ? `its shim ${shim} is ${trouble}` : undefined;
}

/**
 * A directory whose name carries a version, or a cache somebody else empties:
 * `_npx/<hash>`, `Cellar/<formula>/<version>`, `versions/node/<v>` and the
 * fnm/volta/n shapes of the same thing. The old check only knew `_npx` and
 * its remedy was `npm i -g agstatus`, which is wrong on an nvm machine —
 * there `npm root -g` is itself under `.nvm/versions/node/<v>`, so the advice
 * moved the CLI from one version-stamped directory into another. A warning,
 * never a refusal: the install works, it just does not survive an upgrade of
 * whatever owns that directory.
 */
const VERSIONED_SEG_RE = /^v?\d+(?:[._]\d+)+/;
/** Directory names whose children are one version each. */
const VERSION_PARENTS = ['node', 'node-versions', 'versions', 'image'];

function rottingPath(p: string): string | undefined {
  const seg = path.resolve(p).split(path.sep);
  if (seg.includes('_npx')) return 'the npx cache, which npm may clear at any time';
  const cellar = seg.indexOf('Cellar');
  if (cellar !== -1 && VERSIONED_SEG_RE.test(seg[cellar + 2] ?? '')) {
    return `a Homebrew cellar (${seg[cellar + 1]}/${seg[cellar + 2]}), which the next \`brew upgrade\` replaces`;
  }
  for (let i = 1; i < seg.length; i++) {
    if (VERSIONED_SEG_RE.test(seg[i]) && VERSION_PARENTS.includes(seg[i - 1])) {
      return `a Node version directory (${seg[i - 1]}/${seg[i]}), which goes when that Node is uninstalled`;
    }
  }
  return undefined;
}

/** The one documented way in, printed wherever a reinstall is the answer. */
const INSTALL_COMMAND = 'curl -fsSL https://agstatus.online/install.sh | sh';

/**
 * Pointing the agent at one particular Node. It is the *installer* that has
 * to be run with the variable, because the agent's environment is the plist's
 * dict and install() is the only thing that writes it — the same rule as
 * AGSTATUS_RESUME (design §11). `export AGSTATUS_NODE=…` in a shell rc
 * reaches every `agstatus` command the user types and nothing launchd starts,
 * which is why doctor used to be able to go green over an agent that went on
 * exiting 127.
 */
const NODE_OVERRIDE_COMMAND = 'AGSTATUS_NODE=/absolute/path/to/node agstatus listener install';

/** What to do about "no Node >= 18 here", in the two lines doctor prints for it. Callers pad. */
const nodeAdvice = (): string[] => [
  `— install Node, or name the one to use: ${NODE_OVERRIDE_COMMAND}`,
  "  (the installer copies it into the agent's environment; a shell variable never reaches launchd)",
];

const defaultCliPath = (): string => path.resolve(__dirname, '..', 'cli.js');

export async function install(opts: ListenerCommandOptions = {}): Promise<number> {
  const { log, exec, platform, stateDir, uid } = context(opts);
  if (platform !== 'darwin') {
    log('✖ The Focus listener v1 installs as a macOS LaunchAgent only.');
    log('  `agstatus listener run` still works anywhere, in the foreground.');
    return 1;
  }

  // Read and validate everything before the first write: a malformed
  // ~/.agstatus.json or settings.json throws here with nothing changed.
  const picked = pickBoardUrl(opts.url, log);
  if (!picked) return 1;
  const base = boardBase(picked.url);

  // Where this CLI lives decides where its shim goes: an installer layout
  // (`<prefix>/lib/agstatus/dist/cli.js`) puts the shim inside the artifact;
  // anything else falls back to $AGSTATUS_HOME/~/.agstatus, which still gives
  // launchd an absolute argv[0] we own. Rendered here, before the first write,
  // so a path the shim could not quote refuses the install with nothing done.
  const cliPath = opts.cliPath ?? defaultCliPath();
  const nodePath = opts.nodePath ?? process.execPath;
  const prefix = installPrefix(cliPath);
  try {
    renderShim(cliPath, nodePath);
  } catch (err) {
    log(`✖ ${(err as Error).message}`);
    return 1;
  }

  const existing = readMachine(stateDir);
  const hostname = os.hostname();
  let machineId = existing?.machineId;
  if (existing?.machineHost && existing.machineHost !== hostname) {
    log(`⚠ ${machinePath(stateDir)} was created on "${existing.machineHost}" — this looks like a copied`);
    log('  state directory, so a fresh machine id is being minted for this Mac.');
    machineId = undefined;
  }
  const name = machineLabel(opts.name || existing?.name, NAME_FALLBACK);
  const machine: MachineState = {
    machineId: machineId ?? crypto.randomUUID(),
    name,
    machineHost: hostname,
  };
  writeMachine(stateDir, machine);
  const id = publicId(machineKey(machine.machineId, base));

  // `--no-resume` is the only thing that writes the key: leaving it absent is
  // what keeps resume on by default (design §11).
  const patch: Record<string, unknown> = { focus: true, url: picked.url };
  if (opts.resume === false) patch.resume = false;
  mergeAgstatusJson(patch);
  const resumeOn = resumeEnabled();

  const logFile = path.join(stateDir, 'listener.log');

  // The shim first: it is argv[0] of the LaunchAgent below and the one path
  // the resume launcher interpolates, so nothing that names it may be written
  // before it exists. Failing to write it is fatal — an agent whose argv[0]
  // is missing exits 78 at every launch and says nothing.
  let shim: string;
  try {
    shim = writeShim(prefix, cliPath, nodePath);
  } catch (err) {
    log(`✖ Could not write the launcher ${shimPath(prefix)}: ${(err as Error).message}`);
    log('  Nothing was registered with launchd; the agent needs a program it owns to run.');
    return 1;
  }

  // The resume launcher, before the agent that will use it: a plan that
  // respawns a session runs this file and nothing else, and the one path in
  // it is the shim above (design §5.1). A machine whose launcher could not be
  // written still focuses; only resume goes dark. Off — by `--no-resume`,
  // by the file, or by AGSTATUS_RESUME — means the file is gone, not merely
  // unused: the mechanism that starts processes is not left installed and
  // runnable behind a switch (§11). So does a state directory the launcher
  // could never find its way back to.
  const stateDirLost = !launcherResolves(stateDir, platform);
  let launcher: string | undefined;
  try {
    if (resumeOn && !stateDirLost) launcher = writeLauncher(stateDir, shim);
    else removeLauncher(stateDir);
  } catch (err) {
    log(`⚠ Could not ${resumeOn && !stateDirLost ? 'write' : 'remove'} the resume launcher: ${(err as Error).message}`);
    log(`  ${launcherPath(stateDir)}`);
    log('  Focus still works; the board\'s Resume button will report unsupported-host.');
  }
  const env: Record<string, string> = {};
  if (opts.stateDir || process.env.AGSTATUS_STATE_DIR) env.AGSTATUS_STATE_DIR = stateDir;
  // The switch travels with the agent, or `status` and `doctor` would report
  // a shell variable the listener never sees (§11). The file is the durable
  // form; this only keeps an install that ran with the variable honest.
  if (process.env.AGSTATUS_RESUME === 'off') env.AGSTATUS_RESUME = 'off';
  // AGSTATUS_NODE travels for the same reason, and it is the only way the
  // variable ever reaches the agent: the shim tries `$AGSTATUS_NODE` first
  // (resume.ts find_node), but launchd hands the job the dict below and
  // nothing else, so a Node named only in a shell rc is a Node the agent
  // never hears about. Without this line doctor's advice — "set
  // AGSTATUS_NODE" — would turn doctor green (it probes with the shell's
  // environment) while launchd went on exiting 127 forever.
  if (process.env.AGSTATUS_NODE) env.AGSTATUS_NODE = process.env.AGSTATUS_NODE;
  // A --url is kept in the agent's arguments: `listener run --url` resolves
  // the board exactly as this install did, so the id printed below is the
  // id the agent answers to, whatever settings.json says later.
  const args = picked.source === 'flag' ? ['listener', 'run', '--url', picked.url] : ['listener', 'run'];
  const plist = plistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(
    plist,
    renderPlist({
      label: LAUNCH_AGENT_LABEL,
      program: shim,
      args,
      path: process.env.PATH ?? '',
      logFile,
      env,
    }),
    { mode: 0o644 }
  );

  await exec(LAUNCHCTL, ['bootout', serviceTarget(uid)]); // not loaded yet is fine
  const boot = await exec(LAUNCHCTL, ['bootstrap', domain(uid), plist]);
  if (boot.code !== 0) {
    log(`✖ launchctl bootstrap exited with ${boot.code}; the agent is written but not running.`);
    log(`  Try: launchctl bootstrap ${domain(uid)} ${plist}`);
    return 1;
  }

  log('');
  log('✔ Focus listener installed.');
  log(`This machine will appear on your board as "${name}"`);
  log(`  Board:     ${picked.url} (${describeSource(picked)})`);
  log(`  Machine:   ${machinePath(stateDir)}`);
  log(`  Config:    ${agstatusJsonPath()} — "focus": true`);
  log(`  Agent:     ${plist}`);
  log(`  Launcher:  ${shim} — what launchd runs; it finds Node itself at every`);
  log('             start, so a Node upgrade or an nvm uninstall needs no reinstall');
  if (env.AGSTATUS_NODE) {
    log(`  Node:      ${env.AGSTATUS_NODE} — AGSTATUS_NODE, copied into the agent's environment`);
    log('             so the launcher tries it first; it falls back to the search if it goes');
  }
  log(`  CLI:       ${cliPath}`);
  log(`  Records:   ${path.join(stateDir, 'sessions')} (never leave this machine)`);
  log(`  Log:       ${logFile}`);
  if (launcher) {
    log(`  Resume:    ${launcher} — the only thing a tap can start, with --resume <id> and nothing else`);
  } else if (stateDirLost && resumeOn) {
    log('  Resume:    off — a state directory of its own cannot be resumed:');
    for (const line of stateDirNote(stateDir)) log(`             ${line}`);
  } else {
    log(`  Resume:    off (${resumeOffReason()}) — a tap on Resume stays refused, and no launcher is installed`);
  }
  log('');
  log('Every status post from this machine now carries this host object:');
  log(`  { "machine": { "id": "${id}", "name": "${name}" },`);
  log('    "app": { "slug", "name", "kind" } }   ← the app each session runs in,');
  log('                                            e.g. {"slug":"agterm","name":"agterm","kind":"terminal"}');
  const stale = staleFocusHooks();
  if (stale.length > 0) {
    log('');
    log('⚠ The hook installed on this machine predates Focus, so nothing writes the');
    log('  local record a tap needs — the board will show no control for its sessions:');
    for (const file of stale) log(`    ${file}`);
    log('  Run `agstatus init` to refresh it.');
  }
  const other = urlDisagreement(picked);
  if (other) {
    log('');
    log(`⚠ --url names a different board than ${describeSource(other)}:`);
    log(`    ${other.url}`);
    log('  The hook follows that file, so the id it posts will not be the one this listener answers to.');
    log('  Re-run `agstatus init --url <board>` so both agree, or reinstall without --url.');
  }
  const rot = rottingPath(cliPath);
  if (rot) {
    log('');
    log(`⚠ The CLI the launcher runs lives in ${rot}:`);
    log(`    ${cliPath}`);
    log('  Focus and Resume work; they stop working if that directory goes away.');
    log(`  For an install that owns its own prefix:  ${INSTALL_COMMAND}`);
  }
  return 0;
}

/**
 * Whether there is a listener to take down: the LaunchAgent is on disk, or
 * ~/.agstatus.json still says `"focus": true` (a machine that never opted
 * in has neither, and `agstatus uninstall` then leaves launchd alone). A
 * file that cannot be read counts as "no".
 */
export function listenerInstalled(home: string = os.homedir()): boolean {
  if (fs.existsSync(plistPath(home))) return true;
  try {
    return readAgstatusJson().focus === true;
  } catch {
    return false;
  }
}

export async function uninstall(opts: ListenerCommandOptions = {}): Promise<number> {
  const { log, exec, platform, stateDir, uid } = context(opts);
  const plist = plistPath();
  const file = agstatusJsonPath();
  // Read — and so validate — ~/.agstatus.json before anything comes down: a
  // malformed file must stop us while the agent is still in place, not after
  // it is gone with "focus": true left behind.
  try {
    readAgstatusJson(file);
  } catch (err) {
    log(`✖ ${(err as Error).message}`);
    return 1;
  }
  if (platform === 'darwin') {
    await exec(LAUNCHCTL, ['bootout', serviceTarget(uid)]); // ignore: may not be loaded
  }
  if (fs.existsSync(plist)) {
    fs.unlinkSync(plist);
    log(`✔ Removed ${plist}`);
  } else {
    log(`Nothing to remove at ${plist}.`);
  }

  if (fs.existsSync(file)) {
    mergeAgstatusJson({ focus: false });
    log(`✔ Set "focus": false in ${file} (other keys kept) — live cards clear on their next update.`);
  } else {
    log(`No ${file} — Focus was already off.`);
  }

  // The launcher goes with the agent, purge or no purge: nothing may be left
  // that starts a session on a machine whose listener has been taken down
  // (§5.1). A reinstall writes it again, byte for byte.
  //
  // `<prefix>/bin/agstatus` deliberately stays: it starts no session, it is
  // how the user runs `agstatus` at all, and on a prefix install it belongs
  // to the artifact rather than to the listener. Removing the CLI is the
  // uninstaller's job, not this command's.
  if (removeLauncher(stateDir)) log(`✔ Removed ${launcherPath(stateDir)}`);

  if (opts.purge) {
    const targets = [
      path.join(stateDir, 'sessions'),
      path.join(stateDir, 'listener.log'),
      path.join(stateDir, 'listener.lock'),
      path.join(stateDir, 'respawns.json'),
    ];
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      log(`✔ Removed ${target}`);
    }
    log(`Kept ${machinePath(stateDir)} so a reinstall keeps this machine's id.`);
  } else {
    log(`Session records and the log stay in ${stateDir} (re-run with --purge to remove them).`);
  }
  log('Focus listener uninstalled.');
  return 0;
}

/**
 * Bounded read of the end of a file: the last `n` lines from at most 64 KB,
 * with control characters removed — the log quotes what the board sent, and
 * the terminal must not act on an escape sequence hidden in it.
 */
function tail(file: string, n: number): string[] {
  try {
    const size = fs.statSync(file).size;
    const span = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(span);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, span, size - span);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n).map((line) => line.replace(/[\u0000-\u001f\u007f]/g, ''));
  } catch {
    return [];
  }
}

/**
 * What `launchctl print gui/<uid>/<label>` says about the job: the pid while
 * it is running, and the code its last run exited with. The second one is the
 * only place a launcher that could not start is ever recorded — a KeepAlive
 * job that exits 127 at every launch leaves nothing in the log, because the
 * process that would have written the log is the one that never ran. Null
 * when launchd has no such job (nothing installed, or not bootstrapped).
 */
interface ServiceState {
  pid: number | null;
  lastExit: number | null;
}

async function serviceState(exec: Exec, uid: number): Promise<ServiceState | null> {
  const res = await exec(LAUNCHCTL, ['print', serviceTarget(uid)]);
  if (res.code !== 0) return null;
  const pid = /^\s*pid = (\d+)\s*$/m.exec(res.stdout);
  // launchd has spelled this `last exit code` and `last exit status` across
  // releases, and prints `(never exited)` for a job that has not; the regex
  // takes either spelling and only a number.
  const exit = /^\s*last exit (?:code|status) = (-?\d+)\s*$/m.exec(res.stdout);
  return { pid: pid ? Number(pid[1]) : null, lastExit: exit ? Number(exit[1]) : null };
}

/** The running pid, or null when not loaded/running. */
async function runningPid(exec: Exec, uid: number): Promise<number | null> {
  return (await serviceState(exec, uid))?.pid ?? null;
}

/**
 * The Node `<prefix>/bin/agstatus` would pick right now, by running the
 * shim's OWN resolution rather than a second copy of find_node() in
 * TypeScript that could drift from it: the same rendered script, with the
 * NODE_HINT read back out of the installed one, pointed at a two-line probe
 * instead of at cli.js. Everything lives in a 0700 temp directory and is
 * removed again; the probe prints the interpreter that ended up running it,
 * which is the only honest answer to "which Node does the agent use".
 *
 * `code` is the shim's own exit status, so 127 here means exactly what 127
 * from launchd means: find_node() came up empty.
 */
interface NodeProbe {
  /** The shim's own exit status; 127 is find_node() coming up empty. -1 when it never ran. */
  code: number;
  /** The interpreter that ended up running the probe, as it printed itself. */
  answer: string;
  /** Why the probe could not run at all, naming the path at fault. */
  problem?: string;
  /** That path is inside the installed shim, so the agent is broken too — not merely undiagnosed. */
  inShim?: boolean;
}

/**
 * The environment the probe runs under: the agent's, never this shell's.
 * launchd hands the job the plist's `EnvironmentVariables` dict and nothing
 * of ours besides, so a probe that simply inherited this terminal would
 * answer for an `AGSTATUS_NODE` (or a PATH) the agent has never been told
 * about — doctor green, launchd still exiting 127. Everything the plist does
 * not name (HOME above all) still comes from here, because launchd supplies
 * those to the job as well.
 */
/**
 * Everything the shim's own find_node() consults that launchd will never set.
 * AGSTATUS_NODE is the override; NVM_DIR and N_PREFIX redirect two of the
 * version-manager searches. Leaving any of them in from this terminal lets the
 * probe find a Node down a path the agent has never been told about — doctor
 * green, launchd still exiting 127, which is the very failure this answers.
 */
const SHELL_ONLY_NODE_VARS = ['AGSTATUS_NODE', 'NVM_DIR', 'N_PREFIX'] as const;

function probeEnv(agentEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...agentEnv };
  for (const key of SHELL_ONLY_NODE_VARS) {
    if (agentEnv[key] === undefined) delete env[key];
  }
  return env;
}

async function probeNode(shim: string, exec: Exec, agentEnv: Record<string, string>): Promise<NodeProbe> {
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-node-'));
  } catch (err) {
    // No writable temp: report "could not tell", never throw. Nothing doctor
    // does may be the reason doctor prints no report (the rule for every
    // branch below as well).
    return { code: -1, answer: '', problem: `${JSON.stringify(os.tmpdir())} is not writable: ${(err as Error).message}` };
  }
  try {
    const probe = path.join(dir, 'node-probe.js');
    fs.writeFileSync(probe, "process.stdout.write(process.execPath + ' (' + process.versions.node + ')');\n", {
      mode: 0o600,
    });
    const hint = readShim(shim)?.nodeHint ?? '';
    let script: string;
    try {
      script = renderShim(probe, hint);
    } catch {
      // renderShim refuses a path its `"…"` quoting could not survive, and it
      // names the *kind* of path it was handed — "the cli.js path", which here
      // is a temp file of ours and not any cli.js the reader has. Rendering
      // once more without the hint is what says which of the two is really at
      // fault: resume.ts's own rule asked twice, rather than a second copy of
      // UNQUOTABLE_RE here that could drift from it.
      try {
        renderShim(probe, '');
      } catch {
        return { code: -1, answer: '', problem: `${JSON.stringify(dir)} holds a character a POSIX sh script cannot quote` };
      }
      return {
        code: -1,
        answer: '',
        inShim: true,
        problem: `the NODE_HINT in ${shim} (${JSON.stringify(hint)}) holds a character the shim cannot quote`,
      };
    }
    const file = path.join(dir, 'agstatus');
    fs.writeFileSync(file, script, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    const res = await exec(file, [], probeEnv(agentEnv));
    return { code: res.code, answer: res.stdout.trim() };
  } catch (err) {
    return { code: -1, answer: '', problem: `${JSON.stringify(dir)}: ${(err as Error).message}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function safeCandidates(log: (line: string) => void): ResolvedValue[] {
  try {
    return boardUrlCandidates();
  } catch (err) {
    log(`✖ ${(err as Error).message}`);
    return [];
  }
}

export async function status(opts: ListenerCommandOptions = {}): Promise<number> {
  const { log, exec, platform, stateDir, uid } = context(opts);
  const plist = plistPath();
  const hasPlist = fs.existsSync(plist);
  log(`Agent:     ${hasPlist ? plist : `NOT INSTALLED (${plist})`}`);
  if (platform === 'darwin' && hasPlist) {
    const pid = await runningPid(exec, uid);
    log(`Running:   ${pid === null ? '✖ not running (launchctl has no pid for it)' : `✔ pid ${pid}`}`);
  }

  // The board the agent actually runs against: its own --url when it has one, else what the hook reads.
  const flag = hasPlist ? plistUrlFlag(readPlist(plist) ?? '') : undefined;
  const picked: PickedUrl | undefined = flag ? { url: flag, source: 'flag' } : safeCandidates(log)[0];
  if (picked) log(`Board:     ${picked.url} (${flag ? '--url kept in the agent' : describeSource(picked)})`);
  else log('Board:     not configured — run `agstatus init`');

  const machine = readMachine(stateDir);
  if (machine) {
    const name = machineLabel(machine.name, NAME_FALLBACK);
    const id = picked ? publicId(machineKey(machine.machineId, boardBase(picked.url))) : '(needs a board URL)';
    log(`Machine:   "${name}" — public id ${id}`);
  } else {
    log(`Machine:   no usable machine.json in ${stateDir} — run \`agstatus listener install\``);
  }
  log(`State:     ${stateDir}`);
  // What the *listener* would do with a Resume tap, not what this shell
  // thinks: the agent carries its own environment (§11).
  const resume = resumeState(stateDir, platform);
  const launcher = usableLauncher(stateDir);
  const extra: string[] = [];
  let resumeLine: string;
  if (!resume.on) {
    resumeLine = `off (${resume.reason})`;
  } else if (resume.stateDirLost) {
    resumeLine = 'off — a state directory of its own cannot be resumed:';
    extra.push(...stateDirNote(stateDir).map((line) => `           ${line}`));
  } else if (launcher) {
    resumeLine = `on — ${launcher}`;
  } else {
    // Not "missing or not 0700": the shim it delegates to can be the one at
    // fault, and so can its own shape (launcherProblem above).
    resumeLine = `on, but ${launcherPath(stateDir)}: ${launcherProblem(stateDir) ?? 'not usable'} — re-run \`agstatus listener install\``;
  }
  log(`Resume:    ${resumeLine}`);
  for (const line of extra) log(line);
  if (resume.shellOnly) for (const line of shellOnlyNote()) log(`           ${line}`);

  const logFile = path.join(stateDir, 'listener.log');
  const lines = tail(logFile, 10);
  log(`Log:       ${logFile}${lines.length === 0 ? ' (empty)' : ''}`);
  for (const line of lines) log(`  ${line}`);
  return 0;
}

/** Strategy → the tool it needs; rows without one work with /usr/bin/open alone. */
const STRATEGY_BINS: Array<{ strategy: string; bin: (typeof BIN_NAMES)[number] }> = [
  { strategy: 'agterm (pane)', bin: 'agtermctl' },
  { strategy: 'Herdr (pane)', bin: 'herdr' },
  { strategy: 'tmux (pane)', bin: 'tmux' },
  { strategy: 'zellij (pane)', bin: 'zellij' },
  { strategy: 'screen (window)', bin: 'screen' },
  { strategy: 'kitty (pane, needs remote control)', bin: 'kitten' },
  { strategy: 'WezTerm (pane)', bin: 'wezterm' },
  { strategy: 'Codex in a terminal (resume, later)', bin: 'codex' },
];

/**
 * A hook from before Focus shipped still reports status perfectly well, but it
 * writes no local record and sends no `host` — so the board shows no control
 * and a tap would have nothing to act on. The marker is the function that
 * derives the machine key; `agstatus init` refreshes the file.
 */
const FOCUS_HOOK_MARKER = 'function machineKey(';

function hookSupportsFocus(file: string): boolean | null {
  try {
    return fs.readFileSync(file, 'utf8').includes(FOCUS_HOOK_MARKER);
  } catch {
    return null; // not installed through this channel
  }
}

/** Reports every installed hook that is too old for Focus. Empty when all are current. */
export function staleFocusHooks(): string[] {
  return [hookInstallPath(), codexHookInstallPath()].filter((f) => hookSupportsFocus(f) === false);
}

export async function doctor(opts: ListenerCommandOptions = {}): Promise<number> {
  const { log, exec, platform, stateDir, uid } = context(opts);
  let problems = 0;
  const bad = (line: string): void => {
    problems += 1;
    log(line);
  };

  if (platform !== 'darwin') log('⚠ Not macOS: the LaunchAgent cannot be installed here; `listener run` works in the foreground.');

  log('Tools (absolute paths the listener may run):');
  const bins = resolveBins();
  for (const name of BIN_NAMES) log(`  ${name.padEnd(10)} ${bins[name] ?? '—'}`);
  log('Strategies:');
  for (const { strategy, bin } of STRATEGY_BINS) log(`  ${bins[bin] ? '✔' : '✖'} ${strategy}`);
  log('  ✔ iTerm2 (reveal URL), Codex Desktop (thread link), JetBrains/Zed (project window),');
  log('    app activation for everything else — need only /usr/bin/open');
  log('  ✖ Terminal.app / Ghostty tab-exact focus — needs the signed listener app (later); they get app activation');

  log('Machine:');
  const machine = readMachine(stateDir);
  if (!machine) {
    bad(`  ✖ no usable machine.json in ${stateDir} — run \`agstatus listener install\``);
  } else {
    log(`  ✔ ${machinePath(stateDir)} — "${machineLabel(machine.name, NAME_FALLBACK)}"`);
    const mode = fs.statSync(machinePath(stateDir)).mode & 0o777;
    if (mode & 0o077) bad(`  ✖ machine.json mode is ${mode.toString(8)}; expected 600`);
    if (machine.machineHost && machine.machineHost !== os.hostname()) {
      log(`  ⚠ created on "${machine.machineHost}", hostname is now "${os.hostname()}" — a reinstall mints a new id`);
    }
  }

  log('Config:');
  let fileUrl = '';
  try {
    const cfg = readAgstatusJson();
    const focus = cfg.focus;
    if (focus === true) log(`  ✔ ${agstatusJsonPath()} — "focus": true`);
    else bad(`  ✖ ${agstatusJsonPath()} — "focus" is ${JSON.stringify(focus ?? null)} (the hook sends no host object)`);
    if (typeof cfg.url === 'string') fileUrl = cfg.url;
  } catch (err) {
    bad(`  ✖ ${(err as Error).message}`);
  }
  if (process.env.AGSTATUS_FOCUS === 'off') log('  ⚠ AGSTATUS_FOCUS=off in this environment overrides the file');
  for (const stale of staleFocusHooks()) {
    bad(`  ✖ ${stale} predates Focus — it writes no record, so a tap has nothing to act on`);
    log('    — run `agstatus init` to refresh the hook');
  }

  const candidates = safeCandidates(log);
  const picked = candidates[0];
  if (picked) log(`  ✔ board ${picked.url} (${describeSource(picked)})`);
  else bad('  ✖ no board URL configured — run `agstatus init`');
  const settings = candidates.find((c) => c.source === 'settings');
  const codex = candidates.find((c) => c.source === 'codex');
  if (settings && fileUrl && boardBase(settings.url) !== boardBase(fileUrl)) {
    log(`  ⚠ ${agstatusJsonPath()} names ${fileUrl} but ${settingsPath()} names ${settings.url}`);
    log('    — the hook follows settings.json; the listener follows the same order');
  }
  if (settings && codex && boardBase(settings.url) !== boardBase(codex.url)) {
    bad(`  ✖ ${settingsPath()} and ${codexHooksPath()} name different boards`);
  }

  log('Resume:');
  const resume = resumeState(stateDir, platform);
  if (!resume.on) {
    log(`  · resume is off (${resume.reason}) — a tap on Resume comes back unsupported-host`);
    log('    — remove the switch and re-run install to turn it back on; focus is unaffected');
  } else if (resume.stateDirLost) {
    bad('  ✖ this install keeps its state somewhere of its own, which resume cannot use:');
    for (const line of stateDirNote(stateDir)) log(`    ${line}`);
    log('    — reinstall without AGSTATUS_STATE_DIR to use Resume; focus is unaffected');
  } else {
    const launcher = usableLauncher(stateDir);
    if (launcher) {
      log(`  ✔ ${launcher} (0700, yours) — runs \`--resume <id>\` in the recorded directory, nothing else`);
    } else if (launcherPresent(stateDir)) {
      bad(`  ✖ ${launcherPath(stateDir)}: ${launcherProblem(stateDir) ?? 'not usable'} — re-run \`agstatus listener install\``);
    } else {
      bad(`  ✖ ${launcherPath(stateDir)} missing — run \`agstatus listener install\` (resume plans need it)`);
    }
  }
  if (resume.shellOnly) {
    const [first, second] = shellOnlyNote();
    log(`  ⚠ ${first}`);
    log(`    ${second}`);
  }

  log('Agent:');
  const plist = plistPath();
  if (!fs.existsSync(plist)) {
    bad(`  ✖ ${plist} missing — install the listener (${INSTALL_COMMAND})`);
  } else {
    log(`  ✔ ${plist}`);
    const xmlText = fs.readFileSync(plist, 'utf8');
    // The agent's whole environment, read once: the PATH line below, the Node
    // probe in (c), and the AGSTATUS_NODE note all have to answer for this
    // dict rather than for the shell doctor is being run from (§11).
    const agentEnv = plistEnv(xmlText);
    const pathValue = agentEnv.PATH;
    // PATH is for §5.1 tool resolution inside the listener — agtermctl, kitten,
    // tmux, codex. It has never had anything to do with argv[0] below.
    if (pathValue === undefined) bad('  ✖ no PATH in EnvironmentVariables — tools may not resolve under launchd');
    else log(`  ✔ PATH ${pathValue} (for the tools §5.1 runs, not for the program above)`);

    // (a) argv[0]. launchd resolves it against its own default PATH and never
    // against the dict above, so it has to be an absolute file we own — and it
    // is the shim now, not node. Reading index 1 as "the entry point" is what
    // this check used to do, and it would now report the literal "listener".
    const argv = plistProgramArguments(xmlText);
    const program = argv[0];
    const legacy = legacyPlist(argv);
    if (legacy) {
      // The upgrade, and only the upgrade: (a)–(c) below describe a shim this
      // plist does not have, and every one of them would name the user's node
      // binary as the thing at fault.
      bad('  ✖ this plist predates the launcher shim; re-run the installer to upgrade it');
      log(`    — ${INSTALL_COMMAND}`);
      log(`    — it runs ${argv[1]} under ${program}, a Node frozen into the plist at install time:`);
      if (fs.existsSync(program)) {
        log('      nothing is wrong with it today, and it exits 78 (EX_CONFIG) without running the day');
        log('      that Node moves — one `nvm install`, one `brew upgrade node` — saying nothing when it does.');
      } else {
        log(`      ${program} is already gone, so launchd cannot exec it at all (exit 78) and this`);
        log('      listener is down until its plist names a program that exists.');
      }
      // On a legacy plist argv[1] IS the entry point, and the pre-shim doctor
      // checked exactly that. Keep checking it: an npx cache that has been
      // pruned, or a global npm root taken out by an `nvm uninstall`, leaves a
      // plist whose Node is fine and whose cli.js is gone — the commonest way
      // a 1.3.0 listener dies, and the upgrade sentence alone does not say so.
      const legacyCli = argv[1];
      if (legacyCli === undefined || !fs.existsSync(legacyCli)) {
        bad(`  ✖ entry point ${legacyCli === undefined ? 'missing from the plist' : `${legacyCli} no longer exists`}`);
        log('    — that is why this listener is down now, not merely fragile');
      }
    } else if (program === undefined || !path.isAbsolute(program)) {
      bad(`  ✖ the agent's program is ${program === undefined ? 'missing' : JSON.stringify(program)}, not an absolute path`);
      log(`    — launchd exits 78 (EX_CONFIG) without running it; reinstall (${INSTALL_COMMAND})`);
    } else {
      const trouble = scriptProblem(program);
      if (trouble) bad(`  ✖ launcher ${program}: ${trouble} — reinstall (${INSTALL_COMMAND})`);
      else log(`  ✔ launcher ${program} (0700, yours)`);

      // (b) the entry point, derived from the prefix the launcher sits in
      // (`<prefix>/bin/agstatus`), never from the plist's arguments. A CLI
      // outside the layout — a dev checkout, an npx run — is still legitimate;
      // the shim itself records which one it runs.
      const prefix = path.dirname(path.dirname(program));
      const fromLayout = layoutCliPath(prefix);
      const cli = fs.existsSync(fromLayout) ? fromLayout : readShim(program)?.cli;
      if (cli === undefined) {
        bad(`  ✖ no entry point under ${prefix}, and ${program} names none — reinstall`);
      } else if (!fs.existsSync(cli)) {
        bad(`  ✖ entry point ${cli} no longer exists — reinstall (${INSTALL_COMMAND})`);
      } else {
        log(`  ✔ entry point ${cli}`);
        const rot = rottingPath(cli);
        if (rot) {
          log(`  ⚠ it lives in ${rot}`);
          log(`    — Focus works until that directory goes; ${INSTALL_COMMAND} owns its own prefix`);
        }
      }

      // (c) which Node that launcher picks, resolved by the launcher itself
      // and under the agent's environment, so this answer is the one launchd
      // gets. A probe that cannot run says so and names the path it choked
      // on: a diagnostic command is never allowed to be the thing that dies.
      if (!trouble) {
        const node = await probeNode(program, exec, agentEnv);
        if (node.problem !== undefined) {
          const line = `could not run the launcher's own Node resolution — ${node.problem}`;
          if (node.inShim) bad(`  ✖ ${line}; reinstall (${INSTALL_COMMAND})`);
          else log(`  ⚠ ${line}`);
        } else if (node.code === 127) {
          bad('  ✖ the launcher finds no Node >=18 on this machine, so the agent cannot start');
          for (const advice of nodeAdvice()) log(`    ${advice}`);
        } else if (node.code === 0 && node.answer !== '') {
          log(`  ✔ Node ${node.answer} — resolved at every start, so a Node upgrade needs no reinstall`);
        } else {
          log('  ⚠ could not tell which Node the launcher picks (the probe did not answer)');
        }
      }
    }

    // The advice above is worth nothing if the variable is only ever set
    // here: exporting it in a shell rc moves the probe and not the agent.
    if (process.env.AGSTATUS_NODE && agentEnv.AGSTATUS_NODE === undefined) {
      log(`  ⚠ AGSTATUS_NODE=${process.env.AGSTATUS_NODE} is set in this shell, but the agent's environment`);
      log(`    in ${plist} does not carry it — launchd never sees it.`);
      log(`    — re-run the installer with it set to bake it in: ${NODE_OVERRIDE_COMMAND}`);
    }

    // (d) what launchd made of all that. A KeepAlive job that never execs
    // writes nothing to the log, so its exit code is the only evidence there is.
    if (platform === 'darwin') {
      const svc = await serviceState(exec, uid);
      if (svc === null) {
        bad(`  ✖ launchctl has no job ${serviceTarget(uid)} — the plist is on disk but not loaded`);
        log(`    — run \`launchctl bootstrap ${domain(uid)} ${plist}\`, or reinstall`);
      } else {
        log(svc.pid === null ? '  ⚠ not running at this moment (KeepAlive restarts it within 10 s)' : `  ✔ running, pid ${svc.pid}`);
        if (svc.lastExit === 127) {
          // On a pre-shim plist there is no launcher to blame and no
          // AGSTATUS_NODE to set: launchd ran that node itself.
          bad(`  ✖ its last run exited 127 — ${legacy ? 'the node in this plist could not run the CLI' : 'the launcher found no Node >=18 and gave up'}`);
          if (legacy) log(`    — re-run the installer to upgrade the plist (${INSTALL_COMMAND})`);
          else for (const advice of nodeAdvice()) log(`    ${advice}`);
        } else if (svc.lastExit === 78) {
          bad(`  ✖ its last run exited 78 (EX_CONFIG) — launchd could not exec ${program ?? 'the program'}`);
          log(
            legacy
              ? `    — a Node frozen into a plist cannot be re-pointed in place; upgrade it (${INSTALL_COMMAND})`
              : '    — argv[0] must be an absolute path that exists; reinstall'
          );
        } else if (svc.lastExit !== null && svc.lastExit !== 0) {
          log(`  ⚠ its last run exited ${svc.lastExit} — the listener log below is where it says why`);
        }
      }
    }

    const flag = plistUrlFlag(xmlText);
    if (flag && picked && boardBase(flag) !== boardBase(picked.url)) {
      bad(`  ✖ the agent runs with --url ${flag}, but the hook reads ${picked.url} (${describeSource(picked)})`);
      log('    — they would disagree on this machine\'s id; reinstall without --url, or `agstatus init --url <board>`');
    }
  }

  log(problems === 0 ? 'Everything looks fine.' : `${problems} problem${problems === 1 ? '' : 's'} found.`);
  return problems === 0 ? 0 : 1;
}
