import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSettings } from '../../../../contracts/workspace-settings-v12';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { runtimeSettings } from './runtimeSettings';
describe('runtime settings v12', () => {
  it('keeps the model provider identity and uses the versioned allowlisted route', async () => {
    const result: RuntimeSettings = { protocol: 12, sessionId: 'session', model: { id: 'same-id', provider: 'second-provider', name: 'Model' }, models: [], thinkingLevel: 'low', serviceTier: 'fast' };
    invoke.mockResolvedValueOnce(result);
    const command = { type: 'set' as const, sessionId: 'session', model: result.model!, thinkingLevel: 'low', serviceTier: 'fast' as const };
    expect(await runtimeSettings(command)).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith('workspace_settings_v12', { command });
  });
  it('rejects another session response and preserves safe host errors', async () => {
    invoke.mockResolvedValueOnce({ protocol: 12, sessionId: 'other' });
    await expect(runtimeSettings({ type: 'get', sessionId: 'session' })).rejects.toThrow();
    invoke.mockRejectedValueOnce({ code: 'SAFE_MODE', detail: 'PRIVATE' });
    await expect(runtimeSettings({ type: 'get', sessionId: 'session' })).rejects.toThrow('Runtime actions are disabled in safe mode.');
  });
});
