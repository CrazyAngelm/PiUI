import { defineConfig } from '@playwright/test';

const port = Number(process.env.NANO_UI_TEST_PORT ?? 5393);
const channel = process.env.PIUI_E2E_CHANNEL ?? (process.env.CI ? 'chromium' : 'msedge');

export default defineConfig({
  testDir: './tests',
  testMatch: 'graph.spec.ts',
  // Root measured 2.84 GiB free RAM with concurrent repository builds.
  workers: 1,
  outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: channel === 'chromium' ? undefined : channel,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'shared-graph' }],
  webServer: {
    command: `node tests/static-server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/tests/host.html`,
    reuseExistingServer: false,
  },
});
