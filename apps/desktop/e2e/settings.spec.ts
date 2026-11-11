import { expect, test } from './fixtures';

/**
 * Settings → Background in the UI Lab: the host's background-v1 checks and
 * replies without a tray icon or a sign-in registration. The native tray and
 * autostart are covered by the Rust tests, not here.
 */
const LOGIN = /^Start Nano Desktop when I sign in( to Windows)?$/;

test.describe('Settings → General and Shortcuts', () => {
  test('language and density rows carry no extra descriptions', async ({ lab, page }) => {
    await lab.open();
    await lab.openSettings();
    await expect(page.getByRole('heading', { level: 2, name: 'General' })).toBeVisible();
    await expect(page.getByText('Chats and prompts are never translated.', { exact: true })).toBeVisible();
    await expect(page.getByText('Compact fits more rows in lists and panels.')).toHaveCount(0);
    await expect(page.getByText('Interface language.')).toHaveCount(0);
  });

  test('shortcuts list chat search, review and the board keys', async ({ lab, page }) => {
    await lab.open();
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Shortcuts' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Shortcuts' })).toBeVisible();
    for (const label of ['Search this chat', 'Review changes', 'Toggle chat details']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    const search = page.locator('.row', { hasText: 'Search this chat' });
    await expect(search.locator('kbd')).toHaveText([/^(Ctrl|⌘)$/, 'F']);
    const review = page.locator('.row', { hasText: 'Review changes' });
    await expect(review.locator('kbd').last()).toHaveText('G');

    await expect(page.getByRole('heading', { level: 3, name: 'Board' })).toBeVisible();
    for (const label of ['Move between cards', 'Move a card to another status', 'Open a card', 'New card', 'Filter cards']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });
});

test.describe('Settings → Background', () => {
  test('tray and sign-in options turn on, stay on and turn off', async ({ lab, page }) => {
    await lab.open();
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Background' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Background' })).toBeVisible();
    const tray = page.getByRole('switch', { name: 'Keep running in the tray when the window is closed' });
    const login = page.getByRole('switch', { name: LOGIN });
    await expect(tray).not.toBeChecked();
    await expect(login).not.toBeChecked();
    await expect(tray).toBeEnabled();

    await tray.click();
    await expect(tray).toBeChecked();
    await login.click();
    await expect(login).toBeChecked();

    // The host keeps the choice: leaving and coming back reads it again.
    await lab.nav('Inbox').click();
    await lab.openSettings();
    await sections.getByRole('button', { name: 'Background' }).click();
    await expect(tray).toBeChecked();
    await expect(login).toBeChecked();

    await tray.click();
    await expect(tray).not.toBeChecked();
    await login.click();
    await expect(login).not.toBeChecked();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('safe mode shows the background options read-only', async ({ lab, page }) => {
    await lab.open('safe');
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Background' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Safe mode keeps background settings read-only.' })).toBeVisible();
    for (const name of ['Keep running in the tray when the window is closed', 'Pause all automations']) {
      await expect(page.getByRole('switch', { name })).toBeDisabled();
    }
    await expect(page.getByRole('switch', { name: LOGIN })).toBeDisabled();
  });
});
