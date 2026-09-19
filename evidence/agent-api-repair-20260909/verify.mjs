// Read-only acceptance against the installed host. Never print its capability.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callApi } from '../../scripts/agent-api.mjs';

const connection = JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'PiUI-agent-api', 'connection.json'), 'utf8'));
const ping = await callApi(connection, 'ping');
assert.deepEqual(ping, { api: 'piui-agent', version: 1 });
const { catalog } = await callApi(connection, 'workspace', { type: 'catalog' });
assert.equal(catalog.protocol, 15);
let runs = 0;
for (const workspace of catalog.workspaces) {
  const saved = await callApi(connection, 'listRuns', { workspaceId: workspace.id });
  assert.ok(Array.isArray(saved));
  runs += saved.length;
}
await assert.rejects(callApi(connection, 'arbitrary_invoke'), { code: 'unknown-method' });
await assert.rejects(callApi({ ...connection, token: (connection.token[0] === '0' ? '1' : '0') + connection.token.slice(1) }, 'ping'));
const proof = { verifiedAt: new Date().toISOString(), ping, workspaces: catalog.workspaces.length, sessions: catalog.sessions.length, runs, unknownMethodRejected: true, wrongTokenRejected: true, mutations: 0 };
await writeFile(new URL('./api-proof.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
