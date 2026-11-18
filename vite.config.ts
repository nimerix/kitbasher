import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { releaseCommits } from './scripts/release-commits.mjs';

/** The short hash of the commit being built. Cloudflare's builds name it; elsewhere ask git. */
function buildCommit() {
  const ci = process.env.WORKERS_CI_COMMIT_SHA;
  if (ci) return ci.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  // Relative asset URLs let dist/ run from any path, such as a GitHub Pages project site.
  base: './',
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(buildCommit()),
    'import.meta.env.VITE_RELEASE_COMMITS': JSON.stringify(JSON.stringify(releaseCommits())),
  },
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
