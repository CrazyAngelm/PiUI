// Uses the real Tauri host, scheduler and installed Codex against the harness's
// isolated synthetic provider. UI is used only to compare visibility, never to operate.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { callApi, prepareSystem } from '../../../scripts/agent-api.mjs';

export async function runAgentApiProof({ connection, workspaceId, safe = false, automation, commandBoundMs, startupBoundMs }) {
  const call = (method, params) => callApi(connection, method, params, { signal: AbortSignal.timeout(startupBoundMs) });
  assert.equal((await call('ping')).api, 'piui-agent');
  const catalog = await call('workspace', { type: 'catalog' });
  assert.equal(catalog.catalog.safeMode, safe);
  await assert.rejects(callApi({ ...connection, token: '0'.repeat(64) }, 'ping', {}, { signal: AbortSignal.timeout(commandBoundMs) }));
  await assert.rejects(call('arbitrary_invoke', {}), { code: 'unknown-method' });
  await assert.rejects(call('saveGraph', { workspaceId, invented: true }), { code: 'invalid' });
  if (safe) {
    await assert.rejects(call('workspace', { type: 'createSession', workspaceId, harness: 'codex', permissionMode: 'read-only' }));
    await assert.rejects(call('startRun', { workspaceId, runId: randomUUID(), teamId: 'none', pipelineId: 'none' }), { code: 'runtime-unavailable' });
    assert.ok((await call('listRuns', { workspaceId })).some(run => run.status === 'succeeded'));
    return ['agent-api-safe-mode-read-and-denied-execution'];
  }
  const profile = { name: 'API worker', harness: 'codex', model: 'gpt-5.5', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] } };
  const system = { format: 'piui-system', version: 4, name: 'API dependency proof', agents: [
    { id: 'first', profile, task: 'Return the requested result.' },
    { id: 'second', profile: { ...profile, name: 'API reader' }, task: 'Read the upstream result and respond.' },
  ], connections: [{ from: 'first', to: 'second', kind: 'result' }] };
  const plan = await prepareSystem(JSON.stringify(system), workspaceId);
  await call('saveGraph', plan.save);
  await assert.rejects(call('saveGraph', plan.save), { code: 'conflict' });
  const saved = await call('getTeam', { workspaceId, id: plan.start.teamId });
  assert.equal(saved.revision, 0);
  // Atomic failure cannot apply an earlier profile edit.
  const conflict = structuredClone(plan.save);
  conflict.profiles[0].expectedRevision = 0;
  conflict.profiles[0].value.name = 'Must roll back';
  await assert.rejects(call('saveGraph', conflict));
  assert.equal((await call('getProfile', { workspaceId, id: conflict.profiles[0].value.id })).value.name, 'API worker');
  let run = await call('startRun', plan.start);
  await assert.rejects(call('startRun', plan.start), { code: 'already-exists' });
  const deadline = Date.now() + startupBoundMs; // Existing native harness startup/turn bound.
  while (run.status === 'running' && Date.now() < deadline) {
    run = await call('waitRun', { workspaceId, runId: run.id, afterRevision: run.revision, timeoutMs: Math.max(0, deadline - Date.now()) });
  }
  assert.equal(run.status, 'succeeded', JSON.stringify(run.tasks.map(task => ({ status: task.status, failure: task.failure }))));
  assert.equal(run.tasks.length, 2);
  assert.ok(run.tasks.every(task => task.status === 'succeeded'));
  const sessions = (await call('workspace', { type: 'catalog' })).catalog.sessions.filter(session => session.runId === run.id);
  assert.equal(sessions.length, 2);
  for (const session of sessions) {
    const result = await call('workspace', { type: 'snapshot', sessionId: session.id });
    assert.ok(JSON.stringify(result.snapshot.blocks).includes('PIUI_COMPOSER_RESULT'));
  }
  const uiRun = await automation.evaluate(`(async () => { return window.__TAURI_INTERNALS__.invoke('orchestration_get_run_v6', {request:${JSON.stringify({ workspaceId, runId: run.id })}}); })()`);
  assert.equal(uiRun.id, run.id);
  assert.equal(uiRun.status, 'succeeded');
  assert.ok(await call('usage', { workspaceId, runId: run.id }));
  // External API cannot bypass the host's delegation authority comparison.
  const escalation = structuredClone(plan.save);
  escalation.profiles[0].value.allowedSpawnProfileIds = [escalation.profiles[1].value.id];
  escalation.profiles[1].value.permissionMode = 'full-access';
  for (const item of [...escalation.profiles, escalation.team, escalation.pipeline, escalation.command]) item.expectedRevision = 0;
  await assert.rejects(call('saveGraph', escalation), { code: 'denied' });
  return ['agent-api-auth-and-typed-allowlist', 'agent-api-atomic-save-conflict-and-denied-escalation', 'agent-api-native-codex-synthetic-provider-result-dag', 'agent-api-same-ui-run-and-native-answers', 'agent-api-stable-run-id-prevents-duplicate'];
}

export async function setupAgentWorkspace(connection, path) {
  const project = await callApi(connection, 'addProject', {path});
  await callApi(connection, 'setProjectTrust', {projectId: project.id, trustState: 'trusted'});
  return project.id;
}
