import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Drives the REAL hook script as a Codex run and asserts the plan usage it
 * reports. Codex has no usage API: it writes a `rate_limits` block into its
 * own session rollout log, which the hook reads locally. Fixtures here mirror
 * blocks captured from live Codex rollout files.
 *
 * The capture server runs as a SIBLING child process, not inside the vitest
 * worker (same sandbox reason as messages.test.ts).
 */

const HOOK = path.resolve(__dirname, '..', 'assets', 'agstatus-hook.js');

interface Window { id: string; label: string; usedPct: number; resetsAt: number | null }
interface UsagePost { source: string; windows: Window[] }

let server: ChildProcess;
let base: string;
let capturePath: string;
let home: string;

/**
 * One `token_count` rollout line carrying a rate_limits block. The timestamp
 * defaults to now: the hook rejects blocks older than its staleness bound, so
 * a hardcoded date would make every fixture unreportable.
 */
const tokenCountLine = (rateLimits: unknown, ordinal = 1, timestamp = new Date().toISOString()) =>
  JSON.stringify({
    timestamp,
    ordinal,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } }, rate_limits: rateLimits },
  });

const agoISO = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

/** Writes a rollout log for `sessionId` under a fake CODEX_HOME. */
function writeRollout(sessionId: string, lines: string[], day = '2026/09/06', stamp = '2026-09-06T00-47-05') {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

beforeAll(async () => {
  capturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-cx-')), 'posted.jsonl');
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

afterAll(() => { server?.kill(); });

beforeEach(() => {
  fs.writeFileSync(capturePath, '');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-codexhome-'));
});

/**
 * Fires the hook as Codex and returns what it POSTed to /usage, if anything.
 * A fresh TMPDIR per call keeps the 5-minute throttle from hiding a report.
 */
function fireCodex(
  sessionId: string,
  extraEnv: Record<string, string> = {},
  payload: Record<string, unknown> = { hook_event_name: 'Stop' },
): UsagePost | undefined {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-tmp-'));
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: sessionId, cwd: '/tmp/demo-project', ...payload }),
    env: { ...process.env, CLAUDE_STATUS_URL: base, AGSTATUS_SOURCE: 'codex', CODEX_HOME: home, TMPDIR: tmp, AGSTATUS_STATE_DIR: tmp, ...extraEnv },
    timeout: 8000,
  });
  const deadline = Date.now() + 3000;
  for (;;) {
    const lines = fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean);
    const posts = lines.map((l) => JSON.parse(l) as { url: string; body: string });
    // The status webhook and the usage report are awaited together; once the
    // webhook has landed, a missing /usage means the hook chose not to send.
    if (posts.some((p) => p.url === '/webhook')) {
      const usage = posts.find((p) => p.url === '/usage');
      return usage ? (JSON.parse(usage.body) as UsagePost) : undefined;
    }
    if (Date.now() > deadline) return undefined;
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
  }
}

const soon = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;
const WEEKLY_RESET = soon(3 * 24 * 3600);
const FIVE_HOUR_RESET = soon(2 * 3600);
const WEEKLY = { used_percent: 9, window_minutes: 10080, resets_at: WEEKLY_RESET };
const FIVE_HOUR = { used_percent: 42.5, window_minutes: 300, resets_at: FIVE_HOUR_RESET };

