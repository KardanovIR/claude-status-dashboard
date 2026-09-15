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
import { launcherPath, launcherResolves, launcherStateDir, removeLauncher, usableLauncher, writeLauncher } from './resume';
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
  nodePath: string;
  cliPath: string;
  args: string[];
  /** The installer's PATH, so tools resolve under launchd the way they did in the user's shell. */
  path: string;
  logFile: string;
  /** Extra environment (e.g. AGSTATUS_STATE_DIR when the install ran with one). */
  env?: Record<string, string>;
}

/** The LaunchAgent: RunAtLoad + KeepAlive, throttled restarts, stdout and stderr into the listener log. */
export function renderPlist(opts: PlistOptions): string {
  const argv = [opts.nodePath, opts.cliPath, ...opts.args];
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
/** argv-only process launch; `file` is always an absolute path from a fixed table. */
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

const defaultExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000 }, (err, stdout) => {
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
  /** Compiled entry point the LaunchAgent runs; defaults to this package's dist/cli.js. */
  cliPath?: string;
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
    log('  Re-run `npx agstatus init` so both point at one board, or pass --url <board> to choose.');
    return null;
  }
  const picked = candidates[0];
  if (!picked) {
    log('✖ No board URL configured — run `npx agstatus init` first, or pass --url <board>.');
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
 * launcher carries two baked-in paths and is handed no environment, so it
 * reads the platform default whatever AGSTATUS_STATE_DIR said at install.
 */
const stateDirNote = (stateDir: string): string[] => [
  'the resume launcher is handed no environment, so it would read',
  `${launcherStateDir()}, not ${stateDir} — Resume taps answer unsupported-host`,
];

/** The launcher as a directory entry, symlink and all — `existsSync` would call a dangling one missing. */
const launcherPresent = (dir: string): boolean =>
  fs.lstatSync(launcherPath(dir), { throwIfNoEntry: false }) !== undefined;

const isNpxCache = (p: string): boolean => p.split(path.sep).includes('_npx');

const defaultCliPath = (): string => path.resolve(__dirname, '..', 'cli.js');

export async function install(opts: ListenerCommandOptions = {}): Promise<number> {
  const { log, exec, platform, stateDir, uid } = context(opts);
  if (platform !== 'darwin') {
    log('✖ The Focus listener v1 installs as a macOS LaunchAgent only.');
    log('  `npx agstatus listener run` still works anywhere, in the foreground.');
    return 1;
  }

  // Read and validate everything before the first write: a malformed
  // ~/.agstatus.json or settings.json throws here with nothing changed.
  const picked = pickBoardUrl(opts.url, log);
  if (!picked) return 1;
  const base = boardBase(picked.url);

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

  const cliPath = opts.cliPath ?? defaultCliPath();
  const nodePath = opts.nodePath ?? process.execPath;
  const logFile = path.join(stateDir, 'listener.log');

  // The resume launcher, before the agent that will use it: a plan that
  // respawns a session runs this file and nothing else, and both paths in it
  // are baked in here (design §5.1). A machine whose launcher could not be
  // written still focuses; only resume goes dark. Off — by `--no-resume`,
  // by the file, or by AGSTATUS_RESUME — means the file is gone, not merely
  // unused: the mechanism that starts processes is not left installed and
  // runnable behind a switch (§11). So does a state directory the launcher
  // could never find its way back to.
  const stateDirLost = !launcherResolves(stateDir, platform);
  let launcher: string | undefined;
  try {
    if (resumeOn && !stateDirLost) launcher = writeLauncher(stateDir, nodePath, cliPath);
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
      nodePath,
      cliPath,
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
    log('  Run `npx agstatus init` to refresh it.');
  }
  const other = urlDisagreement(picked);
  if (other) {
    log('');
    log(`⚠ --url names a different board than ${describeSource(other)}:`);
    log(`    ${other.url}`);
    log('  The hook follows that file, so the id it posts will not be the one this listener answers to.');
    log('  Re-run `npx agstatus init --url <board>` so both agree, or reinstall without --url.');
  }
  if (isNpxCache(cliPath)) {
    log('');
    log('⚠ The agent points into the npx cache, which npm may clear:');
    log(`    ${cliPath}`);
    log('  Install the CLI (`npm i -g agstatus`) and re-run this command for a stable path.');
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

/** `launchctl print gui/<uid>/<label>` → the running pid, or null when not loaded/running. */
async function runningPid(exec: Exec, uid: number): Promise<number | null> {
  const res = await exec(LAUNCHCTL, ['print', serviceTarget(uid)]);
  if (res.code !== 0) return null;
  const m = /^\s*pid = (\d+)\s*$/m.exec(res.stdout);
  return m ? Number(m[1]) : null;
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
  else log('Board:     not configured — run `npx agstatus init`');

  const machine = readMachine(stateDir);
  if (machine) {
    const name = machineLabel(machine.name, NAME_FALLBACK);
    const id = picked ? publicId(machineKey(machine.machineId, boardBase(picked.url))) : '(needs a board URL)';
    log(`Machine:   "${name}" — public id ${id}`);
  } else {
    log(`Machine:   no usable machine.json in ${stateDir} — run \`npx agstatus listener install\``);
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
    resumeLine = `on, but ${launcherPath(stateDir)} is missing or not 0700 — re-run \`npx agstatus listener install\``;
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
 * derives the machine key; `npx agstatus init` refreshes the file.
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
  const { log, platform, stateDir } = context(opts);
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
    bad(`  ✖ no usable machine.json in ${stateDir} — run \`npx agstatus listener install\``);
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
    log('    — run `npx agstatus init` to refresh the hook');
  }

  const candidates = safeCandidates(log);
  const picked = candidates[0];
  if (picked) log(`  ✔ board ${picked.url} (${describeSource(picked)})`);
  else bad('  ✖ no board URL configured — run `npx agstatus init`');
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
      bad(`  ✖ ${launcherPath(stateDir)} is not a 0700 regular file owned by you — re-run \`npx agstatus listener install\``);
    } else {
      bad(`  ✖ ${launcherPath(stateDir)} missing — run \`npx agstatus listener install\` (resume plans need it)`);
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
    bad(`  ✖ ${plist} missing — run \`npx agstatus listener install\``);
  } else {
    log(`  ✔ ${plist}`);
    const xmlText = fs.readFileSync(plist, 'utf8');
    const pathValue = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(xmlText)?.[1];
    if (pathValue === undefined) bad('  ✖ no PATH in EnvironmentVariables — tools may not resolve under launchd');
    else log(`  ✔ PATH ${pathValue}`);
    const cliPath = plistProgramArguments(xmlText)[1];
    if (cliPath && !fs.existsSync(cliPath)) bad(`  ✖ entry point ${cliPath} no longer exists — reinstall`);
    if (cliPath && isNpxCache(cliPath)) log('  ⚠ entry point lives in the npx cache, which npm may clear — `npm i -g agstatus` and reinstall');
    const flag = plistUrlFlag(xmlText);
    if (flag && picked && boardBase(flag) !== boardBase(picked.url)) {
      bad(`  ✖ the agent runs with --url ${flag}, but the hook reads ${picked.url} (${describeSource(picked)})`);
      log('    — they would disagree on this machine\'s id; reinstall without --url, or `npx agstatus init --url <board>`');
    }
  }

  log(problems === 0 ? 'Everything looks fine.' : `${problems} problem${problems === 1 ? '' : 's'} found.`);
  return problems === 0 ? 0 : 1;
}
