import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/** Sends `/extension-demo` in the Pi extension playground; the lab replays a Pi extension. */
async function startDemo(lab: Lab): Promise<Locator> {
  await lab.open();
  await lab.chat(/Pi extension playground/).click();
  const chat = lab.page.getByRole('region', { name: 'Pi extension playground' });
  await chat.getByRole('textbox', { name: 'Message' }).fill('/extension-demo');
  await chat.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(chat.getByRole('region', { name: 'Conversation messages' })).toContainText('The extension will ask four questions', { timeout: 20_000 });
  return chat;
}

function card(page: Page, title: string): Locator {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { level: 3, name: title }) });
}

test.describe('Pi extension UI in a chat', () => {
  test('surfaces appear next to the message box and every dialog kind can be answered', async ({ lab, page }) => {
    test.slow(); // The lab replays the extension with real timers.
    const chat = await startDemo(lab);
    await expect(chat.getByRole('status').filter({ hasText: 'Extension demo: notices, statuses and panels appear next to the message box.' })).toContainText('Pi extension');
    await expect(chat.getByRole('list', { name: 'Extension status' }).getByRole('listitem')).toHaveText(['Checks: running', 'Branch: feat/classic-port']);
    await expect(chat.getByRole('complementary', { name: 'Extension panel' }).first()).toContainText('Release checklist');
    await expect(page).toHaveTitle('Extension demo — PiUI');

    // 1. confirm → permission card.
    const confirm = card(page, 'Build a preview?');
    await confirm.getByRole('button', { name: 'Allow once' }).click();
    await expect(chat.getByRole('status').filter({ hasText: 'Preview build allowed.' })).toBeVisible();
    // 2. select → choices.
    const select = card(page, 'Where should the preview go?');
    await select.getByRole('group', { name: 'Choices' }).getByRole('button', { name: 'Staging' }).click();
    await expect(chat.getByRole('status').filter({ hasText: 'Target chosen.' })).toBeVisible();
    // 3. input → an answer is required before sending.
    const input = card(page, 'Name the preview');
    const send = input.getByRole('button', { name: 'Send answer' });
    await expect(send).toBeDisabled();
    await input.getByRole('textbox', { name: 'Preview name' }).fill('lab-preview');
    await send.click();
    await expect(chat.getByRole('status').filter({ hasText: 'Preview named.' })).toBeVisible();
    // 4. editor → prepared text that closes by itself if unanswered.
    const editor = card(page, 'Edit the release note');
    await expect(editor.getByRole('textbox', { name: 'Release note' })).toHaveValue('feat(history): read Pi sessions and their branches in PiUI');
    await expect(editor).toContainText('This request closes automatically if you do not answer.');
    await editor.getByRole('button', { name: 'Send answer' }).click();
    await expect(chat.getByRole('status').filter({ hasText: 'Release note saved.' })).toBeVisible();

    // The end of the replay: updated status, a panel below the box, prepared text, a generic fallback.
    await expect(chat.getByRole('list', { name: 'Extension status' })).toContainText('Checks: passed', { timeout: 20_000 });
    await expect(chat.getByRole('complementary', { name: 'Extension panel' }).filter({ hasText: 'Tip: extension panels can sit below the message box too.' })).toBeVisible();
    await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveValue('Summarize what the extension showed.', { timeout: 20_000 });
    await expect(chat.getByRole('region', { name: 'Conversation messages' })).toContainText('Done. The statuses and panels stay', { timeout: 20_000 });

    // A notice can be dismissed.
    const notice = chat.getByRole('status').filter({ hasText: 'Release note saved.' });
    await notice.getByRole('button', { name: 'Dismiss notice' }).click();
    await expect(notice).toHaveCount(0);
  });

  test('declined and dismissed dialogs are reported and the replay goes on', async ({ lab, page }) => {
    test.slow();
    const chat = await startDemo(lab);
    await card(page, 'Build a preview?').getByRole('button', { name: 'Deny' }).click();
    await expect(chat.getByRole('status').filter({ hasText: 'Preview build declined.' })).toBeVisible();
    await card(page, 'Where should the preview go?').getByRole('button', { name: 'Dismiss' }).click();
    await expect(chat.getByRole('status').filter({ hasText: 'No target chosen.' })).toBeVisible();
    await card(page, 'Name the preview').getByRole('button', { name: 'Dismiss' }).click();
    await expect(chat.getByRole('status').filter({ hasText: 'No preview name given.' })).toBeVisible();
    await card(page, 'Edit the release note').getByRole('button', { name: 'Dismiss' }).click();
    await expect(chat.getByRole('status').filter({ hasText: 'Release note skipped.' })).toBeVisible();
    await expect(chat.getByRole('list', { name: 'Extension status' })).toContainText('Checks: passed', { timeout: 20_000 });
  });
});

test.describe('Settings → Extensions', () => {
  test('global extensions per harness turn on and off', async ({ lab, page }) => {
    await lab.open();
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Extensions' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Extensions' })).toBeVisible();
    const pi = page.getByRole('list', { name: 'Global Pi extensions' });
    await expect(pi.getByRole('listitem')).toHaveCount(3);
    const guard = pi.getByRole('switch', { name: 'Turn off permission-guard for Pi' });
    await expect(guard).toBeChecked();
    await guard.click();
    const off = pi.getByRole('switch', { name: 'Turn on permission-guard for Pi' });
    await expect(off).not.toBeChecked();
    await expect(pi.getByRole('listitem').filter({ hasText: 'permission-guard' })).toContainText('Off');
    await off.click();
    await expect(pi.getByRole('switch', { name: 'Turn off permission-guard for Pi' })).toBeChecked();

    // Prime Agent keeps its own inventory; nothing is shared with Pi.
    await page.getByRole('group', { name: 'Harness' }).getByRole('radio', { name: 'Prime Agent' }).click();
    const prime = page.getByRole('list', { name: 'Global Prime Agent extensions' });
    await expect(prime.getByRole('listitem')).toHaveText([/review-workers/]);
    await expect(page.getByRole('note')).toContainText('compatibility is not assumed');
  });

  test('an empty inventory explains how to install extensions', async ({ lab, page }) => {
    await lab.open('empty');
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Extensions' }).click();
    await expect(page.getByText('No global extensions found')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Global Pi extensions' })).toHaveCount(0);
  });
});
