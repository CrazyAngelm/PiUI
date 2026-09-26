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

  test('a script node: sandbox warning, code editor, Insert example and validation', async ({ lab, page }) => {
    await lab.open();
    const editor = await lab.openPipelines();
    await editor.getByRole('textbox', { name: 'Pipeline name' }).fill('Release check');
    await add(lab, editor, 'Model call');
    const inspector = await add(lab, editor, 'Script');
    await expect(inspector.getByRole('textbox', { name: 'Name' })).toHaveValue('Script 2');
    await expect(tabs(inspector)).toHaveText(['Script', 'Output', 'Flow']);
    await expect(inspector.getByRole('note')).toContainText('It is not a sandbox');
    await expect(inspector.getByRole('group', { name: 'Runtime' }).getByRole('radio', { name: 'Node.js' })).toBeChecked();
    const card = editor.getByRole('application').getByRole('group', { name: 'Script 2', exact: true });
    await expect(card).toContainText('No code yet');

    // An empty script is a graph problem.
    await (await checkButton(page)).click();
    await expect(inspector.getByRole('listitem').filter({ hasText: 'A script needs source code of at most 64 KiB.' })).toBeVisible();

    // The code field is a CodeMirror text box (in a shadow root).
    const code = inspector.getByRole('textbox', { name: 'Code' });
    await expect(code).toBeVisible();
    await inspector.getByRole('button', { name: 'Insert example' }).click();
    await expect(code).toContainText('process.stdin');
    await expect(inspector.getByRole('button', { name: 'Insert example' })).toHaveCount(0);
    await expect(card).toContainText("let raw = '';");

    // Keyboard: Tab indents inside the code; Escape, then Tab, leaves it.
    await code.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Tab');
    await expect(code).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await expect(code).not.toBeFocused();

    // Python gets its own example once the code is cleared.
    await inspector.getByRole('group', { name: 'Runtime' }).getByRole('radio', { name: 'Python' }).click();
    await code.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await expect(card).toContainText('No code yet');
    await inspector.getByRole('button', { name: 'Insert example' }).click();
    await expect(code).toContainText('json.load(sys.stdin)');

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

  test('Test script runs the code once and shows what a run would record', async ({ lab, page }) => {
    await lab.open();
    const editor = await lab.openPipelines();
    const inspector = await add(lab, editor, 'Script');
    const panel = inspector.getByRole('region', { name: 'Test script' });
    const test = panel.getByRole('button', { name: 'Test', exact: true });
    // Nothing to run yet.
    await expect(test).toBeDisabled();
    await expect(panel).toContainText('Add code of at most 64 KiB to test it.');

    await inspector.getByRole('button', { name: 'Insert example' }).click();
    const sample = panel.getByRole('textbox', { name: 'Sample input (stdin)' });
    await expect(sample).toHaveValue(/"inputs"/);
    // A sample that is not JSON cannot be sent.
    const original = await sample.inputValue();
    await sample.fill('{ not json');
    await expect(test).toBeDisabled();
    await expect(panel.getByRole('alert')).toBeVisible();
    await panel.getByRole('button', { name: 'Reset to default' }).click();
    await expect(sample).toHaveValue(original);

    await test.click();
    await expect(panel.getByRole('status').filter({ hasText: 'A run would succeed' })).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText('Exit code 0');
    const results = panel.getByRole('tablist', { name: 'Test result' });
    await expect(results.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('tabpanel')).toContainText('"dependencies":[]');

    // A failing script: exit 1, the stderr tab opens with the end of stderr.
    const code = inspector.getByRole('textbox', { name: 'Code' });
    await code.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('// lab:fail');
    await expect(panel).toContainText('The code or the result fields changed after this test. Test again to check them.');
    await test.click();
    await expect(panel.getByRole('status').filter({ hasText: 'A run would fail' })).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText('Exit code 1');
    await expect(results.getByRole('tab', { name: 'stderr' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('tabpanel')).toContainText('Error: the check failed (lab:fail)');
  });

  test('changing a node type asks first, lists what goes and undoes in one step', async ({ lab, page }) => {
    await lab.open();
    const editor = await lab.openPipelines();
    await editor.getByRole('button', { name: /^Review loop/ }).click();
    const canvas = editor.getByRole('application');
    await canvas.getByRole('group', { name: 'Developer', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: 'Node settings' });
    const type = inspector.getByRole('button', { name: 'Node type: Agent' });
    await expect(type).toBeVisible();
    const task = inspector.getByRole('textbox', { name: 'Task' });
    await expect(task).toHaveValue(/Implement the change/);

    // The current type is not offered; a lossy change asks with the exact list.
    await type.click();
    await expect(page.getByRole('menuitem', { name: 'Agent' })).toBeDisabled();
    await page.getByRole('menuitem', { name: 'Script' }).click();
    const confirm = page.getByRole('dialog', { name: 'Change this node to Script?' });
    await expect(confirm.getByRole('region', { name: 'Discarded' }).getByRole('listitem')).toHaveText(['Task', /^Harness and model: Pi · /]);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(type).toBeVisible();
    await expect(task).toHaveValue(/Implement the change/);

    await type.click();
    await page.getByRole('menuitem', { name: 'Script' }).click();
    await confirm.getByRole('button', { name: 'Change to Script' }).click();
    await expect(lab.toast('Changed to Script')).toBeVisible();
    await expect(inspector.getByRole('button', { name: 'Node type: Script' })).toBeVisible();
    await expect(tabs(inspector)).toHaveText(['Script', 'Output', 'Flow']);
    await expect(canvas.getByRole('group', { name: 'Developer', exact: true })).toContainText('No code yet');

    // One undo restores the type and the task.
    await editor.getByRole('toolbar', { name: 'Canvas controls' }).getByRole('button', { name: 'Undo' }).click();
    await canvas.getByRole('group', { name: 'Developer', exact: true }).click();
    await expect(inspector.getByRole('button', { name: 'Node type: Agent' })).toBeVisible();
    await expect(inspector.getByRole('textbox', { name: 'Task' })).toHaveValue(/Implement the change/);
  });
});
