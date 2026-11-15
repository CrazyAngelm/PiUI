import type { Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * Remote access from Nano Web in the UI Lab: the Lab host answers the remote
 * commands with the real host's shapes (`?remote=off|on|pending|viewer|unsupported`)
 * and nothing leaves the browser. Everything is driven by keyboard.
 */
const SWITCH = 'Allow remote access from Nano Web';
const PROMPT = 'Allow this browser to control Nano Desktop?';
const BROWSER = 'Chrome · Android';

async function openNanoAccount(lab: Lab): Promise<void> {
  const sections = await lab.openSettings();
  await sections.getByRole('button', { name: 'Nano account' }).press('Enter');
  await expect(sections.getByRole('button', { name: 'Nano account' })).toHaveAttribute('aria-current', 'page');
}

const indicator = (lab: Lab, count = 1) => lab.sidebar.getByRole('button', { name: `Remote access: ${count} connected` });
const prompt = (page: Page) => page.getByRole('dialog', { name: PROMPT });

test.describe('Settings → Nano account → remote access', () => {
  test('is off by default and turns on by keyboard, then waits for connections', async ({ lab, page }) => {
    await lab.open('demo', '&nano=signed-in&remote=off');
    await openNanoAccount(lab);
    const toggle = page.getByRole('switch', { name: SWITCH });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText('Waiting for connections')).toHaveCount(0);
    await expect(page.getByText(/are not stored there\./)).toBeVisible();

    await toggle.focus();
    await toggle.press('Space');
    await expect(toggle).toBeChecked();
    await expect(page.getByText('Waiting for connections')).toBeVisible();

    await toggle.press('Space');
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText('Waiting for connections')).toHaveCount(0);
  });

  test('says why the switch is unavailable: server, safe mode and signed out', async ({ lab, page }) => {
    await lab.open('demo', '&nano=signed-in&remote=unsupported');
    await openNanoAccount(lab);
    const toggle = page.getByRole('switch', { name: SWITCH });
    await expect(toggle).toBeDisabled();
    await expect(page.getByText('This Nano server does not support remote access yet.')).toBeVisible();

    await lab.open('safe', '&nano=signed-in');
    await openNanoAccount(lab);
    await expect(page.getByRole('switch', { name: SWITCH })).toBeDisabled();
    await expect(page.getByRole('switch', { name: SWITCH })).not.toBeChecked();
    await expect(page.getByText('Not available in safe mode.')).toBeVisible();

    // Signed out: the account page has no remote access block at all.
    await lab.open('demo', '&nano=signed-out');
    await openNanoAccount(lab);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: SWITCH })).toHaveCount(0);
  });

  test('lists a connected browser, disconnects it and forgets it, with named buttons', async ({ lab, page }) => {
    await lab.open('demo', '&nano=signed-in&remote=viewer');
    await expect(indicator(lab)).toBeVisible();
    await indicator(lab).press('Enter');
    await expect(page.getByRole('switch', { name: SWITCH })).toBeChecked();

    const connected = page.getByRole('list', { name: 'Connected now' });
    await expect(connected).toContainText(BROWSER);
    const allowed = page.getByRole('list', { name: 'Allowed browsers' });
    await expect(allowed).toContainText(BROWSER);

    await connected.getByRole('button', { name: `Disconnect ${BROWSER}` }).press('Enter');
    await expect(connected).toHaveCount(0);
    await expect(indicator(lab)).toHaveCount(0);
    // The browser stays allowed until it is removed.
    await expect(allowed).toContainText(BROWSER);

    await allowed.getByRole('button', { name: `Remove ${BROWSER}` }).press('Enter');
    await expect(allowed).toHaveCount(0);
    await expect(page.getByRole('switch', { name: SWITCH })).toBeChecked();
  });
});

test.describe('Pairing prompt', () => {
  test('shows the code, focuses Deny, and Allow once connects the browser', async ({ lab, page }) => {
    await lab.open('demo', '&nano=signed-in&remote=pending');
    const dialog = prompt(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(BROWSER, { exact: true })).toBeVisible();
    await expect(dialog.getByText('908 621', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('img', { name: 'Code 9 0 8 6 2 1' })).toBeVisible();
    await expect(dialog.getByText('Check that the same code is shown in Nano Web. If you did not start this, choose Deny.')).toBeVisible();
    // A close button would be a way to answer nothing.
    await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(0);

    const buttons = dialog.getByRole('button');
    await expect(buttons).toHaveText(['Deny', 'Allow once', 'Always allow this browser']);
    await expect(dialog.getByRole('button', { name: 'Deny' })).toBeFocused();
    await expect(indicator(lab)).toHaveCount(0);

    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Allow once' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(indicator(lab)).toBeVisible();
    lab.expectNoErrors();
  });

  test('Deny and Escape both refuse the browser', async ({ lab, page }) => {
    await lab.open('demo', '&nano=signed-in&remote=pending');
    await expect(prompt(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toHaveCount(0);
    await expect(indicator(lab)).toHaveCount(0);

    await lab.open('demo', '&nano=signed-in&remote=pending');
    await expect(prompt(page)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(prompt(page)).toHaveCount(0);
    await expect(indicator(lab)).toHaveCount(0);
  });

  test('Always allow remembers the browser in settings', async ({ lab, page }) => {
    await lab.open('demo', '&nano=signed-in&remote=pending');
    const dialog = prompt(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Always allow this browser' }).press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(indicator(lab)).toBeVisible();
    await openNanoAccount(lab);
    await expect(page.getByRole('list', { name: 'Allowed browsers' })).toContainText(BROWSER);
    await expect(page.getByRole('list', { name: 'Connected now' })).not.toContainText('Allowed once');
  });

  test('is not offered when remote access is unavailable', async ({ lab, page }) => {
    await lab.open('safe', '&nano=signed-in&remote=pending');
    await expect(lab.sidebar).toBeVisible();
    await page.waitForTimeout(600);
    await expect(prompt(page)).toHaveCount(0);
    await expect(indicator(lab)).toHaveCount(0);
  });
});
