import type {
  CommandType, LocalRecord, MachineFacts, Plan, PlanResult, Reach, Reason, Result, Step,
} from './types';
import {
  BUNDLE_RE, CODEX_ID_RE, HERDR_PANE_RE, INT_RE, ITERM_SESSION_RE, KITTY_LISTEN_RE, MUX_SESSION_RE,
  SOCKET_RE, UUID_RE, ZELLIJ_PANE_RE, cleanEnv, isAbsPath,
} from './records';

/**
 * The Focus planner: the decision ladder of design §5.2 as a pure function
 * from (record, command, machine facts) to the argv arrays the runtime will
 * execFile — no I/O, no clock, so every row runs on CI with fixture records.
 *
 * v1 ships the prompt-free rows only (§5.4): a multiplexer's own pane
 * selection, then the outer app by bundle id — agterm, kitty, iTerm2's URL,
 * WezTerm's CLI, Codex Desktop's deep link, JetBrains/Zed root-open, and
 * `open -b` for the other apps in the table. Terminal.app and Ghostty
 * degrade to the app level until the signed sender of v1.1 exists.
 *
 * `resume` (§5.2 step 4) is the same ladder with one extra rung: on a live
 * session it *is* a focus (the user asked for the window, the session never
 * died), and on a dead one it is a respawn — a host row that starts exactly
 * one process, `agstatus-resume <session-uuid>`, in the directory the
 * runtime resolved. Rows that cannot start a process without AppleScript or
 * a file on disk (Terminal.app, iTerm2) say `unsupported-host` rather than
 * invent one.
 *
 * Trust (§5.1): argv[0] is `OPEN`, an absolute path from facts.bins, or
 * facts.launcher — never a PATH lookup, never a value from the record. Every
 * record or env value that lands in an argv or a URL has passed its regex
 * here, whatever validateRecord() did before; a bundle id reaches `open -b`
 * only when it is in the table below — the record's `app.bundle` and the
 * bundle the runtime read off a multiplexer client's process tree are both
 * refused when the table does not know them (and `app.path` is never taken
 * from the record at all, §5.1). A step's `env` carries only the one socket
 * variable its tool needs. The one *command string* a plan may contain is
 * `'<launcher>' <uuid>`: a fixed absolute path the installer wrote and a
 * token that passed UUID_RE, and nothing else, ever.
 */

/** The one system binary the planner names itself; every other tool comes from ListenerConfig.bins. */
export const OPEN = '/usr/bin/open';

/** Named because two rows key on it: the app that hosts `entrypoint: claude-desktop`. */
const CLAUDE_DESKTOP = 'com.anthropic.claudefordesktop';

/**
 * Entrypoints that are not a terminal session at all: an SDK run or
 * `codex exec` was started by a program, has no window to come back to, and
 * must never be respawned in one (§5.2 step 4).
 */
const HEADLESS_ENTRYPOINTS = new Set(['sdk-cli', 'codex-exec']);

/** One rung of a plan: the multiplexer's pane selection, or the app strategy that follows it. */
interface Leg {
  steps: Step[];
  reach: Reach;
  result: Result;
  experimental: boolean;
  /** True when the rung starts an agent rather than only raising a window. */
  respawns?: boolean;
  /** For the description: what the rung does, never a path. */
  what: string;
}
type LegResult = { ok: true; leg: Leg } | { ok: false; reason: Reason };

interface AppContext {
  bundle: string;
  /** Validated env: the record's own, or the multiplexer client's (facts.outer.env). */
  env: Record<string, string>;
  record: LocalRecord;
  bins: Record<string, string>;
}
type Strategy = (ctx: AppContext) => LegResult;

const fail = (reason: Reason): { ok: false; reason: Reason } => ({ ok: false, reason });

const leg = (
  what: string, steps: Step[], reach: Reach, result: Result, experimental = false, respawns = false,
): LegResult => ({ ok: true, leg: { what, steps, reach, result, experimental, respawns } });

