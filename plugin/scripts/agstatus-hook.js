#!/usr/bin/env node
/**
 * AgStatus hook for Claude Code and OpenAI Codex (dependency-free, node >= 18).
 *
 * Posts session status to an AgStatus dashboard. Both tools deliver the hook
 * payload as JSON on stdin with the same core fields (hook_event_name,
 * session_id, cwd). Wired to SessionStart, PreToolUse, Stop, and
 * UserPromptSubmit + Notification + SessionEnd (Claude Code) /
 * PermissionRequest (Codex).
 *
 * IMPORTANT: this script must never write to stdout — Codex interprets hook
 * stdout as behavior-control JSON, and a stray print could block a tool call.
 *
 * Env:
 *   CLAUDE_STATUS_URL     (board URL; falls back to "url" in ~/.agstatus.json —
 *                          written by the Claude Code plugin's /agstatus:setup —
 *                          and exits silently when neither is set)
 *   CLAUDE_STATUS_SECRET  (optional; sent as x-webhook-secret, legacy servers;
 *                          falls back to "secret" in ~/.agstatus.json)
 *   AGSTATUS_DETAIL=off   (optional; send tool names instead of command text)
 *   AGSTATUS_USAGE=off    (optional; never report plan-usage percentages, and
 *                          never scan local logs for per-project token spend)
 *   AGSTATUS_PROJECT_FORCE=1 (optional; skip the per-project scan's throttle)
 *   AGSTATUS_SOURCE       (optional; agent kind tag, defaults to "claude" —
 *                          the Codex integration sets "codex")
 *
 * Besides session status, the hook reports plan usage so the dashboard can
 * show limit bars, from whichever source the running agent has:
 *   - Claude: reads the Claude Code OAuth token locally and asks Anthropic's
 *     usage endpoint for utilization percentages. Only those percentages and
 *     reset times ever reach the AgStatus server — never the token itself.
 *   - Codex: reads the rate_limits block Codex already writes into its own
 *     session rollout log. Entirely local — no credentials, no network call.
 * Throttled to one attempt per 5 minutes per (board, source), and only on
 * quiet events (never PreToolUse).
 *
 * Never blocks Claude Code: always exits 0, prints nothing, hard 3s HTTP
 * timeout, and an overall ~4s safety timeout.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HTTP_TIMEOUT_MS = 3000;
const SAFETY_TIMEOUT_MS = 4000;
const USAGE_THROTTLE_MS = 5 * 60 * 1000;
const USAGE_FETCH_TIMEOUT_MS = 2500;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Rollout logs reach megabytes; the newest rate_limits is near the end. Sized
// well past the largest gap seen between two rate_limits records (~257KB), so
// one big tool output written after the last one can't push it out of range.
const CODEX_ROLLOUT_TAIL_BYTES = 1024 * 1024;
// Logs to try before giving up: the session's own, then recent siblings.
const CODEX_ROLLOUT_CANDIDATES = 3;
// The server accepts at most this many windows in one usage report.
const MAX_USAGE_WINDOWS = 6;
// Percentages older than this are worse than no bars — they would evict fresh
// numbers from the board for a full server-side TTL.
const CODEX_USAGE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Per-project token totals move slowly and cost a log scan, so they run on
// their own, slower clock than the limit bars.
const PROJECT_THROTTLE_MS = 15 * 60 * 1000;
// The server caps one report at 200 rows to stay inside its 16kb body limit.
const MAX_PROJECT_DAYS_PER_POST = 200;
// Matches the server's retention: older days are neither scanned nor kept.
const PROJECT_HISTORY_DAYS = 90;
// A log untouched for this long has nothing new to contribute.
const PROJECT_FILE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Bytes one hook run may parse. Transcripts run to hundreds of megabytes, so a
// first run reads a slice and the consumed offsets let later runs resume; the
// steady state is only what an agent appended since the last run. `--backfill`
// ignores this and reads everything.
const PROJECT_SCAN_BYTE_BUDGET = 8 * 1024 * 1024;

// Which agent this hook invocation serves. Claude Code installs leave it
// unset (→ "claude"); the Codex hooks.json command embeds AGSTATUS_SOURCE=codex.
// Dashboards use it to show only the limit bars of agents actually running.
const SOURCE = /^[a-z][a-z0-9_-]{0,23}$/.test(process.env.AGSTATUS_SOURCE || '')
  ? process.env.AGSTATUS_SOURCE
  : 'claude';
// Only Bash command text is truncated client-side (matching the bash hook);
// the server caps every message at 300.
const COMMAND_MAX = 120;

// Word-ish matches for common test runners (intent of the bash hook's regex,
// minus the platform-dependent \< \> tokens).
const TEST_RE =
  /\b(pytest|jest|vitest|mocha|rspec|phpunit|(?:go|cargo)\s+test|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test)\b/;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/** Trimmed string, or '' for anything else. */
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');

