import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatPipelineV1, PipelineLibraryResultV1, PipelineTemplateV1 } from '../../../../../contracts/pipeline-library-v1';
import { MAX_CHAT_RUNS, MAX_TEMPLATE_BYTES, MAX_TEMPLATES } from '../../../../../contracts/pipeline-library-v1';
import { decodePipelineLibraryResult } from '../pipelineLibraryClient';
import type { LabHost } from './labHost';
import { labHost, rejection } from './labTestKit';
import { DEMO_PROJECTS, demoSessionId } from './scenarios/demoChats';

const CHAT = demoSessionId('transport');
const SYSTEM = { format: 'piui-system', version: 4, nodes: [] };

async function library(host: LabHost, command: Record<string, unknown>): Promise<PipelineLibraryResultV1> {
  const result = await host.invoke<unknown>('pipeline_library_v1', { command });
  const decoded = decodePipelineLibraryResult(result);
  if (decoded === undefined) throw new Error(`invalid pipeline library result ${JSON.stringify(result)}`);
  return decoded;
}

async function save(host: LabHost, template: Record<string, unknown>): Promise<PipelineTemplateV1> {
  const result = await library(host, { type: 'saveTemplate', template: { scope: { kind: 'global' }, system: SYSTEM, ...template } });
  if (result.type !== 'template') throw new Error('expected a template');
  return result.template;
}

async function names(host: LabHost, workspaceId: string): Promise<string[]> {
  const result = await library(host, { type: 'list', workspaceId });
  return result.type === 'library' ? result.templates.map((template) => template.name) : [];
}

async function chat(host: LabHost, command: Record<string, unknown>): Promise<ChatPipelineV1 | null> {
  const result = await library(host, command);
  if (result.type !== 'chat') throw new Error('expected a chat');
  return result.chat;
}

