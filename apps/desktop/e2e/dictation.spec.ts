import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

// The Lab has no microphone, so no spec records: it checks the settings, the key state and when
// the button is offered. Recording itself is covered by the Vitest suites.

const dictate = (page: Page): Locator => page.getByRole('button', { name: 'Dictate', exact: true });

async function openChat(lab: Lab): Promise<void> {
  await lab.chat(/Route host calls through one transport/).click();
  await expect(lab.page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}

async function openDictation(lab: Lab): Promise<void> {
  const sections = await lab.openSettings();
  await sections.getByRole('button', { name: 'Dictation', exact: true }).press('Enter');
  await expect(lab.page.getByRole('heading', { name: 'Dictation', level: 2, exact: true })).toBeVisible();
}

const source = (page: Page): Locator => page.getByRole('combobox', { name: 'Speech to text', exact: true });
const keyGroup = (page: Page): Locator => page.getByRole('group', { name: /^API key/ });

test('OpenAI is set up by keyboard without a Nano sign-in, and removing its key hides the button', async ({ lab, page }) => {
  await lab.open();
  await openChat(lab);
  await expect(dictate(page)).toHaveCount(0);

  await openDictation(lab);
  await source(page).focus();
  await expect(source(page)).toBeFocused();
  await source(page).selectOption('openai');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-4o-transcribe');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Not set');
  await keyGroup(page).getByRole('button', { name: 'Set API key…', exact: true }).press('Enter');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Saved in the system credential store');

  await openChat(lab);
  await expect(dictate(page)).toBeVisible();
  await expect(dictate(page)).toBeEnabled();

  await openDictation(lab);
  await keyGroup(page).getByRole('button', { name: 'Remove API key', exact: true }).press('Enter');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Not set');
  await openChat(lab);
  await expect(dictate(page)).toHaveCount(0);
  lab.expectNoErrors();
});

test('a custom endpoint refuses plain http to another computer, then works with a local one and no key', async ({ lab, page }) => {
  await lab.open();
  await openDictation(lab);
  await source(page).selectOption('custom');
  const address = page.getByLabel('API base URL', { exact: true });
  await address.fill('http://example.test/v1');
  await address.press('Tab');
  await expect(page.getByRole('alert').filter({ hasText: 'Enter an HTTPS address. HTTP works only for this computer (localhost).' })).toBeVisible();
  await expect(address).toHaveValue('http://example.test/v1');

  await address.fill('http://127.0.0.1:8000/v1');
  await address.press('Tab');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const model = page.getByLabel('Model', { exact: true });
  await model.fill('whisper-local');
  await model.press('Tab');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Not set');
  await expect(address).toHaveValue('http://127.0.0.1:8000/v1');

  await openChat(lab);
  await expect(dictate(page)).toBeVisible();
  lab.expectNoErrors();
});

test('the Nano subscription stays the default when signed in, and Off hides the button everywhere', async ({ lab, page }) => {
  await lab.open('demo', '&nano=signed-in');
  await openChat(lab);
  await expect(dictate(page)).toBeVisible();

  await openDictation(lab);
  await expect(source(page)).toHaveValue('nano');
  await expect(source(page).locator('option:checked')).toHaveText('Nano subscription');
  await source(page).selectOption('off');
  await expect(source(page)).toHaveValue('off');

  await openChat(lab);
  await expect(dictate(page)).toHaveCount(0);
  await lab.nav('New chat').click();
  await expect(page.getByRole('region', { name: 'What should we work on?' })).toBeVisible();
  await expect(dictate(page)).toHaveCount(0);
  lab.expectNoErrors();
});

test('safe mode says dictation is off and offers no setup', async ({ lab, page }) => {
  await lab.open('safe');
  await openDictation(lab);
  await expect(page.getByText('Safe mode is on: dictation is off.', { exact: true })).toBeVisible();
  await expect(source(page)).toHaveCount(0);
  await lab.nav('New chat').click();
  await expect(page.getByRole('region', { name: 'What should we work on?' })).toBeVisible();
  await expect(dictate(page)).toHaveCount(0);
  lab.expectNoErrors();
});
