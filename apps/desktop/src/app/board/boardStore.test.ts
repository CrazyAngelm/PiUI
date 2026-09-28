import { describe, expect, it } from 'vitest';
import type { BoardChangedEventV1, BoardClient, BoardCommandV1, BoardResultV1, BoardV1, CardV1 } from '../../host-api/boardClient';
import { BoardError } from '../../host-api/boardClient';
import { DEFAULT_BOARD_SETTINGS } from '../../host-api/boardClient';
import { BoardStore } from './boardStore.svelte';

const WORKSPACE = 'ws';

function card(id: string, number: number, patch: Partial<CardV1> = {}): CardV1 {
  return {
    id,
    number,
    title: `Card ${number}`,
    description: '',
    priority: 'normal',
    labels: [],
    blockedBy: [],
    parentId: null,
    status: 'todo',
    order: number * 1024,
    links: [],
    comments: [],
    activity: [],
    revision: 1,
    createdBy: { kind: 'person' },
    createdAt: '2026-09-28T10:00:00Z',
    updatedAt: '2026-09-28T10:00:00Z',
    ...patch,
  };
}

function board(cards: CardV1[], revision = 1): BoardV1 {
  return {
    workspaceId: WORKSPACE,
    enabled: true,
    settings: structuredClone(DEFAULT_BOARD_SETTINGS),
    cards,
    proposals: [],
    pendingStarts: [],
    nextNumber: cards.length + 1,
    revision,
    updatedAt: '2026-09-28T10:00:00Z',
  };
}

interface Deferred {
  resolve: (value: BoardResultV1) => void;
  reject: (error: unknown) => void;
}

/** A host whose `moveCard` waits until the test settles it; `get` answers with `current`. */
function fakeHost(initial: BoardV1) {
  let current = initial;
  const commands: BoardCommandV1[] = [];
  const pending: Deferred[] = [];
  let changed: ((event: BoardChangedEventV1) => void) | undefined;
  const client: BoardClient = {
    request(command) {
      commands.push(command);
      if (command.type === 'get') return Promise.resolve({ protocol: 1, type: 'board', board: structuredClone(current) });
      return new Promise<BoardResultV1>((resolve, reject) => pending.push({ resolve, reject }));
    },
    async onChanged(handler) {
      changed = handler;
      return () => undefined;
    },
  };
  return {
    client,
    commands,
    pending,
    set(next: BoardV1) {
      current = next;
    },
    emit(event: BoardChangedEventV1) {
      changed?.(event);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BoardStore', () => {
  it('moves a card at once and keeps the move when the host accepts it', async () => {
    const host = fakeHost(board([card('a', 1), card('b', 2)]));
    const store = new BoardStore(WORKSPACE, host.client);
    await store.load();

    const moving = store.moveCard('a', 'inProgress');
    expect(store.card('a')?.status).toBe('inProgress');
    expect(host.commands.at(-1)).toEqual({ type: 'moveCard', workspaceId: WORKSPACE, cardId: 'a', to: 'inProgress' });

    const moved = card('a', 1, { status: 'inProgress', order: 1024, revision: 2 });
    host.set(board([moved, card('b', 2)], 2));
    host.pending[0]?.resolve({ protocol: 1, type: 'card', card: moved, boardRevision: 2 });
    await moving;
    await flush();
    expect(store.card('a')).toMatchObject({ status: 'inProgress', revision: 2 });
    expect(store.board?.revision).toBe(2);
  });

  it('rolls a refused move back to its column and order and rethrows a typed error', async () => {
    const host = fakeHost(board([card('a', 1, { order: 3000 }), card('b', 2)]));
    const store = new BoardStore(WORKSPACE, host.client);
    await store.load();

    const moving = store.moveCard('a', 'done', 10);
    expect(store.card('a')).toMatchObject({ status: 'done', order: 10 });
    host.pending[0]?.reject({ code: 'SAFE_MODE', message: 'host text', recoverable: true });
    const error = await moving.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BoardError);
    expect((error as BoardError).code).toBe('SAFE_MODE');
    // Host text never reaches the UI.
    expect((error as BoardError).message).not.toContain('host text');
    expect(store.card('a')).toMatchObject({ status: 'todo', order: 3000 });
    expect(store.card('b')?.status).toBe('todo');
  });

  it('keeps a newer host change instead of the snapshot when rolling back', async () => {
    const host = fakeHost(board([card('a', 1), card('b', 2)]));
    const store = new BoardStore(WORKSPACE, host.client);
    await store.load();

    const moving = store.moveCard('a', 'inReview');
    // Another card changed on the host while the move was in flight.
    host.set(board([card('a', 1), card('b', 2, { title: 'Renamed' })], 2));
    store.board = { ...store.board!, cards: store.board!.cards.map((item) => (item.id === 'b' ? { ...item, title: 'Renamed' } : item)) };
    host.pending[0]?.reject({ code: 'REVISION_CONFLICT' });
    await moving.catch(() => undefined);
    expect(store.card('a')?.status).toBe('todo');
    expect(store.card('b')?.title).toBe('Renamed');
  });

  it('reloads on a newer change event and ignores older ones', async () => {
    const host = fakeHost(board([card('a', 1)], 3));
    const store = new BoardStore(WORKSPACE, host.client);
    await store.load();
    const gets = () => host.commands.filter((command) => command.type === 'get').length;
    expect(gets()).toBe(1);

    store.changed({ protocol: 1, workspaceId: WORKSPACE, revision: 3 });
    store.changed({ protocol: 1, workspaceId: 'other', revision: 9 });
    expect(gets()).toBe(1);

    host.set(board([card('a', 1, { title: 'Fresh' })], 4));
    store.changed({ protocol: 1, workspaceId: WORKSPACE, revision: 4 });
    await flush();
    expect(gets()).toBe(2);
    expect(store.card('a')?.title).toBe('Fresh');
  });

  it('refreshes after a revision conflict on an edit', async () => {
    const host = fakeHost(board([card('a', 1)]));
    const store = new BoardStore(WORKSPACE, host.client);
    await store.load();
    const target = store.card('a')!;
    const editing = store.updateCard(target, { title: 'New title' });
    expect(host.commands.at(-1)).toEqual({ type: 'updateCard', workspaceId: WORKSPACE, cardId: 'a', expectedRevision: 1, patch: { title: 'New title' } });
    host.pending[0]?.reject(JSON.stringify({ code: 'REVISION_CONFLICT', message: 'x', recoverable: true }));
    await expect(editing).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await flush();
    expect(host.commands.filter((command) => command.type === 'get')).toHaveLength(2);
  });
});
