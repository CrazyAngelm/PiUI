import { describe, expect, it } from 'vitest';
import {
  SESSION_PERSISTENCE_FEEDBACK_DELAY_MS,
  acceptsPrimeRuntimeBindingSnapshot,
  didResolveNewSession,
  isPendingSessionPersistenceError,
  ownsRuntimeBinding,
  resolveNewCatalogSession,
  resolvePrimeRuntimeCatalogSession,
  withoutPersistedLiveBlocks,
} from './sessionPersistenceFeedback';

describe('new-session persistence feedback', () => {
  it('defers only the expected eventually-consistent catalog miss', () => {
    expect(isPendingSessionPersistenceError(new Error('Pi has not persisted the completed personal turn yet.'))).toBe(true);
    expect(isPendingSessionPersistenceError(new Error('Pi has not persisted the completed project turn yet.'))).toBe(true);
    expect(isPendingSessionPersistenceError(new Error('Prime Agent runtime session binding is still pending.'))).toBe(true);
    expect(isPendingSessionPersistenceError(new Error('The session changed while synchronizing.'))).toBe(false);
    expect(SESSION_PERSISTENCE_FEEDBACK_DELAY_MS).toBeGreaterThan(7_500);
  });

  it('recognizes when a new chat receives its persisted session id', () => {
    expect(didResolveNewSession(undefined, 'session-1')).toBe(true);
    expect(didResolveNewSession('session-1', 'session-1')).toBe(false);
    expect(didResolveNewSession(undefined, undefined)).toBe(false);
  });

  it('resolves the created chat even when the opening catalog baseline was incomplete', () => {
    const sessions = [
      { id: 'old-1', createdAt: '2026-07-26T14:44:11.993Z' },
      { id: 'old-2', createdAt: '2026-07-26T15:44:59.052Z' },
      { id: 'created', createdAt: '2026-07-27T09:02:42.542Z' },
    ];

    expect(resolveNewCatalogSession(sessions, new Set(), Date.parse('2026-07-27T09:02:40.000Z'))?.id).toBe('created');
    expect(resolveNewCatalogSession(sessions, new Set(['old-1', 'old-2']), Date.parse('2026-07-27T09:02:40.000Z'))?.id).toBe('created');
  });

  it('does not adopt a single stale catalog row that predates the pending start', () => {
    expect(resolveNewCatalogSession([
      { id: 'missed-old-chat', createdAt: '2026-07-26T14:44:11.993Z' },
    ], new Set(), Date.parse('2026-07-27T09:02:40.000Z'))).toBeUndefined();
  });

  it('fails closed when multiple sessions could belong to the same pending start', () => {
    const startedAt = Date.parse('2026-07-27T09:02:40.000Z');
    expect(resolveNewCatalogSession([
      { id: 'created-a', createdAt: '2026-07-27T09:02:42.542Z' },
      { id: 'created-b', createdAt: '2026-07-27T09:02:43.542Z' },
    ], new Set(), startedAt)).toBeUndefined();
  });

  it('never infers a Prime session from a sole recent foreign catalog row', () => {
    const foreign = { id: 'opaque-foreign', createdAt: '2026-07-27T09:02:42.542Z' };

    expect(resolvePrimeRuntimeCatalogSession([foreign], undefined)).toBeUndefined();
    expect(resolvePrimeRuntimeCatalogSession([foreign], 'opaque-created')).toBeUndefined();
  });

  it('selects the exact opaque Prime session B among A and B regardless of catalog order', () => {
    const sessions = [
      { id: 'opaque-b', createdAt: '2026-07-27T09:02:43.542Z' },
      { id: 'opaque-a', createdAt: '2026-07-27T09:02:42.542Z' },
    ];

    expect(resolvePrimeRuntimeCatalogSession(sessions, 'opaque-b')?.id).toBe('opaque-b');
  });

  it('guards an exact Prime binding from delayed equal or older catalog rows', () => {
    const exact = [{ id: 'opaque-bound' }];
    const foreign = [{ id: 'opaque-foreign' }];

    expect(acceptsPrimeRuntimeBindingSnapshot(foreign, 'opaque-bound', 7, 7)).toBe(false);
    expect(acceptsPrimeRuntimeBindingSnapshot(foreign, 'opaque-bound', 6, 7)).toBe(false);
    expect(acceptsPrimeRuntimeBindingSnapshot(exact, 'opaque-bound', 7, 7)).toBe(true);
    expect(acceptsPrimeRuntimeBindingSnapshot(foreign, 'opaque-bound', 8, 7)).toBe(true);
  });

  it('keeps binding ownership when only the catalog request epoch changes', () => {
    let projectRequestEpoch = 4;
    const ownsBinding = () => ownsRuntimeBinding('project', 'project', 9, 9, 12, 12);

    expect(ownsBinding()).toBe(true);
    projectRequestEpoch += 1;
    expect(projectRequestEpoch).toBe(5);
    expect(ownsBinding()).toBe(true);
    expect(ownsRuntimeBinding('other', 'project', 9, 9, 12, 12)).toBe(false);
    expect(ownsRuntimeBinding('project', 'project', 10, 9, 12, 12)).toBe(false);
    expect(ownsRuntimeBinding('project', 'project', 9, 9, 13, 12)).toBe(false);
  });

  it('removes only the completed persisted turn and preserves a queued turn', () => {
    const blocks = [
      { id: 'completed-user', text: 'first' },
      { id: 'completed-assistant', text: 'done' },
      { id: 'queued-user', text: 'follow-up' },
      { id: 'queued-assistant', text: 'streaming' },
    ];

    expect(withoutPersistedLiveBlocks(blocks, new Set(['completed-user', 'completed-assistant']))).toEqual([
      { id: 'queued-user', text: 'follow-up' },
      { id: 'queued-assistant', text: 'streaming' },
    ]);
  });
});
