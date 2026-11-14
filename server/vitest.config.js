import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 10000,
    // A named supervisor: the proxy client never starts a DNS proxy process
    // of its own in a test; a test that wants one spawns it.
    env: { CIDRELLA_DNS_PROXY_SUPERVISOR: 'test' },
    // Off unless a run passes --coverage (CI does, for SonarQube Cloud).
    // Paths in lcov.info are relative to the repository root, as the scanner
    // reads them.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: [['lcov', { projectRoot: '..' }]],
      reportsDirectory: 'coverage',
    },
  },
});
