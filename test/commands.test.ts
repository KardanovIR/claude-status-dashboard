import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { makeApp, createWorkspace, webhookBody, sleep } from './helpers';

// Focus commands and listener presence (design: docs/design/focus-protocol.md §3.3).
// SSE tests run the app on a real port and read the streams with native fetch,
// as in sse.test.ts; everything else goes through supertest.

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
/** A machine as its listener knows it: the key it holds, and the id the hook reports (sha256(key)[0..32]). */
const machine = (seed: string) => {
  const key = sha256(seed);
  return { key, id: sha256(key).slice(0, 32) };
};
const MAC = machine('mac');
const OTHER = machine('other');
const MACHINE_ID = MAC.id;
const MACHINE_KEY = MAC.key;
const OTHER_MACHINE = OTHER.id;
const OTHER_KEY = OTHER.key;
const host = (machineId = MACHINE_ID) => ({
  machine: { id: machineId, name: 'Mac' },
  app: { slug: 'agterm', name: 'agterm', kind: 'terminal' },
});
const uuid = (): string => crypto.randomUUID();

function listen(app: Express): Promise<{ srv: Server; base: string }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    srv.close(() => resolve());
  });
}

async function createWorkspaceHttp(base: string): Promise<string> {
  const res = await fetch(`${base}/api/workspaces`, { method: 'POST' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

interface Frame { event: string; data: any }

/** One open SSE connection: a growing buffer plus the frames parsed from it so far. */
class SseStream {
  private buf = '';
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  ended = false;

  constructor(res: Response) {
    if (!res.body) throw new Error('SSE response has no body stream');
    this.reader = res.body.getReader();
  }

  /** Reads until the buffer holds `needle`; returns everything received so far. */
  async waitFor(needle: string, timeoutMs = 4000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.buf.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.ended) {
        throw new Error(`${this.ended ? 'stream ended before' : 'timed out waiting for'} ${JSON.stringify(needle)}; received: ${JSON.stringify(this.buf)}`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.reader.read().catch(() => ({ done: true as const, value: undefined })),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; received: ${JSON.stringify(this.buf)}`)), remaining);
          }),
        ]);
        if (result.done) {
          this.ended = true;
        } else {
          this.buf += this.decoder.decode(result.value, { stream: true });
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return this.buf;
  }

  /** Waits for the n-th frame of `event` (1-based) and returns its parsed data. */
  async waitForEvent(event: string, nth = 1, timeoutMs = 4000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const matches = this.events(event);
      if (matches.length >= nth) return matches[nth - 1];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${event} #${nth}; received: ${JSON.stringify(this.buf)}`);
      await this.waitForMore(remaining);
    }
  }

  private async waitForMore(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.reader.read().catch(() => ({ done: true as const, value: undefined })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out; received: ${JSON.stringify(this.buf)}`)), timeoutMs);
        }),
      ]);
      if (result.done) {
        this.ended = true;
        throw new Error(`stream ended; received: ${JSON.stringify(this.buf)}`);
      }
      this.buf += this.decoder.decode(result.value, { stream: true });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Resolves once the server ends the stream. */
  async waitForEnd(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('stream still open');
      await this.waitForMore(remaining).catch((err: Error) => {
        if (!this.ended) throw err;
      });
    }
  }

  /** Every complete frame received so far, in order (the trailing partial block is ignored). */
  frames(): Frame[] {
    const out: Frame[] = [];
    const blocks = this.buf.split('\n\n');
    blocks.pop();
    for (const block of blocks) {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (data) out.push({ event, data: JSON.parse(data) });
    }
    return out;
  }

  events(name: string): any[] {
    return this.frames().filter((f) => f.event === name).map((f) => f.data);
  }
}

async function connectViewer(base: string, token: string, signal: AbortSignal): Promise<SseStream> {
  const res = await fetch(`${base}/w/${token}/events`, { signal, headers: { accept: 'text/event-stream' } });
  expect(res.status).toBe(200);
  const stream = new SseStream(res);
  await stream.waitFor('event: snapshot');
  return stream;
}

async function connectListener(
  base: string,
  token: string,
  signal: AbortSignal,
  m: { id: string; key: string } = MAC,
  extra = 'name=MacBook',
): Promise<{ res: Response; stream: SseStream }> {
  const res = await fetch(`${base}/w/${token}/events?listener=${m.id}&${extra}`, {
    signal,
    headers: { accept: 'text/event-stream', authorization: `Bearer ${m.key}` },
  });
  // A rejected connection has a JSON body, not a stream; callers check res.status first.
  return { res, stream: res.status === 200 ? new SseStream(res) : (undefined as unknown as SseStream) };
}

/** An app on a real port with one workspace; `session()` adds a hosted session. Tears everything down at the end. */
async function harness(overrides: Parameters<typeof makeApp>[0] = {}) {
  const { app, store } = makeApp(overrides);
  const { srv, base } = await listen(app);
  const token = await createWorkspaceHttp(base);
  const controllers: AbortController[] = [];
  const signal = (): AbortSignal => {
    const ac = new AbortController();
    controllers.push(ac);
    return ac.signal;
  };
  const post = (path: string, body: unknown) => postJson(`${base}/w/${token}${path}`, body);
  const session = async (id: string, machineId = MACHINE_ID) => {
    const r = await post('/webhook', webhookBody(id, { host: host(machineId) }));
    expect(r.status).toBe(200);
  };
  const close = async () => {
    for (const ac of controllers) ac.abort();
    await closeServer(srv);
  };
  return { app, store, srv, base, token, signal, post, session, close };
}

describe('POST /w/:token/commands', () => {
  it('focus: the listener alone receives the command; claim → ack reaches the viewer; GET shows done', async () => {
    const h = await harness();
    try {
      await h.session('s-1');
      const viewer = await connectViewer(h.base, h.token, h.signal());
      const { stream: listener } = await connectListener(h.base, h.token, h.signal());
      await listener.waitFor('event: commands');
      await viewer.waitFor('event: machine');

      const id = uuid();
      const created = await h.post('/commands', { id, type: 'focus', session_id: 's-1' });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ id, delivered: true });
      expect(created.body.expires_in_ms).toBeGreaterThan(100_000);
      expect(created.body.expires_in_ms).toBeLessThanOrEqual(120_000);

      const cmd = await listener.waitForEvent('command');
      expect(cmd).toEqual({ id, type: 'focus', session_id: 's-1', machine_id: MACHINE_ID, expires_in_ms: expect.any(Number) });

      const claim = await h.post(`/commands/${id}/claim`, { machine_key: MACHINE_KEY });
      expect(claim.status).toBe(200);
      expect(claim.body.ok).toBe(true);
      expect(claim.body.expires_in_ms).toBeGreaterThan(0);

      const ack = await h.post(`/commands/${id}/ack`, { machine_key: MACHINE_KEY, result: 'focused', reach: 'tab' });
      expect(ack.status).toBe(200);
      expect(ack.body).toEqual({ ok: true });

      const acked = await viewer.waitForEvent('command_ack');
      expect(acked).toEqual({
        id, session_id: 's-1', machine_id: MACHINE_ID, type: 'focus', result: 'focused', reach: 'tab', reason: null,
      });
      // The listener sees the ack too, but the viewer never saw the command itself.
      expect(await listener.waitForEvent('command_ack')).toMatchObject({ id, result: 'focused' });
      expect(viewer.events('command')).toEqual([]);

      const got = await fetch(`${h.base}/w/${h.token}/commands/${id}`);
      expect(got.status).toBe(200);
      const state = await got.json();
      expect(state).toMatchObject({
        id, type: 'focus', session_id: 's-1', machine_id: MACHINE_ID, state: 'done',
        result: 'focused', reach: 'tab', reason: null,
      });
      expect(state.created_at).toBeTypeOf('number');
      expect(state.expires_at).toBeGreaterThan(state.created_at);
      expect(state.claimed_at).toBeGreaterThanOrEqual(state.created_at);
      expect(state.done_at).toBeGreaterThanOrEqual(state.claimed_at);
    } finally {
      await h.close();
    }
  });

  it('resume is routed and acked the same way', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('s-r', { host: host() })).expect(200);

    const id = uuid().toUpperCase(); // normalized to lowercase
    const created = await request(app).post(`/w/${token}/commands`).send({ id, type: 'resume', session_id: 's-r' }).expect(200);
    expect(created.body).toEqual({ id: id.toLowerCase(), delivered: false, expires_in_ms: expect.any(Number) });

    await request(app).post(`/w/${token}/commands/${id}/claim`).send({ machine_key: MACHINE_KEY }).expect(200);
    await request(app).post(`/w/${token}/commands/${id.toLowerCase()}/ack`).send({ machine_key: MACHINE_KEY, result: 'resumed', reach: 'window' }).expect(200);

    const got = await request(app).get(`/w/${token}/commands/${id}`).expect(200);
    expect(got.body).toMatchObject({ id: id.toLowerCase(), type: 'resume', state: 'done', result: 'resumed', reach: 'window' });
  });

  it('400s: bad id, bad type, bad session_id, ack with a free-text key, failed ack without a reason', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('s-v', { host: host() })).expect(200);
    const post = (body: unknown) => request(app).post(`/w/${token}/commands`).send(body);

    for (const id of [undefined, '', 'not-a-uuid', 42, uuid().slice(1), `${uuid()}x`]) {
      const res = await post({ id, type: 'focus', session_id: 's-v' }).expect(400);
      expect(res.body.error).toMatch(/id/);
    }
    for (const type of [undefined, 'open', 'FOCUS', 1]) {
      const res = await post({ id: uuid(), type, session_id: 's-v' }).expect(400);
      expect(res.body.error).toMatch(/type/);
    }
    for (const sessionId of [undefined, '', 'has space', 'x'.repeat(129), 7]) {
      const res = await post({ id: uuid(), type: 'focus', session_id: sessionId }).expect(400);
      expect(res.body.error).toMatch(/session_id/);
    }

    const id = uuid();
    await post({ id, type: 'focus', session_id: 's-v' }).expect(200);
    await request(app).post(`/w/${token}/commands/${id}/claim`).send({ machine_key: MACHINE_KEY }).expect(200);
    const ack = (body: unknown) => request(app).post(`/w/${token}/commands/${id}/ack`).send(body);

    const free = await ack({ machine_key: MACHINE_KEY, result: 'failed', reason: 'no-record', message: '/Users/me/secret' }).expect(400);
    expect(free.body.error).toMatch(/ack accepts only/);
    await ack({ machine_key: MACHINE_KEY, result: 'focused', detail: 'tty003' }).expect(400);
    const noReason = await ack({ machine_key: MACHINE_KEY, result: 'failed' }).expect(400);
    expect(noReason.body.error).toMatch(/reason/);
    await ack({ machine_key: MACHINE_KEY, result: 'failed', reason: 'the window was gone' }).expect(400);
    await ack({ machine_key: MACHINE_KEY, result: 'exploded' }).expect(400);
    await ack({ machine_key: MACHINE_KEY, result: 'focused', reach: 'universe' }).expect(400);
    const noKey = await ack({ result: 'focused' }).expect(400);
    expect(noKey.body.error).toMatch(/machine_key/);
    // The public machine id is not a credential: it is not even an accepted key.
    await ack({ machine_id: MACHINE_ID, result: 'focused' }).expect(400);
    for (const bad of [{}, { machine_key: MACHINE_ID }, { machine_key: MACHINE_KEY.toUpperCase() }, { machine_key: 42 }]) {
      await request(app).post(`/w/${token}/commands/${id}/claim`).send(bad).expect(400);
    }

    // Still claimed: none of the rejected acks changed it.
    const got = await request(app).get(`/w/${token}/commands/${id}`).expect(200);
    expect(got.body.state).toBe('claimed');
  });

  it('404 unknown_session, 409 no_host, 409 duplicate_id', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('hosted', { host: host() })).expect(200);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('plain')).expect(200);
    const post = (body: unknown) => request(app).post(`/w/${token}/commands`).send(body);

    const unknown = await post({ id: uuid(), type: 'focus', session_id: 'nope' }).expect(404);
    expect(unknown.body).toEqual({ error: 'unknown_session' });

    const noHost = await post({ id: uuid(), type: 'focus', session_id: 'plain' }).expect(409);
    expect(noHost.body).toEqual({ error: 'no_host' });

    const id = uuid();
    await post({ id, type: 'focus', session_id: 'hosted' }).expect(200);
    const dupe = await post({ id: id.toUpperCase(), type: 'resume', session_id: 'hosted' }).expect(409);
    expect(dupe.body).toEqual({ error: 'duplicate_id' });

    // A session in another workspace is unknown here.
    const other = await createWorkspace(app);
    await post({ id: uuid(), type: 'focus', session_id: 'hosted' }).expect(200);
    await request(app).post(`/w/${other}/commands`).send({ id: uuid(), type: 'focus', session_id: 'hosted' }).expect(404);
  });

  it('429 too_many_pending at 10 pending commands per workspace', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    for (let i = 0; i < 6; i++) {
      await request(app).post(`/w/${token}/webhook`).send(webhookBody(`s-${i}`, { host: host() })).expect(200);
    }
    // 10 distinct (session, type) pairs so nothing coalesces.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = uuid();
      ids.push(id);
      await request(app)
        .post(`/w/${token}/commands`)
        .send({ id, type: i % 2 ? 'resume' : 'focus', session_id: `s-${Math.floor(i / 2)}` })
        .expect(200);
    }
    const blocked = await request(app).post(`/w/${token}/commands`).send({ id: uuid(), type: 'focus', session_id: 's-5' }).expect(429);
    expect(blocked.body).toEqual({ error: 'too_many_pending' });

    // A re-tap on a card that is still waiting replaces its own predecessor, so
    // it goes through at the cap; an eleventh card still does not.
    await request(app).post(`/w/${token}/commands`).send({ id: uuid(), type: 'focus', session_id: 's-0' }).expect(200);
    const replaced = await request(app).get(`/w/${token}/commands/${ids[0]}`).expect(200);
    expect(replaced.body).toMatchObject({ state: 'done', result: 'failed', reason: 'superseded' });
    await request(app).post(`/w/${token}/commands`).send({ id: uuid(), type: 'focus', session_id: 's-5' }).expect(429);

    // Only pending ones count: claiming one frees a slot.
    await request(app).post(`/w/${token}/commands/${ids[1]}/claim`).send({ machine_key: MACHINE_KEY }).expect(200);
    await request(app).post(`/w/${token}/commands`).send({ id: uuid(), type: 'focus', session_id: 's-5' }).expect(200);
  });

  it('a re-tap supersedes the older pending command and broadcasts its ack', async () => {
    const h = await harness();
    try {
      await h.session('s-c');
      const viewer = await connectViewer(h.base, h.token, h.signal());

      const first = uuid();
      const second = uuid();
      await h.post('/commands', { id: first, type: 'focus', session_id: 's-c' });
      const res = await h.post('/commands', { id: second, type: 'focus', session_id: 's-c' });
      expect(res.status).toBe(200);

      const ack = await viewer.waitForEvent('command_ack');
      expect(ack).toEqual({
        id: first, session_id: 's-c', machine_id: MACHINE_ID, type: 'focus', result: 'failed', reach: null, reason: 'superseded',
      });
      const oldState = await (await fetch(`${h.base}/w/${h.token}/commands/${first}`)).json();
      expect(oldState).toMatchObject({ state: 'done', result: 'failed', reason: 'superseded' });
      const newState = await (await fetch(`${h.base}/w/${h.token}/commands/${second}`)).json();
      expect(newState.state).toBe('pending');

      // A different type on the same session is not coalesced.
      await h.post('/commands', { id: uuid(), type: 'resume', session_id: 's-c' });
      expect((await (await fetch(`${h.base}/w/${h.token}/commands/${second}`)).json()).state).toBe('pending');
      expect(h.store.countPending(h.store.resolveToken(h.token)!)).toBe(2);
    } finally {
      await h.close();
    }
  });
});

describe('claim and ack state machine', () => {
  async function pendingCommand() {
    const { app } = makeApp();
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('s-m', { host: host() })).expect(200);
    const id = uuid();
    await request(app).post(`/w/${token}/commands`).send({ id, type: 'focus', session_id: 's-m' }).expect(200);
    return {
      app,
      token,
      id,
      claim: (machineKey = MACHINE_KEY, cmdId = id) =>
        request(app).post(`/w/${token}/commands/${cmdId}/claim`).send({ machine_key: machineKey }),
      ack: (body: Record<string, unknown>, cmdId = id) =>
        request(app).post(`/w/${token}/commands/${cmdId}/ack`).send({ machine_key: MACHINE_KEY, result: 'focused', ...body }),
    };
  }

  it('claim: 403 wrong_machine, 409 already_claimed on the second claim, 404 unknown', async () => {
    const c = await pendingCommand();
    // Every viewer knows the machine id from the snapshot; only the key it is derived from claims.
    const wrong = await c.claim(OTHER_KEY).expect(403);
    expect(wrong.body).toEqual({ error: 'wrong_machine' });
    await c.claim(sha256(MACHINE_ID)).expect(403);
    await c.claim().expect(200);
    const again = await c.claim().expect(409);
    expect(again.body).toEqual({ error: 'already_claimed' });
    const missing = await c.claim(MACHINE_KEY, uuid()).expect(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });

  it('ack: 409 not_claimed before a claim, 403 wrong machine, 409 already_done on a second ack', async () => {
    const c = await pendingCommand();
    const early = await c.ack({}).expect(409);
    expect(early.body).toEqual({ error: 'not_claimed' });
    await c.claim().expect(200);
    const wrong = await c.ack({ machine_key: OTHER_KEY }).expect(403);
    expect(wrong.body).toEqual({ error: 'wrong_machine' });
    await c.ack({ machine_key: sha256(MACHINE_ID) }).expect(403);
    await c.ack({ result: 'failed', reason: 'not-running' }).expect(200);
    const twice = await c.ack({}).expect(409);
    expect(twice.body).toEqual({ error: 'already_done' });
    await c.ack({}, uuid()).expect(404);
    // A done command cannot be claimed again either.
    await c.claim().expect(409);

    const got = await request(c.app).get(`/w/${c.token}/commands/${c.id}`).expect(200);
    expect(got.body).toMatchObject({ state: 'done', result: 'failed', reason: 'not-running', reach: null });
  });

  it('GET: 404 for an unknown id and for another workspace\'s command', async () => {
    const c = await pendingCommand();
    await request(c.app).get(`/w/${c.token}/commands/${uuid()}`).expect(404);
    const other = await createWorkspace(c.app);
    await request(c.app).get(`/w/${other}/commands/${c.id}`).expect(404);
    await request(c.app).post(`/w/${other}/commands/${c.id}/claim`).send({ machine_key: MACHINE_KEY }).expect(404);
  });
});

describe('expiry', () => {
  it('a pending command expires: ack broadcast, claim 410, GET expired, swept after the grace period', async () => {
    const h = await harness({ commandTtlMs: 300 });
    try {
      await h.session('s-e');
      const viewer = await connectViewer(h.base, h.token, h.signal());

      const id = uuid();
      const created = await h.post('/commands', { id, type: 'focus', session_id: 's-e' });
      expect(created.status).toBe(200);
      expect(created.body.expires_in_ms).toBeLessThanOrEqual(300);

      const ack = await viewer.waitForEvent('command_ack');
      expect(ack).toEqual({
        id, session_id: 's-e', machine_id: MACHINE_ID, type: 'focus', result: 'failed', reach: null, reason: 'expired',
      });
      expect(viewer.events('command_ack')).toHaveLength(1);

      const claim = await h.post(`/commands/${id}/claim`, { machine_key: MACHINE_KEY });
      expect(claim.status).toBe(410);
      expect(claim.body).toEqual({ error: 'expired' });
      const late = await h.post(`/commands/${id}/ack`, { machine_key: MACHINE_KEY, result: 'focused' });
      expect(late.status).toBe(410);

      const got = await (await fetch(`${h.base}/w/${h.token}/commands/${id}`)).json();
      expect(got).toMatchObject({ state: 'expired', result: 'failed', reason: 'expired' });
      expect(got.done_at).toBeGreaterThanOrEqual(got.expires_at);

      // Kept for the grace period, then forgotten; the sweep announces nothing new.
      expect(h.store.sweepCommands(Date.now() + 9 * 60_000)).toEqual([]);
      expect((await fetch(`${h.base}/w/${h.token}/commands/${id}`)).status).toBe(200);
      expect(h.store.sweepCommands(Date.now() + 11 * 60_000)).toEqual([]);
      expect((await fetch(`${h.base}/w/${h.token}/commands/${id}`)).status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('a claimed command that is never acked expires too, and is announced once', async () => {
    const h = await harness({ commandTtlMs: 300 });
    try {
      await h.session('s-e2');
      const viewer = await connectViewer(h.base, h.token, h.signal());
      const id = uuid();
      await h.post('/commands', { id, type: 'resume', session_id: 's-e2' });
      expect((await h.post(`/commands/${id}/claim`, { machine_key: MACHINE_KEY })).status).toBe(200);

      const ack = await viewer.waitForEvent('command_ack');
      expect(ack).toMatchObject({ id, type: 'resume', result: 'failed', reason: 'expired' });
      await sleep(1100); // another sweep (the interval floors at 1 s)
      expect(viewer.events('command_ack')).toHaveLength(1);
      expect((await h.post(`/commands/${id}/ack`, { machine_key: MACHINE_KEY, result: 'resumed' })).status).toBe(410);
    } finally {
      await h.close();
    }
  });
});

describe('a removed session', () => {
  it('dismissing a card fails its pending command as superseded; clearing does so for every card', async () => {
    const h = await harness();
    try {
      await h.session('s-d1');
      await h.session('s-d2');
      const viewer = await connectViewer(h.base, h.token, h.signal());
      const gone = uuid();
      const kept = uuid();
      await h.post('/commands', { id: gone, type: 'focus', session_id: 's-d1' });
      await h.post('/commands', { id: kept, type: 'focus', session_id: 's-d2' });

      const del = await fetch(`${h.base}/w/${h.token}/sessions/s-d1`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      await del.text();
      expect(await viewer.waitForEvent('remove')).toEqual({ id: 's-d1' });
      const ack = await viewer.waitForEvent('command_ack');
      expect(ack).toMatchObject({ id: gone, session_id: 's-d1', result: 'failed', reason: 'superseded' });
      expect((await (await fetch(`${h.base}/w/${h.token}/commands/${gone}`)).json()).state).toBe('done');
      expect((await (await fetch(`${h.base}/w/${h.token}/commands/${kept}`)).json()).state).toBe('pending');
      // A listener connecting now is not told about it.
      const { stream: listener } = await connectListener(h.base, h.token, h.signal());
      await listener.waitFor('event: commands');
      expect(listener.events('commands')[0].map((c: { id: string }) => c.id)).toEqual([kept]);

      const clear = await fetch(`${h.base}/w/${h.token}/sessions/clear`, { method: 'POST' });
      expect(clear.status).toBe(200);
      await clear.text();
      expect(await viewer.waitForEvent('command_ack', 2)).toMatchObject({ id: kept, result: 'failed', reason: 'superseded' });
      expect(h.store.countPending(h.store.resolveToken(h.token)!)).toBe(0);
    } finally {
      await h.close();
    }
  });
});

describe('listener presence (GET /w/:token/events?listener=)', () => {
  it('connect: viewers get machine online; the listener gets snapshot then its pending commands', async () => {
    const h = await harness();
    try {
      await h.session('s-p');
      const viewer = await connectViewer(h.base, h.token, h.signal());
      expect(viewer.events('machines')).toEqual([[]]);

      // Two commands queued before the listener is up, one for another machine.
      const waiting = uuid();
      await h.post('/commands', { id: waiting, type: 'focus', session_id: 's-p' });
      await h.session('s-other', OTHER_MACHINE);
      await h.post('/commands', { id: uuid(), type: 'focus', session_id: 's-other' });

      const { res, stream: listener } = await connectListener(h.base, h.token, h.signal());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
      await listener.waitFor('event: commands');
      const frames = listener.frames();
      expect(frames[0].event).toBe('snapshot');
      expect(frames[0].data.map((s: { id: string }) => s.id).sort()).toEqual(['s-other', 's-p']);
      expect(frames[1].event).toBe('commands');
      expect(frames[1].data).toEqual([
        { id: waiting, type: 'focus', session_id: 's-p', machine_id: MACHINE_ID, expires_in_ms: expect.any(Number) },
      ]);

      const online = await viewer.waitForEvent('machine');
      expect(online).toEqual({ id: MACHINE_ID, name: 'MacBook', online: true, since: expect.any(Number) });
      // The listener hears the presence event too (it is a client like any other).
      expect(await listener.waitForEvent('machine')).toMatchObject({ id: MACHINE_ID, online: true });

      const machines = await (await fetch(`${h.base}/w/${h.token}/api/machines`)).json();
      expect(machines).toEqual([online]);

      // A later viewer gets the machine in its `machines` frame.
      const viewer2 = await connectViewer(h.base, h.token, h.signal());
      await viewer2.waitFor('event: machines');
      expect(viewer2.events('machines')).toEqual([[online]]);
    } finally {
      await h.close();
    }
  });

  it('validates the request: bad id or key 400, a key for another machine 403 (the real stream stays), name falls back', async () => {
    const h = await harness();
    try {
      for (const bad of ['', 'abc', MACHINE_ID.toUpperCase(), MACHINE_ID + '0']) {
        const res = await fetch(`${h.base}/w/${h.token}/events?listener=${bad}`, {
          headers: { authorization: `Bearer ${MACHINE_KEY}` },
        });
        expect(res.status, `listener=${bad}`).toBe(400);
        await res.text();
      }
      // A missing header is as bad as a malformed one: no key, no stream.
      for (const bad of ['', 'abc', MACHINE_KEY.toUpperCase(), MACHINE_KEY.slice(1), MACHINE_ID]) {
        const res = await fetch(`${h.base}/w/${h.token}/events?listener=${MACHINE_ID}`, {
          headers: { authorization: `Bearer ${bad}` },
        });
        expect(res.status, `Authorization: Bearer ${bad}`).toBe(400);
        await res.text();
      }
      const noHeader = await fetch(`${h.base}/w/${h.token}/events?listener=${MACHINE_ID}`);
      expect(noHeader.status).toBe(400);
      expect((await noHeader.json()).error).toMatch(/Authorization: Bearer/);

      const viewer = await connectViewer(h.base, h.token, h.signal());
      const real = await connectListener(h.base, h.token, h.signal(), MAC, 'name=&platform=darwin&v=1.4.0');
      expect(real.res.status).toBe(200);
      await real.stream.waitFor('event: commands');
      const online = await viewer.waitForEvent('machine');
      // Presence is id, name, online, since — whatever else the query carried stays off the wire.
      expect(online).toEqual({ id: MACHINE_ID, name: 'Machine', online: true, since: expect.any(Number) });

      // A viewer knows every machine id from the snapshot but not the key it
      // derives from, so it can neither take the slot nor end the real stream.
      const forged = await connectListener(h.base, h.token, h.signal(), { id: MACHINE_ID, key: OTHER_KEY });
      expect(forged.res.status).toBe(403);
      expect(await forged.res.json()).toEqual({ error: 'wrong_key' });
      await h.session('s-real');
      const id = uuid();
      expect((await h.post('/commands', { id, type: 'focus', session_id: 's-real' })).body.delivered).toBe(true);
      expect(await real.stream.waitForEvent('command')).toMatchObject({ id });
      expect(viewer.events('machine')).toHaveLength(1);

      const withCtl = await connectListener(h.base, h.token, h.signal(), OTHER, 'name=Big%09Box%20' + 'x'.repeat(40));
      expect(withCtl.res.status).toBe(200);
      const second = await viewer.waitForEvent('machine', 2);
      expect(second.id).toBe(OTHER_MACHINE);
      expect(second.name).toBe(('BigBox ' + 'x'.repeat(40)).slice(0, 32).trim());
    } finally {
      await h.close();
    }
  });

  it('refuses the pre-release ?key= shape without echoing it, and accepts the header instead', async () => {
    const h = await harness();
    try {
      const viewer = await connectViewer(h.base, h.token, h.signal());

      // The shape the listener spoke before the key moved into a header. It
      // must fail, not fall through to a plain viewer stream: a stale client
      // that looked connected would be unauthenticated, in a machine's slot
      // it never proved it owns.
      const stale = await fetch(
        `${h.base}/w/${h.token}/events?listener=${MACHINE_ID}&key=${MACHINE_KEY}&name=MacBook`,
        { headers: { accept: 'text/event-stream' } },
      );
      expect(stale.status).toBe(400);
      expect(stale.headers.get('content-type') ?? '').toContain('application/json');
      const body = await stale.text();
      // The refusal is the one place the key is in hand: it never comes back
      // out, in the error or anywhere else, and it names the header to use.
      expect(body).not.toContain(MACHINE_KEY);
      expect(JSON.parse(body).error).toMatch(/Authorization: Bearer/);

      // Belt and braces: the right header does not rescue a request that also
      // carries the key in its query — the URL is already in an access log.
      const both = await fetch(`${h.base}/w/${h.token}/events?listener=${MACHINE_ID}&key=${MACHINE_KEY}`, {
        headers: { authorization: `Bearer ${MACHINE_KEY}` },
      });
      expect(both.status).toBe(400);
      expect(await both.text()).not.toContain(MACHINE_KEY);

      // A plain viewer connect carrying a stray ?key= is refused too, so the
      // credential can never quietly ride a URL that does open a stream.
      const strayViewer = await fetch(`${h.base}/w/${h.token}/events?key=${MACHINE_KEY}`);
      expect(strayViewer.status).toBe(400);
      await strayViewer.text();

      // Nothing above took the machine's slot or reached the board.
      await sleep(100);
      expect(viewer.events('machine')).toEqual([]);
      expect(await (await fetch(`${h.base}/w/${h.token}/api/machines`)).json()).toEqual([]);

      // The same connect with the key in the header is the supported shape.
      const ok = await fetch(`${h.base}/w/${h.token}/events?listener=${MACHINE_ID}&name=MacBook`, {
        signal: h.signal(),
        headers: { accept: 'text/event-stream', authorization: `Bearer ${MACHINE_KEY}` },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type') ?? '').toContain('text/event-stream');
      await new SseStream(ok).waitFor('event: commands');
      expect(await viewer.waitForEvent('machine')).toMatchObject({ id: MACHINE_ID, name: 'MacBook', online: true });
    } finally {
      await h.close();
    }
  });

  it('a second connection for the same machine replaces the first, which is ended', async () => {
    const h = await harness();
    try {
      const viewer = await connectViewer(h.base, h.token, h.signal());
      const first = await connectListener(h.base, h.token, h.signal());
      await first.stream.waitFor('event: commands');
      await viewer.waitForEvent('machine');

      const second = await connectListener(h.base, h.token, h.signal(), MAC, 'name=MacBook2');
      expect(second.res.status).toBe(200);
      await first.stream.waitForEnd();

      const again = await viewer.waitForEvent('machine', 2);
      expect(again).toMatchObject({ id: MACHINE_ID, name: 'MacBook2', online: true });
      await sleep(100);
      // No offline was announced for the replaced stream.
      expect(viewer.events('machine').filter((m) => m.online === false)).toEqual([]);
      const machines = await (await fetch(`${h.base}/w/${h.token}/api/machines`)).json();
      expect(machines).toHaveLength(1);
      expect(machines[0].name).toBe('MacBook2');

      // Commands reach the replacement.
      await h.session('s-rep');
      const id = uuid();
      const created = await h.post('/commands', { id, type: 'focus', session_id: 's-rep' });
      expect(created.body.delivered).toBe(true);
      expect(await second.stream.waitForEvent('command')).toMatchObject({ id });
    } finally {
      await h.close();
    }
  });

  it('disconnect: viewers get machine offline with lastSeen; /api/machines empties', async () => {
    const h = await harness();
    try {
      const viewer = await connectViewer(h.base, h.token, h.signal());
      const ac = new AbortController();
      const { stream: listener } = await connectListener(h.base, h.token, ac.signal);
      await listener.waitFor('event: commands');
      await viewer.waitForEvent('machine');

      ac.abort();
      const offline = await viewer.waitForEvent('machine', 2);
      expect(offline).toEqual({ id: MACHINE_ID, online: false, lastSeen: expect.any(Number) });
      expect(await (await fetch(`${h.base}/w/${h.token}/api/machines`)).json()).toEqual([]);

      await h.session('s-off');
      const created = await h.post('/commands', { id: uuid(), type: 'focus', session_id: 's-off' });
      expect(created.body.delivered).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('caps listeners at 5 per workspace (429 for a 6th machine) without consuming viewer slots', async () => {
    const h = await harness({ rateLimit: true });
    try {
      // Fill every viewer slot first. The responses stay referenced for the
      // whole test: undici cancels an unread body once its Response is
      // collected, which would close the socket and free the slot.
      const viewers: Response[] = [];
      for (let i = 1; i <= 10; i++) {
        const res = await fetch(`${h.base}/w/${h.token}/events`, { signal: h.signal() });
        expect(res.status, `viewer #${i}`).toBe(200);
        viewers.push(res);
      }
      const eleventh = await fetch(`${h.base}/w/${h.token}/events`, { signal: h.signal() });
      expect(eleventh.status).toBe(429);
      await eleventh.text();

      for (let i = 1; i <= 5; i++) {
        const { res } = await connectListener(h.base, h.token, h.signal(), machine(`m${i}`));
        expect(res.status, `listener #${i}`).toBe(200);
      }
      const sixth = await connectListener(h.base, h.token, h.signal(), machine('sixth'));
      expect(sixth.res.status).toBe(429);
      expect(await sixth.res.json()).toEqual({ error: 'too many listeners' });
      // A reconnect of a known machine is not a new slot.
      const reconnect = await connectListener(h.base, h.token, h.signal(), machine('m3'));
      expect(reconnect.res.status).toBe(200);

      const machines = await (await fetch(`${h.base}/w/${h.token}/api/machines`)).json();
      expect(machines).toHaveLength(5);
      expect(viewers).toHaveLength(10);
    } finally {
      await h.close();
    }
  });

  it('throttles listener connects at 30/min per workspace (rateLimit: true)', async () => {
    const h = await harness({ rateLimit: true });
    try {
      for (let i = 1; i <= 30; i++) {
        const { res } = await connectListener(h.base, h.token, h.signal());
        expect(res.status, `connect #${i}`).toBe(200);
      }
      const throttled = await connectListener(h.base, h.token, h.signal());
      expect(throttled.res.status).toBe(429);
      expect(await throttled.res.json()).toEqual({ error: 'rate limit exceeded' });
      // The last accepted stream is still the machine's.
      expect(await (await fetch(`${h.base}/w/${h.token}/api/machines`)).json()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('DELETE /w/:token ends listener streams as well', async () => {
    const h = await harness();
    try {
      const { stream: listener } = await connectListener(h.base, h.token, h.signal());
      await listener.waitFor('event: commands');
      const del = await fetch(`${h.base}/w/${h.token}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      await del.text();
      await listener.waitForEnd();
    } finally {
      await h.close();
    }
  });
});

describe('legacy mode (multiTenant: false)', () => {
  it('mounts the command routes and presence at the root', async () => {
    const { app } = makeApp({ multiTenant: false });
    await request(app).post('/webhook').send(webhookBody('l-1', { host: host() })).expect(200);
    const id = uuid();
    const created = await request(app).post('/commands').send({ id, type: 'focus', session_id: 'l-1' }).expect(200);
    expect(created.body).toEqual({ id, delivered: false, expires_in_ms: expect.any(Number) });
    await request(app).post(`/commands/${id}/claim`).send({ machine_key: MACHINE_KEY }).expect(200);
    await request(app).post(`/commands/${id}/ack`).send({ machine_key: MACHINE_KEY, result: 'activated', reach: 'app' }).expect(200);
    const got = await request(app).get(`/commands/${id}`).expect(200);
    expect(got.body).toMatchObject({ state: 'done', result: 'activated', reach: 'app' });
    const machines = await request(app).get('/api/machines').expect(200);
    expect(machines.body).toEqual([]);
    // The workspace-scoped paths do not exist here.
    await request(app).post('/w/ags_x/commands').send({ id: uuid(), type: 'focus', session_id: 'l-1' }).expect(404);
  });

  it('requires X-Webhook-Secret on the POSTs when WEBHOOK_SECRET is set; GET stays open', async () => {
    const { app } = makeApp({ multiTenant: false, webhookSecret: 's3cret' });
    const auth = { 'X-Webhook-Secret': 's3cret' };
    await request(app).post('/webhook').set(auth).send(webhookBody('l-2', { host: host() })).expect(200);
    const id = uuid();
    const body = { id, type: 'focus', session_id: 'l-2' };

    await request(app).post('/commands').send(body).expect(401);
    await request(app).post('/commands').set('X-Webhook-Secret', 'wrong').send(body).expect(401);
    await request(app).post('/commands').set(auth).send(body).expect(200);
    await request(app).post(`/commands/${id}/claim`).send({ machine_key: MACHINE_KEY }).expect(401);
    await request(app).post(`/commands/${id}/claim`).set(auth).send({ machine_key: MACHINE_KEY }).expect(200);
    await request(app).post(`/commands/${id}/ack`).send({ machine_key: MACHINE_KEY, result: 'focused' }).expect(401);
    await request(app).post(`/commands/${id}/ack`).set(auth).send({ machine_key: MACHINE_KEY, result: 'focused' }).expect(200);
    const got = await request(app).get(`/commands/${id}`).expect(200);
    expect(got.body.state).toBe('done');
  });

  it('gates ?listener= behind the secret; a plain viewer connect stays open', async () => {
    const { app } = makeApp({ multiTenant: false, webhookSecret: 's3cret' });
    const { srv, base } = await listen(app);
    const ac = new AbortController();
    try {
      const denied = await fetch(`${base}/events?listener=${MACHINE_ID}`, {
        headers: { authorization: `Bearer ${MACHINE_KEY}` },
      });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: 'unauthorized' });

      // Legacy mode refuses the old query shape too — behind the secret, so a
      // stale client without it is turned away before the key is even read.
      const stale = await fetch(`${base}/events?listener=${MACHINE_ID}&key=${MACHINE_KEY}`, {
        headers: { 'x-webhook-secret': 's3cret' },
      });
      expect(stale.status).toBe(400);
      expect(await stale.text()).not.toContain(MACHINE_KEY);

      const viewerRes = await fetch(`${base}/events`, { signal: ac.signal });
      expect(viewerRes.status).toBe(200);
      const viewer = new SseStream(viewerRes);
      await viewer.waitFor('event: snapshot');
      expect(viewer.events('machines')).toEqual([[]]);

      const listenerRes = await fetch(`${base}/events?listener=${MACHINE_ID}&name=Mac`, {
        signal: ac.signal,
        headers: { 'x-webhook-secret': 's3cret', authorization: `Bearer ${MACHINE_KEY}` },
      });
      expect(listenerRes.status).toBe(200);
      await new SseStream(listenerRes).waitFor('event: commands');
      expect(await viewer.waitForEvent('machine')).toEqual({ id: MACHINE_ID, name: 'Mac', online: true, since: expect.any(Number) });
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });
});
