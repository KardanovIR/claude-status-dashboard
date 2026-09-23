import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveListenerConfig, resumeEnabled } from './config';
import {
  PS, STEP_PATH, SYSTEM_BINS, defaultExecFile, defaultFrontmost, isAgentAlive, runPlan,
  type ExecFile, type ExecOptions,
} from './exec';
import { describe as describePlan, plan } from './plan';
import {
  BUNDLE_RE, INT_RE, SOCKET_RE, TTY_LINUX_RE, TTY_RE, UUID_RE, isAbsPath, loadRecords, pickRecord, validSessionId,
} from './records';
import { launcherResolves, resolveResumeCwd, usableLauncher } from './resume';
import { subscribe, type SubscribeTiming } from './sse';
import {
  COMMAND_TYPES, type CommandFrame, type CommandType, type ListenerConfig, type LocalRecord, type MachineFacts,
  type Outcome, type Plan, type Reason,
} from './types';

/**
 * `agstatus listener run` and `agstatus listener plan`: the process that
 * holds the board's event stream, and the dry run that shows what one tap
 * would do. A command arrives as ids only; everything else — the record,
 * whether the agent is alive, which terminal a multiplexer's client sits in
 * — is resolved here, on this machine, and handed to the pure planner. The
 * runner launches the plan; the ack carries enums. A command can fail in
 * every way and the loop keeps going: nothing short of the signal ends it.
 *
 * Guards (design §5.1): one instance per state dir, one action per command
 * id, one focus per session per 2 s, one respawn per session per 60 s, at
 * most 5 respawns per 10 min machine-wide, and a circuit breaker that
 * ignores the board for 5 min after 20 commands in a minute. Log lines name
 * step labels, exit codes, enums and ids — never a cwd, a tty, an env value
 * or a program's output.
 *
 * A `resume` of a session whose agent is gone is the one command that
 * starts a process (§5.2 step 4). It still runs nothing of its own: the
 * plan hands the host the launcher `agstatus listener install` wrote, and
 * this file only decides whether the machine is in a state to allow it —
 * the launcher exists and is ours (`facts.launcher`), resume is not
 * switched off, the working directory resolved, and neither respawn guard
 * has been spent.
 *
 * The record is data (§5.1): validateRecord() checked every shape without
 * touching the disk; verifyOnDisk() here adds what only this machine can
 * answer — a socket path is a socket, a project root is a directory, both
 * owned by this uid — before the planner sees the record. The process
 * table is data too: every `ps` read carries `uid=` and only this uid's
 * rows (root's, for the walk through `login`) are ever followed, so
 * another local user's processes can neither pick the terminal nor name
 * the app bundle whose Info.plist is read.
 */

const COOLDOWN_MS = 2000;
/**
 * How long a command id stays remembered as one this listener claimed. The
 * board expires a command at 120 s (§3.3) and re-sends only unclaimed ones,
 * so an id older than that can never come back.
 */
const CLAIMED_TTL_MS = 120_000;
/** Neither dedupe map grows past this without a prune: both are guards, not a history. */
const DEDUPE_MAX = 1000;
/** §5.1: one respawn per session per minute, five per machine per ten minutes. */
const RESPAWN_COOLDOWN_MS = 60_000;
const RESPAWN_LIMIT = 5;
const RESPAWN_WINDOW_MS = 10 * 60_000;
/** The ledger those two guards are counted in, next to the other state (0600). */
const RESPAWN_LEDGER = 'respawns.json';
/**
 * How long a respawn is given to prove that something started: the hook
 * writes a fresh record at SessionStart, and until one appears the board is
 * told nothing. Generous on purpose — a cold `open -n -b` plus an agent
 * start can take seconds, and a window that is too short would report a
 * failure over a session that did come up. `open -n -b` exits the moment LaunchServices takes the
 * request, so without this every failure inside the new window — a cold
 * start that never came up, a wrong flag, a launcher that found no record —
 * would still ack `resumed` (§5.2 step 4).
 */
// Long enough for a terminal to cold-start and the agent to appear in the
// process table, short enough to answer before the phone's 15 s timeout.
const RESPAWN_CONFIRM_MS = 8_000;
const RESPAWN_CONFIRM_POLL_MS = 250;
/**
 * What a respawn step gets instead of the runner's 5 s: `open -n -b` on a
 * terminal that is not running yet has to cold start the app before it can
 * take the launcher, and `wezterm cli spawn` waits for its own mux server.
 * Steps the planner timed itself keep their own value.
 */
const RESPAWN_STEP_TIMEOUT_MS = 15_000;
const BREAKER_LIMIT = 20;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_HOLD_MS = 5 * 60_000;
const LOG_MAX_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 10_000;
const PS_TIMEOUT_MS = 3000;
/** A process table with full paths for every comm runs past 64 KB on a busy Mac. */
const TABLE_MAX_BUFFER = 4 * 1024 * 1024;
const APP_WALK_MAX_HOPS = 30;
const MACHINE_ID_RE = /^[0-9a-f]{32}$/;
const PS_ENV: NodeJS.ProcessEnv = { PATH: STEP_PATH };
/** What a listener's command line looks like in `ps -o args=`: `… cli.js listener run [--name …]`. */
const LISTENER_ARGS_RE = /(^|\s)listener\s+run(\s|$)/;
/**
 * What `ps` calls a Node program — this listener, the resume launcher it
 * installs, and an npm-installed agent alike. So it identifies nothing on
 * its own: only the script such a process runs does (agentArgv() below).
 */
const NODE_COMM = 'node';
/**
 * Names that identify nothing on their own, so a `ps` line carrying one is not
 * evidence an agent is running. `node` for the reason above; the shells because
 * findAgent() in the hook falls back to the hook's own parent when it cannot
 * reach a claude/codex ancestor — under fish or nu that parent IS a wrapper
 * shell, which lands in `agent_comm`. A respawn then runs the launcher through
 * a shell for every host whose plan takes a command *string* (tmux, agterm),
 * and that shell's argv carries the session uuid — so without this the launcher
 * is mistaken for the agent it was starting.
 */
const GENERIC_COMMS = new Set([NODE_COMM, 'sh', 'bash', 'zsh', 'fish', 'nu', 'dash', 'ksh']);
/** Env keys whose value is a unix socket path the planner may hand to a tool. */
const SOCKET_ENV_KEYS = [
  'AGTERM_SOCKET', 'WEZTERM_UNIX_SOCKET', 'ALACRITTY_SOCKET', 'HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH',
] as const;
/** An Info.plist past this size is not one we read; of a real one the first 64 KB name the bundle. */
const PLIST_MAX_BYTES = 1 << 20;
const PLIST_READ_BYTES = 64 * 1024;

