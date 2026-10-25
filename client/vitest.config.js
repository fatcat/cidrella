import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { sharedAlias } from './shared-modules.js';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: sharedAlias },
  test: {
    include: ['tests/**/*.test.js'],
    // happy-dom rather than jsdom: it is markedly faster to boot and this suite
    // needs a DOM, not browser fidelity. Pure-function tests under tests/unit/utils
    // are unaffected by having a DOM present.
    environment: 'happy-dom',
    setupFiles: ['tests/setup.js'],
    // Off unless a run passes --coverage (CI does, for SonarQube Cloud).
    // Paths in lcov.info are relative to the repository root, as the scanner
    // reads them.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,vue}'],
      reporter: [['lcov', { projectRoot: '..' }]],
      reportsDirectory: 'coverage',
    },
  },
});
