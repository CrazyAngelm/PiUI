import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

const STORAGE_KEY = 'piui.models.favorites.v1';
const miniKey = JSON.stringify(['openai-lab', 'gpt-lab-5-mini']);
const MODEL_CHIP = /^(Default model|Choose a model)$/;
const codexKey = JSON.stringify(['openai-lab', 'gpt-lab-5-codex']);

function home(page: Page): Locator {
  return page.getByRole('region', { name: 'What should we work on?' });
}

/** Codex is the lab harness with several models; the picker is opened from the composer chip. */
async function openCodexModels(lab: Lab, page: Page): Promise<void> {
  await lab.open();
  const composer = home(page);
  await composer.getByRole('button', { name: 'Pi', exact: true }).click();
  await lab.option(/^Codex/).click();
  await composer.getByRole('button', { name: MODEL_CHIP }).click();
  await expect(page.getByPlaceholder('Search models')).toBeVisible();
  await expect(lab.option(/^GPT Lab 5 Mini/)).toBeVisible();
}

function tabs(page: Page): Locator {
  return page.getByRole('group', { name: 'Models shown' });
}

async function stored(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string[]>, STORAGE_KEY);
}

test.describe('model favorites', () => {
  test('a heart favorites a model without picking it and the choice is remembered', async ({ lab, page }) => {
    await openCodexModels(lab, page);
    // No favorites yet: the list opens on All models and the heart is calm.
    await expect(tabs(page).getByRole('radio', { name: 'All models' })).toHaveAttribute('data-state', 'on');
    const mini = lab.option(/^GPT Lab 5 Mini/);
    await mini.getByTitle('Add to favorites (Shift+Enter)').click();

    // The popover stays open, the model was not picked, and the row now says it is a favorite.
    await expect(mini).toBeVisible();
    await expect(mini.getByTitle('Remove from favorites (Shift+Enter)')).toBeVisible();
    await expect(mini).toContainText('favorite');
    await expect(home(page).getByRole('button', { name: 'Default model' })).toBeVisible();
    expect(await stored(page)).toEqual({ codex: [miniKey] });

    // Reopened, the list starts on Favorites with only that model (the harness default row stays).
    await page.keyboard.press('Escape');
    await home(page).getByRole('button', { name: 'Default model' }).click();
    await expect(tabs(page).getByRole('radio', { name: 'Favorites' })).toHaveAttribute('data-state', 'on');
    await expect(lab.option(/^GPT Lab 5 Mini/)).toBeVisible();
    await expect(lab.option(/^GPT Lab 5 Codex/)).toHaveCount(0);
    await expect(lab.option(/^O Lab Deep Research/)).toHaveCount(0);
    await expect(lab.option(/^Harness default/)).toBeVisible();

    await tabs(page).getByRole('radio', { name: 'All models' }).click();
    await expect(lab.option(/^GPT Lab 5 Codex/)).toBeVisible();
    await expect(lab.option(/^O Lab Deep Research/)).toBeVisible();
    await expect(page.getByPlaceholder('Search models')).toBeFocused();
  });

  test('Shift+Enter flips the favorite of the highlighted row and does not select it', async ({ lab, page }) => {
    await openCodexModels(lab, page);
    const codex = lab.option(/^GPT Lab 5 Codex/);
    await codex.hover();
    const search = page.getByPlaceholder('Search models');
    await search.focus();
    await page.keyboard.press('Shift+Enter');
    await expect(codex.getByTitle('Remove from favorites (Shift+Enter)')).toBeVisible();
    await expect(codex).toBeVisible();
    await expect(home(page).getByRole('button', { name: 'Default model' })).toBeVisible();
    expect(await stored(page)).toEqual({ codex: [codexKey] });

    await page.keyboard.press('Shift+Enter');
    await expect(codex.getByTitle('Add to favorites (Shift+Enter)')).toBeVisible();
    expect(await stored(page)).toEqual({});
  });

  test('a search covers every model whatever the tab, and the arrows switch tabs from an empty search', async ({ lab, page }) => {
    await page.addInitScript(({ key, models }) => localStorage.setItem(key, JSON.stringify({ codex: models })), { key: STORAGE_KEY, models: [miniKey] });
    await openCodexModels(lab, page);
    await expect(tabs(page).getByRole('radio', { name: 'Favorites' })).toHaveAttribute('data-state', 'on');
    const search = page.getByPlaceholder('Search models');
    await search.fill('Deep');
    await expect(lab.option(/^O Lab Deep Research/)).toBeVisible();
    await expect(tabs(page).getByRole('radio', { name: 'All models' })).toHaveAttribute('data-state', 'on');

    await search.fill('');
    await expect(lab.option(/^O Lab Deep Research/)).toHaveCount(0);
    await search.press('ArrowRight');
    await expect(tabs(page).getByRole('radio', { name: 'All models' })).toHaveAttribute('data-state', 'on');
    await expect(lab.option(/^O Lab Deep Research/)).toBeVisible();
    await search.press('ArrowLeft');
    await expect(tabs(page).getByRole('radio', { name: 'Favorites' })).toHaveAttribute('data-state', 'on');
  });

  test('un-favoriting on the Favorites tab keeps the row until the tab changes', async ({ lab, page }) => {
    await page.addInitScript(({ key, models }) => localStorage.setItem(key, JSON.stringify({ codex: models })), { key: STORAGE_KEY, models: [miniKey] });
    await openCodexModels(lab, page);
    const mini = lab.option(/^GPT Lab 5 Mini/);
    await mini.getByTitle('Remove from favorites (Shift+Enter)').click();
    await expect(mini.getByTitle('Add to favorites (Shift+Enter)')).toBeVisible();
    expect(await stored(page)).toEqual({});

    await tabs(page).getByRole('radio', { name: 'All models' }).click();
    await tabs(page).getByRole('radio', { name: 'Favorites' }).click();
    await expect(lab.option(/^GPT Lab 5 Mini/)).toHaveCount(0);
    await expect(page.getByText('No favorites yet')).toBeVisible();
  });

  test('favorites belong to their harness and a broken stored value is ignored', async ({ lab, page }) => {
    await page.addInitScript(({ key }) => localStorage.setItem(key, '{broken'), { key: STORAGE_KEY });
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await lab.option(/^Codex/).click();
    await composer.getByRole('button', { name: MODEL_CHIP }).click();
    await expect(tabs(page).getByRole('radio', { name: 'All models' })).toHaveAttribute('data-state', 'on');
    await lab.option(/^GPT Lab 5 Codex/).getByTitle('Add to favorites (Shift+Enter)').click();
    await page.keyboard.press('Escape');

    // Another harness has no favorites, so it opens on All models.
    await composer.getByRole('button', { name: 'Codex', exact: true }).click();
    await lab.option(/^Pi\b/).click();
    await composer.getByRole('button', { name: MODEL_CHIP }).click();
    await expect(tabs(page).getByRole('radio', { name: 'All models' })).toHaveAttribute('data-state', 'on');
    expect(await stored(page)).toEqual({ codex: [codexKey] });
  });
});