const currentUid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

export interface ListenerDeps {
  fetchImpl?: typeof fetch;
  execFile?: ExecFile;
  frontmost?: () => Promise<string | null>;
  now?: () => number;
  /** Aborting it stops the stream, drains the queue and resolves runListener(). */
  signal?: AbortSignal;
  /** Shorter SSE waits for tests. */
  timing?: Partial<SubscribeTiming>;
  /** Tests only: how long a respawn has to produce a record before it is called failed. */
  respawnConfirmMs?: number;
}

type Log = (line: string) => void;

// ---- Log file -------------------------------------------------------------

/** Append-only, 0600, rotated once to `.1` at 1 MB; echoed to stderr under AGSTATUS_DEBUG. */
class Logger {
  constructor(private readonly file: string, private readonly echo: boolean) {}

  line(text: string): void {
    const entry = `${new Date().toISOString()} ${text}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        /* first line */
      }
      if (size >= LOG_MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, entry, { mode: 0o600 });
    } catch {
      /* a log that cannot be written must not stop the listener */
    }
    if (this.echo) process.stderr.write(entry);
  }
}

// ---- Single instance ------------------------------------------------------

/**
 * A pid we could signal — one of our own processes. EPERM (someone else's
 * pid, say a system daemon that took a number the lock file kept across a
 * reboot) counts as not ours, or a stale lock would wedge the agent forever.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pid in the lock file, when it is a live listener other than this
 * process: alive, ours, and — where `ps` exists — running `listener run`,
 * so a pid reused by some other program of ours after a reboot never holds
 * the lock either.
 */
async function lockHolder(file: string, exec: ExecFile, platform: NodeJS.Platform): Promise<number | null> {
  let held = 0;
  try {
    held = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return null;
  }
  const pid = String(held);
  if (!Number.isInteger(held) || held <= 0 || held === process.pid || !INT_RE.test(pid)) return null;
  if (!pidAlive(held)) return null;
  if (platform === 'win32') return held;
  const { code, stdout } = await exec(PS, ['-o', 'args=', '-p', pid], { env: PS_ENV, timeout: PS_TIMEOUT_MS });
  return code === 0 && LISTENER_ARGS_RE.test(stdout.split('\n')[0] ?? '') ? held : null;
}

/**
 * Creates the lock file atomically, pid already inside: the file is written
 * next to its place and hard-linked in, which fails with EEXIST when any
 * lock is there, however fresh — so two starters (the LaunchAgent and a
 * manual `listener run`) can never both pass a check and both write. A file
 * system without hard links falls back to an exclusive create.
 */
function tryLock(file: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = `${process.pid}\n`;
  const tmp = path.join(path.dirname(file), `.listener.lock.${process.pid}.tmp`);
  const isExists = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'EEXIST';
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (isExists(err)) return false;
    try {
      fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (fallback) {
      if (isExists(fallback)) return false;
      throw fallback;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Takes the lock, or throws naming the live listener that holds it. An
 * existing file whose pid is dead, not ours, unreadable, or no longer a
 * listener is stale: it is removed and the atomic create is tried once
 * more, so a starter racing us at that moment wins or loses cleanly.
 */
async function acquireLock(file: string, exec: ExecFile, platform: NodeJS.Platform): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryLock(file)) return;
    const holder = await lockHolder(file, exec, platform);
    if (holder !== null) {
      throw new Error(
        `Another listener (pid ${holder}) already holds ${file}. ` +
          'Stop it first: `agstatus listener uninstall`, or `launchctl bootout gui/$UID/com.agstatus.listener`.'
      );
    }
    fs.rmSync(file, { force: true });
  }
  throw new Error(`Could not take ${file}: another listener keeps re-creating it.`);
}

function releaseLock(file: string): void {
  try {
    if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.unlinkSync(file);
  } catch {
    /* not ours, or already gone */
  }
}

// ---- Machine facts --------------------------------------------------------

const ttyRe = (platform: NodeJS.Platform): RegExp => (platform === 'linux' ? TTY_LINUX_RE : TTY_RE);

/**
 * The liveness check lives in ./exec, next to the process-table primitives,
 * because `listener resume-exec` needs it too and must not import this
 * module (this one imports the launcher). Re-exported here: it has been
 * part of the runtime's surface since step 4.
 */
export { isAgentAlive };

// ---- On-disk checks -------------------------------------------------------

const ownedBy = (st: fs.Stats, uid: number | undefined): boolean => uid === undefined || st.uid === uid;

/** An existing unix socket (not a symlink to one) owned by this uid. */
function ownedSocket(p: string, uid: number | undefined): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isSocket() && ownedBy(st, uid);
  } catch {
    return false;
  }
}

/** An existing directory owned by this uid. */
function ownedDir(p: string, uid: number | undefined): boolean {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() && ownedBy(st, uid);
  } catch {
    return false;
  }
}

/**
 * The stat()-backed half of §5.1's record validation, on a copy of the
 * record: a `project_root` that is not a directory of ours is dropped (the
 * IDE row degrades to app activation); a `mux.socket` that is not a socket
 * of ours is dropped (the multiplexer row then fails as bad-record, since
 * a tool must never be pointed at a stranger's path); an env socket value
 * that is not one is dropped like any other odd env value. Returns the
 * names of what was dropped, for the log — names only, never values.
 */
export function verifyOnDisk(
  record: LocalRecord,
  uid: number | undefined = currentUid()
): { record: LocalRecord; dropped: string[] } {
  const dropped: string[] = [];
  const out: LocalRecord = { ...record, env: { ...record.env } };
  if (out.project_root !== undefined && !ownedDir(out.project_root, uid)) {
    delete out.project_root;
    dropped.push('project_root');
  }
  if (out.mux?.socket !== undefined && !ownedSocket(out.mux.socket, uid)) {
    const { socket: _socket, ...mux } = out.mux;
    out.mux = mux;
    dropped.push('mux.socket');
  }
  for (const key of SOCKET_ENV_KEYS) {
    if (out.env[key] !== undefined && !ownedSocket(out.env[key], uid)) {
      delete out.env[key];
      dropped.push(key);
    }
  }
  const listen = out.env.KITTY_LISTEN_ON;
  if (listen !== undefined && !ownedSocket(listen.replace(/^unix:/, ''), uid)) {
    delete out.env.KITTY_LISTEN_ON;
    dropped.push('KITTY_LISTEN_ON');
  }
  return { record: out, dropped };
}

interface ProcRow {
  pid: number;
  ppid: number;
  uid: number;
  comm: string;
}

/** `ps … -o pid=,ppid=,uid=,comm=` rows; comm may contain spaces (…/Visual Studio Code.app/…). */
function parseRows(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), comm: m[4] });
  }
  return rows;
}

/**
 * CFBundleIdentifier out of the bundle's Info.plist, when it is XML and the
 * id has a sane shape. The path came out of the process table, so the file
 * is opened without following into a FIFO (O_NONBLOCK: a pipe planted there
 * must not stop the event loop), must be a regular file of at most 1 MB
 * owned by root or by us, and only its first 64 KB are read — never a
 * readFileSync on a path another process chose.
 */
function bundleIdOf(appPath: string, uid: number): string | undefined {
  if (!isAbsPath(appPath)) return undefined;
  let fd: number | undefined;
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
    fd = fs.openSync(path.join(appPath, 'Contents', 'Info.plist'), flags);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > PLIST_MAX_BYTES || (st.uid !== 0 && st.uid !== uid)) return undefined;
    const buf = Buffer.alloc(Math.min(st.size, PLIST_READ_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(buf.toString('utf8', 0, n));
    const id = m ? m[1].trim() : '';
    return BUNDLE_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing left to close */
      }
    }
  }
}

/**
 * The app that owns a terminal: from the client process on that tty, up the
 * process table to the first ancestor living inside a bundle. The bundle's
 * id comes from its Info.plist, not from anything the record says. Only
 * this uid's processes on the tty count, and the walk follows only this
 * uid's ancestors and root's (Terminal.app's shells hang under a setuid
 * `login`) — a stranger's process ends it. Without a bundle (Linux, or a
 * client under a bare login) the tty alone is known.
 */
async function outerOfTty(
  clientPid: number,
  tty: string,
  exec: ExecFile,
  platform: NodeJS.Platform,
  uid: number
): Promise<MachineFacts['outer']> {
  if (!ttyRe(platform).test(tty)) return undefined;
  const opts: ExecOptions = { env: PS_ENV, timeout: PS_TIMEOUT_MS, maxBuffer: TABLE_MAX_BUFFER };
  const onTty = await exec(PS, ['-t', tty.replace(/^\/dev\//, ''), '-o', 'pid=,ppid=,uid=,comm='], opts);
  if (onTty.code !== 0) return undefined;
  const rows = parseRows(onTty.stdout).filter((r) => r.uid === uid);
  if (rows.length === 0) return undefined;
  const start = rows.find((r) => r.pid === clientPid) ?? rows.reduce((a, b) => (a.pid <= b.pid ? a : b));
  if (platform !== 'darwin') return { tty };

  const all = await exec(PS, ['-axo', 'pid=,ppid=,uid=,comm='], opts);
  if (all.code !== 0) return { tty };
  const table = new Map(parseRows(all.stdout).map((r) => [r.pid, r]));
  let row: ProcRow | undefined = start;
  for (let hop = 0; row && hop < APP_WALK_MAX_HOPS; hop += 1) {
    if (row.uid !== uid && row.uid !== 0) break;
    const at = row.comm.indexOf('.app/Contents/');
    if (at !== -1) {
      const bundle = bundleIdOf(row.comm.slice(0, at + 4), uid);
      return bundle ? { bundle, tty } : { tty };
    }
    if (!(row.ppid > 1)) break;
    row = table.get(row.ppid);
  }
  return { tty };
}

/**
 * What a multiplexer probe learned. The two fields answer different questions
 * and an empty object is the third answer:
 *
 *   { outer }          — there is an attached client, and this is its terminal
 *   { detached: true } — the mux ANSWERED, and it has no attached client
 *   {}                 — we could not ask, so we know nothing
 *
 * The distinction exists because the planner used to collapse all three into
 * "stop at the pane and report `selected`", which made a detached session
 * indistinguishable from a missing tmux binary. Only the middle case may become
 * `mux-detached`; claiming it for the third would be a confident lie.
 */
type OuterProbe = { outer?: MachineFacts['outer']; detached?: boolean };

/** tmux: the most recently active attached client, by its own accounting. */
async function tmuxOuter(
  mux: NonNullable<LocalRecord['mux']>,
  bins: Record<string, string>,
  exec: ExecFile,
  platform: NodeJS.Platform,
  uid: number
): Promise<OuterProbe> {
  const tmux = bins.tmux;
  const { socket } = mux;
  if (!isAbsPath(tmux) || !socket || !SOCKET_RE.test(socket)) return {};
  const clients = await exec(
    tmux,
    ['-S', socket, 'list-clients', '-F', '#{client_pid} #{client_tty} #{client_activity}'],
    { env: PS_ENV, timeout: PS_TIMEOUT_MS }
  );
  if (clients.code !== 0) return {};
  let newest: { pid: number; tty: string; activity: number } | undefined;
  let rows = 0;
  for (const line of clients.stdout.split('\n')) {
    const m = /^(\d{1,10}) (\S+) (\d{1,12})$/.exec(line.trim());
    if (!m) continue;
    rows += 1;
    const client = { pid: Number(m[1]), tty: m[2], activity: Number(m[3]) };
    if (!newest || client.activity > newest.activity) newest = client;
  }
  // tmux exited 0 and listed nothing parsable. Zero rows is what a detached
  // session looks like; rows that all failed the pattern mean tmux said
  // something we do not understand, which is not evidence of detachment.
  if (!newest) return rows === 0 && clients.stdout.trim() === '' ? { detached: true } : {};
  return { outer: await outerOfTty(newest.pid, newest.tty, exec, platform, uid) };
}

/**
 * Herdr: the newest `herdr` process of ours that owns a tty and is not the
 * server. A row counts only when its argv[0] is the configured binary by
 * exact path (or that path resolved, for a Homebrew symlink) — never by
 * basename, so nothing else called `herdr` is ever followed. `ps` shows
 * argv[0] as the shell set it, so a client started as a bare `herdr`
 * through PATH is not matched and the plan stops at the pane.
 */
async function herdrOuter(
  bins: Record<string, string>,
  exec: ExecFile,
  platform: NodeJS.Platform,
  uid: number
): Promise<OuterProbe> {
  const herdr = bins.herdr;
  if (!isAbsPath(herdr)) return {};
  const paths = new Set([herdr]);
  try {
    paths.add(fs.realpathSync(herdr));
  } catch {
    /* the configured path is the one that counts */
  }
  const table = await exec(PS, ['-axo', 'pid=,uid=,tty=,args='], {
    env: PS_ENV,
    timeout: PS_TIMEOUT_MS,
    maxBuffer: TABLE_MAX_BUFFER,
  });
  if (table.code !== 0) return {};
  let newest: { pid: number; tty: string } | undefined;
  for (const line of table.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, pid, rowUid, tty, args] = m;
    if (Number(rowUid) !== uid) continue;
    if (tty === '??' || tty === '?' || tty === '-') continue;
    const words = args.split(/\s+/);
    if (!paths.has(words[0])) continue;
    if (words[1] === 'server') continue;
    const row = { pid: Number(pid), tty: `/dev/${tty}` };
    if (!newest || row.pid > newest.pid) newest = row;
  }
  // `ps` succeeded and no herdr client of ours owns a tty. Unlike tmux, this is
  // not the mux answering a question about itself — it is us failing to find a
  // process, which a client started as a bare `herdr` through PATH also looks
  // like (see the argv[0] rule above). Too weak to call detachment, so it stays
  // "we could not tell" and the plan degrades to the pane as it always did.
  if (!newest) return {};
  return { outer: await outerOfTty(newest.pid, newest.tty, exec, platform, uid) };
}

export interface FactsOptions {
  /**
   * The state directory to look for `agstatus-resume` in. Only a command
   * that may respawn asks for it — a focus never runs the launcher, and a
   * fact nothing reads is two stat()s per tap.
   */
  stateDir?: string;
  /**
   * True for a `resume` whose agent is gone: it needs the launcher, and it
   * needs the outer terminal (the multiplexer rows raise it after starting
   * the new pane) even though nothing of that session is running.
   */
  respawn?: boolean;
}

/**
 * Everything the planner asks about the machine, for one record: the
 * tools, whether the agent lives, for tmux/herdr the terminal their
 * attached client sits in, and — for a respawn — the resume launcher. Any
 * failure on the way to `outer` leaves it unset and the planner stops at
 * the pane; so does a platform without a uid, since the process table
 * cannot be filtered to ours there.
 *
 * `launcher` is filled only while resume is switched on (`"resume": false`
 * in ~/.agstatus.json, or AGSTATUS_RESUME=off in the listener's own
 * environment, turns it off) **and** the state dir is the one the launcher
 * will find again once a host starts it — the script carries two absolute
 * paths and nothing else, so an install that moved the state dir with
 * AGSTATUS_STATE_DIR cannot be resumed (launcherResolves()). The absent
 * fact is precisely what makes every resume plan `unsupported-host`, so
 * both are enforced once, here, and no row has to know about either
 * (§5.2 step 4, §11).
 */
export async function resolveFacts(
  record: LocalRecord,
  bins: Record<string, string>,
  exec: ExecFile,
  agentAlive: boolean,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = currentUid(),
  opts: FactsOptions = {}
): Promise<MachineFacts> {
  const facts: MachineFacts = { platform, bins, agentAlive };
  if (opts.respawn && isAbsPath(opts.stateDir) && resumeEnabled() && launcherResolves(opts.stateDir, platform)) {
    const launcher = usableLauncher(opts.stateDir, uid);
    if (launcher) facts.launcher = launcher;
  }
  if (!record.mux || uid === undefined) return facts;
  if (!agentAlive && !opts.respawn) return facts;
  try {
    let probe: OuterProbe = {};
    if (record.mux.kind === 'tmux') probe = await tmuxOuter(record.mux, bins, exec, platform, uid);
    else if (record.mux.kind === 'herdr') probe = await herdrOuter(bins, exec, platform, uid);
    if (probe.outer) facts.outer = probe.outer;
    // Only tmux and herdr are probed at all, so zellij and screen never set
    // this and never report detachment — they would need their own probe
    // (`zellij list-sessions`, `screen -ls`) to say anything honest about it.
    if (probe.detached) facts.muxDetached = true;
  } catch {
    /* the planner degrades to the pane */
  }
  return facts;
}

/** The record a command is about, with the liveness of the records it took to find it. */
async function chooseRecord(
  records: LocalRecord[],
  exec: ExecFile,
  platform: NodeJS.Platform
): Promise<{ record: LocalRecord; alive: boolean } | null> {
  const liveness = new Map<LocalRecord, boolean>();
  for (const record of records) {
    const alive = await isAgentAlive(record, exec, platform);
    liveness.set(record, alive);
    if (alive) break;
  }
  const record = pickRecord(records, (r) => liveness.get(r) === true);
  return record ? { record, alive: liveness.get(record) === true } : null;
}

// ---- Commands -------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A command frame with every field in shape, or null. The id is lowercased as the server keeps it. */
function parseCommand(raw: unknown): CommandFrame | null {
  if (!isPlainObject(raw)) return null;
  const { id, type, session_id, machine_id, expires_in_ms } = raw;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  if (typeof type !== 'string' || !(COMMAND_TYPES as readonly string[]).includes(type)) return null;
  if (!validSessionId(session_id)) return null;
  if (typeof machine_id !== 'string' || !MACHINE_ID_RE.test(machine_id)) return null;
  const expires = typeof expires_in_ms === 'number' && Number.isFinite(expires_in_ms) ? expires_in_ms : Infinity;
  return { id: id.toLowerCase(), type: type as CommandType, session_id, machine_id, expires_in_ms: expires };
}

const short = (id: string): string => id.slice(0, 8);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The respawn guards' ledger, on disk (§5.1). It lives in the state dir
 * next to the lock file, 0600, because the LaunchAgent is `KeepAlive` with
 * a 10 s throttle: an in-process counter is re-armed by every crash,
 * log-out, `launchctl kickstart` or stream error, and "five per ten
 * minutes machine-wide" would then bound nothing. Unreadable or corrupt
 * reads as empty — the guards may never keep a machine from working.
 */
interface RespawnLedger {
  /** When each respawn this machine allowed happened, inside the 10 min window. */
  machine: number[];
  /** Per session, when it last respawned, inside the 60 s cooldown. */
  sessions: Record<string, number>;
}

const emptyLedger = (): RespawnLedger => ({ machine: [], sessions: {} });

/** At most this many sessions are remembered; the ledger is a guard, not a history. */
const LEDGER_MAX_SESSIONS = 500;

const ledgerPath = (dir: string): string => path.join(dir, RESPAWN_LEDGER);

/** Numbers that are timestamps, nothing else: the file is data, like every other input. */
function parseLedger(raw: unknown, now: number): RespawnLedger {
  const ledger = emptyLedger();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ledger;
  const { machine, sessions } = raw as Record<string, unknown>;
  const fresh = (value: unknown, window: number): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value <= now && now - value < window ? value : null;
  if (Array.isArray(machine)) {
    for (const at of machine) {
      const kept = fresh(at, RESPAWN_WINDOW_MS);
      if (kept !== null) ledger.machine.push(kept);
    }
    ledger.machine.sort((a, b) => a - b);
  }
  if (typeof sessions === 'object' && sessions !== null && !Array.isArray(sessions)) {
    for (const [id, at] of Object.entries(sessions as Record<string, unknown>)) {
      const kept = fresh(at, RESPAWN_COOLDOWN_MS);
      if (kept !== null && validSessionId(id)) ledger.sessions[id] = kept;
    }
  }
  return ledger;
}

function readLedger(dir: string, now: number): RespawnLedger {
  try {
    return parseLedger(JSON.parse(fs.readFileSync(ledgerPath(dir), 'utf8')), now);
  } catch {
    return emptyLedger();
  }
}

/**
 * Temp + rename, 0600, with an exclusive create on an unguessable name so
 * the write can never follow a symlink somebody planted at the temp path.
 */
function writeLedger(dir: string, ledger: RespawnLedger): void {
  const file = ledgerPath(dir);
  const tmp = path.join(dir, `.${RESPAWN_LEDGER}.agstatus-tmp-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch {
    /* a guard that cannot be written must not stop the listener */
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** What a session's records look like right now: one key per record, pid and stamp. */
function recordKeys(dir: string, sessionId: string): Set<string> {
  const { records } = loadRecords(dir, sessionId);
  return new Set(records.map((r) => `${r.agent_pid}:${r.written_at}`));
}

/**
 * The names an agent process for this record runs under: the agent itself,
 * and whatever `agent_comm` the hook saw its pid as (§4) — the same notion
 * of identity isAgentAlive() applies to the recorded pid, which is why the
 * record carries the field at all. `node` is left out: it is what every Node
 * program is called, so as a name it would mean "some Node process", and the
 * one Node process guaranteed to be there during a respawn is our own
 * launcher.
 */
function agentNames(record: LocalRecord): Set<string> {
  const names = new Set<string>([record.agent]);
  const comm = record.agent_comm ? path.basename(record.agent_comm) : '';
  if (comm && !GENERIC_COMMS.has(comm)) names.add(comm);
  return names;
}

/**
 * Whether a `ps -o args=` line is one of those names being *run*, rather
 * than a line that merely contains one: argv[0]'s basename is the agent, or
 * argv[0] is a Node running the agent's own script (`node …/bin/claude
 * --resume <uuid>`, how an npm-installed Claude Code shows up — there the
 * hook recorded `agent_comm: node` too, and the script is the only thing
 * left that names an agent). Words split on whitespace as the herdr row
 * above splits them: a path with a space in it costs a match and can never
 * invent one.
 *
 * This is what keeps the launcher from being mistaken for what it launches.
 * `<node> <cli.js> listener resume-exec <uuid>` carries the session id for
 * as long as the agent it wraps runs, so a test for the id plus the word
 * `claude` anywhere on the line matches the wrapper itself on any machine
 * whose CLI path contains `claude` or `codex` — this repo's own checkout —
 * and the respawn then acks `resumed` for a window that had already closed
 * with "no local record" in it. Neither `node` nor `cli.js` is an agent.
 */
function agentArgv(line: string, names: ReadonlySet<string>): boolean {
  const words = line.trim().split(/\s+/);
  const argv0 = path.basename(words[0] ?? '');
  if (names.has(argv0)) return true;
  return argv0 === NODE_COMM && names.has(path.basename(words[1] ?? ''));
}

/**
 * Is an agent for this session running right now? The launcher's own failures
 * — no record, the directory gone, no binary — all exit within milliseconds
 * and leave nothing behind, so a live agent process carrying the session id is
 * direct evidence that the resume took. The id has passed UUID_RE, so it is
 * a safe needle for a substring match (no shell, no regex); the record says
 * what counts as an agent (agentNames/agentArgv above).
 */
async function agentRunningFor(record: LocalRecord, exec: ExecFile): Promise<boolean> {
  const names = agentNames(record);
  try {
    // The full argv table runs to hundreds of kilobytes on a busy Mac, well
    // past the default buffer — the other process-table reads size it the same way.
    const { code, stdout } = await exec(PS, ['-axo', 'args='], {
      env: PS_ENV, timeout: PS_TIMEOUT_MS, maxBuffer: TABLE_MAX_BUFFER,
    });
    if (code !== 0) return false;
    for (const line of stdout.split('\n')) {
      if (line.includes(record.session_id) && agentArgv(line, names)) return true;
    }
  } catch {
    /* a process table we cannot read is not evidence either way */
  }
  return false;
}

/**
 * Evidence that a respawn actually came up, polled until the window closes.
 * Two independent signals, because each is missing in a case the other covers:
 * the hook's SessionStart record is definitive but can take longer than the
 * phone waits when a transcript is large, and a live agent process appears in
 * a second but is invisible for a host that resumes inside its own GUI.
 *
 * `record` is the one the command resolved to: it carries the session id the
 * evidence is about, and the agent identity the process table is read with.
 */
async function respawnStarted(
  dir: string,
  record: LocalRecord,
  before: Set<string>,
  windowMs: number,
  sleep: (ms: number) => Promise<void>,
  exec?: ExecFile
): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    for (const key of recordKeys(dir, record.session_id)) if (!before.has(key)) return true;
    if (exec && (await agentRunningFor(record, exec))) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(RESPAWN_CONFIRM_POLL_MS, left));
  }
}

