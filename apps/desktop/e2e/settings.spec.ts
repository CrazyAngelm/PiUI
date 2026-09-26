import { expect, test } from './fixtures';

/**
 * Settings → Background in the UI Lab: the host's background-v1 checks and
 * replies without a tray icon or a sign-in registration. The native tray and
 * autostart are covered by the Rust tests, not here.
 */
const LOGIN = /^Start PiUI when I sign in( to Windows)?$/;

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
