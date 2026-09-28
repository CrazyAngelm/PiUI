/**
 * Project boards (ADR-041): one small store per project, created on demand
 * and kept while the app runs. The host is authoritative; every change event
 * reloads the board. Moves are optimistic and roll back when the host
 * refuses them.
 */
import { SvelteMap } from 'svelte/reactivity';
import {
  boardError,
  boardHost,
  BoardError,
  type BoardChangedEventV1,
  type BoardClient,
  type BoardCommandV1,
  type BoardProposalV1,
  type BoardResultV1,
  type PendingStartV1,
  type BoardSettingsV1,
  type BoardV1,
  type CardEditableFieldsV1,
  type CardStartModeV1,
  type CardStatusV1,
  type CardV1,
  type CommentMentionV1,
} from '../../host-api/boardClient';
import { withMovedCard } from './boardModel';

type Distribute<T> = T extends unknown ? Omit<T, 'workspaceId'> : never;
/** A board command without its project, which the store fills in. */
export type BoardCommandFor = Distribute<BoardCommandV1>;

export class BoardStore {
  board = $state.raw<BoardV1 | undefined>();
  loading = $state(false);
  /** Load failure (fixed copy); commands throw instead. */
  error = $state<string>();
  private loadSerial = 0;
  private pendingMoves = 0;

  constructor(readonly workspaceId: string, private readonly client: BoardClient = boardHost) {}

  get enabled(): boolean {
    return this.board?.enabled === true;
  }

  card(cardId: string | undefined): CardV1 | undefined {
    return cardId === undefined ? undefined : this.board?.cards.find((card) => card.id === cardId);
  }

  async load(): Promise<void> {
    const serial = ++this.loadSerial;
    this.loading = this.board === undefined;
    try {
      const result = await this.client.request({ type: 'get', workspaceId: this.workspaceId });
      if (serial !== this.loadSerial) return;
      if (result.type === 'board') this.board = result.board;
      this.error = undefined;
    } catch (cause) {
      if (serial === this.loadSerial) this.error = boardError(cause).message;
    } finally {
      if (serial === this.loadSerial) this.loading = false;
    }
  }

  /** A host change: reload unless an optimistic move is still in flight (it reloads itself). */
  changed(event: BoardChangedEventV1): void {
    if (event.workspaceId !== this.workspaceId) return;
    if (this.board !== undefined && event.revision <= this.board.revision) return;
    if (this.pendingMoves > 0) return;
    void this.load();
  }

