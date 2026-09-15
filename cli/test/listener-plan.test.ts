import { describe, it, expect } from 'vitest';
import path from 'path';
import { OPEN, describe as describePlan, plan } from '../src/listener/plan';
import type { LocalRecord, MachineFacts, Plan, PlanResult, Step } from '../src/listener/types';

/**
 * One test per rung of the ladder (design §5.2, v1 rows), against fixture
 * records and facts — CI has none of these terminals. Every plan that comes
 * back is also checked for the invariants the trust rules demand: argv[0]
 * absolute, every step labelled, and nothing from the record's env in the
 * plan unless a strategy put it there on purpose.
 */

const SESSION = '5a1d2f6e-9b3c-4d7e-8f01-23456789abcd';
/** Marks values that may never show up in a plan. */
const NEVER = 'never-in-a-plan';

const BINS = {
  agtermctl: '/opt/homebrew/bin/agtermctl',
  kitten: '/Applications/kitty.app/Contents/MacOS/kitten',
  wezterm: '/Applications/WezTerm.app/Contents/MacOS/wezterm',
  herdr: '/opt/homebrew/bin/herdr',
  tmux: '/opt/homebrew/bin/tmux',
  zellij: '/opt/homebrew/bin/zellij',
  screen: '/usr/bin/screen',
};

const AGTERM_ENV = {
  TERM_PROGRAM: 'agterm',
  AGTERM_SESSION_ID: '0d8f5c1e-2b7a-4c3d-9e1f-6a5b4c3d2e1f',
  AGTERM_WINDOW_ID: '7c1b9e4a-3f2d-4e5b-8a6c-1d2e3f4a5b6c',
  AGTERM_SOCKET: '/private/tmp/agterm-501/agterm.sock',
};

/** Whitelisted-but-unused keys and a key that is not whitelisted at all: none may reach a plan. */
const LEAKY_ENV = {
  AWS_SECRET_ACCESS_KEY: `AKIA${NEVER}`,
  GHOSTTY_BIN_DIR: `/opt/${NEVER}`,
  TERM_PROGRAM_VERSION: `${NEVER}-9.9`,
  TERM_SESSION_ID: `w0t0p0:${NEVER}`,
};

const BASE: LocalRecord = {
  v: 1,
  session_id: SESSION,
  agent: 'claude',
  agent_pid: 7449,
  agent_comm: 'claude',
  entrypoint: 'cli',
  written_at: 1789286585,
  ended_at: null,
  tty: '/dev/ttys002',
  cwd: `/Users/demo/src/${NEVER}`,
  env: {},
  bins: {},
};

const rec = (over: Partial<LocalRecord> = {}): LocalRecord =>
  ({ ...BASE, ...over, env: { ...LEAKY_ENV, ...(over.env ?? {}) } });

const inApp = (bundle: string, over: Partial<LocalRecord> = {}): LocalRecord =>
  rec({ app: { bundle, pid: 662, via: 'ppid-walk' }, ...over });

const facts = (over: Partial<MachineFacts> = {}): MachineFacts =>
  ({ platform: 'darwin', bins: BINS, agentAlive: true, ...over });

const focus = (record: LocalRecord, f: MachineFacts = facts()): PlanResult => plan(record, 'focus', f);

/** The plan of an ok result, after the invariants every plan must satisfy. */
function ok(result: PlanResult): Plan {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const { plan: p } = result;
  expect(p.steps.length).toBeGreaterThan(0);
  for (const step of p.steps) {
    expect(path.isAbsolute(step.argv[0])).toBe(true);
    expect(step.label).toMatch(/\S/);
  }
  const json = JSON.stringify(p);
  expect(json).not.toContain(NEVER);
  expect(json).not.toContain('AKIA');
  expect(p.description).not.toContain('/');
  return p;
}

const failed = (result: PlanResult, reason: string): void => {
  expect(result).toEqual({ ok: false, reason });
};

const argvs = (p: Plan): string[][] => p.steps.map((s) => s.argv);

/** The launcher the installer writes, and the cwd the runtime resolves and hands the planner. */
const LAUNCHER = '/Users/demo/Library/Application Support/AgStatus/agstatus-resume';
const CWD = '/Users/demo/src/board';
/** Exactly one path and one uuid, and nothing a shell could read as more (design §5.1). */
const COMMAND_STRING_RE = /^'[^']+' [0-9a-f-]{36}$/;

const dead = (over: Partial<MachineFacts> = {}): MachineFacts =>
  facts({ agentAlive: false, launcher: LAUNCHER, ...over });

/** A resume tap. Call plan() directly to leave `resumeCwd` out — the runtime found no directory. */
const resume = (record: LocalRecord, f: MachineFacts = dead(), cwd: string = CWD): PlanResult =>
  plan(record, 'resume', f, cwd);

/** Every plan that starts a session says so, and acks `resumed`. */
function respawned(result: PlanResult): Plan {
  const p = ok(result);
  expect(p).toMatchObject({ respawns: true, result: 'resumed' });
  // Nothing but the launcher is ever started: the uuid is the only argument it gets.
  const launched = p.steps.flatMap((s) => s.argv).filter((a) => a.includes('agstatus-resume'));
  expect(launched.length).toBeGreaterThan(0);
  for (const arg of launched) expect(arg === LAUNCHER || COMMAND_STRING_RE.test(arg)).toBe(true);
  return p;
}

