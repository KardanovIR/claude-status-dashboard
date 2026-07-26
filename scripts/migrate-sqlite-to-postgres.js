#!/usr/bin/env node
/**
 * One-shot migration of an AgStatus SQLite database (pre-v2 storage) into
 * PostgreSQL. Copies workspaces, sessions, devices, and usage limits; rows
 * that already exist in Postgres are left untouched, so re-running is safe.
 *
 *   node scripts/migrate-sqlite-to-postgres.js ./data/agstatus.db \
 *     postgres://agstatus:secret@localhost:5432/agstatus
 *
 * Needs dev dependencies installed (`npm install` — better-sqlite3 only
 * lives in devDependencies now).
 */
'use strict';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    created_at BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    deleted_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    project TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'claude',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT,
    PRIMARY KEY (workspace_id, id)
  );
  CREATE TABLE IF NOT EXISTS devices (
    workspace_id TEXT NOT NULL,
    device_token TEXT NOT NULL,
    platform TEXT NOT NULL,
    notify_done INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT,
    PRIMARY KEY (workspace_id, device_token)
  );
  CREATE TABLE IF NOT EXISTS usage_limits (
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL,
    windows TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT,
    PRIMARY KEY (workspace_id, source)
  );
`;

async function main() {
  const [sqlitePath, databaseUrl] = process.argv.slice(2);
  if (!sqlitePath || !databaseUrl) {
    console.error('Usage: node scripts/migrate-sqlite-to-postgres.js <sqlite-file> <postgres-url>');
    process.exit(1);
  }

  const Database = require('better-sqlite3');
  const { Pool } = require('pg');

  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const counts = { workspaces: 0, sessions: 0, devices: 0, usage_limits: 0 };

  const tableExists = (name) =>
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

  try {
    await pool.query(SCHEMA);

    if (tableExists('workspaces')) {
      for (const r of sqlite.prepare('SELECT * FROM workspaces').iterate()) {
        await pool.query(
          `INSERT INTO workspaces (id, created_at, last_seen_at)
           VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [r.id, r.created_at, r.last_seen_at]
        );
        counts.workspaces += 1;
      }
    }

    if (tableExists('sessions')) {
      for (const r of sqlite.prepare('SELECT * FROM sessions').iterate()) {
        await pool.query(
          `INSERT INTO sessions (workspace_id, id, name, status, message, project, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (workspace_id, id) DO NOTHING`,
          [
            r.workspace_id, r.id, r.name, r.status, r.message, r.project,
            r.source || 'claude', // pre-source SQLite schemas have no column
            r.created_at, r.updated_at,
          ]
        );
        counts.sessions += 1;
      }
    }

    if (tableExists('devices')) {
      for (const r of sqlite.prepare('SELECT * FROM devices').iterate()) {
        await pool.query(
          `INSERT INTO devices (workspace_id, device_token, platform, notify_done, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (workspace_id, device_token) DO NOTHING`,
          [r.workspace_id, r.device_token, r.platform, r.notify_done, r.created_at, r.updated_at]
        );
        counts.devices += 1;
      }
    }

    if (tableExists('usage_limits')) {
      for (const r of sqlite.prepare('SELECT * FROM usage_limits').iterate()) {
        await pool.query(
          `INSERT INTO usage_limits (workspace_id, source, windows, updated_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, source) DO NOTHING`,
          [r.workspace_id, r.source, r.windows, r.updated_at]
        );
        counts.usage_limits += 1;
      }
    }
  } finally {
    sqlite.close();
    await pool.end();
  }

  console.log(
    `Migrated ${counts.workspaces} workspaces, ${counts.sessions} sessions, ` +
    `${counts.devices} devices, ${counts.usage_limits} usage rows.`
  );
}

main().catch((err) => {
  console.error(`Migration failed: ${err.message}`);
  process.exit(1);
});
