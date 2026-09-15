import fs from 'fs';
import os from 'os';
import path from 'path';
import { HOST_SLUGS, type HostSummary, type LocalRecord, type MachineFacts, type MuxKind } from './types';

/**
 * Local Focus records: where the hook keeps them, what a valid one looks
 * like, and which of a session's records a command refers to.
 *
 * A record is data the hook wrote under the user's own uid, but it is read
 * back by a process that launches things, so it gets the treatment an
 * untrusted input gets (design §5.1): every key is whitelisted, every value
 * has a regex, unknown keys are dropped, and a value that fails is a failed
 * record — except env values, which are dropped one by one, because an odd
 * TERM_PROGRAM must not cost the user Focus. Nothing here touches the
 * process table or stats a cwd; the runtime does that with the facts it
 * hands the planner.
 */

const str = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Per-machine state, never a dotfile — the same directory the hook writes
 * to (focusStateDir() in cli/assets/agstatus-hook.js), so the two must
 * change together.
 */
export function stateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const override = str(env.AGSTATUS_STATE_DIR);
  if (override) return override;
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'AgStatus');
  }
  if (platform === 'win32') {
    const local = str(env.LOCALAPPDATA) || path.join(home, 'AppData', 'Local');
    return path.join(local, 'AgStatus');
  }
  const state = str(env.XDG_STATE_HOME) || path.join(home, '.local', 'state');
  return path.join(state, 'agstatus');
}

// ---- Shapes ---------------------------------------------------------------

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Session ids as the hook accepts them for a path segment ('.' and '..' are refused separately). */
export const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BUNDLE_RE = /^[A-Za-z0-9.-]{3,128}$/;
/** macOS pseudo-terminals; Linux names its own. */
export const TTY_RE = /^\/dev\/ttys[0-9]{3,4}$/;
export const TTY_LINUX_RE = /^\/dev\/(pts\/[0-9]+|tty[0-9]+)$/;
/** A unix socket path: absolute, at most 200 characters, no control characters. */
export const SOCKET_RE = /^\/[^\u0000-\u001f\u007f]{0,199}$/;
/** kitty's `listen_on`, and only the unix: form — `fd:` and `tcp:` are useless to a stranger process. */
export const KITTY_LISTEN_RE = /^unix:\/[^\u0000-\u001f\u007f]{0,199}$/;
export const INT_RE = /^[0-9]{1,10}$/;
export const ITERM_SESSION_RE = /^w\d+t\d+p\d+:[0-9A-Fa-f-]{36}$/;
/** Claude Code's own tmux target recipe: `session:@window.%pane`. */
export const TMUX_TARGET_RE = /^[A-Za-z0-9_.-]{1,64}:@?\d{1,6}\.%?\d{1,6}$/;
export const HERDR_WORKSPACE_RE = /^w\d{1,6}$/;
export const HERDR_TAB_RE = /^w\d{1,6}:t\d{1,6}$/;
export const HERDR_PANE_RE = /^w\d{1,6}:p\d{1,6}$/;
/**
 * A Codex thread id (a uuid in practice). Anchored on a hex digit on
 * purpose: `codex resume <id>` takes this as an argument and a leading `-`
 * would be read as a flag, and `codex://threads/<id>` is a URL — neither may
 * start with a dash.
 */
export const CODEX_ID_RE = /^[0-9a-f][0-9a-f-]{0,63}$/i;
/** tmux/zellij/screen/herdr session names (screen's STY is `pid.tty.host`). */
export const MUX_SESSION_RE = /^[A-Za-z0-9_.-]{1,128}$/;
export const ZELLIJ_PANE_RE = /^[A-Za-z0-9_-]{1,32}$/;

