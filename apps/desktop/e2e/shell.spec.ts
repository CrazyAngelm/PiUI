import { expect, test } from './fixtures';

test.describe('shell navigation', () => {
  test('sidebar sections open their views and mark the current page', async ({ lab, page }) => {
    await lab.open();
    await expect(page.getByRole('heading', { level: 1, name: 'What should we work on?' })).toBeVisible();
    await expect(lab.nav('New chat')).toHaveAttribute('aria-current', 'page');

    await lab.nav('Inbox').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    await expect(lab.nav('Inbox')).toHaveAttribute('aria-current', 'page');
    await expect(lab.nav('New chat')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 2, name: /Waiting for your decision/ })).toBeVisible();

    await lab.openPipelines();
    await expect(lab.nav('Pipelines')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('radio', { name: 'Editor' })).toBeChecked();

    await lab.openRuns();
    await expect(lab.nav('Runs')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('radio', { name: 'Runs' })).toBeChecked();

    await lab.openAutomations();
    await expect(lab.nav('Automations')).toHaveAttribute('aria-current', 'page');

    await lab.openSettings();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(lab.nav('Settings')).toHaveAttribute('aria-current', 'page');

    await lab.chat(/Plan a weekend in Lisbon/).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Plan a weekend in Lisbon' })).toBeVisible();
    await expect(lab.chat(/Plan a weekend in Lisbon/)).toHaveAttribute('aria-current', 'page');

    // Collapsing a project hides its chats; expanding shows them again.
    const project = lab.sidebar.getByRole('button', { name: 'video-studio', exact: true });
    await expect(project).toHaveAttribute('aria-expanded', 'true');
    await project.click();
    await expect(project).toHaveAttribute('aria-expanded', 'false');
    await expect(lab.chat(/Storyboard the launch trailer/)).toBeHidden();
    await project.click();
    await expect(lab.chat(/Storyboard the launch trailer/)).toBeVisible();
  });

  test('a restricted project needs an explicit trust decision before pipelines', async ({ lab, page }) => {
    await lab.open();
    await lab.sidebar.getByRole('button', { name: 'Options for legacy-repo' }).click();
    await page.getByRole('menuitem', { name: 'Trust this folder…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Trust legacy-repo?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Trust is not a sandbox.');

    // Cancelling keeps the folder restricted.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await lab.openPipelines();
    await page.getByRole('region', { name: 'Pipelines' }).getByRole('button', { name: 'piui' }).click();
    await lab.option('legacy-repo').click();
    await expect(page.getByText('This folder is restricted')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Pipeline editor' })).toBeHidden();

    // Trusting it from Settings → Projects unlocks the editor.
    await lab.openSettings();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Projects' }).click();
    const card = page.getByRole('article').filter({ hasText: 'legacy-repo' });
    await expect(card).toContainText('Restricted');
    await card.getByRole('button', { name: 'Review trust…' }).click();
    await page.getByRole('dialog', { name: 'Trust legacy-repo?' }).getByRole('button', { name: 'Trust folder' }).click();
    await expect(lab.toast('Folder trusted')).toBeVisible();
    await expect(card).toContainText('Trusted');
    await lab.openPipelines();
    await expect(page.getByRole('region', { name: 'Pipeline editor' })).toBeVisible();
  });

  test('leaving an unsaved pipeline asks before discarding the draft', async ({ lab, page }) => {
    await lab.open();
    const editor = await lab.openPipelines();
    await editor.getByRole('button', { name: /^Chain/ }).click();
    await expect(editor.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Chain');
    await expect(editor.getByText('Unsaved')).toBeVisible();

    await lab.nav('Runs').click();
    const guard = page.getByRole('dialog', { name: 'Leave the pipeline editor?' });
    await expect(guard).toBeVisible();
    // The guard requires an explicit choice: Escape does not discard.
    await page.keyboard.press('Escape');
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(guard).toBeHidden();
    await expect(editor.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Chain');

    await lab.nav('Runs').click();
    await guard.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByRole('navigation', { name: 'Runs' })).toBeVisible();
    await lab.nav('Pipelines').click();
    await expect(page.getByRole('heading', { name: 'Build a pipeline' })).toBeVisible();
  });
});

test.describe('command palette', () => {
  test('Ctrl+K finds a command and runs it', async ({ lab, page }) => {
    await lab.open();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    await expect(palette).toBeVisible();
    const search = palette.getByPlaceholder('Search chats, projects and commands…');
    await expect(search).toBeFocused();
    await search.fill('open runs');
    await expect(palette.getByRole('option', { name: 'Open runs' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Runs' })).toBeVisible();

    // Chats are searchable by title.
    await page.keyboard.press('Control+k');
    await search.fill('lisbon');
    await palette.getByRole('option', { name: /Plan a weekend in Lisbon/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Plan a weekend in Lisbon' })).toBeVisible();
  });

  test("Ctrl+K lists the open Pi chat's native commands and inserts one without sending", async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Pi extension playground/).click();
    const message = page.getByRole('textbox', { name: 'Message' });
    await expect(message).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    const search = palette.getByPlaceholder('Search chats, projects and commands…');
    await search.fill('fix-tests');
    const option = palette.getByRole('option', { name: /\/fix-tests/ });
    await expect(option).toContainText('Fix failing tests');
    await expect(option).toContainText('Pi · prompt');
    await expect(palette.getByText('Pi commands')).toBeVisible();
    await option.click();
    await expect(palette).toBeHidden();
    await expect(message).toHaveValue('/fix-tests ');
    await expect(page.getByRole('button', { name: 'Stop turn' })).toHaveCount(0);

    // Keyboard: a skill command is chosen with the arrow keys and Enter.
    await message.fill('');
    await page.keyboard.press('Control+k');
    await search.fill('/skill:release');
    await expect(palette.getByRole('option', { name: /\/skill:release-notes/ })).toHaveAttribute('data-selected', /.*/);
    await page.keyboard.press('Enter');
    await expect(message).toHaveValue('/skill:release-notes ');

    // Extension commands are listed too; a harness without `/` commands (Codex) lists none.
    await page.keyboard.press('Control+k');
    await search.fill('deploy-preview');
    await expect(palette.getByRole('option', { name: /\/deploy-preview/ })).toContainText('Pi · extension');
    await page.keyboard.press('Escape');
    await lab.chat(/Route host calls through one transport/).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Route host calls through one transport' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await search.fill('fix-tests');
    await expect(palette.getByRole('option', { name: /\/fix-tests/ })).toHaveCount(0);
    await expect(palette.getByText('Pi commands')).toHaveCount(0);
  });

  test('an unknown query finds nothing and Escape closes without navigating', async ({ lab, page }) => {
    await lab.open();
    const trigger = lab.nav('Search');
    await trigger.click();
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    await expect(palette).toBeVisible();
    await palette.getByPlaceholder('Search chats, projects and commands…').fill('zz-no-such-command');
    await expect(palette.getByText('Nothing found')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'What should we work on?' })).toBeVisible();
    await expect(trigger).toBeFocused();
  });
});

test.describe('appearance and language', () => {
  const background = (page: import('@playwright/test').Page) =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  test('theme switch applies dark, light and system themes', async ({ lab, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await lab.open();
    await lab.openSettings();
    const theme = page.getByRole('group', { name: 'Theme' });
    await expect(theme.getByRole('radio', { name: 'System' })).toBeChecked();
    const systemLight = await background(page);

    await theme.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await background(page);
    expect(dark).not.toBe(systemLight);

    await theme.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await background(page)).toBe(systemLight);

    // The explicit choice wins over the operating system; System follows it.
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await background(page)).toBe(systemLight);
    await theme.getByRole('radio', { name: 'System' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
    await expect.poll(() => background(page)).toBe(dark);

    // The palette action toggles the theme too.
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Search and commands' }).getByPlaceholder('Search chats, projects and commands…').fill('dark theme');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('Russian copy renders, persists and never translates user content', async ({ lab, page }) => {
    await lab.open();
    await lab.openSettings();
    await page.getByRole('group', { name: 'Language' }).getByRole('radio', { name: 'Русский' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

    const sidebar = page.getByRole('navigation', { name: 'Навигация рабочей области' });
    await expect(sidebar.getByRole('button', { name: 'Новый чат Ctrl+N' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Пайплайны', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Настройки' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Тема' }).getByRole('radio', { name: 'Тёмная' })).toBeVisible();
    // Chat titles are user content and stay as written.
    await expect(sidebar.getByRole('button', { name: /Plan a weekend in Lisbon/ })).toBeVisible();

    // The choice survives a reload.
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Навигация рабочей области' })).toBeVisible();
    await sidebar.getByRole('button', { name: 'Новый чат Ctrl+N' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Что делаем?' })).toBeVisible();

    await sidebar.getByRole('button', { name: 'Настройки Ctrl+,' }).click();
    await page.getByRole('group', { name: 'Язык' }).getByRole('radio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(lab.nav('New chat')).toBeVisible();
  });
});
