import { expect, test } from './fixtures';

const WEEKDAY = /^(Monday|Tuesday|Wednesday|Thursday|Friday),/;

test.describe('automations', () => {
  test('a weekday calendar schedule previews, saves, turns off and on', async ({ lab, page }) => {
    await lab.open();
    const section = await lab.openAutomations();
    await expect(section.getByRole('listitem').filter({ hasText: 'Nightly code review' })).toContainText('On');

    await section.getByRole('button', { name: 'New automation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New automation' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Pipeline' })).toHaveValue(/.+/);
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Code review');
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Weekday review');
    await expect(dialog.getByRole('group', { name: 'When' }).getByRole('radio', { name: 'On days' })).toBeChecked();

    await dialog.getByRole('button', { name: 'Weekdays', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Weekdays', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
      await expect(dialog.getByRole('button', { name: day, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    for (const day of ['Saturday', 'Sunday']) {
      await expect(dialog.getByRole('button', { name: day, exact: true })).toHaveAttribute('aria-pressed', 'false');
    }
    await dialog.getByLabel('Time', { exact: true }).fill('09:00');
    const preview = dialog.getByText(/^Next run: /);
    await expect(preview).toBeVisible();
    const next = (await preview.innerText()).replace(/^Next run: /, '');
    expect(next).toMatch(WEEKDAY);
    expect(next).toContain('09:00');

    // The pipeline asks for an input on every run; saving without it is refused.
    await dialog.getByRole('button', { name: 'Save and turn on' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Fill in the pipeline inputs below.' })).toBeVisible();
    const input = dialog.getByRole('textbox', { name: 'What should be reviewed?' });
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByRole('alert').filter({ hasText: 'This input is required.' })).toBeVisible();
    await input.fill('Review yesterday’s merges.');
    await dialog.getByRole('button', { name: 'Save and turn on' }).click();
    await expect(dialog).toBeHidden();

    const card = section.getByRole('listitem').filter({ hasText: 'Weekday review' });
    await expect(card).toContainText('Code review · Weekdays at 09:00');
    await expect(card).toContainText('On');
    await expect(card).toContainText(/Next: /);
    const toggle = card.getByRole('switch');
    await expect(toggle).toHaveAccessibleName('Turn off Weekday review');
    await toggle.click();
    await expect(card).toContainText('Off');
    await expect(card).toContainText('Turn it on to schedule the next run.');
    await expect(toggle).toHaveAccessibleName('Turn on Weekday review');
    await toggle.click();
    await expect(card).toContainText('On');
  });

  test('an invalid time or an empty day set is refused and the dialog stays open', async ({ lab, page }) => {
    await lab.open();
    const section = await lab.openAutomations();
    await section.getByRole('button', { name: 'New automation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New automation' });
    await dialog.getByRole('textbox', { name: 'What should be reviewed?' }).fill('Review the merges.');

    const time = dialog.getByLabel('Time', { exact: true });
    await time.fill('');
    await expect(dialog.getByText(/^Next run: /)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save, keep paused' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Choose a time.');
    await expect(dialog).toBeVisible();

    await time.fill('18:30');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      const button = dialog.getByRole('button', { name: day, exact: true });
      if ((await button.getAttribute('aria-pressed')) === 'true') await button.click();
    }
    await dialog.getByRole('button', { name: 'Save, keep paused' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Choose at least one day.');

    await dialog.getByRole('button', { name: 'Saturday', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save, keep paused' }).click();
    await expect(dialog).toBeHidden();
    const card = section.getByRole('listitem').filter({ hasText: 'Code review · Sat at 18:30' });
    await expect(card).toContainText('Off');
  });
});
