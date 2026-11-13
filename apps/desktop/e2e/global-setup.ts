import { chromium, type FullConfig } from '@playwright/test';
import { windowsBrowserProfile } from './persistent-browser';

/**
 * Warms the Vite dev server once before the workers start: the first visit of
 * each lazy view (pipeline editor, runs, automations…) makes Vite transform its
 * modules, which can take seconds on a cold server and races the specs' waits.
 * The production (`prod-csp`) project is prebuilt and needs no warm-up.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const lab = config.projects.find((project) => project.name === 'lab');
  const baseURL = lab?.use.baseURL;
  if (!lab || !baseURL) return;
  const profile = windowsBrowserProfile('warmup', baseURL);
  const persistent = profile
    ? await chromium.launchPersistentContext(profile, { channel: lab.use.channel })
    : undefined;
  const browser = persistent ? persistent.browser() : await chromium.launch({ channel: lab.use.channel });
  if (!browser) {
    await persistent?.close();
    throw new Error('Persistent Chromium context has no browser.');
  }
  try {
    const page = await browser.newPage();
    // Cold module transformation is covered by the existing landmark readiness
    // bound below; waiting for every load resource here used the shorter default
    // navigation deadline and failed before that readiness check could run.
    await page.goto(`${baseURL}/?lab=demo`, { waitUntil: 'commit' });
    const sidebar = page.getByRole('navigation', { name: 'Workspace navigation' });
    await sidebar.waitFor({ timeout: 120_000 });
    const visit = async (name: RegExp, ready: () => Promise<unknown>) => {
      await sidebar.getByRole('button', { name }).first().click();
      await ready();
    };
    await visit(/^Pipelines$/, () => page.getByRole('region', { name: 'Pipeline editor' }).waitFor({ timeout: 120_000 }));
    await visit(/^Runs$/, () => page.getByRole('navigation', { name: 'Runs' }).waitFor({ timeout: 120_000 }));
    await visit(/^Automations$/, () => page.getByRole('region', { name: 'Automations' }).waitFor({ timeout: 120_000 }));
    await visit(/^Settings/, () => page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ timeout: 120_000 }));
    await visit(/^Inbox/, () => page.getByRole('heading', { level: 1, name: 'Inbox' }).waitFor({ timeout: 120_000 }));
    await visit(/Fix flaky scheduler test/, () => page.getByRole('region', { name: 'Conversation messages' }).waitFor({ timeout: 120_000 }));
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Search and commands' }).waitFor({ timeout: 120_000 });
  } finally {
    await browser.close();
  }
}
