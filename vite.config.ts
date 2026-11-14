import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset URLs let dist/ run from any path, such as a GitHub Pages project site.
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    headers:
      process.env.KITBASHER_CROSS_ORIGIN_ISOLATED === '1'
        ? {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          }
        : undefined,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rolldownOptions: { input: { app: 'index.html', docs: 'docs/index.html' } },
  },
});
