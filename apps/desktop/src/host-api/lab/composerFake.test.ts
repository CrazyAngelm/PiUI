import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerSnapshot, WorkspaceResult } from './labContracts';
import type { LabHost } from './labHost';
import { labUuid } from './labRandom';
import { labHost, record, rejection, settle, snapshotOf, untilStreaming } from './labTestKit';

const CHANNEL = 'piui://composer-v19';

function sessionId(host: LabHost, title: string): string {
  const session = [...host.state.sessions.values()].find((candidate) => candidate.title === title);
  if (session === undefined) throw new Error(`No session ${title}`);
  return session.id;
}

function composer(host: LabHost, command: Record<string, unknown>): Promise<ComposerSnapshot> {
  return host.invoke<ComposerSnapshot>('workspace_composer_v19', { command });
}

async function openChat(host: LabHost, title: string): Promise<string> {
  const id = sessionId(host, title);
  const result = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'openSession', sessionId: id } });
  expect(result.type).toBe('session');
  return id;
}

describe('UI Lab composer outbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues a message, notifies the composer channel and delivers it as a turn', async () => {
    const host = labHost();
    const notices = await record<string>(host, CHANNEL);
    const id = sessionId(host, 'Route host calls through one transport');
    const initial = await composer(host, { type: 'snapshot', sessionId: id });
    expect(initial).toEqual({
      protocol: 19, sessionId: id, capabilities: { steer: true, compact: true, images: true }, queue: { revision: 0, paused: false, items: [] },
    });
    const requestId = labUuid('test:request:1');
    const queued = await composer(host, { type: 'send', sessionId: id, requestId, text: 'Summarize the diff', mode: 'prompt' });
    expect(queued.queue.items).toEqual([{ id: requestId, text: 'Summarize the diff', status: 'queued' }]);
    expect(queued.queue.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(5);
    const delivered = await composer(host, { type: 'snapshot', sessionId: id });
    expect(delivered.queue.items).toEqual([]);
    expect(delivered.queue.revision).toBe(3);
    expect(notices.items.every((notice) => notice === id)).toBe(true);
    expect(notices.items.length).toBeGreaterThanOrEqual(3);
    const running = await snapshotOf(host, id);
    expect(running.session.status).toBe('running');
    expect(running.blocks.some((block) => block.kind === 'user' && block.text === 'Summarize the diff')).toBe(true);
  });

  it('holds follow-ups while a turn runs and drains them one by one afterwards', async () => {
    const host = labHost();
    const id = sessionId(host, 'Route host calls through one transport');
    await composer(host, { type: 'send', sessionId: id, requestId: labUuid('test:first'), text: 'First question', mode: 'prompt' });
    await vi.advanceTimersByTimeAsync(0);
    const second = await composer(host, {
      type: 'send', sessionId: id, requestId: labUuid('test:second'), text: 'Second question', mode: 'follow-up',
    });
    expect(second.queue.items).toMatchObject([{ text: 'Second question', status: 'queued' }]);
    const edited = await composer(host, { type: 'edit', sessionId: id, requestId: labUuid('test:second'), text: 'Second question, edited' });
    expect(edited.queue.items[0]?.text).toBe('Second question, edited');
    await settle(host, id);
    const final = await settle(host, id);
    const users = final.blocks.filter((block) => block.kind === 'user').map((block) => block.text);
    expect(users.slice(-2)).toEqual(['First question', 'Second question, edited']);
    expect((await composer(host, { type: 'snapshot', sessionId: id })).queue.items).toEqual([]);
  });

  it('steers an active turn and refuses steer without one', async () => {
    const host = labHost();
    const id = sessionId(host, 'Route host calls through one transport');
    expect(await rejection(composer(host, { type: 'send', sessionId: id, requestId: labUuid('test:early'), text: 'Early steer', mode: 'steer' })))
      .toMatchObject({ code: 'NO_ACTIVE_TURN' });
    await composer(host, { type: 'send', sessionId: id, requestId: labUuid('test:turn'), text: 'Start a turn', mode: 'prompt' });
    await vi.advanceTimersByTimeAsync(0);
    await untilStreaming(host, id);
    const steered = await composer(host, { type: 'send', sessionId: id, requestId: labUuid('test:steer'), text: 'Focus on tests', mode: 'steer' });
    expect(steered.queue.items).toEqual([]);
    expect((await snapshotOf(host, id)).blocks.some((block) => block.kind === 'user' && block.text === 'Focus on tests')).toBe(true);
  });

  it('pauses on interrupt, blocks resume while delivery is uncertain and supports removal', async () => {
    const host = labHost();
    const id = await openChat(host, 'Investigate crash on startup');
    const seeded = await composer(host, { type: 'snapshot', sessionId: id });
    expect(seeded.queue).toMatchObject({ paused: true, items: [{ status: 'uncertain' }] });
    expect(await rejection(composer(host, { type: 'resume', sessionId: id }))).toMatchObject({ code: 'DELIVERY_UNCERTAIN' });
    const uncertain = seeded.queue.items[0]?.id;
    const removed = await composer(host, { type: 'remove', sessionId: id, requestId: uncertain });
    expect(removed.queue.items).toEqual([]);
    expect(await rejection(composer(host, { type: 'remove', sessionId: id, requestId: uncertain }))).toMatchObject({ code: 'CONFLICT' });
    const resumed = await composer(host, { type: 'resume', sessionId: id });
    expect(resumed.queue.paused).toBe(false);

    await composer(host, { type: 'send', sessionId: id, requestId: labUuid('test:busy'), text: 'Long task', mode: 'prompt' });
    await vi.advanceTimersByTimeAsync(0);
    await composer(host, { type: 'send', sessionId: id, requestId: labUuid('test:later'), text: 'Later', mode: 'follow-up' });
    await host.invoke('workspace_command_v15', { command: { type: 'interrupt', sessionId: id } });
    const paused = await composer(host, { type: 'snapshot', sessionId: id });
    expect(paused.queue.paused).toBe(true);
    expect(paused.queue.items).toMatchObject([{ text: 'Later', status: 'queued' }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await snapshotOf(host, id)).session.status).toBe('idle');
    await composer(host, { type: 'resume', sessionId: id });
    await vi.advanceTimersByTimeAsync(0);
    expect((await snapshotOf(host, id)).blocks.some((block) => block.kind === 'user' && block.text === 'Later')).toBe(true);
  });

  it('compacts idle sessions and refuses compaction when queued, running or unsupported', async () => {
    const host = labHost();
    const id = sessionId(host, 'Route host calls through one transport');
    await composer(host, { type: 'compact', sessionId: id });
    expect((await snapshotOf(host, id)).session.status).toBe('running');
    expect(await rejection(composer(host, { type: 'compact', sessionId: id }))).toMatchObject({ code: 'TURN_ACTIVE' });
    await vi.advanceTimersByTimeAsync(2_000);
    const compacted = await snapshotOf(host, id);
    expect(compacted.blocks.at(-1)).toMatchObject({ kind: 'compaction', status: 'complete' });

    const scheduler = sessionId(host, 'Fix flaky scheduler test');
    expect(await rejection(composer(host, { type: 'compact', sessionId: scheduler }))).toMatchObject({ code: 'QUEUE_PENDING' });
    const hermes = await host.invoke<WorkspaceResult>('workspace_command_v15', {
      command: { type: 'createSession', workspaceId: host.state.projects[1]?.id, harness: 'hermes', permissionMode: 'native' },
    });
    if (hermes.type !== 'session') throw new Error('Expected a Hermes session.');
    const hermesId = hermes.snapshot.session.id;
    expect((await composer(host, { type: 'snapshot', sessionId: hermesId })).capabilities).toEqual({ steer: false, compact: false, images: true });
    expect(await rejection(composer(host, { type: 'compact', sessionId: hermesId }))).toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('keeps managed run sessions and closed sessions out of the outbox', async () => {
    const host = labHost();
    const run = [...host.state.sessions.values()].find((session) => session.runId !== undefined);
    expect(await rejection(composer(host, { type: 'snapshot', sessionId: run?.id }))).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await rejection(composer(host, { type: 'snapshot', sessionId: sessionId(host, 'Plan a weekend in Lisbon') })))
      .toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(composer(host, { type: 'snapshot', sessionId: 'nope' }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
