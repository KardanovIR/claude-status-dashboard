export const DEFAULT_URL = 'https://claude-status.kardan.ddns.net';

export interface ServerConfig {
  mode: 'multi' | 'legacy';
  version?: string;
  requiresSecret?: boolean;
}

export interface Board {
  token: string;
  dashboardUrl: string;
  webhookUrl: string;
}

/** --url flag > AGSTATUS_URL env > built-in default; normalized (no trailing / or /webhook). */
export function resolveBaseUrl(flagUrl?: string): string {
  const raw = flagUrl || process.env.AGSTATUS_URL || DEFAULT_URL;
  let base = raw.trim().replace(/\/+$/, '');
  base = base.replace(/\/webhook$/, '');
  if (!/^https?:\/\//.test(base)) base = `https://${base}`;
  return base;
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5000
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON response */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Returns null when the server can't be reached or doesn't answer sanely. */
export async function getConfig(base: string): Promise<ServerConfig | null> {
  try {
    const { status, body } = await fetchJson(`${base}/api/config`);
    if (status !== 200) return null;
    const mode = body.mode === 'multi' ? 'multi' : 'legacy';
    return {
      mode,
      version: typeof body.version === 'string' ? body.version : undefined,
      requiresSecret: body.requiresSecret === true,
    };
  } catch {
    return null;
  }
}

export async function createWorkspace(base: string): Promise<Board> {
  const { status, body } = await fetchJson(`${base}/api/workspaces`, { method: 'POST' });
  if (status === 429) {
    throw new Error('The server is rate-limiting board creation from your address. Try again later.');
  }
  if (status === 503) {
    throw new Error('The server is at capacity and not accepting new boards right now.');
  }
  if (status !== 201 || typeof body.token !== 'string') {
    throw new Error(`Could not create a board (HTTP ${status}).`);
  }
  return boardFrom(base, body.token);
}

export async function claimCode(base: string, code: string): Promise<Board> {
  const { status, body } = await fetchJson(`${base}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (status === 404) {
    throw new Error('That pairing code is invalid or has expired. Generate a fresh one and retry.');
  }
  if (status === 429) {
    throw new Error('Too many pairing attempts from your address. Wait a minute and retry.');
  }
  if (status !== 200 || typeof body.token !== 'string') {
    throw new Error(`Pairing failed (HTTP ${status}).`);
  }
  return boardFrom(base, body.token);
}

/**
 * Build board URLs from the base the user actually reached the server at,
 * not the server-reported PUBLIC_URL — a misconfigured PUBLIC_URL must not
 * strand the hook on a wrong origin.
 */
function boardFrom(base: string, token: string): Board {
  const dashboardUrl = `${base}/w/${token}`;
  return { token, dashboardUrl, webhookUrl: `${dashboardUrl}/webhook` };
}

/** Reachability probe for `agstatus status`. */
export async function probeSessions(
  hookBaseUrl: string
): Promise<{ ok: boolean; count?: number; detail: string }> {
  const base = hookBaseUrl.replace(/\/+$/, '').replace(/\/webhook$/, '');
  const isWorkspace = /\/w\/[^/]+$/.test(base);
  const url = isWorkspace ? `${base}/api/sessions` : `${base}/api/sessions`;
  try {
    const { status, body } = await fetchJson(url);
    if (status === 200 && Array.isArray(body)) {
      return { ok: true, count: (body as unknown[]).length, detail: 'reachable' };
    }
    if (status === 404 && isWorkspace) {
      return { ok: false, detail: 'server reachable, but this board no longer exists (deleted or expired)' };
    }
    return { ok: false, detail: `unexpected response (HTTP ${status})` };
  } catch {
    return { ok: false, detail: 'unreachable' };
  }
}
