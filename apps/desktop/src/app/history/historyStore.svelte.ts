import { acceptsCatalogSnapshot } from '../../features/sessions/catalogView';
import {
  isCatalogForScope,
  piHistoryError,
  type PiHistoryClient,
  type PiHistoryScope,
} from '../../host-api/piHistoryClient';
import type { SessionCatalogEvent, SessionCatalogSnapshot, SessionRootHint, SessionSummary } from '../../host-api/types';
import {
  emptyReader,
  filterSessions,
  mergeOlderPage,
  readerFromLatestPage,
  scopeKey,
  searchableQuery,
  type HistoryReader,
} from './piHistory';

export interface HistoryTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: HistoryTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Watcher hints are lossy and bursty; one reconciliation follows a quiet period. */
const ROOT_HINT_DELAY_MS = 250;
const SEARCH_DELAY_MS = 150;

const REFRESH_FAILED = 'Could not refresh. Showing the last indexed sessions.';
const SELECTION_GONE = 'The selected session is no longer in the local index.';
const SESSION_CHANGED = 'The session changed on disk. Showing its latest entries.';
/** Notices the view translates; exported for the locale coverage test. */
export const HISTORY_NOTICES = [REFRESH_FAILED, SELECTION_GONE, SESSION_CHANGED] as const;

function messageOf(error: unknown): string {
  return piHistoryError(error).message;
}

/**
 * Screen-local state of the read-only history browser: one scope (a project
 * folder or personal chats), its cached-then-reconciled catalog, the selected
 * session's paged transcript and an optional search across other folders.
 * Every request carries an epoch so a late response never renders a scope or
 * session the reader already left.
 */
export class PiHistoryStore {
  scope = $state.raw<PiHistoryScope | undefined>();
  catalog = $state.raw<SessionCatalogSnapshot | undefined>();
  loadingCatalog = $state(false);
  refreshing = $state(false);
  catalogError = $state<string | undefined>();
  refreshError = $state<string | undefined>();
  notice = $state<string | undefined>();
  selectedId = $state<string | undefined>();
  reader = $state.raw<HistoryReader | undefined>();
  query = $state('');
  searchResults = $state.raw<SessionSummary[]>([]);
  searchBusy = $state(false);
  searchError = $state<string | undefined>();

