import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
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
 * The board script, run for real against the real shell.
 *
 * This used to drive a hand-written stub `document` whose elements held an
 * innerHTML string, on the argument that public/app.js only ever wrote whole
 * HTML strings. That stopped being true: the grid is reconciled by key now, so
 * it needs createElement, insertBefore and a live child list. The stub also
 * never exercised `paintFocus()` at all — its querySelector returned null, so
 * the function returned early every time and focus state was only ever read
 * back out of `renderFocus()`, which is the *other* producer of the same
 * markup. Half of what these tests are named for went unchecked.
 *
 * So: jsdom, seeded from public/index.html rather than a fixture, which means
 * the suite now also fails if the page stops carrying an element app.js needs.
 * `window` and `location` stay stubbed — the board assigns location.hash, and
 * jsdom treats that as navigation.
 */

const BOARD_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');
// index.html loads this before app.js, and app.js reads it at definition time.
const MARKS_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'marks.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');

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

/** Evaluates public/app.js against a real DOM and returns the handles a test drives it by. */
async function loadBoard() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://board.test/' });
  const doc = dom.window.document;
  const calls: Array<{ url: string; method: string; body: string }> = [];
  let stream: FakeStream | null = null;
  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  vi.stubGlobal('document', doc);
  // Not dom.window: the board assigns location.hash, which jsdom treats as a
  // navigation it then refuses to perform. Only these four members are read.
  vi.stubGlobal('window', { addEventListener() {} });   // marks.js writes AGSTATUS_MARKS onto this
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

  new Function(MARKS_SRC)();
  new Function(BOARD_SRC)();
  await vi.advanceTimersByTimeAsync(1);   // let init()'s /api/config settle and the stream open
  if (!stream) throw new Error('the board never opened its event stream');

  const gridEl = doc.getElementById('grid')!;
  return {
    grid: () => gridEl,
    /** Element-level reads, now that there is a real tree to query. */
    $: (sel: string) => gridEl.querySelector(sel),
    $$: (sel: string) => [...gridEl.querySelectorAll(sel)],
    emit: (type: string, data: unknown) => stream!.emit(type, data),
    /** Any session event re-renders the grid, which is where focus state is readable. */
    repaint(over: Record<string, unknown> = {}) { stream!.emit('session', session(over)); return gridEl; },
    /** A real click on the real control, so aria-disabled is honoured as it is in a browser. */
    tap(id: string, kind: 'focus' | 'resume' | 'dismiss') {
      const sel = kind === 'dismiss'
        ? `[data-dismiss="${id}"]`
        : `[data-focus="${id}"][data-type="${kind}"]`;
      const btn = gridEl.querySelector(sel);
      if (!btn) throw new Error(`no ${kind} control on the card for ${id}`);
      btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
    settle: () => vi.advanceTimersByTimeAsync(1),
    lastCommandId: () => JSON.parse(calls.filter((c) => c.url.endsWith('/commands')).pop()!.body).id as string,
    calls,
  };
}

