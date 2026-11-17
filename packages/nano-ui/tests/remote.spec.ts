import type { Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { test, expect } from './browserFixture';
import { NANO_REMOTE_COMMANDS } from '../../../contracts/nano-remote-v1';
import { DEVICE_ID, DEVICE_NAME, MOUNT, OTHER_DEVICE_ID, seedRemotePipeline, startRemoteLab, type RemoteLab } from './remote-harness';

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

test.beforeEach(async ({ page }) => {
  lab.options.approval = 'manual';
  lab.options.shell = {};
  lab.options.commands = undefined;
  lab.options.failNextStartReply = false;
  // Keep the persistent browser and its pairing key. A previous test's route, selected project
  // or draft must not change a first-opening scenario, even on a rerun with the same profile.
  await page.goto(lab.url + MOUNT + 'remote-manifest.json');
  await page.evaluate((devices) => {
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage)) {
        if (devices.some((device) => key.startsWith('nano-remote:' + device + ':'))) storage.removeItem(key);
      }
    }
  }, [DEVICE_ID, OTHER_DEVICE_ID]);
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

test('a phone opens the graph, edits the saved pipeline and starts it on the paired desktop', async ({ page }, testInfo) => {
  lab.options.approval = 'auto';
  await seedRemotePipeline(lab, 'Editorial brief');
  await page.setViewportSize({ width: 390, height: 780 });
  const next = lab.nextViewer();
  await page.goto(lab.launch());
  const viewer = await next;
  await page.getByRole('button', { name: 'Pipelines', exact: true }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('.piui-picker').getByText('Editorial brief', { exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Pipeline name' });
  await expect(name).toHaveValue('Editorial brief');
  await expect(page.locator('.svelte-flow__node[aria-label="Сбор материалов"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The first working step opens at reading size. Fit to screen can still show the whole graph.
  await expect.poll(async () => (await page.locator('.svelte-flow__node[aria-label="Сбор материалов"]').boundingBox())?.width ?? 0).toBeGreaterThan(200);
  const screenshot = testInfo.outputPath('phone-pipeline.png');
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  await testInfo.attach('phone-pipeline', { path: screenshot, contentType: 'image/png' });
  await page.getByRole('button', { name: 'Сбор материалов' }).click();
  const inspector = page.getByRole('complementary', { name: 'Node settings' });
  await inspector.locator('button.select').first().click();
  const picker = page.locator('.piui-picker');
  const hermes = picker.locator('.piui-picker__item').filter({ hasText: /Hermes/i });
  await expect(hermes).toHaveAttribute('aria-disabled', 'true');
  await expect(hermes).toContainText('This harness cannot enforce read-only access.');
  await page.keyboard.press('Escape');
  await inspector.getByRole('button', { name: 'Close', exact: true }).click();
  await name.fill('Revised brief');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => viewer.requests.some((row) => row.command === 'orchestration_save_graph_v6')).toBe(true);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => viewer.requests.some((row) => row.command === 'orchestration_start_run_v6')).toBe(true);
  await expect(page.locator('.stage__title h2')).toHaveText('Revised brief');
});

test('shared member assignments remain visible and start from their original saved command', async ({ page }) => {
  lab.options.approval = 'auto';
  await seedRemotePipeline(lab, 'Shared reviewer', true);
  lab.options.failNextStartReply = true;
  const next = lab.nextViewer();
  await page.goto(lab.launch());
  const viewer = await next;
  await page.getByRole('button', { name: 'Pipelines', exact: true }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('.piui-picker').getByText('Shared reviewer', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Pipeline name' })).toBeDisabled();
  const firstNode = page.locator('.svelte-flow__node[aria-label="Сбор материалов"]');
  await expect(firstNode).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(firstNode).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => (await firstNode.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  const assignments = page.locator('.assignments');
  await assignments.getByText('Saved assignments · read-only').click();
  await expect(assignments.locator('li')).toHaveText([
    'Сбор материалов · Редактор (research)',
    'Подготовка обзора · Редактор (research)',
    'Проверка обзора · Редактор (review)',
    'Messages · Редактор (research) → Редактор (review)',
    'Observe · Редактор (review) → Редактор (research)',
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.stage__title h2')).toHaveText('Shared reviewer');
  expect(viewer.requests.some(({ command }) => command === 'orchestration_save_graph_v6')).toBe(false);
  const starts = viewer.requests.filter(({ command }) => command === 'orchestration_start_run_v6');
  expect(starts).toHaveLength(1);
  const { request: { runId: retryKey } } = starts[0]!.args as { request: { runId: string } };
  const recordedId = 'nano-remote-v1-' + createHash('sha256').update(retryKey, 'utf8').digest('hex');
  expect(viewer.requests.some(({ command, args }) => command === 'orchestration_get_run_v6'
    && (args as { request: { runId: string } }).request.runId === recordedId)).toBe(true);
});

test('a native script graph remains inspectable with its start and editing controls restricted', async ({ page }) => {
  lab.options.approval = 'auto';
  await page.goto(lab.launch('light', 'en', OTHER_DEVICE_ID));
  await page.getByRole('button', { name: 'Pipelines', exact: true }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('.piui-picker').getByText('Release check', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Release check');
  await expect(page.getByRole('textbox', { name: 'Pipeline name' })).toBeDisabled();
  await expect(page.getByText('Start this pipeline on the computer.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
});

test('a runs-only host shows run history without offering its unavailable editor', async ({ page }) => {
  lab.options.approval = 'auto';
  lab.options.commands = NANO_REMOTE_COMMANDS.filter((cmd) => !cmd.startsWith('orchestration_')
    || ['orchestration_list_runs_v6', 'orchestration_get_run_v6', 'orchestration_run_usage_v6'].includes(cmd));
  await page.goto(lab.launch());
  await page.getByRole('button', { name: 'Runs', exact: true }).first().click();
  await page.locator('.run-row').first().click();
  await expect(page.locator('.stage__title h2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open pipeline', exact: true })).toHaveCount(0);
  await page.locator('.pipelines button.project').click();
  await page.locator('.piui-picker').getByText('Personal chats', { exact: true }).click();
  await expect(page.getByText('No runs yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open editor', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pipelines', exact: true })).toHaveCount(0);
});

test('a chat-only desktop keeps chats available and explains where pipelines are', async ({ page }) => {
  lab.options.approval = 'auto';
  lab.options.commands = NANO_REMOTE_COMMANDS.filter((command) => !command.startsWith('orchestration_') && command !== 'board_command_v1' && command !== 'teammates_command_v1');
  await page.goto(lab.launch());
  await expect(page.getByText('This computer shares chats.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pipelines', exact: true })).toHaveCount(0);
  await expect(page.getByText(CHAT, { exact: true }).first()).toBeVisible();
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


test('a touch-only phone opens project actions, board cards, teammates and schedules', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const tap = async (item: Locator) => {
    await expect(item).toBeVisible();
    await item.scrollIntoViewIfNeeded();
    const box = await item.boundingBox();
    if (!box) throw new Error('Touch target has no bounds.');
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  lab.options.approval = 'auto';
  const next = lab.nextViewer();
  await page.goto(lab.launch('light', 'ru'));
  const viewer = await next;
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches && navigator.maxTouchPoints > 0)).toBe(true);
  await tap(page.getByRole('button', { name: 'Открыть навигацию' }));
  const project = page.locator('.project__row').filter({ has: page.getByTitle('video-studio', { exact: true }) });
  await expect(project.locator('.project__actions')).toHaveCSS('opacity', '1');
  await tap(project.getByRole('button', { name: 'Параметры: video-studio', exact: true }));
  await tap(page.getByRole('menuitem', { name: 'Доска', exact: true }));
  const board = page.locator('.board');
  const card = board.getByText('Route every host call through transport.ts', { exact: true });
  await expect(card).toBeVisible();
  await expect(board.getByRole('button', { name: 'Новая карточка' })).toHaveCount(0);
  await testInfo.attach('phone-board', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });

  await tap(card);
  const drawer = page.getByRole('complementary', { name: /Route every host call/ });
  await expect(drawer.getByText('No component may import Tauri directly.', { exact: false })).toBeVisible();
  await expect(drawer.getByRole('textbox')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /Отменить|Отвязать|Удалить карточку|Освободить/ })).toHaveCount(0);
  await testInfo.attach('phone-card', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await tap(drawer.getByRole('button', { name: 'Закрыть', exact: true }));
  await tap(board.getByRole('button', { name: 'Команда', exact: true }));
  const team = page.locator('.team');
  await tap(team.getByRole('button', { name: /@coder/ }).first());
  await expect(team.getByRole('heading', { name: '@coder', exact: true })).toBeVisible();
  await expect(team.getByRole('switch')).toHaveCount(0);
  await expect(team.getByRole('button', { name: /Новый участник|Изменить|Удалить/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await testInfo.attach('phone-team', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });

  await tap(page.getByRole('button', { name: 'Автоматизации', exact: true }).first());
  const schedules = page.locator('.automations');
  await expect(schedules.getByText('Weekly trailer refresh')).toBeVisible();
  await expect(schedules.getByRole('switch')).toHaveCount(0);
  await expect(schedules.getByRole('button', { name: /Новая автоматизация|Удалить|Приостановить|Возобновить/ })).toHaveCount(0);
  await testInfo.attach('phone-schedules', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  const types = (command: string) => viewer.requests.filter((r) => r.command === command)
    .map((r) => (r.args as { command: { type: string } }).command.type);
  expect(new Set(types('board_command_v1'))).toEqual(new Set(['get']));
  expect(new Set(types('teammates_command_v1'))).toEqual(new Set(['list']));
});
