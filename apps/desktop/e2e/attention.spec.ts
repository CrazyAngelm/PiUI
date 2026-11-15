import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/** The composer on Home ("What should we work on?"). */
function home(page: Page): Locator {
  return page.getByRole('region', { name: 'What should we work on?' });
}

/** Starts a chat from Home and waits for its view. The lab streams a scripted native turn. */
async function startChat(lab: Lab, prompt: string): Promise<void> {
  const composer = home(lab.page);
  await composer.getByRole('textbox', { name: 'Message' }).fill(prompt);
  await composer.getByRole('button', { name: 'Start chat' }).click();
  const transcript = lab.page.getByRole('region', { name: 'Conversation messages' });
  await expect(transcript.getByText(prompt, { exact: true })).toBeVisible();
}

/**
 * The number the Lab's taskbar shows: the last `attention_set_v1` report the
 * Lab host recorded on `window.__piuiLabAttention`.
 */
function taskbarCount(page: Page): () => Promise<number> {
  return () => page.evaluate(() => (window as unknown as { __piuiLabAttention?: { count: number } }).__piuiLabAttention?.count ?? -1);
}

/** The attention controller mounts after first paint; give it its first observation. */
async function settleController(page: Page): Promise<void> {
  await page.waitForTimeout(1_200);
}

test.describe('attention', () => {
  test('a chat that finishes while another screen is open shows a badge until the chat is opened', async ({ lab, page }) => {
    test.slow(); // The native turn is simulated with real timers.
    await lab.open();
    await settleController(page);
    const count = taskbarCount(page);
    expect(await count()).toBe(0);

    const prompt = 'Summarize how the transport boundary keeps Tauri out of components';
    await startChat(lab, prompt);
    // Leave the chat while its turn runs.
    await lab.openSettings();

    // The turn finishes out of sight: the taskbar shows 1.
    await expect.poll(count, { timeout: 45_000 }).toBe(1);

    // Opening the chat in a focused window clears it.
    await lab.chat(prompt).click();
    await expect.poll(count).toBe(0);
  });

  test('the badge setting removes the number and brings it back', async ({ lab, page }) => {
    test.slow();
    await lab.open();
    await settleController(page);
    const count = taskbarCount(page);

    const prompt = 'Summarize how the transport boundary keeps Tauri out of components';
    await startChat(lab, prompt);
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Notifications' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
    await expect.poll(count, { timeout: 45_000 }).toBe(1);

    const badge = page.getByRole('switch', { name: 'Show a number on the taskbar button' });
    await expect(badge).toBeChecked();
    await badge.click();
    await expect(badge).not.toBeChecked();
    await expect.poll(count).toBe(0);
    await badge.click();
    await expect.poll(count).toBe(1);

    // The choice is kept on this device.
    expect(JSON.parse((await page.evaluate(() => window.localStorage.getItem('piui.attention.v1'))) ?? '{}')).toMatchObject({ badge: true });
  });

  test('a chat that asks for an approval out of sight is counted until it is opened', async ({ lab, page }) => {
    test.slow();
    await lab.open();
    await settleController(page);
    const count = taskbarCount(page);

    // "Install" makes the lab pause the turn on an approval.
    await startChat(lab, 'Install the lab dependencies and run the checks');
    await lab.openSettings();
    await expect.poll(count, { timeout: 45_000 }).toBe(1);

    await lab.chat(/Install the lab dependencies/).click();
    const card = page.getByRole('article', { name: 'Permission request' });
    await expect(card).toBeVisible();
    await expect.poll(count).toBe(0);

    // Answering and finishing in front of the person raises nothing.
    await card.getByRole('button', { name: 'Allow once' }).click();
    await expect(card).toBeHidden();
    await expect(page.getByRole('button', { name: 'Stop turn' })).toBeHidden({ timeout: 45_000 });
    expect(await count()).toBe(0);
  });

  test('the notification settings are operable with the keyboard', async ({ lab, page }) => {
    await lab.open();
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Notifications' }).click();
    const sound = page.getByRole('switch', { name: 'Play a sound' });
    await sound.focus();
    await page.keyboard.press('Space');
    await expect(sound).not.toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Sound' })).toBeDisabled();
    await expect(page.getByRole('slider', { name: 'Volume' })).toBeDisabled();
    await page.keyboard.press('Space');
    await expect(sound).toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Sound' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  });
});
