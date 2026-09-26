import { readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Page } from '@playwright/test';
import { panelHeaders, PLUGIN_ORIGIN_WINDOWS, uiBase } from '../src/host-api/pluginFrame';
import { expect, test } from './fixtures';

/**
 * Plugins under the production CSP (prod-csp project): the app policy frames
 * only the plugin protocol origin, and the panel document carries its own
 * policy. The host's `piui-plugin` protocol is stood in for by a route that
 * answers with the same headers (`pluginFrame.ts`, shared with csp.rs via
 * the golden fixture). Any violation in PiUI's document fails.
 */
const APP_CSP: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')).app.security.csp;
const HELLO_ROOT = resolve(import.meta.dirname, '..', '..', '..', 'examples', 'plugins', 'hello-command');
const HELLO_ID = 'example.hello-command';

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__cspViolations ?? []);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.violatedDirective} blocked=${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}`);
    });
  });
  await page.route(`${PLUGIN_ORIGIN_WINDOWS}/**`, async (route) => {
    const url = new URL(route.request().url());
    const [, id = '', ...rest] = url.pathname.split('/');
    const path = rest.join('/');
    const base = uiBase(HELLO_ID, 'ui/index.html');
    const file = resolve(HELLO_ROOT, path);
    const headers = id === HELLO_ID && path.startsWith('ui/') && file.startsWith(HELLO_ROOT + sep) ? panelHeaders(PLUGIN_ORIGIN_WINDOWS, base, path) : undefined;
    if (headers === undefined || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    await route.fulfill({ status: 200, headers, body: readFileSync(file) });
  });
});

test('the app policy frames only the plugin origin', () => {
  expect(APP_CSP).toContain(`frame-src ${PLUGIN_ORIGIN_WINDOWS} piui-plugin:;`);
  expect(APP_CSP).not.toMatch(/frame-src[^;]*(\*|'self'|https:)/);
});

test('a plugin panel, the trust review and a plugin theme run under the app CSP', async ({ lab, page }) => {
  test.slow();
  const consoleCsp: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|refused to (load|apply|execute|connect|frame)/i.test(message.text())) consoleCsp.push(message.text());
  });
  const clean = async (step: string) => {
    await expect(page.locator('body'), `pointer events after: ${step}`).toHaveCSS('pointer-events', 'auto');
    expect(await violations(page), `CSP violations after: ${step}`).toEqual([]);
    expect(consoleCsp, `CSP console errors after: ${step}`).toEqual([]);
  };

  await lab.open();
  await lab.chat(/Plan a weekend in Lisbon/).click();
  await page.getByRole('button', { name: 'Details' }).click();
  const frame = page.locator('iframe[title="Hello panel (plugin panel)"]');
  await expect(frame).toHaveAttribute('src', `${PLUGIN_ORIGIN_WINDOWS}/${HELLO_ID}/ui/index.html?panel=hello`);
  const content = page.frameLocator('iframe[title="Hello panel (plugin panel)"]');
  // The panel's own files load under its policy and the bridge answers.
  await expect(content.getByText('Open chat: Plan a weekend in Lisbon')).toBeVisible();
  await expect(content.getByText('Greeting: Hello')).toBeVisible();
  await clean('a chat with a plugin panel');

  // Settings → Plugins and the trust review open and close cleanly.
  await lab.openSettings();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Plugins' }).click();
  await page.getByRole('button', { name: 'Install from folder…' }).click();
  const review = page.getByRole('dialog', { name: 'Install Word count?' });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toBeHidden();
  await clean('the trust review');

  // A plugin theme applies its colors through the CSSOM, which the policy allows.
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'General' }).click();
  await page.getByLabel('Plugin theme').selectOption({ label: 'Midnight (Dark) · Midnight and Paper themes' });
  await expect(page.locator('html')).toHaveAttribute('data-plugin-theme', 'midnight');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(15, 20, 32)');
  await clean('a plugin theme');
});
