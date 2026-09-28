/**
 * Keyboard model of the board (docs/BOARD.md "UI"): columns are lists and
 * cards list items with one roving tab stop. Arrows move focus, Shift+Left/
 * Right move the focused card to the neighbouring status, Enter opens it,
 * `n` starts a new card, `/` focuses the filter and Escape closes. The
 * reducer is pure: the view applies the returned action.
 */
import type { CardStatusV1 } from '../../host-api/boardClient';

export interface KeyColumn {
  status: CardStatusV1;
  /** Visible card ids in display order (empty for a collapsed column). */
  cardIds: readonly string[];
}

export interface BoardFocus {
  column: number;
  row: number;
}

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export type BoardKeyAction =
  | { type: 'focus'; focus: BoardFocus; cardId: string }
  | { type: 'move'; cardId: string; to: CardStatusV1 }
  | { type: 'open'; cardId: string }
  | { type: 'new'; status: CardStatusV1 }
  | { type: 'filter' }
  | { type: 'close' }
  | { type: 'none' };

const NONE: BoardKeyAction = { type: 'none' };

/** The card id at a focus position, if any. */
export function cardAt(columns: readonly KeyColumn[], focus: BoardFocus): string | undefined {
  return columns[focus.column]?.cardIds[focus.row];
}

/** Focus position of a card id, or undefined when it is not visible. */
export function focusOf(columns: readonly KeyColumn[], cardId: string): BoardFocus | undefined {
  for (let column = 0; column < columns.length; column += 1) {
    const row = columns[column]?.cardIds.indexOf(cardId) ?? -1;
    if (row >= 0) return { column, row };
  }
  return undefined;
}

/** A valid focus: the same position clamped, else the first visible card. */
export function clampFocus(columns: readonly KeyColumn[], focus: BoardFocus | undefined): BoardFocus | undefined {
  if (focus !== undefined) {
    const column = columns[focus.column];
    if (column !== undefined && column.cardIds.length > 0) {
      return { column: focus.column, row: Math.min(Math.max(0, focus.row), column.cardIds.length - 1) };
    }
  }
  const first = columns.findIndex((column) => column.cardIds.length > 0);
  return first < 0 ? undefined : { column: first, row: 0 };
}

function focusAction(columns: readonly KeyColumn[], focus: BoardFocus): BoardKeyAction {
  const cardId = cardAt(columns, focus);
  return cardId === undefined ? NONE : { type: 'focus', focus, cardId };
}

/** The nearest column in `direction` that has visible cards. */
function neighbourWithCards(columns: readonly KeyColumn[], from: number, direction: -1 | 1): number | undefined {
  for (let index = from + direction; index >= 0 && index < columns.length; index += direction) {
    if ((columns[index]?.cardIds.length ?? 0) > 0) return index;
  }
  return undefined;
}

export function boardKey(input: KeyInput, columns: readonly KeyColumn[], current: BoardFocus | undefined): BoardKeyAction {
  if (input.ctrlKey || input.metaKey || input.altKey) return NONE;
  const focus = clampFocus(columns, current);
  const column = focus === undefined ? undefined : columns[focus.column];
  const cardId = focus === undefined ? undefined : cardAt(columns, focus);

  switch (input.key) {
    case 'Escape':
      return { type: 'close' };
    case '/':
      return { type: 'filter' };
    case 'n':
    case 'N':
      if (input.shiftKey) return NONE;
      return { type: 'new', status: column?.status ?? 'todo' };
    case 'Enter':
      return cardId === undefined ? NONE : { type: 'open', cardId };
    case 'ArrowUp':
    case 'ArrowDown': {
      if (focus === undefined || column === undefined || input.shiftKey) return NONE;
      const row = input.key === 'ArrowUp' ? Math.max(0, focus.row - 1) : Math.min(column.cardIds.length - 1, focus.row + 1);
      return focusAction(columns, { column: focus.column, row });
    }
    case 'Home':
    case 'End': {
      if (focus === undefined || column === undefined) return NONE;
      return focusAction(columns, { column: focus.column, row: input.key === 'Home' ? 0 : column.cardIds.length - 1 });
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (focus === undefined || cardId === undefined) return NONE;
      const direction = input.key === 'ArrowLeft' ? -1 : 1;
      if (input.shiftKey) {
        // Moving a card may target an empty or collapsed status.
        const target = columns[focus.column + direction];
        return target === undefined ? NONE : { type: 'move', cardId, to: target.status };
      }
      const next = neighbourWithCards(columns, focus.column, direction);
      if (next === undefined) return NONE;
      const length = columns[next]?.cardIds.length ?? 0;
      return focusAction(columns, { column: next, row: Math.min(focus.row, length - 1) });
    }
    default:
      return NONE;
  }
}
