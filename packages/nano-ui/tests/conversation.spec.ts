import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect } from './browserFixture';

interface OwnerCall { name: string; location: 'native' | 'cloud'; sessionId: string; operation?: string; payload?: unknown }
interface Fixture {
  mount(location?: 'native' | 'cloud', fullHistory?: boolean): Promise<void>;
  stream(): void; disconnect(): void; switchOwner(): void;
  loadOlder(): void; replaceWindow(): void;
  longApproval(): void;
  enableMessageActions(): void; allowRepeat(): void; replaceMessageTarget(): void;
  clickStaleOwnerButton(): void; clickStaleContentButton(): void;
  hold(name: string): void; fail(name: string): void; settle(name: string, fail?: boolean): void;
  calls(): OwnerCall[]; mountSecond(): void; dispose(): Promise<void>;
}
declare global { interface Window { nanoConversationFixture: Fixture } }

test('connected old buttons cannot borrow a new owner or target before the DOM flushes', async ({ page }) => {
  await page.goto('/tests/conversation-host.html');
  await page.waitForFunction(() => !!window.nanoConversationFixture);
  const question = page.locator('#conversation [data-timeline-block="user"]');
  for (const transition of ['clickStaleOwnerButton', 'clickStaleContentButton'] as const) {
    await page.evaluate(async () => { await window.nanoConversationFixture.mount('cloud', false); window.nanoConversationFixture.enableMessageActions(); });
    await expect(question.getByRole('button', { name: 'Copy message', exact: true })).toBeVisible();
    // Both the owner/content change and the old DOM activation share one task.
    await page.evaluate(action => window.nanoConversationFixture[action](), transition);
    await expect(question.getByRole('button', { name: 'Copy message', exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.nanoConversationFixture.calls())).filter(call => call.name === 'message')).toEqual([]);
    await question.getByRole('button', { name: 'Copy message', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(question.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.nanoConversationFixture.calls())).filter(call => call.name === 'message')).toHaveLength(1);
  }
  await page.evaluate(() => window.nanoConversationFixture.dispose());
});

