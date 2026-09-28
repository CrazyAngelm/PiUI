import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import {
  BOARD_CHANGED_EVENT_V1,
  CARD_STATUSES,
  type BoardChangedEventV1,
  type BoardCommandV1,
  type BoardErrorCodeV1,
  type BoardResultV1,
  type BoardV1,
  type CardV1,
} from '../../../../contracts/board-v1';
import { isRecord } from './sessionToolErrors';

export type * from '../../../../contracts/board-v1';
export {
  BOARD_CHANGED_EVENT_V1,
  CARD_STATUSES,
  CARD_STATUS_CATEGORY,
  DEFAULT_BOARD_SETTINGS,
  MAX_CARD_DESCRIPTION_BYTES,
  MAX_CARD_TITLE_CHARS,
  MAX_LABELS_PER_CARD,
  MAX_COMMENT_BYTES,
} from '../../../../contracts/board-v1';

/**
 * Client of `board_command_v1` (ADR-041, docs/BOARD.md): the person's side of
 * a project board. Agents never use it; they act through the host `board`
 * tool. Host error text never reaches the UI: each code has fixed copy.
 */
export const BOARD_ERROR_COPY: Readonly<Record<BoardErrorCodeV1 | 'unknown', string>> = {
  SAFE_MODE: 'Safe mode is on: PiUI does not change the board.',
  INVALID_ARGUMENT: 'Check the card details and try again.',
  NOT_FOUND: 'This card is no longer on the board. Refresh and try again.',
  DISABLED: 'The board of this project is turned off.',
  REVISION_CONFLICT: 'The card changed meanwhile. Your view was refreshed; try again.',
  ALREADY_CLAIMED: 'A run is already working on this card.',
  FORBIDDEN: 'This change is not allowed on this board.',
  LIMIT: 'The board is full. Delete or close cards, then try again.',
  RATE_LIMITED: 'Too many board changes at once. Try again in a moment.',
  NOT_ASSIGNABLE: 'This teammate cannot take cards yet. Open the Team screen to fix it.',
  IO_ERROR: 'PiUI could not save the board. Nothing was lost.',
  unknown: 'The board operation could not be completed.',
};

export type BoardErrorKind = BoardErrorCodeV1 | 'unknown';

export class BoardError extends Error {
  constructor(readonly code: BoardErrorKind, message: string = BOARD_ERROR_COPY[code]) {
    super(message);
    this.name = 'BoardError';
  }
}

function isErrorCode(value: unknown): value is BoardErrorCodeV1 {
  return typeof value === 'string' && value !== 'unknown' && Object.hasOwn(BOARD_ERROR_COPY, value);
}

/** Maps a rejected invoke (object or JSON string) to a typed error with safe copy. */
export function boardError(cause: unknown): BoardError {
  if (cause instanceof BoardError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  return new BoardError(isRecord(value) && isErrorCode(value.code) ? value.code : 'unknown');
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isCard(value: unknown): value is CardV1 {
  return isRecord(value)
    && text(value.id)
    && count(value.number)
    && typeof value.title === 'string'
    && typeof value.description === 'string'
    && typeof value.status === 'string'
    && (CARD_STATUSES as readonly string[]).includes(value.status)
    && Array.isArray(value.labels)
    && Array.isArray(value.blockedBy)
    && Array.isArray(value.links)
    && Array.isArray(value.comments)
    && Array.isArray(value.activity)
    && count(value.revision);
}

export function isBoard(value: unknown): value is BoardV1 {
  return isRecord(value)
    && text(value.workspaceId)
    && typeof value.enabled === 'boolean'
    && isRecord(value.settings)
    && Array.isArray(value.cards)
    && value.cards.every(isCard)
    && Array.isArray(value.proposals)
    && Array.isArray(value.pendingStarts)
    && count(value.revision);
}

export function decodeBoardResult(value: unknown): BoardResultV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1) return undefined;
  switch (value.type) {
    case 'board':
      return isBoard(value.board) ? (value as unknown as BoardResultV1) : undefined;
    case 'card':
      return isCard(value.card) && count(value.boardRevision) ? (value as unknown as BoardResultV1) : undefined;
    case 'sessionCards':
      return Array.isArray(value.cards) && value.cards.every(isCard) ? (value as unknown as BoardResultV1) : undefined;
    case 'deleted':
      return text(value.cardId) && count(value.boardRevision) ? (value as unknown as BoardResultV1) : undefined;
    default:
      return undefined;
  }
}

export function decodeBoardChanged(value: unknown): BoardChangedEventV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1 || !text(value.workspaceId) || !count(value.revision)) return undefined;
  if (value.cardIds !== undefined && !(Array.isArray(value.cardIds) && value.cardIds.every(text))) return undefined;
  return value as unknown as BoardChangedEventV1;
}

export interface BoardClient {
  request(command: BoardCommandV1): Promise<BoardResultV1>;
  /** Subscribes to `piui://board-changed-v1`; malformed payloads are dropped. */
  onChanged(handler: (event: BoardChangedEventV1) => void): Promise<() => void>;
}

export function createBoardClient(invoke: HostInvoke, listen: HostListen): BoardClient {
  return {
    async request(command) {
      let result: unknown;
      try {
        result = await invoke<unknown>('board_command_v1', { command });
      } catch (error) {
        throw boardError(error);
      }
      const decoded = decodeBoardResult(result);
      if (decoded === undefined) throw new BoardError('unknown');
      return decoded;
    },
    onChanged(handler) {
      return listen<unknown>(BOARD_CHANGED_EVENT_V1, (payload) => {
        const event = decodeBoardChanged(payload);
        if (event !== undefined) handler(event);
      });
    },
  };
}

export const boardHost: BoardClient = createBoardClient(
  (command, args) => hostInvoke(command, args),
  (channel, handler) => hostListen(channel, handler),
);
