import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LAUNCHER_NAME,
  launcherPath,
  launcherResolves,
  launcherStateDir,
  removeLauncher,
  renderLauncher,
  resolveResumeCwd,
  resumeArgv,
  runResumeExec,
  usableLauncher,
  writeLauncher,
  type ResumeExec,
} from '../src/listener/resume';
import { resumeEnabled } from '../src/listener/config';
import type { ExecFile } from '../src/listener/exec';
import type { LocalRecord } from '../src/listener/types';

/**
 * The resume launcher and `listener resume-exec` — the one path in AgStatus
 * that starts an agent. Everything here runs against a throwaway HOME and
 * state dir; the single launch is an injected exec, so no test ever starts a
 * real agent. What is asserted is the shape of the script (byte for byte),
 * the modes that make it usable, where a resume is allowed to start, and the
 * exact argv the agent gets.
 */

const SESSION = 'd916b7fe-6047-4fed-b87e-8fb52b3cd91e';
const ENV_KEYS = ['HOME', 'AGSTATUS_STATE_DIR', 'CLAUDE_CONFIG_DIR', 'AGSTATUS_RESUME'];

let saved: Record<string, string | undefined>;
let home: string;
let state: string;
const temps: string[] = [];

const mkdtemp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agstatus-${tag}-`));
  temps.push(dir);
  return dir;
};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtemp('rhome');
  state = mkdtemp('rstate');
  process.env.HOME = home;
  process.env.AGSTATUS_STATE_DIR = state;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  while (temps.length > 0) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/** A Claude record as validateRecord() would hand it over, with the fields a test cares about. */
const claudeRecord = (over: Partial<LocalRecord> = {}): LocalRecord => ({
  v: 1,
  session_id: SESSION,
  agent: 'claude',
  agent_pid: 4242,
  agent_comm: '/Users/demo/.local/bin/claude',
  entrypoint: 'cli',
  written_at: 1789286585,
  ended_at: null,
  env: {},
  bins: {},
  ...over,
});

const codexRecord = (over: Partial<LocalRecord> = {}): LocalRecord =>
  claudeRecord({ agent: 'codex', agent_comm: '/Applications/ChatGPT.app/Contents/Resources/codex', ...over });

/** An executable file the resolver will accept as an agent binary (0755, ours, in a 0700 dir). */
function fakeBin(name: string): string {
  const dir = mkdtemp('rbin');
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

/** One local record on disk, exactly as the hook writes them: 0600, under sessions/<session>/<pid>.json. */
function writeRecord(dir: string, record: Record<string, unknown>): void {
  const folder = path.join(dir, 'sessions', String(record.session_id));
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${String(record.agent_pid)}.json`);
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const recordJson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  session_id: SESSION,
  agent: 'claude',
  agent_pid: 4242,
  agent_comm: '/Users/demo/.local/bin/claude',
  entrypoint: 'cli',
  written_at: 1789286585,
  ended_at: null,
  env: {},
  bins: {},
  ...over,
});

/** An exec that records its one call and never starts anything. */
function recorder(code = 0): { exec: ResumeExec; calls: Array<{ file: string; args: string[]; cwd: string }> } {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const exec: ResumeExec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    return { code };
  };
  return { exec, calls };
}

/** `ps` for a pid that is not there any more: the ordinary case for a resume. */
const gonePs: ExecFile = async () => ({ code: 1, stdout: '' });

const quiet = (): { log: (l: string) => void; out: () => string } => {
  const lines: string[] = [];
  return { log: (l) => lines.push(l), out: () => lines.join('\n') };
};

