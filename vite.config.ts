import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { host: true, port: 5174, open: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
