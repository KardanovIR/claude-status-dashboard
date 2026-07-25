import crypto from 'crypto';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';

export const STATUSES = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export interface Session {
  id: string;
  name: string;
  status: Status;
  message: string;
  project: string;
  /** Agent kind that owns the session ("claude", "codex", …). */
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertInput {
  id: string;
  status: Status;
  // undefined = carry the previous value forward (v1 semantics)
  name?: string;
  message?: string;
  project?: string;
  source?: string;
}

export interface Device {
  deviceToken: string;
  notifyDone: boolean;
}

/** One plan-limit window (e.g. the 5-hour session window or a weekly cap). */
export interface UsageWindow {
  id: string;
  label: string;
  /** Percent of the limit consumed, 0–100. */
  usedPct: number;
  /** Epoch ms when the window resets; null when unknown. */
  resetsAt: number | null;
}

/** Plan usage reported by an agent's hook, one entry per source ("claude", …). */
export interface Usage {
  source: string;
  windows: UsageWindow[];
  updatedAt: number;
}

/** Usage older than this is dropped from reads — stale percentages mislead. */
export const USAGE_TTL_MS = 24 * 60 * 60 * 1000;

/** Reserved workspace key for single-tenant (legacy) mode. */
export const LEGACY_WS = '_legacy';

export const TOKEN_RE = /^ags_[A-Za-z0-9_-]{32}$/;

const WEBHOOKS_PER_MINUTE = 120;
const LAST_SEEN_WRITE_THROTTLE_MS = 60_000;
const MAX_DEVICES_PER_WORKSPACE = 10;

// Pairing codes: short-lived, single-use, in-memory only (never SQLite).
// No I/L/O/0/1 to keep the codes unambiguous when read aloud or typed.
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LENGTH = 8;
export const PAIR_CODE_TTL_MS = 15 * 60 * 1000;
const MAX_PAIR_CODES_PER_WORKSPACE = 3;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

interface WorkspaceMeta {
  createdAt: number;
  lastSeenAt: number;
}

export class Store {
  private sessions = new Map<string, Map<string, Session>>();
  private workspaces = new Map<string, WorkspaceMeta>();
  // Push-notification device tokens per workspace (token → notifyDone + createdAt).
  private deviceTokens = new Map<string, Map<string, { notifyDone: boolean; createdAt: number }>>();
  private webhookWindows = new Map<string, { windowStart: number; count: number }>();
  // Plan-limit usage per workspace, keyed by source ("claude", "codex", …).
  private usageBySource = new Map<string, Map<string, Usage>>();
  // Escrowed pairing codes, keyed by the normalized (dash-less) code.
  private pairCodes = new Map<string, { rawToken: string; expiresAt: number }>();
  private db: SqliteDatabase | null = null;
  private stmt: Record<string, Statement> = {};

  constructor(dbPath: string) {
    if (!dbPath) return;
    // Lazy require keeps the native module optional for pure in-memory use.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        project TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'claude',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS devices (
        workspace_id TEXT NOT NULL,
        device_token TEXT NOT NULL,
        platform TEXT NOT NULL,
        notify_done INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, device_token)
      );
      CREATE TABLE IF NOT EXISTS usage_limits (
        workspace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        windows TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, source)
      );
    `);
    // Databases created before the source column existed: add it in place.
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'claude'");
    } catch {
      // column already exists
    }
    this.stmt = {
      insertWs: this.db.prepare(
        'INSERT OR IGNORE INTO workspaces (id, created_at, last_seen_at) VALUES (?, ?, ?)'
      ),
      touchWs: this.db.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?'),
      deleteWs: this.db.prepare('DELETE FROM workspaces WHERE id = ?'),
      upsertSession: this.db.prepare(`
        INSERT INTO sessions (workspace_id, id, name, status, message, project, source, created_at, updated_at)
        VALUES (@workspaceId, @id, @name, @status, @message, @project, @source, @createdAt, @updatedAt)
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          name = excluded.name, status = excluded.status, message = excluded.message,
          project = excluded.project, source = excluded.source, updated_at = excluded.updated_at
      `),
      deleteSession: this.db.prepare('DELETE FROM sessions WHERE workspace_id = ? AND id = ?'),
      clearSessions: this.db.prepare('DELETE FROM sessions WHERE workspace_id = ?'),
      upsertDevice: this.db.prepare(`
        INSERT INTO devices (workspace_id, device_token, platform, notify_done, created_at, updated_at)
        VALUES (?, ?, 'ios', ?, ?, ?)
        ON CONFLICT (workspace_id, device_token) DO UPDATE SET
          notify_done = excluded.notify_done, updated_at = excluded.updated_at
      `),
      deleteDevice: this.db.prepare('DELETE FROM devices WHERE workspace_id = ? AND device_token = ?'),
      clearDevices: this.db.prepare('DELETE FROM devices WHERE workspace_id = ?'),
      upsertUsage: this.db.prepare(`
        INSERT INTO usage_limits (workspace_id, source, windows, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, source) DO UPDATE SET
          windows = excluded.windows, updated_at = excluded.updated_at
      `),
      clearUsage: this.db.prepare('DELETE FROM usage_limits WHERE workspace_id = ?'),
    };
    for (const row of this.db
      .prepare('SELECT id, created_at, last_seen_at FROM workspaces')
      .all() as Array<{ id: string; created_at: number; last_seen_at: number }>) {
      this.workspaces.set(row.id, { createdAt: row.created_at, lastSeenAt: row.last_seen_at });
    }
    for (const row of this.db
      .prepare('SELECT * FROM sessions')
      .all() as Array<Record<string, unknown>>) {
      const wsId = row.workspace_id as string;
      let map = this.sessions.get(wsId);
      if (!map) {
        map = new Map();
        this.sessions.set(wsId, map);
      }
      map.set(row.id as string, {
        id: row.id as string,
        name: row.name as string,
        status: row.status as Status,
        message: row.message as string,
        project: row.project as string,
        source: (row.source as string) || 'claude',
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      });
    }
    for (const row of this.db
      .prepare('SELECT workspace_id, device_token, notify_done, created_at FROM devices')
      .all() as Array<{ workspace_id: string; device_token: string; notify_done: number; created_at: number }>) {
      let map = this.deviceTokens.get(row.workspace_id);
      if (!map) {
        map = new Map();
        this.deviceTokens.set(row.workspace_id, map);
      }
      map.set(row.device_token, {
        notifyDone: row.notify_done === 1,
        createdAt: row.created_at,
      });
    }
    for (const row of this.db
      .prepare('SELECT workspace_id, source, windows, updated_at FROM usage_limits')
      .all() as Array<{ workspace_id: string; source: string; windows: string; updated_at: number }>) {
      let windows: UsageWindow[];
      try {
        windows = JSON.parse(row.windows) as UsageWindow[];
      } catch {
        continue; // corrupt row — skip, it will be overwritten on the next report
      }
      let map = this.usageBySource.get(row.workspace_id);
      if (!map) {
        map = new Map();
        this.usageBySource.set(row.workspace_id, map);
      }
      map.set(row.source, { source: row.source, windows, updatedAt: row.updated_at });
    }
  }

  createWorkspace(): { token: string } {
    const token = 'ags_' + crypto.randomBytes(24).toString('base64url');
    const wsId = hashToken(token);
    const now = Date.now();
    this.workspaces.set(wsId, { createdAt: now, lastSeenAt: now });
    this.stmt.insertWs?.run(wsId, now, now);
    return { token };
  }

  /** Returns the workspace id for a valid, known token; null otherwise. */
  resolveToken(token: string): string | null {
    if (!TOKEN_RE.test(token)) return null;
    const wsId = hashToken(token);
    const meta = this.workspaces.get(wsId);
    if (!meta) return null;
    const now = Date.now();
    if (now - meta.lastSeenAt > LAST_SEEN_WRITE_THROTTLE_MS) {
      meta.lastSeenAt = now;
      this.stmt.touchWs?.run(now, wsId);
    }
    return wsId;
  }

  hasWorkspace(wsId: string): boolean {
    return this.workspaces.has(wsId);
  }

  workspaceCount(): number {
    return this.workspaces.size;
  }

  deleteWorkspace(wsId: string): boolean {
    const existed = this.workspaces.delete(wsId);
    this.sessions.delete(wsId);
    this.webhookWindows.delete(wsId);
    this.deviceTokens.delete(wsId);
    this.usageBySource.delete(wsId);
    if (existed) {
      this.stmt.clearSessions?.run(wsId);
      this.stmt.clearDevices?.run(wsId);
      this.stmt.clearUsage?.run(wsId);
      this.stmt.deleteWs?.run(wsId);
    }
    return existed;
  }

  upsertSession(
    wsId: string,
    input: UpsertInput,
    maxSessions: number
  ): { session: Session; evictedId: string | null; prevStatus: Status | null } {
    let map = this.sessions.get(wsId);
    if (!map) {
      map = new Map();
      this.sessions.set(wsId, map);
      // Legacy mode has no createWorkspace() call; keep the DB row present so
      // persisted sessions satisfy the workspace_id relationship.
      if (this.db && !this.workspaces.has(wsId)) {
        const now = Date.now();
        this.stmt.insertWs.run(wsId, now, now);
      }
    }

    const now = Date.now();
    const prev = map.get(input.id);
    const session: Session = {
      id: input.id,
      name: input.name !== undefined ? input.name || prev?.name || input.id : prev?.name || input.id,
      status: input.status,
      message: input.message !== undefined ? input.message : prev?.message ?? '',
      project: input.project !== undefined ? input.project : prev?.project ?? '',
      source: input.source ?? prev?.source ?? 'claude',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };

    let evictedId: string | null = null;
    if (!prev && map.size >= maxSessions) {
      let oldest: Session | null = null;
      for (const s of map.values()) {
        if (!oldest || s.updatedAt < oldest.updatedAt) oldest = s;
      }
      if (oldest) {
        map.delete(oldest.id);
        this.stmt.deleteSession?.run(wsId, oldest.id);
        evictedId = oldest.id;
      }
    }

    map.set(session.id, session);
    this.stmt.upsertSession?.run({
      workspaceId: wsId,
      id: session.id,
      name: session.name,
      status: session.status,
      message: session.message,
      project: session.project,
      source: session.source,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    return { session, evictedId, prevStatus: prev?.status ?? null };
  }

  /**
   * Registers (or updates) a push-notification device token. Tokens are
   * normalized to lowercase. Returns 'cap' only when a NEW device would exceed
   * the per-workspace limit; updates to existing devices always succeed.
   */
  upsertDevice(wsId: string, deviceToken: string, notifyDone: boolean): 'ok' | 'cap' {
    const token = deviceToken.toLowerCase();
    let map = this.deviceTokens.get(wsId);
    if (!map) {
      map = new Map();
      this.deviceTokens.set(wsId, map);
    }
    const existing = map.get(token);
    if (!existing && map.size >= MAX_DEVICES_PER_WORKSPACE) return 'cap';
    const now = Date.now();
    const createdAt = existing?.createdAt ?? now;
    map.set(token, { notifyDone, createdAt });
    this.stmt.upsertDevice?.run(wsId, token, notifyDone ? 1 : 0, createdAt, now);
    return 'ok';
  }

  deleteDevice(wsId: string, deviceToken: string): boolean {
    const token = deviceToken.toLowerCase();
    const removed = this.deviceTokens.get(wsId)?.delete(token) ?? false;
    if (removed) this.stmt.deleteDevice?.run(wsId, token);
    return removed;
  }

  devices(wsId: string): Device[] {
    const map = this.deviceTokens.get(wsId);
    if (!map) return [];
    return Array.from(map, ([deviceToken, d]) => ({ deviceToken, notifyDone: d.notifyDone }));
  }

  deviceCount(wsId: string): number {
    return this.deviceTokens.get(wsId)?.size ?? 0;
  }

  /** Stores the latest plan usage for one source and returns the stamped record. */
  setUsage(wsId: string, source: string, windows: UsageWindow[]): Usage {
    let map = this.usageBySource.get(wsId);
    if (!map) {
      map = new Map();
      this.usageBySource.set(wsId, map);
      // Same legacy-mode concern as upsertSession: keep the workspace row
      // present so persisted usage satisfies the workspace_id relationship.
      if (this.db && !this.workspaces.has(wsId)) {
        const now = Date.now();
        this.stmt.insertWs.run(wsId, now, now);
      }
    }
    const usage: Usage = { source, windows, updatedAt: Date.now() };
    map.set(source, usage);
    this.stmt.upsertUsage?.run(wsId, source, JSON.stringify(windows), usage.updatedAt);
    return usage;
  }

  /** Current plan usage for a workspace, freshest first. Stale entries are dropped. */
  getUsage(wsId: string): Usage[] {
    const map = this.usageBySource.get(wsId);
    if (!map) return [];
    const cutoff = Date.now() - USAGE_TTL_MS;
    return Array.from(map.values())
      .filter((u) => u.updatedAt >= cutoff)
      .sort((a, b) => a.source.localeCompare(b.source));
  }

  getSessions(wsId: string): Session[] {
    const map = this.sessions.get(wsId);
    if (!map) return [];
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deleteSession(wsId: string, id: string): boolean {
    const removed = this.sessions.get(wsId)?.delete(id) ?? false;
    if (removed) this.stmt.deleteSession?.run(wsId, id);
    return removed;
  }

  clearSessions(wsId: string): void {
    this.sessions.get(wsId)?.clear();
    this.stmt.clearSessions?.run(wsId);
  }

  /** Fixed-window webhook rate limit per workspace. */
  allowWebhook(wsId: string): boolean {
    const now = Date.now();
    const win = this.webhookWindows.get(wsId);
    if (!win || now - win.windowStart >= 60_000) {
      this.webhookWindows.set(wsId, { windowStart: now, count: 1 });
      return true;
    }
    win.count += 1;
    return win.count <= WEBHOOKS_PER_MINUTE;
  }

  /**
   * Escrows rawToken under a fresh single-use pairing code (returned WITHOUT
   * the display dash). Null when the workspace already has 3 outstanding
   * unexpired codes. The raw token is the workspace identity here, so the
   * cap counts codes escrowing the same rawToken.
   */
  createPairCode(rawToken: string): string | null {
    this.sweepExpiredPairCodes();
    let outstanding = 0;
    for (const entry of this.pairCodes.values()) {
      if (entry.rawToken === rawToken) outstanding += 1;
    }
    if (outstanding >= MAX_PAIR_CODES_PER_WORKSPACE) return null;

    let code: string;
    do {
      code = '';
      for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
        // randomInt uses rejection sampling, so no modulo bias.
        code += PAIR_CODE_ALPHABET[crypto.randomInt(PAIR_CODE_ALPHABET.length)];
      }
    } while (this.pairCodes.has(code)); // 31^8 keyspace; collisions are ~impossible but cheap to rule out
    this.pairCodes.set(code, { rawToken, expiresAt: Date.now() + PAIR_CODE_TTL_MS });
    return code;
  }

  /**
   * Consumes a pairing code (normalized: uppercase, dashes/whitespace
   * stripped) and returns the escrowed token. Null for unknown or expired
   * codes; either way the code is gone afterwards (single-use).
   */
  claimPairCode(code: string): { rawToken: string } | null {
    const normalized = code.toUpperCase().replace(/[-\s]/g, '');
    const entry = this.pairCodes.get(normalized);
    if (!entry) return null;
    this.pairCodes.delete(normalized);
    if (Date.now() >= entry.expiresAt) return null;
    return { rawToken: entry.rawToken };
  }

  /** Drops expired pairing codes. Also runs lazily inside create/claim. */
  sweepExpiredPairCodes(): void {
    const now = Date.now();
    for (const [code, entry] of this.pairCodes) {
      if (now >= entry.expiresAt) this.pairCodes.delete(code);
    }
  }

  /** Removes sessions not updated within ttlMs. Returns what was removed, for broadcasting. */
  sweepExpiredSessions(ttlMs: number): Array<{ wsId: string; id: string }> {
    const cutoff = Date.now() - ttlMs;
    const removed: Array<{ wsId: string; id: string }> = [];
    for (const [wsId, map] of this.sessions) {
      for (const [id, s] of map) {
        if (s.updatedAt < cutoff) {
          map.delete(id);
          this.stmt.deleteSession?.run(wsId, id);
          removed.push({ wsId, id });
        }
      }
    }
    return removed;
  }

  /** Deletes workspaces idle beyond maxIdleMs. Returns their ids so SSE streams can be closed. */
  sweepIdleWorkspaces(maxIdleMs: number): string[] {
    const cutoff = Date.now() - maxIdleMs;
    const deleted: string[] = [];
    for (const [wsId, meta] of this.workspaces) {
      if (meta.lastSeenAt < cutoff) {
        this.deleteWorkspace(wsId);
        deleted.push(wsId);
      }
    }
    return deleted;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
