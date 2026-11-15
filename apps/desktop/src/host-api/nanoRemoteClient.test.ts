import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/fixtures/nano-remote-v1.json';
import {
  NANO_REMOTE_ERROR_COPY,
  NANO_REMOTE_EVENT_V1,
  NanoRemoteOperationError,
  createNanoRemoteClient,
  decodeNanoRemoteEvent,
  decodeNanoRemoteStatus,
  nanoRemoteError,
  type NanoRemoteEventV1,
} from './nanoRemoteClient';

const STATUS_KEYS = ['statusOff', 'statusSafeMode', 'statusPending', 'statusViewer'] as const;

describe('Nano remote access v1 client', () => {
  it('accepts every status in the public fixture and reproduces it unchanged', () => {
    for (const key of STATUS_KEYS) {
      expect(decodeNanoRemoteStatus(fixture[key]), key).toEqual(fixture[key]);
    }
    expect(decodeNanoRemoteEvent({ type: 'status', status: fixture.statusViewer })).toEqual({ type: 'status', status: fixture.statusViewer });
  });

  it('refuses statuses outside the contract', () => {
    const base = fixture.statusViewer;
    const pending = fixture.statusPending;
    const broken: unknown[] = [
      null,
      'off',
      [],
      { ...base, protocol: 2 },
      { ...base, revision: -1 },
      { ...base, revision: 1.5 },
      { ...base, unavailable: 'offline' },
      { ...base, unavailable: undefined },
      { ...base, enabled: 'yes' },
      { ...base, link: 'asleep' },
      { ...base, viewers: 'none' },
      { ...base, viewers: [{ ...base.viewers[0], grant: 'forever' }] },
      { ...base, viewers: [{ ...base.viewers[0], id: 7 }] },
      { ...base, viewers: [{ id: 'vw_x' }] },
      { ...base, pending: {} },
      { ...base, pending: { ...pending.pending, code: '12345' } },
      { ...base, pending: { ...pending.pending, code: 'abcdef' } },
      { ...base, pending: { ...pending.pending, requestId: 3 } },
      { ...base, browsers: [{ ...base.browsers[0], createdAt: 5 }] },
      { ...base, browsers: [{ ...base.browsers[0], lastUsedAt: 5 }] },
      { ...base, browsers: {} },
    ];
    for (const value of broken) {
      expect(decodeNanoRemoteStatus(value), JSON.stringify(value)?.slice(0, 80)).toBeUndefined();
    }
    expect(decodeNanoRemoteEvent({ type: 'progress', status: base })).toBeUndefined();
    expect(decodeNanoRemoteEvent({ type: 'status', status: { ...base, protocol: 0 } })).toBeUndefined();
    expect(decodeNanoRemoteEvent(null)).toBeUndefined();
  });

  it('accepts a browser that was never used and a viewer allowed once', () => {
    const base = fixture.statusViewer;
    const next = {
      ...base,
      viewers: [{ ...base.viewers[0], grant: 'once' }],
      browsers: [{ ...base.browsers[0], lastUsedAt: null }],
    };
    expect(decodeNanoRemoteStatus(next)).toEqual(next);
  });

  it('maps host refusals to fixed copy and never forwards host details', () => {
    for (const code of Object.keys(NANO_REMOTE_ERROR_COPY)) {
      const error = nanoRemoteError({ code, message: 'C:/secret/path and token abc' });
      expect(error).toBeInstanceOf(NanoRemoteOperationError);
      expect(error.message).toBe(NANO_REMOTE_ERROR_COPY[code as keyof typeof NANO_REMOTE_ERROR_COPY]);
      expect(error.message).not.toContain('secret');
    }
    expect(nanoRemoteError(JSON.stringify({ code: 'limit' })).code).toBe('limit');
    expect(nanoRemoteError('Command nano_remote_status_v1 not found').code).toBe('unknown');
    expect(nanoRemoteError({ code: 'launch-missiles' }).code).toBe('unknown');
    expect(nanoRemoteError(new Error('boom')).code).toBe('unknown');
    expect(nanoRemoteError({ code: 'remote-not-allowed' }).code).toBe('unknown');
  });

  it('keeps the copy table in step with every contract error code', () => {
    const contractCodes = ['invalid', 'safe-mode', 'sign-in-required', 'unsupported-server', 'not-found', 'limit', 'io'];
    expect(Object.keys(NANO_REMOTE_ERROR_COPY).sort()).toEqual([...contractCodes, 'unknown'].sort());
    for (const copy of Object.values(NANO_REMOTE_ERROR_COPY)) expect(copy.length).toBeGreaterThan(10);
  });

  it('sends the commands the contract lists with `{ request }` and drops malformed events', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const listeners: ((payload: unknown) => void)[] = [];
    const client = createNanoRemoteClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        if (command === 'nano_remote_forget_v1') throw { code: 'not-found' };
        if (command === 'nano_remote_kick_v1') return { protocol: 2 } as T;
        return fixture.statusOff as T;
      },
      async <T>(channel: string, handler: (payload: T) => void) => {
        expect(channel).toBe(NANO_REMOTE_EVENT_V1);
        listeners.push(handler as (payload: unknown) => void);
        return () => undefined;
      },
    );
    await client.status();
    await client.setEnabled(true);
    await client.decide('req_synthetic01', 'always');
    expect(calls).toEqual([
      ['nano_remote_status_v1', undefined],
      ['nano_remote_set_enabled_v1', { request: { enabled: true } }],
      ['nano_remote_decide_v1', { request: { requestId: 'req_synthetic01', decision: 'always' } }],
    ]);
    await expect(client.forget('br_synthetic01')).rejects.toMatchObject({ code: 'not-found' });
    await expect(client.kick('vw_synthetic0000000000001')).rejects.toMatchObject({ code: 'unknown' });
    expect(calls.at(-1)).toEqual(['nano_remote_kick_v1', { request: { viewerId: 'vw_synthetic0000000000001' } }]);

    const events: NanoRemoteEventV1[] = [];
    await client.listen((event) => events.push(event));
    listeners[0]?.({ type: 'status', status: fixture.statusPending });
    listeners[0]?.({ type: 'status', status: { ...fixture.statusPending, protocol: 9 } });
    listeners[0]?.('nonsense');
    expect(events).toEqual([{ type: 'status', status: fixture.statusPending }]);
  });

  it('turns an answer that is not a status into an unknown failure', async () => {
    const client = createNanoRemoteClient(async <T>() => ({ ok: true }) as T, async () => () => undefined);
    await expect(client.status()).rejects.toMatchObject({ code: 'unknown' });
  });
});
