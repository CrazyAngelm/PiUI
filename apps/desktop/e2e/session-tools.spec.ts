import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * Session tools in the UI Lab: the review panel (stage, revert with a preview
 * of what is lost, line comments into the draft), worktree chats, "Continue
 * in another harness" and continuing a terminal Pi session. The lab fakes
 * git and never touches a file.
 */
const LAZY_VIEW_MS = 30_000;

async function openReview(lab: Lab, chat: RegExp): Promise<Locator> {
  await lab.chat(chat).click();
  await lab.page.getByRole('button', { name: 'Review changes' }).click();
  const review = lab.page.getByRole('complementary', { name: 'Review changes' });
  await expect(review).toBeVisible({ timeout: LAZY_VIEW_MS });
  return review;
}

function changedFiles(review: Locator): Locator {
  return review.getByRole('navigation', { name: 'Changed files' });
}

function home(page: Page): Locator {
  return page.getByRole('region', { name: 'What should we work on?' });
}

/** Serious and critical WCAG 2.1 A/AA violations inside one element. */
async function axeBlocking(page: Page, selector: string): Promise<readonly { id: string; nodes: string[] }[]> {
  const results = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(' ')) }));
}

test.describe('review panel', () => {
  test('stages a hunk, reverts with a preview and comments into the draft', async ({ lab, page }) => {
    await lab.open();
    const review = await openReview(lab, /Route host calls through one transport/);
    const files = changedFiles(review);
    await expect(files.getByRole('button')).toHaveCount(5);
    await files.getByRole('button', { name: /^transport\.ts/ }).click();
    const selected = review.getByRole('region', { name: 'Selected file' });
    await expect(selected).toContainText('apps/desktop/src/host-api/transport.ts');

    await selected.getByRole('button', { name: 'Stage change 1', exact: true }).click();
    await expect(files.getByRole('button', { name: /^transport\.ts/ })).toHaveCount(2);

    // Revert shows exactly what will be lost before anything happens.
    await files.getByRole('button', { name: /^transport\.ts/ }).last().click();
    await expect(selected.getByText('Changes', { exact: true })).toBeVisible();
    await selected.getByRole('button', { name: 'Revert change 1…' }).click();
    const confirm = page.getByRole('dialog', { name: /Revert this change in/ });
    await expect(confirm).toContainText('These changes will be lost.');
    await expect(confirm.getByRole('region', { name: /Changes in/ })).toContainText('createLabHost({ ambient: true })');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await selected.getByRole('button', { name: 'Revert change 1…' }).click();
    await page.getByRole('dialog', { name: /Revert this change in/ }).getByRole('button', { name: 'Revert changes' }).click();
    await expect(lab.toast('Changes reverted')).toBeVisible();
    await expect(files.getByRole('button', { name: /^transport\.ts/ })).toHaveCount(1);

    // A line comment goes into the message box and is not sent.
    await files.getByRole('button', { name: /^Sidebar\.svelte/ }).click();
    await selected.getByRole('button', { name: 'Comment on change 1…' }).click();
    const form = review.getByRole('form', { name: /Comment for the agent/ });
    const line = form.getByRole('combobox', { name: 'Line' });
    // The first changed line (the removed one) is preselected; pick the added line.
    await expect(line.locator('option:checked')).toHaveText(/^removed 4:/);
    await line.selectOption({ index: 4 });
    await form.getByRole('textbox', { name: 'Note for the agent' }).fill('Keep the product name in the brand.');
    await form.getByRole('button', { name: 'Add to message' }).click();
    const message = page.getByRole('textbox', { name: 'Message' });
    await expect(message).toHaveValue('`apps/desktop/src/app/shell/Sidebar.svelte:4`\n>     <span class="brand__name">PiUI Lab</span>\n\nKeep the product name in the brand.');
    await expect(lab.toast('Added to your message')).toBeVisible();

    // An untracked file goes to the trash only after its preview.
    await files.getByRole('button', { name: /^review-panel\.md/ }).click();
    await selected.getByRole('button', { name: 'Move to Trash…' }).click();
    const trash = page.getByRole('dialog', { name: /Move docs\/notes\/review-panel\.md to the Trash/ });
    await expect(trash).toContainText('goes to the system Trash, where you can restore it');
    await trash.getByRole('button', { name: 'Move to Trash' }).click();
    await expect(files.getByRole('button', { name: /^review-panel\.md/ })).toHaveCount(0);
  });

  test('keyboard users reach every action and the panel resizes from the keyboard', async ({ lab, page }) => {
    await lab.open();
    const review = await openReview(lab, /Route host calls through one transport/);
    const splitter = review.getByRole('separator', { name: 'Resize the review panel' });
    const before = Number(await splitter.getAttribute('aria-valuenow'));
    await splitter.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(splitter).toHaveAttribute('aria-valuenow', String(before + 24));
    await changedFiles(review).getByRole('button', { name: /^transport\.ts/ }).focus();
    await page.keyboard.press('Enter');
    const comment = review.getByRole('button', { name: 'Comment on change 2…' });
    await comment.focus();
    await page.keyboard.press('Enter');
    await expect(review.getByRole('textbox', { name: 'Note for the agent' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(review.getByRole('form', { name: /Comment for the agent/ })).toBeHidden();
  });

  test('explains a chat without a repository and stays read-only in safe mode', async ({ lab, page }) => {
    await lab.open();
    const personal = await openReview(lab, /Plan a weekend in Lisbon/);
    await expect(personal.getByText('No git repository here')).toBeVisible();

    await page.goto('/?lab=safe');
    await expect(lab.sidebar).toBeVisible({ timeout: LAZY_VIEW_MS });
    const review = await openReview(lab, /Route host calls through one transport/);
    await expect(review.getByText('Safe mode: the review is read-only.')).toBeVisible();
    await changedFiles(review).getByRole('button', { name: /^transport\.ts/ }).click();
    await expect(review.getByRole('button', { name: 'Stage file' })).toBeDisabled();
    await expect(review.getByRole('button', { name: 'Stage change 1', exact: true })).toBeDisabled();
  });
});

test.describe('worktree chats', () => {
  test('a new chat runs in a confirmed worktree and shows it in the sidebar and details', async ({ lab, page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Where the chat works: Local' }).click();
    await page.getByRole('menuitem', { name: /New worktree/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New chat in a worktree' });
    const branch = dialog.getByRole('textbox', { name: 'New branch' });
    await expect(branch).toHaveValue(/^piui\/chat-/);
    await branch.fill('main');
    await expect(dialog.getByRole('alert')).toContainText('A branch with this name already exists.');
    await expect(dialog.getByRole('button', { name: 'Use this worktree' })).toBeDisabled();
    await branch.fill('bad name');
    await expect(dialog.getByRole('alert')).toContainText('Choose a branch name');
    await branch.fill('piui/diff-layout');
    await expect(dialog).toContainText('~/.piui-lab/worktrees/');
    await expect(dialog).toContainText('Uncommitted changes in the project folder are not included');
    await dialog.getByRole('button', { name: 'Use this worktree' }).click();
    await expect(composer.getByRole('button', { name: 'Where the chat works: Worktree · piui/diff-layout' })).toBeVisible();

    await composer.getByRole('textbox', { name: 'Message' }).fill('Try the compact diff layout');
    await composer.getByRole('button', { name: 'Start chat' }).click();
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toBeVisible({ timeout: LAZY_VIEW_MS });
    await expect(lab.sidebar.getByRole('button', { name: /in worktree piui\/diff-layout/ })).toBeVisible();

    await page.getByRole('button', { name: 'Details' }).click();
    const details = page.getByRole('complementary', { name: 'Chat details' });
    await expect(details).toContainText('piui/diff-layout');
    await details.getByRole('button', { name: 'Copy branch name' }).click();
    await expect(lab.toast('Branch name copied')).toBeVisible();
    await details.getByRole('button', { name: 'Review changes' }).click();
    const review = page.getByRole('complementary', { name: 'Review changes' });
    await expect(review.getByText('No changes')).toBeVisible({ timeout: LAZY_VIEW_MS });
    await expect(review.getByText('Worktree', { exact: true })).toBeVisible();
  });

  test('removing a worktree with changes needs an explicit confirmation and keeps the chat', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Try a denser review layout/).click();
    await page.getByRole('button', { name: 'Details' }).click();
    const details = page.getByRole('complementary', { name: 'Chat details' });
    await details.getByRole('button', { name: 'Remove worktree…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove this worktree?' });
    await expect(confirm).toContainText('piui/review-layout');
    await confirm.getByRole('button', { name: 'Remove worktree' }).click();
    const dirty = page.getByRole('dialog', { name: 'Remove the worktree and lose its changes?' });
    await expect(dirty).toContainText('This worktree has 2 uncommitted changes.');
    await expect(dirty.getByRole('list', { name: 'Changes that will be lost' })).toContainText('docs/review-layout.css');
    const remove = dirty.getByRole('button', { name: 'Remove and lose changes' });
    await expect(remove).toBeDisabled();
    await dirty.getByText('I understand that these 2 changes will be lost').click();
    await remove.click();
    await expect(lab.toast('Worktree removed')).toBeVisible();
    await expect(details).toContainText('The worktree was removed. The branch stays; this chat stays readable.');
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('Try a denser layout for the review panel');
    // Its runtime stopped; it cannot resume without the worktree.
    await expect(page.getByText("This chat's worktree was removed. Its history stays readable; start a new chat to keep working.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  });
});

test.describe('continue elsewhere', () => {
  test('continue in another harness prefills a draft and links back to the source', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Route host calls through one transport/).click();
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Continue in another harness…' }).click();
    const composer = home(page);
    await expect(page.getByText(/Continuing "Route host calls through one transport" from Codex/)).toBeVisible();
    const message = composer.getByRole('textbox', { name: 'Message' });
    await expect(message).toHaveValue(/I am continuing work from a Codex chat, "Route host calls through one transport"\./);
    await expect(message).toHaveValue(/The last request there was:\n> Does anything still import Tauri directly from a component\?/);
    await message.fill(`${await message.inputValue()}Check the remaining imports.`);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await lab.option(/^Hermes/).click();
    await composer.getByRole('button', { name: 'Start chat' }).click();
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('Check the remaining imports.', { timeout: LAZY_VIEW_MS });
    await page.getByRole('button', { name: 'Details' }).click();
    const details = page.getByRole('complementary', { name: 'Chat details' });
    await details.getByRole('button', { name: 'Route host calls through one transport' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Route host calls through one transport' })).toBeVisible();
  });

  test('a cancelled handoff restores the earlier new chat draft', async ({ lab, page }) => {
    await lab.open();
    await home(page).getByRole('textbox', { name: 'Message' }).fill('My own draft');
    await lab.chat(/Route host calls through one transport/).click();
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Continue in another harness…' }).click();
    await expect(home(page).getByRole('textbox', { name: 'Message' })).toHaveValue(/I am continuing work/);
    await page.getByRole('status').filter({ hasText: 'Continuing' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(home(page).getByRole('textbox', { name: 'Message' })).toHaveValue('My own draft');
  });

  test('continue a terminal Pi session in PiUI, and refuse one still open there', async ({ lab, page }) => {
    await lab.open();
    await lab.sidebar.getByRole('button', { name: 'Options for piui' }).click();
    await page.getByRole('menuitem', { name: 'Pi session history' }).click();
    const history = page.getByRole('complementary', { name: 'Sessions' });
    await expect(history).toBeVisible({ timeout: LAZY_VIEW_MS });

    await history.getByRole('button', { name: /^Draft release notes for 0\.2\.0/ }).click();
    await page.getByRole('button', { name: 'Continue in PiUI' }).click();
    let dialog = page.getByRole('dialog', { name: 'Continue this session in PiUI?' });
    await expect(dialog).toContainText('Close it in the Pi terminal app first.');
    await dialog.getByRole('button', { name: 'Continue in PiUI' }).click();
    await expect(dialog.getByRole('alert')).toContainText('may still be open in the Pi terminal app');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await history.getByRole('button', { name: /^Make the session index incremental/ }).click();
    await page.getByRole('button', { name: 'Continue in PiUI' }).click();
    dialog = page.getByRole('dialog', { name: 'Continue this session in PiUI?' });
    await dialog.getByRole('button', { name: 'Continue in PiUI' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Make the session index incremental' })).toBeVisible({ timeout: LAZY_VIEW_MS });
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('Can we make it incremental?');
    await expect(lab.chat(/Make the session index incremental/)).toBeVisible();
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('complementary', { name: 'Chat details' })).toContainText('Started in the Pi terminal app.');
  });
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(`session tools accessibility (${theme})`, () => {
    test.use({ colorScheme: theme, reducedMotion: 'reduce' });

    test('review panel, comment form, worktree details and dialogs pass axe', async ({ lab, page }) => {
      test.slow(); // axe's contrast pass is CPU-heavy.
      await lab.open();
      const review = await openReview(lab, /Route host calls through one transport/);
      await changedFiles(review).getByRole('button', { name: /^transport\.ts/ }).click();
      await review.getByRole('button', { name: 'Comment on change 1…' }).click();
      await expect(review.getByRole('form', { name: /Comment for the agent/ })).toBeVisible();
      expect(await axeBlocking(page, 'aside[aria-label="Review changes"]'), 'review panel').toEqual([]);

      await review.getByRole('button', { name: 'Revert change 1…' }).click();
      const revert = page.getByRole('dialog', { name: /Revert this change in/ });
      await expect(revert).toBeVisible();
      expect(await axeBlocking(page, '[role="dialog"]'), 'revert dialog').toEqual([]);
      await revert.getByRole('button', { name: 'Cancel' }).click();

      await lab.chat(/Try a denser review layout/).click();
      await page.getByRole('button', { name: 'Details' }).click();
      const details = page.getByRole('complementary', { name: 'Chat details' });
      await expect(details).toContainText('piui/review-layout');
      expect(await axeBlocking(page, 'aside[aria-label="Chat details"]'), 'worktree details').toEqual([]);
      await details.getByRole('button', { name: 'Remove worktree…' }).click();
      await page.getByRole('dialog', { name: 'Remove this worktree?' }).getByRole('button', { name: 'Remove worktree' }).click();
      const dirty = page.getByRole('dialog', { name: 'Remove the worktree and lose its changes?' });
      await expect(dirty.getByRole('list', { name: 'Changes that will be lost' })).toBeVisible();
      expect(await axeBlocking(page, '[role="dialog"]'), 'remove worktree dialog').toEqual([]);
      await dirty.getByRole('button', { name: 'Cancel' }).click();

      await lab.nav('New chat').click();
      await home(page).getByRole('button', { name: 'Where the chat works: Local' }).click();
      await page.getByRole('menuitem', { name: /New worktree/ }).click();
      const worktree = page.getByRole('dialog', { name: 'New chat in a worktree' });
      await expect(worktree).toContainText('Uncommitted changes in the project folder are not included');
      expect(await axeBlocking(page, '[role="dialog"]'), 'worktree dialog').toEqual([]);
    });

    test('handoff banner and the continue in PiUI dialog pass axe', async ({ lab, page }) => {
      test.slow(); // axe's contrast pass is CPU-heavy.
      await lab.open();
      await lab.chat(/Route host calls through one transport/).click();
      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page.getByRole('menuitem', { name: 'Continue in another harness…' }).click();
      await expect(page.getByText(/Continuing "Route host calls through one transport" from Codex/)).toBeVisible();
      expect(await axeBlocking(page, 'section.home'), 'handoff composer').toEqual([]);

      await lab.sidebar.getByRole('button', { name: 'Options for piui' }).click();
      await page.getByRole('menuitem', { name: 'Pi session history' }).click();
      const history = page.getByRole('complementary', { name: 'Sessions' });
      await history.getByRole('button', { name: /^Make the session index incremental/ }).click({ timeout: LAZY_VIEW_MS });
      await page.getByRole('button', { name: 'Continue in PiUI' }).click();
      await expect(page.getByRole('dialog', { name: 'Continue this session in PiUI?' })).toBeVisible();
      expect(await axeBlocking(page, '[role="dialog"]'), 'continue in PiUI dialog').toEqual([]);
    });
  });
}
