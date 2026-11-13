import { expect, test } from './fixtures';

test('server avatar decoration follows entitlement, preference and sign-out across native chats', async ({ lab, page }) => {
  const requests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname.endsWith('nanoagents.ru') || url.pathname.endsWith('atlas.small.webp')) requests.push(url.href);
  });
  await lab.open('demo', '&nano=signed-in');
  await lab.chat('Plan a weekend in Lisbon').click();
  await expect(page.getByRole('region', { name: 'Conversation messages' })).toBeVisible();
  const pet = page.locator('canvas.pet');
  await expect(pet).toBeVisible();
  await expect(pet).toHaveAttribute('aria-hidden', 'true');

  let sections = await lab.openSettings();
  await sections.getByRole('button', { name: 'Nano account' }).press('Enter');
  const toggle = page.getByRole('switch', { name: 'Show Nano avatar' });
  await expect(toggle).toBeChecked();
  await toggle.press('Space');
  await lab.chat('Plan a weekend in Lisbon').click();
  await expect(pet).toHaveCount(0);

  sections = await lab.openSettings();
  await sections.getByRole('button', { name: 'Nano account' }).press('Enter');
  await toggle.press('Space');
  await lab.chat('Explain Rust lifetimes').click();
  await expect(pet).toBeVisible();
  sections = await lab.openSettings();
  await sections.getByRole('button', { name: 'Nano account' }).press('Enter');
  await page.getByRole('button', { name: 'Sign out', exact: true }).press('Enter');
  await expect(toggle).toHaveCount(0);
  await lab.chat('Explain Rust lifetimes').click();
  await expect(pet).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Conversation messages' })).toBeVisible();

  for (const [scenario, account] of [['demo', 'free'], ['safe', 'signed-in']] as const) {
    await lab.open(scenario, `&nano=${account}`);
    const nav = await lab.openSettings();
    await nav.getByRole('button', { name: 'Nano account' }).press('Enter');
    await expect(toggle).toHaveCount(0);
    await expect(pet).toHaveCount(0);
  }
  expect(requests).toEqual([]);
});
