import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.STREAMORA_API ?? 'http://localhost:8484';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev: cookies, SSE and HLS requests all go through the proxy.
    proxy: { '/api': { target: API_TARGET } },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The player chunk is mostly hls.js and is only loaded when playback starts.
    chunkSizeWarningLimit: 700,
  },
});
