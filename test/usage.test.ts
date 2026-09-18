import { describe, it, expect, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeApp, createWorkspace, webhookBody, TEST_PG_URL, suiteDatabaseUrl } from './helpers';

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

});

/**
 * Lifetime tokens per session: stored under (workspace, source, session_id),
 * served as an additive `tokens` field on the card, absent when unknown.
 */
describe('per-session token totals', () => {
  const totals = (app: Express, token: string, body: unknown) =>
    request(app).post(`/w/${token}/usage/sessions`).send(body as object);

  it('attaches a reported total to the card, keyed by the session source', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('s-1')).expect(200);
    await request(app)
      .post(`/w/${token}/webhook`)
      .send(webhookBody('cx-1', { source: 'codex' }))
      .expect(200);

    await totals(app, token, { source: 'claude', sessions: [{ session_id: 's-1', tokens: 1_284_000 }] })
      .expect(200, { ok: true, sessions: 1 });

    const list = await request(app).get(`/w/${token}/api/sessions`).expect(200);
    const byId = new Map(list.body.map((s: { id: string; tokens?: number }) => [s.id, s.tokens]));
    expect(byId.get('s-1')).toBe(1_284_000);
    // A Codex card is not fed by a Claude report, even for the same id.
    expect(byId.get('cx-1')).toBeUndefined();
  });

  it('leaves the key absent — not zero — for a session nothing was reported for', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const hook = await request(app).post(`/w/${token}/webhook`).send(webhookBody('quiet')).expect(200);
    expect(hook.body.session).not.toHaveProperty('tokens');
    const list = await request(app).get(`/w/${token}/api/sessions`).expect(200);
    expect(list.body[0]).not.toHaveProperty('tokens');
  });

  it('replaces the stored value, including downwards, and is idempotent', async () => {
    // The hook's counter legitimately restarts (lost state file, or a session
    // evicted by its own cap and later resumed), so a smaller total is news,
    // not corruption.
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('s-1')).expect(200);
    const tokensOf = async (): Promise<number | undefined> =>
      (await request(app).get(`/w/${token}/api/sessions`).expect(200)).body[0].tokens;

    for (const n of [500, 500, 900, 40]) {
      await totals(app, token, { source: 'claude', sessions: [{ session_id: 's-1', tokens: n }] }).expect(200);
      expect(await tokensOf()).toBe(n);
    }
  });

  it('stores a total for a session with no card, and the card picks it up later', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await totals(app, token, { source: 'claude', sessions: [{ session_id: 'later', tokens: 77 }] }).expect(200);

    const hook = await request(app).post(`/w/${token}/webhook`).send(webhookBody('later')).expect(200);
    expect(hook.body.session.tokens).toBe(77);
  });

  it('broadcasts the cards whose number moved, and only those', async () => {
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
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      await post(`/w/${token}/webhook`, { session_id: 'live', status: 'coding' });

      const res = await fetch(`${base}/w/${token}/events`, {
        signal: ac.signal,
        headers: { accept: 'text/event-stream' },
      });
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
      await readUntil('event: snapshot');

      buf = '';
      await post(`/w/${token}/usage/sessions`, {
        source: 'claude',
        sessions: [{ session_id: 'live', tokens: 4_200 }, { session_id: 'ghost', tokens: 9 }],
      });
      await readUntil('event: session');
      expect(buf).toContain('4200');
      // 'ghost' has no card, so it is stored silently: one frame, not two.
      expect(buf.match(/event: session/g)).toHaveLength(1);

      // A report that repeats itself is news to nobody.
      buf = '';
      await post(`/w/${token}/usage/sessions`, {
        source: 'claude',
        sessions: [{ session_id: 'live', tokens: 4_200 }],
      });
      await post(`/w/${token}/webhook`, { session_id: 'live', status: 'testing' });
      await readUntil('event: session');
      expect(buf.match(/event: session/g)).toHaveLength(1);
      expect(buf).toContain('testing');
    } finally {
      ac.abort();
      await new Promise<void>((resolve) => {
        (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        srv.close(() => resolve());
      });
    }
  });

  it('rejects a malformed report', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const row = { session_id: 's-1', tokens: 1 };

    await totals(app, token, { sessions: [row] }).expect(400); // no source
    await totals(app, token, { source: 'Claude!', sessions: [row] }).expect(400);
    await totals(app, token, { source: 'claude' }).expect(400); // no sessions
    await totals(app, token, { source: 'claude', sessions: [] }).expect(400);
    await totals(app, token, { source: 'claude', sessions: 'nope' }).expect(400);
    await totals(app, token, { source: 'claude', sessions: [null] }).expect(400);
    await totals(app, token, { source: 'claude', sessions: [{ session_id: 's-1' }] }).expect(400);
    await totals(app, token, { source: 'claude', sessions: [{ tokens: 1 }] }).expect(400);
    await totals(app, token, { source: 'claude', sessions: [{ session_id: 'a b', tokens: 1 }] }).expect(400);
    await totals(app, token, {
      source: 'claude',
      sessions: [{ session_id: 'x'.repeat(65), tokens: 1 }], // past the 64-char bound
    }).expect(400);
    await totals(app, token, { source: 'claude', sessions: [{ session_id: 's-1', tokens: NaN }] }).expect(400);
    // 1e300 is the one that mattered: NaN and Infinity both serialise to null
    // and were already refused, but a huge finite double is valid JSON, passed
    // `Number.isFinite`, survived `Math.floor`, and was stored and then served
    // to three clients that format it for a card. Past MAX_SAFE_INTEGER it is
    // not an exact integer at all, so it cannot mean what the wire contract
    // says it means.
    await totals(app, token, { source: 'claude', sessions: [{ session_id: 's-1', tokens: 1e300 }] }).expect(400);
    await totals(app, token, {
      source: 'claude',
      sessions: [{ session_id: 's-1', tokens: Number.MAX_SAFE_INTEGER + 2 }],
    }).expect(400);
    // The boundary itself is still accepted — the bound rejects what cannot be
    // represented, not what is merely large.
    await totals(app, token, {
      source: 'claude',
      sessions: [{ session_id: 's-1', tokens: Number.MAX_SAFE_INTEGER }],
    }).expect(200);
  });

  it('clamps a negative total and lets the last of a duplicated id win', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('dupe')).expect(200);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('neg')).expect(200);

    await totals(app, token, {
      source: 'claude',
      sessions: [
        { session_id: 'dupe', tokens: 1 },
        { session_id: 'neg', tokens: -5 },
        { session_id: 'dupe', tokens: 2 },
      ],
    }).expect(200, { ok: true, sessions: 2 });

    const list = await request(app).get(`/w/${token}/api/sessions`).expect(200);
    const byId = new Map(list.body.map((s: { id: string; tokens?: number }) => [s.id, s.tokens]));
    expect(byId.get('dupe')).toBe(2);
    expect(byId.get('neg')).toBe(0);
  });

  it('caps one report at 100 rows and accepts a full one inside the body limit', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        session_id: `019a7f3c-8b21-7c4e-9d6f-0000000${String(i).padStart(5, '0')}`,
        tokens: 1_234_567_890,
      }));
    await totals(app, token, { source: 'claude', sessions: rows(101) }).expect(400);
    await totals(app, token, { source: 'claude', sessions: rows(100) })
      .expect(200, { ok: true, sessions: 100 });
  });

  it('drops a total the retention window has passed', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('stale')).expect(200);

    // Reported eight days ago: past SESSION_TOTAL_TTL_MS, so the card must not
    // carry it even though nothing has posted since.
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(eightDaysAgo);
    try {
      await totals(app, token, { source: 'claude', sessions: [{ session_id: 'stale', tokens: 10 }] })
        .expect(200);
    } finally {
      clock.mockRestore();
    }

    const list = await request(app).get(`/w/${token}/api/sessions`).expect(200);
    expect(list.body[0]).not.toHaveProperty('tokens');
  });

  it('drops the oldest totals past the per-workspace cap', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('first')).expect(200);
    await totals(app, token, { source: 'claude', sessions: [{ session_id: 'first', tokens: 5 }] })
      .expect(200);

    // 500 newer totals: the cap is 500, so the first one reported falls off.
    for (let chunk = 0; chunk < 5; chunk++) {
      await totals(app, token, {
        source: 'claude',
        sessions: Array.from({ length: 100 }, (_, i) => ({
          session_id: `filler-${chunk}-${i}`,
          tokens: 1,
        })),
      }).expect(200);
    }

    const list = await request(app).get(`/w/${token}/api/sessions`).expect(200);
    expect(list.body[0].id).toBe('first');
    expect(list.body[0]).not.toHaveProperty('tokens');
  });

  it('serves the legacy route behind the webhook secret', async () => {
    const { app } = makeApp({ multiTenant: false, webhookSecret: 's3cret' });
    await request(app).post('/webhook').set('x-webhook-secret', 's3cret').send(webhookBody('s-1')).expect(200);

    const body = { source: 'claude', sessions: [{ session_id: 's-1', tokens: 64 }] };
    await request(app).post('/usage/sessions').send(body).expect(401);
    await request(app)
      .post('/usage/sessions')
      .set('x-webhook-secret', 's3cret')
      .send(body)
      .expect(200, { ok: true, sessions: 1 });

    const list = await request(app).get('/api/sessions').expect(200);
    expect(list.body[0].tokens).toBe(64);
  });

  it('404s for an unknown workspace, and a deleted board keeps nothing', async () => {
    const { app } = makeApp();
    const bogus = 'ags_' + 'a'.repeat(32);
    await request(app)
      .post(`/w/${bogus}/usage/sessions`)
      .send({ source: 'claude', sessions: [{ session_id: 's-1', tokens: 1 }] })
      .expect(404);

    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('s-1')).expect(200);
    await totals(app, token, { source: 'claude', sessions: [{ session_id: 's-1', tokens: 9 }] }).expect(200);
    await request(app).delete(`/w/${token}`).expect(200);
    await request(app).get(`/w/${token}/api/sessions`).expect(404);
  });
});