describe('plan: the ladder before any host', () => {
  it('refuses a command type that is neither focus nor resume', () => {
    failed(plan(inApp('com.umputun.agterm', { env: AGTERM_ENV }), 'restart' as never, facts()), 'unsupported-type');
  });

  it('is remote over SSH without a multiplexer, for resume too', () => {
    const record = inApp('com.umputun.agterm', { env: { ...AGTERM_ENV, SSH_CONNECTION: '10.0.0.2 51234 10.0.0.9 22' } });
    failed(resume(record), 'remote');
  });

  it('is remote over SSH without a multiplexer', () => {
    failed(focus(inApp('com.umputun.agterm', { env: { ...AGTERM_ENV, SSH_CONNECTION: '10.0.0.2 51234 10.0.0.9 22' } })), 'remote');
  });

  it('proceeds over SSH when a multiplexer is present (the client may be local)', () => {
    const record = rec({
      env: { SSH_CONNECTION: '10.0.0.2 51234 10.0.0.9 22' },
      mux: { kind: 'tmux', target: 'main:@3.%7', socket: '/private/tmp/tmux-501/default' },
    });
    const p = ok(focus(record, facts({ outer: { bundle: 'com.mitchellh.ghostty' } })));
    expect(p.steps).toHaveLength(4);
    expect(p.reach).toBe('app');
  });

  it('is not-running when the agent is dead, before any host is considered', () => {
    failed(focus(inApp('com.umputun.agterm', { env: AGTERM_ENV }), facts({ agentAlive: false })), 'not-running');
    failed(focus(rec(), facts({ agentAlive: false })), 'not-running');
  });
});

describe('plan: terminals by bundle', () => {
  it('agterm: activates the app, then selects window and session with agtermctl', () => {
    const p = ok(focus(inApp('com.umputun.agterm', { env: AGTERM_ENV })));
    expect(argvs(p)).toEqual([
      [OPEN, '-b', 'com.umputun.agterm'],
      [BINS.agtermctl, 'window', 'select', AGTERM_ENV.AGTERM_WINDOW_ID, '--socket', AGTERM_ENV.AGTERM_SOCKET],
      [BINS.agtermctl, 'session', 'select', '--target', AGTERM_ENV.AGTERM_SESSION_ID,
        '--window', AGTERM_ENV.AGTERM_WINDOW_ID, '--socket', AGTERM_ENV.AGTERM_SOCKET],
    ]);
    expect(p.steps.map((s) => s.expectFrontmost)).toEqual([undefined, undefined, 'com.umputun.agterm']);
    expect(p).toMatchObject({ reach: 'pane', result: 'focused', experimental: false });
  });

  it('agterm: falls back to the app when an id or agtermctl is missing', () => {
    const { AGTERM_SESSION_ID: _dropped, ...partial } = AGTERM_ENV;
    void _dropped;
    const noId = ok(focus(inApp('com.umputun.agterm', { env: partial })));
    expect(argvs(noId)).toEqual([[OPEN, '-b', 'com.umputun.agterm']]);
    expect(noId).toMatchObject({ reach: 'app', result: 'activated', experimental: false });
    const noCtl = ok(focus(inApp('com.umputun.agterm', { env: AGTERM_ENV }), facts({ bins: {} })));
    expect(argvs(noCtl)).toEqual([[OPEN, '-b', 'com.umputun.agterm']]);
    // An id that fails its regex is treated as missing, never passed through.
    const badId = ok(focus(inApp('com.umputun.agterm', { env: { ...AGTERM_ENV, AGTERM_WINDOW_ID: `../${NEVER}` } })));
    expect(argvs(badId)).toEqual([[OPEN, '-b', 'com.umputun.agterm']]);
  });

  it('kitty: focuses the window over the unix socket, or activates the app without one', () => {
    const p = ok(focus(inApp('net.kovidgoyal.kitty', { env: { KITTY_LISTEN_ON: 'unix:/tmp/kitty-501', KITTY_WINDOW_ID: '3' } })));
    expect(argvs(p)).toEqual([[BINS.kitten, '@', '--to', 'unix:/tmp/kitty-501', 'focus-window', '--match', 'id:3']]);
    expect(p.steps[0].expectFrontmost).toBe('net.kovidgoyal.kitty');
    expect(p).toMatchObject({ reach: 'pane', result: 'focused', experimental: false });

    for (const env of [
      { KITTY_WINDOW_ID: '3' },
      { KITTY_LISTEN_ON: 'fd:5', KITTY_WINDOW_ID: '3' },
      { KITTY_LISTEN_ON: 'unix:/tmp/kitty-501', KITTY_WINDOW_ID: 'three' },
    ]) {
      const app = ok(focus(inApp('net.kovidgoyal.kitty', { env })));
      expect(argvs(app)).toEqual([[OPEN, '-b', 'net.kovidgoyal.kitty']]);
      expect(app).toMatchObject({ reach: 'app', result: 'activated' });
    }
    expect(argvs(ok(focus(inApp('net.kovidgoyal.kitty', { env: { KITTY_LISTEN_ON: 'unix:/tmp/kitty-501', KITTY_WINDOW_ID: '3' } }), facts({ bins: {} })))))
      .toEqual([[OPEN, '-b', 'net.kovidgoyal.kitty']]);
  });

  it('iTerm2: reveals the session by URL, experimental', () => {
    const id = 'w0t1p2:0D8F5C1E-2B7A-4C3D-9E1F-6A5B4C3D2E1F';
    const p = ok(focus(inApp('com.googlecode.iterm2', { env: { ITERM_SESSION_ID: id } })));
    expect(argvs(p)).toEqual([[OPEN, `iterm2:reveal?sessionid=${id}`]]);
    expect(p).toMatchObject({ reach: 'pane', result: 'focused', experimental: true });
    const app = ok(focus(inApp('com.googlecode.iterm2', { env: { ITERM_SESSION_ID: 'w0t1p2:not-a-uuid' } })));
    expect(argvs(app)).toEqual([[OPEN, '-b', 'com.googlecode.iterm2']]);
    expect(app.experimental).toBe(false);
  });

  it('WezTerm: activates the app, then the pane through the CLI with its socket, experimental', () => {
    const env = { WEZTERM_PANE: '12', WEZTERM_UNIX_SOCKET: '/Users/demo/.local/share/wezterm/gui-sock-501' };
    const p = ok(focus(inApp('com.github.wez.wezterm', { env })));
    expect(argvs(p)).toEqual([
      [OPEN, '-b', 'com.github.wez.wezterm'],
      [BINS.wezterm, 'cli', 'activate-pane', '--pane-id', '12'],
    ]);
    expect(p.steps[1].env).toEqual({ WEZTERM_UNIX_SOCKET: env.WEZTERM_UNIX_SOCKET });
    expect(p.steps[1].expectFrontmost).toBe('com.github.wez.wezterm');
    expect(p).toMatchObject({ reach: 'pane', result: 'focused', experimental: true });

    const noSocket = ok(focus(inApp('com.github.wez.wezterm', { env: { WEZTERM_PANE: '12' } })));
    expect(noSocket.steps[1].env).toBeUndefined();
    const noBin = ok(focus(inApp('com.github.wez.wezterm', { env }), facts({ bins: {} })));
    expect(argvs(noBin)).toEqual([[OPEN, '-b', 'com.github.wez.wezterm']]);
    expect(noBin).toMatchObject({ reach: 'app', result: 'activated', experimental: false });
  });

  it('Terminal.app and Ghostty degrade to the app level (AppleScript waits for the signed sender)', () => {
    for (const bundle of ['com.apple.Terminal', 'com.mitchellh.ghostty', 'org.alacritty', 'dev.warp.Warp-Stable', 'co.zeit.hyper']) {
      const p = ok(focus(inApp(bundle, { env: { TERM_PROGRAM: 'Apple_Terminal', GHOSTTY_SURFACE_ID: 'x' } })));
      expect(argvs(p)).toEqual([[OPEN, '-b', bundle]]);
      expect(p.steps[0].expectFrontmost).toBe(bundle);
      expect(p).toMatchObject({ reach: 'app', result: 'activated', experimental: false });
    }
  });
});

