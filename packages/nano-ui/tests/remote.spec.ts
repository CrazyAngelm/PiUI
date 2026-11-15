import { test, expect } from './browserFixture';
import { NANO_REMOTE_COMMANDS } from '../../../contracts/nano-remote-v1';
import { DEVICE_ID, DEVICE_NAME, OTHER_DEVICE_ID, startRemoteLab, type RemoteLab } from './remote-harness';

// The built `dist-remote` bundle (pnpm build:remote) against a scripted relay and a desktop backed
// by the UI Lab host. Synthetic: no real Nano server, desktop or provider is involved.

const CHAT = 'Plan a weekend in Lisbon';
let lab: RemoteLab;

test.beforeAll(async () => {
  lab = await startRemoteLab(Number(process.env.NANO_REMOTE_TEST_PORT ?? 5394));
});

test.afterAll(async () => {
  await lab.close();
});

test.beforeEach(() => {
  lab.options.approval = 'manual';
  lab.options.shell = {};
});

/** The page's real localStorage, read through a fresh same-origin frame because the page itself sees only its device's keys. */
async function nativeStorage(page: import('@playwright/test').Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const frame = document.body.appendChild(document.createElement('iframe'));
    try {
      const store = (frame.contentWindow as Window).localStorage;
      const all: Record<string, string> = {};
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index) as string;
        all[key] = store.getItem(key) ?? '';
      }
      return all;
    } finally {
      frame.remove();
    }
  });
}

function navigation(page: import('@playwright/test').Page) {
  return page.getByRole('navigation', { name: 'Workspace navigation' });
}

