#!/usr/bin/env node
/**
 * AgStatus hook for Claude Code (dependency-free, node >= 18).
 *
 * Posts session status to an AgStatus dashboard. Wired to SessionStart,
 * PreToolUse, Stop, Notification, SessionEnd. Reads the hook payload as JSON
 * from stdin.
 *
 * Env:
 *   CLAUDE_STATUS_URL     (required; exits silently when unset)
 *   CLAUDE_STATUS_SECRET  (optional; sent as x-webhook-secret, legacy servers)
 *   AGSTATUS_DETAIL=off   (optional; send tool names instead of command text)
 *
 * Never blocks Claude Code: always exits 0, prints nothing, hard 3s HTTP
 * timeout, and an overall ~4s safety timeout.
 */
'use strict';

const path = require('path');

const HTTP_TIMEOUT_MS = 3000;
const SAFETY_TIMEOUT_MS = 4000;
// Only Bash command text is truncated client-side (matching the bash hook);
// the server caps every message at 300.
const COMMAND_MAX = 120;

// Word-ish matches for common test runners (intent of the bash hook's regex,
// minus the platform-dependent \< \> tokens).
const TEST_RE =
  /\b(pytest|jest|vitest|mocha|rspec|phpunit|(?:go|cargo)\s+test|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test)\b/;

// A never-ending stdin (or anything else) must not hang Claude Code.
const safety = setTimeout(() => process.exit(0), SAFETY_TIMEOUT_MS);
safety.unref();

// Belt and braces: no failure mode may produce output or a non-zero exit.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

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
  } else if (event === 'Notification') {
    status = 'blocked';
    message =
      typeof payload.message === 'string' && payload.message !== ''
        ? payload.message
        : 'Needs input';
  } else if (event === 'PreToolUse') {
    const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      status = 'coding';
      message = tool;
    } else if (tool === 'Bash') {
      const command =
        payload.tool_input && typeof payload.tool_input.command === 'string'
          ? payload.tool_input.command
          : '';
      status = TEST_RE.test(command) ? 'testing' : 'coding';
      message = process.env.AGSTATUS_DETAIL === 'off' ? 'Bash' : command.slice(0, COMMAND_MAX);
    } else if (tool === 'Task' || tool === 'WebSearch' || tool === 'WebFetch') {
      status = 'planning';
      message = tool;
    } else {
      return;
    }
  } else if (event === 'Stop') {
    status = 'idle';
    message = 'Waiting for input';
  } else {
    return;
  }

  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd();
  const project = path.basename(cwd);

  await send('POST', `${base}/webhook`, {
    session_id: session,
    name: project,
    status,
    message,
    project,
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
