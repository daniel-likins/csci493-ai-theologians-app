import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: '127.0.0.1',
    port: 5183,
    strictPort: true,
    // The dev backend (npm run dev) listens on 47832. Host header is preserved so the guard can check it.
    proxy: { '/api': { target: 'http://127.0.0.1:47832', changeOrigin: false } },
  },
});
