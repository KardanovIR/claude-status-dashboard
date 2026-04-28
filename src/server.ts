import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 0);

const STATUSES = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'] as const;
type Status = (typeof STATUSES)[number];

interface Session {
  id: string;
  name: string;
  status: Status;
  message: string;
  project: string;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, Session>();
const sseClients = new Set<Response>();

const isStatus = (s: unknown): s is Status =>
  typeof s === 'string' && (STATUSES as readonly string[]).includes(s);

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v.slice(0, 500) : fallback;

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* client gone */ }
  }
}

function requireSecret(req: Request, res: Response, next: NextFunction): void {
  if (!WEBHOOK_SECRET) return next();
  const provided = req.header('x-webhook-secret') || '';
  const expected = WEBHOOK_SECRET;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.post('/webhook', requireSecret, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = str(body.session_id);
  if (!id) {
    res.status(400).json({ error: 'session_id is required' });
    return;
  }
  if (!isStatus(body.status)) {
    res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    return;
  }

  const now = Date.now();
  const prev = sessions.get(id);
  const session: Session = {
    id,
    name: str(body.name) || prev?.name || id,
    status: body.status,
    message: str(body.message, prev?.message ?? ''),
    project: str(body.project, prev?.project ?? ''),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  sessions.set(id, session);
  broadcast('session', session);
  res.json({ ok: true, session });
});

app.delete('/sessions/:id', requireSecret, (req: Request, res: Response) => {
  const removed = sessions.delete(req.params.id);
  if (removed) broadcast('remove', { id: req.params.id });
  res.json({ ok: removed });
});

app.post('/sessions/clear', requireSecret, (_req: Request, res: Response) => {
  sessions.clear();
  broadcast('snapshot', []);
  res.json({ ok: true });
});

app.get('/api/sessions', (_req: Request, res: Response) => {
  const list = Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(list);
});

app.get('/api/config', (_req: Request, res: Response) => {
  res.json({
    webhookUrl: `${PUBLIC_URL}/webhook`,
    requiresSecret: Boolean(WEBHOOK_SECRET),
    statuses: STATUSES,
  });
});

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.get('/events', (req: Request, res: Response) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  sseClients.add(res);

  const snapshot = Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

if (SESSION_TTL_MS > 0) {
  setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) {
      if (s.updatedAt < cutoff) {
        sessions.delete(id);
        broadcast('remove', { id });
      }
    }
  }, Math.min(SESSION_TTL_MS, 60_000)).unref();
}

app.listen(PORT, HOST, () => {
  console.log(`Claude status dashboard listening on http://${HOST}:${PORT}`);
  console.log(`Dashboard: ${PUBLIC_URL}`);
  console.log(`Webhook:   ${PUBLIC_URL}/webhook`);
  if (WEBHOOK_SECRET) console.log('Auth:      X-Webhook-Secret header required');
});