describe('plan: desktop apps and IDEs', () => {
  it('Codex Desktop: opens the thread deep link, preferring thread_id', () => {
    const codex = { thread_id: '0198a7b2-1111-7000-8000-aaaaaaaaaaaa', root_thread_id: '0198a7b2-2222-7000-8000-bbbbbbbbbbbb' };
    const p = ok(focus(inApp('com.openai.codex', { agent: 'codex', entrypoint: 'codex-desktop', codex })));
    expect(argvs(p)).toEqual([[OPEN, '-b', 'com.openai.codex', `codex://threads/${codex.thread_id}`]]);
    expect(p).toMatchObject({ reach: 'thread', result: 'focused', experimental: false });
    const root = ok(focus(inApp('com.openai.codex', { agent: 'codex', codex: { root_thread_id: codex.root_thread_id } })));
    expect(argvs(root)).toEqual([[OPEN, '-b', 'com.openai.codex', `codex://threads/${codex.root_thread_id}`]]);
  });

  it('Codex Desktop: uses the session id when the record has no thread ids', () => {
    const p = ok(focus(inApp('com.openai.codex', { agent: 'codex' })));
    expect(argvs(p)).toEqual([[OPEN, '-b', 'com.openai.codex', `codex://threads/${SESSION}`]]);
  });

  it('Codex Desktop: a thread id outside the regex is a bad record, never a URL', () => {
    failed(focus(inApp('com.openai.codex', { agent: 'codex', codex: { thread_id: 'not a thread!' } })), 'bad-record');
    failed(focus(inApp('com.openai.codex', { agent: 'codex', codex: { thread_id: `x?redirect=${NEVER}` } })), 'bad-record');
    failed(focus(inApp('com.openai.codex', { agent: 'codex', session_id: 'msg-test' })), 'bad-record');
  });

  it('Claude Desktop: activates the app', () => {
    const p = ok(focus(inApp('com.anthropic.claudefordesktop', { entrypoint: 'claude-desktop' })));
    expect(argvs(p)).toEqual([[OPEN, '-b', 'com.anthropic.claudefordesktop']]);
    expect(p).toMatchObject({ reach: 'app', result: 'activated', experimental: false });
  });

  it('JetBrains: opens the project root when known, else the app', () => {
    const root = '/Users/demo/src/board';
    const withRoot = ok(focus(inApp('com.jetbrains.intellij', { project_root: root })));
    expect(argvs(withRoot)).toEqual([[OPEN, '-b', 'com.jetbrains.intellij', root]]);
    expect(withRoot).toMatchObject({ reach: 'window', result: 'focused', experimental: false });
    const without = ok(focus(inApp('com.jetbrains.pycharm')));
    expect(argvs(without)).toEqual([[OPEN, '-b', 'com.jetbrains.pycharm']]);
    expect(without).toMatchObject({ reach: 'app', result: 'activated', experimental: false });
    const studio = ok(focus(inApp('com.google.android.studio', { project_root: root })));
    expect(studio.reach).toBe('window');
    // A root that is not an absolute path never becomes an argument.
    const bad = ok(focus(inApp('com.jetbrains.intellij', { project_root: 'src/board' })));
    expect(argvs(bad)).toEqual([[OPEN, '-b', 'com.jetbrains.intellij']]);
  });

  it('Zed: same shape as JetBrains', () => {
    const p = ok(focus(inApp('dev.zed.Zed', { project_root: '/Users/demo/src/board' })));
    expect(argvs(p)).toEqual([[OPEN, '-b', 'dev.zed.Zed', '/Users/demo/src/board']]);
    expect(p).toMatchObject({ reach: 'window', result: 'focused' });
    expect(ok(focus(inApp('dev.zed.Zed-Preview'))).reach).toBe('app');
  });

  it('VS Code, Cursor and Windsurf: the app, until the lock file strategy lands', () => {
    for (const bundle of ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.todesktop.230313mzl4w4u92', 'com.exafunction.windsurf']) {
      const p = ok(focus(inApp(bundle, { project_root: '/Users/demo/src/board', env: { VSCODE_PID: '4242' } })));
      expect(argvs(p)).toEqual([[OPEN, '-b', bundle]]);
      expect(p).toMatchObject({ reach: 'app', result: 'activated', experimental: false });
    }
  });

  it('a bundle outside the table never reaches open -b, whether the process tree or the env named it', () => {
    failed(focus(inApp('com.example.someterm')), 'unsupported-host');
    failed(focus(rec({ app: { bundle: 'com.example.someterm', via: 'env' } })), 'unsupported-host');
    // Close cousins of table entries are not entries.
    failed(focus(inApp('com.apple.Terminal2')), 'unsupported-host');
    failed(focus(inApp('org.jetbrains.intellij')), 'unsupported-host');
    const known = ok(focus(rec({ app: { bundle: 'com.apple.Terminal', via: 'env' } })));
    expect(argvs(known)).toEqual([[OPEN, '-b', 'com.apple.Terminal']]);
    expect(argvs(ok(focus(inApp('com.apple.dt.Xcode'))))).toEqual([[OPEN, '-b', 'com.apple.dt.Xcode']]);
  });

  it('no bundle at all is an unsupported host; a malformed one is a bad record', () => {
    failed(focus(rec()), 'unsupported-host');
    failed(focus(rec({ app: { via: 'ppid-walk', pid: 662 } })), 'unsupported-host');
    failed(focus(rec({ app: { bundle: 'com example', via: 'ppid-walk' } })), 'bad-record');
  });
});

