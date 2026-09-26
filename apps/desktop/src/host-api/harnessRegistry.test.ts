import { describe, expect, it, vi } from 'vitest';
import { harnessRegistryFixture } from '../../../../contracts/fixtures/harness-registry-v1';
import { createHarnessRegistryClient, harnessRegistryError, HarnessRegistryError } from './harnessRegistry';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./transport', () => ({ hostInvoke: invoke, hostListen: vi.fn(), desktopAvailable: true }));

describe('harness registry v1 client', () => {
  it('uses the versioned route and returns the registry', async () => {
    const run = vi.fn(async () => harnessRegistryFixture as unknown);
    const client = createHarnessRegistryClient(run as never, vi.fn() as never);
    expect(await client.run({ type: 'check', harness: 'acp:gemini-cli' })).toEqual(harnessRegistryFixture);
    expect(run).toHaveBeenLastCalledWith('harness_registry_v1', { command: { type: 'check', harness: 'acp:gemini-cli' } });
  });

  it('keeps host codes and fixed messages, and hides anything unexpected', async () => {
    const client = createHarnessRegistryClient((async () => { throw { code: 'CONFLICT', message: 'The harness list changed. Review it and try again.', recoverable: true }; }) as never, vi.fn() as never);
    await expect(client.run({ type: 'remove', expectedRevision: 1, id: 'lab-agent' })).rejects.toMatchObject({
      code: 'CONFLICT', message: 'The harness list changed. Review it and try again.',
    });
    expect(harnessRegistryError({ code: 'INVALID_DESCRIPTOR', message: 'The program must be a file name found on PATH or an absolute path.' }))
      .toMatchObject({ code: 'INVALID_DESCRIPTOR', message: 'The program must be a file name found on PATH or an absolute path.' });
    // Unknown codes, native text with control characters and Tauri strings never reach the UI.
    for (const cause of [{ code: 'EXPLODED', message: 'stack trace' }, { code: 'CONFLICT', message: 'line\nbreak' }, 'Command harness_registry_v1 not found', undefined]) {
      const mapped = harnessRegistryError(cause);
      expect(mapped).toBeInstanceOf(HarnessRegistryError);
      expect(mapped.message).toBe('PiUI could not read the harness list.');
    }
    expect(harnessRegistryError({ code: 'CONFLICT', message: 'line\nbreak' }).code).toBe('CONFLICT');
    expect(harnessRegistryError('Command harness_registry_v1 not found').code).toBe('UNAVAILABLE');
    const invalid = createHarnessRegistryClient((async () => ({ protocol: 2 })) as never, vi.fn() as never);
    await expect(invalid.run({ type: 'list' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('forwards only well-formed change events', async () => {
    let deliver: ((payload: unknown) => void) | undefined;
    const listen = vi.fn(async (_channel: string, handler: (payload: unknown) => void) => { deliver = handler; return () => undefined; });
    const client = createHarnessRegistryClient(vi.fn() as never, listen as never);
    const changes: unknown[] = [];
    await client.listen((change) => changes.push(change));
    expect(listen).toHaveBeenCalledWith('piui://harness-registry-v1', expect.any(Function));
    deliver?.({ protocol: 1, revision: 4 });
    deliver?.({ protocol: 2, revision: 5 });
    deliver?.('noise');
    expect(changes).toEqual([{ protocol: 1, revision: 4 }]);
  });
});

describe('session mode v1 client', () => {
  it('uses the versioned route and maps host errors', async () => {
    const { setSessionMode } = await import('./sessionMode');
    const result = { protocol: 1, sessionId: 'session', modes: { current: 'plan', available: [{ id: 'plan', name: 'Plan' }] } };
    invoke.mockResolvedValueOnce(result);
    expect(await setSessionMode({ sessionId: 'session', modeId: 'plan' })).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith('workspace_session_mode_v1', { request: { sessionId: 'session', modeId: 'plan' } });
    invoke.mockResolvedValueOnce({ protocol: 1, sessionId: 'other' });
    await expect(setSessionMode({ sessionId: 'session', modeId: 'plan' })).rejects.toThrow('The workspace operation could not be completed.');
    invoke.mockRejectedValueOnce({ code: 'NOT_SUPPORTED' });
    await expect(setSessionMode({ sessionId: 'session', modeId: 'plan' })).rejects.toThrow('This operation is not supported by the selected harness or current mode.');
  });
});
