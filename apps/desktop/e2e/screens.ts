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
  {
    name: 'mcp-form',
    async open(lab) {
      await lab.chat(/File an issue for the broken docs link/).click();
      const card = lab.page.getByRole('article', { name: 'MCP server lab-issues' });
      await card.getByRole('group', { name: 'Requested values' }).getByRole('textbox', { name: 'Title' }).fill('Bug');
      await card.getByRole('button', { name: 'Accept' }).click();
      await expect(card.getByRole('alert').first()).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'script-test',
    async open(lab) {
      const editor = await lab.openPipelines();
      await editor.getByRole('button', { name: 'Add', exact: true }).click();
      await lab.page.getByRole('menuitem', { name: 'Script', exact: true }).click();
      await lab.page.getByRole('button', { name: 'Insert example' }).click();
      const panel = lab.page.getByRole('region', { name: 'Test script' });
      await panel.getByRole('button', { name: 'Test', exact: true }).click();
      await expect(panel.getByRole('status').filter({ hasText: 'A run would succeed' })).toBeVisible({ timeout: 15_000 });
      await panel.scrollIntoViewIfNeeded();
      await settled(lab.page);
    },
  },
  {
    name: 'node-type-change',
    async open(lab) {
      const editor = await lab.openPipelines();
      await editor.getByRole('button', { name: /^Review loop/ }).click();
      await editor.getByRole('application').getByRole('group', { name: 'Developer', exact: true }).click();
      await lab.page.getByRole('button', { name: 'Node type: Agent' }).click();
      await lab.page.getByRole('menuitem', { name: 'Script' }).click();
      await expect(lab.page.getByRole('dialog', { name: 'Change this node to Script?' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'run-inputs',
    async open(lab) {
      const runs = await lab.openRuns();
      await runs.getByRole('button', { name: /^Succeeded Code review/ }).click();
      const run = lab.page.getByRole('region', { name: 'Run' });
      await run.getByRole('application').getByRole('group', { name: 'Planner', exact: true }).click();
      await run.getByRole('button', { name: 'Inputs' }).click();
      await expect(lab.page.getByRole('dialog', { name: 'Run inputs' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'pi-history',
    async open(lab) {
      await lab.sidebar.getByRole('button', { name: 'Options for piui' }).click();
      await lab.page.getByRole('menuitem', { name: 'Pi session history' }).click();
      await lab.page.getByRole('button', { name: /^Make the session index incremental/ }).click();
      await expect(lab.page.getByRole('complementary', { name: 'Session details' }).getByRole('region', { name: 'Branches' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'extension-demo',
    async open(lab) {
      await lab.chat(/Pi extension playground/).click();
      const message = lab.page.getByRole('textbox', { name: 'Message' });
      await message.fill('/extension-demo');
      await message.press('Enter');
      await expect(lab.page.getByRole('heading', { level: 3, name: 'Build a preview?' })).toBeVisible({ timeout: 20_000 });
      await settled(lab.page);
    },
  },
  {
    name: 'run-from-chat',
    async open(lab) {
      await lab.chat(/Route host calls through one transport/).click();
      const message = lab.page.getByRole('textbox', { name: 'Message' });
      await message.fill('/run');
      await message.press('Enter');
      await expect(lab.page.getByRole('dialog', { name: 'Run a pipeline' }).getByRole('button', { name: 'Next…' })).toBeEnabled();
      await settled(lab.page);
    },
  },
  {
    name: 'automation-event',
    async open(lab) {
      const section = await lab.openAutomations();
      await section.getByRole('button', { name: 'New automation' }).click();
      const dialog = lab.page.getByRole('dialog', { name: 'New automation' });
      await dialog.getByRole('group', { name: 'Start' }).getByRole('radio', { name: 'After an event' }).click();
      await dialog.getByRole('group', { name: 'Event' }).getByRole('radio', { name: 'When files change' }).click();
      await dialog.getByRole('button', { name: 'Save, keep paused' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'automations-paused',
    async open(lab) {
      const section = await lab.openAutomations();
      await section.getByRole('button', { name: 'Pause all' }).click();
      await expect(section.getByRole('button', { name: 'Resume automations' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'settings-background',
    async open(lab) {
      const nav = await lab.openSettings();
      await nav.getByRole('button', { name: 'Background' }).click();
      await expect(lab.page.getByRole('switch', { name: 'Pause all automations' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'settings-plugins',
    async open(lab) {
      const nav = await lab.openSettings();
      await nav.getByRole('button', { name: 'Plugins' }).click();
      await expect(lab.page.getByRole('heading', { level: 2, name: 'Plugins' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'settings-extensions',
    async open(lab) {
      const nav = await lab.openSettings();
      await nav.getByRole('button', { name: 'Extensions' }).click();
      await expect(lab.page.getByRole('list', { name: 'Global Pi extensions' })).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'chat-plugin-renderer',
    async open(lab) {
      // Plugins v2: a chat renderer (examples/plugins/tool-cards) for an MCP tool call.
      await lab.chat(/File an issue for the broken docs link/).click();
      await lab.page.getByRole('button', { name: 'Accept' }).click();
      await expect(lab.page.getByText(/I filed/)).toBeVisible();
      const group = lab.page.getByRole('button', { name: /Used 1 tool/ }).last();
      if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
      await expect(lab.page.frameLocator('iframe[title="Issue card (plugin view)"]').getByText('Broken link in the harness guide')).toBeVisible();
      await settled(lab.page);
    },
  },
  {
    name: 'plugin-trust-review',
    async open(lab) {
      const nav = await lab.openSettings();
      await nav.getByRole('button', { name: 'Plugins' }).click();
      await lab.page.getByRole('button', { name: 'Install from .zip…' }).click();
      await expect(lab.page.getByRole('dialog', { name: 'Install Word count?' })).toBeVisible();
      await settled(lab.page);
    },
  },
];
