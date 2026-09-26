import { describe, expect, it } from 'vitest';
import type { SessionSummary, SessionTree, TimelineBlock, TimelinePage } from '../../host-api/types';
import { flatTree } from '../../host-api/lab/scenarios/demoPiHistory';
import {
  emptyReader,
  filterSessions,
  historyAgentLabel,
  mergeOlderPage,
  parseStateLabel,
  readerFromLatestPage,
  scopeForWorkspace,
  scopeKey,
  searchableQuery,
  summarizeTree,
  treeIssueLabel,
} from './piHistory';

const block = (index: number): TimelineBlock => ({ id: `timeline-${index}`, kind: 'user', label: 'You', text: `m${index}`, status: 'complete' });
const tree: SessionTree = { nodes: [], diagnosticCount: 0, navigationSupported: false };

function page(sessionId: string, start: number, end: number, patch: Partial<TimelinePage> = {}): TimelinePage {
  return {
    projectionVersion: 2,
    sessionId,
    blocks: Array.from({ length: end - start }, (_, offset) => block(start + offset)),
    tree,
    fileRevision: 'rev',
    rangeStart: start,
    totalBlocks: 250,
    ...(start > 0 ? { olderCursor: `cursor-${start}` } : {}),
    staleCursor: false,
    ...patch,
  };
}

describe('history scope and list helpers', () => {
  it('maps workspaces to index scopes without exposing the personal backing id', () => {
    expect(scopeForWorkspace({ id: 'p1', personal: false })).toEqual({ kind: 'project', projectId: 'p1' });
    expect(scopeForWorkspace({ id: 'personal-id', personal: true })).toEqual({ kind: 'personal' });
    expect(scopeKey({ kind: 'personal' })).toBe('personal');
    expect(scopeKey({ kind: 'project', projectId: 'p1' })).toBe('project:p1');
    expect(historyAgentLabel('prime-agent')).toBe('Prime Agent');
    expect(historyAgentLabel(undefined)).toBe('Pi');
  });

  it('filters titles and previews case-insensitively and bounds host search queries', () => {
    const sessions = [
      { id: 'a', title: 'Refactor Index', preview: 'scanner', entryCount: 1, parseState: 'healthy', titleSource: 'pi-name' },
      { id: 'b', title: 'Release notes', preview: 'Index of changes', entryCount: 1, parseState: 'healthy', titleSource: 'pi-name' },
      { id: 'c', title: 'Other', entryCount: 1, parseState: 'healthy', titleSource: 'pi-name' },
    ] satisfies SessionSummary[];
    expect(filterSessions(sessions, ' index ').map((session) => session.id)).toEqual(['a', 'b']);
    expect(filterSessions(sessions, '')).toHaveLength(3);
    expect(searchableQuery('   ')).toBeUndefined();
    expect(searchableQuery('x'.repeat(121))).toBeUndefined();
    expect(searchableQuery(' ok ')).toBe('ok');
  });

  it('labels damaged files and tree issues for people, not parsers', () => {
    expect(parseStateLabel('healthy')).toBeUndefined();
    expect(parseStateLabel('partial')).toBe('Partly readable');
    expect(parseStateLabel('corrupt')).toBe('Damaged');
    expect(treeIssueLabel('orphan')).toBe('Missing parent');
    expect(treeIssueLabel('depth-limit')).toBe('Too deep to show');
  });
});

describe('paged read-only transcript', () => {
  it('prepends older pages, keeps block identity unique and follows the next cursor', () => {
    const latest = readerFromLatestPage(page('s', 150, 250));
    expect(latest.olderCursor).toBe('cursor-150');
    const merged = mergeOlderPage(latest, page('s', 50, 151));
    expect(merged.type).toBe('merged');
    if (merged.type !== 'merged') return;
    expect(merged.reader.blocks.map((item) => item.id).slice(0, 2)).toEqual(['timeline-50', 'timeline-51']);
    expect(merged.reader.blocks).toHaveLength(200);
    expect(merged.reader.olderCursor).toBe('cursor-50');
    expect(merged.reader.windowTruncated).toBe(false);
  });

  it('bounds the retained window by releasing the newest blocks', () => {
    const reader = readerFromLatestPage(page('s', 150, 250));
    const merged = mergeOlderPage(reader, page('s', 0, 150), 120);
    if (merged.type !== 'merged') throw new Error('expected a merge');
    expect(merged.reader.blocks).toHaveLength(120);
    expect(merged.reader.blocks[0]?.id).toBe('timeline-0');
    expect(merged.reader.windowTruncated).toBe(true);
  });

  it('never mixes two file revisions or sessions', () => {
    const reader = readerFromLatestPage(page('s', 150, 250));
    expect(mergeOlderPage(reader, page('s', 50, 150, { staleCursor: true })).type).toBe('stale');
    expect(mergeOlderPage(reader, page('s', 50, 150, { fileRevision: 'other' })).type).toBe('stale');
    expect(mergeOlderPage(reader, page('t', 50, 150)).type).toBe('stale');
    expect(emptyReader('s')).toMatchObject({ loading: true, blocks: [], olderCursor: undefined });
  });
});

describe('branch summary of the flat tree', () => {
  it('finds branches, split points and the current branch', () => {
    const summary = summarizeTree(flatTree([
      { id: 'a' },
      { id: 'b', parent: 'a' },
      { id: 'c', parent: 'b' },
      { id: 'd', parent: 'c' },
      { id: 'c2', parent: 'b' },
      { id: 'b2', parent: 'a' },
    ], 'd'));
    expect(summary.entries).toBe(6);
    expect(summary.forks).toBe(2);
    expect(summary.currentPathEntries).toBe(4);
    expect(summary.branches).toEqual([
      { leafId: 'd', entries: 4, splitsAfter: 2, current: true },
      { leafId: 'c2', entries: 3, splitsAfter: 2, current: false },
      { leafId: 'b2', entries: 2, splitsAfter: 1, current: false },
    ]);
  });

  it('keeps a linear session as one unsplit branch and counts index issues', () => {
    const linear = summarizeTree(flatTree([{ id: 'a' }, { id: 'b', parent: 'a' }], 'b'));
    expect(linear.branches).toEqual([{ leafId: 'b', entries: 2, splitsAfter: undefined, current: true }]);
    const damaged = summarizeTree(flatTree([{ id: 'a' }, { id: 'x', parent: 'missing' }], 'a', 2, { x: 'orphan' }));
    expect(damaged.issues).toBe(1);
    expect(damaged.diagnostics).toBe(2);
    expect(damaged.branches).toHaveLength(2);
  });

  it('terminates on malformed parent cycles', () => {
    const cyclic: SessionTree = {
      nodes: [
        { entryId: 'a', parentId: 'b', label: 'a', kind: 'entry', depth: 0, isCurrentPath: false, issue: 'cycle' },
        { entryId: 'b', parentId: 'a', label: 'b', kind: 'entry', depth: 1, isCurrentPath: false, issue: 'cycle' },
      ],
      diagnosticCount: 1,
      navigationSupported: false,
    };
    const summary = summarizeTree(cyclic);
    expect(summary.issues).toBe(2);
    expect(summary.branches.length).toBeLessThanOrEqual(2);
  });
});
