import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

async function add(lab: Lab, editor: Locator, kind: 'Agent' | 'Router' | 'Model call' | 'Script'): Promise<Locator> {
  await editor.getByRole('button', { name: 'Add', exact: true }).click();
  await lab.page.getByRole('menuitem', { name: kind, exact: true }).click();
  const inspector = lab.page.getByRole('complementary', { name: 'Node settings' });
  await expect(inspector).toBeVisible();
  return inspector;
}

function tabs(inspector: Locator): Locator {
  return inspector.getByRole('tablist', { name: 'Node settings' }).getByRole('tab');
}

async function checkButton(page: Page): Promise<Locator> {
  return page.getByRole('region', { name: 'Pipeline editor' }).getByRole('button', { name: /^(Check|Checked|\d+ problems)$/ });
}

test.describe('pipeline editor', () => {
  test('a model call node: read-only model settings and its own tabs', async ({ lab, page }) => {
    await lab.open();
    const editor = await lab.openPipelines();
    const inspector = await add(lab, editor, 'Model call');
    await expect(inspector.getByRole('textbox', { name: 'Name' })).toHaveValue('Model call 1');
    await expect(tabs(inspector)).toHaveText(['Basics', 'Input & output', 'Flow']);
    await expect(inspector.getByText('Prompt', { exact: true })).toBeVisible();
    await expect(inspector.getByText('Answers once inside this installed tool, read-only and without tools.')).toBeVisible();
    const canvas = editor.getByRole('application');
    await expect(canvas.getByRole('group', { name: 'Model call 1', exact: true })).toContainText('Model call');

    await inspector.getByRole('tab', { name: 'Input & output' }).click();
    await expect(inspector.getByRole('heading', { name: 'Structured result fields' })).toBeVisible();
    await inspector.getByRole('tab', { name: 'Flow' }).click();
    await expect(inspector.getByRole('switch', { name: 'A person approves the result' })).toBeVisible();
    // A model call has no Access tab: it never gets tools or write access.
    await expect(inspector.getByRole('tab', { name: 'Access' })).toHaveCount(0);
  });

  test('a script node: sandbox warning, Insert example and validation', async ({ lab, page }) => {
    await lab.open();
    const editor = await lab.openPipelines();
    await editor.getByRole('textbox', { name: 'Pipeline name' }).fill('Release check');
    await add(lab, editor, 'Model call');
    const inspector = await add(lab, editor, 'Script');
    await expect(inspector.getByRole('textbox', { name: 'Name' })).toHaveValue('Script 2');
    await expect(tabs(inspector)).toHaveText(['Script', 'Output', 'Flow']);
    await expect(inspector.getByRole('note')).toContainText('It is not a sandbox');
    await expect(inspector.getByRole('group', { name: 'Runtime' }).getByRole('radio', { name: 'Node.js' })).toBeChecked();

    // An empty script is a graph problem.
    await (await checkButton(page)).click();
    await expect(inspector.getByRole('listitem').filter({ hasText: 'A script needs source code of at most 64 KiB.' })).toBeVisible();

    const code = inspector.getByRole('textbox', { name: 'Code' });
    await expect(code).toHaveValue('');
    await inspector.getByRole('button', { name: 'Insert example' }).click();
    await expect(code).toHaveValue(/process\.stdin/);
    await expect(inspector.getByRole('button', { name: 'Insert example' })).toHaveCount(0);
    await expect(editor.getByRole('application').getByRole('group', { name: 'Script 2', exact: true })).toContainText("let raw = '';");

    // Python gets its own example once the code is cleared.
    await inspector.getByRole('group', { name: 'Runtime' }).getByRole('radio', { name: 'Python' }).click();
    await code.fill('');
    await inspector.getByRole('button', { name: 'Insert example' }).click();
    await expect(code).toHaveValue(/json\.load\(sys\.stdin\)/);

    // An out-of-range time limit is refused next to the field and not saved.
    const limit = inspector.getByRole('textbox', { name: 'Time limit, seconds' });
    await limit.fill('0');
    await expect(inspector.getByText('A script timeout must be a whole number of seconds from 1 to 3600.')).toBeVisible();
    await limit.fill('90');
    await expect(inspector.getByText('A script timeout must be a whole number of seconds from 1 to 3600.')).toHaveCount(0);

    await inspector.getByRole('tab', { name: 'Output' }).click();
    await expect(inspector.getByRole('heading', { name: 'Structured result fields' })).toBeVisible();
    await inspector.getByRole('tab', { name: 'Script' }).click();
    await expect(inspector.getByRole('note')).toContainText('review the code before running it');

    await (await checkButton(page)).click();
    await expect(editor.getByText('Checked')).toBeVisible();
  });
});
