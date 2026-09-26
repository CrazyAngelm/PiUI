import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWorkspaceEvent } from '../../features/workspace/workspaceState';
import { createWorkspaceClient } from '../workspaceClient';
import type {
  HarnessKind, HarnessModelsResult, RuntimeSettings, SessionSnapshot, WorkspaceEvent, WorkspaceHistoryResultV1, WorkspaceResult,
} from './labContracts';
import type { LabHost } from './labHost';
import { consecutive, labHost, record, rejection, settle, untilStreaming } from './labTestKit';

const EVENTS = 'piui://workspace-event';

function projectId(host: LabHost, name: string): string {
  const project = host.state.projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new Error(`No project ${name}`);
  return project.id;
}

function sessionId(host: LabHost, title: string): string {
  const session = [...host.state.sessions.values()].find((candidate) => candidate.title === title);
  if (session === undefined) throw new Error(`No session ${title}`);
  return session.id;
}

async function command(host: LabHost, value: Record<string, unknown>): Promise<WorkspaceResult> {
  return host.invoke<WorkspaceResult>('workspace_command_v15', { command: value });
}

async function snapshot(host: LabHost, id: string): Promise<SessionSnapshot> {
  const result = await command(host, { type: 'snapshot', sessionId: id });
  if (result.type !== 'session') throw new Error('Expected a session snapshot.');
  return result.snapshot;
}

async function create(host: LabHost, harness: HarnessKind, extra: Record<string, unknown> = {}): Promise<SessionSnapshot> {
  const result = await command(host, { type: 'createSession', workspaceId: projectId(host, 'piui'), harness, permissionMode: 'native', ...extra });
  if (result.type !== 'session') throw new Error('Expected a created session.');
  return result.snapshot;
}

