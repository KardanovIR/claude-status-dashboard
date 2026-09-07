import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, createWorkspace } from './helpers';

const w = (id: string, usedPct: number) => ({ id, label: id, usedPct });

/** Both series behind the usage detail screen. */
describe('usage history', () => {
  it('records a point per window only when the value moves', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);

    // Three reports, but the middle one repeats: a plan limit is a step
    // function and reports arrive far more often than it changes.
    for (const pct of [10, 10, 25]) {
      await request(app)
        .post(`/w/${token}/usage`)
        .send({ source: 'claude', windows: [w('week', pct)] })
        .expect(200);
    }

    const res = await request(app).get(`/w/${token}/api/usage/history`).expect(200);
    const series = res.body.history.find((h: { windowId: string }) => h.windowId === 'week');
    expect(series.source).toBe('claude');
    expect(series.points.map((p: { usedPct: number }) => p.usedPct)).toEqual([10, 25]);
    expect(series.points[0].at).toBeTypeOf('number');
  });

  it('keeps each source and window in its own series', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app)
      .post(`/w/${token}/usage`)
      .send({ source: 'claude', windows: [w('session', 5), w('week', 50)] })
      .expect(200);
    await request(app)
      .post(`/w/${token}/usage`)
      .send({ source: 'codex', windows: [w('week', 80)] })
      .expect(200);

    const res = await request(app).get(`/w/${token}/api/usage/history`).expect(200);
    expect(res.body.history.map((h: { source: string; windowId: string }) => `${h.source}/${h.windowId}`))
      .toEqual(['claude/session', 'claude/week', 'codex/week']);
  });

  it('clamps the requested range and defaults to 30 days', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    expect((await request(app).get(`/w/${token}/api/usage/history`)).body.days).toBe(30);
    expect((await request(app).get(`/w/${token}/api/usage/history?days=7`)).body.days).toBe(7);
    expect((await request(app).get(`/w/${token}/api/usage/history?days=9999`)).body.days).toBe(90);
    expect((await request(app).get(`/w/${token}/api/usage/history?days=0`)).body.days).toBe(30);
    expect((await request(app).get(`/w/${token}/api/usage/history?days=junk`)).body.days).toBe(30);
  });

  it('is empty for a board that has never reported', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const res = await request(app).get(`/w/${token}/api/usage/history`).expect(200);
    expect(res.body).toEqual({ days: 30, history: [], projects: [] });
  });
});

describe('per-project token spend', () => {
  const days = [
    { project: 'jobsearch', day: '2026-09-06', tokens: 2_000_000 },
    { project: 'claude-status', day: '2026-09-06', tokens: 500_000 },
    { project: 'jobsearch', day: '2026-09-07', tokens: 1_000_000 },
  ];

  it('stores days and returns them with the history', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app)
      .post(`/w/${token}/usage/projects`)
      .send({ source: 'claude', days })
      .expect(200, { ok: true, days: 3 });

    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects).toHaveLength(3);
    expect(res.body.projects[0]).toEqual({
      source: 'claude', project: 'claude-status', day: '2026-09-06', tokens: 500_000,
    });
  });

  it('replaces a day rather than accumulating, so a re-run converges', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const one = [{ project: 'p', day: '2026-09-07', tokens: 100 }];
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'claude', days: one }).expect(200);
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'claude', days: one }).expect(200);
    await request(app)
      .post(`/w/${token}/usage/projects`)
      .send({ source: 'claude', days: [{ project: 'p', day: '2026-09-07', tokens: 250 }] })
      .expect(200);

    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects).toEqual([
      { source: 'claude', project: 'p', day: '2026-09-07', tokens: 250 },
    ]);
  });

  it('keeps the same project separate per source', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const d = [{ project: 'shared', day: '2026-09-07', tokens: 10 }];
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'claude', days: d }).expect(200);
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'codex', days: d }).expect(200);
    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects.map((p: { source: string }) => p.source)).toEqual(['claude', 'codex']);
  });

  it('rejects a malformed report', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const post = (body: unknown) => request(app).post(`/w/${token}/usage/projects`).send(body as object);

    await post({ source: 'Claude!', days: [{ project: 'p', day: '2026-09-07', tokens: 1 }] }).expect(400);
    await post({ source: 'claude', days: [] }).expect(400);
    await post({ source: 'claude', days: 'nope' }).expect(400);
    await post({ source: 'claude', days: [{ project: 'p', day: '07-09-2026', tokens: 1 }] }).expect(400);
    await post({ source: 'claude', days: [{ project: '', day: '2026-09-07', tokens: 1 }] }).expect(400);
    await post({ source: 'claude', days: [{ project: 'p', day: '2026-09-07' }] }).expect(400);
    await post({ source: 'claude', days: [null] }).expect(400);
  });

  it('clamps a negative token count rather than rejecting the whole report', async () => {
    // Matches how usedPct is handled: one bad number must not lose the batch.
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app)
      .post(`/w/${token}/usage/projects`)
      .send({ source: 'claude', days: [{ project: 'p', day: '2026-09-07', tokens: -5 }] })
      .expect(200);
    const res = await request(app).get(`/w/${token}/api/usage/history?days=90`).expect(200);
    expect(res.body.projects[0].tokens).toBe(0);
  });

  it('caps how much one report may carry', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const many = Array.from({ length: 201 }, (_, i) => ({
      project: `p${i}`, day: '2026-09-07', tokens: 1,
    }));
    await request(app).post(`/w/${token}/usage/projects`).send({ source: 'claude', days: many }).expect(400);
  });

  it('accepts a report right at the cap, inside the JSON body limit', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    const many = Array.from({ length: 200 }, (_, i) => ({
      project: `project-name-${i}`, day: '2026-09-07', tokens: 123_456_789,
    }));
    await request(app)
      .post(`/w/${token}/usage/projects`)
      .send({ source: 'claude', days: many })
      .expect(200, { ok: true, days: 200 });
  });
});
