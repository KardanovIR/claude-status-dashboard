import crypto from 'crypto';
import type { Pool } from 'pg';

export const STATUSES = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'] as const;
export type Status = (typeof STATUSES)[number];

/** Apps a session can be hosted in; anything else the hook reports becomes 'other'. */
export const HOST_SLUGS = [
  'agterm', 'iterm2', 'kitty', 'wezterm', 'terminal', 'ghostty', 'alacritty', 'warp',
  'vscode', 'cursor', 'windsurf', 'jetbrains', 'zed', 'claude-desktop', 'codex-desktop',
  'herdr', 'tmux', 'zellij', 'screen', 'windows-terminal', 'other',
] as const;
export type HostSlug = (typeof HOST_SLUGS)[number];

export const HOST_KINDS = ['terminal', 'multiplexer', 'ide', 'desktop-app', 'unknown'] as const;
export type HostKind = (typeof HOST_KINDS)[number];

/**
 * Where a session runs, as far as the board needs to know: a label for the
 * card and a per-board machine id to route a focus command to. Opt-in on the
 * hook side, so most sessions have none. Never a path, tty, pid or bundle id.
 */
export interface Host {
  machine: { id: string; name: string };
  app: { slug: HostSlug; name: string; kind: HostKind };
}

// A per-board hash the hook derives from its machine id, never the raw id.
export const MACHINE_ID_RE = /^[0-9a-f]{32}$/;
// The listener's credential for that id: the hash the id is itself derived
// from (id = sha256(key)[0..32]). Every board viewer sees the id; only the
// machine holds the key, so a viewer cannot claim, ack or pose as it.
export const MACHINE_KEY_RE = /^[0-9a-f]{64}$/;
export const machineIdForKey = (key: string): string =>
  crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);

/**
 * `sha256(key)[0..32] === machineId`, compared without an early exit.
 * Both sides are public-derivable (every viewer sees the id, and anyone can
 * hash a key they already hold), so the timing channel a `!==` opens here
 * leaks nothing an attacker could not compute offline — but this is the one
 * check standing between a viewer and a machine's stream, and a reader
 * should not have to reconstruct that argument to trust it.
 */
export const machineKeyMatches = (key: string, machineId: string): boolean => {
  const a = Buffer.from(machineIdForKey(key));
  const b = Buffer.from(machineId);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const HOST_NAME_MAX = 32;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

const isHostSlug = (s: unknown): s is HostSlug =>
  typeof s === 'string' && (HOST_SLUGS as readonly string[]).includes(s);
const isHostKind = (s: unknown): s is HostKind =>
  typeof s === 'string' && (HOST_KINDS as readonly string[]).includes(s);

/** A host label: control characters stripped, trimmed, truncated; blank or non-string → fallback. */
const hostName = (v: unknown, fallback: string): string => {
  const s = typeof v === 'string' ? v.replace(CONTROL_CHARS_RE, '').trim().slice(0, HOST_NAME_MAX) : '';
  return s || fallback;
};

/**
 * Rebuilds a Host key by key from whatever came in — a webhook body or a
 * stored column — so the board only ever sees these six values. null unless
 * raw is a plain object whose machine.id is well-formed; unknown slugs and
 * kinds are downgraded, names are cleaned and defaulted, every other key is
 * dropped.
 */
export function normalizeHost(raw: unknown): Host | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  const machine = (typeof h.machine === 'object' && h.machine !== null ? h.machine : {}) as Record<string, unknown>;
  const app = (typeof h.app === 'object' && h.app !== null ? h.app : {}) as Record<string, unknown>;
  if (typeof machine.id !== 'string' || !MACHINE_ID_RE.test(machine.id)) return null;
  const slug = isHostSlug(app.slug) ? app.slug : 'other';
  return {
    machine: { id: machine.id, name: hostName(machine.name, 'Machine') },
    app: { slug, name: hostName(app.name, slug), kind: isHostKind(app.kind) ? app.kind : 'unknown' },
  };
}

export interface Session {
  id: string;
  name: string;
  status: Status;
  message: string;
  project: string;
  /** Agent kind that owns the session ("claude", "codex", …). */
  source: string;
  /** Absent or null = the hook did not report a host. Stored as null. */
  host?: Host | null;
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
  // undefined = carry forward, null = clear (the hook opted out), object = set
  host?: Host | null;
}

