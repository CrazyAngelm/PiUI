import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCatalogEvent, SessionCatalogSnapshot, SessionSummary, TimelinePage } from '../types';
import { summarizeTree } from '../../app/history/piHistory';
import { labHost, record, rejection } from './labTestKit';

function projectId(host: ReturnType<typeof labHost>, name: string): string {
  const project = host.state.projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new Error(`No project ${name}`);
  return project.id;
}

describe('UI Lab native session history (classic index commands)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints a cached catalog, then reconciles with catalog events', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const events = await record<SessionCatalogEvent>(host, 'piui://session-catalog');
    const cached = await host.invoke<SessionCatalogSnapshot>('get_session_catalog', { projectId: piui });
    expect(cached).toMatchObject({ protocol: 7, scope: 'project', projectId: piui, freshness: 'cached' });
    expect(cached.sessions.map((session) => session.title)).toContain('Make the session index incremental');
    const refreshing = host.invoke<SessionCatalogSnapshot>('refresh_session_catalog', { projectId: piui });
    await vi.advanceTimersByTimeAsync(400);
    const current = await refreshing;
    expect(current.freshness).toBe('current');
    expect(current.sequence).toBeGreaterThan(cached.sequence);
    expect(events.items.map((event) => event.kind)).toEqual(['refreshStarted', 'snapshot']);
    events.stop();
  });

  it('keeps the personal scope separate and hides its backing id', async () => {
    const host = labHost();
    const personal = await host.invoke<SessionCatalogSnapshot>('get_personal_session_catalog');
    expect(personal.scope).toBe('personal');
    expect(personal.projectId).toBeUndefined();
    expect(personal.sessions.every((session) => session.projectId === undefined)).toBe(true);
    expect(await rejection(host.invoke('get_session_catalog', { projectId: projectId(host, 'Chats') })))
      .toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await rejection(host.invoke('get_session_catalog', { projectId: 'unknown' }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('pages a long transcript backwards with host-held cursors', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const catalog = await host.invoke<SessionCatalogSnapshot>('get_session_catalog', { projectId: piui });
    const long = catalog.sessions.find((session) => session.title.startsWith('Walk through')) as SessionSummary;
    const latest = await host.invoke<TimelinePage>('get_timeline_page', { projectId: piui, sessionId: long.id });
    expect(latest.blocks).toHaveLength(100);
    expect(latest.totalBlocks).toBe(261);
    expect(latest.olderCursor).toBeDefined();
    const older = await host.invoke<TimelinePage>('get_timeline_page', { projectId: piui, sessionId: long.id, cursor: latest.olderCursor });
    expect(older.rangeStart).toBe(61);
    const oldest = await host.invoke<TimelinePage>('get_timeline_page', { projectId: piui, sessionId: long.id, cursor: older.olderCursor });
    expect(oldest.rangeStart).toBe(0);
    expect(oldest.olderCursor).toBeUndefined();
    expect(await rejection(host.invoke('get_timeline_page', { projectId: piui, sessionId: 'other', cursor: latest.olderCursor })))
      .toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serves a branched session tree and a partly readable file', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const catalog = await host.invoke<SessionCatalogSnapshot>('get_session_catalog', { projectId: piui });
    const branched = catalog.sessions.find((session) => session.branchCount === 3) as SessionSummary;
    const page = await host.invoke<TimelinePage>('get_timeline_page', { projectId: piui, sessionId: branched.id });
    const summary = summarizeTree(page.tree);
    expect(summary.branches.map((branch) => branch.current)).toEqual([true, false, false]);
    expect(page.tree.navigationSupported).toBe(false);
    const damaged = catalog.sessions.find((session) => session.parseState === 'partial') as SessionSummary;
    const damagedPage = await host.invoke<TimelinePage>('get_timeline_page', { projectId: piui, sessionId: damaged.id });
    expect(damagedPage.tree.diagnosticCount).toBe(2);
    expect(damagedPage.blocks.some((block) => block.fallback)).toBe(true);
  });

  it('searches titles and previews across verified projects only', async () => {
    const host = labHost();
    const results = await host.invoke<SessionSummary[]>('search_sessions', { query: 'migrat' });
    expect(results.map((result) => result.title)).toEqual(['Walk through the orchestration store migration']);
    expect(results.every((result) => result.projectId !== undefined)).toBe(true);
    expect(await rejection(host.invoke('search_sessions', { query: ' ' }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('keeps history readable in safe mode', async () => {
    const host = labHost('safe');
    const catalog = await host.invoke<SessionCatalogSnapshot>('get_session_catalog', { projectId: projectId(host, 'piui') });
    expect(catalog.sessions.length).toBeGreaterThan(0);
  });
});
