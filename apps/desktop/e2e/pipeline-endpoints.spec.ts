import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/** The place and size of a card in flow units, read from its wrapper (independent of zoom and pan). */
const rect = (card: Locator) =>
  card.evaluate((element) => {
    const node = element as HTMLElement;
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(node.style.transform);
    return { x: Math.round(Number(match?.[1])), y: Math.round(Number(match?.[2])), w: node.offsetWidth, h: node.offsetHeight };
  });
const place = async (card: Locator) => {
  const { x, y } = await rect(card);
  return { x, y };
};
type Rect = Awaited<ReturnType<typeof rect>>;
const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function dragBy(page: Page, card: Locator, dx: number, dy: number): Promise<void> {
  const box = await card.boundingBox();
  if (!box) throw new Error('The card is not on the canvas.');
  const from = { x: box.x + box.width / 2, y: box.y + 10 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 6 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
}

/** Clicks empty canvas: clears the selection and closes the inspector. */
async function clickCanvas(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('There is no canvas.');
  await page.mouse.click(box.x + box.width / 2, box.y + 95);
}

/** Shift-drags a frame around two cards, from the empty canvas beside and below them: a marquee selection. */
async function marquee(page: Page, first: Locator, second: Locator): Promise<void> {
  const [a, b] = [await first.boundingBox(), await second.boundingBox()];
  if (!a || !b) throw new Error('The cards are not on the canvas.');
  const from = { x: Math.max(a.x + a.width, b.x + b.width) + 10, y: Math.max(a.y + a.height, b.y + b.height) + 30 };
  const to = { x: Math.min(a.x, b.x) - 10, y: Math.min(a.y, b.y) - 30 };
  await page.keyboard.down('Shift');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
}

async function openTemplate(lab: Lab, template: string) {
  await lab.open();
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: new RegExp(`^${template}`) }).click();
  const canvas = editor.getByRole('application');
  const card = (name: string) => canvas.getByRole('group', { name, exact: true });
  return { editor, canvas, card };
}

