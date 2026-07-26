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
  databaseUrl: '',
  trustProxy: false,
  rateLimit: false,
  maxWorkspaces: 10_000,
  version: 'test',
  apns: null,
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
  return { app: created.app, store: created.store, ready: created.ready, shutdown };
}

/**
 * Postgres-backed tests run only when TEST_DATABASE_URL points at a disposable
 * Postgres server (CI provides one; locally e.g.
 * `docker run -e POSTGRES_PASSWORD=t -p 5433:5432 postgres:16-alpine` and
 * TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:5433/postgres). Without it
 * they are skipped.
 */
export const TEST_PG_URL = process.env.TEST_DATABASE_URL || '';

/**
 * Vitest runs test files in parallel workers, so suites sharing one database
 * would race on schema creation and drop each other's tables mid-test. Each
 * suite therefore gets its own database (created on demand, tables dropped)
 * derived from TEST_DATABASE_URL.
 */
export async function suiteDatabaseUrl(suite: string): Promise<string> {
  if (!TEST_PG_URL) return '';
  const url = new URL(TEST_PG_URL);
  const base = url.pathname.replace(/^\//, '') || 'postgres';
  const dbName = `${base}_${suite}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');

  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString: TEST_PG_URL, max: 1 });
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${dbName}`); // dbName is sanitized above
    }
  } finally {
    await admin.end();
  }
  url.pathname = `/${dbName}`;
  const suiteUrl = url.toString();
  await resetTables(suiteUrl);
  return suiteUrl;
}

/** Drops all AgStatus tables so a Postgres test starts from nothing. */
export async function resetTables(databaseUrl: string): Promise<void> {
  if (!databaseUrl) return;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query('DROP TABLE IF EXISTS workspaces, sessions, devices, usage_limits');
  } finally {
    await pool.end();
  }
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
