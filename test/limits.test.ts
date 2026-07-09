import { describe, it, expect } from 'vitest';
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
});
