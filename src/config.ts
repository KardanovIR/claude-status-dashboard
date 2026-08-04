import fs from 'fs';
import crypto from 'crypto';

export interface AppConfig {
  multiTenant: boolean;
  webhookSecret: string;
  publicUrl: string;
  sessionTtlMs: number;
  /** PostgreSQL connection string; empty = in-memory only (no persistence). */
  databaseUrl: string;
  trustProxy: boolean;
  rateLimit: boolean;
  maxWorkspaces: number;
  version: string;
  /** APNs push credentials; null = push disabled (everything else still works). */
  apns: {
    keyPem: string; // .p8 key content (PEM)
    keyId: string; // APNS_KEY_ID
    teamId: string; // APNS_TEAM_ID
    topic: string; // APNS_TOPIC (app bundle id)
    server: string; // preferred endpoint (https://api[.sandbox].push.apple.com)
    /**
     * The other Apple endpoint. A device token is only valid against the
     * environment its build was signed for, and nothing in the token says
     * which — so a token rejected as BadDeviceToken is retried here before it
     * is written off. Null when APNS_SERVER pins one endpoint explicitly.
     */
    altServer: string | null;
  } | null;
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

/**
 * Parses the APNs env block. Fully unset → null (push quietly disabled).
 * Partially set or key unreadable/invalid → warn once and return null; a bad
 * push config must never take the rest of the server down.
 */
function apnsFromEnv(env: NodeJS.ProcessEnv): AppConfig['apns'] {
  const anySet = Boolean(
    env.APNS_KEY || env.APNS_KEY_PATH || env.APNS_KEY_ID || env.APNS_TEAM_ID ||
    env.APNS_TOPIC || env.APNS_SERVER || env.APNS_ENV
  );
  if (!anySet) return null;

  let keyPem = env.APNS_KEY || '';
  if (!keyPem && env.APNS_KEY_PATH) {
    try {
      keyPem = fs.readFileSync(env.APNS_KEY_PATH, 'utf8');
    } catch (err) {
      console.warn(
        `Push disabled: cannot read APNS_KEY_PATH=${JSON.stringify(env.APNS_KEY_PATH)} ` +
        `(${err instanceof Error ? err.message : String(err)})`
      );
      return null;
    }
  }

  const keyId = env.APNS_KEY_ID || '';
  const teamId = env.APNS_TEAM_ID || '';
  const topic = env.APNS_TOPIC || '';
  if (!keyPem || !keyId || !teamId || !topic) {
    console.warn(
      'Push disabled: incomplete APNs config ' +
      '(need APNS_KEY or APNS_KEY_PATH, plus APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC)'
    );
    return null;
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch {
    console.warn('Push disabled: APNS_KEY is not a valid PEM private key');
    return null;
  }
  // ES256 means exactly EC P-256: any other key type would sign a bogus
  // "ES256" JWT and every push would 403 with only a cryptic batch log.
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    console.warn('Push disabled: APNS_KEY must be an EC P-256 (.p8) APNs auth key');
    return null;
  }

  const PRODUCTION = 'https://api.push.apple.com';
  const SANDBOX = 'https://api.sandbox.push.apple.com';

  // An explicit APNS_SERVER means "use exactly this" (a mock in tests, or a
  // proxy) — guessing a second endpoint there would be wrong.
  if (env.APNS_SERVER) {
    return { keyPem, keyId, teamId, topic, server: env.APNS_SERVER.replace(/\/$/, ''), altServer: null };
  }
  // APNS_ENV only picks which endpoint is tried FIRST; both are reachable, so
  // a mixed fleet of development and App Store builds all receive pushes.
  const production = env.APNS_ENV === 'production';
  return {
    keyPem,
    keyId,
    teamId,
    topic,
    server: production ? PRODUCTION : SANDBOX,
    altServer: production ? SANDBOX : PRODUCTION,
  };
}

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

  if (env.DB_PATH) {
    console.warn(
      'DB_PATH (SQLite) is no longer supported and was ignored — set DATABASE_URL to a ' +
      'PostgreSQL connection string instead (see docs/self-hosting.md for migration).'
    );
  }

  return {
    multiTenant,
    webhookSecret: env.WEBHOOK_SECRET || '',
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    sessionTtlMs,
    databaseUrl: env.DATABASE_URL || '',
    trustProxy: boolFromEnv(env.TRUST_PROXY),
    rateLimit: true,
    maxWorkspaces,
    version: pkgVersion(),
    apns: apnsFromEnv(env),
  };
}
