import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import http2 from 'http2';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { makeApp, createWorkspace, webhookBody, sleep } from './helpers';
import { Pusher } from '../src/push';
import { configFromEnv } from '../src/config';
import type { AppConfig, Session } from '../src/app';

// ---- test APNs credentials --------------------------------------------------

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY_ID = 'TESTKEY9AB';
const TEAM_ID = 'TESTTEAM12';
const TOPIC = 'com.kardanov.agstatus';

function apnsCfg(server: string): NonNullable<AppConfig['apns']> {
  return { keyPem: KEY_PEM, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC, server };
}

// ---- mock APNs server (plain-http http2; the Pusher allows http:// for tests)

interface RecordedRequest {
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: unknown;
}

interface MockApns {
  url: string;
  requests: RecordedRequest[];
  /** Next responses, consumed in order; empty queue → 200 {}. */
  respondWith(status: number, body?: unknown): void;
  /** When on, requests are recorded but never answered (half-open connection). */
  stall(on: boolean): void;
  close(): Promise<void>;
}

async function startMockApns(): Promise<MockApns> {
  const requests: RecordedRequest[] = [];
  const scripted: Array<{ status: number; body: unknown }> = [];
  const sessions = new Set<http2.ServerHttp2Session>();
  let stalled = false;

  const server = http2.createServer();
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (c: string) => (body += c));
    stream.on('error', () => {
      /* client-cancelled (e.g. timed-out) streams are expected */
    });
    stream.on('end', () => {
      let parsed: unknown = body;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep raw */
      }
      requests.push({ path: String(headers[':path'] ?? ''), headers, body: parsed });
      if (stalled) return; // accept the stream, never respond
      const next = scripted.shift() ?? { status: 200, body: {} };
      stream.respond({ ':status': next.status, 'content-type': 'application/json' });
      stream.end(JSON.stringify(next.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respondWith: (status, body = {}) => scripted.push({ status, body }),
    stall: (on) => (stalled = on),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Polls until fn() is truthy (2s cap) — pushes are dispatched async after the webhook returns. */
async function waitFor(fn: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const DEVICE_A = 'a'.repeat(64);
const DEVICE_B = 'b'.repeat(64);

function registerBody(deviceToken: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { device_token: deviceToken, platform: 'ios', ...extra };
}

function mkSession(id: string): Session {
  return {
    id, name: 'Agent', status: 'blocked', message: 'stuck',
    project: '', createdAt: Date.now(), updatedAt: Date.now(),
  };
}

const mocks: MockApns[] = [];
async function mockApns(): Promise<MockApns> {
  const mock = await startMockApns();
  mocks.push(mock);
  return mock;
}

afterEach(async () => {
  while (mocks.length > 0) await mocks.pop()!.close();
});

// ---- device registration ----------------------------------------------------

describe('device registration (multi mode)', () => {
  it('POST /w/:token/devices registers a device and returns {ok:true}', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);

    const res = await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);
    expect(res.body).toEqual({ ok: true });

    const wsId = store.resolveToken(token)!;
    expect(store.devices(wsId)).toEqual([{ deviceToken: DEVICE_A, notifyDone: false }]);
  });

  it('rejects malformed device tokens and non-ios platforms with 400', async () => {
    const { app } = makeApp();
    const token = await createWorkspace(app);

    for (const bad of ['', 'g'.repeat(64), 'a'.repeat(15), 'a'.repeat(201), 'not hex!']) {
      const res = await request(app).post(`/w/${token}/devices`).send(registerBody(bad)).expect(400);
      expect(res.body.error).toMatch(/device_token/);
    }
    for (const body of [{ device_token: DEVICE_A }, registerBody(DEVICE_A, { platform: 'android' })]) {
      const res = await request(app).post(`/w/${token}/devices`).send(body).expect(400);
      expect(res.body.error).toMatch(/platform/);
    }
  });

  it('dedupes by lowercased token and re-POST updates notify_done', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;

    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A.toUpperCase())).expect(200);
    await request(app)
      .post(`/w/${token}/devices`)
      .send(registerBody(DEVICE_A, { notify_done: true }))
      .expect(200);

    expect(store.devices(wsId)).toEqual([{ deviceToken: DEVICE_A, notifyDone: true }]);
  });

  it('caps at 10 devices per workspace: 429 for a new device, updates still OK', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;

    for (let i = 0; i < 10; i++) {
      await request(app)
        .post(`/w/${token}/devices`)
        .send(registerBody(i.toString(16).repeat(64).slice(0, 64)))
        .expect(200);
    }
    expect(store.deviceCount(wsId)).toBe(10);

    const blocked = await request(app).post(`/w/${token}/devices`).send(registerBody('f0'.repeat(32))).expect(429);
    expect(blocked.body.error).toMatch(/too many devices/);

    // Updating an existing device at the cap succeeds.
    await request(app)
      .post(`/w/${token}/devices`)
      .send(registerBody('0'.repeat(64), { notify_done: true }))
      .expect(200);
    expect(store.deviceCount(wsId)).toBe(10);
  });

  it('DELETE /w/:token/devices/:deviceToken unregisters (case-insensitive) and reports ok:false when absent', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;

    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);
    const del = await request(app).delete(`/w/${token}/devices/${DEVICE_A.toUpperCase()}`).expect(200);
    expect(del.body).toEqual({ ok: true });
    expect(store.devices(wsId)).toEqual([]);

    const again = await request(app).delete(`/w/${token}/devices/${DEVICE_A}`).expect(200);
    expect(again.body).toEqual({ ok: false });
  });

  it('unknown workspace tokens get 404; legacy mode has no device endpoints', async () => {
    const { app } = makeApp();
    await request(app).post(`/w/ags_${'A'.repeat(32)}/devices`).send(registerBody(DEVICE_A)).expect(404);

    const legacy = makeApp({ multiTenant: false });
    await request(legacy.app).post(`/w/ags_${'A'.repeat(32)}/devices`).send(registerBody(DEVICE_A)).expect(404);
    await request(legacy.app).delete(`/w/ags_${'A'.repeat(32)}/devices/${DEVICE_A}`).expect(404);
  });

  it('DELETE /w/:token purges the workspace devices', async () => {
    const { app, store } = makeApp();
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);

    await request(app).delete(`/w/${token}`).expect(200);
    expect(store.devices(wsId)).toEqual([]);
    expect(store.deviceCount(wsId)).toBe(0);
  });

  it('devices persist across a restart with the same dbPath', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-push-'));
    const dbPath = path.join(tmpDir, 'agstatus.db');
    try {
      const first = makeApp({ dbPath });
      const token = await createWorkspace(first.app);
      await request(first.app)
        .post(`/w/${token}/devices`)
        .send(registerBody(DEVICE_A, { notify_done: true }))
        .expect(200);
      first.shutdown();

      const second = makeApp({ dbPath });
      const wsId = second.store.resolveToken(token)!;
      expect(second.store.devices(wsId)).toEqual([{ deviceToken: DEVICE_A, notifyDone: true }]);
      second.shutdown();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---- config flag --------------------------------------------------------------

describe('GET /api/config push flag', () => {
  it('reports push:false when APNs is not configured (both modes)', async () => {
    for (const multiTenant of [true, false]) {
      const { app } = makeApp({ multiTenant });
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.push).toBe(false);
    }
  });

  it('reports push:true when APNs is configured (both modes)', async () => {
    for (const multiTenant of [true, false]) {
      const { app } = makeApp({ multiTenant, apns: apnsCfg('http://127.0.0.1:1') });
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.push).toBe(true);
    }
  });

  it('configFromEnv: partial APNs env warns and disables push; full env enables it', () => {
    const base = { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv;
    expect(configFromEnv({ ...base }).apns).toBeNull();
    expect(configFromEnv({ ...base, APNS_KEY_ID: KEY_ID }).apns).toBeNull();
    expect(configFromEnv({ ...base, APNS_KEY: 'not a pem', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, APNS_TOPIC: TOPIC }).apns).toBeNull();
    expect(configFromEnv({ ...base, APNS_KEY_PATH: '/nonexistent/key.p8', APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, APNS_TOPIC: TOPIC }).apns).toBeNull();

    // Parseable but non-ES256 keys must be rejected too: they would sign a
    // bogus "ES256" JWT and every push would 403.
    const rsaPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(configFromEnv({ ...base, APNS_KEY: rsaPem, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, APNS_TOPIC: TOPIC }).apns).toBeNull();
    const p384Pem = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(configFromEnv({ ...base, APNS_KEY: p384Pem, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, APNS_TOPIC: TOPIC }).apns).toBeNull();

    const full = configFromEnv({
      ...base,
      APNS_KEY: KEY_PEM,
      APNS_KEY_ID: KEY_ID,
      APNS_TEAM_ID: TEAM_ID,
      APNS_TOPIC: TOPIC,
    }).apns;
    expect(full).toMatchObject({ keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC, server: 'https://api.sandbox.push.apple.com' });

    expect(configFromEnv({ ...base, APNS_KEY: KEY_PEM, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, APNS_TOPIC: TOPIC, APNS_ENV: 'production' }).apns?.server)
      .toBe('https://api.push.apple.com');
    expect(configFromEnv({ ...base, APNS_KEY: KEY_PEM, APNS_KEY_ID: KEY_ID, APNS_TEAM_ID: TEAM_ID, APNS_TOPIC: TOPIC, APNS_SERVER: 'http://127.0.0.1:9999/' }).apns?.server)
      .toBe('http://127.0.0.1:9999');
  });
});

// ---- push dispatch ------------------------------------------------------------

describe('push dispatch', () => {
  it('a blocked transition pushes to ALL devices with the right path, headers, and payload', async () => {
    const mock = await mockApns();
    const { app } = makeApp({ apns: apnsCfg(mock.url) });
    const token = await createWorkspace(app);

    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_B, { notify_done: true })).expect(200);

    await request(app)
      .post(`/w/${token}/webhook`)
      .send(webhookBody('sess-1', { name: 'Refactor auth', message: 'Editing server.ts' }))
      .expect(200);
    await request(app)
      .post(`/w/${token}/webhook`)
      .send(webhookBody('sess-1', { status: 'blocked', message: 'Needs permission for rm -rf' }))
      .expect(200);

    await waitFor(() => mock.requests.length === 2, 'both blocked pushes');

    const paths = mock.requests.map((r) => r.path).sort();
    expect(paths).toEqual([`/3/device/${DEVICE_A}`, `/3/device/${DEVICE_B}`]);
    for (const r of mock.requests) {
      expect(r.headers['apns-topic']).toBe(TOPIC);
      expect(r.headers['apns-push-type']).toBe('alert');
      expect(r.headers['apns-priority']).toBe('10');
      const expiration = Number(r.headers['apns-expiration']);
      expect(expiration).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(r.body).toEqual({
        aps: {
          alert: { title: 'Refactor auth needs input', body: 'Needs permission for rm -rf' },
          sound: 'default',
          'thread-id': 'sess-1',
        },
      });
    }
  });

  it('done goes only to notify_done devices, with the done title', async () => {
    const mock = await mockApns();
    const { app } = makeApp({ apns: apnsCfg(mock.url) });
    const token = await createWorkspace(app);

    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_B, { notify_done: true })).expect(200);

    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-2', { name: 'Ship it' })).expect(200);
    await request(app)
      .post(`/w/${token}/webhook`)
      .send(webhookBody('sess-2', { status: 'done', message: '' }))
      .expect(200);

    await waitFor(() => mock.requests.length === 1, 'the done push');
    await sleep(100); // would-be extra pushes get a moment to (not) arrive

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].path).toBe(`/3/device/${DEVICE_B}`);
    const aps = (mock.requests[0].body as { aps: { alert: { title: string; body: string } } }).aps;
    expect(aps.alert.title).toBe('Ship it is done');
    expect(aps.alert.body).toBe('done'); // empty message falls back to the status word
  });

  it('non-transitions do not push: blocked→blocked and coding→coding are silent', async () => {
    const mock = await mockApns();
    const { app } = makeApp({ apns: apnsCfg(mock.url) });
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);

    // New session already blocked DOES push (once)...
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-3', { status: 'blocked' })).expect(200);
    await waitFor(() => mock.requests.length === 1, 'the new-session blocked push');

    // ...but blocked → blocked does not.
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-3', { status: 'blocked' })).expect(200);
    // And coding → coding never pushes.
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-4')).expect(200);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-4')).expect(200);
    await sleep(150);
    expect(mock.requests).toHaveLength(1);
  });

  it('a new session that arrives already done does NOT push (backfill noise)', async () => {
    const mock = await mockApns();
    const { app } = makeApp({ apns: apnsCfg(mock.url) });
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A, { notify_done: true })).expect(200);

    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-5', { status: 'done' })).expect(200);
    await sleep(150);
    expect(mock.requests).toHaveLength(0);
  });

  it('debounces repeat transitions of the same (session, kind) within the window', async () => {
    const mock = await mockApns();
    const { app } = makeApp({ apns: apnsCfg(mock.url) });
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);

    // blocked → coding → blocked within 60s: the second blocked push is debounced.
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-6', { status: 'blocked' })).expect(200);
    await waitFor(() => mock.requests.length === 1, 'the first blocked push');
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-6')).expect(200);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-6', { status: 'blocked' })).expect(200);
    await sleep(150);
    expect(mock.requests).toHaveLength(1);
  });

  it('pushes again once the debounce window has passed (short override)', async () => {
    const mock = await mockApns();
    const { store } = makeApp(); // store only; drive the Pusher directly
    const wsId = 'ws-debounce';
    store.upsertDevice(wsId, DEVICE_A, false);

    const pusher = new Pusher(apnsCfg(mock.url), store, { debounceMs: 50, log: () => {} });
    try {
      const session = {
        id: 's1', name: 'Agent', status: 'blocked' as const, message: 'stuck',
        project: '', createdAt: Date.now(), updatedAt: Date.now(),
      };
      pusher.notifyTransition(wsId, session, 'coding');
      pusher.notifyTransition(wsId, session, 'coding'); // inside the window → dropped
      await waitFor(() => mock.requests.length === 1, 'the first push');
      await sleep(80); // let the 50ms window lapse
      pusher.notifyTransition(wsId, session, 'coding');
      await waitFor(() => mock.requests.length === 2, 'the post-window push');
    } finally {
      pusher.shutdown();
    }
  });

  it('sends a valid ES256 JWT that verifies against the public key', async () => {
    const mock = await mockApns();
    const { app } = makeApp({ apns: apnsCfg(mock.url) });
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-7', { status: 'blocked' })).expect(200);
    await waitFor(() => mock.requests.length === 1, 'the push');

    const auth = String(mock.requests[0].headers.authorization);
    expect(auth).toMatch(/^bearer /);
    const [h, p, s] = auth.slice('bearer '.length).split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(payload.iss).toBe(TEAM_ID);
    expect(Math.abs(payload.iat - Date.now() / 1000)).toBeLessThan(60);

    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('prunes a device when APNs answers 410 Unregistered', async () => {
    const mock = await mockApns();
    const { app, store } = makeApp({ apns: apnsCfg(mock.url) });
    const token = await createWorkspace(app);
    const wsId = store.resolveToken(token)!;
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);

    mock.respondWith(410, { reason: 'Unregistered' });
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-8', { status: 'blocked' })).expect(200);
    await waitFor(() => store.deviceCount(wsId) === 0, 'the device to be pruned');
    expect(store.devices(wsId)).toEqual([]);
  });

  it('with APNs disabled (apns: null) nothing is sent and nothing crashes', async () => {
    const mock = await mockApns();
    const { app, store } = makeApp(); // apns: null
    const token = await createWorkspace(app);
    await request(app).post(`/w/${token}/devices`).send(registerBody(DEVICE_A)).expect(200);
    await request(app).post(`/w/${token}/webhook`).send(webhookBody('sess-9', { status: 'blocked' })).expect(200);
    await sleep(100);
    expect(mock.requests).toHaveLength(0);

    // Direct no-op check too.
    const pusher = new Pusher(null, store);
    pusher.notifyTransition('ws', {
      id: 's', name: 'n', status: 'blocked', message: '', project: '', createdAt: 0, updatedAt: 0,
    }, null);
    pusher.shutdown();
  });
});