describe('renderLauncher', () => {
  it('is the three fixed lines, with both absolute paths quoted and only "$1" left to the shell', () => {
    expect(renderLauncher('/usr/local/bin/node', '/opt/agstatus/dist/cli.js')).toBe(
      '#!/bin/sh\n' +
        '# AgStatus Focus resume launcher — written by `agstatus listener install`.\n' +
        'exec "/usr/local/bin/node" "/opt/agstatus/dist/cli.js" listener resume-exec "$1"\n'
    );
  });

  it('interpolates nothing else: a space in a path stays inside the quotes', () => {
    const text = renderLauncher('/Users/demo/My Tools/node', '/Users/demo/My Tools/cli.js');
    expect(text.split('\n')[2]).toBe(
      'exec "/Users/demo/My Tools/node" "/Users/demo/My Tools/cli.js" listener resume-exec "$1"'
    );
    expect(text.split('\n')).toHaveLength(4); // three lines and the trailing newline
  });

  it('throws on a relative path, and on anything that would escape the quotes', () => {
    expect(() => renderLauncher('node', '/opt/agstatus/dist/cli.js')).toThrow(/absolute/);
    expect(() => renderLauncher('/usr/local/bin/node', 'dist/cli.js')).toThrow(/absolute/);
    expect(() => renderLauncher('/usr/local/bin/node', '')).toThrow(/absolute/);
    for (const bad of ['/tmp/no"de', '/tmp/no$de', '/tmp/no`de', '/tmp/no\\de', '/tmp/no\nde']) {
      expect(() => renderLauncher(bad, '/opt/agstatus/dist/cli.js')).toThrow(/cannot quote/);
      expect(() => renderLauncher('/usr/local/bin/node', bad)).toThrow(/cannot quote/);
    }
  });
});

describe('writeLauncher', () => {
  it('writes a 0700 script at <stateDir>/agstatus-resume and leaves no temp file behind', () => {
    const file = writeLauncher(state, '/usr/local/bin/node', '/opt/agstatus/dist/cli.js');
    expect(file).toBe(path.join(state, LAUNCHER_NAME));
    expect(file).toBe(launcherPath(state));
    expect(fs.statSync(file).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(file, 'utf8')).toBe(renderLauncher('/usr/local/bin/node', '/opt/agstatus/dist/cli.js'));
    expect(fs.readdirSync(state)).toEqual([LAUNCHER_NAME]);
  });

  it('creates the state dir 0700, and rewrites an existing launcher in place', () => {
    const fresh = path.join(state, 'nested');
    writeLauncher(fresh, '/usr/local/bin/node', '/opt/a/cli.js');
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
    writeLauncher(fresh, '/usr/local/bin/node', '/opt/b/cli.js');
    expect(fs.readFileSync(launcherPath(fresh), 'utf8')).toContain('/opt/b/cli.js');
    expect(fs.readdirSync(fresh)).toEqual([LAUNCHER_NAME]);
  });

  it('writes nothing at all when a path is not absolute', () => {
    expect(() => writeLauncher(state, '/usr/local/bin/node', 'cli.js')).toThrow(/absolute/);
    expect(fs.existsSync(launcherPath(state))).toBe(false);
  });
});

describe('usableLauncher', () => {
  it('accepts the 0700 file it wrote', () => {
    const file = writeLauncher(state, '/usr/local/bin/node', '/opt/agstatus/dist/cli.js');
    expect(usableLauncher(state)).toBe(file);
  });

  it('refuses a missing file, a loosened mode, a directory, a symlink and another user’s file', () => {
    expect(usableLauncher(state)).toBeUndefined();

    const file = writeLauncher(state, '/usr/local/bin/node', '/opt/agstatus/dist/cli.js');
    for (const mode of [0o755, 0o770, 0o701, 0o600]) {
      fs.chmodSync(file, mode);
      expect(usableLauncher(state)).toBeUndefined();
    }
    fs.chmodSync(file, 0o700);
    expect(usableLauncher(state)).toBe(file);

    // Owned by somebody else (simulated through the uid argument the runtime passes).
    const me = uid();
    if (me !== undefined) expect(usableLauncher(state, me + 1)).toBeUndefined();

    fs.rmSync(file);
    const target = path.join(state, 'real-launcher');
    fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o700 });
    fs.symlinkSync(target, file);
    expect(usableLauncher(state)).toBeUndefined();
    fs.rmSync(file);

    fs.mkdirSync(file, { mode: 0o700 });
    expect(usableLauncher(state)).toBeUndefined();
  });
});

