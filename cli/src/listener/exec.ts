import { execFile } from 'child_process';
import path from 'path';
import { OPEN } from './plan';
import type { Outcome, Plan, Reason, Step } from './types';

/**
 * The runner: takes a plan the planner produced and launches its steps, one
 * process at a time, with `child_process.execFile` and an argv array — there
 * is no shell anywhere in this file, and no step ever sees the listener's
 * own environment (only PATH=/usr/bin:/bin plus the one variable a step
 * carries). After a step that names `expectFrontmost`, `lsappinfo` is polled
 * for half a second; when the app never comes to the front the plan's
 * result degrades to `selected` (design §5.2 step 5). Log lines carry the
 * step label, its exit code and the time — never the argv, never output.
 */

/** System binaries the runner names itself; nothing else is ever looked up by name. */
export const SYSTEM_BINS = {
  open: OPEN,
  ps: '/bin/ps',
  lsappinfo: '/usr/bin/lsappinfo',
} as const;
export const PS = SYSTEM_BINS.ps;
export const LSAPPINFO = SYSTEM_BINS.lsappinfo;

/** What every launch sees, whatever the listener itself was started with. */
export const STEP_PATH = '/usr/bin:/bin';
const STEP_TIMEOUT_MS = 5000;
const MAX_BUFFER = 64 * 1024;
const FRONTMOST_WAIT_MS = 500;
const FRONTMOST_POLL_MS = 100;
const LSAPPINFO_TIMEOUT_MS = 2000;

export interface ExecOptions {
  /** The whole environment of the child; undefined means PATH only, never process.env. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeout: number;
  /** Stdout the caller is willing to hold (default 64 KB; the process-table reads ask for more). */
  maxBuffer?: number;
}
export interface ExecResult {
  code: number;
  stdout: string;
}
/** argv-only process launch; `file` is an absolute path from ListenerConfig.bins or SYSTEM_BINS. */
export type ExecFile = (file: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

/** What runPlan() needs: a launcher (stdout not required), the frontmost app, a log, and the tool table. */
export interface RunDeps {
  execFile: (file: string, args: string[], opts: ExecOptions) => Promise<{ code: number }>;
  frontmost: () => Promise<string | null>;
  log: (line: string) => void;
  /**
   * Every argv[0] a step may name, as absolute paths: ListenerConfig.bins
   * plus SYSTEM_BINS. Whatever the planner produced, nothing outside this
   * set is launched — the choke point the trust rule is enforced at.
   */
  allowed: ReadonlySet<string>;
}

/**
 * child_process.execFile, promisified and bounded: no shell, 64 KB of
 * output, SIGKILL when the timeout hits, and a numeric exit code (1 for a
 * launch failure or a kill). Never rejects.
 */
export const defaultExecFile: ExecFile = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: opts.env ?? { PATH: STEP_PATH },
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer ?? MAX_BUFFER,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? '') });
      }
    );
  });

const ASN_RE = /^ASN:0x[0-9A-Fa-f]+-0x[0-9A-Fa-f]+:$/;
const BUNDLE_LINE_RE = /"CFBundleIdentifier"\s*=\s*"([A-Za-z0-9.-]{3,128})"/;

/**
 * The bundle id of the frontmost app: `lsappinfo front` names its ASN,
 * `lsappinfo info -only bundleid <asn>` names the bundle. The ASN goes back
 * into an argv only after it matched its regex. Null on any failure.
 */
export async function defaultFrontmost(exec: ExecFile = defaultExecFile): Promise<string | null> {
  try {
    const opts: ExecOptions = { env: { PATH: STEP_PATH }, timeout: LSAPPINFO_TIMEOUT_MS };
    const front = await exec(LSAPPINFO, ['front'], opts);
    const asn = front.stdout.trim();
    if (front.code !== 0 || !ASN_RE.test(asn)) return null;
    const info = await exec(LSAPPINFO, ['info', '-only', 'bundleid', asn], opts);
    if (info.code !== 0) return null;
    const m = BUNDLE_LINE_RE.exec(info.stdout);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** A bare name only for a binary in SYSTEM_BINS; otherwise argv[0] must already be absolute. */
function resolveArgv0(argv0: string | undefined): string | null {
  if (!argv0) return null;
  if (Object.prototype.hasOwnProperty.call(SYSTEM_BINS, argv0)) return SYSTEM_BINS[argv0 as keyof typeof SYSTEM_BINS];
  return path.isAbsolute(argv0) ? argv0 : null;
}

/** An `open -b` that fails means the app is not installed or refused to launch. */
const failureReason = (step: Step, file: string): Reason =>
  file === OPEN && step.argv[1] === '-b' ? 'app-not-running' : 'unsupported-host';

async function waitFrontmost(bundle: string, frontmost: () => Promise<string | null>): Promise<boolean> {
  const deadline = Date.now() + FRONTMOST_WAIT_MS;
  for (;;) {
    let front: string | null = null;
    try {
      front = await frontmost();
    } catch {
      /* treated as "not in front" */
    }
    if (front === bundle) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(FRONTMOST_POLL_MS, left)));
  }
}

/**
 * Runs the steps in order. A step's environment is PATH plus its own `env`,
 * its timeout `timeoutMs` or 5 s. A failing step ends the plan as `failed`
 * unless it is optional; a failing `expectFrontmost` check degrades the
 * result to `selected` and keeps the reach. The outcome carries enums only.
 */
export async function runPlan(plan: Plan, deps: RunDeps): Promise<Outcome> {
  let result = plan.result;
  const total = plan.steps.length;
  for (let i = 0; i < total; i += 1) {
    const step = plan.steps[i];
    const tag = `step ${i + 1}/${total} ${step.label}`;
    const file = resolveArgv0(step.argv[0]);
    if (!file) {
      deps.log(`${tag}: refused — argv[0] is not an absolute path`);
      return { result: 'failed', reason: 'bad-record' };
    }
    if (!deps.allowed.has(file)) {
      deps.log(`${tag}: refused — argv[0] is not in the tool table`);
      return { result: 'failed', reason: 'bad-record' };
    }
    const started = Date.now();
    let code: number;
    try {
      ({ code } = await deps.execFile(file, step.argv.slice(1), {
        env: { PATH: STEP_PATH, ...(step.env ?? {}) },
        cwd: step.cwd,
        timeout: step.timeoutMs ?? STEP_TIMEOUT_MS,
      }));
    } catch {
      code = -1;
    }
    deps.log(`${tag}: exit ${code} (${Date.now() - started}ms)${step.optional ? ', optional' : ''}`);
    if (code !== 0) {
      if (step.optional) continue;
      return { result: 'failed', reason: failureReason(step, file) };
    }
    if (step.expectFrontmost && !(await waitFrontmost(step.expectFrontmost, deps.frontmost))) {
      deps.log(`frontmost: ${step.expectFrontmost} did not come to the front — result degrades to selected`);
      if (result === 'focused' || result === 'activated') result = 'selected';
    }
  }
  return { result, reach: plan.reach };
}