const TMUX_VAR_RE = /^\/[^\u0000-\u001f\u007f,]{0,199},\d{1,10},\d{1,10}$/;
const TMUX_PANE_RE = /^%\d{1,6}$/;
const SSH_CONNECTION_RE = /^[0-9A-Fa-f.:%]{1,64} \d{1,5} [0-9A-Fa-f.:%]{1,64} \d{1,5}$/;
/** Informational values the planner never puts in an argv: printable, bounded. */
const TEXT_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
/** Paths the record only reports (GHOSTTY_BIN_DIR and friends): absolute, bounded. */
const ABS_RE = /^\/[^\u0000-\u001f\u007f]{0,1023}$/;
/** `ps` comm: a bare name on Linux, the executable's full path on macOS. Compared, never run. */
const COMM_RE = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const ENTRYPOINT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BIN_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** The agent's $PATH, kept for respawns: a list, so not absolute as a whole. */
const PATH_LIST_RE = /^[^\u0000-\u001f\u007f]{1,8192}$/;
const MACHINE_ID_RE = /^[0-9a-f]{32}$/;
const LABEL_RE = /^[^\u0000-\u001f\u007f]{1,32}$/;
const RECORD_FILE_RE = /^[A-Za-z0-9._-]{1,64}\.json$/;
const RECORD_MAX_BYTES = 64 * 1024;
/** Linux's pid_max ceiling; macOS stops far lower. */
const PID_MAX = 4194304;

const HOST_KINDS = ['terminal', 'multiplexer', 'ide', 'desktop-app', 'unknown'] as const;
const MUX_KINDS: readonly MuxKind[] = ['herdr', 'tmux', 'zellij', 'screen'];

/**
 * The env whitelist, key for key the one the hook applies (HOST_ENV_KEYS),
 * each with the shape its value may take. Keys the planner puts into an
 * argv or a URL carry the strict per-host regexes; the rest are bounded
 * printable text. A key missing here never reaches a LocalRecord.
 */
const ENV_RULES = new Map<string, RegExp>([
  ['TERM_PROGRAM', TEXT_RE], ['TERM_PROGRAM_VERSION', TEXT_RE], ['TERM', TEXT_RE],
  ['__CFBundleIdentifier', BUNDLE_RE], ['TERMINAL_EMULATOR', TEXT_RE],
  ['AGTERM_SESSION_ID', UUID_RE], ['AGTERM_WINDOW_ID', UUID_RE], ['AGTERM_WORKSPACE_ID', UUID_RE],
  ['AGTERM_SOCKET', SOCKET_RE],
  ['GHOSTTY_SURFACE_ID', TEXT_RE], ['GHOSTTY_BIN_DIR', ABS_RE],
  ['KITTY_WINDOW_ID', INT_RE], ['KITTY_PID', INT_RE], ['KITTY_LISTEN_ON', KITTY_LISTEN_RE],
  ['KITTY_INSTALLATION_DIR', ABS_RE],
  ['ITERM_SESSION_ID', ITERM_SESSION_RE], ['TERM_SESSION_ID', TEXT_RE],
  ['WEZTERM_PANE', INT_RE], ['WEZTERM_UNIX_SOCKET', SOCKET_RE], ['WEZTERM_EXECUTABLE', ABS_RE],
  ['ALACRITTY_WINDOW_ID', INT_RE], ['ALACRITTY_SOCKET', SOCKET_RE], ['WARP_IS_LOCAL_SHELL_SESSION', TEXT_RE],
  ['VSCODE_PID', INT_RE], ['VSCODE_GIT_ASKPASS_MAIN', ABS_RE], ['CURSOR_TRACE_ID', TEXT_RE], ['ZED_TERM', TEXT_RE],
  ['CLAUDE_CODE_SSE_PORT', INT_RE], ['CLAUDE_CODE_HOST_SESSION_ID', TEXT_RE],
  ['TMUX', TMUX_VAR_RE], ['TMUX_PANE', TMUX_PANE_RE],
  ['ZELLIJ', TEXT_RE], ['ZELLIJ_SESSION_NAME', MUX_SESSION_RE], ['ZELLIJ_PANE_ID', ZELLIJ_PANE_RE],
  ['STY', MUX_SESSION_RE], ['WINDOW', INT_RE],
  ['HERDR_ENV', TEXT_RE], ['HERDR_SOCKET_PATH', SOCKET_RE], ['HERDR_WORKSPACE_ID', HERDR_WORKSPACE_RE],
  ['HERDR_TAB_ID', HERDR_TAB_RE], ['HERDR_PANE_ID', HERDR_PANE_RE], ['HERDR_SESSION', MUX_SESSION_RE],
  ['HERDR_CLIENT_SOCKET_PATH', SOCKET_RE], ['HERDR_BIN_PATH', ABS_RE],
  ['WT_SESSION', TEXT_RE], ['WT_PROFILE_ID', TEXT_RE], ['WSL_DISTRO_NAME', TEXT_RE], ['WSL_INTEROP', TEXT_RE],
  ['ConEmuHWND', TEXT_RE],
  ['WINDOWID', INT_RE], ['DISPLAY', TEXT_RE], ['WAYLAND_DISPLAY', TEXT_RE], ['XDG_SESSION_TYPE', TEXT_RE],
  ['XDG_CURRENT_DESKTOP', TEXT_RE], ['SWAYSOCK', TEXT_RE], ['HYPRLAND_INSTANCE_SIGNATURE', TEXT_RE],
  ['KONSOLE_DBUS_SERVICE', TEXT_RE], ['KONSOLE_DBUS_SESSION', TEXT_RE], ['KONSOLE_DBUS_WINDOW', TEXT_RE],
  ['GNOME_TERMINAL_SERVICE', TEXT_RE],
  ['SSH_CONNECTION', SSH_CONNECTION_RE],
]);