describe('resolveResumeCwd', () => {
  it('takes the recorded cwd when it is still a directory of ours', () => {
    const dir = mkdtemp('rcwd');
    expect(resolveResumeCwd(claudeRecord({ cwd: dir }))).toBe(dir);
  });

  it('refuses a recorded cwd that is a file, that is gone, or that belongs to someone else', () => {
    const dir = mkdtemp('rcwd');
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, '');
    expect(resolveResumeCwd(claudeRecord({ cwd: file }))).toBeUndefined();
    expect(resolveResumeCwd(claudeRecord({ cwd: path.join(dir, 'gone') }))).toBeUndefined();
    const me = uid();
    if (me !== undefined) expect(resolveResumeCwd(claudeRecord({ cwd: dir }), me + 1)).toBeUndefined();
  });

  it('falls back to ~/.claude/projects/*/<session>.jsonl and reads the cwd from the file, never from the folder name', () => {
    const real = mkdtemp('rrepo');
    // The project folder name is a LOSSY encoding of a path ("/Users/x/my-repo"
    // and "/Users/x/my/repo" both land here) — it is only a folder to look in.
    const lossy = path.join(home, '.claude', 'projects', '-Users-x-my-repo');
    fs.mkdirSync(lossy, { recursive: true });
    fs.writeFileSync(
      path.join(lossy, `${SESSION}.jsonl`),
      [
        JSON.stringify({ type: 'queue-operation', sessionId: SESSION }), // carries no cwd
        JSON.stringify({ type: 'user', sessionId: SESSION, cwd: real }),
        '',
      ].join('\n')
    );

    const resolved = resolveResumeCwd(claudeRecord({ cwd: '/nope/gone' }));
    expect(resolved).toBe(real);
    expect(resolved).not.toBe('/Users/x/my-repo');
    expect(resolved).not.toContain('-Users-x-my-repo');
  });

  it('ignores a transcript whose cwd is gone, and a cwd hiding past the 1 MiB read', () => {
    const projects = path.join(home, '.claude', 'projects');
    const stale = path.join(projects, '-Users-x-stale');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, `${SESSION}.jsonl`), JSON.stringify({ cwd: '/Users/x/was-deleted' }) + '\n');
    expect(resolveResumeCwd(claudeRecord())).toBeUndefined();

    const real = mkdtemp('rrepo');
    const huge = path.join(projects, '-Users-x-huge');
    fs.mkdirSync(huge, { recursive: true });
    fs.writeFileSync(
      path.join(huge, `${SESSION}.jsonl`),
      `${'x'.repeat(1024 * 1024 + 16)}\n${JSON.stringify({ cwd: real })}\n`
    );
    expect(resolveResumeCwd(claudeRecord())).toBeUndefined();
  });

  it('reads a Codex rollout’s session_meta line, and only that line', () => {
    const real = mkdtemp('rrepo');
    const other = mkdtemp('rrepo');
    const rollout = path.join(mkdtemp('rsessions'), 'rollout-2026-09-15T10-00-00-abc.jsonl');
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({ timestamp: '2026-09-15T10:00:00Z', type: 'session_meta', payload: { id: SESSION, cwd: real } }),
        JSON.stringify({ type: 'event_msg', cwd: other }),
        '',
      ].join('\n')
    );
    expect(resolveResumeCwd(codexRecord({ transcript_path: rollout }))).toBe(real);

    // A rollout that names its directory only on a later line is no answer.
    const late = path.join(path.dirname(rollout), 'rollout-late.jsonl');
    fs.writeFileSync(late, [JSON.stringify({ type: 'session_meta', payload: {} }), JSON.stringify({ cwd: other }), ''].join('\n'));
    expect(resolveResumeCwd(codexRecord({ transcript_path: late }))).toBeUndefined();
  });

  it('is undefined when there is nothing left to point at', () => {
    expect(resolveResumeCwd(claudeRecord())).toBeUndefined();
    expect(resolveResumeCwd(codexRecord({ transcript_path: '/nope/rollout.jsonl' }))).toBeUndefined();
  });
});

