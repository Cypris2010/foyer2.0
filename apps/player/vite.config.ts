import { defineConfig } from 'vite';

export default defineConfig({
  base: '/player/',
  build: {
    // Airtame 2 runs an older embedded Chromium (KONZEPT 2.2).
    target: 'es2017',
    cssTarget: 'chrome61',
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
});
