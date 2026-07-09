import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createApp } from '../../src/app';
import { runInit, runUninstall } from '../src/index';
import {
  CODEX_EVENTS,
  codexHookCommand,
  codexHookInstallPath,
  codexHooksPath,
  mergeCodexHooks,
  readCodexHooks,
  removeCodexHooks,
} from '../src/codex';

const CMD = 'CLAUDE_STATUS_URL="https://s.example/w/ags_x" node "$HOME/.codex/hooks/agstatus-hook.js"';

describe('mergeCodexHooks', () => {
  it('registers all four events with matchers, timeout, and statusMessage', () => {
    const out = mergeCodexHooks({}, CMD);
    const hooks = out.hooks as Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    for (const { event, matcher } of CODEX_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
      const h = hooks[event][0].hooks[0];
      expect(h.command).toContain('agstatus-hook');
      expect(h.type).toBe('command');
      expect(h.timeout).toBe(10);
      if (matcher) expect(hooks[event][0].matcher).toBe(matcher);
    }
    expect(hooks.PreToolUse[0].matcher).toBe('^(Bash|apply_patch|Edit|Write)$');
  });

  it('is idempotent and preserves foreign entries', () => {
    const input = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'other-tool.sh' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
    };
    const twice = mergeCodexHooks(mergeCodexHooks(input, CMD), CMD);
    const hooks = twice.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop[0].hooks[0].command).toBe('other-tool.sh');
    expect(hooks.PostToolUse).toHaveLength(1);
    for (const { event } of CODEX_EVENTS) {
      const ours = hooks[event].filter((e) => e.hooks[0].command.includes('agstatus-hook'));
      expect(ours).toHaveLength(1);
    }
  });

  it('rejects malformed shapes without mutating', () => {
    expect(() => mergeCodexHooks({ hooks: [] }, CMD)).toThrow(/"hooks".*array/);
    expect(() => mergeCodexHooks({ hooks: { Stop: 'oops' } }, CMD)).toThrow(/"hooks\.Stop"/);
  });

  it('removeCodexHooks strips only ours and prunes empties', () => {
    const merged = mergeCodexHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep.sh' }] }] } },
      CMD
    );
    const { hooks: cleaned, removed } = removeCodexHooks(merged);
    const hooks = cleaned.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop[0].hooks[0].command).toBe('keep.sh');
    expect(hooks).not.toHaveProperty('SessionStart');
    expect(removed).toContain('hooks.SessionStart');
    expect(removeCodexHooks(mergeCodexHooks({}, CMD)).hooks).toEqual({});
  });
});

describe('codexHookCommand', () => {
  it('embeds the board URL and honors minimal', () => {
    const cmd = codexHookCommand('https://h.example/w/ags_t', true);
    expect(cmd).toContain('CLAUDE_STATUS_URL="https://h.example/w/ags_t"');
    expect(cmd).toContain('AGSTATUS_DETAIL=off');
    expect(cmd).toContain('agstatus-hook.js');
    expect(codexHookCommand('https://h.example', false)).not.toContain('AGSTATUS_DETAIL');
  });

  it('embeds a single-quoted secret only when provided', () => {
    expect(codexHookCommand('https://h.example', false)).not.toContain('CLAUDE_STATUS_SECRET');
    const cmd = codexHookCommand('https://h.example', false, "s3cr'et");
    // Single-quoted with the embedded quote escaped as '\'' — no unquoted break-out.
    expect(cmd).toContain(`CLAUDE_STATUS_SECRET='s3cr'\\''et'`);
  });

  it('refuses a URL carrying shell metacharacters (defense in depth)', () => {
    expect(() => codexHookCommand('https://h.example/"; rm -rf ~; "', false)).toThrow(
      /shell metacharacters/
    );
    expect(() => codexHookCommand('https://h.example/$(reboot)', false)).toThrow(
      /shell metacharacters/
    );
    expect(() => codexHookCommand('https://h.example/`id`', false)).toThrow(/shell metacharacters/);
  });
});

