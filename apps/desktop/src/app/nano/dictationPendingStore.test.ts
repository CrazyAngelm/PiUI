import { describe, expect, it } from 'vitest';
import {
  PENDING_LIFETIME_MS,
  PendingRecordings,
  indexedDbPendingStorage,
  type PendingRecording,
  type PendingStorage,
} from './dictationPendingStore.svelte';

const NOW = 5_000_000_000;

function recording(scope: string, patch: Partial<PendingRecording> = {}): PendingRecording {
  return {
    id: `id-${scope}-${patch.createdAt ?? NOW}`,
    scope,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
    mimeType: 'audio/webm',
    durationMs: 61_000,
    createdAt: NOW,
    reason: 'failed',
    ...patch,
  };
}

/** A storage over a map; `broken` makes every call fail, as an unavailable IndexedDB does. */
function memoryStorage(initial: PendingRecording[] = []) {
  const rows = new Map(initial.map((item) => [item.scope, item]));
  const state = { broken: false, deleted: [] as string[] };
  const guard = (): void => {
    if (state.broken) throw new Error('storage unavailable');
  };
  const storage: PendingStorage = {
    load: async () => {
      guard();
      return [...rows.values()];
    },
    put: async (item) => {
      guard();
      rows.set(item.scope, item);
    },
    delete: async (scope) => {
      guard();
      state.deleted.push(scope);
      rows.delete(scope);
    },
  };
  return { storage, rows, state };
}

