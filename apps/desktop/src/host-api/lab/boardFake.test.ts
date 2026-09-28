import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardChangedEventV1, BoardResultV1, BoardV1, CardV1 } from '../../../../../contracts/board-v1';
import type { TeammatesResultV1, TeammateV1 } from '../../../../../contracts/teammates-v1';
import { decodeBoardResult } from '../boardClient';
import { decodeTeammatesResult } from '../teammatesClient';
import { LAB_BOARD_RUN_MS } from './boardFake';
import type { LabHost } from './labHost';
import { labHost, record, rejection } from './labTestKit';
import { DEMO_PROJECTS, demoSessionId } from './scenarios/demoChats';

const WS = DEMO_PROJECTS.video;
const OTHER = DEMO_PROJECTS.piui;
const CHAT = demoSessionId('storyboard');

async function board(host: LabHost, command: Record<string, unknown>): Promise<BoardResultV1> {
  const result = await host.invoke<unknown>('board_command_v1', { command: { workspaceId: WS, ...command } });
  const decoded = decodeBoardResult(result);
  if (decoded === undefined) throw new Error(`invalid board result ${JSON.stringify(result)}`);
  return decoded;
}

async function get(host: LabHost, workspaceId = WS): Promise<BoardV1> {
  const result = await board(host, { type: 'get', workspaceId });
  if (result.type !== 'board') throw new Error('expected a board');
  return result.board;
}

async function cardResult(host: LabHost, command: Record<string, unknown>): Promise<CardV1> {
  const result = await board(host, command);
  if (result.type !== 'card') throw new Error(`expected a card, got ${result.type}`);
  return result.card;
}

async function team(host: LabHost): Promise<TeammateV1[]> {
  const result = decodeTeammatesResult(await host.invoke<unknown>('teammates_command_v1', { command: { type: 'list', workspaceId: WS } })) as TeammatesResultV1;
  return result.type === 'teammates' ? result.teammates : [];
}

const byTitle = (value: BoardV1, prefix: string): CardV1 => {
  const found = value.cards.find((card) => card.title.startsWith(prefix));
  if (!found) throw new Error(`no card ${prefix}`);
  return found;
};