/**
 * ~/.agstatus.json — the env-less configuration path, used when the hook is
 * shipped by the Claude Code plugin (plugins cannot set env vars). Env vars
 * always win. Missing or malformed file just means "not configured".
 */
const FILE_CONFIG = (() => {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.agstatus.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  } catch {
    return {};
  }
})();

/** Bash commands may arrive as a string (Claude Code) or argv (Codex). */
function commandText(input) {
  const raw = input.command;
  if (Array.isArray(raw)) return raw.filter((a) => typeof a === 'string').join(' ');
  return typeof raw === 'string' ? raw : '';
}

/**
 * Agents write their own one-line description of each Bash command ("Run the
 * test suite"), which reads far better on a board than the raw shell line —
 * and incidentally leaks less. Not every caller supplies one, so fall back.
 */
function describeBash(input) {
  return str(input.description) || commandText(input);
}

/** Basename of whichever path field the tool used. */
function editedFile(input) {
  const p = str(input.file_path) || str(input.notebook_path) || str(input.path);
  return p ? path.basename(p) : '';
}

function describeEdit(tool, input) {
  const name = editedFile(input);
  if (!name) return tool === 'apply_patch' ? 'Editing files' : tool;
  return `${tool === 'Write' ? 'Writing' : 'Editing'} ${name}`;
}

function describeResearch(tool, input) {
  if (tool === 'WebSearch') {
    const query = str(input.query);
    return query ? `Searching: ${query}` : 'Searching the web';
  }
  if (tool === 'WebFetch') {
    const url = str(input.url);
    if (!url) return 'Fetching a page';
    try {
      return `Reading ${new URL(url).hostname}`;
    } catch {
      return 'Fetching a page';
    }
  }
  // Task: the subagent's own description of the job it was handed.
  return str(input.description) || 'Delegating a subtask';
}

// A never-ending stdin (or anything else) must not hang Claude Code.
const safety = setTimeout(() => process.exit(0), SAFETY_TIMEOUT_MS);
safety.unref();

// Belt and braces: no failure mode may produce output or a non-zero exit.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

/**
 * Opt-in diagnostics (AGSTATUS_DEBUG=1). Everything in this script fails
 * silently by design, which makes "my bars stopped showing" impossible to
 * diagnose; this is the escape hatch. stderr only — stdout is reserved
 * because Codex parses it as behavior-control JSON.
 */
function dbg(msg) {
  if (!process.env.AGSTATUS_DEBUG) return;
  try {
    process.stderr.write(`[agstatus] ${msg}\n`);
  } catch {
    /* nothing we can do */
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function send(method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  timer.unref();
  try {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const secret = process.env.CLAUDE_STATUS_SECRET || str(FILE_CONFIG.secret);
    if (secret) headers['x-webhook-secret'] = secret;
    // Await the response, but its status/body are irrelevant: fire-and-forget.
    await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---- plan-usage reporting ---------------------------------------------------

function readCredentialsFile() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')
    );
  } catch {
    return null;
  }
}

// On macOS Claude Code keeps its OAuth credentials in the login keychain.
// Absolute path on purpose: hooks can be spawned with a minimal PATH, and a
// bare "security" then fails with ENOENT — silently costing us plan usage.
const SECURITY_BIN = fs.existsSync('/usr/bin/security') ? '/usr/bin/security' : 'security';

function readCredentialsKeychain() {
  return new Promise((resolve) => {
    execFile(
      SECURITY_BIN,
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 1500 },
      (err, stdout) => {
        if (err) {
          dbg(`keychain read failed: ${err.code || err.message}`);
          return resolve(null);
        }
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch {
          dbg('keychain returned unparseable JSON');
          resolve(null);
        }
      }
    );
  });
}

async function readClaudeOAuthToken() {
  let creds = readCredentialsFile();
  if (!creds && process.platform === 'darwin') creds = await readCredentialsKeychain();
  const oauth = creds && creds.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken === '') return null;
  // An expired token would only 401; Claude Code refreshes it by itself.
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return null;
  return oauth.accessToken;
}

// Legacy fallback windows of the usage endpoint → dashboard bars.
const USAGE_WINDOWS = [
  ['five_hour', 'session', 'Current session'],
  ['seven_day', 'week', 'Weekly (all models)'],
  ['seven_day_opus', 'week_opus', 'Weekly (Opus)'],
  ['seven_day_sonnet', 'week_sonnet', 'Weekly (Sonnet)'],
];

// Window ids must satisfy the server's ^[a-z][a-z0-9_-]{0,31}$.
function slugify(value) {
  const s = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (/^[a-z]/.test(s) ? s : `w_${s}`).slice(0, 20);
}

