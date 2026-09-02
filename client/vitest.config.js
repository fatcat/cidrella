import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['tests/**/*.test.js'],
    // happy-dom rather than jsdom: it is markedly faster to boot and this suite
    // needs a DOM, not browser fidelity. Pure-function tests under tests/unit/utils
    // are unaffected by having a DOM present.
    environment: 'happy-dom',
    setupFiles: ['tests/setup.js'],
  },
});
