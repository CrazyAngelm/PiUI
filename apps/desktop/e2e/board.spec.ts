import type { Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * Project board and teammates (ADR-041, docs/BOARD.md) in the UI Lab: the demo
 * seeds an enabled board and two teammates for video-studio, with its first
 * chat ("Storyboard the launch trailer") linked to card #1 and a pending
 * proposal from that chat's agent.
 */
async function openBoard(lab: Lab, page: Page): Promise<void> {
  await lab.open();
  // The project tree loads first; board summaries load after first paint, then
  // the sidebar offers the board.
  await expect(lab.chat(/Storyboard the launch trailer/)).toBeVisible({ timeout: 30_000 });
  const boardButton = lab.sidebar.getByRole('button', { name: 'Board of video-studio' });
  await expect(boardButton).toBeVisible({ timeout: 30_000 });
  await boardButton.click();
  await expect(page.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible({ timeout: 30_000 });
}

test.describe('project board', () => {
  test('moves a card with the keyboard, opens it and comments', async ({ lab, page }) => {
    await openBoard(lab, page);
    const todo = page.getByRole('list', { name: 'To do cards' });
    const inProgress = page.getByRole('list', { name: 'In progress cards' });
    const tile = page.getByRole('listitem', { name: '#2 Document pipeline editor shortcuts' });
    await expect(todo.getByRole('listitem', { name: '#2 Document pipeline editor shortcuts' })).toBeVisible();

    await tile.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(inProgress.getByRole('listitem', { name: '#2 Document pipeline editor shortcuts' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Moved #2 to In progress' })).toBeAttached();

    await tile.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('complementary', { name: /^#2/ });
    await expect(drawer).toBeVisible();
    const comment = drawer.getByRole('combobox', { name: 'Comment on #2' });
    await comment.fill('Shortcuts are listed in the editor help too.');
    await drawer.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(drawer.getByText('Shortcuts are listed in the editor help too.')).toBeVisible();
    expect(lab.errors).toEqual([]);
  });

  test('creates a simple teammate through the dialog', async ({ lab, page }) => {
    await openBoard(lab, page);
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Teammates' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'New teammate' }).first().click();

    const dialog = page.getByRole('dialog', { name: 'New teammate' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Docs writer');
    await dialog.getByRole('button', { name: 'Next' }).click();
    // One agent: the harness is preselected; pick a model.
    await dialog.getByRole('button', { name: 'Model' }).click();
    await page.getByRole('option').first().click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Create teammate' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Teammates' })).toContainText('@docs-writer');
    expect(lab.errors).toEqual([]);
  });

  test('a chat shows its active card and accepts its agent proposal', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Storyboard the launch trailer/).click();

    const chip = page.getByRole('button', { name: /^Active card: #1 Route every host call through transport\.ts/ });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Open on board' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Unlink from this chat' })).toBeVisible();
    await page.keyboard.press('Escape');

    const proposals = page.getByRole('list', { name: 'Board proposals from this chat' });
    await expect(proposals).toContainText('Agent proposes: Move #5 to Done');
    await proposals.getByRole('button', { name: /^Accept: Move #5 to Done/ }).click();
    await expect(lab.toast('Accepted: Move #5 to Done')).toBeVisible();
    await expect(proposals).toHaveCount(0);

    // The agent's earlier edit of #1 can be undone from the chat.
    const updates = page.getByRole('region', { name: 'Board updates from this chat' });
    await updates.getByRole('button', { name: /^Board updates/ }).click();
    await expect(updates.getByRole('button', { name: /^Undo: #1/ })).toBeVisible();
    expect(lab.errors).toEqual([]);
  });
});
