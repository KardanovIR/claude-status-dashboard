import crypto from 'crypto';
import type { Pool } from 'pg';

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

/** One entry in a session's timeline: what the agent switched to, and when. */
export interface SessionEvent {
  /** Monotonically increasing per session; stable identity for clients. */
  seq: number;
  status: Status;
  message: string;
  at: number;
}

/** History kept per session; older entries are soft-deleted, newest wins. */
export const MAX_EVENTS_PER_SESSION = 100;

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
  // Per-session timelines (ascending seq), wsId → sessionId → events.
  private events = new Map<string, Map<string, SessionEvent[]>>();
  // Next seq per `${wsId}\n${sessionId}` — spans soft-deleted rows so a
  // restarted server never reuses a primary key.
  private eventSeq = new Map<string, number>();
  // Escrowed pairing codes, keyed by the normalized (dash-less) code.
  private pairCodes = new Map<string, { rawToken: string; expiresAt: number }>();
  private pool: Pool | null = null;
  // Writes are fire-and-forget but strictly ordered: each is chained onto this
  // queue so an upsert can never overtake the delete that preceded it.
  private writeQueue: Promise<void> = Promise.resolve();
  /** Resolves once the schema exists and persisted state is loaded into memory. */
  readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    if (!databaseUrl) {
      this.ready = Promise.resolve();
      return;
    }
    // Lazy require keeps the module optional for pure in-memory use.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = require('pg') as typeof import('pg');
    this.pool = new Pool({ connectionString: databaseUrl, max: 4 });
    // Idle-client errors surface on the pool; a dropped connection must not
    // take the server down (the pool reconnects on the next query).
    this.pool.on('error', (err) => console.warn(`Postgres pool error: ${err.message}`));
    this.ready = this.init();
    this.writeQueue = this.ready.catch(() => undefined);
  }

  private async init(): Promise<void> {
    const pool = this.pool!;
    // Soft deletes only: rows are never removed, deletion sets deleted_at and
    // every load filters on it. Upserts resurrect a flagged row (deleted_at
    // back to NULL) so a re-posted session or re-registered device just works.
    await pool.query(`
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
      CREATE TABLE IF NOT EXISTS session_events (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq BIGINT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        at BIGINT NOT NULL,
        deleted_at BIGINT,
        PRIMARY KEY (workspace_id, session_id, seq)
      );
    `);

    // node-postgres returns BIGINT as string to avoid precision loss; every
    // epoch-ms value here fits a double, so Number() them on the way in.
    const workspaces = await pool.query(
      'SELECT id, created_at, last_seen_at FROM workspaces WHERE deleted_at IS NULL'
    );
    for (const row of workspaces.rows as Array<{ id: string; created_at: string; last_seen_at: string }>) {
      this.workspaces.set(row.id, {
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.last_seen_at),
      });
    }

    const sessions = await pool.query('SELECT * FROM sessions WHERE deleted_at IS NULL');
    for (const row of sessions.rows as Array<Record<string, unknown>>) {
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
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      });
    }

    const devices = await pool.query(
      'SELECT workspace_id, device_token, notify_done, created_at FROM devices WHERE deleted_at IS NULL'
    );
    for (const row of devices.rows as Array<{
      workspace_id: string; device_token: string; notify_done: number; created_at: string;
    }>) {
      let map = this.deviceTokens.get(row.workspace_id);
      if (!map) {
        map = new Map();
        this.deviceTokens.set(row.workspace_id, map);
      }
      map.set(row.device_token, {
        notifyDone: row.notify_done === 1,
        createdAt: Number(row.created_at),
      });
    }

    const usage = await pool.query(
      'SELECT workspace_id, source, windows, updated_at FROM usage_limits WHERE deleted_at IS NULL'
    );
    for (const row of usage.rows as Array<{
      workspace_id: string; source: string; windows: string; updated_at: string;
    }>) {
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
      map.set(row.source, { source: row.source, windows, updatedAt: Number(row.updated_at) });
    }

    const events = await pool.query(
      `SELECT workspace_id, session_id, seq, status, message, at FROM session_events
       WHERE deleted_at IS NULL ORDER BY seq`
    );
    for (const row of events.rows as Array<{
      workspace_id: string; session_id: string; seq: string; status: string; message: string; at: string;
    }>) {
      let ws = this.events.get(row.workspace_id);
      if (!ws) {
        ws = new Map();
        this.events.set(row.workspace_id, ws);
      }
      let list = ws.get(row.session_id);
      if (!list) {
        list = [];
        ws.set(row.session_id, list);
      }
      list.push({
        seq: Number(row.seq),
        status: row.status as Status,
        message: row.message,
        at: Number(row.at),
      });
    }
    // Seq counters continue past soft-deleted rows, so take MAX over all rows.
    const seqs = await pool.query(
      'SELECT workspace_id, session_id, MAX(seq) AS max_seq FROM session_events GROUP BY workspace_id, session_id'
    );
    for (const row of seqs.rows as Array<{ workspace_id: string; session_id: string; max_seq: string }>) {
      this.eventSeq.set(`${row.workspace_id}\n${row.session_id}`, Number(row.max_seq) + 1);
    }
  }

  /**
   * Enqueues a persistence write. Failures are logged, never thrown — memory
   * stays authoritative and the dashboard keeps working through DB outages.
   */
  private exec(text: string, values: unknown[]): void {
    // Capture the pool now: close() nulls the field, but writes already
    // enqueued must still drain against the live pool.
    const pool = this.pool;
    if (!pool) return;
    this.writeQueue = this.writeQueue
      .then(() => pool.query(text, values))
      .then(() => undefined)
      .catch((err: unknown) =>
        console.warn(`Postgres write failed: ${err instanceof Error ? err.message : String(err)}`)
      );
  }

  /** Resolves when every write enqueued so far has been flushed to Postgres. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  private static readonly INSERT_WS =
    `INSERT INTO workspaces (id, created_at, last_seen_at) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET deleted_at = NULL`;

  createWorkspace(): { token: string } {
    const token = 'ags_' + crypto.randomBytes(24).toString('base64url');
    const wsId = hashToken(token);
    const now = Date.now();
    this.workspaces.set(wsId, { createdAt: now, lastSeenAt: now });
    this.exec(Store.INSERT_WS, [wsId, now, now]);
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
      this.exec('UPDATE workspaces SET last_seen_at = $1 WHERE id = $2', [now, wsId]);
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
    this.events.delete(wsId);
    if (existed) {
      const now = Date.now();
      this.exec('UPDATE sessions SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE devices SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE usage_limits SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE session_events SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE workspaces SET deleted_at = $2 WHERE id = $1', [wsId, now]);
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
      if (this.pool && !this.workspaces.has(wsId)) {
        const now = Date.now();
        this.exec(Store.INSERT_WS, [wsId, now, now]);
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
        this.exec(
          'UPDATE sessions SET deleted_at = $3 WHERE workspace_id = $1 AND id = $2',
          [wsId, oldest.id, now]
        );
        this.dropEvents(wsId, oldest.id);
        evictedId = oldest.id;
      }
    }

    map.set(session.id, session);
    // Timeline: record real transitions, not keep-alive re-posts of the same
    // status+message (PreToolUse fires between every tool call).
    if (!prev || prev.status !== session.status || prev.message !== session.message) {
      this.recordEvent(wsId, session.id, session.status, session.message, now);
    }
    this.exec(
      `INSERT INTO sessions (workspace_id, id, name, status, message, project, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (workspace_id, id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status, message = EXCLUDED.message,
         project = EXCLUDED.project, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at,
         deleted_at = NULL`,
      [
        wsId,
        session.id,
        session.name,
        session.status,
        session.message,
        session.project,
        session.source,
        session.createdAt,
        session.updatedAt,
      ]
    );
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
    this.exec(
      `INSERT INTO devices (workspace_id, device_token, platform, notify_done, created_at, updated_at)
       VALUES ($1, $2, 'ios', $3, $4, $5)
       ON CONFLICT (workspace_id, device_token) DO UPDATE SET
         notify_done = EXCLUDED.notify_done, updated_at = EXCLUDED.updated_at, deleted_at = NULL`,
      [wsId, token, notifyDone ? 1 : 0, createdAt, now]
    );
    return 'ok';
  }

  deleteDevice(wsId: string, deviceToken: string): boolean {
    const token = deviceToken.toLowerCase();
    const removed = this.deviceTokens.get(wsId)?.delete(token) ?? false;
    if (removed) {
      this.exec(
        'UPDATE devices SET deleted_at = $3 WHERE workspace_id = $1 AND device_token = $2',
        [wsId, token, Date.now()]
      );
    }
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
      if (this.pool && !this.workspaces.has(wsId)) {
        const now = Date.now();
        this.exec(Store.INSERT_WS, [wsId, now, now]);
      }
    }
    const usage: Usage = { source, windows, updatedAt: Date.now() };
    map.set(source, usage);
    this.exec(
      `INSERT INTO usage_limits (workspace_id, source, windows, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, source) DO UPDATE SET
         windows = EXCLUDED.windows, updated_at = EXCLUDED.updated_at, deleted_at = NULL`,
      [wsId, source, JSON.stringify(windows), usage.updatedAt]
    );
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

  /** Appends a timeline entry, trimming (soft-deleting) beyond the cap. */
  private recordEvent(wsId: string, sessionId: string, status: Status, message: string, at: number): void {
    let ws = this.events.get(wsId);
    if (!ws) {
      ws = new Map();
      this.events.set(wsId, ws);
    }
    let list = ws.get(sessionId);
    if (!list) {
      list = [];
      ws.set(sessionId, list);
    }
    const seqKey = `${wsId}\n${sessionId}`;
    const seq = this.eventSeq.get(seqKey) ?? 0;
    this.eventSeq.set(seqKey, seq + 1);

    list.push({ seq, status, message, at });
    this.exec(
      `INSERT INTO session_events (workspace_id, session_id, seq, status, message, at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, session_id, seq) DO UPDATE SET
         status = EXCLUDED.status, message = EXCLUDED.message, at = EXCLUDED.at, deleted_at = NULL`,
      [wsId, sessionId, seq, status, message, at]
    );
    while (list.length > MAX_EVENTS_PER_SESSION) {
      const trimmed = list.shift()!;
      this.exec(
        'UPDATE session_events SET deleted_at = $4 WHERE workspace_id = $1 AND session_id = $2 AND seq = $3',
        [wsId, sessionId, trimmed.seq, at]
      );
    }
  }

  /** The session's timeline, newest first. Empty for unknown sessions. */
  getHistory(wsId: string, sessionId: string): SessionEvent[] {
    const list = this.events.get(wsId)?.get(sessionId);
    if (!list) return [];
    return [...list].reverse();
  }

  /** Drops a session's timeline (memory now, rows via soft-delete flags). */
  private dropEvents(wsId: string, sessionId: string): void {
    const removed = this.events.get(wsId)?.delete(sessionId) ?? false;
    if (removed) {
      this.exec(
        'UPDATE session_events SET deleted_at = $3 WHERE workspace_id = $1 AND session_id = $2 AND deleted_at IS NULL',
        [wsId, sessionId, Date.now()]
      );
    }
  }

  getSessions(wsId: string): Session[] {
    const map = this.sessions.get(wsId);
    if (!map) return [];
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deleteSession(wsId: string, id: string): boolean {
    const removed = this.sessions.get(wsId)?.delete(id) ?? false;
    if (removed) {
      this.exec(
        'UPDATE sessions SET deleted_at = $3 WHERE workspace_id = $1 AND id = $2',
        [wsId, id, Date.now()]
      );
      this.dropEvents(wsId, id);
    }
    return removed;
  }

  clearSessions(wsId: string): void {
    const map = this.sessions.get(wsId);
    if (map) {
      for (const id of map.keys()) this.dropEvents(wsId, id);
      map.clear();
    }
    this.exec(
      'UPDATE sessions SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL',
      [wsId, Date.now()]
    );
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
          this.exec(
            'UPDATE sessions SET deleted_at = $3 WHERE workspace_id = $1 AND id = $2',
            [wsId, id, Date.now()]
          );
          this.dropEvents(wsId, id);
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

  /** Drains pending writes, then closes the connection pool. */
  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null; // no new writes may be enqueued past this point
    await this.writeQueue;
    await pool?.end();
  }
}
