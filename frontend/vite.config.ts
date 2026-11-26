import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig(({ mode }) => {
  // `npm run dev` serves the API on DEV_PORT (default 8483, see backend/src/config.ts),
  // so it never clashes with the desktop app or `npm start` on 8484.
  const env = loadEnv(mode, REPO_ROOT, ['DEV_PORT', 'STREAMORA_API']);
  const apiTarget = env.STREAMORA_API ?? `http://localhost:${env.DEV_PORT || 8483}`;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // Same-origin in dev: cookies, SSE and HLS requests all go through the proxy.
      proxy: { '/api': { target: apiTarget } },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      // The player chunk is mostly hls.js and is only loaded when playback starts.
      chunkSizeWarningLimit: 700,
    },
  };
});