test.describe('Start and Output blocks', () => {
  test('move like steps, stay put when steps move, and keep their place after save and reopen', async ({ lab, page }) => {
    const { editor, canvas, card } = await openTemplate(lab, 'Chain');
    const [start, output, planner] = [card('Start'), card('Output'), card('Planner')];
    await expect(start).toHaveClass(/(?:^|\s)draggable(?:\s|$)/);
    await expect(output).toHaveClass(/(?:^|\s)draggable(?:\s|$)/);
    const original = { start: await place(start), output: await place(output), planner: await place(planner) };

    await dragBy(page, start, 80, 120);
    await expect.poll(() => place(start)).not.toEqual(original.start);
    // A dragged block opens its inspector over the right of the canvas, which would cover Output.
    await clickCanvas(page, canvas);
    await dragBy(page, output, -60, 90);
    await expect.poll(() => place(output)).not.toEqual(original.output);
    const moved = { start: await place(start), output: await place(output) };

    // A step moving, being added or being connected never drags a block along.
    await dragBy(page, planner, 0, 150);
    await expect.poll(() => place(planner)).not.toEqual(original.planner);
    const movedPlanner = await place(planner);
    expect(await place(start)).toEqual(moved.start);
    expect(await place(output)).toEqual(moved.output);

    const undo = editor.getByRole('button', { name: 'Undo', exact: true });
    const redo = editor.getByRole('button', { name: 'Redo', exact: true });
    for (let step = 0; step < 3; step += 1) await undo.click();
    await expect.poll(() => place(start)).toEqual(original.start);
    await expect.poll(() => place(output)).toEqual(original.output);
    await expect.poll(() => place(planner)).toEqual(original.planner);
    for (let step = 0; step < 3; step += 1) await redo.click();
    await expect.poll(() => place(start)).toEqual(moved.start);
    await expect.poll(() => place(output)).toEqual(moved.output);
    await expect.poll(() => place(planner)).toEqual(movedPlanner);

    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(lab.toast('Pipeline saved')).toBeVisible();
    await lab.openRuns();
    await lab.openPipelines();
    await expect.poll(() => place(start)).toEqual(moved.start);
    await expect.poll(() => place(output)).toEqual(moved.output);
    await expect.poll(() => place(planner)).toEqual(movedPlanner);
    await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  });

  test('arrow keys move a selected block or step and the move is kept', async ({ lab, page }) => {
    const { canvas, card } = await openTemplate(lab, 'Chain');
    const output = card('Output');
    const builder = card('Builder');
    const outputBefore = await place(output);
    const builderBefore = await place(builder);

    await output.click();
    await output.focus();
    for (let press = 0; press < 5; press += 1) await page.keyboard.press('ArrowDown');
    // Svelte Flow moves a card by the 8 unit grid per press.
    await expect.poll(async () => (await place(output)).y - outputBefore.y).toBeGreaterThanOrEqual(32);
    const outputMoved = await place(output);
    await clickCanvas(page, canvas);
    await expect(page.getByRole('complementary', { name: 'Output', exact: true })).toBeHidden();
    expect(await place(output)).toEqual(outputMoved);

    await builder.click();
    await builder.focus();
    for (let press = 0; press < 5; press += 1) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await place(builder)).x - builderBefore.x).toBeGreaterThanOrEqual(32);
    const builderMoved = await place(builder);
    await clickCanvas(page, canvas);
    await expect(page.getByRole('complementary', { name: 'Node settings' })).toBeHidden();
    expect(await place(builder)).toEqual(builderMoved);

    // Every press is its own undo step; extra presses do nothing once the template is reached.
    for (let step = 0; step < 12; step += 1) await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => place(output)).toEqual(outputBefore);
    await expect.poll(() => place(builder)).toEqual(builderBefore);
  });

  test('a marquee selection moves with the arrow keys, is kept after a refresh of the canvas and undone in one step', async ({ lab, page }) => {
    const { editor, canvas, card } = await openTemplate(lab, 'Chain');
    const [planner, builder, reviewer] = [card('Planner'), card('Builder'), card('Reviewer')];
    const before = { planner: await place(planner), builder: await place(builder), reviewer: await place(reviewer) };
    const undo = editor.getByRole('button', { name: 'Undo', exact: true });

    await marquee(page, planner, builder);
    await expect(planner).toHaveClass(/(?:^|\s)selected(?:\s|$)/);
    await expect(builder).toHaveClass(/(?:^|\s)selected(?:\s|$)/);
    // Focus sits on the selection frame, not on a card.
    const frame = canvas.locator('.svelte-flow__selection-wrapper');
    await expect(frame).toBeVisible();
    await frame.focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await place(planner)).y - before.planner.y).toBeGreaterThan(0);
    const moved = { planner: await place(planner), builder: await place(builder) };
    expect(moved.builder.y - before.builder.y).toBe(moved.planner.y - before.planner.y);
    expect(await place(reviewer)).toEqual(before.reviewer);
    await expect(undo).toBeEnabled();

    // Selecting a block redraws every card from the graph: the move must be in the graph.
    await card('Start').click();
    await expect(page.getByRole('complementary', { name: 'Start', exact: true })).toBeVisible();
    expect(await place(planner)).toEqual(moved.planner);
    expect(await place(builder)).toEqual(moved.builder);

    await undo.click();
    await expect.poll(() => place(planner)).toEqual(before.planner);
    await expect.poll(() => place(builder)).toEqual(before.builder);
    await expect(undo).toBeDisabled();
  });

  test('a wire to Start explains the rule and changes nothing', async ({ lab }) => {
    const { editor, canvas, card } = await openTemplate(lab, 'Chain');
    const start = card('Start');
    const wires = canvas.locator('.svelte-flow__edge');
    const count = await wires.count();
    const before = { start: await place(start), builder: await place(card('Builder')) };

    await card('Builder').locator('[data-handleid="in"]').dragTo(start.locator('[data-handleid="out"]'));
    await expect(lab.toast(/Builder waits for the steps connected to it\./).first()).toBeVisible();
    await start.locator('[data-handleid="out"]').dragTo(card('Planner').locator('[data-handleid="in"]'));
    await expect(lab.toast(/Planner has nothing before it/).first()).toBeVisible();

    await expect(wires).toHaveCount(count);
    expect(await place(start)).toEqual(before.start);
    expect(await place(card('Builder'))).toEqual(before.builder);
    await expect(editor.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

  test('clicking an automatic wire selects its block, so Delete cannot remove a step', async ({ lab, page }) => {
    const { canvas, card } = await openTemplate(lab, 'Chain');
    const builder = card('Builder');

    await builder.click();
    await expect(page.getByRole('complementary', { name: 'Node settings' })).toBeVisible();
    await canvas.getByRole('group', { name: /^Connection from Start to / }).first().locator('path').first().dispatchEvent('click');
    await expect(page.getByRole('complementary', { name: 'Start', exact: true })).toBeVisible();
    await page.keyboard.press('Delete');
    await expect(builder).toBeAttached();
    await expect(lab.toast('Start and Output stay in every pipeline').first()).toBeVisible();
    await expect(canvas.getByRole('group', { name: /^Result connection from Planner to Builder/ })).toBeAttached();

    await builder.click();
    await canvas.getByRole('group', { name: /^Completion connection from / }).first().locator('path').first().dispatchEvent('click');
    await expect(page.getByRole('complementary', { name: 'Output', exact: true })).toBeVisible();
    await page.keyboard.press('Delete');
    await expect(builder).toBeAttached();
    await expect(lab.toast('Start and Output stay in every pipeline').last()).toBeVisible();
  });

  test('clicking an automatic wire after a marquee selection replaces the selection, so Delete cannot remove steps', async ({ lab, page }) => {
    const { canvas, card } = await openTemplate(lab, 'Chain');
    const [planner, builder] = [card('Planner'), card('Builder')];

    await marquee(page, planner, builder);
    await expect(planner).toHaveClass(/(?:^|\s)selected(?:\s|$)/);
    await expect(builder).toHaveClass(/(?:^|\s)selected(?:\s|$)/);
    await canvas.getByRole('group', { name: /^Connection from Start to / }).first().locator('path').first().dispatchEvent('click');
    await expect(page.getByRole('complementary', { name: 'Start', exact: true })).toBeVisible();
    await expect(canvas.locator('.svelte-flow__node.selected')).toHaveCount(1);
    await expect(planner).not.toHaveClass(/(?:^|\s)selected(?:\s|$)/);
    await expect(builder).not.toHaveClass(/(?:^|\s)selected(?:\s|$)/);
    await expect(canvas.locator('.svelte-flow__selection-wrapper')).toHaveCount(0);
    await page.keyboard.press('Delete');
    await expect(planner).toBeAttached();
    await expect(builder).toBeAttached();
    await expect(lab.toast('Start and Output stay in every pipeline').first()).toBeVisible();

    // Same for a completion wire after the frame is drawn again.
    await marquee(page, planner, builder);
    await canvas.getByRole('group', { name: /^Completion connection from / }).first().locator('path').first().dispatchEvent('click');
    await expect(page.getByRole('complementary', { name: 'Output', exact: true })).toBeVisible();
    await expect(canvas.locator('.svelte-flow__node.selected')).toHaveCount(1);
    await page.keyboard.press('Delete');
    await expect(planner).toBeAttached();
    await expect(builder).toBeAttached();
  });

  test('automatic wires are not Tab stops, so a stale selection cannot be deleted from them', async ({ lab }) => {
    const { canvas } = await openTemplate(lab, 'Chain');
    const automatic = canvas.getByRole('group', { name: /^(Connection from Start to |Completion connection from )/ });
    expect(await automatic.count()).toBeGreaterThan(1);
    expect(await automatic.evaluateAll((wires) => wires.filter((wire) => wire.hasAttribute('tabindex')).length)).toBe(0);
    // A wire the person made is still a keyboard stop.
    await expect(canvas.getByRole('group', { name: /^Result connection from Planner to Builder/ })).toHaveAttribute('tabindex', '0');
  });

  test('a declared Output wire is deleted like any wire and final steps keep their completion wire', async ({ lab, page }) => {
    const { canvas, card } = await openTemplate(lab, 'Chain');
    const output = card('Output');
    const result = canvas.getByRole('group', { name: 'Result connection from Planner to Output' });
    const completion = canvas.getByRole('group', { name: 'Completion connection from Reviewer to Output' });
    await expect(completion).toBeAttached();

    await card('Planner').locator('[data-handleid="out"]').dragTo(output.getByRole('button', { name: 'Connect to Output' }));
    const settings = page.getByRole('complementary', { name: 'Output', exact: true });
    await expect(settings).toBeVisible();
    await expect(result).toBeAttached();
    // Declaring an output never takes the completion wire of another final step away.
    await expect(completion).toBeAttached();
    await settings.getByRole('button', { name: 'Close output settings' }).click();

    await result.locator('path').first().dispatchEvent('click');
    await page.keyboard.press('Delete');
    await expect(result).toHaveCount(0);
    await expect(completion).toBeAttached();
    await expect(output).toContainText('Pipeline end');

    await page.keyboard.press('ControlOrMeta+z');
    await expect(result).toBeAttached();
    await expect(completion).toBeAttached();
  });

  test('Arrange puts Start and Output beside the steps, never on top of them', async ({ lab, page }) => {
    const { editor, card } = await openTemplate(lab, 'Orchestrator and helpers');
    const [start, output] = [card('Start'), card('Output')];
    const steps = ['Orchestrator', 'Worker', 'Tester'].map((name) => card(name));
    const crowded = async () => {
      const block = await rect(output);
      return (await Promise.all(steps.map(rect))).some((step) => intersects(block, step));
    };
    expect(await crowded()).toBe(false);

    const [from, to] = [await output.boundingBox(), await steps[1].boundingBox()];
    if (!from || !to) throw new Error('The cards are not on the canvas.');
    await dragBy(page, output, to.x - from.x, to.y - from.y);
    await expect.poll(crowded).toBe(true);

    await editor.getByRole('button', { name: 'Arrange automatically' }).click();
    await expect.poll(crowded).toBe(false);
    const startRect = await rect(start);
    for (const step of await Promise.all(steps.map(rect))) {
      expect(startRect.x + startRect.w).toBeLessThan(step.x);
      expect(step.x + step.w).toBeLessThan((await rect(output)).x);
    }
  });

  test('new steps never land on another step or block', async ({ lab, page }) => {
    const { editor, canvas } = await openTemplate(lab, 'Chain');
    const agents = canvas.locator('.svelte-flow__node-agent');
    await expect(agents).toHaveCount(3);
    for (let added = 1; added <= 3; added += 1) {
      await editor.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Agent', exact: true }).click();
      await expect(agents).toHaveCount(3 + added);
    }
    const cards = await Promise.all((await canvas.locator('.svelte-flow__node').all()).map(rect));
    expect(cards).toHaveLength(8);
    for (const [index, card] of cards.entries()) {
      for (const other of cards.slice(index + 1)) expect(intersects(card, other)).toBe(false);
    }
  });

  test('a step left of the origin keeps its place after reopening and exports', async ({ lab, page }) => {
    const { editor, card } = await openTemplate(lab, 'Chain');
    const planner = card('Planner');
    await dragBy(page, planner, -420, -120);
    await expect.poll(async () => (await place(planner)).x).toBeLessThan(0);
    const moved = await place(planner);

    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(lab.toast('Pipeline saved')).toBeVisible();
    await lab.openRuns();
    await lab.openPipelines();
    await expect.poll(() => place(planner)).toEqual(moved);

    const download = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'More pipeline actions' }).click();
    await page.getByRole('menuitem', { name: 'Export JSON' }).click();
    expect((await download).suggestedFilename()).toBe('Chain.piui.json');
    await expect(lab.toast('Could not export')).toHaveCount(0);
  });

  test('Tab moves through the canvas and opens Add only from the empty canvas', async ({ lab, page }) => {
    const { editor, canvas, card } = await openTemplate(lab, 'Chain');
    const menu = page.getByRole('menu').filter({ hasText: 'Add to canvas' });
    const start = card('Start');

    await start.focus();
    await expect(start).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(start).not.toBeFocused();

    await editor.getByRole('button', { name: 'Add', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(menu).toHaveCount(0);

    await clickCanvas(page, canvas);
    await page.keyboard.press('Tab');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('Tab is not swallowed in safe mode', async ({ lab, page }) => {
    await lab.open('safe');
    const editor = await lab.openPipelines();
    await editor.getByRole('button', { name: 'Release check', exact: true }).click();
    const canvas = editor.getByRole('application');
    await clickCanvas(page, canvas);
    expect(await page.evaluate(() => document.activeElement?.localName)).toMatch(/^(body|main)$/);
    await page.evaluate(() => {
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') Reflect.set(window, 'piuiTabPrevented', event.defaultPrevented);
      });
    });
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Reflect.get(window, 'piuiTabPrevented'))).toBe(false);
    await expect(page.getByRole('menu').filter({ hasText: 'Add to canvas' })).toHaveCount(0);
  });

  test('safe mode keeps Start and Output fixed', async ({ lab }) => {
    await lab.open('safe');
    const editor = await lab.openPipelines();
    await editor.getByRole('button', { name: 'Release check', exact: true }).click();
    const canvas = editor.getByRole('application');
    for (const name of ['Start', 'Output']) {
      await expect(canvas.getByRole('group', { name, exact: true })).not.toHaveClass(/(?:^|\s)draggable(?:\s|$)/);
    }
    await expect(canvas.getByRole('group', { name: 'Start', exact: true }).locator('[data-handleid="out"]')).not.toHaveClass(/(?:^|\s)connectable(?:\s|$)/);
    await expect(canvas.getByRole('group', { name: 'Output', exact: true }).locator('[data-handleid="in"]')).not.toHaveClass(/(?:^|\s)connectable(?:\s|$)/);
  });
});
