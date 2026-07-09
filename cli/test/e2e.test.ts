import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createApp } from '../../src/app';
import { runInit, runUninstall } from '../src/index';
import { hookInstallPath, settingsPath } from '../src/settings';

const created = createApp({
  multiTenant: true,
  webhookSecret: '',
  publicUrl: 'http://misconfigured.example', // deliberately wrong: CLI must not trust it
  sessionTtlMs: 0,
  dbPath: '',
  trustProxy: false,
  rateLimit: false,
  maxWorkspaces: 10_000,
  version: 'e2e',
});

let server: Server;
let base: string;
let dir: string;
let prevConfigDir: string | undefined;
const logs: string[] = [];
const log = (l: string): void => {
  logs.push(l);
};

beforeAll(async () => {
  server = created.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  created.shutdown();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-e2e-'));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  logs.length = 0;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

function readInstalledSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
}

async function waitForServer(baseUrl: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server at ${baseUrl} did not come up within ${timeoutMs}ms`);
}

describe('agstatus init against a real multi-tenant server', () => {
  it('creates a board, installs the hook, and the hook actually reports a session', async () => {
    // The hook runs as a subprocess, and in some sandboxed environments a
    // subprocess cannot connect to a port owned by the vitest worker itself —
    // so this test runs the server as a sibling child process (which also
    // exercises the real compiled dist/server.js).
    const root = path.resolve(__dirname, '..', '..');
    const serverJs = path.join(root, 'dist', 'server.js');
    if (!fs.existsSync(serverJs)) {
      throw new Error('dist/server.js missing — run `npm run build` at the repo root first');
    }
    const port = 3400 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, [serverJs], {
      env: {
        ...process.env,
        PORT: String(port),
        MULTI_TENANT: 'true',
        PUBLIC_URL: 'http://misconfigured.example', // CLI must not trust it
        DB_PATH: '',
        SESSION_TTL_MS: '0',
      },
      stdio: 'ignore',
    });
    const childBase = `http://127.0.0.1:${port}`;
    try {
      await waitForServer(childBase);
      await runInit({ url: childBase, noQr: true, log });

      // Hook file installed and executable.
      const hookFile = hookInstallPath();
      expect(fs.existsSync(hookFile)).toBe(true);
      expect(fs.statSync(hookFile).mode & 0o111).not.toBe(0);

      // settings.json points at a board on the origin WE reached, not PUBLIC_URL.
      const settings = readInstalledSettings();
      const env = settings.env as Record<string, string>;
      expect(env.CLAUDE_STATUS_URL).toMatch(
        new RegExp(`^${childBase}/w/ags_[A-Za-z0-9_-]{32}$`)
      );
      expect(env.CLAUDE_STATUS_URL).not.toContain('misconfigured.example');
      expect(Object.keys(settings.hooks as object).sort()).toEqual(
        ['Notification', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop'].sort()
      );

      // Fire the REAL installed hook with a SessionStart payload.
      const payload = JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'e2e-hook-1',
        cwd: '/tmp/demo-project',
      });
      execFileSync(process.execPath, [hookFile], {
        input: payload,
        env: { ...process.env, CLAUDE_STATUS_URL: env.CLAUDE_STATUS_URL },
        timeout: 8000,
      });

      const sessions = (await (
        await fetch(`${env.CLAUDE_STATUS_URL}/api/sessions`)
      ).json()) as Array<{ id: string; status: string; project: string }>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('e2e-hook-1');
      expect(sessions[0].status).toBe('idle');
      expect(sessions[0].project).toBe('demo-project');
    } finally {
      child.kill();
    }
  });

  it('init --code claims the pairing code and reuses the existing board', async () => {
    // Simulate the mobile app: it owns a board and creates a pairing code.
    const board = (await (await fetch(`${base}/api/workspaces`, { method: 'POST' })).json()) as {
      token: string;
    };
    const pair = (await (
      await fetch(`${base}/w/${board.token}/pair`, { method: 'POST' })
    ).json()) as { code: string };
    expect(pair.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    await runInit({ url: base, code: pair.code, noQr: true, log });

    const env = readInstalledSettings().env as Record<string, string>;
    expect(env.CLAUDE_STATUS_URL).toBe(`${base}/w/${board.token}`);

    // Code is single-use.
    const second = await fetch(`${base}/api/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pair.code }),
    });
    expect(second.status).toBe(404);
  });

  it('re-running init is idempotent; uninstall removes everything it added', async () => {
    await runInit({ url: base, noQr: true, log });
    await runInit({ url: base, noQr: true, log });
    const hooks = readInstalledSettings().hooks as Record<string, unknown[]>;
    for (const entries of Object.values(hooks)) expect(entries).toHaveLength(1);

    await runUninstall(log);
    const after = readInstalledSettings();
    expect(after).not.toHaveProperty('hooks');
    expect(after).not.toHaveProperty('env');
    expect(fs.existsSync(hookInstallPath())).toBe(false);
    expect(fs.existsSync(`${settingsPath()}.agstatus-backup`)).toBe(true);
  });

  it('aborts without touching an invalid settings.json', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath(), '{ definitely not json');
    await expect(runInit({ url: base, noQr: true, log })).rejects.toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ definitely not json');
  });

  it('fails with a clear error when the server is unreachable', async () => {
    await expect(runInit({ url: 'http://127.0.0.1:9', noQr: true, log })).rejects.toThrow(
      /Could not reach/
    );
    expect(fs.existsSync(settingsPath())).toBe(false);
  });
});
