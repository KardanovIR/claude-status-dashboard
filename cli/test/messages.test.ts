import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Drives the REAL hook script with realistic Claude Code / Codex payloads and
 * asserts the status + human-readable message it posts. Field names here were
 * captured from live Claude Code hook payloads.
 *
 * The capture server runs as a SIBLING child process, not inside the vitest
 * worker: in some sandboxed environments a subprocess cannot connect to a port
 * owned by the worker itself (same reason as e2e.test.ts).
 */

const HOOK = path.resolve(__dirname, '..', 'assets', 'agstatus-hook.js');

interface Posted {
  status: string;
  message: string;
}

let server: ChildProcess;
let base: string;
let capturePath: string;
let stateDir: string;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-msg-'));
  capturePath = path.join(dir, 'posted.jsonl');
  // The hook writes a Focus record whenever the machine has opted in; without
  // this the suite would leave fixtures in the developer's own state directory.
  stateDir = dir;
  fs.writeFileSync(capturePath, '');

  const script = `
    const http = require('http'), fs = require('fs');
    const out = process.argv[1];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        fs.appendFileSync(out, JSON.stringify({ url: req.url, body: b }) + '\\n');
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    srv.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + srv.address().port + '\\n'));
  `;
  server = spawn(process.execPath, ['-e', script, capturePath], { stdio: ['ignore', 'pipe', 'ignore'] });

  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('capture server did not start')), 10_000);
    server.stdout!.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString());
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.kill();
});

/**
 * Every request the hook made, in order and whatever the path — the status
 * post and the usage reports go to different endpoints, and a test that only
 * ever saw /webhook could not tell "reported nothing" from "reported it
 * somewhere else".
 */
function captured(): Array<{ url: string; body: string }> {
  return fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { url: string; body: string });
}

/** Fires the hook with the given payload fields and returns what it posted. */
function fireEvent(
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Posted | undefined {
  fs.writeFileSync(capturePath, '');
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      session_id: 'msg-test',
      cwd: '/tmp/demo-project',
      ...payload,
    }),
    // AGSTATUS_USAGE=off: never read real credentials from a test.
    env: { ...process.env, CLAUDE_STATUS_URL: base, AGSTATUS_USAGE: 'off', AGSTATUS_STATE_DIR: stateDir, ...extraEnv },
    timeout: 8000,
  });
  // The hook awaits its POST before exiting, but the server still has to write.
  const deadline = Date.now() + 3000;
  for (;;) {
    const webhook = captured().filter((p) => p.url === '/webhook');
    if (webhook.length > 0) return JSON.parse(webhook[0].body) as Posted;
    if (Date.now() > deadline) return undefined;
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']); // brief pause
  }
}

