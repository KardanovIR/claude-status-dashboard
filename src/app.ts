import express, { Request, Response, NextFunction, Express } from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import crypto from 'crypto';
import { AppConfig } from './config';
import { Pusher } from './push';
import {
  AckError,
  ClaimError,
  Command,
  COMMAND_REACHES,
  COMMAND_REASONS,
  COMMAND_RESULTS,
  COMMAND_TYPES,
  dayKey,
  Host,
  LEGACY_WS,
  MACHINE_ID_RE,
  MACHINE_KEY_RE,
  machineKeyMatches,
  MAX_HISTORY_DAYS,
  MAX_PENDING_COMMANDS_PER_WORKSPACE,
  normalizeHost,
  PAIR_CODE_TTL_MS,
  STATUSES,
  Status,
  Store,
  UpsertInput,
  UsageWindow,
} from './store';

export type { AppConfig } from './config';
export { Store, STATUSES } from './store';
export type { Command, Host, Session } from './store';

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DEVICE_TOKEN_RE = /^[0-9a-fA-F]{16,200}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
const MAX_SESSIONS_PER_WORKSPACE = 50;
const MAX_SSE_PER_WORKSPACE = 10;
const WORKSPACE_IDLE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const NAME_MAX = 120;
const MESSAGE_MAX = 300;
const USAGE_SOURCE_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const USAGE_WINDOW_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const USAGE_LABEL_MAX = 48;
const MAX_USAGE_WINDOWS = 6;
const PROJECT_NAME_MAX = 120;
// Sized to fit inside the 16kb JSON body limit (~65 bytes a row); a backfill
// spanning more than this sends several reports.
const MAX_PROJECT_DAYS_PER_REPORT = 200;
// A session row is wider than a project-day row (an id where the other has a
// folder name and a day), so fewer fit the same 16kb body: 100 rows of
// {"session_id":"<uuid>","tokens":<n>} measure ~6.5kb, and ~11kb at the 64-char
// id bound below. The hook chunks at the same number (MAX_SESSION_TOTALS_PER_POST).
const MAX_SESSION_TOTALS_PER_REPORT = 100;
// Session ids on this endpoint share the webhook's charset but are held to
// half its length: both agents name sessions with a uuid (36 chars), and the
// bound is what turns the body estimate above into an actual limit.
const SESSION_TOTAL_ID_MAX = 64;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_HISTORY_DAYS = 30;
// Focus: a tap is {id, type, session_id}; the id is a client uuid so a retry
// can be told apart from a second tap.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LISTENERS_PER_WORKSPACE = 5;
const LISTENER_NAME_MAX = 32;
/**
 * The listener's credential travels as `Authorization: Bearer <key>`.
 *
 * Not in the query string, because nginx, Cloudflare and most PaaS log
 * `$request_uri` verbatim and ship those logs to aggregators. But not in a
 * custom header either: log pipelines that redact credentials do it by NAME,
 * and `Authorization` is on every one of those lists while `x-machine-key` is
 * on none. Our own deploy/Caddyfile is the case in point — Caddy serializes
 * the whole request header map into its access log, and `log_credentials`
 * (off by default) redacts exactly Cookie, Set-Cookie, Authorization and
 * Proxy-Authorization. A custom name would have put the key straight back in
 * the log the moment an operator added a `log` directive, which is the very
 * thing moving it out of the URL was for.
 */
const MACHINE_KEY_SCHEME = 'Bearer';

/** The key from `Authorization: Bearer <key>`, or '' when absent or malformed. */
function bearerKey(req: express.Request): string {
  const raw = req.header('authorization') || '';
  const [scheme, ...rest] = raw.split(' ');
  if (scheme.toLowerCase() !== MACHINE_KEY_SCHEME.toLowerCase()) return '';
  return rest.join(' ').trim();
}
const COMMAND_SWEEP_MS = 15_000;
const ACK_KEYS = ['machine_key', 'result', 'reach', 'reason'];

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
const LANDING_HTML = path.join(PUBLIC_DIR, 'landing.html');
const PRIVACY_HTML = path.join(PUBLIC_DIR, 'privacy.html');
const DOCS_HTML = path.join(PUBLIC_DIR, 'docs.html');
// The two install scripts. They are checked in under public/, so every board —
// hosted or self-hosted — hands out the same one-liner install path.
const INSTALL_SH = path.join(PUBLIC_DIR, 'install.sh');
const INSTALL_PS1 = path.join(PUBLIC_DIR, 'install.ps1');

const isStatus = (s: unknown): s is Status =>
  typeof s === 'string' && (STATUSES as readonly string[]).includes(s);

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Strips control characters and truncates; non-strings become undefined (carry-forward). */
const clean = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.replace(CONTROL_CHARS_RE, '').slice(0, max) : undefined;

/**
 * Validates the `host` field of a webhook. undefined = absent (carry forward),
 * null = the hook opted out (clear); 'invalid' rejects the post. Only a
 * non-object or a bad machine id is a hard error — the shape itself is then
 * rebuilt by normalizeHost(), which downgrades unknown slugs and kinds, cleans
 * and defaults the names and drops everything else.
 */
function parseHost(raw: unknown): Host | null | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const machine = (raw as { machine?: unknown }).machine;
  const id = typeof machine === 'object' && machine !== null ? (machine as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || !MACHINE_ID_RE.test(id)) return 'invalid';
  return normalizeHost(raw)!;
}

