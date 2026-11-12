import { expect, test } from './fixtures';

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
  await expect(outputPort).toHaveClass(/connectable/);
  await port.dragTo(outputPort);

  const settings = page.getByRole('complementary', { name: 'Output', exact: true });
  await expect(settings.getByRole('textbox', { name: 'Output name' })).toHaveValue('result');
  await expect(settings.getByRole('combobox', { name: 'Value', exact: true })).toHaveValue('');
  await expect(settings.getByRole('combobox', { name: 'From step' }).locator('option:checked')).toHaveText(sourceName!);
  const wire = canvas.getByRole('group', { name: `Result connection from ${sourceName} to Output` });
  await expect(wire).toBeAttached();

  await editor.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(wire).toHaveCount(0);
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
  await expect(canvas.getByRole('group', { name: 'Output', exact: true })).toContainText('No declared outputs');
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});
