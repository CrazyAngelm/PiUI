import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSettings } from '../../../../contracts/workspace-settings-v16';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./transport', () => ({ hostInvoke: invoke, hostListen: vi.fn(), desktopAvailable: true }));
import { onRuntimeSettingsSet, runtimeSettings } from './runtimeSettings';
describe('runtime settings v12', () => {
  it('keeps the model provider identity and uses the versioned allowlisted route', async () => {
    const result: RuntimeSettings = { protocol: 16, sessionId: 'session', model: { id: 'same-id', provider: 'second-provider', name: 'Model' }, models: [], thinkingLevel: 'low', serviceTier: 'fast' };
    invoke.mockResolvedValueOnce(result);
    const command = { type: 'set' as const, sessionId: 'session', model: result.model!, thinkingLevel: 'low', serviceTier: 'fast' as const };
    expect(await runtimeSettings(command)).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith('workspace_settings_v16', { command });
  });
  it('rejects another session response and preserves safe host errors', async () => {
    invoke.mockResolvedValueOnce({ protocol: 16, sessionId: 'other' });
    await expect(runtimeSettings({ type: 'get', sessionId: 'session' })).rejects.toThrow();
    invoke.mockRejectedValueOnce({ code: 'SAFE_MODE', detail: 'PRIVATE' });
    await expect(runtimeSettings({ type: 'get', sessionId: 'session' })).rejects.toThrow('Runtime actions are disabled in safe mode.');
  });
  it('announces confirmed changes, and only those', async () => {
    const result: RuntimeSettings = { protocol: 16, sessionId: 'session', model: { id: 'model', name: 'Model' }, models: [], thinkingLevel: 'high', serviceTier: null };
    const listener = vi.fn();
    const unsubscribe = onRuntimeSettingsSet(listener);
    const set = { type: 'set' as const, sessionId: 'session', model: result.model!, thinkingLevel: 'high' };
    invoke.mockResolvedValueOnce(result);
    await runtimeSettings(set);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(result);
    invoke.mockResolvedValueOnce(result);
    await runtimeSettings({ type: 'get', sessionId: 'session' });
    expect(listener).toHaveBeenCalledTimes(1);
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    await expect(runtimeSettings(set)).rejects.toThrow();
    invoke.mockResolvedValueOnce({ ...result, sessionId: 'other' });
    await expect(runtimeSettings(set)).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    invoke.mockResolvedValueOnce(result);
    await runtimeSettings(set);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
