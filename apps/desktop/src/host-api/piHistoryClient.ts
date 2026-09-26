import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import type {
  SessionCatalogEvent,
  SessionCatalogSnapshot,
  SessionRootHint,
  SessionSummary,
  TimelinePage,
} from './types';

/**
 * Read-only native Pi (and Prime Agent) session history from PiUI's
 * rebuildable index. These are the host commands the classic view used; the
 * new shell reaches them through the transport so the UI Lab answers them too.
 * Nothing here starts a runtime or writes a session file: the index only
 * scans JSONL that the native harness owns.
 */
export type PiHistoryScope = { readonly kind: 'project'; readonly projectId: string } | { readonly kind: 'personal' };

export const SESSION_CATALOG_CHANNEL = 'piui://session-catalog';
export const SESSION_ROOT_HINT_CHANNEL = 'piui://session-root-hint';

export const PI_HISTORY_MESSAGES: Readonly<Record<string, string>> = {
  NOT_FOUND: 'This history is no longer in the local index. Refresh the list.',
  PROJECT_UNAVAILABLE: 'The folder is unavailable. Reconnect it, then refresh.',
  CONFLICT: 'This folder changed on disk. Add it again and confirm trust before continuing.',
  INVALID_ARGUMENT: 'PiUI could not read this part of the history. Refresh and try again.',
};
export const FALLBACK_MESSAGE = 'Local session history could not be read. Try again.';

export class PiHistoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PiHistoryError';
  }
}

/** Maps a host rejection to a fixed, translatable message; raw payloads never reach the UI. */
export function piHistoryError(cause: unknown): PiHistoryError {
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const code = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' ? value.code : 'UNKNOWN';
  return new PiHistoryError(code, PI_HISTORY_MESSAGES[code] ?? FALLBACK_MESSAGE);
}

export function isCatalogForScope(snapshot: SessionCatalogSnapshot, scope: PiHistoryScope): boolean {
  if (snapshot.protocol !== 7 || !Array.isArray(snapshot.sessions)) return false;
  return scope.kind === 'personal'
    ? snapshot.scope === 'personal'
    : snapshot.scope === 'project' && snapshot.projectId === scope.projectId;
}

export interface PiHistoryClient {
  /** Last indexed catalog, returned at once without scanning. */
  catalog(scope: PiHistoryScope): Promise<SessionCatalogSnapshot>;
  /** Bounded read-only reconciliation of the native session folder. */
  refresh(scope: PiHistoryScope): Promise<SessionCatalogSnapshot>;
  /** Latest page without a cursor; an `olderCursor` pages backwards. */
  page(scope: PiHistoryScope, sessionId: string, cursor: string | undefined): Promise<TimelinePage>;
  /** Titles and previews across verified projects (never the personal scope). */
  search(query: string): Promise<SessionSummary[]>;
  listenCatalog(handler: (event: SessionCatalogEvent) => void): Promise<() => void>;
  listenRootHints(handler: (hint: SessionRootHint) => void): Promise<() => void>;
}

export function createPiHistoryClient(invoke: HostInvoke, listen: HostListen): PiHistoryClient {
  async function call<T>(command: string, args: Record<string, unknown> | undefined = undefined): Promise<T> {
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      throw piHistoryError(error);
    }
  }

  async function catalogCall(command: string, scope: PiHistoryScope, args: Record<string, unknown> | undefined): Promise<SessionCatalogSnapshot> {
    const snapshot = await call<SessionCatalogSnapshot>(command, args);
    if (!isCatalogForScope(snapshot, scope)) throw new PiHistoryError('INVALID_RESPONSE', FALLBACK_MESSAGE);
    return snapshot;
  }

  return {
    catalog(scope) {
      return scope.kind === 'personal'
        ? catalogCall('get_personal_session_catalog', scope, undefined)
        : catalogCall('get_session_catalog', scope, { projectId: scope.projectId });
    },
    refresh(scope) {
      return scope.kind === 'personal'
        ? catalogCall('refresh_personal_session_catalog', scope, undefined)
        : catalogCall('refresh_session_catalog', scope, { projectId: scope.projectId });
    },
    async page(scope, sessionId, cursor) {
      const page = scope.kind === 'personal'
        ? await call<TimelinePage>('get_personal_timeline_page', { sessionId, cursor })
        : await call<TimelinePage>('get_timeline_page', { projectId: scope.projectId, sessionId, cursor });
      if (page.projectionVersion !== 2 || page.sessionId !== sessionId || !Array.isArray(page.blocks)) {
        throw new PiHistoryError('INVALID_RESPONSE', FALLBACK_MESSAGE);
      }
      return page;
    },
    search(query) {
      return call<SessionSummary[]>('search_sessions', { query });
    },
    listenCatalog(handler) {
      return listen<SessionCatalogEvent>(SESSION_CATALOG_CHANNEL, (event) => {
        if (event?.protocol === 7) handler(event);
      });
    },
    listenRootHints(handler) {
      return listen<SessionRootHint>(SESSION_ROOT_HINT_CHANNEL, (hint) => {
        if (hint?.protocol === 7) handler(hint);
      });
    },
  };
}

export const piHistoryHost: PiHistoryClient = createPiHistoryClient(hostInvoke, hostListen);
