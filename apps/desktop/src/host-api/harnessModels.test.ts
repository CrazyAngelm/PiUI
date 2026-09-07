import { describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { harnessModels } from './harnessModels';

describe('native harness catalog v14', () => {
  it('preserves provider identity and native capability values', async () => {
    const result = { protocol: 14, harness: 'pi', models: [{ id: 'model', provider: 'local', name: 'Model', thinkingLevels: ['off', 'high'] }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(result);
    expect(await harnessModels({ workspaceId: 'project', harness: 'pi' })).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith('harness_models_v14', { request: { workspaceId: 'project', harness: 'pi' } });
  });
  it('rejects a mismatched harness and sanitizes native failures', async () => {
    invoke.mockResolvedValueOnce({ protocol: 14, harness: 'codex' });
    await expect(harnessModels({ workspaceId: 'project', harness: 'pi' })).rejects.toThrow();
    invoke.mockRejectedValueOnce({ code: 'SAFE_MODE', detail: 'PRIVATE' });
    await expect(harnessModels({ workspaceId: 'project', harness: 'pi' })).rejects.toThrow('Runtime actions are disabled in safe mode.');
  });
});
