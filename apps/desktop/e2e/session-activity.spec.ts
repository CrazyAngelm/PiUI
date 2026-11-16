import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * What a chat is running now (ADR-072), in the UI Lab. The live Claude Code demo
 * chat has two running background tasks (an agent and the UI Lab dev server) and
 * two finished ones; the Pi chat "Cache sizing" runs nothing.
 */
const CLAUDE_CHAT = /Map pipeline editor shortcuts/;
const IDLE_CHAT = /Cache sizing/;
const REVIEW_AGENT = 'Review the transport diff';
const MAP_AGENT = 'Map every direct Tauri import';
const DEV_SERVER = 'pnpm --filter @piui/desktop dev';
const FAILED_COMMAND = 'cargo test -p piui-runtime';

async function openDetails(lab: Lab): Promise<Locator> {
  await lab.page.getByRole('button', { name: 'Details' }).click();
  const details = lab.page.getByRole('complementary', { name: 'Chat details' });
  await expect(details).toBeVisible();
  return details;
}

/** Serious and critical WCAG 2.1 A/AA violations inside one element. */
async function axeBlocking(page: Page, selector: string): Promise<readonly { id: string; nodes: string[] }[]> {
  const results = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(' ')) }));
}

test.describe('chat activity', () => {
  test('the details panel leads with the running agents and commands, background ones included', async ({ lab }) => {
    await lab.open('demo');
    await lab.chat(CLAUDE_CHAT).click();
    const details = await openDetails(lab);
    const activity = details.getByRole('region', { name: 'Activity' });
    await expect(activity).toBeVisible();
    await expect(activity.getByText('Nothing is running')).toHaveCount(0);

    const agents = activity.getByRole('group', { name: 'Agents' });
    const commands = activity.getByRole('group', { name: 'Commands' });
    await expect(agents).toContainText(REVIEW_AGENT);
    await expect(agents).toContainText('Reading apps/desktop/src/host-api/transport.ts');
    await expect(agents).toContainText('general-purpose');
    await expect(agents).toContainText(MAP_AGENT);
    await expect(agents).toContainText('Three components still import Tauri directly.');
    await expect(commands).toContainText(DEV_SERVER);
    await expect(commands).toContainText(FAILED_COMMAND);
    await expect(activity.getByRole('group', { name: 'Other' })).toHaveCount(0);

    // Every state has a name for screen readers, and running rows show their elapsed time.
    await expect(activity.getByRole('img', { name: 'Running' })).toHaveCount(2);
    await expect(agents.getByRole('img', { name: 'Completed' })).toBeVisible();
    await expect(commands.getByRole('img', { name: 'Failed' })).toBeVisible();
    await expect(agents.getByRole('listitem').filter({ hasText: REVIEW_AGENT })).toContainText(/\d+:\d{2}/);

    // Only running work can be stopped.
    await expect(activity.getByRole('button', { name: /^Stop / })).toHaveCount(2);
    await expect(activity.getByRole('button', { name: `Stop ${REVIEW_AGENT}`, exact: true })).toBeVisible();
    await expect(activity.getByRole('button', { name: `Stop ${DEV_SERVER}`, exact: true })).toBeVisible();
    lab.expectNoErrors();
  });

  test('a running command is stopped from the keyboard and its row shows the Stopped state', async ({ lab, page }) => {
    await lab.open('demo');
    await lab.chat(CLAUDE_CHAT).click();
    const details = await openDetails(lab);
    const activity = details.getByRole('region', { name: 'Activity' });
    const commands = activity.getByRole('group', { name: 'Commands' });
    const row = commands.getByRole('listitem').filter({ hasText: DEV_SERVER });
    const stop = row.getByRole('button', { name: `Stop ${DEV_SERVER}`, exact: true });

    await stop.focus();
    await expect(stop).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(row.getByRole('img', { name: 'Stopped' })).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(row).toBeFocused();
    await expect(row.getByRole('img', { name: 'Running' })).toHaveCount(0);
    await expect(row).toContainText(DEV_SERVER);
    // The agent that still runs keeps its control, and the toolbar counts one task less.
    await expect(activity.getByRole('button', { name: /^Stop / })).toHaveCount(1);
    await expect(activity.getByRole('img', { name: 'Running' })).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: 'running in this chat' })).toHaveText('1 running in this chat');
    lab.expectNoErrors();
  });

  test('a chat with nothing running says so', async ({ lab }) => {
    await lab.open('demo');
    await lab.chat(IDLE_CHAT).click();
    const details = await openDetails(lab);
    const activity = details.getByRole('region', { name: 'Activity' });
    await expect(activity).toContainText('Nothing is running');
    await expect(activity.getByRole('group')).toHaveCount(0);
    await expect(activity.getByRole('button')).toHaveCount(0);
  });

  test('the details panel has no facts or capabilities block', async ({ lab }) => {
    await lab.open('demo');
    await lab.chat(CLAUDE_CHAT).click();
    const details = await openDetails(lab);
    await expect(details.getByText('About this chat')).toHaveCount(0);
    await expect(details.getByText('What this agent can do here')).toHaveCount(0);
    await expect(details.getByRole('region', { name: 'Activity' })).toBeVisible();
  });

  test('the toolbar tells that work is running while the details panel is closed', async ({ lab, page }) => {
    await lab.open('demo');
    await lab.chat(CLAUDE_CHAT).click();
    const status = page.getByRole('status').filter({ hasText: 'running in this chat' });
    // Visually hidden text: it reaches screen readers, and the button keeps its name.
    await expect(status).toHaveText('2 running in this chat');
    await expect(page.getByRole('button', { name: 'Details' })).toBeVisible();
    // A decorative dot marks the button while the panel is closed.
    await expect(page.locator('.chat__running-dot')).toHaveCount(1);

    await openDetails(lab);
    await expect(page.locator('.chat__running-dot')).toHaveCount(0);
    await expect(status).toHaveText('2 running in this chat');

    // A chat that runs nothing announces nothing.
    await lab.chat(IDLE_CHAT).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Cache sizing' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'running in this chat' })).toHaveCount(0);
  });
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(`chat activity accessibility (${theme})`, () => {
    test.use({ colorScheme: theme, reducedMotion: 'reduce' });

    test('the details panel passes axe', async ({ lab, page }) => {
      test.slow(); // axe's contrast pass is CPU-heavy.
      await lab.open('demo');
      await lab.chat(CLAUDE_CHAT).click();
      const details = await openDetails(lab);
      await expect(details.getByRole('region', { name: 'Activity' })).toContainText(REVIEW_AGENT);
      expect(await axeBlocking(page, 'aside[aria-label="Chat details"]'), 'activity').toEqual([]);
    });
  });
}
