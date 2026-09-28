import { describe, expect, it } from 'vitest';
import { boardKey, clampFocus, focusOf, type KeyColumn, type KeyInput } from './boardKeyboard';
import { columnsOf, orderAt, withMovedCard } from './boardModel';
import type { BoardV1, CardV1 } from '../../host-api/boardClient';
import { DEFAULT_BOARD_SETTINGS } from '../../host-api/boardClient';

const key = (value: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  key: value,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

/** backlog [a], todo [b, c], inProgress [], inReview [d], blocked [], done (collapsed), cancelled []. */
const COLUMNS: KeyColumn[] = [
  { status: 'backlog', cardIds: ['a'] },
  { status: 'todo', cardIds: ['b', 'c'] },
  { status: 'inProgress', cardIds: [] },
  { status: 'inReview', cardIds: ['d'] },
  { status: 'blocked', cardIds: [] },
  { status: 'done', cardIds: [] },
  { status: 'cancelled', cardIds: [] },
];

describe('board keyboard model', () => {
  it('moves focus within a column and clamps at the ends', () => {
    expect(boardKey(key('ArrowDown'), COLUMNS, { column: 1, row: 0 })).toEqual({ type: 'focus', focus: { column: 1, row: 1 }, cardId: 'c' });
    expect(boardKey(key('ArrowDown'), COLUMNS, { column: 1, row: 1 })).toEqual({ type: 'focus', focus: { column: 1, row: 1 }, cardId: 'c' });
    expect(boardKey(key('ArrowUp'), COLUMNS, { column: 1, row: 0 })).toEqual({ type: 'focus', focus: { column: 1, row: 0 }, cardId: 'b' });
    expect(boardKey(key('End'), COLUMNS, { column: 1, row: 0 })).toMatchObject({ cardId: 'c' });
    expect(boardKey(key('Home'), COLUMNS, { column: 1, row: 1 })).toMatchObject({ cardId: 'b' });
  });

  it('skips empty columns when moving focus sideways and keeps the row when it can', () => {
    expect(boardKey(key('ArrowRight'), COLUMNS, { column: 1, row: 1 })).toEqual({ type: 'focus', focus: { column: 3, row: 0 }, cardId: 'd' });
    expect(boardKey(key('ArrowLeft'), COLUMNS, { column: 3, row: 0 })).toEqual({ type: 'focus', focus: { column: 1, row: 0 }, cardId: 'b' });
    expect(boardKey(key('ArrowRight'), COLUMNS, { column: 3, row: 0 })).toEqual({ type: 'none' });
  });

  it('moves the focused card to the neighbouring status with Shift, even into an empty column', () => {
    expect(boardKey(key('ArrowRight', { shiftKey: true }), COLUMNS, { column: 1, row: 1 })).toEqual({ type: 'move', cardId: 'c', to: 'inProgress' });
    expect(boardKey(key('ArrowLeft', { shiftKey: true }), COLUMNS, { column: 1, row: 0 })).toEqual({ type: 'move', cardId: 'b', to: 'backlog' });
    expect(boardKey(key('ArrowLeft', { shiftKey: true }), COLUMNS, { column: 0, row: 0 })).toEqual({ type: 'none' });
  });

  it('opens, starts a new card in the focused column, filters and closes', () => {
    expect(boardKey(key('Enter'), COLUMNS, { column: 3, row: 0 })).toEqual({ type: 'open', cardId: 'd' });
    expect(boardKey(key('n'), COLUMNS, { column: 3, row: 0 })).toEqual({ type: 'new', status: 'inReview' });
    expect(boardKey(key('n'), [], undefined)).toEqual({ type: 'new', status: 'todo' });
    expect(boardKey(key('/'), COLUMNS, undefined)).toEqual({ type: 'filter' });
    expect(boardKey(key('Escape'), COLUMNS, undefined)).toEqual({ type: 'close' });
  });

  it('ignores shortcuts with modifiers and unknown keys', () => {
    expect(boardKey(key('n', { ctrlKey: true }), COLUMNS, undefined)).toEqual({ type: 'none' });
    expect(boardKey(key('ArrowDown', { metaKey: true }), COLUMNS, { column: 1, row: 0 })).toEqual({ type: 'none' });
    expect(boardKey(key('x'), COLUMNS, { column: 1, row: 0 })).toEqual({ type: 'none' });
  });

  it('recovers a stale focus after cards move away', () => {
    expect(clampFocus(COLUMNS, { column: 1, row: 7 })).toEqual({ column: 1, row: 1 });
    expect(clampFocus(COLUMNS, { column: 2, row: 0 })).toEqual({ column: 0, row: 0 });
    expect(clampFocus([], undefined)).toBeUndefined();
    expect(focusOf(COLUMNS, 'd')).toEqual({ column: 3, row: 0 });
    expect(boardKey(key('ArrowDown'), COLUMNS, { column: 2, row: 4 })).toEqual({ type: 'focus', focus: { column: 0, row: 0 }, cardId: 'a' });
  });
});

function card(id: string, order: number, patch: Partial<CardV1> = {}): CardV1 {
  return {
    id, number: order, title: id, description: '', priority: 'normal', labels: [], blockedBy: [], parentId: null, status: 'todo', order,
    links: [], comments: [], activity: [], revision: 1, createdBy: { kind: 'person' }, createdAt: '', updatedAt: '', ...patch,
  };
}

describe('board ordering', () => {
  const column = [card('a', 100), card('b', 200), card('c', 300)];

  it('places a card between neighbours, first, or appends', () => {
    expect(orderAt(column, 0, 'x')).toBe(50);
    expect(orderAt(column, 1, 'x')).toBe(150);
    expect(orderAt(column, 3, 'x')).toBeUndefined();
    // The moving card itself is ignored.
    expect(orderAt(column, 1, 'a')).toBe(250);
  });

  it('builds sorted, filtered columns and optimistic copies', () => {
    const board: BoardV1 = {
      workspaceId: 'ws', enabled: true, settings: DEFAULT_BOARD_SETTINGS, proposals: [], pendingStarts: [], nextNumber: 4, revision: 1, updatedAt: '',
      cards: [card('b', 200, { labels: ['docs'] }), card('a', 100, { assignee: 't1' }), card('c', 300, { status: 'done' })],
    };
    const todo = columnsOf(board).find((item) => item.status === 'todo');
    expect(todo?.cards.map((item) => item.id)).toEqual(['a', 'b']);
    expect(columnsOf(board, { text: 'docs', teammate: '' })[1]?.cards.map((item) => item.id)).toEqual(['b']);
    expect(columnsOf(board, { text: '', teammate: 't1' })[1]?.cards.map((item) => item.id)).toEqual(['a']);
    expect(columnsOf(board, { text: '', teammate: 'unassigned' })[1]?.cards.map((item) => item.id)).toEqual(['b']);
    const moved = withMovedCard(board, 'a', 'done', undefined);
    expect(moved.cards.find((item) => item.id === 'a')).toMatchObject({ status: 'done', order: 1324 });
    expect(board.cards.find((item) => item.id === 'a')?.status).toBe('todo');
  });
});
