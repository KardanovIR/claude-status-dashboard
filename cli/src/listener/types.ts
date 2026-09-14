/**
 * Shared shapes for the Focus listener (`agstatus listener …`).
 *
 * The listener is the machine-side half of the Focus Protocol
 * (docs/design/focus-protocol.md): it holds one SSE stream to the board,
 * receives commands routed to this machine, turns each into a plan from the
 * local record the hook wrote, runs the plan with argv arrays only, and
 * acknowledges the outcome with enums alone. Everything here is data the
 * runtime, the planner and the installer agree on; the wire enums mirror
 * src/store.ts on the server exactly and must change together.
 */

export const COMMAND_TYPES = ['focus', 'resume'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const RESULTS = ['focused', 'activated', 'selected', 'resumed', 'failed'] as const;
export type Result = (typeof RESULTS)[number];

/** How far the plan got: the exact pane, a tab, a window, only the app, or a Codex thread. */
export const REACHES = ['pane', 'tab', 'window', 'app', 'thread'] as const;
export type Reach = (typeof REACHES)[number];

/** Why a command failed. An enum on purpose: nothing free-form ever reaches the board. */
export const REASONS = [
  'no-record', 'remote', 'not-running', 'app-not-running', 'consent-needed', 'mux-detached',
  'ambiguous', 'unsupported-host', 'bad-record', 'respawn-failed', 'unsupported-type',
  'superseded', 'expired',
] as const;
export type Reason = (typeof REASONS)[number];

export const HOST_SLUGS = [
  'agterm', 'iterm2', 'kitty', 'wezterm', 'terminal', 'ghostty', 'alacritty', 'warp',
  'vscode', 'cursor', 'windsurf', 'jetbrains', 'zed', 'claude-desktop', 'codex-desktop',
  'herdr', 'tmux', 'zellij', 'screen', 'windows-terminal', 'other',
] as const;
export type HostSlug = (typeof HOST_SLUGS)[number];
export type HostKind = 'terminal' | 'multiplexer' | 'ide' | 'desktop-app' | 'unknown';

/** The wire `host` object the hook posts; the listener never sends it, only reads it back from records. */
export interface HostSummary {
  machine: { id: string; name: string };
  app: { slug: HostSlug; name: string; kind: HostKind };
}

export type MuxKind = 'herdr' | 'tmux' | 'zellij' | 'screen';

/**
 * One local record, `<state>/sessions/<session_id>/<agent_pid>.json`, exactly
 * as cli/assets/agstatus-hook.js writes it. Optional fields are omitted by the
 * hook when unknown. The runtime validates every field before the planner
 * sees it (records are data, never instructions).
 */
export interface LocalRecord {
  v: 1;
  session_id: string;
  agent: 'claude' | 'codex';
  agent_pid: number;
  agent_comm: string;
  entrypoint: string;
  written_at: number;
  ended_at: number | null;
  tty?: string;
  cwd?: string;
  transcript_path?: string;
  project_root?: string;
  app?: { bundle?: string; path?: string; pid?: number; via: 'ppid-walk' | 'env' };
  env: Record<string, string>;
  mux?: { kind: MuxKind; target?: string; tab?: string; workspace?: string; socket?: string; session?: string };
  codex?: {
    thread_id?: string;
    root_thread_id?: string;
    parent_thread_id?: string | null;
    originator?: string;
    source?: string;
  };
  bins: Record<string, string>;
  path?: string;
  summary?: HostSummary;
}

/** `<state>/machine.json` — created by `agstatus listener install`, read-only for the hook. */
export interface MachineState {
  machineId: string;
  name?: string;
  /** Hostname at creation; a mismatch means the state dir was copied to another machine. */
  machineHost?: string;
}

/** What the listener resolved at start: the board, this machine's credential, where things are. */
export interface ListenerConfig {
  /** Board URL exactly as configured (CLAUDE_STATUS_URL / hooks.json / ~/.agstatus.json). */
  url: string;
  /** boardBase(url): no trailing "/", no "/webhook" — the string the hook hashes. */
  base: string;
  secret?: string;
  stateDir: string;
  /** Raw uuid from machine.json. Never leaves the machine. */
  machineId: string;
  /** sha256(machineId + "\n" + base) as 64 hex — the listener's credential. */
  machineKey: string;
  /** sha256(machineKey).slice(0, 32) — what the hook puts on the wire and the server routes by. */
  machinePublicId: string;
  name: string;
  /** Absolute paths of tools the listener may run, resolved at install/doctor time — never PATH. */
  bins: Record<string, string>;
  logFile: string;
  lockFile: string;
}

/** A command as the server frames it on the `command` / `commands` events. */
export interface CommandFrame {
  id: string;
  type: CommandType;
  session_id: string;
  machine_id: string;
  expires_in_ms: number;
}

/** What the listener reports back; enums only. `reason` is required when result is `failed`. */
export interface Outcome {
  result: Result;
  reach?: Reach;
  reason?: Reason;
}

/**
 * One process launch. `argv[0]` is an absolute path (or a bare name only for
 * /usr/bin/open, /bin/ps and the like, resolved by the runner from a fixed
 * table); every element is passed as-is — there is no shell. `expectFrontmost`
 * names a bundle id the runner checks after the step (with `lsappinfo`); when
 * the app is not frontmost the plan's result degrades from focused/activated
 * to `selected`. `optional` steps may fail without failing the plan.
 */
export interface Step {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  expectFrontmost?: string;
  optional?: boolean;
  /** Short human label for `agstatus listener plan` and the log. */
  label: string;
}

export interface Plan {
  steps: Step[];
  /** What the plan achieves when every step succeeds. */
  reach: Reach;
  /** Which result to ack when every step succeeds (focused for pane/tab/window, activated for app, resumed, …). */
  result: Result;
  /** True for strategies the matrix marks DOCS-ONLY/INFERRED — surfaced in the ack log and `plan` output. */
  experimental: boolean;
  /** One line for `plan` and the log; never contains record paths. */
  description: string;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; reason: Reason };

/**
 * Facts about the machine the planner may consult, resolved by the runtime
 * (and stubbed in tests): which tools exist, whether the agent is alive,
 * what the multiplexer's attached client looks like.
 */
export interface MachineFacts {
  platform: NodeJS.Platform;
  bins: Record<string, string>;
  /** True when `agent_pid` is live and its comm matches `agent_comm`. */
  agentAlive: boolean;
  /** For tmux/herdr/screen/zellij: the outer terminal that the attached client sits in, if resolvable. */
  outer?: { bundle?: string; tty?: string; env?: Record<string, string> };
}
