import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  makeApp,
  createWorkspace,
  webhookBody,
  TEST_PG_URL,
  suiteDatabaseUrl,
  resetTables,
} from './helpers';

describe.skipIf(!TEST_PG_URL)('persistence (PostgreSQL)', () => {
  let dbUrl = '';

  beforeAll(async () => {
    dbUrl = await suiteDatabaseUrl('persistence');
  });
  beforeEach(() => resetTables(dbUrl));

  it('workspaces and sessions survive a restart against the same database', async () => {
    // First app: create a workspace and post a session, then shut down.
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app)
      .post(`/w/${token}/webhook`)
      .send(webhookBody('persisted', { name: 'Keeper', message: 'still here', project: 'proj' }))
      .expect(200);
    await first.store.flush();
    first.shutdown();

    // Second app on the same database: token resolves, session is still there.
    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        id: 'persisted',
        status: 'coding',
        name: 'Keeper',
        message: 'still here',
        project: 'proj',
        source: 'claude',
      });

      // Token also resolves for the dashboard route
      const html = await request(second.app).get(`/w/${token}`).expect(200);
      expect(html.headers['content-type']).toMatch(/text\/html/);
    } finally {
      second.shutdown();
    }
  });

  it('a workspace deleted before shutdown stays deleted after restart', async () => {
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('gone')).expect(200);
    await request(first.app).delete(`/w/${token}`).expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const res = await request(second.app).get(`/w/${token}/api/sessions`).expect(404);
      expect(res.body).toEqual({ error: 'unknown workspace' });
    } finally {
      second.shutdown();
    }
  });

  it('a session host survives a restart, and every soft delete keeps it on the row', async () => {
    const host = {
      machine: { id: '9f2c'.repeat(8), name: 'Mac' },
      app: { slug: 'herdr', name: 'herdr', kind: 'multiplexer' },
    };
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('hosted', { host })).expect(200);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('dismissed', { host })).expect(200);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('bare')).expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      const byId = new Map(list.body.map((s: { id: string; host: unknown }) => [s.id, s.host]));
      expect(byId.get('hosted')).toEqual(host);
      expect(byId.get('dismissed')).toEqual(host);
      expect(byId.get('bare')).toBeNull();

      // One session dismissed, then the whole workspace. Both soft deletes must
      // leave the row FLAGGED AND STILL CARRYING ITS HOST. Every one of these
      // paths used to null the column — dismiss, workspace delete, cap
      // eviction, clear, and the daily TTL sweep — which destroyed the machine
      // and app a session ran on rather than hiding it. Deleting hides; it does
      // not erase.
      await request(second.app).delete(`/w/${token}/sessions/dismissed`).expect(200);
      await request(second.app).delete(`/w/${token}`).expect(200);
      await second.store.flush();
    } finally {
      second.shutdown();
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    try {
      const rows = await pool.query(
        'SELECT id, host, deleted_at FROM sessions WHERE id IN ($1, $2) ORDER BY id',
        ['dismissed', 'hosted']
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows as Array<{ id: string; host: string | null; deleted_at: string | null }>) {
        expect(row.deleted_at, row.id).not.toBeNull();
        // Flagged AND intact. This assertion is inverted from what it was: it
        // used to require the host be gone, which is what made a delete
        // destructive. If a future change reintroduces a `host = NULL` on any
        // soft-delete path, this fails.
        expect(row.host, row.id).not.toBeNull();
      }
    } finally {
      await pool.end();
    }

    const third = makeApp({ databaseUrl: dbUrl });
    await third.ready;
    try {
      await request(third.app).get(`/w/${token}/api/sessions`).expect(404);
    } finally {
      third.shutdown();
    }
  });

  it('a malformed host column loads as null instead of failing the load', async () => {
    // Not JSON, and well-formed JSON of the wrong shape: none of it may reach
    // the board, and none of it may break the load.
    const corrupt: Record<string, string> = {
      'not-json': '{not json',
      'wrong-shape': '{"cwd":"/Users/x"}',
      'a-string': '"x"',
      'an-array': '[]',
    };
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    for (const id of Object.keys(corrupt)) {
      await request(first.app).post(`/w/${token}/webhook`).send(webhookBody(id)).expect(200);
    }
    await first.store.flush();
    first.shutdown();

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    try {
      for (const [id, host] of Object.entries(corrupt)) {
        await pool.query('UPDATE sessions SET host = $2 WHERE id = $1', [id, host]);
      }
    } finally {
      await pool.end();
    }

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body.map((s: { id: string }) => s.id).sort()).toEqual(Object.keys(corrupt).sort());
      for (const s of list.body as Array<{ id: string; host: unknown }>) {
        expect(s.host, s.id).toBeNull();
      }
    } finally {
      second.shutdown();
    }
  });

  it('write ordering holds: an upsert never resurrects a later delete', async () => {
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    // Rapid upsert → delete → upsert → delete without flushing in between:
    // the serialized write queue must replay them in order.
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('flappy')).expect(200);
    await request(first.app).delete(`/w/${token}/sessions/flappy`).expect(200);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('flappy')).expect(200);
    await request(first.app).delete(`/w/${token}/sessions/flappy`).expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    try {
      const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body).toEqual([]);
    } finally {
      second.shutdown();
    }
  });
});
