import { describe, expect, it } from 'vitest';
import {
  SESSION_PERSISTENCE_FEEDBACK_DELAY_MS,
  didResolveNewSession,
  isPendingSessionPersistenceError,
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