function parseResetsAt(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Modern response shape: a `limits` array of
 * {kind, group, percent, resets_at, scope: {model: {display_name}}}.
 * This is where model-scoped weekly limits (e.g. Fable) live — the legacy
 * five_hour/seven_day keys never mention them.
 */
function windowsFromLimits(limits) {
  const windows = [];
  const seen = new Set();
  for (const limit of limits) {
    if (!limit || typeof limit.percent !== 'number' || !isFinite(limit.percent)) continue;
    const scopeName =
      limit.scope && limit.scope.model && typeof limit.scope.model.display_name === 'string'
        ? limit.scope.model.display_name
        : '';
    let id;
    let label;
    if (limit.kind === 'session') {
      id = 'session';
      label = 'Current session';
    } else if (limit.kind === 'weekly_all') {
      id = 'week';
      label = 'Weekly (all models)';
    } else if (limit.group === 'weekly') {
      id = `week_${slugify(scopeName || limit.kind || 'scoped')}`;
      label = `Weekly (${scopeName || limit.kind || 'scoped'})`;
    } else {
      id = slugify(`${limit.kind || 'window'}${scopeName ? `_${scopeName}` : ''}`);
      label = scopeName ? `${limit.kind} (${scopeName})` : String(limit.kind || 'window');
    }
    if (seen.has(id)) continue; // server rejects duplicate ids
    seen.add(id);
    windows.push({
      id,
      label,
      usedPct: Math.min(100, Math.max(0, limit.percent)),
      resetsAt: parseResetsAt(limit.resets_at),
    });
    if (windows.length >= MAX_USAGE_WINDOWS) break; // server cap per report
  }
  return windows;
}

function windowsFromLegacyKeys(data) {
  const windows = [];
  for (const [key, id, label] of USAGE_WINDOWS) {
    const w = data ? data[key] : undefined;
    if (!w || typeof w.utilization !== 'number' || !isFinite(w.utilization)) continue;
    windows.push({
      id,
      label,
      usedPct: Math.min(100, Math.max(0, w.utilization)),
      resetsAt: parseResetsAt(w.resets_at),
    });
  }
  return windows;
}

async function fetchClaudeUsage(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        // Without a claude-code UA this endpoint lands in an aggressively
        // rate-limited bucket (anthropics/claude-code#31021).
        'user-agent': 'claude-code/2.0.0 (external; agstatus-hook)',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      dbg(`usage endpoint HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const windows =
      data && Array.isArray(data.limits) && data.limits.length > 0
        ? windowsFromLimits(data.limits)
        : windowsFromLegacyKeys(data);
    if (windows.length === 0) dbg('usage response contained no recognizable windows');
    return windows.length > 0 ? { source: 'claude', windows } : null;
  } catch (err) {
    dbg(`usage fetch failed: ${err && err.message ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Codex plan usage (local rollout log) -----------------------------------

/** Codex config dir; mirrors cli/src/codex.ts (respects CODEX_HOME). */
function codexHome() {
  const override = process.env.CODEX_HOME;
  return override && override.trim() !== '' ? override.trim() : path.join(os.homedir(), '.codex');
}

/**
 * Rollout logs to try, best first: the session's own, then recent siblings.
 * Files live at <home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl, so
 * the session id from the hook payload names the file directly.
 *
 * Siblings matter even when the session's own log is found: Codex writes its
 * first rate_limits block only when a turn completes, so at SessionStart the
 * session's log exists but carries none. Limits are account-wide rather than
 * per-session, so a sibling reports the same numbers. Day directories are
 * visited newest-first; names are timestamp-prefixed, so a lexicographic sort
 * is chronological and no stat() calls are needed.
 */
function findCodexRollouts(sessionId) {
  const root = path.join(codexHome(), 'sessions');
  const suffix = sessionId ? `-${sessionId}.jsonl` : '';
  const subdirs = (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };

  let own = null;
  const siblings = [];
  const done = () => siblings.length >= CODEX_ROLLOUT_CANDIDATES && (own || !suffix);
  for (const y of subdirs(root)) {
    for (const m of subdirs(path.join(root, y))) {
      for (const d of subdirs(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        let names;
        try {
          names = fs
            .readdirSync(dir)
            .filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
            .sort()
            .reverse();
        } catch {
          continue;
        }
        for (const n of names) {
          const full = path.join(dir, n);
          if (suffix && n.endsWith(suffix)) own = own || full;
          else if (siblings.length < CODEX_ROLLOUT_CANDIDATES) siblings.push(full);
        }
        if (done()) return own ? [own, ...siblings] : siblings;
      }
    }
  }
  return own ? [own, ...siblings] : siblings;
}

/**
 * The newest `rate_limits` block per limit bucket in a rollout log, with the
 * time Codex wrote each. Codex appends a token_count event after every turn,
 * so the freshest sit near the end of a file that can run to megabytes — hence
 * a tail read instead of parsing the whole log. The write time is what makes a
 * block datable: a snapshot from hours ago must not be reported as current.
 *
 * Buckets are keyed by `limit_id`: Codex reports the general allowance as
 * {limit_id:"codex", limit_name:null} and each model's own allowance under its
 * own id, e.g. {limit_id:"codex_bengalfox", limit_name:"GPT-5.3-Codex-Spark"}.
 * One session can touch several, so the scan collects them all rather than
 * stopping at the first.
 */
function readCodexRateLimitBlocks(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - CODEX_ROLLOUT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    // Starting mid-file leaves a truncated first line; it can never parse.
    if (start > 0) lines.shift();
    const blocks = new Map(); // limit_id -> newest block, scanning backwards
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (line === '' || !line.includes('"rate_limits"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const rl = obj && obj.payload && obj.payload.rate_limits;
      if (!rl || typeof rl !== 'object') continue;
      const id = typeof rl.limit_id === 'string' && rl.limit_id !== '' ? rl.limit_id : 'codex';
      if (blocks.has(id)) continue; // walking backwards: first seen is newest
      const at = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
      blocks.set(id, {
        limitId: id,
        limitName: typeof rl.limit_name === 'string' && rl.limit_name !== '' ? rl.limit_name : '',
        rateLimits: rl,
        at: Number.isNaN(at) ? null : at,
      });
    }
    return Array.from(blocks.values());
  } catch (err) {
    dbg(`codex rollout read failed: ${err && err.message ? err.message : String(err)}`);
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing we can do */
      }
    }
  }
}

/** "Weekly" / "5h" / "30m" for a rate-limit window length in minutes. */
function codexWindowName(minutes) {
  if (typeof minutes !== 'number' || !isFinite(minutes) || minutes <= 0) return 'Plan';
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? 'Weekly' : `${weeks}-week`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? 'Daily' : `${days}-day`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Codex reports epoch SECONDS; the board's API takes milliseconds.
 * `at` is when Codex wrote the block — a relative countdown is anchored to
 * that, never to now, or a snapshot from hours ago would state a reset time
 * wrong by exactly its own age and no client could tell.
 */
function codexResetsAt(w, at) {
  let ms = null;
  if (typeof w.resets_at === 'number' && isFinite(w.resets_at) && w.resets_at > 0) {
    ms = Math.round(w.resets_at * 1000);
  } else if (
    typeof w.resets_in_seconds === 'number' &&
    isFinite(w.resets_in_seconds) &&
    w.resets_in_seconds > 0
  ) {
    ms = (typeof at === 'number' ? at : Date.now()) + Math.round(w.resets_in_seconds * 1000);
  }
  // A window that already reset tells the reader nothing; the board renders a
  // null as "no reset time" rather than guessing.
  return ms !== null && ms > Date.now() ? ms : null;
}

/**
 * One Codex limit bucket → dashboard bars, named to match the Claude side so
 * the two agents' blocks read alike. The general bucket (no limit_name) yields
 * "Current session" / "Weekly (all models)"; a model bucket yields
 * "Session (<model>)" / "Weekly (<model>)".
 *
 * Codex describes each window only by its length, so the kind is derived from
 * `window_minutes` rather than from the primary/secondary slot: nothing
 * guarantees primary is the shorter one, and on the general bucket primary IS
 * the weekly window.
 */
function windowsFromCodexBucket(block) {
  const { rateLimits: rl, limitName, limitId, at } = block;
  // Only the default bucket is unscoped. A named bucket scopes by its model
  // name; an unnamed non-default one (Codex has shipped at least one, "premium")
  // scopes by its id, or two unnamed buckets would both derive `week` and the
  // duplicate-id guard would silently drop the second.
  const scopeName = limitName || (limitId && limitId !== 'codex' ? limitId : '');
  const out = [];
  const used = new Set();
  for (const slot of ['primary', 'secondary']) {
    const w = rl[slot];
    if (!w || typeof w !== 'object') continue;
    if (typeof w.used_percent !== 'number' || !isFinite(w.used_percent)) continue;
    const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : 0;
    const weekly = minutes >= 1440; // a day or longer reads as a standing cap
    const scope = scopeName ? slugify(scopeName) : '';
    let id = weekly
      ? scope ? `week_${scope}` : 'week'
      : scope ? `session_${scope}` : 'session';
    let label;
    if (weekly) label = scopeName ? `Weekly (${scopeName})` : 'Weekly (all models)';
    else label = scopeName ? `Session (${scopeName})` : 'Current session';
    // Both windows of one bucket can share a length; keep the second rather
    // than letting the duplicate id drop it. `_2` keeps the id inside 32 chars.
    if (used.has(id)) {
      id = `${id}_2`;
      label = `${label} (secondary)`;
    }
    used.add(id);
    out.push({
      id,
      label,
      usedPct: Math.min(100, Math.max(0, w.used_percent)),
      resetsAt: codexResetsAt(w, at),
      // Sort key: session before weekly, general before scoped.
      _rank: (weekly ? 1 : 0) + (scope ? 2 : 0),
    });
  }
  return out;
}

/**
 * Every fresh bucket → one report. Ordered so the general allowance leads and
 * model-scoped bars follow, then trimmed to the server's per-report cap.
 */
function windowsFromCodexBuckets(blocks) {
  const windows = [];
  const seen = new Set();
  const ordered = blocks
    .slice()
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .flatMap(windowsFromCodexBucket)
    .sort((a, b) => a._rank - b._rank);
  for (const w of ordered) {
    if (seen.has(w.id)) continue; // server rejects duplicate ids
    seen.add(w.id);
    delete w._rank;
    windows.push(w);
    if (windows.length >= MAX_USAGE_WINDOWS) break;
  }
  return windows;
}

/** Plan usage for a Codex run, read entirely from local state. */
function readCodexUsage(sessionId) {
  const files = findCodexRollouts(sessionId);
  if (files.length === 0) {
    dbg('no Codex rollout log found');
    return null;
  }
  // Merge across candidate logs: a model's bucket may only appear in the log of
  // the session that used it, while the general bucket shows up in all of them.
  const fresh = new Map();
  const cutoff = Date.now() - CODEX_USAGE_MAX_AGE_MS;
  for (const file of files) {
    const blocks = readCodexRateLimitBlocks(file);
    if (blocks.length === 0) {
      dbg(`no rate_limits block in ${path.basename(file)}`);
      continue;
    }
    for (const b of blocks) {
      if (b.at !== null && b.at < cutoff) continue; // stale beats missing
      const prev = fresh.get(b.limitId);
      if (!prev || (b.at || 0) > (prev.at || 0)) fresh.set(b.limitId, b);
    }
  }
  if (fresh.size === 0) {
    dbg('no Codex rate_limits fresh enough to report');
    return null;
  }
  const windows = windowsFromCodexBuckets(Array.from(fresh.values()));
  if (windows.length === 0) {
    dbg('Codex rate_limits carried no usable window');
    return null;
  }
  dbg(`codex buckets: ${Array.from(fresh.values()).map((b) => b.limitName || b.limitId).join(', ')}`);
  return { source: SOURCE, windows };
}

// ---- per-project token spend ------------------------------------------------
//
// The limit bars are account-wide: nothing in either agent's usage API says
// which project burned the quota. Both agents do, however, write their own
// local logs with a token count and a working directory per turn, which is
// enough to answer "where is my quota going" as a share of tokens spent.
//
// Reported tokens are input + output + cache-creation. Cache READS are left
// out on purpose: they are ~94% of raw token volume but a small fraction of
// what a plan limit actually charges, and including them reorders the ranking
// into a list of which project has the largest context, not the largest spend.

/** The UTC day an epoch-ms instant falls in, as YYYY-MM-DD. */
function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Recursively collect files under `dir` matching `keep`.
 *
 * Symlinked directories are deliberately NOT followed: Claude Code links a
 * shared subagent workflow into every session that used it, so following them
 * counts the same transcript once per link and inflates that project's total.
 * `isDirectory()` is false for a symlink, which gives us that for free — don't
 * "fix" it to a stat() that resolves links.
 */
function collectLogs(dir, keep, maxAgeMs, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const cutoff = maxAgeMs === null ? 0 : Date.now() - maxAgeMs;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectLogs(full, keep, maxAgeMs, out);
      continue;
    }
    if (!e.isFile() || !keep(e.name)) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    out.push({ file: full, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/** Newest first: a budgeted run should spend itself on the freshest logs. */
function byNewest(a, b) {
  return b.mtime - a.mtime;
}

/**
 * Read the bytes of `file` that `seen` has not consumed yet, returning whole
 * lines only. Consuming byte offsets rather than re-reading is what keeps this
 * affordable: a hook run costs the few KB an agent appended since the last one,
 * not the hundreds of megabytes of transcript on disk.
 */
function readNewLines(file, seen, size, budget) {
  let from = typeof seen === 'number' && seen >= 0 ? seen : 0;
  if (from > size) from = 0; // truncated or replaced — start over
  if (from === size) return { lines: [], consumed: size };
  const want = Math.min(size - from, budget === undefined ? Infinity : Math.max(0, budget));
  if (want === 0) return { lines: [], consumed: from };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(want);
    // readSync may return a short read; loop rather than trust one call, or the
    // unread tail would be silently skipped and its offset marked consumed.
    let filled = 0;
    for (;;) {
      const got = fs.readSync(fd, buf, filled, buf.length - filled, from + filled);
      if (got <= 0) break;
      filled += got;
      if (filled >= buf.length) break;
    }
    const text = buf.subarray(0, filled).toString('utf8');
    const lastBreak = text.lastIndexOf('\n');
    // A trailing partial line is left for the next run rather than dropped.
    if (lastBreak === -1) return { lines: [], consumed: from };
    return { lines: text.slice(0, lastBreak).split('\n'), consumed: from + Buffer.byteLength(text.slice(0, lastBreak + 1)) };
  } catch (err) {
    dbg(`project log read failed: ${err && err.message ? err.message : String(err)}`);
    return { lines: [], consumed: from };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing we can do */
      }
    }
  }
}

/** Claude Code transcripts: one assistant record per request, with its own cwd. */
function scanClaudeLogs(state, full) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = collectLogs(root, (n) => n.endsWith('.jsonl'), full ? null : PROJECT_FILE_MAX_AGE_MS, [])
    .sort(byNewest);
  let budget = full ? Infinity : PROJECT_SCAN_BYTE_BUDGET;
  for (const { file, size } of files) {
    if (budget <= 0) break;
    const prev = state.files[file] || {};
    const { lines, consumed } = readNewLines(file, full ? 0 : prev.at, size, budget);
    budget -= consumed - (full ? 0 : prev.at || 0);
    for (const line of lines) {
      if (line === '' || !line.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const u = o && o.message && o.message.usage;
      if (!u || typeof u !== 'object') continue;
      const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
      if (Number.isNaN(at)) continue;
      const project = path.basename(o.cwd || '') || 'unknown';
      const tokens =
        (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (tokens <= 0) continue;
      addTokens(state, project, dayKey(at), tokens);
    }
    state.files[file] = { at: consumed, seen: Date.now() };
  }
}

/** Codex rollouts: token_count carries a running total, so spend is its delta. */
function scanCodexLogs(state, full) {
  const root = path.join(codexHome(), 'sessions');
  const files = collectLogs(
    root,
    (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    full ? null : PROJECT_FILE_MAX_AGE_MS,
    []
  ).sort(byNewest);
  let budget = full ? Infinity : PROJECT_SCAN_BYTE_BUDGET;
  for (const { file, size } of files) {
    if (budget <= 0) break;
    const prev = state.files[file] || {};
    const { lines, consumed } = readNewLines(file, full ? 0 : prev.at, size, budget);
    budget -= consumed - (full ? 0 : prev.at || 0);
    let project = prev.project || '';
    let running = typeof prev.cum === 'number' ? prev.cum : 0;
    for (const line of lines) {
      if (line === '') continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const p = o && o.payload;
      if (!p || typeof p !== 'object') continue;
      if (!project && typeof p.cwd === 'string' && p.cwd !== '') project = path.basename(p.cwd);
      if (p.type !== 'token_count') continue;
      const total = p.info && p.info.total_token_usage && p.info.total_token_usage.total_tokens;
      if (typeof total !== 'number' || !isFinite(total)) continue;
      const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
      // A repeated record adds nothing; a reset (new total below the running
      // one) restarts rather than subtracting.
      const delta = total >= running ? total - running : total;
      running = total;
      if (delta > 0 && !Number.isNaN(at)) addTokens(state, project || 'unknown', dayKey(at), delta);
    }
    state.files[file] = { at: consumed, cum: running, project, seen: Date.now() };
  }
}

function addTokens(state, project, day, tokens) {
  const key = `${project}\n${day}`;
  state.days[key] = (state.days[key] || 0) + tokens;
  state.dirty[key] = true;
}

/** Drops files and days that have aged past what the server will keep. */
function pruneProjectState(state) {
  const oldestDay = dayKey(Date.now() - PROJECT_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(state.days)) {
    if (key.slice(key.indexOf('\n') + 1) < oldestDay) delete state.days[key];
  }
  const cutoff = Date.now() - PROJECT_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  for (const [file, meta] of Object.entries(state.files)) {
    if (!meta || typeof meta.seen !== 'number' || meta.seen < cutoff) delete state.files[file];
  }
}

function projectStateFile(base) {
  const key = crypto.createHash('sha256').update(`${base}\n${SOURCE}`).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `agstatus-projects-${key}.json`);
}

function loadProjectState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      lastAttemptAt: typeof parsed.lastAttemptAt === 'number' ? parsed.lastAttemptAt : 0,
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      dirty: {},
    };
  } catch {
    return { lastAttemptAt: 0, files: {}, days: {}, dirty: {} };
  }
}

/**
 * Scan this agent's own logs and report per-project token totals for the days
 * that changed. `full` rescans every log from byte zero — the backfill path.
 */
async function reportProjectUsage(base, full) {
  if (process.env.AGSTATUS_USAGE === 'off') return 0;
  if (SOURCE !== 'claude' && SOURCE !== 'codex') return 0;

  const stateFile = projectStateFile(base);
  const state = full
    ? { lastAttemptAt: 0, files: {}, days: {}, dirty: {} }
    : loadProjectState(stateFile);
  // AGSTATUS_PROJECT_FORCE skips the wait without discarding the consumed
  // offsets — the way to pick up a just-finished session immediately, and how
  // the tests exercise a second incremental pass.
  const forced = process.env.AGSTATUS_PROJECT_FORCE === '1';
  if (!full && !forced && Date.now() - state.lastAttemptAt < PROJECT_THROTTLE_MS) {
    dbg('project totals throttled');
    return 0;
  }

  if (SOURCE === 'codex') scanCodexLogs(state, full);
  else scanClaudeLogs(state, full);
  pruneProjectState(state);

  const changed = full ? Object.keys(state.days) : Object.keys(state.dirty);
  const rows = changed
    .filter((k) => state.days[k] > 0)
    .map((k) => {
      const at = k.indexOf('\n');
      return { project: k.slice(0, at), day: k.slice(at + 1), tokens: state.days[k] };
    });

  state.lastAttemptAt = Date.now();
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      lastAttemptAt: state.lastAttemptAt, files: state.files, days: state.days,
    }));
  } catch {
    // Unwritable tmp: reporting still works, it just rescans next time.
  }
  if (rows.length === 0) {
    dbg('no project token changes to report');
    return 0;
  }
  // The server replaces whole days, so chunks are independent and a partial
  // failure just leaves those days to the next run.
  for (let i = 0; i < rows.length; i += MAX_PROJECT_DAYS_PER_POST) {
    await send('POST', `${base}/usage/projects`, {
      source: SOURCE,
      days: rows.slice(i, i + MAX_PROJECT_DAYS_PER_POST),
    });
  }
  dbg(`reported ${rows.length} project-day total(s)`);
  return rows.length;
}

