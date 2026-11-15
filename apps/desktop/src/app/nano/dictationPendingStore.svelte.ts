/**
 * Recordings that were not sent (ADR-066). A finished clip is never dropped
 * silently: when transcription fails, finds no speech, the clip is too large or
 * the recording is cut short, it stays here until the person sends it again,
 * saves it or deletes it. It lives in the WebView's own IndexedDB for at most
 * 24 hours and in memory when IndexedDB is unavailable. It leaves this device
 * only through the chosen dictation source or an explicit save.
 */

export type PendingReason = 'failed' | 'unsent' | 'empty' | 'too-large';

export interface PendingRecording {
  readonly id: string;
  /** The composer the clip belongs to: `chat:<sessionId>` or `new:<workspaceId or "personal">`. */
  readonly scope: string;
  readonly blob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly reason: PendingReason;
  /** English source copy of the last failure. */
  readonly error?: string;
}

/** A clip is kept this long. */
export const PENDING_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const PENDING_DATABASE = 'piui-dictation-pending';
export const PENDING_STORE = 'recordings';

/** Where clips are kept between runs; tests substitute a fake. One entry per scope. */
export interface PendingStorage {
  load(): Promise<PendingRecording[]>;
  put(recording: PendingRecording): Promise<void>;
  delete(scope: string): Promise<void>;
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** The pending store in IndexedDB, or undefined where there is none. */
export function indexedDbPendingStorage(factory: IDBFactory | undefined): PendingStorage | undefined {
  if (factory === undefined) return undefined;
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(PENDING_DATABASE, 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(PENDING_STORE)) opening.result.createObjectStore(PENDING_STORE, { keyPath: 'scope' });
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error('IndexedDB could not be opened'));
      opening.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
    // A failed open is tried again by the next call.
    opened.catch(() => (opened = undefined));
    return opened;
  };
  return {
    async load() {
      const database = await open();
      return (await request(database.transaction(PENDING_STORE, 'readonly').objectStore(PENDING_STORE).getAll())) as PendingRecording[];
    },
    async put(recording) {
      const transaction = (await open()).transaction(PENDING_STORE, 'readwrite');
      transaction.objectStore(PENDING_STORE).put(recording);
      await finished(transaction);
    },
    async delete(scope) {
      const transaction = (await open()).transaction(PENDING_STORE, 'readwrite');
      transaction.objectStore(PENDING_STORE).delete(scope);
      await finished(transaction);
    },
  };
}

/** A fresh id for a recording. */
export function newRecordingId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function wellFormed(value: unknown): value is PendingRecording {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<Record<keyof PendingRecording, unknown>>;
  return (
    typeof item.id === 'string' &&
    typeof item.scope === 'string' &&
    item.blob instanceof Blob &&
    typeof item.mimeType === 'string' &&
    typeof item.durationMs === 'number' &&
    typeof item.createdAt === 'number' &&
    (item.reason === 'failed' || item.reason === 'unsent' || item.reason === 'empty' || item.reason === 'too-large')
  );
}

/**
 * The unsent recordings, one per composer scope. A change shows at once in
 * memory; saving it to the storage follows, in the order the changes were made
 * (one chain of writes, so a delete is never overtaken by an earlier put).
 * When the storage is missing or fails, the clip stays in memory for this run
 * and `isVolatile` says so.
 */
export class PendingRecordings {
  private items = $state.raw<Readonly<Record<string, PendingRecording>>>({});
  /** Scopes whose current clip is in memory only. */
  private volatileScopes = $state.raw<ReadonlySet<string>>(new Set());
  /** Ids of clips a window is recording or sending right now. */
  private heldIds = $state.raw<ReadonlySet<string>>(new Set());
  private loading: Promise<void> | undefined;
  /** Every storage write waits for the one before it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: PendingStorage | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The recording waiting in a scope, if any, held or not. A clip older than
   * its lifetime is not returned and is forgotten (in a microtask: callers read
   * this inside derived values, which must not change state).
   */
  get(scope: string): PendingRecording | undefined {
    const item = this.items[scope];
    if (item === undefined) return undefined;
    if (this.expired(item)) {
      queueMicrotask(() => void this.remove(scope, item.id));
      return undefined;
    }
    return item;
  }

