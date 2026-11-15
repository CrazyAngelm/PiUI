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
  test('reasoning and prose stay visible between collapsed tool groups', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Fix flaky scheduler test/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });

    // Finished reasoning is one closed line; its text opens with the keyboard.
    const thought = transcript.getByRole('button', { name: 'Thought', exact: true });
    const reasoningText = transcript.getByText(/The flaky test is cancellation_preserves/);
    await expect(thought).toBeVisible();
    await expect(thought).toHaveAttribute('aria-expanded', 'false');
    await expect(reasoningText).toHaveCount(0);
    await thought.focus();
    await page.keyboard.press('Enter');
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(reasoningText).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(thought).toHaveAttribute('aria-expanded', 'false');

    // Tool calls collapse between the prose and reasoning rows, not across them.
    const first = transcript.getByRole('button', { name: /^Read 1 file, searched 1 time/ });
    await expect(first).toBeVisible();
    await expect(first).toHaveAttribute('aria-expanded', 'false');

    // The running group shows a live state and the command it is running.
    await expect(
      transcript.getByRole('button', { name: /^Edited 1 file, ran 1 command.*working….*pnpm --filter @piui\/desktop test:e2e/ }),
    ).toBeVisible();
    await expect(transcript.getByRole('button', { name: /failed|Stopped/ })).toHaveCount(0);
  });

  test('only a failed call shows the error state', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Investigate crash on startup/).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });

    const group = transcript.getByRole('button', { name: /^Ran 2 commands.*1 failed/ });
    await expect(group).toBeVisible();
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(transcript.getByText('Failed', { exact: true })).toBeVisible();

    // A chat whose calls all succeeded carries no error or stopped mark.
    await lab.chat(/Map pipeline editor shortcuts/).click();
    await expect(transcript.getByRole('button', { name: /^Read 1 file, searched 1 time/ })).toBeVisible();
    await expect(transcript.getByRole('button', { name: /failed|Stopped/ })).toHaveCount(0);
  });

  test('a running turn shows its reasoning, and a declined command is stopped, not failed', async ({ lab, page }) => {
    test.slow(); // The native turn streams with real timers.
    await lab.open();
    const transcript = await startChat(lab, 'Install the lab dependencies and run the checks');

    // Reasoning is a row of its own: open while it streams, then a closed "Thought".
    await expect(transcript.getByRole('button', { name: /^(Thinking…|Thought)/ })).toBeVisible({ timeout: 15_000 });
    const card = page.getByRole('article', { name: 'Permission request' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(transcript.getByRole('button', { name: /^Thought/ })).toHaveAttribute('aria-expanded', 'false');
    await expect(transcript.getByRole('button', { name: /^Ran 1 command.*working…/ })).toBeVisible();

    // Declining stops the command; it is not an error.
    await card.getByRole('button', { name: 'Deny' }).click();
    await expect(transcript.getByRole('button', { name: /^Ran 1 command.*Stopped/ })).toBeVisible({ timeout: 30_000 });
    await expect(transcript.getByRole('button', { name: /failed/ })).toHaveCount(0);
  });
});
