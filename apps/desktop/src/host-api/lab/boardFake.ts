import {
  BOARD_CHANGED_EVENT_V1,
  CARD_STATUS_CATEGORY,
  CARD_STATUSES,
  CLAIM_LEASE_SECONDS,
  DEFAULT_BOARD_SETTINGS,
  MAX_CARD_DESCRIPTION_BYTES,
  MAX_CARD_TITLE_CHARS,
  MAX_CARDS,
  MAX_COMMENT_BYTES,
  MAX_COMMENTS_PER_CARD,
  MAX_LABELS_PER_CARD,
  MAX_ACTIVITY_PER_CARD,
  type BoardActorV1,
  type BoardCommandV1,
  type BoardOperationV1,
  type BoardResultV1,
  type BoardRunCauseV1,
  type BoardSettingsV1,
  type BoardV1,
  type CardActivityV1,
  type CardChangeV1,
  type CardEditableFieldsV1,
  type CardStartModeV1,
  type CardStatusV1,
  type CardV1,
  type CommentMentionV1,
} from '../../../../../contracts/board-v1';
import type { TeammateV1 } from '../../../../../contracts/teammates-v1';
import type { LabEventBus } from './labBus';
import { MINUTE, SECOND } from './labClock';
import type { HostErrorPayload } from './labErrors';
import type { LabHandlers } from './labHandlers';
import { labUuid } from './labRandom';
import { arrayOf, boolean, decodeArgument, enumOf, object, option, string, tagged, u32, u64 } from './labSchema';
import { pipelineInputsOf, resolveCardInput, type LabTeam } from './teammatesFake';
import type { LabSessions } from './sessionRuntime';

/**
 * UI Lab fake of `board_command_v1` (ADR-041, docs/BOARD.md): one board per
 * project in memory with the host's limits, revision checks, safe-mode
 * refusals, undo, proposals and wake rules. `startRun` claims the card and
 * links a simulated run that finishes on its own after a short while; no
 * agent is executed.
 */
function failure(code: string, message: string): HostErrorPayload {
  return { code, message, recoverable: true };
}

const SAFE_MODE = failure('SAFE_MODE', 'Safe mode is on: PiUI does not change the board.');
const INVALID = failure('INVALID_ARGUMENT', 'Check the card details and try again.');
const NOT_FOUND = failure('NOT_FOUND', 'That card is no longer on the board.');
const DISABLED = failure('DISABLED', 'The board of this project is turned off.');
const CONFLICT = failure('REVISION_CONFLICT', 'The card changed meanwhile.');
const CLAIMED = failure('ALREADY_CLAIMED', 'A run is already working on this card.');
const LIMIT = failure('LIMIT', 'The board is full.');
const NOT_ASSIGNABLE = failure('NOT_ASSIGNABLE', 'This teammate cannot take cards.');

/** How long a simulated board run works before it finishes. */
export const LAB_BOARD_RUN_MS = 30 * SECOND;

const PERSON: BoardActorV1 = { kind: 'person' };
const HOST: BoardActorV1 = { kind: 'host' };
const statusSchema = enumOf(CARD_STATUSES);
const prioritySchema = enumOf(['urgent', 'high', 'normal', 'low']);
const permissionsSchema = object({ read: boolean, comment: boolean, create: boolean, move: boolean, claim: boolean, assign: boolean });
const fields = {
  description: option(string),
  priority: option(prioritySchema),
  labels: option(arrayOf(string)),
  blockedBy: option(arrayOf(string)),
  parentId: option(string),
};

const commandSchema = tagged('type', {
  get: { workspaceId: string },
  setEnabled: { workspaceId: string, enabled: boolean },
  updateSettings: {
    workspaceId: string,
    expectedRevision: u64,
    settings: object({ agentMode: enumOf(['auto', 'proposal']), chatAgentPermissions: permissionsSchema, maxConcurrentRuns: u32 }),
  },
  createCard: { workspaceId: string, card: object({ title: string, ...fields }), status: option(statusSchema), sessionId: option(string) },
  updateCard: { workspaceId: string, cardId: string, expectedRevision: u64, patch: object({ title: option(string), ...fields }) },
  moveCard: { workspaceId: string, cardId: string, to: statusSchema, order: option(u64) },
  deleteCard: { workspaceId: string, cardId: string, expectedRevision: u64 },
  comment: {
    workspaceId: string,
    cardId: string,
    body: string,
    mentions: option(arrayOf(object({ teammateId: string, start: u32, length: u32 }))),
  },
  assign: { workspaceId: string, cardId: string, teammateId: option(string), start: enumOf(['ask', 'now', 'later']) },
  startRun: { workspaceId: string, cardId: string },
  resolvePendingStart: { workspaceId: string, pendingStartId: string, accept: boolean },
  releaseClaim: { workspaceId: string, cardId: string },
  linkSession: { workspaceId: string, cardId: string, sessionId: string },
  unlinkSession: { workspaceId: string, cardId: string, sessionId: string },
  sessionCards: { workspaceId: string, sessionId: string },
  undo: { workspaceId: string, cardId: string, activityId: string },
  resolveProposal: { workspaceId: string, proposalId: string, accept: boolean },
});

