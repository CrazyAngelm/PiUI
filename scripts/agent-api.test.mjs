import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { callApi, prepareSystem } from './agent-api.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('Windows starter accepts both executable names and refuses either existing host before writing credentials', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'piui-launch-test-'));
  const starter = fileURLToPath(new URL('./start-agent-api.ps1', import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    for (const filename of ['PiUI.exe', 'piui-desktop.exe']) {
      const executable = join(directory, filename);
      await writeFile(executable, '');
      for (const running of ['PiUI', 'piui-desktop']) {
        const command = `function Get-Process { param($Name, $ErrorAction) if (${quote(running)} -in $Name) { [pscustomobject]@{ Id = 1 } } }
try { & ${quote(starter)} -Executable ${quote(executable)} -ConnectionDirectory ${quote(join(directory, 'connection'))}; exit 1 }
catch { if ($_.Exception.Message -notlike 'PiUI is already open.*') { throw }; if (Test-Path -LiteralPath ${quote(join(directory, 'connection'))}) { throw 'Wrote connection before detecting host' }; Write-Output 'blocked-existing-host' }`;
        assert.match(execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }), /blocked-existing-host/);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
const profile = { name: 'Writer', harness: 'codex', model: 'test-model', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] } };
test('Windows starter creates owner-only directory but publishes no credentials after failed launch in Desktop and Core PowerShell', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'piui-acl-test-'));
  const starter = fileURLToPath(new URL('./start-agent-api.ps1', import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    const executable = join(directory, 'PiUI.exe');
    await writeFile(executable, ''); // Deliberately cannot launch a desktop host.
    for (const shell of ['powershell', 'pwsh']) {
      const connectionDirectory = join(directory, shell);
      const command = `$ErrorActionPreference = 'Stop'
function Get-Process { param($Name, $ErrorAction) }
try { & ${quote(starter)} -Executable ${quote(executable)} -ConnectionDirectory ${quote(connectionDirectory)}; throw 'Unexpected launch' }
catch { if (!(Test-Path -LiteralPath ${quote(connectionDirectory)})) { throw } }
if (Test-Path -LiteralPath ${quote(join(connectionDirectory, 'connection.json'))}) { throw 'Published stale credentials after failed launch' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($path in @(${quote(connectionDirectory)})) {
  $acl = Get-Acl -LiteralPath $path
  $rules = @($acl.Access)
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'Credentials are not owner-only' }
}
Write-Output 'owner-only-credentials'`;
      try {
        // Let each edition use its own built-in modules, not the parent shell's.
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
        assert.match(execFileSync(shell, ['-NoProfile', '-Command', command], { encoding: 'utf8', env }), /owner-only-credentials/);
      } catch (error) {
        if (shell === 'pwsh' && error.code === 'ENOENT') continue;
        throw error;
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('prepare uses current UI parser, keeps edges and stable run identity, rejects escalation and cycles', async () => {
  const system = { format: 'piui-system', version: 4, name: 'Sequence', agents: [
    { id: 'a', profile, task: 'write' }, { id: 'b', profile, task: 'review' },
  ], connections: [{ from: 'a', to: 'b', kind: 'result' }] };
  const plan = await prepareSystem(JSON.stringify(system), 'workspace');
  assert.equal(plan.save.pipeline.value.steps[1].dependencyStepIds[0], 'a');
  assert.equal(plan.start.teamId, plan.save.team.value.id);
  assert.equal(plan.start.launchCommandId, plan.save.command.value.id);
  assert.ok(plan.start.runId);
  const invalid = structuredClone(system);
  invalid.connections.push({ from: 'b', to: 'a', kind: 'result' });
  await assert.rejects(prepareSystem(JSON.stringify(invalid), 'workspace'), /cycle/);
  invalid.connections = [{ from: 'a', to: 'b', kind: 'spawn' }];
  invalid.agents[1].profile = { ...profile, permissionMode: 'full-access' };
  await assert.rejects(prepareSystem(JSON.stringify(invalid), 'workspace'), /permissions/);
  for (const version of [1, 2, 3]) assert.ok((await prepareSystem(JSON.stringify({ ...system, version }), 'workspace')).save);
});
test('client preserves Unicode separators and surfaces host error without leaking token', async () => {
  const token = 'a'.repeat(64);
  const requests = [];
  const server = net.createServer(socket => {
    let text = ''; socket.setEncoding('utf8'); socket.on('data', chunk => {
      text += chunk;
      const lines = text.split('\n');
      if (lines.length < 3) return;
      assert.equal(lines[0], token);
      const request = JSON.parse(lines[1]);
      requests.push({ method: request.method, protocol: request.protocol });
      socket.end(JSON.stringify(request.method === 'fail' ? { protocol:request.protocol,ok:false,error:{code:'conflict'} } : { protocol:request.protocol,ok:true,result:request.params }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const connection = { port: server.address().port, token };
    assert.deepEqual(await callApi(connection, 'echo', { text: 'a\u2028b\u2029c' }), { text: 'a\u2028b\u2029c' });
    assert.deepEqual(await callApi(connection, 'listSchedules', { workspaceId: 'workspace' }), { workspaceId: 'workspace' });
    const saveGraph = { workspaceId: 'workspace', profiles: [
      { workspaceId: 'workspace', value: { id: 'offline', networkAccess: false } },
      { workspaceId: 'workspace', value: { id: 'online', networkAccess: true } },
    ] };
    assert.deepEqual(await callApi(connection, 'saveGraph', saveGraph), { workspaceId: 'workspace', profiles: [
      { workspaceId: 'workspace', value: { id: 'offline' } },
      { workspaceId: 'workspace', value: { id: 'online', networkAccess: true } },
    ] });
    assert.equal(saveGraph.profiles[0].value.networkAccess, false);
    await assert.rejects(callApi(connection, 'fail'), { code: 'conflict' });
    await assert.rejects(callApi({ ...connection, token: 'invalid' }, 'echo'), /configuration/);
    assert.deepEqual(requests, [
      { method: 'echo', protocol: 1 },
      { method: 'listSchedules', protocol: 2 },
      { method: 'saveGraph', protocol: 1 },
      { method: 'fail', protocol: 1 },
    ]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('offline connection gives recovery instructions without starting or retrying a host', async () => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await assert.rejects(callApi({ port, token: 'a'.repeat(64) }, 'ping'), error =>
    error.code === 'ECONNREFUSED' && error.message.includes('No request was sent') && error.message.includes('Do not start a second host'));
});
