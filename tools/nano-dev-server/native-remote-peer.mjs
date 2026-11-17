// Executed by the Windows native remote integration test. All account and
// project input comes from that test's ephemeral issuer and project.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNanoDevServer } from './server.mjs';
import { connectRaw } from './ws.mjs';

const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const line = async () => (await input.next()).value;
const remoteUiDir = process.env.PIUI_REMOTE_PROOF_SCREENSHOTS
  ? process.env.PIUI_REMOTE_PROOF_UI ?? fileURLToPath(new URL('../../packages/nano-ui/dist-remote/', import.meta.url))
  : undefined;
const server = await startNanoDevServer({ port: 0, plan: 'paid', remoteUiDir });
const timeout = 120_000; // nano-remote.v1 request timeout
let ws;
try {
  console.log(server.origin);
  const auth = new URL(await line());
  assert.equal(auth.origin, server.origin);
  const page = await (await fetch(auth)).text();
  assert.match(page, /Synthetic Nano development server/);
  const txn = /name="txn" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(txn);
  const decision = await fetch(new URL('/connect/authorize', server.origin), {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ txn, decision: 'approve' }),
  });
  assert.equal(decision.status, 302);
  const callback = new URL(decision.headers.get('location'));
  assert.equal(callback.hostname, '127.0.0.1');
  assert.equal(callback.pathname, '/callback');
  await fetch(callback);

  const { device, workspaceId } = JSON.parse(await line());
  const opened = await connectRaw(new URL(`/api/hermes/remote/devices/${encodeURIComponent(device)}/socket`, server.origin).href, { Origin: server.origin }, ['nano-remote.v1']);
  assert.equal(opened.status, 101);
  ws = opened.ws;
  const send = (d) => assert.ok(ws.sendText(JSON.stringify({ t: 'msg', d })));
  const next = async () => (await ws.nextJson(timeout)).d;
  const ready = await ws.nextJson(timeout);
  assert.equal(ready.t, 'ready');
  assert.equal(ready.device.id, device);
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const key = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
  send({ k: 'hello', proto: 1, key, label: 'Synthetic native integration' });
  const challenge = await next();
  assert.equal(challenge.k, 'challenge');
  const payload = Buffer.from(['nano-remote-v1', device, ready.viewer, challenge.nonce].join('\n'));
  const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, payload)).toString('base64url');
  send({ k: 'proof', sig });
  const approval = await next();
  assert.equal(approval.k, 'approval');
  console.log(approval.code); // matched against the native local consent prompt
  const welcome = await next();
  assert.equal(welcome.k, 'welcome');
  assert.ok(welcome.commands.includes('orchestration_save_graph_v6'));

  let id = 0;
  async function request(cmd, args) {
    send({ k: 'req', id: ++id, cmd, args });
    for (;;) {
      const result = await next();
      if (result.k === 'ev' || result.k === 'gap') continue;
      assert.equal(result.k, 'res');
      assert.equal(result.id, id);
      return result;
    }
  }
  const definition = (value) => ({ workspaceId, value });
  const profile = (id, name) => definition({
    id, name, harness: 'codex', model: 'model', permissionMode: 'read-only',
    instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [],
  });
  const graphName = 'Редакционный обзор';
  const graph = {
    workspaceId,
    profiles: [profile('reader', 'Сбор фактов'), profile('editor', 'Краткий отчёт')],
    team: definition({
      id: 'team', name: 'Редакция', orchestratorMemberId: 'sources',
      members: [{ id: 'sources', profileId: 'reader' }, { id: 'summary', profileId: 'editor' }],
      sendEdges: [], observeEdges: [],
    }),
    pipeline: definition({
      id: 'pipeline', name: graphName, steps: [
        { id: 'sources', name: 'Сбор фактов', assignedMemberId: 'sources', instructions: 'Подбери источники по теме.', dependencyStepIds: [],
          pinnedOutput: {text:'Проверенные материалы', pinnedAt:'2026-11-17T00:00:00Z'} },
        { id: 'summary', name: 'Краткий отчёт', assignedMemberId: 'summary', instructions: 'Составь обзор по проверенным фактам.', dependencyStepIds: ['sources'],
          pinnedOutput: {text:'Итоговый обзор', pinnedAt:'2026-11-17T00:00:00Z'} },
      ],
    }),
    command: definition({ id: 'command', name: graphName, teamId: 'team', pipelineId: 'pipeline' }),
  };
  assert.equal((await request('orchestration_save_graph_v6', { request:graph })).ok, true);
  const stored = await request('orchestration_get_pipeline_v6', { request:{ workspaceId, id:'pipeline' } });
  assert.equal(stored.ok, true);
  assert.equal(stored.value.value.name, graphName);
  assert.equal(stored.value.revision, 0);
  const started = await request('orchestration_start_run_v6', { request: {
    workspaceId, runId: 'pinned-proof', teamId: 'team', pipelineId: 'pipeline',
    launchCommandId: 'command', usePinnedData: true,
  } });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  assert.equal(started.value.pairedBrowser, true);
  assert.equal(started.value.status, 'succeeded');
  const readRun = await request('orchestration_get_run_v6', { request: { workspaceId, runId: started.value.id } });
  assert.deepEqual(readRun.value, started.value);
  for (const item of [...graph.profiles, graph.team, graph.pipeline, graph.command]) item.expectedRevision = 0;
  graph.profiles[0].value.permissionMode = 'full-access';
  graph.pipeline.value.name = 'Forbidden edit';
  const denied = await request('orchestration_save_graph_v6', { request:graph });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'denied');
  const after = await request('orchestration_get_pipeline_v6', { request:{ workspaceId, id:'pipeline' } });
  assert.deepEqual(after.value, stored.value);
  console.error('Verified signed relay, durable graph save/read, completed pinned run and denied write.');
  const sharedName = 'Общая редактура';
  if (remoteUiDir) {
    const shared = {
      workspaceId,
      profiles: [profile('shared-editor', 'Главный редактор')],
      team: definition({ id:'shared-team', name:sharedName, orchestratorMemberId:'editor-role',
        members:[{ id:'editor-role', profileId:'shared-editor' }], sendEdges:[], observeEdges:[] }),
      pipeline: definition({ id:'shared-pipeline', name:sharedName, steps:[
        { id:'first-pass', name:'Вычитка', assignedMemberId:'editor-role', instructions:'Вычитай текст.', dependencyStepIds:[],
          pinnedOutput:{text:'Правки внесены', pinnedAt:'2026-11-17T00:00:00Z'} },
        { id:'second-pass', name:'Проверка', assignedMemberId:'editor-role', instructions:'Проверь правки.', dependencyStepIds:['first-pass'],
          pinnedOutput:{text:'Готово', pinnedAt:'2026-11-17T00:00:00Z'} },
      ] }),
      command: definition({id:'shared-command', name:sharedName, teamId:'shared-team', pipelineId:'shared-pipeline'}),
    };
    assert.equal((await request('orchestration_save_graph_v6', {request:shared})).ok, true);
  }
  ws.close();
  await checkBrowser(device, graphName, sharedName);
  console.log('verified');
} catch (error) {
  console.log('failed');
  throw error;
} finally {
  ws?.close();
  await server.close();
  process.stdin.destroy();
}

