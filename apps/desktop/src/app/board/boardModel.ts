/**
 * Pure board presentation helpers (ADR-041, docs/BOARD.md "UI"): columns,
 * filtering, ordering and actor/status copy. Kept free of Svelte so they are
 * unit-tested directly and shared by the board, drawer, inbox and team views.
 */
import {
  CARD_STATUS_CATEGORY,
  CARD_STATUSES,
  type BoardActorV1,
  type BoardOperationV1,
  type BoardPermissionsV1,
  type BoardV1,
  type CardActivityV1,
  type CardChangeV1,
  type CardCommentV1,
  type CardPriorityV1,
  type CardStatusV1,
  type CardV1,
} from '../../host-api/boardClient';
import type { TeammateV1 } from '../../host-api/teammatesClient';

/** English source labels; the views pass them through `$t`. */
export const STATUS_LABEL: Readonly<Record<CardStatusV1, string>> = {
  backlog: 'Backlog',
  todo: 'To do',
  inProgress: 'In progress',
  inReview: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABEL: Readonly<Record<CardPriorityV1, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

/** Board permission rows (settings popover and teammate rules). */
export const PERMISSION_COPY: readonly { key: keyof BoardPermissionsV1; label: string; description: string }[] = [
  { key: 'read', label: 'Read cards', description: 'See the board and search cards.' },
  { key: 'comment', label: 'Comment', description: 'Leave progress notes on cards.' },
  { key: 'create', label: 'Create cards', description: 'Track a distinct deliverable.' },
  { key: 'move', label: 'Move cards', description: 'Closing a card always waits for you.' },
  { key: 'claim', label: 'Claim cards', description: 'Mark a card as taken.' },
  { key: 'assign', label: 'Hand off to teammates', description: 'Assign cards to @teammates.' },
];

export const PRIORITIES: readonly CardPriorityV1[] = ['urgent', 'high', 'normal', 'low'];
const PRIORITY_RANK: Readonly<Record<CardPriorityV1, number>> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Columns that start collapsed; the person can expand them. */
export const COLLAPSIBLE: ReadonlySet<CardStatusV1> = new Set<CardStatusV1>(['done', 'cancelled']);

export const isClosed = (status: CardStatusV1): boolean => CARD_STATUS_CATEGORY[status] === 'closed';

export interface BoardFilter {
  text: string;
  /** Teammate id, `unassigned`, or '' for everyone. */
  teammate: string;
}

export const EMPTY_FILTER: BoardFilter = { text: '', teammate: '' };

export function matchesFilter(card: CardV1, filter: BoardFilter): boolean {
  if (filter.teammate === 'unassigned' ? card.assignee !== undefined : filter.teammate !== '' && card.assignee !== filter.teammate) return false;
  const query = filter.text.trim().toLowerCase();
  if (!query) return true;
  const number = query.startsWith('#') ? query.slice(1) : undefined;
  if (number !== undefined && number !== '' && String(card.number).startsWith(number)) return true;
  return card.title.toLowerCase().includes(query)
    || card.labels.some((label) => label.includes(query))
    || card.description.toLowerCase().includes(query);
}

export interface BoardColumn {
  status: CardStatusV1;
  cards: CardV1[];
  /** Total in the status before filtering. */
  total: number;
}

export function columnsOf(board: BoardV1 | undefined, filter: BoardFilter = EMPTY_FILTER): BoardColumn[] {
  return CARD_STATUSES.map((status) => {
    const all = (board?.cards ?? []).filter((card) => card.status === status);
    const cards = all
      .filter((card) => matchesFilter(card, filter))
      .sort((left, right) => left.order - right.order || left.number - right.number);
    return { status, cards, total: all.length };
  });
}

/**
 * The `order` that places a card at `index` of a column (cards sorted by
 * order, the moving card excluded). Absent appends, as the host does.
 */
export function orderAt(column: readonly CardV1[], index: number, movingId: string): number | undefined {
  const others = column.filter((card) => card.id !== movingId);
  if (index >= others.length) return undefined;
  const next = others[index];
  const previous = index > 0 ? others[index - 1] : undefined;
  if (next === undefined) return undefined;
  if (previous === undefined) return Math.max(0, Math.floor(next.order / 2));
  const middle = Math.floor((previous.order + next.order) / 2);
  return middle > previous.order ? middle : undefined;
}

/** A copy of the board with one card moved; used for optimistic updates. */
export function withMovedCard(board: BoardV1, cardId: string, to: CardStatusV1, order: number | undefined): BoardV1 {
  const maxOrder = board.cards.filter((card) => card.status === to && card.id !== cardId).reduce((max, card) => Math.max(max, card.order), 0);
  return {
    ...board,
    cards: board.cards.map((card) => (card.id === cardId ? { ...card, status: to, order: order ?? maxOrder + 1024 } : card)),
  };
}

export function byPriority(left: CardV1, right: CardV1): number {
  return PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] || left.number - right.number;
}

export function cardByNumber(board: BoardV1 | undefined, number: number): CardV1 | undefined {
  return board?.cards.find((card) => card.number === number);
}

export function linkCount(card: CardV1): number {
  return card.links.length;
}

export function hasLiveRun(card: CardV1): boolean {
  return card.claim?.runId !== undefined;
}

// ---- actors ------------------------------------------------------------------

