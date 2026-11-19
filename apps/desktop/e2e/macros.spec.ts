import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

const review = { id: 'review', name: 'review', description: 'Check the changes', prompt: 'Review the diff carefully.', skills: ['test-runner'] };
const expanded = '$test-runner Review the diff carefully.';

type Entry = { id: string; name: string; description: string; prompt: string; skills: string[]; key?: string };

async function seed(page: Page, entries: Entry[] = [review]): Promise<void> {
  await page.addInitScript((entries) => {
    if (localStorage.getItem('piui.macros.v1') === null) localStorage.setItem('piui.macros.v1', JSON.stringify(entries));
  }, entries);
}

async function openChat(lab: Lab): Promise<Locator> {
  await lab.chat(/Route host calls through one transport/).click();
  const editor = lab.page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

async function openMacros(lab: Lab): Promise<void> {
  await lab.page.keyboard.press('Control+,');
  const sections = lab.page.getByRole('navigation', { name: 'Settings sections' });
  await sections.getByRole('button', { name: 'Macros', exact: true }).press('Enter');
  await expect(lab.page.getByRole('heading', { name: 'Macros', exact: true })).toBeVisible();
}

async function createByKeyboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New macro', exact: true }).first().press('Enter');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await page.keyboard.insertText('review');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: /^Key/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('Check the changes');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('test-runner');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('Review the diff carefully.');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
}

async function expectGeometry(editor: Locator): Promise<void> {
  await expect.poll(() => editor.evaluate((input) => {
    const mirror = input.parentElement?.querySelector<HTMLElement>('.macro-marks');
    if (!mirror) return 'missing mirror';
    const a = input.getBoundingClientRect();
    const b = mirror.getBoundingClientRect();
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
  })).toBeLessThanOrEqual(0.5);
  await expect.poll(() => editor.evaluate((input) => {
    const mirror = input.parentElement?.querySelector<HTMLElement>('.macro-marks');
    return mirror && { scrollHeight: mirror.scrollHeight - input.scrollHeight, clientWidth: mirror.clientWidth - input.clientWidth, scrollTop: mirror.scrollTop - input.scrollTop };
  })).toEqual({ scrollHeight: 0, clientWidth: 0, scrollTop: 0 });
}

