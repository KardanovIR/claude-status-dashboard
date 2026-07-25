import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeApp, createWorkspace } from './helpers';

const windows = [
  { id: 'session', label: 'Current session', usedPct: 42, resetsAt: Date.now() + 3_600_000 },
  { id: 'week', label: 'Weekly (all models)', usedPct: 61.5, resetsAt: Date.now() + 86_400_000 },
];

describe('plan usage (multi-tenant)', () => {
  it('stores a usage report and returns it from GET /api/usage', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);

    await request(app)
      .post(`/w/${token}/usage`)
      .send({ source: 'claude', windows })
      .expect(200, { ok: true });

    const res = await request(app).get(`/w/${token}/api/usage`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].source).toBe('claude');
    expect(res.body[0].updatedAt).toBeTypeOf('number');
    expect(res.body[0].windows).toEqual(windows);
  });

  it('keeps one report per source, replacing on re-post', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);

    await request(app)
      .post(`/w/${token}/usage`)
      .send({ source: 'claude', windows })
      .expect(200);
    await request(app)
      .post(`/w/${token}/usage`)
      .send({ source: 'codex', windows: [{ id: 'session', usedPct: 10 }] })
      .expect(200);
    await request(app)
      .post(`/w/${token}/usage`)
      .send({ source: 'claude', windows: [{ id: 'session', usedPct: 99 }] })
      .expect(200);

    const res = await request(app).get(`/w/${token}/api/usage`).expect(200);
    expect(res.body.map((u: { source: string }) => u.source)).toEqual(['claude', 'codex']);
    expect(res.body[0].windows).toEqual([
      { id: 'session', label: 'session', usedPct: 99, resetsAt: null },
    ]);
  });

  it('clamps usedPct into 0-100 and nulls invalid resetsAt', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);

    await request(app)
      .post(`/w/${token}/usage`)
      .send({
        source: 'claude',
        windows: [
          { id: 'over', usedPct: 250, resetsAt: -5 },
          { id: 'under', usedPct: -3, resetsAt: 'soon' },
        ],
      })
      .expect(200);

    const res = await request(app).get(`/w/${token}/api/usage`).expect(200);
    expect(res.body[0].windows).toEqual([
      { id: 'over', label: 'over', usedPct: 100, resetsAt: null },
      { id: 'under', label: 'under', usedPct: 0, resetsAt: null },
    ]);
  });

  it('rejects malformed reports', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const post = (body: unknown) => request(app).post(`/w/${token}/usage`).send(body as object);

    await post({ windows }).expect(400); // missing source
    await post({ source: 'Claude!', windows }).expect(400); // bad source chars
    await post({ source: 'claude' }).expect(400); // missing windows
    await post({ source: 'claude', windows: [] }).expect(400); // empty
    await post({ source: 'claude', windows: [{ id: 'a' }] }).expect(400); // no usedPct
    await post({ source: 'claude', windows: [{ id: 'a', usedPct: NaN }] }).expect(400);
    await post({
      source: 'claude',
      windows: [
        { id: 'a', usedPct: 1 },
        { id: 'a', usedPct: 2 }, // duplicate id
      ],
    }).expect(400);
    await post({
      source: 'claude',
      windows: Array.from({ length: 7 }, (_, i) => ({ id: `w${i}`, usedPct: 1 })),
    }).expect(400); // too many windows

    await request(app).get(`/w/${token}/api/usage`).expect(200, []);
  });

  it('404s for an unknown workspace', async () => {
    const { app } = makeApp();
    const bogus = 'ags_' + 'a'.repeat(32);
    await request(app).post(`/w/${bogus}/usage`).send({ source: 'claude', windows }).expect(404);
    await request(app).get(`/w/${bogus}/api/usage`).expect(404);
  });

  it('deleting the workspace drops its usage', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/usage`).send({ source: 'claude', windows }).expect(200);

    await request(app).delete(`/w/${token}`).expect(200);
    const recreated = await createWorkspace(app);
    expect(store.getUsage(recreated === token ? '' : recreated)).toEqual([]);
    await request(app).get(`/w/${token}/api/usage`).expect(404);
  });
});

describe('plan usage (legacy mode)', () => {
  it('serves POST /usage and GET /api/usage, honoring the webhook secret', async () => {
    const { app } = makeApp({ multiTenant: false, webhookSecret: 's3cret' });

    await request(app).post('/usage').send({ source: 'claude', windows }).expect(401);
    await request(app)
      .post('/usage')
      .set('x-webhook-secret', 's3cret')
      .send({ source: 'claude', windows })
      .expect(200, { ok: true });

    const res = await request(app).get('/api/usage').expect(200);
    expect(res.body[0].windows).toEqual(windows);
  });
});

describe('plan usage (SSE)', () => {
  it('sends a usage frame on connect and broadcasts on new reports', async () => {
    const { app } = makeApp();
    const srv = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = srv.address() as import('net').AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const ac = new AbortController();

    try {
      const create = await fetch(`${base}/api/workspaces`, { method: 'POST' });
      const { token } = (await create.json()) as { token: string };

      await fetch(`${base}/w/${token}/usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'claude', windows }),
      });

      const res = await fetch(`${base}/w/${token}/events`, {
        signal: ac.signal,
        headers: { accept: 'text/event-stream' },
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const readUntil = async (needle: string) => {
        const deadline = Date.now() + 4000;
        while (!buf.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}: ${buf}`);
          const { done, value } = await reader.read();
          if (done) throw new Error(`stream ended before ${needle}: ${buf}`);
          buf += decoder.decode(value, { stream: true });
        }
      };

      // Connect: snapshot first, then the stored usage.
      await readUntil('event: snapshot');
      await readUntil('event: usage');
      expect(buf).toContain('Current session');

      // Live report while connected: another usage frame.
      buf = '';
      await fetch(`${base}/w/${token}/usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'claude', windows: [{ id: 'session', usedPct: 88 }] }),
      });
      await readUntil('event: usage');
      expect(buf).toContain('88');
    } finally {
      ac.abort();
      await new Promise<void>((resolve) => {
        (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        srv.close(() => resolve());
      });
    }
  });
});

