import {
  composerCatalog,
  projectFiles,
  type ComposerCatalogResult,
  type ComposerFilesResult,
  type NativeCommand,
  type NativeSkill,
} from '../../../host-api/composerInputsClient';
import { errorMessage } from '../../workspaceStore.svelte';

/** Listings are reused briefly so typing does not walk the project again. */
const FILES_TTL_MS = 30_000;
const CATALOG_TTL_MS = 60_000;
const NARROW_DELAY_MS = 150;

interface Cached<T> {
  readonly at: number;
  readonly promise: Promise<T>;
}

function cached<T>(cache: Map<string, Cached<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < ttl) return entry.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

const fileListings = new Map<string, Cached<ComposerFilesResult>>();
const catalogs = new Map<string, Cached<ComposerCatalogResult>>();

/** Native `/` commands and `$` skills of a live session (shared, briefly cached). */
export function loadComposerCatalog(sessionId: string, refresh = false): Promise<ComposerCatalogResult> {
  if (refresh) catalogs.delete(sessionId);
  return cached(catalogs, sessionId, CATALOG_TTL_MS, () => composerCatalog(sessionId));
}

export interface NativeEntries {
  readonly commands: readonly NativeCommand[];
  readonly skills: readonly NativeSkill[];
}

/**
 * Project file names for `@` mentions. The first listing covers the whole
 * project; when the host had to cut it short, the typed text narrows a new
 * host walk (debounced) so deep files stay reachable.
 */
export class FileMentions {
  /** Candidates for the current query (ranked by the composer). */
  files = $state.raw<string[]>([]);
  loading = $state(false);
  error = $state('');
  private workspaceId = '';
  private base: ComposerFilesResult | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request = 0;

  update(workspaceId: string, query: string): void {
    if (workspaceId !== this.workspaceId) {
      this.workspaceId = workspaceId;
      this.base = undefined;
      this.files = [];
      this.error = '';
    }
    if (!workspaceId) return;
    const request = ++this.request;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.base === undefined) {
      this.loading = true;
      void this.load(workspaceId, '', request).then((listing) => {
        if (listing) this.base = listing;
        if (listing && request === this.request && listing.truncated && query.trim()) this.narrow(workspaceId, query, request);
      });
      return;
    }
    if (!this.base.truncated || !query.trim()) {
      this.files = this.base.files;
      this.loading = false;
      return;
    }
    this.narrow(workspaceId, query, request);
  }

  private narrow(workspaceId: string, query: string, request: number): void {
    this.loading = true;
    this.timer = setTimeout(() => void this.load(workspaceId, query, request), NARROW_DELAY_MS);
  }

  private async load(workspaceId: string, query: string, request: number): Promise<ComposerFilesResult | undefined> {
    try {
      const listing = await cached(fileListings, JSON.stringify([workspaceId, query]), FILES_TTL_MS, () => projectFiles(workspaceId, query));
      if (request === this.request) {
        this.files = listing.files;
        this.error = '';
        this.loading = false;
      }
      return listing;
    } catch (error) {
      if (request === this.request) {
        this.error = errorMessage(error);
        this.loading = false;
      }
      return undefined;
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.request += 1;
  }
}
