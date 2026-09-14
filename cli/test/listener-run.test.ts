import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { machineKey, publicId, writeMachine } from '../src/listener/config';
import { SYSTEM_BINS, runPlan } from '../src/listener/exec';
import type { ExecFile, ExecOptions } from '../src/listener/exec';
import {
  allowedArgv0, isAgentAlive, resolveFacts, runListener, runPlanCommand, verifyOnDisk, type ListenerDeps,
} from '../src/listener/run';
import { MAX_FRAME_BYTES, OversizedFrameError, SseParser } from '../src/listener/sse';
import type { ListenerConfig, LocalRecord, Plan } from '../src/listener/types';

/**
 * The runtime against a fake board that lives in this process: an SSE
 * endpoint that scripts frames per connection and records claims and acks,
 * with process launches replaced by a recorder. Nothing here spawns a real
 * tool — the assertions are about what would have been launched, how, and
 * what the board was told.
 */

const SESSION = '5a1d2f6e-9b3c-4d7e-8f01-23456789abcd';
const OTHER_SESSION = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const MACHINE_ID = '6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const AGTERM = 'com.umputun.agterm';
/** Marks values that may never reach a launch, an ack or the log. */
const NEVER = 'never-in-a-launch';

/** The socket itself is per fixture: the listener refuses a path that is not a live socket of ours. */
const AGTERM_ENV = {
  TERM_PROGRAM: 'agterm',
  AGTERM_SESSION_ID: '0d8f5c1e-2b7a-4c3d-9e1f-6a5b4c3d2e1f',
  AGTERM_WINDOW_ID: '7c1b9e4a-3f2d-4e5b-8a6c-1d2e3f4a5b6c',
};

const ENV_KEYS = [
  'HOME', 'PATH', 'AGSTATUS_STATE_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_STATUS_URL',
  'CLAUDE_STATUS_SECRET', 'AGSTATUS_FOCUS', 'AGSTATUS_DEBUG', 'AWS_SECRET_ACCESS_KEY',
];

let uuidCounter = 0;
const commandId = (): string => `c0ffee00-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;

// ---- Fake board -----------------------------------------------------------

interface Connection {
  at: number;
  query: URLSearchParams;
  secret: string | undefined;
  res: http.ServerResponse;
}
interface Posted {
  id: string;
  body: Record<string, unknown>;
}
interface FakeBoard {
  base: string;
  connections: Connection[];
  claims: Posted[];
  acks: Posted[];
  /** Requests that reached /redirected — where a followed 30x would have carried the key. */
  redirected: string[];
  /** A frame to the most recent stream. */
  send(event: string, data: unknown): void;
  /** Bytes to the most recent stream, exactly as given. */
  raw(text: string): void;
  /** End the most recent stream, as a restarting server would. */
  end(): void;
  close(): Promise<void>;
}
interface FakeOptions {
  /** What the n-th /events connect gets: a stream, or a bare HTTP status (a 30x points at /redirected). */
  connect?: (n: number) => 'sse' | number;
  claim?: (id: string) => number;
  /** Runs right after the snapshot on the n-th stream. */
  onOpen?: (n: number, board: FakeBoard) => void;
}

function startBoard(opts: FakeOptions = {}): Promise<FakeBoard> {
  const board: FakeBoard = {
    base: '',
    connections: [],
    claims: [],
    acks: [],
    redirected: [],
    send(event, data) {
      board.raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    raw(text) {
      board.connections[board.connections.length - 1]?.res.write(text);
    },
    end() {
      board.connections[board.connections.length - 1]?.res.end();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const json = { 'content-type': 'application/json' };
  const headersFor = (status: number): Record<string, string> =>
    status >= 300 && status < 400 ? { ...json, location: `${board.base}/redirected` } : json;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://board.test');
    const route = url.pathname.replace(/^\/w\/ags_test/, '');
    if (route === '/redirected') {
      board.redirected.push(`${req.method} ${req.url}`);
      res.writeHead(200, json);
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'GET' && route === '/events') {
      const n = board.connections.length;
      const mode = opts.connect?.(n) ?? 'sse';
      if (mode !== 'sse') {
        res.writeHead(mode, headersFor(mode));
        res.end('{"error":"nope"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const header = req.headers['x-webhook-secret'];
      board.connections.push({ at: Date.now(), query: url.searchParams, secret: Array.isArray(header) ? header[0] : header, res });
      res.write('event: snapshot\ndata: []\n\n');
      opts.onOpen?.(n, board);
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; });
    req.on('end', () => {
      const m = /^\/commands\/([^/]+)\/(claim|ack)$/.exec(route);
      if (req.method !== 'POST' || !m) {
        res.writeHead(404, json);
        res.end('{"error":"not_found"}');
        return;
      }
      const posted: Posted = { id: m[1], body: JSON.parse(raw) as Record<string, unknown> };
      if (m[2] === 'claim') {
        board.claims.push(posted);
        const status = opts.claim?.(m[1]) ?? 200;
        res.writeHead(status, headersFor(status));
        res.end(status === 200 ? '{"ok":true,"expires_in_ms":100000}' : '{"error":"already_claimed"}');
      } else {
        board.acks.push(posted);
        res.writeHead(200, json);
        res.end('{"ok":true}');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      board.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/w/ags_test`;
      resolve(board);
    });
  });
}

// ---- Fixtures -------------------------------------------------------------

interface Fixture {
  root: string;
  home: string;
  stateDir: string;
  stub: string;
  /** A unix socket this uid owns, standing in for agterm's. */
  sock: string;
  close(): Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-run-'));
  const home = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin, { recursive: true });
  // An executable file with no interpreter line: nothing could run it as a script even by accident.
  const stub = path.join(bin, 'agtermctl');
  fs.writeFileSync(stub, '');
  fs.chmodSync(stub, 0o755);
  writeMachine(stateDir, { machineId: MACHINE_ID, name: 'Test Mac', machineHost: os.hostname() });
  const sock = path.join(root, 'agterm.sock');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const close = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
  return { root, home, stateDir, stub, sock, close };
}

