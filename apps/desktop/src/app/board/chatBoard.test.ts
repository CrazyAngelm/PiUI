import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOARD_SETTINGS,
  MAX_CARD_TITLE_CHARS,
  type BoardActorV1,
  type BoardProposalV1,
  type BoardV1,
  type CardActivityV1,
  type CardV1,
} from '../../host-api/boardClient';
import type { TeammateV1 } from '../../host-api/teammatesClient';
import {
  activeCardOf,
  chatProposals,
  handoffDraft,
  handoffPlan,
  lastUserMessageAt,
  linkableCards,
  mentionedTeammates,
  recentAgentChanges,
  sessionCardsOf,
} from './chatBoard';

const CHAT = 'chat-a';
const OTHER = 'chat-b';
const agent = (sessionId: string): BoardActorV1 => ({ kind: 'chatAgent', sessionId, harness: 'codex' });

function card(id: string, number: number, patch: Partial<CardV1> = {}): CardV1 {
  return {
    id, number, title: `Card ${number}`, description: '', priority: 'normal', labels: [], blockedBy: [], parentId: null,
    status: 'todo', order: number * 1024, links: [], comments: [], activity: [], revision: 1, createdBy: { kind: 'person' },
    createdAt: '2026-09-28T10:00:00Z', updatedAt: '2026-09-28T10:00:00Z', ...patch,
  };
}

const linked = (sessionId: string, since: string) => ({ kind: 'session' as const, sessionId, harness: 'codex', since });

function board(cards: CardV1[], proposals: BoardProposalV1[] = []): BoardV1 {
  return {
    workspaceId: 'ws', enabled: true, settings: structuredClone(DEFAULT_BOARD_SETTINGS), cards, proposals, pendingStarts: [],
    nextNumber: cards.length + 1, revision: 1, updatedAt: '2026-09-28T10:00:00Z',
  };
}

function teammate(id: string, handle: string, patch: Partial<TeammateV1> = {}): TeammateV1 {
  return {
    id, handle, name: handle, color: 'chaos', avatar: 'T', role: '', kind: { type: 'pipeline' }, launchCommandId: `cmd-${id}`,
    cardInput: { type: 'auto' }, board: { read: true, comment: true, create: false, move: false, claim: false, assign: false },
    maxConcurrentRuns: 1, wake: { onAssign: 'ask', onMention: true }, enabled: true, revision: 1, createdAt: '', updatedAt: '', ...patch,
  };
}

function activity(id: string, at: string, actor: BoardActorV1, undoable = true): CardActivityV1 {
  return { id, at, actor, change: { type: 'moved', from: 'todo', to: 'inProgress' }, ...(undoable ? { undoable: true as const } : {}) };
}

describe('the active card of a chat', () => {
  it('orders linked cards open first, most recently linked first', () => {
    const value = board([
      card('old', 1, { links: [linked(CHAT, '2026-09-28T09:00:00Z')] }),
      card('closed', 2, { status: 'done', links: [linked(CHAT, '2026-09-28T11:00:00Z')] }),
      card('new', 3, { links: [linked(CHAT, '2026-09-28T09:00:00Z'), linked(CHAT, '2026-09-28T10:30:00Z')] }),
      card('elsewhere', 4, { links: [linked(OTHER, '2026-09-28T12:00:00Z')] }),
    ]);
    expect(sessionCardsOf(value, CHAT).map((item) => item.id)).toEqual(['new', 'old', 'closed']);
    expect(activeCardOf(value, CHAT)?.id).toBe('new');
    expect(sessionCardsOf(undefined, CHAT)).toEqual([]);
  });

  it('has no active card when every linked card is closed', () => {
    const value = board([card('closed', 1, { status: 'cancelled', links: [linked(CHAT, '2026-09-28T09:00:00Z')] })]);
    expect(sessionCardsOf(value, CHAT)).toHaveLength(1);
    expect(activeCardOf(value, CHAT)).toBeUndefined();
  });

  it('offers open cards other than the active one for "Change card", by #number or title', () => {
    const value = board([card('a', 1, { title: 'Fix login' }), card('b', 2, { title: 'Write docs' }), card('c', 12, { status: 'done' })]);
    expect(linkableCards(value, '').map((item) => item.id)).toEqual(['b', 'a']);
    expect(linkableCards(value, '', 'b').map((item) => item.id)).toEqual(['a']);
    expect(linkableCards(value, '#2').map((item) => item.id)).toEqual(['b']);
    expect(linkableCards(value, 'login').map((item) => item.id)).toEqual(['a']);
  });
});

