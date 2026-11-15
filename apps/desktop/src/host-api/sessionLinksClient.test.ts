import { describe, expect, it, vi } from 'vitest';
import { createSessionLinksClient, decodeSessionLinksChanged, decodeSessionLinksResult, SESSION_LINKS_EVENT_V1 } from './sessionLinksClient';
import type { HostListen } from './transport';

const linked = { sessionId: 'child', title: 'Review', harness: 'codex', kind: 'agent', relation: 'child', state: 'idle', pending: 0, lastReport: { at: '2026-11-16T00:00:00Z', excerpt: 'Reviewed.' } };
describe('linked chats host contract v1', () => {
  it('validates and routes find, mutations and settings', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ type: 'links', sessionId: 'parent', chats: [linked], revision: 1 }).mockResolvedValueOnce({ type: 'done' }).mockResolvedValueOnce({ type: 'settings', enabled: true, readOnly: false });
    const client = createSessionLinksClient(invoke, vi.fn());
    expect(await client.request({ op: 'find', sessionId: 'parent' })).toMatchObject({ type: 'links', chats: [linked] });
    expect(invoke).toHaveBeenLastCalledWith('session_links_command_v1', { command: { op: 'find', sessionId: 'parent' } });
    expect(await client.request({ op: 'link', sessionId: 'parent', otherSessionId: 'child' })).toEqual({ type: 'done' });
    expect(await client.request({ op: 'settings' })).toEqual({ type: 'settings', enabled: true, readOnly: false });
  });
  it.each([null, {}, { type: 'settings', enabled: 1, readOnly: false }, { type: 'links', sessionId: 'parent', revision: -1, chats: [] }, { type: 'links', sessionId: 'parent', revision: 1, chats: [{ ...linked, harness: 'unknown' }] }, { type: 'links', sessionId: 'parent', revision: 1, chats: [{ ...linked, pending: 0.5 }] }, { type: 'links', sessionId: 'parent', revision: 1, chats: [{ ...linked, lastReport: { at: 'bad', excerpt: 'x' } }] }])('rejects malformed answers %s', value => {
    expect(decodeSessionLinksResult(value)).toBeUndefined();
  });
  it('rejects answers for another command or session', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ type: 'links', sessionId: 'another', revision: 0, chats: [] }).mockResolvedValueOnce({ type: 'done' });
    const client = createSessionLinksClient(invoke, vi.fn());
    await expect(client.request({ op: 'find', sessionId: 'parent' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.request({ op: 'settings' })).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('keeps typed fixed host refusals and maps unknown failures', async () => {
    const invoke = vi.fn().mockRejectedValueOnce({ code: 'authority-denied', message: 'A linked chat cannot have more access than its parent.' }).mockRejectedValueOnce('native details');
    const client = createSessionLinksClient(invoke, vi.fn());
    await expect(client.request({ op: 'settings' })).rejects.toMatchObject({ code: 'authority-denied' });
    await expect(client.request({ op: 'settings' })).rejects.toMatchObject({ code: 'unavailable', message: 'Linked chats are unavailable right now.' });
  });
  it('listens on the typed channel and drops malformed events', async () => {
    let receive!: (payload: unknown) => void;
    const stop = vi.fn();
    const channels: string[] = [];
    const listen: HostListen = async (channel, handler) => { channels.push(channel); receive = handler as (payload: unknown) => void; return stop; };
    const client = createSessionLinksClient(vi.fn(), listen);
    const changed = vi.fn();
    expect(await client.onChanged(changed)).toBe(stop);
    expect(channels).toEqual([SESSION_LINKS_EVENT_V1]);
    receive({ sessionId: 'parent', revision: 2 });
    receive({ sessionId: 'parent', revision: '3' });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ sessionId: 'parent', revision: 2 });
    expect(decodeSessionLinksChanged({ sessionId: '', revision: 1 })).toBeUndefined();
  });
});
