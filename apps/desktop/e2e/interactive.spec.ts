import { expect, test } from './fixtures';

test.describe('interactive answers', () => {
  test('sliders update estimates by keyboard, reveal warnings and send the selected plan', async ({ lab, page }) => {
    await lab.open();
    await lab.chat('Cache sizing').click();
    const widget = page.locator('.assistant .hui');
    await expect(widget).toBeVisible();
    const sliders = widget.locator('input[type="range"]');
    const stats = widget.locator('.hui-stat__value');
    await expect(sliders).toHaveCount(2);
    await expect(stats).toHaveCount(2);
    const initial = await stats.first().textContent();
    const warning = widget.getByText('More than 500 requests per second reach the database.', { exact: true });
    await expect(warning).toBeHidden();
    await sliders.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(stats.first()).not.toHaveText(initial ?? '');
    await page.keyboard.press('End');
    await expect(warning).toBeVisible();
    await widget.getByRole('button', { name: 'Plan for this load', exact: true }).click();
    await expect(page.locator('.user').filter({ hasText: 'Plan the cache for 5000 requests per second at a 80 % hit rate' })).toBeVisible();
  });

  test('a user fence remains readable code', async ({ lab, page }) => {
    await lab.open();
    await lab.chat('Cache sizing').click();
    const fence = '```hermes-ui\n{"body":[{"type":"text","text":"User-owned JSON"}]}\n```';
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(fence);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const user = page.locator('.user').filter({ hasText: 'User-owned JSON' });
    await expect(user.locator('pre code')).toContainText('User-owned JSON');
    await expect(user.locator('.hui')).toHaveCount(0);
  });

  test('safe mode keeps the source visible and the instruction preference read-only', async ({ lab, page }) => {
    await lab.open('safe');
    await lab.chat('Cache sizing').click();
    await expect(page.locator('.assistant pre code').filter({ hasText: '"title":"Cache sizing"' })).toBeVisible();
    await expect(page.locator('.hui')).toHaveCount(0);
    const settings = await lab.openSettings();
    await settings.getByRole('button', { name: 'General', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Interactive answers' });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
  });

  test('the instruction switch survives reload without disabling existing interfaces', async ({ lab, page }) => {
    await lab.open();
    const settings = await lab.openSettings();
    await settings.getByRole('button', { name: 'General', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Interactive answers' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.reload();
    await expect(lab.sidebar).toBeVisible();
    await lab.openSettings();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'General', exact: true }).click();
    await expect(toggle).not.toBeChecked();
    await lab.chat('Cache sizing').click();
    await expect(page.locator('.assistant .hui')).toBeVisible();
  });
});
