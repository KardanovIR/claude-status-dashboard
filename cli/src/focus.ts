import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveListenerConfig } from './listener/config';
import type { ListenerConfig } from './listener/types';

/**
 * `agstatus focus <n>` — bring the n-th session's window to the front from a
 * key press, so a hotkey (or a macro pad's n-th button) does what tapping the
 * card on the board does.
 *
 * Why slots are not the board's own order. The apps deliberately freeze a
 * card's position once it is on screen — ios/AgStatus/SessionStore.swift's
 * `stableOrder` keeps every session already visible where it is and slots only
 * unseen ones in, at the top — so the n-th card on a phone is a function of
 * *that device's* arrival history since launch, and nothing on the wire can
 * reconstruct it. `GET /api/sessions` is `updatedAt` descending, a different
 * order again, and one that re-ranks on every webhook post.
 *
 * Why slots are not a rank either. Ordering the list by `createdAt` looks
 * stable — that field never mutates — but a *position* in it is not: the
 * server sweeps sessions by `updatedAt` (store.ts sweepExpiredSessions) and
 * evicts at a cap, so the session holding slot 1 can go quiet and vanish while
 * newer ones stay, sliding every later slot down by one. Fingers would have
 * learned the wrong number, silently.
 *
 * So a slot is an *assignment*, held on this machine: once a session is given
 * a number it keeps it until it leaves the board, and the number it frees is
 * reused by the next session that needs one. New sessions take the lowest free
 * slot, oldest first. `agstatus focus --list` prints the mapping, because the
 * board does not show these numbers.
 *
 * Two ways to reach a window, picked per session:
 *   - hosted on this machine → run the plan here, in this process. No network
 *     round trip for the focus itself, and no board rate limit.
 *   - hosted elsewhere → POST a focus command and let that machine's listener
 *     act on it, exactly as a tap on the board does.
 */

/** The fields of a board session this command reads. Everything else is ignored. */
export interface BoardSession {
  id: string;
  name?: string;
  project?: string;
  status?: string;
  source?: string;
  /** Epoch ms, or undefined when the board did not give a usable one. */
  createdAt?: number;
  updatedAt?: number;
  host?: {
    machine?: { id?: string; name?: string };
    app?: { slug?: string; name?: string; kind?: string };
  };
}

/** How many slots a pad is assumed to have; only used to trim `--list`. */
export const DEFAULT_SLOTS = 6;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Tolerant by design: a board running a newer server may carry fields this
 * CLI has never heard of, and a session missing everything but an id still
 * deserves a slot — it is on the board, so it is in the list the user counts.
 */
