import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationClient, OrchestrationRunV6, PipelineDefinition, StartRunRequestV7 } from '../../host-api/orchestrationClient';
import type { ChatPipelineV1, PipelineLibraryCommandV1, PipelineLibraryResultV1 } from '../../host-api/pipelineLibraryClient';
import type { readWorkspaceHistory } from '../../host-api/workspaceHistory';
import { ChatPipelinesStore, type ChatCreator } from './chatPipelines.svelte';

const WORKSPACE = 'ws';
const pipeline = (inputs: PipelineDefinition['inputs']): PipelineDefinition => ({
  id: 'pipe',
  name: 'Review loop',
  inputs,
  steps: [
    { id: 'dev', name: 'Developer', assignedMemberId: 'm-dev', instructions: '', dependencyStepIds: [] },
    { id: 'review', name: 'Reviewer', assignedMemberId: 'm-review', instructions: '', dependencyStepIds: ['dev'] },
  ],
});

function setup(inputs: PipelineDefinition['inputs'] = [{ name: 'task', label: 'Task', kind: 'long-text', required: true }]) {
  const started: StartRunRequestV7[] = [];
  const runs = new Map<string, OrchestrationRunV6>();
  const client = {
    orchestration_get_launch_command_v6: async () => ({ revision: 1, value: { id: 'cmd', name: 'Review loop', teamId: 'team', pipelineId: 'pipe' } }),
    orchestration_get_pipeline_v6: async () => ({ revision: 1, value: pipeline(inputs) }),
    orchestration_get_team_v6: async () => ({
      revision: 1,
      value: { id: 'team', name: 'T', members: [{ id: 'm-dev', profileId: 'p-dev' }, { id: 'm-review', profileId: 'p-review' }], sendEdges: [], observeEdges: [], orchestratorMemberId: 'm-dev' },
    }),
    orchestration_get_profile_v6: async ({ id }: { id: string }) => ({
      revision: 1,
      value: { id, name: id, harness: id === 'p-review' ? 'claude-code' : 'codex', model: id === 'p-review' ? 'opus' : 'gpt', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] },
    }),
    orchestration_start_run_v6: async (request: StartRunRequestV7) => {
      started.push(request);
      const run = {
        schemaVersion: 6,
        id: request.runId,
        revision: 0,
        status: 'running',
        inputs: request.inputs,
        definition: { profiles: [], team: {}, pipeline: pipeline(inputs), launchCommand: { id: 'cmd', name: 'Review loop', teamId: 'team', pipelineId: 'pipe' } },
        tasks: [],
        messages: [],
        agentRequests: [],
      } as unknown as OrchestrationRunV6;
      runs.set(run.id, run);
      return run;
    },
    orchestration_get_run_v6: async ({ runId }: { runId: string }) => runs.get(runId) ?? null,
    listen: async () => () => undefined,
  } as unknown as OrchestrationClient;

  const chats = new Map<string, ChatPipelineV1>();
  const commands: PipelineLibraryCommandV1[] = [];
  const library = {
    async request(command: PipelineLibraryCommandV1): Promise<PipelineLibraryResultV1> {
      commands.push(command);
      switch (command.type) {
        case 'setChatPipeline': {
          const chat = { ...(chats.get(command.sessionId) ?? { sessionId: command.sessionId, workspaceId: command.workspaceId, runs: [] }) };
          if (command.launchCommandId) chat.launchCommandId = command.launchCommandId;
          else delete chat.launchCommandId;
          chats.set(command.sessionId, chat);
          return { protocol: 1, type: 'chat', chat };
        }
        case 'recordChatRun': {
          const chat = chats.get(command.sessionId) ?? { sessionId: command.sessionId, workspaceId: command.workspaceId, runs: [] };
          const next = { ...chat, runs: [...chat.runs, { runId: command.runId, startedAt: '2026-09-28T10:00:00.000Z' }] };
          chats.set(command.sessionId, next);
          return { protocol: 1, type: 'chat', chat: next };
        }
        case 'consumeChatRuns': {
          const chat = chats.get(command.sessionId)!;
          const next = { ...chat, runs: chat.runs.map((entry) => (command.runIds.includes(entry.runId) ? { ...entry, consumed: true as const } : entry)) };
          chats.set(command.sessionId, next);
          return { protocol: 1, type: 'chat', chat: next };
        }
        case 'chat':
          return { protocol: 1, type: 'chat', chat: chats.get(command.sessionId) ?? null };
        default:
          return { protocol: 1, type: 'library', templates: [] };
      }
    },
  };
  type Blocks = Awaited<ReturnType<typeof readWorkspaceHistory>>;
  const history = vi.fn(async (): Promise<Blocks> => [
    { id: 'u', kind: 'user', text: 'task' },
    { id: 'a', kind: 'assistant', text: 'All fixed.' },
  ] as unknown as Blocks);
  const created: Parameters<ChatCreator['createChat']>[0][] = [];
  const creator: ChatCreator = {
    async createChat(request) {
      created.push(request);
      return { sessionId: 'chat-1' };
    },
  };
  const store = new ChatPipelinesStore(client, library, history);
  return { store, started, runs, commands, creator, created, history };
}

