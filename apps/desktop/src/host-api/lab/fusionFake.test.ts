import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFusionResult,
  FUSION_CHANGED_EVENT_V1,
  type FusionChangedEventV1,
  type FusionPairV1,
  type FusionResultV1,
  type FusionRoleV1,
  type FusionStateV1,
} from '../fusionClient';
import { checkPair, LAB_FUSION_BRIEF_DELAY_MS, LAB_FUSION_QUEUE_MS, LAB_FUSION_ROUND_MS, simulateFusionBrief } from './fusionFake';
import type { HarnessKind } from './labContracts';
import type { LabHost } from './labHost';
import { labHost, record, rejection } from './labTestKit';
import { DEMO_PROJECTS } from './scenarios/demoChats';

const WS = DEMO_PROJECTS.piui;

const OPTIONS = { briefPolicy: 'prescriptive', pushback: false, autoDeliver: true, leadNativeSubagents: false } as const;
const role = (harness: HarnessKind, permissionMode: FusionRoleV1['permissionMode']): FusionRoleV1 => ({ harness, permissionMode });
const pairOf = (lead: FusionRoleV1, sidekick: FusionRoleV1): FusionPairV1 => ({ lead, sidekick, options: { ...OPTIONS } });
const CODEX_PAIR = pairOf(role('codex', 'native'), role('codex', 'native'));
const CROSS_PAIR = pairOf(role('codex', 'full-access'), role('claude-code', 'full-access'));

async function fusion(host: LabHost, command: Record<string, unknown>): Promise<FusionResultV1> {
  const result = await host.invoke<unknown>('fusion_command_v1', { command });
  const decoded = decodeFusionResult(result);
  if (decoded === undefined) throw new Error(`invalid fusion result ${JSON.stringify(result)}`);
  return decoded;
}

async function create(host: LabHost, pair: FusionPairV1 = CODEX_PAIR): Promise<FusionStateV1> {
  const result = await fusion(host, { type: 'createChat', workspaceId: WS, pair });
  if (result.type !== 'created') throw new Error(`expected a created chat, got ${result.type}`);
  return result.state;
}

async function stateOf(host: LabHost, leadSessionId: string): Promise<FusionStateV1> {
  const result = await fusion(host, { type: 'state', leadSessionId });
  if (result.type !== 'state') throw new Error('expected a state');
  return result.state;
}

