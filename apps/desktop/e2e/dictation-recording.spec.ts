import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

// A real recording in the Lab: Chromium's fake microphone stands in for a person speaking, so the
// composer's recording state can be checked (the rest of dictation is covered by dictation.spec.ts and Vitest).
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

const dictate = (page: Page): Locator => page.getByRole('button', { name: 'Dictate', exact: true });
const cancel = (page: Page): Locator => page.getByRole('button', { name: 'Cancel dictation', exact: true });
const bar = (page: Page): Locator => page.locator('[data-nano-composer="bar"]');

/** The names of every button in the composer's bar, in order. */
const barButtons = (page: Page): Promise<string[]> =>
  bar(page).getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''));

async function openChat(lab: Lab): Promise<void> {
  await lab.open('demo', '&nano=signed-in');
  await lab.chat(/Route host calls through one transport/).click();
  await expect(lab.page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}

async function openNewChat(lab: Lab): Promise<void> {
  await lab.open('demo', '&nano=signed-in');
  await lab.nav('New chat').click();
  await expect(lab.page.getByRole('region', { name: 'What should we work on?' })).toBeVisible();
}

async function expectRecording(page: Page): Promise<void> {
  await expect(cancel(page)).toBeVisible();
  // While recording, only Cancel, Stop and Send are left in the bar.
  await expect.poll(() => barButtons(page)).toEqual(['Cancel dictation', 'Stop dictation', 'Stop dictation and send']);
}

test('a recording in a chat leaves only Cancel, Stop and Send, and Cancel gives the composer back', async ({ lab, page }) => {
  await openChat(lab);
  await expect(dictate(page)).toBeVisible();
  const before = await barButtons(page);
  expect(before.length).toBeGreaterThan(3);
  expect(before).toContain('Dictate');

  await dictate(page).click();
  await expectRecording(page);

  await cancel(page).click();
  await expect(dictate(page)).toBeVisible();
  await expect(cancel(page)).toHaveCount(0);
  await expect.poll(() => barButtons(page)).toEqual(before);
  // Nothing recorded for five seconds is left behind: no unsent recording is offered.
  await expect(page.getByRole('group', { name: 'Unsent recording', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  lab.expectNoErrors();
});

test('Escape cancels a recording the same way', async ({ lab, page }) => {
  await openChat(lab);
  await dictate(page).click();
  await expectRecording(page);
  await page.keyboard.press('Escape');
  await expect(dictate(page)).toBeVisible();
  await expect(cancel(page)).toHaveCount(0);
  lab.expectNoErrors();
});

test('the new-chat composer offers the same three buttons while recording', async ({ lab, page }) => {
  await openNewChat(lab);
  await expect(dictate(page)).toBeVisible();
  const before = await barButtons(page);
  expect(before.length).toBeGreaterThan(3);

  await dictate(page).click();
  await expectRecording(page);
  await cancel(page).focus();
  await page.keyboard.press('Enter');
  await expect(dictate(page)).toBeVisible();
  await expect.poll(() => barButtons(page)).toEqual(before);
  lab.expectNoErrors();
});