describe('resumeArgv', () => {
  it('gives Claude exactly --resume <session>, and Codex exactly resume <root thread>', () => {
    expect(resumeArgv(claudeRecord(), { claude: '/Users/demo/.local/bin/claude' })).toEqual({
      file: '/Users/demo/.local/bin/claude',
      args: ['--resume', SESSION],
    });

    const root = '01a01b80-c46e-7dd2-ab6e-92dd86fa65e5';
    const codex = codexRecord({ codex: { thread_id: '01a01bab-1b27-7d83-b491-7b8d53f365f4', root_thread_id: root } });
    expect(resumeArgv(codex, { codex: '/Applications/ChatGPT.app/Contents/Resources/codex' })).toEqual({
      file: '/Applications/ChatGPT.app/Contents/Resources/codex',
      args: ['resume', root],
    });
    // No recorded thread: the session id is the root id the hook posts.
    expect(resumeArgv(codexRecord(), { codex: '/bin/codex' })?.args).toEqual(['resume', SESSION]);
  });

  it('is undefined without a binary, with a relative one, or when the id fails its regex', () => {
    expect(resumeArgv(claudeRecord(), {})).toBeUndefined();
    expect(resumeArgv(codexRecord(), {})).toBeUndefined();
    expect(resumeArgv(claudeRecord(), { claude: 'claude' })).toBeUndefined();
    expect(resumeArgv(claudeRecord(), { codex: '/bin/codex' })).toBeUndefined();
    expect(resumeArgv(claudeRecord({ session_id: 'not-a-uuid' }), { claude: '/bin/claude' })).toBeUndefined();
    expect(
      resumeArgv(codexRecord({ codex: { root_thread_id: '../../etc' } }), { codex: '/bin/codex' })
    ).toBeUndefined();
  });
});

