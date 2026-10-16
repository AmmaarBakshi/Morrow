import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.MORROW_API_URL ?? 'http://localhost:4400';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in development so the session cookie and CSRF flow match production.
    proxy: Object.fromEntries(['/api', '/u', '/t', '/webhooks', '/verify-sender', '/healthz', '/readyz'].map((p) => [p, { target: api, changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
