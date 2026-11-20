/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import type { Plugin } from 'vite';

/**
 * The window's CSP is strict in index.html (script-src 'self'). Vite's dev server needs inline
 * scripts (React refresh) and a websocket (HMR), so only `vite` (serve) relaxes it; `vite build`
 * keeps the strict policy.
 */
function devOnlyCspRelaxation(): Plugin {
  return {
    name: 'studio-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline' http://localhost:*")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");
    },
  };
}

export default defineConfig({
  plugins: [react(), devOnlyCspRelaxation()],
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
  test: {
    // Image decoding runs in a worker thread; the tests compile one (tests/setup/imageWorker.ts)
    globalSetup: ['tests/setup/imageWorker.ts'],
    env: {
      WEBRING_IMAGE_WORKER: resolve(import.meta.dirname, 'node_modules/.cache/webring-image-worker/imageWorker.js'),
    },
  },
});