test('message controls use owner actions and credit labels with keyboard and pending-action guards', async ({ page }, testInfo) => {
  await page.goto('/tests/conversation-host.html');
  await page.waitForFunction(() => !!window.nanoConversationFixture);
  await page.evaluate(async () => { await window.nanoConversationFixture.mount('cloud', false); window.nanoConversationFixture.stream(); window.nanoConversationFixture.enableMessageActions(); });
  const root = page.locator('#conversation');
  const question = root.locator('[data-timeline-block="user"]');
  const answer = root.locator('[data-timeline-block="answer"]');
  await expect(question.getByRole('group', {name:'Message actions'})).toBeVisible();
  await expect(answer.getByText('7 credits', {exact:true})).toHaveAttribute('title', 'Owner supplied usage');
  await expect(root.getByRole('button', {name:'Copy answer',exact:true})).toHaveCount(0);
  await question.getByRole('button', {name:'Copy message',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(question.getByRole('button', {name:'Copied',exact:true})).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(question.getByRole('button', {name:'Edit and send again',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(question.getByText('Please read the notes', {exact:false})).toBeVisible();
  await expect(answer.getByRole('button', {name:'Repeat request',exact:true})).toBeDisabled();
  await answer.getByRole('button', {name:'Refresh conversation',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.nanoConversationFixture.allowRepeat());
  await answer.getByRole('button', {name:'Repeat request',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.nanoConversationFixture.hold('message'));
  const branch = question.getByRole('button', {name:'Branch into a new chat',exact:true});
  await branch.focus(); await page.keyboard.press('Enter');
  await expect(branch).toBeDisabled();
  await expect(branch).toHaveAttribute('aria-busy','true');
  await page.keyboard.press('Enter');
  expect((await page.evaluate(() => window.nanoConversationFixture.calls())).filter(call => call.name === 'message').map(call => (call.payload as {action:string}).action)).toEqual(['copy','edit','refresh','repeat','branch']);
  await page.evaluate(() => window.nanoConversationFixture.settle('message'));
  await expect(branch).toBeEnabled();
  await root.screenshot({path:testInfo.outputPath('owner-message-actions.png')});
  await page.evaluate(() => window.nanoConversationFixture.dispose());
});

test('message action failures stay with the current content and never cross a retired owner', async ({ page }) => {
  await page.goto('/tests/conversation-host.html');
  await page.waitForFunction(() => !!window.nanoConversationFixture);
  await page.evaluate(async () => { await window.nanoConversationFixture.mount('cloud', false); window.nanoConversationFixture.stream(); window.nanoConversationFixture.enableMessageActions(); window.nanoConversationFixture.fail('message'); });
  const root = page.locator('#conversation');
  const question = root.locator('[data-timeline-block="user"]');
  const branch = question.getByRole('button', {name:'Branch into a new chat',exact:true});
  await branch.click();
  await expect(question.getByRole('alert')).toHaveText('Could not complete the message action.');
  await page.evaluate(() => window.nanoConversationFixture.hold('message'));
  await branch.click();
  await expect(branch).toBeDisabled();
  await page.evaluate(() => { window.nanoConversationFixture.replaceMessageTarget(); window.nanoConversationFixture.settle('message', true); });
  await expect(question).toContainText('Replacement question');
  await expect(question.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => window.nanoConversationFixture.hold('message'));
  await branch.click();
  await expect(branch).toBeDisabled();
  await page.evaluate(() => { window.nanoConversationFixture.switchOwner(); window.nanoConversationFixture.settle('message',true); });
  await expect(root.getByRole('group', {name:'Message actions'})).toHaveCount(0);
  await expect(root.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => window.nanoConversationFixture.dispose());
});

test('long approval remains scrollable and its decisions are keyboard reachable', async ({ page }) => {
  await page.goto('/tests/conversation-host.html');
  await page.waitForFunction(() => !!window.nanoConversationFixture);
  await page.evaluate(async () => { await window.nanoConversationFixture.mount('cloud'); window.nanoConversationFixture.longApproval(); });
  const region = page.locator('#conversation').getByRole('region', { name: 'Approval requests', exact: true });
  expect(await region.evaluate(node => node.scrollHeight > node.clientHeight && node.clientHeight > 0)).toBe(true);
  await region.focus();
  await page.keyboard.press('End');
  await region.getByRole('button', { name: 'Allow once', exact: true }).focus();
  await expect(region.getByRole('button', { name: 'Allow once', exact: true })).toBeInViewport();
  await page.keyboard.press('Enter');
  expect((await page.evaluate(() => window.nanoConversationFixture.calls())).some(call => call.name === 'approval')).toBe(true);
  await page.evaluate(() => window.nanoConversationFixture.dispose());
});

test('loaded-window search follows streaming, older pages and replacement snapshots', async ({ page }) => {
  await page.goto('/tests/conversation-host.html');
  await page.waitForFunction(() => !!window.nanoConversationFixture);
  await page.evaluate(() => window.nanoConversationFixture.mount('cloud', false));
  const root = page.locator('#conversation');
  await root.getByRole('button', { name: 'Search this chat', exact: true }).click();
  const input = root.getByRole('textbox', { name: 'Search this chat', exact: true });
  await input.fill('final');
  await expect(root.getByText('Streamed final answer', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.nanoConversationFixture.stream());
  await expect(root.getByText('Streamed final answer', { exact: true })).toBeVisible();
  await page.evaluate(() => window.nanoConversationFixture.loadOlder());
  await expect(root.getByText('Older final answer', { exact: true })).toBeVisible();
  await root.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(root.getByText('Streamed final answer', { exact: true })).toBeVisible();
  await page.evaluate(() => window.nanoConversationFixture.replaceWindow());
  await expect(root.getByText('Replacement final answer', { exact: true })).toBeVisible();
  await root.getByRole('button', { name: 'Close search', exact: true }).click();
  await root.getByRole('button', { name: 'Search this chat', exact: true }).click();
  await input.fill('Replacement');
  await expect(root.getByText('Replacement final answer', { exact: true })).toBeVisible();
  await input.press('Escape');
  await expect(root.getByRole('button', { name: 'Search this chat', exact: true })).toBeFocused();
  expect((await page.evaluate(() => window.nanoConversationFixture.calls())).some(call => call.name === 'history')).toBe(false);
  await page.evaluate(() => window.nanoConversationFixture.dispose());
});

for (const location of ['native', 'cloud'] as const) {
  test(`${location} owner renders the actual transcript with streaming, attachments, approvals, reconnect and generic fallback`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.goto('/tests/conversation-host.html');
    await page.waitForFunction(() => !!window.nanoConversationFixture);
    const persistedBefore = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    await page.evaluate(location => window.nanoConversationFixture.mount(location), location);
    const root = page.locator('#conversation');
    await expect(root.getByText('Starting first', { exact: true })).toBeVisible();
    if (location === 'native') await expect(root.getByRole('list', { name: 'Attached images' })).toContainText('Image');
    else {
      await expect(root.getByRole('list', { name: 'Attached images' })).toHaveCount(0);
      await expect(root.locator('.user')).toContainText('[image]');
    }
    await page.screenshot({ path: testInfo.outputPath(`conversation-${location}-transcript.png`), fullPage: true });
    await root.getByRole('button', { name: 'notes.txt', exact: true }).press('Enter');
    expect(await page.evaluate(() => window.nanoConversationFixture.calls())).toContainEqual(expect.objectContaining({ name: 'attachment', location, sessionId: 'first', payload: 'notes' }));
    await page.evaluate(() => window.nanoConversationFixture.fail('attachment'));
    await root.getByRole('button', { name: 'notes.txt', exact: true }).click();
    await expect(root.getByRole('alert')).toContainText('Could not open attachment.');

    await root.locator('.group__head').press('Enter');
    await expect(root.getByText('Generic tool output', { exact: true })).toBeVisible();
    await expect(root.getByRole('group', { name: 'How to show this tool' })).toHaveCount(0);
    await root.getByText('Future event', { exact: true }).click();
    await expect(root.locator('.fallback')).toContainText('<img src=x onerror=alert(1)>Readable unknown content');
    await expect(root.locator('img')).toHaveCount(0);

    const streamingFrameMs = await page.evaluate(async () => {
      const start = performance.now();
      window.nanoConversationFixture.stream();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      return performance.now() - start;
    });
    await testInfo.attach('streaming-frame', { body: JSON.stringify({ location, blockCount: 4, streamingFrameMs }), contentType: 'application/json' });
    mkdirSync(testInfo.outputDir, { recursive: true });
    writeFileSync(testInfo.outputPath('streaming-frame.json'), JSON.stringify({ location, blockCount: 4, streamingFrameMs }) + '\n');
    await expect(root.getByText('Streamed final answer', { exact: true })).toBeVisible();
    await expect(root.getByText('Starting first', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.nanoConversationFixture.fail('approval'));
    await root.getByRole('button', { name: 'Allow once', exact: true }).press('Enter');
    await expect(root.locator('.approval')).toContainText('Could not send the decision');
    await root.getByRole('button', { name: 'Allow once', exact: true }).press('Enter');
    await expect(root.locator('.approval')).not.toContainText('Could not send the decision');
    expect((await page.evaluate(() => window.nanoConversationFixture.calls())).filter(call => call.name === 'approval')).toHaveLength(2);

    await page.evaluate(() => { window.nanoConversationFixture.disconnect(); window.nanoConversationFixture.fail('reconnect'); });
    await expect(root.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled();
    await root.getByRole('button', { name: 'Reconnect', exact: true }).press('Enter');
    await expect(root.getByRole('alert').filter({ hasText: 'Could not reconnect.' })).toBeVisible();
    await expect(root.getByText('Streamed final answer', { exact: true })).toBeVisible();
    await root.getByRole('button', { name: 'Reconnect', exact: true }).press('Enter');
    await expect(root.getByText('Recovered first', { exact: true })).toBeVisible();
    await expect(root.locator('.approval')).toHaveCount(0);
    await expect(root.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`conversation-${location}.png`), fullPage: true });
    expect(await page.evaluate(() => 'process' in window)).toBe(false);
    expect(errors).toEqual([]);
    expect(requests.every(path => ['/tests/conversation-host.html', '/dist-conversation/nano-conversation.js', '/dist-conversation/nano-conversation.css'].includes(path))).toBe(true);
    const served = await (await page.request.get('/dist-conversation/nano-conversation.js')).body();
    const published = readFileSync(new URL('../dist-conversation/nano-conversation.js', import.meta.url));
    expect(createHash('sha256').update(served).digest('hex')).toBe(createHash('sha256').update(published).digest('hex'));
    await page.evaluate(() => window.nanoConversationFixture.dispose());
    await expect(root).toBeEmpty();
    expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(persistedBefore);
  });
}

test('changing owner fences in-flight history, attachment and approval results; islands keep independent locale', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/conversation-host.html');
  await page.waitForFunction(() => !!window.nanoConversationFixture);
  await page.evaluate(async () => {
    await window.nanoConversationFixture.mount('native');
    for (const operation of ['history', 'attachment', 'approval']) window.nanoConversationFixture.hold(operation);
  });
  const root = page.locator('#conversation');
  await root.getByRole('button', { name: 'Search this chat', exact: true }).press('Enter');
  await root.getByRole('textbox', { name: 'Search this chat', exact: true }).fill('Private');
  // Opening search hides unmatched messages; close it to act on the same live owner.
  await root.getByRole('button', { name: 'Close search', exact: true }).press('Enter');
  await root.getByRole('button', { name: 'notes.txt', exact: true }).press('Enter');
  await root.getByRole('button', { name: 'Allow once', exact: true }).press('Enter');
  await expect.poll(() => page.evaluate(() => window.nanoConversationFixture.calls().filter(call => ['history', 'attachment', 'approval'].includes(call.name)).length)).toBe(3);
  await page.evaluate(() => window.nanoConversationFixture.switchOwner());
  await expect(root.getByText('Starting second', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.nanoConversationFixture.calls().filter(call => call.name === 'aborted').length)).toBe(3);
  await page.evaluate(() => {
    window.nanoConversationFixture.settle('history');
    window.nanoConversationFixture.settle('attachment', true);
    window.nanoConversationFixture.settle('approval', true);
  });
  await expect(root.getByRole('alert')).toHaveCount(0);
  await expect(root).not.toContainText('Private history first');
  await root.getByRole('button', { name: 'Search this chat', exact: true }).press('Enter');
  await root.getByRole('textbox', { name: 'Search this chat', exact: true }).fill('Private');
  await expect(root.getByText('Private history second', { exact: true })).toBeVisible();
  await root.getByRole('button', { name: 'Close search', exact: true }).press('Enter');
  await page.evaluate(() => window.nanoConversationFixture.mountSecond());
  await expect(page.locator('#second').getByRole('button', { name: 'Разрешить один раз', exact: true })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 240, 230)');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('');
  expect(errors).toEqual([]);
  await page.evaluate(() => window.nanoConversationFixture.dispose());
});