describe('board lab fake', () => {
  let host: LabHost;
  beforeEach(() => {
    vi.useFakeTimers();
    host = labHost('demo');
  });
  afterEach(() => vi.useRealTimers());

  it('seeds an enabled board with every status, a proposal and a pending start', async () => {
    const seeded = await get(host);
    expect(seeded.enabled).toBe(true);
    expect(seeded.cards).toHaveLength(10);
    expect(new Set(seeded.cards.map((card) => card.status))).toEqual(new Set(['backlog', 'todo', 'inProgress', 'inReview', 'blocked', 'done', 'cancelled']));
    expect(seeded.proposals.filter((proposal) => proposal.status === 'pending')).toHaveLength(1);
    expect(seeded.pendingStarts).toHaveLength(1);
    expect(seeded.cards.some((card) => card.activity.some((entry) => entry.undoable))).toBe(true);
  });

  it('reads other projects as disabled and refuses card writes there', async () => {
    const other = await get(host, OTHER);
    expect(other).toMatchObject({ enabled: false, cards: [], revision: 0 });
    expect(await rejection(board(host, { type: 'createCard', workspaceId: OTHER, card: { title: 'x' } }))).toMatchObject({ code: 'DISABLED' });
    const enabled = await board(host, { type: 'setEnabled', workspaceId: OTHER, enabled: true });
    expect(enabled.type === 'board' && enabled.board.enabled).toBe(true);
  });

  it('creates, edits with revision checks, moves and emits change events', async () => {
    const events = await record<BoardChangedEventV1>(host, 'piui://board-changed-v1');
    const created = await cardResult(host, { type: 'createCard', card: { title: '  Write docs ', labels: ['Docs'] }, sessionId: CHAT });
    expect(created).toMatchObject({ number: 11, title: 'Write docs', status: 'todo', labels: ['docs'] });
    expect(created.links[0]).toMatchObject({ kind: 'session', sessionId: CHAT });

    const edited = await cardResult(host, { type: 'updateCard', cardId: created.id, expectedRevision: created.revision, patch: { title: 'Write the docs' } });
    expect(edited.title).toBe('Write the docs');
    expect(await rejection(board(host, { type: 'updateCard', cardId: created.id, expectedRevision: created.revision, patch: { title: 'stale' } })))
      .toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await rejection(board(host, { type: 'updateCard', cardId: created.id, expectedRevision: edited.revision, patch: { title: '' } })))
      .toMatchObject({ code: 'INVALID_ARGUMENT' });
    // Unknown fields fail like serde's deny_unknown_fields.
    await expect(board(host, { type: 'createCard', card: { title: 'x', color: 'red' } })).rejects.toBeTruthy();

    const moved = await cardResult(host, { type: 'moveCard', cardId: created.id, to: 'done' });
    expect(moved).toMatchObject({ status: 'done' });
    expect(moved.closedAt).toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.items.length).toBeGreaterThanOrEqual(3);
    expect(events.items.every((event) => event.workspaceId === WS && event.protocol === 1)).toBe(true);
  });

  it('undoes an agent edit and a move', async () => {
    const seeded = await get(host);
    const transport = byTitle(seeded, 'Route every host call');
    const agentEdit = transport.activity.find((entry) => entry.undoable && entry.change.type === 'edited');
    const reverted = await cardResult(host, { type: 'undo', cardId: transport.id, activityId: agentEdit?.id });
    expect(reverted.description).toBe('No component may import Tauri directly.');
    expect(reverted.activity.at(-1)?.change).toEqual({ type: 'reverted', activityId: agentEdit?.id });
    expect(await rejection(board(host, { type: 'undo', cardId: transport.id, activityId: agentEdit?.id }))).toMatchObject({ code: 'INVALID_ARGUMENT' });

    const moved = await cardResult(host, { type: 'moveCard', cardId: transport.id, to: 'blocked' });
    const move = moved.activity.find((entry) => entry.change.type === 'moved' && entry.undoable);
    const back = await cardResult(host, { type: 'undo', cardId: transport.id, activityId: move?.id });
    expect(back.status).toBe('inProgress');
  });

  it('accepts a proposal by applying its operation', async () => {
    const seeded = await get(host);
    const proposal = seeded.proposals[0];
    const result = await board(host, { type: 'resolveProposal', proposalId: proposal?.id, accept: true });
    if (result.type !== 'board') throw new Error('expected a board');
    expect(result.board.proposals[0]?.status).toBe('accepted');
    expect(result.board.cards.find((card) => card.id === proposal?.cardId)?.status).toBe('done');
    // The accepted close unblocks the card it blocked.
    expect(byTitle(result.board, 'Fix crash on startup')).toMatchObject({ status: 'todo' });
    expect(await rejection(board(host, { type: 'resolveProposal', proposalId: proposal?.id, accept: false }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('starts a run from a pending start, claims the card and finishes it later', async () => {
    const seeded = await get(host);
    const pending = seeded.pendingStarts[0];
    const started = await cardResult(host, { type: 'resolvePendingStart', pendingStartId: pending?.id, accept: true });
    expect(started.status).toBe('inProgress');
    expect(started.claim?.runId).toBeDefined();
    expect(started.links.some((link) => link.kind === 'run' && link.runId === started.claim?.runId)).toBe(true);
    expect((await get(host)).pendingStarts).toHaveLength(0);
    expect(await rejection(board(host, { type: 'startRun', cardId: started.id }))).toMatchObject({ code: 'ALREADY_CLAIMED' });

    const status = decodeTeammatesResult(await host.invoke<unknown>('teammates_command_v1', { command: { type: 'list', workspaceId: WS } }));
    expect(status?.type === 'teammates' && status.status.some((item) => item.availability === 'working')).toBe(true);

    await vi.advanceTimersByTimeAsync(LAB_BOARD_RUN_MS + 10);
    const finished = (await get(host)).cards.find((card) => card.id === started.id);
    expect(finished?.status).toBe('inReview');
    expect(finished?.claim).toBeUndefined();
    expect(finished?.comments.at(-1)?.runId).toBe(started.claim?.runId);
  });

  it('follows the assign start mode and never starts backlog cards', async () => {
    const [coder] = await team(host);
    const seeded = await get(host);
    const backlog = byTitle(seeded, 'Explain session compaction');
    const assigned = await cardResult(host, { type: 'assign', cardId: backlog.id, teammateId: coder?.id, start: 'now' });
    expect(assigned).toMatchObject({ assignee: coder?.id, status: 'backlog' });
    expect(assigned.claim).toBeUndefined();

    const todo = byTitle(seeded, 'Measure long-session scroll');
    const asked = await cardResult(host, { type: 'assign', cardId: todo.id, teammateId: coder?.id, start: 'ask' });
    expect(asked.claim).toBeUndefined();
    expect((await get(host)).pendingStarts.some((item) => item.cardId === todo.id)).toBe(true);

    const now = await cardResult(host, { type: 'assign', cardId: todo.id, teammateId: coder?.id, start: 'now' });
    expect(now.claim?.runId).toBeDefined();
  });

  it('validates comment mentions and wakes a mentioned assignee', async () => {
    const [coder] = await team(host);
    const seeded = await get(host);
    const perf = byTitle(seeded, 'Measure long-session scroll');
    await cardResult(host, { type: 'assign', cardId: perf.id, teammateId: coder?.id, start: 'later' });
    expect(await rejection(board(host, { type: 'comment', cardId: perf.id, body: 'hi @coder', mentions: [{ teammateId: coder?.id, start: 0, length: 6 }] })))
      .toMatchObject({ code: 'INVALID_ARGUMENT' });
    const commented = await cardResult(host, { type: 'comment', cardId: perf.id, body: 'hi @coder', mentions: [{ teammateId: coder?.id, start: 3, length: 6 }] });
    expect(commented.comments.at(-1)?.mentions).toEqual([{ teammateId: coder?.id, start: 3, length: 6 }]);
    expect((await get(host)).pendingStarts.some((item) => item.cardId === perf.id)).toBe(true);
  });

  it('lists a chat’s cards with the active one first and deletes cards', async () => {
    const seeded = await get(host);
    const link = byTitle(seeded, 'Route every host call').links.find((item) => item.kind === 'session');
    const chat = link?.kind === 'session' ? link.sessionId : '';
    const result = await board(host, { type: 'sessionCards', sessionId: chat });
    expect(result.type === 'sessionCards' && result.cards[0]?.title).toMatch(/^Route every host call/);
    const repro = byTitle(seeded, 'Reproduce the startup crash');
    const deleted = await board(host, { type: 'deleteCard', cardId: repro.id, expectedRevision: repro.revision });
    expect(deleted).toMatchObject({ type: 'deleted', cardId: repro.id });
    const after = await get(host);
    expect(after.cards.some((card) => card.id === repro.id)).toBe(false);
    expect(byTitle(after, 'Fix crash on startup').blockedBy).toEqual([]);
    expect(after.proposals.some((proposal) => proposal.cardId === repro.id)).toBe(false);
  });

  it('refuses every change in safe mode but still reads', async () => {
    const safe = labHost('safe');
    const seeded = await get(safe);
    expect(seeded.cards).toHaveLength(10);
    expect(await rejection(safe.invoke('board_command_v1', { command: { type: 'createCard', workspaceId: WS, card: { title: 'x' } } }))).toMatchObject({ code: 'SAFE_MODE' });
  });
});
