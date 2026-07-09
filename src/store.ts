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
}

/** Reserved workspace key for single-tenant (legacy) mode. */
export const LEGACY_WS = '_legacy';

export const TOKEN_RE = /^ags_[A-Za-z0-9_-]{32}$/;

const WEBHOOKS_PER_MINUTE = 120;
const LAST_SEEN_WRITE_THROTTLE_MS = 60_000;

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
  private webhookWindows = new Map<string, { windowStart: number; count: number }>();
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
    `);
    this.stmt = {
      insertWs: this.db.prepare(
        'INSERT OR IGNORE INTO workspaces (id, created_at, last_seen_at) VALUES (?, ?, ?)'
      ),
      touchWs: this.db.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?'),
      deleteWs: this.db.prepare('DELETE FROM workspaces WHERE id = ?'),
      upsertSession: this.db.prepare(`
        INSERT INTO sessions (workspace_id, id, name, status, message, project, created_at, updated_at)
        VALUES (@workspaceId, @id, @name, @status, @message, @project, @createdAt, @updatedAt)
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          name = excluded.name, status = excluded.status, message = excluded.message,
          project = excluded.project, updated_at = excluded.updated_at
      `),
      deleteSession: this.db.prepare('DELETE FROM sessions WHERE workspace_id = ? AND id = ?'),
      clearSessions: this.db.prepare('DELETE FROM sessions WHERE workspace_id = ?'),
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
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      });
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
    if (existed) {
      this.stmt.clearSessions?.run(wsId);
      this.stmt.deleteWs?.run(wsId);
    }
    return existed;
  }

  upsertSession(
    wsId: string,
    input: UpsertInput,
    maxSessions: number
  ): { session: Session; evictedId: string | null } {
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
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    return { session, evictedId };
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
