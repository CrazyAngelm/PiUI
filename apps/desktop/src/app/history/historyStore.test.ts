import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { createPiHistoryClient, piHistoryError, type PiHistoryClient } from '../../host-api/piHistoryClient';
import type { LabHost } from '../../host-api/lab/labHost';
import { labHost } from '../../host-api/lab/labTestKit';
import type { SessionCatalogSnapshot, TimelinePage } from '../../host-api/types';
import { flatTree } from '../../host-api/lab/scenarios/demoPiHistory';
import { PiHistoryStore } from './historyStore.svelte';
import SessionBranches from './SessionBranches.svelte';

function clientFor(host: LabHost): PiHistoryClient {
  return createPiHistoryClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler));
}

function projectId(host: LabHost, name: string): string {
  const project = host.state.projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new Error(`No project ${name}`);
  return project.id;
}

async function until(check: () => boolean): Promise<void> {
  for (let step = 0; step < 200; step += 1) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(50);
  }
  throw new Error('Condition was not reached.');
}

describe('PiHistoryStore over the UI Lab host', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints the cached catalog, reconciles it and opens the latest page read-only', async () => {
    const host = labHost();
    const history = new PiHistoryStore(clientFor(host));
    await history.start();
    const opening = history.open({ kind: 'project', projectId: projectId(host, 'piui') });
    await until(() => history.catalog !== undefined);
    expect(history.catalog?.freshness).toBe('cached');
    await opening;
    await until(() => history.catalog?.freshness === 'current' && !history.refreshing);
    const long = history.catalog?.sessions.find((session) => session.title.startsWith('Walk through'));
    await history.select(long?.id ?? '');
    expect(history.reader?.blocks).toHaveLength(100);
    expect(history.reader?.olderCursor).toBeDefined();
    await history.loadOlder();
    await history.loadOlder();
    expect(history.reader?.blocks).toHaveLength(261);
    expect(history.reader?.olderCursor).toBeUndefined();
    history.dispose();
  });

  it('filters locally and finds matches in other folders', async () => {
    const host = labHost();
    const history = new PiHistoryStore(clientFor(host));
    await history.open({ kind: 'project', projectId: projectId(host, 'video-studio') });
    history.setQuery('migration');
    expect(history.sessions).toHaveLength(0);
    expect(history.searchBusy).toBe(true);
    await until(() => !history.searchBusy);
    expect(history.otherResults.map((result) => result.title)).toEqual(['Walk through the orchestration store migration']);
    history.setQuery('');
    expect(history.otherResults).toHaveLength(0);
    history.dispose();
  });

  it('ignores late responses for a scope the reader already left', async () => {
    let releaseFirst: (value: SessionCatalogSnapshot) => void = () => {};
    const client: PiHistoryClient = {
      catalog: (scope) => scope.kind === 'personal'
        ? Promise.resolve({ protocol: 7, scope: 'personal', sequence: 1, freshness: 'current', sessions: [] })
        : new Promise((resolve) => { releaseFirst = resolve; }),
      refresh: () => new Promise(() => {}),
      page: () => new Promise(() => {}),
      search: async () => [],
      listenCatalog: async () => () => {},
      listenRootHints: async () => () => {},
    };
    const history = new PiHistoryStore(client);
    const first = history.open({ kind: 'project', projectId: 'a' });
    await history.open({ kind: 'personal' });
    releaseFirst({ protocol: 7, scope: 'project', projectId: 'a', sequence: 9, freshness: 'current', sessions: [
      { id: 'x', title: 'Late', titleSource: 'pi-name', entryCount: 1, parseState: 'healthy', projectId: 'a' },
    ] });
    await first;
    expect(history.scope).toEqual({ kind: 'personal' });
    expect(history.catalog?.scope).toBe('personal');
    expect(history.catalog?.sessions).toHaveLength(0);
  });

  it('keeps loaded entries when an older page fails and reloads after a file change', async () => {
    const latest: TimelinePage = {
      projectionVersion: 2, sessionId: 's', blocks: [{ id: 'timeline-5', kind: 'user', label: 'You', text: 'newest', status: 'complete' }],
      tree: flatTree([{ id: 'a' }], 'a'), fileRevision: 'r1', rangeStart: 5, totalBlocks: 6, olderCursor: 'c', staleCursor: false,
    };
    let older: () => Promise<TimelinePage> = () => Promise.reject({ code: 'IO_ERROR', message: 'secret native detail' });
    const client: PiHistoryClient = {
      catalog: async () => ({ protocol: 7, scope: 'personal', sequence: 1, freshness: 'current', sessions: [
        { id: 's', title: 'Chat', titleSource: 'pi-name', entryCount: 6, parseState: 'healthy' },
      ] }),
      refresh: () => new Promise(() => {}),
      page: (_scope, _session, cursor) => (cursor === undefined ? Promise.resolve(latest) : older()),
      search: async () => [],
      listenCatalog: async () => () => {},
      listenRootHints: async () => () => {},
    };
    const history = new PiHistoryStore(client);
    await history.open({ kind: 'personal' }, 's');
    await history.loadOlder();
    expect(history.reader?.blocks).toHaveLength(1);
    expect(history.reader?.error).toBe('Local session history could not be read. Try again.');
    expect(history.reader?.error).not.toContain('secret');
    older = async () => ({ ...latest, blocks: [], staleCursor: true, fileRevision: 'r2' });
    await history.loadOlder();
    expect(history.notice).toBe('The session changed on disk. Showing its latest entries.');
    expect(history.reader?.blocks.map((block) => block.id)).toEqual(['timeline-5']);
  });

  it('drops a selection that a refreshed catalog no longer lists', async () => {
    let sessions = [{ id: 's', title: 'Chat', titleSource: 'pi-name' as const, entryCount: 1, parseState: 'healthy' as const }];
    let sequence = 1;
    const client: PiHistoryClient = {
      catalog: async () => ({ protocol: 7, scope: 'personal', sequence, freshness: 'current', sessions }),
      refresh: async () => ({ protocol: 7, scope: 'personal', sequence: ++sequence, freshness: 'current', sessions }),
      page: async (_scope, sessionId) => ({
        projectionVersion: 2, sessionId, blocks: [], tree: flatTree([], ''), fileRevision: 'r', rangeStart: 0, totalBlocks: 0, staleCursor: false,
      }),
      search: async () => [],
      listenCatalog: async () => () => {},
      listenRootHints: async () => () => {},
    };
    const history = new PiHistoryStore(client);
    await history.open({ kind: 'personal' }, 's');
    expect(history.selectedId).toBe('s');
    sessions = [];
    await history.refresh();
    expect(history.selectedId).toBeUndefined();
    expect(history.notice).toBe('The selected session is no longer in the local index.');
  });
});

describe('history errors and branch rendering', () => {
  it('maps host rejections to fixed messages without forwarding payloads', () => {
    expect(piHistoryError({ code: 'PROJECT_UNAVAILABLE', message: 'C:\\secret' }).message).toBe('The folder is unavailable. Reconnect it, then refresh.');
    expect(piHistoryError('{"code":"CONFLICT"}').code).toBe('CONFLICT');
    expect(piHistoryError(new Error('boom')).message).toBe('Local session history could not be read. Try again.');
  });

  it('renders branches with the current branch first and escapes entry labels', () => {
    const tree = flatTree([{ id: 'a' }, { id: 'b', parent: 'a' }, { id: '<img src=x>', parent: 'a' }], 'b');
    const { body } = render(SessionBranches, { props: { tree, agentLabel: 'Pi' } });
    expect(body).toContain('Current branch');
    expect(body).toContain('2 branches');
    expect(body).toContain('splits after entry 1');
    expect(body).toContain('Switch branches in the Pi terminal app');
    expect(body).not.toContain('<img src=x>');
    expect(body).toContain('&lt;img');
  });
});
