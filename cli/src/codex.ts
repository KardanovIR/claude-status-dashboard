import fs from 'fs';
import os from 'os';
import path from 'path';
import { HOOK_MARKER, hookCommandFor } from './settings';

/**
 * OpenAI Codex integration. Codex discovers lifecycle hooks in
 * `$CODEX_HOME/hooks.json` (default ~/.codex) using a schema that mirrors
 * Claude Code's: events → [{matcher?, hooks: [{type:"command", command}]}],
 * and command hooks receive the event JSON on stdin with the same core
 * fields — so the same agstatus-hook.js serves both tools.
 *
 * Unlike Claude Code there is no settings `env` block to carry the board URL.
 * It used to ride along as a POSIX env-var prefix on the command string
 * (`CLAUDE_STATUS_URL="…" AGSTATUS_SOURCE=codex node "…"`); that is a shell
 * construct with no cmd.exe equivalent, so on Windows the registration would
 * be written, accepted, and then silently never fire. The configuration now
 * travels in a sidecar JSON file next to the hook script instead, and the
 * registered command is the same bare `node "<script>"` on every platform —
 * which is what lets a Linux test run exercise the Windows path.
 *
 * Codex requires the user to trust new hooks once via `/hooks` in the TUI, and
 * that trust is a hash of the command string: changing it invalidates every
 * existing trusted_hash, so upgraders must re-run /hooks once.
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

/**
 * The sidecar the hook reads instead of an env prefix. It sits next to the
 * script, not at a fixed path, because the hook resolves it from `__dirname`:
 * the Claude Code copy and the Codex copy are two files in two directories,
 * and only a per-copy file can tell them apart (which is what carries
 * `source: "codex"`).
 */
export function codexConfigPath(): string {
  return path.join(codexHome(), 'hooks', 'agstatus-hook.json');
}

/** What agstatus-hook.json holds — the env prefix's payload, as data. */
export interface CodexHookConfig {
  /** Board URL the hook posts to. The only required key. */
  url: string;
  /**
   * Tags these sessions as Codex ones so dashboards scope limit bars.
   * Deliberately not in ~/.agstatus.json: that file is shared by both agents.
   */
  source: 'codex';
  /** x-webhook-secret, legacy single-tenant servers only. */
  secret?: string;
  /** "off" = the `--minimal` privacy switch (tool names, never command text). */
  detail?: 'off';
}

/**
 * Build (and validate) the sidecar. Callers must do this before touching
 * anything on disk, so a URL this refuses aborts with Codex untouched.
 *
 * Server-issued tokens are already validated to a shell-safe charset upstream
 * (see api.ts). The command string no longer meets a shell, but the guard
 * stays here as defense in depth: this URL is what `listener install` later
 * reads back and what the hook puts in a fetch(), and the listener's
 * BOARD_URL_RE (listener/config.ts) refuses the same characters — keeping the
 * two in step is what lets the listener trust what init wrote.
 */
