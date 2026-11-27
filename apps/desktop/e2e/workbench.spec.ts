import type { Locator } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

const LISBON = 'Plan a weekend in Lisbon';
const CACHE = 'Cache sizing';
const LIFETIMES = 'Explain Rust lifetimes';
const TRANSPORT = 'Route host calls through one transport';
const CRASH = 'Investigate crash on startup';

/** Opens chats from the sidebar one after another; each becomes a tab. */
async function openChats(lab: Lab, titles: string[]): Promise<void> {
  for (const title of titles) {
    await lab.chat(title).click();
    await expect(lab.page.getByRole('tab', { name: title })).toHaveAttribute('aria-selected', 'true');
  }
}

const tab = (lab: Lab, title: string) => lab.page.getByRole('tab', { name: title });
const pane = (lab: Lab, title: string) => lab.page.getByRole('region', { name: title });

/** The place of an element on the page; an element that is not drawn fails the test. */
async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const value = await locator.boundingBox();
  if (!value) throw new Error('The element is not drawn.');
  return value;
}

/** Shows a chat beside the active pane through its tab's context menu. */
async function openFromTab(lab: Lab, title: string, item: 'Open to the right' | 'Open below'): Promise<void> {
  await tab(lab, title).click({ button: 'right' });
  await lab.page.getByRole('menuitem', { name: item }).click();
}

test.describe('chat tabs', () => {
  test('checking chat status clears a stale error and the notice can also be dismissed', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON]);
    const chat = pane(lab, LISBON);
    const notice = chat.getByRole('alert').filter({ hasText: 'The Pi runtime could not authenticate the selected model.' });
    async function showError(): Promise<void> {
      await page.evaluate(async (path) => {
        const { workspaceHost } = await import(path);
        const snapshot = workspaceHost.snapshot;
        workspaceHost.snapshot = () => {
          workspaceHost.snapshot = snapshot;
          return Promise.reject(new Error('The Pi runtime could not authenticate the selected model.'));
        };
      }, '/src/host-api/workspaceClient.ts');
      await chat.getByRole('button', { name: 'Chat actions' }).click();
      await page.getByRole('menuitem', { name: 'Refresh from history' }).click();
      await expect(notice).toBeVisible();
    }

    await showError();
    await page.evaluate(async (path) => {
      const { workspaceHost } = await import(path);
      const snapshot = workspaceHost.snapshot;
      const gate = new Promise<void>((resolve) => window.addEventListener('finish-status-check', () => resolve(), { once: true }));
      workspaceHost.snapshot = async (sessionId: string) => {
        workspaceHost.snapshot = snapshot;
        await gate;
        return snapshot(sessionId);
      };
    }, '/src/host-api/workspaceClient.ts');
    await notice.getByRole('button', { name: 'Check status' }).click();
    await expect(notice.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('finish-status-check')));
    await expect(notice).toHaveCount(0);

    await showError();
    await notice.getByRole('button', { name: 'Dismiss notice' }).click();
    await expect(notice).toHaveCount(0);
  });

  test('a plain click dismisses a retained transcript selection without dismissing a new range', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON]);
    const chat = pane(lab, LISBON);
    const messages = chat.getByRole('region', { name: 'Conversation messages' });
    const row = messages.locator('[data-timeline-block]').first();
    const input = chat.getByRole('textbox', { name: 'Message' });
    await expect(row).toBeVisible();

    // Model WebKit retaining its range when the user clicks away.
    await input.evaluate((element) => element.addEventListener('mousedown', (event) => event.preventDefault()));
    const select = async () => row.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const selected = () => page.evaluate(() => !document.getSelection()?.isCollapsed);

    await select();
    expect(await selected()).toBe(true);
    await input.click({ modifiers: ['Shift'] });
    expect(await selected()).toBe(true);
    await input.click();
    await expect.poll(selected).toBe(false);

    await select();
    await page.evaluate(() => {
      document.addEventListener('pointerup', () => {
        const selection = document.getSelection()!;
        const range = selection.getRangeAt(0);
        const text = document.createTreeWalker(range.startContainer, NodeFilter.SHOW_TEXT).nextNode();
        if (!text?.textContent) throw new Error('Expected transcript text');
        range.setStart(text, 0);
        range.setEnd(text, 1);
      }, { once: true });
    });
    await input.click();
    expect(await selected()).toBe(true);
  });

  test('opening an older chat leaves its sidebar date and position alone', async ({ lab }) => {
    await lab.open();
    const older = lab.chat(LIFETIMES);
    const newer = lab.chat(CACHE);
    const time = await older.locator('.chat__time').innerText();
    expect((await box(newer)).y).toBeLessThan((await box(older)).y);

    await openChats(lab, [LIFETIMES]);
    await expect(pane(lab, LIFETIMES).getByRole('region', { name: 'Conversation messages' })).toBeVisible();
    await expect(older.locator('.chat__time')).toHaveText(time);
    expect((await box(newer)).y).toBeLessThan((await box(older)).y);
  });

  test('opened chats stay as tabs and a click switches between them', async ({ lab }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    const tabs = lab.page.getByRole('tablist', { name: 'Open chats' });
    await expect(tabs.getByRole('tab')).toHaveCount(2);

    await tab(lab, LISBON).click();
    await expect(tab(lab, LISBON)).toHaveAttribute('aria-selected', 'true');
    await expect(tab(lab, CACHE)).toHaveAttribute('aria-selected', 'false');
    await expect(pane(lab, LISBON)).toBeVisible();
    lab.expectNoErrors();
  });

  test('closing a tab removes it and the chat that was shown gives way to its neighbour', async ({ lab }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    // The close button is a pointer shortcut outside the accessibility tree: a tablist holds tabs only.
    await lab.page.getByRole('button', { name: `Close tab ${CACHE}`, includeHidden: true }).click();
    await expect(tab(lab, CACHE)).toHaveCount(0);
    await expect(tab(lab, LISBON)).toHaveAttribute('aria-selected', 'true');
    await expect(lab.chat(CACHE)).toBeVisible();
  });

  test('a reload restores the tabs and the panes', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    await expect(pane(lab, LISBON)).toBeVisible();
    await expect(pane(lab, CACHE)).toBeVisible();

    await page.reload();
    await expect(lab.sidebar).toBeVisible();
    await expect(tab(lab, LISBON)).toBeVisible();
    await expect(tab(lab, CACHE)).toBeVisible();
    await expect(pane(lab, LISBON)).toBeVisible();
    await expect(pane(lab, CACHE)).toBeVisible();
  });

  test('the tab strip is a keyboard walk: arrows, Home, End, Delete and Ctrl+Tab', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE, LIFETIMES]);
    await tab(lab, LIFETIMES).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tab(lab, CACHE)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab(lab, LISBON)).toBeFocused();
    await page.keyboard.press('End');
    await expect(tab(lab, LIFETIMES)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await expect(tab(lab, CACHE)).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Control+Tab');
    await expect(tab(lab, LIFETIMES)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Shift+Tab');
    await expect(tab(lab, CACHE)).toHaveAttribute('aria-selected', 'true');

    await tab(lab, CACHE).focus();
    await page.keyboard.press('Delete');
    await expect(tab(lab, CACHE)).toHaveCount(0);
    await expect(tab(lab, LIFETIMES)).toBeFocused();
  });
});