/** Which `mux` fields each kind may carry, and their shapes; a field without a rule is dropped. */
const MUX_RULES: Record<MuxKind, Partial<Record<'target' | 'tab' | 'workspace' | 'socket' | 'session', RegExp>>> = {
  herdr: { target: HERDR_PANE_RE, tab: HERDR_TAB_RE, workspace: HERDR_WORKSPACE_RE, socket: SOCKET_RE, session: MUX_SESSION_RE },
  tmux: { target: TMUX_TARGET_RE, socket: SOCKET_RE },
  zellij: { target: ZELLIJ_PANE_RE, session: MUX_SESSION_RE },
  screen: { target: INT_RE, session: MUX_SESSION_RE },
};
const MUX_FIELDS = ['target', 'tab', 'workspace', 'socket', 'session'] as const;

// ---- Field checks ---------------------------------------------------------

/** A session id fit for a path segment: the regex, and never a dot directory. */
export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && id !== '.' && id !== '..';
}

/** An absolute path without control characters, of a sane length. Not stat()ed here. */
export function isAbsPath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 && !CONTROL_RE.test(v) && path.isAbsolute(v);
}

const isPid = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= PID_MAX;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isMuxKind = (v: unknown): v is MuxKind => typeof v === 'string' && (MUX_KINDS as readonly string[]).includes(v);

function ttyRe(platform: NodeJS.Platform): RegExp {
  if (platform === 'darwin') return TTY_RE;
  if (platform === 'linux') return TTY_LINUX_RE;
  return new RegExp(`${TTY_RE.source}|${TTY_LINUX_RE.source}`);
}

/**
 * The env block, key-whitelisted and value-checked. Values that fail are
 * dropped one at a time and never fail the record; the planner re-checks the
 * ones it uses anyway. Also applied to the multiplexer client's env the
 * runtime resolves (facts.outer.env), which is no more trusted.
 */
export function cleanEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const rule = ENV_RULES.get(key);
    if (rule && typeof value === 'string' && rule.test(value)) out[key] = value;
  }
  return out;
}

