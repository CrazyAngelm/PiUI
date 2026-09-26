import { expect, test } from './fixtures';

test.describe('pipelines', () => {
  test('template → Start inputs → Check → Run → run canvas → step panel → review limit', async ({ lab, page }) => {
    test.slow(); // Two native turns are simulated with real timers.
    await lab.open();
    const editor = await lab.openPipelines();
    await editor.getByRole('button', { name: /^Review loop/ }).click();
    const canvas = editor.getByRole('application');
    await expect(canvas.getByRole('group', { name: 'Developer', exact: true })).toBeVisible();
    await expect(canvas.getByRole('group', { name: 'Reviewer', exact: true })).toBeVisible();
    await expect(canvas.getByRole('group', { name: 'Result connection from Developer to Reviewer' })).toBeAttached();
    await expect(canvas.getByRole('group', { name: 'Connection from Start to Developer' })).toBeAttached();

    // The Start node shows and edits the run inputs asked for at launch.
    await canvas.getByRole('group', { name: 'Start', exact: true }).click();
    const start = page.getByRole('complementary', { name: 'Start' });
    await expect(start.getByRole('heading', { name: 'Run inputs' })).toBeVisible();
    const question = start.getByRole('textbox', { name: 'Question' });
    await expect(question).toHaveValue('What should the pipeline do?');
    await question.fill('What should be reviewed?');
    await expect(canvas.getByRole('group', { name: 'Start', exact: true })).toContainText('What should be reviewed?');
    await start.getByRole('button', { name: 'Close start settings' }).click();

    // Check reports a graph issue and recovers once it is fixed.
    const name = editor.getByRole('textbox', { name: 'Pipeline name' });
    await name.fill('');
    await editor.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(editor.getByRole('button', { name: '1 problems' })).toBeVisible();
    await expect(editor.getByRole('listitem').filter({ hasText: 'Enter a name and model for every agent.' })).toBeVisible();
    await name.fill('Review loop');
    await editor.getByRole('button', { name: '1 problems' }).click();
    await expect(editor.getByText('Checked')).toBeVisible();

    // One review round: the first (rejected) review reaches the limit and waits for a person.
    await canvas.getByRole('group', { name: 'Reviewer', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: 'Node settings' });
    await expect(inspector.getByRole('textbox', { name: 'Name' })).toHaveValue('Reviewer');
    await inspector.getByRole('tab', { name: 'Flow' }).click();
    const rounds = inspector.getByRole('spinbutton', { name: 'Maximum rounds' });
    await expect(rounds).toHaveValue('3');
    await rounds.fill('1');
    await rounds.press('Tab');
    await inspector.getByRole('button', { name: 'Close' }).click();

    // Run asks for the inputs first; a required answer cannot be empty.
    await editor.getByRole('button', { name: 'Run', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Run Review loop' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Start run' }).click();
    const answer = dialog.getByRole('textbox', { name: 'What should be reviewed?' });
    await expect(answer).toHaveAttribute('aria-invalid', 'true');
    await expect(answer).toBeFocused();
    await answer.fill('Cover the cancellation path of the transport with a test.');
    await dialog.getByRole('button', { name: 'Start run' }).click();
    await expect(dialog).toBeHidden();

    // The run opens on its canvas; node states follow the recorded journal.
    const run = page.getByRole('region', { name: 'Run' });
    await expect(run.getByRole('heading', { level: 2, name: 'Review loop' })).toBeVisible();
    const runCanvas = run.getByRole('application');
    const developer = runCanvas.getByRole('group', { name: 'Developer', exact: true });
    const reviewer = runCanvas.getByRole('group', { name: 'Reviewer', exact: true });
    await expect(developer).toContainText(/Working|Done/);
    await expect(developer).toContainText('Done', { timeout: 30_000 });
    await expect(reviewer).toContainText('Needs approval', { timeout: 30_000 });

    // The step panel: result, native conversation and inputs.
    await reviewer.click();
    const panel = page.getByRole('complementary', { name: /Reviewer/ });
    const tabs = panel.getByRole('tablist', { name: 'Step details' });
    await expect(tabs.getByRole('tab')).toHaveText(['Result', 'Conversation', 'Input']);
    await expect(panel).toContainText('Round 1 of 1');
    await tabs.getByRole('tab', { name: 'Conversation' }).click();
    await expect(panel.getByRole('tabpanel')).toContainText('Review the change');
    await tabs.getByRole('tab', { name: 'Input' }).click();
    await expect(panel.getByRole('tabpanel')).toContainText('Receives results from');
    await tabs.getByRole('tab', { name: 'Result' }).click();

    // Operator actions at the review round limit.
    await expect(panel.getByRole('button', { name: 'Accept last result' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'One more round' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reject' })).toBeVisible();
    await panel.getByRole('button', { name: 'Accept last result' }).click();
    await expect(reviewer).toContainText('Done');
    await expect(run).toContainText('Succeeded');
  });

  test('a failed run offers recovery actions without hiding the failure', async ({ lab, page }) => {
    await lab.open();
    const runs = await lab.openRuns();
    await runs.getByRole('radio', { name: 'Problems' }).click();
    await runs.getByRole('button', { name: /^Failed Code review/ }).click();
    const run = page.getByRole('region', { name: 'Run' });
    await expect(run).toContainText('Failed');
    const developer = run.getByRole('application').getByRole('group', { name: 'Developer', exact: true });
    await expect(developer).toContainText('Failed');
    await developer.click();
    const panel = page.getByRole('complementary', { name: /Developer/ });
    await expect(panel).toContainText('The agent’s turn failed in the harness.');
    await expect(panel.getByRole('button', { name: 'Open chat' })).toBeVisible();
    // Repeating is an explicit decision; keeping the results changes nothing.
    await panel.getByRole('button', { name: 'Run again from here' }).click();
    const confirm = page.getByRole('dialog', { name: 'Run again from this step?' });
    await expect(confirm).toContainText('Earlier results stay in the attempt history.');
    await confirm.getByRole('button', { name: 'Keep results' }).click();
    await expect(confirm).toBeHidden();
    await expect(developer).toContainText('Failed');
    await expect(run).toContainText('Failed');
  });

  test('the run header wraps instead of overlapping when the step panel is open', async ({ lab, page }) => {
    await lab.open();
    const runs = await lab.openRuns();
    await runs.getByRole('button', { name: /^Succeeded Code review/ }).click();
    const run = page.getByRole('region', { name: 'Run' });
    await run.getByRole('application').getByRole('group', { name: 'Planner', exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Step details' })).toBeVisible();

    const parts = [
      run.getByRole('heading', { level: 2, name: 'Code review' }),
      run.getByText('Succeeded', { exact: true }),
      run.getByText('3 of 3 steps done'),
      run.getByText('Started by Nightly code review'),
      run.getByRole('button', { name: 'Inputs' }),
      run.getByRole('button', { name: 'Edit pipeline' }),
    ];
    const boxes = [];
    for (const part of parts) {
      await expect(part).toBeVisible();
      const box = await part.boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box!);
    }
    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        const a = boxes[first]!;
        const b = boxes[second]!;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `header parts ${first} and ${second} overlap`).toBe(false);
      }
    }
    // Everything stays inside the stage, left of the step panel.
    const panel = await page.getByRole('complementary', { name: /Planner/ }).boundingBox();
    for (const box of boxes) expect(box.x + box.width).toBeLessThanOrEqual(panel!.x + 1);

    // The inputs stay reachable from the wrapped header.
    await run.getByRole('button', { name: 'Inputs' }).click();
    await expect(page.getByRole('dialog', { name: 'Run inputs' })).toContainText('Review the changes merged since the last nightly run');
  });
});
