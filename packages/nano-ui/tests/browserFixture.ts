import { test as base, expect, type BrowserContext } from '@playwright/test';
import { windowsBrowserProfile } from '../../../apps/desktop/e2e/persistent-browser';

// Use the persistent context itself. Creating an extra incognito context from
// its Browser and closing both was the earlier fixture's teardown failure.
export const test = base.extend<object, { persistent: BrowserContext }>({
  persistent: [async ({ playwright, channel, headless, launchOptions }, use, workerInfo) => {
    const profile = windowsBrowserProfile(`graph-static-${workerInfo.parallelIndex}`, workerInfo.project.use.baseURL ?? '');
    const context = await playwright.chromium.launchPersistentContext(profile ?? '.browser-profile', {
      ...launchOptions, channel, headless, viewport: workerInfo.project.use.viewport,
    });
    try { await use(context); } finally { await context.close(); }
  }, { scope: 'worker' }],
  context: async ({ persistent }, use) => { await use(persistent); },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    try { await use(page); } finally { await page.close(); }
  },
});
export { expect };
