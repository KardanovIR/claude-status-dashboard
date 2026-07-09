// Subscribes to the dashboard's GET /events SSE stream and keeps an in-memory
// session map in sync. Mirrors the browser client in public/app.js (snapshot /
// session / remove events), but uses fetch streaming instead of EventSource.

import { config } from './config.js';
import type { Session } from './types.js';

type ChangeListener = (sessions: Map<string, Session>) => void;

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private listener: ChangeListener = () => {};
  private backoffMs = 1000;
  private stopped = false;

  onChange(fn: ChangeListener): void {
    this.listener = fn;
  }

  snapshot(): Map<string, Session> {
    return this.sessions;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private emit(): void {
    this.listener(this.sessions);
  }

  private async loop(): Promise<void> {
    const url = `${config.dashboardUrl}/events`;
    while (!this.stopped) {
      try {
        console.log(`[sse] connecting to ${url}`);
        const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        console.log('[sse] connected');
        this.backoffMs = 1000;
        await this.consume(res.body);
      } catch (err) {
        if (this.stopped) break;
        console.warn(`[sse] disconnected: ${(err as Error).message}; retrying in ${this.backoffMs}ms`);
        await delay(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 15000);
      }
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (!this.stopped) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.handleFrame(frame);
      }
    }
  }

  private handleFrame(frame: string): void {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // keepalive comment
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;

    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }

    switch (event) {
      case 'snapshot': {
        this.sessions.clear();
        for (const s of data as Session[]) this.sessions.set(s.id, s);
        this.emit();
        break;
      }
      case 'session': {
        const s = data as Session;
        this.sessions.set(s.id, s);
        this.emit();
        break;
      }
      case 'remove': {
        const { id } = data as { id: string };
        if (this.sessions.delete(id)) this.emit();
        break;
      }
      default:
        break;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
