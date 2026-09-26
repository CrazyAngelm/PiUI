import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./transport', () => ({ hostInvoke: invoke, hostListen: vi.fn(), desktopAvailable: true }));
let harnessModels: typeof import('./harnessModels').harnessModels;
let workspaceModel: typeof import('./harnessModels').workspaceModel;
beforeEach(async () => { vi.resetModules(); invoke.mockReset(); ({ harnessModels, workspaceModel } = await import('./harnessModels')); });

describe('native harness catalog v18', () => {
  it('preserves provider identity and native capability values', async () => {
    const result = { protocol: 18, harness: 'pi', models: [{ id: 'model', provider: 'local', name: 'Model', thinkingLevels: ['off', 'high'] }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(result);
    expect(await harnessModels({ workspaceId: 'project', harness: 'pi' })).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith('harness_models_v18', { request: { workspaceId: 'project', harness: 'pi' } });
  });
  it('shares concurrent loads, reuses all five catalogs and refreshes explicitly', async () => {
    for (const harness of ['pi', 'codex', 'prime-agent', 'hermes', 'claude-code'] as const) {
      const request = { workspaceId: 'project', harness };
      const result = { protocol: 18, harness, models: [], resources: { items: [], warnings: [] } };
      let complete!: (value: typeof result) => void;
      invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      const first = harnessModels(request), second = harnessModels(request), concurrentRefresh = harnessModels(request, true);
      expect(second).toBe(first); expect(concurrentRefresh).toBe(first);
      complete(result); await first;
      const calls = invoke.mock.calls.length;
      expect(await harnessModels(request)).toBe(result);
      expect(invoke).toHaveBeenCalledTimes(calls);
      invoke.mockResolvedValueOnce(result);
      await harnessModels(request, true);
      expect(invoke).toHaveBeenCalledTimes(calls + 1);
      invoke.mockResolvedValueOnce(result);
      await harnessModels({ ...request, workspaceId: 'other-project' });
      expect(invoke).toHaveBeenCalledTimes(calls + 2);
    }
  });
  it('does not cache failures or show session-history errors for catalog failures', async () => {
    const request = { workspaceId: 'project', harness: 'prime-agent' as const };
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    await expect(harnessModels(request)).rejects.toThrow('Could not load models.');
    const result = { protocol: 18, harness: 'prime-agent', models: [], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(result);
    expect(await harnessModels(request)).toEqual(result);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('rejects a mismatched harness and sanitizes native failures', async () => {
    invoke.mockResolvedValueOnce({ protocol: 18, harness: 'codex' });
    await expect(harnessModels({ workspaceId: 'project', harness: 'pi' })).rejects.toThrow();
    invoke.mockRejectedValueOnce({ code: 'SAFE_MODE', detail: 'PRIVATE' });
    await expect(harnessModels({ workspaceId: 'project', harness: 'pi' })).rejects.toThrow('Runtime actions are disabled in safe mode.');
  });
  it('turns a refused Claude Code login into the fixed sign-in guidance and retries later', async () => {
    const request = { workspaceId: 'project', harness: 'claude-code' as const };
    invoke.mockRejectedValueOnce({ code: 'SIGN_IN_REQUIRED', message: 'host text is not trusted', recoverable: true });
    await expect(harnessModels(request)).rejects.toMatchObject({
      code: 'SIGN_IN_REQUIRED',
      message: 'Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.',
    });
    const result = { protocol: 18, harness: 'claude-code', models: [{ id: 'sonnet', provider: 'anthropic', name: 'Sonnet', thinkingLevels: ['low', 'high'], supportsFast: false }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(result);
    expect(await harnessModels(request), 'a failure is never cached').toEqual(result);
  });
  it('forwards only session model fields: the host rejects catalog-only fields', () => {
    const catalogEntry = { id: 'gpt-5.5', provider: null as unknown as string, name: 'GPT-5.5', thinkingLevels: ['low', 'high'], supportsFast: true };
    expect(workspaceModel(catalogEntry)).toEqual({ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'high'] });
    expect(workspaceModel({ id: 'sonnet', provider: 'anthropic', name: 'Sonnet' })).toEqual({ id: 'sonnet', provider: 'anthropic', name: 'Sonnet' });
  });
});
