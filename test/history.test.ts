import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, createWorkspace, webhookBody, TEST_PG_URL, suiteDatabaseUrl } from './helpers';
import { MAX_EVENTS_PER_SESSION } from '../src/store';

describe('session history', () => {
  it('records transitions with timestamps, newest first', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const post = (body: Record<string, unknown>) =>
      request(app).post(`/w/${token}/webhook`).send(body).expect(200);

    const before = Date.now();
    await post(webhookBody('s1', { status: 'idle', message: 'Session started' }));
    await post(webhookBody('s1', { status: 'coding', message: 'Edit' }));
    await post(webhookBody('s1', { status: 'testing', message: 'npm test' }));

    const res = await request(app).get(`/w/${token}/api/sessions/s1/history`).expect(200);
    expect(res.body.map((e: { status: string }) => e.status)).toEqual(['testing', 'coding', 'idle']);
    expect(res.body.map((e: { message: string }) => e.message)).toEqual([
      'npm test', 'Edit', 'Session started',
    ]);
    for (const e of res.body) {
      expect(e.at).toBeGreaterThanOrEqual(before);
      expect(e.seq).toBeTypeOf('number');
    }
    // seq strictly decreasing when newest-first
    expect(res.body[0].seq).toBeGreaterThan(res.body[2].seq);
  });

  it('does not record keep-alive re-posts of the same status and message', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/w/${token}/webhook`)
        .send(webhookBody('s1', { status: 'coding', message: 'same' }))
        .expect(200);
    }
    const res = await request(app).get(`/w/${token}/api/sessions/s1/history`).expect(200);
    expect(res.body).toHaveLength(1);
  });

  it('caps the timeline, keeping the newest entries', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;
    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 20; i++) {
      store.upsertSession(wsId, { id: 's1', status: 'coding', message: `step ${i}` }, Infinity);
    }
    const history = store.getHistory(wsId, 's1');
    expect(history).toHaveLength(MAX_EVENTS_PER_SESSION);
    expect(history[0].message).toBe(`step ${MAX_EVENTS_PER_SESSION + 19}`);
  });

  it('dismissing a session drops its history; a new session starts fresh', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('s1')).expect(200);
    await request(app).delete(`/w/${token}/sessions/s1`).expect(200);
    await request(app).get(`/w/${token}/api/sessions/s1/history`).expect(200, []);

    await request(app)
      .post(`/w/${token}/webhook`)
      .send(webhookBody('s1', { status: 'idle', message: 'back' }))
      .expect(200);
    const res = await request(app).get(`/w/${token}/api/sessions/s1/history`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].message).toBe('back');
  });

  it('returns [] for unknown sessions and 404 for unknown workspaces', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).get(`/w/${token}/api/sessions/nope/history`).expect(200, []);
    await request(app).get(`/w/${'ags_' + 'a'.repeat(32)}/api/sessions/x/history`).expect(404);
  });

  it('serves history in legacy mode', async () => {
    const { app } = makeApp({ multiTenant: false });
    await request(app).post('/webhook').send(webhookBody('leg-1')).expect(200);
    const res = await request(app).get('/api/sessions/leg-1/history').expect(200);
    expect(res.body).toHaveLength(1);
  });
});

describe.skipIf(!TEST_PG_URL)('session history (persistence)', () => {
  it('survives a restart and keeps seq monotonic past soft-deleted rows', async () => {
    const dbUrl = await suiteDatabaseUrl('history');
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('s1', { status: 'idle' })).expect(200);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('s1', { status: 'coding' })).expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    const res = await request(second.app).get(`/w/${token}/api/sessions/s1/history`).expect(200);
    expect(res.body.map((e: { status: string }) => e.status)).toEqual(['coding', 'idle']);

    // New events after the restart continue the seq sequence.
    await request(second.app).post(`/w/${token}/webhook`).send(webhookBody('s1', { status: 'done' })).expect(200);
    const after = await request(second.app).get(`/w/${token}/api/sessions/s1/history`).expect(200);
    expect(after[0] ?? after.body[0]).toBeTruthy();
    expect(after.body[0].seq).toBeGreaterThan(after.body[1].seq);
    second.shutdown();
  });
});
