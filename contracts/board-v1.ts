/**
 * PiUI project board protocol v1 (`board_command_v1`, ADR-041, docs/BOARD.md).
 * Independently versioned; workspace v15, orchestration v6 and the system file
 * format are unchanged by it.
 *
 * - A board belongs to one project (`workspaceId`). It is authoritative,
 *   user-authored data stored by the host as create-only generation files
 *   under `boards-v1/`; it is never written into the project folder.
 * - Cards are durable intent. Runs stay orchestration runs; a card only links
 *   them. Card comments are board data, never chat transcript.
 * - The person acts through `board_command_v1` (actor `person`). Agents act
 *   only through the host `board` tool (`BoardToolOperationV1`); the host
 *   derives the agent actor from the session binding, never from arguments.
 * - A disabled board keeps its cards; agents do not get the `board` tool.
 *
 * `get` works in safe mode; every change is refused there (`SAFE_MODE`).
 */
import type { TeammateIdV1 } from './teammates-v1';

export const BOARD_PROTOCOL = 1 as const;
export const BOARD_CHANGED_EVENT_V1 = 'piui://board-changed-v1' as const;

/** Most cards kept in the live board document (all statuses). */
export const MAX_CARDS = 2000;
export const MAX_COMMENTS_PER_CARD = 500;
export const MAX_CARD_TITLE_CHARS = 200;
export const MAX_CARD_DESCRIPTION_BYTES = 64 * 1024;
export const MAX_COMMENT_BYTES = 16 * 1024;
export const MAX_LABELS_PER_CARD = 12;
/** Most activity entries kept per card; the oldest are dropped first. */
export const MAX_ACTIVITY_PER_CARD = 300;
/** Board writes one agent turn may make before `RATE_LIMITED`. */
export const MAX_AGENT_WRITES_PER_TURN = 8;
/** Claim lease; renewed by the holder's activity, held by a run until it ends. */
export const CLAIM_LEASE_SECONDS = 30 * 60;

export type CardStatusV1 =
  | 'backlog'
  | 'todo'
  | 'inProgress'
  | 'inReview'
  | 'blocked'
  | 'done'
  | 'cancelled';

/** The category decides automation: `unstarted` backlog never starts a run. */
export type CardStatusCategoryV1 = 'unstarted' | 'active' | 'blocked' | 'closed';

export const CARD_STATUS_CATEGORY: Readonly<Record<CardStatusV1, CardStatusCategoryV1>> = {
  backlog: 'unstarted',
  todo: 'unstarted',
  inProgress: 'active',
  inReview: 'active',
  blocked: 'blocked',
  done: 'closed',
  cancelled: 'closed',
};

export const CARD_STATUSES: readonly CardStatusV1[] = [
  'backlog',
  'todo',
  'inProgress',
  'inReview',
  'blocked',
  'done',
  'cancelled',
];

export type CardPriorityV1 = 'urgent' | 'high' | 'normal' | 'low';

/** What an agent may do on a board. Closing (done/cancelled) is person-only in v1. */
export interface BoardPermissionsV1 {
  read: boolean;
  comment: boolean;
  create: boolean;
  move: boolean;
  claim: boolean;
  /** Assign cards to teammates (create+assign for `handoff`). */
  assign: boolean;
}

/**
 * `auto`: agent writes apply at once and can be undone by the person.
 * `proposal`: agent writes wait in the Inbox for Accept/Reject.
 * Closing a card is always a proposal regardless of mode.
 */
export type BoardAgentModeV1 = 'auto' | 'proposal';

export interface BoardSettingsV1 {
  agentMode: BoardAgentModeV1;
  /** Permissions of agents in ordinary chats of this project. */
  chatAgentPermissions: BoardPermissionsV1;
  /** Safety ceiling across all teammates of the board (1-16). */
  maxConcurrentRuns: number;
}

export const DEFAULT_BOARD_SETTINGS: BoardSettingsV1 = {
  agentMode: 'auto',
  chatAgentPermissions: {
    read: true,
    comment: true,
    create: true,
    move: true,
    claim: false,
    assign: true,
  },
  maxConcurrentRuns: 4,
};

export type BoardActorV1 =
  | { kind: 'person' }
  | { kind: 'chatAgent'; sessionId: string; harness: string }
  | { kind: 'runMember'; runId: string; memberId: string; profileId: string; teammateId?: TeammateIdV1 }
  | { kind: 'host' };

export interface CardClaimV1 {
  actor: BoardActorV1;
  runId?: string;
  claimedAt: string;
  expiresAt: string;
}

export type CardLinkV1 =
  | { kind: 'session'; sessionId: string; harness: string; since: string }
  | { kind: 'run'; runId: string; teammateId?: TeammateIdV1; since: string };

/** A `@handle` span inside a comment, stored by id so renames keep history. */
export interface CommentMentionV1 {
  teammateId: TeammateIdV1;
  /** UTF-16 offset/length of the `@handle` text in `body`. */
  start: number;
  length: number;
}

