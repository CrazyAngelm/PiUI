import { describe, expect, it } from 'vitest';
import {
  SESSION_PERSISTENCE_FEEDBACK_DELAY_MS,
  didResolveNewSession,
  isPendingSessionPersistenceError,
  resolveNewCatalogSession,
  withoutPersistedLiveBlocks,
} from './sessionPersistenceFeedback';

describe('new-session persistence feedback', () => {
  it('defers only the expected eventually-consistent catalog miss', () => {
    expect(isPendingSessionPersistenceError(new Error('Pi has not persisted the completed personal turn yet.'))).toBe(true);
    expect(isPendingSessionPersistenceError(new Error('Pi has not persisted the completed project turn yet.'))).toBe(true);
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