test('the gate shows the code the desktop computed, then the shell mounts and speaks only the allowlist', async ({ page }) => {
  const errors: string[] = [];
  const outside: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(lab.url) && !/^(data|blob):/.test(request.url())) outside.push(request.url());
  });
  page.on('websocket', (socket) => {
    if (!socket.url().startsWith(lab.url.replace('http', 'ws'))) outside.push(socket.url());
  });

  const next = lab.nextViewer();
  await page.goto(lab.launch());
  const viewer = await next;
  await expect.poll(() => viewer.code).toMatch(/^\d{6}$/);
  expect(viewer.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  expect(viewer.label.length).toBeGreaterThan(0);

  await expect(page.getByRole('status')).toContainText('Confirm on your computer');
  await expect(page.getByRole('status')).toContainText(DEVICE_NAME);
  await expect(page.getByText(`${viewer.code.slice(0, 3)} ${viewer.code.slice(3)}`, { exact: true })).toBeVisible();
  await expect(navigation(page)).toHaveCount(0);
  expect(viewer.requests).toEqual([]);

  viewer.approve();
  await expect(navigation(page)).toBeVisible();
  await expect(page.getByText(CHAT, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Confirm on your computer' })).toHaveCount(0);

  const commands = lab.requests.map((request) => request.command);
  expect(commands).toContain('bootstrap_v10');
  expect(commands).toContain('workspace_command_v15');
  for (const command of commands) expect(NANO_REMOTE_COMMANDS as readonly string[]).toContain(command);
  expect(lab.proofs).toBeGreaterThan(0);
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test('a message typed in the browser reaches the desktop and its events come back', async ({ page }) => {
  lab.options.approval = 'auto';
  const next = lab.nextViewer();
  await page.goto(lab.launch());
  const viewer = await next;
  await expect(page.getByText(CHAT, { exact: true }).first()).toBeVisible();
  await page.getByText(CHAT, { exact: true }).first().click();

  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello from the phone');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(page.getByText('Hello from the phone').first()).toBeVisible();
  await expect.poll(() => viewer.requests.some((request) => {
    const command = (request.args as { command?: { type?: string } }).command;
    return request.command === 'workspace_composer_v19' && command?.type === 'send';
  })).toBe(true);
  await expect.poll(() => viewer.events.length).toBeGreaterThan(0);
  for (const event of viewer.events) expect(event.channel).toMatch(/^piui:\/\//);
});

test('a skipped oversized event makes the shell read its state again on the same session, without a new pairing', async ({ page }) => {
  lab.options.approval = 'auto';
  const next = lab.nextViewer();
  await page.goto(lab.launch());
  const viewer = await next;
  await expect(page.getByText(CHAT, { exact: true }).first()).toBeVisible();
  const catalogReads = (): number => viewer.requests.filter((request) => (request.args as { command?: { type?: string } }).command?.type === 'catalog').length;
  await expect.poll(catalogReads).toBeGreaterThan(0);
  const before = catalogReads();
  const proofs = lab.proofs;

  viewer.gap('piui://workspace-event', 'ses_unknown');
  viewer.gap('piui://workspace-event');
  await expect.poll(catalogReads).toBeGreaterThan(before);
  await expect(page.getByText(CHAT, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Confirm on your computer' })).toHaveCount(0);
  // The same socket served it: no second handshake, so no new code for the person to confirm.
  expect(lab.proofs).toBe(proofs);
  expect(viewer.closed).toBeUndefined();
});

test('the desktop can end the session, and the gate takes its place', async ({ page }) => {
  lab.options.approval = 'auto';
  const next = lab.nextViewer();
  await page.goto(lab.launch());
  const viewer = await next;
  await expect(navigation(page)).toBeVisible();

  viewer.bye('kicked');
  await expect(page.getByRole('status')).toContainText('Disconnected on the computer');
  await expect(navigation(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
});

test('a refusal on the desktop shows the refusal and never mounts the shell', async ({ page }) => {
  const next = lab.nextViewer();
  await page.goto(lab.launch());
  const viewer = await next;
  await expect(page.getByRole('status')).toContainText('Confirm on your computer');

  viewer.deny();
  await expect(page.getByRole('status')).toContainText('Connection refused');
  await expect(navigation(page)).toHaveCount(0);
  expect(viewer.requests).toEqual([]);
});

test('a desktop on other shell contracts is refused before anything mounts or any command is sent', async ({ page }) => {
  lab.options.approval = 'auto';
  lab.options.shell = { workspace: 99 };
  const next = lab.nextViewer();
  await page.goto(lab.launch());
  const viewer = await next;

  await expect(page.getByRole('status')).toContainText('Versions differ');
  await expect(navigation(page)).toHaveCount(0);
  expect(viewer.requests).toEqual([]);
});

test('the same browser key is offered on every connection', async ({ page }) => {
  const first = lab.nextViewer();
  await page.goto(lab.launch());
  const one = await first;
  await expect.poll(() => one.fingerprint).not.toBe('');

  const second = lab.nextViewer();
  await page.reload();
  const two = await second;
  await expect.poll(() => two.fingerprint).not.toBe('');
  expect(two.fingerprint).toBe(one.fingerprint);
  expect(two.code).not.toBe(one.code);
});

test('the gate and the shell fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const next = lab.nextViewer();
  await page.goto(lab.launch('dark', 'ru'));
  const viewer = await next;
  await expect(page.getByRole('status')).toContainText('Подтвердите подключение на компьютере');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  viewer.approve();
  await page.locator('.narrow-bar').getByRole('button').first().click();
  await expect(page.getByText(CHAT, { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('drafts and the open chat belong to one device: A, then B, then A again', async ({ page }) => {
  lab.options.approval = 'auto';
  const draft = 'Draft typed for the first computer only';
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const draftsKey = (device: string) => `nano-remote:${device}:piui.shell.drafts.v1`;
  // A device switch in the host page is a new frame; a fragment change alone would keep this page.
  const open = async (device: string) => {
    await page.goto('about:blank');
    const next = lab.nextViewer();
    await page.goto(lab.launch('light', 'en', device));
    await next;
    await expect(page.getByText(CHAT, { exact: true }).first()).toBeVisible();
    await page.getByText(CHAT, { exact: true }).first().click();
    await expect(composer).toBeVisible();
  };

  await open(DEVICE_ID);
  await composer.fill(draft);
  await expect.poll(async () => (await nativeStorage(page))[draftsKey(DEVICE_ID)] ?? '').toContain(draft);

  await open(OTHER_DEVICE_ID);
  await expect(composer).toHaveValue('');
  const forB = await nativeStorage(page);
  expect(forB[draftsKey(OTHER_DEVICE_ID)] ?? '').not.toContain(draft);

  await open(DEVICE_ID);
  await expect(composer).toHaveValue(draft);

  // Nothing the shell saved is outside a device's own prefix.
  const keys = Object.keys(await nativeStorage(page));
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.filter((key) => !key.startsWith('nano-remote:'))).toEqual([]);
});
