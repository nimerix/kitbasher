import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: 'google-drive.spec.ts',
  timeout: 45000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    headless: true,
    channel: 'chrome',
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
    // These tests place parts inside each other freely. clipping.spec.ts covers the default.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:5173',
          localStorage: [
            { name: 'kitbasher.avoid-clipping', value: '{"enabled":false,"overlap":0.1}' },
          ],
        },
      ],
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