interface RunnerDeps {
  cfg: ListenerConfig;
  log: Log;
  fetchImpl: typeof fetch;
  execFile: ExecFile;
  frontmost: () => Promise<string | null>;
  now: () => number;
  /** Every argv[0] a plan may name: the config's tools plus the fixed system table. */
  allowed: ReadonlySet<string>;
  /** How long a respawn has to write a record before it counts as failed. */
  respawnConfirmMs: number;
}

/**
 * The only argv[0]s the runner will launch, whatever a plan says. The
 * resume launcher is deliberately **not** in it: a respawn row hands the
 * launcher to the host's own tool (as an argument, or inside the one
 * quoted command string), so it is never argv[0] and the allowlist stays
 * "the tools the installer resolved, and nothing else".
 */
export function allowedArgv0(cfg: ListenerConfig): ReadonlySet<string> {
  return new Set<string>([...Object.values(cfg.bins), ...Object.values(SYSTEM_BINS)]);
}

/** A respawn's steps get the longer timeout; a row that set its own keeps it. */
function withRespawnTimeouts(made: Plan): Plan {
  if (!made.respawns) return made;
  return {
    ...made,
    steps: made.steps.map((step) => (step.timeoutMs === undefined ? { ...step, timeoutMs: RESPAWN_STEP_TIMEOUT_MS } : step)),
  };
}