const encoder = new TextEncoder();
const bytes = (value: string): number => encoder.encode(value).length;
const CONTROL = /\p{Cc}/u;

export function emptyBoard(workspaceId: string, now: string): BoardV1 {
  return {
    workspaceId,
    enabled: false,
    settings: structuredClone(DEFAULT_BOARD_SETTINGS),
    cards: [],
    proposals: [],
    pendingStarts: [],
    nextNumber: 1,
    revision: 0,
    updatedAt: now,
  };
}

export interface LabBoards {
  boards: Map<string, BoardV1>;
}

export function createLabBoards(): LabBoards {
  return { boards: new Map() };
}

function validLabels(labels: readonly string[]): boolean {
  return labels.length <= MAX_LABELS_PER_CARD && labels.every((label) => label.trim().length > 0 && [...label].length <= 40 && !CONTROL.test(label));
}

function normalizedLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim().toLowerCase()))];
}

export function boardHandlers(runtime: LabSessions, bus: LabEventBus, team: LabTeam, store: LabBoards = createLabBoards()): LabHandlers {
  const { state } = runtime;
  const finishTimers = new Map<string, () => void>();
  team.queuedFor = (workspaceId, teammateId) =>
    store.boards.get(workspaceId)?.pendingStarts.filter((item) => item.teammateId === teammateId).length ?? 0;

  const copy = <T>(value: T): T => structuredClone(value);
  const now = (): string => runtime.clock.iso();

  function requireProject(workspaceId: string): void {
    if (!state.projects.some((project) => project.id === workspaceId && !project.personal)) throw NOT_FOUND;
  }

  function boardOf(workspaceId: string): BoardV1 {
    requireProject(workspaceId);
    const existing = store.boards.get(workspaceId);
    if (existing !== undefined) return existing;
    const created = emptyBoard(workspaceId, now());
    store.boards.set(workspaceId, created);
    return created;
  }

  function enabledBoard(workspaceId: string): BoardV1 {
    const board = boardOf(workspaceId);
    if (!board.enabled) throw DISABLED;
    return board;
  }

  function cardOf(board: BoardV1, cardId: string): CardV1 {
    const card = board.cards.find((item) => item.id === cardId);
    if (card === undefined) throw NOT_FOUND;
    return card;
  }

  function teammateOf(workspaceId: string, teammateId: string): TeammateV1 | undefined {
    return team.teammates.get(workspaceId)?.find((item) => item.id === teammateId);
  }

  function assignable(workspaceId: string, teammate: TeammateV1 | undefined): teammate is TeammateV1 {
    if (teammate === undefined || !teammate.enabled) return false;
    const inputs = pipelineInputsOf(state, workspaceId, teammate.launchCommandId);
    return inputs !== undefined && 'inputName' in resolveCardInput(inputs, teammate.cardInput);
  }

  /** One board generation: bump revisions and tell every listener which cards changed. */
  function commit(board: BoardV1, cards: readonly CardV1[]): void {
    const at = now();
    for (const card of cards) {
      card.revision += 1;
      card.updatedAt = at;
    }
    board.revision += 1;
    board.updatedAt = at;
    bus.emit(BOARD_CHANGED_EVENT_V1, { protocol: 1, workspaceId: board.workspaceId, revision: board.revision, cardIds: cards.map((card) => card.id) });
  }

  function commitWhole(board: BoardV1): void {
    board.revision += 1;
    board.updatedAt = now();
    bus.emit(BOARD_CHANGED_EVENT_V1, { protocol: 1, workspaceId: board.workspaceId, revision: board.revision });
  }

  function activity(card: CardV1, actor: BoardActorV1, change: CardChangeV1, undoable = false): CardActivityV1 {
    const entry: CardActivityV1 = { id: state.ids.next('card-activity'), actor, at: now(), change, ...(undoable ? { undoable: true as const } : {}) };
    card.activity.push(entry);
    if (card.activity.length > MAX_ACTIVITY_PER_CARD) card.activity.splice(0, card.activity.length - MAX_ACTIVITY_PER_CARD);
    return entry;
  }

  function nextOrder(board: BoardV1, status: CardStatusV1): number {
    return board.cards.filter((card) => card.status === status).reduce((max, card) => Math.max(max, card.order), 0) + 1024;
  }

  function setStatus(board: BoardV1, card: CardV1, to: CardStatusV1, order?: number): void {
    card.status = to;
    card.order = order ?? nextOrder(board, to);
    if (CARD_STATUS_CATEGORY[to] === 'closed') card.closedAt = now();
    else delete card.closedAt;
  }

  function comment(card: CardV1, actor: BoardActorV1, body: string, extra: { mentions?: CommentMentionV1[]; runId?: string } = {}): void {
    if (card.comments.length >= MAX_COMMENTS_PER_CARD) throw LIMIT;
    const entry = { id: state.ids.next('card-comment'), actor, body, createdAt: now(), ...extra };
    card.comments.push(entry);
    activity(card, actor, { type: 'commented', commentId: entry.id });
  }

  // ---- runs ------------------------------------------------------------------

  function startRun(board: BoardV1, card: CardV1, cause: BoardRunCauseV1): CardV1[] {
    if (card.assignee === undefined) throw INVALID;
    if (card.claim !== undefined) throw CLAIMED;
    const teammate = teammateOf(board.workspaceId, card.assignee);
    if (!assignable(board.workspaceId, teammate)) throw NOT_ASSIGNABLE;
    const runId = state.ids.next('board-run');
    const claimedAt = now();
    card.claim = {
      actor: { kind: 'runMember', runId, memberId: labUuid(`board-run:${runId}:member`), profileId: teammate.kind.type === 'simple' ? teammate.kind.profileId : teammate.launchCommandId, teammateId: teammate.id },
      runId,
      claimedAt,
      expiresAt: new Date(runtime.clock.now() + CLAIM_LEASE_SECONDS * 1000).toISOString().replace('.000Z', 'Z'),
    };
    const from = card.status;
    if (from !== 'inProgress') {
      setStatus(board, card, 'inProgress');
      activity(card, HOST, { type: 'moved', from, to: 'inProgress', reason: `run started (${cause})` });
    }
    const link = { kind: 'run' as const, runId, teammateId: teammate.id, since: claimedAt };
    card.links.push(link);
    activity(card, HOST, { type: 'claimed' });
    activity(card, HOST, { type: 'runStarted', runId, teammateId: teammate.id });
    board.pendingStarts = board.pendingStarts.filter((item) => item.cardId !== card.id);
    team.liveRuns.set(runId, { workspaceId: board.workspaceId, cardId: card.id, teammateId: teammate.id });
    finishTimers.set(runId, runtime.clock.after(LAB_BOARD_RUN_MS, () => finishRun(board.workspaceId, runId, 'succeeded')));
    return [card];
  }

  function finishRun(workspaceId: string, runId: string, outcome: 'succeeded' | 'failed' | 'cancelled'): void {
    const live = team.liveRuns.get(runId);
    team.liveRuns.delete(runId);
    finishTimers.get(runId)?.();
    finishTimers.delete(runId);
    const board = store.boards.get(workspaceId);
    const card = live === undefined ? undefined : board?.cards.find((item) => item.id === live.cardId);
    if (board === undefined || card === undefined || card.claim?.runId !== runId) return;
    delete card.claim;
    activity(card, HOST, { type: 'runFinished', runId, outcome });
    activity(card, HOST, { type: 'released', reason: 'runEnded' });
    const actor: BoardActorV1 = { kind: 'runMember', runId, memberId: labUuid(`board-run:${runId}:member`), profileId: '', ...(live ? { teammateId: live.teammateId } : {}) };
    if (outcome === 'succeeded') {
      comment(card, actor, 'Done in the lab: the change is ready for review. (Simulated run result.)', { runId });
      const from = card.status;
      setStatus(board, card, 'inReview');
      activity(card, HOST, { type: 'moved', from, to: 'inReview', reason: 'run succeeded' });
    } else if (outcome === 'failed') {
      comment(card, actor, 'The simulated run failed.', { runId });
      const from = card.status;
      setStatus(board, card, 'blocked');
      activity(card, HOST, { type: 'moved', from, to: 'blocked', reason: 'run failed' });
    }
    commit(board, [card]);
  }

  /** Wake rule of the assignee (docs/BOARD.md "Wake rules"). */
  function wake(board: BoardV1, card: CardV1, cause: BoardRunCauseV1, start: CardStartModeV1, requestedBy: BoardActorV1): CardV1[] {
    if (card.assignee === undefined || card.status === 'backlog' || CARD_STATUS_CATEGORY[card.status] === 'closed') return [];
    if (card.claim !== undefined) return [];
    const teammate = teammateOf(board.workspaceId, card.assignee);
    if (!assignable(board.workspaceId, teammate)) return [];
    const rule = start === 'now' ? 'always' : start === 'later' ? 'never' : teammate.wake.onAssign;
    if (rule === 'never') return [];
    if (rule === 'always') return startRun(board, card, cause);
    if (!board.pendingStarts.some((item) => item.cardId === card.id)) {
      board.pendingStarts.push({ id: state.ids.next('pending-start'), cardId: card.id, teammateId: teammate.id, cause, requestedBy, createdAt: now() });
    }
    return [];
  }

  /** Blocked cards whose blockers are all closed move to todo and wake their assignee. */
  function unblock(board: BoardV1): CardV1[] {
    const touched: CardV1[] = [];
    for (const card of board.cards) {
      if (card.status !== 'blocked' || card.blockedBy.length === 0) continue;
      const open = card.blockedBy.some((id) => {
        const blocker = board.cards.find((item) => item.id === id);
        return blocker !== undefined && CARD_STATUS_CATEGORY[blocker.status] !== 'closed';
      });
      if (open) continue;
      setStatus(board, card, 'todo');
      activity(card, HOST, { type: 'unblocked' });
      touched.push(card);
      wake(board, card, 'unblocked', 'ask', HOST);
    }
    return touched;
  }

  // ---- edits -----------------------------------------------------------------

  function checkFields(board: BoardV1, card: CardV1 | undefined, patch: Partial<CardEditableFieldsV1>): void {
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length === 0 || [...title].length > MAX_CARD_TITLE_CHARS || CONTROL.test(title)) throw INVALID;
    }
    if (patch.description !== undefined && bytes(patch.description) > MAX_CARD_DESCRIPTION_BYTES) throw INVALID;
    if (patch.labels !== undefined && !validLabels(patch.labels)) throw INVALID;
    if (patch.blockedBy !== undefined) {
      if (patch.blockedBy.some((id) => id === card?.id || !board.cards.some((item) => item.id === id))) throw INVALID;
    }
    if (patch.parentId !== undefined && patch.parentId !== null) {
      const parentId = patch.parentId;
      if (parentId === card?.id || !board.cards.some((item) => item.id === parentId)) throw INVALID;
    }
  }

  function applyPatch(card: CardV1, patch: Partial<CardEditableFieldsV1>): { fields: string[]; previous: Partial<CardEditableFieldsV1> } {
    const changed: string[] = [];
    const previous: Partial<CardEditableFieldsV1> = {};
    if (patch.title !== undefined && patch.title.trim() !== card.title) {
      previous.title = card.title;
      card.title = patch.title.trim();
      changed.push('title');
    }
    if (patch.description !== undefined && patch.description !== card.description) {
      previous.description = card.description;
      card.description = patch.description;
      changed.push('description');
    }
    if (patch.priority !== undefined && patch.priority !== card.priority) {
      previous.priority = card.priority;
      card.priority = patch.priority;
      changed.push('priority');
    }
    if (patch.labels !== undefined) {
      const labels = normalizedLabels(patch.labels);
      if (JSON.stringify(labels) !== JSON.stringify(card.labels)) {
        previous.labels = card.labels;
        card.labels = labels;
        changed.push('labels');
      }
    }
    if (patch.blockedBy !== undefined) {
      const blockedBy = [...new Set(patch.blockedBy)];
      if (JSON.stringify(blockedBy) !== JSON.stringify(card.blockedBy)) {
        previous.blockedBy = card.blockedBy;
        card.blockedBy = blockedBy;
        changed.push('blockedBy');
      }
    }
    if (patch.parentId !== undefined && patch.parentId !== card.parentId) {
      previous.parentId = card.parentId;
      card.parentId = patch.parentId;
      changed.push('parentId');
    }
    return { fields: changed, previous };
  }

  function createCard(
    board: BoardV1,
    actor: BoardActorV1,
    input: Partial<CardEditableFieldsV1> & { title: string },
    status: CardStatusV1 = 'todo',
    sessionId?: string,
  ): CardV1 {
    if (board.cards.length >= MAX_CARDS) throw LIMIT;
    checkFields(board, undefined, input);
    const at = now();
    const card: CardV1 = {
      id: state.ids.next('card'),
      number: board.nextNumber,
      title: input.title.trim(),
      description: input.description ?? '',
      priority: input.priority ?? 'normal',
      labels: normalizedLabels(input.labels ?? []),
      blockedBy: [...new Set(input.blockedBy ?? [])],
      parentId: input.parentId ?? null,
      status,
      order: nextOrder(board, status),
      links: [],
      comments: [],
      activity: [],
      revision: 0,
      createdBy: actor,
      createdAt: at,
      updatedAt: at,
    };
    if (CARD_STATUS_CATEGORY[status] === 'closed') card.closedAt = at;
    board.nextNumber += 1;
    board.cards.push(card);
    activity(card, actor, { type: 'created' }, actor.kind !== 'person');
    if (sessionId !== undefined) {
      const session = sessionOf(board.workspaceId, sessionId);
      const link = { kind: 'session' as const, sessionId, harness: session.harness, since: at };
      card.links.push(link);
      activity(card, actor, { type: 'linked', link });
    }
    return card;
  }

  function sessionOf(workspaceId: string, sessionId: string): { harness: string } {
    const record = state.sessions.get(sessionId);
    if (record === undefined || record.workspaceId !== workspaceId) throw NOT_FOUND;
    return { harness: record.harness };
  }

  function move(board: BoardV1, card: CardV1, to: CardStatusV1, actor: BoardActorV1, order?: number, reason?: string): CardV1[] {
    const from = card.status;
    if (from === to) {
      if (order !== undefined) card.order = order;
      return [card];
    }
    setStatus(board, card, to, order);
    activity(card, actor, { type: 'moved', from, to, ...(reason ? { reason } : {}) }, true);
    const touched = [card];
    if (CARD_STATUS_CATEGORY[to] === 'closed') {
      board.pendingStarts = board.pendingStarts.filter((item) => item.cardId !== card.id);
      touched.push(...unblock(board));
    }
    if (to === 'todo' && actor.kind === 'person') wake(board, card, 'movedToTodo', 'ask', actor);
    return touched;
  }

  function assign(board: BoardV1, card: CardV1, teammateId: string | null, start: CardStartModeV1, actor: BoardActorV1): CardV1[] {
    if (teammateId !== null && !assignable(board.workspaceId, teammateOf(board.workspaceId, teammateId))) throw NOT_ASSIGNABLE;
    const from = card.assignee;
    const to = teammateId ?? undefined;
    if (from === to) return teammateId === null ? [card] : [card, ...wake(board, card, 'assigned', start, actor)];
    if (to === undefined) delete card.assignee;
    else card.assignee = to;
    board.pendingStarts = board.pendingStarts.filter((item) => item.cardId !== card.id);
    activity(card, actor, { type: 'assigned', ...(from ? { from } : {}), ...(to ? { to } : {}) }, true);
    return to === undefined ? [card] : [card, ...wake(board, card, 'assigned', start, actor)];
  }

  function applyOperation(board: BoardV1, operation: BoardOperationV1, actor: BoardActorV1): CardV1[] {
    switch (operation.op) {
      case 'create':
        return [createCard(board, actor, operation.card, operation.status)];
      case 'update': {
        const card = cardOf(board, operation.cardId);
        checkFields(board, card, operation.patch);
        const result = applyPatch(card, operation.patch);
        if (result.fields.length) activity(card, actor, { type: 'edited', ...result }, true);
        return [card];
      }
      case 'move':
        return move(board, cardOf(board, operation.cardId), operation.to, actor, undefined, operation.reason);
      case 'comment': {
        const card = cardOf(board, operation.cardId);
        comment(card, actor, operation.body);
        return [card];
      }
      case 'assign':
        return assign(board, cardOf(board, operation.cardId), operation.teammateId, 'ask', actor);
      default: {
        const exhaustive: never = operation;
        return exhaustive;
      }
    }
  }

  function undo(board: BoardV1, card: CardV1, activityId: string): CardV1[] {
    const entry = card.activity.find((item) => item.id === activityId);
    if (entry === undefined || entry.undoable !== true) throw INVALID;
    delete entry.undoable;
    const change = entry.change;
    const touched: CardV1[] = [card];
    switch (change.type) {
      case 'edited':
        applyPatch(card, change.previous);
        break;
      case 'moved':
        setStatus(board, card, change.from);
        break;
      case 'assigned':
        if (change.from === undefined) delete card.assignee;
        else card.assignee = change.from;
        board.pendingStarts = board.pendingStarts.filter((item) => item.cardId !== card.id);
        break;
      case 'linked':
        card.links = card.links.filter((link) => JSON.stringify(link) !== JSON.stringify(change.link));
        break;
      case 'created':
        board.cards = board.cards.filter((item) => item.id !== card.id);
        commitWhole(board);
        return [];
      default:
        throw INVALID;
    }
    activity(card, PERSON, { type: 'reverted', activityId });
    return touched;
  }

  function resolveProposal(board: BoardV1, proposalId: string, accept: boolean): CardV1[] {
    const proposal = board.proposals.find((item) => item.id === proposalId && item.status === 'pending');
    if (proposal === undefined) throw NOT_FOUND;
    const touched = accept ? applyOperation(board, proposal.operation, proposal.actor) : [];
    proposal.status = accept ? 'accepted' : 'rejected';
    return touched;
  }

  function deleteCard(board: BoardV1, cardId: string, expectedRevision: number): void {
    const card = cardOf(board, cardId);
    if (card.revision !== expectedRevision) throw CONFLICT;
    if (card.claim?.runId !== undefined) finishRun(board.workspaceId, card.claim.runId, 'cancelled');
    board.cards = board.cards.filter((item) => item.id !== cardId);
    for (const other of board.cards) {
      other.blockedBy = other.blockedBy.filter((id) => id !== cardId);
      if (other.parentId === cardId) other.parentId = null;
    }
    board.proposals = board.proposals.filter((item) => item.cardId !== cardId);
    board.pendingStarts = board.pendingStarts.filter((item) => item.cardId !== cardId);
  }

  function validMentions(workspaceId: string, body: string, mentions: readonly CommentMentionV1[]): boolean {
    return mentions.every((mention) => {
      const teammate = teammateOf(workspaceId, mention.teammateId);
      return teammate !== undefined && body.slice(mention.start, mention.start + mention.length) === `@${teammate.handle}`;
    });
  }

  // ---- dispatch --------------------------------------------------------------

  const boardResult = (board: BoardV1): BoardResultV1 => ({ protocol: 1, type: 'board', board: copy(board) });
  const cardResult = (board: BoardV1, card: CardV1): BoardResultV1 => ({ protocol: 1, type: 'card', card: copy(card), boardRevision: board.revision });

  function dispatch(command: BoardCommandV1): BoardResultV1 {
    if (state.safeMode && command.type !== 'get' && command.type !== 'sessionCards') throw SAFE_MODE;
    switch (command.type) {
      case 'get':
        return boardResult(boardOf(command.workspaceId));
      case 'setEnabled': {
        const board = boardOf(command.workspaceId);
        if (board.enabled !== command.enabled) {
          board.enabled = command.enabled;
          commitWhole(board);
        }
        return boardResult(board);
      }
      case 'updateSettings': {
        const board = boardOf(command.workspaceId);
        if (board.revision !== command.expectedRevision) throw CONFLICT;
        const settings: BoardSettingsV1 = command.settings;
        if (settings.maxConcurrentRuns < 1 || settings.maxConcurrentRuns > 16) throw INVALID;
        board.settings = copy(settings);
        commitWhole(board);
        return boardResult(board);
      }
      case 'createCard': {
        const board = enabledBoard(command.workspaceId);
        const card = createCard(board, PERSON, command.card, command.status ?? undefined, command.sessionId ?? undefined);
        commit(board, [card]);
        return cardResult(board, card);
      }
      case 'updateCard': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        if (card.revision !== command.expectedRevision) throw CONFLICT;
        checkFields(board, card, command.patch);
        const result = applyPatch(card, command.patch);
        if (result.fields.length) activity(card, PERSON, { type: 'edited', ...result }, true);
        commit(board, [card]);
        return cardResult(board, card);
      }
      case 'moveCard': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        const touched = move(board, card, command.to, PERSON, command.order ?? undefined);
        commit(board, touched);
        return cardResult(board, card);
      }
      case 'deleteCard': {
        const board = enabledBoard(command.workspaceId);
        deleteCard(board, command.cardId, command.expectedRevision);
        commitWhole(board);
        return { protocol: 1, type: 'deleted', cardId: command.cardId, boardRevision: board.revision };
      }
      case 'comment': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        const body = command.body;
        const mentions = command.mentions ?? [];
        if (body.trim().length === 0 || bytes(body) > MAX_COMMENT_BYTES || !validMentions(board.workspaceId, body, mentions)) throw INVALID;
        comment(card, PERSON, body, mentions.length ? { mentions: copy(mentions) } : {});
        const touched = [card];
        for (const mention of mentions) {
          const teammate = teammateOf(board.workspaceId, mention.teammateId);
          if (teammate?.wake.onMention && card.assignee === teammate.id && card.claim === undefined) {
            touched.push(...wake(board, card, 'mention', 'ask', PERSON));
          }
        }
        commit(board, [...new Set(touched)]);
        return cardResult(board, card);
      }
      case 'assign': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        const touched = assign(board, card, command.teammateId ?? null, command.start, PERSON);
        commit(board, [...new Set(touched)]);
        return cardResult(board, card);
      }
      case 'startRun': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        commit(board, startRun(board, card, 'manual'));
        return cardResult(board, card);
      }
      case 'resolvePendingStart': {
        const board = enabledBoard(command.workspaceId);
        const pending = board.pendingStarts.find((item) => item.id === command.pendingStartId);
        if (pending === undefined) throw NOT_FOUND;
        const card = cardOf(board, pending.cardId);
        board.pendingStarts = board.pendingStarts.filter((item) => item.id !== pending.id);
        const touched = command.accept ? startRun(board, card, pending.cause) : [card];
        commit(board, touched);
        return cardResult(board, card);
      }
      case 'releaseClaim': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        if (card.claim === undefined) return cardResult(board, card);
        const runId = card.claim.runId;
        if (runId !== undefined && team.liveRuns.has(runId)) {
          finishRun(board.workspaceId, runId, 'cancelled');
          return cardResult(board, card);
        }
        delete card.claim;
        activity(card, PERSON, { type: 'released', reason: 'released' });
        commit(board, [card]);
        return cardResult(board, card);
      }
      case 'linkSession': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        const session = sessionOf(board.workspaceId, command.sessionId);
        card.links = card.links.filter((link) => !(link.kind === 'session' && link.sessionId === command.sessionId));
        const link = { kind: 'session' as const, sessionId: command.sessionId, harness: session.harness, since: now() };
        card.links.push(link);
        activity(card, PERSON, { type: 'linked', link });
        commit(board, [card]);
        return cardResult(board, card);
      }
      case 'unlinkSession': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        const link = card.links.find((item) => item.kind === 'session' && item.sessionId === command.sessionId);
        if (link === undefined) throw NOT_FOUND;
        card.links = card.links.filter((item) => item !== link);
        activity(card, PERSON, { type: 'unlinked', link });
        commit(board, [card]);
        return cardResult(board, card);
      }
      case 'sessionCards': {
        const board = boardOf(command.workspaceId);
        const since = (card: CardV1): string =>
          card.links.find((link) => link.kind === 'session' && link.sessionId === command.sessionId)?.since ?? '';
        const cards = board.cards
          .filter((card) => card.links.some((link) => link.kind === 'session' && link.sessionId === command.sessionId))
          .sort((left, right) => {
            const leftOpen = CARD_STATUS_CATEGORY[left.status] !== 'closed';
            const rightOpen = CARD_STATUS_CATEGORY[right.status] !== 'closed';
            if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
            return since(right).localeCompare(since(left));
          });
        return { protocol: 1, type: 'sessionCards', cards: copy(cards) };
      }
      case 'undo': {
        const board = enabledBoard(command.workspaceId);
        const card = cardOf(board, command.cardId);
        const touched = undo(board, card, command.activityId);
        if (touched.length === 0) return { protocol: 1, type: 'deleted', cardId: card.id, boardRevision: board.revision };
        commit(board, touched);
        return cardResult(board, card);
      }
      case 'resolveProposal': {
        const board = enabledBoard(command.workspaceId);
        const touched = resolveProposal(board, command.proposalId, command.accept);
        if (touched.length) commit(board, [...new Set(touched)]);
        else commitWhole(board);
        return boardResult(board);
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  return {
    board_command_v1: (args) => dispatch(decodeArgument<BoardCommandV1>(args, 'command', commandSchema)),
  };
}