describe('Codex plan usage', () => {
  it('reports the primary window from the session rollout log', () => {
    writeRollout('sess-a', [tokenCountLine({ limit_id: 'codex', primary: WEEKLY, secondary: null })]);
    const usage = fireCodex('sess-a');
    expect(usage?.source).toBe('codex');
    expect(usage?.windows).toEqual([
      { id: 'week', label: 'Weekly (all models)', usedPct: 9, resetsAt: WEEKLY_RESET * 1000 },
    ]);
  });

  it('reports both windows and names them by duration', () => {
    writeRollout('sess-b', [tokenCountLine({ primary: FIVE_HOUR, secondary: WEEKLY })]);
    const usage = fireCodex('sess-b');
    expect(usage?.windows).toEqual([
      { id: 'session', label: 'Current session', usedPct: 42.5, resetsAt: FIVE_HOUR_RESET * 1000 },
      { id: 'week', label: 'Weekly (all models)', usedPct: 9, resetsAt: WEEKLY_RESET * 1000 },
    ]);
  });

  it('disambiguates two windows of the same length', () => {
    writeRollout('sess-c', [tokenCountLine({ primary: WEEKLY, secondary: { ...WEEKLY, used_percent: 3 } })]);
    const usage = fireCodex('sess-c');
    expect(usage?.windows.map((w) => w.label)).toEqual([
      'Weekly (all models)', 'Weekly (all models) (secondary)',
    ]);
    expect(usage?.windows.map((w) => w.id)).toEqual(['week', 'week_2']);
  });

  it('uses the LAST rate_limits block in the log', () => {
    writeRollout('sess-d', [
      tokenCountLine({ primary: { ...WEEKLY, used_percent: 1 } }, 1),
      tokenCountLine({ primary: { ...WEEKLY, used_percent: 77 } }, 2),
    ]);
    expect(fireCodex('sess-d')?.windows[0].usedPct).toBe(77);
  });

  it('clamps out-of-range percentages', () => {
    writeRollout('sess-e', [tokenCountLine({ primary: { ...WEEKLY, used_percent: 140 } })]);
    expect(fireCodex('sess-e')?.windows[0].usedPct).toBe(100);
  });

  it('accepts resets_in_seconds when resets_at is absent', () => {
    writeRollout('sess-f', [
      tokenCountLine({ primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 3600 } }),
    ]);
    const at = fireCodex('sess-f')?.windows[0].resetsAt;
    expect(at).toBeGreaterThan(Date.now() + 3400_000);
    expect(at).toBeLessThan(Date.now() + 3700_000);
  });

  it('anchors resets_in_seconds to when the block was written, not to now', () => {
    // A countdown Codex wrote 2h ago has 2h less left than it claims. Anchoring
    // to now would restate the same stale countdown as fresh on every report.
    writeRollout('sess-anchor', [
      tokenCountLine(
        { primary: { used_percent: 5, window_minutes: 600, resets_in_seconds: 3 * 3600 } },
        1,
        agoISO(2 * HOUR),
      ),
    ]);
    const at = fireCodex('sess-anchor')?.windows[0].resetsAt;
    // Written 2h ago with 3h to run => ~1h from now, not ~3h.
    expect(at).toBeGreaterThan(Date.now() + 0.8 * HOUR);
    expect(at).toBeLessThan(Date.now() + 1.2 * HOUR);
  });

  it('reports no reset time for a window that already reset', () => {
    writeRollout('sess-past', [
      tokenCountLine({ primary: { used_percent: 12, window_minutes: 300, resets_at: soon(-3600) } }),
    ]);
    const w = fireCodex('sess-past')?.windows[0];
    expect(w?.usedPct).toBe(12); // the percentage is still worth showing
    expect(w?.resetsAt).toBeNull();
  });

  it('skips a rate_limits block older than the staleness bound', () => {
    // Stale percentages would evict fresh ones from the board for a full day.
    writeRollout('sess-stale', [tokenCountLine({ primary: WEEKLY }, 1, agoISO(20 * HOUR))]);
    expect(fireCodex('sess-stale')).toBeUndefined();
  });

  it('still reports a block that is old but within the bound', () => {
    writeRollout('sess-recent', [tokenCountLine({ primary: WEEKLY }, 1, agoISO(2 * HOUR))]);
    expect(fireCodex('sess-recent')?.windows[0].usedPct).toBe(9);
  });

  it('falls back to the newest log when the session id is unknown', () => {
    writeRollout('older', [tokenCountLine({ primary: { ...WEEKLY, used_percent: 11 } })], '2026/09/05', '2026-09-05T01-00-00');
    writeRollout('newer', [tokenCountLine({ primary: { ...WEEKLY, used_percent: 22 } })], '2026/09/06', '2026-09-06T01-00-00');
    // Account-wide limits: a sibling log carries the same numbers.
    expect(fireCodex('not-a-known-session')?.windows[0].usedPct).toBe(22);
  });

  it("falls back to a sibling when the session's own log has no limits yet", () => {
    // Codex writes its first rate_limits only when a turn completes, so at
    // SessionStart the session's own log exists but carries none.
    writeRollout('sess-sibling', [JSON.stringify({ type: 'session_meta', payload: { id: 'sess-sibling' } })]);
    writeRollout('older-sib', [tokenCountLine({ primary: { ...WEEKLY, used_percent: 41 } })],
      '2026/09/06', '2026-09-06T09-00-00');
    expect(fireCodex('sess-sibling')?.windows[0].usedPct).toBe(41);
  });

  it('does not burn the throttle slot when it has nothing to report', () => {
    // Otherwise every Codex session loses its first bars to the 5-minute window.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-thr-'));
    const file = writeRollout('sess-thr', [JSON.stringify({ type: 'session_meta' })]);
    const fire = () => {
      fs.writeFileSync(capturePath, '');
      execFileSync(process.execPath, [HOOK], {
        input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-thr', cwd: '/tmp/p' }),
        env: { ...process.env, CLAUDE_STATUS_URL: base, AGSTATUS_SOURCE: 'codex', CODEX_HOME: home, TMPDIR: tmp, AGSTATUS_STATE_DIR: tmp },
        timeout: 8000,
      });
      const posts = fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as { url: string; body: string });
      return posts.find((p) => p.url === '/usage');
    };
    expect(fire()).toBeUndefined();                    // nothing to report yet
    fs.appendFileSync(file, tokenCountLine({ primary: WEEKLY }) + '\n');
    expect(fire()).toBeDefined();                      // must not be throttled out
  });

  it('reads the tail of a log far larger than the read window', () => {
    const filler = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', text: 'x'.repeat(4000) } });
    writeRollout('sess-big', [
      ...Array.from({ length: 400 }, () => filler),
      tokenCountLine({ primary: { ...WEEKLY, used_percent: 64 } }),
    ]);
    expect(fireCodex('sess-big')?.windows[0].usedPct).toBe(64);
  });

  it('sends nothing when the log has no rate_limits, and never crashes', () => {
    writeRollout('sess-none', [JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })]);
    expect(fireCodex('sess-none')).toBeUndefined();
  });

  it('sends nothing when there is no rollout log at all', () => {
    expect(fireCodex('sess-missing')).toBeUndefined();
  });

  it('survives a truncated / malformed log line', () => {
    writeRollout('sess-bad', ['{"payload":{"rate_limits":{"primary"', tokenCountLine({ primary: WEEKLY })]);
    expect(fireCodex('sess-bad')?.windows[0].usedPct).toBe(9);
  });

  it('reports one bar per window across every limit bucket', () => {
    // Codex keys limits by limit_id: a general allowance plus one per model.
    writeRollout('sess-buckets', [
      tokenCountLine({
        limit_id: 'codex', limit_name: null,
        primary: { used_percent: 52, window_minutes: 10080, resets_at: soon(5 * 86400) },
        secondary: null,
      }),
      tokenCountLine({
        limit_id: 'codex_astra', limit_name: 'GPT-6-Astra',
        primary: { used_percent: 18, window_minutes: 300, resets_at: soon(2 * 3600) },
        secondary: { used_percent: 32, window_minutes: 10080, resets_at: soon(4 * 86400) },
      }, 2),
    ]);
    const usage = fireCodex('sess-buckets');
    expect(usage?.windows.map((w) => [w.id, w.label, w.usedPct])).toEqual([
      ['week', 'Weekly (all models)', 52],
      ['session_gpt_6_astra', 'Session (GPT-6-Astra)', 18],
      ['week_gpt_6_astra', 'Weekly (GPT-6-Astra)', 32],
    ]);
  });

  it('keeps only the newest block of each bucket', () => {
    writeRollout('sess-newest', [
      tokenCountLine({ limit_id: 'codex', primary: { ...WEEKLY, used_percent: 10 } }, 1),
      tokenCountLine({ limit_id: 'codex_astra', limit_name: 'GPT-6-Astra',
                       primary: { used_percent: 5, window_minutes: 300, resets_at: FIVE_HOUR_RESET } }, 2),
      tokenCountLine({ limit_id: 'codex', primary: { ...WEEKLY, used_percent: 61 } }, 3),
    ]);
    const usage = fireCodex('sess-newest');
    expect(usage?.windows.find((w) => w.id === 'week')?.usedPct).toBe(61);
    expect(usage?.windows.find((w) => w.id === 'session_gpt_6_astra')?.usedPct).toBe(5);
  });

  it('keeps two unnamed buckets apart by their limit id', () => {
    // Codex ships at least one unnamed non-default bucket ("premium"). Deriving
    // its id from the name alone would collide with the default bucket's
    // `week`, and the duplicate guard would drop whichever came second.
    writeRollout('sess-unnamed', [
      tokenCountLine({ limit_id: 'codex', limit_name: null, primary: { ...WEEKLY, used_percent: 71 } }),
      tokenCountLine({ limit_id: 'premium', limit_name: null, primary: { ...WEEKLY, used_percent: 12 } }, 2),
    ]);
    const usage = fireCodex('sess-unnamed');
    expect(usage?.windows.map((w) => [w.id, w.label, w.usedPct])).toEqual([
      ['week', 'Weekly (all models)', 71],
      ['week_premium', 'Weekly (premium)', 12],
    ]);
  });

  it('reports on PreToolUse too, which is most of what Codex fires', () => {
    // Claude skips PreToolUse because its report is a network call; Codex reads
    // a local file, and skipping would leave its bars minutes stale.
    writeRollout('sess-pre', [tokenCountLine({ primary: WEEKLY })]);
    const usage = fireCodex('sess-pre', {}, {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
    });
    expect(usage?.windows[0].usedPct).toBe(9);
  });

  it('honours AGSTATUS_USAGE=off', () => {
    writeRollout('sess-off', [tokenCountLine({ primary: WEEKLY })]);
    expect(fireCodex('sess-off', { AGSTATUS_USAGE: 'off' })).toBeUndefined();
  });

  it('never reads Claude credentials for a Codex run', () => {
    // A HOME with a planted credentials file: a Codex run must ignore it and
    // still report from the rollout log instead.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-fakehome-'));
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'must-not-be-used', expiresAt: Date.now() + 3600_000 } }),
    );
    writeRollout('sess-creds', [tokenCountLine({ primary: WEEKLY })]);
    const usage = fireCodex('sess-creds', { HOME: fakeHome });
    expect(usage?.source).toBe('codex');
    expect(usage?.windows[0].usedPct).toBe(9);
  });

  it('does not share a throttle slot with Claude on the same board', () => {
    // Both agents point at one board; the second must not be starved by the
    // first having claimed the 5-minute slot.
    writeRollout('sess-share', [tokenCountLine({ primary: WEEKLY })]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-shared-'));
    const fire = (source: string) => {
      fs.writeFileSync(capturePath, '');
      execFileSync(process.execPath, [HOOK], {
        input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-share', cwd: '/tmp/p' }),
        // AGSTATUS_USAGE stays on, but Claude has no credentials under this
        // HOME, so only the throttle file it writes matters here.
        env: { ...process.env, CLAUDE_STATUS_URL: base, AGSTATUS_SOURCE: source, CODEX_HOME: home, TMPDIR: tmp, AGSTATUS_STATE_DIR: tmp,
               HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-nh-')) },
        timeout: 8000,
      });
      return fs.readdirSync(tmp).filter((f) => f.startsWith('agstatus-usage-'));
    };
    fire('claude');
    const afterBoth = fire('codex');
    expect(afterBoth).toHaveLength(2); // one throttle slot per source, not one per board
  });
});
