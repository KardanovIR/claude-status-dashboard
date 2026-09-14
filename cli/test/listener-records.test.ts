import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadRecords, pickRecord, stateDir, validateRecord } from '../src/listener/records';
import type { LocalRecord } from '../src/listener/types';

const SESSION = '5a1d2f6e-9b3c-4d7e-8f01-23456789abcd';

/** A record as the hook writes it for Claude Code inside agterm — the shape host.test.ts asserts on. */
const AGTERM_RECORD = {
  v: 1,
  session_id: SESSION,
  agent: 'claude',
  agent_pid: 7449,
  agent_comm: '/Users/demo/.local/bin/claude',
  entrypoint: 'cli',
  written_at: 1789286585,
  ended_at: null,
  tty: '/dev/ttys002',
  cwd: '/Users/demo/src/board',
  transcript_path: `/Users/demo/.claude/projects/-Users-demo-src-board/${SESSION}.jsonl`,
  app: { bundle: 'com.umputun.agterm', path: '/Applications/agterm.app', pid: 662, via: 'ppid-walk' },
  env: {
    TERM_PROGRAM: 'agterm',
    TERM: 'xterm-256color',
    AGTERM_SESSION_ID: '0d8f5c1e-2b7a-4c3d-9e1f-6a5b4c3d2e1f',
    AGTERM_WINDOW_ID: '7c1b9e4a-3f2d-4e5b-8a6c-1d2e3f4a5b6c',
    AGTERM_WORKSPACE_ID: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    AGTERM_SOCKET: '/private/tmp/agterm-501/agterm.sock',
  },
  bins: { agtermctl: '/opt/homebrew/bin/agtermctl', claude: '/Users/demo/.local/bin/claude' },
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  summary: {
    machine: { id: '0123456789abcdef0123456789abcdef', name: 'Studio' },
    app: { slug: 'agterm', name: 'agterm', kind: 'terminal' },
  },
};

type Raw = Record<string, unknown>;

/** A deep copy of the fixture with top-level overrides. */
const clone = (over: Raw = {}): Raw => ({ ...(JSON.parse(JSON.stringify(AGTERM_RECORD)) as Raw), ...over });

const valid = (raw: Raw): LocalRecord => {
  const record = validateRecord(raw, 'darwin');
  expect(record).not.toBeNull();
  return record as LocalRecord;
};