describe('pending recordings', () => {
  it('puts, gets and deletes a recording through the storage', async () => {
    const { storage, rows } = memoryStorage();
    const store = new PendingRecordings(storage, () => NOW);
    expect(store.get('chat:1')).toBeUndefined();
    const clip = recording('chat:1');
    await store.put(clip);
    expect(store.get('chat:1')).toBe(clip);
    expect(rows.get('chat:1')).toBe(clip);
    await store.remove('chat:1', clip.id);
    expect(store.get('chat:1')).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it('keeps one recording per scope and leaves other scopes alone', async () => {
    const { storage, rows } = memoryStorage();
    const store = new PendingRecordings(storage, () => NOW);
    await store.put(recording('chat:1', { reason: 'failed' }));
    await store.put(recording('new:personal'));
    const newer = recording('chat:1', { reason: 'unsent', createdAt: NOW + 1 });
    await store.put(newer);
    expect(store.get('chat:1')).toBe(newer);
    expect(store.get('new:personal')?.scope).toBe('new:personal');
    expect(rows.size).toBe(2);
  });

  it('removes only the clip it was asked to remove', async () => {
    const store = new PendingRecordings(undefined, () => NOW);
    const clip = recording('chat:1');
    await store.put(clip);
    await store.remove('chat:1', 'another-id');
    expect(store.get('chat:1')).toBe(clip);
    await store.remove('chat:1');
    expect(store.get('chat:1')).toBeUndefined();
  });

  it('purges entries older than 24 hours when the store is opened and keeps the rest', async () => {
    const old = recording('chat:old', { createdAt: NOW - PENDING_LIFETIME_MS - 1 });
    const edge = recording('chat:edge', { createdAt: NOW - PENDING_LIFETIME_MS });
    const fresh = recording('chat:fresh', { createdAt: NOW - PENDING_LIFETIME_MS + 1_000 });
    const { storage, rows, state } = memoryStorage([old, edge, fresh]);
    const store = new PendingRecordings(storage, () => NOW);
    await store.load();
    expect(store.get('chat:old')).toBeUndefined();
    expect(store.get('chat:edge')).toBeUndefined();
    expect(store.get('chat:fresh')).toBe(fresh);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect([...state.deleted].sort()).toEqual(['chat:edge', 'chat:old']);
    expect([...rows.keys()]).toEqual(['chat:fresh']);
  });

  it('reads the storage once on load, and again on refresh without losing what is in memory', async () => {
    const { storage, rows } = memoryStorage();
    const store = new PendingRecordings(storage, () => NOW);
    await store.load();
    rows.set('chat:other-window', recording('chat:other-window'));
    await store.load();
    expect(store.get('chat:other-window')).toBeUndefined();
    const mine = recording('chat:1', { reason: 'unsent' });
    await store.put(mine);
    rows.set('chat:1', recording('chat:1', { reason: 'failed', createdAt: NOW - 5 }));
    await store.refresh();
    expect(store.get('chat:other-window')).toBeDefined();
    expect(store.get('chat:1')).toBe(mine);
  });

  it('does not resurrect a clip consumed while its stored copy is read', async () => {
    const clip = recording('chat:1');
    const { storage } = memoryStorage([clip]);
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let deliver!: (clips: PendingRecording[]) => void;
    const delayedRead = new Promise<PendingRecording[]>((resolve) => { deliver = resolve; });
    let delay = false;
    const store = new PendingRecordings({
      ...storage,
      load: () => {
        if (!delay) return storage.load();
        began();
        return delayedRead;
      },
    }, () => NOW);
    await store.load();
    delay = true;
    const refresh = store.refresh();
    await started;
    const consumed = store.remove(clip.scope, clip.id);
    deliver([clip]);
    await Promise.all([refresh, consumed]);
    expect(store.get(clip.scope)).toBeUndefined();
  });

  it('ignores stored entries that are not recordings', async () => {
    const { storage, rows } = memoryStorage();
    rows.set('chat:bad', { scope: 'chat:bad', blob: 'not a blob' } as unknown as PendingRecording);
    const good = recording('chat:good');
    rows.set('chat:good', good);
    const store = new PendingRecordings(storage, () => NOW);
    await store.load();
    expect(store.get('chat:bad')).toBeUndefined();
    expect(store.get('chat:good')).toBe(good);
  });

  it('keeps recordings in memory when there is no storage', async () => {
    const store = new PendingRecordings(undefined, () => NOW);
    await store.load();
    const clip = recording('chat:1');
    await store.put(clip);
    expect(store.get('chat:1')).toBe(clip);
    await store.remove('chat:1');
    expect(store.get('chat:1')).toBeUndefined();
    expect(indexedDbPendingStorage(undefined)).toBeUndefined();
  });

  it('keeps a recording in memory when the storage fails', async () => {
    const { storage, state } = memoryStorage();
    state.broken = true;
    const store = new PendingRecordings(storage, () => NOW);
    await store.load();
    const clip = recording('chat:1');
    await expect(store.put(clip)).resolves.toBe(false);
    expect(store.get('chat:1')).toBe(clip);
    await expect(store.remove('chat:1')).resolves.toBeUndefined();
    expect(store.get('chat:1')).toBeUndefined();
  });
});

describe('pending recordings: order, expiry, durability, holds', () => {
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  it('ends with nothing stored when a remove follows a slow put', async () => {
    const rows = new Map<string, PendingRecording>();
    const storage: PendingStorage = {
      load: async () => [...rows.values()],
      put: async (item) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        rows.set(item.scope, item);
      },
      delete: async (scope) => void rows.delete(scope),
    };
    const store = new PendingRecordings(storage, () => NOW);
    const clip = recording('chat:1');
    const put = store.put(clip);
    const removed = store.remove('chat:1', clip.id);
    expect(store.get('chat:1')).toBeUndefined();
    await Promise.all([put, removed]);
    expect(rows.size).toBe(0);
  });

  it('hides an expired clip and removes it from memory and storage', async () => {
    const old = recording('chat:1', { createdAt: NOW - PENDING_LIFETIME_MS - 1 });
    const { storage, rows } = memoryStorage();
    const store = new PendingRecordings(storage, () => NOW);
    await store.put(old);
    expect(store.get('chat:1')).toBeUndefined();
    await settle();
    expect(store.visible('chat:1')).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it('deletes an expired stored entry even when memory holds the same clip', async () => {
    const old = recording('chat:1', { createdAt: NOW - PENDING_LIFETIME_MS - 1 });
    const { storage, rows } = memoryStorage([old]);
    const store = new PendingRecordings(storage, () => NOW);
    await store.put(old);
    await store.refresh();
    await settle();
    expect(rows.size).toBe(0);
  });

  it('keeps the stored entry of an expired clip when memory holds a different live clip', async () => {
    const old = recording('chat:1', { createdAt: NOW - PENDING_LIFETIME_MS - 1 });
    const { storage, rows, state } = memoryStorage([old]);
    const store = new PendingRecordings(storage, () => NOW);
    const live = recording('chat:1', { id: 'live' });
    void store.put(live);
    await store.refresh();
    await settle();
    expect(state.deleted).toEqual([]);
    expect(rows.get('chat:1')?.id).toBe('live');
  });

  it('says a clip is in memory only when there is no storage or the write fails, and clears it after a good write', async () => {
    const none = new PendingRecordings(undefined, () => NOW);
    expect(none.isVolatile('chat:1')).toBe(false);
    await expect(none.put(recording('chat:1'))).resolves.toBe(false);
    expect(none.isVolatile('chat:1')).toBe(true);
    await none.remove('chat:1');
    expect(none.isVolatile('chat:1')).toBe(false);

    const { storage, state } = memoryStorage();
    const store = new PendingRecordings(storage, () => NOW);
    state.broken = true;
    await expect(store.put(recording('chat:1'))).resolves.toBe(false);
    expect(store.isVolatile('chat:1')).toBe(true);
    expect(store.isVolatile('chat:2')).toBe(false);
    state.broken = false;
    await expect(store.put(recording('chat:1', { createdAt: NOW + 1 }))).resolves.toBe(true);
    expect(store.isVolatile('chat:1')).toBe(false);
  });

  it('replaces a clip only while it is still the one with that id', async () => {
    const { storage, rows } = memoryStorage();
    const store = new PendingRecordings(storage, () => NOW);
    const first = recording('chat:1', { id: 'first' });
    await store.put(first);
    await expect(store.replace('chat:1', 'first', { ...first, reason: 'empty' })).resolves.toBe(true);
    expect(rows.get('chat:1')?.reason).toBe('empty');
    const second = recording('chat:1', { id: 'second' });
    await store.put(second);
    await expect(store.replace('chat:1', 'first', { ...first, reason: 'failed' })).resolves.toBe(false);
    expect(store.get('chat:1')).toBe(second);
    await store.remove('chat:1', 'second');
    await expect(store.replace('chat:1', 'second', second)).resolves.toBe(false);
    expect(store.get('chat:1')).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it('does not offer a held clip but still returns it', async () => {
    const store = new PendingRecordings(undefined, () => NOW);
    const clip = recording('chat:1', { id: 'held' });
    await store.put(clip);
    store.hold('held');
    expect(store.visible('chat:1')).toBeUndefined();
    expect(store.get('chat:1')).toBe(clip);
    store.release('held');
    expect(store.visible('chat:1')).toBe(clip);
  });
});
