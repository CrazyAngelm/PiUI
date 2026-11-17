import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFileV1 } from '../../../host-api/chatFilesClient';

const client = vi.hoisted(() => ({
  listChatFiles: vi.fn(),
  chatFileBlob: vi.fn(),
  openChatFile: vi.fn(),
  revealChatFile: vi.fn(),
  saveChatFile: vi.fn(),
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

beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
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

describe('ChatFilesStore previews', () => {
  it('makes one blob URL per file, two transfers at a time, and revokes them all on dispose', async () => {
    client.listChatFiles.mockResolvedValue([]);
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
    const store = new ChatFilesStore();
    store.bind('session-1');
    const a = store.resolve('a');
    const again = store.resolve('a');
    const b = store.resolve('b');
    const c = store.resolve('c');
    await settle();
    expect(peak).toBe(2);
    expect([...transfers.keys()]).toEqual(['a', 'b']);
    transfers.get('a')?.resolve(new Blob(['a']));
    await expect(a).resolves.toEqual({ src: 'blob:lab/0' });
    await expect(again).resolves.toEqual({ src: 'blob:lab/0' });
    await settle();
    expect([...transfers.keys()]).toEqual(['a', 'b', 'c']);
    transfers.get('b')?.resolve(new Blob(['b']));
    transfers.get('c')?.resolve(new Blob(['c']));
    await expect(Promise.all([b, c])).resolves.toHaveLength(2);
    expect(client.chatFileBlob).toHaveBeenCalledTimes(3);
    expect(created).toHaveLength(3);
    // A second ask for the same file reuses the URL.
    await expect(store.resolve('b')).resolves.toEqual({ src: 'blob:lab/1' });
    expect(client.chatFileBlob).toHaveBeenCalledTimes(3);
    expect(revoked).toEqual([]);

    store.dispose();
    await settle();
    expect(revoked.sort()).toEqual(['blob:lab/0', 'blob:lab/1', 'blob:lab/2']);
    await expect(store.resolve('a')).rejects.toBeInstanceOf(Error);
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

    client.chatFileBlob.mockRejectedValueOnce(new Error('CHAT_FILE_UNAVAILABLE'));
    await expect(store.resolve('b')).rejects.toBeInstanceOf(Error);
    await settle();
    client.chatFileBlob.mockResolvedValueOnce(new Blob(['b']));
    await expect(store.resolve('b')).resolves.toEqual({ src: 'blob:lab/0' });
    expect(client.chatFileBlob).toHaveBeenLastCalledWith('session-2', 'b');
  });
});

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