  private applyResult(result: BoardResultV1): void {
    const board = this.board;
    switch (result.type) {
      case 'board':
        this.board = result.board;
        return;
      case 'card':
        if (board === undefined) return;
        this.board = {
          ...board,
          revision: Math.max(board.revision, result.boardRevision),
          cards: board.cards.some((card) => card.id === result.card.id)
            ? board.cards.map((card) => (card.id === result.card.id ? result.card : card))
            : [...board.cards, result.card],
        };
        return;
      case 'deleted':
        if (board === undefined) return;
        this.board = { ...board, revision: Math.max(board.revision, result.boardRevision), cards: board.cards.filter((card) => card.id !== result.cardId) };
        return;
      case 'sessionCards':
        return;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }

  /** Sends one command; the card/board in the result replaces the cached copy, then the whole board reloads. */
  async run(command: BoardCommandFor): Promise<BoardResultV1> {
    let result: BoardResultV1;
    try {
      result = await this.client.request({ ...command, workspaceId: this.workspaceId } as BoardCommandV1);
    } catch (cause) {
      const error = boardError(cause);
      // A conflict means our copy is stale: refresh before the person retries.
      if (error.code === 'REVISION_CONFLICT' || error.code === 'NOT_FOUND') void this.load();
      throw error;
    }
    this.applyResult(result);
    // Wake rules and blockers may touch other cards: stay authoritative.
    if (result.type === 'card' || result.type === 'deleted') void this.load();
    return result;
  }

  /**
   * Optimistic move: the card shows in its new column at once. On refusal it
   * returns to where it was (unless the board changed meanwhile) and the
   * typed error is rethrown for the view to announce.
   */
  async moveCard(cardId: string, to: CardStatusV1, order: number | undefined = undefined): Promise<void> {
    const board = this.board;
    const card = board?.cards.find((item) => item.id === cardId);
    if (board === undefined || card === undefined) throw new BoardError('NOT_FOUND');
    const previous = { status: card.status, order: card.order };
    const optimistic = withMovedCard(board, cardId, to, order);
    this.board = optimistic;
    this.pendingMoves += 1;
    try {
      const result = await this.client.request({ type: 'moveCard', workspaceId: this.workspaceId, cardId, to, ...(order === undefined ? {} : { order }) });
      this.applyResult(result);
    } catch (cause) {
      const current = this.board;
      if (current !== undefined) {
        this.board = { ...current, cards: current.cards.map((item) => (item.id === cardId ? { ...item, ...previous } : item)) };
      }
      throw boardError(cause);
    } finally {
      this.pendingMoves -= 1;
      if (this.pendingMoves === 0) void this.load();
    }
  }

  setEnabled(enabled: boolean): Promise<BoardResultV1> {
    return this.run({ type: 'setEnabled', enabled });
  }

  updateSettings(settings: BoardSettingsV1): Promise<BoardResultV1> {
    return this.run({ type: 'updateSettings', expectedRevision: this.board?.revision ?? 0, settings });
  }

  async createCard(
    card: Partial<CardEditableFieldsV1> & { title: string },
    status: CardStatusV1 | undefined = undefined,
    sessionId: string | undefined = undefined,
  ): Promise<CardV1 | undefined> {
    const result = await this.run({
      type: 'createCard',
      card,
      ...(status === undefined ? {} : { status }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return result.type === 'card' ? result.card : undefined;
  }

  updateCard(card: CardV1, patch: Partial<CardEditableFieldsV1>): Promise<BoardResultV1> {
    return this.run({ type: 'updateCard', cardId: card.id, expectedRevision: card.revision, patch });
  }

  deleteCard(card: CardV1): Promise<BoardResultV1> {
    return this.run({ type: 'deleteCard', cardId: card.id, expectedRevision: card.revision });
  }

  comment(cardId: string, body: string, mentions: readonly CommentMentionV1[]): Promise<BoardResultV1> {
    return this.run({ type: 'comment', cardId, body, ...(mentions.length ? { mentions: [...mentions] } : {}) });
  }

  assign(cardId: string, teammateId: string | null, start: CardStartModeV1): Promise<BoardResultV1> {
    return this.run({ type: 'assign', cardId, teammateId, start });
  }

  startRun(cardId: string): Promise<BoardResultV1> {
    return this.run({ type: 'startRun', cardId });
  }

  releaseClaim(cardId: string): Promise<BoardResultV1> {
    return this.run({ type: 'releaseClaim', cardId });
  }

  resolvePendingStart(pendingStartId: string, accept: boolean): Promise<BoardResultV1> {
    return this.run({ type: 'resolvePendingStart', pendingStartId, accept });
  }

  resolveProposal(proposalId: string, accept: boolean): Promise<BoardResultV1> {
    return this.run({ type: 'resolveProposal', proposalId, accept });
  }

  undo(cardId: string, activityId: string): Promise<BoardResultV1> {
    return this.run({ type: 'undo', cardId, activityId });
  }

  linkSession(cardId: string, sessionId: string): Promise<BoardResultV1> {
    return this.run({ type: 'linkSession', cardId, sessionId });
  }

  unlinkSession(cardId: string, sessionId: string): Promise<BoardResultV1> {
    return this.run({ type: 'unlinkSession', cardId, sessionId });
  }

  /** Cards linked to a chat, the active (most recent open) one first. */
  async sessionCards(sessionId: string): Promise<CardV1[]> {
    const result = await this.client.request({ type: 'sessionCards', workspaceId: this.workspaceId, sessionId }).catch((cause: unknown) => {
      throw boardError(cause);
    });
    return result.type === 'sessionCards' ? result.cards : [];
  }
}

export interface BoardAttention {
  readonly workspaceId: string;
  readonly store: BoardStore;
  readonly proposals: readonly BoardProposalV1[];
  readonly pendingStarts: readonly PendingStartV1[];
}

/**
 * Board stores by project, plus one host subscription for all of them. The
 * sidebar asks for summaries after first paint; views ask for their project.
 */
export class BoardRegistry {
  readonly stores = new SvelteMap<string, BoardStore>();
  private listening: Promise<void> | undefined;

  constructor(private readonly client: BoardClient = boardHost) {}

  get(workspaceId: string): BoardStore {
    let store = this.stores.get(workspaceId);
    if (store === undefined) {
      store = new BoardStore(workspaceId, this.client);
      this.stores.set(workspaceId, store);
      void store.load();
    }
    this.listen();
    return store;
  }

  /** Loads the boards of these projects (sidebar, inbox); never blocks first paint. */
  ensure(workspaceIds: readonly string[]): void {
    for (const id of workspaceIds) this.get(id);
  }

  enabled(workspaceId: string): boolean {
    return this.stores.get(workspaceId)?.enabled === true;
  }

  /** Pending proposals and run starts of every loaded, enabled board (Inbox). */
  attention(): BoardAttention[] {
    const items: BoardAttention[] = [];
    for (const [workspaceId, store] of this.stores) {
      const board = store.board;
      if (!board?.enabled) continue;
      const proposals = board.proposals.filter((proposal) => proposal.status === 'pending');
      if (proposals.length || board.pendingStarts.length) items.push({ workspaceId, store, proposals, pendingStarts: board.pendingStarts });
    }
    return items;
  }

  private listen(): void {
    this.listening ??= this.client
      .onChanged((event) => this.stores.get(event.workspaceId)?.changed(event))
      .then(() => undefined)
      .catch(() => {
        this.listening = undefined;
      });
  }
}

export const boards = new BoardRegistry();
