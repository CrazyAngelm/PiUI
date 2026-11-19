import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationClient, OrchestrationRunV6, PipelineDefinition } from '../../host-api/orchestrationClient';
import type { ChatPipelineV1, PipelineLibraryCommandV1, PipelineLibraryResultV1 } from '../../host-api/pipelineLibraryClient';
import type { readWorkspaceHistory } from '../../host-api/workspaceHistory';
import { ChatPipelinesStore, type ChatCreator } from './chatPipelines.svelte';

const WORKSPACE = 'ws';
const pipeline: PipelineDefinition = {
  id: 'pipe',
  name: 'Review loop',
  inputs: [{ name: 'task', label: 'Task', kind: 'long-text', required: true }],
  steps: [
    { id: 'dev', name: 'Developer', assignedMemberId: 'm-dev', instructions: '', dependencyStepIds: [] },
    { id: 'review', name: 'Reviewer', assignedMemberId: 'm-review', instructions: '', dependencyStepIds: ['dev'] },
  ],
};
const members = [
  { id: 'm-dev', profileId: 'p-dev' },
  { id: 'm-review', profileId: 'p-review' },
];
const profiles = [
  { id: 'p-dev', name: 'Dev', harness: 'codex', model: 'gpt' },
  { id: 'p-review', name: 'Review', harness: 'claude-code', model: 'opus' },
];

type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };

/** A run the test may reshape before handing it over (the real one is read-only). */
function finished(status: OrchestrationRunV6['status']): Writable<OrchestrationRunV6> {
  return {
    schemaVersion: 6,
    id: 'run-9',
    revision: 5,
    status,
    inputs: { task: 'Fix the login bug' },
    definition: structuredClone({ profiles, team: { id: 'team', name: 'T', members }, pipeline, launchCommand: { id: 'cmd', name: 'Review loop', teamId: 'team', pipelineId: 'pipe' } }),
    tasks: [{ stepId: 'review', status: 'succeeded', revision: 1, output: { text: 'All fixed.' } }],
    messages: [],
    agentRequests: [],
  } as unknown as Writable<OrchestrationRunV6>;
}

function setup(failRecording = false) {
  const client = { listen: async () => () => undefined, orchestration_get_run_v6: async () => null } as unknown as OrchestrationClient;
  const chats = new Map<string, ChatPipelineV1>();
  const commands: PipelineLibraryCommandV1[] = [];
  const library = {
    async request(command: PipelineLibraryCommandV1): Promise<PipelineLibraryResultV1> {
      commands.push(command);
      if (failRecording) throw new Error('disk full');
      switch (command.type) {
        case 'recordChatRun': {
          const chat = chats.get(command.sessionId) ?? { sessionId: command.sessionId, workspaceId: command.workspaceId, runs: [] };
          const next = { ...chat, runs: [...chat.runs, { runId: command.runId, startedAt: '2026-11-19T10:00:00.000Z' }] };
          chats.set(command.sessionId, next);
          return { protocol: 1, type: 'chat', chat: next };
        }
        case 'consumeChatRuns': {
          const chat = chats.get(command.sessionId)!;
          const next = { ...chat, runs: chat.runs.map((entry) => (command.runIds.includes(entry.runId) ? { ...entry, consumed: true as const } : entry)) };
          chats.set(command.sessionId, next);
          return { protocol: 1, type: 'chat', chat: next };
        }
        default:
          return { protocol: 1, type: 'library', templates: [] };
      }
    },
  };
  type Blocks = Awaited<ReturnType<typeof readWorkspaceHistory>>;
  const history = vi.fn(async (): Promise<Blocks> => [{ id: 'a', kind: 'assistant', text: 'All fixed.' }] as unknown as Blocks);
  const calls: { request: Parameters<ChatCreator['createChat']>[0]; options: Parameters<ChatCreator['createChat']>[1] }[] = [];
  const creator: ChatCreator = {
    async createChat(request, options) {
      calls.push({ request, options });
      return { sessionId: 'chat-2' };
    },
  };
  return { store: new ChatPipelinesStore(client, library, history), commands, calls, creator };
}

const continuing = (run: OrchestrationRunV6, over: Partial<Parameters<ChatPipelinesStore['continueRun']>[1]> = {}) => ({
  workspaceId: WORKSPACE,
  run,
  permissionMode: 'native' as const,
  fallbackHarness: 'codex' as const,
  available: ['codex', 'claude-code'] as const,
  title: 'Review loop',
  open: async () => undefined,
  ...over,
});