/**
 * A respawn that reached a launch and failed is `respawn-failed`, not
 * "this host cannot do it": the row was right, the start was not (§5.2
 * step 4). `bad-record` is the runner's refusal *before* any launch — an
 * argv[0] outside the tool table — and keeps its own name.
 */
function respawnOutcome(outcome: Outcome): Outcome {
  if (outcome.result !== 'failed' || outcome.reason === 'bad-record') return outcome;
  return { result: 'failed', reason: 'respawn-failed' };
}

/** Commands, one at a time, in the order the board sent them. */
class CommandRunner {
  private queue: Promise<void> = Promise.resolve();
  /** Keyed `<session>:<type>`: a resume must never be swallowed by the focus that offered it. */
  private readonly lastActed = new Map<string, number>();
  /** Keyed by command id: what this listener has already claimed, so one tap is acted on once. */
  private readonly claimed = new Map<string, number>();
  private recent: number[] = [];
  private breakerUntil = 0;

  constructor(private readonly deps: RunnerDeps) {
    // The respawn guards live on disk (allowRespawn below); this only says
    // at start what the LaunchAgent's last life already spent of them.
    const spent = readLedger(deps.cfg.stateDir, deps.now()).machine.length;
    if (spent > 0) {
      deps.log(`respawn ledger: ${spent}/${RESPAWN_LIMIT} spent in the last ${RESPAWN_WINDOW_MS / 60_000} min`);
    }
  }

