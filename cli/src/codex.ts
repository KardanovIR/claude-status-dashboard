import fs from 'fs';
import os from 'os';
import path from 'path';
import { HOOK_MARKER } from './settings';

/**
 * OpenAI Codex integration. Codex discovers lifecycle hooks in
 * `$CODEX_HOME/hooks.json` (default ~/.codex) using a schema that mirrors
 * Claude Code's: events → [{matcher?, hooks: [{type:"command", command}]}],
 * and command hooks receive the event JSON on stdin with the same core
 * fields — so the same agstatus-hook.js serves both tools.
 *
 * Unlike Claude Code there is no settings `env` block: the board URL is
 * embedded as an env prefix in the (shell-interpreted) command string.
 * Codex requires the user to trust new hooks once via `/hooks` in the TUI.
 */

export const CODEX_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: 'SessionStart' },
  { event: 'PreToolUse', matcher: '^(Bash|apply_patch|Edit|Write)$' },
  { event: 'PermissionRequest' },
  { event: 'Stop' },
];

/** Keep hooks snappy: our script self-exits at ~4s; Codex's default is 600s. */
const HOOK_TIMEOUT_SECONDS = 10;

type HooksFile = Record<string, unknown>;

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const shapeName = (v: unknown): string => (Array.isArray(v) ? 'an array' : `a ${typeof v}`);

/** Codex config directory (respects CODEX_HOME). */
export function codexHome(): string {
  const override = process.env.CODEX_HOME;
  if (override && override.trim() !== '') return override;
  return path.join(os.homedir(), '.codex');
}

/** Codex is "installed" when its home directory exists. */
export function codexDetected(): boolean {
  try {
    return fs.statSync(codexHome()).isDirectory();
  } catch {
    return false;
  }
}

export function codexHooksPath(): string {
  return path.join(codexHome(), 'hooks.json');
}

export function codexHookInstallPath(): string {
  return path.join(codexHome(), 'hooks', 'agstatus-hook.js');
}

/** Wrap a value in single quotes for POSIX sh, escaping any embedded quote. */
const shSingleQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell command registered in hooks.json. Codex command hooks run
 * through a shell (official examples use $(...)), so an env-var prefix
 * carries the board URL and (for legacy servers) the webhook secret;
 * $HOME keeps synced dotfiles portable.
 *
 * Server-issued tokens are already validated to a shell-safe charset upstream
 * (see api.ts), but this is the point where untrusted input meets a shell, so
 * we reject any URL bearing characters that could break out of the double
 * quotes as defense in depth; the secret is user-supplied and single-quoted.
 */
export function codexHookCommand(url: string, minimal: boolean, secret?: string): string {
  if (/["`$\\\n\r]/.test(url)) {
    throw new Error(`Refusing to embed a URL with shell metacharacters in hooks.json: ${url}`);
  }
  const dest = codexHookInstallPath();
  const home = os.homedir();
  const script = dest.startsWith(home + path.sep)
    ? `$HOME${dest.slice(home.length)}`
    : dest;
  const parts = [`CLAUDE_STATUS_URL="${url}"`];
  if (secret) parts.push(`CLAUDE_STATUS_SECRET=${shSingleQuote(secret)}`);
  if (minimal) parts.push('AGSTATUS_DETAIL=off');
  return `${parts.join(' ')} node "${script}"`;
}

/** True when a parsed hooks.json currently holds our registrations. */
export function codexHasOurHooks(input: HooksFile): boolean {
  if (!isPlainObject(input.hooks)) return false;
  return Object.values(input.hooks).some(
    (entries) => Array.isArray(entries) && entries.some((e) => isOurs(e as HookEntry))
  );
}

/**
 * Read and parse hooks.json. Missing file → {}. Invalid JSON or a non-object
 * root → throws; callers abort without writing anything.
 */
export function readCodexHooks(file: string): HooksFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) throw new Error('not a JSON object');
    return parsed;
  } catch (err) {
    throw new Error(
      `${file} exists but is not valid JSON (${(err as Error).message}). ` +
        'Fix or remove it, then re-run — nothing was changed.'
    );
  }
}

/** Atomic write with a single rolling backup (mirrors settings.json handling). */
export function writeCodexHooksWithBackup(file: string, hooks: HooksFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let target = file;
  let mode = 0o644;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
    fs.copyFileSync(target, `${file}.agstatus-backup`);
  }
  const tmp = path.join(path.dirname(target), `.hooks.json.agstatus-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(hooks, null, 2) + '\n', { mode });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const isOurs = (entry: HookEntry): boolean =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER));

/**
 * Pure merge: registers our events under the top-level "hooks" key,
 * replacing previous agstatus entries and preserving everything else.
 */
export function mergeCodexHooks(input: HooksFile, command: string): HooksFile {
  if (input.hooks !== undefined && !isPlainObject(input.hooks)) {
    throw new Error(
      `hooks.json has "hooks" of unexpected shape (${shapeName(input.hooks)}; expected an ` +
        'object mapping event names to arrays). Fix the file and re-run — nothing was changed.'
    );
  }
  for (const { event } of CODEX_EVENTS) {
    const v = (input.hooks as Record<string, unknown> | undefined)?.[event];
    if (v !== undefined && !Array.isArray(v)) {
      throw new Error(
        `hooks.json has "hooks.${event}" of unexpected shape (${shapeName(v)}; expected an ` +
          'array). Fix the file and re-run — nothing was changed.'
      );
    }
  }

  const out = structuredClone(input);
  const hooks = (out.hooks ?? {}) as Record<string, unknown>;
  for (const { event, matcher } of CODEX_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : [];
    const kept = existing.filter((e) => !isOurs(e));
    const entry: HookEntry & { hooks: Array<Record<string, unknown>> } = {
      ...(matcher ? { matcher } : {}),
      hooks: [
        {
          type: 'command',
          command,
          timeout: HOOK_TIMEOUT_SECONDS,
          statusMessage: 'Reporting status to AgStatus',
        },
      ],
    };
    hooks[event] = [...kept, entry];
  }
  out.hooks = hooks;
  return out;
}

/** Pure removal of our entries; prunes empty containers it leaves behind. */
export function removeCodexHooks(input: HooksFile): { hooks: HooksFile; removed: string[] } {
  const out = structuredClone(input);
  const removed: string[] = [];

  if (isPlainObject(out.hooks)) {
    const hooks = out.hooks as Record<string, unknown>;
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      const entries = hooks[event] as HookEntry[];
      const kept = entries.filter((e) => !isOurs(e));
      if (kept.length !== entries.length) removed.push(`hooks.${event}`);
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0) delete out.hooks;
  }

  return { hooks: out, removed };
}