describe('session source', () => {
  it('stores source from the webhook, defaulting to claude, and carries it forward', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);

    const first = await request(app)
      .post(`/w/${token}/webhook`)
      .send({ session_id: 'cx-1', status: 'coding', source: 'codex' })
      .expect(200);
    expect(first.body.session.source).toBe('codex');

    // Update without source: carried forward, not reset.
    const second = await request(app)
      .post(`/w/${token}/webhook`)
      .send({ session_id: 'cx-1', status: 'idle' })
      .expect(200);
    expect(second.body.session.source).toBe('codex');

    const noSource = await request(app)
      .post(`/w/${token}/webhook`)
      .send({ session_id: 'cl-1', status: 'coding' })
      .expect(200);
    expect(noSource.body.session.source).toBe('claude');
  });

  it('rejects a malformed source', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app)
      .post(`/w/${token}/webhook`)
      .send({ session_id: 's1', status: 'coding', source: 'Codex!' })
      .expect(400);
    await request(app)
      .post(`/w/${token}/webhook`)
      .send({ session_id: 's1', status: 'coding', source: 42 })
      .expect(400);
  });

  it('migrates a pre-source database in place (rows default to claude)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-migrate-'));
    const dbPath = path.join(dir, 'old.db');
    try {
      // Build a DB with the old sessions schema (no source column).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3') as typeof import('better-sqlite3');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
        CREATE TABLE sessions (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
          status TEXT NOT NULL, message TEXT NOT NULL, project TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, id)
        );
        INSERT INTO workspaces VALUES ('ws1', 1, 1);
        INSERT INTO sessions VALUES ('ws1', 'old-1', 'Old', 'idle', '', 'proj', 1, 1);
      `);
      db.close();

      const { store } = makeApp({ dbPath });
      const loaded = store.getSessions('ws1');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].source).toBe('claude');

      // Upserting into the migrated table works and persists source.
      store.upsertSession('ws1', { id: 'new-1', status: 'coding', source: 'codex' }, Infinity);
      expect(store.getSessions('ws1').find((s) => s.id === 'new-1')?.source).toBe('codex');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('plan usage (persistence)', () => {
  it('survives a store restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-usage-'));
    const dbPath = path.join(dir, 'test.db');
    try {
      const first = makeApp({ dbPath });
      const token = await createWorkspace(first.app);
      await request(first.app)
        .post(`/w/${token}/usage`)
        .send({ source: 'claude', windows })
        .expect(200);
      first.shutdown();

      const second = makeApp({ dbPath });
      const res = await request(second.app).get(`/w/${token}/api/usage`).expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].windows).toEqual(windows);
      second.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
