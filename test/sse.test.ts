import { describe, it, expect } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { makeApp, webhookBody } from './helpers';

// supertest does not handle long-lived streams well, so SSE tests run the app
// on a real ephemeral port and use native fetch with AbortControllers.

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
    // Node >= 18.2: drop any lingering keep-alive sockets so close() completes.
    (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    srv.close(() => resolve());
  });
}

async function createWorkspaceHttp(base: string): Promise<string> {
  const res = await fetch(`${base}/api/workspaces`, { method: 'POST' });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function postWebhook(base: string, token: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}/w/${token}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  await res.text();
}

function connectSse(base: string, token: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${base}/w/${token}/events`, {
    signal,
    headers: { accept: 'text/event-stream' },
  });
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Accumulate stream chunks until `needle` appears; fail fast on timeout/EOF. */
async function waitForChunk(reader: ChunkReader, needle: string, timeoutMs = 4000): Promise<string> {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;

  while (!buf.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}; received: ${JSON.stringify(buf)}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; received: ${JSON.stringify(buf)}`)),
            remaining,
          );
        }),
      ]);
      if (result.done) {
        throw new Error(`stream ended before ${JSON.stringify(needle)}; received: ${JSON.stringify(buf)}`);
      }
      buf += decoder.decode(result.value, { stream: true });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return buf;
}

describe('SSE (/w/:token/events)', () => {
  it('sends a snapshot on connect, then session events for webhook posts', async () => {
    const { app } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();

    try {
      const token = await createWorkspaceHttp(base);
      await postWebhook(base, token, webhookBody('pre-1', { name: 'Existing' }));

      const res = await connectSse(base, token, ac.signal);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
      if (!res.body) throw new Error('SSE response has no body stream');
      const reader = res.body.getReader();

      // Initial snapshot must include the previously-posted session
      const snapshot = await waitForChunk(reader, 'event: snapshot');
      expect(snapshot).toContain('pre-1');

      // A webhook upsert while connected produces a session event
      await postWebhook(base, token, webhookBody('live-2', { status: 'testing' }));
      const sessionEvt = await waitForChunk(reader, 'event: session');
      expect(sessionEvt).toContain('live-2');
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });

  it('allows 10 concurrent connections per workspace; the 11th gets 429', async () => {
    // rateLimit: true so the test holds whether the implementation treats the
    // SSE cap as an always-on structural cap or as part of rate limiting.
    const { app } = makeApp({ rateLimit: true });
    const { srv, base } = await listen(app);
    const controllers: AbortController[] = [];

    try {
      const token = await createWorkspaceHttp(base);

      for (let i = 1; i <= 10; i++) {
        const ac = new AbortController();
        controllers.push(ac);
        const res = await connectSse(base, token, ac.signal);
        expect(res.status, `SSE connection #${i}`).toBe(200);
      }

      const ac11 = new AbortController();
      controllers.push(ac11);
      const res11 = await connectSse(base, token, ac11.signal);
      expect(res11.status).toBe(429);
      await res11.text().catch(() => '');
    } finally {
      for (const ac of controllers) ac.abort();
      await closeServer(srv);
    }
  });

  it('DELETE /w/:token ends the workspace\'s SSE streams', async () => {
    const { app } = makeApp();
    const { srv, base } = await listen(app);
    const ac = new AbortController();

    try {
      const token = await createWorkspaceHttp(base);
      const res = await connectSse(base, token, ac.signal);
      expect(res.status).toBe(200);
      if (!res.body) throw new Error('SSE response has no body stream');
      const reader = res.body.getReader();
      await waitForChunk(reader, 'event: snapshot');

      const del = await fetch(`${base}/w/${token}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      await del.text();

      // The stream should terminate (done) shortly after workspace deletion.
      const deadline = Date.now() + 4000;
      let ended = false;
      while (Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            // An abrupt socket teardown rejects read(); treat that as ended too.
            reader.read().catch(() => ({ done: true as const, value: undefined })),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('stream still open after workspace deletion')), deadline - Date.now());
            }),
          ]);
          if (result.done) {
            ended = true;
            break;
          }
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      expect(ended).toBe(true);
    } finally {
      ac.abort();
      await closeServer(srv);
    }
  });
});