// Runs only when a persistent synthetic browser profile and a screenshot
// directory were supplied by the person running the native integration proof.
async function checkBrowser(device, graphName, sharedName) {
  const profile = process.env.PIUI_REMOTE_PROOF_PROFILE;
  const out = process.env.PIUI_REMOTE_PROOF_SCREENSHOTS;
  if (!out && !profile) return;
  assert.ok(out && profile && process.env.PIUI_REMOTE_PROOF_BROWSER);
  const require = createRequire(new URL('../../packages/nano-ui/package.json', import.meta.url));
  const { chromium } = require('@playwright/test');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PIUI_REMOTE_PROOF_BROWSER,
    headless: true, viewport: { width: 1440, height: 900 },
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(30_000); // Playwright's default test timeout
    page.on('pageerror', (error) => console.error('Synthetic page error:', error.message));
    await page.goto(new URL('/remote/index.html#device=' + device + '&lang=ru&theme=light', server.origin).href, {waitUntil:'commit'});
    const button = (name) => page.getByRole('button', {name, exact:true});
    try {
      const shownCode = await page.locator('.gate__code [aria-hidden="true"]').innerText();
      console.log(shownCode.replace(/\D/g, '')); // owner approves this separate key
      // Open the project's actual command from its sidebar menu, so the
      // personal workspace cannot accidentally satisfy the proof.
      const options = button('Параметры: Remote fixture');
      await options.click();
      await page.getByRole('menuitem', { name: 'Конвейеры', exact: true }).click();
      const graph = button(graphName);
      if (await graph.isVisible()) await graph.click();
      else {
        await button('Открыть').click();
        await page.locator('.piui-picker').getByText(graphName, {exact:true}).click();
      }
      await page.getByRole('textbox', { name: 'Название конвейера' }).waitFor();
      await page.locator('.svelte-flow__node').filter({hasText: 'Краткий отчёт'}).first().waitFor();
      await page.screenshot({ path:join(out, 'native-desktop-pipeline.png') });
      await page.setViewportSize({ width:390, height:844 });
      const openSaved = async (name) => {
        await button('Открыть').click();
        await page.locator('.piui-picker').getByText(name, {exact:true}).click();
      };
      // Open from the phone's picker after its viewport is established.
      await openSaved(sharedName);
      await page.locator('.assignments > summary').waitFor();
      await openSaved(graphName);
      await page.waitForFunction(() => {
        const node = document.querySelector('.svelte-flow__node[aria-label="Сбор фактов"]');
        const rect = node?.getBoundingClientRect();
        return rect && rect.left >= 0 && rect.right <= innerWidth;
      });
      await page.screenshot({ path:join(out, 'native-phone-pipeline.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.setViewportSize({width:1440, height:900});
      await openSaved(sharedName);
      await page.locator('.assignments > summary').click();
      await page.locator('.svelte-flow__node[aria-label="Проверка"]').waitFor();
      assert.ok(await page.getByRole('textbox', {name:'Название конвейера'}).isDisabled());
      assert.match(await page.locator('.assignments').innerText(), /Главный редактор/);
      await button('Запустить').click();
      const dialog = page.getByRole('dialog');
      const pins = dialog.getByRole('checkbox', {name:/Использовать закреплённые данные/});
      await pins.check();
      assert.ok(await pins.isChecked());
      await dialog.locator('button[type=submit]').click();
      assert.equal(await page.locator('.stage__title h2').innerText(), sharedName);
    } catch (error) {
      console.error(error);
      if (!page.isClosed()) console.error('Synthetic workbench page:', (await page.locator('body').innerText()).slice(0, 1400));
      throw error;
    }
  } finally {
    await context.close();
  }
}
