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
 * degrade to the app level until the signed sender of v1.1 exists;
 * `resume` is step 5 and is refused outright.
 *
 * Trust (§5.1): argv[0] is `OPEN` or an absolute path from facts.bins — never
 * a PATH lookup, never a value from the record. Every record or env value
 * that lands in an argv or a URL has passed its regex here, whatever
 * validateRecord() did before; a bundle id reaches `open -b` only when it
 * is in the table below — the record's `app.bundle` and the bundle the
 * runtime read off a multiplexer client's process tree are both refused
 * when the table does not know them. A step's `env` carries only the one
 * socket variable its tool needs.
 */

/** The one system binary the planner names itself; every other tool comes from ListenerConfig.bins. */
export const OPEN = '/usr/bin/open';

/** One rung of a plan: the multiplexer's pane selection, or the app strategy that follows it. */
interface Leg {
  steps: Step[];
  reach: Reach;
  result: Result;
  experimental: boolean;
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

const leg = (what: string, steps: Step[], reach: Reach, result: Result, experimental = false): LegResult =>
  ({ ok: true, leg: { what, steps, reach, result, experimental } });

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

// ---- App strategies (§5.2 step 3) ----------------------------------------

const appOnly: Strategy = ({ bundle }) => leg(`open -b ${bundle}`, [openApp(bundle)], 'app', 'activated');

const agterm: Strategy = (ctx) => {
  const ctl = bin(ctx.bins, 'agtermctl');
  const { AGTERM_SOCKET: socket, AGTERM_WINDOW_ID: window, AGTERM_SESSION_ID: session } = ctx.env;
  if (!ctl || !socket || !SOCKET_RE.test(socket) || !window || !UUID_RE.test(window)
    || !session || !UUID_RE.test(session)) {
    return appOnly(ctx);
  }
  return leg('agterm session', [
    openApp(ctx.bundle, false),
    { argv: [ctl, '--socket', socket, 'window', 'select', window], label: 'agtermctl: select window' },
    {
      argv: [ctl, '--socket', socket, 'session', 'select', '--target', session, '--window', window],
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
  const { record, bundle } = ctx;
  const id = record.codex?.thread_id ?? record.codex?.root_thread_id ?? record.session_id;
  if (!CODEX_ID_RE.test(id)) return fail('bad-record');
  return leg('Codex thread', [
    { argv: [OPEN, '-b', bundle, `codex://threads/${id}`], expectFrontmost: bundle, label: 'open: codex thread' },
  ], 'thread', 'focused');
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

// ---- The ladder -----------------------------------------------------------

function finish(legs: Leg[], reach: Reach, result: Result, experimental: boolean): PlanResult {
  const what = legs.map((l) => l.what).join(', then ');
  return {
    ok: true,
    plan: {
      steps: legs.flatMap((l) => l.steps),
      reach,
      result,
      experimental,
      description: `${what} → reach ${reach}, result ${result}${experimental ? ', experimental' : ''}`,
    },
  };
}

/**
 * The plan for one command against one record, or the reason there is none.
 * Rung by rung: `resume` is not in v1; SSH without a multiplexer is remote;
 * a dead agent is not-running; a multiplexer selects its pane first, and the
 * outer app the runtime resolved (facts.outer) is raised after it — with no
 * outer, or an outer the table does not know, the pane is selected and the
 * window stays where it was; without a multiplexer the record's own app is
 * raised by its bundle strategy, or refused when the table has none.
 */
export function plan(record: LocalRecord, type: CommandType, facts: MachineFacts): PlanResult {
  if (type !== 'focus') return fail('unsupported-type');
  // A tmux/herdr server started over SSH and attached locally is not remote (§5.1).
  if (record.env.SSH_CONNECTION && !record.mux) return fail('remote');
  if (!facts.agentAlive) return fail('not-running');

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

/** Arguments that look like long paths are not for the log or the terminal. */
const redact = (arg: string): string => (arg.startsWith('/') && arg.length > 40 ? '<path>' : arg);

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
  lines.push(`reach ${plan.reach}, result ${plan.result}${plan.experimental ? ', experimental' : ''}`);
  return lines.join('\n');
}
