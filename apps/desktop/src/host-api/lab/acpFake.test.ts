import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessRegistryCommandV1, HarnessRegistryV1 } from '../../../../../contracts/harness-registry-v1';
import type { SessionModeResultV1 } from '../../../../../contracts/workspace-session-mode-v1';
import { LAB_GEMINI_DESCRIPTOR, labFingerprint } from './acpFake';
import type { HarnessModelsResult, WorkspaceResult } from './labContracts';
import type { LabHost } from './labHost';
import { labHost, record, rejection, snapshotOf } from './labTestKit';

async function registry(host: LabHost, command: HarnessRegistryCommandV1 = { type: 'list' }): Promise<HarnessRegistryV1> {
  const pending = host.invoke<HarnessRegistryV1>('harness_registry_v1', { command });
  await vi.runAllTimersAsync();
  return pending;
}

async function failure(host: LabHost, command: HarnessRegistryCommandV1): Promise<unknown> {
  const pending = rejection(host.invoke('harness_registry_v1', { command }));
  await vi.runAllTimersAsync();
  return pending;
}

function agent(view: HarnessRegistryV1, id: string) {
  const found = view.agents.find((entry) => entry.descriptor.id === id);
  if (found === undefined) throw new Error(`No agent ${id}.`);
  return found;
}

async function start(host: LabHost, harness: string, model?: { id: string; name: string }): Promise<WorkspaceResult> {
  const chats = host.state.projects.find((project) => project.personal);
  return host.invoke<WorkspaceResult>('workspace_command_v15', {
    command: { type: 'createSession', workspaceId: chats?.id, harness, permissionMode: 'native', ...(model ? { model } : {}) },
  });
}

