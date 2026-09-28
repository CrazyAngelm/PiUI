/**
 * Chat ↔ card helpers (ADR-041, docs/BOARD.md "Chat ↔ card"): the active card
 * of a chat, the agent proposals and undoable agent changes that came from it,
 * the card picker and the `@teammate` handoff plan. Pure, so they are unit
 * tested directly and shared by the chat header, transcript strip and composer.
 */
import {
  CARD_STATUS_CATEGORY,
  MAX_CARD_DESCRIPTION_BYTES,
  MAX_CARD_TITLE_CHARS,
  MAX_COMMENT_BYTES,
  type BoardActorV1,
  type BoardProposalV1,
  type BoardV1,
  type CardActivityV1,
  type CardV1,
} from '../../host-api/boardClient';
import type { TeammateV1 } from '../../host-api/teammatesClient';
import { matchesFilter } from './boardModel';

const isOpen = (card: CardV1): boolean => CARD_STATUS_CATEGORY[card.status] !== 'closed';

function linkedSince(card: CardV1, sessionId: string): string | undefined {
  let since: string | undefined;
  for (const link of card.links) {
    if (link.kind === 'session' && link.sessionId === sessionId && (since === undefined || link.since > since)) since = link.since;
  }
  return since;
}

/**
 * Cards linked to a chat, open cards first and the most recently linked first
 * inside each group: the same order as the host's `sessionCards`.
 */
export function sessionCardsOf(board: BoardV1 | undefined, sessionId: string): CardV1[] {
  if (board === undefined) return [];
  return board.cards
    .flatMap((card) => {
      const since = linkedSince(card, sessionId);
      return since === undefined ? [] : [{ card, since }];
    })
    .sort((left, right) => Number(!isOpen(left.card)) - Number(!isOpen(right.card)) || right.since.localeCompare(left.since))
    .map((entry) => entry.card);
}

/** The chat's active card: the most recently linked open card. */
export function activeCardOf(board: BoardV1 | undefined, sessionId: string): CardV1 | undefined {
  const first = sessionCardsOf(board, sessionId)[0];
  return first !== undefined && isOpen(first) ? first : undefined;
}

const fromChat = (actor: BoardActorV1, sessionId: string): boolean => actor.kind === 'chatAgent' && actor.sessionId === sessionId;

/** Pending proposals made by the agent of this chat, oldest first. */
export function chatProposals(board: BoardV1 | undefined, sessionId: string): BoardProposalV1[] {
  if (board === undefined) return [];
  return board.proposals
    .filter((proposal) => proposal.status === 'pending' && fromChat(proposal.actor, sessionId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export interface ChatBoardChange {
  readonly card: CardV1;
  readonly activity: CardActivityV1;
}

/**
 * Board changes the agent of this chat applied on its own that the person can
 * still undo, newest first. `since` (the last message the person sent) keeps
 * the strip about the current exchange; without it, every such change counts.
 */
export function recentAgentChanges(board: BoardV1 | undefined, sessionId: string, since: string | undefined, limit = 5): ChatBoardChange[] {
  if (board === undefined) return [];
  const changes: ChatBoardChange[] = [];
  for (const card of board.cards) {
    for (const activity of card.activity) {
      if (activity.undoable !== true || !fromChat(activity.actor, sessionId)) continue;
      if (since !== undefined && activity.at < since) continue;
      changes.push({ card, activity });
    }
  }
  return changes.sort((left, right) => right.activity.at.localeCompare(left.activity.at)).slice(0, limit);
}

/** When the person last wrote in this chat (ISO time), if the transcript says. */
export function lastUserMessageAt(blocks: readonly { kind: string; createdAt?: string }[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === 'user' && block.createdAt) return block.createdAt;
  }
  return undefined;
}

/** Open cards for the "Change card" picker, newest first; `exclude` is the current card. */
export function linkableCards(board: BoardV1 | undefined, query: string, exclude: string | undefined = undefined, limit = 50): CardV1[] {
  if (board === undefined) return [];
  return board.cards
    .filter((card) => isOpen(card) && card.id !== exclude && matchesFilter(card, { text: query, teammate: '' }))
    .sort((left, right) => right.number - left.number)
    .slice(0, limit);
}

// ---- @teammate handoff -------------------------------------------------------

/** Enabled teammates whose `@handle` appears in the message, in order of first mention. */
export function mentionedTeammates(text: string, teammates: readonly TeammateV1[]): TeammateV1[] {
  const byHandle = new Map(teammates.filter((teammate) => teammate.enabled).map((teammate) => [teammate.handle, teammate]));
  const found: TeammateV1[] = [];
  for (const match of text.matchAll(/(^|[^a-z0-9-])@([a-z0-9][a-z0-9-]{1,31})(?![a-z0-9-])/gu)) {
    const teammate = byHandle.get(match[2] ?? '');
    if (teammate !== undefined && !found.includes(teammate)) found.push(teammate);
  }
  return found;
}

const encoder = new TextEncoder();

function withinBytes(value: string, limit: number): string {
  if (encoder.encode(value).length <= limit) return value;
  let result = '';
  let used = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (used + size > limit) break;
    result += char;
    used += size;
  }
  return result;
}

function withoutHandle(line: string, handle: string): string {
  return line
    .replace(new RegExp(`(^|[^a-z0-9-])@${handle}(?![a-z0-9-])[,:;]?`, 'gu'), '$1')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s,:;.–—-]+|[\s,:;–—-]+$/gu, '')
    .trim();
}

/** A card draft from a chat message: the first meaningful line titles it, the message describes it. */
export function handoffDraft(message: string, handle: string): { title: string; description: string } | undefined {
  const description = withinBytes(message.trim(), MAX_CARD_DESCRIPTION_BYTES);
  const line = description
    .split('\n')
    .map((item) => withoutHandle(item, handle))
    .find((item) => item.length > 0);
  if (line === undefined) return undefined;
  const chars = [...line];
  const title = chars.length > MAX_CARD_TITLE_CHARS ? `${chars.slice(0, MAX_CARD_TITLE_CHARS - 1).join('').trimEnd()}…` : line;
  return { title, description };
}

/**
 * What "Hand off to @x" does: with an active card, assign it to the teammate
 * and leave the message as a comment; otherwise create a card from the message
 * (linked to this chat) and assign it. `undefined` when the message has
 * nothing to hand off besides the handle.
 */
export type HandoffPlan =
  | { kind: 'assign'; cardId: string; cardNumber: number; teammateId: string; comment: string }
  | { kind: 'create'; title: string; description: string; teammateId: string };

export function handoffPlan(message: string, teammate: TeammateV1, activeCard: CardV1 | undefined): HandoffPlan | undefined {
  const draft = handoffDraft(message, teammate.handle);
  if (draft === undefined) return undefined;
  if (activeCard !== undefined) {
    return { kind: 'assign', cardId: activeCard.id, cardNumber: activeCard.number, teammateId: teammate.id, comment: withinBytes(draft.description, MAX_COMMENT_BYTES) };
  }
  return { kind: 'create', title: draft.title, description: draft.description, teammateId: teammate.id };
}
