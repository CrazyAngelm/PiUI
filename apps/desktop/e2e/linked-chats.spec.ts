import { expect, test, type Lab } from './fixtures';

// The first demo chat has one seeded child started by an agent, with a report (UI Lab).
const LEAD = 'Plan a weekend in Lisbon';
const CHILD = 'Cache sizing';
const OTHER = 'Explain Rust lifetimes';
const REPORT = 'The linked review is complete.';

/** A chat row of the sidebar; the name starts with the title (the time follows it). */
const row = (lab: Lab, title: string) => lab.sidebar.getByRole('listitem').getByRole('button', { name: new RegExp(`^${title}`) });

async function openDetails(lab: Lab) {
  await lab.page.getByRole('button', { name: 'Details' }).click();
  return lab.page.getByRole('complementary', { name: 'Chat details' });
}

async function chatMenu(lab: Lab, item: string) {
  await lab.page.getByRole('button', { name: 'Chat actions' }).click();
  return lab.page.getByRole('menuitem', { name: item });
}

test.describe('linked chats', () => {
  test('a child started by an agent is listed under its parent and opens with the same chevron as a sidekick', async ({ lab }) => {
    await lab.open('demo', '&links=seed');
    const toggle = lab.sidebar.getByRole('button', { name: 'Show linked chats' });
    await expect(toggle).toBeVisible();
    await expect(row(lab, CHILD)).toHaveCount(0);
    await expect(row(lab, LEAD)).toBeVisible();

    await toggle.click();
    await expect(lab.sidebar.getByRole('button', { name: 'Hide linked chats' })).toHaveAttribute('aria-expanded', 'true');
    await expect(row(lab, CHILD)).toBeVisible();

    await row(lab, CHILD).click();
    await expect(row(lab, CHILD)).toHaveAttribute('aria-current', 'page');
    await expect(lab.sidebar.getByRole('button', { name: 'Hide linked chats' })).toBeVisible();
  });

  test('a reload shows the current child already under its parent', async ({ lab, page }) => {
    await lab.open('demo', '&links=seed');
    await lab.sidebar.getByRole('button', { name: 'Show linked chats' }).click();
    await row(lab, CHILD).click();
    await expect(row(lab, CHILD)).toHaveAttribute('aria-current', 'page');
    await page.reload();
    await expect(lab.sidebar).toBeVisible();
    await expect(row(lab, CHILD)).toBeVisible();
    await expect(lab.sidebar.getByRole('button', { name: 'Hide linked chats' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('the details panel lists the linked chat with its report and the notice for an agent without the tool', async ({ lab, page }) => {
    await lab.open('demo', '&links=seed');
    await lab.chat(LEAD).click();
    const details = await openDetails(lab);
    const section = details.getByRole('region', { name: 'Linked chats' });
    await expect(section).toBeVisible();
    await expect(section.getByRole('button', { name: new RegExp(CHILD) })).toBeVisible();
    await expect(section).toContainText(REPORT);
    await expect(section).toContainText('The agent in this chat cannot use linked chats.');
    // Idle chats carry no state badge and nothing waits for delivery.
    await expect(section.getByRole('button', { name: 'Deliver' })).toHaveCount(0);

    await section.getByRole('button', { name: new RegExp(CHILD) }).click();
    await expect(page.getByRole('heading', { level: 1, name: CHILD })).toBeVisible();
    // The child's panel lists its parent.
    await expect(details.getByRole('region', { name: 'Linked chats' }).getByRole('button', { name: new RegExp(LEAD) })).toBeVisible();
  });

  test('a row menu opens the linked chat to the side, and offers no unlink for a child of an agent', async ({ lab, page }) => {
    await lab.open('demo', '&links=seed');
    await lab.chat(LEAD).click();
    const details = await openDetails(lab);
    await details.getByRole('button', { name: `Options for ${CHILD}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Unlink' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Open to the side' }).click();
    await expect(page.getByRole('region', { name: LEAD })).toBeVisible();
    await expect(page.getByRole('region', { name: CHILD })).toBeVisible();
  });

  test('Link chat links a second chat as a peer, hides the ones already linked, and Unlink removes it', async ({ lab, page }) => {
    await lab.open('demo', '&links=seed');
    await lab.chat(LEAD).click();
    const details = await openDetails(lab);
    await (await chatMenu(lab, 'Link chat…')).click();

    const dialog = page.getByRole('dialog', { name: 'Link chat' });
    await expect(dialog).toBeVisible();
    // The current chat and the already linked chat are not offered.
    await expect(dialog.getByRole('radio', { name: new RegExp(LEAD) })).toHaveCount(0);
    await expect(dialog.getByRole('radio', { name: new RegExp(CHILD) })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Link', exact: true })).toBeDisabled();

    await dialog.getByRole('searchbox', { name: 'Search chats' }).fill('lifetimes');
    await expect(dialog.getByRole('radio')).toHaveCount(1);
    await dialog.getByRole('radio', { name: new RegExp(OTHER) }).check();
    await dialog.getByRole('button', { name: 'Link', exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect(lab.toast(`Linked to ${OTHER}`)).toBeVisible();
    const section = details.getByRole('region', { name: 'Linked chats' });
    await expect(section.getByRole('button', { name: new RegExp(OTHER) })).toBeVisible();
    await expect(section.getByRole('button', { name: new RegExp(CHILD) })).toBeVisible();
    // A peer stays a top-level chat in the sidebar.
    await expect(row(lab, OTHER)).toBeVisible();

    await details.getByRole('button', { name: `Options for ${OTHER}` }).click();
    await page.getByRole('menuitem', { name: 'Unlink' }).click();
    await expect(section.getByRole('button', { name: new RegExp(OTHER) })).toHaveCount(0);
    await expect(section.getByRole('button', { name: new RegExp(CHILD) })).toBeVisible();
    lab.expectNoErrors();
  });

  test('Send to chat sends a message to a linked chat, and only chats with links offer it', async ({ lab, page }) => {
    await lab.open('demo', '&links=seed');
    await lab.chat(OTHER).click();
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Link chat…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Send to chat…' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await lab.chat(LEAD).click();
    await (await chatMenu(lab, 'Send to chat…')).click();
    const dialog = page.getByRole('dialog', { name: 'Send to chat' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'To' }).locator('option:checked')).toHaveText(CHILD);
    const send = dialog.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Message' }).fill('Use this estimate.');
    await send.click();

    await expect(dialog).toHaveCount(0);
    await expect(lab.toast(`Sent to ${CHILD}`)).toBeVisible();
    // The lab's child is idle, so the text was handed over rather than queued.
    await expect(lab.toast(`Queued for ${CHILD}. It is delivered when that chat can take it.`)).toHaveCount(0);

    await lab.sidebar.getByRole('button', { name: 'Show linked chats' }).click();
    await row(lab, CHILD).click();
    await expect(page.getByText('Use this estimate.').first()).toBeVisible();
    lab.expectNoErrors();
  });

  test('both dialogs are keyboard operable and Escape closes them', async ({ lab, page }) => {
    await lab.open('demo', '&links=seed');
    await lab.chat(LEAD).click();
    await (await chatMenu(lab, 'Link chat…')).click();
    const link = page.getByRole('dialog', { name: 'Link chat' });
    await expect(link.getByRole('searchbox', { name: 'Search chats' })).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(link.locator(':focus')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(link).toHaveCount(0);

    await (await chatMenu(lab, 'Send to chat…')).click();
    const send = page.getByRole('dialog', { name: 'Send to chat' });
    await expect(send).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(send).toHaveCount(0);
  });

  test('safe mode disables linking, sending and the preference', async ({ lab, page }) => {
    await lab.open('safe', '&links=seed');
    await lab.chat(LEAD).click();
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Link chat…' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('menuitem', { name: 'Send to chat…' })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    const settings = await lab.openSettings();
    await settings.getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Linked chats' })).toBeDisabled();
  });

  test('the Settings switch turns the preference off and on', async ({ lab, page }) => {
    await lab.open('demo', '&links=seed');
    const settings = await lab.openSettings();
    await settings.getByRole('button', { name: 'General', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Linked chats' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    lab.expectNoErrors();
  });
});
