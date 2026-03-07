import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  define: {
    'import.meta.env.VITE_TRACKING': JSON.stringify(process.env.VITE_TRACKING === '1')
  },
  server: {
    proxy: {
      '/api': {
        target: 'https://localhost:8443',
        secure: false,
        changeOrigin: true
      }
    }
  }
});
