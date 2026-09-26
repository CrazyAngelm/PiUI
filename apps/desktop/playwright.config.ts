import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E against the deterministic UI Lab host (`?lab=demo`): no Tauri,
 * no native harness, no model turns. `lab` runs the Vite dev server; `prod-csp`
 * serves the production build under the app's real Content-Security-Policy.
 *
 * Local runs use the installed Microsoft Edge so nothing is downloaded; CI
 * installs Playwright's bundled Chromium. `PIUI_E2E_CHANNEL` overrides the
 * channel (`chromium` selects the bundled browser).
 */
const ci = Boolean(process.env.CI);
const labPort = Number(process.env.PIUI_E2E_LAB_PORT ?? 5391);
const prodPort = Number(process.env.PIUI_E2E_PROD_PORT ?? 5392);
const channelSetting = process.env.PIUI_E2E_CHANNEL ?? (ci ? 'chromium' : 'msedge');
const channel = channelSetting === 'chromium' ? undefined : channelSetting;

/** Start only the servers of the projects this invocation runs. */
const requestedProjects = process.argv.flatMap((argument, index, all) =>
  argument === '--project' ? [all[index + 1] ?? ''] : argument.startsWith('--project=') ? [argument.slice('--project='.length)] : [],
);
const runs = (project: string): boolean => requestedProjects.length === 0 || requestedProjects.includes(project);

const browser = { ...devices['Desktop Chrome'], channel, viewport: { width: 1280, height: 860 } };

export default defineConfig({
  testDir: './e2e',
  // Warms the dev server's lazy views; skipped when only prod-csp runs.
  globalSetup: runs('lab') ? './e2e/global-setup.ts' : undefined,
  outputDir: './test-results/playwright',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: Number(process.env.PIUI_E2E_WORKERS ?? (ci ? 2 : 4)),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: ci
    ? [['list'], ['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    {
      name: 'lab',
      testIgnore: /csp\.spec\.ts/,
      use: { ...browser, baseURL: `http://127.0.0.1:${labPort}` },
    },
    {
      name: 'prod-csp',
      testMatch: /csp\.spec\.ts/,
      use: { ...browser, baseURL: `http://127.0.0.1:${prodPort}` },
    },
  ],
  webServer: [
    ...(runs('lab')
      ? [{
          command: `pnpm exec vite --host 127.0.0.1 --port ${labPort} --strictPort`,
          url: `http://127.0.0.1:${labPort}/`,
          reuseExistingServer: !ci,
          timeout: 120_000,
          stdout: 'ignore' as const,
          stderr: 'pipe' as const,
        }]
      : []),
    ...(runs('prod-csp')
      ? [{
          // Builds dist/ first, then serves it with the CSP from tauri.conf.json.
          command: `node e2e/serve-dist.mjs --port ${prodPort}`,
          url: `http://127.0.0.1:${prodPort}/`,
          reuseExistingServer: false,
          timeout: 180_000,
          stdout: 'pipe' as const,
          stderr: 'pipe' as const,
        }]
      : []),
  ],
});