async function maybeReportUsage(base, sessionId) {
  if (process.env.AGSTATUS_USAGE === 'off') return;
  // Each agent reports from its own source and only its own: Claude reads
  // Claude Code's OAuth credentials, Codex reads Codex's rollout log. A Codex
  // run has no business touching Claude credentials, even on a machine with
  // both. Any other agent has no usage source we know how to read.
  if (SOURCE !== 'claude' && SOURCE !== 'codex') return;

  // Throttle across hook invocations via a per-server tmp file, keyed by source
  // as well as board so two agents pointed at one board don't starve each other
  // out of a shared slot.
  const stateFile = path.join(
    os.tmpdir(),
    `agstatus-usage-${crypto
      .createHash('sha256')
      .update(`${base}\n${SOURCE}`)
      .digest('hex')
      .slice(0, 12)}.json`
  );
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (typeof state.lastAttemptAt === 'number' && Date.now() - state.lastAttemptAt < USAGE_THROTTLE_MS) {
      dbg(`usage throttled (last attempt ${Math.round((Date.now() - state.lastAttemptAt) / 1000)}s ago)`);
      return;
    }
  } catch {
    // no state yet — proceed
  }
  const claimSlot = () => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ lastAttemptAt: Date.now() }));
      return true;
    } catch {
      return false; // unwritable tmp — skip rather than run unthrottled forever
    }
  };

  let usage;
  if (SOURCE === 'codex') {
    // Reading a local file costs nothing worth backing off from, and at
    // SessionStart the log reliably has no limits yet — so the slot is claimed
    // only once there is something to send. Claiming first would silence a
    // session's first bars for the whole throttle window.
    usage = readCodexUsage(sessionId);
    if (!usage) return;
    if (!claimSlot()) return;
  } else {
    // Claimed before the fetch so failed requests back off too, instead of
    // hammering the usage endpoint every quiet event.
    if (!claimSlot()) return;
    const token = await readClaudeOAuthToken();
    if (!token) {
      dbg('no usable Claude OAuth token (credentials file and keychain both unavailable)');
      return;
    }
    usage = await fetchClaudeUsage(token);
    if (!usage) {
      dbg('usage endpoint returned nothing usable');
      return;
    }
  }
  await send('POST', `${base}/usage`, usage);
  dbg(`reported ${usage.windows.length} ${SOURCE} usage window(s)`);
}

