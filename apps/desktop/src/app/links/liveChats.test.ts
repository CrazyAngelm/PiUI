import { describe, expect, it } from 'vitest';
import type { LinkedChatV1 } from '../../host-api/sessionLinksClient';
import { liveChats } from './liveChats';

const chat = (patch: Partial<LinkedChatV1>): LinkedChatV1 => ({ sessionId: 'x', title: 'Cached', harness: 'codex', kind: 'peer', relation: 'peer', state: 'running', pending: 0, ...patch });

describe('live linked chats', () => {
  it('takes the state and title from the catalog', () => {
    const [done, failed, renamed, stopping] = liveChats(
      [chat({ sessionId: 'a' }), chat({ sessionId: 'b' }), chat({ sessionId: 'c', state: 'idle' }), chat({ sessionId: 'd', state: 'idle' })],
      [
        { id: 'a', title: 'Cached', status: 'idle' },
        { id: 'b', title: 'Cached', status: 'failed' },
        { id: 'c', title: 'New name', status: 'idle' },
        { id: 'd', title: 'Cached', status: 'stopping' },
      ],
    );
    expect(done).toMatchObject({ state: 'idle', title: 'Cached' });
    expect(failed?.state).toBe('failed');
    expect(renamed).toMatchObject({ state: 'idle', title: 'New name' });
    expect(stopping?.state).toBe('running');
  });

  it('keeps the cached values of a chat that is not in the catalog and the rest of the row', () => {
    const cached = chat({ sessionId: 'gone', pending: 2, lastReport: { at: '2026-11-16T10:00:00Z', excerpt: 'Report' } });
    expect(liveChats([cached], [{ id: 'other', title: 'Other', status: 'idle' }])).toEqual([cached]);
    expect(liveChats([cached], [{ id: 'gone', title: '', status: 'closed' }])[0]).toEqual({ ...cached, state: 'closed' });
  });
});
