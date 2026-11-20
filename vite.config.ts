/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  test: {
    // Image decoding runs in a worker thread; the tests compile one (tests/setup/imageWorker.ts)
    globalSetup: ['tests/setup/imageWorker.ts'],
    env: {
      WEBRING_IMAGE_WORKER: resolve(__dirname, 'node_modules/.cache/webring-image-worker/imageWorker.js'),
    },
  },
});