describe('plan: multiplexers', () => {
  const HERDR = { kind: 'herdr' as const, target: 'w1:p3', tab: 'w1:t1', workspace: 'w1', socket: '/tmp/herdr-501/herdr.sock' };
  const TMUX = { kind: 'tmux' as const, target: 'main:@3.%7', socket: '/private/tmp/tmux-501/default' };

  it('herdr with an outer agterm: focuses the pane, then runs the agterm steps', () => {
    const outer = { bundle: 'com.umputun.agterm', tty: '/dev/ttys004', env: { ...AGTERM_ENV, AWS_SECRET_ACCESS_KEY: `AKIA${NEVER}` } };
    const p = ok(focus(rec({ mux: HERDR }), facts({ outer })));
    expect(argvs(p)).toEqual([
      [BINS.herdr, 'agent', 'focus', 'w1:p3'],
      [OPEN, '-b', 'com.umputun.agterm'],
      [BINS.agtermctl, 'window', 'select', AGTERM_ENV.AGTERM_WINDOW_ID, '--socket', AGTERM_ENV.AGTERM_SOCKET],
      [BINS.agtermctl, 'session', 'select', '--target', AGTERM_ENV.AGTERM_SESSION_ID,
        '--window', AGTERM_ENV.AGTERM_WINDOW_ID, '--socket', AGTERM_ENV.AGTERM_SOCKET],
    ]);
    expect(p.steps[0].env).toEqual({ HERDR_SOCKET_PATH: HERDR.socket });
    expect(p.steps[0].label).toBe('herdr: focus pane');
    expect(p).toMatchObject({ reach: 'pane', result: 'focused', experimental: true });
  });

  it('herdr with no resolvable outer app: the pane is selected and the window stays put', () => {
    const p = ok(focus(rec({ mux: HERDR })));
    expect(argvs(p)).toEqual([[BINS.herdr, 'agent', 'focus', 'w1:p3']]);
    expect(p).toMatchObject({ reach: 'pane', result: 'selected', experimental: true });
  });

  it('herdr: the outer app\'s env is validated like the record\'s', () => {
    const outer = { bundle: 'com.umputun.agterm', env: { ...AGTERM_ENV, AGTERM_SESSION_ID: `'; ${NEVER}` } };
    const p = ok(focus(rec({ mux: HERDR }), facts({ outer })));
    expect(argvs(p)).toEqual([[BINS.herdr, 'agent', 'focus', 'w1:p3'], [OPEN, '-b', 'com.umputun.agterm']]);
    expect(p).toMatchObject({ reach: 'app', result: 'activated' });
  });

  it('herdr: a missing socket or target is a bad record; a missing binary an unsupported host', () => {
    failed(focus(rec({ mux: { kind: 'herdr', target: 'w1:p3' } })), 'bad-record');
    failed(focus(rec({ mux: { kind: 'herdr', socket: HERDR.socket } })), 'bad-record');
    failed(focus(rec({ mux: { ...HERDR, socket: 'herdr.sock' } })), 'bad-record');
    failed(focus(rec({ mux: { ...HERDR, target: 'w1:t3' } })), 'bad-record');
    failed(focus(rec({ mux: HERDR }), facts({ bins: { herdr: 'herdr' } })), 'unsupported-host');
    failed(focus(rec({ mux: HERDR }), facts({ bins: {} })), 'unsupported-host');
  });

  it('tmux: parses session:@window.%pane into select-window, select-pane and an optional switch-client', () => {
    const p = ok(focus(rec({ mux: TMUX })));
    expect(argvs(p)).toEqual([
      [BINS.tmux, '-S', TMUX.socket, 'select-window', '-t', '@3'],
      [BINS.tmux, '-S', TMUX.socket, 'select-pane', '-t', '%7'],
      [BINS.tmux, '-S', TMUX.socket, 'switch-client', '-t', 'main'],
    ]);
    expect(p.steps.map((s) => s.optional)).toEqual([undefined, undefined, true]);
    expect(p).toMatchObject({ reach: 'pane', result: 'selected', experimental: true });
    // The sigils are optional in the recipe and always present in the argv.
    const bare = ok(focus(rec({ mux: { ...TMUX, target: 'work.2:3.7' } })));
    expect(argvs(bare).map((a) => a[5])).toEqual(['@3', '%7', 'work.2']);
  });

  it('tmux with an outer terminal: the mux steps first, then the app; experimental only if the app is', () => {
    const p = ok(focus(rec({ mux: TMUX }), facts({ outer: { bundle: 'com.mitchellh.ghostty', tty: '/dev/ttys004' } })));
    expect(argvs(p)[3]).toEqual([OPEN, '-b', 'com.mitchellh.ghostty']);
    expect(p).toMatchObject({ reach: 'app', result: 'activated', experimental: false });
    const kitty = ok(focus(rec({ mux: TMUX }), facts({
      outer: { bundle: 'net.kovidgoyal.kitty', env: { KITTY_LISTEN_ON: 'unix:/tmp/kitty-501', KITTY_WINDOW_ID: '2' } },
    })));
    expect(argvs(kitty)[3]).toEqual([BINS.kitten, '@', '--to', 'unix:/tmp/kitty-501', 'focus-window', '--match', 'id:2']);
    expect(kitty).toMatchObject({ reach: 'pane', result: 'focused', experimental: false });
    // An outer app the table does not know is left alone: the pane is selected, no open -b for it.
    const unlisted = ok(focus(rec({ mux: TMUX }), facts({ outer: { bundle: 'com.example.someterm' } })));
    expect(argvs(unlisted).map((a) => a[0])).toEqual([BINS.tmux, BINS.tmux, BINS.tmux]);
    expect(JSON.stringify(unlisted)).not.toContain('com.example.someterm');
    expect(unlisted).toMatchObject({ reach: 'pane', result: 'selected', experimental: true });
    failed(focus(rec({ mux: TMUX }), facts({ outer: { bundle: 'com example' } })), 'bad-record');
  });

  it('tmux: a missing or malformed target or socket is a bad record; no tmux binary is an unsupported host', () => {
    failed(focus(rec({ mux: { kind: 'tmux', socket: TMUX.socket } })), 'bad-record');
    failed(focus(rec({ mux: { ...TMUX, target: 'main:@3' } })), 'bad-record');
    failed(focus(rec({ mux: { ...TMUX, target: `main:@3.%7 ${NEVER}` } })), 'bad-record');
    failed(focus(rec({ mux: { ...TMUX, socket: 'default' } })), 'bad-record');
    failed(focus(rec({ mux: TMUX }), facts({ bins: { herdr: BINS.herdr } })), 'unsupported-host');
  });

  it('zellij and screen: select inside the multiplexer, experimental', () => {
    const zellij = ok(focus(rec({ mux: { kind: 'zellij', target: '4', session: 'dev' } })));
    expect(argvs(zellij)).toEqual([[BINS.zellij, '--session', 'dev', 'action', 'focus-pane-id', '4']]);
    expect(zellij).toMatchObject({ reach: 'pane', result: 'selected', experimental: true });
    const screen = ok(focus(rec({ mux: { kind: 'screen', target: '2', session: '12345.ttys002.studio' } }), facts({ outer: { bundle: 'com.apple.Terminal' } })));
    expect(argvs(screen)).toEqual([[BINS.screen, '-S', '12345.ttys002.studio', '-X', 'select', '2'], [OPEN, '-b', 'com.apple.Terminal']]);
    expect(screen).toMatchObject({ reach: 'app', result: 'activated', experimental: true });
    failed(focus(rec({ mux: { kind: 'zellij', target: '4' } })), 'bad-record');
    failed(focus(rec({ mux: { kind: 'screen', session: '12345.ttys002.studio' } })), 'bad-record');
    failed(focus(rec({ mux: { kind: 'zellij', target: '4', session: 'dev' } }), facts({ bins: {} })), 'unsupported-host');
    failed(focus(rec({ mux: { kind: 'screen', target: '2', session: 'x' } }), facts({ bins: {} })), 'unsupported-host');
  });
});