describe.skipIf(!TEST_PG_URL)('per-session token totals (persistence)', () => {
  it('survives a store restart', async () => {
    const dbUrl = await suiteDatabaseUrl('session_totals');
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app).post(`/w/${token}/webhook`).send(webhookBody('kept')).expect(200);
    await request(first.app)
      .post(`/w/${token}/usage/sessions`)
      .send({ source: 'claude', sessions: [{ session_id: 'kept', tokens: 31_415 }] })
      .expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    const list = await request(second.app).get(`/w/${token}/api/sessions`).expect(200);
    expect(list.body[0].tokens).toBe(31_415);
    second.shutdown();
  });
});

describe.skipIf(!TEST_PG_URL)('plan usage (persistence)', () => {
  it('survives a store restart', async () => {
    const dbUrl = await suiteDatabaseUrl('usage');
    const first = makeApp({ databaseUrl: dbUrl });
    await first.ready;
    const token = await createWorkspace(first.app);
    await request(first.app)
      .post(`/w/${token}/usage`)
      .send({ source: 'claude', windows })
      .expect(200);
    await first.store.flush();
    first.shutdown();

    const second = makeApp({ databaseUrl: dbUrl });
    await second.ready;
    const res = await request(second.app).get(`/w/${token}/api/usage`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].windows).toEqual(windows);
    second.shutdown();
  });
});
