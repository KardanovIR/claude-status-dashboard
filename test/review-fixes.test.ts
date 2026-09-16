import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { configFromEnv } from '../src/config';
import { makeApp } from './helpers';

describe('configFromEnv hardening', () => {
  it('TRUST_PROXY only enables on "1" or "true"', () => {
    expect(configFromEnv({ TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(configFromEnv({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(configFromEnv({ TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(configFromEnv({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(configFromEnv({ TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(configFromEnv({}).trustProxy).toBe(false);
  });

  it('invalid SESSION_TTL_MS falls back to the mode default instead of NaN', () => {
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '24h' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ SESSION_TTL_MS: '24h' }).sessionTtlMs).toBe(0);
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: ' ' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '-5' }).sessionTtlMs).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '5000' }).sessionTtlMs).toBe(5000);
    expect(configFromEnv({ MULTI_TENANT: 'true', SESSION_TTL_MS: '0' }).sessionTtlMs).toBe(0);
  });

  it('invalid MAX_WORKSPACES falls back to the default', () => {
    expect(configFromEnv({ MAX_WORKSPACES: 'lots' }).maxWorkspaces).toBe(10_000);
    expect(configFromEnv({ MAX_WORKSPACES: '0' }).maxWorkspaces).toBe(10_000);
    expect(configFromEnv({ MAX_WORKSPACES: '50' }).maxWorkspaces).toBe(50);
  });

  it('COMMAND_TTL_MS must be whole milliseconds of at least a second, else the default', () => {
    for (const bad of ['soon', '0', '1', '0.5', '999', '1500.5', '-120000']) {
      expect(configFromEnv({ COMMAND_TTL_MS: bad }).commandTtlMs, bad).toBe(120_000);
    }
    expect(configFromEnv({ COMMAND_TTL_MS: '1000' }).commandTtlMs).toBe(1000);
    expect(configFromEnv({ COMMAND_TTL_MS: '30000' }).commandTtlMs).toBe(30_000);
  });
});

describe('global workspace cap', () => {
  it('creation returns 503 once maxWorkspaces is reached', async () => {
    const { app } = makeApp({ maxWorkspaces: 2 });
    await request(app).post('/api/workspaces').expect(201);
    await request(app).post('/api/workspaces').expect(201);
    const res = await request(app).post('/api/workspaces').expect(503);
    expect(res.body.error).toMatch(/capacity/);
  });

  it('deleting a workspace frees capacity', async () => {
    const { app } = makeApp({ maxWorkspaces: 1 });
    const created = await request(app).post('/api/workspaces').expect(201);
    await request(app).post('/api/workspaces').expect(503);
    await request(app).delete(`/w/${created.body.token}`).expect(200);
    await request(app).post('/api/workspaces').expect(201);
  });
});

describe('/api/config legacy fields', () => {
  it('legacy mode reports requiresSecret and webhookUrl', async () => {
    const { app } = makeApp({ multiTenant: false, webhookSecret: 's3cret' });
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.mode).toBe('legacy');
    expect(res.body.requiresSecret).toBe(true);
    expect(res.body.webhookUrl).toBe('http://test.local/webhook');
  });

  it('legacy mode without a secret reports requiresSecret false', async () => {
    const { app } = makeApp({ multiTenant: false });
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.requiresSecret).toBe(false);
  });

  it('multi mode omits webhookUrl and requiresSecret', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.mode).toBe('multi');
    expect(res.body).not.toHaveProperty('requiresSecret');
    expect(res.body).not.toHaveProperty('webhookUrl');
  });
});

/*
 * The board script, run for real. There is no DOM here — this suite is a node
 * environment and the repo takes no new dependency, so there is no jsdom to
 * render into — but public/app.js only ever writes whole HTML strings, so a
 * stub `document` whose elements hold an innerHTML string, plus a stub
 * EventSource the test pushes frames into, is enough to drive it end to end.
 * `paintFocus()` finds no card in that stub and returns early, so focus state
 * is read back through `renderGrid()`'s HTML, which `renderFocus()` builds
 * from the very same entry.
 */

const BOARD_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

type Handler = (e: unknown) => void;

interface FakeEl {
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  handlers: Record<string, Handler>;
  addEventListener(type: string, fn: Handler): void;
  querySelector(): null;
  querySelectorAll(): never[];
  classList: { toggle(): void; add(): void; remove(): void };
}

function fakeEl(): FakeEl {
  return {
    innerHTML: '',
    textContent: '',
    hidden: false,
    handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { toggle() {}, add() {}, remove() {} },
  };
}

/** The stream the board subscribed to, with a way to push one frame into it. */
class FakeStream {
  private listeners = new Map<string, (e: { data: string }) => void>();
  addEventListener(type: string, fn: (e: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
  emit(type: string, data: unknown): void {
    const fn = this.listeners.get(type);
    if (!fn) throw new Error(`the board is not listening for "${type}"`);
    fn({ data: JSON.stringify(data) });
  }
}

const HOST = {
  machine: { id: 'm1', name: 'Studio' },
  app: { slug: 'agterm', name: 'agterm', kind: 'terminal' },
};
const session = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Fix the parser',
  status: 'coding',
  message: 'editing src/app.ts',
  project: 'agstatus',
  updatedAt: Date.now(),
  host: HOST,
  ...over,
});
const online = () => [{ id: 'm1', name: 'Studio', online: true, since: Date.now() }];

/** Evaluates public/app.js against the stubs and returns the handles a test drives it by. */
async function loadBoard() {
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    let e = els.get(id);
    if (!e) { e = fakeEl(); els.set(id, e); }
    return e;
  };
  const calls: Array<{ url: string; method: string; body: string }> = [];
  let stream: FakeStream | null = null;
  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  vi.stubGlobal('document', {
    getElementById: (id: string) => el(id),
    querySelectorAll: () => [],
    body: { classList: { toggle() {} } },
  });
  vi.stubGlobal('window', { addEventListener() {} });
  vi.stubGlobal('location', { pathname: '/', hash: '', origin: 'http://board.test', href: '' });
  vi.stubGlobal('navigator', { clipboard: { writeText: async () => {} } });
  vi.stubGlobal('EventSource', class extends FakeStream {
    constructor(_url: string) { super(); stream = this; }
  });
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body || '' });
    if (url.endsWith('/api/config')) return reply({ mode: 'legacy', webhookUrl: 'http://board.test/webhook' });
    if (url.endsWith('/commands')) return reply({ id: JSON.parse(init!.body!).id, delivered: true });
    return reply({});
  });

  new Function(BOARD_SRC)();
  await vi.advanceTimersByTimeAsync(1);   // let init()'s /api/config settle and the stream open
  if (!stream) throw new Error('the board never opened its event stream');

  return {
    grid: () => el('grid').innerHTML,
    emit: (type: string, data: unknown) => stream!.emit(type, data),
    /** Any session event re-renders the grid, which is where focus state is readable. */
    repaint(over: Record<string, unknown> = {}) { stream!.emit('session', session(over)); return el('grid').innerHTML; },
    tap(id: string, kind: 'focus' | 'resume' | 'dismiss') {
      const want = kind === 'dismiss' ? '[data-dismiss]' : '[data-focus]';
      const btn = { dataset: kind === 'dismiss' ? { dismiss: id } : { focus: id, type: kind }, getAttribute: () => null };
      el('grid').handlers.click({ preventDefault() {}, target: { closest: (sel: string) => (sel === want ? btn : null) } });
    },
    settle: () => vi.advanceTimersByTimeAsync(1),
    lastCommandId: () => JSON.parse(calls.filter((c) => c.url.endsWith('/commands')).pop()!.body).id as string,
    calls,
  };
}

