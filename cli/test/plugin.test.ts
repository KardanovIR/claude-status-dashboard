import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { HOOK_EVENTS } from '../src/settings';

const ROOT = path.join(__dirname, '..', '..');

// The Claude Code plugin bundles its own copy of the hook (plugins are
// installed standalone, so it cannot reference cli/assets). These tests pin
// the two distribution channels together — if one fails, run:
//   npm run sync:plugin
describe('claude code plugin bundle', () => {
  it('ships a byte-identical copy of the CLI hook script', () => {
    const cliHook = fs.readFileSync(path.join(ROOT, 'cli', 'assets', 'agstatus-hook.js'), 'utf8');
    const pluginHook = fs.readFileSync(
      path.join(ROOT, 'plugin', 'scripts', 'agstatus-hook.js'),
      'utf8'
    );
    expect(pluginHook).toBe(cliHook);
  });

  it('registers the same events and PreToolUse matcher as the CLI installer', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8');
    const hooks = JSON.parse(raw).hooks as Record<
      string,
      Array<{ matcher?: string; hooks: Array<{ command: string }> }>
    >;
    expect(Object.keys(hooks).sort()).toEqual(HOOK_EVENTS.map((e) => e.event).sort());
    for (const { event, matcher } of HOOK_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event][0].matcher).toBe(matcher);
      expect(hooks[event][0].hooks[0].command).toContain('agstatus-hook.js');
    }
  });
});
