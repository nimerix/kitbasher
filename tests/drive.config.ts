import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

// A separate server supplies a public test client id without changing a developer's running app.
export default defineConfig(base, {
  testDir: './e2e',
  testMatch: 'google-drive.spec.ts',
  testIgnore: [],
  outputDir: '../test-results-drive',
  use: {
    baseURL: 'http://127.0.0.1:5178',
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:5178',
          localStorage: [
            { name: 'kitbasher.avoid-clipping', value: '{"enabled":false,"overlap":0.1}' },
          ],
        },
      ],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5178 --strictPort',
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: false,
    env: { VITE_GOOGLE_CLIENT_ID: 'kitbasher-test.apps.googleusercontent.com' },
  },
});