function cleanSummary(raw: unknown): HostSummary | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.machine) || !isPlainObject(raw.app)) return null;
  const { id, name } = raw.machine;
  const { slug, name: appName, kind } = raw.app;
  if (typeof id !== 'string' || !MACHINE_ID_RE.test(id)) return null;
  if (typeof name !== 'string' || !LABEL_RE.test(name)) return null;
  if (typeof slug !== 'string' || !(HOST_SLUGS as readonly string[]).includes(slug)) return null;
  if (typeof appName !== 'string' || !LABEL_RE.test(appName)) return null;
  if (typeof kind !== 'string' || !(HOST_KINDS as readonly string[]).includes(kind)) return null;
  return {
    machine: { id, name },
    app: { slug: slug as HostSummary['app']['slug'], name: appName, kind: kind as HostSummary['app']['kind'] },
  };
}

/**
 * A LocalRecord from parsed JSON, or null when anything about it is off.
 * Every key is whitelisted and unknown ones vanish; a wrong type or a value
 * outside its regex fails the whole record — except inside `env`, where the
 * offending value alone is dropped. `agent_comm` and `entrypoint` may be
 * absent (the hook omits what it could not learn) and read as ''. `platform`
 * picks the tty shape; nothing is stat()ed.
 */
export function validateRecord(raw: unknown, platform: NodeJS.Platform = process.platform): LocalRecord | null {
  if (!isPlainObject(raw)) return null;
  const { v, session_id, agent, agent_pid, written_at, ended_at, env } = raw;
  if (v !== 1) return null;
  if (!validSessionId(session_id)) return null;
  if (agent !== 'claude' && agent !== 'codex') return null;
  if (!isPid(agent_pid)) return null;
  if (!isTime(written_at)) return null;
  if (ended_at !== null && ended_at !== undefined && !isTime(ended_at)) return null;
  if (!isPlainObject(env)) return null;

  let bad = false;
  /** An optional string field: absent reads as undefined; present, it must match or the record fails. */
  const text = (value: unknown, re: RegExp): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && re.test(value)) return value;
    bad = true;
    return undefined;
  };
  const abs = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (isAbsPath(value)) return value;
    bad = true;
    return undefined;
  };

  const record: LocalRecord = {
    v: 1,
    session_id,
    agent,
    agent_pid,
    agent_comm: text(raw.agent_comm, COMM_RE) ?? '',
    entrypoint: text(raw.entrypoint, ENTRYPOINT_RE) ?? '',
    written_at,
    ended_at: ended_at ?? null,
    env: cleanEnv(env),
    bins: {},
  };

  const tty = text(raw.tty, ttyRe(platform));
  if (tty !== undefined) record.tty = tty;
  const cwd = abs(raw.cwd);
  if (cwd !== undefined) record.cwd = cwd;
  const transcript = abs(raw.transcript_path);
  if (transcript !== undefined) record.transcript_path = transcript;
  const projectRoot = abs(raw.project_root);
  if (projectRoot !== undefined) record.project_root = projectRoot;
  const pathList = text(raw.path, PATH_LIST_RE);
  if (pathList !== undefined) record.path = pathList;

  if (raw.app !== undefined) {
    if (!isPlainObject(raw.app)) return null;
    const via = raw.app.via;
    if (via !== 'ppid-walk' && via !== 'env') return null;
    const app: NonNullable<LocalRecord['app']> = { via };
    const bundle = text(raw.app.bundle, BUNDLE_RE);
    if (bundle !== undefined) app.bundle = bundle;
    const appPath = abs(raw.app.path);
    if (appPath !== undefined) app.path = appPath;
    if (raw.app.pid !== undefined) {
      if (!isPid(raw.app.pid)) return null;
      app.pid = raw.app.pid;
    }
    record.app = app;
  }

  if (raw.mux !== undefined) {
    if (!isPlainObject(raw.mux)) return null;
    const kind = raw.mux.kind;
    if (!isMuxKind(kind)) return null;
    const rules = MUX_RULES[kind];
    const mux: NonNullable<LocalRecord['mux']> = { kind };
    for (const field of MUX_FIELDS) {
      const value = raw.mux[field];
      const rule = rules[field];
      if (value === undefined || !rule) continue;
      if (typeof value !== 'string' || !rule.test(value)) return null;
      mux[field] = value;
    }
    record.mux = mux;
  }

  if (raw.codex !== undefined) {
    if (!isPlainObject(raw.codex)) return null;
    const codex: NonNullable<LocalRecord['codex']> = {};
    const thread = text(raw.codex.thread_id, CODEX_ID_RE);
    if (thread !== undefined) codex.thread_id = thread;
    const root = text(raw.codex.root_thread_id, CODEX_ID_RE);
    if (root !== undefined) codex.root_thread_id = root;
    if (raw.codex.parent_thread_id === null) {
      codex.parent_thread_id = null;
    } else {
      const parent = text(raw.codex.parent_thread_id, CODEX_ID_RE);
      if (parent !== undefined) codex.parent_thread_id = parent;
    }
    // The hook writes null for an originator or source it could not read; absent and null read alike.
    const originator = text(raw.codex.originator ?? undefined, TEXT_RE);
    if (originator !== undefined) codex.originator = originator;
    const source = text(raw.codex.source ?? undefined, TEXT_RE);
    if (source !== undefined) codex.source = source;
    record.codex = codex;
  }

  if (raw.bins !== undefined) {
    if (!isPlainObject(raw.bins)) return null;
    for (const [name, value] of Object.entries(raw.bins)) {
      if (!BIN_NAME_RE.test(name) || !isAbsPath(value)) return null;
      record.bins[name] = value;
    }
  }

  if (raw.summary !== undefined) {
    const summary = cleanSummary(raw.summary);
    if (!summary) return null;
    record.summary = summary;
  }

  return bad ? null : record;
}