test.describe('split panes', () => {
  test('Open to the right from the tab menu shows two panes with both chats', async ({ lab }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    await expect(pane(lab, LISBON)).toBeVisible();
    await expect(pane(lab, CACHE)).toBeVisible();
    await expect(lab.page.getByRole('button', { name: 'Close pane' })).toHaveCount(2);
    lab.expectNoErrors();
  });

  test('a chat stays mounted when panes open and close beside it', async ({ lab }) => {
    await lab.open();
    await openChats(lab, [LISBON, LIFETIMES, TRANSPORT]);
    // A mark on the live element: it is gone if the chat is mounted again.
    await lab.page.getByRole('region', { name: 'Conversation messages' }).evaluate((element) => element.setAttribute('data-kept', 'yes'));
    const kept = pane(lab, TRANSPORT).locator('[data-kept="yes"]');

    await openFromTab(lab, LISBON, 'Open to the right');
    await expect(lab.page.getByRole('button', { name: 'Close pane' })).toHaveCount(2);
    await expect(kept).toHaveCount(1);
    // Splitting the first chat's own pane moves it deeper into the layout.
    await tab(lab, TRANSPORT).click();
    await openFromTab(lab, LIFETIMES, 'Open below');
    await expect(lab.page.getByRole('button', { name: 'Close pane' })).toHaveCount(3);
    await expect(kept).toHaveCount(1);

    await pane(lab, LISBON).getByRole('button', { name: 'Close pane' }).click();
    await expect(lab.page.getByRole('button', { name: 'Close pane' })).toHaveCount(2);
    await expect(kept).toHaveCount(1);
    lab.expectNoErrors();
  });

  test('a third pane opens below', async ({ lab }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE, LIFETIMES]);
    await openFromTab(lab, LISBON, 'Open to the right');
    await openFromTab(lab, CACHE, 'Open below');
    for (const title of [LISBON, CACHE, LIFETIMES]) await expect(pane(lab, title)).toBeVisible();
    await expect(lab.page.getByRole('button', { name: 'Close pane' })).toHaveCount(3);
  });

  test('dragging an already visible tab into the left pane swaps the chats and survives reloading', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE, LIFETIMES]);
    await openFromTab(lab, LISBON, 'Open to the right');
    await openFromTab(lab, CACHE, 'Open below');
    const left = await box(pane(lab, LIFETIMES));
    const target = { x: left.x + left.width / 2, y: left.y + left.height / 2 };
    const source = await box(tab(lab, CACHE));

    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await page.mouse.move(target.x, target.y);
    await page.mouse.up();

    await expect.poll(async () => (await box(pane(lab, CACHE))).x).toBe(left.x);
    await expect(tab(lab, CACHE)).toHaveAttribute('aria-selected', 'true');
    await expect(pane(lab, LIFETIMES)).toBeVisible();
    await expect(pane(lab, LISBON)).toBeVisible();

    await page.reload();
    await expect(tab(lab, CACHE)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await box(pane(lab, CACHE))).x).toBe(left.x);
    await expect(pane(lab, LIFETIMES)).toBeVisible();
    await expect(pane(lab, LISBON)).toBeVisible();
  });

  test('a fifth chat is refused with a message', async ({ lab, page }) => {
    await lab.open();
    // The last chat opened is in the single pane; three more join it, and the first one has no room.
    await openChats(lab, [LISBON, CACHE, LIFETIMES, TRANSPORT, CRASH]);
    await openFromTab(lab, CACHE, 'Open to the right');
    await openFromTab(lab, LIFETIMES, 'Open below');
    await openFromTab(lab, TRANSPORT, 'Open to the right');
    await expect(lab.page.getByRole('button', { name: 'Close pane' })).toHaveCount(4);

    // The tab menu refuses it up front; the sidebar menu explains.
    await tab(lab, LISBON).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Open to the right' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await lab.sidebar.getByRole('button', { name: `Options for ${LISBON}` }).click();
    await page.getByRole('menuitem', { name: 'Open to the side' }).click();
    await expect(lab.toast('Four chats are on screen. Close one first.')).toBeVisible();
    await expect(lab.page.getByRole('button', { name: 'Close pane' })).toHaveCount(4);
  });

  test('the tab menu can swap a visible chat with the active pane using only the keyboard', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    const right = await box(pane(lab, LISBON));
    await tab(lab, CACHE).focus();
    await page.keyboard.press('Shift+F10');
    const swap = page.getByRole('menuitem', { name: 'Swap with active pane' });
    await swap.focus();
    await page.keyboard.press('Enter');

    await expect(tab(lab, CACHE)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await box(pane(lab, CACHE))).x).toBe(right.x);
    await expect(pane(lab, LISBON)).toBeVisible();
  });

  test('focusing the other pane selects its tab', async ({ lab }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    await expect(tab(lab, LISBON)).toHaveAttribute('aria-selected', 'true');

    await pane(lab, CACHE).getByRole('heading', { level: 1, name: CACHE }).click();
    await expect(tab(lab, CACHE)).toHaveAttribute('aria-selected', 'true');
    await expect(tab(lab, LISBON)).toHaveAttribute('aria-selected', 'false');
    // The mark of a chat that is on screen but not selected is drawn on the tab's wrapper.
    await expect(tab(lab, LISBON).locator('..')).toHaveAttribute('data-shown', '');
  });

  test('F6 moves to the next pane', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    await expect(tab(lab, LISBON)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('F6');
    await expect(tab(lab, CACHE)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+F6');
    await expect(tab(lab, LISBON)).toHaveAttribute('aria-selected', 'true');
  });

  test('the splitter moves with the arrow keys and resets with Home', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    const splitter = page.getByRole('separator', { name: 'Resize panes side by side' });
    await expect(splitter).toHaveAttribute('aria-valuenow', '50');
    await splitter.focus();
    for (let step = 0; step < 5; step += 1) await page.keyboard.press('ArrowRight');
    await expect(splitter).toHaveAttribute('aria-valuenow', '60');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(splitter).toHaveAttribute('aria-valuenow', '50');
    for (let step = 0; step < 6; step += 1) await page.keyboard.press('Shift+ArrowRight');
    await expect(splitter).toHaveAttribute('aria-valuenow', '80');
    await page.keyboard.press('Home');
    await expect(splitter).toHaveAttribute('aria-valuenow', '50');
  });

  test('the splitter sits between its panes in the tab order', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    const splitter = page.getByRole('separator', { name: 'Resize panes side by side' });
    const holdsFocus = (title: string) => pane(lab, title).evaluate((element) => element.contains(document.activeElement));

    await splitter.focus();
    await page.keyboard.press('Shift+Tab');
    expect(await holdsFocus(CACHE)).toBe(true);
    await splitter.focus();
    await page.keyboard.press('Tab');
    expect(await holdsFocus(LISBON)).toBe(true);
  });

  test('dragging the splitter resizes both panes and it stays on their seam', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    const splitter = page.getByRole('separator', { name: 'Resize panes side by side' });
    const left = await box(pane(lab, CACHE));
    const right = await box(pane(lab, LISBON));
    const bar = await box(splitter);
    expect(Math.abs(left.width - right.width)).toBeLessThan(3);

    const y = bar.y + bar.height / 2;
    await page.mouse.move(bar.x + bar.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(left.x + (left.width + right.width) * 0.3, y, { steps: 5 });
    await page.mouse.up();
    await expect(splitter).toHaveAttribute('aria-valuenow', '30');

    const narrow = await box(pane(lab, CACHE));
    const wide = await box(pane(lab, LISBON));
    expect(narrow.width / (narrow.width + wide.width)).toBeCloseTo(0.3, 1);
    expect(Math.abs((await box(splitter)).x - (narrow.x + narrow.width))).toBeLessThan(3);
  });

  test('closing a pane keeps its tab', async ({ lab }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await openFromTab(lab, LISBON, 'Open to the right');
    await pane(lab, CACHE).getByRole('button', { name: 'Close pane' }).click();
    await expect(pane(lab, CACHE)).toHaveCount(0);
    await expect(pane(lab, LISBON)).toBeVisible();
    await expect(tab(lab, CACHE)).toBeVisible();
    await expect(lab.page.getByRole('button', { name: 'Close pane' })).toHaveCount(0);
  });
});

