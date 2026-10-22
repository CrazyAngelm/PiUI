import { expect, test } from './fixtures';

test.describe('sub-pipelines', () => {
  test('add a sub-pipeline step, map its input, run it and open the child run', async ({ lab, page }) => {
    test.slow(); // Native turns of the child run are simulated with real timers.
    await lab.open();
    const editor = await lab.openPipelines();
    await editor.getByRole('button', { name: /^Review loop/ }).click();
    const canvas = editor.getByRole('application');
    await expect(canvas.getByRole('group', { name: 'Developer', exact: true })).toBeVisible();
    await editor.getByRole('textbox', { name: 'Pipeline name' }).fill('Ship with checks');

    // Add → Sub-pipelines lists the project's saved pipelines.
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Release check', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: 'Node settings' });
    await expect(inspector.getByRole('textbox', { name: 'Name' })).toHaveValue('Release check');
    await expect(inspector.getByRole('tablist', { name: 'Node settings' }).getByRole('tab')).toHaveText(['Sub-pipeline', 'Output', 'Flow']);
    const card = canvas.getByRole('group', { name: 'Release check', exact: true });
    await expect(card).toContainText('Pipeline');
    await expect(card.getByRole('button', { name: 'Open pipeline Release check' })).toBeVisible();

    // Map the child's input to a fixed value.
    await expect(inspector.getByRole('heading', { name: 'Inputs of Release check' })).toBeVisible();
    await inspector.getByRole('combobox', { name: 'Value from' }).selectOption('value');
    await inspector.getByRole('textbox', { name: 'Fixed value for Changes since' }).fill('last Friday');
    await expect(inspector).toContainText('This pipeline declares no outputs');
    await inspector.getByRole('button', { name: 'Close' }).click();

    // The Output block edits what this pipeline returns as a sub-pipeline.
    await canvas.getByRole('group', { name: 'Output', exact: true }).click();
    const output = page.getByRole('complementary', { name: 'Output', exact: true });
    await expect(output).toContainText('No declared outputs');
    await output.getByRole('button', { name: 'Close output settings' }).click();

    await editor.getByRole('button', { name: 'Run', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Run Ship with checks' });
    await dialog.getByRole('textbox').first().fill('Cover the cancellation path with a test.');
    await dialog.getByRole('button', { name: 'Start run' }).click();
    await expect(dialog).toBeHidden();

    // The sub-pipeline step runs as a child run.
    const run = page.getByRole('region', { name: 'Run' });
    const step = run.getByRole('application').getByRole('group', { name: 'Release check', exact: true });
    await expect(step).toContainText('Sub-pipeline');
    await step.click();
    const panel = page.getByRole('complementary', { name: /Release check/ });
    await panel.getByRole('button', { name: 'Open child run' }).click();

    await expect(run.getByRole('heading', { level: 2, name: 'Release check' })).toBeVisible();
    await expect(run).toContainText('Sub-pipeline of run');
    await expect(run.getByRole('button', { name: /^Open parent run / })).toBeVisible();
    await expect(run).toContainText('Succeeded', { timeout: 60_000 });
    await run.getByRole('button', { name: /^Open parent run / }).click();
    await expect(run.getByRole('heading', { level: 2, name: 'Ship with checks' })).toBeVisible();
  });
});
