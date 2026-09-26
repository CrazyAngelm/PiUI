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

test.describe('new chat', () => {
  test('harness → model → reasoning → send streams the answer', async ({ lab, page }) => {
    test.slow(); // The native turn streams with real timers.
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Harness' })).toBeFocused();
    await lab.option(/^Codex/).click();
    await composer.getByRole('button', { name: 'Default model' }).click();
    await lab.option(/^GPT Lab 5 Codex/).click();
    // Reasoning is tuned in the model popover, from the model's native levels.
    await composer.getByRole('button', { name: 'GPT Lab 5 Codex' }).click();
    const reasoning = page.getByRole('group', { name: 'Reasoning' });
    await expect(reasoning.getByRole('radio')).toHaveText(['Default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    await reasoning.getByRole('radio', { name: 'high', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(composer.getByRole('button', { name: 'GPT Lab 5 Codex high' })).toBeVisible();

    const prompt = 'Summarize how the transport boundary keeps Tauri out of components';
    const transcript = await startChat(lab, prompt);
    const answer = transcript.getByRole('blockquote').filter({ hasText: prompt });
    // The answer arrives in chunks while the turn is still running.
    await expect(answer).toBeVisible({ timeout: 20_000 });
    const early = (await transcript.innerText()).length;
    await expect(page.getByRole('button', { name: 'Stop turn' })).toBeHidden({ timeout: 30_000 });
    expect((await transcript.innerText()).length).toBeGreaterThan(early);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    // The chosen model and reasoning reached the native session settings.
    await page.getByRole('button', { name: 'GPT Lab 5 Codex', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Reasoning' }).getByRole('radio', { name: 'high', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'GPT Lab 5 Codex high' })).toBeVisible();
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('complementary', { name: 'Chat details' })).toContainText('GPT Lab 5 Codex');
  });

  test('a restricted project asks for trust instead of starting', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'piui', exact: true }).click();
    await lab.option(/^legacy-repo/).click();
    await expect(page.getByText('This folder is restricted. Trust it to let agents work on its files.')).toBeVisible();
    const message = composer.getByRole('textbox', { name: 'Message' });
    await message.fill('Refactor the auth module');
    await composer.getByRole('button', { name: 'Start chat' }).click();
    const dialog = page.getByRole('dialog', { name: 'Trust legacy-repo?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // Nothing started and the draft is kept.
    await expect(message).toHaveValue('Refactor the auth module');
    await expect(page.getByRole('heading', { level: 1, name: 'What should we work on?' })).toBeVisible();
  });

  test('safe mode keeps history readable and refuses to start agents', async ({ lab, page }) => {
    await lab.open('safe');
    await expect(page.getByText('Safe mode: history is read-only and agents are not started.')).toBeVisible();
    await expect(home(page).getByRole('textbox', { name: 'Message' })).toBeDisabled();
    await expect(home(page).getByRole('button', { name: 'Start chat' })).toBeDisabled();
    await lab.chat(/Route host calls through one transport/).click();
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('Does anything still import Tauri directly');
    await expect(page.getByText('Runtime actions are disabled in safe mode. Your draft is preserved.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
  });

  test('a signed-out Claude Code refuses the chat with a sign-in hint', async ({ lab, page }) => {
    await lab.open('empty');
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await lab.option(/^Claude Code/).click();
    await composer.getByRole('textbox', { name: 'Message' }).fill('Map the editor shortcuts');
    await composer.getByRole('button', { name: 'Start chat' }).click();
    await expect(lab.toast('Could not start the chat')).toContainText('Sign in to Claude Code');
    await expect(composer.getByRole('textbox', { name: 'Message' })).toHaveValue('Map the editor shortcuts');
  });
});

test.describe('approvals', () => {
  test('allowing a command lets the turn finish', async ({ lab, page }) => {
    await lab.open();
    const transcript = await startChat(lab, 'Install the lab dependencies and run the checks');
    const card = page.getByRole('article', { name: 'Permission request' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole('heading', { level: 3 })).toHaveText('Allow this command?');
    await card.getByRole('button', { name: 'Allow once' }).click();
    await expect(card).toBeHidden();
    await expect(transcript.getByRole('blockquote')).toContainText('Install the lab dependencies', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Stop turn' })).toBeHidden({ timeout: 30_000 });
    await expect(transcript).not.toContainText('because the request was declined');
  });

  test('denying a command is reported by the agent', async ({ lab, page }) => {
    await lab.open();
    const transcript = await startChat(lab, 'Install the lab dependencies and run the checks');
    const card = page.getByRole('article', { name: 'Permission request' });
    await card.getByRole('button', { name: 'Deny' }).click();
    await expect(card).toBeHidden();
    await expect(transcript).toContainText('because the request was declined', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Stop turn' })).toBeHidden({ timeout: 30_000 });
  });

  test('the Inbox decides a waiting approval and the queued follow-up drains', async ({ lab, page }) => {
    test.slow(); // Several native turns are simulated with real timers.
    await lab.open();
    await lab.nav('Inbox').click();
    const card = page.getByRole('article', { name: 'Permission request' });
    await expect(card.getByRole('heading', { name: 'Run the full e2e suite?' })).toBeVisible();
    await card.getByRole('button', { name: 'Allow once' }).click();
    await expect(card).toHaveCount(0);
    await expect(lab.nav('Inbox')).toHaveAccessibleName('Inbox');

    await lab.chat(/Fix flaky scheduler test/).click();
    const queue = page.getByRole('region', { name: 'Message queue' });
    // The e2e run finishes, then the queued follow-up is delivered as the next turn.
    await expect(queue).toBeHidden({ timeout: 45_000 });
    await expect(page.getByRole('region', { name: 'Conversation messages' }))
      .toContainText('After the e2e run, add a CHANGELOG entry for the fix.');
  });
});

test.describe('queue and steer', () => {
  test('a follow-up waits for the turn; steer joins it at once', async ({ lab, page }) => {
    test.slow(); // Several native turns are simulated with real timers.
    await lab.open();
    const transcript = await startChat(lab, 'Walk through the event bus batching');
    const message = page.getByRole('textbox', { name: 'Message' });
    await expect(message).toHaveAttribute('placeholder', 'Queue a follow-up…');

    await message.fill('Also cover backpressure');
    await page.getByRole('button', { name: 'Follow up', exact: true }).click();
    const queue = page.getByRole('region', { name: 'Message queue' });
    await expect(queue.getByRole('article').filter({ hasText: 'Also cover backpressure' })).toContainText('Queued');

    await page.getByRole('group', { name: 'Send mode' }).getByRole('radio', { name: 'Steer' }).click();
    await message.fill('Keep the answer short');
    await page.getByRole('button', { name: 'Steer', exact: true }).click();
    await expect(transcript.getByText('Keep the answer short', { exact: true })).toBeVisible();
    await expect(queue.getByText('Keep the answer short')).toHaveCount(0);

    // After the running turn ends the queued follow-up is sent as its own turn.
    // (The lab's answer quotes the prompt, so the text appears twice.)
    await expect(transcript.getByText('Also cover backpressure', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expect(queue).toBeHidden({ timeout: 45_000 });
  });

  test('an uncertain delivery blocks the queue until it is checked', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Investigate crash on startup/).click();
    const queue = page.getByRole('region', { name: 'Message queue' });
    await expect(queue).toContainText('Queue paused');
    await expect(queue).toContainText('Delivery uncertain');
    // Nothing is resent automatically: the queue stays paused until the person checks history.
    await expect(queue.getByRole('button', { name: 'Resume queue' })).toBeDisabled();
    await queue.getByRole('button', { name: 'Dismiss after checking history' }).click();
    await expect(queue).toBeHidden();
  });
});
