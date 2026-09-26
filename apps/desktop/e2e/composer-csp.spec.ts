import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Composer inputs in the production build under the desktop app's CSP
 * (`img-src 'self' asset:`; the `prod-csp` project serves it). Image
 * previews are decoded in memory and drawn on a canvas, so no `blob:` or
 * `data:` URL may appear and no violation may be reported.
 */
declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

const SCREENSHOT = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAY0lEQVR4nGPQUtMYVIhhwF0w6qAh76AKDYtBhUYdNPQchJam3rx4RGdEIJchK63IK6EEUd9Bgy6ERh005BxEYaImMrEP5RAaddCQc9BoST3qoGHnoNGSGpuDBhyNOmjUQZQiAPldjjHC8MlzAAAAAElFTkSuQmCC';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.violatedDirective} blocked=${event.blockedURI} sample=${event.sample}`);
    });
  });
});

async function paste(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ({ name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: 'image/png' }));
      document.querySelector('textarea[aria-label="Message"]')
        ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { name, base64: SCREENSHOT },
  );
}

test('composer attachments, previews and menus run under the app CSP without violations', async ({ lab, page }) => {
  const consoleCsp: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|refused to (load|apply|execute|connect|frame)/i.test(message.text())) consoleCsp.push(message.text());
  });
  await lab.open();
  const home = page.getByRole('region', { name: 'What should we work on?' });
  const message = home.getByRole('textbox', { name: 'Message' });
  await message.fill('Check this');
  await home.getByRole('button', { name: 'Attach images or files' }).click();
  await page.getByRole('dialog', { name: 'Reference this file by its path?' }).getByRole('button', { name: 'Insert references' }).click();
  await paste(page, 'pasted.png');
  const images = home.getByRole('list', { name: 'Attached images' });
  await expect(images.getByRole('img', { name: 'Preview of pasted.png' })).toBeVisible();
  await expect(images.getByRole('img', { name: 'Preview of lab-screenshot.png' })).toBeVisible();
  // Both previews were drawn (a canvas with pixels, not an image URL).
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('ul canvas')].filter((canvas) => (canvas as HTMLCanvasElement).width > 0).length)).toBe(2);
  expect(await page.evaluate(() => document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length)).toBe(0);
  await message.press('End');
  await message.pressSequentially(' @chat/comp');
  await expect(page.getByRole('listbox', { name: 'Project files' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveCSS('pointer-events', 'auto');
  expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
  expect(consoleCsp).toEqual([]);
});
