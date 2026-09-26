import type {
  SessionCatalogEvent,
  SessionCatalogFreshness,
  SessionCatalogSnapshot,
  SessionSummary,
  SessionTree,
  TimelineBlock,
  TimelinePage,
} from '../types';
import type { LabEventBus } from './labBus';
import { apiFailure, LabDecodeFailure } from './labErrors';
import type { LabArgs, LabHandlers } from './labHandlers';
import type { LabProject } from './labState';
import type { LabSessions } from './sessionRuntime';

/**
 * The classic index commands behind the read-only history browser:
 * cached-then-reconciled catalogs (protocol 7), cursor-paged timeline pages
 * with a bounded tree, and title/preview search. Only fixed demo data is
 * served; nothing is scanned, written or executed.
 */
export interface LabIndexedSession {
  /** Catalog row without `projectId`; the handler adds it per scope. */
  readonly summary: Omit<SessionSummary, 'projectId'>;
  readonly blocks: TimelineBlock[];
  readonly tree: SessionTree;
  readonly fileRevision: string;
}

export interface LabNativeHistory {
  /** Keyed by project id; the personal workspace's id holds projectless chats. */
  readonly byProject: ReadonlyMap<string, readonly LabIndexedSession[]>;
}

export const EMPTY_NATIVE_HISTORY: LabNativeHistory = { byProject: new Map() };

/** The host's `DEFAULT_TIMELINE_PAGE_SIZE`. */
export const LAB_TIMELINE_PAGE = 100;
const REFRESH_LATENCY_MS = 300;
const CATALOG_CHANNEL = 'piui://session-catalog';

function stringArgument(args: LabArgs, name: string): string {
  const value = args[name];
  if (value === undefined) throw new LabDecodeFailure('missing', name, true);
  if (typeof value !== 'string') throw new LabDecodeFailure('invalid type: expected a string', name);
  return value;
}

function optionalString(args: LabArgs, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new LabDecodeFailure('invalid type: expected a string', name);
  return value;
}

function optionalCount(args: LabArgs, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new LabDecodeFailure('invalid type: expected usize', name);
  return value;
}

interface Cursor {
  readonly projectId: string;
  readonly sessionId: string;
  readonly fileRevision: string;
  readonly before: number;
}

