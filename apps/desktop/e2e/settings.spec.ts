import type { Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * Settings → Background in the UI Lab: the host's background-v1 checks and
 * replies without a tray icon or a sign-in registration. The native tray and
 * autostart are covered by the Rust tests, not here.
 */
const LOGIN = /^Start Nano Desktop when I sign in( to Windows)?$/;

/** Opens Settings → Harnesses and returns its built-in rows by harness name. */
async function openHarnesses(lab: Lab, page: Page) {
  const sections = await lab.openSettings();
  await sections.getByRole('button', { name: 'Harnesses' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Harnesses' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Built-in harnesses' });
  return {
    sections,
    row: (name: string) => list.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) }),
  };
}

test.describe('Settings → Nano account', () => {
  test('no longer lists model providers: they belong to the Nano harness', async ({ lab, page }) => {
    await lab.open();
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Nano account' }).press('Enter');
    await expect(sections.getByRole('button', { name: 'Nano account' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'External model providers' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toHaveCount(0);
  });

  test('keeps the account page free of provider setup in safe mode', async ({ lab, page }) => {
    await lab.open('safe');
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Nano account' }).press('Enter');
    await expect(page.getByText(/Safe mode is on/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'External model providers' })).toHaveCount(0);
  });
});

test.describe('Settings → Harnesses → Connect', () => {
  test('connects and disconnects ChatGPT and an API source from the Nano dialog by keyboard', async ({ lab, page }) => {
    await lab.open();
    const { row } = await openHarnesses(lab, page);
    await row('Nano').getByRole('button', { name: 'Connect' }).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Connect Nano' });
    await expect(dialog).toBeVisible();
    const providers = dialog.getByRole('region', { name: 'External model providers' });
    await providers.getByRole('button', { name: 'Continue with ChatGPT' }).press('Enter');
    const welcome = page.getByRole('dialog', { name: 'You’re using your ChatGPT plan' });
    await expect(welcome).toBeVisible();
    await welcome.getByRole('button', { name: 'Got it' }).press('Enter');
    await expect(welcome).toHaveCount(0);
    // The nested welcome closed without closing the Connect dialog.
    await expect(dialog).toBeVisible();
    await providers.getByRole('button', { name: 'Disconnect ChatGPT' }).press('Enter');
    await expect(providers.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible();
    await providers.getByLabel('Provider name').fill('Demo gateway');
    await providers.getByLabel('API base URL').fill('https://example.test/v1');
    await providers.getByLabel('Model ID').fill('demo-model');
    await providers.getByLabel('Chat Completions request format').press('ArrowDown');
    await providers.getByRole('button', { name: 'Connect API key…' }).press('Enter');
    const disconnect = providers.getByRole('button', { name: 'Disconnect Demo gateway' });
    await expect(disconnect).toBeVisible();
    await disconnect.press('Enter');
    await expect(disconnect).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Done' }).press('Enter');
    await expect(dialog).toHaveCount(0);
  });

  test('opens the Nano account from the Nano dialog', async ({ lab, page }) => {
    await lab.open();
    const { row, sections } = await openHarnesses(lab, page);
    await row('Nano').getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Nano' });
    await dialog.getByRole('button', { name: 'Open Nano account' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(sections.getByRole('button', { name: 'Nano account' })).toHaveAttribute('aria-current', 'page');
  });

  test('disables Connect in safe mode', async ({ lab, page }) => {
    await lab.open('safe');
    const { row } = await openHarnesses(lab, page);
    for (const name of ['Codex', 'Claude Code', 'Nano']) {
      await expect(row(name).getByRole('button', { name: 'Connect' })).toBeDisabled();
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('shows the Codex command and opens a terminal through the host', async ({ lab, page }) => {
    await lab.open();
    const { row } = await openHarnesses(lab, page);
    await row('Codex').getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Codex' });
    await expect(dialog.getByText('Codex signs in with its own tools. Nano Desktop never sees its credentials.')).toBeVisible();
    await expect(dialog.locator('code', { hasText: /^codex login$/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy command' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Open terminal' }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Finish signing in in the terminal, then check again.' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Check again' }).click();
    await expect(dialog.getByRole('button', { name: 'Check again' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('Claude Code that needs a sign-in shows its status and the second command', async ({ lab, page }) => {
    await lab.open('demo', '&claude=signed-out');
    const { row } = await openHarnesses(lab, page);
    await expect(row('Claude Code').getByText('Sign-in required')).toBeVisible();
    await row('Claude Code').getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Claude Code' });
    await expect(dialog.locator('code', { hasText: /^claude$/ })).toBeVisible();
    await expect(dialog.getByText('Then type /login there.')).toBeVisible();
  });

  test('gives Prime Agent one line of guidance and no terminal', async ({ lab, page }) => {
    await lab.open();
    const { row } = await openHarnesses(lab, page);
    await row('Prime Agent').getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Prime Agent' });
    await expect(dialog.getByText('Sign in with Prime Agent’s own tools in a terminal, then check again.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Open terminal' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Check again' })).toBeVisible();
  });

  test('an ACP agent explains its sign-in and hands over to the secret variables review', async ({ lab, page }) => {
    await lab.open();
    await openHarnesses(lab, page);
    const agents = page.getByRole('list', { name: 'ACP agents' });
    const gemini = agents.getByRole('listitem').filter({ has: page.getByText('Gemini CLI', { exact: true }) });
    await gemini.getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Gemini CLI' });
    await expect(dialog.getByText(/run `gemini` in a terminal/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Secret variables…' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Secret variables for Gemini CLI' })).toBeVisible();
  });

  test('keeps location and tested versions under Details', async ({ lab, page }) => {
    await lab.open();
    const { row } = await openHarnesses(lab, page);
    const codex = row('Codex');
    await expect(codex.getByText('Location')).toBeHidden();
    await codex.getByText('Details', { exact: true }).click();
    await expect(codex.getByText('Location')).toBeVisible();
    await expect(codex.getByText('Tested with Nano Desktop')).toBeVisible();
  });
});

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
