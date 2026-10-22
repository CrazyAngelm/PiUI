import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FusionChangedEventV1, FusionCommandV1, FusionResultV1, FusionStateV1 } from '../../host-api/fusionClient';

const pair = {
  lead: { harness: 'codex', permissionMode: 'native' },
  sidekick: { harness: 'codex', permissionMode: 'native' },
  options: { briefPolicy: 'prescriptive', pushback: false, autoDeliver: true, leadNativeSubagents: false },
} as const;

function stateOf(leadSessionId: string, sessions: { id: string; retired: boolean }[], revision = 1): FusionStateV1 {
  return {
    protocol: 1,
    leadSessionId,
    workspaceId: 'w',
    pair: structuredClone(pair),
    sidekick: 'idle',
    sessions: sessions.map((session) => ({ sessionId: session.id, harness: 'codex', retired: session.retired, createdAt: '2026-10-22T00:00:00Z' })),
    briefs: [],
    stats: { briefs: 0, accepted: 0, rejected: 0, takenOver: 0, rounds: 0 },
    revision,
  } as FusionStateV1;
}

type Membership = typeof import('./fusionMembership.svelte').fusionMembership;
type Client = typeof import('../../host-api/fusionClient');

describe('Fusion membership cache', () => {
  let membership: Membership;
  let client: Client;
  const members = new Map<string, FusionResultV1>();
  const states = new Map<string, FusionStateV1>();
  let calls: FusionCommandV1[] = [];
  let listeners: ((event: FusionChangedEventV1) => void)[] = [];

  const asked = (type: 'find' | 'state', key: string): number =>
    calls.filter((call) => call.type === type && (call.type === 'find' ? call.sessionId === key : 'leadSessionId' in call && call.leadSessionId === key)).length;

  beforeEach(async () => {
    // The cache is a module singleton with a one-time event listener: a fresh copy per test.
    vi.resetModules();
    client = await import('../../host-api/fusionClient');
    membership = (await import('./fusionMembership.svelte')).fusionMembership;
    members.clear();
    states.clear();
    calls = [];
    listeners = [];
    vi.spyOn(client.fusionHost, 'request').mockImplementation((command) => {
      calls.push(command);
      if (command.type === 'find') return Promise.resolve(members.get(command.sessionId) ?? { type: 'membership', role: null });
      if (command.type === 'state') {
        const state = states.get(command.leadSessionId);
        return state ? Promise.resolve({ type: 'state', state }) : Promise.reject(new client.FusionError('NOT_FOUND'));
      }
      return Promise.resolve({ type: 'accepted' });
    });
    vi.spyOn(client.fusionHost, 'onChanged').mockImplementation((handler) => {
      listeners.push(handler);
      return Promise.resolve(() => {});
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('asks once per chat and asks again after its lead was deleted', async () => {
    members.set('side-1', { type: 'membership', role: 'sidekick', leadSessionId: 'lead-1' });
    states.set('lead-1', stateOf('lead-1', [{ id: 'side-1', retired: false }]));
    await membership.load('side-1');
    await membership.load('side-1');
    expect(asked('find', 'side-1')).toBe(1);
    expect(membership.peek('side-1')).toEqual({ role: 'sidekick', leadSessionId: 'lead-1' });

    // The lead is deleted: the host forgot the pair, so the sidekick chat is ordinary now.
    members.set('side-1', { type: 'membership', role: null });
    membership.forgetLead('lead-1');
    expect(membership.peek('side-1')).toBeUndefined();
    expect(membership.isSidekick('side-1')).toBe(false);
    await membership.load('side-1');
    expect(asked('find', 'side-1')).toBe(2);
    expect(membership.peek('side-1')).toEqual({ role: null });
  });

  it('forgets the lead itself and every chat that names it, and keeps other pairs', () => {
    membership.remember('lead-2');
    membership.rememberSidekick('side-2', 'lead-2');
    membership.remember('lead-3');
    membership.rememberSidekick('side-3', 'lead-3');
    membership.forgetLead('lead-2');
    expect(membership.peek('lead-2')).toBeUndefined();
    expect(membership.peek('side-2')).toBeUndefined();
    expect(membership.peek('lead-3')).toEqual({ role: 'lead', leadSessionId: 'lead-3' });
    expect(membership.isSidekick('side-3')).toBe(true);
  });

  it('ignores an answer that arrives after the lead was forgotten', async () => {
    members.set('side-4', { type: 'membership', role: 'sidekick', leadSessionId: 'lead-4' });
    states.set('lead-4', stateOf('lead-4', [{ id: 'side-4', retired: false }]));
    const loading = membership.load('side-4');
    membership.forgetLead('lead-4');
    await loading;
    expect(membership.peek('side-4')).toBeUndefined();
  });

  it('prunes chats whose lead left the catalog', () => {
    membership.remember('lead-5');
    membership.rememberSidekick('side-5', 'lead-5');
    membership.remember('lead-6');
    membership.prune(new Set(['lead-6', 'side-5']));
    expect(membership.peek('lead-5')).toBeUndefined();
    expect(membership.peek('side-5')).toBeUndefined();
    expect(membership.peek('lead-6')).toBeDefined();
  });

  it('tells the sidekick in use from a retired one by the lead state', async () => {
    members.set('old-7', { type: 'membership', role: 'sidekick', leadSessionId: 'lead-7' });
    members.set('new-7', { type: 'membership', role: 'sidekick', leadSessionId: 'lead-7' });
    states.set('lead-7', stateOf('lead-7', [{ id: 'old-7', retired: true }, { id: 'new-7', retired: false }]));
    await membership.load('old-7');
    await membership.load('new-7');
    expect(membership.isSidekick('old-7')).toBe(true);
    expect(membership.isCurrentSidekick('old-7')).toBe(false);
    expect(membership.isCurrentSidekick('new-7')).toBe(true);
    // Not a sidekick at all: nothing is protected.
    expect(membership.isCurrentSidekick('nobody')).toBe(false);
  });

  it('counts a sidekick as current while its lead state cannot be read', async () => {
    membership.rememberSidekick('side-8', 'lead-8');
    expect(membership.isCurrentSidekick('side-8')).toBe(true);
    vi.mocked(client.fusionHost.request).mockRejectedValue(new client.FusionError('IO_ERROR'));
    await membership.load('side-8');
    expect(membership.isCurrentSidekick('side-8')).toBe(true);
  });

  it('forgets a sidekick whose lead no longer has a pair', async () => {
    members.set('side-9', { type: 'membership', role: 'sidekick', leadSessionId: 'lead-9' });
    // `lead-9` has no state: the host answers NOT_FOUND.
    await membership.load('side-9');
    expect(membership.peek('side-9')).toBeUndefined();
    expect(membership.isCurrentSidekick('side-9')).toBe(false);
  });

  it('follows a reset: the sidekick retires when the lead announces a new revision', async () => {
    members.set('side-10', { type: 'membership', role: 'sidekick', leadSessionId: 'lead-10' });
    states.set('lead-10', stateOf('lead-10', [{ id: 'side-10', retired: false }], 1));
    await membership.load('side-10');
    expect(membership.isCurrentSidekick('side-10')).toBe(true);

    states.set('lead-10', stateOf('lead-10', [{ id: 'side-10', retired: true }], 2));
    for (const listener of listeners) listener({ protocol: 1, leadSessionId: 'lead-10', revision: 2 });
    await vi.waitFor(() => expect(membership.isCurrentSidekick('side-10')).toBe(false));
    expect(membership.isSidekick('side-10')).toBe(true);
  });
});
