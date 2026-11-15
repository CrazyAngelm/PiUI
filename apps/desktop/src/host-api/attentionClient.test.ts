import { describe, expect, it, vi } from 'vitest';
import { createAttentionClient } from './attentionClient';
import { labHost } from './lab/labTestKit';

describe('attention client', () => {
  it('sends the count and the flash to attention_set_v1', async () => {
    const invoke = vi.fn(async () => null);
    const client = createAttentionClient(invoke as never);
    expect(await client.set({ count: 3, flash: true })).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('attention_set_v1', { request: { count: 3, flash: true } });
  });

  it('caps and rounds the count to what the host accepts', async () => {
    const invoke = vi.fn(async () => null);
    const client = createAttentionClient(invoke as never);
    await client.set({ count: 123456, flash: false });
    await client.set({ count: -4, flash: false });
    await client.set({ count: 2.9, flash: false });
    await client.set({ count: Number.NaN, flash: false });
    expect(invoke.mock.calls.map((call) => (call as unknown as [string, { request: { count: number } }])[1].request.count)).toEqual([9999, 0, 2, 0]);
  });

  it('answers with the host refusal code and never throws', async () => {
    expect(await createAttentionClient((async () => Promise.reject({ code: 'unavailable' })) as never).set({ count: 1, flash: false })).toBe('unavailable');
    expect(await createAttentionClient((async () => Promise.reject({ code: 'failed' })) as never).set({ count: 1, flash: false })).toBe('failed');
    expect(await createAttentionClient((async () => Promise.reject('Command attention_set_v1 not found')) as never).set({ count: 1, flash: false })).toBe('unknown');
  });
});

describe('attention in the UI Lab', () => {
  it('accepts a report and refuses what the host refuses', async () => {
    const host = labHost('demo');
    const client = createAttentionClient((command, args) => host.invoke(command, args));
    expect(await client.set({ count: 2, flash: false })).toBeUndefined();
    expect(await client.set({ count: 0, flash: false })).toBeUndefined();
    await expect(host.invoke('attention_set_v1', { request: { count: 1, flash: false, sound: true } })).rejects.toEqual({ code: 'failed' });
    await expect(host.invoke('attention_set_v1', { request: { count: 1 } })).rejects.toEqual({ code: 'failed' });
  });
});