export function codexHookConfig(url: string, minimal: boolean, secret?: string): CodexHookConfig {
  if (/["`$\\\n\r]/.test(url)) {
    throw new Error(
      `Refusing to write a URL with shell metacharacters to agstatus-hook.json: ${url}`
    );
  }
  const cfg: CodexHookConfig = { url, source: 'codex' };
  if (secret) cfg.secret = secret;
  if (minimal) cfg.detail = 'off';
  return cfg;
}

/**
 * Write the sidecar: 0600 (it can carry a webhook secret, and the board URL is
 * itself a capability token), temp + rename so a hook firing mid-write never
 * reads a half-file. chmod explicitly — writeFileSync's mode is masked by the
 * umask, and 0600 must not degrade to 0644 on a permissive one.
 */
export function writeCodexHookConfig(file: string, cfg: CodexHookConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.agstatus-hook.json.agstatus-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Read the sidecar back. Missing, malformed or urlless → null, never a throw:
 * every caller has a fallback, and a file we wrote ourselves being unreadable
 * must not take `listener install` or `status` down with it.
 */
export function readCodexHookConfig(file: string = codexConfigPath()): CodexHookConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
  if (!url) return null;
  const cfg: CodexHookConfig = { url, source: 'codex' };
  const secret = typeof parsed.secret === 'string' ? parsed.secret.trim() : '';
  if (secret) cfg.secret = secret;
  if (parsed.detail === 'off') cfg.detail = 'off';
  return cfg;
}

/**
 * The command registered in hooks.json: the interpreter and the script, and
 * nothing else — everything configurable lives in codexConfigPath() beside it.
 *
 * Same builder as the Claude Code side, so both registrations get `$HOME` on
 * POSIX (portable across synced dotfiles) and a baked absolute path with
 * forward slashes on Windows, where no shell would expand `$HOME`.
 */
export function codexHookCommand(): string {
  return hookCommandFor(codexHookInstallPath(), os.homedir(), process.platform);
}

/** Every command string in a parsed hooks.json that is one of ours. */
function ourCommands(input: HooksFile): string[] {
  if (!isPlainObject(input.hooks)) return [];
  const out: string[] = [];
  for (const entries of Object.values(input.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as HookEntry[]) {
      if (!Array.isArray(entry?.hooks)) continue;
      for (const h of entry.hooks) {
        if (typeof h?.command === 'string' && h.command.includes(HOOK_MARKER)) out.push(h.command);
      }
    }
  }
  return out;
}

/** True when a parsed hooks.json currently holds our registrations. */
export function codexHasOurHooks(input: HooksFile): boolean {
  return ourCommands(input).length > 0;
}

/**
 * Any assignment from the env prefix a pre-sidecar registration carried
 * (`CLAUDE_STATUS_URL="…" AGSTATUS_SOURCE=codex … node "<script>"`). Matching
 * on the names we ourselves used, not on "looks like an assignment", so a
 * command a user hand-edited for their own reasons is not called legacy.
 */
const LEGACY_ENV_PREFIX_RE =
  /(?:^|\s)(?:CLAUDE_STATUS_URL|CLAUDE_STATUS_SECRET|AGSTATUS_SOURCE|AGSTATUS_DETAIL)=/;

/**
 * True when a parsed hooks.json still registers us the pre-sidecar way. That
 * form runs fine on POSIX — nothing else in `agstatus status` would ever hint
 * at it — but cmd.exe cannot parse the line at all, and the current hook reads
 * its configuration from agstatus-hook.json, not from the environment.
 *
 * Deliberately asked of the registration rather than inferred from the
 * sidecar's absence: the two coexist. setupCodex() writes the sidecar before
 * it rewrites hooks.json (cli/src/index.ts), so a rewrite that throws —
 * EACCES, a read-only ~/.codex, a full disk — leaves a sidecar next to a
 * legacy registration, which is exactly the broken state this warns about.
 */
export function codexLegacyRegistration(input: HooksFile): boolean {
  return ourCommands(input).some((command) => LEGACY_ENV_PREFIX_RE.test(command));
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

/**
 * The two quoted forms the old env prefix used for values worth protecting:
 * the board URL (a capability token — whoever holds it can read and write the
 * board) and the webhook secret. Same shapes listener/config.ts still parses
 * back, so the pair stays in step.
 */
const LEGACY_CREDENTIAL_RE = /CLAUDE_STATUS_URL="[^"]*"|CLAUDE_STATUS_SECRET='(?:[^']|'\\'')*'/g;
const REDACTED = '"<redacted by agstatus>"';

/**
 * A hooks.json with the credentials stripped out of *our* command strings.
 *
 * Exported for the test that pins it, and pure so it can be: the walk is the
 * same one isOurs() drives everywhere else in this file.
 */
export function redactCodexCredentials(input: HooksFile): HooksFile {
  const out = structuredClone(input);
  if (!isPlainObject(out.hooks)) return out;
  for (const entries of Object.values(out.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as HookEntry[]) {
      if (!isOurs(entry)) continue;
      for (const h of entry.hooks ?? []) {
        if (typeof h.command !== 'string') continue;
        h.command = h.command.replace(
          LEGACY_CREDENTIAL_RE,
          (m) => `${m.slice(0, m.indexOf('='))}=${REDACTED}`
        );
      }
    }
  }
  return out;
}

/**
 * Write the rolling backup — redacted, and 0600.
 *
 * The whole point of the sidecar is that the board URL and the secret live in
 * one file nobody else on the machine can read. But the file an upgrade backs
 * up is the OLD hooks.json: the one still carrying
 * `CLAUDE_STATUS_URL="…" … CLAUDE_STATUS_SECRET='…'` on every registered
 * command. Nothing ever deletes a backup, so a verbatim copy (which inherits
 * hooks.json's usually-0644 mode) would quietly outlive the file we just
 * cleaned and hand the token to every other account anyway.
 *
 * Only our own entries lose their values: those are precisely the ones this
 * write replaces, and agstatus-hook.json holds them now, so nobody restores a
 * backup to get them back. Every foreign entry — the reason to keep a backup
 * at all — survives byte for byte, and the placeholder keeps the restored file
 * valid JSON and obvious about what happened to it.
 */
function writeCodexHooksBackup(backup: string, source: string): void {
  const raw = fs.readFileSync(source, 'utf8');
  let text = raw;
  try {
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
    if (isPlainObject(parsed)) text = JSON.stringify(redactCodexCredentials(parsed), null, 2) + '\n';
  } catch {
    // Not JSON we can rewrite — keep the bytes verbatim rather than lose the
    // user's file. 0600 still applies: what we cannot parse may still hold a
    // token. (Today unreachable: callers read the file first and abort on a
    // parse error. It stays because the backup must never be the weak link.)
  }
  fs.writeFileSync(backup, text, { mode: 0o600 });
  // writeFileSync's mode is masked by the umask, and ignored outright when the
  // backup already exists — a previous 0644 copy must not survive an upgrade.
  fs.chmodSync(backup, 0o600);
}

/** Atomic write with a single rolling backup (mirrors settings.json handling). */
export function writeCodexHooksWithBackup(file: string, hooks: HooksFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let target = file;
  let mode = 0o644;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
    writeCodexHooksBackup(`${file}.agstatus-backup`, target);
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
