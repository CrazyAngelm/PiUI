import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FusionPairV1, FusionStateV1 } from '../host-api/fusionClient';
import { LAB_FUSION_BRIEF_DELAY_MS, LAB_FUSION_QUEUE_MS, LAB_FUSION_ROUND_MS } from '../host-api/lab/fusionFake';
import { DEMO_PROJECTS } from '../host-api/lab/scenarios/demoChats';
import type { WorkspaceStore as Store } from './workspaceStore.svelte';

// Fresh module copies per test: each test gets its own lab host (its event bus and
// timers), its own membership cache and its own fake clock.
let fusionHost: typeof import('../host-api/fusionClient').fusionHost;
let workspaceHost: typeof import('../host-api/workspaceClient').workspaceHost;
let fusionMembership: typeof import('./fusion/fusionMembership.svelte').fusionMembership;
let WorkspaceStore: typeof import('./workspaceStore.svelte').WorkspaceStore;
type WorkspaceStore = Store;

const WS = DEMO_PROJECTS.piui;
const PAIR: FusionPairV1 = {
  lead: { harness: 'codex', permissionMode: 'native' },
  sidekick: { harness: 'codex', permissionMode: 'native' },
  options: { briefPolicy: 'prescriptive', pushback: false, autoDeliver: true, leadNativeSubagents: false },
};

async function stateOf(leadSessionId: string): Promise<FusionStateV1> {
  const result = await fusionHost.request({ type: 'state', leadSessionId });
  if (result.type !== 'state') throw new Error('expected a state');
  return result.state;
}

/** A Fusion chat in the lab whose first round is running; the store knows both chats. */
async function runningPair(store: WorkspaceStore): Promise<{ lead: string; sidekick: string }> {
  const created = await fusionHost.request({ type: 'createChat', workspaceId: WS, pair: PAIR });
  if (created.type !== 'created') throw new Error('expected a created chat');
  const lead = created.leadSessionId;
  fusionMembership.remember(lead);
  await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS);
  const sidekick = (await stateOf(lead)).sessions[0]?.sessionId ?? '';
  await store.loadCatalog(WS);
  await fusionMembership.load(sidekick);
  return { lead, sidekick };
}

describe('WorkspaceStore and Fusion chats over the transport', () => {
  let store: WorkspaceStore;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    fusionHost = (await import('../host-api/fusionClient')).fusionHost;
    workspaceHost = (await import('../host-api/workspaceClient')).workspaceHost;
    fusionMembership = (await import('./fusion/fusionMembership.svelte')).fusionMembership;
    WorkspaceStore = (await import('./workspaceStore.svelte')).WorkspaceStore;
    store = new WorkspaceStore();
    await store.loadCatalog();
  });
  afterEach(() => {
    store.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('routes the primary Stop of a lead through stopPair with its own id', async () => {
    const { lead } = await runningPair(store);
    expect((await stateOf(lead)).sidekick).toBe('working');
    const request = vi.spyOn(fusionHost, 'request');

    expect(await store.interrupt(lead)).toBe(true);
    expect(request).toHaveBeenCalledWith({ type: 'stopPair', leadSessionId: lead });
    const stopped = await stateOf(lead);
    expect(stopped.sidekick).toBe('idle');
    expect(stopped.briefs[0]?.rounds[0]).toMatchObject({ outcome: 'interrupted', delivery: { state: 'withdrawn' } });
    // The late scripted report never reaches the lead.
    await vi.advanceTimersByTimeAsync(LAB_FUSION_ROUND_MS * 2);
    expect(await stateOf(lead)).toEqual(stopped);
  });

  it('keeps routing a sidekick Stop through stopSidekick and leaves ordinary chats alone', async () => {
    const { lead, sidekick } = await runningPair(store);
    const request = vi.spyOn(fusionHost, 'request');
    expect(await store.interrupt(sidekick)).toBe(true);
    expect(request).toHaveBeenCalledWith({ type: 'stopSidekick', leadSessionId: lead });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stopPair' }));

    request.mockClear();
    const ordinary = store.catalog.sessions.find((session) => session.workspaceId === WS && !session.runId && session.id !== lead && session.id !== sidekick)?.id ?? '';
    expect(ordinary).not.toBe('');
    await store.interrupt(ordinary);
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stopPair' }));
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stopSidekick' }));
  });

  it('shows the host refusal when a lead Stop fails', async () => {
    const { lead } = await runningPair(store);
    vi.spyOn(fusionHost, 'request').mockRejectedValueOnce({ code: 'CONFLICT', message: 'raw' }).mockResolvedValue({ type: 'membership', role: null });
    expect(await store.interrupt(lead)).toBe(false);
    expect(store.sessionError).toBe('The state changed meanwhile. Try again.');
  });

  it('refuses to delete a lead during an open round, then forgets the pair and its cached membership', async () => {
    const { lead, sidekick } = await runningPair(store);
    await expect(store.deleteChat(lead)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.catalog.sessions.some((session) => session.id === lead)).toBe(true);
    expect(fusionMembership.peek(lead)).toBeDefined();

    expect(await store.interrupt(lead)).toBe(true);
    await store.deleteChat(lead);
    expect(store.catalog.sessions.some((session) => session.id === lead)).toBe(false);
    // The deleted lead and the chats that named it are asked about again.
    expect(fusionMembership.peek(lead)).toBeUndefined();
    expect(fusionMembership.peek(sidekick)).toBeUndefined();
    await fusionMembership.load(sidekick);
    expect(fusionMembership.peek(sidekick)).toEqual({ role: null });
  });

  it('closes the sidekick in use through the broker and shows a refusal', async () => {
    const { lead, sidekick } = await runningPair(store);
    expect(fusionMembership.isCurrentSidekick(sidekick)).toBe(true);

    vi.spyOn(workspaceHost, 'request').mockRejectedValueOnce({ code: 'NOT_SUPPORTED', message: 'raw' });
    await store.close(sidekick);
    expect(store.sessionError).toBe('This action is not available here.');
    expect((await stateOf(lead)).sidekick).toBe('working');
    vi.restoreAllMocks();

    await store.close(sidekick);
    const closed = await stateOf(lead);
    expect(closed.sidekick).toBe('idle');
    expect(closed.briefs[0]?.rounds[0]).toMatchObject({ outcome: 'interrupted', delivery: { state: 'withdrawn' } });
  });

  it('deletes a retired sidekick chat but not the one in use', async () => {
    const { lead, sidekick } = await runningPair(store);
    await expect(store.deleteChat(sidekick)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(store.catalog.sessions.some((session) => session.id === sidekick)).toBe(true);

    await store.interrupt(sidekick);
    await fusionHost.request({ type: 'resetSidekick', leadSessionId: lead });
    // The change event reaches the cache on a later lab tick.
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(fusionMembership.isCurrentSidekick(sidekick)).toBe(false));
    expect(fusionMembership.isSidekick(sidekick)).toBe(true);

    await store.deleteChat(sidekick);
    expect(store.catalog.sessions.some((session) => session.id === sidekick)).toBe(false);
    expect((await stateOf(lead)).sessions[0]).toMatchObject({ sessionId: sidekick, retired: true });
  });
});
