import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTaskStopResultV1, SessionTaskV1 } from '../../../../../contracts/workspace-session-tasks-v1';
import { WORKSPACE_EVENT_CHANNEL, type WorkspaceEvent } from './labContracts';
import type { LabHost } from './labHost';
import { labHost, record, rejection, snapshotOf } from './labTestKit';
import { demoSessionId } from './scenarios/demoChats';

const CLAUDE_CHAT = demoSessionId('keymap');
const DEV_SERVER = 'pnpm --filter @piui/desktop dev';

const stop = (host: LabHost, sessionId: string, taskId: string, extra: Record<string, unknown> = {}) =>
  host.invoke<SessionTaskStopResultV1>('workspace_task_stop_v1', { request: { sessionId, taskId, ...extra } });

async function tasksOf(host: LabHost, sessionId = CLAUDE_CHAT): Promise<SessionTaskV1[]> {
  return (await snapshotOf(host, sessionId)).tasks ?? [];
}

async function devServer(host: LabHost): Promise<SessionTaskV1> {
  const task = (await tasksOf(host)).find((candidate) => candidate.title === DEV_SERVER);
  if (task === undefined) throw new Error('The demo chat has no dev server task.');
  return task;
}

describe('UI Lab session tasks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds background agents and commands in the live Claude Code demo chat only', async () => {
    const host = labHost('demo');
    const tasks = await tasksOf(host);
    expect(tasks.map((task) => [task.kind, task.status, task.title])).toEqual([
      ['agent', 'running', 'Review the transport diff'],
      ['agent', 'completed', 'Map every direct Tauri import'],
      ['command', 'running', DEV_SERVER],
      ['command', 'failed', 'cargo test -p piui-runtime'],
    ]);
    expect(tasks.every((task) => task.background && Number.isFinite(Date.parse(task.startedAt)))).toBe(true);
    expect(tasks[0]).toMatchObject({ detail: 'general-purpose', toolUses: 7, totalTokens: 18_400 });
    // Other live chats and closed ones carry none, and the field is omitted rather than empty.
    expect(await snapshotOf(host, demoSessionId('cache-sizing'))).not.toHaveProperty('tasks');
    expect(await snapshotOf(host, demoSessionId('lisbon'))).not.toHaveProperty('tasks');
  });

  it('stops a running task, drops its activity and publishes the whole new list', async () => {
    const host = labHost('demo');
    const events = await record<WorkspaceEvent>(host, WORKSPACE_EVENT_CHANNEL);
    const before = await snapshotOf(host, CLAUDE_CHAT);
    const target = await devServer(host);
    expect(await stop(host, CLAUDE_CHAT, target.id)).toEqual({ protocol: 1, sessionId: CLAUDE_CHAT });
    // Events reach listeners on a later macrotask, like Tauri's.
    await vi.advanceTimersByTimeAsync(10);

    const published = events.items.filter((item) => item.sessionId === CLAUDE_CHAT && item.event.type === 'tasks');
    expect(published).toHaveLength(1);
    const [event] = published;
    expect(event?.revision).toBe(before.revision + 1);
    if (event?.event.type !== 'tasks') throw new Error('Expected a tasks event.');
    const stopped = event.event.tasks.find((task) => task.id === target.id);
    expect(stopped).toMatchObject({ status: 'stopped', title: DEV_SERVER });
    expect(stopped).not.toHaveProperty('activity');
    expect(Date.parse(stopped?.endedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(stopped?.startedAt ?? ''));
    expect(event.event.tasks).toHaveLength(before.tasks?.length ?? -1);

    const after = await snapshotOf(host, CLAUDE_CHAT);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.tasks).toEqual(event.event.tasks);
    // The other running task is untouched.
    expect(after.tasks?.filter((task) => task.status === 'running').map((task) => task.title)).toEqual(['Review the transport diff']);
    events.stop();
  });

  it('refuses a second stop, an unknown task and a finished one', async () => {
    const host = labHost('demo');
    const target = await devServer(host);
    await stop(host, CLAUDE_CHAT, target.id);
    expect(await rejection(stop(host, CLAUDE_CHAT, target.id))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(stop(host, CLAUDE_CHAT, 'no-such-task'))).toMatchObject({ code: 'NOT_FOUND' });
    const finished = (await tasksOf(host)).find((task) => task.status === 'completed');
    expect(await rejection(stop(host, CLAUDE_CHAT, finished?.id ?? ''))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(stop(host, CLAUDE_CHAT, ''))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects an unknown field like the host does', async () => {
    const host = labHost('demo');
    const target = await devServer(host);
    expect(await rejection(stop(host, CLAUDE_CHAT, target.id, { extra: 1 }))).toContain('unknown field `extra`');
    expect(await rejection(host.invoke('workspace_task_stop_v1', { request: { sessionId: CLAUDE_CHAT } }))).toContain('missing');
    // Nothing was stopped by the refused requests.
    expect((await tasksOf(host)).filter((task) => task.status === 'running')).toHaveLength(2);
  });

  it('needs an open session and refuses in safe mode', async () => {
    const host = labHost('demo');
    expect(await rejection(stop(host, demoSessionId('lisbon'), 'lab-task-dev'))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(stop(host, demoSessionId('cache-sizing'), 'lab-task-dev'))).toMatchObject({ code: 'NOT_FOUND' });
    const safe = labHost('safe');
    expect(await rejection(stop(safe, CLAUDE_CHAT, 'lab-task-dev'))).toMatchObject({ code: 'SAFE_MODE' });
  });
});
