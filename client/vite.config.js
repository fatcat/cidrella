import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { sharedAlias } from './shared-modules.js';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: sharedAlias },
  define: {
    'import.meta.env.VITE_TRACKING': JSON.stringify(process.env.VITE_TRACKING === '1')
  },
  server: {
    // The @shared alias resolves outside client/, so the dev server has to be
    // allowed to serve from the repo root.
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: 'https://localhost:8443',
        secure: false,
        changeOrigin: true
      }
    }
  }
});
