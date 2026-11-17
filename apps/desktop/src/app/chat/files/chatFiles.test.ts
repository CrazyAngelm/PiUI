import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFileV1 } from '../../../host-api/chatFilesClient';

const client = vi.hoisted(() => ({
  listChatFiles: vi.fn(),
  chatFileBlob: vi.fn(),
  openChatFile: vi.fn(),
  revealChatFile: vi.fn(),
  saveChatFile: vi.fn(),
  listenChatFilesChanged: vi.fn(),
  CHAT_FILE_MAX_MEDIA_PREVIEW_BYTES: 64 * 1024 * 1024,
}));
vi.mock('../../../host-api/chatFilesClient', () => client);
import { ChatFilesStore } from './chatFiles.svelte';

function file(id: string, patch: Partial<ChatFileV1> = {}): ChatFileV1 {
  return { id, blockId: 'block-1', name: `${id}.png`, kind: 'image', origin: 'generated', openable: true, previewable: true, revealable: true, ...patch };
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

let created: string[];
let revoked: string[];

/** The host's "files changed" handler the store registered, and the stop function it was given. */
let changed: ((sessionId: string) => void) | undefined;
let stopListening: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const mock of Object.values(client)) if (typeof mock === 'function') mock.mockReset();
  changed = undefined;
  stopListening = vi.fn();
  client.listenChatFilesChanged.mockImplementation(async (handler: (sessionId: string) => void) => {
    changed = handler;
    return stopListening;
  });
  created = [];
  revoked = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:lab/${created.length}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ChatFilesStore listing', () => {
  it('lists the files of the bound chat once and keeps its array while nothing changed', async () => {
    client.listChatFiles.mockResolvedValue([file('a')]);
    const store = new ChatFilesStore();
    store.bind('session-1');
    store.bind('session-1');
    await vi.waitFor(() => expect(store.files.map((item) => item.id)).toEqual(['a']));
    expect(client.listChatFiles).toHaveBeenCalledTimes(1);
    expect(client.listChatFiles).toHaveBeenCalledWith('session-1');
    const shown = store.files;
    await store.refresh();
    expect(store.files).toBe(shown);
    client.listChatFiles.mockResolvedValue([file('a'), file('b')]);
    await store.refresh();
    expect(store.files.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('shares one request among a burst of refreshes and asks once more afterwards', async () => {
    const first = deferred<ChatFileV1[]>();
    client.listChatFiles.mockReturnValueOnce(first.promise).mockResolvedValue([file('a'), file('b')]);
    const store = new ChatFilesStore();
    store.bind('session-1');
    void store.refresh();
    void store.refresh();
    expect(client.listChatFiles).toHaveBeenCalledTimes(1);
    first.resolve([file('a')]);
    await vi.waitFor(() => expect(client.listChatFiles).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.files.map((item) => item.id)).toEqual(['a', 'b']));
  });

  it('keeps what is shown when a listing fails and drops a reply for a chat that was left', async () => {
    client.listChatFiles.mockResolvedValueOnce([file('a')]);
    const store = new ChatFilesStore();
    store.bind('session-1');
    await vi.waitFor(() => expect(store.files).toHaveLength(1));
    client.listChatFiles.mockRejectedValueOnce(new Error('SAFE_MODE'));
    await store.refresh();
    expect(store.files).toHaveLength(1);

    const late = deferred<ChatFileV1[]>();
    client.listChatFiles.mockReturnValueOnce(late.promise);
    void store.refresh();
    client.listChatFiles.mockResolvedValue([file('other')]);
    store.bind('session-2');
    expect(store.files).toEqual([]);
    late.resolve([file('stale')]);
    await vi.waitFor(() => expect(store.files.map((item) => item.id)).toEqual(['other']));
  });

  it('waits for a burst of events before asking the host', async () => {
    vi.useFakeTimers();
    client.listChatFiles.mockResolvedValue([]);
    const store = new ChatFilesStore();
    store.bind('session-1');
    await vi.advanceTimersByTimeAsync(0);
    client.listChatFiles.mockClear();
    store.scheduleRefresh();
    store.scheduleRefresh();
    store.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(399);
    expect(client.listChatFiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(client.listChatFiles).toHaveBeenCalledTimes(1);
    store.dispose();
    store.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.listChatFiles).toHaveBeenCalledTimes(1);
  });
});

