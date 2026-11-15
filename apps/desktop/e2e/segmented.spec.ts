import { expect, test } from './fixtures';
import type { Locator } from '@playwright/test';

/**
 * A segmented switch always keeps exactly one option selected. The headless
 * toggle group underneath empties itself when the active option is pressed
 * again, so these presses must leave the switch, and the setting behind it,
 * on the same option.
 */
async function expectOnlySelected(group: Locator, name: string, options: number): Promise<void> {
  const radios = group.getByRole('radio');
  await expect(radios).toHaveCount(options);
  const selected = group.getByRole('radio', { checked: true });
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAccessibleName(name);
  await expect(selected).toHaveAttribute('data-state', 'on');
  await expect(group.locator('[role="radio"][data-state="on"]')).toHaveCount(1);
}

test.describe('segmented switch', () => {
  test('keeps the theme selected when the active option is pressed again', async ({ lab, page }) => {
    await lab.open();
    await lab.openSettings();
    const theme = page.getByRole('group', { name: 'Theme', exact: true });
    await expectOnlySelected(theme, 'System', 3);

    await theme.getByRole('radio', { name: 'Dark' }).click();
    await expectOnlySelected(theme, 'Dark', 3);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const dark = theme.getByRole('radio', { name: 'Dark' });
    await dark.click();
    await expectOnlySelected(theme, 'Dark', 3);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await dark.focus();
    await page.keyboard.press('Space');
    await expectOnlySelected(theme, 'Dark', 3);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.keyboard.press('Enter');
    await expectOnlySelected(theme, 'Dark', 3);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // The switch still changes after the repeated presses.
    await theme.getByRole('radio', { name: 'Light' }).click();
    await expectOnlySelected(theme, 'Light', 3);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('keeps the density selected when the active option is pressed again', async ({ lab, page }) => {
    await lab.open();
    await lab.openSettings();
    const density = page.getByRole('group', { name: 'Density', exact: true });
    await expectOnlySelected(density, 'Comfortable', 2);

    await density.getByRole('radio', { name: 'Compact' }).click();
    await expectOnlySelected(density, 'Compact', 2);
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

    const compact = density.getByRole('radio', { name: 'Compact' });
    await compact.click();
    await expectOnlySelected(density, 'Compact', 2);
    await compact.focus();
    await page.keyboard.press('Space');
    await expectOnlySelected(density, 'Compact', 2);
    await page.keyboard.press('Enter');
    await expectOnlySelected(density, 'Compact', 2);
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  });
});
