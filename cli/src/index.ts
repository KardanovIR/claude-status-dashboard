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
import { resolveBoardUrl, resolveListenerConfig } from './listener/config';
import {
  doctor as listenerDoctor,
  install as listenerInstall,
  listenerInstalled,
  status as listenerStatus,
  uninstall as listenerUninstall,
  type ListenerCommandOptions,
} from './listener/install';
import { runResumeExec } from './listener/resume';
import { runFocus } from './focus';
import { runKeys } from './keys';
import type { ListenerConfig } from './listener/types';
import {
  codexConfigPath,
  codexDetected,
  codexHasOurHooks,
  codexHookCommand,
  codexHookConfig,
  codexHookInstallPath,
  codexHooksPath,
  codexLegacyRegistration,
  mergeCodexHooks,
  readCodexHooks,
  removeCodexHooks,
  writeCodexHookConfig,
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
  /** Force a fresh board even when this machine already has one (`--new-board`). */
  newBoard?: boolean;
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
 * Codex setup: same hook script, registered via $CODEX_HOME/hooks.json, with
 * its configuration in a sidecar agstatus-hook.json beside the script (an env
 * prefix on the command string would not run on Windows — see codex.ts).
 *
 * Everything that can refuse the inputs runs before the first write: the
 * sidecar is built (and its URL validated) first, then hooks.json is read and
 * validated. A bad URL or a malformed hooks.json therefore throws here with
 * nothing on the Codex side changed — the caller treats that as a warning and
 * still completes Claude Code setup.
 */
function setupCodex(
  hookUrl: string,
  minimal: boolean | undefined,
  secret: string | undefined,
  log: (l: string) => void
): void {
  const config = codexHookConfig(hookUrl, minimal === true, secret); // throws on a hostile URL
  const file = codexHooksPath();
  const configFile = codexConfigPath();
  const hooks = readCodexHooks(file); // throws (aborting) on malformed JSON
  const merged = mergeCodexHooks(hooks, codexHookCommand());
  installHookFile(codexHookInstallPath());
  // Config before registration: between these two writes the hook is on disk
  // but unregistered, so nothing can fire against a missing config.
  writeCodexHookConfig(configFile, config);
  writeCodexHooksWithBackup(file, merged);
  log('');
  log('✔ Codex is set up too.');
  log(`  Hooks:     ${file}`);
  log(`  Config:    ${configFile} (board URL${secret ? ' and secret' : ''}, mode 0600)`);
  log('  ⚠ One-time step: run /hooks inside Codex to trust the AgStatus hook.');
  log('    Codex trusts a hook by hashing its command, and this release changed');
  log('    that command — an existing install stays silent until you re-run /hooks.');
}

function renderQr(url: string, log: (line: string) => void): void {
  qrcode.generate(url, { small: true }, (qr) => {
    for (const line of qr.split('\n')) log(`  ${line}`);
  });
}

/**
 * The board this machine is already configured with, if it is a board on
 * `base`. Anything else — no configuration at all, a single-tenant server's
 * bare origin, or a board on a different host — returns undefined so the
 * caller mints a new one.
 */
function existingBoard(base: string): string | undefined {
  let current: string | undefined;
  try {
    current = resolveBoardUrl()?.url;
  } catch {
    // An unreadable settings.json or ~/.agstatus.json is the existing setup's
    // problem to report, not a reason to silently mint a second board here.
    return undefined;
  }
  if (!current) return undefined;
  const trimmed = current.replace(/\/$/, '').replace(/\/webhook$/, '');
  // `<base>/w/<token>` and nothing else: a bare origin is a legacy server, and
  // a deeper path is not something `init` wrote.
  const prefix = `${base.replace(/\/$/, '')}/w/`;
  if (!trimmed.startsWith(prefix)) return undefined;
  const token = trimmed.slice(prefix.length);
  return token.length > 0 && !token.includes('/') ? trimmed : undefined;
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
    // Reuse the board this machine already reports to. `init` used to be a
    // once-per-machine setup command, so minting a board unconditionally was
    // fine; it is now also the UPGRADE command — the installer runs it on every
    // re-run — and a second board would silently strand the sessions, the
    // history and the phone pairing on the first one. Only a board on the same
    // server counts: pointing `--url` somewhere else is a deliberate move.
    const existing = existingBoard(base);
    if (existing && !opts.newBoard) {
      hookUrl = existing;
      dashboardUrl = existing;
      log('Using the board this machine already reports to.');
      log('  Wanted a separate one? Re-run with --new-board.');
    } else {
      const board = await createWorkspace(base);
      hookUrl = board.dashboardUrl;
      dashboardUrl = board.dashboardUrl;
      log('Created a new private board.');
    }
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

export interface UninstallOptions {
  /**
   * Also take the Focus listener down (design §5.4: `agstatus uninstall`
   * calls `listener uninstall`), with these options for it. Off unless the
   * caller asks, so library callers and tests never reach launchd or a
   * developer's real ~/.agstatus.json; `main()` turns it on.
   */
  listener?: ListenerCommandOptions;
}

export async function runUninstall(
  log: (line: string) => void = console.log,
  opts: UninstallOptions = {}
): Promise<void> {
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
    log(`  Left ${codexHookInstallPath()} and its config in place (still referenced by hooks.json).`);
  }
  if (codexCleanupOk) {
    // The sidecar goes with the script it configures — and only once the
    // registrations are gone, for the same reason: a still-registered hook
    // that finds no config would post nothing but would still run.
    for (const file of [codexHookInstallPath(), codexConfigPath()]) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        log(`✔ Deleted ${file}`);
      }
    }
  }

  log('AgStatus hooks are uninstalled. Backups kept alongside the edited files.');

  // Focus: with the hooks gone nothing posts a host object any more, but
  // `"focus": true` would still make a reinstalled hook send one and write
  // local records, and the LaunchAgent would keep a stream open to the board.
  if (opts.listener && listenerInstalled()) {
    log('');
    const code = await listenerUninstall({ ...opts.listener, log });
    if (code !== 0) {
      throw new Error('The Focus listener is still installed — fix the problem above, then run `agstatus listener uninstall`.');
    }
  }
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
    const codexHooks = safeReadCodexHooks();
    const codexConfigured = fs.existsSync(codexHookInstallPath()) && codexHasOurHooks(codexHooks);
    log(`Codex:     ${codexConfigured ? `configured (${codexHooksPath()})` : 'detected, not configured'}`);
    // A registration older than the sidecar carries its config as an env-var
    // prefix on the command string. Nothing looks wrong on POSIX — it still
    // runs — but that form cannot run on Windows at all, and it is not where
    // the current hook looks. Say so, because the fix is two steps and the
    // second one (re-trusting in Codex) is not something init can do.
    //
    // Read off the registration itself, never off "is there a sidecar?":
    // setupCodex() writes the sidecar before it rewrites hooks.json, so a
    // rewrite that throws (EACCES, read-only ~/.codex, a full disk — which
    // runInit degrades to a one-line warning before reporting success) leaves
    // a sidecar beside a legacy registration. That pair is the broken state,
    // and inferring from the sidecar would make this permanently silent on it.
    if (codexConfigured && codexLegacyRegistration(codexHooks)) {
      log('           ⚠ Registered with the older env-prefix command. Re-run `agstatus init`,');
      log('             then /hooks inside Codex to trust the new one.');
    }
  }
  if (!url) {
    log('URL:       not configured — run `agstatus init`');
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

/**
 * The runtime half of the listener (SSE stream, planner, runner) lives in
 * ./listener/run and is loaded only when `plan` or `run` is invoked: the
 * install/status/doctor paths never need it, and a broken runtime must not
 * take `agstatus init` down with it.
 */
interface ListenerRuntime {
  runPlanCommand(
    sessionId: string,
    log: (line: string) => void,
    deps?: { resume?: boolean; execute?: boolean; url?: string }
  ): Promise<number | void>;
  /** Resolves only once `signal` aborts; throws before subscribing when another listener holds the lock. */
  runListener(cfg: ListenerConfig, deps?: { signal?: AbortSignal }): Promise<void>;
}
const LISTENER_RUNTIME = './listener/run';

async function runListenerCommand(
  sub: string | undefined,
  arg: string | undefined,
  flags: Map<string, string | boolean>
): Promise<number> {
  const str = (k: string): string | undefined => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
  switch (sub) {
    case 'install':
      return listenerInstall({
        name: str('name'),
        url: str('url'),
        // Absent unless asked for: no flag must never write the key.
        ...(flags.get('no-resume') === true ? { resume: false } : {}),
      });
    case 'uninstall':
      return listenerUninstall({ purge: flags.get('purge') === true });
    case 'status':
      return listenerStatus();
    case 'doctor':
      return listenerDoctor();
    case 'plan': {
      if (!arg) {
        console.error('✖ Usage: agstatus listener plan <session_id> [--resume]\n');
        console.log(USAGE);
        return 1;
      }
      const runtime = (await import(LISTENER_RUNTIME)) as ListenerRuntime;
      // `--resume` is the dry run of the Resume tap — the only way to see
      // what a respawn would launch on this machine before it launches it.
      const code = await runtime.runPlanCommand(arg, console.log, { resume: flags.get('resume') === true });
      return typeof code === 'number' ? code : 0;
    }
    case 'resume-exec': {
      // What <stateDir>/agstatus-resume execs, and the only path that starts
      // an agent. Not in the usage summary: nobody types this by hand.
      if (!arg) {
        console.error('✖ Usage: agstatus listener resume-exec <session-id>');
        return 1;
      }
      return runResumeExec(arg);
    }
    case 'run': {
      const cfg = resolveListenerConfig({ name: str('name'), url: str('url') });
      if ('error' in cfg) {
        console.error(`✖ ${cfg.error}`);
        return 1;
      }
      // launchd stops the agent with SIGTERM (Ctrl-C in the foreground is
      // SIGINT): end the stream, release the lock and log the stop instead
      // of dying mid-write.
      const ctrl = new AbortController();
      const stop = (): void => ctrl.abort();
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      const runtime = (await import(LISTENER_RUNTIME)) as ListenerRuntime;
      await runtime.runListener(cfg, { signal: ctrl.signal }); // resolves only on a signal
      return 0;
    }
    default:
      console.error(`✖ ${sub ? `Unknown listener command: ${sub}` : 'Missing listener command'}\n`);
      console.log(USAGE);
      return 1;
  }
}

const USAGE = `agstatus — live status board for your coding agents (Claude Code & Codex)

Usage:
  agstatus init [options]   Set up hooks + a status board
  agstatus status           Show current setup and server reachability
  agstatus uninstall        Remove hooks and env entries (and the Focus listener, if installed)
  agstatus focus <n>        Bring the n-th session's window to the front (bind it to a key)
  agstatus keys             Show the shortcut for each slot, and config for your hotkey tool
  agstatus listener <cmd>   Focus listener (bring a session's terminal to the front from the board)
  agstatus help             This help

init options:
  --url <base>      Server to use (default: ${resolveBaseUrl()})
  --code XXXX-XXXX  Pair with a board created elsewhere (e.g. the mobile app)
  --secret <s>      Webhook secret for self-hosted single-tenant servers
  --minimal         Send tool names only, never command text
  --new-board       Create a second board instead of reusing this machine's
  --codex           Also set up OpenAI Codex even if ~/.codex isn't detected
  --no-codex        Skip Codex setup (default: auto-configure when detected)
  --no-qr           Skip the QR code

keys options (see docs/focus-keys.md):
  --skhd            Print skhd config for the shortcuts
  --karabiner       Print a Karabiner-Elements complex modification
  --write           Save the current shortcuts to ~/.agstatus.json so you can edit them
  --slots <n>       How many slots the defaults cover (default 6)

  AgStatus does not capture keys itself — a hotkey tool runs agstatus focus <n>.
  Defaults are ctrl+alt+1 .. ctrl+alt+6; edit "keys" in ~/.agstatus.json to change them.

focus options (see docs/focus-keys.md):
  --list            Print the slot -> session mapping and exit
  --url <board>     Use this board instead of the configured one

  A slot is an assignment this machine holds: a session keeps its number until
  it leaves the board, and the number it frees is reused by the next one. New
  sessions take the lowest free slot, oldest first. The apps do not show these
  numbers — a card's position is frozen per device — so use --list to see them.

listener commands (macOS; see docs/hooks.md "Focus"):
  install [--name <label>] [--url <board>] [--no-resume]
                                             Create machine.json, set "focus": true, start the LaunchAgent;
                                             --no-resume writes "resume": false (Resume taps stay refused)
  uninstall [--purge]                        Stop it, set "focus": false; --purge also drops records and log
  status                                     Agent state, machine id, board, last log lines
  doctor                                     Which tools and strategies are available, config sanity
  plan <session_id> [--resume]               Print what a focus command would run, without running it;
                                             --resume dry-runs the Resume tap (a respawn when it is gone)
  run                                        Run the listener in the foreground (what the LaunchAgent runs)
  resume-exec <session-id>                   Resume that session here — what the resume launcher execs
`;

const VALUE_FLAGS = new Set(['url', 'code', 'secret', 'name', 'slots']);
const BOOL_FLAGS = new Set(['minimal', 'no-qr', 'help', 'codex', 'no-codex', 'purge', 'no-resume', 'resume', 'new-board', 'list', 'skhd', 'karabiner', 'write']);

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positional: string[] = []; // `listener <sub> [session_id]` only
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) {
      // `listener <sub> [session_id]` takes two; `focus <n>` takes one.
      const limit = cmd === 'listener' ? 2 : cmd === 'focus' ? 1 : 0;
      if (positional.length < limit) {
        positional.push(a);
        continue;
      }
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
          newBoard: flags.get('new-board') === true,
        });
        return 0;
      case 'uninstall':
        await runUninstall(console.log, { listener: {} });
        return 0;
      case 'status':
        await runStatus();
        return 0;
      case 'focus':
        return await runFocus(
          positional[0],
          {
            list: flags.get('list') === true,
            ...(typeof flags.get('url') === 'string' ? { url: flags.get('url') as string } : {}),
          },
          console.log,
          {
            // A session on this machine is focused here, in this process, by
            // the same planner the listener uses — no board round trip, so a
            // key press neither spends the workspace's ten-a-minute command
            // budget nor waits on the network. The runtime stays a lazy
            // import: `agstatus init` must not depend on it loading.
            focusLocally: async (sessionId, log) => {
              const runtime = (await import(LISTENER_RUNTIME)) as ListenerRuntime;
              const url = flags.get('url');
              const code = await runtime.runPlanCommand(sessionId, log, {
                execute: true,
                ...(typeof url === 'string' ? { url } : {}),
              });
              return typeof code === 'number' ? code : 0;
            },
          }
        );
      case 'keys':
        return await runKeys(
          {
            skhd: flags.get('skhd') === true,
            karabiner: flags.get('karabiner') === true,
            write: flags.get('write') === true,
            ...(typeof flags.get('slots') === 'string' ? { slots: flags.get('slots') as string } : {}),
          },
          console.log
        );
      case 'listener':
        return await runListenerCommand(positional[0], positional[1], flags);
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