/** A tool from the listener's own table; anything but an absolute path counts as missing. */
function bin(bins: Record<string, string>, name: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(bins, name) ? bins[name] : undefined;
  return isAbsPath(value) ? value : undefined;
}

/** `open -b <bundle>`; the last step of a plan is the one the runner verifies with lsappinfo. */
function openApp(bundle: string, last = true): Step {
  const step: Step = { argv: [OPEN, '-b', bundle], label: 'open: activate app' };
  if (last) step.expectFrontmost = bundle;
  return step;
}

/**
 * The launcher path as it may appear inside a *command string*: absolute,
 * and free of the quote, backslash and control characters that would make
 * `'<path>' <uuid>` mean anything but one path and one token. A home
 * directory with an apostrophe in it therefore costs the string hosts
 * (agterm, tmux) their respawn row instead of producing a string nobody can
 * reason about; the argv hosts are unaffected.
 */
const UNQUOTABLE_RE = /['"\\]/;

/**
 * The only command string the listener ever builds (§5.1): the installer's
 * own launcher, single-quoted, plus a session id that has passed UUID_RE.
 * Null when the launcher path cannot be quoted — never a best effort.
 */
function commandString(launcher: string, uuid: string): string | null {
  if (!isAbsPath(launcher) || UNQUOTABLE_RE.test(launcher) || !UUID_RE.test(uuid)) return null;
  return `'${launcher}' ${uuid}`;
}

/** The Codex thread a record points at — `thread_id`, else the root, else the session id. */
function threadId(record: LocalRecord): string | null {
  const id = record.codex?.thread_id ?? record.codex?.root_thread_id ?? record.session_id;
  return CODEX_ID_RE.test(id) ? id : null;
}

/**
 * Codex Desktop's deep link. It both navigates and raises, and it reopens an
 * archived thread through an interstitial — which is why `resume` needs no
 * process of its own here (§5.2 step 4).
 */
const codexLink = (bundle: string, id: string): Step =>
  ({ argv: [OPEN, '-b', bundle, `codex://threads/${id}`], expectFrontmost: bundle, label: 'open: codex thread' });

// ---- App strategies (§5.2 step 3) ----------------------------------------

const appOnly: Strategy = ({ bundle }) => leg(`open -b ${bundle}`, [openApp(bundle)], 'app', 'activated');

const agterm: Strategy = (ctx) => {
  const ctl = bin(ctx.bins, 'agtermctl');
  // `--socket` is an option of each agtermctl SUBCOMMAND, not a global flag:
  // `agtermctl --socket X window select Y` exits 64 with "Unknown option".
  const { AGTERM_SOCKET: socket, AGTERM_WINDOW_ID: window, AGTERM_SESSION_ID: session } = ctx.env;
  if (!ctl || !socket || !SOCKET_RE.test(socket) || !window || !UUID_RE.test(window)
    || !session || !UUID_RE.test(session)) {
    return appOnly(ctx);
  }
  return leg('agterm session', [
    openApp(ctx.bundle, false),
    { argv: [ctl, 'window', 'select', window, '--socket', socket], label: 'agtermctl: select window' },
    {
      argv: [ctl, 'session', 'select', '--target', session, '--window', window, '--socket', socket],
      expectFrontmost: ctx.bundle,
      label: 'agtermctl: select session',
    },
  ], 'pane', 'focused');
};

const kitty: Strategy = (ctx) => {
  const kitten = bin(ctx.bins, 'kitten');
  const { KITTY_LISTEN_ON: to, KITTY_WINDOW_ID: id } = ctx.env;
  if (!kitten || !to || !KITTY_LISTEN_RE.test(to) || !id || !INT_RE.test(id)) return appOnly(ctx);
  return leg('kitty window', [
    {
      argv: [kitten, '@', '--to', to, 'focus-window', '--match', `id:${id}`],
      expectFrontmost: ctx.bundle,
      label: 'kitten: focus window',
    },
  ], 'pane', 'focused');
};

const iterm2: Strategy = (ctx) => {
  const id = ctx.env.ITERM_SESSION_ID;
  if (!id || !ITERM_SESSION_RE.test(id)) return appOnly(ctx);
  return leg('iTerm2 reveal', [
    { argv: [OPEN, `iterm2:reveal?sessionid=${id}`], expectFrontmost: ctx.bundle, label: 'open: iterm2:reveal' },
  ], 'pane', 'focused', true);
};

const wezterm: Strategy = (ctx) => {
  const wez = bin(ctx.bins, 'wezterm');
  const { WEZTERM_PANE: pane, WEZTERM_UNIX_SOCKET: socket } = ctx.env;
  if (!wez || !pane || !INT_RE.test(pane)) return appOnly(ctx);
  const activate: Step = {
    argv: [wez, 'cli', 'activate-pane', '--pane-id', pane],
    expectFrontmost: ctx.bundle,
    label: 'wezterm: activate pane',
  };
  if (socket && SOCKET_RE.test(socket)) activate.env = { WEZTERM_UNIX_SOCKET: socket };
  return leg('WezTerm pane', [openApp(ctx.bundle, false), activate], 'pane', 'focused', true);
};

const codexDesktop: Strategy = (ctx) => {
  const id = threadId(ctx.record);
  if (id === null) return fail('bad-record');
  return leg('Codex thread', [codexLink(ctx.bundle, id)], 'thread', 'focused');
};

/** JetBrains, Android Studio, Zed: opening the project root raises that project's window. */
const projectOpen: Strategy = (ctx) => {
  const root = ctx.record.project_root;
  if (!isAbsPath(root)) return appOnly(ctx);
  return leg('project window', [
    { argv: [OPEN, '-b', ctx.bundle, root], expectFrontmost: ctx.bundle, label: 'open: project root' },
  ], 'window', 'focused');
};

/**
 * The bundle table: the only bundle ids the listener ever hands to
 * `open -b` (plus the `com.jetbrains.` prefix). Anything else is an
 * unsupported host, however the record says it learned the id.
 */
const STRATEGIES = new Map<string, Strategy>([
  ['com.umputun.agterm', agterm],
  ['net.kovidgoyal.kitty', kitty],
  ['com.googlecode.iterm2', iterm2],
  ['com.github.wez.wezterm', wezterm],
  // Tab-exact focus for these needs the signed Apple-events sender (v1.1).
  ['com.apple.Terminal', appOnly],
  ['com.mitchellh.ghostty', appOnly],
  ['org.alacritty', appOnly],
  ['dev.warp.Warp-Stable', appOnly],
  ['dev.warp.Warp-Preview', appOnly],
  ['co.zeit.hyper', appOnly],
  ['org.tabby', appOnly],
  ['com.raphaelamorim.rio', appOnly],
  ['com.apple.dt.Xcode', appOnly],
  ['com.openai.codex', codexDesktop],
  ['com.anthropic.claudefordesktop', appOnly],
  ['com.google.android.studio', projectOpen],
  ['dev.zed.Zed', projectOpen],
  ['dev.zed.Zed-Preview', projectOpen],
  // Window-exact focus needs the ~/.claude/ide lock file — later.
  ['com.microsoft.VSCode', appOnly],
  ['com.microsoft.VSCodeInsiders', appOnly],
  ['com.todesktop.230313mzl4w4u92', appOnly], // Cursor
  ['com.exafunction.windsurf', appOnly],
]);

function strategyFor(bundle: string): Strategy | undefined {
  return STRATEGIES.get(bundle) ?? (bundle.startsWith('com.jetbrains.') ? projectOpen : undefined);
}

// ---- Respawn strategies (§5.2 step 4) -------------------------------------

/**
 * What a respawn row may use on top of an AppContext: the launcher the
 * installer wrote, the session id (already UUID_RE-clean, or '' when the
 * record's id is not a uuid) and the working directory the *runtime*
 * resolved and stat()ed — the planner never goes looking for one, and '' is
 * "the runtime could not find it".
 */
interface RespawnContext extends AppContext {
  launcher: string;
  uuid: string;
  cwd: string;
}
type Respawner = (ctx: RespawnContext) => LegResult;

/** No uuid → the record cannot name a session to resume; no cwd → the runtime had none. */
function missing(ctx: RespawnContext): Reason | null {
  if (!ctx.uuid) return 'bad-record';
  if (!ctx.cwd) return 'respawn-failed';
  return null;
}

/**
 * Rows that can only hand a host a command through AppleScript (`do script`,
 * `create window with default profile command`) or through a file on disk:
 * both wait for the signed sender of v1.1 (§5.4), and neither is worth a
 * shell string in the meantime.
 */
const needsAppleScript: Respawner = () => fail('unsupported-host');

/** agterm: one `session new` carrying the launcher as its command, then raise the app. */
const respawnAgterm: Respawner = (ctx) => {
  const gone = missing(ctx);
  if (gone) return fail(gone);
  const ctl = bin(ctx.bins, 'agtermctl');
  const socket = ctx.env.AGTERM_SOCKET;
  const command = commandString(ctx.launcher, ctx.uuid);
  if (!ctl || !command || !socket || !SOCKET_RE.test(socket)) return fail('unsupported-host');
  // `--socket` is an option of the SUBCOMMAND here too — see agterm() above.
  return leg('agterm session new', [
    {
      argv: [ctl, 'session', 'new', '--cwd', ctx.cwd, '--command', command, '--socket', socket],
      label: 'agtermctl: new session',
    },
    // Everything after the step that starts the agent is cosmetic: the
    // session exists whether or not the app comes to the front, and failing
    // the plan here would tell the user nothing started (§5.2 step 4).
    { ...openApp(ctx.bundle), optional: true },
  ], 'pane', 'resumed', true, true);
};

/**
 * A new terminal window through `open`, for the hosts that take
 * `--working-directory=` and `-e` on their own argv (Ghostty, Alacritty,
 * Rio). The bundle id comes from the table below, never from the record,
 * and `app.path` is never read at all (§5.1) — so the only strings here are
 * a table constant, the runtime's cwd and the launcher's own argv.
 */
const respawnTerminalWindow: Respawner = (ctx) => {
  const gone = missing(ctx);
  if (gone) return fail(gone);
  return leg('new terminal window', [{
    argv: [OPEN, '-n', '-b', ctx.bundle, '--args', `--working-directory=${ctx.cwd}`, '-e', ctx.launcher, ctx.uuid],
    expectFrontmost: ctx.bundle,
    label: 'open: new terminal window',
  }], 'window', 'resumed', true, true);
};

/**
 * kitty: `launch --type=os-window` over the same socket the focus row uses,
 * which takes the command as argv. Without remote control there is no
 * socket to ask, so the generic `open` row runs instead — kitty documents
 * `--directory` for that, with `--working-directory` only as a later alias,
 * so the fallback stays experimental until the §10 smoke test says which
 * this kitty takes.
 */
const respawnKitty: Respawner = (ctx) => {
  const kitten = bin(ctx.bins, 'kitten');
  const to = ctx.env.KITTY_LISTEN_ON;
  if (!kitten || !to || !KITTY_LISTEN_RE.test(to)) return respawnTerminalWindow(ctx);
  const gone = missing(ctx);
  if (gone) return fail(gone);
  return leg('kitty os-window', [{
    argv: [kitten, '@', '--to', to, 'launch', '--type=os-window', `--cwd=${ctx.cwd}`, ctx.launcher, ctx.uuid],
    label: 'kitten: launch os-window',
  }], 'pane', 'resumed', true, true);
};

/** WezTerm: `cli spawn --new-window`, argv after `--`, on the recorded socket. */
const respawnWezterm: Respawner = (ctx) => {
  const wez = bin(ctx.bins, 'wezterm');
  if (!wez) return fail('unsupported-host');
  const gone = missing(ctx);
  if (gone) return fail(gone);
  const spawn: Step = {
    argv: [wez, 'cli', 'spawn', '--new-window', '--cwd', ctx.cwd, '--', ctx.launcher, ctx.uuid],
    label: 'wezterm: spawn window',
  };
  const socket = ctx.env.WEZTERM_UNIX_SOCKET;
  if (socket && SOCKET_RE.test(socket)) spawn.env = { WEZTERM_UNIX_SOCKET: socket };
  return leg('WezTerm window', [spawn], 'pane', 'resumed', true, true);
};

/** Codex Desktop: the deep link reopens the thread, archived or not. No process starts. */
const respawnCodexDesktop: Respawner = (ctx) => {
  const id = threadId(ctx.record);
  if (id === null) return fail('bad-record');
  return leg('Codex thread', [codexLink(ctx.bundle, id)], 'thread', 'resumed');
};

/**
 * Claude Desktop documents no resume-by-id link, so the honest move is to
 * put the app in front and let the user pick the conversation up inside it:
 * `activated`, and nothing was started.
 */
const claudeDesktopLeg = (): LegResult =>
  leg(`open -b ${CLAUDE_DESKTOP}`, [openApp(CLAUDE_DESKTOP)], 'app', 'activated');
const respawnClaudeDesktop: Respawner = () => claudeDesktopLeg();

/**
 * The respawn table. A bundle that is not here has no way to be handed a
 * command without AppleScript, an extension or a file on disk, so `resume`
 * on it is an unsupported host — that includes Warp, Hyper, Tabby, Xcode,
 * VS Code/Cursor/Windsurf (the deep link needs the extension and the right
 * window, §5.2) and JetBrains/Zed (no agent session to resume there).
 */
const RESPAWNS = new Map<string, Respawner>([
  ['com.umputun.agterm', respawnAgterm],
  ['net.kovidgoyal.kitty', respawnKitty],
  ['com.github.wez.wezterm', respawnWezterm],
  ['com.mitchellh.ghostty', respawnTerminalWindow],
  ['org.alacritty', respawnTerminalWindow],
  ['com.raphaelamorim.rio', respawnTerminalWindow],
  // Both need a command *string* through Apple events — v1.1, with the signed sender.
  ['com.apple.Terminal', needsAppleScript],
  ['com.googlecode.iterm2', needsAppleScript],
  ['com.openai.codex', respawnCodexDesktop],
  [CLAUDE_DESKTOP, respawnClaudeDesktop],
]);

// ---- Multiplexers (§5.2 step 2) -------------------------------------------

function muxLeg(mux: NonNullable<LocalRecord['mux']>, bins: Record<string, string>): LegResult {
  switch (mux.kind) {
    case 'herdr': {
      const herdr = bin(bins, 'herdr');
      if (!herdr) return fail('unsupported-host');
      const { socket, target } = mux;
      if (!socket || !SOCKET_RE.test(socket) || !target || !HERDR_PANE_RE.test(target)) return fail('bad-record');
      return leg('herdr pane', [
        { argv: [herdr, 'agent', 'focus', target], env: { HERDR_SOCKET_PATH: socket }, label: 'herdr: focus pane' },
      ], 'pane', 'selected', true);
    }
    case 'tmux': {
      const tmux = bin(bins, 'tmux');
      if (!tmux) return fail('unsupported-host');
      const { socket, target } = mux;
      if (!socket || !SOCKET_RE.test(socket) || !target) return fail('bad-record');
      // session:@window.%pane — the sigils are optional in the recipe and mandatory in the argv.
      const parts = /^([A-Za-z0-9_.-]{1,64}):@?(\d{1,6})\.%?(\d{1,6})$/.exec(target);
      if (!parts) return fail('bad-record');
      const [, session, window, pane] = parts;
      return leg('tmux pane', [
        { argv: [tmux, '-S', socket, 'select-window', '-t', `@${window}`], label: 'tmux: select window' },
        { argv: [tmux, '-S', socket, 'select-pane', '-t', `%${pane}`], label: 'tmux: select pane' },
        { argv: [tmux, '-S', socket, 'switch-client', '-t', session], optional: true, label: 'tmux: switch client' },
      ], 'pane', 'selected');
    }
    case 'zellij': {
      const zellij = bin(bins, 'zellij');
      if (!zellij) return fail('unsupported-host');
      const { session, target } = mux;
      if (!session || !MUX_SESSION_RE.test(session) || !target || !ZELLIJ_PANE_RE.test(target)) {
        return fail('bad-record');
      }
      return leg('zellij pane', [
        { argv: [zellij, '--session', session, 'action', 'focus-pane-id', target], label: 'zellij: focus pane' },
      ], 'pane', 'selected', true);
    }
    case 'screen': {
      const screen = bin(bins, 'screen');
      if (!screen) return fail('unsupported-host');
      const { session, target } = mux;
      if (!session || !MUX_SESSION_RE.test(session) || !target || !INT_RE.test(target)) return fail('bad-record');
      return leg('screen window', [
        { argv: [screen, '-S', session, '-X', 'select', target], label: 'screen: select window' },
      ], 'pane', 'selected', true);
    }
    default:
      return fail('bad-record');
  }
}

// ---- Multiplexer respawns (§5.2 step 4) -----------------------------------

/** Everything a respawn row needs beyond the host itself, all of it already checked. */
interface Spawn {
  launcher: string;
  uuid: string;
  cwd: string;
  /** The label herdr files the new pane under; the record's own enum, `claude` or `codex`. */
  agent: LocalRecord['agent'];
}

/**
 * The new session goes back INSIDE the multiplexer it died in — a tmux
 * window or a herdr pane — and the outer terminal is raised afterwards
 * exactly as a focus raises it. zellij and screen would need a command
 * string built for their own parsers (`zellij run -- …`, `screen -X screen`),
 * which v1 does not do.
 */
function muxRespawn(mux: NonNullable<LocalRecord['mux']>, bins: Record<string, string>, spawn: Spawn): LegResult {
  const { launcher, uuid, cwd } = spawn;
  switch (mux.kind) {
    case 'tmux': {
      const tmux = bin(bins, 'tmux');
      if (!tmux) return fail('unsupported-host');
      const command = commandString(launcher, uuid);
      if (!command) return fail('unsupported-host');
      const { socket, target } = mux;
      if (!socket || !SOCKET_RE.test(socket) || !target) return fail('bad-record');
      // Without `-t` the window lands in whatever session the server calls
      // current, which on a server with several is rarely the one that died
      // — and the outer terminal is then raised showing the wrong session.
      // The session name is the first field of the same `session:@window.%pane`
      // target the focus row parses.
      const parts = /^([A-Za-z0-9_.-]{1,64}):@?\d{1,6}\.%?\d{1,6}$/.exec(target);
      if (!parts) return fail('bad-record');
      return leg('tmux new-window', [
        { argv: [tmux, '-S', socket, 'new-window', '-t', `${parts[1]}:`, '-c', cwd, command], label: 'tmux: new window' },
      ], 'pane', 'resumed', true, true);
    }
    case 'herdr': {
      const herdr = bin(bins, 'herdr');
      if (!herdr) return fail('unsupported-host');
      const { socket } = mux;
      if (!socket || !SOCKET_RE.test(socket)) return fail('bad-record');
      // The launcher and the uuid are argv after `--`, never a string (§5.2 step 4).
      return leg('herdr agent start', [{
        argv: [herdr, 'agent', 'start', spawn.agent, '--cwd', cwd, '--focus', '--', launcher, uuid],
        env: { HERDR_SOCKET_PATH: socket },
        label: 'herdr: start agent',
      }], 'pane', 'resumed', true, true);
    }
    default:
      return fail('unsupported-host');
  }
}

// ---- The ladder -----------------------------------------------------------

function finish(legs: Leg[], reach: Reach, result: Result, experimental: boolean): PlanResult {
  const what = legs.map((l) => l.what).join(', then ');
  const respawns = legs.some((l) => l.respawns === true);
  const tail = `reach ${reach}, result ${result}${respawns ? ', starts a new session' : ''}`
    + `${experimental ? ', experimental' : ''}`;
  const made: Plan = {
    steps: legs.flatMap((l) => l.steps),
    reach,
    result,
    experimental,
    description: `${what} → ${tail}`,
  };
  if (respawns) made.respawns = true;
  return { ok: true, plan: made };
}

/** One leg on its own, for the rows that are a whole plan (the deep links and `open -b`). */
function only(result: LegResult): PlanResult {
  if (!result.ok) return result;
  const { leg: single } = result;
  return finish([single], single.reach, single.result, single.experimental);
}

/**
 * `resume` on a session whose agent is gone (§5.2 step 4). Exactly one
 * process is ever started, and it is always the same one: the launcher the
 * installer wrote, with the session uuid, in the directory the *runtime*
 * resolved and handed in — the planner does no lookup of its own. A host
 * that cannot be handed an argv (Terminal.app, iTerm2, Warp), a session
 * that was never in a terminal (sdk-cli, codex-exec) and a machine with no
 * launcher (resume turned off, or a file that failed its 0700-and-ours
 * check) all refuse rather than improvise.
 */
function respawnPlan(record: LocalRecord, facts: MachineFacts, resumeCwd?: string): PlanResult {
  const { launcher } = facts;
  if (!isAbsPath(launcher)) return fail('unsupported-host');
  if (HEADLESS_ENTRYPOINTS.has(record.entrypoint)) return fail('unsupported-type');
  // Claude Desktop keeps its own conversation list and documents no resume link.
  if (record.entrypoint === 'claude-desktop') return only(claudeDesktopLeg());

  const uuid = UUID_RE.test(record.session_id) ? record.session_id : '';
  const cwd = isAbsPath(resumeCwd) ? resumeCwd : '';

  if (record.mux) {
    if (!uuid) return fail('bad-record');
    if (!cwd) return fail('respawn-failed');
    const inner = muxRespawn(record.mux, facts.bins, { launcher, uuid, cwd, agent: record.agent });
    if (!inner.ok) return inner;
    const legs: Leg[] = [inner.leg];
    const outer = facts.outer?.bundle;
    if (outer !== undefined) {
      if (!BUNDLE_RE.test(outer)) return fail('bad-record');
      const known = strategyFor(outer);
      // An outer app the table does not know stays where it is; the new pane still exists.
      if (known) {
        const raise = known({ bundle: outer, env: cleanEnv(facts.outer?.env), record, bins: facts.bins });
        if (!raise.ok) return raise;
        // The pane was created by the leg before this one. A raise that
        // fails (the app is not installed, LaunchServices refuses) must not
        // report `respawn-failed` over a session that is sitting in tmux or
        // herdr, waiting — so these steps may fail and the plan still acks.
        legs.push({ ...raise.leg, steps: raise.leg.steps.map((step) => ({ ...step, optional: true })) });
      }
    }
    return finish(legs, 'pane', 'resumed', legs.some((l) => l.experimental));
  }

  const bundle = record.app?.bundle;
  if (bundle === undefined) return fail('unsupported-host');
  if (!BUNDLE_RE.test(bundle)) return fail('bad-record');
  const row = RESPAWNS.get(bundle);
  if (!row) return fail('unsupported-host');
  return only(row({ bundle, env: cleanEnv(record.env), record, bins: facts.bins, launcher, uuid, cwd }));
}

/**
 * The plan for one command against one record, or the reason there is none.
 * Rung by rung: SSH without a multiplexer is remote; a live agent is
 * focused whichever button was tapped (a `resume` tap on a session that
 * turned out to be alive wants the same window as `focus`); a dead agent is
 * `not-running` for a focus and a respawn for a resume. Focus itself: a
 * multiplexer selects its pane first, and the outer app the runtime
 * resolved (facts.outer) is raised after it — with no outer, or an outer
 * the table does not know, the pane is selected and the window stays where
 * it was; without a multiplexer the record's own app is raised by its
 * bundle strategy, or refused when the table has none.
 *
 * `resumeCwd` is the working directory for a respawn, already resolved and
 * validated by the runtime (this function reads no disk and no clock); it
 * is used only by respawn steps, and its absence is `respawn-failed`.
 */
export function plan(
  record: LocalRecord, type: CommandType, facts: MachineFacts, resumeCwd?: string,
): PlanResult {
  if (type !== 'focus' && type !== 'resume') return fail('unsupported-type');
  // A tmux/herdr server started over SSH and attached locally is not remote (§5.1).
  if (record.env.SSH_CONNECTION && !record.mux) return fail('remote');
  if (!facts.agentAlive) {
    if (type === 'focus') return fail('not-running');
    return respawnPlan(record, facts, resumeCwd);
  }
  return focusPlan(record, facts);
}

/** Step 3 of the ladder: the session is running, put its window in front. */
function focusPlan(record: LocalRecord, facts: MachineFacts): PlanResult {
  const legs: Leg[] = [];
  let strategy: Strategy;
  let ctx: AppContext;
  if (record.mux) {
    const inner = muxLeg(record.mux, facts.bins);
    if (!inner.ok) return inner;
    legs.push(inner.leg);
    const outer = facts.outer?.bundle;
    if (outer === undefined) return finish(legs, 'pane', 'selected', true);
    if (!BUNDLE_RE.test(outer)) return fail('bad-record');
    const known = strategyFor(outer);
    // The pane is selected either way; an outer app the table does not know stays where it is.
    if (!known) return finish(legs, 'pane', 'selected', true);
    strategy = known;
    ctx = { bundle: outer, env: cleanEnv(facts.outer?.env), record, bins: facts.bins };
  } else {
    const bundle = record.app?.bundle;
    if (bundle === undefined) return fail('unsupported-host');
    if (!BUNDLE_RE.test(bundle)) return fail('bad-record');
    const known = strategyFor(bundle);
    if (!known) return fail('unsupported-host');
    strategy = known;
    ctx = { bundle, env: cleanEnv(record.env), record, bins: facts.bins };
  }

  const outer = strategy(ctx);
  if (!outer.ok) return outer;
  legs.push(outer.leg);
  return finish(legs, outer.leg.reach, outer.leg.result, legs.some((l) => l.experimental));
}

const LONG_PATH = 40;

/** `--cwd=<dir>`, `--working-directory=<dir>`: the flag is worth printing, the directory is not. */
const FLAG_PATH_RE = /^(--[a-z-]{1,32}=)(\/.*)$/;
/** The launcher command string, `'<abs path>' <uuid>`, as the string hosts receive it. */
const COMMAND_RE = /^'(\/[^']*)' (\S{1,64})$/;