describe('agent board activity of a chat', () => {
  const proposal = (id: string, actor: BoardActorV1, status: BoardProposalV1['status'] = 'pending', createdAt = '2026-09-28T10:00:00Z'): BoardProposalV1 => ({
    id, cardId: 'a', operation: { op: 'move', cardId: 'a', to: 'inReview' }, actor, createdAt, status,
  });

  it('keeps only pending proposals by the agent of this chat, oldest first', () => {
    const value = board([card('a', 1)], [
      proposal('later', agent(CHAT), 'pending', '2026-09-28T10:05:00Z'),
      proposal('first', agent(CHAT), 'pending', '2026-09-28T10:01:00Z'),
      proposal('done', agent(CHAT), 'accepted'),
      proposal('other-chat', agent(OTHER)),
      proposal('run', { kind: 'runMember', runId: 'r', memberId: 'm', profileId: 'p' }),
      proposal('person', { kind: 'person' }),
    ]);
    expect(chatProposals(value, CHAT).map((item) => item.id)).toEqual(['first', 'later']);
    expect(chatProposals(undefined, CHAT)).toEqual([]);
  });

  it('lists undoable agent changes since the last message, newest first', () => {
    const value = board([
      card('a', 1, {
        activity: [
          activity('before', '2026-09-28T09:00:00Z', agent(CHAT)),
          activity('after', '2026-09-28T10:10:00Z', agent(CHAT)),
          activity('not-undoable', '2026-09-28T10:11:00Z', agent(CHAT), false),
          activity('person', '2026-09-28T10:12:00Z', { kind: 'person' }),
        ],
      }),
      card('b', 2, { activity: [activity('latest', '2026-09-28T10:20:00Z', agent(CHAT)), activity('other', '2026-09-28T10:21:00Z', agent(OTHER))] }),
    ]);
    const since = lastUserMessageAt([
      { kind: 'user', createdAt: '2026-09-28T08:00:00Z' },
      { kind: 'assistant', createdAt: '2026-09-28T08:01:00Z' },
      { kind: 'user', createdAt: '2026-09-28T10:00:00Z' },
      { kind: 'assistant' },
    ]);
    expect(since).toBe('2026-09-28T10:00:00Z');
    expect(recentAgentChanges(value, CHAT, since).map((item) => item.activity.id)).toEqual(['latest', 'after']);
    expect(recentAgentChanges(value, CHAT, undefined).map((item) => item.activity.id)).toEqual(['latest', 'after', 'before']);
    expect(recentAgentChanges(value, CHAT, undefined, 1)).toHaveLength(1);
    expect(lastUserMessageAt([{ kind: 'user' }, { kind: 'assistant', createdAt: '2026-09-28T08:00:00Z' }])).toBeUndefined();
  });
});

describe('@teammate handoff', () => {
  const coder = teammate('t1', 'coder');
  const reviewer = teammate('t2', 'reviewer');
  const off = teammate('t3', 'sleepy', { enabled: false });

  it('finds enabled teammates mentioned in the message, in order, once each', () => {
    expect(mentionedTeammates('@reviewer then @coder, and @reviewer again', [coder, reviewer]).map((item) => item.handle)).toEqual(['reviewer', 'coder']);
    expect(mentionedTeammates('mail me@coder.dev or @sleepy or @unknown', [coder, off])).toEqual([]);
    expect(mentionedTeammates('no mentions here', [coder])).toEqual([]);
  });

  it('titles the card with the first meaningful line without the handle and keeps the message as description', () => {
    expect(handoffDraft('@coder fix the login redirect\nIt loops after SSO.', 'coder')).toEqual({
      title: 'fix the login redirect',
      description: '@coder fix the login redirect\nIt loops after SSO.',
    });
    expect(handoffDraft('@coder,\n\n  Add dark mode to settings  ', 'coder')?.title).toBe('Add dark mode to settings');
    expect(handoffDraft('Please, @coder: review #42.', 'coder')?.title).toBe('Please, review #42.');
    expect(handoffDraft('  @coder  ', 'coder')).toBeUndefined();
  });

  it('caps a long title to the contract limit', () => {
    const draft = handoffDraft(`@coder ${'word '.repeat(80)}`, 'coder');
    expect(draft).toBeDefined();
    expect([...(draft?.title ?? '')].length).toBeLessThanOrEqual(MAX_CARD_TITLE_CHARS);
    expect(draft?.title.endsWith('…')).toBe(true);
  });

  it('assigns the active card with the message as a comment, else creates a card', () => {
    const active = card('a', 42, { title: 'Fix login' });
    expect(handoffPlan('@coder take it from here', coder, active)).toEqual({
      kind: 'assign', cardId: 'a', cardNumber: 42, teammateId: 't1', comment: '@coder take it from here',
    });
    expect(handoffPlan('@coder write the release note', coder, undefined)).toEqual({
      kind: 'create', title: 'write the release note', description: '@coder write the release note', teammateId: 't1',
    });
    expect(handoffPlan('@coder', coder, active)).toBeUndefined();
  });
});
