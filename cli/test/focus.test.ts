import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { arrivalOrder, assignSlots, runFocus, slotsPath, type BoardSession } from '../src/focus';
import * as config from '../src/listener/config';
import type { ListenerConfig } from '../src/listener/types';

const HERE = '5f534705389f8d995e57e9d7163fa050';
const THERE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-focus-'));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const session = (over: Partial<BoardSession> & { id: string }): BoardSession => ({
  host: { machine: { id: HERE, name: 'MacBook' }, app: { slug: 'ghostty', name: 'Ghostty', kind: 'terminal' } },
  ...over,
});

const cfg = (): ListenerConfig => ({
  url: 'https://board.example/w/ags_x',
  base: 'https://board.example/w/ags_x',
  stateDir,
  machineId: '00000000-0000-4000-8000-000000000000',
  machineKey: 'k',
  machinePublicId: HERE,
  name: 'MacBook',
  bins: {},
  logFile: path.join(stateDir, 'listener.log'),
  lockFile: path.join(stateDir, 'listener.lock'),
});

const slots = (sessions: BoardSession[]): Record<number, string> => {
  const { bySlot } = assignSlots(sessions, cfg());
  return Object.fromEntries([...bySlot].map(([n, s]) => [n, s.id]));
};

describe('arrival order', () => {
  it('is oldest first', () => {
    const ordered = arrivalOrder([
      session({ id: 'b', createdAt: 200, updatedAt: 999 }),
      session({ id: 'a', createdAt: 100, updatedAt: 1 }),
      session({ id: 'c', createdAt: 300 }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by id so two agents starting in the same millisecond do not swap', () => {
    const one = arrivalOrder([session({ id: 'z', createdAt: 5 }), session({ id: 'y', createdAt: 5 })]);
    const two = arrivalOrder([session({ id: 'y', createdAt: 5 }), session({ id: 'z', createdAt: 5 })]);
    expect(one.map((s) => s.id)).toEqual(['y', 'z']);
    expect(two.map((s) => s.id)).toEqual(one.map((s) => s.id));
  });

  it('sorts a session with no readable createdAt last, so it cannot seize slot 1', () => {
    const ordered = arrivalOrder([session({ id: 'nodate' }), session({ id: 'real', createdAt: 100 })]);
    expect(ordered.map((s) => s.id)).toEqual(['real', 'nodate']);
  });

  it('does not mutate its input', () => {
    const input = [session({ id: 'b', createdAt: 2 }), session({ id: 'a', createdAt: 1 })];
    arrivalOrder(input);
    expect(input.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('slot assignment', () => {
  // The whole feature rests on this: a slot must keep meaning the same session
  // between one key press and the next, however the board churns around it.
  it('numbers a fresh board oldest first', () => {
    expect(slots([
      session({ id: 'b', createdAt: 200 }),
      session({ id: 'a', createdAt: 100 }),
    ])).toEqual({ 1: 'a', 2: 'b' });
  });

  it('keeps a session on its slot when an EARLIER session leaves the board', () => {
    const a = session({ id: 'a', createdAt: 100 });
    const b = session({ id: 'b', createdAt: 200 });
    const c = session({ id: 'c', createdAt: 300 });
    expect(slots([a, b, c])).toEqual({ 1: 'a', 2: 'b', 3: 'c' });
    // The server sweeps by updatedAt, so the oldest-created session is exactly
    // the one most likely to go quiet and vanish. A dense rank would slide b
    // and c down one and send every learned key press to the wrong window.
    expect(slots([b, c])).toEqual({ 2: 'b', 3: 'c' });
  });

  it('keeps existing slots and gives a new session the lowest free number', () => {
    const b = session({ id: 'b', createdAt: 200 });
    const c = session({ id: 'c', createdAt: 300 });
    slots([session({ id: 'a', createdAt: 100 }), b, c]);
    slots([b, c]); // 'a' leaves, freeing slot 1
    expect(slots([b, c, session({ id: 'd', createdAt: 400 })])).toEqual({ 1: 'd', 2: 'b', 3: 'c' });
  });

  it('is stable across repeated calls with an unchanged board', () => {
    const list = [session({ id: 'a', createdAt: 1 }), session({ id: 'b', createdAt: 2 })];
    expect(slots(list)).toEqual(slots(list));
  });

  it('starts over when the board changes', () => {
    slots([session({ id: 'a', createdAt: 100 })]);
    const other = { ...cfg(), base: 'https://board.example/w/ags_other' };
    const { bySlot } = assignSlots([session({ id: 'z', createdAt: 999 })], other);
    expect([...bySlot]).toEqual([[1, expect.objectContaining({ id: 'z' })]]);
  });

  it('survives a corrupt slot file by re-deriving the numbering', () => {
    fs.writeFileSync(slotsPath(stateDir), '{ not json');
    expect(slots([session({ id: 'a', createdAt: 1 })])).toEqual({ 1: 'a' });
  });

  it('persists the assignment with restrictive permissions', () => {
    slots([session({ id: 'a', createdAt: 1 })]);
    expect(fs.statSync(slotsPath(stateDir)).mode & 0o777).toBe(0o600);
  });
});

describe('agstatus focus <n>', () => {
  const run = async (
    slot: string | undefined,
    sessions: BoardSession[],
    opts: { list?: boolean } = {},
    deps: Parameters<typeof runFocus>[3] = {}
  ): Promise<{ code: number; out: string }> => {
    vi.spyOn(config, 'resolveListenerConfig').mockReturnValue(cfg());
    let out = '';
    const code = await runFocus(slot, opts, (l) => { out += `${l}\n`; },
      { fetchSessions: async () => sessions, ...deps });
    return { code, out };
  };

  it('focuses a session on this machine locally, without touching the board', async () => {
    const focusLocally = vi.fn(async () => 0);
    const sendFocusCommand = vi.fn(async () => {});
    const { code } = await run('2', [
      session({ id: 'a', createdAt: 1 }),
      session({ id: 'b', createdAt: 2, project: 'infra' }),
    ], {}, { focusLocally, sendFocusCommand });
    expect(code).toBe(0);
    expect(focusLocally).toHaveBeenCalledWith('b', expect.any(Function));
    // The board's ten-a-minute command budget must not be spent on a session
    // we can reach without it.
    expect(sendFocusCommand).not.toHaveBeenCalled();
  });

  it('posts a command for a session hosted on another machine', async () => {
    const focusLocally = vi.fn(async () => 0);
    const sendFocusCommand = vi.fn(async () => {});
    const { code, out } = await run('1', [
      session({ id: 'remote', createdAt: 1, host: { machine: { id: THERE, name: 'mini' } } }),
    ], {}, { focusLocally, sendFocusCommand });
    expect(code).toBe(0);
    expect(sendFocusCommand).toHaveBeenCalledWith(expect.objectContaining({ machinePublicId: HERE }), 'remote');
    expect(focusLocally).not.toHaveBeenCalled();
    expect(out).toMatch(/mini/);
  });

  it('reports a remote focus that no listener heard as a failure', async () => {
    const { code, out } = await run('1', [
      session({ id: 'remote', createdAt: 1, host: { machine: { id: THERE, name: 'mini' } } }),
    ], {}, {
      sendFocusCommand: async () => {
        throw new Error('That machine has no listener connected, so nothing acted on the request.');
      },
    });
    expect(code).toBe(1);
    expect(out).toMatch(/no listener connected/);
  });

  it('refuses an empty slot instead of focusing something else', async () => {
    const focusLocally = vi.fn(async () => 0);
    const { code, out } = await run('4', [session({ id: 'a', createdAt: 1 })], {}, { focusLocally });
    expect(code).toBe(1);
    expect(out).toMatch(/Slot 4 is empty/);
    expect(focusLocally).not.toHaveBeenCalled();
  });

  it('refuses a session that never reported a host', async () => {
    const { code, out } = await run('1', [{ id: 'x', createdAt: 1 }], {}, {});
    expect(code).toBe(1);
    expect(out).toMatch(/never reported a host/);
  });

  it('rejects a slot that is not a positive number', async () => {
    for (const bad of ['0', '-1', 'two', '1.5', '']) {
      const { code } = await run(bad, [session({ id: 'a', createdAt: 1 })]);
      expect(code).toBe(1);
    }
  });

  it('--list distinguishes this machine, another machine, and no host at all', async () => {
    const { code, out } = await run(undefined, [
      session({ id: 'a', createdAt: 1, project: 'here-repo' }),
      session({ id: 'b', createdAt: 2, project: 'there-repo', host: { machine: { id: THERE, name: 'mini' } } }),
      { id: 'c', createdAt: 3, project: 'no-host-repo' },
    ], { list: true });
    expect(code).toBe(0);
    expect(out).toMatch(/1.*here-repo(?!.*another machine)/);
    expect(out).toMatch(/2.*there-repo.*another machine/);
    expect(out).toMatch(/3.*no-host-repo.*no host — cannot focus/);
  });

  it('reports an unreachable board rather than focusing a stale guess', async () => {
    const { code, out } = await run('1', [], {}, {
      fetchSessions: async () => { throw new Error('Could not reach the board at https://board.example.'); },
    });
    expect(code).toBe(1);
    expect(out).toMatch(/Could not reach the board/);
  });
});
