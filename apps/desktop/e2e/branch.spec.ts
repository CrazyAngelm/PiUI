import type { Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * Message actions, branches and `/btw` in the UI Lab. The lab's Codex chat
 * "Route host calls through one transport" has two turns and branches natively;
 * the lab host keeps the source chat unchanged and links the branch to it.
 */
const SOURCE = 'Route host calls through one transport';
const BRANCH = `${SOURCE} (branch)`;
const FIRST_PROMPT = 'Route every host call in apps/desktop through a single transport';
const FIRST_ANSWER = 'Done: one host transport';
const SECOND_PROMPT = 'Does anything still import Tauri directly from a component?';

const transcript = (page: Page) => page.getByRole('region', { name: 'Conversation messages' });
const pane = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });

async function openSource(lab: Lab): Promise<void> {
  await lab.open();
  await lab.chat(new RegExp(SOURCE)).click();
  await expect(transcript(lab.page)).toContainText(SECOND_PROMPT);
}

test.describe('message actions', () => {
  test('copy writes the message and shows the copied state for a moment', async ({ lab, page }) => {
    // A page-local clipboard double preserves the user's real clipboard.
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { (window as Window & { copyProof?: string }).copyProof = text; } },
      }),
    );
    await openSource(lab);
    await page.getByRole('button', { name: 'Copy message', exact: true }).last().click();
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as Window & { copyProof?: string }).copyProof ?? '')).toContain('SessionComposer.svelte');
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
    lab.expectNoErrors();
  });

  test('branching an answer opens a new chat that shows the earlier messages', async ({ lab, page }) => {
    await openSource(lab);
    await page.getByRole('button', { name: 'Branch into a new chat', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: BRANCH })).toBeVisible();
    await expect(transcript(page)).toContainText(FIRST_PROMPT);
    await expect(transcript(page)).toContainText(FIRST_ANSWER);
    // The branch is cut after that answer: the later turn stays in the source only.
    await expect(transcript(page)).not.toContainText(SECOND_PROMPT);

    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('heading', { name: 'Branch of' })).toBeVisible();
    // A native branch carries the source's own history: no "not copied" note, no linked-branch toast.
    await expect(page.getByText('A linked branch: the history was not copied.')).toHaveCount(0);
    await expect(page.getByText(/^Linked branch: it starts/)).toHaveCount(0);
    await page.getByRole('complementary', { name: 'Chat details' }).getByRole('button', { name: SOURCE, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: SOURCE, exact: true })).toBeVisible();
    await expect(transcript(page)).toContainText(SECOND_PROMPT);
    lab.expectNoErrors();
  });

  test('edit and send again opens a chat without that message and with its text in the composer', async ({ lab, page }) => {
    await openSource(lab);
    await page.getByRole('button', { name: 'Edit and send again', exact: true }).last().click();
    await expect(page.getByRole('heading', { level: 1, name: BRANCH })).toBeVisible();
    await expect(transcript(page)).toContainText(FIRST_ANSWER);
    await expect(transcript(page)).not.toContainText(SECOND_PROMPT);
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(SECOND_PROMPT);
    lab.expectNoErrors();
  });
});

test.describe('/btw', () => {
  test('a side question opens a second pane with the question sent', async ({ lab, page }) => {
    await openSource(lab);
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill('/btw why is the build slow?');
    await message.press('Enter');

    await expect(page.getByRole('button', { name: 'Close pane' })).toHaveCount(2);
    await expect(pane(page, SOURCE)).toBeVisible();
    await expect(pane(page, BRANCH)).toBeVisible();
    await expect(pane(page, BRANCH)).toContainText('why is the build slow?');
    // The branch holds the earlier turns; the composer of the source is empty again.
    await expect(pane(page, BRANCH)).toContainText(FIRST_ANSWER);
    await expect(pane(page, SOURCE).getByRole('textbox', { name: 'Message' })).toHaveValue('');
    lab.expectNoErrors();
  });

  test('/btw alone opens the branch beside with an empty composer', async ({ lab, page }) => {
    await openSource(lab);
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill('/btw');
    await message.press('Enter');
    await expect(pane(page, BRANCH)).toBeVisible();
    await expect(pane(page, BRANCH).getByRole('textbox', { name: 'Message' })).toHaveValue('');
    await expect(pane(page, SOURCE)).toBeVisible();
  });
});