export interface Device {
  deviceToken: string;
  notifyDone: boolean;
  /**
   * APNs endpoint this token last authenticated against. A development build's
   * token only works against the sandbox and an App Store build's only against
   * production, and nothing in the token says which — so it is learned on
   * first delivery and remembered. Null until then.
   */
  apnsServer: string | null;
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

/** One recorded reading of a limit window's utilization. */
export interface UsagePoint {
  at: number; // epoch milliseconds
  usedPct: number;
}

/** Tokens one agent spent on one project during one UTC day. */
export interface ProjectDay {
  source: string;
  project: string;
  day: string; // YYYY-MM-DD, UTC
  tokens: number;
}

export const COMMAND_TYPES = ['focus', 'resume'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_RESULTS = ['focused', 'activated', 'selected', 'resumed', 'failed'] as const;
export type CommandResult = (typeof COMMAND_RESULTS)[number];

/** How far the listener got: the exact pane, a tab, a window, only the app, or a Codex thread. */
export const COMMAND_REACHES = ['pane', 'tab', 'window', 'app', 'thread'] as const;
export type CommandReach = (typeof COMMAND_REACHES)[number];

/** Why a command failed. An enum on purpose: a free-text reason would leak cwd/tty/stderr to every viewer. */
export const COMMAND_REASONS = [
  'no-record', 'remote', 'not-running', 'app-not-running', 'consent-needed', 'mux-detached',
  'ambiguous', 'unsupported-host', 'bad-record', 'respawn-failed', 'unsupported-type',
  'superseded', 'expired',
] as const;
export type CommandReason = (typeof COMMAND_REASONS)[number];

export type CommandState = 'pending' | 'claimed' | 'done' | 'expired';

/**
 * A tap on a card, waiting for the listener on the machine that hosts the
 * session. Carries only ids: the listener derives every action from its own
 * local record. In memory only (like pairing codes) — a two-minute object
 * must not become a permanent soft-deleted row, and a restart just lets the
 * phone time out.
 */
export interface Command {
  id: string;
  wsId: string;
  type: CommandType;
  sessionId: string;
  machineId: string;
  state: CommandState;
  createdAt: number;
  expiresAt: number;
  claimedAt?: number;
  doneAt?: number;
  result?: CommandResult;
  reach?: CommandReach;
  reason?: CommandReason;
}

export type ClaimError = 'not_found' | 'wrong_machine' | 'already_claimed' | 'expired';
export type AckError = 'not_found' | 'wrong_machine' | 'not_claimed' | 'already_done' | 'expired';

/** How far back the usage detail view may look. */
export const MAX_HISTORY_DAYS = 90;
/** Points held in memory per (source, window) — a plan limit moves slowly. */
const MAX_USAGE_POINTS = 2000;

/** The UTC day an instant falls in, as YYYY-MM-DD. */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

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
const COMMANDS_PER_MINUTE = 10;
// Every listener connect is broadcast to every viewer; a reconnect loop must not flood them.
const LISTENER_CONNECTS_PER_MINUTE = 30;
export const MAX_PENDING_COMMANDS_PER_WORKSPACE = 10;
/** Done and expired commands stay readable this long, so a phone that backgrounded can still poll them. */
export const COMMAND_GRACE_MS = 10 * 60 * 1000;
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
  private deviceTokens = new Map<
    string,
    Map<string, { notifyDone: boolean; createdAt: number; apnsServer: string | null }>
  >();
  private webhookWindows = new Map<string, { windowStart: number; count: number }>();
  // Plan-limit usage per workspace, keyed by source ("claude", "codex", …).
  private usageBySource = new Map<string, Map<string, Usage>>();
  // Per-session timelines (ascending seq), wsId → sessionId → events.
  private events = new Map<string, Map<string, SessionEvent[]>>();
  // Limit utilization over time, wsId → `${source}\n${windowId}` → ascending points.
  private usagePoints = new Map<string, Map<string, UsagePoint[]>>();
  // Token spend per agent and project, wsId → `${source}\n${project}\n${day}` → row.
  private projectDays = new Map<string, Map<string, ProjectDay>>();
  // Next seq per `${wsId}\n${sessionId}` — spans soft-deleted rows so a
  // restarted server never reuses a primary key.
  private eventSeq = new Map<string, number>();
  // Escrowed pairing codes, keyed by the normalized (dash-less) code.
  private pairCodes = new Map<string, { rawToken: string; expiresAt: number }>();
  // Focus commands, wsId → id → command; in memory only, swept like pair codes.
  private commands = new Map<string, Map<string, Command>>();
  private commandWindows = new Map<string, { windowStart: number; count: number }>();
  private listenerWindows = new Map<string, { windowStart: number; count: number }>();
  // Commands the server finished itself — expired (by the sweep or lazily on
  // read) or cancelled with their session — and has not yet handed to app.ts,
  // so each gets exactly one command_ack broadcast.
  private unannounced: Command[] = [];
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
        host TEXT,
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
        apns_server TEXT,
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
      CREATE TABLE IF NOT EXISTS usage_history (
        workspace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        window_id TEXT NOT NULL,
        at BIGINT NOT NULL,
        used_pct DOUBLE PRECISION NOT NULL,
        deleted_at BIGINT,
        PRIMARY KEY (workspace_id, source, window_id, at)
      );
      CREATE TABLE IF NOT EXISTS usage_project_days (
        workspace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        project TEXT NOT NULL,
        day TEXT NOT NULL,
        tokens BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        deleted_at BIGINT,
        PRIMARY KEY (workspace_id, source, project, day)
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

    // Databases created before these columns existed.
    await pool.query('ALTER TABLE devices ADD COLUMN IF NOT EXISTS apns_server TEXT');
    await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS host TEXT');

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
      // Re-validated on the way in: a column that is not JSON, or is JSON of
      // the wrong shape, loads as no host; the next post with one overwrites it.
      let host: Host | null = null;
      try {
        if (typeof row.host === 'string') host = normalizeHost(JSON.parse(row.host));
      } catch {
        // not JSON at all
      }
      map.set(row.id as string, {
        id: row.id as string,
        name: row.name as string,
        status: row.status as Status,
        message: row.message as string,
        project: row.project as string,
        source: (row.source as string) || 'claude',
        host,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      });
    }

    const devices = await pool.query(
      'SELECT workspace_id, device_token, notify_done, created_at, apns_server FROM devices WHERE deleted_at IS NULL'
    );
    for (const row of devices.rows as Array<{
      workspace_id: string; device_token: string; notify_done: number; created_at: string;
      apns_server: string | null;
    }>) {
      let map = this.deviceTokens.get(row.workspace_id);
      if (!map) {
        map = new Map();
        this.deviceTokens.set(row.workspace_id, map);
      }
      map.set(row.device_token, {
        notifyDone: row.notify_done === 1,
        createdAt: Number(row.created_at),
        apnsServer: row.apns_server ?? null,
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

    // Only the retained window is loaded: older points are left on disk rather
    // than deleted, per the soft-delete rule, but never reach memory.
    const historySince = Date.now() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const points = await pool.query(
      `SELECT workspace_id, source, window_id, at, used_pct FROM usage_history
       WHERE deleted_at IS NULL AND at >= $1 ORDER BY at`,
      [historySince]
    );
    for (const row of points.rows as Array<{
      workspace_id: string; source: string; window_id: string; at: string; used_pct: string;
    }>) {
      let ws = this.usagePoints.get(row.workspace_id);
      if (!ws) {
        ws = new Map();
        this.usagePoints.set(row.workspace_id, ws);
      }
      const key = `${row.source}\n${row.window_id}`;
      let list = ws.get(key);
      if (!list) {
        list = [];
        ws.set(key, list);
      }
      list.push({ at: Number(row.at), usedPct: Number(row.used_pct) });
    }
    for (const ws of this.usagePoints.values()) {
      for (const list of ws.values()) {
        if (list.length > MAX_USAGE_POINTS) list.splice(0, list.length - MAX_USAGE_POINTS);
      }
    }

    const projectDays = await pool.query(
      `SELECT workspace_id, source, project, day, tokens FROM usage_project_days
       WHERE deleted_at IS NULL AND day >= $1`,
      [dayKey(historySince)]
    );
    for (const row of projectDays.rows as Array<{
      workspace_id: string; source: string; project: string; day: string; tokens: string;
    }>) {
      let ws = this.projectDays.get(row.workspace_id);
      if (!ws) {
        ws = new Map();
        this.projectDays.set(row.workspace_id, ws);
      }
      ws.set(`${row.source}\n${row.project}\n${row.day}`, {
        source: row.source,
        project: row.project,
        day: row.day,
        tokens: Number(row.tokens),
      });
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
    this.usagePoints.delete(wsId);
    this.projectDays.delete(wsId);
    this.commands.delete(wsId);
    this.commandWindows.delete(wsId);
    this.listenerWindows.delete(wsId);
    if (existed) {
      const now = Date.now();
      this.exec('UPDATE sessions SET deleted_at = $2, host = NULL WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE devices SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE usage_limits SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE session_events SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE usage_history SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
      this.exec('UPDATE usage_project_days SET deleted_at = $2 WHERE workspace_id = $1 AND deleted_at IS NULL', [wsId, now]);
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
      // Always a key (null, never undefined) so the wire shape is stable.
      host: input.host !== undefined ? input.host : prev?.host ?? null,
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
          'UPDATE sessions SET deleted_at = $3, host = NULL WHERE workspace_id = $1 AND id = $2',
          [wsId, oldest.id, now]
        );
        this.dropEvents(wsId, oldest.id);
        this.cancelCommands(wsId, oldest.id);
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
      `INSERT INTO sessions (workspace_id, id, name, status, message, project, source, host, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (workspace_id, id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status, message = EXCLUDED.message,
         project = EXCLUDED.project, source = EXCLUDED.source, host = EXCLUDED.host,
         updated_at = EXCLUDED.updated_at, deleted_at = NULL`,
      [
        wsId,
        session.id,
        session.name,
        session.status,
        session.message,
        session.project,
        session.source,
        session.host ? JSON.stringify(session.host) : null,
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
    // Re-registering keeps the learned endpoint: the same token on the same
    // build still belongs to the same APNs environment.
    map.set(token, { notifyDone, createdAt, apnsServer: existing?.apnsServer ?? null });
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
    return Array.from(map, ([deviceToken, d]) => ({
      deviceToken,
      notifyDone: d.notifyDone,
      apnsServer: d.apnsServer,
    }));
  }

  /**
   * Records which APNs endpoint accepted this token, so later pushes go
   * straight there instead of rediscovering it. No-op for unknown devices.
   */
  setDeviceApnsServer(wsId: string, deviceToken: string, server: string): void {
    const token = deviceToken.toLowerCase();
    const entry = this.deviceTokens.get(wsId)?.get(token);
    if (!entry || entry.apnsServer === server) return;
    entry.apnsServer = server;
    this.exec(
      'UPDATE devices SET apns_server = $3 WHERE workspace_id = $1 AND device_token = $2',
      [wsId, token, server]
    );
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
    this.recordUsagePoints(wsId, source, windows, usage.updatedAt);
    this.exec(
      `INSERT INTO usage_limits (workspace_id, source, windows, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, source) DO UPDATE SET
         windows = EXCLUDED.windows, updated_at = EXCLUDED.updated_at, deleted_at = NULL`,
      [wsId, source, JSON.stringify(windows), usage.updatedAt]
    );
    return usage;
  }

  /**
   * Appends a point for every window whose utilization actually moved. A plan
   * limit is a step function and reports arrive every few minutes, mostly
   * repeating the last value, so recording only the changes keeps the series
   * small without losing its shape.
   */
  private recordUsagePoints(wsId: string, source: string, windows: UsageWindow[], at: number): void {
    let ws = this.usagePoints.get(wsId);
    if (!ws) {
      ws = new Map();
      this.usagePoints.set(wsId, ws);
    }
    for (const w of windows) {
      const key = `${source}\n${w.id}`;
      let list = ws.get(key);
      if (!list) {
        list = [];
        ws.set(key, list);
      }
      const prev = list[list.length - 1];
      if (prev && prev.usedPct === w.usedPct) continue;
      list.push({ at, usedPct: w.usedPct });
      if (list.length > MAX_USAGE_POINTS) list.splice(0, list.length - MAX_USAGE_POINTS);
      this.exec(
        `INSERT INTO usage_history (workspace_id, source, window_id, at, used_pct)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, source, window_id, at) DO NOTHING`,
        [wsId, source, w.id, at, w.usedPct]
      );
    }
  }

  /**
   * Recorded utilization per (source, window) since `since`. Each series keeps
   * the last reading from *before* the cutoff as its first point: without that
   * anchor a step chart has nothing to draw from until the first change lands
   * inside the window.
   */
  getUsageHistory(
    wsId: string,
    since: number
  ): Array<{ source: string; windowId: string; points: UsagePoint[] }> {
    const ws = this.usagePoints.get(wsId);
    if (!ws) return [];
    const out: Array<{ source: string; windowId: string; points: UsagePoint[] }> = [];
    for (const [key, list] of ws) {
      const [source, windowId] = key.split('\n');
      let start = list.findIndex((p) => p.at >= since);
      if (start === -1) start = list.length - 1; // all older: keep the newest as the anchor
      else if (start > 0) start -= 1;
      const points = start < 0 ? [] : list.slice(start);
      if (points.length > 0) out.push({ source, windowId, points });
    }
    return out.sort(
      (a, b) => a.source.localeCompare(b.source) || a.windowId.localeCompare(b.windowId)
    );
  }

  /**
   * Replaces the token totals for the given (source, project, day) rows. Whole
   * days are replaced rather than incremented so a re-run — a backfill, or a
   * hook re-reporting today — converges instead of double-counting.
   */
  setProjectDays(
    wsId: string,
    source: string,
    days: Array<{ project: string; day: string; tokens: number }>
  ): void {
    let ws = this.projectDays.get(wsId);
    if (!ws) {
      ws = new Map();
      this.projectDays.set(wsId, ws);
      // Same legacy-mode concern as upsertSession: keep the workspace row
      // present so persisted rows satisfy the workspace_id relationship.
      if (this.pool && !this.workspaces.has(wsId)) {
        const now = Date.now();
        this.exec(Store.INSERT_WS, [wsId, now, now]);
      }
    }
    const now = Date.now();
    for (const d of days) {
      ws.set(`${source}\n${d.project}\n${d.day}`, {
        source,
        project: d.project,
        day: d.day,
        tokens: d.tokens,
      });
      this.exec(
        `INSERT INTO usage_project_days (workspace_id, source, project, day, tokens, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, source, project, day) DO UPDATE SET
           tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at, deleted_at = NULL`,
        [wsId, source, d.project, d.day, d.tokens, now]
      );
    }
  }

  /** Token spend per (source, project, day) on or after `sinceDay` (YYYY-MM-DD). */
  getProjectDays(wsId: string, sinceDay: string): ProjectDay[] {
    const ws = this.projectDays.get(wsId);
    if (!ws) return [];
    return Array.from(ws.values())
      .filter((d) => d.day >= sinceDay)
      .sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          a.source.localeCompare(b.source) ||
          a.project.localeCompare(b.project)
      );
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

  getSession(wsId: string, id: string): Session | null {
    return this.sessions.get(wsId)?.get(id) ?? null;
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
        'UPDATE sessions SET deleted_at = $3, host = NULL WHERE workspace_id = $1 AND id = $2',
        [wsId, id, Date.now()]
      );
      this.dropEvents(wsId, id);
      this.cancelCommands(wsId, id);
    }
    return removed;
  }

  clearSessions(wsId: string): void {
    const map = this.sessions.get(wsId);
    if (map) {
      for (const id of map.keys()) this.dropEvents(wsId, id);
      map.clear();
    }
    this.cancelCommands(wsId, null);
    this.exec(
      'UPDATE sessions SET deleted_at = $2, host = NULL WHERE workspace_id = $1 AND deleted_at IS NULL',
      [wsId, Date.now()]
    );
  }

  /** Fixed-window webhook rate limit per workspace. */
  allowWebhook(wsId: string): boolean {
    return this.allowInWindow(this.webhookWindows, wsId, WEBHOOKS_PER_MINUTE);
  }

  /** Fixed-window Focus-command rate limit per workspace, separate from the webhook budget. */
  allowCommand(wsId: string): boolean {
    return this.allowInWindow(this.commandWindows, wsId, COMMANDS_PER_MINUTE);
  }

  /** Fixed-window limit on listener connects per workspace (each one is broadcast to every viewer). */
  allowListenerConnect(wsId: string): boolean {
    return this.allowInWindow(this.listenerWindows, wsId, LISTENER_CONNECTS_PER_MINUTE);
  }

  private allowInWindow(
    windows: Map<string, { windowStart: number; count: number }>,
    wsId: string,
    perMinute: number,
  ): boolean {
    const now = Date.now();
    const win = windows.get(wsId);
    if (!win || now - win.windowStart >= 60_000) {
      windows.set(wsId, { windowStart: now, count: 1 });
      return true;
    }
    win.count += 1;
    return win.count <= perMinute;
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

  // ---- Focus commands ------------------------------------------------------

  private isPending(cmd: Command, now: number): boolean {
    return cmd.state === 'pending' && now < cmd.expiresAt;
  }

  /** Fails a live command on the server's behalf; the caller decides how its ack gets out. */
  private failCommand(cmd: Command, now: number, state: 'done' | 'expired', reason: CommandReason): void {
    cmd.state = state;
    cmd.doneAt = now;
    cmd.result = 'failed';
    cmd.reason = reason;
  }

  /** Flips a live command to expired and queues it for the sweep's broadcast. */
  private expireCommand(cmd: Command, now: number): void {
    this.failCommand(cmd, now, 'expired', 'expired');
    this.unannounced.push(cmd);
  }

  /** The command, expired on the spot if its TTL passed; null when unknown or already swept. */
  private liveCommand(wsId: string, id: string, now: number): Command | null {
    const cmd = this.commands.get(wsId)?.get(id);
    if (!cmd) return null;
    if ((cmd.state === 'pending' || cmd.state === 'claimed') && now >= cmd.expiresAt) {
      this.expireCommand(cmd, now);
    }
    return cmd;
  }

  /**
   * Records a new pending command. Null when the id is already taken in this
   * workspace (the phone retried with the same client uuid; it should poll
   * the existing one instead).
   */
  createCommand(
    input: { wsId: string; id: string; type: CommandType; sessionId: string; machineId: string },
    ttlMs: number,
  ): Command | null {
    let map = this.commands.get(input.wsId);
    if (!map) {
      map = new Map();
      this.commands.set(input.wsId, map);
    }
    if (map.has(input.id)) return null;
    const now = Date.now();
    const cmd: Command = {
      id: input.id,
      wsId: input.wsId,
      type: input.type,
      sessionId: input.sessionId,
      machineId: input.machineId,
      state: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    map.set(cmd.id, cmd);
    return cmd;
  }

  getCommand(wsId: string, id: string): Command | null {
    return this.liveCommand(wsId, id, Date.now());
  }

  /**
   * pending → claimed, only from pending and only with the key of the machine
   * the command was routed to. The key never reaches a viewer, so the machine
   * id alone (which every viewer sees) cannot claim.
   */
  claimCommand(wsId: string, id: string, machineKey: string): { ok: true; command: Command } | { ok: false; error: ClaimError } {
    const now = Date.now();
    const cmd = this.liveCommand(wsId, id, now);
    if (!cmd) return { ok: false, error: 'not_found' };
    if (!machineKeyMatches(machineKey, cmd.machineId)) return { ok: false, error: 'wrong_machine' };
    if (cmd.state === 'expired') return { ok: false, error: 'expired' };
    if (cmd.state !== 'pending') return { ok: false, error: 'already_claimed' };
    cmd.state = 'claimed';
    cmd.claimedAt = now;
    return { ok: true, command: cmd };
  }

  /** claimed → done, with the machine's key as for claim. The outcome is enums only; nothing free-form is ever stored. */
  ackCommand(
    wsId: string,
    id: string,
    machineKey: string,
    outcome: { result: CommandResult; reach?: CommandReach; reason?: CommandReason },
  ): { ok: true; command: Command } | { ok: false; error: AckError } {
    const now = Date.now();
    const cmd = this.liveCommand(wsId, id, now);
    if (!cmd) return { ok: false, error: 'not_found' };
    if (!machineKeyMatches(machineKey, cmd.machineId)) return { ok: false, error: 'wrong_machine' };
    if (cmd.state === 'expired') return { ok: false, error: 'expired' };
    if (cmd.state === 'done') return { ok: false, error: 'already_done' };
    if (cmd.state === 'pending') return { ok: false, error: 'not_claimed' };
    cmd.state = 'done';
    cmd.doneAt = now;
    cmd.result = outcome.result;
    if (outcome.reach) cmd.reach = outcome.reach;
    if (outcome.reason) cmd.reason = outcome.reason;
    return { ok: true, command: cmd };
  }

  /** Unclaimed, unexpired commands routed to one machine — what a (re)connecting listener has missed. */
  pendingCommandsFor(wsId: string, machineId: string): Command[] {
    const now = Date.now();
    const pending: Command[] = [];
    for (const cmd of this.commands.get(wsId)?.values() ?? []) {
      if (cmd.machineId === machineId && this.isPending(cmd, now)) pending.push(cmd);
    }
    return pending.sort((a, b) => a.createdAt - b.createdAt);
  }

  countPending(wsId: string): number {
    const now = Date.now();
    let n = 0;
    for (const cmd of this.commands.get(wsId)?.values() ?? []) {
      if (this.isPending(cmd, now)) n += 1;
    }
    return n;
  }

  /** The pending command a new one for the same card would coalesce with, if any. */
  private findPending(wsId: string, sessionId: string, type: CommandType, machineId: string, now: number): Command | null {
    for (const cmd of this.commands.get(wsId)?.values() ?? []) {
      if (cmd.sessionId !== sessionId || cmd.type !== type || cmd.machineId !== machineId) continue;
      if (this.isPending(cmd, now)) return cmd;
    }
    return null;
  }

  /** Whether a new command for this card would supersede one that is still pending. */
  hasPending(wsId: string, sessionId: string, type: CommandType, machineId: string): boolean {
    return this.findPending(wsId, sessionId, type, machineId, Date.now()) !== null;
  }

  /**
   * Coalesces a re-tap: an older pending command for the same session, type
   * and machine is finished as failed/superseded and returned so its ack can
   * be broadcast. Null when there was none.
   */
  supersedePending(wsId: string, sessionId: string, type: CommandType, machineId: string): Command | null {
    const now = Date.now();
    const cmd = this.findPending(wsId, sessionId, type, machineId, now);
    if (!cmd) return null;
    this.failCommand(cmd, now, 'done', 'superseded');
    return cmd;
  }

  /**
   * Fails the pending commands aimed at one session (null: at every session
   * of the workspace) as superseded — the card is gone, so nobody is waiting
   * and the listener must not raise a window for it. Claimed ones are left to
   * ack or expire. Queued for app.ts to broadcast (takeFinishedCommands).
   */
  private cancelCommands(wsId: string, sessionId: string | null): void {
    const now = Date.now();
    for (const cmd of this.commands.get(wsId)?.values() ?? []) {
      if (sessionId !== null && cmd.sessionId !== sessionId) continue;
      if (!this.isPending(cmd, now)) continue;
      this.failCommand(cmd, now, 'done', 'superseded');
      this.unannounced.push(cmd);
    }
  }

  /**
   * Every command the server finished itself since the last call — expired,
   * or cancelled with its session — each for exactly one broadcast.
   */
  takeFinishedCommands(): Command[] {
    const finished = this.unannounced;
    this.unannounced = [];
    return finished;
  }

  /**
   * Expires live commands past their TTL and forgets finished ones past the
   * grace period. Returns what finished server-side since the last drain
   * (including what a read expired lazily) so app.ts can broadcast each
   * exactly once.
   */
  sweepCommands(now: number = Date.now()): Command[] {
    for (const [wsId, map] of this.commands) {
      for (const [id, cmd] of map) {
        if (cmd.state === 'pending' || cmd.state === 'claimed') {
          if (now >= cmd.expiresAt) this.expireCommand(cmd, now);
        } else if (now >= (cmd.doneAt ?? cmd.expiresAt) + COMMAND_GRACE_MS) {
          map.delete(id);
        }
      }
      if (map.size === 0) this.commands.delete(wsId);
    }
    return this.takeFinishedCommands();
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
            'UPDATE sessions SET deleted_at = $3, host = NULL WHERE workspace_id = $1 AND id = $2',
            [wsId, id, Date.now()]
          );
          this.dropEvents(wsId, id);
          this.cancelCommands(wsId, id);
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
