/**
 * The listener's half of the board's event stream: one long-lived GET on
 * `/events?listener=<machine_id>&name=…` with the machine key in the
 * `Authorization: Bearer` header, parsed by hand (Node has no EventSource and the
 * CLI has no room for a dependency), and reconnected forever — exponential backoff with jitter from 1 s to 60 s, a
 * 60 s pause after a 429 or an auth error so a misconfigured machine never
 * spins against the board, and an idle watchdog that drops a stream the
 * server stopped keeping alive (design §3.3, §5.4). subscribe() resolves
 * only when its signal aborts; everything it learns goes through the
 * callbacks. The key travels as a header, like `x-webhook-secret`, and so
 * reaches neither this log nor the board's access log: a URL is recorded
 * verbatim by nginx, Cloudflare and most PaaS, a request header is not. Only
 * the machine id — which every board viewer already reads off the `machines`
 * frame — stays in the query.
 *
 * The stream is data from the network: a line or a frame past 1 MB drops
 * the connection (into the normal backoff, so a board that keeps doing it
 * backs off to a minute), the server-chosen event name reaches the log
 * only when it looks like one, and a redirect is an error — the key is
 * never replayed to a Location the board or a man in the middle names
 * (`fetch` forwards a custom header across a redirect, so this is the guard
 * that keeps the header as private as the query string was not).
 */

/** A pending line or a frame's joined data past this size ends the stream. */
export const MAX_FRAME_BYTES = 1 << 20;
/** What an event name the board sends may look like; anything else is logged as `other`. */
const EVENT_NAME_RE = /^[a-z_]{1,32}$/;

export class OversizedFrameError extends Error {
  constructor() {
    super('oversized frame');
    this.name = 'OversizedFrameError';
  }
}

export interface SubscribeTiming {
  /** First reconnect delay; doubles per attempt up to backoffMaxMs, plus jitter. */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** A stream that lived this long resets the backoff. */
  stableMs: number;
  /** No bytes for this long (the server keeps alive every 25 s) → abort and reconnect. */
  idleMs: number;
  /** After a 429, or after a 400/401/403 that means the config is wrong. */
  penaltyMs: number;
  /** How long the response headers may take. */
  connectMs: number;
}

export const DEFAULT_TIMING: SubscribeTiming = {
  backoffMinMs: 1000,
  backoffMaxMs: 60_000,
  stableMs: 30_000,
  idleMs: 90_000,
  penaltyMs: 60_000,
  connectMs: 15_000,
};

export interface SubscribeOptions {
  /** boardBase(url): the `/events` route is appended here. */
  base: string;
  /** Legacy single-tenant servers: sent as x-webhook-secret. */
  secret?: string;
  machinePublicId: string;
  machineKey: string;
  name: string;
  /** Every frame with JSON data, by event name; a throw here is logged and does not end the stream. */
  onFrame: (event: string, data: unknown) => void;
  onOpen?: () => void;
  onClose?: (why: string) => void;
  /** Aborting it ends the current request, any wait, and resolves subscribe(). */
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  log: (line: string) => void;
  /** Shorter waits for tests; production runs the defaults. */
  timing?: Partial<SubscribeTiming>;
}

/**
 * The SSE wire format, as much of it as the board uses: `event:` and
 * `data:` lines, a blank line ends a frame, several `data:` lines join with
 * "\n", `:` comments (the keepalive) are skipped, and `id:`/`retry:` are
 * ignored. Bytes are fed as decoded text; a partial last line waits. A
 * pending line or a frame's data past MAX_FRAME_BYTES (counted in UTF-16
 * units, near enough) throws OversizedFrameError: the caller drops the
 * stream and calls reset() before the next one.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private dataLength = 0;

  constructor(private readonly onFrame: (event: string, data: string) => void) {}

  push(text: string): void {
    this.buffer += text;
    if (this.buffer.length > MAX_FRAME_BYTES) throw new OversizedFrameError();
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) return;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.line(line);
    }
  }

  /** Forgets a partial line and a half-built frame, so the next stream starts clean. */
  reset(): void {
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.dataLength = 0;
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.onFrame(this.event || 'message', this.data.join('\n'));
      this.event = '';
      this.data = [];
      this.dataLength = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.dataLength += value.length + 1;
      if (this.dataLength > MAX_FRAME_BYTES) throw new OversizedFrameError();
      this.data.push(value);
    }
  }
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

