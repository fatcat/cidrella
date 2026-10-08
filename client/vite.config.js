import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { sharedAlias } from './shared-modules.js';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: sharedAlias },
  define: {
    'import.meta.env.VITE_TRACKING': JSON.stringify(process.env.VITE_TRACKING === '1'),
  },
  server: {
    // The @shared alias resolves outside client/, so the dev server needs a
    // grant beyond the project root. Scope it to exactly that directory.
    //
    // allow: ['..'] granted the whole repo, and `npm run dev:client` is
    // `vite --host`, so anyone who could reach port 5173 could fetch
    // /@fs/<repo>/server/data/cidrella.db. Verified: HTTP 200, the full 6.4MB
    // dev database, which holds credentials and audit log contents. The same
    // file is excluded from release tarballs by .buildignore for that reason.
    fs: { allow: ['.', '../server/src/utils'] },
    proxy: {
      '/api': {
        target: 'https://localhost:8443',
        secure: false,
        changeOrigin: true,
      },
    },
  },
});
