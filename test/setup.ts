import net from 'net';
import { beforeAll } from 'vitest';

/*
 * supertest starts a throwaway server with a bare `listen(0)` for every
 * request and closes it right after. On macOS the kernel's automatic port
 * choice for that dual-stack [::] bind does not exclude a port another
 * process already holds on 127.0.0.1 alone: the bind succeeds beside it, and
 * that process answers the request — a JetBrains helper with 403 Forbidden,
 * Docker with 400, Postgres with a reset (`socket hang up`), an IDE never (a
 * 10 s stall). About one request in 4000, and a serial run makes more than
 * that. So a bare `listen(0)` takes an explicit port instead, from a band
 * this file has probed on 127.0.0.1 — below the ephemeral range of both
 * macOS (49152+) and Linux (32768+), where automatically assigned foreign
 * listeners never sit. A port that [::] cannot bind is skipped on the spot
 * (that failure is synchronous, which is what supertest needs: it reads
 * `address()` right after `listen(0)` returns). The pool wraps around, and a
 * port still in TIME_WAIT rebinds because Node sets SO_REUSEADDR.
 */
const BAND_FIRST = 20000;
const BAND_LAST = 31999;
const POOL_SIZE = 2500;

interface PortPool { ports: number[]; next: number }
type Listen = net.Server['listen'];
const g = globalThis as { __supertestPorts?: PortPool };

function freeOnLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function pooledListen(original: Listen): Listen {
  const listen = function (this: net.Server, ...args: unknown[]) {
    const pool = g.__supertestPorts;
    if (!pool || args.length !== 1 || args[0] !== 0) return original.apply(this, args as never);
    for (let tries = 0; tries < pool.ports.length; tries++) {
      const port = pool.ports[pool.next];
      pool.next = (pool.next + 1) % pool.ports.length;
      original.call(this, port);
      if (this.address()) return this;
      // Taken on [::] meanwhile; the EADDRINUSE for this attempt arrives on
      // the next tick and would otherwise be an uncaught exception.
      this.once('error', () => undefined);
    }
    return original.call(this, 0);
  } as Listen;
  (listen as { pooled?: true }).pooled = true;
  return listen;
}

beforeAll(async () => {
  // Files in one worker process share the pool and the patch.
  if (!g.__supertestPorts) {
    const ports: number[] = [];
    let port = BAND_FIRST + Math.floor(Math.random() * (BAND_LAST - BAND_FIRST - POOL_SIZE));
    while (ports.length < POOL_SIZE && port <= BAND_LAST) {
      if (await freeOnLoopback(port)) ports.push(port);
      port += 1;
    }
    g.__supertestPorts = { ports, next: 0 };
  }
  if (!(net.Server.prototype.listen as { pooled?: true }).pooled) {
    net.Server.prototype.listen = pooledListen(net.Server.prototype.listen);
  }
});