describe('continuing a run in a chat (ADR-078)', () => {
  it('opens a chat with the agent that answered and files the run under it', async () => {
    const { store, commands, calls, creator } = setup();
    const order: string[] = [];
    const sessionId = await store.continueRun(creator, {
      ...continuing(finished('succeeded')),
      onFiled: (id) => order.push(`filed:${id}:${store.chats[id]?.runs.length ?? 0}`),
      open: async (id) => void order.push(`open:${id}`),
    });
    expect(sessionId).toBe('chat-2');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toMatchObject({ workspaceId: WORKSPACE, harness: 'claude-code', model: { id: 'opus' }, permissionMode: 'native', text: '' });
    // The chat is created without opening, so nobody can write to it before the run is filed.
    expect(calls[0]?.options).toEqual({ open: false, title: 'Review loop' });
    // Nothing is started: the only host call is the one that files the run.
    expect(commands).toEqual([{ type: 'recordChatRun', sessionId: 'chat-2', workspaceId: WORKSPACE, runId: 'run-9' }]);
    expect(store.chats['chat-2']?.runs.map((entry) => entry.runId)).toEqual(['run-9']);
    expect(store.runs['run-9']?.status).toBe('succeeded');
    expect(order).toEqual(['filed:chat-2:1', 'open:chat-2']);
  });

  it('keeps the permission it was given, never the pipeline step’s', async () => {
    const { store, calls, creator } = setup();
    await store.continueRun(creator, continuing(finished('succeeded'), { permissionMode: 'read-only' }));
    expect(calls[0]?.request.permissionMode).toBe('read-only');
  });

  it('gives an agent that cannot honour the remembered permission its own default', async () => {
    const { store, calls, creator } = setup();
    // Claude Code takes every mode; Prime Agent only its native one.
    const prime = finished('succeeded');
    prime.definition.profiles.find((item) => item.id === 'p-review')!.harness = 'prime-agent';
    await store.continueRun(creator, continuing(prime, { permissionMode: 'workspace-write', available: ['codex', 'prime-agent'] }));
    expect(calls[0]?.request).toMatchObject({ harness: 'prime-agent', permissionMode: 'native' });
    await store.continueRun(creator, continuing(finished('succeeded'), { permissionMode: 'workspace-write' }));
    expect(calls[1]?.request).toMatchObject({ harness: 'claude-code', permissionMode: 'workspace-write' });
  });

  it('continues with the agent that supplied the result when a router skipped the last one', async () => {
    const { store, calls, creator } = setup();
    // Both final steps are agents; only the first one ran and answered.
    const routed = finished('succeeded');
    routed.definition.pipeline.steps = [
      { id: 'dev', name: 'Developer', assignedMemberId: 'm-dev', instructions: '', dependencyStepIds: [] },
      { id: 'review', name: 'Reviewer', assignedMemberId: 'm-review', instructions: '', dependencyStepIds: [] },
    ];
    routed.tasks = [
      { stepId: 'dev', status: 'succeeded', revision: 1, output: { text: 'Done by dev.' } },
      { stepId: 'review', status: 'skipped', revision: 1 },
    ] as never;
    await store.continueRun(creator, continuing(routed));
    expect(calls[0]?.request).toMatchObject({ harness: 'codex', model: { id: 'gpt' } });
  });

  it('does not carry the model of a run that failed or was stopped', async () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const { store, calls, creator } = setup();
      await store.continueRun(creator, continuing(finished(status)));
      expect(calls[0]?.request.harness).toBe('claude-code');
      expect(calls[0]?.request.model).toBeUndefined();
    }
  });

  it('falls back to an available harness when the answering agent is not installed', async () => {
    const { store, calls, creator } = setup();
    await store.continueRun(creator, continuing(finished('succeeded'), { available: ['codex'] }));
    expect(calls[0]?.request.harness).toBe('codex');
    expect(calls[0]?.request.model).toBeUndefined();
  });

  it('waits for a run that is still working', async () => {
    const { store, calls, creator } = setup();
    await expect(store.continueRun(creator, continuing(finished('running')))).rejects.toThrow('Wait for the run to finish');
    expect(calls).toEqual([]);
  });

  it('opens the chat anyway when the run could not be filed, but never links the run to it', async () => {
    const { store, creator } = setup(true);
    const events: string[] = [];
    await expect(
      store.continueRun(creator, {
        ...continuing(finished('succeeded')),
        onFiled: (id) => events.push(`filed:${id}`),
        open: async (id) => void events.push(`open:${id}`),
      }),
    ).rejects.toThrow('could not remember this run');
    expect(events).toEqual(['open:chat-2']);
  });

  it('hands the run’s result to the chat’s agent inside the first message, once', async () => {
    const { store, creator } = setup();
    await store.continueRun(creator, continuing(finished('succeeded')));
    const first = await store.withResults('chat-2', 'Make it shorter');
    expect(first.runIds).toEqual(['run-9']);
    expect(first.text).toContain('All fixed.');
    expect(first.text.endsWith('Make it shorter')).toBe(true);
    await store.consume('chat-2', first.runIds);
    expect((await store.withResults('chat-2', 'And again')).text).toBe('And again');
  });
});
