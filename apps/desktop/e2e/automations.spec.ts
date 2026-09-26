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
    const pipeline = dialog.getByRole('combobox', { name: 'Pipeline to run' });
    await expect(pipeline).toHaveValue(/.+/);
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Code review');
    // Until it is typed, the name follows the pipeline; other choices are kept.
    await dialog.getByRole('button', { name: 'Saturday', exact: true }).click();
    await pipeline.selectOption({ label: 'Release check' });
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Release check');
    await expect(dialog.getByRole('button', { name: 'Saturday', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await pipeline.selectOption({ label: 'Code review' });
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

  test('an "after an event" rule is checked and previewed before it saves', async ({ lab, page }) => {
    await lab.open();
    const section = await lab.openAutomations();
    await section.getByRole('button', { name: 'New automation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New automation' });
    await dialog.getByRole('combobox', { name: 'Pipeline to run' }).selectOption({ label: 'Release check' });
    await dialog.getByRole('group', { name: 'Start' }).getByRole('radio', { name: 'After an event' }).click();
    await expect(dialog.getByRole('group', { name: 'When', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('group', { name: 'Event' }).getByRole('radio', { name: 'When a pipeline finishes' })).toBeChecked();

    // Waiting for itself is allowed but warned about.
    const source = dialog.getByRole('combobox', { name: 'Pipeline to wait for' });
    await source.selectOption({ label: 'Release check' });
    await expect(dialog.getByRole('status').filter({ hasText: 'This automation starts the pipeline it waits for' })).toBeVisible();
    await source.selectOption({ label: 'Code review' });
    await expect(dialog.getByRole('status').filter({ hasText: 'This automation starts the pipeline it waits for' })).toHaveCount(0);
    await expect(dialog.getByText('When Code review succeeds, PiUI starts Release check.')).toBeVisible();
    await expect(dialog.getByText(/^At most one run every 30 s\./)).toBeVisible();

    // No result chosen: no preview, and saving is refused.
    const outcomes = dialog.getByRole('group', { name: 'Start when that pipeline' });
    await outcomes.getByRole('checkbox', { name: 'Succeeds' }).click();
    await expect(dialog.getByText(/PiUI starts Release check/)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save, keep paused' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Choose at least one result.');
    await outcomes.getByRole('checkbox', { name: 'Succeeds' }).click();
    await outcomes.getByRole('checkbox', { name: 'Fails' }).click();
    await expect(dialog.getByText('When Code review succeeds or fails, PiUI starts Release check.')).toBeVisible();

    // Files: a pattern and a quiet period in range are required.
    await dialog.getByRole('group', { name: 'Event' }).getByRole('radio', { name: 'When files change' }).click();
    await dialog.getByRole('button', { name: 'Save, keep paused' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Add at least one file pattern.');
    await dialog.getByRole('textbox', { name: 'Files to watch' }).fill('src/**/*.ts');
    const quiet = dialog.getByRole('textbox', { name: 'Wait until files are quiet for' });
    await quiet.fill('1');
    await dialog.getByRole('button', { name: 'Save, keep paused' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Wait between 2 and 3600 seconds.');
    await quiet.fill('30');
    await expect(dialog.getByText('PiUI starts Release check 30 s after matching files stop changing.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save and turn on' }).click();
    await expect(dialog).toBeHidden();

    const card = section.getByRole('listitem').filter({ hasText: 'Release check · When src/**/*.ts changes' });
    await expect(card).toContainText('On');
  });

  test('Pause all stops every automation until it is resumed', async ({ lab, page }) => {
    await lab.open();
    const section = await lab.openAutomations();
    await section.getByRole('button', { name: 'Pause all' }).click();
    const banner = section.getByRole('status').filter({ hasText: 'All automations are paused. Nothing starts until you resume them.' });
    await expect(banner).toBeVisible();
    await expect(section.getByRole('button', { name: 'Pause all' })).toHaveCount(0);

    // Settings → Background shows and changes the same switch.
    const sections = await lab.openSettings();
    await sections.getByRole('button', { name: 'Background' }).click();
    const pauseSwitch = page.getByRole('switch', { name: 'Pause all automations' });
    await expect(pauseSwitch).toBeChecked();
    await pauseSwitch.click();
    await expect(pauseSwitch).not.toBeChecked();
    await lab.openAutomations();
    await expect(banner).toHaveCount(0);
    await section.getByRole('button', { name: 'Pause all' }).click();
    await banner.getByRole('button', { name: 'Resume automations' }).click();
    await expect(banner).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Pause all' })).toBeVisible();
  });
});