describe('UI Lab workspace host', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a session and streams a full turn the UI reducer reproduces exactly', async () => {
    const host = labHost();
    const events = await record<WorkspaceEvent>(host, EVENTS);
    const created = await create(host, 'prime-agent', { title: '  Lab turn  ' });
    expect(created.revision).toBe(0);
    expect(created.session).toMatchObject({ title: 'Lab turn', status: 'idle', harness: 'prime-agent', model: { id: 'prime-lab-large' } });
    expect(created.models.length).toBeGreaterThan(0);
    expect(await command(host, { type: 'send', sessionId: created.session.id, text: 'Explain the transport layer', mode: 'prompt' }))
      .toEqual({ type: 'accepted', sessionId: created.session.id });

    await vi.advanceTimersByTimeAsync(10_000);
    const mine = events.items.filter((event) => event.sessionId === created.session.id);
    expect(consecutive(mine, created.session.id, 0)).toBe(true);
    expect(mine[0]?.event).toMatchObject({ type: 'session', session: { status: 'idle' } });
    expect(mine[1]?.event).toMatchObject({ type: 'session', session: { status: 'running' } });
    expect(mine.at(-1)?.event).toMatchObject({ type: 'session', session: { status: 'idle' } });
    const kinds = new Set(mine.map((event) => event.event.type));
    expect(kinds).toEqual(new Set(['session', 'block', 'textDelta']));
    const blocks = mine.flatMap((event) => (event.event.type === 'block' ? [event.event.block] : []));
    expect(new Set(blocks.map((block) => block.kind))).toEqual(new Set(['user', 'thinking', 'tool', 'assistant']));

    let replayed = created;
    for (const event of mine) {
      const applied = applyWorkspaceEvent(replayed, event);
      expect(applied.type).toBe('applied');
      replayed = applied.snapshot;
    }
    const latest = await snapshot(host, created.session.id);
    expect(latest.revision).toBe(mine.at(-1)?.revision);
    expect(replayed.blocks).toEqual(latest.blocks);
    expect(latest.blocks.every((block) => block.status === 'complete')).toBe(true);
    expect(latest.session.status).toBe('idle');
  });

  it('streams Hermes turns as whole-block updates instead of text deltas', async () => {
    const host = labHost();
    const events = await record<WorkspaceEvent>(host, EVENTS);
    const created = await create(host, 'hermes');
    await command(host, { type: 'send', sessionId: created.session.id, text: 'Summarize the render queue', mode: 'prompt' });
    await vi.advanceTimersByTimeAsync(3_000);
    const approval = events.items.find((event) => event.event.type === 'approval');
    if (approval?.event.type === 'approval') {
      await command(host, { type: 'respond', sessionId: created.session.id, requestId: approval.event.approval.id, decision: 'approve-once' });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    const mine = events.items.filter((event) => event.sessionId === created.session.id);
    expect(mine.some((event) => event.event.type === 'textDelta')).toBe(false);
    expect(mine.filter((event) => event.event.type === 'block').length).toBeGreaterThan(10);
    expect(mine.at(-1)?.event).toMatchObject({ type: 'session', session: { status: 'idle' } });
  });

  it('pauses a turn on an approval until respond, then finishes it', async () => {
    const host = labHost();
    const events = await record<WorkspaceEvent>(host, EVENTS);
    const created = await create(host, 'codex');
    const id = created.session.id;
    await command(host, { type: 'send', sessionId: id, text: 'Deploy the preview build', mode: 'prompt' });
    await vi.advanceTimersByTimeAsync(5_000);
    const request = events.items.find((event) => event.event.type === 'approval');
    if (request?.event.type !== 'approval') throw new Error('Expected an approval request.');
    expect(request.event.approval).toMatchObject({
      kind: 'command', title: 'Run command', decisions: ['approve-once', 'approve-session', 'deny', 'cancel'],
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const waiting = await snapshot(host, id);
    expect(waiting.session.status).toBe('running');
    expect(waiting.approvals).toHaveLength(1);

    expect(await rejection(command(host, { type: 'respond', sessionId: id, requestId: 'stale', decision: 'approve-once' })))
      .toMatchObject({ code: 'APPROVAL_EXPIRED' });
    await command(host, { type: 'respond', sessionId: id, requestId: request.event.approval.id, decision: 'approve-once' });
    await vi.advanceTimersByTimeAsync(10_000);
    const done = await snapshot(host, id);
    expect(done.session.status).toBe('idle');
    expect(done.approvals).toEqual([]);
    expect(events.items.some((event) => event.event.type === 'approvalResolved')).toBe(true);
    expect(done.blocks.find((block) => block.kind === 'tool')?.text).toContain('Command:');
    expect(consecutive(events.items.filter((event) => event.sessionId === id), id, 0)).toBe(true);
  });

  it('resolves a declined approval by skipping the command', async () => {
    const host = labHost();
    const created = await create(host, 'pi');
    const id = created.session.id;
    await command(host, { type: 'send', sessionId: id, text: 'Install the release build', mode: 'prompt' });
    await vi.advanceTimersByTimeAsync(5_000);
    const [approval] = (await snapshot(host, id)).approvals;
    expect(approval).toMatchObject({ kind: 'permission', decisions: ['approve-once', 'deny', 'cancel'] });
    await command(host, { type: 'respond', sessionId: id, requestId: approval?.id, decision: 'deny' });
    await vi.advanceTimersByTimeAsync(10_000);
    const done = await snapshot(host, id);
    expect(done.blocks.find((block) => block.kind === 'tool')?.status).toBe('interrupted');
    expect(done.blocks.at(-1)?.text).toContain('declined');
  });

  it('seeds an MCP form request whose answer is checked like the adapter does', async () => {
    const host = labHost();
    const id = sessionId(host, 'File an issue for the broken docs link');
    const before = await snapshot(host, id);
    expect(before.session).toMatchObject({ harness: 'codex', status: 'running' });
    const [approval] = before.approvals;
    expect(approval).toMatchObject({ kind: 'input', title: 'MCP server request', decisions: ['approve-once', 'deny', 'cancel'] });
    expect(approval?.form).toMatchObject({ server: 'lab-issues', limitation: 'optional-fields-omitted' });
    expect(approval?.form?.fields.map((field) => field.type)).toEqual(['text', 'choice', 'number', 'boolean', 'text']);
    const respond = (text: string | undefined) => command(host, {
      type: 'respond', sessionId: id, requestId: approval?.id, decision: 'approve-once', ...(text === undefined ? {} : { text }),
    });
    for (const text of [
      undefined,
      JSON.stringify({ 'field-1': 'Bug', 'field-2': 'choice-2' }),
      JSON.stringify({ 'field-1': 'Broken link', 'field-2': 'normal' }),
      JSON.stringify({ 'field-1': 'Broken link', 'field-2': 'choice-2', 'field-3': 41 }),
      JSON.stringify({ 'field-1': 'Broken link', 'field-2': 'choice-2', title: 'native name' }),
    ]) {
      expect(await rejection(respond(text)), text).toMatchObject({ code: 'RUNTIME_FAILED' });
    }
    expect((await snapshot(host, id)).approvals).toHaveLength(1);
    await respond(JSON.stringify({ 'field-1': 'Broken link in the harness guide', 'field-2': 'choice-1', 'field-3': 2, 'field-4': true }));
    await vi.advanceTimersByTimeAsync(10_000);
    const after = await snapshot(host, id);
    expect(after.approvals).toEqual([]);
    expect(after.session.status).toBe('idle');
    expect(after.blocks.find((block) => block.id === 'issue-triage-create')).toMatchObject({ status: 'complete', title: 'lab-issues.create_issue' });
    expect(after.blocks.at(-1)?.text).toContain('LAB-142');
  });

  it('declining the seeded MCP form request skips the MCP tool', async () => {
    const host = labHost();
    const id = sessionId(host, 'File an issue for the broken docs link');
    const [approval] = (await snapshot(host, id)).approvals;
    await command(host, { type: 'respond', sessionId: id, requestId: approval?.id, decision: 'deny' });
    await vi.advanceTimersByTimeAsync(10_000);
    const after = await snapshot(host, id);
    expect(after.approvals).toEqual([]);
    expect(after.blocks.some((block) => block.id === 'issue-triage-create')).toBe(false);
    expect(after.blocks.at(-1)?.text).toContain('did not file');
  });

  it('continues the seeded approval session and then drains its queued follow-up', async () => {
    const host = labHost();
    const id = sessionId(host, 'Fix flaky scheduler test');
    const before = await snapshot(host, id);
    expect(before.session.status).toBe('running');
    const [approval] = before.approvals;
    expect(approval?.title).toBe('Run the full e2e suite?');
    await command(host, { type: 'respond', sessionId: id, requestId: approval?.id, decision: 'approve-once' });
    await vi.advanceTimersByTimeAsync(15_000);
    const after = await snapshot(host, id);
    expect(after.blocks.find((block) => block.id === 'scheduler-e2e')).toMatchObject({ status: 'complete' });
    expect(after.blocks.some((block) => block.kind === 'user' && block.text?.includes('CHANGELOG'))).toBe(true);
    const settled = await settle(host, id);
    expect(settled.session.status).toBe('idle');
    expect(settled.blocks.at(-1)?.kind).toBe('assistant');
  });

  it('interrupts a turn: streaming blocks stop as interrupted and no further events arrive', async () => {
    const host = labHost();
    const events = await record<WorkspaceEvent>(host, EVENTS);
    const created = await create(host, 'prime-agent');
    const id = created.session.id;
    await command(host, { type: 'send', sessionId: id, text: 'Write a long report', mode: 'prompt' });
    await untilStreaming(host, id);
    await command(host, { type: 'interrupt', sessionId: id });
    await vi.advanceTimersByTimeAsync(0);
    const stopped = await snapshot(host, id);
    expect(stopped.session.status).toBe('idle');
    expect(stopped.blocks.some((block) => block.status === 'interrupted')).toBe(true);
    expect(stopped.blocks.some((block) => block.status === 'streaming')).toBe(false);
    const count = events.items.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.items.length).toBe(count);
    expect(consecutive(events.items.filter((event) => event.sessionId === id), id, 0)).toBe(true);
  });

  it('keeps the seeded Prime session streaming while ambient activity runs', async () => {
    const host = labHost('demo', { ambient: true });
    const events = await record<WorkspaceEvent>(host, EVENTS);
    const id = sessionId(host, 'Streaming markdown renderer spike');
    await vi.advanceTimersByTimeAsync(30_000);
    const streamed = events.items.filter((event) => event.sessionId === id);
    expect(streamed.length).toBeGreaterThan(50);
    expect(consecutive(streamed, id, (streamed[0]?.revision ?? 1) - 1)).toBe(true);
    expect(streamed.some((event) => event.event.type === 'textDelta')).toBe(true);
    expect((await snapshot(host, id)).session.status).toBe('running');
  });

  it('opens and closes native runtimes with the host revision watermark', async () => {
    const host = labHost();
    const events = await record<WorkspaceEvent>(host, EVENTS);
    const id = sessionId(host, 'Plan a weekend in Lisbon');
    const closed = await snapshot(host, id);
    expect(closed.session.status).toBe('closed');
    expect(closed.blocks.every((block) => ['You', 'Assistant', 'Reasoning'].includes(block.label))).toBe(true);
    const opened = await command(host, { type: 'openSession', sessionId: id });
    if (opened.type !== 'session') throw new Error('Expected a snapshot.');
    expect(opened.snapshot.session.status).toBe('idle');
    expect(opened.snapshot.revision).toBe(closed.revision);
    expect(opened.snapshot.blocks.find((block) => block.kind === 'assistant')?.label).toBe('Pi');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.items.at(-1)).toMatchObject({ sessionId: id, revision: closed.revision + 1, event: { type: 'session' } });
    await command(host, { type: 'closeSession', sessionId: id });
    const after = await snapshot(host, id);
    expect(after.session.status).toBe('closed');
    expect(after.revision).toBe(closed.revision + 2);
    expect(await rejection(command(host, { type: 'send', sessionId: id, text: 'hi', mode: 'prompt' })))
      .toMatchObject({ code: 'NOT_FOUND', message: 'Open the workspace session before using it.' });
  });

  it('validates runtime settings like workspace_settings_v16', async () => {
    const host = labHost();
    const id = sessionId(host, 'Route host calls through one transport');
    const settings = (value: Record<string, unknown>) => host.invoke<RuntimeSettings>('workspace_settings_v16', { command: value });
    const current = await settings({ type: 'get', sessionId: id });
    expect(current).toMatchObject({ protocol: 16, sessionId: id, model: { id: 'gpt-lab-5-codex' }, thinkingLevel: 'high', serviceTier: 'fast' });
    const mini = current.models.find((model) => model.id === 'gpt-lab-5-mini');
    const changed = await settings({ type: 'set', sessionId: id, model: mini, thinkingLevel: 'low', serviceTier: 'standard' });
    expect(changed).toMatchObject({ model: { id: 'gpt-lab-5-mini' }, thinkingLevel: 'low', serviceTier: 'standard' });
    const invalid = [
      { type: 'set', sessionId: id, model: { id: 'ghost', provider: 'openai-lab', name: 'Ghost' } },
      { type: 'set', sessionId: id, model: mini, thinkingLevel: 'xhigh' },
      { type: 'set', sessionId: id, model: mini, serviceTier: 'turbo' },
    ];
    for (const value of invalid) expect(await rejection(settings(value))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const pi = sessionId(host, 'Fix flaky scheduler test');
    const piModel = (await settings({ type: 'get', sessionId: pi })).models[0];
    expect(await rejection(settings({ type: 'set', sessionId: pi, model: piModel }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((await settings({ type: 'get', sessionId: pi })).serviceTier).toBeNull();
    const closed = sessionId(host, 'Plan a weekend in Lisbon');
    expect(await rejection(settings({ type: 'get', sessionId: closed }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('projects closed history with host limits and serves full answers from workspace_history_v1', async () => {
    const host = labHost();
    const id = sessionId(host, 'Session compaction deep-dive');
    const closed = await snapshot(host, id);
    const long = closed.blocks.at(-1);
    expect(long).toMatchObject({ kind: 'assistant', label: 'Assistant', truncated: true });
    expect(long?.text?.endsWith('…')).toBe(true);
    expect(new TextEncoder().encode(long?.text ?? '').length).toBeLessThanOrEqual(64 * 1024);
    expect(closed.blocks.some((block) => block.kind === 'compaction' && block.title === 'Context compacted')).toBe(true);
    const history = await host.invoke<WorkspaceHistoryResultV1>('workspace_history_v1', { request: { sessionId: id } });
    expect(history.protocol).toBe(1);
    const full = history.blocks.find((block) => block.id === long?.id);
    expect(full?.truncated).toBeUndefined();
    expect((full?.text?.length ?? 0)).toBeGreaterThan(64 * 1024);
    const transport = await host.invoke<WorkspaceHistoryResultV1>('workspace_history_v1', {
      request: { sessionId: sessionId(host, 'Route host calls through one transport') },
    });
    expect(transport.blocks.some((block) => block.kind === 'tool' && block.truncated === true)).toBe(true);
  });

  it('enforces trust, lifecycle and creation rules with host error codes', async () => {
    const host = labHost();
    const legacy = sessionId(host, 'Audit legacy auth module');
    expect((await snapshot(host, legacy)).blocks.length).toBeGreaterThan(0);
    expect(await rejection(command(host, { type: 'openSession', sessionId: legacy }))).toMatchObject({ code: 'NOT_TRUSTED' });
    expect(await rejection(command(host, {
      type: 'createSession', workspaceId: projectId(host, 'legacy-repo'), harness: 'pi', permissionMode: 'native',
    }))).toMatchObject({ code: 'NOT_TRUSTED' });
    expect(await rejection(create(host, 'pi', { permissionMode: 'workspace-write' }))).toMatchObject({ code: 'RUNTIME_FAILED' });
    expect(await rejection(create(host, 'pi', { title: '   ' }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await rejection(create(host, 'pi', { model: { id: 'ghost', provider: 'anthropic-lab', name: 'Ghost' } })))
      .toMatchObject({ code: 'RUNTIME_FAILED' });
    const chosen = await create(host, 'pi', { model: { id: 'gpt-lab-5', provider: 'openai-lab', name: 'GPT Lab 5' } });
    expect(chosen.session.model).toMatchObject({ id: 'gpt-lab-5', provider: 'openai-lab' });

    const lifecycle = (id: string) => host.invoke('workspace_lifecycle_v17', { command: { type: 'deleteSession', sessionId: id } });
    const run = [...host.state.sessions.values()].find((session) => session.runId !== undefined);
    expect(await rejection(lifecycle(run?.id ?? ''))).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await rejection(lifecycle(sessionId(host, 'Fix flaky scheduler test')))).toMatchObject({ code: 'CONFLICT' });
    expect(await rejection(lifecycle('not-a-uuid'))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const lisbon = sessionId(host, 'Plan a weekend in Lisbon');
    expect(await lifecycle(lisbon)).toEqual({ protocol: 17, sessionId: lisbon });
    expect(await rejection(snapshot(host, lisbon))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serves native model catalogs with providers, Fast support and resources after a probe delay', async () => {
    const host = labHost();
    const pending = host.invoke<HarnessModelsResult>('harness_models_v18', { request: { workspaceId: projectId(host, 'piui'), harness: 'codex' } });
    await vi.advanceTimersByTimeAsync(400);
    const catalog = await pending;
    expect(catalog.protocol).toBe(18);
    expect(catalog.models.every((model) => typeof model.provider === 'string' && model.supportsFast === true)).toBe(true);
    expect(new Set(catalog.resources.items.map((item) => item.kind))).toEqual(new Set(['skill', 'mcp', 'tool']));
    expect(catalog.resources.items.some((item) => !item.configurable)).toBe(true);
    const empty = labHost('empty');
    const chats = empty.state.projects[0]?.id;
    expect(await rejection(empty.invoke('harness_models_v18', { request: { workspaceId: chats, harness: 'hermes' } })))
      .toMatchObject({ code: 'RUNTIME_FAILED' });
  });

  it('runs Claude Code on the subscription only: effort catalog, no fast mode, typed sign-in status', async () => {
    const host = labHost();
    const created = await create(host, 'claude-code', { permissionMode: 'workspace-write' });
    expect(created.session).toMatchObject({ harness: 'claude-code', title: 'New Claude Code session', model: { id: 'lab-sonnet', provider: 'anthropic' } });
    expect(created.models.map((model) => model.name)).toEqual(['Claude Lab Sonnet', 'Claude Lab Opus', 'Claude Lab Haiku']);
    expect(created.models[1]?.thinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(created.capabilities.nativeSubagents).toMatchObject({ supported: true, enforcement: 'coordinator' });
    const pending = host.invoke<HarnessModelsResult>('harness_models_v18', { request: { workspaceId: projectId(host, 'piui'), harness: 'claude-code' } });
    await vi.advanceTimersByTimeAsync(400);
    const catalog = await pending;
    expect(catalog.models.every((model) => model.provider === 'anthropic' && model.supportsFast === false)).toBe(true);
    expect(catalog.resources.items.every((item) => item.kind === 'skill' && !item.configurable)).toBe(true);

    const id = created.session.id;
    const opus = { id: 'lab-opus', provider: 'anthropic', name: 'Claude Lab Opus', thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] };
    expect(await rejection(host.invoke('workspace_settings_v16', { command: { type: 'set', sessionId: id, model: opus, thinkingLevel: 'max', serviceTier: 'fast' } })))
      .toMatchObject({ code: 'NOT_SUPPORTED' });
    const settings = await host.invoke<RuntimeSettings>('workspace_settings_v16', {
      command: { type: 'set', sessionId: id, model: opus, thinkingLevel: 'max', serviceTier: 'standard' },
    });
    expect(settings).toMatchObject({ model: { id: 'lab-opus' }, thinkingLevel: 'max', serviceTier: null });

    const demoChat = sessionId(host, 'Map pipeline editor shortcuts');
    expect((await snapshot(host, demoChat)).session).toMatchObject({ harness: 'claude-code', status: 'idle' });

    const empty = labHost('empty');
    const chats = empty.state.projects[0]?.id;
    expect(await rejection(empty.invoke('workspace_command_v15', {
      command: { type: 'createSession', workspaceId: chats, harness: 'claude-code', permissionMode: 'native' },
    }))).toMatchObject({ code: 'SIGN_IN_REQUIRED' });
    const refused = rejection(empty.invoke('harness_models_v18', { request: { workspaceId: chats, harness: 'claude-code' } }));
    await vi.advanceTimersByTimeAsync(400);
    expect(await refused).toMatchObject({
      code: 'SIGN_IN_REQUIRED',
      message: 'Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.',
    });
  });

  it('rejects every runtime action in safe mode while history stays readable', async () => {
    const host = labHost('safe');
    const id = sessionId(host, 'Route host calls through one transport');
    expect((await snapshot(host, id)).session.status).toBe('closed');
    expect((await host.invoke<WorkspaceHistoryResultV1>('workspace_history_v1', { request: { sessionId: id } })).blocks.length).toBeGreaterThan(0);
    const refused = [
      command(host, { type: 'openSession', sessionId: id }),
      command(host, { type: 'send', sessionId: id, text: 'hello', mode: 'prompt' }),
      command(host, { type: 'createSession', workspaceId: projectId(host, 'piui'), harness: 'pi', permissionMode: 'native' }),
      host.invoke('workspace_settings_v16', { command: { type: 'get', sessionId: id } }),
      host.invoke('workspace_lifecycle_v17', { command: { type: 'deleteSession', sessionId: id } }),
      host.invoke('workspace_composer_v19', { command: { type: 'snapshot', sessionId: id } }),
      host.invoke('harness_models_v18', { request: { workspaceId: projectId(host, 'piui'), harness: 'pi' } }),
    ];
    for (const attempt of refused) expect(await rejection(attempt)).toMatchObject({ code: 'SAFE_MODE' });
  });

  it('works through the production workspace client and its validation', async () => {
    const host = labHost();
    const client = createWorkspaceClient((route, args) => host.invoke(route, args), (channel, handler) => host.listen(channel, handler));
    const catalog = await client.catalog();
    expect(catalog.sessions.length).toBeGreaterThan(10);
    const received: WorkspaceEvent[] = [];
    await client.listen((event) => received.push(event));
    const id = sessionId(host, 'Route host calls through one transport');
    expect((await client.snapshot(id)).session.id).toBe(id);
    await client.request({ type: 'renameSession', sessionId: id, title: 'Renamed in the lab' });
    await vi.advanceTimersByTimeAsync(0);
    expect(received.at(-1)?.event).toMatchObject({ type: 'session', session: { title: 'Renamed in the lab' } });
    await expect(client.request({ type: 'openSession', sessionId: sessionId(host, 'Audit legacy auth module') }))
      .rejects.toMatchObject({ code: 'NOT_TRUSTED', message: 'Trust this project before starting or controlling its agents.' });
  });
});
