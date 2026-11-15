import { expect, test } from './fixtures';

test('cloud entry names the work location and preserves the local chat', async ({ lab, page }) => {
  await lab.open('demo', '&nano=signed-in');
  await lab.chat('Plan a weekend in Lisbon').click();
  const location = lab.rail.getByRole('group', { name: 'Work location', exact: true });
  await expect(location).toHaveText('');
  await expect(location.getByRole('img', { name: 'This computer' })).toHaveAttribute('aria-current', 'location');
  await test.info().attach('work-location-icons', { body: await location.screenshot(), contentType: 'image/png' });
  await location.getByRole('button', { name: 'Open Nano Cloud' }).press('Enter');
  await expect(page.getByText('Opening Nano Cloud…', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation messages' })).toBeVisible();
  await expect(location.getByRole('img', { name: 'This computer' })).toHaveAttribute('aria-current', 'location');

  for (const [scenario, account] of [['demo', 'signed-out'], ['demo', 'free'], ['safe', 'signed-in']] as const) {
    await lab.open(scenario, `&nano=${account}`);
    await expect(location).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open Nano Cloud' })).toHaveCount(0);
    await expect(lab.nav('New chat')).toBeVisible();
  }
});
