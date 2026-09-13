import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { makeApp, createWorkspace, webhookBody } from './helpers';

describe('rate limiting (rateLimit: true)', () => {
  describe('POST /api/workspaces (~20/hour/IP)', () => {
    it('allows 20 creations from one client, 429s the 21st', async () => {
      const { app } = makeApp({ rateLimit: true });

      for (let i = 1; i <= 20; i++) {
        const res = await request(app).post('/api/workspaces');
        expect(res.status, `workspace creation #${i}`).toBe(201);
      }

      const blocked = await request(app).post('/api/workspaces');
      expect(blocked.status).toBe(429);
    });

    it('is not enforced when rateLimit is false', async () => {
      const { app } = makeApp({ rateLimit: false });
      for (let i = 1; i <= 25; i++) {
        const res = await request(app).post('/api/workspaces');
        expect(res.status, `workspace creation #${i}`).toBe(201);
      }
    });
  });

  describe('webhook (120 req/min per workspace)', () => {
    // retry: this test fires 121 sequential local HTTP requests and is
    // occasionally disturbed by ephemeral-port interference on busy machines.
    it('allows 120 posts in a minute, 429s the 121st', { retry: 2 }, async () => {
      const { app } = makeApp({ rateLimit: true });
      const token = await createWorkspace(app);

      for (let i = 1; i <= 120; i++) {
        const res = await request(app).post(`/w/${token}/webhook`).send(webhookBody('hot'));
        expect(res.status, `webhook post #${i}`).toBe(200);
      }

      const blocked = await request(app).post(`/w/${token}/webhook`).send(webhookBody('hot'));
      expect(blocked.status).toBe(429);
    });

    it('is scoped per workspace: exhausting one workspace does not affect another', async () => {
      const { app } = makeApp({ rateLimit: true });
      const tokenA = await createWorkspace(app);
      const tokenB = await createWorkspace(app);

      for (let i = 1; i <= 120; i++) {
        const res = await request(app).post(`/w/${tokenA}/webhook`).send(webhookBody('hot'));
        expect(res.status, `webhook post #${i} to A`).toBe(200);
      }
      await request(app).post(`/w/${tokenA}/webhook`).send(webhookBody('hot')).expect(429);

      // Workspace B has its own budget
      await request(app).post(`/w/${tokenB}/webhook`).send(webhookBody('cool')).expect(200);
    });
  });

  describe('Focus commands (10 req/min per workspace, separate from the webhook budget)', () => {
    const host = { machine: { id: '9f2c'.repeat(8), name: 'Mac' }, app: { slug: 'agterm', name: 'agterm', kind: 'terminal' } };
    const tap = (session: string) => ({ id: crypto.randomUUID(), type: 'focus', session_id: session });

    it('allows 10 commands in a minute, 429s the 11th; the webhook still works', async () => {
      const { app } = makeApp({ rateLimit: true });
      const token = await createWorkspace(app);
      // A pending command per session so the pending cap (also 10) is not what fires.
      for (let i = 1; i <= 11; i++) {
        await request(app).post(`/w/${token}/webhook`).send(webhookBody(`s-${i}`, { host })).expect(200);
      }

      for (let i = 1; i <= 10; i++) {
        const res = await request(app).post(`/w/${token}/commands`).send(tap(`s-${i}`));
        expect(res.status, `command #${i}`).toBe(200);
      }
      const blocked = await request(app).post(`/w/${token}/commands`).send(tap('s-11'));
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ error: 'rate limit exceeded' });

      await request(app).post(`/w/${token}/webhook`).send(webhookBody('s-1')).expect(200);
    });

    it('is scoped per workspace and not enforced when rateLimit is false', async () => {
      const limited = makeApp({ rateLimit: true });
      const tokenA = await createWorkspace(limited.app);
      const tokenB = await createWorkspace(limited.app);
      for (const t of [tokenA, tokenB]) {
        await request(limited.app).post(`/w/${t}/webhook`).send(webhookBody('s', { host })).expect(200);
      }
      // Re-taps coalesce, so only one stays pending: the limiter alone decides here.
      for (let i = 1; i <= 10; i++) {
        await request(limited.app).post(`/w/${tokenA}/commands`).send(tap('s')).expect(200);
      }
      await request(limited.app).post(`/w/${tokenA}/commands`).send(tap('s')).expect(429);
      await request(limited.app).post(`/w/${tokenB}/commands`).send(tap('s')).expect(200);

      const open = makeApp({ rateLimit: false });
      const token = await createWorkspace(open.app);
      await request(open.app).post(`/w/${token}/webhook`).send(webhookBody('s', { host })).expect(200);
      for (let i = 1; i <= 15; i++) {
        await request(open.app).post(`/w/${token}/commands`).send(tap('s')).expect(200);
      }
    });
  });
});