export function piHistoryHandlers(runtime: LabSessions, history: LabNativeHistory, bus: LabEventBus): LabHandlers {
  const { state } = runtime;
  const sequences = new Map<string, number>();
  const refreshed = new Set<string>();
  const cursors = new Map<string, Cursor>();
  let cursorSerial = 0;

  const personal = (): LabProject | undefined => state.projects.find((project) => project.personal);

  /** `require_user_project` plus the catalog visibility check (missing folders stay readable). */
  function userProject(projectId: string): LabProject {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (project?.personal) throw apiFailure('INVALID_ARGUMENT');
    if (project === undefined) throw apiFailure('NOT_FOUND');
    return project;
  }

  function sessionsOf(projectId: string): readonly LabIndexedSession[] {
    return history.byProject.get(projectId) ?? [];
  }

  function snapshot(project: LabProject, freshness: SessionCatalogFreshness): SessionCatalogSnapshot {
    const sequence = sequences.get(project.id) ?? 1;
    return {
      protocol: 7,
      scope: project.personal ? 'personal' : 'project',
      ...(project.personal ? {} : { projectId: project.id }),
      sequence,
      freshness,
      sessions: sessionsOf(project.id).map((entry) => ({ ...entry.summary, ...(project.personal ? {} : { projectId: project.id }) })),
    };
  }

  function cached(project: LabProject): SessionCatalogSnapshot {
    return snapshot(project, refreshed.has(project.id) ? 'current' : 'cached');
  }

  async function refresh(project: LabProject): Promise<SessionCatalogSnapshot> {
    const sequence = (sequences.get(project.id) ?? 1) + 1;
    sequences.set(project.id, sequence);
    const scope = project.personal ? 'personal' : 'project';
    const started: SessionCatalogEvent = {
      protocol: 7, kind: 'refreshStarted', scope, ...(project.personal ? {} : { projectId: project.id }), sequence,
    };
    bus.emit(CATALOG_CHANNEL, started);
    await runtime.clock.delay(REFRESH_LATENCY_MS);
    if (project.missing) {
      const failed: SessionCatalogEvent = {
        protocol: 7, kind: 'refreshFailed', scope, ...(project.personal ? {} : { projectId: project.id }), sequence,
        safeSummary: 'Local sessions could not be refreshed. Showing the last indexed catalog.',
      };
      bus.emit(CATALOG_CHANNEL, failed);
      throw apiFailure('PROJECT_UNAVAILABLE');
    }
    refreshed.add(project.id);
    const result = snapshot(project, 'current');
    bus.emit(CATALOG_CHANNEL, { protocol: 7, kind: 'snapshot', snapshot: result } satisfies SessionCatalogEvent);
    return result;
  }

  /** Mirrors `timeline_page`: latest slice, cursor capabilities, stale detection. */
  function page(project: LabProject, args: LabArgs): TimelinePage {
    const sessionId = stringArgument(args, 'sessionId');
    const token = optionalString(args, 'cursor');
    const limit = optionalCount(args, 'limit') ?? LAB_TIMELINE_PAGE;
    if (limit === 0) throw apiFailure('INVALID_ARGUMENT');
    const entry = sessionsOf(project.id).find((candidate) => candidate.summary.id === sessionId);
    if (entry === undefined) throw apiFailure('NOT_FOUND');
    // Reading JSONL needs the folder, even though the cached catalog does not.
    if (project.missing) throw apiFailure('PROJECT_UNAVAILABLE');
    const total = entry.blocks.length;
    let end = total;
    if (token !== undefined) {
      const cursor = cursors.get(token);
      if (cursor === undefined || cursor.projectId !== project.id || cursor.sessionId !== sessionId) throw apiFailure('INVALID_ARGUMENT');
      if (cursor.fileRevision !== entry.fileRevision) {
        return {
          projectionVersion: 2, sessionId, blocks: [], tree: entry.tree, fileRevision: entry.fileRevision,
          rangeStart: 0, totalBlocks: total, staleCursor: true,
        };
      }
      end = cursor.before;
    }
    const start = Math.max(0, end - limit);
    let olderCursor: string | undefined;
    if (start > 0) {
      cursorSerial += 1;
      olderCursor = `lab-history-cursor-${cursorSerial}`;
      cursors.set(olderCursor, { projectId: project.id, sessionId, fileRevision: entry.fileRevision, before: start });
    }
    return {
      projectionVersion: 2,
      sessionId,
      blocks: entry.blocks.slice(start, end),
      tree: entry.tree,
      fileRevision: entry.fileRevision,
      rangeStart: start,
      totalBlocks: total,
      ...(olderCursor === undefined ? {} : { olderCursor }),
      staleCursor: false,
    };
  }

  function search(args: LabArgs): SessionSummary[] {
    const query = stringArgument(args, 'query').trim();
    if (query.length === 0 || [...query].length > 120) throw apiFailure('INVALID_ARGUMENT');
    const needle = query.toLocaleLowerCase();
    const results: SessionSummary[] = [];
    for (const project of state.projects) {
      if (project.personal || project.missing) continue;
      for (const entry of sessionsOf(project.id)) {
        if (`${entry.summary.title} ${entry.summary.preview ?? ''}`.toLocaleLowerCase().includes(needle)) {
          results.push({ ...entry.summary, projectId: project.id });
        }
      }
    }
    return results.slice(0, 50);
  }

  function personalProject(): LabProject {
    const project = personal();
    if (project === undefined) throw apiFailure('NOT_FOUND');
    return project;
  }

  return {
    get_session_catalog: (args) => cached(userProject(stringArgument(args, 'projectId'))),
    get_personal_session_catalog: () => cached(personalProject()),
    refresh_session_catalog: (args) => refresh(userProject(stringArgument(args, 'projectId'))),
    refresh_personal_session_catalog: () => refresh(personalProject()),
    get_timeline_page: (args) => page(userProject(stringArgument(args, 'projectId')), args),
    get_personal_timeline_page: (args) => page(personalProject(), args),
    get_tree: (args) => {
      const project = userProject(stringArgument(args, 'projectId'));
      const entry = sessionsOf(project.id).find((candidate) => candidate.summary.id === stringArgument(args, 'sessionId'));
      if (entry === undefined) throw apiFailure('NOT_FOUND');
      return entry.tree;
    },
    get_personal_tree: (args) => {
      const entry = sessionsOf(personalProject().id).find((candidate) => candidate.summary.id === stringArgument(args, 'sessionId'));
      if (entry === undefined) throw apiFailure('NOT_FOUND');
      return entry.tree;
    },
    search_sessions: (args) => search(args),
  };
}