function toSession(raw: unknown): BoardSession | null {
  if (!isPlainObject(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const host = isPlainObject(raw.host) ? raw.host : undefined;
  const machine = host && isPlainObject(host.machine) ? host.machine : undefined;
  const app = host && isPlainObject(host.app) ? host.app : undefined;
  const created = num(raw.createdAt);
  const updated = num(raw.updatedAt);
  return {
    id,
    name: str(raw.name) || undefined,
    project: str(raw.project) || undefined,
    status: str(raw.status) || undefined,
    source: str(raw.source) || undefined,
    ...(created !== undefined ? { createdAt: created } : {}),
    ...(updated !== undefined ? { updatedAt: updated } : {}),
    ...(host
      ? {
          host: {
            ...(machine ? { machine: { id: str(machine.id), name: str(machine.name) } } : {}),
            ...(app
              ? { app: { slug: str(app.slug), name: str(app.name), kind: str(app.kind) } }
              : {}),
          },
        }
      : {}),
  };
}

/** True when this session runs on the machine we are on. */
export function isLocal(s: BoardSession, cfg: ListenerConfig): boolean {
  const id = s.host?.machine?.id;
  return typeof id === 'string' && id !== '' && id === cfg.machinePublicId;
}

/**
 * The order new sessions are handed free slots in: oldest first. A session
 * whose `createdAt` the board did not give sorts last rather than first —
 * an unreadable timestamp must not seize slot 1 from a real session. Ties
 * break on id, because two agents can start inside the same millisecond and
 * the server promises nothing about equal timestamps.
 */
export function arrivalOrder(sessions: BoardSession[]): BoardSession[] {
  return [...sessions].sort((a, b) => {
    const ac = a.createdAt ?? Number.MAX_SAFE_INTEGER;
    const bc = b.createdAt ?? Number.MAX_SAFE_INTEGER;
    if (ac !== bc) return ac - bc;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---- The slot assignment, held on this machine ----------------------------

interface SlotFile {
  /** Which board these slots belong to; a different board starts over. */
  board: string;
  /** Slot number (as a string key) -> session id. */
  slots: Record<string, string>;
}

/** The board's identity without writing its token into a second file. */
const boardFingerprint = (base: string): string =>
  crypto.createHash('sha256').update(base).digest('hex').slice(0, 16);

export const slotsPath = (stateDir: string): string => path.join(stateDir, 'focus-slots.json');

function readSlotFile(file: string, board: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing or unreadable is not an error: the assignment rebuilds itself
    // from the board on the next press. Only the numbering is lost.
    return {};
  }
  if (!isPlainObject(parsed) || str(parsed.board) !== board) return {};
  const slots = isPlainObject(parsed.slots) ? parsed.slots : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(slots)) {
    if (/^[0-9]{1,3}$/.test(k) && Number(k) >= 1 && typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

function writeSlotFile(file: string, data: SlotFile): void {
  // Same discipline as the listener's own records: 0700 dir, 0600 file,
  // temp + rename, so two key presses racing cannot leave a half-written map.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.agstatus-tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch {
    // A slot map we could not persist still works for this press; the next
    // one just re-derives it. Never fail a focus over bookkeeping.
  }
}

export interface Assignment {
  /** Slot number -> the session holding it, lowest first. */
  bySlot: Map<number, BoardSession>;
}

/**
 * Give every session on the board a slot, keeping the ones already assigned.
 * Sessions that have left the board release their numbers, and the next new
 * session takes the lowest free one — so a slot is only ever reused after the
 * session that held it is gone.
 */
export function assignSlots(sessions: BoardSession[], cfg: ListenerConfig): Assignment {
  const file = slotsPath(cfg.stateDir);
  const board = boardFingerprint(cfg.base);
  const held = readSlotFile(file, board);

  const onBoard = new Map(sessions.map((s) => [s.id, s]));
  const bySlot = new Map<number, BoardSession>();
  const assigned = new Set<string>();

  for (const [slotKey, sessionId] of Object.entries(held)) {
    const session = onBoard.get(sessionId);
    if (!session) continue; // left the board — the number is free again
    const slot = Number(slotKey);
    if (bySlot.has(slot)) continue; // a duplicated key in a hand-edited file
    bySlot.set(slot, session);
    assigned.add(sessionId);
  }

  let next = 1;
  for (const session of arrivalOrder(sessions)) {
    if (assigned.has(session.id)) continue;
    while (bySlot.has(next)) next += 1;
    bySlot.set(next, session);
    assigned.add(session.id);
  }

  const slots: Record<string, string> = {};
  for (const [slot, session] of [...bySlot].sort((a, b) => a[0] - b[0])) slots[String(slot)] = session.id;
  if (JSON.stringify(slots) !== JSON.stringify(held)) writeSlotFile(file, { board, slots });

  return { bySlot };
}

/** A one-line label for `--list`, in the terms the board shows. */
export function describeSession(s: BoardSession): string {
  const where = s.host?.app?.name || s.host?.app?.slug || '-';
  const machine = s.host?.machine?.name || '-';
  return `${(s.status ?? '?').padEnd(9)} ${(s.project || s.name || s.id.slice(0, 8)).padEnd(24)} ${machine}/${where}`;
}

// ---- Talking to the board -------------------------------------------------

/**
 * One timeout for the whole exchange, headers *and* body. Clearing the timer
 * when the headers land would leave a board that stops mid-body hanging the
 * process — and a hotkey that never returns is worse than one that fails.
 */
async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSessions(base: string, timeoutMs = 4000): Promise<BoardSession[]> {
  const body = await withDeadline(timeoutMs, async (signal) => {
    let res: Response;
    try {
      res = await fetch(`${base}/api/sessions`, { headers: { accept: 'application/json' }, signal });
    } catch {
      throw new Error(`Could not reach the board at ${base}.`);
    }
    if (res.status === 404) {
      throw new Error('That board no longer exists (deleted or expired). Re-run `agstatus init`.');
    }
    if (res.status !== 200) {
      throw new Error(`The board answered HTTP ${res.status} for its session list.`);
    }
    return res.json().catch(() => null) as Promise<unknown>;
  });
  if (!Array.isArray(body)) throw new Error('The board returned a session list this CLI cannot read.');
  return body.map(toSession).filter((s): s is BoardSession => s !== null);
}

/**
 * Ask the machine hosting the session to focus it, the same way the board's
 * Focus button does: a client-minted uuid so a retry is distinguishable from
 * a second press, and `session_id` — the server takes the machine from the
 * session it has stored and never from anything we could name.
 *
 * Resolves only when the command actually reached a listener. A 200 with
 * `delivered: false` means that machine has no listener connected right now:
 * the command sits until it expires, so reporting it as sent would be a lie.
 */
async function sendFocusCommand(cfg: ListenerConfig, sessionId: string, timeoutMs = 4000): Promise<void> {
  const { status, body } = await withDeadline(timeoutMs, async (signal) => {
    let res: Response;
    try {
      res = await fetch(`${cfg.base}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.secret ? { 'x-webhook-secret': cfg.secret } : {}),
        },
        body: JSON.stringify({ id: crypto.randomUUID(), type: 'focus', session_id: sessionId }),
        signal,
      });
    } catch {
      throw new Error(`Could not reach the board at ${cfg.base}.`);
    }
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  });

  if (status === 200) {
    if (body.delivered === false) {
      throw new Error('That machine has no listener connected, so nothing acted on the request.');
    }
    return;
  }
  const err = str(body.error);
  if (status === 409 && err === 'no_host') {
    throw new Error('That session never reported a host, so no machine can be asked to focus it.');
  }
  if (status === 429) {
    throw new Error(
      err === 'too_many_pending'
        ? 'The board already has ten focus requests waiting. Give it a moment.'
        : 'The board is rate-limiting commands (ten a minute). Give it a moment.'
    );
  }
  throw new Error(`The board refused the focus request (HTTP ${status}${err ? `: ${err}` : ''}).`);
}

// ---- The command ----------------------------------------------------------

export interface FocusDeps {
  /** Injected by the caller so the listener runtime stays a lazy import. */
  focusLocally?: (sessionId: string, log: (line: string) => void) => Promise<number>;
  fetchSessions?: (base: string) => Promise<BoardSession[]>;
  sendFocusCommand?: (cfg: ListenerConfig, sessionId: string) => Promise<void>;
}

/**
 * `agstatus focus [n] [--list]`. Exit 0 when the window was reached (or the
 * command was delivered to another machine), 1 with a reason otherwise — a
 * hotkey wrapper discards both, so every failure also says why on stdout.
 */
export async function runFocus(
  slot: string | undefined,
  opts: { list?: boolean; url?: string },
  log: (line: string) => void,
  deps: FocusDeps = {}
): Promise<number> {
  const cfg = resolveListenerConfig({ url: opts.url });
  if ('error' in cfg) {
    log(`✖ ${cfg.error}`);
    return 1;
  }

  const wantList = opts.list === true || slot === undefined;
  let sessions: BoardSession[];
  try {
    sessions = await (deps.fetchSessions ?? fetchSessions)(cfg.base);
  } catch (err) {
    log(`✖ ${(err as Error).message}`);
    return 1;
  }

  const { bySlot } = assignSlots(sessions, cfg);

  if (wantList) {
    if (bySlot.size === 0) {
      log('No sessions on the board — nothing to focus.');
      return opts.list === true ? 0 : 1;
    }
    log('Slot  Session');
    for (const [n, s] of [...bySlot].sort((a, b) => a[0] - b[0])) {
      const where = !s.host?.machine?.id ? '  (no host — cannot focus)' : isLocal(s, cfg) ? '' : '  (another machine)';
      log(`  ${String(n).padStart(2)}  ${describeSession(s)}${where}`);
    }
    const highest = Math.max(...bySlot.keys());
    if (highest > DEFAULT_SLOTS) {
      log(`\nSlots past ${DEFAULT_SLOTS} have no button unless you bind more keys.`);
    }
    if (opts.list === true) return 0;
    log('\n✖ Usage: agstatus focus <n>');
    return 1;
  }

  if (!/^[0-9]{1,3}$/.test(slot) || Number(slot) < 1) {
    log('✖ The slot must be a positive whole number — `agstatus focus 3`.');
    return 1;
  }
  const n = Number(slot);
  const session = bySlot.get(n);
  if (!session) {
    log(`✖ Slot ${n} is empty: the board has ${bySlot.size} session${bySlot.size === 1 ? '' : 's'}.`);
    return 1;
  }

  const label = session.project || session.name || session.id.slice(0, 8);
  // A session hosted here never round-trips the board to be focused: the plan
  // the listener would run is built and run in this process instead.
  if (isLocal(session, cfg) && deps.focusLocally) {
    log(`Slot ${n}: ${label}`);
    return deps.focusLocally(session.id, log);
  }
  if (!session.host?.machine?.id) {
    log(`✖ Slot ${n} (${label}) never reported a host, so there is no window to bring forward.`);
    return 1;
  }
  try {
    await (deps.sendFocusCommand ?? sendFocusCommand)(cfg, session.id);
  } catch (err) {
    log(`✖ Slot ${n} (${label}): ${(err as Error).message}`);
    return 1;
  }
  log(`Slot ${n}: ${label} — asked ${session.host.machine.name || 'that machine'} to bring it forward.`);
  return 0;
}
