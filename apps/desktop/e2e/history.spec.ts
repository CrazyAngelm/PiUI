import type { Locator } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/** Opens the read-only Pi session history of the piui project from its sidebar menu. */
async function openHistory(lab: Lab): Promise<Locator> {
  await lab.open();
  await lab.sidebar.getByRole('button', { name: 'Options for piui' }).click();
  await lab.page.getByRole('menuitem', { name: 'Pi session history' }).click();
  const view = lab.page.getByRole('region', { name: 'Pi session history' });
  await expect(view.getByRole('heading', { level: 1, name: 'Pi session history' })).toBeVisible();
  return view;
}

test.describe('Pi session history', () => {
  test('a session reads read-only with its branches', async ({ lab }) => {
    const view = await openHistory(lab);
    const sessions = view.getByRole('complementary', { name: 'Sessions' });
    await expect(sessions.getByRole('button')).toHaveCount(4);
    const branched = sessions.getByRole('button', { name: /^Make the session index incremental .*3 branches/ });
    await expect(branched).toContainText('14 entries');
    await expect(view.getByRole('region', { name: 'Transcript' })).toContainText('Choose a session');

    await branched.click();
    await expect(branched).toHaveAttribute('aria-current', 'page');
    const transcript = view.getByRole('region', { name: 'Transcript' });
    await expect(transcript.getByRole('heading', { level: 2, name: 'Make the session index incremental' })).toBeVisible();
    await expect(transcript).toContainText('Read only');
    await expect(transcript.getByRole('region', { name: 'Conversation messages' })).toContainText('Incremental session scan');
    // History has no composer: it is never written to.
    await expect(lab.page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);

    const details = lab.page.getByRole('complementary', { name: 'Session details' });
    const branches = details.getByRole('region', { name: 'Branches' });
    await expect(branches).toContainText('3 branches · 14 entries');
    await expect(branches.getByRole('list', { name: 'Branches of this session' }).getByRole('listitem')).toHaveCount(3);
    await expect(branches.getByRole('listitem').first()).toContainText('Current branch');
    await expect(branches).toContainText('Switch branches in the Pi terminal app; PiUI never rewrites session files.');
    // Every entry in tree order, the current path marked for screen readers.
    await branches.getByText('All entries (14)').click();
    const entries = branches.getByRole('list', { name: 'Entries in tree order' }).getByRole('listitem');
    await expect(entries).toHaveCount(14);
    await expect(entries.first()).toContainText('on the current branch');

    // The details panel closes and reopens from the reader.
    await details.getByRole('button', { name: 'Close details' }).click();
    await expect(details).toBeHidden();
    await transcript.getByRole('button', { name: 'Details' }).click();
    await expect(details).toBeVisible();
  });

  test('a damaged file stays readable with a generic fallback and a warning', async ({ lab }) => {
    const view = await openHistory(lab);
    const damaged = view.getByRole('complementary', { name: 'Sessions' }).getByRole('button', { name: /^Rename the catalog watcher/ });
    await expect(damaged).toContainText('Partly readable');
    await damaged.click();
    const messages = view.getByRole('region', { name: 'Transcript' }).getByRole('region', { name: 'Conversation messages' });
    await expect(messages).toContainText('Rename the watcher module and update its imports.');
    await expect(messages.getByRole('note')).toContainText('The session file ended in the middle of an entry.');
    await expect(messages.getByRole('group').filter({ hasText: 'Unrecognized session entry' })).toContainText('Compatibility view');
    const details = lab.page.getByRole('complementary', { name: 'Session details' });
    await expect(details).toContainText('Partly readable');
    await expect(details.getByRole('note')).toContainText('Some entries could not be linked.');
  });

  test('the filter narrows the list and says when nothing matches', async ({ lab }) => {
    const view = await openHistory(lab);
    const sessions = view.getByRole('complementary', { name: 'Sessions' });
    const filter = sessions.getByRole('textbox', { name: 'Filter sessions' });
    await filter.fill('release notes');
    await expect(sessions.getByRole('listitem')).toHaveCount(1);
    await expect(sessions.getByRole('button', { name: /^Draft release notes for 0\.2\.0/ })).toBeVisible();
    await filter.fill('zz-no-such-session');
    await expect(sessions.getByText('No sessions match the filter.')).toBeVisible();
    await filter.fill('');
    await expect(sessions.getByRole('button')).toHaveCount(4);
  });
});
