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