describe('fusion lab fake', () => {
  let host: LabHost;
  beforeEach(() => {
    vi.useFakeTimers();
    host = labHost('demo');
  });
  afterEach(() => vi.useRealTimers());

  it('refuses pairs by the host matrix', () => {
    const refusal = (pair: FusionPairV1, sandbox = true): string | undefined => {
      const answer = checkPair(pair, sandbox);
      return answer === undefined ? undefined : `${answer.refusal}:${answer.role}`;
    };
    expect(refusal(pairOf(role('hermes', 'native'), role('codex', 'native')))).toBe('lead-harness-unsupported:lead');
    expect(refusal(pairOf(role('codex', 'full-access'), role('hermes', 'native')))).toBe('sidekick-harness-unsupported:sidekick');
    expect(refusal(pairOf(role('codex', 'read-only'), role('codex', 'read-only')))).toBe('read-only-lead:lead');
    expect(refusal(CODEX_PAIR)).toBeUndefined();
    expect(refusal(pairOf(role('claude-code', 'native'), role('claude-code', 'native')))).toBeUndefined();
    // Native modes of different harnesses are incomparable.
    expect(refusal(pairOf(role('claude-code', 'native'), role('codex', 'native')))).toBe('explicit-modes-required:sidekick');
    expect(refusal(pairOf(role('codex', 'full-access'), role('codex', 'native')))).toBe('explicit-modes-required:sidekick');
    expect(refusal(pairOf(role('codex', 'native'), role('pi', 'native')))).toBe('explicit-modes-required:sidekick');
    expect(refusal(CROSS_PAIR)).toBeUndefined();
    expect(refusal(pairOf(role('codex', 'workspace-write'), role('codex', 'full-access')))).toBe('sidekick-exceeds-lead:sidekick');
    expect(refusal(pairOf(role('codex', 'full-access'), role('claude-code', 'workspace-write')))).toBe('sidekick-needs-full-access:sidekick');
    expect(refusal(pairOf(role('codex', 'full-access'), role('claude-code', 'read-only')))).toBe('sidekick-needs-full-access:sidekick');
    // Pi needs both roles at full access.
    expect(refusal(pairOf(role('codex', 'full-access'), role('pi', 'full-access')))).toBeUndefined();
    expect(refusal(pairOf(role('codex', 'workspace-write'), role('pi', 'workspace-write')))).toBe('sidekick-needs-full-access:sidekick');
    // A workspace-write Codex sidekick needs the sandbox.
    const sandboxed = pairOf(role('claude-code', 'full-access'), role('codex', 'workspace-write'));
    expect(refusal(sandboxed)).toBeUndefined();
    expect(refusal(sandboxed, false)).toBe('codex-sandbox-unverified:sidekick');
  });

  it('answers checkPair through the host and simulates an unverified Codex sandbox', async () => {
    const sandboxed = pairOf(role('claude-code', 'full-access'), role('codex', 'workspace-write'));
    expect(await fusion(host, { type: 'checkPair', workspaceId: WS, pair: sandboxed })).toEqual({ type: 'pairCheck', ok: true });
    host.fusion.codexSandbox = false;
    expect(await fusion(host, { type: 'checkPair', workspaceId: WS, pair: sandboxed })).toEqual({
      type: 'pairCheck', ok: false, refusal: 'codex-sandbox-unverified', role: 'sidekick',
    });
    // Unknown fields fail like serde's deny_unknown_fields.
    await expect(fusion(host, { type: 'state', leadSessionId: 'x', extra: 1 })).rejects.toBeTruthy();
  });

  it('creates an ordinary lead chat and a state the client decoder accepts', async () => {
    const before = host.state.sessions.size;
    const state = await create(host, CROSS_PAIR);
    expect(host.state.sessions.size).toBe(before + 1);
    expect(host.state.sessions.get(state.leadSessionId)).toMatchObject({ harness: 'codex', workspaceId: WS });
    expect(state).toMatchObject({ protocol: 1, workspaceId: WS, sidekick: 'none', sessions: [], briefs: [], pair: CROSS_PAIR });
    expect(state.stats).toEqual({ briefs: 0, accepted: 0, rejected: 0, takenOver: 0, rounds: 0 });
    expect(await stateOf(host, state.leadSessionId)).toEqual(state);
    expect(await fusion(host, { type: 'find', sessionId: state.leadSessionId })).toEqual({
      type: 'membership', role: 'lead', leadSessionId: state.leadSessionId,
    });
    expect(await fusion(host, { type: 'find', sessionId: 'not-a-member' })).toEqual({ type: 'membership', role: null });
    expect(await rejection(host.invoke('fusion_command_v1', { command: { type: 'state', leadSessionId: 'missing' } }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers a refused createChat with pairCheck and starts nothing', async () => {
    const before = host.state.sessions.size;
    const result = await fusion(host, { type: 'createChat', workspaceId: WS, pair: pairOf(role('codex', 'read-only'), role('codex', 'read-only')) });
    expect(result).toEqual({ type: 'pairCheck', ok: false, refusal: 'read-only-lead', role: 'lead' });
    expect(host.state.sessions.size).toBe(before);
  });

  it('plays the demo brief and emits a change event for every step', async () => {
    const events = await record<FusionChangedEventV1>(host, FUSION_CHANGED_EVENT_V1);
    const lead = (await create(host, CROSS_PAIR)).leadSessionId;
    expect((await stateOf(host, lead)).briefs).toEqual([]);

    await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS);
    const queued = await stateOf(host, lead);
    expect(queued.briefs).toHaveLength(1);
    expect(queued.briefs[0]).toMatchObject({ state: 'active', rounds: [{ kind: 'brief', state: 'queued' }] });
    expect(queued.sidekick).toBe('working');
    expect(queued.sessions).toHaveLength(1);
    expect(queued.sessions[0]).toMatchObject({ harness: 'claude-code', retired: false });
    expect(queued.briefs[0]?.sidekickSessionId).toBe(queued.sessions[0]?.sessionId);
    expect(await fusion(host, { type: 'find', sessionId: queued.sessions[0]?.sessionId })).toEqual({
      type: 'membership', role: 'sidekick', leadSessionId: lead,
    });

    await vi.advanceTimersByTimeAsync(LAB_FUSION_QUEUE_MS);
    expect((await stateOf(host, lead)).briefs[0]?.rounds[0]?.state).toBe('running');

    await vi.advanceTimersByTimeAsync(LAB_FUSION_ROUND_MS);
    await vi.advanceTimersByTimeAsync(0);
    const finished = await stateOf(host, lead);
    expect(finished.sidekick).toBe('idle');
    expect(finished.briefs[0]).toMatchObject({ state: 'reported' });
    expect(finished.briefs[0]?.rounds[0]).toMatchObject({
      state: 'finished', outcome: 'completed', status: 'done', delivery: { via: 'tool', state: 'sent' },
    });
    expect(finished.stats).toMatchObject({ briefs: 1, rounds: 1 });

    // The lab bus delivers events on a later timer tick.
    await vi.advanceTimersByTimeAsync(10);
    // Queued, running, finished; creation answers with the state itself, as on the host.
    expect(events.items.length).toBeGreaterThanOrEqual(3);
    expect(events.items.every((event) => event.protocol === 1 && event.leadSessionId === lead)).toBe(true);
    const revisions = events.items.map((event) => event.revision);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(revisions.at(-1)).toBe(finished.revision);
  });

  it('stops the open round, withdraws its delivery and cancels the script', async () => {
    const lead = (await create(host)).leadSessionId;
    await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS);
    expect((await stateOf(host, lead)).sidekick).toBe('working');

    expect(await fusion(host, { type: 'stopSidekick', leadSessionId: lead })).toEqual({ type: 'accepted' });
    const stopped = await stateOf(host, lead);
    expect(stopped.sidekick).toBe('idle');
    expect(stopped.briefs[0]?.rounds[0]).toMatchObject({ state: 'finished', outcome: 'interrupted', delivery: { via: 'followUp', state: 'withdrawn' } });

    await vi.advanceTimersByTimeAsync(LAB_FUSION_ROUND_MS * 2);
    expect(await stateOf(host, lead)).toEqual(stopped);
    // Nothing is open: a second stop changes nothing.
    expect(await fusion(host, { type: 'stopPair', leadSessionId: lead })).toEqual({ type: 'accepted' });
    expect((await stateOf(host, lead)).revision).toBe(stopped.revision);
    expect(await rejection(host.invoke('fusion_command_v1', { command: { type: 'stopSidekick', leadSessionId: 'missing' } }))).toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('resets the sidekick by retiring and closing its session', async () => {
    const lead = (await create(host)).leadSessionId;
    await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS);
    const before = await stateOf(host, lead);
    const sidekickId = before.sessions[0]?.sessionId ?? '';
    expect(host.state.sessions.get(sidekickId)?.live).toBeDefined();

    expect(await fusion(host, { type: 'resetSidekick', leadSessionId: lead })).toEqual({ type: 'accepted' });
    const after = await stateOf(host, lead);
    expect(after.sidekick).toBe('none');
    expect(after.sessions[0]).toMatchObject({ sessionId: sidekickId, retired: true, retiredReason: 'reset by the person' });
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(host.state.sessions.get(sidekickId)?.live).toBeUndefined();
    // The retired session still belongs to the pair.
    expect(await fusion(host, { type: 'find', sessionId: sidekickId })).toMatchObject({ role: 'sidekick', leadSessionId: lead });
  });

  it('refuses ordinary workspace commands on a sidekick like the native host', async () => {
    const lead = (await create(host)).leadSessionId;
    await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS);
    const sidekick = (await stateOf(host, lead)).sessions[0]?.sessionId ?? '';
    const refused = async (channel: string, command: Record<string, unknown>) =>
      rejection(host.invoke(channel, { command }));
    const model = { id: 'lab-sonnet', provider: 'anthropic', name: 'Claude Lab Sonnet' };

    expect(await refused('workspace_command_v15', { type: 'send', sessionId: sidekick, text: 'hello', mode: 'prompt' })).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await refused('workspace_command_v15', { type: 'send', sessionId: sidekick, text: 'hello', mode: 'steer' })).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await refused('workspace_command_v15', { type: 'interrupt', sessionId: sidekick })).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await refused('workspace_command_v15', { type: 'setModel', sessionId: sidekick, model })).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await refused('workspace_command_v15', { type: 'respond', sessionId: sidekick, requestId: 'r1', decision: 'approve-session' })).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await refused('workspace_settings_v16', { type: 'set', sessionId: sidekick, model, thinkingLevel: null, serviceTier: null })).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await refused('workspace_lifecycle_v17', { type: 'deleteSession', sessionId: sidekick })).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(await refused('workspace_composer_v19', { type: 'send', sessionId: sidekick, requestId: 'q1', text: 'hello', mode: 'prompt' })).toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(host.state.sessions.has(sidekick)).toBe(true);

    // Reading, renaming, closing and answering a request once stay available.
    await expect(host.invoke('workspace_settings_v16', { command: { type: 'get', sessionId: sidekick } })).resolves.toMatchObject({ sessionId: sidekick });
    await expect(host.invoke('workspace_composer_v19', { command: { type: 'snapshot', sessionId: sidekick } })).resolves.toMatchObject({ sessionId: sidekick });
    expect(await refused('workspace_command_v15', { type: 'respond', sessionId: sidekick, requestId: 'r1', decision: 'approve-once' })).toMatchObject({ code: 'APPROVAL_EXPIRED' });
    await expect(host.invoke('workspace_command_v15', { command: { type: 'renameSession', sessionId: sidekick, title: 'Sidekick notes' } })).resolves.toMatchObject({ type: 'accepted' });

    // The lead is an ordinary chat; stopping the sidekick goes through the broker.
    await expect(host.invoke('workspace_command_v15', { command: { type: 'send', sessionId: lead, text: 'hello', mode: 'prompt' } })).resolves.toMatchObject({ type: 'accepted' });
    expect(await fusion(host, { type: 'stopSidekick', leadSessionId: lead })).toEqual({ type: 'accepted' });
  });

  it('reconciles or abandons an uncertain round and refuses a reset meanwhile', async () => {
    host.fusion.autoDemo = false;
    const lead = (await create(host)).leadSessionId;
    expect(simulateFusionBrief(host.fusion, 'missing')).toBeUndefined();
    const first = simulateFusionBrief(host.fusion, lead, { ending: 'uncertain' });
    expect(first).toBeDefined();
    expect(simulateFusionBrief(host.fusion, lead)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS);
    expect((await stateOf(host, lead)).briefs[0]?.rounds[0]?.state).toBe('uncertain');

    expect(await rejection(host.invoke('fusion_command_v1', { command: { type: 'resetSidekick', leadSessionId: lead } }))).toMatchObject({ code: 'CONFLICT' });
    expect(await rejection(host.invoke('fusion_command_v1', { command: { type: 'abandonRound', leadSessionId: lead, roundId: 'missing' } }))).toMatchObject({ code: 'NOT_FOUND' });

    const abandoned = await fusion(host, { type: 'abandonRound', leadSessionId: lead, roundId: first?.roundId });
    if (abandoned.type !== 'state') throw new Error('expected a state');
    expect(abandoned.state.briefs[0]).toMatchObject({ state: 'stopped' });
    expect(abandoned.state.briefs[0]?.rounds[0]).toMatchObject({ state: 'finished', outcome: 'uncertain' });
    expect(await rejection(host.invoke('fusion_command_v1', { command: { type: 'reconcileRound', leadSessionId: lead, roundId: first?.roundId } }))).toMatchObject({ code: 'CONFLICT' });

    const second = simulateFusionBrief(host.fusion, lead, { ending: 'uncertain' });
    await vi.advanceTimersByTimeAsync(LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS);
    const reconciled = await fusion(host, { type: 'reconcileRound', leadSessionId: lead, roundId: second?.roundId });
    if (reconciled.type !== 'state') throw new Error('expected a state');
    expect(reconciled.state.briefs[1]?.rounds[0]).toMatchObject({ state: 'finished', outcome: 'completed', status: 'done' });
    expect(reconciled.state.briefs[1]?.state).toBe('reported');
  });

  describe('lifecycle of Fusion chats', () => {
    const lifecycle = (id: string) => host.invoke('workspace_lifecycle_v17', { command: { type: 'deleteSession', sessionId: id } });

    it('refuses deleting a lead while a sidekick round is open and deletes it once the round is stopped', async () => {
      const lead = (await create(host)).leadSessionId;
      await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS);
      expect((await stateOf(host, lead)).sidekick).toBe('working');
      expect(await rejection(lifecycle(lead))).toMatchObject({ code: 'CONFLICT' });
      expect(host.state.sessions.has(lead)).toBe(true);
      expect(host.fusion.states.has(lead)).toBe(true);

      await fusion(host, { type: 'stopPair', leadSessionId: lead });
      await expect(lifecycle(lead)).resolves.toMatchObject({ sessionId: lead });
      expect(host.state.sessions.has(lead)).toBe(false);
    });

    it('refuses deleting a lead whose round is uncertain until the person settles it', async () => {
      host.fusion.autoDemo = false;
      const lead = (await create(host)).leadSessionId;
      const round = simulateFusionBrief(host.fusion, lead, { ending: 'uncertain' });
      await vi.advanceTimersByTimeAsync(LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS);
      expect((await stateOf(host, lead)).briefs[0]?.rounds[0]?.state).toBe('uncertain');
      expect(await rejection(lifecycle(lead))).toMatchObject({ code: 'CONFLICT' });
      await fusion(host, { type: 'abandonRound', leadSessionId: lead, roundId: round?.roundId });
      await expect(lifecycle(lead)).resolves.toMatchObject({ sessionId: lead });
    });

    it('forgets the pair and its membership when the lead is deleted; the sidekick chat stays', async () => {
      const lead = (await create(host)).leadSessionId;
      await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS);
      const sidekick = (await stateOf(host, lead)).sessions[0]?.sessionId ?? '';
      expect(host.state.sessions.get(sidekick)?.live).toBeDefined();

      await lifecycle(lead);
      expect(host.fusion.states.has(lead)).toBe(false);
      expect(await fusion(host, { type: 'find', sessionId: lead })).toEqual({ type: 'membership', role: null });
      expect(await rejection(host.invoke('fusion_command_v1', { command: { type: 'state', leadSessionId: lead } }))).toMatchObject({ code: 'NOT_FOUND' });
      // The sidekick chat stays as an ordinary chat that is no longer a member; its idle process is closed.
      expect(host.state.sessions.has(sidekick)).toBe(true);
      expect(host.state.sessions.get(sidekick)?.live).toBeUndefined();
      expect(await fusion(host, { type: 'find', sessionId: sidekick })).toEqual({ type: 'membership', role: null });
      await expect(lifecycle(sidekick)).resolves.toMatchObject({ sessionId: sidekick });
    });

    it('cancels the scheduled demo brief of a deleted lead', async () => {
      const events = await record<FusionChangedEventV1>(host, FUSION_CHANGED_EVENT_V1);
      const lead = (await create(host)).leadSessionId;
      await lifecycle(lead);
      await vi.advanceTimersByTimeAsync(10);
      const seen = events.items.length;
      const sessions = host.state.sessions.size;

      await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS * 2);
      // No brief starts, no sidekick chat appears, no event is emitted.
      expect(events.items.length).toBe(seen);
      expect(host.state.sessions.size).toBe(sessions);
      expect(host.fusion.states.size).toBe(0);
      events.stop();
    });

    it('deletes only a retired sidekick chat and refuses the one in use', async () => {
      const lead = (await create(host)).leadSessionId;
      await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS);
      const first = (await stateOf(host, lead)).sessions[0]?.sessionId ?? '';
      expect(await rejection(lifecycle(first))).toMatchObject({ code: 'NOT_SUPPORTED' });

      await fusion(host, { type: 'resetSidekick', leadSessionId: lead });
      // The retired chat keeps its membership (read-only) yet may be deleted.
      expect(await fusion(host, { type: 'find', sessionId: first })).toMatchObject({ role: 'sidekick', leadSessionId: lead });
      expect(await rejection(host.invoke('workspace_command_v15', { command: { type: 'send', sessionId: first, text: 'hi', mode: 'prompt' } }))).toMatchObject({ code: 'NOT_SUPPORTED' });

      expect(simulateFusionBrief(host.fusion, lead)).toBeDefined();
      const current = (await stateOf(host, lead)).sessions.find((session) => !session.retired)?.sessionId ?? '';
      expect(current).not.toBe(first);
      expect(await rejection(lifecycle(current))).toMatchObject({ code: 'NOT_SUPPORTED' });
      await expect(lifecycle(first)).resolves.toMatchObject({ sessionId: first });
      expect(host.state.sessions.has(first)).toBe(false);
      expect(host.state.sessions.has(current)).toBe(true);
    });

    it('closes the sidekick in use through the broker: the round stops and its report is withdrawn', async () => {
      const lead = (await create(host)).leadSessionId;
      await vi.advanceTimersByTimeAsync(LAB_FUSION_BRIEF_DELAY_MS + LAB_FUSION_QUEUE_MS);
      const state = await stateOf(host, lead);
      const sidekick = state.sessions[0]?.sessionId ?? '';
      expect(state.sidekick).toBe('working');

      await expect(host.invoke('workspace_command_v15', { command: { type: 'closeSession', sessionId: sidekick } })).resolves.toMatchObject({ type: 'accepted' });
      const closed = await stateOf(host, lead);
      expect(closed.sidekick).toBe('idle');
      expect(closed.briefs[0]?.rounds[0]).toMatchObject({ state: 'finished', outcome: 'interrupted', delivery: { state: 'withdrawn' } });
      expect(host.state.sessions.get(sidekick)?.live).toBeUndefined();
      // The scripted report never arrives afterwards.
      await vi.advanceTimersByTimeAsync(LAB_FUSION_ROUND_MS * 2);
      expect(await stateOf(host, lead)).toEqual(closed);
    });
  });

  it('refuses every change in safe mode but still reads', async () => {
    const safe = labHost('safe');
    expect(await rejection(safe.invoke('fusion_command_v1', { command: { type: 'createChat', workspaceId: WS, pair: CODEX_PAIR } }))).toMatchObject({ code: 'SAFE_MODE' });
    for (const type of ['stopPair', 'stopSidekick', 'resetSidekick']) {
      expect(await rejection(safe.invoke('fusion_command_v1', { command: { type, leadSessionId: 'x' } }))).toMatchObject({ code: 'SAFE_MODE' });
    }
    expect(await fusion(safe, { type: 'checkPair', workspaceId: WS, pair: CODEX_PAIR })).toEqual({ type: 'pairCheck', ok: true });
    expect(await fusion(safe, { type: 'find', sessionId: 'x' })).toEqual({ type: 'membership', role: null });
    expect(await rejection(safe.invoke('fusion_command_v1', { command: { type: 'state', leadSessionId: 'x' } }))).toMatchObject({ code: 'NOT_FOUND' });
  });
});