  onFrame(event: string, data: unknown): void {
    if (event === 'commands' && Array.isArray(data)) data.forEach((item) => this.enqueue(item));
    else if (event === 'command') this.enqueue(data);
  }

  /** Resolves when every queued command has been acted on. */
  drain(): Promise<void> {
    return this.queue;
  }

  private enqueue(raw: unknown): void {
    const { cfg, log } = this.deps;
    const cmd = parseCommand(raw);
    if (!cmd) {
      log('command: malformed frame ignored');
      return;
    }
    if (cmd.machine_id !== cfg.machinePublicId) return;
    this.queue = this.queue.then(() => this.handle(cmd)).catch((err: unknown) => {
      log(`command ${short(cmd.id)}: ${(err as Error).name}`);
    });
  }

  private tripped(now: number): boolean {
    if (now < this.breakerUntil) return true;
    this.recent = this.recent.filter((t) => now - t < BREAKER_WINDOW_MS);
    this.recent.push(now);
    if (this.recent.length < BREAKER_LIMIT) return false;
    this.breakerUntil = now + BREAKER_HOLD_MS;
    this.recent = [];
    this.deps.log(`breaker: ${BREAKER_LIMIT} commands within a minute — ignoring commands for 5 min`);
    return true;
  }

  /**
   * The respawn guards of §5.1, enforced here rather than in the planner:
   * the planner is pure and has no clock, and these are about this machine
   * over time, not about this host. One respawn per session per 60 s bounds
   * a double tap (the 2 s focus cooldown is far too short for something
   * that opens a window); 5 per 10 min machine-wide bounds a board that has
   * gone mad, or a leaked token, to a handful of terminal windows holding
   * the user's own sessions. A refusal spends nothing and launches nothing.
   */
  private allowRespawn(sessionId: string, at: number, tag: string): boolean {
    const { log, cfg } = this.deps;
    // Re-read: another listener process (a `listener run` next to the
    // LaunchAgent, or this agent's own predecessor 10 s ago) may have spent
    // part of the quota since the constructor.
    const ledger = readLedger(cfg.stateDir, at);
    const last = ledger.sessions[sessionId];
    if (last !== undefined && at - last < RESPAWN_COOLDOWN_MS) {
      log(`${tag}: one respawn per session per ${RESPAWN_COOLDOWN_MS / 1000}s — refused`);
      return false;
    }
    ledger.machine = ledger.machine.filter((t) => at - t < RESPAWN_WINDOW_MS);
    if (ledger.machine.length >= RESPAWN_LIMIT) {
      log(`${tag}: ${RESPAWN_LIMIT} respawns within ${RESPAWN_WINDOW_MS / 60_000} min — refused`);
      return false;
    }
    ledger.machine.push(at);
    ledger.sessions[sessionId] = at;
    const ids = Object.keys(ledger.sessions);
    if (ids.length > LEDGER_MAX_SESSIONS) {
      for (const id of ids) if (at - ledger.sessions[id] >= RESPAWN_COOLDOWN_MS) delete ledger.sessions[id];
    }
    writeLedger(cfg.stateDir, ledger);
    return true;
  }