describe('runResumeExec', () => {
  it('runs the newest record’s agent in the directory it ran in, and exits with its code', async () => {
    const bin = fakeBin('claude');
    const older = mkdtemp('rold');
    const newer = mkdtemp('rnew');
    writeRecord(state, recordJson({ agent_pid: 11, written_at: 1000, cwd: older, bins: { claude: bin } }));
    writeRecord(state, recordJson({ agent_pid: 12, written_at: 2000, cwd: newer, bins: { claude: bin } }));

    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await runResumeExec(SESSION, { stateDir: state, execFile: gonePs, exec, log })).toBe(0);
    expect(calls).toEqual([{ file: bin, args: ['--resume', SESSION], cwd: newer }]);
    expect(out()).toContain(newer);

    // The agent's own exit code comes back.
    const failing = recorder(3);
    expect(await runResumeExec(SESSION, { stateDir: state, execFile: gonePs, exec: failing.exec, log })).toBe(3);
  });

  it('resumes Codex with its root thread id', async () => {
    const bin = fakeBin('codex');
    const dir = mkdtemp('rrepo');
    const root = '01a01b80-c46e-7dd2-ab6e-92dd86fa65e5';
    writeRecord(
      state,
      recordJson({ agent: 'codex', agent_comm: 'codex', cwd: dir, bins: { codex: bin }, codex: { root_thread_id: root } })
    );
    const { exec, calls } = recorder();
    expect(await runResumeExec(SESSION, { stateDir: state, execFile: gonePs, exec, log: quiet().log })).toBe(0);
    expect(calls).toEqual([{ file: bin, args: ['resume', root], cwd: dir }]);
  });

  it('refuses a session with no record here, and starts nothing', async () => {
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await runResumeExec('11111111-2222-4333-8444-555555555555', { stateDir: state, execFile: gonePs, exec, log })).toBe(1);
    expect(calls).toEqual([]);
    expect(out()).toContain('no local record');
  });

  it('refuses when the directory the session ran in is gone', async () => {
    const bin = fakeBin('claude');
    const gone = mkdtemp('rgone');
    fs.rmSync(gone, { recursive: true, force: true });
    writeRecord(state, recordJson({ cwd: gone, bins: { claude: bin } }));

    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await runResumeExec(SESSION, { stateDir: state, execFile: gonePs, exec, log })).toBe(1);
    expect(calls).toEqual([]);
    expect(out()).toContain('gone');
  });

  it('never launches a recorded binary that anyone else could replace', async () => {
    const dir = mkdtemp('rrepo');
    const planted = path.join(dir, 'claude');
    fs.writeFileSync(planted, '#!/bin/sh\nexit 0\n', { mode: 0o777 });
    fs.chmodSync(planted, 0o777); // group- and world-writable: not ours alone any more
    writeRecord(state, recordJson({ cwd: dir, bins: { claude: planted } }));

    const { exec, calls } = recorder();
    await runResumeExec(SESSION, { stateDir: state, execFile: gonePs, exec, log: quiet().log });
    // Either the listener's own resolution found a real claude, or nothing ran;
    // what the record named is never what gets launched.
    expect(calls.map((c) => c.file)).not.toContain(planted);
  });

  it('resolves the state dir itself when the launcher passed none', async () => {
    // The launcher's three lines carry node, cli.js and `"$1"` — nothing
    // else, ever — so this is the branch the real one always takes.
    // AGSTATUS_STATE_DIR is pinned to the fixture for this suite.
    const bin = fakeBin('claude');
    const dir = mkdtemp('rrepo');
    writeRecord(state, recordJson({ cwd: dir, bins: { claude: bin } }));
    const { exec, calls } = recorder();
    expect(await runResumeExec(SESSION, { execFile: gonePs, exec, log: quiet().log })).toBe(0);
    expect(calls).toEqual([{ file: bin, args: ['--resume', SESSION], cwd: dir }]);
  });

  it('refuses while resume is switched off, before it reads a record', async () => {
    const bin = fakeBin('claude');
    writeRecord(state, recordJson({ cwd: mkdtemp('rrepo'), bins: { claude: bin } }));
    fs.writeFileSync(path.join(home, '.agstatus.json'), JSON.stringify({ focus: true, resume: false }));

    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await runResumeExec(SESSION, { stateDir: state, execFile: gonePs, exec, log })).toBe(1);
    expect(calls).toEqual([]);
    expect(out()).toContain('switched off');

    // …and AGSTATUS_RESUME=off does it for one run, launcher or no launcher.
    fs.writeFileSync(path.join(home, '.agstatus.json'), JSON.stringify({ focus: true }));
    process.env.AGSTATUS_RESUME = 'off';
    expect(await runResumeExec(SESSION, { stateDir: state, execFile: gonePs, exec, log })).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses to start a second agent on a session that turns out to be running', async () => {
    const bin = fakeBin('claude');
    writeRecord(state, recordJson({ cwd: mkdtemp('rrepo'), bins: { claude: bin } }));
    // `ps` answers with the recorded comm: the pid is that very agent. A
    // command the board re-sent, or a `ps` that failed when the plan was
    // made, must not put two `--resume <same uuid>` on one transcript.
    const running: ExecFile = async (file, args) => {
      expect(file).toBe('/bin/ps');
      expect(args).toEqual(['-o', 'comm=', '-p', '4242']);
      return { code: 0, stdout: '/Users/demo/.local/bin/claude\n' };
    };
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    expect(await runResumeExec(SESSION, { stateDir: state, execFile: running, exec, log, platform: 'darwin' })).toBe(1);
    expect(calls).toEqual([]);
    expect(out()).toContain('still running');
  });

  it('is transparent to the terminal’s signals for as long as the agent runs', async () => {
    // Not a real execv: Ctrl-C reaches this wrapper too, and the terminal
    // emulator is watching *it* — dying on SIGINT would close the window and
    // SIGHUP the session that was just restored.
    const dir = mkdtemp('rbin');
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\nsleep 0.4\nexit 7\n', { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    writeRecord(state, recordJson({ cwd: mkdtemp('rrepo'), bins: { claude: bin } }));

    const before = process.listeners('SIGINT').length;
    const run = runResumeExec(SESSION, { stateDir: state, execFile: gonePs, log: quiet().log });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(process.listeners('SIGINT').length).toBe(before + 1);
    expect(process.listeners('SIGTERM').length).toBeGreaterThan(0);

    expect(await run).toBe(7); // the agent's own exit code, as a real exec would
    expect(process.listeners('SIGINT').length).toBe(before); // and the handlers come off again
  });

  it('refuses an id that is not a uuid before it touches the filesystem at all', async () => {
    const spies = (['readdirSync', 'readFileSync', 'lstatSync', 'statSync', 'openSync', 'existsSync'] as const).map(
      (name) => vi.spyOn(fs, name)
    );
    const { exec, calls } = recorder();
    const { log, out } = quiet();
    for (const bad of ['../../etc/passwd', `${SESSION}/../..`, 'not-a-uuid', '', `${SESSION} extra`]) {
      expect(await runResumeExec(bad, { stateDir: state, execFile: gonePs, exec, log })).toBe(1);
    }
    expect(calls).toEqual([]);
    expect(out()).toContain('session uuid');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    // …and the spies are live: a well-formed uuid does reach the filesystem.
    expect(await runResumeExec(SESSION, { stateDir: state, execFile: gonePs, exec, log })).toBe(1);
    expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
  });
});