const statusText = (html: string) => /<span class="focus-status[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1].trim() ?? '';
const noteText = (html: string) => /<span class="focus-note"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1].trim() ?? '';
const resumeShown = (html: string) => {
  const btn = /<button[^>]*data-type="resume"[^>]*>/.exec(html)?.[0];
  return Boolean(btn) && !/\shidden/.test(btn!);
};

describe('board script: focus lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // The 15s mark is a warning, not a verdict: a listener that was asleep can
  // still claim and ack well inside the server's 120s TTL, and the card that
  // said "is it asleep?" must accept that answer rather than discard it.
  it('keeps waiting past the 15s mark, so a slow ack still lands on the card', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.tap('s1', 'focus');
    await b.settle();
    expect(statusText(b.repaint())).toBe('Sent…');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(statusText(b.repaint())).toContain('No answer from Studio yet');

    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'focused', reach: 'window' });
    expect(statusText(b.repaint())).toBe('Brought to front on Studio');
  });

  // And the give-up that follows is still the board's own guess: COMMAND_TTL_MS
  // belongs to whoever runs the board, so an ack that beats it wins anyway.
  it('gives up only near the command TTL, and a later ack still overrides it', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.tap('s1', 'focus');
    await vi.advanceTimersByTimeAsync(149_000);
    expect(statusText(b.repaint())).toContain('yet');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(statusText(b.repaint())).toBe('No answer from Studio — is it asleep?');

    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'focused', reach: 'window' });
    expect(statusText(b.repaint())).toBe('Brought to front on Studio');
  });

  // The `machines` frame lists only who is online, and it arrives again on every
  // reconnect: a machine missing from it is offline, never unknown.
  it('keeps a known offline machine across a reconnect re-seed', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.emit('machine', { id: 'm1', online: false, lastSeen: Date.now() });
    expect(noteText(b.grid())).toContain('Studio is offline');

    b.emit('machines', []);
    expect(noteText(b.grid())).toContain('Studio is offline');
    expect(b.grid()).not.toContain('AgStatus listener');
  });

  it('turns a machine the reconnect frame no longer lists offline, keeping its name', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.emit('machines', []);   // it dropped while the stream was down
    expect(noteText(b.grid())).toBe('Studio is offline');
    expect(b.grid()).not.toContain('AgStatus listener');
  });

  // Focus off posts `host: null`, which draws no focus row — so the entry behind
  // it has to go, or re-enabling Focus brings back the old tap's Resume button.
  it('drops focus state when the machine turns Focus off', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.tap('s1', 'focus');
    await b.settle();
    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'failed', reason: 'not-running' });
    expect(resumeShown(b.repaint())).toBe(true);

    b.emit('session', session({ host: null }));
    expect(b.grid()).not.toContain('class="focus"');

    b.emit('session', session());
    expect(statusText(b.grid())).toBe('');
    expect(resumeShown(b.grid())).toBe(false);
  });

  // Dismiss deletes on the spot, so it must not wait for the `remove` broadcast
  // to drop the focus entry: sessions are soft-deleted and come back.
  it('drops focus state when the card is dismissed', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.tap('s1', 'focus');
    await b.settle();
    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'failed', reason: 'not-running' });
    expect(resumeShown(b.repaint())).toBe(true);

    b.tap('s1', 'dismiss');
    await b.settle();
    expect(b.calls.some((c) => c.method === 'DELETE')).toBe(true);

    b.emit('session', session());
    expect(statusText(b.grid())).toBe('');
    expect(resumeShown(b.grid())).toBe(false);
  });
});
