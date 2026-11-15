import { expect, test } from './fixtures';

const CHAT = 'Plan a weekend in Lisbon';

test.describe('chat menu and marks in the sidebar', () => {
  test('a chat is renamed from its sidebar menu', async ({ lab, page }) => {
    await lab.open();
    await lab.sidebar.getByRole('button', { name: `Options for ${CHAT}` }).click();
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename chat' });
    await dialog.getByRole('textbox', { name: 'Chat title' }).fill('Lisbon in three days');
    await dialog.getByRole('button', { name: 'Save name' }).click();
    await expect(dialog).toBeHidden();
    await expect(lab.chat('Lisbon in three days')).toBeVisible();
    await expect(lab.chat(CHAT)).toHaveCount(0);
  });

  test('deleting from the sidebar menu asks for confirmation first', async ({ lab, page }) => {
    await lab.open();
    await lab.sidebar.getByRole('button', { name: `Options for ${CHAT}` }).click();
    await page.getByRole('menuitem', { name: 'Delete chat…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete chat?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(lab.chat(CHAT)).toBeVisible();
  });

  test('the menu trigger is reachable by keyboard and visible on focus', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(CHAT).focus();
    await page.keyboard.press('Tab');
    const trigger = lab.sidebar.getByRole('button', { name: `Options for ${CHAT}` });
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Mark…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  test('a shape on a chat and an emoji on a project survive a reload', async ({ lab, page }) => {
    await lab.open();
    const project = lab.sidebar.getByRole('button', { name: 'piui', exact: true });

    // A color alone only waits for a shape; the shape applies it and closes the dialog.
    await lab.sidebar.getByRole('button', { name: `Options for ${CHAT}` }).click();
    await page.getByRole('menuitem', { name: 'Mark…' }).click();
    const picker = page.getByRole('dialog', { name: 'Mark' });
    await picker.getByRole('radio', { name: 'Green' }).click();
    await expect(picker).toBeVisible();
    await picker.getByRole('radio', { name: 'Star' }).click();
    await expect(picker).toBeHidden();
    await expect(lab.chat(CHAT).locator('[data-mark="star"][data-mark-color="green"]')).toBeVisible();

    await lab.sidebar.getByRole('button', { name: 'Options for piui' }).click();
    await page.getByRole('menuitem', { name: 'Mark…' }).click();
    await picker.getByRole('button', { name: '🚀' }).click();
    await expect(picker).toBeHidden();
    await expect(project).toContainText('🚀');

    await page.reload();
    await expect(lab.sidebar).toBeVisible();
    await expect(lab.chat(CHAT).locator('[data-mark="star"][data-mark-color="green"]')).toBeVisible();
    await expect(project).toContainText('🚀');

    // The chat header shows the mark too, and the picker removes it.
    await lab.chat(CHAT).click();
    const header = page.getByRole('heading', { level: 1, name: CHAT });
    await expect(header).toBeVisible();
    await expect(page.locator('header [data-mark="star"]')).toBeVisible();
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Mark…' }).click();
    await picker.getByRole('button', { name: 'Remove mark' }).click();
    await expect(picker).toBeHidden();
    await expect(lab.chat(CHAT).locator('[data-mark]')).toHaveCount(0);
  });

  test('the picker is operated by keyboard: arrows move, Space chooses', async ({ lab, page }) => {
    await lab.open();
    await lab.sidebar.getByRole('button', { name: `Options for ${CHAT}` }).click();
    await page.getByRole('menuitem', { name: 'Mark…' }).click();
    const picker = page.getByRole('dialog', { name: 'Mark' });
    await picker.getByRole('radio', { name: 'Blue' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(picker.getByRole('radio', { name: 'Purple' })).toBeFocused();
    await page.keyboard.press('Space');
    await picker.getByRole('radio', { name: 'Circle' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(picker.getByRole('radio', { name: 'Square' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(picker).toBeHidden();
    await expect(lab.chat(CHAT).locator('[data-mark="square"][data-mark-color="purple"]')).toBeVisible();
  });
});