/** Arguments that look like long paths are not for the log or the terminal. */
function redact(arg: string): string {
  if (arg.startsWith('/')) return arg.length > LONG_PATH ? '<path>' : arg;
  const flag = FLAG_PATH_RE.exec(arg);
  if (flag) return flag[2].length > LONG_PATH ? `${flag[1]}<path>` : arg;
  const command = COMMAND_RE.exec(arg);
  if (command) return command[1].length > LONG_PATH ? `'<path>' ${command[2]}` : arg;
  return arg;
}

/** The plan as `agstatus listener plan` prints it: one line per step, then what it reaches. */
export function describe(plan: Plan): string {
  const lines = plan.steps.map((step, i) => {
    const notes = [
      step.env ? `env ${Object.keys(step.env).join(',')}` : '',
      step.optional ? 'optional' : '',
      step.expectFrontmost ? `expect frontmost ${step.expectFrontmost}` : '',
    ].filter(Boolean);
    const argv = step.argv.map(redact).join(' ');
    return `${i + 1}. ${step.label}: ${argv}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  });
  lines.push(`reach ${plan.reach}, result ${plan.result}`
    + `${plan.respawns ? ', starts a new session' : ''}${plan.experimental ? ', experimental' : ''}`);
  return lines.join('\n');
}
