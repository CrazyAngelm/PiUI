import type { Page } from '@playwright/test';
import { expect, type Lab } from './fixtures';

/**
 * The main screens, reached through the UI the way a person would. Shared by
 * the accessibility audit and the light/dark screenshots.
 */
export interface Screen {
  readonly name: string;
  open(lab: Lab): Promise<void>;
}

async function settled(page: Page): Promise<void> {
  // Let entry animations and lazy views finish before auditing or capturing.
  await page.waitForTimeout(400);
}

export const SCREENS: readonly Screen[] = [
  {
    name: 'home',
    async open(lab) {
      await expect(lab.page.getByRole('heading', { level: 1, name: 'What should we work on?' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'chat',
    async open(lab) {
      await lab.chat(/Fix flaky scheduler test/).click();
      await expect(lab.page.getByRole('article', { name: 'Permission request' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'chat-details',
    async open(lab) {
      await lab.chat(/Route host calls through one transport/).click();
      await lab.page.getByRole('button', { name: 'Details' }).click();
      await expect(lab.page.getByRole('complementary', { name: 'Chat details' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'inbox',
    async open(lab) {
      await lab.nav('Inbox').click();
      await expect(lab.page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'pipeline-editor',
    async open(lab) {
      const editor = await lab.openPipelines();
      await editor.getByRole('button', { name: /^Review loop/ }).click();
      await editor.getByRole('application').getByRole('group', { name: 'Reviewer', exact: true }).click();
      await expect(lab.page.getByRole('complementary', { name: 'Node settings' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'pipeline-script',
    async open(lab) {
      const editor = await lab.openPipelines();
      await editor.getByRole('button', { name: 'Add', exact: true }).click();
      await lab.page.getByRole('menuitem', { name: 'Script', exact: true }).click();
      await lab.page.getByRole('button', { name: 'Insert example' }).click();
      await settled(lab.page);
    },
  },
  {
    name: 'runs',
    async open(lab) {
      const runs = await lab.openRuns();
      await runs.getByRole('button', { name: /^Succeeded Code review/ }).click();
      const run = lab.page.getByRole('region', { name: 'Run' });
      await run.getByRole('application').getByRole('group', { name: 'Reviewer', exact: true }).click();
      await expect(lab.page.getByRole('tablist', { name: 'Step details' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'automations',
    async open(lab) {
      await lab.openAutomations();
      await settled(lab.page);
    },
  },
  {
    name: 'automation-dialog',
    async open(lab) {
      const section = await lab.openAutomations();
      await section.getByRole('button', { name: 'New automation' }).click();
      await expect(lab.page.getByRole('dialog', { name: 'New automation' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'settings',
    async open(lab) {
      await lab.openSettings();
      await settled(lab.page);
    },
  },
  {
    name: 'settings-harnesses',
    async open(lab) {
      const nav = await lab.openSettings();
      await nav.getByRole('button', { name: 'Harnesses' }).click();
      await expect(lab.page.getByRole('heading', { level: 2, name: 'Harnesses' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'palette',
    async open(lab) {
      await lab.page.keyboard.press('Control+k');
      await expect(lab.page.getByRole('dialog', { name: 'Search and commands' })).toBeVisible();
      await settled(lab.page);
    },
  },
];