describe('stateDir', () => {
  it('honours AGSTATUS_STATE_DIR on every platform, trimmed', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(stateDir({ AGSTATUS_STATE_DIR: ' /tmp/agstatus-state ' }, platform, '/home/x')).toBe('/tmp/agstatus-state');
    }
  });

  it('falls through a blank override', () => {
    expect(stateDir({ AGSTATUS_STATE_DIR: '   ' }, 'darwin', '/Users/demo'))
      .toBe(path.join('/Users/demo', 'Library', 'Application Support', 'AgStatus'));
  });

  it('uses Application Support on macOS', () => {
    expect(stateDir({}, 'darwin', '/Users/demo'))
      .toBe(path.join('/Users/demo', 'Library', 'Application Support', 'AgStatus'));
  });

  it('uses LOCALAPPDATA on Windows, with the AppData\\Local default', () => {
    expect(stateDir({ LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' }, 'win32', 'C:\\Users\\demo'))
      .toBe(path.join('C:\\Users\\demo\\AppData\\Local', 'AgStatus'));
    expect(stateDir({}, 'win32', 'C:\\Users\\demo'))
      .toBe(path.join('C:\\Users\\demo', 'AppData', 'Local', 'AgStatus'));
  });

  it('uses XDG_STATE_HOME elsewhere, with the ~/.local/state default', () => {
    expect(stateDir({ XDG_STATE_HOME: '/var/state' }, 'linux', '/home/demo')).toBe(path.join('/var/state', 'agstatus'));
    expect(stateDir({}, 'linux', '/home/demo')).toBe(path.join('/home/demo', '.local', 'state', 'agstatus'));
    expect(stateDir({}, 'freebsd', '/home/demo')).toBe(path.join('/home/demo', '.local', 'state', 'agstatus'));
  });

  it('defaults to the process env, platform and home', () => {
    expect(stateDir()).toBe(stateDir(process.env, process.platform, os.homedir()));
  });
});

describe('validateRecord', () => {
  it('accepts a realistic agterm record unchanged, as a fresh object', () => {
    const input = clone();
    const record = valid(input);
    expect(record).toEqual(AGTERM_RECORD);
    expect(record).not.toBe(input);
    expect(record.env).not.toBe(input.env);
  });

  it('rejects anything that is not a plain object', () => {
    for (const raw of [null, undefined, 'record', 42, true, [], [AGTERM_RECORD]]) {
      expect(validateRecord(raw)).toBeNull();
    }
  });

  it('rejects a wrong or missing version', () => {
    expect(validateRecord(clone({ v: 2 }))).toBeNull();
    expect(validateRecord(clone({ v: '1' }))).toBeNull();
    const noVersion = clone();
    delete noVersion.v;
    expect(validateRecord(noVersion)).toBeNull();
  });

  it('rejects session ids unfit for a path', () => {
    for (const session_id of ['../x', '.', '..', 'a/b', 'a b', '', 'x'.repeat(129), 42]) {
      expect(validateRecord(clone({ session_id }))).toBeNull();
    }
    expect(valid(clone({ session_id: 'msg-test' })).session_id).toBe('msg-test');
  });

  it('rejects an unknown agent', () => {
    expect(validateRecord(clone({ agent: 'gpt' }))).toBeNull();
    expect(validateRecord(clone({ agent: 1 }))).toBeNull();
  });

  it('rejects pids outside 1..4194304 or not integers', () => {
    for (const agent_pid of [0, -1, 1.5, '7449', 4194305, null]) {
      expect(validateRecord(clone({ agent_pid }))).toBeNull();
    }
    expect(valid(clone({ agent_pid: 1 })).agent_pid).toBe(1);
    expect(valid(clone({ agent_pid: 4194304 })).agent_pid).toBe(4194304);
  });

  it('rejects bad timestamps, and reads a missing ended_at as null', () => {
    expect(validateRecord(clone({ written_at: '1789286585' }))).toBeNull();
    expect(validateRecord(clone({ written_at: 0 }))).toBeNull();
    expect(validateRecord(clone({ ended_at: 'x' }))).toBeNull();
    expect(valid(clone({ ended_at: 1789286600 })).ended_at).toBe(1789286600);
    const absent = clone();
    delete absent.ended_at;
    expect(valid(absent).ended_at).toBeNull();
  });

  it('reads a missing agent_comm and entrypoint as empty, but rejects bad ones', () => {
    const absent = clone();
    delete absent.agent_comm;
    delete absent.entrypoint;
    const record = valid(absent);
    expect(record.agent_comm).toBe('');
    expect(record.entrypoint).toBe('');
    expect(validateRecord(clone({ agent_comm: 'claude\n' }))).toBeNull();
    expect(validateRecord(clone({ entrypoint: 'cli; rm -rf /' }))).toBeNull();
    expect(valid(clone({ agent_comm: 'claude' })).agent_comm).toBe('claude');
  });

  it('rejects a tty that is not a macOS pseudo-terminal, unless the platform is linux', () => {
    expect(validateRecord(clone({ tty: 'ttys002' }), 'darwin')).toBeNull();
    expect(validateRecord(clone({ tty: '/dev/ttys02' }), 'darwin')).toBeNull();
    expect(validateRecord(clone({ tty: '/dev/pts/3' }), 'darwin')).toBeNull();
    expect(validateRecord(clone({ tty: '/dev/ttys002' }), 'linux')).toBeNull();
    expect(validateRecord(clone({ tty: '/dev/pts/3' }), 'linux')?.tty).toBe('/dev/pts/3');
    expect(validateRecord(clone({ tty: '/dev/ttys0021' }), 'darwin')?.tty).toBe('/dev/ttys0021');
    const noTty = clone();
    delete noTty.tty;
    expect(valid(noTty)).not.toHaveProperty('tty');
  });

  it('rejects a cwd, transcript or project root that is relative or carries control characters', () => {
    expect(validateRecord(clone({ cwd: '/Users/demo/src\n' }))).toBeNull();
    expect(validateRecord(clone({ cwd: '/Users/demo/\u0007bell' }))).toBeNull();
    expect(validateRecord(clone({ cwd: 'src/board' }))).toBeNull();
    expect(validateRecord(clone({ cwd: 42 }))).toBeNull();
    expect(validateRecord(clone({ transcript_path: 'rollout.jsonl' }))).toBeNull();
    expect(validateRecord(clone({ project_root: './repo' }))).toBeNull();
    expect(valid(clone({ project_root: '/Users/demo/src' })).project_root).toBe('/Users/demo/src');
    // A cwd that is only odd, not unsafe, is data: the runtime stats it, this does not.
    expect(valid(clone({ cwd: "/Users/demo/it's \"quoted\" $(here)" })).cwd).toBe("/Users/demo/it's \"quoted\" $(here)");
  });

  it('drops unknown keys at every level', () => {
    const raw = clone({
      extra: 'nope',
      app: { bundle: 'com.umputun.agterm', via: 'ppid-walk', extra: 1 },
      mux: { kind: 'tmux', socket: '/private/tmp/tmux-501/default', extra: 'x' },
      codex: { thread_id: 'abc', extra: 'x' },
    });
    const record = valid(raw);
    expect(record).not.toHaveProperty('extra');
    expect(record.app).toEqual({ bundle: 'com.umputun.agterm', via: 'ppid-walk' });
    expect(record.mux).toEqual({ kind: 'tmux', socket: '/private/tmp/tmux-501/default' });
    expect(record.codex).toEqual({ thread_id: 'abc' });
  });

  it('drops an env value that fails its regex, and keeps the record', () => {
    const record = valid(clone({ env: { ...AGTERM_RECORD.env, AGTERM_SESSION_ID: 'not-a-uuid' } }));
    expect(record.env).not.toHaveProperty('AGTERM_SESSION_ID');
    expect(record.env.AGTERM_WINDOW_ID).toBe(AGTERM_RECORD.env.AGTERM_WINDOW_ID);
    expect(record.app?.bundle).toBe('com.umputun.agterm');
  });

  it('drops KITTY_LISTEN_ON unless it is a unix: socket', () => {
    expect(valid(clone({ env: { KITTY_LISTEN_ON: 'fd:5' } })).env).not.toHaveProperty('KITTY_LISTEN_ON');
    expect(valid(clone({ env: { KITTY_LISTEN_ON: 'tcp:localhost:12345' } })).env).not.toHaveProperty('KITTY_LISTEN_ON');
    expect(valid(clone({ env: { KITTY_LISTEN_ON: 'unix:relative' } })).env).not.toHaveProperty('KITTY_LISTEN_ON');
    expect(valid(clone({ env: { KITTY_LISTEN_ON: 'unix:/tmp/kitty-1' } })).env.KITTY_LISTEN_ON).toBe('unix:/tmp/kitty-1');
  });

  it('drops env keys outside the whitelist, non-string values and an odd TERM_PROGRAM', () => {
    const record = valid(clone({
      env: {
        ...AGTERM_RECORD.env,
        AWS_SECRET_ACCESS_KEY: 'AKIA-leak',
        PATH: '/usr/bin',
        KITTY_WINDOW_ID: 7,
        TERM_PROGRAM: 'ghostty\u001b[0m',
        WEZTERM_PANE: '12abc',
      },
    }));
    expect(record.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(record.env).not.toHaveProperty('PATH');
    expect(record.env).not.toHaveProperty('KITTY_WINDOW_ID');
    expect(record.env).not.toHaveProperty('TERM_PROGRAM');
    expect(record.env).not.toHaveProperty('WEZTERM_PANE');
    expect(record.env.AGTERM_SOCKET).toBe(AGTERM_RECORD.env.AGTERM_SOCKET);
    expect(validateRecord(clone({ env: 'TERM=x' }))).toBeNull();
    expect(validateRecord(clone({ env: ['TERM'] }))).toBeNull();
  });

  it('validates each mux kind, and fails the record on a bad socket or target', () => {
    const herdr = { kind: 'herdr', target: 'w1:p3', tab: 'w1:t1', workspace: 'w1', socket: '/tmp/x.sock', session: 'main' };
    expect(valid(clone({ mux: herdr })).mux).toEqual(herdr);
    expect(validateRecord(clone({ mux: { ...herdr, socket: 'tmp/x.sock' } }))).toBeNull();
    expect(validateRecord(clone({ mux: { ...herdr, socket: `/${'s'.repeat(200)}` } }))).toBeNull();
    expect(valid(clone({ mux: { ...herdr, socket: `/${'s'.repeat(199)}` } })).mux?.socket).toHaveLength(200);
    expect(validateRecord(clone({ mux: { ...herdr, socket: '/tmp/x\n.sock' } }))).toBeNull();
    expect(validateRecord(clone({ mux: { ...herdr, target: 'w1:t3' } }))).toBeNull();
    expect(validateRecord(clone({ mux: { ...herdr, workspace: 'ws1' } }))).toBeNull();

    const tmux = { kind: 'tmux', target: 'main:@3.%7', socket: '/private/tmp/tmux-501/default' };
    expect(valid(clone({ mux: tmux })).mux).toEqual(tmux);
    expect(validateRecord(clone({ mux: { ...tmux, target: 'main:@3' } }))).toBeNull();
    expect(validateRecord(clone({ mux: { ...tmux, target: 'main:@3.%7; rm' } }))).toBeNull();
    // The hook writes tmux without a target when display-message failed; the planner refuses it, not the loader.
    expect(valid(clone({ mux: { kind: 'tmux', socket: tmux.socket } })).mux).toEqual({ kind: 'tmux', socket: tmux.socket });
    // A field that means nothing for the kind is dropped.
    expect(valid(clone({ mux: { ...tmux, tab: 'w1:t1' } })).mux).toEqual(tmux);

    const zellij = { kind: 'zellij', target: '0', session: 'dev' };
    expect(valid(clone({ mux: zellij })).mux).toEqual(zellij);
    expect(validateRecord(clone({ mux: { ...zellij, session: 'dev session' } }))).toBeNull();

    const screen = { kind: 'screen', target: '2', session: '12345.ttys002.studio' };
    expect(valid(clone({ mux: screen })).mux).toEqual(screen);
    expect(validateRecord(clone({ mux: { ...screen, target: 'two' } }))).toBeNull();

    expect(validateRecord(clone({ mux: { kind: 'byobu' } }))).toBeNull();
    expect(validateRecord(clone({ mux: 'tmux' }))).toBeNull();
    expect(validateRecord(clone({ mux: { kind: 'tmux', socket: 42 } }))).toBeNull();
  });

  it('validates codex ids, reads null originator/source as absent, and fails on a bad thread id', () => {
    const codex = {
      thread_id: '0198a7b2-1111-7000-8000-aaaaaaaaaaaa',
      root_thread_id: '0198a7b2-2222-7000-8000-bbbbbbbbbbbb',
      parent_thread_id: '0198a7b2-2222-7000-8000-bbbbbbbbbbbb',
      originator: 'Codex Desktop',
      source: 'vscode',
    };
    expect(valid(clone({ codex })).codex).toEqual(codex);
    const sparse = valid(clone({ codex: { thread_id: 'abc', parent_thread_id: null, originator: null, source: null } }));
    expect(sparse.codex).toEqual({ thread_id: 'abc', parent_thread_id: null });
    expect(validateRecord(clone({ codex: { thread_id: 'not a thread!' } }))).toBeNull();
    expect(validateRecord(clone({ codex: { root_thread_id: 'x'.repeat(65) } }))).toBeNull();
    expect(validateRecord(clone({ codex: { thread_id: 'abc', parent_thread_id: 7 } }))).toBeNull();
    expect(validateRecord(clone({ codex: 'abc' }))).toBeNull();
  });

  it('requires absolute bin paths and plain bin names', () => {
    expect(validateRecord(clone({ bins: { tmux: 'tmux' } }))).toBeNull();
    expect(validateRecord(clone({ bins: { tmux: '/opt/homebrew/bin/tmux\n' } }))).toBeNull();
    expect(validateRecord(clone({ bins: { 'tm ux': '/opt/homebrew/bin/tmux' } }))).toBeNull();
    expect(validateRecord(clone({ bins: { tmux: 7 } }))).toBeNull();
    expect(validateRecord(clone({ bins: [] }))).toBeNull();
    const absent = clone();
    delete absent.bins;
    expect(valid(absent).bins).toEqual({});
  });

  it('validates app and summary, failing the record when either is malformed', () => {
    expect(validateRecord(clone({ app: { bundle: 'com.umputun.agterm' } }))).toBeNull();
    expect(validateRecord(clone({ app: { bundle: 'com umputun', via: 'env' } }))).toBeNull();
    expect(validateRecord(clone({ app: { via: 'ppid-walk', pid: 0 } }))).toBeNull();
    expect(validateRecord(clone({ app: { via: 'ppid-walk', path: 'agterm.app' } }))).toBeNull();
    expect(valid(clone({ app: { via: 'ppid-walk', path: '/Applications/agterm.app', pid: 662 } })).app)
      .toEqual({ via: 'ppid-walk', path: '/Applications/agterm.app', pid: 662 });
    expect(validateRecord(clone({ summary: { machine: { id: 'short', name: 'Mac' }, app: AGTERM_RECORD.summary.app } }))).toBeNull();
    expect(validateRecord(clone({ summary: { machine: AGTERM_RECORD.summary.machine, app: { slug: 'emacs', name: 'x', kind: 'terminal' } } }))).toBeNull();
    expect(validateRecord(clone({ summary: 'agterm' }))).toBeNull();
    expect(validateRecord(clone({ path: 'a\u0000b' }))).toBeNull();
  });
});

describe('loadRecords', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-records-'));
  const folder = path.join(tmp, 'sessions', SESSION);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (name: string, content: unknown, mode: number): string => {
    const file = path.join(folder, name);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const clear = (): void => {
    for (const name of fs.readdirSync(folder)) fs.rmSync(path.join(folder, name), { recursive: true, force: true });
  };

  it('accepts a 0600 record and refuses one readable by group or other', () => {
    clear();
    write('7449.json', AGTERM_RECORD, 0o600);
    write('7450.json', { ...AGTERM_RECORD, agent_pid: 7450 }, 0o644);
    write('7451.json', { ...AGTERM_RECORD, agent_pid: 7451 }, 0o640);
    const { records, rejected } = loadRecords(tmp, SESSION);
    expect(records.map((r) => r.agent_pid)).toEqual([7449]);
    expect(rejected).toBe(2);
  });

  it('refuses directories, symlinks, bad JSON, invalid records and other sessions', () => {
    clear();
    const good = write('7449.json', AGTERM_RECORD, 0o600);
    fs.mkdirSync(path.join(folder, 'dir.json'), { mode: 0o700 });
    fs.symlinkSync(good, path.join(folder, 'link.json'));
    write('broken.json', '{"v":1,', 0o600);
    write('bad.json', { ...AGTERM_RECORD, agent_pid: 0 }, 0o600);
    write('other.json', { ...AGTERM_RECORD, session_id: 'other-session' }, 0o600);
    write('7449.json.123.tmp', '{', 0o600); // the hook's temp file: skipped, not counted
    const { records, rejected } = loadRecords(tmp, SESSION);
    expect(records.map((r) => r.agent_pid)).toEqual([7449]);
    expect(rejected).toBe(5);
  });

  it('sorts newest written_at first', () => {
    clear();
    write('100.json', { ...AGTERM_RECORD, agent_pid: 100, written_at: 1000 }, 0o600);
    write('300.json', { ...AGTERM_RECORD, agent_pid: 300, written_at: 3000 }, 0o600);
    write('200.json', { ...AGTERM_RECORD, agent_pid: 200, written_at: 2000 }, 0o600);
    const { records } = loadRecords(tmp, SESSION);
    expect(records.map((r) => r.agent_pid)).toEqual([300, 200, 100]);
  });

  it('never touches the filesystem for a session id unfit for a path', () => {
    const spy = vi.spyOn(fs, 'readdirSync');
    try {
      for (const id of ['..', '.', '../x', `${SESSION}/..`, 'a b']) {
        expect(loadRecords(tmp, id)).toEqual({ records: [], rejected: 0 });
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports nothing for a session with no directory', () => {
    expect(loadRecords(tmp, 'never-seen')).toEqual({ records: [], rejected: 0 });
    expect(loadRecords(path.join(tmp, 'missing'), SESSION)).toEqual({ records: [], rejected: 0 });
  });
});

describe('pickRecord', () => {
  const at = (agent_pid: number, written_at: number): LocalRecord =>
    ({ ...(validateRecord(clone()) as LocalRecord), agent_pid, written_at });
  const older = at(100, 1000);
  const middle = at(200, 2000);
  const newest = at(300, 3000);

  it('returns null for no records', () => {
    expect(pickRecord([], () => true)).toBeNull();
    expect(pickRecord([], { agentAlive: true })).toBeNull();
  });

  it('prefers the most recently written record whose agent is alive', () => {
    const records = [older, newest, middle];
    expect(pickRecord(records, (r) => r.agent_pid !== 300)).toBe(middle);
    expect(pickRecord(records, (r) => r.agent_pid === 100)).toBe(older);
    expect(records).toEqual([older, newest, middle]); // never reordered in place
  });

  it('falls back to the most recent record when none is alive', () => {
    expect(pickRecord([older, middle, newest], () => false)).toBe(newest);
    expect(pickRecord([older, middle, newest], { agentAlive: false })).toBe(newest);
    expect(pickRecord([older, middle, newest], { agentAlive: true })).toBe(newest);
  });
});