// ---- transport resilience ------------------------------------------------------

describe('push transport resilience', () => {
  it('a stalled request times out, and 3 straight timeouts tear down the wedged connection', async () => {
    const mock = await mockApns();
    mock.stall(true);
    const { store } = makeApp();
    const wsId = 'ws-timeout';
    store.upsertDevice(wsId, DEVICE_A, false);

    const logs: string[] = [];
    const pusher = new Pusher(apnsCfg(mock.url), store, { timeoutMs: 100, log: (m) => logs.push(m) });
    const timeouts = (): number => logs.filter((l) => l.includes('timed out after 100ms')).length;
    try {
      pusher.notifyTransition(wsId, mkSession('t1'), null);
      await waitFor(() => timeouts() === 1, 'the first timeout log');

      pusher.notifyTransition(wsId, mkSession('t2'), null);
      pusher.notifyTransition(wsId, mkSession('t3'), null);
      await waitFor(() => timeouts() === 3, 'three timeout logs');

      // The 3rd consecutive timeout destroyed the wedged session; once the
      // server behaves again, a fresh connection delivers the next push.
      mock.stall(false);
      pusher.notifyTransition(wsId, mkSession('t4'), null);
      await waitFor(() => mock.requests.length === 4, 'the post-recovery push');
      await sleep(150); // the recovered push must not time out
      expect(timeouts()).toBe(3);
    } finally {
      pusher.shutdown();
    }
  });

  it('drops pushes past the in-flight cap instead of pinning them forever', async () => {
    const mock = await mockApns();
    mock.stall(true);
    const { store } = makeApp();
    const wsId = 'ws-cap';
    store.upsertDevice(wsId, DEVICE_A, false);

    const logs: string[] = [];
    const pusher = new Pusher(apnsCfg(mock.url), store, {
      timeoutMs: 5000, maxInFlight: 1, log: (m) => logs.push(m),
    });
    try {
      pusher.notifyTransition(wsId, mkSession('c1'), null); // occupies the only slot (stalled)
      await waitFor(() => mock.requests.length === 1, 'the stalled push to reach the server');

      pusher.notifyTransition(wsId, mkSession('c2'), null); // over the cap → dropped
      await waitFor(
        () => logs.some((l) => l.includes('dropped: in-flight cap (1) reached')),
        'the drop to be logged',
      );
      expect(mock.requests).toHaveLength(1); // the dropped push never went out
    } finally {
      pusher.shutdown();
    }
  });

  it('a store failure while pruning a 410 device is logged, never thrown', async () => {
    const mock = await mockApns();
    const { store } = makeApp();
    const wsId = 'ws-prune';
    store.upsertDevice(wsId, DEVICE_A, false);
    store.deleteDevice = () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    };

    const logs: string[] = [];
    const pusher = new Pusher(apnsCfg(mock.url), store, { log: (m) => logs.push(m) });
    try {
      mock.respondWith(410, { reason: 'Unregistered' });
      pusher.notifyTransition(wsId, mkSession('p1'), 'coding');
      await waitFor(
        () => logs.some((l) => l.includes('prune failed') && l.includes('SQLITE_IOERR')),
        'the prune failure to be logged',
      );
    } finally {
      pusher.shutdown();
    }
  });
});
