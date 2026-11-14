import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** The composer on Home ("What should we work on?"). */
function home(page: Page): Locator {
  return page.getByRole('region', { name: 'What should we work on?' });
}

test.describe('chat pipelines', () => {
  test('a new chat goes through a pipeline, then the chat agent gets its result', async ({ lab, page }) => {
    test.slow(); // The lab run and the follow-up turn use real timers.
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await page.getByRole('combobox', { name: 'Who answers' }).fill('Code review');
    await lab.option(/^Code review/).click();
    // A pipeline picks the models of its steps; only who answers stays.
    await expect(composer.getByRole('button', { name: 'Default model' })).toHaveCount(0);
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toContainText('then Prime Agent continues the chat');

    await composer.getByRole('textbox', { name: 'Message' }).fill('Review the login flow for session fixation');
    await composer.getByRole('button', { name: 'Start chat' }).click();

    const card = page.getByRole('article', { name: 'Pipeline run: Code review' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Succeeded', { timeout: 30_000 });
    await expect(card).toContainText('Answer from Reviewer');

    // Follow-ups talk to the chat's own agent and carry the result once.
    await expect(page.getByText('The next message hands the pipeline result to Prime Agent.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill('Summarize the risks in two bullets');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });
    await expect(transcript.getByText('Handed on the result of Code review')).toBeVisible();
    await expect(page.getByText('The next message hands the pipeline result to Prime Agent.')).toHaveCount(0);
  });

  test('a template chosen in the composer is saved and run on send, without opening the editor', async ({ lab, page }) => {
    test.slow(); // The lab run uses real timers.
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await page.getByRole('radio', { name: 'Pipelines' }).click();
    await lab.option(/^Review loop.*built-in/).click();

    // Choosing only selects: the editor stays closed and the chip names the template.
    await expect(page.getByRole('region', { name: 'Pipeline editor' })).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Review loop', exact: true })).toBeVisible();
    await expect(page.getByText('Sending saves this template as a pipeline in this project.')).toBeVisible();
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toContainText('Runs Review loop');

    await composer.getByRole('textbox', { name: 'Message' }).fill('Add input validation to the signup form');
    await composer.getByRole('button', { name: 'Start chat' }).click();

    await expect(lab.toast(/Saved .Review loop. to this project.s pipelines/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Pipeline editor' })).toHaveCount(0);
    await expect(page.getByRole('article', { name: 'Pipeline run: Review loop' })).toBeVisible({ timeout: 30_000 });
  });

  test('the executor picker has a Direct and a Pipelines tab, and only Pipelines offers the editor', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    const search = page.getByRole('combobox', { name: 'Who answers' });
    const manage = page.getByRole('button', { name: 'Manage pipelines' });
    const tabs = page.getByRole('group', { name: 'Executor type' });

    // Opens on the tab of the current executor, with the search focused.
    await expect(search).toBeFocused();
    await expect(tabs.getByRole('radio', { name: 'Direct' })).toBeChecked();
    await expect(manage).toHaveCount(0);
    await expect(lab.option(/^Review loop/)).toHaveCount(0);

    // Left and right switch the tab while the search is empty; clicking a tab keeps the search focused.
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('radio', { name: 'Pipelines' })).toBeChecked();
    await expect(lab.option(/^Review loop.*built-in/)).toBeVisible();
    await expect(manage).toBeVisible();
    await tabs.getByRole('radio', { name: 'Direct' }).click();
    await expect(search).toBeFocused();
    await expect(manage).toHaveCount(0);

    // A search spans both tabs.
    await search.fill('Review loop');
    await expect(lab.option(/^Review loop.*built-in/)).toBeVisible();
    await search.fill('');

    await tabs.getByRole('radio', { name: 'Pipelines' }).click();
    await manage.click();
    await expect(page.getByRole('region', { name: 'Pipeline editor' })).toBeVisible({ timeout: 30_000 });
  });

  test('project, permissions and worktree share one keyboard-operable chip', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    const chip = composer.getByRole('button', { name: /^Project and permissions: piui/ });
    await chip.focus();
    await page.keyboard.press('Enter');
    const readOnly = page.getByRole('radio', { name: /^Read only/ });
    await readOnly.check();
    await page.keyboard.press('Escape');
    await expect(composer.getByRole('button', { name: /^Project and permissions: piui · Read only$/ })).toBeVisible();
  });
});
