import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, createWorkspace, webhookBody, sleep } from './helpers';

const TOKEN_RE = /^ags_[A-Za-z0-9_-]{32}$/;

describe('multi mode (multiTenant: true)', () => {
  describe('workspace creation', () => {
    it('POST /api/workspaces returns 201 with token and URLs built from publicUrl', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/api/workspaces').expect(201);

      expect(res.body.ok).toBe(true);
      expect(res.body.token).toMatch(TOKEN_RE);
      expect(res.body.dashboardUrl).toBe(`http://test.local/w/${res.body.token}`);
      expect(res.body.webhookUrl).toBe(`http://test.local/w/${res.body.token}/webhook`);
    });

    it('issues distinct tokens per workspace', async () => {
      const { app } = makeApp();
      const a = await createWorkspace(app);
      const b = await createWorkspace(app);
      expect(a).not.toBe(b);
    });
  });

  describe('scoped webhook + sessions', () => {
    it('webhook and session list work end-to-end through /w/:token', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      const hook = await request(app)
        .post(`/w/${token}/webhook`)
        .send(webhookBody('s1', { name: 'Agent', message: 'hi', project: 'p' }))
        .expect(200);
      expect(hook.body.ok).toBe(true);
      expect(hook.body.session).toMatchObject({
        id: 's1',
        name: 'Agent',
        status: 'coding',
        message: 'hi',
        project: 'p',
      });

      const list = await request(app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ id: 's1', status: 'coding' });
    });

    it('lists sessions sorted by updatedAt desc', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      await request(app).post(`/w/${token}/webhook`).send(webhookBody('older')).expect(200);
      await sleep(10);
      await request(app).post(`/w/${token}/webhook`).send(webhookBody('newer')).expect(200);

      const list = await request(app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body.map((s: { id: string }) => s.id)).toEqual(['newer', 'older']);
    });

    it('validates webhook input on scoped routes too', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);
      await request(app)
        .post(`/w/${token}/webhook`)
        .send({ session_id: 's1', status: 'nonsense' })
        .expect(400);
      await request(app)
        .post(`/w/${token}/webhook`)
        .send({ status: 'coding' })
        .expect(400);
    });
  });

  describe('workspace isolation', () => {
    it('sessions posted to workspace A do not appear in workspace B', async () => {
      const { app } = makeApp();
      const tokenA = await createWorkspace(app);
      const tokenB = await createWorkspace(app);

      await request(app).post(`/w/${tokenA}/webhook`).send(webhookBody('only-in-a')).expect(200);
      await request(app).post(`/w/${tokenB}/webhook`).send(webhookBody('only-in-b')).expect(200);

      const listA = await request(app).get(`/w/${tokenA}/api/sessions`).expect(200);
      const listB = await request(app).get(`/w/${tokenB}/api/sessions`).expect(200);

      expect(listA.body.map((s: { id: string }) => s.id)).toEqual(['only-in-a']);
      expect(listB.body.map((s: { id: string }) => s.id)).toEqual(['only-in-b']);
    });
  });

  describe('unknown / malformed tokens', () => {
    const unknownWellFormed = `ags_${'A'.repeat(32)}`;
    const malformed = 'definitely-not-a-token';

    for (const [label, token] of [
      ['well-formed but unknown', unknownWellFormed],
      ['malformed', malformed],
    ] as const) {
      it(`${label} token gets 404 {error:"unknown workspace"} on every /w route`, async () => {
        const { app } = makeApp();

        const checks = [
          request(app).get(`/w/${token}`),
          request(app).get(`/w/${token}/api/sessions`),
          request(app).get(`/w/${token}/events`),
          request(app).post(`/w/${token}/webhook`).send(webhookBody('s1')),
          request(app).delete(`/w/${token}/sessions/s1`),
          request(app).post(`/w/${token}/sessions/clear`),
          request(app).delete(`/w/${token}`),
        ];

        for (const check of checks) {
          const res = await check.expect(404);
          expect(res.body).toEqual({ error: 'unknown workspace' });
        }
      });
    }
  });

  describe('legacy endpoints are disabled', () => {
    it('global webhook/sessions/events endpoints return 404 in multi mode', async () => {
      const { app } = makeApp();

      await request(app).post('/webhook').send(webhookBody('s1')).expect(404);
      await request(app).get('/api/sessions').expect(404);
      await request(app).get('/events').expect(404);
      await request(app).delete('/sessions/s1').expect(404);
      await request(app).post('/sessions/clear').expect(404);
    });
  });

  describe('dashboard HTML', () => {
    it('GET /w/:token (and with trailing slash) serves HTML for a valid token', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      const res = await request(app).get(`/w/${token}`).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text.length).toBeGreaterThan(0);

      const slash = await request(app).get(`/w/${token}/`).expect(200);
      expect(slash.headers['content-type']).toMatch(/text\/html/);
    });
  });

  describe('scoped deletes', () => {
    it('DELETE /w/:token/sessions/:id deletes only within that workspace', async () => {
      const { app } = makeApp();
      const tokenA = await createWorkspace(app);
      const tokenB = await createWorkspace(app);

      // Same session id in both workspaces
      await request(app).post(`/w/${tokenA}/webhook`).send(webhookBody('shared')).expect(200);
      await request(app).post(`/w/${tokenB}/webhook`).send(webhookBody('shared')).expect(200);

      const del = await request(app).delete(`/w/${tokenA}/sessions/shared`).expect(200);
      expect(del.body.ok).toBe(true);

      const listA = await request(app).get(`/w/${tokenA}/api/sessions`).expect(200);
      expect(listA.body).toHaveLength(0);

      // B's session with the same id is untouched
      const listB = await request(app).get(`/w/${tokenB}/api/sessions`).expect(200);
      expect(listB.body.map((s: { id: string }) => s.id)).toEqual(['shared']);
    });

    it('cannot delete another workspace\'s session (ok:false, session survives)', async () => {
      const { app } = makeApp();
      const tokenA = await createWorkspace(app);
      const tokenB = await createWorkspace(app);

      await request(app).post(`/w/${tokenB}/webhook`).send(webhookBody('b-only')).expect(200);

      const del = await request(app).delete(`/w/${tokenA}/sessions/b-only`).expect(200);
      expect(del.body.ok).toBe(false);

      const listB = await request(app).get(`/w/${tokenB}/api/sessions`).expect(200);
      expect(listB.body).toHaveLength(1);
    });
  });

  describe('workspace deletion', () => {
    it('DELETE /w/:token returns ok:true, then every /w/:token route is 404', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);
      await request(app).post(`/w/${token}/webhook`).send(webhookBody('s1')).expect(200);

      const del = await request(app).delete(`/w/${token}`).expect(200);
      expect(del.body).toMatchObject({ ok: true });

      const checks = [
        request(app).get(`/w/${token}`),
        request(app).get(`/w/${token}/api/sessions`),
        request(app).post(`/w/${token}/webhook`).send(webhookBody('s2')),
        request(app).delete(`/w/${token}/sessions/s1`),
        request(app).delete(`/w/${token}`),
      ];
      for (const check of checks) {
        const res = await check.expect(404);
        expect(res.body).toEqual({ error: 'unknown workspace' });
      }
    });

    it('deleting one workspace leaves others intact', async () => {
      const { app } = makeApp();
      const tokenA = await createWorkspace(app);
      const tokenB = await createWorkspace(app);
      await request(app).post(`/w/${tokenB}/webhook`).send(webhookBody('keep')).expect(200);

      await request(app).delete(`/w/${tokenA}`).expect(200);

      const listB = await request(app).get(`/w/${tokenB}/api/sessions`).expect(200);
      expect(listB.body).toHaveLength(1);
    });
  });

  describe('session cap (50 per workspace)', () => {
    it('a 51st NEW session evicts the oldest-updated session and count stays 50', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      // Post the future-oldest session first, then wait so its updatedAt is
      // strictly older than every other session (avoids same-ms ties).
      await request(app).post(`/w/${token}/webhook`).send(webhookBody('cap-1')).expect(200);
      await sleep(15);

      for (let i = 2; i <= 50; i++) {
        await request(app).post(`/w/${token}/webhook`).send(webhookBody(`cap-${i}`)).expect(200);
      }

      const before = await request(app).get(`/w/${token}/api/sessions`).expect(200);
      expect(before.body).toHaveLength(50);

      await request(app).post(`/w/${token}/webhook`).send(webhookBody('cap-51')).expect(200);

      const after = await request(app).get(`/w/${token}/api/sessions`).expect(200);
      const ids = after.body.map((s: { id: string }) => s.id);
      expect(after.body).toHaveLength(50);
      expect(ids).toContain('cap-51');
      expect(ids).not.toContain('cap-1');
      expect(ids).toContain('cap-2');
    });

    it('updating an existing session at the cap does not evict anything', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      for (let i = 1; i <= 50; i++) {
        await request(app).post(`/w/${token}/webhook`).send(webhookBody(`cap-${i}`)).expect(200);
      }
      // Upsert of an EXISTING id must not trigger eviction
      await request(app)
        .post(`/w/${token}/webhook`)
        .send(webhookBody('cap-25', { status: 'done' }))
        .expect(200);

      const list = await request(app).get(`/w/${token}/api/sessions`).expect(200);
      expect(list.body).toHaveLength(50);
      const ids = list.body.map((s: { id: string }) => s.id);
      for (let i = 1; i <= 50; i++) expect(ids).toContain(`cap-${i}`);
    });
  });

  describe('config + health', () => {
    it('GET /api/config reports mode "multi" with version and statuses', async () => {
      const { app } = makeApp();
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mode).toBe('multi');
      expect(res.body.version).toBe('test');
      expect(res.body.statuses).toEqual(
        expect.arrayContaining(['idle', 'planning', 'coding', 'testing', 'blocked', 'done']),
      );
    });

    it('GET /healthz has ok/version and no session count in multi mode', async () => {
      const { app } = makeApp();
      const res = await request(app).get('/healthz').expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.version).toBe('test');
      expect(res.body).not.toHaveProperty('sessions');
    });
  });

  describe('CORS on /w routes', () => {
    it('GET /w/:token/api/sessions carries access-control-allow-origin: *', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      const res = await request(app)
        .get(`/w/${token}/api/sessions`)
        .set('Origin', 'http://elsewhere.example')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('OPTIONS preflight returns 204 with allowed methods', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      const res = await request(app)
        .options(`/w/${token}/api/sessions`)
        .set('Origin', 'http://elsewhere.example')
        .set('Access-Control-Request-Method', 'DELETE')
        .set('Access-Control-Request-Headers', 'content-type')
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBe('*');
      const methods = res.headers['access-control-allow-methods'] ?? '';
      expect(methods).toMatch(/GET/);
      expect(methods).toMatch(/POST/);
      expect(methods).toMatch(/DELETE/);
    });
  });
});