  private scopeEpoch = 0;
  private ownRefresh = false;
  private readerEpoch = 0;
  private searchEpoch = 0;
  private searchTimer: unknown;
  private hintTimer: unknown;
  private hintPending = false;
  private unlisten: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly client: PiHistoryClient,
    private readonly timers: HistoryTimers = browserTimers,
  ) {}

  get sessions(): SessionSummary[] {
    return filterSessions(this.catalog?.sessions ?? [], this.query);
  }

  get selected(): SessionSummary | undefined {
    return this.catalog?.sessions.find((session) => session.id === this.selectedId);
  }

  /** Subscribes to catalog events and watcher hints; snapshots stay the recovery path. */
  async start(): Promise<void> {
    try {
      const stops = await Promise.all([
        this.client.listenCatalog((event) => this.applyCatalogEvent(event)),
        this.client.listenRootHints((hint) => this.applyRootHint(hint)),
      ]);
      if (this.disposed) stops.forEach((stop) => stop());
      else this.unlisten = stops;
    } catch {
      // Explicit refresh remains available without live events.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten.forEach((stop) => stop());
    this.unlisten = [];
    if (this.searchTimer !== undefined) this.timers.clearTimeout(this.searchTimer);
    if (this.hintTimer !== undefined) this.timers.clearTimeout(this.hintTimer);
  }

  /** Paints the cached catalog, then reconciles; selects `sessionId` when given. */
  async open(scope: PiHistoryScope, sessionId: string | undefined = undefined): Promise<void> {
    const changed = this.scope === undefined || scopeKey(this.scope) !== scopeKey(scope);
    if (changed) {
      this.scopeEpoch += 1;
      this.readerEpoch += 1;
      this.scope = scope;
      this.catalog = undefined;
      this.catalogError = undefined;
      this.refreshError = undefined;
      this.notice = undefined;
      this.selectedId = undefined;
      this.reader = undefined;
      this.refreshing = false;
      this.ownRefresh = false;
      this.setQuery('');
      const epoch = this.scopeEpoch;
      this.loadingCatalog = true;
      try {
        const snapshot = await this.client.catalog(scope);
        if (epoch !== this.scopeEpoch) return;
        this.acceptSnapshot(snapshot);
      } catch (error) {
        if (epoch !== this.scopeEpoch) return;
        this.catalogError = messageOf(error);
      } finally {
        if (epoch === this.scopeEpoch) this.loadingCatalog = false;
      }
      void this.refresh();
    }
    if (sessionId !== undefined && sessionId !== this.selectedId) await this.select(sessionId);
  }

  async refresh(): Promise<void> {
    const scope = this.scope;
    // Event-driven "refreshing" never blocks an explicit request; only our own does.
    if (scope === undefined || this.ownRefresh) return;
    const epoch = this.scopeEpoch;
    this.ownRefresh = true;
    this.refreshing = true;
    this.refreshError = undefined;
    try {
      const snapshot = await this.client.refresh(scope);
      if (epoch !== this.scopeEpoch) return;
      this.catalogError = undefined;
      this.acceptSnapshot(snapshot);
      if (snapshot.freshness === 'degraded') this.refreshError = REFRESH_FAILED;
    } catch (error) {
      if (epoch !== this.scopeEpoch) return;
      // The cached catalog stays visible; the error is local to the list.
      this.refreshError = this.catalog === undefined ? messageOf(error) : REFRESH_FAILED;
    } finally {
      if (epoch === this.scopeEpoch) {
        this.ownRefresh = false;
        this.refreshing = false;
      }
    }
  }

  async select(sessionId: string): Promise<void> {
    const scope = this.scope;
    if (scope === undefined) return;
    const epoch = ++this.readerEpoch;
    this.selectedId = sessionId;
    this.notice = undefined;
    this.reader = emptyReader(sessionId);
    try {
      const page = await this.client.page(scope, sessionId, undefined);
      if (epoch !== this.readerEpoch) return;
      this.reader = page.staleCursor
        ? { ...emptyReader(sessionId), loading: false, error: SESSION_CHANGED }
        : readerFromLatestPage(page);
    } catch (error) {
      if (epoch !== this.readerEpoch) return;
      this.reader = { ...emptyReader(sessionId), loading: false, error: messageOf(error) };
    }
  }

  /** Reloads the latest page of the selected session (explicit retry or a changed file). */
  async reload(): Promise<void> {
    if (this.selectedId !== undefined) await this.select(this.selectedId);
  }

  async loadOlder(): Promise<void> {
    const scope = this.scope;
    const reader = this.reader;
    if (scope === undefined || reader === undefined || reader.olderCursor === undefined || reader.loadingOlder || reader.loading) return;
    const epoch = this.readerEpoch;
    this.reader = { ...reader, loadingOlder: true, error: undefined };
    try {
      const page = await this.client.page(scope, reader.sessionId, reader.olderCursor);
      if (epoch !== this.readerEpoch || this.reader === undefined) return;
      const outcome = mergeOlderPage(this.reader, page);
      if (outcome.type === 'stale') {
        await this.select(reader.sessionId);
        if (this.selectedId === reader.sessionId) this.notice = SESSION_CHANGED;
        return;
      }
      this.reader = outcome.reader;
    } catch (error) {
      if (epoch !== this.readerEpoch || this.reader === undefined) return;
      // Loaded entries stay on screen; only the older page failed.
      this.reader = { ...this.reader, loadingOlder: false, error: messageOf(error) };
    }
  }

  clearSelection(): void {
    this.readerEpoch += 1;
    this.selectedId = undefined;
    this.reader = undefined;
  }

  /** Filters this scope at once and searches other folders after a short pause. */
  setQuery(query: string): void {
    this.query = query;
    const epoch = ++this.searchEpoch;
    if (this.searchTimer !== undefined) this.timers.clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    const normalized = searchableQuery(query);
    if (normalized === undefined) {
      this.searchResults = [];
      this.searchBusy = false;
      this.searchError = undefined;
      return;
    }
    this.searchBusy = true;
    this.searchError = undefined;
    this.searchTimer = this.timers.setTimeout(() => {
      this.searchTimer = undefined;
      void this.runSearch(normalized, epoch);
    }, SEARCH_DELAY_MS);
  }

  /** Matches from other folders; this scope's own rows are already filtered locally. */
  get otherResults(): SessionSummary[] {
    const scope = this.scope;
    const own = new Set((this.catalog?.sessions ?? []).map((session) => session.id));
    return this.searchResults.filter((result) =>
      result.projectId !== undefined
      && !(scope?.kind === 'project' && result.projectId === scope.projectId && own.has(result.id)),
    );
  }

  private async runSearch(query: string, epoch: number): Promise<void> {
    try {
      const results = await this.client.search(query);
      if (epoch !== this.searchEpoch) return;
      this.searchResults = results;
    } catch (error) {
      if (epoch !== this.searchEpoch) return;
      this.searchResults = [];
      this.searchError = messageOf(error);
    } finally {
      if (epoch === this.searchEpoch) this.searchBusy = false;
    }
  }

  private acceptSnapshot(snapshot: SessionCatalogSnapshot): void {
    const scope = this.scope;
    if (scope === undefined || !isCatalogForScope(snapshot, scope) || !acceptsCatalogSnapshot(this.catalog, snapshot)) return;
    this.catalog = snapshot;
    const selected = this.selectedId;
    if (selected !== undefined && !snapshot.sessions.some((session) => session.id === selected)) {
      // A refresh never silently swaps in another transcript.
      this.clearSelection();
      this.notice = SELECTION_GONE;
    }
  }

  private applyCatalogEvent(event: SessionCatalogEvent): void {
    const scope = this.scope;
    if (scope === undefined) return;
    const matches = (eventScope: 'project' | 'personal', projectId: string | undefined) =>
      scope.kind === 'personal' ? eventScope === 'personal' : eventScope === 'project' && projectId === scope.projectId;
    switch (event.kind) {
      case 'refreshStarted':
        if (matches(event.scope, event.projectId) && event.sequence > (this.catalog?.sequence ?? 0)) this.refreshing = true;
        return;
      case 'snapshot':
        if (matches(event.snapshot.scope, event.snapshot.projectId)) {
          this.acceptSnapshot(event.snapshot);
          this.refreshing = false;
        }
        return;
      case 'refreshFailed':
        if (matches(event.scope, event.projectId) && event.sequence >= (this.catalog?.sequence ?? 0)) {
          this.refreshing = false;
          this.refreshError = REFRESH_FAILED;
        }
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  private applyRootHint(hint: SessionRootHint): void {
    if (hint.kind === 'unavailable' || this.scope === undefined) return;
    this.hintPending = true;
    if (this.hintTimer !== undefined) this.timers.clearTimeout(this.hintTimer);
    this.hintTimer = this.timers.setTimeout(() => {
      this.hintTimer = undefined;
      if (!this.hintPending || this.disposed) return;
      this.hintPending = false;
      void this.refresh();
    }, hint.kind === 'overflow' ? 0 : ROOT_HINT_DELAY_MS);
  }
}