test.describe('sidebar', () => {
  test('a visible project action opens a new draft in that project', async ({ lab, page }) => {
    await lab.open();
    await page.mouse.move(700, 200);
    const create = lab.sidebar.getByRole('button', { name: 'New chat in video-studio', exact: true });
    await expect(create).toBeVisible();
    expect(await create.evaluate((element) => element.checkVisibility({ opacityProperty: true }))).toBe(true);
    await create.focus();
    await page.keyboard.press('Enter');
    await expect(lab.main.getByRole('button', { name: 'Project and permissions: video-studio', exact: true })).toBeVisible();
    await expect(lab.main.getByRole('textbox', { name: 'Message' })).toBeFocused();
  });

  test('Hide sidebar and Ctrl+B hide and restore it, and the choice survives a reload', async ({ lab, page }) => {
    await lab.open();
    await lab.sidebar.getByRole('button', { name: 'Hide sidebar' }).click();
    await expect(lab.sidebar).toBeHidden();
    await expect(lab.rail.getByRole('button', { name: 'Show sidebar' })).toBeVisible();

    await page.reload();
    await expect(lab.main).toBeVisible();
    await expect(lab.sidebar).toBeHidden();

    await lab.rail.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(lab.sidebar).toBeVisible();

    await page.keyboard.press('ControlOrMeta+b');
    await expect(lab.sidebar).toBeHidden();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(lab.sidebar).toBeVisible();
    await expect(lab.rail.getByRole('button', { name: 'Show sidebar' })).toHaveCount(0);
  });

  test('the panes stay usable without the sidebar', async ({ lab, page }) => {
    await lab.open();
    await openChats(lab, [LISBON, CACHE]);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(lab.sidebar).toBeHidden();
    await openFromTab(lab, LISBON, 'Open to the right');
    await expect(pane(lab, LISBON)).toBeVisible();
    await expect(pane(lab, CACHE)).toBeVisible();
  });

  test('focus follows the sidebar toggle without stealing the caret', async ({ lab, page }) => {
    await lab.open();
    await lab.sidebar.getByRole('button', { name: 'Hide sidebar' }).click();
    await lab.rail.getByRole('button', { name: 'Show sidebar' }).focus();
    await page.keyboard.press('Enter');
    await expect(lab.sidebar.getByRole('button', { name: 'Hide sidebar' })).toBeFocused();

    await lab.chat(LISBON).click();
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    await composer.focus();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(lab.sidebar).toBeHidden();
    await expect(composer).toBeFocused();
  });
});