test('Settings creates by keyboard, rejects duplicate names, deletes with Undo, and persists edits on reload', async ({ lab, page }) => {
  await seed(page, []);
  await lab.open();
  await openMacros(lab);
  await expect(page.getByText('No macros yet', { exact: true })).toBeVisible();
  await createByKeyboard(page);
  const list = page.getByRole('list', { name: 'Macros', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByText('review', { exact: true })).toBeVisible();
  await createByKeyboard(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Another macro already has this name.' })).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await list.getByRole('button', { name: 'Delete //review', exact: true }).press('Enter');
  await expect(list).toHaveCount(0);
  await lab.toast('Deleted //review').getByRole('button', { name: 'Undo', exact: true }).press('Enter');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: 'Edit //review', exact: true }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Updated review.');
  await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
  await page.reload();
  await openMacros(lab);
  await list.getByRole('button', { name: 'Edit //review', exact: true }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Updated review.');
});

test('Codex space menu inserts with Enter, Tab and click, filters, and highlights known macros', async ({ lab, page }) => {
  await seed(page);
  await lab.open();
  const editor = await openChat(lab);
  const menu = page.getByRole('listbox', { name: 'Macros', exact: true });
  for (const key of ['Enter', 'Tab', 'click']) {
    await editor.fill(' re');
    const option = menu.getByRole('option', { name: /^review( |$)/ });
    await expect(option).toBeVisible();
    if (key === 'click') await option.click();
    else await editor.press(key);
    await expect(editor).toHaveValue('//review ');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('.macro-marks mark')).toHaveText('//review');
  }
  // A space that names no macro is an ordinary space.
  await editor.fill(' unknown');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.macro-marks')).toHaveCount(0);
});

test('typed spaces open the menu only at the start or as a second space, and Escape keeps a plain space', async ({ lab, page }) => {
  await seed(page);
  await lab.open();
  const editor = await openChat(lab);
  const menu = page.getByRole('listbox', { name: 'Macros', exact: true });
  await editor.fill('');
  await editor.press('Space');
  await expect(menu.getByRole('option', { name: /^review( |$)/ })).toBeVisible();
  await editor.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(editor).toHaveValue(' ');
  await editor.press('r');
  await expect(menu).toHaveCount(0);
  await editor.fill('fix');
  await editor.press('Space');
  await expect(menu).toHaveCount(0);
  await editor.press('Space');
  await expect(menu).toBeVisible();
  await editor.press('r');
  await editor.press('ArrowDown');
  await editor.press('Enter');
  await expect(editor).toHaveValue('fix //review ');
  await expect(page.locator('.macro-marks mark')).toHaveText('//review');
});

test('mirror matches short, wrapped and scrolling text and stays aligned on resize', async ({ lab, page }) => {
  await seed(page);
  await lab.open();
  const editor = await openChat(lab);
  for (const text of ['//review ', `${'Some wrapping words '.repeat(25)}//review end`, `${'line\n'.repeat(20)}//review last\n`]) {
    await editor.fill(text);
    await expectGeometry(editor);
    await editor.evaluate((input) => { input.scrollTop = input.scrollHeight; input.dispatchEvent(new Event('scroll')); });
    await expectGeometry(editor);
  }
  await page.setViewportSize({ width: 1000, height: 860 });
  await expectGeometry(editor);
});

test('hover previews exact native text, Escape and typing close it, and the pencil edits the macro', async ({ lab, page }) => {
  await seed(page);
  await lab.open();
  const editor = await openChat(lab);
  await editor.fill('//review ');
  const mark = page.locator('.macro-marks mark');
  await expect(mark).toBeVisible();
  const hover = async () => {
    const box = await mark.boundingBox();
    if (!box) throw new Error('Macro token has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  const card = page.getByRole('group', { name: 'review', exact: true });
  await hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Check the changes');
  await expect(card).toContainText(expanded);
  await editor.press('Escape');
  await expect(card).toHaveCount(0);
  await page.mouse.move(0, 0);
  await hover();
  await expect(card).toBeVisible();
  await editor.press('End');
  await editor.press('x');
  await expect(card).toHaveCount(0);
  await page.mouse.move(0, 0);
  await hover();
  await card.getByRole('button', { name: 'Edit macro', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Macros', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('dialog', { name: 'Edit macro', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('review');
});

test('F2 at the caret edits from both composers and ignores modified F2', async ({ lab, page }) => {
  await seed(page);
  await lab.open();
  for (const existing of [true, false]) {
    if (!existing) await lab.nav('New chat').click();
    const editor = existing ? await openChat(lab) : page.getByRole('textbox', { name: 'Message', exact: true });
    await editor.fill('//review ');
    await editor.press('Home');
    await editor.press('ArrowRight');
    await editor.press('Shift+F2');
    await expect(page.getByRole('dialog', { name: 'Edit macro', exact: true })).toHaveCount(0);
    await editor.press('F2');
    const dialog = page.getByRole('dialog', { name: 'Edit macro', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('review');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});

test('sending expands every known token in an existing Codex chat', async ({ lab, page }) => {
  await seed(page);
  await lab.open();
  const editor = await openChat(lab);
  await editor.fill('//review and fix');
  await editor.press('Enter');
  await expect(page.getByRole('region', { name: 'Conversation messages' }).getByText(`${expanded} and fix`, { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('');
});

test('the menu lists an exact name before a longer name that starts with it', async ({ lab, page }) => {
  await seed(page, [{ ...review, id: 'review-all', name: 'review-all' }, review]);
  await lab.open();
  const editor = await openChat(lab);
  await editor.fill(' review');
  const options = page.getByRole('listbox', { name: 'Macros', exact: true }).getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.first()).not.toContainText('review-all');
  await editor.press('Enter');
  await expect(editor).toHaveValue('//review ');
});

test('the caret on a macro shows its card, and moving off the macro closes it', async ({ lab, page }) => {
  await seed(page);
  await lab.open();
  const editor = await openChat(lab);
  await editor.fill('fix //review now');
  const card = page.getByRole('group', { name: 'review', exact: true });
  await editor.press('Home');
  await expect(card).toHaveCount(0);
  for (let step = 0; step < 4; step += 1) await editor.press('ArrowRight');
  await expect(card).toBeVisible();
  await expect(card).toContainText(expanded);
  await editor.press('End');
  await expect(card).toHaveCount(0);
});

test('new-chat menu and highlighting use the selected agent syntax and expand the first message', async ({ lab, page }) => {
  await seed(page);
  await lab.open();
  const home = page.getByRole('region', { name: 'What should we work on?' });
  await home.getByRole('button', { name: 'Pi', exact: true }).click();
  await lab.option(/^Codex/).click();
  const editor = home.getByRole('textbox', { name: 'Message', exact: true });
  await editor.fill(' re');
  await expect(page.getByRole('listbox', { name: 'Macros', exact: true }).getByRole('option', { name: /^review( |$)/ })).toBeVisible();
  await editor.press('Enter');
  await expect(editor).toHaveValue('//review ');
  await expect(page.locator('.macro-marks mark')).toHaveText('//review');
  await expectGeometry(editor);
  await home.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation messages' }).getByText(expanded, { exact: true })).toBeVisible();
});

test('with no saved macros a space opens no listbox and / commands still work', async ({ lab, page }) => {
  await seed(page, []);
  await lab.open();
  const editor = await openChat(lab);
  await editor.fill(' ');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.locator('.macro-marks')).toHaveCount(0);
  await editor.fill('/');
  await expect(page.getByRole('listbox', { name: 'Available commands', exact: true })).toBeVisible();
  await lab.nav('New chat').click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(' ');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

function many(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    name: `macro${String(index).padStart(2, '0')}`,
    description: `Macro number ${index}`,
    prompt: `Prompt ${index}.`,
    skills: [] as string[],
  }));
}

const trio = [
  { ...review, id: 'a', name: 'alpha' },
  { ...review, id: 'b', name: 'beta', key: 'x' },
  { ...review, id: 'c', name: 'gamma' },
];

test('digits and a macro key pick from the list a space opens, until a name is typed', async ({ lab, page }) => {
  await seed(page, trio);
  await lab.open();
  const editor = await openChat(lab);
  const menu = page.getByRole('listbox', { name: 'Macros', exact: true });
  await editor.fill('');
  await editor.press('Space');
  await expect(menu.locator('.menu__number')).toHaveText(['1', '2', '3']);
  await expect(menu.locator('.menu__key')).toHaveText(['x']);
  await editor.press('3');
  await expect(editor).toHaveValue('//gamma ');
  await expect(menu).toHaveCount(0);
  await editor.fill('');
  await editor.press('Space');
  await editor.press('x');
  await expect(editor).toHaveValue('//beta ');
  // A digit past the end of the list picks nothing and types.
  await editor.fill('');
  await editor.press('Space');
  await editor.press('9');
  await expect(editor).toHaveValue(' 9');
  // Once a name is started, digits and letters type again and the numbers go.
  await editor.fill('');
  await editor.press('Space');
  await editor.press('l');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.menu__number')).toHaveCount(0);
  await editor.press('1');
  await expect(editor).toHaveValue(' l1');
});

test('a digit never replaces a word already written after the space, and a held key picks once', async ({ lab, page }) => {
  await seed(page, trio);
  await lab.open();
  const editor = await openChat(lab);
  const menu = page.getByRole('listbox', { name: 'Macros', exact: true });
  await editor.fill(' alpha');
  await editor.press('Home');
  await editor.press('ArrowRight');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.menu__number')).toHaveCount(0);
  await editor.press('3');
  await expect(editor).toHaveValue(' 3alpha');
  await editor.fill('');
  await editor.press('Space');
  await expect(menu.locator('.menu__number')).toHaveCount(3);
  await page.keyboard.down('3');
  await page.keyboard.down('3');
  await page.keyboard.down('3');
  await page.keyboard.up('3');
  await expect(editor).toHaveValue('//gamma ');
});

test('a key set in Settings picks the macro in the list, and a key already taken is refused', async ({ lab, page }) => {
  await seed(page, [{ ...review, key: 'r' }, { ...review, id: 'other', name: 'other' }]);
  await lab.open();
  await openMacros(lab);
  await page.getByRole('button', { name: 'Edit //other', exact: true }).press('Enter');
  const key = page.getByRole('textbox', { name: /^Key/ });
  await key.fill('R');
  await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Another macro already uses this key.' })).toBeVisible();
  await key.fill('o');
  await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
  const list = page.getByRole('list', { name: 'Macros', exact: true });
  await expect(list.getByLabel('O', { exact: true })).toBeVisible();
  await expect(list.getByLabel('R', { exact: true })).toBeVisible();
  const editor = await openChat(lab);
  await editor.fill('');
  await editor.press('Space');
  await editor.press('o');
  await expect(editor).toHaveValue('//other ');
});

test('a number can be clicked, and the new-chat composer takes digits and keys too', async ({ lab, page }) => {
  await seed(page, trio);
  await lab.open();
  await lab.nav('New chat').click();
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  const menu = page.getByRole('listbox', { name: 'Macros', exact: true });
  await editor.fill('');
  await editor.press('Space');
  await menu.locator('.menu__number').nth(1).click();
  await expect(editor).toHaveValue('//beta ');
  await editor.fill('');
  await editor.press('Space');
  await editor.press('1');
  await expect(editor).toHaveValue('//alpha ');
  await editor.fill('');
  await editor.press('Space');
  await editor.press('x');
  await expect(editor).toHaveValue('//beta ');
});

test('a long macro list scrolls in its menu, follows the arrow keys and stays inside the window', async ({ lab, page }) => {
  await seed(page, many(40));
  await page.setViewportSize({ width: 1280, height: 640 });
  await lab.open();
  await lab.nav('New chat').click();
  const home = page.getByRole('region', { name: 'What should we work on?' });
  const editor = home.getByRole('textbox', { name: 'Message', exact: true });
  const menu = page.getByRole('listbox', { name: 'Macros', exact: true });
  await editor.fill('');
  await editor.press('Space');
  await expect(menu).toBeVisible();
  const homeBox = await home.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(menuBox && homeBox && menuBox.y >= homeBox.y).toBe(true);
  expect(await menu.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  for (let step = 0; step < 30; step += 1) await editor.press('ArrowDown');
  await expect.poll(() => menu.evaluate((node) => {
    const row = node.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row) return 'no active row';
    const a = row.getBoundingClientRect();
    const b = node.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  })).toBe(true);
  await editor.press('Enter');
  await expect(editor).toHaveValue('//macro30 ');
});

test('the new-chat composer sits low enough for a full macro list', async ({ lab, page }) => {
  await seed(page, many(12));
  await page.setViewportSize({ width: 1280, height: 900 });
  await lab.open();
  await lab.nav('New chat').click();
  const home = page.getByRole('region', { name: 'What should we work on?' });
  const editor = home.getByRole('textbox', { name: 'Message', exact: true });
  await editor.fill('');
  await editor.press('Space');
  const menu = page.getByRole('listbox', { name: 'Macros', exact: true });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box && box.y).toBeGreaterThanOrEqual(0);
  // Twelve rows are more than fit: the menu is as tall as its limit and the rest scrolls.
  expect(box && box.height).toBeGreaterThan(300);
});

test('safe mode keeps local macro settings available', async ({ lab, page }) => {
  await seed(page);
  await lab.open('safe');
  await openMacros(lab);
  await expect(page.getByRole('list', { name: 'Macros', exact: true }).getByText('review', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit //review', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
});