describe('`agstatus listener resume-exec`', () => {
  it('is wired to the dispatch, needs an id, and refuses one that is not a uuid', async () => {
    const { main } = await import('../src/index');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await main(['listener', 'resume-exec'])).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toContain('resume-exec <session-id>');

    // A bad id gets the launcher's own one-line answer, not the usage text.
    err.mockClear();
    expect(await main(['listener', 'resume-exec', 'not-a-uuid'])).toBe(1);
    expect(err).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('session uuid');
  });
});

describe('resumeEnabled', () => {
  const file = (): string => path.join(home, '.agstatus.json');

  it('is on by default, and on when the key is anything but false', () => {
    expect(resumeEnabled(file())).toBe(true);
    fs.writeFileSync(file(), JSON.stringify({ focus: true }));
    expect(resumeEnabled(file())).toBe(true);
    fs.writeFileSync(file(), JSON.stringify({ focus: true, resume: true }));
    expect(resumeEnabled(file())).toBe(true);
  });

  it('is off on "resume": false, and off for one run on AGSTATUS_RESUME=off', () => {
    fs.writeFileSync(file(), JSON.stringify({ focus: true, resume: false }));
    expect(resumeEnabled(file())).toBe(false);

    fs.writeFileSync(file(), JSON.stringify({ focus: true }));
    process.env.AGSTATUS_RESUME = 'off';
    expect(resumeEnabled(file())).toBe(false);
    process.env.AGSTATUS_RESUME = 'on';
    expect(resumeEnabled(file())).toBe(true);
  });

  it('does not read a "no" into a file it cannot parse', () => {
    fs.writeFileSync(file(), '{oops');
    expect(resumeEnabled(file())).toBe(true);
  });
});

describe('where the launcher can be used at all', () => {
  it('is the platform default only: AGSTATUS_STATE_DIR does not survive the trip to a new window', () => {
    // The listener may run with AGSTATUS_STATE_DIR (its plist carries one),
    // but the launcher is started by a terminal, a mux server or
    // LaunchServices, and is handed no environment of ours. So this is what
    // `resume-exec` would read, and an install anywhere else must answer
    // unsupported-host rather than ack a resume that never happened.
    const dflt = path.join(home, 'Library', 'Application Support', 'AgStatus');
    expect(launcherStateDir('darwin', home)).toBe(dflt);
    expect(launcherStateDir('linux', home)).toBe(path.join(home, '.local', 'state', 'agstatus'));

    expect(launcherResolves(dflt, 'darwin', home)).toBe(true);
    expect(launcherResolves(`${dflt}/`, 'darwin', home)).toBe(true);
    expect(launcherResolves(state, 'darwin', home)).toBe(false); // the pinned AGSTATUS_STATE_DIR
    expect(launcherResolves('relative/dir', 'darwin', home)).toBe(false);
    expect(launcherResolves('', 'darwin', home)).toBe(false);
  });

  it('removeLauncher takes the file away and says whether there was one', () => {
    expect(removeLauncher(state)).toBe(false);
    writeLauncher(state, '/usr/local/bin/node', '/opt/agstatus/dist/cli.js');
    expect(removeLauncher(state)).toBe(true);
    expect(fs.existsSync(launcherPath(state))).toBe(false);
    expect(usableLauncher(state)).toBeUndefined();
  });
});
