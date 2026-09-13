import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
    // Explicit, loopback-probed ports for supertest's throwaway servers — see test/setup.ts.
    setupFiles: ['test/setup.ts'],
  },
});
