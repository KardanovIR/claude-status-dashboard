import { afterEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp, type AppConfig } from '../src/app';

export type TestApp = ReturnType<typeof createApp>;

/**
 * Defaults for tests: multi-tenant, in-memory store, no rate limiting,
 * no TTL sweeping, fixed public URL so generated URLs are assertable.
 */
export const TEST_DEFAULTS: AppConfig = {
  multiTenant: true,
  webhookSecret: '',
  publicUrl: 'http://test.local',
  sessionTtlMs: 0,
  dbPath: '',
  trustProxy: false,
  rateLimit: false,
  maxWorkspaces: 10_000,
  version: 'test',
};

// Every app created via makeApp() gets shut down after the test that created
// it, so timers/DB handles never leak across tests. Registered at import time,
// which attaches the hook to the importing test file (vitest isolates files,
// so each file gets its own registry).
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      fn();
    } catch {
      // already shut down (e.g. test called shutdown() itself) — fine
    }
  }
});

/**
 * Create an app with test defaults. The returned shutdown() is idempotent and
 * is also invoked automatically after the current test.
 */
export function makeApp(overrides: Partial<AppConfig> = {}): TestApp {
  const created = createApp({ ...TEST_DEFAULTS, ...overrides });
  let done = false;
  const shutdown = (): void => {
    if (done) return;
    done = true;
    created.shutdown();
  };
  cleanups.push(shutdown);
  return { app: created.app, store: created.store, shutdown };
}

/** Create a workspace via the public API and return its raw token. */
export async function createWorkspace(app: Express): Promise<string> {
  const res = await request(app).post('/api/workspaces').expect(201);
  return res.body.token as string;
}

/** Minimal valid webhook body for a given session id. */
export function webhookBody(
  sessionId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { session_id: sessionId, status: 'coding', ...extra };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