  /**
   * What the two dedupe guards read, written at the one moment they are
   * about: a claim came back 200, so this listener is the one acting on this
   * command. Each map is pruned of what is past its own window when it
   * grows — a listener that ran for a month must not hold every id it saw.
   */
  private remember(id: string, key: string, at: number): void {
    this.lastActed.set(key, at);
    this.claimed.set(id, at);
    if (this.lastActed.size > DEDUPE_MAX) {
      for (const [k, t] of this.lastActed) if (at - t >= COOLDOWN_MS) this.lastActed.delete(k);
    }
    if (this.claimed.size > DEDUPE_MAX) {
      for (const [k, t] of this.claimed) if (at - t >= CLAIMED_TTL_MS) this.claimed.delete(k);
    }
  }

  private async handle(cmd: CommandFrame): Promise<void> {
    const { log, now } = this.deps;
    const at = now();
    const tag = `command ${short(cmd.id)}`;
    if (this.tripped(at)) return;
    if (cmd.expires_in_ms <= 0) {
      log(`${tag}: already expired, skipped`);
      return;
    }
    // One id is acted on once, however often it arrives. The board re-sends
    // what it has not seen acked in the `commands` frame of every reconnect,
    // and that is the same tap, not a second one; the claim below already
    // makes acting exactly-once *across* processes (409 once anyone claimed),
    // and this is the same rule inside the one that did the claiming. It is
    // what the cooldown used to cover by accident, before it stopped being
    // spent on commands this listener never got to act on.
    if (this.claimed.has(cmd.id)) {
      log(`${tag}: already claimed by this listener, skipped`);
      return;
    }
    // Per session AND per type: the board offers Resume only after a focus
    // came back `not-running`, so a cooldown keyed on the session alone
    // would swallow the one tap it is there to make possible — silently,
    // before the claim, leaving the phone with no answer at all and the
    // command to be re-delivered on the next SSE connect. Resume-to-resume
    // taps stay bounded by the respawn guards, which are far stricter.
    const key = `${cmd.session_id}:${cmd.type}`;
    const last = this.lastActed.get(key);
    if (last !== undefined && at - last < COOLDOWN_MS) {
      log(`${tag}: within the ${COOLDOWN_MS}ms cooldown for its session and type, skipped`);
      return;
    }

    const claim = await this.post(`/commands/${cmd.id}/claim`, { machine_key: this.deps.cfg.machineKey });
    if (claim !== 200) {
      // This return is deliberately ahead of remember(): a claim that never
      // landed leaves the command pending, so the board re-sends it on the
      // next connect — and the first backoff is about a second, i.e. *inside*
      // the 2 s window. A cooldown spent on a command this listener never
      // acted on would swallow that re-delivery, and the tap would then do
      // nothing at all until the command expired.
      log(`${tag}: claim ${claim === 0 ? 'unreachable' : `HTTP ${claim}`}, skipped`);
      return;
    }
    this.remember(cmd.id, key, at);
    const started = Date.now();
    let outcome: Outcome;
    let experimental = false;
    try {
      ({ outcome, experimental } = await this.execute(cmd, tag, at));
    } catch (err) {
      log(`${tag}: ${(err as Error).name} while acting — acking bad-record`);
      outcome = { result: 'failed', reason: 'bad-record' };
    }
    const ack = await this.ack(cmd, outcome);
    const summary = [outcome.result, outcome.reach && `reach ${outcome.reach}`, outcome.reason && `reason ${outcome.reason}`]
      .filter(Boolean)
      .join(', ');
    log(`${tag}: ${cmd.type} → ${summary} (${Date.now() - started}ms${experimental ? ', experimental' : ''})` +
      (ack === 200 ? '' : `; ack ${ack === 0 ? 'unreachable' : `HTTP ${ack}`}`));
  }