export type ActorView =
  | { kind: 'person' }
  | { kind: 'chatAgent'; sessionId: string; harness: string }
  | { kind: 'teammate'; teammate: TeammateV1 }
  | { kind: 'runMember'; runId: string }
  | { kind: 'host' };

export function actorView(actor: BoardActorV1, teammates: readonly TeammateV1[]): ActorView {
  switch (actor.kind) {
    case 'person':
      return { kind: 'person' };
    case 'chatAgent':
      return { kind: 'chatAgent', sessionId: actor.sessionId, harness: actor.harness };
    case 'runMember': {
      const teammate = actor.teammateId === undefined ? undefined : teammates.find((item) => item.id === actor.teammateId);
      return teammate ? { kind: 'teammate', teammate } : { kind: 'runMember', runId: actor.runId };
    }
    case 'host':
      return { kind: 'host' };
    default: {
      const exhaustive: never = actor;
      return exhaustive;
    }
  }
}

// ---- timeline ----------------------------------------------------------------

export type TimelineEntry =
  | { kind: 'comment'; at: string; comment: CardCommentV1 }
  | { kind: 'activity'; at: string; activity: CardActivityV1 };

/** Comments and activity in time order; `commented` activity is folded into its comment. */
export function timelineOf(card: CardV1): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...card.comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment })),
    ...card.activity
      .filter((activity) => activity.change.type !== 'commented')
      .map((activity) => ({ kind: 'activity' as const, at: activity.at, activity })),
  ];
  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

/** English template and parameters for one activity entry. */
export function changeCopy(
  change: CardChangeV1,
  handleOf: (teammateId: string | undefined) => string,
): { text: string; params: readonly (string | number)[] } {
  switch (change.type) {
    case 'created':
      return { text: 'created the card', params: [] };
    case 'edited':
      return { text: 'edited {0}', params: [change.fields.join(', ')] };
    case 'moved':
      return change.reason
        ? { text: 'moved it from {0} to {1}: {2}', params: [STATUS_LABEL[change.from], STATUS_LABEL[change.to], change.reason] }
        : { text: 'moved it from {0} to {1}', params: [STATUS_LABEL[change.from], STATUS_LABEL[change.to]] };
    case 'assigned':
      return change.to === undefined
        ? { text: 'unassigned {0}', params: [handleOf(change.from)] }
        : { text: 'assigned {0}', params: [handleOf(change.to)] };
    case 'claimed':
      return { text: 'claimed the card', params: [] };
    case 'released':
      return { text: 'released the claim', params: [] };
    case 'linked':
      return { text: change.link.kind === 'run' ? 'linked a run' : 'linked a chat', params: [] };
    case 'unlinked':
      return { text: change.link.kind === 'run' ? 'unlinked a run' : 'unlinked a chat', params: [] };
    case 'commented':
      return { text: 'commented', params: [] };
    case 'runStarted':
      return { text: 'started a run of {0}', params: [handleOf(change.teammateId)] };
    case 'runFinished':
      return {
        text: change.outcome === 'succeeded' ? 'run succeeded' : change.outcome === 'failed' ? 'run failed' : 'run was cancelled',
        params: [],
      };
    case 'queued':
      return { text: 'waiting for a free slot for {0}', params: [handleOf(change.teammateId)] };
    case 'unblocked':
      return { text: 'unblocked: every blocker is closed', params: [] };
    case 'reverted':
      return { text: 'undid a change', params: [] };
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

/** English template and parameters describing a proposal's operation. */
export function operationCopy(operation: BoardOperationV1, board: BoardV1 | undefined, handleOf: (teammateId: string | undefined) => string): { text: string; params: readonly (string | number)[] } {
  const number = (cardId: string): string => {
    const card = board?.cards.find((item) => item.id === cardId);
    return card ? `#${card.number}` : '#?';
  };
  switch (operation.op) {
    case 'create':
      return { text: 'Create card “{0}”', params: [operation.card.title] };
    case 'update':
      return { text: 'Edit {0}: {1}', params: [number(operation.cardId), Object.keys(operation.patch).join(', ')] };
    case 'move':
      return { text: 'Move {0} to {1}', params: [number(operation.cardId), STATUS_LABEL[operation.to]] };
    case 'comment':
      return { text: 'Comment on {0}', params: [number(operation.cardId)] };
    case 'assign':
      return operation.teammateId === null
        ? { text: 'Unassign {0}', params: [number(operation.cardId)] }
        : { text: 'Assign {0} to {1}', params: [number(operation.cardId), handleOf(operation.teammateId)] };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/** English labels of activity/proposal templates, for the locale test. */
export const TIMELINE_COPY: readonly string[] = [
  'created the card',
  'edited {0}',
  'moved it from {0} to {1}: {2}',
  'moved it from {0} to {1}',
  'unassigned {0}',
  'assigned {0}',
  'claimed the card',
  'released the claim',
  'linked a run',
  'linked a chat',
  'unlinked a run',
  'unlinked a chat',
  'commented',
  'started a run of {0}',
  'run succeeded',
  'run failed',
  'run was cancelled',
  'waiting for a free slot for {0}',
  'unblocked: every blocker is closed',
  'undid a change',
  'Create card “{0}”',
  'Edit {0}: {1}',
  'Move {0} to {1}',
  'Comment on {0}',
  'Unassign {0}',
  'Assign {0} to {1}',
];
