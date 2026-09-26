import { expect, test } from './fixtures';

test.describe('run a pipeline from a chat', () => {
  test('/run asks for the inputs, starts the run and opens it from the toast', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Route host calls through one transport/).click();
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill('/run');
    const commands = page.getByRole('listbox', { name: 'Available commands' });
    await expect(commands.getByRole('option', { name: /^\/run/ })).toHaveAttribute('aria-selected', 'true');
    await message.press('Enter');

    const picker = page.getByRole('dialog', { name: 'Run a pipeline' });
    await expect(picker).toContainText('Starts a saved pipeline of piui.');
    const pipelines = picker.getByRole('radiogroup', { name: 'Saved pipelines' });
    await expect(pipelines.getByRole('radio', { name: 'Code review' })).toBeChecked();
    await expect(pipelines.getByRole('radio', { name: 'Release check' })).toBeVisible();
    // Nothing is sent to the chat.
    await expect(message).toHaveValue('');
    await picker.getByRole('button', { name: 'Next…' }).click();

    const inputs = page.getByRole('dialog', { name: 'Run Code review' });
    await inputs.getByRole('button', { name: 'Start run' }).click();
    const task = inputs.getByRole('textbox', { name: 'What should be reviewed?' });
    await expect(task).toHaveAttribute('aria-invalid', 'true');
    await task.fill('Review the transport cancellation test.');
    await inputs.getByRole('button', { name: 'Start run' }).click();
    await expect(inputs).toBeHidden();

    const toast = lab.toast('Run started: Code review');
    await expect(toast).toContainText('Follow it in Runs. This chat is not changed.');
    await toast.getByRole('button', { name: 'Open run' }).click();
    const run = page.getByRole('region', { name: 'Run' });
    await expect(run.getByRole('heading', { level: 2, name: 'Code review' })).toBeVisible();
    await expect(run).toContainText('Started from a chat');
    await expect(run.getByRole('application').getByRole('group', { name: 'Planner', exact: true })).toBeVisible();
  });

  test('Ctrl+K "Run pipeline…" starts a pipeline with its default inputs', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Route host calls through one transport/).click();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    await palette.getByPlaceholder('Search chats, projects and commands…').fill('run pipeline');
    await palette.getByRole('option', { name: 'Run pipeline…' }).click();
    const picker = page.getByRole('dialog', { name: 'Run a pipeline' });
    await picker.getByRole('radiogroup', { name: 'Saved pipelines' }).getByRole('radio', { name: 'Release check' }).check();
    // Release check asks for one input that has a default value.
    await expect(picker).toContainText('This pipeline asks for inputs on the next step.');
    await picker.getByRole('button', { name: 'Next…' }).click();
    const inputs = page.getByRole('dialog', { name: 'Run Release check' });
    await expect(inputs.getByRole('textbox', { name: /^Changes since/ })).toHaveValue('the last release');
    await inputs.getByRole('button', { name: 'Start run' }).click();
    await expect(lab.toast('Run started: Release check')).toBeVisible();
  });

  test('a project without saved pipelines explains what to do and starts nothing', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Explain Rust lifetimes/).click();
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill('/run');
    await message.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Run a pipeline' });
    await expect(picker).toContainText('This project has no saved pipelines yet. Build one in Pipelines first.');
    await expect(picker.getByRole('button', { name: 'Start run' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(message).toBeFocused();
  });
});
