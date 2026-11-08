import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset URLs let dist/ run from any path, such as a GitHub Pages project site.
  base: './',
  plugins: [react()],
  server: { host: '0.0.0.0' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
