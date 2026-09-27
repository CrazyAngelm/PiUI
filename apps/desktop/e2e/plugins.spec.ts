import type { Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * Plugins v1 (ADR-032) in the UI Lab: the trust review before an install,
 * enabling and disabling, a palette command and a composer action that only
 * prepare text, the sandboxed panel frame on the plugin origin (served by
 * the lab's dev-server stand-in for the host protocol), a plugin node in the
 * pipeline editor, and safe mode. Nothing runs outside the lab host.
 */
async function openPlugins(lab: Lab, page: Page, scenario: 'demo' | 'safe' = 'demo') {
  await lab.open(scenario);
  await lab.openSettings();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Plugins' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Plugins' })).toBeVisible();
}

const card = (page: Page, name: string) => page.getByRole('article', { name, exact: true });

/** Opens the finished issue-tracker tool call of the "File an issue" lab chat. */
async function expandFinishedTool(page: Page): Promise<void> {
  await expect(page.getByText(/I filed/)).toBeVisible();
  const group = page.getByRole('button', { name: /Used 1 tool/ }).last();
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
}

test.describe('plugins', () => {
  test('a package installs only after its trust review', async ({ lab, page }) => {
    await openPlugins(lab, page);
    await expect(card(page, 'Hello command')).toContainText('Active');
    await expect(card(page, 'Broken sample').getByRole('button', { name: 'Restart backend' })).toBeVisible();

    // Cancelling the review installs nothing.
    await page.getByRole('button', { name: 'Install from folder…' }).click();
    let review = page.getByRole('dialog', { name: 'Install Word count?' });
    await expect(review).toBeVisible();
    await review.getByRole('button', { name: 'Cancel' }).click();
    await expect(review).toBeHidden();
    await expect(card(page, 'Word count')).toHaveCount(0);

    await page.getByRole('button', { name: 'Install from .zip…' }).click();
    review = page.getByRole('dialog', { name: 'Install Word count?' });
    await expect(review).toContainText('From Lab Tools · version 0.3.0');
    // Every permission in plain words, the exact backend command line and the honest limits.
    await expect(review.getByRole('listitem').filter({ hasText: 'Add commands to the command palette and the message box' })).toBeVisible();
    await expect(review.getByRole('listitem').filter({ hasText: 'See the title of the open chat' })).toBeVisible();
    await expect(review.getByRole('region', { name: 'Backend command' })).toContainText('node.exe');
    await expect(review.getByRole('note')).toContainText('Plugins are not a sandbox.');
    await review.getByRole('button', { name: 'Install and enable' }).click();
    await expect(review).toBeHidden();
    await expect(lab.toast('Plugin installed')).toBeVisible();
    await expect(card(page, 'Word count')).toContainText('Active');

    // The same package again is reported, not installed twice.
    await page.getByRole('button', { name: 'Install from .zip…' }).click();
    const again = page.getByRole('dialog', { name: 'Word count is already installed' });
    await expect(again).toBeVisible();
    await expect(again.getByRole('button', { name: 'Install and enable' })).toHaveCount(0);
    await again.getByRole('button', { name: 'Close' }).first().click();
    await expect(again).toBeHidden();
  });

  test('switching a plugin off removes its commands and its panel', async ({ lab, page }) => {
    await openPlugins(lab, page);
    const toggle = card(page, 'Hello command').getByRole('switch', { name: 'Enable Hello command' });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(card(page, 'Hello command')).toContainText('Disabled');

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    await palette.getByPlaceholder('Search chats, projects and commands…').fill('say hello');
    await expect(palette.getByRole('option', { name: /Say hello/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(card(page, 'Hello command')).toContainText('Active');
  });

  test('palette commands and composer actions prepare text but never send it', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Plan a weekend in Lisbon/).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Plan a weekend in Lisbon' })).toBeVisible();

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    await palette.getByPlaceholder('Search chats, projects and commands…').fill('say hello');
    await palette.getByRole('option', { name: /Say hello/ }).click();
    await expect(palette).toBeHidden();
    await expect(lab.toast('Hello to “Plan a weekend in Lisbon” from the Hello command plugin!')).toBeVisible();

    // A composer action fills the empty message box; nothing is sent.
    const actions = page.getByRole('group', { name: 'Plugin actions' });
    await actions.getByRole('button', { name: 'Thank the agent' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(/^Thanks! That looks right\./);
    await expect(page.getByRole('button', { name: 'Stop turn' })).toHaveCount(0);

    // The broken sample fails in a toast; the app keeps working.
    await page.keyboard.press('Control+k');
    await palette.getByPlaceholder('Search chats, projects and commands…').fill('broken check');
    await palette.getByRole('option', { name: /Run the broken check/ }).click();
    await expect(lab.toast('Broken sample could not run the command')).toContainText("The plugin's backend keeps stopping.");
    await expect(page.getByRole('heading', { level: 1, name: 'Plan a weekend in Lisbon' })).toBeVisible();
  });

  test('a panel runs in a sandboxed frame on the plugin origin and talks only through the bridge', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Plan a weekend in Lisbon/).click();
    const documentResponse = page.waitForResponse((response) => response.url().includes('/example.hello-command/ui/index.html'));
    await page.getByRole('button', { name: 'Details' }).click();
    const details = page.getByRole('complementary', { name: 'Chat details' });
    const panel = details.getByRole('region', { name: /Hello panel/ });
    await expect(panel).toBeVisible();

    const frame = panel.locator('iframe');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).toHaveAttribute('title', 'Hello panel (plugin panel)');
    expect(await frame.getAttribute('src')).toMatch(/^http:\/\/piui-plugin\.localhost(?::\d+)?\/example\.hello-command\/ui\/index\.html\?panel=hello$/);
    const policy = (await documentResponse).headers()['content-security-policy'] ?? '';
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain('sandbox allow-scripts');

    // The panel got its context over the bridge (it has chat.read) and can run its command.
    const content = page.frameLocator('iframe[title="Hello panel (plugin panel)"]');
    await expect(content.getByText('Open chat: Plan a weekend in Lisbon')).toBeVisible();
    await expect(content.getByText('Greeting: Hello')).toBeVisible();
    await content.getByRole('button', { name: 'Say hello' }).click();
    await expect(lab.toast('Hello to “Plan a weekend in Lisbon” from the Hello command plugin!')).toBeVisible();
    // A setting stored through the bridge is checked by the host like the Settings form.
    await content.getByRole('button', { name: 'Use “Hi”' }).click();
    await expect(content.getByText('Greeting: Hi')).toBeVisible();
  });

  test.describe('isolation', () => {
    test('the panel frame has an opaque origin, no PiUI document, no Tauri bridge and no network', async ({ lab, page }) => {
      // The browser reports the blocked connection below; the lab fixture
      // treats plugin-frame policy reports as expected, so collect them here.
      const reports: string[] = [];
      page.on('console', (message) => {
        if (/Content Security Policy/.test(message.text())) reports.push(message.text());
      });
      await lab.open();
      await lab.chat(/Plan a weekend in Lisbon/).click();
      await page.getByRole('button', { name: 'Details' }).click();
      const content = page.frameLocator('iframe[title="Hello panel (plugin panel)"]');
      await expect(content.getByText('Open chat: Plan a weekend in Lisbon')).toBeVisible();
      const child = page.frames().find((candidate) => candidate.url().includes('/example.hello-command/ui/'));
      expect(child).toBeDefined();
      const isolation = await child!.evaluate(async () => {
        let parent = 'readable';
        try {
          void window.parent.document.title;
        } catch {
          parent = 'blocked';
        }
        let network = 'allowed';
        try {
          await fetch('/example.hello-command/ui/panel.css');
        } catch {
          network = 'blocked';
        }
        return { origin: window.origin, parent, network, tauri: '__TAURI_INTERNALS__' in window };
      });
      expect(isolation).toEqual({ origin: 'null', parent: 'blocked', network: 'blocked', tauri: false });
      // It was the panel's own policy that refused the request.
      await expect.poll(() => reports.some((report) => report.includes("connect-src 'none'"))).toBe(true);
    });
  });

  test('a plugin node joins the pipeline editor with a generated settings form', async ({ lab, page }) => {
    await lab.open();
    const editor = await lab.openPipelines();
    // Plugin templates sit next to the built-in ones.
    await expect(editor.getByRole('button', { name: /^Draft and critique/ })).toBeVisible();
    await editor.getByRole('button', { name: /^Review loop/ }).click();
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'JSON transform' }).click();

    const inspector = page.getByRole('complementary', { name: 'Node settings' });
    await expect(inspector.getByRole('tab', { name: 'Plugin node' })).toHaveAttribute('aria-selected', 'true');
    await expect(inspector.getByRole('note')).toContainText("Runs in the plugin's backend on this computer");
    const form = inspector.getByRole('group', { name: 'Node configuration' });
    await expect(form.getByRole('textbox', { name: 'Keep fields' })).toBeVisible();
    await form.getByRole('textbox', { name: 'Keep fields' }).fill('changes');
    await form.getByRole('textbox', { name: 'Wrap in field' }).fill('summary');
    await expect(form.getByRole('textbox', { name: 'Keep fields' })).toHaveValue('changes');
    await expect(editor.getByRole('application').getByRole('group', { name: 'JSON transform', exact: true })).toBeVisible();
  });

  test('the review, a plugin switch and a plugin command work from the keyboard', async ({ lab, page }) => {
    await openPlugins(lab, page);
    await page.getByRole('button', { name: 'Install from folder…' }).focus();
    await page.keyboard.press('Enter');
    const review = page.getByRole('dialog', { name: 'Install Word count?' });
    await expect(review).toBeVisible();
    await expect(review.locator(':focus')).toHaveCount(1);
    // Escape is Cancel: nothing is installed and focus returns to the page.
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();
    await expect(card(page, 'Word count')).toHaveCount(0);

    const toggle = card(page, 'Hello command').getByRole('switch', { name: 'Enable Hello command' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();

    const details = card(page, 'Hello command').getByText('Permissions and backend');
    await details.focus();
    await page.keyboard.press('Enter');
    await expect(card(page, 'Hello command').getByRole('listitem').filter({ hasText: 'Show panels in chat details' })).toBeVisible();

    await lab.chat(/Plan a weekend in Lisbon/).click();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Search and commands' }).getByPlaceholder('Search chats, projects and commands…').fill('say hello');
    await page.keyboard.press('Enter');
    await expect(lab.toast('Hello to “Plan a weekend in Lisbon” from the Hello command plugin!')).toBeVisible();
  });

  test('a status item and keybindings run their plugin commands and leave with the plugin (v2)', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/Plan a weekend in Lisbon/).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Plan a weekend in Lisbon' })).toBeVisible();
    const status = page.getByRole('contentinfo', { name: 'Plugin status items' });
    const item = status.getByRole('button', { name: "Show the open chat's title (Status tools plugin) (plugin Status tools)" });
    await expect(item).toHaveText('Chat title');
    await item.click();
    await expect(lab.toast('“Plan a weekend in Lisbon” (5 words)')).toBeVisible();

    // A keybinding prepares text in the message box for review; nothing is sent.
    await page.getByRole('textbox', { name: 'Message' }).click();
    await page.keyboard.press('Control+Alt+Shift+KeyK');
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(/^Please keep the next answer short/);
    await expect(page.getByRole('button', { name: 'Stop turn' })).toHaveCount(0);

    // Settings lists the shortcuts; switching the plugin off removes the item and the bindings.
    await lab.openSettings();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Plugins' }).click();
    const plugin = card(page, 'Status tools');
    await plugin.getByText('Permissions and backend').click();
    await expect(plugin.getByRole('listitem').filter({ hasText: 'Ask for a short answer' })).toBeVisible();
    await expect(plugin.getByRole('listitem').filter({ hasText: 'Show items in the status bar' })).toBeVisible();
    await plugin.getByRole('switch', { name: 'Enable Status tools' }).click();
    await expect(plugin).toContainText('Disabled');
    await expect(status).toHaveCount(0);
  });

  test('a chat renderer shows a tool in a sandboxed frame and the plain view stays one click away (v2)', async ({ lab, page }) => {
    await lab.open();
    await lab.chat(/File an issue for the broken docs link/).click();
    // The MCP tool call becomes visible once its request is accepted.
    await page.getByRole('button', { name: 'Accept' }).click();
    await expandFinishedTool(page);
    const views = page.getByRole('group', { name: 'How to show this tool' });
    await expect(views.getByRole('button', { name: 'Issue card (plugin Tool cards)' })).toHaveAttribute('aria-pressed', 'true');
    const frame = page.locator('iframe[title="Issue card (plugin view)"]');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(await frame.getAttribute('src')).toMatch(/\/example\.tool-cards\/ui\/index\.html\?renderer=issue$/);
    // The card gets the activity as data over the bridge and sizes itself.
    const issueCard = page.frameLocator('iframe[title="Issue card (plugin view)"]');
    await expect(issueCard.getByRole('heading', { name: 'lab-issues.create_issue' })).toBeVisible();
    await expect(issueCard.getByText('Broken link in the harness guide')).toBeVisible();
    await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeLessThan(200);

    // The generic view is one click away and needs nothing from the plugin.
    await views.getByRole('button', { name: 'Plain view' }).click();
    await expect(frame).toHaveCount(0);
    await expect(page.getByText('Arguments: title: Broken link in the harness guide, priority: normal')).toBeVisible();
    await views.getByRole('button', { name: 'Issue card (plugin Tool cards)' }).press('Enter');
    await expect(page.locator('iframe[title="Issue card (plugin view)"]')).toBeVisible();

    // With the plugin off, the chat stays readable in the generic view only.
    await lab.openSettings();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Plugins' }).click();
    await card(page, 'Tool cards').getByRole('switch', { name: 'Enable Tool cards' }).click();
    await expect(card(page, 'Tool cards')).toContainText('Disabled');
    await lab.chat(/File an issue for the broken docs link/).click();
    await expandFinishedTool(page);
    await expect(page.getByText('Arguments: title: Broken link in the harness guide, priority: normal')).toBeVisible();
    await expect(page.getByRole('group', { name: 'How to show this tool' })).toHaveCount(0);
  });

  test('a renderer frame that never loads falls back to the plain view (v2)', async ({ lab, page }) => {
    await page.route(/\/example\.tool-cards\/ui\/index\.html/, (route) => route.abort());
    await lab.open();
    await lab.chat(/File an issue for the broken docs link/).click();
    // The MCP tool call becomes visible once its request is accepted.
    await page.getByRole('button', { name: 'Accept' }).click();
    await expandFinishedTool(page);
    await expect(page.getByRole('status').filter({ hasText: 'The plugin view did not load, so the plain view is shown.' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Arguments: title: Broken link in the harness guide, priority: normal')).toBeVisible();
    await expect(page.getByRole('group', { name: 'How to show this tool' }).getByRole('button', { name: 'Issue card (plugin Tool cards)' })).toBeDisabled();
  });

  test('an MCP tool server is offered to new chats only after the person turns it on (v2)', async ({ lab, page }) => {
    await openPlugins(lab, page);
    const plugin = card(page, 'Tool cards');
    const servers = plugin.getByRole('region', { name: 'MCP tool servers' });
    await expect(servers).toContainText('Codex, Pi, Prime Agent and pipeline runs never get it.');
    await expect(servers.locator('code')).toContainText('--permission');
    const offer = servers.getByRole('switch', { name: 'Offer Issue drafts to new chats' });
    await expect(offer).not.toBeChecked();
    // Keyboard: Space turns the offer on and off.
    await offer.focus();
    await page.keyboard.press('Space');
    await expect(lab.toast('New chats that can take it get this tool server')).toBeVisible();
    await expect(offer).toBeChecked();
    await page.keyboard.press('Space');
    await expect(offer).not.toBeChecked();
    // A disabled plugin offers nothing and its switch is off-limits.
    await plugin.getByRole('switch', { name: 'Enable Tool cards' }).click();
    await expect(plugin).toContainText('Disabled');
    await expect(offer).toBeDisabled();
  });

  test('safe mode lists plugins read-only', async ({ lab, page }) => {
    await openPlugins(lab, page, 'safe');
    await expect(page.getByText('Safe mode: plugins are listed, but none is active and changes are off.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install from folder…' })).toBeDisabled();
    await expect(card(page, 'Hello command')).toContainText('Off in safe mode');
    await expect(card(page, 'Hello command').getByRole('switch', { name: 'Enable Hello command' })).toBeDisabled();
    // No plugin is active in safe mode: no status items either.
    await expect(page.getByRole('contentinfo', { name: 'Plugin status items' })).toHaveCount(0);
  });
});
