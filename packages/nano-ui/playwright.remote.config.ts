import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// The remote shell E2E: the built `dist-remote` bundle in a real browser, talking to a scripted
// relay and a desktop backed by the UI Lab host (tests/remote-harness.ts). It starts its own
// servers, so there is no webServer. The base URL is only the scope of the persistent browser
// profile (see tests/browserFixture.ts); the harness picks a free port itself.
const port = Number(process.env.NANO_REMOTE_TEST_PORT ?? 5394);
const channel = process.env.PIUI_E2E_CHANNEL ?? (process.env.CI ? 'chromium' : 'msedge');

export default defineConfig({
  testDir: './tests',
  testMatch: 'remote.spec.ts',
  workers: 1,
  timeout: 60_000,
  outputDir: process.env.NANO_REMOTE_TEST_OUTPUT ?? join(tmpdir(), 'nano-remote-test-results'),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: channel === 'chromium' ? undefined : channel,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'shared-remote' }],
});