export interface CardCommentV1 {
  id: string;
  actor: BoardActorV1;
  body: string;
  mentions?: CommentMentionV1[];
  createdAt: string;
  runId?: string;
}

export type CardChangeV1 =
  | { type: 'created' }
  | { type: 'edited'; fields: string[]; previous: Partial<CardEditableFieldsV1> }
  | { type: 'moved'; from: CardStatusV1; to: CardStatusV1; reason?: string }
  | { type: 'assigned'; from?: TeammateIdV1; to?: TeammateIdV1 }
  | { type: 'claimed' }
  | { type: 'released'; reason: 'done' | 'expired' | 'released' | 'runEnded' }
  | { type: 'linked'; link: CardLinkV1 }
  | { type: 'unlinked'; link: CardLinkV1 }
  | { type: 'commented'; commentId: string }
  | { type: 'runStarted'; runId: string; teammateId: TeammateIdV1 }
  | { type: 'runFinished'; runId: string; outcome: 'succeeded' | 'failed' | 'cancelled' }
  | { type: 'unblocked' }
  | { type: 'reverted'; activityId: string };

export interface CardActivityV1 {
  id: string;
  actor: BoardActorV1;
  at: string;
  change: CardChangeV1;
  /** Set when the person can undo this change (auto-mode agent writes, moves, assigns). */
  undoable?: true;
}

export interface CardEditableFieldsV1 {
  title: string;
  description: string;
  priority: CardPriorityV1;
  labels: string[];
  blockedBy: string[];
  parentId: string | null;
}

