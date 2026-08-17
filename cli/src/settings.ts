import fs from 'fs';
import os from 'os';
import path from 'path';

/** Marker every hook command we install carries; used to find our entries. */
export const HOOK_MARKER = 'agstatus-hook';

export const HOOK_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Task|WebSearch|WebFetch' },
  { event: 'Stop' },
  { event: 'Notification' },
  { event: 'SessionEnd' },
];

export interface MergeOptions {
  /** Base URL the hook posts to (workspace URL in multi mode, server root in legacy). */
  url: string;
  /** X-Webhook-Secret for legacy servers. Omitted = removed from settings. */
  secret?: string;
  /** true = send tool names only (AGSTATUS_DETAIL=off). false/omitted = remove the key. */
  minimal?: boolean;
  /** Shell command registered for every hook event. */
  hookCommand: string;
}

type Settings = Record<string, unknown>;

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const shapeName = (v: unknown): string => (Array.isArray(v) ? 'an array' : `a ${typeof v}`);

/** Claude Code config directory (respects CLAUDE_CONFIG_DIR). */
export function configDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim() !== '') return override;
  return path.join(os.homedir(), '.claude');
}

export function settingsPath(): string {
  return path.join(configDir(), 'settings.json');
}

export function hookInstallPath(): string {
  return path.join(configDir(), 'hooks', 'agstatus-hook.js');
}

/**
 * The command string written into settings.json. Uses $HOME so synced dotfiles
 * stay portable; falls back to the literal path when the config dir lives
 * outside the home directory (e.g. CLAUDE_CONFIG_DIR pointing at a temp dir).
 */
export function hookCommand(): string {
  const dest = hookInstallPath();
  const home = os.homedir();
  if (dest.startsWith(home + path.sep)) {
    return `node "$HOME${dest.slice(home.length)}"`;
  }
  return `node "${dest}"`;
}

/**
 * Read and parse settings.json.
 * - Missing file → {} (fresh start).
 * - Present but invalid JSON → throws with a clear message; callers must abort
 *   without writing anything.
 */
export function readSettings(file: string): Settings {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip UTF-8 BOM
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Settings;
  } catch (err) {
    throw new Error(
      `${file} exists but is not valid JSON (${(err as Error).message}). ` +
        'Fix or remove it, then re-run — nothing was changed.'
    );
  }
}

/**
 * Write settings.json atomically (temp file + rename), backing up the existing
 * file first (single rolling backup). A crash mid-write must never leave a
 * truncated settings.json — that would break Claude Code entirely.
 */
export function writeSettingsWithBackup(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let target = file;
  let mode = 0o644;
  if (fs.existsSync(file)) {
    // Follow a symlinked settings.json so we update the real file in place.
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
    fs.copyFileSync(target, `${file}.agstatus-backup`);
  }
  const tmp = path.join(path.dirname(target), `.settings.json.agstatus-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode });
    fs.renameSync(tmp, target); // atomic within the same directory
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const isOurs = (entry: HookEntry): boolean =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER));

/**
 * Pure merge: registers our five hook events and env vars, replacing any
 * previous agstatus entries and leaving everything else untouched.
 */
export function mergeSettings(input: Settings, opts: MergeOptions): Settings {
  if (input.hooks !== undefined && !isPlainObject(input.hooks)) {
    throw new Error(
      `settings.json has "hooks" of unexpected shape (${shapeName(input.hooks)}; expected an ` +
        'object mapping event names to arrays). Fix the file and re-run — nothing was changed.'
    );
  }
  if (input.env !== undefined && !isPlainObject(input.env)) {
    throw new Error(
      `settings.json has "env" of unexpected shape (${shapeName(input.env)}; expected an object). ` +
        'Fix the file and re-run — nothing was changed.'
    );
  }
  for (const { event } of HOOK_EVENTS) {
    const v = (input.hooks as Record<string, unknown> | undefined)?.[event];
    if (v !== undefined && !Array.isArray(v)) {
      throw new Error(
        `settings.json has "hooks.${event}" of unexpected shape (${shapeName(v)}; expected an ` +
          'array). Fix the file and re-run — nothing was changed.'
      );
    }
  }

  const settings = structuredClone(input);

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const { event, matcher } of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : [];
    const kept = existing.filter((e) => !isOurs(e));
    const entry: HookEntry = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: opts.hookCommand }],
    };
    hooks[event] = [...kept, entry];
  }
  settings.hooks = hooks;

  const env = (settings.env ?? {}) as Record<string, unknown>;
  env.CLAUDE_STATUS_URL = opts.url;
  if (opts.secret) env.CLAUDE_STATUS_SECRET = opts.secret;
  else delete env.CLAUDE_STATUS_SECRET;
  if (opts.minimal) env.AGSTATUS_DETAIL = 'off';
  else delete env.AGSTATUS_DETAIL;
  settings.env = env;

  return settings;
}

/**
 * Pure removal: strips our hook entries and env vars. Empty arrays/objects we
 * leave behind are pruned so an uninstall on a fresh config restores `{}`.
 */
export function removeAgstatus(input: Settings): { settings: Settings; removed: string[] } {
  const settings = structuredClone(input);
  const removed: string[] = [];

  if (settings.hooks && typeof settings.hooks === 'object') {
    const hooks = settings.hooks as Record<string, unknown>;
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      const entries = hooks[event] as HookEntry[];
      const kept = entries.filter((e) => !isOurs(e));
      if (kept.length !== entries.length) removed.push(`hooks.${event}`);
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  if (settings.env && typeof settings.env === 'object') {
    const env = settings.env as Record<string, unknown>;
    for (const key of ['CLAUDE_STATUS_URL', 'CLAUDE_STATUS_SECRET', 'AGSTATUS_DETAIL']) {
      if (key in env) {
        delete env[key];
        removed.push(`env.${key}`);
      }
    }
    if (Object.keys(env).length === 0) delete settings.env;
  }

  return { settings, removed };
}