async function main() {
  const rawUrl = process.env.CLAUDE_STATUS_URL || str(FILE_CONFIG.url);
  if (!rawUrl) return;
  const base = rawUrl.replace(/\/$/, '').replace(/\/webhook$/, '');

  const payload = JSON.parse(await readStdin());
  if (!payload || typeof payload !== 'object') return;

  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  const session = typeof payload.session_id === 'string' ? payload.session_id : '';
  if (!session) return;

  if (event === 'SessionEnd') {
    await send('DELETE', `${base}/sessions/${encodeURIComponent(session)}`);
    return;
  }

  let status = '';
  let message = '';

  if (event === 'SessionStart') {
    status = 'idle';
    message = 'Session started';
  } else if (event === 'Notification' || event === 'PermissionRequest') {
    // Claude Code fires Notification; Codex fires PermissionRequest before
    // approval prompts. Both mean "a human needs to look at this".
    status = 'blocked';
    const generic = event === 'PermissionRequest' ? 'Needs approval' : 'Needs input';
    // The prompt text can quote the command awaiting approval, so honor the
    // privacy switch here too: minimal mode sends only the generic label.
    message =
      process.env.AGSTATUS_DETAIL === 'off'
        ? generic
        : typeof payload.message === 'string' && payload.message !== ''
          ? payload.message
          : generic;
  } else if (event === 'UserPromptSubmit') {
    // The user just answered — flip the card away from blocked/idle right now,
    // not at the first tool call (which may come much later, or never for a
    // tool-free reply). Prompts are the user's own words, so honor the
    // privacy switch exactly like command text.
    status = 'planning';
    const prompt = str(typeof payload.prompt === 'string' ? payload.prompt : '')
      .replace(/\s+/g, ' ');
    message =
      process.env.AGSTATUS_DETAIL === 'off' || prompt === ''
        ? 'Processing prompt'
        : prompt.slice(0, COMMAND_MAX);
  } else if (event === 'PreToolUse') {
    const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    const input =
      payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    // Privacy switch: minimal mode reports the tool and nothing else — no
    // descriptions, file names, search queries, or command text.
    const minimal = process.env.AGSTATUS_DETAIL === 'off';

    // Codex's file-edit tool is apply_patch; Claude Code uses Edit/Write/….
    if (EDIT_TOOLS.has(tool)) {
      status = 'coding';
      message = minimal ? tool : describeEdit(tool, input);
    } else if (tool === 'Bash') {
      // Classify from the command itself — the description says what the
      // command means, but only the command says whether it runs tests.
      status = TEST_RE.test(commandText(input)) ? 'testing' : 'coding';
      message = minimal ? 'Bash' : describeBash(input);
    } else if (tool === 'Task' || tool === 'WebSearch' || tool === 'WebFetch') {
      status = 'planning';
      message = minimal ? tool : describeResearch(tool, input);
    } else {
      return;
    }
    message = message.slice(0, COMMAND_MAX);
  } else if (event === 'Stop') {
    status = 'idle';
    message = 'Waiting for input';
  } else {
    return;
  }

  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd();
  const project = path.basename(cwd);

  const statusPost = send('POST', `${base}/webhook`, {
    session_id: session,
    name: project,
    status,
    message,
    project,
    source: SOURCE,
  });
  // Claude's report costs a network round trip, so it stays off PreToolUse,
  // which fires between every tool call. Codex reads a local file instead, and
  // PreToolUse is most of what Codex fires at all (its only other events are
  // SessionStart, Stop and PermissionRequest) — skipping it there would leave
  // Codex bars minutes stale. The 5-minute throttle bounds the real work in
  // both cases; off-slot invocations cost one small file read.
  const usagePost =
    event === 'PreToolUse' && SOURCE !== 'codex'
      ? Promise.resolve()
      : maybeReportUsage(base, session);
  // Same reasoning as the usage report, and cheaper: off-slot runs stop at the
  // throttle file, and a run that does scan is capped by its byte budget.
  const projectPost =
    event === 'PreToolUse' && SOURCE !== 'codex'
      ? Promise.resolve(0)
      : reportProjectUsage(base, false);
  await Promise.all([statusPost, usagePost.catch(() => {}), projectPost.catch(() => {})]);
}

/**
 * `--backfill` re-reads every log from the beginning and reports the lot, so a
 * board has project history from the day it is set up instead of only from the
 * next turn onwards. Run by hand; the hook never takes this path, and it is the
 * one mode allowed to take longer than the safety timeout or to print.
 */
if (process.argv.includes('--backfill')) {
  clearTimeout(safety);
  const rawUrl = process.env.CLAUDE_STATUS_URL || str(FILE_CONFIG.url);
  if (!rawUrl) {
    process.stderr.write('agstatus: set CLAUDE_STATUS_URL to your board URL first\n');
    process.exit(1);
  }
  const backfillBase = rawUrl.replace(/\/$/, '').replace(/\/webhook$/, '');
  process.stderr.write(`agstatus: scanning ${SOURCE} logs — this can take a minute…\n`);
  reportProjectUsage(backfillBase, true)
    .then((n) => {
      process.stderr.write(`agstatus: reported ${n} project-day total(s) for ${SOURCE}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`agstatus: backfill failed: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
} else {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
