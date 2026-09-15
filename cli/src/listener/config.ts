import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HOOK_MARKER, readSettings, settingsPath } from '../settings';
import { codexHooksPath, readCodexHooks } from '../codex';
import type { ListenerConfig, MachineState } from './types';

/**
 * Configuration for the Focus listener: where the board is, who this machine
 * is, where its state lives, and which tools it may run. Every derivation
 * here mirrors cli/assets/agstatus-hook.js line for line — the hook and the
 * listener must agree on the state dir, the machine key and the public id or
 * the server routes commands to a machine that never hears them.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** http(s) URL with no whitespace, quotes, backslashes or `$` — the set codexHookCommand also refuses. */
export const BOARD_URL_RE = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!&()*+,;=%-]+$/;

/** Tools the listener may launch; names only — resolveBins() turns them into absolute paths. */
export const BIN_NAMES = [
  'claude', 'codex', 'agtermctl', 'herdr', 'tmux', 'zellij', 'screen', 'kitten', 'wezterm', 'code',
] as const;
export type BinName = (typeof BIN_NAMES)[number];

/** Directories searched after PATH, then per-tool locations inside app bundles. */
const BIN_DIRS = (): string[] => [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
];
const BIN_FALLBACKS: Partial<Record<BinName, string[]>> = {
  agtermctl: ['/Applications/agterm.app/Contents/MacOS/agtermctl'],
  kitten: ['/Applications/kitty.app/Contents/MacOS/kitten'],
  wezterm: ['/Applications/WezTerm.app/Contents/MacOS/wezterm'],
  codex: ['/Applications/ChatGPT.app/Contents/Resources/codex'],
  screen: ['/usr/bin/screen'],
};

const str = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The board URL as every request — and the machine id hash — sees it: no
 * trailing "/", no "/webhook" suffix. Identical to the hook's boardBase().
 */
export function boardBase(url: string): string {
  return url.replace(/\/$/, '').replace(/\/webhook$/, '');
}

/** The listener's credential for this machine and board: sha256(machineId + "\n" + base), 64 hex. */
export function machineKey(machineId: string, base: string): string {
  return crypto.createHash('sha256').update(`${machineId}\n${base}`).digest('hex');
}

/** What the hook puts on the wire and the server routes by: sha256(key)[0..32]. */
export function publicId(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Non-identifying default label — a Mac's hostname embeds the account's name. */
export function defaultMachineName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'PC' : 'Linux';
}

/** The hook's label(): control characters out, whitespace collapsed, 32 chars, fallback when empty. */
export function machineLabel(value: unknown, fallback: string = defaultMachineName()): string {
  const s = str(value).replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
  return s || fallback;
}

/**
 * Per-machine state, never a dotfile: ~/.agstatus.json is the file people
 * sync between machines, and a machine id must never travel with it. Same
 * rules as the hook's focusStateDir().
 */
export function defaultStateDir(): string {
  const override = str(process.env.AGSTATUS_STATE_DIR);
  if (override) return override;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AgStatus');
  }
  if (process.platform === 'win32') {
    const local = str(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'AgStatus');
  }
  const state = str(process.env.XDG_STATE_HOME) || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'agstatus');
}

export function machinePath(dir: string): string {
  return path.join(dir, 'machine.json');
}

/** machine.json, or null when missing, malformed, or without a uuid machineId. */
export function readMachine(dir: string): MachineState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(machinePath(dir), 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const machineId = str(parsed.machineId);
  if (!UUID_RE.test(machineId)) return null;
  const state: MachineState = { machineId };
  const name = str(parsed.name);
  if (name) state.name = machineLabel(name);
  const host = str(parsed.machineHost);
  if (host) state.machineHost = host;
  return state;
}