  private async execute(cmd: CommandFrame, tag: string, at: number): Promise<{ outcome: Outcome; experimental: boolean }> {
    const { cfg, log, execFile, frontmost, allowed } = this.deps;
    const { records, rejected } = loadRecords(cfg.stateDir, cmd.session_id);
    if (rejected > 0) log(`${tag}: ${rejected} record(s) refused (mode, owner or shape)`);
    const chosen = await chooseRecord(records, execFile, process.platform);
    if (!chosen) return { outcome: { result: 'failed', reason: 'no-record' }, experimental: false };
    const { record, dropped } = verifyOnDisk(chosen.record);
    if (dropped.length > 0) log(`${tag}: dropped ${dropped.join(', ')} (not a directory/socket of ours)`);
    // A resume of a session that is still alive is a focus (the planner's
    // ladder); only a dead one respawns, and only that needs the launcher
    // and a directory to start in. Both are resolved here, on this
    // machine — the planner reads no disk. The log names the fields, never
    // the paths.
    const respawn = cmd.type === 'resume' && !chosen.alive;
    const facts = await resolveFacts(record, cfg.bins, execFile, chosen.alive, process.platform, currentUid(), {
      stateDir: cfg.stateDir,
      respawn,
    });
    let resumeCwd: string | undefined;
    if (respawn) {
      resumeCwd = resolveResumeCwd(record);
      log(`${tag}: resume — launcher ${facts.launcher ? 'ready' : 'absent'}, cwd ${resumeCwd ? 'resolved' : 'unresolved'}`);
    }
    const planned = plan(record, cmd.type, facts, resumeCwd);
    if (!planned.ok) return { outcome: { result: 'failed', reason: planned.reason }, experimental: false };
    const made = planned.plan;
    log(`${tag}: pid ${record.agent_pid}, ${made.description}`);
    // A guard refusal launches nothing, so it is not an experimental row
    // having been tried — the log says so, like any other refusal.
    if (made.respawns === true && !this.allowRespawn(cmd.session_id, at, tag)) {
      return { outcome: { result: 'failed', reason: 'respawn-failed' }, experimental: false };
    }
    // What the session's records look like before anything starts: the
    // evidence a respawn is checked against below.
    const before = made.respawns === true ? recordKeys(cfg.stateDir, cmd.session_id) : undefined;
    const outcome = await runPlan(withRespawnTimeouts(made), { execFile, frontmost, log, allowed });
    if (made.respawns !== true) return { outcome, experimental: made.experimental };
    const spawned = respawnOutcome(outcome);
    if (spawned.result !== 'resumed') return { outcome: spawned, experimental: made.experimental };
    // Every respawn step exited 0 — which on `open -n -b` only means
    // LaunchServices took the request. Wait for the hook to write a record
    // for this session before telling the phone it is back (§5.2 step 4).
    const started = await respawnStarted(
      cfg.stateDir, record, before ?? new Set(), this.deps.respawnConfirmMs, pause, execFile
    );
    if (!started) {
      log(`${tag}: no record and no agent for the session within ${this.deps.respawnConfirmMs}ms — nothing came up`);
      return { outcome: { result: 'failed', reason: 'respawn-failed' }, experimental: made.experimental };
    }
    log(`${tag}: confirmed started`);
    return { outcome: spawned, experimental: made.experimental };
  }

  /** `{machine_key, result, reach?, reason?}` and not one key more; a failure always names a reason. */
  private ack(cmd: CommandFrame, outcome: Outcome): Promise<number> {
    const body: Record<string, string> = { machine_key: this.deps.cfg.machineKey, result: outcome.result };
    if (outcome.reach) body.reach = outcome.reach;
    if (outcome.result === 'failed') body.reason = outcome.reason ?? ('unsupported-host' satisfies Reason);
    return this.post(`/commands/${cmd.id}/ack`, body);
  }

  /**
   * The HTTP status, or 0 when the board could not be reached. The protocol
   * never redirects, so a 30x — from the board, or from whoever sits on an
   * http:// board's path — is an error, never a replay of the key elsewhere.
   */
  private async post(route: string, body: Record<string, string>): Promise<number> {
    const { cfg, fetchImpl } = this.deps;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.secret) headers['x-webhook-secret'] = cfg.secret;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${cfg.base}${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        redirect: 'error',
      });
      try {
        await res.arrayBuffer();
      } catch {
        /* the status is what matters */
      }
      return res.status;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- Entry points ---------------------------------------------------------

