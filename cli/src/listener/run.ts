import fs from 'fs';
import path from 'path';
import { resolveListenerConfig } from './config';
import {
  PS, STEP_PATH, SYSTEM_BINS, defaultExecFile, defaultFrontmost, runPlan, type ExecFile, type ExecOptions,
} from './exec';
import { describe as describePlan, plan } from './plan';
import {
  BUNDLE_RE, INT_RE, SOCKET_RE, TTY_LINUX_RE, TTY_RE, UUID_RE, isAbsPath, loadRecords, pickRecord, validSessionId,
} from './records';
import { subscribe, type SubscribeTiming } from './sse';
import {
  COMMAND_TYPES, type CommandFrame, type CommandType, type ListenerConfig, type LocalRecord, type MachineFacts,
  type Outcome, type Reason,
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
 * Guards (design §5.1): one instance per state dir, one focus per session
 * per 2 s, and a circuit breaker that ignores the board for 5 min after 20
 * commands in a minute. Log lines name step labels, exit codes, enums and
 * ids — never a cwd, a tty, an env value or a program's output.
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
          'Stop it first: `npx agstatus listener uninstall`, or `launchctl bootout gui/$UID/com.agstatus.listener`.'
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
 * `agent_pid` is live and its comm is the recorded one (basenames compared:
 * macOS prints the executable's full path, the hook may have kept either).
 * A record without a comm — the hook could not read the process table —
 * is not trusted on the pid alone: the live comm must then be the agent's
 * own name or `node`, the two shapes a Claude/Codex process takes. Windows
 * has no ps; the pid is probed instead.
 */
export async function isAgentAlive(
  record: LocalRecord,
  exec: ExecFile,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform === 'win32') return pidAlive(record.agent_pid);
  const pid = String(record.agent_pid);
  if (!INT_RE.test(pid)) return false;
  const { code, stdout } = await exec(PS, ['-o', 'comm=', '-p', pid], { env: PS_ENV, timeout: PS_TIMEOUT_MS });
  if (code !== 0) return false;
  const comm = stdout.split('\n')[0]?.trim() ?? '';
  if (!comm) return false;
  const name = path.basename(comm);
  if (record.agent_comm) return name === path.basename(record.agent_comm);
  return name === record.agent || name === 'node';
}

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

/** tmux: the most recently active attached client, by its own accounting. */
async function tmuxOuter(
  mux: NonNullable<LocalRecord['mux']>,
  bins: Record<string, string>,
  exec: ExecFile,
  platform: NodeJS.Platform,
  uid: number
): Promise<MachineFacts['outer']> {
  const tmux = bins.tmux;
  const { socket } = mux;
  if (!isAbsPath(tmux) || !socket || !SOCKET_RE.test(socket)) return undefined;
  const clients = await exec(
    tmux,
    ['-S', socket, 'list-clients', '-F', '#{client_pid} #{client_tty} #{client_activity}'],
    { env: PS_ENV, timeout: PS_TIMEOUT_MS }
  );
  if (clients.code !== 0) return undefined;
  let newest: { pid: number; tty: string; activity: number } | undefined;
  for (const line of clients.stdout.split('\n')) {
    const m = /^(\d{1,10}) (\S+) (\d{1,12})$/.exec(line.trim());
    if (!m) continue;
    const client = { pid: Number(m[1]), tty: m[2], activity: Number(m[3]) };
    if (!newest || client.activity > newest.activity) newest = client;
  }
  if (!newest) return undefined;
  return outerOfTty(newest.pid, newest.tty, exec, platform, uid);
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
): Promise<MachineFacts['outer']> {
  const herdr = bins.herdr;
  if (!isAbsPath(herdr)) return undefined;
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
  if (table.code !== 0) return undefined;
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
  if (!newest) return undefined;
  return outerOfTty(newest.pid, newest.tty, exec, platform, uid);
}

/**
 * Everything the planner asks about the machine, for one record: the
 * tools, whether the agent lives, and for tmux/herdr the terminal their
 * attached client sits in. Any failure on the way to `outer` leaves it
 * unset and the planner stops at the pane; so does a platform without a
 * uid, since the process table cannot be filtered to ours there.
 */
export async function resolveFacts(
  record: LocalRecord,
  bins: Record<string, string>,
  exec: ExecFile,
  agentAlive: boolean,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = currentUid()
): Promise<MachineFacts> {
  const facts: MachineFacts = { platform, bins, agentAlive };
  if (!record.mux || !agentAlive || uid === undefined) return facts;
  try {
    let outer: MachineFacts['outer'];
    if (record.mux.kind === 'tmux') outer = await tmuxOuter(record.mux, bins, exec, platform, uid);
    else if (record.mux.kind === 'herdr') outer = await herdrOuter(bins, exec, platform, uid);
    if (outer) facts.outer = outer;
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

interface RunnerDeps {
  cfg: ListenerConfig;
  log: Log;
  fetchImpl: typeof fetch;
  execFile: ExecFile;
  frontmost: () => Promise<string | null>;
  now: () => number;
  /** Every argv[0] a plan may name: the config's tools plus the fixed system table. */
  allowed: ReadonlySet<string>;
}

/** The only argv[0]s the runner will launch, whatever a plan says. */
export function allowedArgv0(cfg: ListenerConfig): ReadonlySet<string> {
  return new Set<string>([...Object.values(cfg.bins), ...Object.values(SYSTEM_BINS)]);
}

/** Commands, one at a time, in the order the board sent them. */
class CommandRunner {
  private queue: Promise<void> = Promise.resolve();
  private readonly lastActed = new Map<string, number>();
  private recent: number[] = [];
  private breakerUntil = 0;

  constructor(private readonly deps: RunnerDeps) {}

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

  private async handle(cmd: CommandFrame): Promise<void> {
    const { log, now } = this.deps;
    const at = now();
    const tag = `command ${short(cmd.id)}`;
    if (this.tripped(at)) return;
    if (cmd.expires_in_ms <= 0) {
      log(`${tag}: already expired, skipped`);
      return;
    }
    const last = this.lastActed.get(cmd.session_id);
    if (last !== undefined && at - last < COOLDOWN_MS) {
      log(`${tag}: within the ${COOLDOWN_MS}ms cooldown for its session, skipped`);
      return;
    }
    if (this.lastActed.size > 1000) {
      for (const [id, t] of this.lastActed) if (at - t >= COOLDOWN_MS) this.lastActed.delete(id);
    }
    this.lastActed.set(cmd.session_id, at);

    const claim = await this.post(`/commands/${cmd.id}/claim`, { machine_key: this.deps.cfg.machineKey });
    if (claim !== 200) {
      log(`${tag}: claim ${claim === 0 ? 'unreachable' : `HTTP ${claim}`}, skipped`);
      return;
    }
    const started = Date.now();
    let outcome: Outcome;
    let experimental = false;
    try {
      ({ outcome, experimental } = await this.execute(cmd, tag));
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

  private async execute(cmd: CommandFrame, tag: string): Promise<{ outcome: Outcome; experimental: boolean }> {
    const { cfg, log, execFile, frontmost, allowed } = this.deps;
    const { records, rejected } = loadRecords(cfg.stateDir, cmd.session_id);
    if (rejected > 0) log(`${tag}: ${rejected} record(s) refused (mode, owner or shape)`);
    const chosen = await chooseRecord(records, execFile, process.platform);
    if (!chosen) return { outcome: { result: 'failed', reason: 'no-record' }, experimental: false };
    const { record, dropped } = verifyOnDisk(chosen.record);
    if (dropped.length > 0) log(`${tag}: dropped ${dropped.join(', ')} (not a directory/socket of ours)`);
    const facts = await resolveFacts(record, cfg.bins, execFile, chosen.alive);
    const planned = plan(record, cmd.type, facts);
    if (!planned.ok) return { outcome: { result: 'failed', reason: planned.reason }, experimental: false };
    log(`${tag}: pid ${record.agent_pid}, ${planned.plan.description}`);
    const outcome = await runPlan(planned.plan, { execFile, frontmost, log, allowed });
    return { outcome, experimental: planned.plan.experimental };
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
  platform?: NodeJS.Platform;
}

/**
 * `agstatus listener plan <session_id>`: what a focus tap on that session
 * would run on this machine, without running it. Exit 0 with the steps,
 * 1 with the reason there are none.
 */
export async function runPlanCommand(sessionId: string, log: Log, deps: PlanCommandDeps = {}): Promise<number> {
  if (!validSessionId(sessionId)) {
    log('✖ The session id may contain only letters, digits, ".", "_", ":" and "-".');
    return 1;
  }
  const cfg = resolveListenerConfig();
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
    log('  No local record — the hook writes one only while Focus is on (`npx agstatus listener install`).');
    return 1;
  }
  const { alive } = chosen;
  const { record, dropped } = verifyOnDisk(chosen.record);
  log(
    `  Using pid ${record.agent_pid} (${record.agent}, ${alive ? 'running' : 'not running'}; ` +
      `app ${record.app?.bundle ?? '-'}; mux ${record.mux?.kind ?? '-'})`
  );
  if (dropped.length > 0) log(`  Ignored ${dropped.join(', ')}: not a directory/socket owned by this user`);
  const facts = await resolveFacts(record, cfg.bins, exec, alive, platform);
  if (record.mux) log(`  Outer app: ${facts.outer?.bundle ?? 'not resolved'}`);
  const planned = plan(record, 'focus', facts);
  if (!planned.ok) {
    log(`  No plan: ${planned.reason}`);
    return 1;
  }
  log(`  Plan${planned.plan.experimental ? ' (experimental)' : ''}:`);
  for (const line of describePlan(planned.plan).split('\n')) log(`    ${line}`);
  return 0;
}
