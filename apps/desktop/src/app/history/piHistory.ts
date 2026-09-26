import type { PiHistoryScope } from '../../host-api/piHistoryClient';
import type { AgentKind, SessionSummary, SessionTree, TimelineBlock, TimelinePage } from '../../host-api/types';
import type { WorkspaceSummary } from '../../../../../contracts/workspace-v15';

/**
 * Presentation logic for read-only native session history (the classic
 * view's Pi history, now in the workbench shell). Pure functions only; the
 * store owns requests and the components own layout.
 */

/** Older pages are prepended; beyond this bound the newest blocks are released. */
export const MAX_RETAINED_HISTORY_BLOCKS = 500;
/** The full entry list of a tree renders in slices this long. */
export const TREE_ENTRY_PAGE = 200;

export function scopeForWorkspace(workspace: Pick<WorkspaceSummary, 'id' | 'personal'>): PiHistoryScope {
  return workspace.personal ? { kind: 'personal' } : { kind: 'project', projectId: workspace.id };
}

export function scopeKey(scope: PiHistoryScope): string {
  return scope.kind === 'personal' ? 'personal' : `project:${scope.projectId}`;
}

/** Harness whose native folder the index scans; personal chats are always Pi. */
export function historyAgentLabel(agentKind: AgentKind | undefined): string {
  return agentKind === 'prime-agent' ? 'Prime Agent' : 'Pi';
}

export function filterSessions(sessions: readonly SessionSummary[], query: string): SessionSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...sessions];
  return sessions.filter((session) => `${session.title} ${session.preview ?? ''}`.toLocaleLowerCase().includes(needle));
}

/** Host search accepts 1–120 characters; anything else is not sent. */
export function searchableQuery(query: string): string | undefined {
  const trimmed = query.trim();
  return trimmed.length > 0 && [...trimmed].length <= 120 ? trimmed : undefined;
}

export interface HistoryReader {
  readonly sessionId: string;
  readonly blocks: TimelineBlock[];
  readonly tree: SessionTree | undefined;
  readonly totalBlocks: number;
  readonly olderCursor: string | undefined;
  readonly fileRevision: string | undefined;
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly error: string | undefined;
  /** An older window is shown and newer blocks were released from memory. */
  readonly windowTruncated: boolean;
}

export function emptyReader(sessionId: string): HistoryReader {
  return {
    sessionId,
    blocks: [],
    tree: undefined,
    totalBlocks: 0,
    olderCursor: undefined,
    fileRevision: undefined,
    loading: true,
    loadingOlder: false,
    error: undefined,
    windowTruncated: false,
  };
}

export function readerFromLatestPage(page: TimelinePage): HistoryReader {
  return {
    sessionId: page.sessionId,
    blocks: page.blocks,
    tree: page.tree,
    totalBlocks: page.totalBlocks,
    olderCursor: page.olderCursor,
    fileRevision: page.fileRevision,
    loading: false,
    loadingOlder: false,
    error: undefined,
    windowTruncated: false,
  };
}

export type OlderPageOutcome = { readonly type: 'merged'; readonly reader: HistoryReader } | { readonly type: 'stale' };

/**
 * Prepends an older page. A stale cursor means the file changed since the
 * first page: the caller reloads the latest page instead of mixing two file
 * revisions in one transcript.
 */
export function mergeOlderPage(reader: HistoryReader, page: TimelinePage, max = MAX_RETAINED_HISTORY_BLOCKS): OlderPageOutcome {
  if (page.staleCursor || page.sessionId !== reader.sessionId || (reader.fileRevision !== undefined && page.fileRevision !== reader.fileRevision)) {
    return { type: 'stale' };
  }
  const known = new Set(reader.blocks.map((block) => block.id));
  const combined = [...page.blocks.filter((block) => !known.has(block.id)), ...reader.blocks];
  const truncated = combined.length > max;
  return {
    type: 'merged',
    reader: {
      ...reader,
      blocks: truncated ? combined.slice(0, max) : combined,
      tree: page.tree,
      totalBlocks: page.totalBlocks,
      olderCursor: page.olderCursor,
      loadingOlder: false,
      error: undefined,
      windowTruncated: reader.windowTruncated || truncated,
    },
  };
}

export interface TreeBranch {
  readonly leafId: string;
  /** Entries from the root to this branch's last entry. */
  readonly entries: number;
  /** 1-based position of the entry this branch splits from; absent for the first line. */
  readonly splitsAfter: number | undefined;
  readonly current: boolean;
}

export interface TreeSummary {
  readonly entries: number;
  readonly branches: readonly TreeBranch[];
  /** Entries with more than one continuation. */
  readonly forks: number;
  readonly currentPathEntries: number;
  /** Entries the index flagged (orphan, cycle, duplicate, depth or size limit). */
  readonly issues: number;
  readonly diagnostics: number;
}

/**
 * Summarizes the host's bounded, flat depth-first tree. Leaves are branch
 * ends; walking up to the nearest entry with several children gives the
 * split point. Parent links are only followed inside the projection and a
 * visited set bounds the walk even for malformed input.
 */
export function summarizeTree(tree: SessionTree): TreeSummary {
  const byId = new Map(tree.nodes.map((node) => [node.entryId, node]));
  const children = new Map<string, number>();
  for (const node of tree.nodes) {
    if (node.parentId !== undefined && node.parentId !== node.entryId && byId.has(node.parentId)) {
      children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
    }
  }
  const branches: TreeBranch[] = [];
  for (const node of tree.nodes) {
    if (children.has(node.entryId)) continue;
    let splitsAfter: number | undefined;
    const visited = new Set([node.entryId]);
    let cursor = node.parentId === undefined ? undefined : byId.get(node.parentId);
    while (cursor !== undefined && !visited.has(cursor.entryId)) {
      visited.add(cursor.entryId);
      if ((children.get(cursor.entryId) ?? 0) > 1) {
        splitsAfter = cursor.depth + 1;
        break;
      }
      cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
    }
    branches.push({ leafId: node.entryId, entries: node.depth + 1, splitsAfter, current: node.isCurrentPath });
  }
  branches.sort((left, right) => Number(right.current) - Number(left.current));
  return {
    entries: tree.nodes.length,
    branches,
    forks: [...children.values()].filter((count) => count > 1).length,
    currentPathEntries: tree.nodes.filter((node) => node.isCurrentPath).length,
    issues: tree.nodes.filter((node) => node.issue !== undefined).length,
    diagnostics: tree.diagnosticCount,
  };
}

export type TreeIssue = NonNullable<SessionTree['nodes'][number]['issue']>;

export function treeIssueLabel(issue: TreeIssue): string {
  switch (issue) {
    case 'orphan':
      return 'Missing parent';
    case 'cycle':
      return 'Loop in links';
    case 'duplicate':
      return 'Duplicate entry';
    case 'depth-limit':
      return 'Too deep to show';
    case 'truncated':
      return 'Not shown';
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
}

export function parseStateLabel(state: SessionSummary['parseState']): string | undefined {
  switch (state) {
    case 'healthy':
      return undefined;
    case 'partial':
      return 'Partly readable';
    case 'unsupported':
      return 'Unsupported format';
    case 'corrupt':
      return 'Damaged';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
