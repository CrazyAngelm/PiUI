import { expect, test } from './fixtures';

test.describe('Fusion in the chat list', () => {
  test('a working pair shows its sidekick chat under the lead without opening it', async ({ lab, page }) => {
    test.slow(); // The lab pair briefs its sidekick two seconds after the chat starts.
    await lab.open();
    await page.getByLabel('Chat type').getByRole('radio', { name: 'Fusion' }).click();
    await lab.main.getByRole('textbox', { name: 'Message' }).fill('Add a retry limit to the uploader');
    await lab.main.getByRole('button', { name: 'Start chat' }).click();
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toBeVisible();
    // Both chats are named after the first message, not after their agents.
    await expect(lab.chat(/^Add a retry limit to the uploader/)).toBeVisible();

    // No click on the lead's toggle: the sidekick's chat is in view as soon as it exists.
    const sidekick = lab.chat(/^Sidekick · Add a retry limit to the uploader/);
    await expect(sidekick).toBeVisible({ timeout: 15_000 });
    const toggle = lab.sidebar.getByRole('button', { name: 'Hide sidekick chats' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Closing the lead is the person's choice: later work of the pair does not reopen it.
    await toggle.click();
    await expect(sidekick).toBeHidden();
    // The round moves from queued to running meanwhile, which changes the pair again.
    await page.waitForTimeout(2_500);
    await expect(sidekick).toBeHidden();
    await expect(lab.sidebar.getByRole('button', { name: 'Show sidekick chats' })).toHaveAttribute('aria-expanded', 'false');
  });
});
