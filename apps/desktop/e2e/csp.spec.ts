import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * The production build (`vite build`) served with the desktop app's exact
 * Content-Security-Policy (see serve-dist.mjs). The UI Lab host runs inside
 * it because there is no Tauri bridge. Any `securitypolicyviolation` event or
 * console CSP error fails: a blocked inline style can silently break layout or
 * leave the page unclickable after a dialog closes.
 */
const APP_CSP: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')).app.security.csp;

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
      window.__cspViolations?.push(`${event.violatedDirective} blocked=${event.blockedURI} sample=${event.sample} at ${event.sourceFile}:${event.lineNumber}`);
    });
  });
});

test('the server applies the app CSP from tauri.conf.json', async ({ request }) => {
  const response = await request.get('/?lab=demo');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-security-policy']).toBe(APP_CSP);
  // Inline scripts and eval stay forbidden; only two exact style attribute
  // values are allowed by hash (empty, and Svelte's `display: contents` wrapper).
  expect(APP_CSP).toContain("script-src 'self';");
  expect(APP_CSP).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
});

test('main screens run under the app CSP without violations', async ({ lab, page }) => {
  test.slow();
  const consoleCsp: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|refused to (load|apply|execute|connect|frame)/i.test(message.text())) consoleCsp.push(message.text());
  });
  const clean = async (step: string) => {
    // Modal cleanup restores the body style; a blocked reset leaves it unclickable.
    await expect(page.locator('body'), `pointer events after: ${step}`).toHaveCSS('pointer-events', 'auto');
    expect(await violations(page), `CSP violations after: ${step}`).toEqual([]);
    expect(consoleCsp, `CSP console errors after: ${step}`).toEqual([]);
  };

  await lab.open();
  await clean('startup');

  // Chat: a waiting approval, then a new streamed chat.
  await lab.chat(/Fix flaky scheduler test/).click();
  await expect(page.getByRole('article', { name: 'Permission request' })).toBeVisible();
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await page.keyboard.press('Escape');
  await clean('chat and its menu');
  await lab.nav('New chat').click();
  const home = page.getByRole('region', { name: 'What should we work on?' });
  await home.getByRole('button', { name: 'Default model' }).click();
  await lab.option(/^Claude Lab Sonnet/).click();
  await home.getByRole('textbox', { name: 'Message' }).fill('Explain the event bus');
  await home.getByRole('button', { name: 'Start chat' }).click();
  await expect(page.getByRole('region', { name: 'Conversation messages' }).getByRole('blockquote')).toBeVisible({ timeout: 20_000 });
  await clean('new streamed chat');

  // Pipeline editor: a template, a node inspector, a script node with its code.
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: /^Review loop/ }).click();
  await editor.getByRole('application').getByRole('group', { name: 'Reviewer', exact: true }).click();
  await page.getByRole('complementary', { name: 'Node settings' }).getByRole('tab', { name: 'Flow' }).click();
  await editor.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Script', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Node settings' });
  await expect(inspector.getByRole('note')).toContainText('It is not a sandbox');
  await inspector.getByRole('button', { name: 'Insert example' }).click();
  await expect(inspector.getByRole('textbox', { name: 'Code' })).toHaveValue(/process\.stdin/);
  await clean('pipeline editor with a script node');

  // Leaving the unsaved draft asks first; discard and open Runs.
  await lab.nav('Runs').click();
  await page.getByRole('dialog', { name: 'Leave the pipeline editor?' }).getByRole('button', { name: 'Discard changes' }).click();
  const runs = page.getByRole('navigation', { name: 'Runs' });
  await runs.getByRole('button', { name: /^Succeeded Code review/ }).click();
  const run = page.getByRole('region', { name: 'Run' });
  await run.getByRole('application').getByRole('group', { name: 'Reviewer', exact: true }).click();
  await page.getByRole('tablist', { name: 'Step details' }).getByRole('tab', { name: 'Conversation' }).click();
  await clean('runs with the step panel');

  // Automations: the schedule dialog opens and closes.
  const automations = await lab.openAutomations();
  await automations.getByRole('button', { name: 'New automation' }).click();
  await expect(page.getByRole('dialog', { name: 'New automation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'New automation' })).toBeHidden();
  await clean('automations and the schedule dialog');

  // Settings: theme and language, then the palette.
  await lab.openSettings();
  await page.getByRole('group', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
  await page.getByRole('group', { name: 'Language' }).getByRole('radio', { name: 'Русский' }).click();
  await page.getByRole('group', { name: 'Язык' }).getByRole('radio', { name: 'English' }).click();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Search and commands' })).toBeVisible();
  await page.keyboard.press('Escape');
  await clean('settings and the palette');

  // The page is still operable with the pointer after every dialog closed.
  await lab.nav('Inbox').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await page.waitForTimeout(300);
  await clean('end');
});