// ---- seed ------------------------------------------------------------------

interface SeedCard {
  key: string;
  title: string;
  status: CardStatusV1;
  priority?: CardV1['priority'];
  labels?: string[];
  description?: string;
  assignee?: 'coder' | 'release-team';
}

const SEED_CARDS: readonly SeedCard[] = [
  { key: 'transport', title: 'Route every host call through transport.ts', status: 'inProgress', priority: 'high', labels: ['host-api'], assignee: 'coder',
    description: 'No component may import Tauri directly. Cover the cancellation path with a test.' },
  { key: 'shortcuts', title: 'Document pipeline editor shortcuts', status: 'todo', labels: ['docs'], assignee: 'coder' },
  { key: 'release-note', title: 'Write the 0.2.6 release note', status: 'todo', priority: 'normal', labels: ['release'], assignee: 'release-team' },
  { key: 'crash', title: 'Fix crash on startup with a missing project folder', status: 'blocked', priority: 'urgent', labels: ['bug'] },
  { key: 'repro', title: 'Reproduce the startup crash on Windows', status: 'inReview', priority: 'urgent', labels: ['bug', 'windows'] },
  { key: 'compaction', title: 'Explain session compaction in the docs', status: 'backlog', priority: 'low', labels: ['docs'] },
  { key: 'dark-mode', title: 'Check dropdown contrast in the light theme', status: 'backlog', labels: ['ui'] },
  { key: 'keymap', title: 'Map the pipeline editor keymap', status: 'done', labels: ['ui'] },
  { key: 'flaky', title: 'Quarantine the flaky scheduler test', status: 'cancelled', priority: 'low', labels: ['tests'] },
  { key: 'perf', title: 'Measure long-session scroll performance', status: 'todo', priority: 'high', labels: ['perf'] },
];