describe('plan: resume, one row per host (§5.2 step 4)', () => {
  const HERDR = { kind: 'herdr' as const, target: 'w1:p3', socket: '/tmp/herdr-501/herdr.sock' };
  const TMUX = { kind: 'tmux' as const, target: 'main:@3.%7', socket: '/private/tmp/tmux-501/default' };
  const AGTERM = inApp('com.umputun.agterm', { env: AGTERM_ENV });

  it('a live session is the focus plan, whichever button was tapped', () => {
    const live = facts({ launcher: LAUNCHER });
    const p = ok(plan(AGTERM, 'resume', live, CWD));
    expect(argvs(p)).toEqual(argvs(ok(focus(AGTERM, live))));
    expect(p).toMatchObject({ reach: 'pane', result: 'focused' });
    expect(p.respawns).toBeFalsy();
    // and it needs neither a launcher nor a working directory to do it
    const bare = ok(plan(AGTERM, 'resume', facts(), undefined));
    expect(argvs(bare)).toEqual(argvs(ok(focus(AGTERM))));
    expect(bare.respawns).toBeFalsy();
    const muxed = ok(plan(rec({ mux: TMUX }), 'resume', facts({ outer: { bundle: 'com.mitchellh.ghostty' } })));
    expect(argvs(muxed)).toEqual(argvs(ok(focus(rec({ mux: TMUX }), facts({ outer: { bundle: 'com.mitchellh.ghostty' } })))));
  });

  it('with no launcher on this machine, every resume row is an unsupported host', () => {
    failed(resume(AGTERM, facts({ agentAlive: false })), 'unsupported-host');
    // a relative path is not a launcher
    failed(resume(AGTERM, facts({ agentAlive: false, launcher: 'agstatus-resume' })), 'unsupported-host');
    failed(resume(rec({ mux: TMUX }), facts({ agentAlive: false })), 'unsupported-host');
    failed(resume(inApp('com.openai.codex', { agent: 'codex' }), facts({ agentAlive: false })), 'unsupported-host');
  });

  it('with no working directory from the runtime, the respawn fails instead of guessing one', () => {
    failed(plan(AGTERM, 'resume', dead()), 'respawn-failed');
    failed(resume(AGTERM, dead(), 'src/board'), 'respawn-failed');
    failed(plan(rec({ mux: TMUX }), 'resume', dead()), 'respawn-failed');
    failed(plan(inApp('com.mitchellh.ghostty'), 'resume', dead()), 'respawn-failed');
    // the planner resolves none of its own: the record's cwd never appears in a plan
    expect(JSON.stringify(ok(resume(AGTERM)))).not.toContain(NEVER);
  });

  it('a session id that is not a uuid never reaches the launcher', () => {
    failed(resume(rec({ session_id: 'msg-test', app: { bundle: 'com.umputun.agterm', via: 'env' }, env: AGTERM_ENV })), 'bad-record');
    failed(resume(rec({ session_id: 'msg-test', mux: TMUX })), 'bad-record');
  });

  it('headless runs are never respawned in a terminal', () => {
    for (const entrypoint of ['sdk-cli', 'codex-exec']) {
      failed(resume(inApp('com.umputun.agterm', { entrypoint, env: AGTERM_ENV })), 'unsupported-type');
      failed(resume(rec({ entrypoint, mux: TMUX })), 'unsupported-type');
    }
    // a live one is still focused: focus never starts anything, so it is safe
    expect(ok(plan(inApp('com.umputun.agterm', { entrypoint: 'sdk-cli', env: AGTERM_ENV }), 'resume', facts({ launcher: LAUNCHER }), CWD)).reach)
      .toBe('pane');
  });

  it('Claude Desktop: the app comes to the front, and nothing is started', () => {
    const p = ok(resume(inApp('com.anthropic.claudefordesktop', { entrypoint: 'claude-desktop' })));
    expect(argvs(p)).toEqual([[OPEN, '-b', 'com.anthropic.claudefordesktop']]);
    expect(p).toMatchObject({ reach: 'app', result: 'activated', experimental: false });
    expect(p.respawns).toBeFalsy();
    // the entrypoint decides it, whatever app the ppid walk landed on
    const viaEntrypoint = ok(resume(inApp('com.apple.Terminal', { entrypoint: 'claude-desktop' })));
    expect(argvs(viaEntrypoint)).toEqual([[OPEN, '-b', 'com.anthropic.claudefordesktop']]);
  });

  it('agterm: one `session new` carrying the launcher, then the app', () => {
    const p = respawned(resume(AGTERM));
    expect(argvs(p)).toEqual([
      [BINS.agtermctl, 'session', 'new', '--cwd', CWD, '--command', `'${LAUNCHER}' ${SESSION}`,
        '--socket', AGTERM_ENV.AGTERM_SOCKET],
      [OPEN, '-b', 'com.umputun.agterm'],
    ]);
    expect(p.steps[0].argv[6]).toMatch(COMMAND_STRING_RE);
    expect(p.steps[1].expectFrontmost).toBe('com.umputun.agterm');
    expect(p).toMatchObject({ reach: 'pane', result: 'resumed', respawns: true, experimental: true });
  });

  it('agterm: no agtermctl, no socket, or a launcher path that cannot be quoted, and the row is refused', () => {
    failed(resume(AGTERM, dead({ bins: {} })), 'unsupported-host');
    const { AGTERM_SOCKET: _dropped, ...noSocket } = AGTERM_ENV;
    void _dropped;
    failed(resume(inApp('com.umputun.agterm', { env: noSocket })), 'unsupported-host');
    failed(resume(AGTERM, dead({ launcher: "/Users/o'brien/AgStatus/agstatus-resume" })), 'unsupported-host');
  });

  it('kitty: launches an os-window over the socket, argv only', () => {
    const env = { KITTY_LISTEN_ON: 'unix:/tmp/kitty-501', KITTY_WINDOW_ID: '3' };
    const p = respawned(resume(inApp('net.kovidgoyal.kitty', { env })));
    expect(argvs(p)).toEqual([
      [BINS.kitten, '@', '--to', 'unix:/tmp/kitty-501', 'launch', '--type=os-window', `--cwd=${CWD}`, LAUNCHER, SESSION],
    ]);
    expect(p).toMatchObject({ reach: 'pane', result: 'resumed', experimental: true });
  });

  it('kitty without remote control falls through to the generic terminal row', () => {
    const generic = [[OPEN, '-n', '-b', 'net.kovidgoyal.kitty', '--args', `--working-directory=${CWD}`, '-e', LAUNCHER, SESSION]];
    expect(argvs(respawned(resume(inApp('net.kovidgoyal.kitty', { env: { KITTY_WINDOW_ID: '3' } }))))).toEqual(generic);
    const noKitten = resume(inApp('net.kovidgoyal.kitty', { env: { KITTY_LISTEN_ON: 'unix:/tmp/kitty-501' } }), dead({ bins: {} }));
    expect(argvs(respawned(noKitten))).toEqual(generic);
  });

  it('WezTerm: spawns a new window through the CLI, argv after --', () => {
    const env = { WEZTERM_PANE: '12', WEZTERM_UNIX_SOCKET: '/Users/demo/.local/share/wezterm/gui-sock-501' };
    const p = respawned(resume(inApp('com.github.wez.wezterm', { env })));
    expect(argvs(p)).toEqual([[BINS.wezterm, 'cli', 'spawn', '--new-window', '--cwd', CWD, '--', LAUNCHER, SESSION]]);
    expect(p.steps[0].env).toEqual({ WEZTERM_UNIX_SOCKET: env.WEZTERM_UNIX_SOCKET });
    expect(p).toMatchObject({ reach: 'pane', result: 'resumed', experimental: true });
    const noSocket = respawned(resume(inApp('com.github.wez.wezterm', { env: { WEZTERM_PANE: '12' } })));
    expect(noSocket.steps[0].env).toBeUndefined();
    failed(resume(inApp('com.github.wez.wezterm', { env }), dead({ bins: {} })), 'unsupported-host');
  });

  it('Ghostty, Alacritty and Rio: a new window through open, the launcher as its command', () => {
    for (const bundle of ['com.mitchellh.ghostty', 'org.alacritty', 'com.raphaelamorim.rio']) {
      const p = respawned(resume(inApp(bundle)));
      expect(argvs(p)).toEqual([[OPEN, '-n', '-b', bundle, '--args', `--working-directory=${CWD}`, '-e', LAUNCHER, SESSION]]);
      expect(p.steps[0].expectFrontmost).toBe(bundle);
      expect(p).toMatchObject({ reach: 'window', result: 'resumed', experimental: true });
    }
    // The bundle comes from the table; the record's own app.path is never read (§5.1).
    const withPath = respawned(resume(inApp('com.mitchellh.ghostty', {
      app: { bundle: 'com.mitchellh.ghostty', path: `/Applications/${NEVER}.app`, via: 'ppid-walk' },
    })));
    expect(argvs(withPath)).toEqual([
      [OPEN, '-n', '-b', 'com.mitchellh.ghostty', '--args', `--working-directory=${CWD}`, '-e', LAUNCHER, SESSION],
    ]);
  });

  it('Terminal.app and iTerm2 wait for the signed sender instead of building a shell string', () => {
    failed(resume(inApp('com.apple.Terminal', { env: { TERM_PROGRAM: 'Apple_Terminal' } })), 'unsupported-host');
    const id = 'w0t1p2:0D8F5C1E-2B7A-4C3D-9E1F-6A5B4C3D2E1F';
    failed(resume(inApp('com.googlecode.iterm2', { env: { ITERM_SESSION_ID: id } })), 'unsupported-host');
  });

  it('IDEs, Warp and the rest of the open -b table have no respawn at all', () => {
    for (const bundle of [
      'com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.todesktop.230313mzl4w4u92',
      'com.exafunction.windsurf', 'com.jetbrains.intellij', 'dev.zed.Zed', 'dev.zed.Zed-Preview',
      'com.google.android.studio', 'dev.warp.Warp-Stable', 'co.zeit.hyper', 'org.tabby',
      'com.apple.dt.Xcode', 'com.example.someterm',
    ]) {
      failed(resume(inApp(bundle, { project_root: CWD })), 'unsupported-host');
    }
    failed(resume(rec()), 'unsupported-host');
    failed(resume(rec({ app: { bundle: 'com example', via: 'ppid-walk' } })), 'bad-record');
  });

  it('Codex Desktop: the deep link reopens the thread, archived or not, and starts nothing', () => {
    const codex = { thread_id: '0198a7b2-1111-7000-8000-aaaaaaaaaaaa', root_thread_id: '0198a7b2-2222-7000-8000-bbbbbbbbbbbb' };
    const p = ok(resume(inApp('com.openai.codex', { agent: 'codex', entrypoint: 'codex-desktop', codex })));
    expect(argvs(p)).toEqual([[OPEN, '-b', 'com.openai.codex', `codex://threads/${codex.thread_id}`]]);
    expect(p).toMatchObject({ reach: 'thread', result: 'resumed', experimental: false });
    expect(p.respawns).toBeFalsy();
    failed(resume(inApp('com.openai.codex', { agent: 'codex', codex: { thread_id: 'not a thread!' } })), 'bad-record');
  });

  it('tmux: a new window in the session that died, then the outer terminal as a focus raises it', () => {
    const p = respawned(resume(rec({ mux: TMUX }), dead({ outer: { bundle: 'com.mitchellh.ghostty' } })));
    // `-t main:` — without it the window lands in whatever session the server
    // calls current, and the terminal is then raised showing the wrong one.
    expect(argvs(p)).toEqual([
      [BINS.tmux, '-S', TMUX.socket, 'new-window', '-t', 'main:', '-c', CWD, `'${LAUNCHER}' ${SESSION}`],
      [OPEN, '-b', 'com.mitchellh.ghostty'],
    ]);
    expect(p.steps[0].argv[8]).toMatch(COMMAND_STRING_RE);
    expect(p).toMatchObject({ reach: 'pane', result: 'resumed', experimental: true });
    // Everything after the step that started the agent is best-effort: a
    // raise that fails must not report that nothing came up.
    expect(p.steps[0].optional).toBeFalsy();
    expect(p.steps.slice(1).every((step) => step.optional === true)).toBe(true);
    // the outer app's own focus row runs after the new window, exactly as for a focus
    const viaAgterm = respawned(resume(rec({ mux: TMUX }), dead({ outer: { bundle: 'com.umputun.agterm', env: AGTERM_ENV } })));
    expect(argvs(viaAgterm).map((a) => a[0])).toEqual([BINS.tmux, OPEN, BINS.agtermctl, BINS.agtermctl]);
    expect(viaAgterm.steps.slice(1).every((step) => step.optional === true)).toBe(true);
    // no outer app: the session is back in its pane and the window stays where it was
    const alone = respawned(resume(rec({ mux: TMUX })));
    expect(argvs(alone)).toEqual([
      [BINS.tmux, '-S', TMUX.socket, 'new-window', '-t', 'main:', '-c', CWD, `'${LAUNCHER}' ${SESSION}`],
    ]);
    expect(alone.reach).toBe('pane');
  });

  it('tmux: a target that does not name its session is a bad record, like the focus row', () => {
    failed(resume(rec({ mux: { kind: 'tmux', target: 'main@3.%7', socket: TMUX.socket } })), 'bad-record');
    failed(resume(rec({ mux: { kind: 'tmux', socket: TMUX.socket } })), 'bad-record');
  });

  it('tmux: no socket is a bad record; no tmux, or a launcher that cannot be quoted, an unsupported host', () => {
    failed(resume(rec({ mux: { kind: 'tmux', target: TMUX.target } })), 'bad-record');
    failed(resume(rec({ mux: TMUX }), dead({ bins: {} })), 'unsupported-host');
    failed(resume(rec({ mux: TMUX }), dead({ launcher: "/Users/o'brien/agstatus-resume" })), 'unsupported-host');
  });

  it('herdr: `agent start` with the launcher as argv after --, labelled by the record agent', () => {
    const p = respawned(resume(rec({ mux: HERDR })));
    expect(argvs(p)).toEqual([[BINS.herdr, 'agent', 'start', 'claude', '--cwd', CWD, '--focus', '--', LAUNCHER, SESSION]]);
    expect(p.steps[0].env).toEqual({ HERDR_SOCKET_PATH: HERDR.socket });
    expect(p).toMatchObject({ reach: 'pane', result: 'resumed', experimental: true });
    expect(argvs(respawned(resume(rec({ agent: 'codex', mux: HERDR }))))[0][3]).toBe('codex');
    failed(resume(rec({ mux: { kind: 'herdr', target: 'w1:p3' } })), 'bad-record');
    failed(resume(rec({ mux: HERDR }), dead({ bins: {} })), 'unsupported-host');
  });

  it('zellij and screen have no v1 respawn', () => {
    failed(resume(rec({ mux: { kind: 'zellij', target: '4', session: 'dev' } })), 'unsupported-host');
    failed(resume(rec({ mux: { kind: 'screen', target: '2', session: '12345.ttys002.studio' } })), 'unsupported-host');
  });

  it('nothing from the record env reaches a respawn plan unless a strategy whitelisted it', () => {
    const env = { ...LEAKY_ENV, KITTY_LISTEN_ON: 'unix:/tmp/kitty-501', TERM_PROGRAM: `kitty-${NEVER}` };
    const json = JSON.stringify(respawned(resume(inApp('net.kovidgoyal.kitty', { env }))));
    for (const [key, value] of Object.entries(env)) {
      if (key === 'KITTY_LISTEN_ON') continue;
      expect(json).not.toContain(value);
    }
  });
});

