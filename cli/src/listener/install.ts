import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { settingsPath } from '../settings';
import { codexHooksPath } from '../codex';
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
  writeMachine,
  type ConfigSource,
  type ResolvedValue,
} from './config';
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
  /** Also remove the session records and the log (uninstall only). */
  purge?: boolean;
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

  mergeAgstatusJson({ focus: true, url: picked.url });

  const cliPath = opts.cliPath ?? defaultCliPath();
  const nodePath = opts.nodePath ?? process.execPath;
  const logFile = path.join(stateDir, 'listener.log');
  const env: Record<string, string> = {};
  if (opts.stateDir || process.env.AGSTATUS_STATE_DIR) env.AGSTATUS_STATE_DIR = stateDir;
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
  log('');
  log('Every status post from this machine now carries this host object:');
  log(`  { "machine": { "id": "${id}", "name": "${name}" },`);
  log('    "app": { "slug", "name", "kind" } }   ← the app each session runs in,');
  log('                                            e.g. {"slug":"agterm","name":"agterm","kind":"terminal"}');
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

  if (opts.purge) {
    for (const target of [path.join(stateDir, 'sessions'), path.join(stateDir, 'listener.log'), path.join(stateDir, 'listener.lock')]) {
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
