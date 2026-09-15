import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Drives the REAL hook against synthetic agent logs and asserts the per-project
 * token totals it reports. Neither agent exposes per-project limit data, so the
 * hook derives spend from the logs each one already writes locally.
 */

const HOOK = path.resolve(__dirname, '..', 'assets', 'agstatus-hook.js');

interface Row { project: string; day: string; tokens: number }
interface Post { source: string; days: Row[] }

let server: ChildProcess;
let base: string;
let capturePath: string;
let home: string;   // fake HOME (Claude) and CODEX_HOME (Codex)
let tmp: string;    // fake TMPDIR, so state persists across runs within a test

const claudeLine = (
  cwd: string, timestamp: string,
  u: { input?: number; output?: number; cacheCreate?: number; cacheRead?: number },
) => JSON.stringify({
  type: 'assistant', timestamp, cwd,
  message: {
    usage: {
      input_tokens: u.input ?? 0,
      output_tokens: u.output ?? 0,
      cache_creation_input_tokens: u.cacheCreate ?? 0,
      cache_read_input_tokens: u.cacheRead ?? 0,
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

function writeClaude(session: string, lines: string[], project = 'demo') {
  const dir = path.join(home, '.claude', 'projects', `-Users-x-${project}`, session);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function writeCodex(name: string, lines: string[], day = '2026/09/07') {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-07T10-00-00-${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

beforeAll(async () => {
  capturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-pj-')), 'posted.jsonl');
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
    server.stdout!.on('data', (c: Buffer) => {
      const m = /PORT (\d+)/.exec(c.toString());
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => { server?.kill(); });

beforeEach(() => {
  fs.writeFileSync(capturePath, '');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-home-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-tmp-'));
});

/** Runs the hook and returns every /usage/projects row it posted. */
function run(source: 'claude' | 'codex', extraEnv: Record<string, string> = {}, args: string[] = []): Row[] {
  fs.writeFileSync(capturePath, '');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CLAUDE_STATUS_URL: base, TMPDIR: tmp,
    // Keep the Focus record out of the developer's own state directory.
    AGSTATUS_STATE_DIR: tmp,
    ...(source === 'codex' ? { AGSTATUS_SOURCE: 'codex', CODEX_HOME: home } : { HOME: home }),
    ...extraEnv,
  };
  execFileSync(process.execPath, [HOOK, ...args], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: '/tmp/p' }),
    env, timeout: 20_000,
  });
  const lines = fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean);
  const posts = lines
    .map((l) => JSON.parse(l) as { url: string; body: string })
    .filter((p) => p.url === '/usage/projects')
    .map((p) => JSON.parse(p.body) as Post);
  return posts.flatMap((p) => p.days);
}

const byKey = (rows: Row[]) =>
  Object.fromEntries(rows.map((r) => [`${r.project}/${r.day}`, r.tokens]));

describe('Claude per-project token spend', () => {
  it('sums input, output and cache creation but not cache reads', () => {
    // Cache reads are ~94% of raw volume and a small share of what a plan
    // limit charges; counting them ranks by context size, not by spend.
    writeClaude('s1', [
      claudeLine('/Users/x/demo', '2026-09-07T10:00:00.000Z',
        { input: 100, output: 50, cacheCreate: 200, cacheRead: 900_000 }),
    ]);
    expect(byKey(run('claude'))).toEqual({ 'demo/2026-09-07': 350 });
  });

  it('buckets by UTC day and by the record\'s own cwd', () => {
    writeClaude('s1', [
      claudeLine('/Users/x/alpha', '2026-09-06T23:30:00.000Z', { output: 10 }),
      claudeLine('/Users/x/alpha', '2026-09-07T00:30:00.000Z', { output: 20 }),
      claudeLine('/Users/x/beta', '2026-09-07T01:00:00.000Z', { output: 30 }),
    ]);
    expect(byKey(run('claude'))).toEqual({
      'alpha/2026-09-06': 10, 'alpha/2026-09-07': 20, 'beta/2026-09-07': 30,
    });
  });

  it('reports only what is new on a second run, and keeps the running total', () => {
    const file = writeClaude('s1', [claudeLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', { output: 10 })]);
    expect(byKey(run('claude'))).toEqual({ 'demo/2026-09-07': 10 });

    // Nothing appended and the throttle is still warm: no second report.
    expect(run('claude')).toEqual([]);

    fs.appendFileSync(file, claudeLine('/Users/x/demo', '2026-09-07T11:00:00.000Z', { output: 5 }) + '\n');
    // AGSTATUS_PROJECT_FORCE bypasses only the throttle, not the offsets.
    const second = byKey(run('claude', { AGSTATUS_PROJECT_FORCE: '1' }));
    expect(second).toEqual({ 'demo/2026-09-07': 15 }); // absolute, not a delta
  });

  it('does not count a transcript twice through a symlinked directory', () => {
    // Claude Code links a shared subagent workflow into every session that
    // used it; following those links inflates the project's total.
    writeClaude('real', [claudeLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', { output: 100 })]);
    const linkDir = path.join(home, '.claude', 'projects', '-Users-x-demo', 'other');
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(path.join(home, '.claude', 'projects', '-Users-x-demo', 'real'),
                   path.join(linkDir, 'linked'), 'dir');
    expect(byKey(run('claude'))).toEqual({ 'demo/2026-09-07': 100 });
  });

  it('ignores records with no usable usage or timestamp', () => {
    writeClaude('s1', [
      JSON.stringify({ type: 'user', timestamp: '2026-09-07T10:00:00.000Z' }),
      '{ not json',
      JSON.stringify({ type: 'assistant', cwd: '/Users/x/demo', message: { usage: { output_tokens: 5 } } }),
      claudeLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', { output: 7 }),
    ]);
    expect(byKey(run('claude'))).toEqual({ 'demo/2026-09-07': 7 });
  });
});

describe('Codex per-project token spend', () => {
  it('turns the running total into per-day spend', () => {
    writeCodex('a', [
      codexMeta('/Users/x/gamma', '2026-09-07T09:00:00.000Z'),
      codexTokens('2026-09-07T09:01:00.000Z', 1000),
      codexTokens('2026-09-07T09:02:00.000Z', 2500),
      codexTokens('2026-09-07T09:03:00.000Z', 2500), // repeat adds nothing
    ]);
    expect(byKey(run('codex'))).toEqual({ 'gamma/2026-09-07': 2500 });
  });

  it('takes the project from the session metadata', () => {
    writeCodex('a', [
      codexMeta('/Users/x/one', '2026-09-07T09:00:00.000Z'),
      codexTokens('2026-09-07T09:01:00.000Z', 42),
    ]);
    writeCodex('b', [
      codexMeta('/Users/x/two', '2026-09-07T09:00:00.000Z'),
      codexTokens('2026-09-07T09:01:00.000Z', 58),
    ]);
    expect(byKey(run('codex'))).toEqual({ 'one/2026-09-07': 42, 'two/2026-09-07': 58 });
  });

  it('restarts rather than going negative if the total resets', () => {
    writeCodex('a', [
      codexMeta('/Users/x/gamma', '2026-09-07T09:00:00.000Z'),
      codexTokens('2026-09-07T09:01:00.000Z', 5000),
      codexTokens('2026-09-07T09:02:00.000Z', 300),
    ]);
    expect(byKey(run('codex'))).toEqual({ 'gamma/2026-09-07': 5300 });
  });
});

describe('reporting rules', () => {
  it('sends nothing when AGSTATUS_USAGE=off', () => {
    writeClaude('s1', [claudeLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', { output: 10 })]);
    expect(run('claude', { AGSTATUS_USAGE: 'off' })).toEqual([]);
  });

  it('splits a large report into chunks the server will accept', () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      lines.push(claudeLine(`/Users/x/p${i}`, '2026-09-07T10:00:00.000Z', { output: 1 }));
    }
    writeClaude('s1', lines);
    const rows = run('claude');
    expect(rows).toHaveLength(250);
    const posts = fs.readFileSync(capturePath, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { url: string; body: string })
      .filter((p) => p.url === '/usage/projects');
    expect(posts).toHaveLength(2); // 200 + 50, each inside the 16kb body limit
    expect(JSON.parse(posts[0].body).days).toHaveLength(200);
  });

  it('--backfill rescans everything from the start', () => {
    writeClaude('s1', [claudeLine('/Users/x/demo', '2026-09-07T10:00:00.000Z', { output: 10 })]);
    expect(byKey(run('claude'))).toEqual({ 'demo/2026-09-07': 10 });
    // Offsets say there is nothing new, but a backfill ignores them.
    expect(byKey(run('claude', {}, ['--backfill']))).toEqual({ 'demo/2026-09-07': 10 });
  });
});