/**
 * An enabled board for the first project: ten cards in every status, one agent
 * proposal, one pending start and an undoable agent edit.
 */
export function seedLabBoard(runtime: LabSessions, team: LabTeam, store: LabBoards, workspaceId: string, links: { sessionId?: string; runId?: string } = {}): void {
  const { state } = runtime;
  const base = runtime.clock.now();
  const at = (minutesAgo: number): string => new Date(base - minutesAgo * MINUTE).toISOString().replace('.000Z', 'Z');
  const teammates = team.teammates.get(workspaceId) ?? [];
  const handleId = (handle: string): string | undefined => teammates.find((item) => item.handle === handle)?.id;
  const id = (key: string): string => labUuid(`board:${workspaceId}:card:${key}`);
  const board = emptyBoard(workspaceId, at(0));
  board.enabled = true;
  // The linked lab chat's agent made the undoable edit and the pending proposal,
  // so that chat shows its active card, the proposal and "Board updates".
  const agentSession = links.sessionId === undefined ? undefined : state.sessions.get(links.sessionId);
  const agent: BoardActorV1 = { kind: 'chatAgent', sessionId: links.sessionId ?? labUuid('lab:chat'), harness: agentSession?.harness ?? 'codex' };
  SEED_CARDS.forEach((seed, index) => {
    const created = at(600 - index * 40);
    const assignee = seed.assignee ? handleId(seed.assignee) : undefined;
    const card: CardV1 = {
      id: id(seed.key),
      number: index + 1,
      title: seed.title,
      description: seed.description ?? '',
      priority: seed.priority ?? 'normal',
      labels: seed.labels ?? [],
      blockedBy: [],
      parentId: null,
      status: seed.status,
      order: (index + 1) * 1024,
      ...(assignee ? { assignee } : {}),
      links: [],
      comments: [],
      activity: [{ id: labUuid(`${id(seed.key)}:created`), actor: PERSON, at: created, change: { type: 'created' } }],
      revision: 1,
      createdBy: PERSON,
      createdAt: created,
      updatedAt: created,
      ...(CARD_STATUS_CATEGORY[seed.status] === 'closed' ? { closedAt: at(30) } : {}),
    };
    board.cards.push(card);
  });
  board.nextNumber = SEED_CARDS.length + 1;
  const card = (key: string): CardV1 => {
    const found = board.cards.find((item) => item.id === id(key));
    if (found === undefined) throw new Error(`missing seed card ${key}`);
    return found;
  };
  // Blockers and a parent.
  card('crash').blockedBy = [id('repro')];
  card('repro').parentId = id('crash');
  // A chat linked the transport card and an agent edited it (undoable).
  const transport = card('transport');
  if (links.sessionId !== undefined) {
    const link = { kind: 'session' as const, sessionId: links.sessionId, harness: agentSession?.harness ?? 'codex', since: at(90) };
    transport.links.push(link);
    transport.activity.push({ id: labUuid(`${transport.id}:linked`), actor: agent, at: at(90), change: { type: 'linked', link } });
  }
  transport.activity.push({
    id: labUuid(`${transport.id}:edited`),
    actor: agent,
    at: at(80),
    change: { type: 'edited', fields: ['description'], previous: { description: 'No component may import Tauri directly.' } },
    undoable: true,
  });
  transport.comments.push({ id: labUuid(`${transport.id}:comment`), actor: agent, body: 'Found two listeners that bypass the transport; fixing them next.', createdAt: at(75) });
  transport.activity.push({ id: labUuid(`${transport.id}:commented`), actor: agent, at: at(75), change: { type: 'commented', commentId: labUuid(`${transport.id}:comment`) } });
  if (links.runId !== undefined) {
    const coder = handleId('coder');
    transport.links.push({ kind: 'run', runId: links.runId, ...(coder ? { teammateId: coder } : {}), since: at(60) });
  }
  // The person asked @coder in a comment.
  const shortcuts = card('shortcuts');
  const coderId = handleId('coder');
  if (coderId !== undefined) {
    const body = '@coder please pick this up after the transport card.';
    shortcuts.comments.push({ id: labUuid(`${shortcuts.id}:comment`), actor: PERSON, body, mentions: [{ teammateId: coderId, start: 0, length: 6 }], createdAt: at(40) });
    shortcuts.activity.push({ id: labUuid(`${shortcuts.id}:commented`), actor: PERSON, at: at(40), change: { type: 'commented', commentId: labUuid(`${shortcuts.id}:comment`) } });
    shortcuts.activity.push({ id: labUuid(`${shortcuts.id}:assigned`), actor: PERSON, at: at(41), change: { type: 'assigned', to: coderId }, undoable: true });
    // Pending start: @coder asks before starting.
    board.pendingStarts.push({ id: labUuid(`${workspaceId}:pending:shortcuts`), cardId: shortcuts.id, teammateId: coderId, cause: 'assigned', requestedBy: PERSON, createdAt: at(41) });
  }
  // An agent proposes closing the reviewed repro card.
  board.proposals.push({
    id: labUuid(`${workspaceId}:proposal:repro`),
    cardId: id('repro'),
    operation: { op: 'move', cardId: id('repro'), to: 'done', reason: 'Reproduced and documented; the fix is tracked in #4.' },
    actor: agent,
    createdAt: at(20),
    status: 'pending',
  });
  board.revision = 1;
  board.updatedAt = at(20);
  store.boards.set(workspaceId, board);
}
