#!/usr/bin/env node
/**
 * AgStatus hook for Claude Code and OpenAI Codex (dependency-free, node >= 18).
 *
 * Posts session status to an AgStatus dashboard. Both tools deliver the hook
 * payload as JSON on stdin with the same core fields (hook_event_name,
 * session_id, cwd). Wired to SessionStart, PreToolUse, Stop, and
 * Notification + SessionEnd (Claude Code) / PermissionRequest (Codex).
 *
 * IMPORTANT: this script must never write to stdout — Codex interprets hook
 * stdout as behavior-control JSON, and a stray print could block a tool call.
 *
 * Env:
 *   CLAUDE_STATUS_URL     (required; exits silently when unset)
 *   CLAUDE_STATUS_SECRET  (optional; sent as x-webhook-secret, legacy servers)
 *   AGSTATUS_DETAIL=off   (optional; send tool names instead of command text)
 *   AGSTATUS_USAGE=off    (optional; never report plan-usage percentages)
 *   AGSTATUS_SOURCE       (optional; agent kind tag, defaults to "claude" —
 *                          the Codex integration sets "codex")
 *
 * Besides session status, the hook reports Claude plan usage (the 5-hour
 * session window and weekly limits) so the dashboard can show limit bars.
 * It reads the Claude Code OAuth token locally and asks Anthropic's usage
 * endpoint for utilization percentages; only those percentages and reset
 * times ever reach the AgStatus server — never the token itself. Throttled
 * to one attempt per 5 minutes, and only on quiet events (never PreToolUse).
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
    const secret = process.env.CLAUDE_STATUS_SECRET;
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
    if (windows.length >= 6) break; // server cap per report
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

async function maybeReportUsage(base) {
  if (process.env.AGSTATUS_USAGE === 'off') return;
  // Only Claude Code invocations may touch Claude credentials — a Codex run
  // has no business reading them, even on a machine that has both agents.
  if (SOURCE !== 'claude') return;

  // Throttle across hook invocations via a per-server tmp file. The slot is
  // claimed before fetching so failures back off too instead of hammering.
  const stateFile = path.join(
    os.tmpdir(),
    `agstatus-usage-${crypto.createHash('sha256').update(base).digest('hex').slice(0, 12)}.json`
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
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ lastAttemptAt: Date.now() }));
  } catch {
    return; // unwritable tmp — skip rather than fetch unthrottled forever
  }

  const token = await readClaudeOAuthToken();
  if (!token) {
    dbg('no usable Claude OAuth token (credentials file and keychain both unavailable)');
    return;
  }
  const usage = await fetchClaudeUsage(token);
  if (!usage) {
    dbg('usage endpoint returned nothing usable');
    return;
  }
  await send('POST', `${base}/usage`, usage);
  dbg(`reported ${usage.windows.length} usage window(s)`);
}

async function main() {
  const rawUrl = process.env.CLAUDE_STATUS_URL;
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
  // Piggyback plan-usage refresh on quiet events only — PreToolUse fires
  // between every tool call and must stay as cheap as possible.
  const usagePost = event === 'PreToolUse' ? Promise.resolve() : maybeReportUsage(base);
  await Promise.all([statusPost, usagePost.catch(() => {})]);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