/**
 * The listener proper. Resolves only when `deps.signal` aborts; throws
 * before subscribing when another instance holds the lock. Nothing a
 * command does can end it.
 */
export async function runListener(cfg: ListenerConfig, deps: ListenerDeps = {}): Promise<void> {
  const execFile = deps.execFile ?? defaultExecFile;
  await acquireLock(cfg.lockFile, execFile, process.platform);
  const logger = new Logger(cfg.logFile, Boolean(process.env.AGSTATUS_DEBUG));
  const log: Log = (line) => logger.line(line);
  const signal = deps.signal ?? new AbortController().signal;
  const runner = new CommandRunner({
    cfg,
    log,
    fetchImpl: deps.fetchImpl ?? fetch,
    execFile,
    frontmost: deps.frontmost ?? defaultFrontmost,
    now: deps.now ?? Date.now,
    allowed: allowedArgv0(cfg),
    respawnConfirmMs: deps.respawnConfirmMs ?? RESPAWN_CONFIRM_MS,
  });
  const tools = Object.keys(cfg.bins).sort().join(',') || 'none';
  log(`listener start: pid ${process.pid}, machine ${cfg.machinePublicId} "${cfg.name}", tools ${tools}`);
  try {
    await subscribe({
      base: cfg.base,
      secret: cfg.secret,
      machinePublicId: cfg.machinePublicId,
      machineKey: cfg.machineKey,
      name: cfg.name,
      onFrame: (event, data) => runner.onFrame(event, data),
      signal,
      fetchImpl: deps.fetchImpl,
      log,
      timing: deps.timing,
    });
    await runner.drain();
  } finally {
    releaseLock(cfg.lockFile);
    log('listener stop');
  }
}

export interface PlanCommandDeps {
  execFile?: ExecFile;
  /** Only read when `execute` is set: how the runner checks what came to the front. */
  frontmost?: () => Promise<string | null>;
  /** `--url`: the board the caller resolved against, so both halves of `agstatus focus` agree on which machine is "this" one. */
  url?: string;
  platform?: NodeJS.Platform;
  /** `--resume`: plan the Resume tap (a respawn when the agent is gone) instead of the focus. */
  resume?: boolean;
  /**
   * Run the plan instead of printing it — what `agstatus focus` uses for a
   * session hosted on this machine. Identical resolution, identical steps,
   * identical argv[0] table; only the last line of this function differs.
   * The board never hears about it, which is the point: a key press must not
   * spend the workspace's 10-commands-a-minute budget, and must still work
   * with the board unreachable.
   */
  execute?: boolean;
}

/**
 * `agstatus listener plan <session_id> [--resume]`: what a tap on that
 * session would run on this machine, without running it. Exit 0 with the
 * steps, 1 with the reason there are none. The dry run resolves exactly
 * what the runtime would — the launcher, and for a dead session the
 * working directory — but prints neither path, only whether they resolved.
 */
export async function runPlanCommand(sessionId: string, log: Log, deps: PlanCommandDeps = {}): Promise<number> {
  if (!validSessionId(sessionId)) {
    log('✖ The session id may contain only letters, digits, ".", "_", ":" and "-".');
    return 1;
  }
  const cfg = resolveListenerConfig(deps.url !== undefined ? { url: deps.url } : {});
  if ('error' in cfg) {
    log(`✖ ${cfg.error}`);
    return 1;
  }
  const exec = deps.execFile ?? defaultExecFile;
  const platform = deps.platform ?? process.platform;
  const { records, rejected } = loadRecords(cfg.stateDir, sessionId);
  log(`Session ${sessionId}: ${records.length} record(s)${rejected ? `, ${rejected} refused (mode, owner or shape)` : ''}`);
  const chosen = await chooseRecord(records, exec, platform);
  if (!chosen) {
    log('  No local record — the hook writes one only while Focus is on (`agstatus listener install`).');
    return 1;
  }
  const { alive } = chosen;
  const { record, dropped } = verifyOnDisk(chosen.record);
  log(
    `  Using pid ${record.agent_pid} (${record.agent}, ${alive ? 'running' : 'not running'}; ` +
      `app ${record.app?.bundle ?? '-'}; mux ${record.mux?.kind ?? '-'})`
  );
  if (dropped.length > 0) log(`  Ignored ${dropped.join(', ')}: not a directory/socket owned by this user`);
  const type: CommandType = deps.resume === true ? 'resume' : 'focus';
  const respawn = type === 'resume' && !alive;
  const facts = await resolveFacts(record, cfg.bins, exec, alive, platform, undefined, {
    stateDir: cfg.stateDir,
    respawn,
  });
  if (record.mux) log(`  Outer app: ${facts.outer?.bundle ?? 'not resolved'}`);
  let resumeCwd: string | undefined;
  if (respawn) {
    resumeCwd = resolveResumeCwd(record);
    const why = launcherResolves(cfg.stateDir, platform)
      ? 'not installed (or "resume": false)'
      : 'unusable: this install\'s state directory is not the one the launcher would read';
    log(
      `  Resume: launcher ${facts.launcher ? 'ready' : why}` +
        `, working directory ${resumeCwd ? 'resolved' : 'not resolved'}`
    );
  }
  const planned = plan(record, type, facts, resumeCwd);
  if (!planned.ok) {
    log(`  No plan: ${planned.reason}`);
    return 1;
  }
  if (deps.execute !== true) {
    log(`  Plan${planned.plan.experimental ? ' (experimental)' : ''}:`);
    for (const line of describePlan(planned.plan).split('\n')) log(`    ${line}`);
    return 0;
  }
  // Focus only. A respawn needs the guards that live in the listener — the
  // 60 s per-session cooldown on disk, the respawn-confirmation wait, the
  // longer step timeouts — and running one from here would skip all three.
  // Nothing asks for this today; the check is here so nothing starts to.
  if (planned.plan.respawns === true) {
    log('  Refusing to respawn from here — use Resume on the board.');
    return 1;
  }
  const outcome = await runPlan(planned.plan, {
    execFile: exec,
    frontmost: deps.frontmost ?? defaultFrontmost,
    log: (line) => log(`  ${line}`),
    allowed: allowedArgv0(cfg),
  });
  log(`  ${outcome.result}${outcome.reason ? `: ${outcome.reason}` : ''}`);
  // `selected` means the steps ran but the app did not come to the front in
  // time — a degraded focus, not a failure. Only `failed` is worth a non-zero
  // exit, and a hotkey wrapper discards it anyway.
  return outcome.result === 'failed' ? 1 : 0;
}
