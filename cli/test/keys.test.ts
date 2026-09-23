import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_SLOT_COUNT, parseShortcut, resolveKeys, runKeys, toKarabiner, toSkhd,
} from '../src/keys';

const SHIM = '/Users/demo/.agstatus/bin/agstatus';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-keys-'));
  file = path.join(dir, '.agstatus.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (obj: unknown): void => fs.writeFileSync(file, JSON.stringify(obj));

describe('parseShortcut', () => {
  it('accepts the modifier spellings macOS uses interchangeably', () => {
    for (const raw of ['ctrl+opt+1', 'ctrl+alt+1', 'control+option+1', 'CTRL+OPT+1', ' ctrl + opt + 1 ']) {
      expect(parseShortcut(raw)).toMatchObject({ modifiers: ['ctrl', 'alt'], key: '1', shortcut: 'ctrl+alt+1' });
    }
  });

  it('puts modifiers in a fixed order so the same chord has one spelling', () => {
    expect(parseShortcut('cmd+shift+alt+ctrl+k')).toMatchObject({ shortcut: 'ctrl+alt+shift+cmd+k' });
    expect(parseShortcut('alt+ctrl+k')).toMatchObject({ shortcut: 'ctrl+alt+k' });
  });

  it('allows a bare function key, because F13-F24 are meant to be bound bare', () => {
    expect(parseShortcut('f13')).toMatchObject({ modifiers: [], key: 'f13', shortcut: 'f13' });
    expect(parseShortcut('f24')).toMatchObject({ key: 'f24' });
  });

  // Binding a bare letter or digit takes that key from every app on the
  // machine. Nobody asks for that on purpose.
  it('refuses a bare letter or digit', () => {
    expect(parseShortcut('1')).toEqual({ error: expect.stringContaining('bare') });
    expect(parseShortcut('k')).toEqual({ error: expect.stringContaining('bare') });
  });

  it('refuses a typo rather than binding something else', () => {
    expect(parseShortcut('crtl+1')).toEqual({ error: expect.stringContaining('not a modifier') });
    expect(parseShortcut('ctrl+')).toEqual({ error: expect.stringContaining('needs a key too') });
    expect(parseShortcut('ctrl+alt')).toEqual({ error: expect.stringContaining('needs a key too') });
    expect(parseShortcut('')).toEqual({ error: expect.stringContaining('empty') });
  });
});

describe('resolveKeys', () => {
  it('falls back to ctrl+alt+1..6 when nothing is configured', () => {
    const { bindings, source } = resolveKeys(DEFAULT_SLOT_COUNT, file);
    expect(source).toBe('default');
    expect(bindings).toHaveLength(6);
    expect(bindings[0]).toMatchObject({ slot: 1, shortcut: 'ctrl+alt+1' });
    expect(bindings[5]).toMatchObject({ slot: 6, shortcut: 'ctrl+alt+6' });
  });

  it('honours a configured mapping, normalising the spelling', () => {
    write({ keys: { '1': 'ctrl+opt+j', '2': 'F14' } });
    const { bindings, source } = resolveKeys(6, file);
    expect(source).toBe('file');
    expect(bindings).toEqual([
      { slot: 1, shortcut: 'ctrl+alt+j', modifiers: ['ctrl', 'alt'], key: 'j' },
      { slot: 2, shortcut: 'f14', modifiers: [], key: 'f14' },
    ]);
  });

  // One bad line must not cost the user the shortcuts that were fine.
  it('skips a bad entry, keeps the rest, and says what was wrong', () => {
    write({ keys: { '1': 'ctrl+alt+1', '2': 'crtl+alt+2', '3': 'ctrl+alt+3' } });
    const { bindings, problems } = resolveKeys(6, file);
    expect(bindings.map((b) => b.slot)).toEqual([1, 3]);
    expect(problems.join(' ')).toMatch(/slot 2.*not a modifier/);
  });

  it('refuses to give one shortcut to two slots', () => {
    write({ keys: { '1': 'ctrl+alt+1', '2': 'ctrl+opt+1' } });
    const { bindings, problems } = resolveKeys(6, file);
    expect(bindings.map((b) => b.slot)).toEqual([1]);
    expect(problems.join(' ')).toMatch(/repeats ctrl\+alt\+1.*slot 1/);
  });

  it('skips a key that is not a slot number', () => {
    write({ keys: { '0': 'ctrl+alt+a', 'x': 'ctrl+alt+b', '99': 'ctrl+alt+c' } });
    const { bindings, problems } = resolveKeys(6, file);
    expect(bindings).toEqual([]);
    expect(problems).toHaveLength(3);
  });

  it('ignores a "keys" that is not an object and uses the defaults', () => {
    write({ keys: ['ctrl+alt+1'] });
    const { bindings, problems } = resolveKeys(6, file);
    expect(bindings).toHaveLength(6);
    expect(problems.join(' ')).toMatch(/not an object/);
  });

  it('--slots changes how many defaults there are', () => {
    expect(resolveKeys(5, file).bindings.map((b) => b.slot)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('generators', () => {
  const bindings = resolveKeys(2, '/nonexistent/.agstatus.json').bindings;

  it('skhd config binds each chord to a detached focus', () => {
    const out = toSkhd(bindings, SHIM);
    expect(out).toContain(`ctrl + alt - 1 : /usr/bin/nohup '${SHIM}' focus 1 >/dev/null 2>&1 &`);
    expect(out).toContain('ctrl + alt - 2 :');
  });

  it('skhd omits the modifier separator for a bare function key', () => {
    const bare = parseShortcut('f13');
    if ('error' in bare) throw new Error('f13 should parse');
    expect(toSkhd([{ slot: 3, ...bare }], SHIM)).toContain('f13 : /usr/bin/nohup');
  });

  it('karabiner config is valid JSON with the right modifier names', () => {
    const parsed = JSON.parse(toKarabiner(bindings, SHIM));
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0].manipulators[0].from).toEqual({
      key_code: '1',
      modifiers: { mandatory: ['control', 'option'] },
    });
    expect(parsed.rules[0].manipulators[0].to[0].shell_command).toContain('focus 1');
  });

  it('karabiner omits modifiers entirely for a bare function key', () => {
    const bare = parseShortcut('f13');
    if ('error' in bare) throw new Error('f13 should parse');
    const parsed = JSON.parse(toKarabiner([{ slot: 1, ...bare }], SHIM));
    expect(parsed.rules[0].manipulators[0].from).toEqual({ key_code: 'f13' });
  });
});

describe('agstatus keys', () => {
  const run = async (opts: Parameters<typeof runKeys>[0]): Promise<{ code: number; out: string }> => {
    let out = '';
    const code = await runKeys(opts, (l) => { out += `${l}\n`; }, { file, shim: SHIM });
    return { code, out };
  };

  it('shows the mapping and says nothing is listening yet', async () => {
    const { code, out } = await run({});
    expect(code).toBe(0);
    expect(out).toMatch(/defaults — none configured/);
    expect(out).toMatch(/ctrl\+alt\+1\s+→ agstatus focus 1/);
    expect(out).toMatch(/does not capture keys itself/);
  });

  it('--write persists the mapping so it can be edited', async () => {
    const { code } = await run({ write: true, slots: '3' });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).keys)
      .toEqual({ '1': 'ctrl+alt+1', '2': 'ctrl+alt+2', '3': 'ctrl+alt+3' });
    // ...and is read back as configured, not as defaults.
    expect((await run({})).out).toMatch(/Shortcuts from/);
  });

  it('--write keeps the rest of the config file', async () => {
    write({ url: 'https://board.example/w/ags_x', focus: true });
    await run({ write: true, slots: '1' });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.url).toBe('https://board.example/w/ags_x');
    expect(after.focus).toBe(true);
    expect(after.keys).toEqual({ '1': 'ctrl+alt+1' });
  });

  it('rejects a nonsense --slots', async () => {
    for (const bad of ['0', '99', 'six', '']) {
      expect((await run({ slots: bad })).code).toBe(1);
    }
  });

  it('fails when every configured shortcut is unusable', async () => {
    write({ keys: { '1': 'crtl+1' } });
    const { code, out } = await run({});
    expect(code).toBe(1);
    expect(out).toMatch(/No usable shortcuts/);
  });
});
