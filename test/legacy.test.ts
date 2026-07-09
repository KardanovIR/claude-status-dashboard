import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, webhookBody } from './helpers';

const legacyApp = (overrides = {}) => makeApp({ multiTenant: false, ...overrides });

describe('legacy mode (multiTenant: false)', () => {
  describe('webhook upsert + listing', () => {
    it('POST /webhook upserts and returns {ok:true, session}; GET /api/sessions lists it', async () => {
      const { app } = legacyApp();

      const res = await request(app)
        .post('/webhook')
        .send({ session_id: 's1', status: 'coding', name: 'Agent One', message: 'building', project: 'proj' })
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.session).toMatchObject({
        id: 's1',
        name: 'Agent One',
        status: 'coding',
        message: 'building',
        project: 'proj',
      });
      expect(typeof res.body.session.createdAt).toBe('number');
      expect(typeof res.body.session.updatedAt).toBe('number');

      const list = await request(app).get('/api/sessions').expect(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ id: 's1', status: 'coding', name: 'Agent One' });
    });

    it('carries forward name/message/project on partial update', async () => {
      const { app } = legacyApp();

      await request(app)
        .post('/webhook')
        .send({ session_id: 's1', status: 'planning', name: 'Agent One', message: 'thinking', project: 'proj' })
        .expect(200);

      // Partial update: only session_id + status. v1 behavior keeps the rest.
      const res = await request(app)
        .post('/webhook')
        .send({ session_id: 's1', status: 'testing' })
        .expect(200);

      expect(res.body.session).toMatchObject({
        id: 's1',
        status: 'testing',
        name: 'Agent One',
        message: 'thinking',
        project: 'proj',
      });

      const list = await request(app).get('/api/sessions').expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ status: 'testing', name: 'Agent One', message: 'thinking', project: 'proj' });
    });

    it('defaults name to the session id when never provided', async () => {
      const { app } = legacyApp();
      const res = await request(app).post('/webhook').send(webhookBody('bare-id')).expect(200);
      expect(res.body.session.name).toBe('bare-id');
    });
  });

  describe('webhook secret', () => {
    it('missing X-Webhook-Secret is 401 when a secret is configured', async () => {
      const { app } = legacyApp({ webhookSecret: 'hunter2' });
      await request(app).post('/webhook').send(webhookBody('s1')).expect(401);
    });

    it('wrong X-Webhook-Secret is 401', async () => {
      const { app } = legacyApp({ webhookSecret: 'hunter2' });
      await request(app)
        .post('/webhook')
        .set('X-Webhook-Secret', 'wrong')
        .send(webhookBody('s1'))
        .expect(401);
    });

    it('correct X-Webhook-Secret is 200', async () => {
      const { app } = legacyApp({ webhookSecret: 'hunter2' });
      const res = await request(app)
        .post('/webhook')
        .set('X-Webhook-Secret', 'hunter2')
        .send(webhookBody('s1'))
        .expect(200);
      expect(res.body.ok).toBe(true);
    });

    it('no secret configured: webhook is open', async () => {
      const { app } = legacyApp();
      await request(app).post('/webhook').send(webhookBody('s1')).expect(200);
    });
  });

  describe('session deletion', () => {
    it('DELETE /sessions/:id works unauthenticated even with a secret configured', async () => {
      const { app } = legacyApp({ webhookSecret: 'hunter2' });
      await request(app)
        .post('/webhook')
        .set('X-Webhook-Secret', 'hunter2')
        .send(webhookBody('doomed'))
        .expect(200);

      const del = await request(app).delete('/sessions/doomed').expect(200);
      expect(del.body.ok).toBe(true);

      const list = await request(app).get('/api/sessions').expect(200);
      expect(list.body).toHaveLength(0);
    });

    it('DELETE /sessions/:id of a nonexistent session returns ok:false', async () => {
      const { app } = legacyApp();
      const del = await request(app).delete('/sessions/nope').expect(200);
      expect(del.body.ok).toBe(false);
    });

    it('POST /sessions/clear requires the secret when set', async () => {
      const { app } = legacyApp({ webhookSecret: 'hunter2' });
      await request(app)
        .post('/webhook')
        .set('X-Webhook-Secret', 'hunter2')
        .send(webhookBody('s1'))
        .expect(200);

      await request(app).post('/sessions/clear').expect(401);
      await request(app).post('/sessions/clear').set('X-Webhook-Secret', 'wrong').expect(401);

      const ok = await request(app).post('/sessions/clear').set('X-Webhook-Secret', 'hunter2').expect(200);
      expect(ok.body.ok).toBe(true);

      const list = await request(app).get('/api/sessions').expect(200);
      expect(list.body).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it('rejects a bad status with 400', async () => {
      const { app } = legacyApp();
      await request(app)
        .post('/webhook')
        .send({ session_id: 's1', status: 'exploding' })
        .expect(400);
    });

    it('rejects a missing session_id with 400', async () => {
      const { app } = legacyApp();
      await request(app).post('/webhook').send({ status: 'coding' }).expect(400);
    });

    it.each([
      ['space', 'a b'],
      ['slashes / dots traversal', 'x/../y'],
      ['too long (129 chars)', 'a'.repeat(129)],
    ])('rejects session_id with illegal chars: %s', async (_label, sessionId) => {
      const { app } = legacyApp();
      await request(app)
        .post('/webhook')
        .send({ session_id: sessionId, status: 'coding' })
        .expect(400);
    });

    it('accepts session_id at the 128-char boundary and with allowed punctuation', async () => {
      const { app } = legacyApp();
      await request(app).post('/webhook').send(webhookBody('a'.repeat(128))).expect(200);
      await request(app).post('/webhook').send(webhookBody('a.B_c:d-e')).expect(200);
    });

    it('truncates name to 120 chars and message to 300 chars', async () => {
      const { app } = legacyApp();
      const res = await request(app)
        .post('/webhook')
        .send(webhookBody('s1', { name: 'n'.repeat(200), message: 'm'.repeat(400) }))
        .expect(200);

      expect(res.body.session.name).toBe('n'.repeat(120));
      expect(res.body.session.message).toBe('m'.repeat(300));
    });

    it('strips control characters from name and message', async () => {
      const { app } = legacyApp();
      const res = await request(app)
        .post('/webhook')
        .send(webhookBody('s1', { name: 'ab\u0000cd\u0007ef', message: 'one\u0001two\u001Ftree' }))
        .expect(200);

      expect(res.body.session.name).toBe('abcdef');
      expect(res.body.session.message).toBe('onetwotree');
    });
  });

  describe('health', () => {
    it('GET /healthz includes ok:true', async () => {
      const { app } = legacyApp();
      const res = await request(app).get('/healthz').expect(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
