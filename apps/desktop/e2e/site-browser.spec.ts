import { expect, test } from './fixtures';

test('opens browser chrome, navigates with the keyboard and keeps separate tabs', async ({ page, lab }) => {
  await lab.open();
  const [browser] = await Promise.all([
    page.context().waitForEvent('page'),
    lab.page.getByRole('button', { name: 'Browser', exact: true }).click(),
  ]);
  const address = browser.getByRole('textbox', { name: 'Website address' });
  await address.fill('example.org/docs');
  await address.press('Enter');
  await expect(address).toHaveValue('https://example.org/docs');
  await browser.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(address).toHaveValue('');
  await address.fill('file:///etc/passwd');
  await address.press('Enter');
  await expect(browser.getByRole('status')).toHaveText('Enter a valid HTTP or HTTPS address.');
  await browser.getByRole('button', { name: 'example.org', exact: true }).click();
  await expect(address).toHaveValue('https://example.org/docs');
  await browser.close();
});