// Read off the tree rather than off a serialization of it. The old versions
// regex-matched `class="focus-status"` out of an HTML string, which meant an
// assertion could pass for the wrong reason — `not.toContain('class="focus"')`
// below was already vacuous the moment that element gained a second class.
const statusText = (root: Element) => root.querySelector('.focus-status')?.textContent?.trim() ?? '';
const noteText = (root: Element) => root.querySelector('.focus-note')?.textContent?.trim() ?? '';
const resumeShown = (root: Element) => {
  const btn = root.querySelector('[data-type="resume"]');
  return Boolean(btn) && !btn!.hasAttribute('hidden');
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
    expect(b.grid().textContent).not.toContain('AgStatus listener');
  });

  it('turns a machine the reconnect frame no longer lists offline, keeping its name', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    b.emit('machines', []);   // it dropped while the stream was down
    expect(noteText(b.grid())).toBe('Studio is offline');
    expect(b.grid().textContent).not.toContain('AgStatus listener');
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
    expect(b.$$('.focus')).toHaveLength(0);

    b.emit('session', session());
    expect(statusText(b.grid())).toBe('');
    expect(resumeShown(b.grid())).toBe(false);
  });

  // The grid is reconciled by key, and the whole of board.css's motion rests on
  // that: a card that moves is supposed to have news. Reassigning the grid's
  // innerHTML — which is what this board did for its whole life — restarted
  // every card's entrance animation and cancelled every transition in flight,
  // on a frame about some other card.
  it('leaves a card it has no news about completely alone', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session(), session({ id: 's2', name: 'Other', host: null })]);

    const before = b.$$('.card');
    expect(before).toHaveLength(2);
    const quiet = before.find((c) => (c as HTMLElement).dataset.id === 's2')!;
    const quietName = quiet.querySelector('.name');

    // A frame about s1 only.
    b.emit('session', session({ message: 'now editing src/store.ts' }));

    const after = b.$$('.card');
    expect(after).toHaveLength(2);
    // Same elements, in both cases — not rebuilt, not replaced.
    expect(after.find((c) => (c as HTMLElement).dataset.id === 's2')).toBe(quiet);
    expect(quiet.querySelector('.name')).toBe(quietName);
    // ...and the card that did have news shows it.
    expect(b.$('.card[data-id="s1"] .message')!.textContent).toBe('now editing src/store.ts');
  });

  it('swaps the status class on the card it already has, and marks the change', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    const card = b.$('.card') as HTMLElement;
    expect(card.className).toContain('status-coding');

    b.emit('session', session({ status: 'blocked', message: 'needs approval' }));
    expect(b.$('.card')).toBe(card);
    expect(card.className).toContain('status-blocked');
    expect(card.className).not.toContain('status-coding');
    // `.changed` is what board.css animates; it is cleared on animationend,
    // which jsdom never fires, so seeing it here is exactly the assertion.
    expect(card.className).toContain('changed');
    expect(card.querySelector('.badge')!.textContent).toBe('blocked');

    // ...and clears when the animation reports it is over, which is the only
    // thing that lets the NEXT change re-trigger it. jsdom runs no animations,
    // so the event is delivered by hand; what is under test is the handler.
    const end = (name: string) => {
      const e = card.ownerDocument.createEvent('Event');
      e.initEvent('animationend', true, true);
      (e as unknown as { animationName: string }).animationName = name;
      card.dispatchEvent(e);
    };
    end('state-change');
    expect(card.className).not.toContain('changed');
    end('card-in');
    expect(card.className).not.toContain('entering');

    // A second change re-arms it, which it could not do if the class had stuck.
    b.emit('session', session({ status: 'done', message: 'finished' }));
    expect(b.$('.card')).toBe(card);
    expect(card.className).toContain('changed');
  });

  // Four states that need nothing from you are quiet outlines and `blocked` is
  // solid, but the point of the marks is that there IS a second channel: the
  // board's design principle is that state is never carried by hue alone.
  it('gives every status its own mark, not just its own colour', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    const kinds = ['idle', 'planning', 'coding', 'testing', 'blocked', 'done'];
    b.emit('snapshot', kinds.map((status, i) => session({ id: `s${i}`, status, host: null })));
    const marks = b.$$('.state-mark');
    expect(marks).toHaveLength(6);
    const shapes = new Set(marks.map((m) => m.innerHTML));
    expect(shapes.size).toBe(6);   // six statuses, six distinct drawings
    for (const m of marks) expect(m.getAttribute('aria-hidden')).toBe('true');
  });

  // A status this client does not know is a card that renders quietly, not a
  // render loop that stops. classList.add throws on a value with a space in
  // it, and the throw would be inside the loop that draws every other card.
  it('survives a status it has never heard of, and keeps drawing the rest', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('snapshot', [
      session({ id: 'a', status: 'rogue status', host: null }),
      session({ id: 'b', status: 'coding', host: null }),
    ]);

    expect(b.$$('.card')).toHaveLength(2);          // the good card still drew
    const odd = b.$('.card[data-id="a"]') as HTMLElement;
    expect(odd.className).not.toContain('status-');  // matched no rule
    expect(odd.dataset.status).toBe('rogue status'); // but the board kept the fact
    expect(odd.querySelector('.badge')!.textContent).toBe('rogue status');
    expect(odd.querySelector('.state-mark')).not.toBeNull();
    expect(b.$('.card[data-id="b"]')!.className).toContain('status-coding');
  });

  // paintFocus() patches the ack line in place rather than re-rendering the
  // grid, so the aria-live region keeps its identity and actually announces.
  // The old stub could not run this function at all.
  it('updates the ack line without rebuilding the card around it', async () => {
    vi.useFakeTimers();
    const b = await loadBoard();
    b.emit('machines', online());
    b.emit('snapshot', [session()]);
    const card = b.$('.card');
    const line = b.$('.focus-status');
    expect(line!.getAttribute('aria-live')).toBe('polite');

    b.tap('s1', 'focus');
    await b.settle();
    // Same nodes: no repaint happened, the text was written into them.
    expect(b.$('.card')).toBe(card);
    expect(b.$('.focus-status')).toBe(line);
    expect(statusText(b.grid())).toBe('Sent…');

    b.emit('command_ack', { id: b.lastCommandId(), session_id: 's1', result: 'focused' });
    expect(b.$('.focus-status')).toBe(line);
    expect(line!.className).toBe('focus-status ok');
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
