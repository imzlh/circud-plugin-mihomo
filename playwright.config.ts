import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const systemChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const systemChromium = '/usr/bin/chromium';

export default defineConfig({
  testDir: './tests',
  // These suites exercise the removed standalone-UI contract (browser-owned
  // Controller URL/Secret, multi-controller sessions, and local production
  // profile storage). Keep them as migration history, but do not treat them as
  // release tests for the circud-managed product.
  testIgnore: [
    '**/logs.spec.ts',
    '**/profile-enhancement-editor.spec.ts',
    '**/profiles-batch.spec.ts',
    '**/proxy-delay.spec.ts',
    '**/proxy-preferences.spec.ts',
    '**/resource-actions.spec.ts',
  ],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { outputFolder: '.verification/report', open: 'never' }]],
  outputDir: '.verification/test-results',
  use: {
    baseURL: 'http://127.0.0.1:5179/io.cno.mihomo/',
    browserName: 'chromium',
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROME_PATH ??
        (existsSync(systemChrome)
          ? systemChrome
          : existsSync(systemChromium)
            ? systemChromium
            : undefined),
    },
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 5179 --strictPort',
    url: 'http://127.0.0.1:5179/io.cno.mihomo/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
