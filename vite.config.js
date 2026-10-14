import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        bench: resolve(import.meta.dirname, 'bench.html'),
      },
    },
  },
});