/**
 * Validates and normalizes the `windows` array of a usage report. Returns null
 * when the shape is unacceptable; individual values are clamped, not rejected.
 */
function parseUsageWindows(raw: unknown): UsageWindow[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_USAGE_WINDOWS) return null;
  const seen = new Set<string>();
  const windows: UsageWindow[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const w = item as Record<string, unknown>;
    if (typeof w.id !== 'string' || !USAGE_WINDOW_ID_RE.test(w.id) || seen.has(w.id)) return null;
    if (typeof w.usedPct !== 'number' || !Number.isFinite(w.usedPct)) return null;
    seen.add(w.id);
    const resetsAt =
      typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt > 0
        ? Math.floor(w.resetsAt)
        : null;
    windows.push({
      id: w.id,
      label: clean(w.label, USAGE_LABEL_MAX) || w.id,
      usedPct: Math.min(100, Math.max(0, w.usedPct)),
      resetsAt,
    });
  }
  return windows;
}

/** One connected Focus listener: the machine that can act on this board's commands. */
interface Listener {
  res: Response;
  name: string;
  connectedAt: number;
}

/** The wire shape of a command, as sent to its listener and returned in the `commands` frame. */
const commandFrame = (cmd: Command) => ({
  id: cmd.id,
  type: cmd.type,
  session_id: cmd.sessionId,
  machine_id: cmd.machineId,
  expires_in_ms: Math.max(0, cmd.expiresAt - Date.now()),
});

/** The `command_ack` event: ids and enums only, never a message. */
const ackPayload = (cmd: Command) => ({
  id: cmd.id,
  session_id: cmd.sessionId,
  machine_id: cmd.machineId,
  type: cmd.type,
  result: cmd.result ?? null,
  reach: cmd.reach ?? null,
  reason: cmd.reason ?? null,
});

const COMMAND_ERROR_STATUS: Record<ClaimError | AckError, number> = {
  not_found: 404,
  wrong_machine: 403,
  already_claimed: 409,
  not_claimed: 409,
  already_done: 409,
  expired: 410,
};

export interface CreatedApp {
  app: Express;
  store: Store;
  /** Resolves once persisted state (if any) is loaded; reject = DB unreachable. */
  ready: Promise<void>;
  shutdown(): void;
}