describe('describe', () => {
  it('prints one line per step, redacts long paths, and ends with the reach', () => {
    const socket = '/Users/demo/Library/Application Support/agterm/control.sock';
    const p = ok(focus(inApp('com.umputun.agterm', { env: { ...AGTERM_ENV, AGTERM_SOCKET: socket } })));
    const text = describePlan(p);
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('1. open: activate app: /usr/bin/open -b com.umputun.agterm');
    expect(lines[1]).toBe(`2. agtermctl: select window: ${BINS.agtermctl} window select ${AGTERM_ENV.AGTERM_WINDOW_ID} --socket <path>`);
    expect(lines[2]).toContain('(expect frontmost com.umputun.agterm)');
    expect(lines[3]).toBe('reach pane, result focused');
    expect(text).not.toContain(socket);
    expect(text).not.toContain('Application Support');
  });

  it('names env keys and optional steps, never env values', () => {
    // The socket is whitelisted into the step's env on purpose; describe() prints the key, never the value.
    const socket = '/tmp/herdr-501/private-socket-name/herdr.sock';
    const p = ok(focus(rec({ mux: { kind: 'herdr', target: 'w1:p3', socket } })));
    expect(p.steps[0].env).toEqual({ HERDR_SOCKET_PATH: socket });
    const text = describePlan(p);
    expect(text).toContain('(env HERDR_SOCKET_PATH)');
    expect(text).not.toContain('private-socket-name');
    expect(text.split('\n').at(-1)).toBe('reach pane, result selected, experimental');
    const tmux = ok(focus(rec({ mux: { kind: 'tmux', target: 'main:@3.%7', socket: '/private/tmp/tmux-501/default' } })));
    expect(describePlan(tmux)).toContain('switch-client -t main (optional)');
  });

  it('renders a respawn: the command string stays one path and one uuid, and the summary says so', () => {
    const long = '/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/board';
    const p = respawned(resume(inApp('com.umputun.agterm', { env: AGTERM_ENV }), dead(), long));
    const lines = describePlan(p).split('\n');
    expect(lines[0]).toBe(`1. agtermctl: new session: ${BINS.agtermctl} session new --cwd <path> `
      + `--command '<path>' ${SESSION} --socket ${AGTERM_ENV.AGTERM_SOCKET}`);
    expect(lines[1]).toBe('2. open: activate app: /usr/bin/open -b com.umputun.agterm '
      + '(optional; expect frontmost com.umputun.agterm)');
    expect(lines[2]).toBe('reach pane, result resumed, starts a new session, experimental');
    expect(lines.join('\n')).not.toContain(LAUNCHER);
    expect(lines.join('\n')).not.toContain(long);
  });

  it('redacts the directory behind a --working-directory= flag, and the launcher in front of the uuid', () => {
    const long = '/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/board';
    const text = describePlan(respawned(resume(inApp('com.mitchellh.ghostty'), dead(), long)));
    expect(text.split('\n')[0]).toBe('1. open: new terminal window: /usr/bin/open -n -b com.mitchellh.ghostty '
      + `--args --working-directory=<path> -e <path> ${SESSION} (expect frontmost com.mitchellh.ghostty)`);
    expect(text).not.toContain(long);
    expect(text).not.toContain(LAUNCHER);
  });

  it('redacts only long absolute paths', () => {
    const step: Step = { argv: [OPEN, '-b', 'x.y', '/short/path', `/${'a'.repeat(40)}`], label: 'l' };
    const text = describePlan({ steps: [step], reach: 'app', result: 'activated', experimental: false, description: '' });
    expect(text.split('\n')[0]).toBe('1. l: /usr/bin/open -b x.y /short/path <path>');
  });
});