const request = {
  workspaceId: WORKSPACE,
  commandId: 'cmd',
  text: 'Fix the login bug',
  values: {},
  permissionMode: 'workspace-write' as const,
  fallbackHarness: 'codex' as const,
  available: ['codex', 'claude-code'] as const,
  safeMode: false,
  title: 'Fix the login bug',
};

describe('ChatPipelinesStore', () => {
  it('creates the chat on the answering agent and starts a chat-triggered run', async () => {
    const { store, started, created, creator, commands } = setup();
    const sessionId = await store.startChat(creator, { ...request, available: [...request.available] });
    expect(sessionId).toBe('chat-1');
    expect(created[0]).toMatchObject({ harness: 'claude-code', model: { id: 'opus' }, permissionMode: 'workspace-write', text: '' });
    expect(started[0]).toMatchObject({ launchCommandId: 'cmd', inputs: { task: 'Fix the login bug' }, trigger: { kind: 'chat', sessionId: 'chat-1' } });
    expect(commands.map((command) => command.type)).toEqual(['recordChatRun']);
    expect(store.chats['chat-1']?.launchCommandId).toBeUndefined();
    expect(store.chats['chat-1']?.runs).toHaveLength(1);
  });

  it('falls back to an available harness', async () => {
    const { store, created, creator } = setup();
    await store.startChat(creator, { ...request, available: ['codex'] });
    expect(created[0]).toMatchObject({ harness: 'codex' });
    expect(created[0]?.model).toBeUndefined();
  });

  it('refuses a pipeline without a chat input before creating a chat', async () => {
    const { store, created, creator, started } = setup([
      { name: 'a', label: 'A', kind: 'text' },
      { name: 'b', label: 'B', kind: 'text' },
    ]);
    await expect(store.startChat(creator, { ...request, available: [...request.available] })).rejects.toThrow('does not accept chat messages');
    expect(created).toEqual([]);
    expect(started).toEqual([]);
  });

  it('hands a finished result on once, labelled, then marks it consumed', async () => {
    const { store, creator, runs } = setup();
    await store.startChat(creator, { ...request, available: [...request.available] });
    const runId = store.chats['chat-1']!.runs[0]!.runId;
    expect(store.pendingResults('chat-1')).toEqual([]);
    const finished = {
      ...runs.get(runId)!,
      revision: 3,
      status: 'succeeded',
      tasks: [
        { stepId: 'dev', status: 'succeeded', revision: 1 },
        { stepId: 'review', status: 'succeeded', revision: 1, execution: { id: 'run-session' }, resultReference: { sessionId: 'run-session', blockId: 'a' } },
      ],
    } as OrchestrationRunV6;
    runs.set(runId, finished);
    await store.refreshRun(WORKSPACE, runId);
    const handed = await store.withResults('chat-1', 'Now add tests');
    expect(handed.runIds).toEqual([runId]);
    expect(handed.text).toContain('pipeline "Review loop"');
    expect(handed.text).toContain('Fix the login bug');
    expect(handed.text).toContain('All fixed.');
    expect(handed.text.endsWith('Now add tests')).toBe(true);
    await store.consume('chat-1', handed.runIds);
    expect(store.pendingResults('chat-1')).toEqual([]);
    expect((await store.withResults('chat-1', 'Next')).text).toBe('Next');
  });
});
