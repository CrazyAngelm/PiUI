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
  test('reasoning and calls between two replies share one group, and the working group names its command', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Fix flaky scheduler test/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });

    // Reasoning is a row inside its group, not a button of its own.
    await expect(transcript.getByRole('button', { name: 'Thought', exact: true })).toHaveCount(0);
    const early = transcript.getByRole('button', { name: /^Read 1 file, searched 1 time/ });
    const reasoning = transcript.getByRole('button', { name: /^Reasoning/ });
    const plan = transcript.getByText(/Plan: read the test, grep for the revision assertion/);
    await expect(early).toBeVisible();
    await expect(early).toHaveAttribute('aria-expanded', 'false');
    await expect(reasoning).toHaveCount(0);

    // Opening the group lists its rows; the reasoning row shows its first line and opens with the keyboard.
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

    // The group that is still working says what it is doing now, in place of counts.
    await expect(
      transcript.getByRole('button', { name: /^Running a command.*pnpm --filter @piui\/desktop test:e2e/ }),
    ).toBeVisible();
    await expect(transcript.getByRole('button', { name: /failed|Stopped/ })).toHaveCount(0);
  });

  test('a finished turn folds its groups behind one control that opens with the keyboard', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Route host calls through one transport/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });

    // One control for the whole turn: how long it took, then what it did. The first reply stays visible.
    const control = transcript.getByRole('button', { name: /^Worked for \d+m \d+s · edited 1 file, ran 4 commands/ });
    const edits = transcript.getByRole('button', { name: /^Edited 1 file, ran 1 command/ });
    const checks = transcript.getByRole('button', { name: /^Ran 3 commands/ });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute('aria-expanded', 'false');
    await expect(transcript.getByText('The edits are in place. Running the checks next.')).toBeVisible();
    await expect(edits).toHaveCount(0);
    await expect(checks).toHaveCount(0);

    // Enter opens it: the groups return, each still closed.
    await control.focus();
    await page.keyboard.press('Enter');
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(edits).toBeVisible();
    await expect(edits).toHaveAttribute('aria-expanded', 'false');
    await expect(checks).toBeVisible();

    // Enter again folds them.
    await page.keyboard.press('Enter');
    await expect(control).toHaveAttribute('aria-expanded', 'false');
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

  test('only a failed call shows the error state', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Investigate crash on startup/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });

    const group = transcript.getByRole('button', { name: /^Ran 2 commands.*1 failed/ });
    await expect(group).toBeVisible();
    // The transcript follows new content until the reader scrolls away: a
    // script's own scroll is read as a layout shift and pinned back to the
    // bottom. Scroll up the way a reader does, then open the group.
    await transcript.focus();
    await page.keyboard.press('Home');
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(transcript.getByText('Failed', { exact: true })).toBeVisible();

    // A chat whose calls all succeeded carries no error or stopped mark.
    await lab.chat(/Map pipeline editor shortcuts/).click();
    await expect(transcript.getByRole('button', { name: /^Read 1 file, searched 1 time/ })).toBeVisible();
    await expect(transcript.getByRole('button', { name: /failed|Stopped/ })).toHaveCount(0);
  });

  test('a running turn shows its reasoning and command as one working group, and a declined command is stopped, not failed', async ({ lab, page }) => {
    test.slow(); // The native turn streams with real timers.
    await lab.open();
    const transcript = await startChat(lab, 'Install the lab dependencies and run the checks');

    // While the agent thinks and then waits on the command, one group says what it is doing.
    await expect(transcript.getByRole('button', { name: /^(Thinking|Running a command)/ })).toBeVisible({ timeout: 15_000 });
    const card = page.getByRole('article', { name: 'Permission request' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    const working = transcript.getByRole('button', { name: /^Running a command/ });
    await expect(working).toBeVisible();
    await expect(working).toHaveAttribute('aria-expanded', 'false');

    // The finished reasoning is a row inside that group.
    await expect(transcript.getByRole('button', { name: /^Reasoning/ })).toHaveCount(0);
    await working.click();
    await expect(transcript.getByRole('button', { name: /^Reasoning/ })).toBeVisible();

    // Declining stops the command; it is not an error.
    await card.getByRole('button', { name: 'Deny' }).click();
    await expect(transcript.getByRole('button', { name: /^Ran 1 command.*Stopped/ })).toBeVisible({ timeout: 30_000 });
    await expect(transcript.getByRole('button', { name: /failed/ })).toHaveCount(0);
  });
});
