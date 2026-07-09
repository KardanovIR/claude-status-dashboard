import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode-terminal';
import {
  claimCode,
  createWorkspace,
  getConfig,
  probeSessions,
  resolveBaseUrl,
} from './api';
import {
  hookCommand,
  hookInstallPath,
  mergeSettings,
  readSettings,
  removeAgstatus,
  settingsPath,
  writeSettingsWithBackup,
} from './settings';
import {
  codexDetected,
  codexHasOurHooks,
  codexHookCommand,
  codexHookInstallPath,
  codexHooksPath,
  mergeCodexHooks,
  readCodexHooks,
  removeCodexHooks,
  writeCodexHooksWithBackup,
} from './codex';

export interface InitOptions {
  url?: string;
  code?: string;
  secret?: string;
  minimal?: boolean;
  /** true = force Codex setup, false = skip it, undefined = auto-detect. */
  codex?: boolean;
  /** Suppress the QR code (tests / narrow terminals). */
  noQr?: boolean;
  log?: (line: string) => void;
}

const BUNDLED_HOOK = path.join(__dirname, '..', 'assets', 'agstatus-hook.js');

function installHookFile(dest: string = hookInstallPath()): string {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(BUNDLED_HOOK, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

/**
 * Codex setup: same hook script, registered via $CODEX_HOME/hooks.json.
 * Reads (and validates) hooks.json before writing anything, so a malformed
 * file throws here with nothing on the Codex side changed — the caller treats
 * that as a warning and still completes Claude Code setup.
 */
function setupCodex(
  hookUrl: string,
  minimal: boolean | undefined,
  secret: string | undefined,
  log: (l: string) => void
): void {
  const file = codexHooksPath();
  const hooks = readCodexHooks(file); // throws (aborting) on malformed JSON
  const merged = mergeCodexHooks(hooks, codexHookCommand(hookUrl, minimal === true, secret));
  installHookFile(codexHookInstallPath());
  writeCodexHooksWithBackup(file, merged);
  log('');
  log('✔ Codex is set up too.');
  log(`  Hooks:     ${file}`);
  log('  ⚠ One-time step: run /hooks inside Codex to trust the AgStatus hook.');
}

function renderQr(url: string, log: (line: string) => void): void {
  qrcode.generate(url, { small: true }, (qr) => {
    for (const line of qr.split('\n')) log(`  ${line}`);
  });
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const base = resolveBaseUrl(opts.url);

  log(`Connecting to ${base} ...`);
  const cfg = await getConfig(base);
  if (!cfg) {
    throw new Error(
      `Could not reach ${base} — check the URL (pass --url <your-server> for a self-hosted instance).`
    );
  }

  // Acquire a board and decide what URL the hook should target.
  let hookUrl: string;
  let dashboardUrl: string;
  if (opts.code) {
    const board = await claimCode(base, opts.code);
    hookUrl = board.dashboardUrl;
    dashboardUrl = board.dashboardUrl;
    log('Paired with your existing board.');
  } else if (cfg.mode === 'multi') {
    const board = await createWorkspace(base);
    hookUrl = board.dashboardUrl;
    dashboardUrl = board.dashboardUrl;
    log('Created a new private board.');
  } else {
    hookUrl = base;
    dashboardUrl = base;
    if (cfg.requiresSecret && !opts.secret) {
      log('⚠ This server requires a webhook secret; pass --secret <value> or updates will be rejected.');
    }
  }

  const hookFile = installHookFile();

  const file = settingsPath();
  const settings = readSettings(file);
  const merged = mergeSettings(settings, {
    url: hookUrl,
    secret: opts.secret,
    minimal: opts.minimal,
    hookCommand: hookCommand(),
  });
  writeSettingsWithBackup(file, merged);

  log('');
  log('✔ AgStatus is set up for Claude Code.');
  log(`  Hook:      ${hookFile}`);
  log(`  Settings:  ${file} (backup written alongside)`);
  log(`  Dashboard: ${dashboardUrl}`);

  // Codex is a bonus target: never let a broken ~/.codex/hooks.json abort the
  // Claude Code setup that already succeeded above — degrade to a warning.
  if (opts.codex ?? codexDetected()) {
    try {
      setupCodex(hookUrl, opts.minimal, opts.secret, log);
    } catch (err) {
      log('');
      log(`⚠ Skipped Codex setup: ${(err as Error).message}`);
    }
  }
  log('');
  if (!opts.noQr) {
    log('Scan to open your board on your phone:');
    renderQr(dashboardUrl, log);
    log('');
  }
  if (!opts.minimal) {
    log('ℹ Status messages include truncated command text.');
    log('  Re-run with --minimal to send tool names only.');
  }
  log('Start a Claude Code session and watch it appear.');
}

export async function runUninstall(log: (line: string) => void = console.log): Promise<void> {
  const file = settingsPath();
  const settings = readSettings(file);
  const { settings: cleaned, removed } = removeAgstatus(settings);

  if (removed.length > 0) {
    writeSettingsWithBackup(file, cleaned);
    log(`✔ Removed from ${file}: ${removed.join(', ')}`);
  } else {
    log(`Nothing to remove in ${file}.`);
  }

  const hookFile = hookInstallPath();
  if (fs.existsSync(hookFile)) {
    fs.unlinkSync(hookFile);
    log(`✔ Deleted ${hookFile}`);
  }

  // Codex side (no-op unless something of ours is there). Only delete the hook
  // script once the registrations are gone: if cleanup is skipped (malformed
  // hooks.json), leaving the script keeps the still-registered hook working.
  const codexFile = codexHooksPath();
  let codexCleanupOk = false;
  try {
    const hooks = readCodexHooks(codexFile);
    const { hooks: cleaned, removed } = removeCodexHooks(hooks);
    if (removed.length > 0) {
      writeCodexHooksWithBackup(codexFile, cleaned);
      log(`✔ Removed from ${codexFile}: ${removed.join(', ')}`);
    }
    codexCleanupOk = true;
  } catch (err) {
    log(`⚠ Skipped Codex cleanup: ${(err as Error).message}`);
    log(`  Left ${codexHookInstallPath()} in place (still referenced by hooks.json).`);
  }
  if (codexCleanupOk) {
    const codexHook = codexHookInstallPath();
    if (fs.existsSync(codexHook)) {
      fs.unlinkSync(codexHook);
      log(`✔ Deleted ${codexHook}`);
    }
  }

  log('AgStatus hooks are uninstalled. Backups kept alongside the edited files.');
}

export async function runStatus(log: (line: string) => void = console.log): Promise<void> {
  const file = settingsPath();
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(file);
  } catch (err) {
    log(`✖ ${(err as Error).message}`);
    return;
  }
  const env = (settings.env ?? {}) as Record<string, unknown>;
  const url = typeof env.CLAUDE_STATUS_URL === 'string' ? env.CLAUDE_STATUS_URL : null;
  const hookFile = hookInstallPath();

  log(`Settings:  ${file}`);
  log(`Hook file: ${fs.existsSync(hookFile) ? hookFile : 'NOT INSTALLED'}`);
  if (codexDetected()) {
    const codexConfigured =
      fs.existsSync(codexHookInstallPath()) && codexHasOurHooks(safeReadCodexHooks());
    log(`Codex:     ${codexConfigured ? `configured (${codexHooksPath()})` : 'detected, not configured'}`);
  }
  if (!url) {
    log('URL:       not configured — run `npx agstatus init`');
    return;
  }
  log(`URL:       ${url}`);
  const probe = await probeSessions(url);
  if (probe.ok) {
    log(`Server:    ✔ ${probe.detail} (${probe.count} active session${probe.count === 1 ? '' : 's'})`);
  } else {
    log(`Server:    ✖ ${probe.detail}`);
  }
}

function safeReadCodexHooks(): Record<string, unknown> {
  try {
    return readCodexHooks(codexHooksPath());
  } catch {
    return {};
  }
}

const USAGE = `agstatus — live status board for your coding agents (Claude Code & Codex)

Usage:
  npx agstatus init [options]   Set up hooks + a status board
  npx agstatus status           Show current setup and server reachability
  npx agstatus uninstall        Remove hooks and env entries
  npx agstatus help             This help

init options:
  --url <base>      Server to use (default: ${resolveBaseUrl()})
  --code XXXX-XXXX  Pair with a board created elsewhere (e.g. the mobile app)
  --secret <s>      Webhook secret for self-hosted single-tenant servers
  --minimal         Send tool names only, never command text
  --codex           Also set up OpenAI Codex even if ~/.codex isn't detected
  --no-codex        Skip Codex setup (default: auto-configure when detected)
  --no-qr           Skip the QR code
`;

const VALUE_FLAGS = new Set(['url', 'code', 'secret']);
const BOOL_FLAGS = new Set(['minimal', 'no-qr', 'help', 'codex', 'no-codex']);

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) {
      console.error(`✖ Unexpected argument: ${a}\n`);
      console.log(USAGE);
      return 1;
    }
    const name = a.slice(2);
    const eq = name.indexOf('=');
    if (eq !== -1) {
      const key = name.slice(0, eq);
      if (!VALUE_FLAGS.has(key)) {
        console.error(`✖ Unknown option: --${key}\n`);
        console.log(USAGE);
        return 1;
      }
      flags.set(key, name.slice(eq + 1));
      continue;
    }
    if (BOOL_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        console.error(`✖ Missing value for --${name}\n`);
        console.log(USAGE);
        return 1;
      }
      flags.set(name, next);
      i++;
      continue;
    }
    console.error(`✖ Unknown option: --${name}\n`);
    console.log(USAGE);
    return 1;
  }

  try {
    switch (cmd) {
      case 'init':
        await runInit({
          url: typeof flags.get('url') === 'string' ? (flags.get('url') as string) : undefined,
          code: typeof flags.get('code') === 'string' ? (flags.get('code') as string) : undefined,
          secret: typeof flags.get('secret') === 'string' ? (flags.get('secret') as string) : undefined,
          minimal: flags.get('minimal') === true,
          codex: flags.get('codex') === true ? true : flags.get('no-codex') === true ? false : undefined,
          noQr: flags.get('no-qr') === true,
        });
        return 0;
      case 'uninstall':
        await runUninstall();
        return 0;
      case 'status':
        await runStatus();
        return 0;
      case undefined:
      case 'help':
      case '--help':
        console.log(USAGE);
        return cmd === undefined ? 1 : 0;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(USAGE);
        return 1;
    }
  } catch (err) {
    console.error(`✖ ${(err as Error).message}`);
    return 1;
  }
}