describe('UI Lab ACP agent registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ships the host Gemini CLI descriptor with the host fingerprint', () => {
    const fixture: unknown = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/acp-descriptors/valid-builtin-gemini-cli.json', import.meta.url), 'utf8'));
    expect(LAB_GEMINI_DESCRIPTOR).toEqual(fixture);
    // `contracts/fixtures/harness-registry-v1.json`: the host's SHA-256 of the canonical descriptor.
    expect(labFingerprint(LAB_GEMINI_DESCRIPTOR)).toBe('546a3012e964972e5071973329d47e81297fbfc3d5d4e508aec9a55031c9b71a');
  });

  it('lists every harness and seeds a ready, a missing and an untrusted ACP agent', async () => {
    const view = await registry(labHost('demo'));
    expect(view).toMatchObject({ protocol: 1, safeMode: false, checked: true });
    expect(view.harnesses.map((harness) => [harness.harness, harness.state])).toEqual([
      ['pi', 'ready'], ['prime-agent', 'ready'], ['codex', 'ready'], ['hermes', 'ready'], ['claude-code', 'ready'],
      ['acp:gemini-cli', 'ready'], ['acp:qwen-code', 'not-installed'], ['acp:lab-agent', 'untrusted'],
    ]);
    expect(view.harnesses.find((harness) => harness.harness === 'codex')).toMatchObject({
      verifiedVersions: '0.147.0 – 0.157.x', signInHint: "Sign in with Codex's own flow: run `codex login` in a terminal.",
    });
    expect(view.harnesses.find((harness) => harness.harness === 'claude-code')?.signInHint).toContain('Claude subscription');
    const gemini = agent(view, 'gemini-cli');
    expect(gemini).toMatchObject({
      source: 'built-in', trusted: true, version: '0.39.1', versionStatus: 'no-verified-range', confirmedVersion: '0.39.1',
      secretEnvironment: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'], allowedSecrets: [],
    });
    expect(gemini.commandLine?.args.slice(1)).toEqual(['--experimental-acp']);
    expect(agent(view, 'qwen-code')).toMatchObject({ state: 'not-installed', reason: "The agent's program was not found on PATH.", trusted: false });
    expect(agent(view, 'lab-agent')).toMatchObject({
      state: 'untrusted', trusted: false, commandLine: { program: 'C:/Users/example/.local/bin/lab-agent.exe', args: ['--acp'] },
    });
    // Listing never probes a user descriptor before trust.
    expect(agent(view, 'lab-agent').version).toBeUndefined();
  });

  it('trusts only the reviewed command line, with revision checks and a change event', async () => {
    const host = labHost('demo');
    const events = await record<{ protocol: number; revision: number }>(host, 'piui://harness-registry-v1');
    const before = await registry(host);
    const lab = agent(before, 'lab-agent');
    const line = lab.commandLine;
    if (line === undefined) throw new Error('Expected a resolved command line.');
    const trust = { type: 'trust' as const, expectedRevision: before.revision, id: 'lab-agent', fingerprint: lab.fingerprint, commandLine: line };
    expect(await failure(host, { ...trust, fingerprint: 'stale' })).toMatchObject({ code: 'TRUST_CHANGED' });
    expect(await failure(host, { ...trust, commandLine: { ...line, args: ['--acp', '--yolo'] } })).toMatchObject({ code: 'TRUST_CHANGED' });
    expect(await failure(host, { ...trust, expectedRevision: before.revision - 1 })).toMatchObject({ code: 'CONFLICT' });
    expect(await failure(host, { ...trust, id: 'gemini-cli' })).toMatchObject({ code: 'BUILT_IN' });
    expect(await failure(host, { ...trust, id: 'qwen-code' })).toMatchObject({ code: 'TRUST_CHANGED' });
    const after = await registry(host, trust);
    expect(after.revision).toBe(before.revision + 1);
    expect(agent(after, 'lab-agent')).toMatchObject({ state: 'ready', trusted: true, version: '1.4.0', versionStatus: 'verified' });
    expect(events.items).toEqual([{ protocol: 1, revision: after.revision }]);
    const catalog = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'catalog' } });
    expect(catalog.type === 'catalog' && catalog.catalog.harnesses.find((row) => row.kind === 'acp:lab-agent'))
      .toMatchObject({ status: 'available', version: '1.4.0' });
  });

  it('refuses ACP starts with typed statuses until the agent is trusted and signed in', async () => {
    const host = labHost('demo');
    expect(await rejection(start(host, 'acp:lab-agent'))).toMatchObject({ code: 'ACP_TRUST_REQUIRED' });
    expect(await rejection(start(host, 'acp:qwen-code'))).toMatchObject({ code: 'UNAVAILABLE' });
    expect(await rejection(start(host, 'acp:no-such-agent'))).toMatchObject({ code: 'UNAVAILABLE' });
    expect(await rejection(start(host, 'acp:Bad'))).toContain('unknown harness `acp:Bad`');
    const view = await registry(host);
    const lab = agent(view, 'lab-agent');
    await registry(host, { type: 'trust', expectedRevision: view.revision, id: 'lab-agent', fingerprint: lab.fingerprint, commandLine: lab.commandLine ?? { program: '', args: [] } });
    expect(await rejection(start(host, 'acp:lab-agent'))).toMatchObject({ code: 'ACP_SIGN_IN_REQUIRED' });
    expect(agent(await registry(host), 'lab-agent')).toMatchObject({ state: 'sign-in-required', authMethods: ['Lab Agent login', 'API key'] });
    // The next start asks the agent again; this time it accepts.
    const created = await start(host, 'acp:lab-agent');
    if (created.type !== 'session') throw new Error('Expected a session.');
    expect(created.snapshot.session).toMatchObject({ harness: 'acp:lab-agent', title: 'New Lab Agent session', model: { id: 'lab-pro' } });
    expect(agent(await registry(host), 'lab-agent')).toMatchObject({ state: 'ready', authMethods: [] });
  });

  it('offers the agent default model and agent-advertised modes', async () => {
    const host = labHost('demo');
    const chats = host.state.projects.find((project) => project.personal);
    const models = await host.invoke<HarnessModelsResult>('harness_models_v18', { request: { workspaceId: chats?.id, harness: 'acp:gemini-cli' } });
    expect(models.models.map((model) => model.id)).toEqual(['default', 'lab-pro', 'lab-flash']);
    expect(models.resources).toEqual({ items: [], warnings: [] });
    expect(await rejection(host.invoke('workspace_command_v15', {
      command: { type: 'createSession', workspaceId: chats?.id, harness: 'acp:gemini-cli', permissionMode: 'read-only' },
    }))).toMatchObject({ code: 'RUNTIME_FAILED' });
    const created = await start(host, 'acp:gemini-cli', { id: 'default', name: 'Agent default' });
    if (created.type !== 'session') throw new Error('Expected a session.');
    const sessionId = created.snapshot.session.id;
    expect(created.snapshot.session.model?.id).toBe('lab-pro');
    expect(created.snapshot.modes).toMatchObject({ current: 'default' });
    expect(created.snapshot.modes?.available.map((mode) => mode.id)).toEqual(['default', 'auto-edit', 'plan']);
    const result = await host.invoke<SessionModeResultV1>('workspace_session_mode_v1', { request: { sessionId, modeId: 'plan' } });
    expect(result).toMatchObject({ protocol: 1, sessionId, modes: { current: 'plan' } });
    expect((await snapshotOf(host, sessionId)).modes?.current).toBe('plan');
    expect(await rejection(host.invoke('workspace_session_mode_v1', { request: { sessionId, modeId: 'yolo' } }))).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await rejection(host.invoke('workspace_session_mode_v1', { request: { sessionId, modeId: 'plan', extra: 1 } }))).toContain('unknown field `extra`');
    expect(await rejection(host.invoke('workspace_command_v15', { command: { type: 'send', sessionId, text: 'steer', mode: 'steer' } })))
      .toMatchObject({ code: 'RUNTIME_FAILED' });
    // Built-in harnesses advertise no ACP modes.
    const codex = await start(host, 'codex');
    if (codex.type !== 'session') throw new Error('Expected a session.');
    expect(codex.snapshot.modes).toBeUndefined();
  });

  it('adds, confirms, allows secrets and removes user descriptors', async () => {
    const host = labHost('demo');
    let view = await registry(host);
    const invalid = await failure(host, { type: 'add', expectedRevision: view.revision, descriptor: { ...LAB_GEMINI_DESCRIPTOR, id: 'x-agent', shell: 'cmd' } as never });
    expect(invalid).toEqual({ code: 'INVALID_DESCRIPTOR', message: 'The descriptor is not valid JSON or contains unknown fields.', recoverable: true });
    expect(await failure(host, { type: 'add', expectedRevision: view.revision, descriptor: LAB_GEMINI_DESCRIPTOR })).toMatchObject({ code: 'DUPLICATE' });
    const tool = {
      schemaVersion: 1 as const, id: 'tool-agent', displayName: 'Tool Agent',
      command: { program: 'C:/Tools/tool-agent.js', args: ['acp'] }, version: { args: ['--version'] }, environment: ['TOOL_SECRET', 'TOOL_HOME'],
    };
    view = await registry(host, { type: 'add', expectedRevision: view.revision, descriptor: tool });
    const added = agent(view, 'tool-agent');
    expect(added).toMatchObject({ source: 'user', state: 'untrusted', secretEnvironment: ['TOOL_SECRET'] });
    // A Node script runs through Node, never through a shell.
    expect(added.commandLine).toEqual({ program: 'C:/Program Files/nodejs/node.exe', args: ['C:/Tools/tool-agent.js', 'acp'] });
    view = await registry(host, { type: 'trust', expectedRevision: view.revision, id: 'tool-agent', fingerprint: added.fingerprint, commandLine: added.commandLine ?? { program: '', args: [] } });
    expect(agent(view, 'tool-agent')).toMatchObject({ state: 'unverified-version', version: '1.0.0', versionStatus: 'no-verified-range' });
    expect(await rejection(start(host, 'acp:tool-agent'))).toMatchObject({ code: 'ACP_VERSION_UNCONFIRMED' });
    expect(await failure(host, { type: 'confirmVersion', expectedRevision: view.revision, id: 'tool-agent', version: '9.9.9' })).toMatchObject({ code: 'NOTHING_TO_CONFIRM' });
    view = await registry(host, { type: 'confirmVersion', expectedRevision: view.revision, id: 'tool-agent', version: '1.0.0' });
    expect(agent(view, 'tool-agent')).toMatchObject({ state: 'ready', confirmedVersion: '1.0.0' });
    expect(await failure(host, { type: 'allowSecrets', expectedRevision: view.revision, id: 'tool-agent', fingerprint: added.fingerprint, names: ['TOOL_HOME'] }))
      .toMatchObject({ code: 'NOTHING_TO_CONFIRM' });
    view = await registry(host, { type: 'allowSecrets', expectedRevision: view.revision, id: 'tool-agent', fingerprint: added.fingerprint, names: ['TOOL_SECRET'] });
    expect(agent(view, 'tool-agent').allowedSecrets).toEqual(['TOOL_SECRET']);
    expect(await failure(host, { type: 'remove', expectedRevision: view.revision, id: 'gemini-cli' })).toMatchObject({ code: 'BUILT_IN' });
    view = await registry(host, { type: 'remove', expectedRevision: view.revision, id: 'tool-agent' });
    expect(view.agents.map((entry) => entry.descriptor.id)).toEqual(['gemini-cli', 'qwen-code', 'lab-agent']);
    expect(await failure(host, { type: 'remove', expectedRevision: view.revision, id: 'tool-agent' })).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('checks again, starts a fresh machine without Gemini and refuses changes in safe mode', async () => {
    const empty = labHost('empty');
    const fresh = await registry(empty, { type: 'check' });
    expect(fresh.agents.map((entry) => [entry.descriptor.id, entry.state])).toEqual([['gemini-cli', 'not-installed']]);
    expect(await failure(empty, { type: 'confirmVersion', expectedRevision: fresh.revision, id: 'gemini-cli', version: '0.39.1' }))
      .toMatchObject({ code: 'NOTHING_TO_CONFIRM' });
    const safe = labHost('safe');
    const listed = await registry(safe);
    expect(listed).toMatchObject({ safeMode: true, checked: false });
    expect(agent(listed, 'gemini-cli')).toMatchObject({ state: 'checking', reason: 'Checking this agent…' });
    expect(await failure(safe, { type: 'check' })).toEqual({ code: 'SAFE_MODE', message: 'Harness checks and changes are disabled in safe mode.', recoverable: true });
    expect(await rejection(safe.invoke('harness_registry_v1', { command: { type: 'list', extra: true } }))).toContain('unknown field `extra`');
    expect(await rejection(safe.invoke('harness_registry_v1', { command: { type: 'remove', expectedRevision: 1, id: 'Bad_Id' } })))
      .toContain('an ACP agent id is a lowercase slug');
  });
});
