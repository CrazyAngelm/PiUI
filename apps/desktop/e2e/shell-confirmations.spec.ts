import type { Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

type Confirmation = 'trust' | 'delete' | 'navigation';
const confirmations: readonly Confirmation[] = ['trust', 'delete', 'navigation'];
const moduleRequest = /\/(?:src\/app\/shell\/ShellConfirmations\.svelte|assets\/ShellConfirmations-[^/?]+\.js)(?:\?|$)/;
const draft = 'Keep this draft until an explicit decision';

async function prepare(lab: Lab, page: Page, kind: Confirmation): Promise<void> {
  await lab.open();
  if (kind === 'delete') await lab.chat(/Plan a weekend in Lisbon/).click();
  if (kind === 'navigation') {
    const editor = await lab.openPipelines();
    await editor.getByRole('button', { name: /^Chain/ }).click();
    await editor.getByRole('textbox', { name: 'Pipeline name' }).fill(draft);
    await expect(editor.getByText('Unsaved')).toBeVisible();
  } else {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
  }
}

async function requestConfirmation(lab: Lab, page: Page, kind: Confirmation): Promise<void> {
  if (kind === 'trust') {
    await lab.sidebar.getByRole('button', { name: 'Options for legacy-repo' }).click();
    await page.getByRole('menuitem', { name: 'Trust this folder…' }).click();
  } else if (kind === 'delete') {
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete chat…' }).click();
  } else {
    await lab.nav('Runs').click();
  }
}

async function expectUnchanged(lab: Lab, page: Page, kind: Confirmation): Promise<void> {
  if (kind === 'navigation') {
    await expect(page.getByRole('region', { name: 'Pipeline editor' }).getByRole('textbox', { name: 'Pipeline name' })).toHaveValue(draft);
    await expect(lab.nav('Pipelines')).toHaveAttribute('aria-current', 'page');
  } else {
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);
    if (kind === 'delete') await expect(lab.chat(/Plan a weekend in Lisbon/)).toBeVisible();
  }
}

for (const kind of confirmations) {
  test(`${kind} loads its confirmation on demand and requires an explicit decision`, async ({ lab, page }) => {
    let requests = 0;
    await page.route(moduleRequest, async (route) => {
      if (new URL(route.request().url()).searchParams.get('type') !== 'style') requests += 1;
      await route.continue();
    });
    await prepare(lab, page, kind);
    expect(requests).toBe(0);
    await requestConfirmation(lab, page, kind);
    const title = kind === 'trust' ? 'Trust legacy-repo?' : kind === 'delete' ? 'Delete chat?' : 'Leave the pipeline editor?';
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    const cancel = kind === 'navigation' ? 'Keep editing' : 'Cancel';
    await dialog.getByRole('button', { name: cancel, exact: true }).press('Enter');
    await expect(dialog).toBeHidden();
    await expectUnchanged(lab, page, kind);

    await requestConfirmation(lab, page, kind);
    const confirm = kind === 'trust' ? 'Trust folder' : kind === 'delete' ? 'Delete chat' : 'Discard changes';
    await dialog.getByRole('button', { name: confirm, exact: true }).press('Enter');
    await expect(dialog).toBeHidden();
    if (kind === 'trust') {
      await expect(lab.toast('Folder trusted')).toBeVisible();
      await expectUnchanged(lab, page, kind);
      await lab.sidebar.getByRole('button', { name: 'Options for legacy-repo' }).click();
      await expect(page.getByRole('menuitem', { name: 'Trust this folder…' })).toHaveCount(0);
    } else if (kind === 'delete') {
      await expect(lab.chat(/Plan a weekend in Lisbon/)).toHaveCount(0);
    } else {
      await expect(page.getByRole('navigation', { name: 'Runs' })).toBeVisible();
    }
    expect(requests).toBe(1);
  });
}

