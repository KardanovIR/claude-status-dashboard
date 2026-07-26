import express, { Request, Response, NextFunction, Express } from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import crypto from 'crypto';
import { AppConfig } from './config';
import { Pusher } from './push';
import {
  LEGACY_WS,
  PAIR_CODE_TTL_MS,
  STATUSES,
  Status,
  Store,
  UpsertInput,
  UsageWindow,
} from './store';

export type { AppConfig } from './config';
export { Store, STATUSES } from './store';
export type { Session } from './store';

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

const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

const isStatus = (s: unknown): s is Status =>
  typeof s === 'string' && (STATUSES as readonly string[]).includes(s);

/** Strips control characters and truncates; non-strings become undefined (carry-forward). */
const clean = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.replace(CONTROL_CHARS_RE, '').slice(0, max) : undefined;

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
  const timers: NodeJS.Timeout[] = [];

  // A reader that stops draining its socket never fires 'close', so writes pile
  // up in per-connection heap buffers. Evict once the buffer exceeds this cap.
  // (write() returning false is NOT a signal — healthy readers cross the 16KB
  // highWaterMark transiently.)
  const MAX_BUFFERED_BYTES = 1_000_000;

  function safeWrite(clients: Set<Response>, res: Response, payload: string): void {
    try {
      res.write(payload);
      if (res.socket && res.socket.writableLength > MAX_BUFFERED_BYTES) {
        clients.delete(res);
        res.destroy();
      }
    } catch {
      clients.delete(res);
      try { res.end(); } catch { /* already gone */ }
    }
  }

  function broadcast(wsId: string, event: string, data: unknown): void {
    const clients = sseClients.get(wsId);
    if (!clients) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of Array.from(clients)) {
      safeWrite(clients, res, payload);
    }
  }

  function closeStreams(wsId: string): void {
    const clients = sseClients.get(wsId);
    if (!clients) return;
    for (const res of Array.from(clients)) {
      try {
        res.write('event: snapshot\ndata: []\n\n');
        res.end();
      } catch { /* already gone */ }
    }
    sseClients.delete(wsId);
  }

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: true }));

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
    const input: UpsertInput = {
      id,
      status: body.status,
      name: clean(body.name, NAME_MAX),
      message: clean(body.message, MESSAGE_MAX),
      project: clean(body.project, NAME_MAX),
      source: body.source as string | undefined,
    };
    const max = cfg.multiTenant ? MAX_SESSIONS_PER_WORKSPACE : Infinity;
    const { session, evictedId, prevStatus } = store.upsertSession(wsId, input, max);
    if (evictedId) broadcast(wsId, 'remove', { id: evictedId });
    broadcast(wsId, 'session', session);
    // Fire-and-forget: enqueues async APNs work, never throws or blocks.
    pusher.notifyTransition(wsId, session, prevStatus);
    res.json({ ok: true, session });
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
    let clients = sseClients.get(wsId);
    if (!clients) {
      clients = new Set();
      sseClients.set(wsId, clients);
    }
    if (cfg.multiTenant && clients.size >= MAX_SSE_PER_WORKSPACE) {
      res.status(429).json({ error: 'too many concurrent connections' });
      return;
    }
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    clients.add(res);
    safeWrite(clients, res, `event: snapshot\ndata: ${JSON.stringify(store.getSessions(wsId))}\n\n`);
    const usage = store.getUsage(wsId);
    if (usage.length > 0) {
      safeWrite(clients, res, `event: usage\ndata: ${JSON.stringify(usage)}\n\n`);
    }
    req.on('close', () => {
      sseClients.get(wsId)?.delete(res);
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

    app.get('/api/usage', (_req, res) => {
      res.json(store.getUsage(LEGACY_WS));
    });

    app.delete('/sessions/:id', (req, res) => {
      const removed = store.deleteSession(LEGACY_WS, req.params.id);
      if (removed) broadcast(LEGACY_WS, 'remove', { id: req.params.id });
      res.json({ ok: removed });
    });

    app.post('/sessions/clear', requireSecret, (_req, res) => {
      store.clearSessions(LEGACY_WS);
      broadcast(LEGACY_WS, 'snapshot', []);
      res.json({ ok: true });
    });

    app.get('/api/sessions', (_req, res) => {
      res.json(store.getSessions(LEGACY_WS));
    });

    app.get('/events', (req, res) => handleEvents(LEGACY_WS, req, res));
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

    app.get('/w/:token/api/usage', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      res.json(store.getUsage(wsId));
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
      if (removed) broadcast(wsId, 'remove', { id: req.params.id });
      res.json({ ok: removed });
    });

    app.post('/w/:token/sessions/clear', (req, res) => {
      const wsId = resolveWs(req, res);
      if (!wsId) return;
      store.clearSessions(wsId);
      broadcast(wsId, 'snapshot', []);
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
        safeWrite(clients, res, ': keepalive\n\n');
      }
    }
  }, 25_000);
  keepalive.unref();
  timers.push(keepalive);

  if (cfg.sessionTtlMs > 0) {
    const sweep = setInterval(() => {
      for (const { wsId, id } of store.sweepExpiredSessions(cfg.sessionTtlMs)) {
        broadcast(wsId, 'remove', { id });
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
    for (const wsId of Array.from(sseClients.keys())) closeStreams(wsId);
    pusher.shutdown();
    // Drains queued writes then closes the pool; nothing left to surface here.
    void store.close().catch(() => undefined);
  }

  return { app, store, ready: store.ready, shutdown };
}
