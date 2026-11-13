import { expect, test } from './fixtures';

test.describe('built-in styles', () => {
  test('starts in Nano and changes style independently from appearance by keyboard', async ({ lab, page }) => {
    await lab.open();
    await expect(page.locator('html')).toHaveAttribute('data-style', 'nano');
    await lab.openSettings();
    const identityColors = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return ['chaos', 'chaos-gold', 'chaos-spark', 'accent'].map((token) => css.getPropertyValue(`--piui-${token}`).trim());
    });
    expect(new Set(identityColors).size).toBe(identityColors.length);
    const styles = page.getByRole('group', { name: 'Visual style', exact: true });
    const appearance = page.getByRole('group', { name: 'Theme', exact: true });
    await appearance.getByRole('radio', { name: 'Light', exact: true }).press('Enter');
    await styles.getByRole('radio', { name: 'Nano', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(styles.getByRole('radio', { name: 'Chaos', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'chaos');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-action').trim())).toBe('#9e354e');
    await styles.getByRole('radio', { name: 'Nano', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-action').trim())).toBe('#107150');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-decoration-marker-shape').trim())).toBe('none');
    await styles.getByRole('radio', { name: 'Chaos', exact: true }).press('Enter');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-style', 'chaos');
    await lab.openSettings();
    await expect(styles.getByRole('radio', { name: 'Chaos', exact: true })).toBeChecked();
  });

  test('follows system appearance in both styles', async ({ lab, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await lab.open();
    await lab.openSettings();
    const styles = page.getByRole('group', { name: 'Visual style', exact: true });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('#ebefee');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('#101513');
    await styles.getByRole('radio', { name: 'Chaos', exact: true }).click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('#131214');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('#f4f4f4');
  });

  test('reports blocked persistence while still applying the choice', async ({ lab, page }) => {
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string): void {
        if (key === 'piui.appearance.style') throw new DOMException('Storage blocked', 'SecurityError');
        setItem.call(this, key, value);
      };
    });
    await lab.open();
    await lab.openSettings();
    await page.getByRole('group', { name: 'Visual style', exact: true }).getByRole('radio', { name: 'Chaos', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'chaos');
    await expect(page.getByRole('status').filter({ hasText: 'This style could not be saved.' })).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-style', 'nano');
  });

  test('keeps the fallback of partial plugin palettes across style changes', async ({ lab, page }) => {
    await lab.open();
    await lab.openSettings();
    await page.getByLabel('Plugin theme', { exact: true }).selectOption(JSON.stringify(['example.midnight-theme', 'partial']));
    const action = () => page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return [css.getPropertyValue('--piui-action').trim(), css.getPropertyValue('--piui-action-ink').trim()];
    });
    await expect.poll(action).toEqual(['#9e354e', '#eeeeee']);
    const ornament = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-decoration-secondary').trim());
    await expect.poll(ornament).toBe('#f0c050');
    await page.getByRole('group', { name: 'Visual style', exact: true }).getByRole('radio', { name: 'Chaos', exact: true }).click();
    await expect.poll(action).toEqual(['#9e354e', '#eeeeee']);
    await page.getByRole('group', { name: 'Visual style', exact: true }).getByRole('radio', { name: 'Nano', exact: true }).click();
    await expect.poll(action).toEqual(['#9e354e', '#eeeeee']);
    await expect.poll(ornament).toBe('#f0c050');
    await page.getByLabel('Plugin theme', { exact: true }).selectOption('');
    await expect.poll(action).toEqual(['#10845e', '#ffffff']);
  });

  test('works in safe mode without Nano requests from the WebView', async ({ lab, page }) => {
    const nanoRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).hostname.endsWith('nanoagents.ru')) nanoRequests.push(request.url());
    });
    await lab.open('safe');
    await lab.openSettings();
    const styles = page.getByRole('group', { name: 'Visual style', exact: true });
    await styles.getByRole('radio', { name: 'Chaos', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'chaos');
    await styles.getByRole('radio', { name: 'Nano', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'nano');
    expect(nanoRequests).toEqual([]);
  });
});