// ---- Files ----------------------------------------------------------------

/** Newest first; ties broken by pid so the order is stable across runs. */
const byNewest = (a: LocalRecord, b: LocalRecord): number =>
  b.written_at - a.written_at || b.agent_pid - a.agent_pid;

/**
 * Every record the hook kept for a session, `<dir>/sessions/<session_id>/*.json`,
 * newest `written_at` first. A file is refused — counted in `rejected`,
 * never thrown — when it is not a regular file (symlinks included), is
 * readable by group or other, belongs to another uid, is oversized, is not
 * JSON, fails validateRecord(), or names a different session. A session id
 * that is unfit for a path never reaches the filesystem.
 */
export function loadRecords(dir: string, sessionId: string): { records: LocalRecord[]; rejected: number } {
  if (!validSessionId(sessionId)) return { records: [], rejected: 0 };
  const folder = path.join(dir, 'sessions', sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return { records: [], rejected: 0 };
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const records: LocalRecord[] = [];
  let rejected = 0;
  for (const name of names) {
    if (!RECORD_FILE_RE.test(name)) continue; // the hook's temp files, editor droppings
    const file = path.join(folder, name);
    let parsed: unknown;
    try {
      const st = fs.lstatSync(file);
      const foreign = uid !== undefined && st.uid !== uid;
      if (!st.isFile() || (st.mode & 0o077) !== 0 || foreign || st.size > RECORD_MAX_BYTES) {
        rejected += 1;
        continue;
      }
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      rejected += 1;
      continue;
    }
    const record = validateRecord(parsed);
    if (!record || record.session_id !== sessionId) {
      rejected += 1;
      continue;
    }
    records.push(record);
  }
  records.sort(byNewest);
  return { records, rejected };
}

/** What pickRecord() consults: the runtime's per-record liveness check, or the facts it already resolved. */
export type AliveCheck = Pick<MachineFacts, 'agentAlive'> | ((record: LocalRecord) => boolean);

/**
 * The record a command is about: the most recently written one whose agent
 * is alive, else simply the most recent (so a `resume` still knows where the
 * session last ran). Null when there is nothing to pick from.
 */
export function pickRecord(records: LocalRecord[], facts: AliveCheck): LocalRecord | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort(byNewest);
  const alive = typeof facts === 'function' ? facts : () => facts.agentAlive;
  return sorted.find((record) => alive(record)) ?? sorted[0];
}