/** Fires the hook with a PreToolUse payload and returns what it posted. */
function fire(
  toolName: string,
  toolInput: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Posted | undefined {
  return fireEvent(
    { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput },
    extraEnv,
  );
}

describe('hook status messages', () => {
  it('prefers the agent-written description over the raw Bash command', () => {
    const posted = fire('Bash', {
      command: 'git status --short && git log --oneline -5',
      description: 'Show working tree status',
    });
    expect(posted?.message).toBe('Show working tree status');
    expect(posted?.status).toBe('coding');
  });

  it('still classifies tests from the command, not the description', () => {
    const posted = fire('Bash', {
      command: 'npx vitest run test/usage.test.ts',
      description: 'Check the new usage endpoint',
    });
    expect(posted?.status).toBe('testing');
    expect(posted?.message).toBe('Check the new usage endpoint');
  });

  it('falls back to the command when no description is supplied', () => {
    const posted = fire('Bash', { command: 'ls -la' });
    expect(posted?.message).toBe('ls -la');
  });

  it('handles a Codex argv-array command', () => {
    const posted = fire('Bash', { command: ['bash', '-lc', 'npm test'] });
    expect(posted?.status).toBe('testing');
    expect(posted?.message).toBe('bash -lc npm test');
  });

  it('names the file being edited or written', () => {
    expect(fire('Edit', { file_path: '/Users/x/proj/src/store.ts' })?.message)
      .toBe('Editing store.ts');
    expect(fire('Write', { file_path: '/Users/x/proj/public/landing.html' })?.message)
      .toBe('Writing landing.html');
    expect(fire('NotebookEdit', { notebook_path: '/Users/x/analysis.ipynb' })?.message)
      .toBe('Editing analysis.ipynb');
  });

  it('falls back to the tool name when an edit carries no path', () => {
    expect(fire('Edit', {})?.message).toBe('Edit');
    expect(fire('apply_patch', {})?.message).toBe('Editing files');
  });

  it('describes research tools by what they are looking for', () => {
    expect(fire('Task', { description: 'Audit the iOS project' })?.message)
      .toBe('Audit the iOS project');
    expect(fire('WebSearch', { query: 'APNs BadDeviceToken' })?.message)
      .toBe('Searching: APNs BadDeviceToken');
    expect(fire('WebFetch', { url: 'https://developer.apple.com/documentation/x' })?.message)
      .toBe('Reading developer.apple.com');
    expect(fire('Task', {})?.message).toBe('Delegating a subtask');
    expect(fire('WebFetch', { url: 'not a url' })?.message).toBe('Fetching a page');
  });

  it('sends tool names only in minimal mode, leaking no detail', () => {
    const detail = { AGSTATUS_DETAIL: 'off' };
    expect(fire('Bash', { command: 'deploy prod', description: 'Deploy to production' }, detail)?.message)
      .toBe('Bash');
    expect(fire('Edit', { file_path: '/secret/payroll.ts' }, detail)?.message).toBe('Edit');
    expect(fire('WebSearch', { query: 'confidential thing' }, detail)?.message).toBe('WebSearch');
    expect(fire('Task', { description: 'Secret task' }, detail)?.message).toBe('Task');
  });

  it('truncates long messages', () => {
    const posted = fire('Bash', { description: 'x'.repeat(400), command: 'true' });
    expect(posted!.message.length).toBeLessThanOrEqual(120);
  });

  it('falls back to ~/.agstatus.json when CLAUDE_STATUS_URL is unset (plugin mode)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-home-'));
    fs.writeFileSync(path.join(home, '.agstatus.json'), JSON.stringify({ url: base }));
    const posted = fireEvent({ hook_event_name: 'Stop' }, { CLAUDE_STATUS_URL: '', HOME: home });
    expect(posted?.status).toBe('done');
    expect(posted?.message).toBe('Turn finished');
  });

  it('flips to planning the moment the user submits a prompt', () => {
    const posted = fireEvent({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Fix the login bug\nin the session store',
    });
    expect(posted?.status).toBe('planning');
    expect(posted?.message).toBe('Fix the login bug in the session store');
  });

  it('sends a generic prompt label in minimal mode, and truncates long prompts', () => {
    const minimal = fireEvent(
      { hook_event_name: 'UserPromptSubmit', prompt: 'secret plans' },
      { AGSTATUS_DETAIL: 'off' },
    );
    expect(minimal?.message).toBe('Processing prompt');

    const long = fireEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'y'.repeat(400) });
    expect(long?.status).toBe('planning');
    expect(long!.message.length).toBeLessThanOrEqual(120);

    const empty = fireEvent({ hook_event_name: 'UserPromptSubmit' });
    expect(empty?.message).toBe('Processing prompt');
  });
});

/**
 * Per-SESSION token totals: what THIS session has spent, gathered on the same
 * pass over the same local logs that feeds the per-project totals and posted
 * to /usage/sessions.
 *
 * The fixtures are the shape both agents really write. A Claude transcript
 * record carries its session id beside the usage block and its own cwd, so a
 * session that moves folders splits across projects — these tests pin that it
 * does NOT split across sessions. A Codex rollout is named by its session id
 * and carries a cumulative total, so its id comes from the filename.
 *
 * Each test gets a fresh HOME/CODEX_HOME (the logs) and TMPDIR (the scan
 * state), so runs inside one test share state and runs across tests never do.
 */
interface SessionRow { session_id: string; tokens: number }

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

const claudeUsageLine = (cwd: string, timestamp: string, sessionId: string, output: number) =>
  JSON.stringify({
    type: 'assistant', timestamp, cwd, sessionId,
    message: {
      usage: {
        input_tokens: 0, output_tokens: output,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 900_000,
      },
    },
  });

const codexMeta = (cwd: string, timestamp: string) =>
  JSON.stringify({ timestamp, type: 'session_meta', payload: { cwd, id: 'x' } });

const codexTokens = (timestamp: string, cumulative: number) =>
  JSON.stringify({
    timestamp, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: cumulative } } },
  });

