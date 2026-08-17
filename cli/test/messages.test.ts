import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

beforeAll(async () => {
  capturePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-msg-')),
    'posted.jsonl',
  );
  fs.writeFileSync(capturePath, '');

  const script = `
    const http = require('http'), fs = require('fs');
    const out = process.argv[1];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        if (req.url === '/webhook') fs.appendFileSync(out, b + '\\n');
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
    env: { ...process.env, CLAUDE_STATUS_URL: base, AGSTATUS_USAGE: 'off', ...extraEnv },
    timeout: 8000,
  });
  // The hook awaits its POST before exiting, but the server still has to write.
  const deadline = Date.now() + 3000;
  for (;;) {
    const lines = fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > 0) return JSON.parse(lines[0]) as Posted;
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
