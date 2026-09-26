import { test as base, expect, type ConsoleMessage, type Locator, type Page } from '@playwright/test';

/**
 * Shared helpers for the UI Lab specs. Every test gets a fresh browser context,
 * so the in-memory lab host, localStorage and theme start from the scenario
 * seed. Locators are semantic (role + accessible name) so the specs survive
 * restyling; add an accessible name to a component instead of a CSS selector.
 */
export type LabScenario = 'demo' | 'empty' | 'safe' | 'long';

/** Lazy views load their chunks on first use; a cold dev server transforms them first. */
const LAZY_VIEW_MS = 30_000;

/** Browser noise that is not an application error. */
const PLUGIN_FRAME = /^https?:\/\/piui-plugin\.localhost(?::\d+)?\//;

function ignorable(message: ConsoleMessage): boolean {
  // Vite's dev server has no favicon; the desktop app never requests one.
  if (message.location().url.endsWith('/favicon.ico')) return true;
  // A plugin panel is a third-party page in a sandboxed frame: its own policy
  // refusing a request (a plugin's or axe's stylesheet preload) is the
  // isolation working, not a PiUI error.
  const refused = /Content Security Policy/.test(message.text()) ? (message.text().match(/https?:\/\/[^'"\s]+/)?.[0] ?? '') : '';
  return PLUGIN_FRAME.test(message.location().url) || PLUGIN_FRAME.test(refused);
}

export class Lab {
  readonly errors: string[] = [];

  constructor(readonly page: Page) {
    page.on('pageerror', (error) => this.errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !ignorable(message)) this.errors.push(`console: ${message.text()}`);
    });
  }

  /** Opens the lab and waits for the shell (sidebar and first view) to render. */
  async open(scenario: LabScenario = 'demo'): Promise<void> {
    await this.page.goto(`/?lab=${scenario}`);
    await expect(this.sidebar).toBeVisible({ timeout: LAZY_VIEW_MS });
    await expect(this.main).toBeVisible();
  }

  get sidebar(): Locator {
    return this.page.getByRole('navigation', { name: 'Workspace navigation' });
  }

  get main(): Locator {
    return this.page.getByRole('main');
  }

  /** A primary sidebar entry by its visible label (the shortcut hint is part of the name). */
  nav(label: 'New chat' | 'Search' | 'Inbox' | 'Pipelines' | 'Runs' | 'Automations' | 'Settings'): Locator {
    // The name carries the shortcut hint ("New chat Ctrl+N") or a count ("Inbox 1 waiting").
    return this.sidebar.getByRole('button', { name: new RegExp(`^${label}(?: Ctrl\\+\\S+| \\d+ waiting)?$`) });
  }

  /** A chat row in the sidebar project tree. */
  chat(title: string | RegExp): Locator {
    return this.sidebar.getByRole('listitem').getByRole('button', { name: title }).first();
  }

  /** An option of the open picker popover. */
  option(name: string | RegExp): Locator {
    return this.page.getByRole('option', { name });
  }

  /** A toast: failures are alerts, confirmations are status messages. */
  toast(text: string | RegExp): Locator {
    return this.page.getByRole('alert').or(this.page.getByRole('status')).filter({ hasText: text });
  }

  async openPipelines(): Promise<Locator> {
    await this.nav('Pipelines').click();
    const editor = this.page.getByRole('region', { name: 'Pipeline editor' });
    await expect(editor).toBeVisible({ timeout: LAZY_VIEW_MS });
    return editor;
  }

  async openRuns(): Promise<Locator> {
    await this.nav('Runs').click();
    const runs = this.page.getByRole('navigation', { name: 'Runs' });
    await expect(runs).toBeVisible({ timeout: LAZY_VIEW_MS });
    return runs;
  }

  async openAutomations(): Promise<Locator> {
    await this.nav('Automations').click();
    const section = this.page.getByRole('region', { name: 'Automations' });
    await expect(section).toBeVisible({ timeout: LAZY_VIEW_MS });
    return section;
  }

  async openSettings(): Promise<Locator> {
    await this.nav('Settings').click();
    const settings = this.page.getByRole('navigation', { name: 'Settings sections' });
    await expect(settings).toBeVisible({ timeout: LAZY_VIEW_MS });
    return settings;
  }

  /** Fails the test when the page logged an application error. */
  expectNoErrors(): void {
    expect(this.errors, 'console errors or uncaught exceptions').toEqual([]);
  }
}

interface LabOptions {
  /** Opt out of the console-error check for tests that provoke host failures on purpose. */
  allowConsoleErrors: boolean;
}

export const test = base.extend<{ lab: Lab } & LabOptions>({
  allowConsoleErrors: [false, { option: true }],
  lab: async ({ page, allowConsoleErrors }, use) => {
    const lab = new Lab(page);
    await use(lab);
    if (!allowConsoleErrors) lab.expectNoErrors();
  },
});

export { expect };
