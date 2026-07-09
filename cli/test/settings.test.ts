import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HOOK_EVENTS,
  configDir,
  hookCommand,
  mergeSettings,
  readSettings,
  removeAgstatus,
  settingsPath,
  writeSettingsWithBackup,
} from '../src/settings';

const OPTS = { url: 'https://s.example/w/ags_x', hookCommand: 'node "$HOME/.claude/hooks/agstatus-hook.js"' };

describe('mergeSettings', () => {
  it('registers all five events and the env block on a fresh config', () => {
    const out = mergeSettings({}, OPTS);
    const hooks = out.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    for (const { event, matcher } of HOOK_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event][0].hooks[0].command).toContain('agstatus-hook');
      if (matcher) expect(hooks[event][0].matcher).toBe(matcher);
      else expect(hooks[event][0]).not.toHaveProperty('matcher');
    }
    expect((out.env as Record<string, string>).CLAUDE_STATUS_URL).toBe(OPTS.url);
    expect(out.env).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(out.env).not.toHaveProperty('AGSTATUS_DETAIL');
  });

  it('preserves unrelated settings, hooks, and env vars', () => {
    const input = {
      model: 'opus',
      permissions: { allow: ['Bash(ls *)'] },
      env: { FOO: 'bar' },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-other-hook.sh' }] },
        ],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
      },
    };
    const out = mergeSettings(input, OPTS);
    expect(out.model).toBe('opus');
    expect(out.permissions).toEqual({ allow: ['Bash(ls *)'] });
    expect((out.env as Record<string, string>).FOO).toBe('bar');
    const hooks = out.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0].hooks[0].command).toBe('my-other-hook.sh');
  });

  it('is idempotent — re-running replaces our entries instead of duplicating', () => {
    const once = mergeSettings({}, OPTS);
    const twice = mergeSettings(once, { ...OPTS, url: 'https://new.example/w/ags_y' });
    const hooks = twice.hooks as Record<string, unknown[]>;
    for (const { event } of HOOK_EVENTS) expect(hooks[event]).toHaveLength(1);
    expect((twice.env as Record<string, string>).CLAUDE_STATUS_URL).toBe('https://new.example/w/ags_y');
  });

  it('secret and minimal flags add keys; omitting them removes the keys', () => {
    const withBoth = mergeSettings({}, { ...OPTS, secret: 's3', minimal: true });
    expect((withBoth.env as Record<string, string>).CLAUDE_STATUS_SECRET).toBe('s3');
    expect((withBoth.env as Record<string, string>).AGSTATUS_DETAIL).toBe('off');
    const without = mergeSettings(withBoth, OPTS);
    expect(without.env).not.toHaveProperty('CLAUDE_STATUS_SECRET');
    expect(without.env).not.toHaveProperty('AGSTATUS_DETAIL');
  });

  it('does not mutate its input', () => {
    const input = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeSettings(input, OPTS);
    expect(input).toEqual(snapshot);
  });

  it('rejects malformed shapes loudly instead of silently losing data', () => {
    expect(() => mergeSettings({ hooks: [] }, OPTS)).toThrow(/"hooks".*array/);
    expect(() => mergeSettings({ hooks: 'oops' }, OPTS)).toThrow(/"hooks".*string/);
    expect(() => mergeSettings({ env: [] }, OPTS)).toThrow(/"env".*array/);
    expect(() => mergeSettings({ hooks: { Stop: { my: 'data' } } }, OPTS)).toThrow(/"hooks\.Stop"/);
    // Non-agstatus events with odd shapes are none of our business.
    expect(() => mergeSettings({ hooks: { PostToolUse: { odd: true } } }, OPTS)).not.toThrow();
  });
});

describe('removeAgstatus', () => {
  it('removes only our entries and prunes empty containers', () => {
    const merged = mergeSettings(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me.sh' }] }] }, env: { KEEP: '1' } },
      { ...OPTS, secret: 's', minimal: true }
    );
    const { settings: cleaned, removed } = removeAgstatus(merged);
    const hooks = cleaned.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop[0].hooks[0].command).toBe('keep-me.sh');
    expect(hooks).not.toHaveProperty('SessionStart');
    expect((cleaned.env as Record<string, string>).KEEP).toBe('1');
    expect(cleaned.env).not.toHaveProperty('CLAUDE_STATUS_URL');
    expect(removed).toContain('env.CLAUDE_STATUS_URL');
    expect(removed).toContain('env.CLAUDE_STATUS_SECRET');
  });

  it('uninstall on a merged fresh config restores an empty object', () => {
    const { settings: cleaned } = removeAgstatus(mergeSettings({}, OPTS));
    expect(cleaned).toEqual({});
  });
});

describe('file operations', () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstatus-test-'));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('configDir/settingsPath respect CLAUDE_CONFIG_DIR', () => {
    expect(configDir()).toBe(dir);
    expect(settingsPath()).toBe(path.join(dir, 'settings.json'));
  });

  it('hookCommand falls back to a literal path outside the home dir', () => {
    expect(hookCommand()).toBe(`node "${path.join(dir, 'hooks', 'agstatus-hook.js')}"`);
  });

  it('readSettings: missing file → {}, invalid JSON → clear error', () => {
    const file = settingsPath();
    expect(readSettings(file)).toEqual({});
    fs.writeFileSync(file, '{ broken');
    expect(() => readSettings(file)).toThrow(/not valid JSON/);
    fs.writeFileSync(file, '[1,2]');
    expect(() => readSettings(file)).toThrow(/not valid JSON/);
  });

  it('readSettings tolerates a UTF-8 BOM', () => {
    const file = settingsPath();
    fs.writeFileSync(file, '﻿{"a": 1}');
    expect(readSettings(file)).toEqual({ a: 1 });
  });

  it('writeSettingsWithBackup follows a symlinked settings.json', () => {
    const file = settingsPath();
    const real = path.join(dir, 'real-settings.json');
    fs.writeFileSync(real, '{"a":1}\n');
    fs.symlinkSync(real, file);
    writeSettingsWithBackup(file, { a: 2 });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ a: 2 });
  });

  it('writeSettingsWithBackup writes a rolling backup', () => {
    const file = settingsPath();
    writeSettingsWithBackup(file, { a: 1 });
    expect(fs.existsSync(`${file}.agstatus-backup`)).toBe(false);
    writeSettingsWithBackup(file, { a: 2 });
    expect(JSON.parse(fs.readFileSync(`${file}.agstatus-backup`, 'utf8'))).toEqual({ a: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 2 });
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });
});
