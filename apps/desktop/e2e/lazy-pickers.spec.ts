import { expect, test } from './fixtures';

test('a cold executor panel loads on open, can close while loading and reopens with search focus', async ({ lab, page }) => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let requests = 0;
  await page.route(/\/PickerPanel\.svelte(?:\?|$)/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('type') === 'style') return route.continue();
    requests += 1;
    await held;
    await route.continue();
  });
  await lab.open();
  const home = page.getByRole('region', { name: 'What should we work on?' });
  const trigger = home.getByRole('button', { name: 'Pi', exact: true });
  await expect(trigger).toBeEnabled();
  expect(requests).toBe(0);
  await trigger.press('Enter');
  await expect(page.getByRole('status', { name: 'Who answers' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  const response = page.waitForResponse(/\/PickerPanel\.svelte(?:\?|$)/);
  release();
  await response;
  await home.getByRole('textbox').fill('Keep the editor focused');
  await expect(home.getByRole('textbox')).toBeFocused();
  await trigger.click();
  await expect(page.getByPlaceholder('Search teammates, harnesses and pipelines')).toBeFocused();
  await lab.option(/^Codex/).click();
  await expect(home.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
  expect(requests).toBe(1);
});

test('a cold model panel focuses search and preserves keyboard favorites after reopening', async ({ lab, page }) => {
  let requests = 0;
  await page.route(/\/ModelPickerPanel\.svelte(?:\?|$)/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('type') === 'style') return route.continue();
    requests += 1;
    await route.continue();
  });
  await lab.open();
  const home = page.getByRole('region', { name: 'What should we work on?' });
  await home.getByRole('button', { name: 'Pi', exact: true }).click();
  await lab.option(/^Codex/).click();
  const trigger = home.getByRole('button', { name: /^(Default model|Choose a model)$/ });
  expect(requests).toBe(0);
  await trigger.press('Enter');
  const search = page.getByPlaceholder('Search models');
  await expect(search).toBeFocused();
  await search.fill('GPT Lab 5 Mini');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+Enter');
  await expect(lab.option(/^GPT Lab 5 Mini/)).toContainText('favorite');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(search).toBeFocused();
  await expect(page.getByRole('radio', { name: 'Favorites', exact: true })).toHaveAttribute('data-state', 'on');
  await expect(lab.option(/^GPT Lab 5 Mini/)).toBeVisible();
  expect(requests).toBe(1);
});

test.describe('a failed picker chunk', () => {
  test.use({ allowConsoleErrors: true });
  test('shows a keyboard retry and recovers without losing the draft', async ({ lab, page }) => {
    let requests = 0;
    await page.route(/\/ModelPickerPanel\.svelte(?:\?|$)/, async (route) => {
      if (new URL(route.request().url()).searchParams.get('type') === 'style') return route.continue();
      requests += 1;
      if (requests === 1) await route.abort('failed');
      else await route.continue();
    });
    await lab.open();
    const home = page.getByRole('region', { name: 'What should we work on?' });
    await home.getByRole('textbox').fill('Draft survives a missing panel chunk');
    await home.getByRole('button', { name: /^(Default model|Choose a model)$/ }).click();
    await expect(page.getByText('This view could not be loaded', { exact: true })).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeFocused();
    await retry.press('Enter');
    await expect(page.getByPlaceholder('Search models')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(home.getByRole('textbox')).toHaveValue('Draft survives a missing panel chunk');
    expect(requests).toBe(2);
  });
});
