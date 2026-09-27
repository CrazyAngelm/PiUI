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

  test('a template chosen in the composer opens in the editor unsaved', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await page.getByRole('combobox', { name: 'Who answers' }).fill('Review loop');
    await lab.option(/^Review loop.*built-in/).click();
    await expect(lab.toast('Opened a template as a new pipeline')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Review loop');
    await expect(page.getByText('Unsaved')).toBeVisible();
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