export interface CardV1 extends CardEditableFieldsV1 {
  id: string;
  /** Per-board human number shown as `#42`; never reused. */
  number: number;
  status: CardStatusV1;
  /** Sort key inside a column (ascending). */
  order: number;
  assignee?: TeammateIdV1;
  claim?: CardClaimV1;
  links: CardLinkV1[];
  comments: CardCommentV1[];
  activity: CardActivityV1[];
  revision: number;
  createdBy: BoardActorV1;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type BoardOperationV1 =
  | { op: 'create'; card: Partial<CardEditableFieldsV1> & { title: string }; status?: CardStatusV1 }
  | { op: 'update'; cardId: string; patch: Partial<CardEditableFieldsV1> }
  | { op: 'move'; cardId: string; to: CardStatusV1; reason?: string }
  | { op: 'comment'; cardId: string; body: string }
  | { op: 'assign'; cardId: string; teammateId: TeammateIdV1 | null };

export interface BoardProposalV1 {
  id: string;
  cardId?: string;
  operation: BoardOperationV1;
  actor: BoardActorV1;
  createdAt: string;
  status: 'pending' | 'accepted' | 'rejected';
}

/** Start of a run that waits for the person (teammate `onAssign: 'ask'`). */
export interface PendingStartV1 {
  id: string;
  cardId: string;
  teammateId: TeammateIdV1;
  cause: BoardRunCauseV1;
  requestedBy: BoardActorV1;
  createdAt: string;
}

export type BoardRunCauseV1 = 'assigned' | 'movedToTodo' | 'unblocked' | 'mention' | 'manual';

export interface BoardV1 {
  workspaceId: string;
  enabled: boolean;
  settings: BoardSettingsV1;
  cards: CardV1[];
  proposals: BoardProposalV1[];
  pendingStarts: PendingStartV1[];
  nextNumber: number;
  revision: number;
  updatedAt: string;
}

export type CardStartModeV1 = 'ask' | 'now' | 'later';

export type BoardCommandV1 =
  /** Returns a disabled empty board when none was saved yet. */
  | { type: 'get'; workspaceId: string }
  | { type: 'setEnabled'; workspaceId: string; enabled: boolean }
  | { type: 'updateSettings'; workspaceId: string; expectedRevision: number; settings: BoardSettingsV1 }
  | {
      type: 'createCard';
      workspaceId: string;
      card: Partial<CardEditableFieldsV1> & { title: string };
      status?: CardStatusV1;
      /** Optional chat to link the new card to. */
      sessionId?: string;
    }
  | { type: 'updateCard'; workspaceId: string; cardId: string; expectedRevision: number; patch: Partial<CardEditableFieldsV1> }
  /** `order` places the card inside the target column; absent appends. */
  | { type: 'moveCard'; workspaceId: string; cardId: string; to: CardStatusV1; order?: number }
  | { type: 'deleteCard'; workspaceId: string; cardId: string; expectedRevision: number }
  | { type: 'comment'; workspaceId: string; cardId: string; body: string; mentions?: CommentMentionV1[] }
  /** `start`: `ask` follows the teammate's rule, `now` starts, `later` only assigns. */
  | { type: 'assign'; workspaceId: string; cardId: string; teammateId: TeammateIdV1 | null; start: CardStartModeV1 }
  | { type: 'startRun'; workspaceId: string; cardId: string }
  | { type: 'resolvePendingStart'; workspaceId: string; pendingStartId: string; accept: boolean }
  | { type: 'releaseClaim'; workspaceId: string; cardId: string }
  | { type: 'linkSession'; workspaceId: string; cardId: string; sessionId: string }
  | { type: 'unlinkSession'; workspaceId: string; cardId: string; sessionId: string }
  /** Cards linked to a chat, most recent open link first (the active card). */
  | { type: 'sessionCards'; workspaceId: string; sessionId: string }
  | { type: 'undo'; workspaceId: string; cardId: string; activityId: string }
  | { type: 'resolveProposal'; workspaceId: string; proposalId: string; accept: boolean };

export type BoardResultV1 =
  | { protocol: 1; type: 'board'; board: BoardV1 }
  | { protocol: 1; type: 'card'; card: CardV1; boardRevision: number }
  | { protocol: 1; type: 'sessionCards'; cards: CardV1[] }
  | { protocol: 1; type: 'deleted'; cardId: string; boardRevision: number };

export interface BoardChangedEventV1 {
  protocol: 1;
  workspaceId: string;
  revision: number;
  /** Cards touched by the change; absent means reload the whole board. */
  cardIds?: string[];
}

export type BoardErrorCodeV1 =
  | 'SAFE_MODE'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'DISABLED'
  | 'REVISION_CONFLICT'
  | 'ALREADY_CLAIMED'
  | 'FORBIDDEN'
  | 'LIMIT'
  | 'RATE_LIMITED'
  | 'NOT_ASSIGNABLE'
  | 'IO_ERROR';

export interface BoardErrorV1 {
  code: BoardErrorCodeV1;
  message: string;
  recoverable: boolean;
}

/* ------------------------------------------------------------------------ *
 * Agent tool `board` (host tool, bridge CONTRACT.md "hostTools").
 * Arguments are validated with exact key sets (unknown keys are rejected).
 * Every result is plain JSON text for the agent; errors carry `code` and a
 * one-line instruction ("do not retry" for ALREADY_CLAIMED/FORBIDDEN).
 * ------------------------------------------------------------------------ */

export type BoardToolOperationV1 =
  /** Active card of this chat, permissions, mode, up to 5 similar open cards for `query`. */
  | { op: 'context'; query?: string }
  | { op: 'search'; query: string; includeClosed?: boolean }
  | { op: 'list'; status?: CardStatusV1 }
  | { op: 'get'; card: number }
  /**
   * Without `confirmNew` the host returns `possibleDuplicates` instead of
   * creating when similar open cards exist.
   */
  | {
      op: 'create';
      title: string;
      description?: string;
      priority?: CardPriorityV1;
      labels?: string[];
      status?: 'backlog' | 'todo';
      confirmNew?: boolean;
    }
  | {
      op: 'update';
      card: number;
      title?: string;
      description?: string;
      priority?: CardPriorityV1;
      labels?: string[];
    }
  /** `done`/`cancelled` always become a proposal for the person. */
  | { op: 'move'; card: number; to: CardStatusV1; reason?: string }
  | { op: 'comment'; card: number; body: string }
  | { op: 'claim'; card: number }
  | { op: 'release'; card: number }
  /** Makes the card the active card of this chat. */
  | { op: 'link'; card: number }
  /** Enabled, assignable teammates with role and availability. */
  | { op: 'roster' }
  | { op: 'assign'; card: number; handle: string }
  /** Create + assign in one step. */
  | { op: 'handoff'; handle: string; title: string; description?: string; priority?: CardPriorityV1 };

export interface BoardToolCardSummaryV1 {
  number: number;
  title: string;
  status: CardStatusV1;
  priority: CardPriorityV1;
  assignee?: string;
  labels: string[];
}

export interface BoardToolRosterEntryV1 {
  handle: string;
  name: string;
  role: string;
  kind: 'simple' | 'pipeline';
  availability: 'idle' | 'queued' | 'working';
}

export type BoardToolResultV1 =
  | {
      ok: true;
      op: 'context';
      mode: BoardAgentModeV1;
      permissions: BoardPermissionsV1;
      activeCard?: BoardToolCardSummaryV1 & { description: string };
      similar: BoardToolCardSummaryV1[];
    }
  | { ok: true; op: 'search' | 'list'; cards: BoardToolCardSummaryV1[] }
  | {
      ok: true;
      op: 'get';
      card: BoardToolCardSummaryV1 & { description: string; recentComments: { author: string; body: string; at: string }[] };
    }
  | { ok: true; op: 'possibleDuplicates'; candidates: BoardToolCardSummaryV1[]; hint: string }
  | {
      ok: true;
      op: 'create' | 'update' | 'move' | 'comment' | 'claim' | 'release' | 'link' | 'assign' | 'handoff';
      card: BoardToolCardSummaryV1;
      /** `applied` in auto mode, `proposed` when it waits for the person. */
      state: 'applied' | 'proposed' | 'pendingStart';
    }
  | { ok: true; op: 'roster'; teammates: BoardToolRosterEntryV1[] }
  | { ok: false; code: BoardErrorCodeV1; message: string };
