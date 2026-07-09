import { describe, it, expect, vi, afterEach } from 'vitest';
import { main } from '../src/index';

// These invocations must fail BEFORE any network call or settings write.
describe('argument parsing failure modes', () => {
  afterEach(() => vi.restoreAllMocks());

  const run = async (argv: string[]): Promise<{ code: number; err: string }> => {
    let err = '';
    vi.spyOn(console, 'error').mockImplementation((m: string) => {
      err += `${m}\n`;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(argv);
    return { code, err };
  };

  it('--url with a missing value exits 1 instead of silently using the default server', async () => {
    for (const argv of [
      ['init', '--url'],
      ['init', '--url', '--minimal'],
      ['init', '--code'],
      ['init', '--secret', '--minimal'],
    ]) {
      const { code, err } = await run(argv);
      expect(code).toBe(1);
      expect(err).toMatch(/Missing value/);
    }
  });

  it('--url=value form is accepted (fails later on unreachable host, not on parsing)', async () => {
    const { code, err } = await run(['init', '--url=http://127.0.0.1:9', '--no-qr']);
    expect(code).toBe(1);
    expect(err).toMatch(/Could not reach http:\/\/127\.0\.0\.1:9/);
  });

  it('unknown flags and stray arguments are rejected', async () => {
    expect((await run(['init', '--ulr', 'x'])).code).toBe(1);
    expect((await run(['init', 'extra-arg'])).code).toBe(1);
    expect((await run(['init', '--frobnicate=1'])).code).toBe(1);
  });
});
