import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { main, cliVersion } from '../src/index';

/**
 * `agstatus --version` did not exist until 1.5.3, which release.yml had not
 * noticed: its version-guard comment has cited `agstatus --version` since the
 * guard was written, as the thing a mistagged release makes disagree with the
 * artifact's name. 1.5.0's own release notes listed it as a known gap —
 * "The installed artifact's package.json is the only place the number
 * appears."
 */

const capture = async (...argv: string[]) => {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((l?: unknown) => { out.push(String(l)); });
  const code = await main(argv);
  spy.mockRestore();
  return { code, out: out.join('\n') };
};

describe('agstatus version', () => {
  it('prints one parseable line and exits 0, under every spelling', async () => {
    for (const argv of [['version'], ['--version'], ['-v']]) {
      const { code, out } = await capture(...argv);
      expect(code, argv[0]).toBe(0);
      // `agstatus <semver>` — a script comparing versions splits on the space.
      expect(out, argv[0]).toMatch(/^agstatus \d+\.\d+\.\d+/);
      expect(out.split('\n'), argv[0]).toHaveLength(1);
    }
  });

  // This is the guarantee release.yml's version-guard is written against: the
  // tag, cli/package.json and what the binary reports all have to agree, or a
  // release ships an artifact whose name does not match what it says it is.
  it('reports exactly what cli/package.json declares', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
    ) as { version: string };
    expect(cliVersion()).toBe(pkg.version);
  });

  it('is listed in the help', async () => {
    const { out } = await capture('help');
    expect(out).toMatch(/agstatus version/);
  });

  // A version query is the one command that must never fail: it is what you
  // run when something else already has.
  it('says "unknown" rather than throwing when package.json cannot be read', () => {
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(cliVersion()).toBe('unknown');
    spy.mockRestore();
  });
});
