import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { callApi, prepareSystem } from '../../scripts/agent-api.mjs';

const installedPath = join(process.env.LOCALAPPDATA, 'PiUI/piui-desktop.exe');
const binary = await readFile(installedPath);
assert(binary.includes(Buffer.from('unsupported-network-policy')), 'Installed binary lacks the new Codex network policy');
const codexBridge = await readFile(new URL('../../crates/piui-runtime/bridge/codex.mjs', import.meta.url));
assert(binary.includes(codexBridge), 'Installed Codex bridge differs from the verified source');
const connection = JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'PiUI-agent-api/connection.json'), 'utf8'));
const ping = await callApi(connection, 'ping');
assert.equal(ping.api, 'piui-agent');
const { catalog } = await callApi(connection, 'workspace', { type: 'catalog' });
const workspaceId = 'c4058dea-fa79-4cb5-b5c2-f93ff365ba8c';
assert(catalog.workspaces.some(workspace => workspace.id === workspaceId && workspace.name === 'PIUI'));
const observedCodex = catalog.sessions.find(session => session.harness === 'codex' && session.model?.id);
assert(observedCodex, 'A previously observed Codex model is required for the non-executing profile fixture');
const profile = {
  id: randomUUID(),
  name: 'PiUI networkAccess persistence verification (never executed)',
  harness: 'codex',
  model: observedCodex.model.id,
  modelProvider: observedCodex.model.provider,
  permissionMode: 'read-only',
  networkAccess: true,
  instructions: 'Verification fixture only. This profile must never be executed.',
  toolPolicy: { rules: [] },
  allowedSpawnProfileIds: [],
};
const identity = { workspaceId, id: profile.id };
await writeFile(new URL('profile-request.json', import.meta.url), JSON.stringify({ workspaceId, value: profile }, null, 2), { flag: 'wx' });
const result = {
  installedPath,
  installedSha256: createHash('sha256').update(binary).digest('hex'),
  newNetworkPolicyEmbedded: true,
  nativeBridgeMatchesSource: true,
  bridgeSourceSha256: createHash('sha256').update(codexBridge).digest('hex'),
  pid: connection.pid,
  address: `127.0.0.1:${connection.port}`,
  ping,
  profileId: profile.id,
  nativeRunsStarted: 0,
};
try {
  const created = await callApi(connection, 'saveProfile', { workspaceId, value: profile });
  assert.equal(created.value.networkAccess, true);
  let stored = await callApi(connection, 'getProfile', identity);
  assert.equal(stored.value.networkAccess, true);
  assert.equal(stored.value.permissionMode, 'read-only');
  result.savedTrueAndReadBack = true;
  const disabled = await callApi(connection, 'saveProfile', {
    workspaceId, expectedRevision: stored.revision, value: { ...stored.value, networkAccess: false },
  });
  stored = await callApi(connection, 'getProfile', identity);
  assert.equal(stored.revision, disabled.revision);
  assert.equal(stored.value.networkAccess ?? false, false);
  result.savedFalseAndReadBack = true;
  const enabled = await callApi(connection, 'saveProfile', {
    workspaceId, expectedRevision: stored.revision, value: { ...stored.value, networkAccess: true },
  });
  stored = await callApi(connection, 'getProfile', identity);
  assert.equal(stored.revision, enabled.revision);
  assert.equal(stored.value.networkAccess, true);
  result.reenabledAndReadBack = true;
  const { id: storedId, allowedSpawnProfileIds, ...portableProfile } = stored.value;
  assert.equal(storedId, profile.id);
  assert.deepEqual(allowedSpawnProfileIds, []);
  const portable = {
    format: 'piui-system', version: 4, name: 'Network access persistence verification',
    orchestrator: 'probe',
    agents: [{ id: 'probe', profile: portableProfile, task: 'Verification fixture only. Never execute.' }],
    connections: [],
  };
  const prepared = await prepareSystem(JSON.stringify(portable), workspaceId);
  assert.equal(prepared.save.profiles[0].value.networkAccess, true);
  assert.equal(prepared.save.profiles[0].value.permissionMode, 'read-only');
  result.portableV4ToNativeProfileRoundTrip = true;
  const schedules = await callApi(connection, 'listSchedules', { workspaceId: '3db5bb24-fa5d-45fa-a026-94085fd90fa4' });
  const moneySchedule = schedules.find(schedule => schedule.value.id === '8b7f12a0-2cfb-4fd8-8e2b-150f52f97e9b');
  assert(moneySchedule);
  assert.equal(moneySchedule.enabled, false);
  result.moneySchedule = { id: moneySchedule.value.id, enabled: moneySchedule.enabled, revision: moneySchedule.revision };
} finally {
  const ownedProfile = await callApi(connection, 'getProfile', identity);
  if (ownedProfile) await callApi(connection, 'deleteProfile', { ...identity, expectedRevision: ownedProfile.revision });
  assert.equal(await callApi(connection, 'getProfile', identity), null);
  result.verificationProfileRemoved = true;
}
await writeFile(new URL('installed-verification.json', import.meta.url), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