/** The hook's agterm record for the session, 0600 in a 0700 folder, with leak markers in every unused field. */
function writeRecord(fx: Fixture, session: string, over: Record<string, unknown> = {}): void {
  const folder = path.join(fx.stateDir, 'sessions', session);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const record = {
    v: 1,
    session_id: session,
    agent: 'claude',
    agent_pid: 7449,
    agent_comm: '/Users/demo/.local/bin/claude',
    entrypoint: 'cli',
    written_at: 1789286585,
    ended_at: null,
    tty: '/dev/ttys002',
    cwd: `/Users/demo/src/${NEVER}`,
    app: { bundle: AGTERM, path: '/Applications/agterm.app', pid: 662, via: 'ppid-walk' },
    env: { ...AGTERM_ENV, AGTERM_SOCKET: fx.sock, TERM_SESSION_ID: `w0t0p0:${NEVER}` },
    bins: { agtermctl: fx.stub },
    path: `/opt/${NEVER}:/usr/bin:/bin`,
    ...over,
  };
  const file = path.join(folder, `${record.agent_pid}.json`);
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function config(fx: Fixture, base: string): ListenerConfig {
  const key = machineKey(MACHINE_ID, base);
  return {
    url: base,
    base,
    stateDir: fx.stateDir,
    machineId: MACHINE_ID,
    machineKey: key,
    machinePublicId: publicId(key),
    name: 'Test Mac',
    bins: { agtermctl: fx.stub },
    logFile: path.join(fx.stateDir, 'listener.log'),
    lockFile: path.join(fx.stateDir, 'listener.lock'),
  };
}

const command = (over: Partial<{ id: string; type: string; session_id: string; machine_id: string }> = {}, cfg?: ListenerConfig) => ({
  id: commandId(),
  type: 'focus',
  session_id: SESSION,
  machine_id: cfg?.machinePublicId ?? 'ffffffffffffffffffffffffffffffff',
  expires_in_ms: 120_000,
  ...over,
});

interface Launch {
  file: string;
  args: string[];
  opts: ExecOptions;
}

/** Launch recorder: `ps -o comm=` answers with the record's agent, everything else succeeds silently. */
function recorder(psComm = '/Users/demo/.local/bin/claude'): { execFile: ExecFile; launches: Launch[] } {
  const launches: Launch[] = [];
  const execFile: ExecFile = async (file, args, opts) => {
    launches.push({ file, args, opts });
    if (file === '/bin/ps' && args[0] === '-o') return { code: 0, stdout: `${psComm}\n` };
    return { code: 0, stdout: '' };
  };
  return { execFile, launches };
}

/** Polls until `cond` holds; on timeout the listener log (when given) is part of the failure. */
async function until(cond: () => boolean, ms = 5000, detail?: () => string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met in time${detail ? `\n--- listener log ---\n${detail()}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Running {
  stop(): Promise<void>;
  log(): string;
}

function start(cfg: ListenerConfig, deps: Omit<ListenerDeps, 'signal'>): Running {
  const ctrl = new AbortController();
  const done = runListener(cfg, { ...deps, signal: ctrl.signal });
  return {
    stop: async () => {
      ctrl.abort();
      await done;
    },
    log: () => {
      try {
        return fs.readFileSync(cfg.logFile, 'utf8');
      } catch {
        return '';
      }
    },
  };
}

/** Log lines carry labels, enums and ids: nothing from the record's cwd, tty, env or path. */
function expectCleanLog(text: string): void {
  expect(text).not.toContain(NEVER);
  expect(text).not.toContain('/dev/ttys002');
  expect(text).not.toContain('.sock');
  expect(text).not.toContain(AGTERM_ENV.AGTERM_SESSION_ID);
  expect(text).not.toContain('AKIA');
}

// ---- Tests ----------------------------------------------------------------

describe('SseParser', () => {
  it('joins multi-line data, skips comments and dispatches on the blank line', () => {
    const frames: Array<[string, string]> = [];
    const parser = new SseParser((event, data) => frames.push([event, data]));
    parser.push(': keepalive\n\nevent: commands\ndata: [1,\ndata: 2]\n\n');
    parser.push('data: {"a":1}\r\n\r\nevent: partial\ndata: {"b":');
    expect(frames).toEqual([['commands', '[1,\n2]'], ['message', '{"a":1}']]);
    parser.push('2}\n\n');
    expect(frames[2]).toEqual(['partial', '{"b":2}']);
  });

  it('throws on a line or a frame past the cap, and starts clean after reset()', () => {
    const frames: Array<[string, string]> = [];
    const parser = new SseParser((event, data) => frames.push([event, data]));
    // One line that never ends: the cap is hit while it is still pending.
    expect(() => parser.push(`data: ${'x'.repeat(MAX_FRAME_BYTES + 1)}`)).toThrow(OversizedFrameError);
    parser.reset();
    // Many complete lines whose joined data would pass the cap.
    const chunk = `data: ${'y'.repeat(64 * 1024)}\n`;
    expect(() => {
      for (let i = 0; i < 17; i += 1) parser.push(chunk);
    }).toThrow(OversizedFrameError);
    parser.reset();
    // Below the cap, whatever came before the reset, a frame still arrives whole.
    parser.push('event: commands\ndata: [1]\n\n');
    expect(frames).toEqual([['commands', '[1]']]);
  });
});

describe('runListener', () => {
  let fx: Fixture;
  let board: FakeBoard;
  let running: Running | undefined;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    // Something that must never reach a launch: the listener's own environment.
    process.env.AWS_SECRET_ACCESS_KEY = `AKIA${NEVER}`;
    delete process.env.AGSTATUS_DEBUG;
    fx = await makeFixture();
    running = undefined;
  });

  afterEach(async () => {
    await running?.stop();
    await board?.close();
    await fx.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('subscribes with its id, key and name, claims, runs the plan with argv arrays and acks focused/pane', async () => {
    writeRecord(fx, SESSION);
    const cmd = command();
    board = await startBoard({ onOpen: (_n, b) => b.send('commands', [{ ...cmd, machine_id: cfg.machinePublicId }]) });
    const cfg = config(fx, board.base);
    const { execFile, launches } = recorder();
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 5000, running.log);

    const query = board.connections[0].query;
    expect(query.get('listener')).toBe(cfg.machinePublicId);
    expect(query.get('key')).toBe(cfg.machineKey);
    expect(query.get('name')).toBe('Test Mac');
    expect(board.connections[0].secret).toBeUndefined();

    expect(board.claims).toEqual([{ id: cmd.id, body: { machine_key: cfg.machineKey } }]);
    expect(board.acks).toEqual([{ id: cmd.id, body: { machine_key: cfg.machineKey, result: 'focused', reach: 'pane' } }]);

    expect(launches.map((l) => [l.file, ...l.args])).toEqual([
      ['/bin/ps', '-o', 'comm=', '-p', '7449'],
      ['/usr/bin/open', '-b', AGTERM],
      [fx.stub, '--socket', fx.sock, 'window', 'select', AGTERM_ENV.AGTERM_WINDOW_ID],
      [fx.stub, '--socket', fx.sock, 'session', 'select',
        '--target', AGTERM_ENV.AGTERM_SESSION_ID, '--window', AGTERM_ENV.AGTERM_WINDOW_ID],
    ]);
    for (const launch of launches) {
      expect(path.isAbsolute(launch.file)).toBe(true);
      expect(Array.isArray(launch.args)).toBe(true);
      expect(Object.keys(launch.opts).every((k) => ['env', 'cwd', 'timeout', 'maxBuffer'].includes(k))).toBe(true);
      expect(launch.opts.env?.PATH).toBe('/usr/bin:/bin');
      expect(launch.opts.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(JSON.stringify(launch)).not.toContain(NEVER);
      expect(launch.opts.timeout).toBeGreaterThan(0);
    }
    // The plan's steps see PATH alone; the liveness check sees no more.
    expect(launches[1].opts.env).toEqual({ PATH: '/usr/bin:/bin' });

    expectCleanLog(running.log());
    expect(running.log()).toContain('focused, reach pane');
  });

  it('sends the secret on the stream and the posts when configured', async () => {
    writeRecord(fx, SESSION);
    board = await startBoard({ onOpen: (_n, b) => b.send('command', { ...command(), machine_id: cfg.machinePublicId }) });
    const cfg: ListenerConfig = { ...config(fx, board.base), secret: 's3cret' };
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 5000, running.log);
    expect(board.connections[0].secret).toBe('s3cret');
    expect(board.acks[0].body).not.toHaveProperty('secret');
  });

  it('ignores a command for another machine and never claims it', async () => {
    writeRecord(fx, SESSION);
    const mine = command();
    const theirs = command({ machine_id: '0123456789abcdef0123456789abcdef' });
    board = await startBoard({
      onOpen: (_n, b) => b.send('commands', [theirs, { ...mine, machine_id: cfg.machinePublicId }]),
    });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 5000, running.log);
    expect(board.claims.map((c) => c.id)).toEqual([mine.id]);
    expect(board.acks.map((a) => a.id)).toEqual([mine.id]);
  });

  it('acks failed/no-record for a session without a record, without launching anything', async () => {
    const cmd = command({ session_id: OTHER_SESSION });
    board = await startBoard({ onOpen: (_n, b) => b.send('command', { ...cmd, machine_id: cfg.machinePublicId }) });
    const cfg = config(fx, board.base);
    const { execFile, launches } = recorder();
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 5000, running.log);
    expect(board.claims.map((c) => c.id)).toEqual([cmd.id]);
    expect(board.acks[0].body).toEqual({ machine_key: cfg.machineKey, result: 'failed', reason: 'no-record' });
    expect(launches).toEqual([]);
  });

  it('acks failed/unsupported-type for resume — v1 starts nothing', async () => {
    writeRecord(fx, SESSION);
    const cmd = command({ type: 'resume' });
    board = await startBoard({ onOpen: (_n, b) => b.send('command', { ...cmd, machine_id: cfg.machinePublicId }) });
    const cfg = config(fx, board.base);
    const { execFile, launches } = recorder();
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 5000, running.log);
    expect(board.acks[0].body).toEqual({ machine_key: cfg.machineKey, result: 'failed', reason: 'unsupported-type' });
    expect(launches.map((l) => l.file)).toEqual(['/bin/ps']);
  });

  it('acks failed/not-running when the pid is gone or belongs to something else', async () => {
    writeRecord(fx, SESSION);
    board = await startBoard({ onOpen: (_n, b) => b.send('command', { ...command(), machine_id: cfg.machinePublicId }) });
    const cfg = config(fx, board.base);
    const { execFile, launches } = recorder('/usr/bin/vim');
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 5000, running.log);
    expect(board.acks[0].body).toMatchObject({ result: 'failed', reason: 'not-running' });
    expect(launches.map((l) => l.file)).toEqual(['/bin/ps']);
  });

  it('runs nothing and acks nothing when the claim answers 409', async () => {
    writeRecord(fx, SESSION);
    const cmd = command();
    board = await startBoard({
      claim: () => 409,
      onOpen: (_n, b) => b.send('command', { ...cmd, machine_id: cfg.machinePublicId }),
    });
    const cfg = config(fx, board.base);
    const { execFile, launches } = recorder();
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => running!.log().includes('claim HTTP 409'));
    expect(board.claims.map((c) => c.id)).toEqual([cmd.id]);
    expect(board.acks).toEqual([]);
    expect(launches).toEqual([]);
  });

  it('degrades to selected when the app never comes to the front', async () => {
    writeRecord(fx, SESSION);
    board = await startBoard({ onOpen: (_n, b) => b.send('command', { ...command(), machine_id: cfg.machinePublicId }) });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => 'com.apple.Terminal' });
    await until(() => board.acks.length === 1, 5000, running.log);
    expect(board.acks[0].body).toEqual({ machine_key: cfg.machineKey, result: 'selected', reach: 'pane' });
    expectCleanLog(running.log());
  });

  it('never points a tool at a socket path that is not a live socket of ours', async () => {
    // The hook recorded a path that is now a plain file (or the app restarted elsewhere): the
    // value is dropped like any odd env value and the plan degrades to app activation.
    writeRecord(fx, SESSION, { env: { ...AGTERM_ENV, AGTERM_SOCKET: fx.stub } });
    board = await startBoard({ onOpen: (_n, b) => b.send('command', { ...command(), machine_id: cfg.machinePublicId }) });
    const cfg = config(fx, board.base);
    const { execFile, launches } = recorder();
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 5000, running.log);
    expect(board.acks[0].body).toEqual({ machine_key: cfg.machineKey, result: 'activated', reach: 'app' });
    expect(launches.map((l) => [l.file, ...l.args])).toEqual([
      ['/bin/ps', '-o', 'comm=', '-p', '7449'],
      ['/usr/bin/open', '-b', AGTERM],
    ]);
    expect(running.log()).toContain('dropped AGTERM_SOCKET');
    expect(running.log()).not.toContain(fx.stub);
  });

  it('acks failed/bad-record when acting throws after the claim', async () => {
    writeRecord(fx, SESSION);
    board = await startBoard({ onOpen: (_n, b) => b.send('command', { ...command(), machine_id: cfg.machinePublicId }) });
    const cfg = config(fx, board.base);
    const execFile: ExecFile = async () => {
      throw new Error(`boom ${NEVER}`);
    };
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 5000, running.log);
    expect(board.acks[0].body).toEqual({ machine_key: cfg.machineKey, result: 'failed', reason: 'bad-record' });
    expectCleanLog(running.log());
  });

  it('claims one command per session within the 2 s cooldown, and others still', async () => {
    writeRecord(fx, SESSION);
    writeRecord(fx, OTHER_SESSION);
    const first = command();
    const repeat = command();
    const other = command({ session_id: OTHER_SESSION });
    board = await startBoard({
      onOpen: (_n, b) => b.send('commands', [first, repeat, other].map((c) => ({ ...c, machine_id: cfg.machinePublicId }))),
    });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM });
    await until(() => board.acks.length === 2, 5000, running.log);
    expect(board.claims.map((c) => c.id)).toEqual([first.id, other.id]);
    expect(board.acks.map((a) => a.id)).toEqual([first.id, other.id]);
    expect(running.log()).toContain('cooldown');
  });

  it('trips the breaker after 20 commands in a minute', async () => {
    writeRecord(fx, SESSION);
    let clock = 1_000_000;
    const now = (): number => (clock += 3000); // every command lands past the previous one's cooldown
    const flood = Array.from({ length: 22 }, () => command());
    board = await startBoard({
      onOpen: (_n, b) => b.send('commands', flood.map((c) => ({ ...c, machine_id: cfg.machinePublicId }))),
    });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM, now });
    await until(() => running!.log().includes('breaker'));
    await pause(100);
    expect(board.claims.length).toBe(19);
    expect(board.acks.length).toBe(19);
  });

  it('reconnects after the board closes the stream, with at least a second of backoff', async () => {
    writeRecord(fx, SESSION);
    const cmd = command();
    board = await startBoard({
      onOpen: (n, b) => {
        if (n === 0) b.end();
        else b.send('command', { ...cmd, machine_id: cfg.machinePublicId });
      },
    });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM });
    await until(() => board.acks.length === 1, 8000, running.log);
    expect(board.connections.length).toBeGreaterThanOrEqual(2);
    expect(board.connections[1].at - board.connections[0].at).toBeGreaterThanOrEqual(1000);
    expect(running.log()).toMatch(/sse: closed after .* — reconnecting in 1(\.\d+)?s/);
  });

  it('reconnects when the stream goes idle', async () => {
    board = await startBoard();
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM, timing: { idleMs: 200, backoffMinMs: 20, backoffMaxMs: 40 } });
    await until(() => board.connections.length >= 2, 3000, running.log);
    expect(running.log()).toContain('sse: idle after');
  });

  it('waits the penalty after a 429 instead of backing off', async () => {
    board = await startBoard({ connect: () => 429 });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM, timing: { backoffMinMs: 20, backoffMaxMs: 40 } });
    await until(() => running!.log().includes('HTTP 429'));
    await pause(1500);
    expect(running.log().match(/HTTP 429/g)?.length).toBe(1);
    expect(running.log()).toContain('waiting 60s');
  });

  it('logs an auth failure once and keeps a slow retry', async () => {
    board = await startBoard({ connect: () => 403 });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM, timing: { penaltyMs: 100 } });
    await until(() => running!.log().includes('HTTP 403'));
    await pause(500);
    expect(running.log().match(/HTTP 403/g)?.length).toBe(1);
    expect(running.log()).not.toContain(cfg.machineKey);
  });

  it('treats a redirect as an error and never carries the key or the machine key to its Location', async () => {
    writeRecord(fx, SESSION);
    const cmd = command();
    let attempts = 0; // `connect` is told the stream count, and a refused connect is not a stream
    board = await startBoard({
      connect: () => (attempts++ === 0 ? 302 : 'sse'),
      claim: () => 307,
      onOpen: (_n, b) => b.send('command', { ...cmd, machine_id: cfg.machinePublicId }),
    });
    const cfg = config(fx, board.base);
    const { execFile, launches } = recorder();
    running = start(cfg, { execFile, frontmost: async () => AGTERM, timing: { backoffMinMs: 20, backoffMaxMs: 40 } });
    await until(() => running!.log().includes('claim unreachable'), 5000, running.log);
    expect(board.redirected).toEqual([]);
    expect(running.log()).toMatch(/sse: error after/);
    expect(board.claims.map((c) => c.id)).toEqual([cmd.id]);
    expect(board.acks).toEqual([]);
    expect(launches).toEqual([]);
  });

  it('drops a stream that sends an oversized frame and reconnects with backoff', async () => {
    board = await startBoard({
      onOpen: (n, b) => {
        if (n === 0) b.raw(`data: ${'x'.repeat(MAX_FRAME_BYTES + 1)}`);
      },
    });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM, timing: { backoffMinMs: 20, backoffMaxMs: 40 } });
    await until(() => board.connections.length >= 2, 5000, running.log);
    expect(running.log()).toMatch(/sse: oversized frame after .* — reconnecting in/);
    expect(board.claims).toEqual([]);
  });

  it('never echoes a server-chosen event name into the log', async () => {
    board = await startBoard({
      onOpen: (_n, b) => b.raw('event: \u001b[2Jinjected\rforged line\ndata: not json\n\n'),
    });
    const cfg = config(fx, board.base);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM });
    await until(() => running!.log().includes('frame with non-JSON data ignored'), 5000, running.log);
    expect(running.log()).toContain('sse: other frame with non-JSON data ignored');
    expect(running.log()).not.toContain('\u001b');
    expect(running.log()).not.toContain('injected');
    expect(running.log()).not.toContain('forged');
  });

  it('refuses to start while another live listener holds the lock, and cleans its own lock up', async () => {
    board = await startBoard();
    const cfg = config(fx, board.base);
    // Our parent is alive and ours; `ps` is told it is a listener.
    fs.writeFileSync(cfg.lockFile, `${process.ppid}\n`);
    const psArgs: string[][] = [];
    const listenerPs: ExecFile = async (file, args) => {
      psArgs.push([file, ...args]);
      return { code: 0, stdout: '/usr/local/bin/node /opt/agstatus/dist/cli.js listener run --name Studio\n' };
    };
    await expect(runListener(cfg, { fetchImpl: fetch, execFile: listenerPs })).rejects.toThrow(/already holds/);
    expect(psArgs).toEqual([['/bin/ps', '-o', 'args=', '-p', String(process.ppid)]]);
    expect(fs.readFileSync(cfg.lockFile, 'utf8').trim()).toBe(String(process.ppid));
    fs.unlinkSync(cfg.lockFile);
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM });
    await until(() => board.connections.length === 1, 5000, running.log);
    expect(fs.readFileSync(cfg.lockFile, 'utf8').trim()).toBe(String(process.pid));
    await running.stop();
    running = undefined;
    expect(fs.existsSync(cfg.lockFile)).toBe(false);
  });

  it('takes over a lock whose pid a reboot handed to someone else, or to a program that is not a listener', async () => {
    board = await startBoard();
    const cfg = config(fx, board.base);
    // pid 1 is launchd/init: alive, but not a process this user may signal (or, as root, not a listener).
    fs.writeFileSync(cfg.lockFile, '1\n');
    running = start(cfg, { ...recorder(), frontmost: async () => AGTERM });
    await until(() => board.connections.length === 1, 5000, running.log);
    expect(fs.readFileSync(cfg.lockFile, 'utf8').trim()).toBe(String(process.pid));
    await running.stop();
    running = undefined;

    // Our parent is alive and ours, but `ps` says it is running something else.
    fs.writeFileSync(cfg.lockFile, `${process.ppid}\n`);
    const { execFile, launches } = recorder('/usr/local/bin/node /opt/vitest/vitest.mjs run');
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => board.connections.length === 2, 5000, running.log);
    expect(launches.map((l) => [l.file, ...l.args])).toEqual([['/bin/ps', '-o', 'args=', '-p', String(process.ppid)]]);
    expect(fs.readFileSync(cfg.lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('takes over a lock whose content is not a pid without asking ps, and leaves no temp file behind', async () => {
    board = await startBoard();
    const cfg = config(fx, board.base);
    fs.writeFileSync(cfg.lockFile, 'not a pid\n');
    const { execFile, launches } = recorder();
    running = start(cfg, { execFile, frontmost: async () => AGTERM });
    await until(() => board.connections.length === 1, 5000, running.log);
    expect(launches).toEqual([]);
    expect(fs.readFileSync(cfg.lockFile, 'utf8')).toBe(`${process.pid}\n`);
    expect(fs.statSync(cfg.lockFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(fx.stateDir).filter((f) => f.includes('.lock.'))).toEqual([]);
  });
});

describe('resolveFacts', () => {
  let fx: Fixture;
  const UID = process.getuid?.() ?? 0;
  const OTHER = UID + 1;
  const record = (mux: LocalRecord['mux']): LocalRecord => ({
    v: 1, session_id: SESSION, agent: 'claude', agent_pid: 7449, agent_comm: 'claude', entrypoint: 'cli',
    written_at: 1789286585, ended_at: null, env: {}, bins: {}, mux,
  });
  const HERDR = record({ kind: 'herdr', target: 'w1:p3', socket: '/tmp/herdr.sock' });
  const TMUX = record({ kind: 'tmux', target: 'main:@3.%7', socket: '/tmp/tmux-501/default' });

  /** Canned process tables, keyed by the exact `ps` format the runtime asks for. */
  interface Tables {
    herdr?: string;
    tty?: Record<string, string>;
    walk?: string;
    tmux?: string;
  }
  function ps(tables: Tables): { execFile: ExecFile; calls: string[][] } {
    const calls: string[][] = [];
    const execFile: ExecFile = async (file, args) => {
      calls.push([file, ...args]);
      const fmt = args[args.length - 1];
      if (file === '/bin/ps' && args[0] === '-axo' && fmt === 'pid=,uid=,tty=,args=') return { code: 0, stdout: tables.herdr ?? '' };
      if (file === '/bin/ps' && args[0] === '-t' && fmt === 'pid=,ppid=,uid=,comm=') return { code: 0, stdout: tables.tty?.[args[1]] ?? '' };
      if (file === '/bin/ps' && args[0] === '-axo' && fmt === 'pid=,ppid=,uid=,comm=') return { code: 0, stdout: tables.walk ?? '' };
      if (args[2] === 'list-clients') return { code: 0, stdout: tables.tmux ?? '' };
      return { code: 1, stdout: '' };
    };
    return { execFile, calls };
  }

  /** A bundle at <root>/<name>.app with an XML Info.plist naming `id`; returns its executable's path. */
  function makeApp(name: string, id: string): string {
    const app = path.join(fx.root, `${name}.app`);
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(
      path.join(app, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n  <key>CFBundleIdentifier</key>\n  <string>${id}</string>\n</dict></plist>\n`
    );
    return path.join(app, 'Contents', 'MacOS', name);
  }
  const plistOf = (exe: string): string => path.join(exe, '..', '..', 'Info.plist');

  /** The tty's rows and the full table for: client → zsh → (root) login → the app → launchd. */
  function tree(client: string, app: string, shellUid = UID): { tty: Record<string, string>; walk: string } {
    const rows = [
      `  500  400  ${UID} ${client}`,
      `  400  300  ${shellUid} /bin/zsh`,
      '  300  200  0 /usr/bin/login',
      `  200    1  ${UID} ${app}`,
      '    1    0  0 /sbin/launchd',
    ];
    return { tty: { ttys004: `${rows[0]}\n${rows[1]}\n` }, walk: `${rows.join('\n')}\n` };
  }

  beforeEach(async () => {
    fx = await makeFixture();
  });
  afterEach(async () => {
    await fx.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('herdr: follows only our own client named by the configured path, then reads the bundle off our own ancestors', async () => {
    const herdr = path.join(fx.root, 'bin', 'herdr');
    fs.writeFileSync(herdr, '');
    const link = path.join(fx.root, 'bin', 'herdr-link');
    fs.symlinkSync(herdr, link);
    const real = fs.realpathSync(link);
    const term = makeApp('Fake', 'com.example.fake');
    const poisoned = [
      `  900  ${OTHER} ttys009 ${link} attach`, // another user's, and the newest: never followed
      `  800  ${UID} ttys008 /tmp/herdr attach`, // a basename match: never followed
      `  700  ${UID} ttys007 ${link} server`, // the server
      `  600  ${UID} ??      ${link} attach`, // no tty
      `  500  ${UID} ttys004 ${real} attach`, // ours, by the configured path resolved
      '',
    ].join('\n');
    const { execFile, calls } = ps({ herdr: poisoned, ...tree(real, term) });
    const facts = await resolveFacts(HERDR, { herdr: link }, execFile, true, 'darwin', UID);
    expect(facts.outer).toEqual({ bundle: 'com.example.fake', tty: '/dev/ttys004' });
    expect(calls).toEqual([
      ['/bin/ps', '-axo', 'pid=,uid=,tty=,args='],
      ['/bin/ps', '-t', 'ttys004', '-o', 'pid=,ppid=,uid=,comm='],
      ['/bin/ps', '-axo', 'pid=,ppid=,uid=,comm='],
    ]);

    // The configured path itself, unresolved, counts too; a bare `herdr` (how a shell sets argv[0]) does not.
    const byLink = ps({ herdr: `  500  ${UID} ttys004 ${link} attach\n`, ...tree(link, term) });
    expect((await resolveFacts(HERDR, { herdr: link }, byLink.execFile, true, 'darwin', UID)).outer?.tty).toBe('/dev/ttys004');
    const bare = ps({ herdr: `  500  ${UID} ttys004 herdr attach\n`, ...tree(link, term) });
    expect((await resolveFacts(HERDR, { herdr: link }, bare.execFile, true, 'darwin', UID)).outer).toBeUndefined();
    expect(bare.calls).toHaveLength(1);
  });

  it('stops the walk at another user\'s ancestor, and sees nothing on a tty without our processes', async () => {
    const link = path.join(fx.root, 'bin', 'herdr');
    fs.writeFileSync(link, '');
    const term = makeApp('Fake', 'com.example.fake');
    const row = `  500  ${UID} ttys004 ${link} attach\n`;
    const foreignShell = ps({ herdr: row, ...tree(link, term, OTHER) });
    expect((await resolveFacts(HERDR, { herdr: link }, foreignShell.execFile, true, 'darwin', UID)).outer).toEqual({ tty: '/dev/ttys004' });

    const foreignTty = ps({ herdr: row, tty: { ttys004: `  500  400  ${OTHER} ${link}\n  400  300  ${OTHER} /bin/zsh\n` } });
    expect((await resolveFacts(HERDR, { herdr: link }, foreignTty.execFile, true, 'darwin', UID)).outer).toBeUndefined();
    expect(foreignTty.calls).toHaveLength(2);
  });

  it('reads a bundle id only from a regular Info.plist of a sane size — never through a FIFO or a huge file', async () => {
    const link = path.join(fx.root, 'bin', 'herdr');
    fs.writeFileSync(link, '');
    const term = makeApp('Fake', 'com.example.fake');
    const tables = { herdr: `  500  ${UID} ttys004 ${link} attach\n`, ...tree(link, term) };
    const outer = async (): Promise<unknown> =>
      (await resolveFacts(HERDR, { herdr: link }, ps(tables).execFile, true, 'darwin', UID)).outer;
    expect(await outer()).toEqual({ bundle: 'com.example.fake', tty: '/dev/ttys004' });

    // Past the size cap, whatever it says.
    fs.writeFileSync(plistOf(term), `${'<!-- -->'.repeat(140_000)}<key>CFBundleIdentifier</key><string>com.example.fake</string>`);
    expect(fs.statSync(plistOf(term)).size).toBeGreaterThan(1 << 20);
    expect(await outer()).toEqual({ tty: '/dev/ttys004' });

    // A pipe in its place must neither block the loop nor yield anything.
    if (process.platform !== 'win32') {
      fs.rmSync(plistOf(term));
      execFileSync('/usr/bin/mkfifo', [plistOf(term)]);
      const started = Date.now();
      expect(await outer()).toEqual({ tty: '/dev/ttys004' });
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it('tmux: asks the multiplexer for its newest client, then resolves that tty the same way', async () => {
    const term = makeApp('Fake', 'com.example.fake');
    const tmux = path.join(fx.root, 'bin', 'tmux');
    const { execFile, calls } = ps({
      tmux: '450 /dev/ttys003 1600000000\n500 /dev/ttys004 1700000000\n',
      ...tree(tmux, term),
    });
    const facts = await resolveFacts(TMUX, { tmux }, execFile, true, 'darwin', UID);
    expect(facts.outer).toEqual({ bundle: 'com.example.fake', tty: '/dev/ttys004' });
    expect(calls[0]).toEqual([tmux, '-S', '/tmp/tmux-501/default', 'list-clients', '-F', '#{client_pid} #{client_tty} #{client_activity}']);
    expect(calls[1]).toEqual(['/bin/ps', '-t', 'ttys004', '-o', 'pid=,ppid=,uid=,comm=']);
    // Without a uid to filter by (a platform with no getuid), the process table is not consulted at all.
    const none = ps({ tmux: '500 /dev/ttys004 1700000000\n', ...tree(tmux, term) });
    const getuid = process.getuid;
    (process as { getuid?: () => number }).getuid = undefined;
    try {
      expect((await resolveFacts(TMUX, { tmux }, none.execFile, true, 'darwin')).outer).toBeUndefined();
    } finally {
      process.getuid = getuid;
    }
    expect(none.calls).toEqual([]);
  });
});

describe('isAgentAlive', () => {
  const base: LocalRecord = {
    v: 1, session_id: SESSION, agent: 'claude', agent_pid: 7449, agent_comm: '', entrypoint: 'cli',
    written_at: 1789286585, ended_at: null, env: {}, bins: {},
  };
  const ps = (comm: string): ExecFile => async () => ({ code: 0, stdout: `${comm}\n` });

  it('compares basenames against the recorded comm', async () => {
    const record = { ...base, agent_comm: '/Users/demo/.local/bin/claude' };
    expect(await isAgentAlive(record, ps('/opt/homebrew/bin/claude'), 'darwin')).toBe(true);
    expect(await isAgentAlive(record, ps('/usr/bin/vim'), 'darwin')).toBe(false);
    expect(await isAgentAlive(record, async () => ({ code: 1, stdout: '' }), 'darwin')).toBe(false);
  });

  it('without a recorded comm accepts only the agent name or node — never the pid alone', async () => {
    expect(await isAgentAlive(base, ps('claude'), 'darwin')).toBe(true);
    expect(await isAgentAlive(base, ps('/usr/local/bin/node'), 'darwin')).toBe(true);
    expect(await isAgentAlive({ ...base, agent: 'codex' }, ps('/Applications/ChatGPT.app/Contents/Resources/codex'), 'darwin')).toBe(true);
    expect(await isAgentAlive(base, ps('/usr/bin/vim'), 'darwin')).toBe(false);
    expect(await isAgentAlive(base, ps('codex'), 'darwin')).toBe(false);
  });
});

describe('verifyOnDisk', () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await makeFixture();
  });
  afterEach(async () => {
    await fx.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  const record = (over: Partial<LocalRecord>): LocalRecord => ({
    v: 1, session_id: SESSION, agent: 'claude', agent_pid: 7449, agent_comm: 'claude', entrypoint: 'cli',
    written_at: 1789286585, ended_at: null, env: {}, bins: {}, ...over,
  });

  it('keeps a project root that is a directory of ours and drops anything else', () => {
    expect(verifyOnDisk(record({ project_root: fx.root }))).toMatchObject({ dropped: [], record: { project_root: fx.root } });
    for (const root of [fx.stub, path.join(fx.root, 'missing')]) {
      const out = verifyOnDisk(record({ project_root: root }));
      expect(out.dropped).toEqual(['project_root']);
      expect(out.record).not.toHaveProperty('project_root');
    }
    const foreign = verifyOnDisk(record({ project_root: fx.root }), (process.getuid?.() ?? 0) + 1);
    expect(foreign.dropped).toEqual(['project_root']);
  });

  it('keeps sockets that are sockets of ours, drops a multiplexer socket that is not, and leaves the input alone', () => {
    const input = record({
      mux: { kind: 'tmux', target: 'main:@3.%7', socket: fx.sock },
      env: { AGTERM_SOCKET: fx.sock, KITTY_LISTEN_ON: `unix:${fx.sock}`, WEZTERM_UNIX_SOCKET: fx.stub, KITTY_WINDOW_ID: '2' },
    });
    const snapshot = JSON.stringify(input);
    const out = verifyOnDisk(input);
    expect(out.dropped).toEqual(['WEZTERM_UNIX_SOCKET']);
    expect(out.record.mux).toEqual(input.mux);
    expect(out.record.env).toEqual({ AGTERM_SOCKET: fx.sock, KITTY_LISTEN_ON: `unix:${fx.sock}`, KITTY_WINDOW_ID: '2' });
    expect(JSON.stringify(input)).toBe(snapshot);

    const gone = verifyOnDisk(record({
      mux: { kind: 'tmux', target: 'main:@3.%7', socket: path.join(fx.root, 'no.sock') },
      env: { KITTY_LISTEN_ON: 'unix:/nonexistent/kitty.sock', HERDR_SOCKET_PATH: fx.stub },
    }));
    expect(gone.dropped).toEqual(['mux.socket', 'HERDR_SOCKET_PATH', 'KITTY_LISTEN_ON']);
    expect(gone.record.mux).toEqual({ kind: 'tmux', target: 'main:@3.%7' });
    expect(gone.record.env).toEqual({});
  });
});

describe('runPlan', () => {
  /** The tool table as run.ts builds it: the config's bins plus the fixed system binaries. */
  const ALLOWED: ReadonlySet<string> = new Set(['/opt/x/agtermctl', '/opt/x/tmux', ...Object.values(SYSTEM_BINS)]);
  const plan = (over: Partial<Plan> = {}): Plan => ({
    steps: [
      { argv: ['/usr/bin/open', '-b', AGTERM], label: 'open: activate app' },
      { argv: ['/opt/x/agtermctl', '--socket', '/tmp/s', 'window', 'select', 'w'], env: { HERDR_SOCKET_PATH: '/tmp/h' }, label: 'agtermctl: select window', expectFrontmost: AGTERM },
    ],
    reach: 'pane',
    result: 'focused',
    experimental: false,
    description: 'agterm session',
    ...over,
  });

  it('gives each step PATH plus its own env, and the plan its result and reach', async () => {
    const launches: Launch[] = [];
    const lines: string[] = [];
    const outcome = await runPlan(plan(), {
      execFile: async (file, args, opts) => {
        launches.push({ file, args, opts });
        return { code: 0 };
      },
      frontmost: async () => AGTERM,
      log: (l) => lines.push(l),
      allowed: ALLOWED,
    });
    expect(outcome).toEqual({ result: 'focused', reach: 'pane' });
    expect(launches[0].opts.env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(launches[1].opts.env).toEqual({ PATH: '/usr/bin:/bin', HERDR_SOCKET_PATH: '/tmp/h' });
    expect(launches.map((l) => l.opts.timeout)).toEqual([5000, 5000]);
    expect(lines.join('\n')).not.toContain('/tmp/s');
    expect(lines.join('\n')).toMatch(/step 1\/2 open: activate app: exit 0/);
  });

  it('fails as app-not-running when open -b fails, unsupported-host for any other step', async () => {
    const failAt = (index: number) => async (file: string) =>
      ({ code: file === '/usr/bin/open' ? (index === 0 ? 1 : 0) : index === 1 ? 2 : 0 });
    const deps = { frontmost: async () => AGTERM, log: () => {}, allowed: ALLOWED };
    expect(await runPlan(plan(), { ...deps, execFile: failAt(0) })).toEqual({ result: 'failed', reason: 'app-not-running' });
    expect(await runPlan(plan(), { ...deps, execFile: failAt(1) })).toEqual({ result: 'failed', reason: 'unsupported-host' });
  });

  it('skips a failing optional step and refuses a relative argv[0]', async () => {
    const deps = { frontmost: async () => AGTERM, log: () => {}, allowed: ALLOWED };
    const optional = plan({ steps: [{ argv: ['/opt/x/tmux', 'switch-client'], optional: true, label: 'tmux: switch client' }], result: 'selected' });
    expect(await runPlan(optional, { ...deps, execFile: async () => ({ code: 1 }) })).toEqual({ result: 'selected', reach: 'pane' });
    const relative = plan({ steps: [{ argv: ['agtermctl', 'window', 'select'], label: 'x' }] });
    let launched = false;
    expect(await runPlan(relative, { ...deps, execFile: async () => { launched = true; return { code: 0 }; } }))
      .toEqual({ result: 'failed', reason: 'bad-record' });
    expect(launched).toBe(false);
  });

  it('refuses an absolute argv[0] outside the tool table before launching anything, even after good steps', async () => {
    const lines: string[] = [];
    const launched: string[] = [];
    const deps = {
      execFile: async (file: string) => {
        launched.push(file);
        return { code: 0 };
      },
      frontmost: async () => AGTERM,
      log: (l: string) => lines.push(l),
      allowed: ALLOWED,
    };
    const stray = plan({
      steps: [
        { argv: ['/usr/bin/open', '-b', AGTERM], label: 'open: activate app' },
        { argv: ['/opt/elsewhere/agtermctl', 'window', 'select', 'w'], label: 'agtermctl: select window' },
      ],
    });
    expect(await runPlan(stray, deps)).toEqual({ result: 'failed', reason: 'bad-record' });
    expect(launched).toEqual(['/usr/bin/open']);
    expect(lines.join('\n')).toContain('step 2/2 agtermctl: select window: refused — argv[0] is not in the tool table');
    // A bare system name resolves to its fixed path, which is in the table by construction.
    const bare = plan({ steps: [{ argv: ['open', '-b', AGTERM], label: 'open' }], result: 'activated', reach: 'app' });
    expect(await runPlan(bare, deps)).toEqual({ result: 'activated', reach: 'app' });
  });

  it('allowedArgv0 is the config\'s tools plus the fixed system table', () => {
    const cfg = { bins: { tmux: '/opt/homebrew/bin/tmux', herdr: '/opt/homebrew/bin/herdr' } } as unknown as ListenerConfig;
    expect([...allowedArgv0(cfg)].sort()).toEqual(
      ['/opt/homebrew/bin/herdr', '/opt/homebrew/bin/tmux', ...Object.values(SYSTEM_BINS)].sort()
    );
  });
});

describe('runPlanCommand', () => {
  let fx: Fixture;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    fx = await makeFixture();
    process.env.HOME = fx.home;
    process.env.CLAUDE_CONFIG_DIR = path.join(fx.home, '.claude');
    process.env.CODEX_HOME = path.join(fx.home, '.codex');
    process.env.AGSTATUS_STATE_DIR = fx.stateDir;
    process.env.CLAUDE_STATUS_URL = 'https://s.example/w/ags_plan';
    process.env.PATH = path.dirname(fx.stub);
    delete process.env.CLAUDE_STATUS_SECRET;
  });

  afterEach(async () => {
    await fx.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('prints the agterm plan without a path from the record', async () => {
    writeRecord(fx, SESSION);
    const lines: string[] = [];
    const { execFile } = recorder();
    const code = await runPlanCommand(SESSION, (l) => lines.push(l), { execFile, platform: 'darwin' });
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('agterm');
    expect(text).toContain('agtermctl: select session');
    expect(text).toContain('reach pane, result focused');
    expect(text).not.toContain('/Users');
    expect(text).not.toContain(NEVER);
  });

  it('explains a missing record and a dead agent', async () => {
    const lines: string[] = [];
    expect(await runPlanCommand(OTHER_SESSION, (l) => lines.push(l), { execFile: recorder().execFile })).toBe(1);
    expect(lines.join('\n')).toContain('No local record');

    writeRecord(fx, SESSION);
    lines.length = 0;
    const dead: ExecFile = async () => ({ code: 1, stdout: '' });
    expect(await runPlanCommand(SESSION, (l) => lines.push(l), { execFile: dead, platform: 'darwin' })).toBe(1);
    expect(lines.join('\n')).toContain('No plan: not-running');
  });

  it('refuses a session id unfit for a path', async () => {
    const lines: string[] = [];
    expect(await runPlanCommand('../etc', (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toContain('session id');
  });
});