export function createApp(cfg: AppConfig): CreatedApp {
  const store = new Store(cfg.databaseUrl);
  const pusher = new Pusher(cfg.apns, store);
  const sseClients = new Map<string, Set<Response>>();
  // Focus listeners, wsId → machine id → stream. One per machine (a reconnect
  // replaces the old stream), counted apart from the viewer slots above.
  const listeners = new Map<string, Map<string, Listener>>();
  const timers: NodeJS.Timeout[] = [];
  // A caller that omits or misconfigures the TTL gets the default, never NaN — a NaN
  // sweep interval is a 1 ms hot loop and a NaN expiry is a command that never ends.
  const commandTtlMs =
    Number.isFinite(cfg.commandTtlMs) && cfg.commandTtlMs > 0 ? cfg.commandTtlMs : 120_000;

  // A reader that stops draining its socket never fires 'close', so writes pile
  // up in per-connection heap buffers. Evict once the buffer exceeds this cap.
  // (write() returning false is NOT a signal — healthy readers cross the 16KB
  // highWaterMark transiently.)
  const MAX_BUFFERED_BYTES = 1_000_000;

  function safeWrite(res: Response, payload: string, evict: () => void): void {
    try {
      res.write(payload);
      if (res.socket && res.socket.writableLength > MAX_BUFFERED_BYTES) {
        evict();
        res.destroy();
      }
    } catch {
      evict();
      try { res.end(); } catch { /* already gone */ }
    }
  }

  /** Forgets a listener stream — if it is still the machine's current one — and tells the board. */
  function dropListener(wsId: string, machineId: string, entry: Listener): void {
    const group = listeners.get(wsId);
    if (!group || group.get(machineId) !== entry) return;
    group.delete(machineId);
    if (group.size === 0) listeners.delete(wsId);
    broadcast(wsId, 'machine', { id: machineId, online: false, lastSeen: Date.now() });
  }

  // Presence is {id, name, online, since}: no platform or version, which the
  // privacy page does not list and every viewer would otherwise learn.
  const machineInfo = (id: string, l: Listener) => ({ id, name: l.name, online: true, since: l.connectedAt });

  function onlineMachines(wsId: string): ReturnType<typeof machineInfo>[] {
    const group = listeners.get(wsId);
    return group ? Array.from(group, ([id, l]) => machineInfo(id, l)) : [];
  }

  /** To every stream of the workspace: viewers and listeners alike. */
  function broadcast(wsId: string, event: string, data: unknown): void {
    const payload = frame(event, data);
    const clients = sseClients.get(wsId);
    if (clients) {
      for (const res of Array.from(clients)) {
        safeWrite(res, payload, () => clients.delete(res));
      }
    }
    const group = listeners.get(wsId);
    if (group) {
      for (const [machineId, l] of Array.from(group)) {
        safeWrite(l.res, payload, () => dropListener(wsId, machineId, l));
      }
    }
  }

  /** One `command_ack` per command the server finished itself, to its workspace. */
  function announceAcks(cmds: Command[]): void {
    for (const cmd of cmds) broadcast(cmd.wsId, 'command_ack', ackPayload(cmd));
  }

  /** A session left the board: viewers drop the card, and the taps still waiting on it fail. */
  function announceRemoved(wsId: string, id: string): void {
    broadcast(wsId, 'remove', { id });
    announceAcks(store.takeFinishedCommands());
  }

  function closeStreams(wsId: string): void {
    const clients = sseClients.get(wsId);
    if (clients) {
      for (const res of Array.from(clients)) {
        try {
          res.write('event: snapshot\ndata: []\n\n');
          res.end();
        } catch { /* already gone */ }
      }
      sseClients.delete(wsId);
    }
    const group = listeners.get(wsId);
    if (group) {
      for (const l of group.values()) {
        try { l.res.end(); } catch { /* already gone */ }
      }
      listeners.delete(wsId);
    }
  }

  function openStream(res: Response): void {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
  }

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '16kb' }));

  // Registered before the static handler, which would otherwise answer "/"
  // with index.html. On a multi-tenant server "/" is the marketing landing
  // page; a legacy (single-tenant) server's root IS its dashboard, so it
  // keeps index.html.
  if (cfg.multiTenant) {
    app.get('/', (_req, res) => res.sendFile(LANDING_HTML));
  }
  // Stable URL for the privacy policy — the App Store listing points here.
  app.get('/privacy', (_req, res) => res.sendFile(PRIVACY_HTML));
  // Docs page, generated from docs/*.md by scripts/build-docs.js.
  app.get('/docs', (_req, res) => res.sendFile(DOCS_HTML));

  // The one documented install path:
  //   curl -fsSL https://agstatus.online/install.sh | sh
  //   irm https://agstatus.online/install.ps1 | iex
  //
  // Served as text/plain, not text/x-shellscript, on purpose. Neither `sh` nor
  // PowerShell's Invoke-RestMethod looks at the type — but a person who pastes
  // the URL into a browser to read the script before piping it into a shell
  // very much does, and Chrome and Safari download an x-shellscript body
  // instead of rendering it. A pipe-to-shell one-liner is only trustworthy if
  // reading it first is one click away, so the type that renders wins.
  // (Invoke-RestMethod is happier as well: on text/* it hands back a string,
  // where an unfamiliar type can send it looking for a deserializer.)
  //
  // Five minutes of caching: long enough that a link doing the rounds does not
  // hit the origin on every click, short enough that a bad release can be
  // corrected the same afternoon. sendFile still adds an ETag, so a
  // revalidation after that costs a 304 and no body.
  const sendScript = (res: Response, file: string): void => {
    res.type('text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(file);
  };
  // Registered ahead of express.static, which would otherwise answer with
  // application/x-sh (and application/octet-stream for the .ps1).
  app.get('/install.sh', (_req, res) => sendScript(res, INSTALL_SH));
  app.get('/install.ps1', (_req, res) => sendScript(res, INSTALL_PS1));

  app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: true }));

  // ---- shared handlers -----------------------------------------------------

  function handleWebhook(wsId: string, req: Request, res: Response): void {
    if (cfg.multiTenant && cfg.rateLimit && !store.allowWebhook(wsId)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.session_id === 'string' ? body.session_id : '';
    if (!id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    if (!SESSION_ID_RE.test(id)) {
      res.status(400).json({ error: 'session_id must match ^[A-Za-z0-9._:-]{1,128}$' });
      return;
    }
    if (!isStatus(body.status)) {
      res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
      return;
    }
    if (body.source !== undefined
        && (typeof body.source !== 'string' || !USAGE_SOURCE_RE.test(body.source))) {
      res.status(400).json({ error: `source must match ${USAGE_SOURCE_RE}` });
      return;
    }
    const host = parseHost(body.host);
    if (host === 'invalid') {
      res.status(400).json({
        error: `host must be an object or null; host.machine.id must match ${MACHINE_ID_RE}`,
      });
      return;
    }
    const input: UpsertInput = {
      id,
      status: body.status,
      name: clean(body.name, NAME_MAX),
      message: clean(body.message, MESSAGE_MAX),
      project: clean(body.project, NAME_MAX),
      source: body.source as string | undefined,
      host,
    };
    const max = cfg.multiTenant ? MAX_SESSIONS_PER_WORKSPACE : Infinity;
    const { session, evictedId, prevStatus } = store.upsertSession(wsId, input, max);
    if (evictedId) announceRemoved(wsId, evictedId);
    broadcast(wsId, 'session', session);
    // Fire-and-forget: enqueues async APNs work, never throws or blocks.
    pusher.notifyTransition(wsId, session, prevStatus);
    res.json({ ok: true, session });
  }

  /**
   * Token spend per project and day, reported by the hook from the agent's own
   * local logs. Whole days are replaced, so a backfill can be re-run safely.
   */
  function handleProjectUsage(wsId: string, req: Request, res: Response): void {
    if (cfg.multiTenant && cfg.rateLimit && !store.allowWebhook(wsId)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = typeof body.source === 'string' ? body.source : '';
    if (!USAGE_SOURCE_RE.test(source)) {
      res.status(400).json({ error: `source must match ${USAGE_SOURCE_RE}` });
      return;
    }
    const raw = body.days;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PROJECT_DAYS_PER_REPORT) {
      res.status(400).json({ error: `days must be 1-${MAX_PROJECT_DAYS_PER_REPORT} objects` });
      return;
    }
    const days: Array<{ project: string; day: string; tokens: number }> = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) {
        res.status(400).json({ error: 'each day must be an object' });
        return;
      }
      const d = item as Record<string, unknown>;
      const project = clean(d.project, PROJECT_NAME_MAX);
      const day = typeof d.day === 'string' ? d.day : '';
      const tokens =
        typeof d.tokens === 'number' && Number.isFinite(d.tokens) ? Math.max(0, Math.floor(d.tokens)) : -1;
      if (!project || !DAY_RE.test(day) || tokens < 0) {
        res.status(400).json({ error: 'each day needs a project, a YYYY-MM-DD day and numeric tokens' });
        return;
      }
      const key = `${project}\n${day}`;
      if (seen.has(key)) continue; // last one wins rather than 400 on a dupe
      seen.add(key);
      days.push({ project, day, tokens });
    }
    store.setProjectDays(wsId, source, days);
    res.json({ ok: true, days: days.length });
  }

  /**
   * Lifetime token totals per session, from the same pass over the same local
   * logs that feeds /usage/projects — a second key on those records, not a
   * second measure of the same thing. A project-day sums across sessions; a
   * session total sums across days and folders. Neither converts into the
   * other, and neither is a share of any plan limit.
   *
   * The card is where this number is read, so a stored total is attached to
   * the session on its way out (Store.withTokens) and the cards that moved are
   * rebroadcast below. That keeps SSE the one delivery path for anything a
   * card shows: no second stream to join, no polling, and a client that has
   * never heard of the field simply ignores it.
   */
  function handleSessionUsage(wsId: string, req: Request, res: Response): void {
    if (cfg.multiTenant && cfg.rateLimit && !store.allowWebhook(wsId)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = typeof body.source === 'string' ? body.source : '';
    if (!USAGE_SOURCE_RE.test(source)) {
      res.status(400).json({ error: `source must match ${USAGE_SOURCE_RE}` });
      return;
    }
    const raw = body.sessions;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SESSION_TOTALS_PER_REPORT) {
      res.status(400).json({ error: `sessions must be 1-${MAX_SESSION_TOTALS_PER_REPORT} objects` });
      return;
    }
    // Keyed while parsing, so a repeated id inside one body replaces its
    // earlier value — last one wins, rather than a 400 over something the
    // store would collapse anyway.
    const byId = new Map<string, number>();
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) {
        res.status(400).json({ error: 'each session must be an object' });
        return;
      }
      const t = item as Record<string, unknown>;
      const sessionId = typeof t.session_id === 'string' ? t.session_id : '';
      // Bounded above as well as below. `Number.isFinite` alone accepts 1e300,
      // which survives `Math.floor`, is stored, and is then served to three
      // clients that format it for a card — and past MAX_SAFE_INTEGER the
      // value has stopped being an exact integer at all, so it cannot mean
      // what the wire contract says it means ("a non-negative integer").
      // Rejecting is right rather than clamping: a number that large is a bug
      // or an attack at the sender, and silently storing a plausible-looking
      // ceiling would hide it.
      const tokens =
        typeof t.tokens === 'number' && Number.isFinite(t.tokens) ? Math.max(0, Math.floor(t.tokens)) : -1;
      if (
        !sessionId ||
        sessionId.length > SESSION_TOTAL_ID_MAX ||
        !SESSION_ID_RE.test(sessionId) ||
        tokens < 0 ||
        tokens > Number.MAX_SAFE_INTEGER
      ) {
        res.status(400).json({
          error:
            `each session needs a session_id matching ^[A-Za-z0-9._:-]{1,${SESSION_TOTAL_ID_MAX}}$ ` +
            'and numeric tokens',
        });
        return;
      }
      byId.set(sessionId, tokens);
    }
    const rows = Array.from(byId, ([sessionId, tokens]) => ({ sessionId, tokens }));
    // Only the cards on this board whose number actually moved: a report that
    // repeats itself broadcasts nothing, and a total for a session that has no
    // card (already expired, or never posted to this board) is stored for the
    // card's return without waking any viewer.
    for (const id of store.setSessionTotals(wsId, source, rows)) {
      const session = store.getSession(wsId, id);
      if (session && session.source === source) broadcast(wsId, 'session', session);
    }
    res.json({ ok: true, sessions: rows.length });
  }

  /** Both series behind the usage detail screen: limit over time, and by project. */
  function handleUsageHistory(wsId: string, req: Request, res: Response): void {
    const asked = Number(req.query.days);
    const days =
      Number.isFinite(asked) && asked > 0
        ? Math.min(Math.floor(asked), MAX_HISTORY_DAYS)
        : DEFAULT_HISTORY_DAYS;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    res.json({
      days,
      history: store.getUsageHistory(wsId, since),
      projects: store.getProjectDays(wsId, dayKey(since)),
    });
  }

  function handleUsage(wsId: string, req: Request, res: Response): void {
    if (cfg.multiTenant && cfg.rateLimit && !store.allowWebhook(wsId)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = typeof body.source === 'string' ? body.source : '';
    if (!USAGE_SOURCE_RE.test(source)) {
      res.status(400).json({ error: `source must match ${USAGE_SOURCE_RE}` });
      return;
    }
    const windows = parseUsageWindows(body.windows);
    if (!windows) {
      res.status(400).json({
        error: `windows must be 1-${MAX_USAGE_WINDOWS} objects with unique id and numeric usedPct`,
      });
      return;
    }
    store.setUsage(wsId, source, windows);
    broadcast(wsId, 'usage', store.getUsage(wsId));
    res.json({ ok: true });
  }

  function handleEvents(wsId: string, req: Request, res: Response): void {
    // The key used to ride in `?key=`. A stale client must fail loudly rather
    // than fall through to a viewer stream and look connected while
    // unauthenticated. The value is never echoed back or logged: it is in an
    // access log already, which is the whole reason it moved.
    // Case-insensitively: the remaining way a key reaches a URL is a human
    // typing or editing one, and `?Key=` should be just as loud as `?key=`.
    if (Object.keys(req.query).some((k) => k.toLowerCase() === 'key')) {
      res.status(400).json({
        error:
          'key must not be in the query string (access logs record it): send it as ' +
          `\`Authorization: ${MACHINE_KEY_SCHEME} <key>\`, and rotate the key that was in this URL`,
      });
      return;
    }
    if (req.query.listener !== undefined) {
      handleListener(wsId, req, res);
      return;
    }
    let clients = sseClients.get(wsId);
    if (!clients) {
      clients = new Set();
      sseClients.set(wsId, clients);
    }
    if (cfg.multiTenant && clients.size >= MAX_SSE_PER_WORKSPACE) {
      res.status(429).json({ error: 'too many concurrent connections' });
      return;
    }
    openStream(res);
    clients.add(res);
    const evict = (): void => { clients.delete(res); };
    safeWrite(res, frame('snapshot', store.getSessions(wsId)), evict);
    safeWrite(res, frame('machines', onlineMachines(wsId)), evict);
    const usage = store.getUsage(wsId);
    if (usage.length > 0) {
      safeWrite(res, frame('usage', usage), evict);
    }
    req.on('close', () => {
      sseClients.get(wsId)?.delete(res);
    });
  }

  /**
   * A Focus listener subscribing on behalf of one machine
   * (`?listener=<machine_id>&name=` plus `Authorization: Bearer <machine_key>`). It gets
   * the snapshot, then the commands already waiting for it, then every event a
   * viewer gets; the board learns it is online. Its slot is separate from the
   * viewer cap. The key proves it is that machine: viewers know every machine
   * id from the snapshot, and without the key one of them could take the
   * machine's slot, end its real stream and read its commands.
   *
   * The id stays in the query — every board viewer already reads it off the
   * `machines` frame, so it is a routing label, not a credential, and leaving
   * it in the URL keeps the two kinds of `/events` connect distinguishable to
   * the proxy in front and to `guardListener` below. The key is a header
   * precisely because the id is not: only one of the two must stay out of
   * `$request_uri`.
   */
  function handleListener(wsId: string, req: Request, res: Response): void {
    const q = req.query as Record<string, unknown>;
    const machineId = typeof q.listener === 'string' ? q.listener : '';
    if (!MACHINE_ID_RE.test(machineId)) {
      res.status(400).json({ error: `listener must match ${MACHINE_ID_RE}` });
      return;
    }
    const key = bearerKey(req);
    if (!MACHINE_KEY_RE.test(key)) {
      // Never echo the value: this response goes to whoever sent it, but the
      // error text is also what a listener writes to its own log.
      res.status(400).json({ error: `Authorization: ${MACHINE_KEY_SCHEME} <key> must match ${MACHINE_KEY_RE}` });
      return;
    }
    if (!machineKeyMatches(key, machineId)) {
      res.status(403).json({ error: 'wrong_key' });
      return;
    }
    // Each connect is broadcast to every viewer, so a reconnect loop is throttled here.
    if (cfg.rateLimit && !store.allowListenerConnect(wsId)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    let group = listeners.get(wsId);
    const previous = group?.get(machineId);
    if (!previous && (group?.size ?? 0) >= MAX_LISTENERS_PER_WORKSPACE) {
      res.status(429).json({ error: 'too many listeners' });
      return;
    }
    if (!group) {
      group = new Map();
      listeners.set(wsId, group);
    }
    const entry: Listener = {
      res,
      name: (clean(q.name, LISTENER_NAME_MAX) ?? '').trim() || 'Machine',
      connectedAt: Date.now(),
    };
    openStream(res);
    // A reconnect replaces the machine's old stream. The old stream's close
    // handler sees it is no longer current and stays quiet, so the board
    // never sees a spurious offline.
    group.set(machineId, entry);
    if (previous) {
      try { previous.res.end(); } catch { /* already gone */ }
    }
    const evict = (): void => dropListener(wsId, machineId, entry);
    safeWrite(res, frame('snapshot', store.getSessions(wsId)), evict);
    safeWrite(res, frame('commands', store.pendingCommandsFor(wsId, machineId).map(commandFrame)), evict);
    broadcast(wsId, 'machine', machineInfo(machineId, entry));
    req.on('close', evict);
  }

  // ---- Focus commands ------------------------------------------------------
  // A tap on a card. The body carries ids only; the server routes it to the
  // machine the session itself reported, and the listener there derives the
  // action from its own local record. See docs/design/focus-protocol.md §3.3.

  const commandId = (req: Request): string => (req.params.id ?? '').toLowerCase();

  function handleCreateCommand(wsId: string, req: Request, res: Response): void {
    if (cfg.rateLimit && !store.allowCommand(wsId)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.id !== 'string' || !UUID_RE.test(body.id)) {
      res.status(400).json({ error: 'id must be a UUID' });
      return;
    }
    const id = body.id.toLowerCase();
    const type = body.type;
    if (!isOneOf(COMMAND_TYPES, type)) {
      res.status(400).json({ error: `type must be one of: ${COMMAND_TYPES.join(', ')}` });
      return;
    }
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    if (!SESSION_ID_RE.test(sessionId)) {
      res.status(400).json({ error: 'session_id must match ^[A-Za-z0-9._:-]{1,128}$' });
      return;
    }
    const session = store.getSession(wsId, sessionId);
    if (!session) {
      res.status(404).json({ error: 'unknown_session' });
      return;
    }
    if (!session.host) {
      res.status(409).json({ error: 'no_host' });
      return;
    }
    // Only the machine the session reported itself on — never one the client names.
    const machineId = session.host.machine.id;
    if (store.getCommand(wsId, id)) {
      res.status(409).json({ error: 'duplicate_id' });
      return;
    }
    // A second tap on the same card while the first is still waiting replaces
    // it, so it does not count against the cap: at the cap, a re-tap on a
    // waiting card (the most common gesture) still goes through, while a tap
    // on an eleventh card does not.
    const retap = store.hasPending(wsId, sessionId, type, machineId);
    if (store.countPending(wsId) - (retap ? 1 : 0) >= MAX_PENDING_COMMANDS_PER_WORKSPACE) {
      res.status(429).json({ error: 'too_many_pending' });
      return;
    }
    // The phone sees the replaced command fail as superseded.
    const superseded = store.supersedePending(wsId, sessionId, type, machineId);
    if (superseded) broadcast(wsId, 'command_ack', ackPayload(superseded));
    const cmd = store.createCommand({ wsId, id, type, sessionId, machineId }, commandTtlMs)!;
    const payload = commandFrame(cmd);
    // Only that machine's listener hears the command; viewers learn the
    // outcome from the ack.
    const listener = listeners.get(wsId)?.get(machineId);
    if (listener) {
      safeWrite(listener.res, frame('command', payload), () => dropListener(wsId, machineId, listener));
    }
    res.json({ id, delivered: Boolean(listener), expires_in_ms: payload.expires_in_ms });
  }

  /** The listener's credential from a claim/ack body: the key its machine id is derived from. */
  function machineKeyOf(body: Record<string, unknown>, res: Response): string | null {
    const key = typeof body.machine_key === 'string' ? body.machine_key : '';
    if (!MACHINE_KEY_RE.test(key)) {
      res.status(400).json({ error: `machine_key must match ${MACHINE_KEY_RE}` });
      return null;
    }
    return key;
  }

  function handleClaimCommand(wsId: string, req: Request, res: Response): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const machineKey = machineKeyOf(body, res);
    if (machineKey === null) return;
    const claimed = store.claimCommand(wsId, commandId(req), machineKey);
    if (!claimed.ok) {
      res.status(COMMAND_ERROR_STATUS[claimed.error]).json({ error: claimed.error });
      return;
    }
    // Nothing is broadcast: a claim is between the server and the listener.
    res.json({ ok: true, expires_in_ms: Math.max(0, claimed.command.expiresAt - Date.now()) });
  }

  function handleAckCommand(wsId: string, req: Request, res: Response): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Enums only. A free-text field here would put cwd, tty or stderr in front
    // of every viewer, so an unknown key is rejected rather than dropped.
    if (Object.keys(body).some((k) => !ACK_KEYS.includes(k))) {
      res.status(400).json({ error: `ack accepts only: ${ACK_KEYS.join(', ')}` });
      return;
    }
    const machineKey = machineKeyOf(body, res);
    if (machineKey === null) return;
    const result = body.result;
    if (!isOneOf(COMMAND_RESULTS, result)) {
      res.status(400).json({ error: `result must be one of: ${COMMAND_RESULTS.join(', ')}` });
      return;
    }
    const reach = body.reach ?? undefined;
    if (reach !== undefined && !isOneOf(COMMAND_REACHES, reach)) {
      res.status(400).json({ error: `reach must be one of: ${COMMAND_REACHES.join(', ')}` });
      return;
    }
    const reason = body.reason ?? undefined;
    if (reason !== undefined && !isOneOf(COMMAND_REASONS, reason)) {
      res.status(400).json({ error: `reason must be one of: ${COMMAND_REASONS.join(', ')}` });
      return;
    }
    if (result === 'failed' && reason === undefined) {
      res.status(400).json({ error: 'a failed result needs a reason' });
      return;
    }
    const acked = store.ackCommand(wsId, commandId(req), machineKey, { result, reach, reason });
    if (!acked.ok) {
      res.status(COMMAND_ERROR_STATUS[acked.error]).json({ error: acked.error });
      return;
    }
    broadcast(wsId, 'command_ack', ackPayload(acked.command));
    res.json({ ok: true });
  }

  /** For a phone that backgrounded (iOS drops SSE) and polls on return. */
  function handleGetCommand(wsId: string, req: Request, res: Response): void {
    const cmd = store.getCommand(wsId, commandId(req));
    if (!cmd) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      id: cmd.id,
      type: cmd.type,
      session_id: cmd.sessionId,
      machine_id: cmd.machineId,
      state: cmd.state,
      result: cmd.result ?? null,
      reach: cmd.reach ?? null,
      reason: cmd.reason ?? null,
      created_at: cmd.createdAt,
      expires_at: cmd.expiresAt,
      claimed_at: cmd.claimedAt ?? null,
      done_at: cmd.doneAt ?? null,
    });
  }

  // ---- legacy (single-tenant) mode ------------------------------------------

  if (!cfg.multiTenant) {
    const requireSecret = (req: Request, res: Response, next: NextFunction): void => {
      if (!cfg.webhookSecret) return next();
      const provided = req.header('x-webhook-secret') || '';
      const a = Buffer.from(provided);
      const b = Buffer.from(cfg.webhookSecret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    };

    app.post('/webhook', requireSecret, (req, res) => handleWebhook(LEGACY_WS, req, res));

    app.post('/usage', requireSecret, (req, res) => handleUsage(LEGACY_WS, req, res));

    app.post('/usage/projects', requireSecret, (req, res) =>
      handleProjectUsage(LEGACY_WS, req, res)
    );

    app.post('/usage/sessions', requireSecret, (req, res) =>
      handleSessionUsage(LEGACY_WS, req, res)
    );

    app.get('/api/usage', (_req, res) => {
      res.json(store.getUsage(LEGACY_WS));
    });

    app.get('/api/usage/history', (req, res) => handleUsageHistory(LEGACY_WS, req, res));

    app.get('/api/sessions/:id/history', (req, res) => {
      res.json(store.getHistory(LEGACY_WS, req.params.id));
    });

    app.delete('/sessions/:id', (req, res) => {
      const removed = store.deleteSession(LEGACY_WS, req.params.id);
      if (removed) announceRemoved(LEGACY_WS, req.params.id);
      res.json({ ok: removed });
    });

    app.post('/sessions/clear', requireSecret, (_req, res) => {
      store.clearSessions(LEGACY_WS);
      broadcast(LEGACY_WS, 'snapshot', []);
      announceAcks(store.takeFinishedCommands());
      res.json({ ok: true });
    });

    app.get('/api/sessions', (_req, res) => {
      res.json(store.getSessions(LEGACY_WS));
    });

    // A plain viewer connect stays open, like every other read; the listener
    // branch sits behind the secret like the command POSTs (a listener holds
    // the secret anyway, and nobody else may take a machine's slot).
    const guardListener = (req: Request, res: Response, next: NextFunction): void =>
      req.query.listener === undefined ? next() : requireSecret(req, res, next);

    app.get('/events', guardListener, (req, res) => handleEvents(LEGACY_WS, req, res));

    app.get('/api/machines', (_req, res) => {
      res.json(onlineMachines(LEGACY_WS));
    });

    app.post('/commands', requireSecret, (req, res) => handleCreateCommand(LEGACY_WS, req, res));

    app.post('/commands/:id/claim', requireSecret, (req, res) =>
      handleClaimCommand(LEGACY_WS, req, res)
    );

    app.post('/commands/:id/ack', requireSecret, (req, res) => handleAckCommand(LEGACY_WS, req, res));

    app.get('/commands/:id', (req, res) => handleGetCommand(LEGACY_WS, req, res));
  }

  // ---- multi-tenant (workspace) mode ----------------------------------------

  if (cfg.multiTenant) {
    const createLimiter = rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => !cfg.rateLimit,
    });

    app.post('/api/workspaces', createLimiter, (_req, res) => {
      if (store.workspaceCount() >= cfg.maxWorkspaces) {
        res.status(503).json({ error: 'server at capacity, try again later' });
        return;
      }
      const { token } = store.createWorkspace();
      res.status(201).json({
        ok: true,
        token,
        dashboardUrl: `${cfg.publicUrl}/w/${token}`,
        webhookUrl: `${cfg.publicUrl}/w/${token}/webhook`,
      });
    });

    // Brute-force protection for pairing-code claims: the keyspace is large
    // (31^8), but codes are short-lived secrets, so keep guessing expensive.
    const claimLimiter = rateLimit({
      windowMs: 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => !cfg.rateLimit,
    });

    app.post('/api/pair/claim', claimLimiter, (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.code !== 'string') {
        res.status(400).json({ error: 'code is required' });
        return;
      }
      const claimed = store.claimPairCode(body.code);
      // The workspace may have been deleted after the code was escrowed; the
      // claim above already consumed (dropped) the code either way.
      if (!claimed || !store.resolveToken(claimed.rawToken)) {
        res.status(404).json({ error: 'invalid or expired code' });
        return;
      }
      const { rawToken: token } = claimed;
      res.json({
        ok: true,
        token,
        dashboardUrl: `${cfg.publicUrl}/w/${token}`,
        webhookUrl: `${cfg.publicUrl}/w/${token}/webhook`,
      });
    });

    // CORS: the token in the path is the credential, so origins add nothing.
    app.use('/w', (req, res, next) => {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
      });
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });

    /** Resolves :token or responds 404. */
    const resolveWs = (req: Request, res: Response): string | null => {
      const wsId = store.resolveToken(req.params.token ?? '');
      if (!wsId) res.status(404).json({ error: 'unknown workspace' });
      return wsId;
    };

    app.get('/w/:token', (req, res) => {
      if (!resolveWs(req, res)) return;
      res.sendFile(INDEX_HTML);
    });

    app.get('/w/:token/api/sessions', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      res.json(store.getSessions(wsId));
    });

    app.get('/w/:token/events', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleEvents(wsId, req, res);
    });

    app.post('/w/:token/webhook', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleWebhook(wsId, req, res);
    });

    app.post('/w/:token/usage', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleUsage(wsId, req, res);
    });

    app.post('/w/:token/usage/projects', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleProjectUsage(wsId, req, res);
    });

    app.post('/w/:token/usage/sessions', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleSessionUsage(wsId, req, res);
    });

    app.get('/w/:token/api/usage', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      res.json(store.getUsage(wsId));
    });

    app.get('/w/:token/api/usage/history', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleUsageHistory(wsId, req, res);
    });

    app.get('/w/:token/api/sessions/:id/history', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      res.json(store.getHistory(wsId, req.params.id));
    });

    app.get('/w/:token/api/machines', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      res.json(onlineMachines(wsId));
    });

    app.post('/w/:token/commands', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleCreateCommand(wsId, req, res);
    });

    app.post('/w/:token/commands/:id/claim', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleClaimCommand(wsId, req, res);
    });

    app.post('/w/:token/commands/:id/ack', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleAckCommand(wsId, req, res);
    });

    app.get('/w/:token/commands/:id', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      handleGetCommand(wsId, req, res);
    });

    app.post('/w/:token/pair', (req, res) => {
      if (!resolveWs(req, res)) return;
      // The raw token (not the hashed wsId) is what the claimer needs.
      const code = store.createPairCode(req.params.token);
      if (!code) {
        res.status(429).json({ error: 'too many outstanding codes' });
        return;
      }
      res.status(201).json({
        ok: true,
        code: `${code.slice(0, 4)}-${code.slice(4)}`,
        expiresInSeconds: PAIR_CODE_TTL_MS / 1000,
      });
    });

    // Push-notification device registration (upsert by workspace + token).
    app.post('/w/:token/devices', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const deviceToken = typeof body.device_token === 'string' ? body.device_token : '';
      if (!DEVICE_TOKEN_RE.test(deviceToken)) {
        res.status(400).json({ error: 'device_token must match ^[0-9a-fA-F]{16,200}$' });
        return;
      }
      if (body.platform !== 'ios') {
        res.status(400).json({ error: 'platform must be "ios"' });
        return;
      }
      const result = store.upsertDevice(wsId, deviceToken, body.notify_done === true);
      if (result === 'cap') {
        res.status(429).json({ error: 'too many devices for this workspace' });
        return;
      }
      res.json({ ok: true });
    });

    app.delete('/w/:token/devices/:deviceToken', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      res.json({ ok: store.deleteDevice(wsId, req.params.deviceToken) });
    });

    app.delete('/w/:token/sessions/:id', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      const removed = store.deleteSession(wsId, req.params.id);
      if (removed) announceRemoved(wsId, req.params.id);
      res.json({ ok: removed });
    });

    app.post('/w/:token/sessions/clear', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      store.clearSessions(wsId);
      broadcast(wsId, 'snapshot', []);
      announceAcks(store.takeFinishedCommands());
      res.json({ ok: true });
    });

    app.delete('/w/:token', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      closeStreams(wsId);
      store.deleteWorkspace(wsId);
      res.json({ ok: true });
    });
  }

  // ---- shared endpoints ------------------------------------------------------

  app.get('/api/config', (_req, res) => {
    res.json({
      mode: cfg.multiTenant ? 'multi' : 'legacy',
      version: cfg.version,
      statuses: STATUSES,
      push: Boolean(cfg.apns),
      ...(cfg.multiTenant
        ? {}
        : { webhookUrl: `${cfg.publicUrl}/webhook`, requiresSecret: Boolean(cfg.webhookSecret) }),
    });
  });

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      version: cfg.version,
      ...(cfg.multiTenant ? {} : { sessions: store.getSessions(LEGACY_WS).length }),
    });
  });

  // ---- background sweeps ------------------------------------------------------

  const keepalive = setInterval(() => {
    for (const clients of sseClients.values()) {
      for (const res of Array.from(clients)) {
        safeWrite(res, ': keepalive\n\n', () => clients.delete(res));
      }
    }
    for (const [wsId, group] of listeners) {
      for (const [machineId, l] of Array.from(group)) {
        safeWrite(l.res, ': keepalive\n\n', () => dropListener(wsId, machineId, l));
      }
    }
  }, 25_000);
  keepalive.unref();
  timers.push(keepalive);

  // Every command terminates observably: the ones nobody claimed or acked in
  // time fail as expired, on the board and for a polling phone alike.
  // The floor keeps a tiny TTL from turning this into a hot timer.
  const commandSweep = setInterval(() => {
    announceAcks(store.sweepCommands());
  }, Math.max(1_000, Math.min(commandTtlMs, COMMAND_SWEEP_MS)));
  commandSweep.unref();
  timers.push(commandSweep);

  if (cfg.sessionTtlMs > 0) {
    const sweep = setInterval(() => {
      for (const { wsId, id } of store.sweepExpiredSessions(cfg.sessionTtlMs)) {
        announceRemoved(wsId, id);
      }
    }, Math.min(cfg.sessionTtlMs, 60_000));
    sweep.unref();
    timers.push(sweep);
  }

  if (cfg.multiTenant) {
    const wsSweep = setInterval(() => {
      for (const wsId of store.sweepIdleWorkspaces(WORKSPACE_IDLE_MS)) {
        closeStreams(wsId);
      }
    }, 6 * 60 * 60 * 1000);
    wsSweep.unref();
    timers.push(wsSweep);

    // Pairing codes also expire lazily on create/claim; this keeps the map
    // from holding escrowed tokens longer than the TTL when nobody touches it.
    const pairSweep = setInterval(() => store.sweepExpiredPairCodes(), 60_000);
    pairSweep.unref();
    timers.push(pairSweep);
  }

  function shutdown(): void {
    for (const t of timers) clearInterval(t);
    for (const wsId of new Set([...sseClients.keys(), ...listeners.keys()])) closeStreams(wsId);
    pusher.shutdown();
    // Drains queued writes then closes the pool; nothing left to surface here.
    void store.close().catch(() => undefined);
  }

  return { app, store, ready: store.ready, shutdown };
}