describe('init/uninstall with a detected Codex install', () => {
  const created = createApp({
    multiTenant: true, webhookSecret: '', publicUrl: 'http://x.example',
    sessionTtlMs: 0, dbPath: '', trustProxy: false, rateLimit: false,
    maxWorkspaces: 10_000, version: 'codex-e2e', apns: null,
  });
  let server: Server;
  let base: string;
  let claudeDir: string;
  let codexDir: string;
  let prevClaude: string | undefined;
  let prevCodex: string | undefined;
  const log = (): void => {};

  beforeAll(async () => {
    server = created.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    created.shutdown();
  });

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-claude-'));
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-codex-'));
    prevClaude = process.env.CLAUDE_CONFIG_DIR;
    prevCodex = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.CODEX_HOME = codexDir;
  });

  afterEach(() => {
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
  });

  it('auto-configures Codex, and the hook maps Codex events to statuses', async () => {
    // The hook runs as a subprocess; in some sandboxes a subprocess cannot
    // reach a port owned by the vitest worker, so this test spawns the real
    // compiled server as a sibling process (same pattern as e2e.test.ts).
    const root = path.resolve(__dirname, '..', '..');
    const serverJs = path.join(root, 'dist', 'server.js');
    if (!fs.existsSync(serverJs)) {
      throw new Error('dist/server.js missing — run `npm run build` at the repo root first');
    }
    const port = 3900 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, [serverJs], {
      env: {
        ...process.env,
        PORT: String(port),
        MULTI_TENANT: 'true',
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        DB_PATH: '',
        SESSION_TTL_MS: '0',
      },
      stdio: 'ignore',
    });
    const childBase = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 8000;
      for (;;) {
        try {
          if ((await fetch(`${childBase}/healthz`)).ok) break;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error('sibling server did not start');
        await new Promise((r) => setTimeout(r, 150));
      }

      await runInit({ url: childBase, noQr: true, log });

      // hooks.json written with our entries; hook script installed.
      const hooks = readCodexHooks(codexHooksPath());
      expect(JSON.stringify(hooks)).toContain('agstatus-hook');
      const hookFile = codexHookInstallPath();
      expect(fs.existsSync(hookFile)).toBe(true);

      // Board URL embedded in the registered command.
      const cmd = (hooks.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
        .SessionStart[0].hooks[0].command;
      const url = /CLAUDE_STATUS_URL="([^"]+)"/.exec(cmd)?.[1] ?? '';
      expect(url).toMatch(new RegExp(`^${childBase}/w/ags_`));

      // Drive the REAL hook with Codex-shaped payloads.
      const fire = (payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): string => {
        return execFileSync(process.execPath, [hookFile], {
          input: JSON.stringify(payload),
          env: { ...process.env, CLAUDE_STATUS_URL: url, ...extraEnv },
          timeout: 8000,
        }).toString();
      };
      const sessionsAt = async (id: string) => {
        const all = (await (await fetch(`${url}/api/sessions`)).json()) as Array<{
          id: string; status: string; message: string;
        }>;
        return all.find((s) => s.id === id)!;
      };

      fire({ hook_event_name: 'SessionStart', session_id: 'codex-1', cwd: '/tmp/codex-proj' });
      fire({
        hook_event_name: 'PreToolUse', session_id: 'codex-1', cwd: '/tmp/codex-proj',
        tool_name: 'apply_patch', tool_input: {},
      });
      let s = await sessionsAt('codex-1');
      expect(s.status).toBe('coding');
      expect(s.message).toBe('Editing files');

      // Codex exec tools deliver the command as an argv array — the test
      // detector must still classify `npm test` as testing (not empty → coding).
      fire({
        hook_event_name: 'PreToolUse', session_id: 'codex-1', cwd: '/tmp/codex-proj',
        tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'npm test'] },
      });
      s = await sessionsAt('codex-1');
      expect(s.status).toBe('testing');

      // PermissionRequest text may quote the command; --minimal must suppress it.
      fire(
        {
          hook_event_name: 'PermissionRequest', session_id: 'codex-1', cwd: '/tmp/codex-proj',
          message: 'Codex wants to run rm -rf ./dist',
        },
        { AGSTATUS_DETAIL: 'off' }
      );
      s = await sessionsAt('codex-1');
      expect(s.status).toBe('blocked');
      expect(s.message).toBe('Needs approval');
      expect(s.message).not.toContain('rm -rf');

      // Without --minimal the full prompt text comes through.
      fire({
        hook_event_name: 'PermissionRequest', session_id: 'codex-1', cwd: '/tmp/codex-proj',
        message: 'Codex wants to run rm -rf ./dist',
      });
      s = await sessionsAt('codex-1');
      expect(s.message).toBe('Codex wants to run rm -rf ./dist');

      // Hook must stay silent on stdout — Codex interprets output as decisions.
      const out = fire({ hook_event_name: 'Stop', session_id: 'codex-1', cwd: '/x' });
      expect(out).toBe('');
    } finally {
      child.kill();
    }
  });

  it('respects --no-codex and force-configures with --codex when undetected', async () => {
    await runInit({ url: base, noQr: true, codex: false, log });
    expect(fs.existsSync(codexHooksPath())).toBe(false);

    fs.rmSync(codexDir, { recursive: true, force: true }); // undetected now
    await runInit({ url: base, noQr: true, codex: true, log });
    expect(fs.existsSync(codexHooksPath())).toBe(true);
  });

  it('uninstall cleans the Codex side and preserves foreign hooks', async () => {
    fs.writeFileSync(
      codexHooksPath(),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep.sh' }] }] } })
    );
    await runInit({ url: base, noQr: true, log });
    await runUninstall(log);

    const hooks = readCodexHooks(codexHooksPath());
    expect(JSON.stringify(hooks)).not.toContain('agstatus-hook');
    expect(JSON.stringify(hooks)).toContain('keep.sh');
    expect(fs.existsSync(codexHookInstallPath())).toBe(false);
  });

  it('warns but still finishes Claude setup when hooks.json is malformed, leaving it untouched', async () => {
    fs.writeFileSync(codexHooksPath(), '{ nope');
    const lines: string[] = [];
    // A broken ~/.codex/hooks.json must not abort the Claude Code setup.
    await expect(runInit({ url: base, noQr: true, log: (l) => lines.push(l) })).resolves.toBeUndefined();

    // Claude side succeeded; Codex file untouched and its hook script not written.
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
    expect(fs.readFileSync(codexHooksPath(), 'utf8')).toBe('{ nope');
    expect(fs.existsSync(codexHookInstallPath())).toBe(false);
    expect(lines.join('\n')).toMatch(/Skipped Codex setup/);
  });
});

describe('board token validation (shell-injection guard)', () => {
  it('refuses a server-supplied token bearing shell metacharacters', async () => {
    // Stand up a hostile server that answers /api/config as multi-tenant but
    // hands back a booby-trapped token from /api/workspaces.
    const evil = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/config') {
        res.end(JSON.stringify({ mode: 'multi', version: 'evil' }));
      } else if (req.url === '/api/workspaces') {
        res.statusCode = 201;
        res.end(JSON.stringify({ token: 'ags_x"; rm -rf ~; echo "' }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => evil.listen(0, r));
    const port = (evil.address() as AddressInfo).port;
    try {
      await expect(
        runInit({ url: `http://127.0.0.1:${port}`, noQr: true, log: () => {} })
      ).rejects.toThrow(/malformed board token/);
    } finally {
      await new Promise((r) => evil.close(r));
    }
  });
});