describe('per-session token totals', () => {
  let home: string;
  let tmp: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-sess-home-'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-sess-tmp-'));
  });

  function writeClaude(lines: string[], session = 's'): string {
    const dir = path.join(home, '.claude', 'projects', '-Users-x-demo', session);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${session}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  function writeCodex(id: string, lines: string[]): string {
    const dir = path.join(home, 'sessions', '2026', '09', '07');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-07T10-00-00-${id}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  /** Runs the hook over the fixture logs and returns the session rows it sent. */
  function scan(source: 'claude' | 'codex', extraEnv: Record<string, string> = {}): SessionRow[] {
    fs.writeFileSync(capturePath, '');
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'hook-session', cwd: '/tmp/demo' }),
      env: {
        ...process.env,
        CLAUDE_STATUS_URL: base, TMPDIR: tmp, AGSTATUS_STATE_DIR: tmp,
        ...(source === 'codex' ? { AGSTATUS_SOURCE: 'codex', CODEX_HOME: home } : { HOME: home }),
        ...extraEnv,
      },
      timeout: 20_000,
    });
    return sessionPosts().flatMap((p) => p.sessions);
  }

  const sessionPosts = (): Array<{ source: string; sessions: SessionRow[] }> =>
    captured().filter((p) => p.url === '/usage/sessions')
      .map((p) => JSON.parse(p.body) as { source: string; sessions: SessionRow[] });

  const byId = (rows: SessionRow[]) =>
    Object.fromEntries(rows.map((r) => [r.session_id, r.tokens]));

  it('keeps a Claude session whole even when it moves between folders', () => {
    // The per-PROJECT view splits this session across two folders, because
    // Claude stamps every record with its own cwd. The session's own number
    // must not split with it — the id does not change when the folder does.
    writeClaude([
      claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', S1, 100),
      claudeUsageLine('/Users/x/other', '2026-09-07T11:00:00.000Z', S1, 50),
      claudeUsageLine('/Users/x/demo', '2026-09-07T12:00:00.000Z', S2, 7),
    ]);
    expect(byId(scan('claude'))).toEqual({ [S1]: 150, [S2]: 7 });
    expect(sessionPosts()[0].source).toBe('claude');
  });

  it('sends the absolute total on a later run, and nothing when nothing moved', () => {
    const file = writeClaude([claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', S1, 100)]);
    expect(byId(scan('claude'))).toEqual({ [S1]: 100 });

    // Nothing appended: the throttle has not elapsed and there is nothing new.
    expect(scan('claude')).toEqual([]);

    fs.appendFileSync(file, claudeUsageLine('/Users/x/demo', '2026-09-07T11:00:00.000Z', S1, 75) + '\n');
    // The offsets are what stop the first 100 being counted twice; the row is
    // the session's total so far, not the 75 that just arrived.
    expect(byId(scan('claude', { AGSTATUS_PROJECT_FORCE: '1' }))).toEqual({ [S1]: 175 });
  });

  it('counts only what a plan is charged for, ignoring cache reads', () => {
    // 900k cache-read tokens sit in every fixture record above; a session that
    // spent 12 tokens must read as 12.
    writeClaude([claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', S1, 12)]);
    expect(byId(scan('claude'))).toEqual({ [S1]: 12 });
  });

  it('takes a Codex session id from the rollout filename', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    writeCodex(id, [
      codexMeta('/Users/x/gamma', '2026-09-07T09:00:00.000Z'),
      codexTokens('2026-09-07T09:01:00.000Z', 1000),
      codexTokens('2026-09-07T09:02:00.000Z', 2500),
      codexTokens('2026-09-07T09:03:00.000Z', 2500), // a repeat adds nothing
    ]);
    expect(byId(scan('codex'))).toEqual({ [id]: 2500 });
  });

  it('never puts an id on the wire that is not one an agent would write', () => {
    // Only a number and an id may leave the machine, and the id has to be one:
    // an unbounded string out of a log is neither safe nor within the chunk
    // arithmetic the 16kb body cap depends on.
    writeClaude([
      claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', 'a'.repeat(200), 9),
      claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', '../../etc/passwd', 9),
      claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', 'ok-1', 9),
    ]);
    expect(byId(scan('claude'))).toEqual({ 'ok-1': 9 });
  });

  it('splits a large report into bodies the server will accept', () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      lines.push(claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z',
        `${String(i).padStart(8, '0')}-4444-4444-8444-444444444444`, 1));
    }
    writeClaude(lines);
    expect(scan('claude')).toHaveLength(250);
    const posts = sessionPosts();
    expect(posts.map((p) => p.sessions.length)).toEqual([100, 100, 50]);
    for (const p of posts) expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(16 * 1024);
  });

  it('survives a corrupt scan state instead of reporting nonsense', () => {
    writeClaude([claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', S1, 100)]);
    expect(byId(scan('claude'))).toEqual({ [S1]: 100 });
    for (const name of fs.readdirSync(tmp).filter((n) => n.startsWith('agstatus-projects-'))) {
      fs.writeFileSync(path.join(tmp, name), `{"sessions":{"${S1}":{"tokens":"nope"}},"days":`);
    }
    // Unreadable state means unknown offsets, so the log is read from the top
    // and the total is rebuilt — never resumed from a value that is not one.
    expect(byId(scan('claude', { AGSTATUS_PROJECT_FORCE: '1' }))).toEqual({ [S1]: 100 });
  });

  it('reports nothing at all with AGSTATUS_USAGE=off', () => {
    writeClaude([claudeUsageLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', S1, 100)]);
    expect(scan('claude', { AGSTATUS_USAGE: 'off' })).toEqual([]);
  });
});
