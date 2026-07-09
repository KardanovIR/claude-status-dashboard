export interface AppConfig {
  multiTenant: boolean;
  webhookSecret: string;
  publicUrl: string;
  sessionTtlMs: number;
  dbPath: string;
  trustProxy: boolean;
  rateLimit: boolean;
  maxWorkspaces: number;
  version: string;
}

const DEFAULT_MULTI_TENANT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_WORKSPACES = 10_000;

function pkgVersion(): string {
  try {
    // Resolved relative to the compiled file (dist/) or src/ under tsx — both
    // sit one level below the repo root.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Only '1' and 'true' enable a boolean env flag; everything else disables it. */
const boolFromEnv = (v: string | undefined): boolean => v === '1' || v === 'true';

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT || 3000);
  const multiTenant = boolFromEnv(env.MULTI_TENANT);

  let sessionTtlMs = multiTenant ? DEFAULT_MULTI_TENANT_TTL_MS : 0;
  const ttlRaw = env.SESSION_TTL_MS;
  if (ttlRaw !== undefined && ttlRaw.trim() !== '') {
    const n = Number(ttlRaw);
    if (Number.isFinite(n) && n >= 0) {
      sessionTtlMs = n;
    } else {
      console.warn(`Ignoring invalid SESSION_TTL_MS=${JSON.stringify(ttlRaw)}; using ${sessionTtlMs}ms`);
    }
  }

  let maxWorkspaces = DEFAULT_MAX_WORKSPACES;
  const maxWsRaw = env.MAX_WORKSPACES;
  if (maxWsRaw !== undefined && maxWsRaw.trim() !== '') {
    const n = Number(maxWsRaw);
    if (Number.isFinite(n) && n > 0) {
      maxWorkspaces = n;
    } else {
      console.warn(`Ignoring invalid MAX_WORKSPACES=${JSON.stringify(maxWsRaw)}; using ${maxWorkspaces}`);
    }
  }

  return {
    multiTenant,
    webhookSecret: env.WEBHOOK_SECRET || '',
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    sessionTtlMs,
    dbPath: env.DB_PATH || '',
    trustProxy: boolFromEnv(env.TRUST_PROXY),
    rateLimit: true,
    maxWorkspaces,
    version: pkgVersion(),
  };
}