test.describe('unavailable confirmation module', () => {
  test.use({ allowConsoleErrors: true });
  for (const kind of confirmations) {
    test(`${kind} failure cancels the request and preserves its owner`, async ({ lab, page }) => {
      let requests = 0;
      await page.route(moduleRequest, async (route) => {
        if (new URL(route.request().url()).searchParams.get('type') === 'style') return route.continue();
        requests += 1;
        await route.abort('failed');
      });
      await prepare(lab, page, kind);
      await requestConfirmation(lab, page, kind);
      await expect(lab.toast('This view could not be loaded')).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
      await expectUnchanged(lab, page, kind);
      const trigger = kind === 'trust'
        ? lab.sidebar.getByRole('button', { name: 'Options for legacy-repo' })
        : kind === 'delete' ? page.getByRole('button', { name: 'Chat actions' }) : lab.nav('Runs');
      await expect(trigger).toBeFocused();

      // A failed module identity is terminal in Chromium. A new intent is also
      // cancelled, without claiming a Retry can recover or performing the action.
      await requestConfirmation(lab, page, kind);
      await expect(page.locator('[data-confirmation-loading]')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expectUnchanged(lab, page, kind);
      expect(requests).toBe(1);
    });
  }
});

test('Escape cancels a held confirmation and its later load does not open a dialog', async ({ lab, page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(moduleRequest, async (route) => {
    if (new URL(route.request().url()).searchParams.get('type') !== 'style') await held;
    await route.continue();
  });
  await prepare(lab, page, 'trust');
  await requestConfirmation(lab, page, 'trust');
  const loading = page.locator('[data-confirmation-loading]');
  await expect(loading).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(loading).toHaveCount(0);
  await expect(lab.sidebar.getByRole('button', { name: 'Options for legacy-repo' })).toBeFocused();
  const loaded = page.waitForResponse(moduleRequest);
  release();
  await loaded;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectUnchanged(lab, page, 'trust');
  await requestConfirmation(lab, page, 'trust');
  await expect(page.getByRole('dialog', { name: 'Trust legacy-repo?' })).toBeVisible();
});

async function holdConfirmations(page: Page): Promise<{ release: () => void; requests: () => number }> {
  let release!: () => void;
  let requests = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(moduleRequest, async (route) => {
    if (new URL(route.request().url()).searchParams.get('type') !== 'style') {
      requests += 1;
      await held;
    }
    await route.continue();
  });
  return { release, requests: () => requests };
}

test('a narrow navigation drawer leaves loading Cancel reachable', async ({ lab, page }) => {
  const held = await holdConfirmations(page);
  try {
    await prepare(lab, page, 'trust');
    // 740 CSS px is inside the supported native width and below the shell's
    // existing 760 px drawer breakpoint, where main is deliberately inert.
    await page.setViewportSize({ width: 740, height: 860 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await requestConfirmation(lab, page, 'trust');
    const loading = page.locator('[data-confirmation-loading]');
    const cancel = loading.getByRole('button', { name: 'Cancel', exact: true });
    await expect(page.getByRole('main', { includeHidden: true })).toHaveAttribute('inert', '');
    // A real hit-tested click must work; force and DOM dispatch would conceal
    // the frame scrim / inert regression this case exercises.
    await cancel.click();
    await expect(loading).toHaveCount(0);
    await expect(lab.sidebar.getByRole('button', { name: 'Options for legacy-repo' })).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close navigation' }).click();
    await expectUnchanged(lab, page, 'trust');
    expect(held.requests()).toBe(1);
  } finally {
    held.release();
  }
});

for (const outcome of ['cancel', 'loaded-dialog'] as const) {
  test(`a second intent sharing the held import restores its own trigger after ${outcome}`, async ({ lab, page }) => {
    const held = await holdConfirmations(page);
    try {
      await prepare(lab, page, 'trust');
      await lab.openSettings();
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
      const card = page.getByRole('article').filter({ hasText: 'legacy-repo' });
      const firstTrigger = card.getByRole('button', { name: 'Review trust…' });
      await firstTrigger.click();
      const loading = page.locator('[data-confirmation-loading]');
      await expect(loading).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(loading).toHaveCount(0);
      await expect(firstTrigger).toBeFocused();

      await requestConfirmation(lab, page, 'trust');
      const secondTrigger = lab.sidebar.getByRole('button', { name: 'Options for legacy-repo' });
      const cancel = loading.getByRole('button', { name: 'Cancel', exact: true });
      await cancel.focus();
      await expect(cancel).toBeFocused();
      if (outcome === 'cancel') {
        await cancel.press('Enter');
      } else {
        held.release();
        const dialog = page.getByRole('dialog', { name: 'Trust legacy-repo?' });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
        await expect(dialog).toBeHidden();
      }
      await expect(loading).toHaveCount(0);
      await expect(secondTrigger).toBeFocused();
      await expect(firstTrigger).not.toBeFocused();
      await expect(card).toContainText('Restricted');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(held.requests()).toBe(1);
      await lab.nav('New chat').click();
      await expectUnchanged(lab, page, 'trust');
    } finally {
      held.release();
    }
  });
}

test('a shortcut replacement keeps the stable trigger while loading Cancel has focus', async ({ lab, page }) => {
  const held = await holdConfirmations(page);
  try {
    await prepare(lab, page, 'navigation');
    const trigger = lab.nav('Runs');
    await requestConfirmation(lab, page, 'navigation');
    const loading = page.locator('[data-confirmation-loading]');
    const cancel = loading.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.focus();
    await expect(cancel).toBeFocused();
    // The dirty editor replaces its pending navigation with a new Home intent,
    // while the loading control remains the active element.
    await page.keyboard.press('Control+n');
    await expect(cancel).toBeFocused();
    await cancel.press('Enter');
    await expect(loading).toHaveCount(0);
    await expectUnchanged(lab, page, 'navigation');
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(held.requests()).toBe(1);
  } finally {
    held.release();
  }
});