  /** The recording of a scope unless a window is still recording or sending it. */
  visible(scope: string): PendingRecording | undefined {
    const item = this.get(scope);
    return item === undefined || this.heldIds.has(item.id) ? undefined : item;
  }

  /** True while the scope's current clip is in memory only: no storage, or the last write failed. */
  isVolatile(scope: string): boolean {
    return this.volatileScopes.has(scope);
  }

  /** Marks a clip as in use by a window: `visible` does not offer it. */
  hold(id: string): void {
    if (!this.heldIds.has(id)) this.heldIds = new Set(this.heldIds).add(id);
  }

  release(id: string): void {
    if (!this.heldIds.has(id)) return;
    const next = new Set(this.heldIds);
    next.delete(id);
    this.heldIds = next;
  }

  /** Reads the storage once; expired entries are purged then. Never rejects. */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  /** Reads the storage again, so clips another window left appear; what is in memory wins. */
  refresh(): Promise<void> {
    this.loading = this.read();
    return this.loading;
  }

  /**
   * Keeps a recording for its scope, replacing an older one. Resolves to true
   * when the clip reached the storage, false when there is none or the write
   * failed (the clip stays in memory then).
   */
  async put(recording: PendingRecording): Promise<boolean> {
    this.items = { ...this.items, [recording.scope]: recording };
    const storage = this.storage;
    const stored = storage === undefined ? false : await this.write(() => storage.put(recording));
    // A clip that was replaced or removed meanwhile owns the flag, not this write.
    if (this.items[recording.scope]?.id === recording.id) this.setVolatile(recording.scope, !stored);
    return stored;
  }

  /** Writes a recording only while its scope still holds the clip with this id; otherwise does nothing and resolves false. */
  async replace(scope: string, id: string, recording: PendingRecording): Promise<boolean> {
    if (this.items[scope]?.id !== id) return false;
    return this.put(recording);
  }

  /** Forgets the recording of a scope, but only when it is still this one. */
  async remove(scope: string, id: string | undefined = undefined): Promise<void> {
    const current = this.items[scope];
    if (current === undefined || (id !== undefined && current.id !== id)) return;
    const rest = { ...this.items };
    delete rest[scope];
    this.items = rest;
    this.setVolatile(scope, false);
    const storage = this.storage;
    // A failed delete leaves the entry to expire with its 24 hours.
    if (storage !== undefined) await this.write(() => storage.delete(scope));
  }

  private expired(item: PendingRecording): boolean {
    return item.createdAt <= this.now() - PENDING_LIFETIME_MS;
  }

  private setVolatile(scope: string, on: boolean): void {
    if (this.volatileScopes.has(scope) === on) return;
    const next = new Set(this.volatileScopes);
    if (on) next.add(scope);
    else next.delete(scope);
    this.volatileScopes = next;
  }

  private write(task: () => Promise<void>): Promise<boolean> {
    const run = this.chain.then(async () => {
      try {
        await task();
        return true;
      } catch {
        return false;
      }
    });
    this.chain = run;
    return run;
  }

  private async read(): Promise<void> {
    const storage = this.storage;
    if (storage === undefined) return;
    let stored: PendingRecording[];
    try {
      stored = (await storage.load()).filter(wellFormed);
    } catch {
      return;
    }
    const next: Record<string, PendingRecording> = {};
    for (const recording of stored) {
      if (this.expired(recording)) {
        // A newer live clip of this scope that is in memory owns the entry; anything else expires.
        const mine = this.items[recording.scope];
        const superseded = mine !== undefined && mine.id !== recording.id && !this.expired(mine);
        if (!superseded) void this.write(() => storage.delete(recording.scope));
        continue;
      }
      next[recording.scope] = recording;
    }
    this.items = { ...next, ...this.items };
  }
}

/** The shared store of this window. */
export const dictationPending = new PendingRecordings(indexedDbPendingStorage(typeof indexedDB === 'undefined' ? undefined : indexedDB));