/** min·2^attempt, capped, plus up to a quarter of itself as jitter (never below the floor). */
function backoffMs(attempt: number, t: SubscribeTiming): number {
  const raw = Math.min(t.backoffMaxMs, t.backoffMinMs * 2 ** Math.min(attempt, 16));
  return Math.round(Math.min(t.backoffMaxMs, raw + Math.random() * raw * 0.25));
}

/** A wait the signal can cut short. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Reads the body to its end, feeding the parser and pinging the watchdog per chunk. */
async function pump(body: ReadableStream<Uint8Array>, parser: SseParser, onBytes: () => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes();
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* the stream is gone either way */
    }
  }
}

export async function subscribe(opts: SubscribeOptions): Promise<void> {
  const t: SubscribeTiming = { ...DEFAULT_TIMING, ...opts.timing };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { signal, log } = opts;
  const url =
    `${opts.base}/events?listener=${encodeURIComponent(opts.machinePublicId)}` +
    `&name=${encodeURIComponent(opts.name)}`;
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    // `Authorization`, not a custom name: credential-redacting log
    // pipelines (Caddy's `log_credentials` included) key off this header name.
    authorization: `Bearer ${opts.machineKey}`,
  };
  if (opts.secret) headers['x-webhook-secret'] = opts.secret;

  const parser = new SseParser((event, raw) => {
    // The board chose the event name; the log and the handler see it only when it looks like one.
    const name = EVENT_NAME_RE.test(event) ? event : 'other';
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      log(`sse: ${name} frame with non-JSON data ignored`);
      return;
    }
    try {
      opts.onFrame(name, data);
    } catch (err) {
      log(`sse: ${name} handler threw ${(err as Error).name}`);
    }
  });

  let attempt = 0;
  let misconfigured = false;
  while (!signal.aborted) {
    const ctrl = new AbortController();
    const abort = (): void => ctrl.abort();
    signal.addEventListener('abort', abort, { once: true });
    let why = 'closed';
    let status = 0;
    let watchdog: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        why = 'idle';
        ctrl.abort();
      }, t.idleMs);
    };
    const startedAt = Date.now();
    parser.reset();
    try {
      const connectTimer = setTimeout(() => {
        why = 'connect timeout';
        ctrl.abort();
      }, t.connectMs);
      let res: Response;
      try {
        res = await fetchImpl(url, { headers, signal: ctrl.signal, redirect: 'error' });
      } finally {
        clearTimeout(connectTimer);
      }
      status = res.status;
      if (status === 200 && res.body) {
        misconfigured = false;
        log('sse: connected');
        opts.onOpen?.();
        arm();
        await pump(res.body, parser, arm);
      } else {
        why = `http ${status}`;
        try {
          await res.body?.cancel();
        } catch {
          /* nothing to drain */
        }
      }
    } catch (err) {
      if (signal.aborted) why = 'stopped';
      else if (err instanceof OversizedFrameError) {
        why = 'oversized frame';
        ctrl.abort();
      } else if (why === 'closed') why = 'error';
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener('abort', abort);
    }
    if (signal.aborted) {
      log('sse: stopped');
      opts.onClose?.('stopped');
      return;
    }

    const lived = Date.now() - startedAt;
    let delay: number;
    if (status === 429) {
      delay = t.penaltyMs;
      log(`sse: HTTP 429 from the board — waiting ${seconds(delay)}`);
    } else if (status === 400 || status === 401 || status === 403) {
      delay = t.penaltyMs;
      if (!misconfigured) {
        misconfigured = true;
        log(
          `sse: HTTP ${status} — the board rejects this listener (key, secret or URL); ` +
            `run \`agstatus listener doctor\`. Retrying every ${seconds(delay)}`
        );
      }
    } else {
      // A stream that misbehaved does not count as stable, however long it lived first.
      if (status === 200 && lived > t.stableMs && why !== 'oversized frame') attempt = 0;
      delay = backoffMs(attempt, t);
      attempt += 1;
      log(`sse: ${why} after ${seconds(lived)} — reconnecting in ${seconds(delay)}`);
    }
    opts.onClose?.(why);
    await sleep(delay, signal);
  }
  log('sse: stopped');
}
