import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeApp, createWorkspace, webhookBody } from './helpers';

// 8 chars from the no-lookalike alphabet (no I/L/O/0/1), grouped XXXX-XXXX.
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

async function createCode(app: Express, token: string): Promise<string> {
  const res = await request(app).post(`/w/${token}/pair`).expect(201);
  return res.body.code as string;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pairing (multi mode)', () => {
  describe('POST /w/:token/pair', () => {
    it('returns 201 with a XXXX-XXXX code and expiresInSeconds 900', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      const res = await request(app).post(`/w/${token}/pair`).expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.code).toMatch(CODE_RE);
      expect(res.body.expiresInSeconds).toBe(900);
    });

    it('unknown workspace token gets 404 {error:"unknown workspace"}', async () => {
      const { app } = makeApp();
      const res = await request(app).post(`/w/ags_${'A'.repeat(32)}/pair`).expect(404);
      expect(res.body).toEqual({ error: 'unknown workspace' });
    });

    it('allows 3 outstanding codes, 429s the 4th, and creating does not invalidate earlier codes', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      const codes: string[] = [];
      for (let i = 1; i <= 3; i++) {
        codes.push(await createCode(app, token));
      }
      expect(new Set(codes).size).toBe(3);

      const blocked = await request(app).post(`/w/${token}/pair`).expect(429);
      expect(blocked.body).toEqual({ error: 'too many outstanding codes' });

      // The first code is still claimable — the cap rejects new codes only.
      await request(app).post('/api/pair/claim').send({ code: codes[0] }).expect(200);

      // Claiming freed a slot, so a new code can be created again.
      await request(app).post(`/w/${token}/pair`).expect(201);
    });

    it('the cap is per workspace: another workspace can still create codes', async () => {
      const { app } = makeApp();
      const tokenA = await createWorkspace(app);
      const tokenB = await createWorkspace(app);

      for (let i = 1; i <= 3; i++) await createCode(app, tokenA);
      await request(app).post(`/w/${tokenA}/pair`).expect(429);

      await request(app).post(`/w/${tokenB}/pair`).expect(201);
    });
  });

  describe('POST /api/pair/claim', () => {
    it('returns the escrowed token with URLs, and the token works against /w routes', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);
      await request(app).post(`/w/${token}/webhook`).send(webhookBody('paired-1')).expect(200);

      const code = await createCode(app, token);
      const res = await request(app).post('/api/pair/claim').send({ code }).expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.token).toBe(token);
      expect(res.body.dashboardUrl).toBe(`http://test.local/w/${token}`);
      expect(res.body.webhookUrl).toBe(`http://test.local/w/${token}/webhook`);

      // The claimed token resolves to the SAME workspace the code came from.
      const list = await request(app).get(`/w/${res.body.token}/api/sessions`).expect(200);
      expect(list.body.map((s: { id: string }) => s.id)).toEqual(['paired-1']);
    });

    it('consumes the code: a second claim gets 404', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);
      const code = await createCode(app, token);

      await request(app).post('/api/pair/claim').send({ code }).expect(200);

      const again = await request(app).post('/api/pair/claim').send({ code }).expect(404);
      expect(again.body).toEqual({ error: 'invalid or expired code' });
    });

    it('normalizes the code: lowercase, no dashes, and extra whitespace all claim', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);

      const mangle: Array<(code: string) => string> = [
        (c) => c.toLowerCase(),
        (c) => c.replace('-', ''),
        (c) => `  ${c.slice(0, 4)} ${c.slice(4, 5)}- ${c.slice(5)}  `,
      ];
      for (const fn of mangle) {
        const code = await createCode(app, token);
        const res = await request(app).post('/api/pair/claim').send({ code: fn(code) }).expect(200);
        expect(res.body.token).toBe(token);
      }
    });

    it('unknown or garbage codes get 404 {error:"invalid or expired code"}', async () => {
      const { app } = makeApp();
      for (const code of ['ZZZZ-ZZZZ', 'definitely not a code!!!', '']) {
        const res = await request(app).post('/api/pair/claim').send({ code }).expect(404);
        expect(res.body).toEqual({ error: 'invalid or expired code' });
      }
    });

    it('missing or non-string code gets 400 {error:"code is required"}', async () => {
      const { app } = makeApp();
      for (const body of [{}, { code: 12345678 }, { code: null }, { code: ['AAAA-AAAA'] }]) {
        const res = await request(app).post('/api/pair/claim').send(body).expect(400);
        expect(res.body).toEqual({ error: 'code is required' });
      }
    });

    it('a code for a since-deleted workspace gets 404 and is dropped', async () => {
      const { app } = makeApp();
      const token = await createWorkspace(app);
      const code = await createCode(app, token);

      await request(app).delete(`/w/${token}`).expect(200);

      const res = await request(app).post('/api/pair/claim').send({ code }).expect(404);
      expect(res.body).toEqual({ error: 'invalid or expired code' });

      // Dropped, not merely rejected: still 404 even if the same 8 chars are retried.
      await request(app).post('/api/pair/claim').send({ code }).expect(404);
    });
  });

  describe('claim rate limit (10/min/IP, rateLimit: true)', () => {
    it('allows 10 claim attempts in a minute, 429s the 11th', async () => {
      const { app } = makeApp({ rateLimit: true });

      for (let i = 1; i <= 10; i++) {
        const res = await request(app).post('/api/pair/claim').send({ code: 'ZZZZ-ZZZZ' });
        expect(res.status, `claim attempt #${i}`).toBe(404);
      }

      const blocked = await request(app).post('/api/pair/claim').send({ code: 'ZZZZ-ZZZZ' });
      expect(blocked.status).toBe(429);
    });

    it('is not enforced when rateLimit is false', async () => {
      const { app } = makeApp({ rateLimit: false });
      for (let i = 1; i <= 15; i++) {
        const res = await request(app).post('/api/pair/claim').send({ code: 'ZZZZ-ZZZZ' });
        expect(res.status, `claim attempt #${i}`).toBe(404);
      }
    });
  });

  describe('expiry (15-minute TTL)', () => {
    it('a code past its TTL no longer claims', async () => {
      const { app, store } = makeApp();
      const token = await createWorkspace(app);
      const code = store.createPairCode(token);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 901_000);

      expect(store.claimPairCode(code!)).toBeNull();
    });

    it('expired codes stop counting toward the 3-outstanding cap', async () => {
      const { app, store } = makeApp();
      const token = await createWorkspace(app);

      for (let i = 1; i <= 3; i++) expect(store.createPairCode(token)).not.toBeNull();
      expect(store.createPairCode(token)).toBeNull();

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 901_000);

      // The lazy sweep inside createPairCode clears the expired escrow.
      expect(store.createPairCode(token)).not.toBeNull();
    });

    it('a fresh code still claims just before the TTL', async () => {
      const { app, store } = makeApp();
      const token = await createWorkspace(app);
      const code = store.createPairCode(token)!;

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 899_000);

      expect(store.claimPairCode(code)).toEqual({ rawToken: token });
    });
  });
});

describe('pairing (legacy mode)', () => {
  it('pair and claim endpoints do not exist: both 404', async () => {
    const { app } = makeApp({ multiTenant: false });

    await request(app).post(`/w/ags_${'A'.repeat(32)}/pair`).expect(404);
    await request(app).post('/api/pair/claim').send({ code: 'AAAA-AAAA' }).expect(404);
  });
});
