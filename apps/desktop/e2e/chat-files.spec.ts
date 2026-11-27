import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * Chat files (ADR-074) in the Lab: the demo chat's file change reports an
 * image, a sound, a source file and an executable. Previews are `blob:` URLs
 * made from host bytes; Save as and Open containing folder have no visible
 * effect in a browser, so the Lab host records every call on
 * `window.__piuiLabChatFiles`.
 */
const CHAT = /Route host calls through one transport/;

function card(page: Page, name: string): Locator {
  return page.locator(`[data-file-name="${name}"]`);
}

async function openChat(lab: Lab): Promise<void> {
  await lab.open();
  await lab.chat(CHAT).click();
  await expect(card(lab.page, 'transport-diagram.png')).toBeVisible();
}

function calls(page: Page): Promise<{ type: string; fileId?: string }[]> {
  return page.evaluate(() => (window as unknown as { __piuiLabChatFiles?: { calls: { type: string; fileId?: string }[] } }).__piuiLabChatFiles?.calls ?? []);
}

test.describe('chat files', () => {
  test('shows artifacts with the answer and expands ordinary writes from one count', async ({ lab, page }) => {
    await openChat(lab);

    const image = card(page, 'transport-diagram.png');
    await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => image.locator('img').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    await expect(image).toContainText('Generated');

    const sound = card(page, 'narration.wav');
    await expect(sound.locator('audio')).toHaveAttribute('src', /^blob:/);
    await expect(sound.locator('audio')).toHaveAttribute('controls', '');
    await expect(sound.getByRole('button', { name: 'Save as…' })).toBeVisible();

    const source = card(page, 'transport-notes.md');
    const changed = page.getByText('Changed files (2)', { exact: true });
    await expect(changed).toBeVisible();
    await expect(source).toHaveCount(0);
    await changed.focus();
    await expect(changed).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(source).toBeVisible();
    await expect(source.locator('img, audio, video')).toHaveCount(0);
    await expect(source).toContainText('Written');

    // A file the app will not open still offers a copy and its folder.
    const program = card(page, 'install-helper.exe');
    await expect(program.getByRole('button', { name: 'install-helper.exe' })).toHaveCount(0);
    await expect(program.getByRole('button', { name: 'Save as…' })).toBeVisible();
    await expect(program.getByRole('button', { name: 'Open containing folder' })).toBeVisible();

    // Nothing but ids went to the host.
    expect((await calls(page)).filter((call) => call.type === 'preview').length).toBeGreaterThanOrEqual(2);
    await changed.click();
    await expect(source).toHaveCount(0);
    await expect(image).toBeVisible();
  });

  test('saves a copy and shows the folder from the keyboard', async ({ lab, page }) => {
    await openChat(lab);
    const sound = card(page, 'narration.wav');
    const save = sound.getByRole('button', { name: 'Save as…' });
    const reveal = sound.getByRole('button', { name: 'Open containing folder' });

    await save.focus();
    await expect(save).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(lab.toast('File saved')).toBeVisible();
    await expect.poll(async () => (await calls(page)).filter((call) => call.type === 'save').length).toBe(1);

    // Tab reaches the folder action next, and Enter runs it.
    await expect(save).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(reveal).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await calls(page)).filter((call) => call.type === 'reveal').length).toBe(1);

    const log = await calls(page);
    const saved = log.find((call) => call.type === 'save');
    const shown = log.find((call) => call.type === 'reveal');
    expect(saved?.fileId).toBeTruthy();
    expect(shown?.fileId).toBe(saved?.fileId);
  });

  test('opens a file through the host', async ({ lab, page }) => {
    await openChat(lab);
    await page.getByText('Changed files (2)', { exact: true }).click();
    await card(page, 'transport-notes.md').getByRole('button', { name: 'transport-notes.md' }).click();
    await expect.poll(async () => (await calls(page)).filter((call) => call.type === 'open').length).toBe(1);
  });
});