/** Directory 0700, file 0600, temp + rename — the same discipline as the hook's records. */
export function writeMachine(dir: string, state: MachineState): void {
  if (!UUID_RE.test(state.machineId)) {
    throw new Error('machineId must be a uuid');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = machinePath(dir);
  const tmp = path.join(dir, `.machine.json.agstatus-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export type ConfigSource = 'env' | 'settings' | 'codex' | 'file';
export interface ResolvedValue {
  url: string;
  source: ConfigSource;
}

export function agstatusJsonPath(): string {
  return path.join(os.homedir(), '.agstatus.json');
}

/**
 * ~/.agstatus.json — missing → {}. Malformed → throws with a clear message,
 * so no caller ever writes over a file it could not read.
 */
export function readAgstatusJson(file: string = agstatusJsonPath()): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) throw new Error('not a JSON object');
    return parsed;
  } catch (err) {
    throw new Error(
      `${file} exists but is not valid JSON (${(err as Error).message}). ` +
        'Fix or remove it, then re-run — nothing was changed.'
    );
  }
}

/** The `CLAUDE_STATUS_URL="…"` / `CLAUDE_STATUS_SECRET='…'` prefix of our Codex hook command, if registered. */
function codexPrefix(): { url?: string; secret?: string } | null {
  const hooks = readCodexHooks(codexHooksPath());
  if (!isPlainObject(hooks.hooks)) return null;
  for (const entries of Object.values(hooks.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const list = isPlainObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const h of list) {
        const command = isPlainObject(h) && typeof h.command === 'string' ? h.command : '';
        if (!command.includes(HOOK_MARKER)) continue;
        const out: { url?: string; secret?: string } = {};
        const url = /(?:^|\s)CLAUDE_STATUS_URL="([^"]*)"/.exec(command);
        if (url && str(url[1])) out.url = url[1].trim();
        const secret = /(?:^|\s)CLAUDE_STATUS_SECRET='((?:[^']|'\\'')*)'/.exec(command);
        if (secret && secret[1]) out.secret = secret[1].replace(/'\\''/g, "'");
        return out;
      }
    }
  }
  return null;
}

function settingsEnv(): Record<string, unknown> {
  const settings = readSettings(settingsPath());
  return isPlainObject(settings.env) ? settings.env : {};
}

/**
 * Every place a board URL can be configured, in precedence order: the
 * process environment, ~/.claude/settings.json env, the Codex hook command's
 * env prefix, ~/.agstatus.json. Throws when a file exists but is unreadable.
 */
export function boardUrlCandidates(): ResolvedValue[] {
  const out: ResolvedValue[] = [];
  const env = str(process.env.CLAUDE_STATUS_URL);
  if (env) out.push({ url: env, source: 'env' });
  const fromSettings = str(settingsEnv().CLAUDE_STATUS_URL);
  if (fromSettings) out.push({ url: fromSettings, source: 'settings' });
  const codex = codexPrefix();
  if (codex?.url) out.push({ url: codex.url, source: 'codex' });
  const fromFile = str(readAgstatusJson().url);
  if (fromFile) out.push({ url: fromFile, source: 'file' });
  return out;
}

export function resolveBoardUrl(): ResolvedValue | null {
  return boardUrlCandidates()[0] ?? null;
}

/** Same precedence as the URL. Legacy servers only; boards carry their auth in the URL. */
export function resolveSecret(): { secret: string; source: ConfigSource } | null {
  const env = str(process.env.CLAUDE_STATUS_SECRET);
  if (env) return { secret: env, source: 'env' };
  const fromSettings = str(settingsEnv().CLAUDE_STATUS_SECRET);
  if (fromSettings) return { secret: fromSettings, source: 'settings' };
  const codex = codexPrefix();
  if (codex?.secret) return { secret: codex.secret, source: 'codex' };
  const fromFile = str(readAgstatusJson().secret);
  if (fromFile) return { secret: fromFile, source: 'file' };
  return null;
}

/**
 * Read-modify-write ~/.agstatus.json, mode 0600, keeping every key it already
 * has. `url` and `secret` are written only when absent — the installer must
 * never redirect a board someone configured on purpose.
 */
export function mergeAgstatusJson(patch: Record<string, unknown>, file: string = agstatusJsonPath()): void {
  const current = readAgstatusJson(file);
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if ((key === 'url' || key === 'secret') && str(current[key])) continue;
    merged[key] = value;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const tmp = path.join(path.dirname(target), `.agstatus.json.agstatus-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const currentUid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/**
 * A regular file with an execute bit that only root or this user could have
 * put there: no group/other write bit, owned by root or by us, and not in a
 * directory anyone may write to. PATH is the one place a tool's location
 * still comes from, so what it names must not be something another local
 * user could have planted or can replace.
 */
export const isExecutableFile = (p: string): boolean => {
  const uid = currentUid();
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || (st.mode & 0o111) === 0 || (st.mode & 0o022) !== 0) return false;
    if (uid !== undefined && st.uid !== 0 && st.uid !== uid) return false;
    return (fs.statSync(path.dirname(p)).mode & 0o002) === 0;
  } catch {
    return false;
  }
};

/**
 * Absolute paths for the tools the listener may run. PATH is consulted here,
 * at install/doctor/start time, with stat() only — nothing runs, and relative
 * PATH entries are ignored. Then the fixed locations. A candidate counts only
 * when isExecutableFile() vouches for it, and the result is the only place a
 * plan may take an argv[0] from.
 */
export function resolveBins(): Record<string, string> {
  const dirs = str(process.env.PATH)
    .split(path.delimiter)
    .filter((d) => d && path.isAbsolute(d));
  const bins: Record<string, string> = {};
  for (const name of BIN_NAMES) {
    const candidates = [
      ...dirs.map((d) => path.join(d, name)),
      ...BIN_DIRS().map((d) => path.join(d, name)),
      ...(BIN_FALLBACKS[name] ?? []),
    ];
    const found = candidates.find(isExecutableFile);
    if (found) bins[name] = found;
  }
  return bins;
}

/**
 * Whether a tap may resume a session on this machine (design §11: resume
 * ships on, with a switch). `ListenerConfig` is the shape the runtime,
 * planner and installer agree on and does not carry it, so the switch is
 * read where it is needed: `"resume": false` in ~/.agstatus.json, or
 * AGSTATUS_RESUME=off in the environment for one run. A file that cannot be
 * parsed is not a "no" — doctor reports it, and the default stands.
 */
export function resumeEnabled(file: string = agstatusJsonPath()): boolean {
  if (process.env.AGSTATUS_RESUME === 'off') return false;
  try {
    return readAgstatusJson(file).resume !== false;
  } catch {
    return true;
  }
}

export interface ResolveOptions {
  name?: string;
  url?: string;
  stateDir?: string;
}

/** Everything the listener needs at start, or one line saying what is missing. */
export function resolveListenerConfig(opts: ResolveOptions = {}): ListenerConfig | { error: string } {
  let url = str(opts.url);
  if (!url) {
    let resolved: ResolvedValue | null;
    try {
      resolved = resolveBoardUrl();
    } catch (err) {
      return { error: (err as Error).message };
    }
    if (!resolved) {
      return { error: 'No board URL configured — run `npx agstatus init` first (or pass --url <board>).' };
    }
    url = resolved.url;
  }
  if (!BOARD_URL_RE.test(url)) {
    return { error: 'The board URL must be an http(s) URL without spaces or quotes.' };
  }
  const base = boardBase(url);
  const stateDir = str(opts.stateDir) || defaultStateDir();
  const machine = readMachine(stateDir);
  if (!machine) {
    return { error: `No usable machine.json in ${stateDir} — run \`npx agstatus listener install\`.` };
  }
  const key = machineKey(machine.machineId, base);
  let secret: string | undefined;
  try {
    secret = resolveSecret()?.secret;
  } catch (err) {
    return { error: (err as Error).message };
  }
  const cfg: ListenerConfig = {
    url,
    base,
    stateDir,
    machineId: machine.machineId,
    machineKey: key,
    machinePublicId: publicId(key),
    name: machineLabel(opts.name || machine.name),
    bins: resolveBins(),
    logFile: path.join(stateDir, 'listener.log'),
    lockFile: path.join(stateDir, 'listener.lock'),
  };
  if (secret) cfg.secret = secret;
  return cfg;
}
