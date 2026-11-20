import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/** The composer on Home ("What should we work on?"). */
function home(page: Page): Locator {
  return page.getByRole('region', { name: 'What should we work on?' });
}

/** Starts a chat from Home and waits for its view. The lab streams a scripted native turn. */
async function startChat(lab: Lab, prompt: string): Promise<Locator> {
  const composer = home(lab.page);
  await composer.getByRole('textbox', { name: 'Message' }).fill(prompt);
  await composer.getByRole('button', { name: 'Start chat' }).click();
  const transcript = lab.page.getByRole('region', { name: 'Conversation messages' });
  await expect(transcript).toBeVisible();
  await expect(transcript.getByText(prompt, { exact: true })).toBeVisible();
  return transcript;
}

test.describe('chat activity', () => {
  test('a working turn is one line that names its command, and opens into its steps', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Fix flaky scheduler test/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });

    // The turn's work and the reply written between its groups sit behind one control. It says what is happening now.
    // Opened, the control drops the command from its label (the live group inside names it), so find it by the label's start.
    const control = transcript.getByRole('button', { name: /^Running a command/ }).first();
    const analysis = transcript.getByText(/Found it\. The assertion pins/);
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute('aria-expanded', 'false');
    await expect(control).toContainText('pnpm --filter @piui/desktop test:e2e');
    await expect(analysis).toHaveCount(0);
    await expect(transcript.getByRole('button', { name: 'Thought', exact: true })).toHaveCount(0);
    await expect(transcript.getByRole('button', { name: /returned an error|Stopped/ })).toHaveCount(0);

    // Opening it outlines the groups with the reply between them, each group still closed.
    await control.focus();
    await page.keyboard.press('Enter');
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(analysis).toBeVisible();
    const early = transcript.getByRole('button', { name: /^Read 1 file, searched 1 time/ });
    const reasoning = transcript.getByRole('button', { name: /^Reasoning/ });
    const plan = transcript.getByText(/Plan: read the test, grep for the revision assertion/);
    await expect(early).toBeVisible();
    await expect(early).toHaveAttribute('aria-expanded', 'false');
    await expect(reasoning).toHaveCount(0);

    // Opening a group lists its rows; the reasoning row shows its first line and opens with the keyboard.
    await early.focus();
    await page.keyboard.press('Enter');
    await expect(early).toHaveAttribute('aria-expanded', 'true');
    await expect(reasoning).toHaveAttribute('aria-expanded', 'false');
    await expect(reasoning).toContainText('The flaky test is cancellation_preserves');
    await expect(plan).toHaveCount(0);
    await reasoning.focus();
    await page.keyboard.press('Enter');
    await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
    await expect(plan).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(reasoning).toHaveAttribute('aria-expanded', 'false');
    await expect(plan).toHaveCount(0);
  });

  test('a finished turn leaves its answer and folds the work and the replies between the steps behind one control', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Route host calls through one transport/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });

    // One control for the whole turn: how long it took, then what it did. Only the answer stays in the chat.
    const control = transcript.getByRole('button', { name: /^Worked for \d+m \d+s · edited 1 file, ran 4 commands/ });
    const edits = transcript.getByRole('button', { name: /^Edited 1 file, ran 1 command/ });
    const checks = transcript.getByRole('button', { name: /^Ran 3 commands/ });
    const narration = transcript.getByText('The edits are in place. Running the checks next.');
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute('aria-expanded', 'false');
    await expect(transcript.getByRole('heading', { name: 'Done: one host transport' })).toBeVisible();
    await expect(narration).toHaveCount(0);
    await expect(edits).toHaveCount(0);
    await expect(checks).toHaveCount(0);

    // Enter opens it: the first group, the reply and the second group return in order, each group still closed.
    await control.focus();
    await page.keyboard.press('Enter');
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(narration).toBeVisible();
    await expect(edits).toBeVisible();
    await expect(edits).toHaveAttribute('aria-expanded', 'false');
    await expect(checks).toBeVisible();

    // Enter again folds them.
    await page.keyboard.press('Enter');
    await expect(control).toHaveAttribute('aria-expanded', 'false');
    await expect(narration).toHaveCount(0);
    await expect(edits).toHaveCount(0);
    await expect(checks).toHaveCount(0);
  });

  test('a control reached with the keyboard stays in view', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Route host calls through one transport/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });
    const control = transcript.getByRole('button', { name: /^Worked for/ });
    await expect(control).toBeVisible();
    await expect(control).not.toBeInViewport();

    // Focus scrolls the control into view. The transcript must not pull the view back to the latest message.
    await control.focus();
    await expect(control).toBeInViewport();
    await page.waitForTimeout(500);
    await expect(control).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(control).toBeInViewport();
  });

  test('message actions stay out of the way until reached, except on the last answer', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Route host calls through one transport/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });
    const answers = transcript.locator('article.assistant');
    await expect(answers).toHaveCount(2);

    const actions = (answer: Locator): Locator => answer.locator('xpath=ancestor::div[contains(@class, "item")][1]').getByRole('group', { name: 'Message actions' });
    const opacity = (target: Locator): Promise<number> => target.evaluate((node) => Number(getComputedStyle(node).opacity));

    // The first answer shows its actions only on hover or focus; the last one always does.
    const first = answers.first();
    await first.scrollIntoViewIfNeeded();
    await expect.poll(() => opacity(actions(first))).toBe(0);
    await expect.poll(() => opacity(actions(answers.last()))).toBe(1);
    await first.hover();
    await expect.poll(() => opacity(actions(first))).toBe(1);
    await page.mouse.move(0, 0);
    await expect.poll(() => opacity(actions(first))).toBe(0);
    // The keyboard reaches them, too.
    await actions(first).getByRole('button').first().focus();
    await expect.poll(() => opacity(actions(first))).toBe(1);
  });

  test('only a failed call shows the error state', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Investigate crash on startup/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });

    // A turn that ended badly opens its process: the failed call is in view without a click.
    const control = transcript.getByRole('button', { name: /ran 2 commands.*1 returned an error/i });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(transcript.getByText('Failed', { exact: true })).toBeVisible();

    // A chat whose calls all succeeded carries no error or stopped mark.
    await lab.chat(/Map pipeline editor shortcuts/).click();
    await expect(transcript.getByRole('button', { name: /read 1 file, searched 1 time/i })).toBeVisible();
    await expect(transcript.getByRole('button', { name: /returned an error|Stopped/ })).toHaveCount(0);
  });

  test('a running turn shows its reasoning and command as one working line, and a declined command is stopped, not failed', async ({ lab, page }) => {
    test.slow(); // The native turn streams with real timers.
    await lab.open();
    const transcript = await startChat(lab, 'Install the lab dependencies and run the checks');

    // While the agent thinks and then waits on the command, one line says what it is doing.
    await expect(transcript.getByRole('button', { name: /^(Thinking|Running a command)/ })).toBeVisible({ timeout: 15_000 });
    const card = page.getByRole('article', { name: 'Permission request' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    const working = transcript.getByRole('button', { name: /^Running a command/ });
    await expect(working).toBeVisible();
    await expect(working).toHaveAttribute('aria-expanded', 'false');

    // The finished reasoning is a row inside the process.
    await expect(transcript.getByRole('button', { name: /^Reasoning/ })).toHaveCount(0);
    await working.click();
    await expect(transcript.getByRole('button', { name: /^Reasoning/ })).toBeVisible();

    // Declining stops the command; it is not an error.
    await card.getByRole('button', { name: 'Deny' }).click();
    await expect(transcript.getByRole('button', { name: /ran 1 command.*Stopped/i })).toBeVisible({ timeout: 30_000 });
    await expect(transcript.getByRole('button', { name: /returned an error/ })).toHaveCount(0);
  });
});
