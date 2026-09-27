import { expect, test } from './fixtures';

test.describe('keyboard-only operation', () => {
  test('Tab walks the skip link and the sidebar in order; Enter activates', async ({ lab, page }) => {
    await lab.open();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    for (const label of ['New chat', 'Search', 'Inbox', 'Pipelines', 'Runs', 'Automations'] as const) {
      await page.keyboard.press('Tab');
      await expect(lab.nav(label)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Automations' })).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(lab.sidebar.getByRole('button', { name: 'Project options' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(lab.sidebar.getByRole('button', { name: 'Add project' })).toBeFocused();
    await page.keyboard.press('Tab');
    const project = lab.sidebar.getByRole('button', { name: 'piui', exact: true });
    await expect(project).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(project).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(project).toHaveAttribute('aria-expanded', 'true');

    // Options, new chat in the project, then its first chat.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(lab.chat(/Streaming markdown renderer spike/)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Streaming markdown renderer spike' })).toBeVisible();
  });

  test('the skip link moves focus to the main content', async ({ lab, page }) => {
    await lab.open();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(lab.main).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('region', { name: 'What should we work on?' }).getByRole('textbox', { name: 'Message' })).toBeFocused();
  });

  test('global shortcuts open views and the palette closes with Escape', async ({ lab, page }) => {
    await lab.open();
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Control+Shift+I');
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    await page.keyboard.press('Control+n');
    await expect(page.getByRole('heading', { level: 1, name: 'What should we work on?' })).toBeVisible();

    const search = lab.nav('Search');
    await search.focus();
    await page.keyboard.press('Enter');
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    await expect(palette).toBeVisible();
    await expect(palette.getByPlaceholder('Search chats, projects and commands…')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(search).toBeFocused();
  });

  test('dialogs trap focus, close with Escape and return focus to their trigger', async ({ lab, page }) => {
    await lab.open();
    await lab.openAutomations();
    const create = page.getByRole('region', { name: 'Automations' }).getByRole('button', { name: 'New automation' });
    await create.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'New automation' });
    await expect(dialog).toBeVisible();
    // Focus stays inside the modal while tabbing forward and backward.
    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press('Tab');
      await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(create).toBeFocused();

    // A dialog opened from a menu returns focus to the menu trigger.
    await lab.chat(/Plan a weekend in Lisbon/).click();
    const actions = page.getByRole('button', { name: 'Chat actions' });
    await actions.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Delete chat…' })).toBeFocused();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: 'Delete chat?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('The harness keeps its own history.');
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Plan a weekend in Lisbon' })).toBeVisible();
    await expect(actions).toBeFocused();
  });

  test('pickers open, choose and close from the keyboard', async ({ lab, page }) => {
    await lab.open();
    const composer = page.getByRole('region', { name: 'What should we work on?' });
    const harness = composer.getByRole('button', { name: 'Pi', exact: true });
    await harness.focus();
    await page.keyboard.press('Enter');
    const search = page.getByRole('combobox', { name: 'Who answers' });
    await expect(search).toBeFocused();
    await page.keyboard.type('hermes');
    await page.keyboard.press('Enter');
    await expect(search).toBeHidden();
    const chosen = composer.getByRole('button', { name: 'Hermes', exact: true });
    await expect(chosen).toBeFocused();

    // Escape closes without changing the choice.
    await page.keyboard.press('Enter');
    await expect(search).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();
    await expect(chosen).toBeFocused();
  });
});