describe('pipeline library lab fake', () => {
  let host: LabHost;
  beforeEach(() => {
    vi.useFakeTimers();
    host = labHost('demo');
  });
  afterEach(() => vi.useRealTimers());

  it('saves, replaces, scopes, sorts and deletes templates', async () => {
    const first = await save(host, { name: '  beta  ' });
    expect(first.name).toBe('beta');
    expect(first.createdAt).toBe(first.updatedAt);
    await save(host, { name: 'Alpha', scope: { kind: 'workspace', workspaceId: DEMO_PROJECTS.piui } });
    await save(host, { name: 'gamma', scope: { kind: 'workspace', workspaceId: DEMO_PROJECTS.video } });
    expect(await names(host, DEMO_PROJECTS.piui)).toEqual(['Alpha', 'beta']);
    expect(await names(host, DEMO_PROJECTS.video)).toEqual(['beta', 'gamma']);

    await vi.advanceTimersByTimeAsync(5_000);
    const replaced = await save(host, { id: first.id, name: 'Delta', description: 'Renamed' });
    expect(replaced).toMatchObject({ id: first.id, createdAt: first.createdAt, description: 'Renamed' });
    expect(replaced.updatedAt).not.toBe(first.createdAt);
    await expect(library(host, { type: 'deleteTemplate', id: first.id })).resolves.toEqual({ protocol: 1, type: 'deleted', id: first.id });
    expect(await names(host, DEMO_PROJECTS.video)).toEqual(['gamma']);
  });

  it('refuses invalid drafts, unknown ids and a full library', async () => {
    const refused = (template: Record<string, unknown>) =>
      rejection(host.invoke('pipeline_library_v1', { command: { type: 'saveTemplate', template: { scope: { kind: 'global' }, system: SYSTEM, name: 'Ok', ...template } } }));
    expect(await refused({ name: '   ' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await refused({ name: 'n'.repeat(121) })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await refused({ description: 'd'.repeat(501) })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await refused({ system: ['piui-system'] })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await refused({ system: { format: 'n8n' } })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await refused({ system: { format: 'piui-system', blob: 'x'.repeat(MAX_TEMPLATE_BYTES) } })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await refused({ scope: { kind: 'workspace', workspaceId: '' } })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await refused({ id: 'missing' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(host.invoke('pipeline_library_v1', { command: { type: 'deleteTemplate', id: 'missing' } })))
      .toMatchObject({ code: 'NOT_FOUND' });
    // Unknown fields fail decoding like `deny_unknown_fields`.
    await expect(host.invoke('pipeline_library_v1', { command: { type: 'list', workspaceId: 'w', extra: 1 } })).rejects.toBeDefined();

    for (let index = 0; index < MAX_TEMPLATES; index += 1) await save(host, { name: `T${index}` });
    expect(await refused({})).toMatchObject({ code: 'LIMIT' });
  });

  it('sets and removes the chat default of a project', async () => {
    const set = await library(host, { type: 'setChatDefault', workspaceId: DEMO_PROJECTS.piui, launchCommandId: 'launch' });
    expect(set).toMatchObject({ type: 'library', chatDefault: 'launch' });
    const cleared = await library(host, { type: 'setChatDefault', workspaceId: DEMO_PROJECTS.piui });
    expect(cleared.type === 'library' && cleared.chatDefault).toBeUndefined();
  });

  it('binds chats of their own project and records runs once', async () => {
    expect(await chat(host, { type: 'chat', sessionId: CHAT })).toBeNull();
    const bound = await chat(host, { type: 'setChatPipeline', sessionId: CHAT, workspaceId: DEMO_PROJECTS.piui, launchCommandId: 'launch' });
    expect(bound).toEqual({ sessionId: CHAT, workspaceId: DEMO_PROJECTS.piui, launchCommandId: 'launch', runs: [] });
    expect(await rejection(host.invoke('pipeline_library_v1', {
      command: { type: 'setChatPipeline', sessionId: CHAT, workspaceId: DEMO_PROJECTS.video, launchCommandId: 'launch' },
    }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(host.invoke('pipeline_library_v1', {
      command: { type: 'recordChatRun', sessionId: 'no-such-chat', workspaceId: DEMO_PROJECTS.piui, runId: 'run' },
    }))).toMatchObject({ code: 'NOT_FOUND' });

    const record = (runId: string) => chat(host, { type: 'recordChatRun', sessionId: CHAT, workspaceId: DEMO_PROJECTS.piui, runId });
    const first = await record('run-1');
    await vi.advanceTimersByTimeAsync(1_000);
    const again = await record('run-1');
    expect(again?.runs).toEqual(first?.runs);

    const unbound = await chat(host, { type: 'setChatPipeline', sessionId: CHAT, workspaceId: DEMO_PROJECTS.piui });
    expect(unbound?.launchCommandId).toBeUndefined();
    expect(unbound?.runs.map((run) => run.runId)).toEqual(['run-1']);

    for (let index = 2; index <= MAX_CHAT_RUNS + 1; index += 1) await record(`run-${index}`);
    const full = await chat(host, { type: 'chat', sessionId: CHAT });
    expect(full?.runs).toHaveLength(MAX_CHAT_RUNS);
    expect(full?.runs[0]?.runId).toBe('run-2');

    const consumed = await chat(host, { type: 'consumeChatRuns', sessionId: CHAT, runIds: ['run-3', 'unknown'] });
    expect(consumed?.runs.find((run) => run.runId === 'run-3')?.consumed).toBe(true);
    expect(consumed?.runs.find((run) => run.runId === 'run-4')).not.toHaveProperty('consumed');
    expect(await chat(host, { type: 'consumeChatRuns', sessionId: 'missing', runIds: ['run-3'] })).toBeNull();
  });

  it('reads in safe mode and refuses every change', async () => {
    const safe = labHost('safe');
    await expect(library(safe, { type: 'list', workspaceId: DEMO_PROJECTS.piui })).resolves.toMatchObject({ type: 'library' });
    await expect(library(safe, { type: 'chat', sessionId: CHAT })).resolves.toMatchObject({ type: 'chat', chat: null });
    expect(await rejection(safe.invoke('pipeline_library_v1', { command: { type: 'setChatDefault', workspaceId: DEMO_PROJECTS.piui, launchCommandId: 'l' } })))
      .toMatchObject({ code: 'SAFE_MODE' });
    expect(await rejection(safe.invoke('pipeline_library_v1', { command: { type: 'saveTemplate', template: { name: 'x', scope: { kind: 'global' }, system: SYSTEM } } })))
      .toMatchObject({ code: 'SAFE_MODE' });
  });
});
