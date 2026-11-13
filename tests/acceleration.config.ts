import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

export default defineConfig({
  ...base,
  testDir: './e2e',
  outputDir: '../test-results-acceleration',
  testMatch: 'acceleration*.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5174' },
  webServer: {
    command: 'npm run dev -- --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    env: { KITBASHER_CROSS_ORIGIN_ISOLATED: '1' },
    timeout: 30_000,
  },
});
