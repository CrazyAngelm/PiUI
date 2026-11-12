import { expect, test } from './fixtures';

for (const [template, finalSteps] of [
  ['Chain', ['Reviewer']],
  ['Parallel research', ['Synthesis']],
  ['Orchestrator and helpers', ['Orchestrator']],
  ['Review loop', ['Reviewer']],
  ['Classify and route', ['Bug fixer', 'Feature builder']],
] as const) {
  test(`${template} connects final steps to Output automatically and preserves them after reopening`, async ({ lab, page }) => {
    await lab.open();
    const editor = await lab.openPipelines();
    await editor.getByRole('button', { name: new RegExp(`^${template}`) }).click();
    const canvas = editor.getByRole('application');
    const output = canvas.getByRole('group', { name: 'Output', exact: true });
    await expect(output).toContainText('Pipeline end');
    await expect(output.getByRole('button', { name: 'Connect to Output' })).toHaveClass(/port--wired/);
    const wires = canvas.getByRole('group', { name: /^Completion connection from / });
    await expect(wires).toHaveCount(finalSteps.length);
    for (const step of finalSteps) {
      await expect(canvas.getByRole('group', { name: `Completion connection from ${step} to Output` })).toBeAttached();
      await expect(canvas.getByRole('group', { name: step, exact: true }).locator('[data-handleid="out"]')).toHaveClass(/port--wired/);
    }
    await output.click();
    const settings = page.getByRole('complementary', { name: 'Output', exact: true });
    await expect(settings).toContainText('Final steps connect here automatically.');
    await expect(settings.getByRole('textbox', { name: 'Output name' })).toHaveCount(0);
    await wires.first().locator('path').first().dispatchEvent('click');
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Close output settings' }).click();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(lab.toast('Pipeline saved')).toBeVisible();
    await lab.openRuns();
    await lab.openPipelines();
    await expect(wires).toHaveCount(finalSteps.length);
    await expect(output).toContainText('Pipeline end');
    await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  });
}

test('an explicitly mapped router result keeps its wire and uses a non-connectable result anchor', async ({ lab, page }) => {
  await lab.open();
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: /^Classify and route/ }).click();
  const canvas = editor.getByRole('application');
  await canvas.getByRole('group', { name: 'Output', exact: true }).click();
  const settings = page.getByRole('complementary', { name: 'Output', exact: true });
  await settings.getByRole('button', { name: 'Add output' }).click();
  await settings.getByRole('combobox', { name: 'From step' }).selectOption({ label: 'Route by category' });
  const wire = canvas.getByRole('group', { name: 'Result connection from Route by category to Output' });
  await expect(wire.locator('path').first()).toHaveAttribute('d', /^M/);
  const anchor = canvas.getByRole('group', { name: 'Route by category', exact: true }).locator('[data-handleid="out"]');
  await expect(anchor).toHaveClass(/port--wired/);
  await expect(anchor).not.toHaveClass(/(?:^|\s)connectable(?:\s|$)/);
  await settings.getByRole('button', { name: 'Remove output result' }).click();
  await expect(anchor).toHaveCount(0);
  await expect(canvas.getByRole('group', { name: /^Completion connection from / })).toHaveCount(2);
});

test('wire a step to Output, undo, edit by keyboard, save and reopen', async ({ lab, page }) => {
  await lab.open();
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: 'Release check', exact: true }).click();
  const canvas = editor.getByRole('application');
  const outputNode = canvas.getByRole('group', { name: 'Output', exact: true });
  const source = canvas.locator('.svelte-flow__node-agent').last();
  const sourceName = await source.getAttribute('aria-label');
  const port = source.locator('[data-handleid="out"]');
  const outputPort = outputNode.getByRole('button', { name: 'Connect to Output' });
  const completion = canvas.getByRole('group', { name: `Completion connection from ${sourceName} to Output` });
  await expect(completion).toBeAttached();
  await expect(outputPort).toHaveClass(/connectable/);
  await port.dragTo(outputPort);

  const settings = page.getByRole('complementary', { name: 'Output', exact: true });
  await expect(settings.getByRole('textbox', { name: 'Output name' })).toHaveValue('result');
  await expect(settings.getByRole('combobox', { name: 'Value', exact: true })).toHaveValue('');
  await expect(settings.getByRole('combobox', { name: 'From step' }).locator('option:checked')).toHaveText(sourceName!);
  const wire = canvas.getByRole('group', { name: `Result connection from ${sourceName} to Output` });
  await expect(wire).toBeAttached();
  await expect(completion).toHaveCount(0);

  await editor.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(wire).toHaveCount(0);
  await expect(completion).toBeAttached();
  await editor.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(wire).toBeAttached();
  await outputNode.click();
  const name = settings.getByRole('textbox', { name: 'Output name' });
  await name.focus();
  await name.press('ControlOrMeta+A');
  await name.pressSequentially('finalResult');
  await name.press('Tab');
  await expect(name).toHaveValue('finalResult');
  await settings.getByRole('button', { name: 'Close output settings' }).click();

  // Connecting an already wired source is idempotent.
  await port.dragTo(outputPort);
  await expect(settings.getByRole('textbox', { name: 'Output name' })).toHaveCount(1);
  await settings.getByRole('button', { name: 'Close output settings' }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(lab.toast('Pipeline saved')).toBeVisible();
  await lab.openRuns();
  await lab.openPipelines();
  await expect(canvas.getByRole('group', { name: 'Output', exact: true })).toContainText('finalResult');
  await expect(wire).toBeAttached();
});

test('Output refuses a collaboration wire without changing its declarations', async ({ lab, page }) => {
  await lab.open();
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: 'Release check', exact: true }).click();
  const canvas = editor.getByRole('application');
  await editor.getByRole('radio', { name: 'Messages', exact: true }).click();
  await canvas.locator('.svelte-flow__node-agent').last().locator('[data-handleid="out"]').dragTo(
    canvas.getByRole('button', { name: 'Connect to Output' }),
  );
  await expect(lab.toast('Only result connections can connect to Output.')).toBeVisible();
  await expect(canvas.getByRole('group', { name: 'Output', exact: true })).toContainText('Pipeline end');
  await expect(canvas.getByRole('group', { name: /^Completion connection from / })).toHaveCount(1);
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('safe mode shows automatic completion without enabling output edits', async ({ lab, page }) => {
  await lab.open('safe');
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: 'Release check', exact: true }).click();
  const canvas = editor.getByRole('application');
  const output = canvas.getByRole('group', { name: 'Output', exact: true });
  await expect(output).toContainText('Pipeline end');
  await expect(canvas.getByRole('group', { name: /^Completion connection from / })).toHaveCount(1);
  await expect(output.getByRole('button', { name: 'Connect to Output' })).not.toHaveClass(/(?:^|\s)connectable(?:\s|$)/);
  await output.click();
  await expect(page.getByRole('complementary', { name: 'Output', exact: true }).getByRole('button', { name: 'Add output' })).toBeDisabled();
});