describe('ChatFilesStore live listing', () => {
  it('lists again, once, when the host says the bound chat\'s files changed', async () => {
    vi.useFakeTimers();
    client.listChatFiles.mockResolvedValue([]);
    const store = new ChatFilesStore();
    store.bind('session-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toBeDefined();
    client.listChatFiles.mockClear();
    client.listChatFiles.mockResolvedValue([file('late')]);
    // Another chat's event changes nothing; a burst of this chat's makes one listing.
    changed?.('session-2');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.listChatFiles).not.toHaveBeenCalled();
    changed?.('session-1');
    changed?.('session-1');
    await vi.advanceTimersByTimeAsync(500);
    expect(client.listChatFiles).toHaveBeenCalledTimes(1);
    expect(store.files.map((item) => item.id)).toEqual(['late']);
    // The listener lives as long as the store: another chat, then the end.
    store.bind('session-2');
    expect(client.listenChatFilesChanged).toHaveBeenCalledTimes(1);
    store.dispose();
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it('keeps working when the host has no event route', async () => {
    client.listenChatFilesChanged.mockRejectedValue(new Error('no transport'));
    client.listChatFiles.mockResolvedValue([file('a')]);
    const store = new ChatFilesStore();
    store.bind('session-1');
    await vi.waitFor(() => expect(store.files.map((item) => item.id)).toEqual(['a']));
  });
});

describe('ChatFilesStore previews', () => {
  const sized = (...ids: string[]): ChatFileV1[] => ids.map((id) => file(id, { size: 1_000 }));
  async function bound(files: ChatFileV1[]): Promise<ChatFilesStore> {
    client.listChatFiles.mockResolvedValue(files);
    const store = new ChatFilesStore();
    store.bind('session-1');
    await vi.waitFor(() => expect(store.files).toHaveLength(files.length));
    return store;
  }

  it('makes one blob URL per file, three transfers at a time, and revokes them all on dispose', async () => {
    const transfers = new Map<string, ReturnType<typeof deferred<Blob>>>();
    let running = 0;
    let peak = 0;
    client.chatFileBlob.mockImplementation(async (_session: string, id: string) => {
      const transfer = deferred<Blob>();
      transfers.set(id, transfer);
      running += 1;
      peak = Math.max(peak, running);
      try {
        return await transfer.promise;
      } finally {
        running -= 1;
      }
    });
    const store = await bound(sized('a', 'b', 'c', 'd'));
    const a = store.resolve('a');
    const again = store.resolve('a');
    const b = store.resolve('b');
    const c = store.resolve('c');
    const d = store.resolve('d');
    await settle();
    expect(peak).toBe(3);
    expect([...transfers.keys()]).toEqual(['a', 'b', 'c']);
    transfers.get('a')?.resolve(new Blob(['a']));
    await expect(a).resolves.toMatchObject({ src: 'blob:lab/0' });
    await expect(again).resolves.toMatchObject({ src: 'blob:lab/0' });
    await settle();
    expect([...transfers.keys()]).toEqual(['a', 'b', 'c', 'd']);
    for (const id of ['b', 'c', 'd']) transfers.get(id)?.resolve(new Blob([id]));
    await expect(Promise.all([b, c, d])).resolves.toHaveLength(3);
    expect(client.chatFileBlob).toHaveBeenCalledTimes(4);
    expect(created).toHaveLength(4);
    // A second ask for the same file reuses the URL.
    await expect(store.resolve('b')).resolves.toMatchObject({ src: 'blob:lab/1' });
    expect(client.chatFileBlob).toHaveBeenCalledTimes(4);
    expect(revoked).toEqual([]);

    store.dispose();
    await settle();
    expect(revoked.sort()).toEqual(['blob:lab/0', 'blob:lab/1', 'blob:lab/2', 'blob:lab/3']);
    await expect(store.resolve('a')).rejects.toBeInstanceOf(Error);
  });

  it('reserves a file\'s listed size before it asks for the bytes and refuses beyond the chat\'s budget', async () => {
    const half = Math.floor(store0Limit() / 2);
    const transfers: ReturnType<typeof deferred<Blob>>[] = [];
    client.chatFileBlob.mockImplementation(() => {
      const transfer = deferred<Blob>();
      transfers.push(transfer);
      return transfer.promise;
    });
    const store = await bound([file('a', { size: half }), file('b', { size: half }), file('c', { size: half })]);
    const a = store.resolve('a');
    const b = store.resolve('b');
    await settle();
    expect(store.gate.heldBytes).toBe(half * 2);
    // The third does not fit: refused before any transfer.
    await expect(store.resolve('c')).rejects.toBeInstanceOf(Error);
    expect(client.chatFileBlob).toHaveBeenCalledTimes(2);
    expect(store.gate.heldBytes).toBe(half * 2);
    // The reservation settles to the bytes that arrived: a file smaller than listed gives the rest back,
    // and then the third fits.
    transfers[0]?.resolve(new Blob(['x']));
    transfers[1]?.resolve(new Blob(['y']));
    await Promise.all([a, b]);
    expect(store.gate.heldBytes).toBe(2);
    const c = store.resolve('c');
    await settle();
    transfers[2]?.resolve(new Blob(['z']));
    await c;
    expect(store.gate.heldBytes).toBe(3);
  });

  it('lets a preview go when its last card does, gives the budget back and fetches it again when it is shown once more', async () => {
    client.chatFileBlob.mockImplementation(async () => new Blob(['x']));
    const store = await bound(sized('a'));
    const first = await store.resolve('a');
    const second = await store.resolve('a');
    expect(created).toHaveLength(1);
    expect(store.gate.heldBytes).toBe(1);
    // Two cards show the same file: the first to leave does not take the picture from the other.
    first.release?.();
    first.release?.();
    expect(revoked).toEqual([]);
    expect(store.gate.heldBytes).toBe(1);
    second.release?.();
    await settle();
    expect(revoked).toEqual(['blob:lab/0']);
    expect(store.gate.heldBytes).toBe(0);
    // Shown again: the bytes come again, under a new URL.
    await expect(store.resolve('a')).resolves.toMatchObject({ src: 'blob:lab/1' });
    expect(client.chatFileBlob).toHaveBeenCalledTimes(2);
    expect(store.gate.heldBytes).toBe(1);
  });

  it('gives the reservation back when a transfer fails and when the file turned out bigger than listed', async () => {
    const store = await bound([file('a', { size: 10 })]);
    client.chatFileBlob.mockRejectedValueOnce(new Error('CHAT_FILE_UNAVAILABLE'));
    await expect(store.resolve('a')).rejects.toBeInstanceOf(Error);
    await settle();
    expect(store.gate.heldBytes).toBe(0);
    client.chatFileBlob.mockResolvedValueOnce(new Blob(['x'.repeat(40)]));
    const grown = await store.resolve('a');
    expect(grown.src).toMatch(/^blob:/);
    expect(store.gate.heldBytes).toBe(40);
  });

  it('never keeps bytes that arrive after the chat was closed and retries a failed preview', async () => {
    client.listChatFiles.mockResolvedValue([]);
    const transfer = deferred<Blob>();
    client.chatFileBlob.mockReturnValueOnce(transfer.promise);
    const store = new ChatFilesStore();
    store.bind('session-1');
    const preview = store.resolve('a');
    await settle();
    store.bind('session-2');
    transfer.resolve(new Blob(['late']));
    await expect(preview).rejects.toBeInstanceOf(Error);
    expect(created).toEqual([]);
    expect(store.gate.heldBytes).toBe(0);

    client.chatFileBlob.mockRejectedValueOnce(new Error('CHAT_FILE_UNAVAILABLE'));
    await expect(store.resolve('b')).rejects.toBeInstanceOf(Error);
    await settle();
    client.chatFileBlob.mockResolvedValueOnce(new Blob(['b']));
    await expect(store.resolve('b')).resolves.toMatchObject({ src: 'blob:lab/0' });
    expect(client.chatFileBlob).toHaveBeenLastCalledWith('session-2', 'b');
  });
});

/** The chat's media budget (a fresh store's gate). */
function store0Limit(): number {
  return new ChatFilesStore().gate.limit;
}

describe('ChatFilesStore actions', () => {
  it('sends the open, save as and reveal actions to the bound chat', async () => {
    client.listChatFiles.mockResolvedValue([]);
    client.saveChatFile.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const store = new ChatFilesStore();
    store.bind('session-1');
    await store.open('a');
    await store.reveal('b');
    await expect(store.save('c')).resolves.toBe(true);
    await expect(store.save('c')).resolves.toBe(false);
    expect(client.openChatFile).toHaveBeenCalledWith('session-1', 'a');
    expect(client.revealChatFile).toHaveBeenCalledWith('session-1', 'b');
    expect(client.saveChatFile).toHaveBeenCalledWith('session-1', 'c');
    client.openChatFile.mockRejectedValueOnce(new Error('CHAT_FILE_OPEN_REFUSED'));
    await expect(store.open('d')).rejects.toBeInstanceOf(Error);
  });
});
