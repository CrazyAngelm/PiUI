import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./transport', () => ({
  hostInvoke: async (...args: unknown[]) => ({ protocol: 19, catalog: await invoke(...args) }),
  hostListen: vi.fn(), desktopAvailable: true,
}));
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  get length() { return memory.size; },
  key: (index: number) => [...memory.keys()][index] ?? null,
});
let harnessModels: typeof import('./harnessModels').harnessModels;
let workspaceModel: typeof import('./harnessModels').workspaceModel;
beforeEach(async () => { vi.resetModules(); invoke.mockReset(); ({ harnessModels, workspaceModel } = await import('./harnessModels')); });

describe('native harness catalog v19 with v18 catalog data', () => {
  it('preserves provider identity and native capability values', async () => {
    const result = { protocol: 18, harness: 'pi', models: [{ id: 'model', provider: 'local', name: 'Model', thinkingLevels: ['off', 'high'] }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(result).mockResolvedValueOnce(result);
    expect(await harnessModels({ workspaceId: 'project', harness: 'pi' })).toEqual(result);
    const discoveryId = invoke.mock.calls[0]![1].request.discoveryId;
    expect(discoveryId).toMatch(/^[\da-f-]{36}$/u);
    expect(invoke).toHaveBeenLastCalledWith('harness_models_v19', { request: { workspaceId: 'project', harness: 'pi', part: 'resources', discoveryId } });
  });
  it('shares concurrent loads, reuses all six catalogs and refreshes explicitly', async () => {
    for (const harness of ['pi', 'codex', 'prime-agent', 'hermes', 'claude-code', 'nano'] as const) {
      const request = { workspaceId: 'project', harness };
      const result = { protocol: 18, harness, models: [], resources: { items: [], warnings: [] } };
      let complete!: (value: typeof result) => void;
      invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      invoke.mockResolvedValueOnce(result);
      const first = harnessModels(request), second = harnessModels(request), concurrentRefresh = harnessModels(request, true);
      expect(second).toBe(first); expect(concurrentRefresh).toBe(first);
      complete(result); await first;
      const calls = invoke.mock.calls.length;
      expect(await harnessModels(request)).toEqual(result);
      expect(invoke).toHaveBeenCalledTimes(calls);
      invoke.mockResolvedValueOnce(result).mockResolvedValueOnce(result);
      await harnessModels(request, true);
      expect(invoke).toHaveBeenCalledTimes(calls + 2);
      invoke.mockResolvedValueOnce(result).mockResolvedValueOnce(result);
      await harnessModels({ ...request, workspaceId: 'other-project' });
      expect(invoke).toHaveBeenCalledTimes(calls + 4);
    }
  });
  it('does not cache failures or show session-history errors for catalog failures', async () => {
    const request = { workspaceId: 'project', harness: 'prime-agent' as const };
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    await expect(harnessModels(request)).rejects.toThrow('Could not load models.');
    const result = { protocol: 18, harness: 'prime-agent', models: [], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(result).mockResolvedValueOnce(result);
    expect(await harnessModels(request)).toEqual(result);
    expect(invoke).toHaveBeenCalledTimes(3);
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
    invoke.mockResolvedValueOnce(result).mockResolvedValueOnce(result);
    expect(await harnessModels(request), 'a failure is never cached').toEqual(result);
  });
  it('shows a remembered catalog at once and reports the probe that replaces it', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'claude-code' as const };
    const old = { protocol: 18, harness: 'claude-code', models: [{ id: 'sonnet', name: 'Sonnet' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(old).mockResolvedValueOnce(old);
    await harnessModels(request);
    vi.resetModules();
    const fresh = await import('./harnessModels');
    const next = { ...old, models: [{ id: 'opus', name: 'Opus' }] };
    const found = { ...old, models: [], resources: { items: [{ kind: 'skill', id: 'review', name: 'review', enabled: true, configurable: false }], warnings: [] } };
    let complete!: (value: typeof next) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    invoke.mockResolvedValueOnce(found);
    const onFresh = vi.fn();
    expect(await fresh.cachedHarnessModels(request, { onFresh }), 'no wait for the native probe').toEqual(old);
    expect(onFresh).not.toHaveBeenCalled();
    complete(next);
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith(next));
    await vi.waitFor(() => expect(onFresh).toHaveBeenLastCalledWith({ ...next, resources: found.resources }));
  });
  it('answers a picker with the models before resource discovery finishes', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    const found = { protocol: 18, harness: 'codex', models: [], resources: { items: [{ kind: 'mcp', id: 'docs', name: 'docs', enabled: true, configurable: true }], warnings: [] } };
    let discover!: (value: typeof found) => void;
    invoke.mockResolvedValueOnce(listed);
    invoke.mockImplementationOnce(() => new Promise(resolve => { discover = resolve; }));
    const { cachedHarnessModels } = await import('./harnessModels');
    const onFresh = vi.fn();
    expect(await cachedHarnessModels(request, { onFresh })).toEqual(listed);
    expect(invoke).toHaveBeenNthCalledWith(1, 'harness_models_v19', { request: { ...request, part: 'models', discoveryId: expect.any(String) } });
    await vi.waitFor(() => expect(invoke).toHaveBeenNthCalledWith(2, 'harness_models_v19', { request: { ...request, part: 'resources', discoveryId: expect.any(String) } }));
    discover(found);
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith({ ...listed, resources: found.resources }));
    expect(await harnessModels(request), 'the merged catalog is reused').toEqual({ ...listed, resources: found.resources });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('keeps the models when resource discovery fails', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(listed);
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    const { cachedHarnessModels } = await import('./harnessModels');
    const onFresh = vi.fn();
    expect(await cachedHarnessModels(request, { onFresh })).toEqual(listed);
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith({
      ...listed, resources: { items: [], warnings: ['Skills, MCP servers and tools could not be loaded from the harness.'] },
    }));
  });
  it('answers a second picker with the models while the resources are still loading', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    const found = { protocol: 18, harness: 'codex', models: [], resources: { items: [{ kind: 'mcp', id: 'docs', name: 'docs', enabled: true, configurable: true }], warnings: [] } };
    const merged = { ...listed, resources: found.resources };
    let discover!: (value: typeof found) => void;
    invoke.mockResolvedValueOnce(listed);
    invoke.mockImplementationOnce(() => new Promise(resolve => { discover = resolve; }));
    const { cachedHarnessModels } = await import('./harnessModels');
    const first = vi.fn(), second = vi.fn();
    expect(await cachedHarnessModels(request, { onFresh: first })).toEqual(listed);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(await cachedHarnessModels(request, { onFresh: second }), 'no wait for resource discovery').toEqual(listed);
    expect(invoke, 'the second picker shares the probe').toHaveBeenCalledTimes(2);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    discover(found);
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith(merged));
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith(merged));
  });
  it('does not remember a degraded catalog: the next load asks for the resources again and reuses the models', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    const found = { protocol: 18, harness: 'codex', models: [], resources: { items: [{ kind: 'mcp', id: 'docs', name: 'docs', enabled: true, configurable: true }], warnings: [] } };
    const degraded = { ...listed, resources: { items: [], warnings: ['Skills, MCP servers and tools could not be loaded from the harness.'] } };
    invoke.mockResolvedValueOnce(listed);
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    const { cachedHarnessModels, catalogSettled } = await import('./harnessModels');
    const onFresh = vi.fn();
    await cachedHarnessModels(request, { onFresh });
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith(degraded));
    expect(catalogSettled(request), 'a degraded load has ended').toBe(true);
    invoke.mockResolvedValueOnce(found);
    const retry = vi.fn();
    await cachedHarnessModels(request, { onFresh: retry });
    await vi.waitFor(() => expect(retry).toHaveBeenLastCalledWith({ ...listed, resources: found.resources }));
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(3, 'harness_models_v19', { request: { ...request, part: 'resources', discoveryId: expect.any(String) } });
    expect(await harnessModels(request), 'the complete catalog is reused').toEqual({ ...listed, resources: found.resources });
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it('stores the fresh models with the resources it already had when discovery degrades', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const snapshotKey = `piui.harness.catalog.v1:${JSON.stringify([request.workspaceId, request.harness])}`;
    const earlier = { items: [{ kind: 'skill', id: 'review', name: 'review', enabled: true, configurable: false }], warnings: [] };
    localStorage.setItem(snapshotKey, JSON.stringify({ at: Date.now(), result: { protocol: 18, harness: 'codex', models: [{ id: 'old', name: 'Old' }], resources: earlier } }));
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(listed);
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    const { cachedHarnessModels } = await import('./harnessModels');
    const onFresh = vi.fn();
    expect((await cachedHarnessModels(request, { onFresh })).models, 'the remembered catalog shows first').toEqual([{ id: 'old', name: 'Old' }]);
    await vi.waitFor(() => expect(onFresh).toHaveBeenLastCalledWith({ ...listed, resources: { items: [], warnings: ['Skills, MCP servers and tools could not be loaded from the harness.'] } }));
    expect(JSON.parse(memory.get(snapshotKey) ?? 'null').result).toEqual({ ...listed, resources: earlier });
  });
  it('reports a catalog settled only while neither its models nor its resources are in flight', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    const found = { ...listed, models: [] };
    let list!: (value: typeof listed) => void, discover!: (value: typeof found) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { list = resolve; }));
    invoke.mockImplementationOnce(() => new Promise(resolve => { discover = resolve; }));
    const { cachedHarnessModels, catalogSettled } = await import('./harnessModels');
    expect(catalogSettled(request), 'nothing requested').toBe(true);
    const loading = cachedHarnessModels(request);
    expect(catalogSettled(request), 'models in flight').toBe(false);
    list(listed);
    await loading;
    expect(catalogSettled(request), 'models answered, resources in flight').toBe(false);
    expect(catalogSettled({ ...request, workspaceId: 'other-project' }), 'another project is unaffected').toBe(true);
    expect(catalogSettled({ ...request, harness: 'pi' }), 'another harness is unaffected').toBe(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    discover(found);
    await vi.waitFor(() => expect(catalogSettled(request)).toBe(true));
    expect(await harnessModels(request), 'the settled catalog is complete').toEqual(listed);
    invoke.mockImplementationOnce(() => new Promise(resolve => { list = resolve; }));
    const refresh = harnessModels(request, true);
    expect(catalogSettled(request), 'an explicit refresh is in flight').toBe(false);
    list(listed);
    await refresh;
    expect(catalogSettled(request)).toBe(true);
  });
  it('asks the harness again after a failed explicit refresh instead of reusing the parts it replaced', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(listed);
    invoke.mockResolvedValueOnce(listed);
    const { cachedHarnessModels, catalogSettled } = await import('./harnessModels');
    await cachedHarnessModels(request);
    await vi.waitFor(() => expect(catalogSettled(request)).toBe(true));
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    await expect(harnessModels(request, true)).rejects.toThrow('Could not load models.');
    invoke.mockResolvedValueOnce(listed);
    invoke.mockResolvedValueOnce(listed);
    await cachedHarnessModels(request);
    expect(invoke).toHaveBeenNthCalledWith(4, 'harness_models_v19', { request: { ...request, part: 'models', discoveryId: expect.any(String) } });
  });
  it('does not remember resources the host degraded to a warning, on the split and the full path', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const warning = 'Skills, MCP servers and tools could not be loaded from the harness.';
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    const warned = { ...listed, models: [], resources: { items: [], warnings: [warning] } };
    const found = { ...listed, models: [], resources: { items: [{ kind: 'mcp', id: 'docs', name: 'docs', enabled: true, configurable: true }], warnings: [] } };
    invoke.mockResolvedValueOnce(listed);
    invoke.mockResolvedValueOnce(warned);
    const { cachedHarnessModels, catalogDegraded, catalogSettled } = await import('./harnessModels');
    const onFresh = vi.fn();
    await cachedHarnessModels(request, { onFresh });
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith({ ...listed, resources: warned.resources }));
    expect(catalogDegraded(onFresh.mock.calls[0]![0])).toBe(true);
    expect(catalogSettled(request)).toBe(true);
    invoke.mockResolvedValueOnce(found);
    const retry = vi.fn();
    await cachedHarnessModels(request, { onFresh: retry });
    await vi.waitFor(() => expect(retry).toHaveBeenLastCalledWith({ ...listed, resources: found.resources }));
    expect(invoke).toHaveBeenNthCalledWith(3, 'harness_models_v19', { request: { ...request, part: 'resources', discoveryId: expect.any(String) } });

    const other = { workspaceId: 'other', harness: 'codex' as const };
    invoke.mockResolvedValueOnce(listed).mockResolvedValueOnce(warned);
    expect(catalogDegraded(await harnessModels(other))).toBe(true);
    invoke.mockResolvedValueOnce({ ...listed, resources: found.resources });
    expect((await harnessModels(other)).resources, 'the degraded full answer was not reused').toEqual(found.resources);
    expect(invoke).toHaveBeenCalledTimes(6);
  });
  it('shows a later picker the snapshot first, then the answers it already has', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const snapshotKey = `piui.harness.catalog.v1:${JSON.stringify([request.workspaceId, request.harness])}`;
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    let discover!: (value: typeof listed) => void;
    invoke.mockResolvedValueOnce(listed);
    invoke.mockImplementationOnce(() => new Promise(resolve => { discover = resolve; }));
    const { cachedHarnessModels } = await import('./harnessModels');
    await cachedHarnessModels(request);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    localStorage.setItem(snapshotKey, JSON.stringify({ at: Date.now(), result: { ...listed, models: [{ id: 'old', name: 'Old' }] } }));
    const seen: string[] = [];
    const shown = cachedHarnessModels(request, { onFresh: result => seen.push(`fresh:${result.models[0]?.id}`) });
    await shown.then(result => seen.push(`first:${result.models[0]?.id}`));
    await vi.waitFor(() => expect(seen).toContain('fresh:gpt'));
    expect(seen[0]).toBe('first:old');
    discover(listed);
  });
  it('an explicit refresh asks for the models even while a split load is reusing them', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(listed);
    invoke.mockImplementationOnce(() => new Promise(() => undefined));
    const { cachedHarnessModels } = await import('./harnessModels');
    await cachedHarnessModels(request);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    const newer = { ...listed, models: [{ id: 'gpt-2', name: 'GPT 2' }] };
    invoke.mockResolvedValueOnce(newer).mockResolvedValueOnce(newer);
    expect(await harnessModels(request, true)).toEqual(newer);
    expect(invoke).toHaveBeenNthCalledWith(3, 'harness_models_v19', { request: { ...request, part: 'models', discoveryId: expect.any(String) } });
  });
  it('settles a catalog whose models failed', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    const { cachedHarnessModels, catalogSettled } = await import('./harnessModels');
    const loading = cachedHarnessModels(request);
    expect(catalogSettled(request)).toBe(false);
    await expect(loading).rejects.toThrow('Could not load models.');
    await vi.waitFor(() => expect(catalogSettled(request)).toBe(true));
  });
  it('forgets a remembered catalog when the probe fails and never serves it to direct callers', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'claude-code' as const };
    invoke.mockResolvedValue({ protocol: 18, harness: 'claude-code', models: [], resources: { items: [], warnings: [] } });
    await harnessModels(request);
    vi.resetModules();
    let fresh = await import('./harnessModels');
    invoke.mockRejectedValueOnce({ code: 'SIGN_IN_REQUIRED', recoverable: true });
    await expect(fresh.harnessModels(request), 'sign-in checks see the probe').rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
    vi.resetModules();
    fresh = await import('./harnessModels');
    invoke.mockRejectedValueOnce({ code: 'SIGN_IN_REQUIRED', recoverable: true });
    await expect(fresh.cachedHarnessModels(request), 'no snapshot after a failure').rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
  });
  it('forgets the answers and remembered snapshots of one harness and keeps the others', async () => {
    localStorage.clear();
    const snapshotKey = (workspaceId: string, harness: string): string => `piui.harness.catalog.v1:${JSON.stringify([workspaceId, harness])}`;
    const answer = (harness: string, id: string) => ({ protocol: 18, harness, models: [{ id, name: id }], resources: { items: [], warnings: [] } });
    const { forgetHarnessCatalogs } = await import('./harnessModels');
    const nano = { workspaceId: 'project', harness: 'nano' as const };
    const otherNano = { workspaceId: 'other-project', harness: 'nano' as const };
    const codex = { workspaceId: 'project', harness: 'codex' as const };
    invoke.mockResolvedValueOnce(answer('nano', 'auto'));
    invoke.mockResolvedValueOnce(answer('nano', 'auto'));
    invoke.mockResolvedValueOnce(answer('codex', 'gpt'));
    invoke.mockResolvedValueOnce(answer('nano', 'auto'));
    invoke.mockResolvedValueOnce(answer('nano', 'auto'));
    invoke.mockResolvedValueOnce(answer('codex', 'gpt'));
    await Promise.all([harnessModels(nano), harnessModels(otherNano), harnessModels(codex)]);
    expect(invoke).toHaveBeenCalledTimes(6);
    // Snapshots of older sessions: a part key never appears in storage, a full key does.
    for (const key of [snapshotKey('project', 'nano'), snapshotKey('other-project', 'nano'), snapshotKey('project', 'codex')]) {
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), result: answer(JSON.parse(key.slice('piui.harness.catalog.v1:'.length))[1], 'old') }));
    }
    localStorage.setItem('unrelated', 'kept');

    forgetHarnessCatalogs('nano');
    expect([...memory.keys()].sort()).toEqual([snapshotKey('project', 'codex'), snapshotKey('*', 'codex'), 'unrelated'].sort());
    expect(await harnessModels(codex), 'another harness is reused').toEqual(answer('codex', 'gpt'));
    expect(invoke).toHaveBeenCalledTimes(6);
    invoke.mockResolvedValueOnce(answer('nano', 'free')).mockResolvedValueOnce(answer('nano', 'free'));
    expect(await harnessModels(nano), 'a forgotten catalog is asked for again').toEqual(answer('nano', 'free'));
    expect(invoke).toHaveBeenCalledTimes(8);
  });
  it('forgets the part entries of a split load too', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'nano' as const };
    const listed = { protocol: 18, harness: 'nano', models: [{ id: 'auto', name: 'Auto' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(listed);
    invoke.mockResolvedValueOnce(listed);
    const { cachedHarnessModels, catalogSettled, forgetHarnessCatalogs } = await import('./harnessModels');
    await cachedHarnessModels(request);
    await vi.waitFor(() => expect(catalogSettled(request)).toBe(true));
    expect(invoke).toHaveBeenCalledTimes(2);
    forgetHarnessCatalogs('nano');
    const next = { ...listed, models: [{ id: 'free', name: 'Free' }] };
    invoke.mockResolvedValueOnce(next);
    invoke.mockResolvedValueOnce(next);
    expect((await cachedHarnessModels(request)).models, 'neither the full entry nor the models part is reused').toEqual(next.models);
    expect(invoke).toHaveBeenNthCalledWith(3, 'harness_models_v19', { request: { ...request, part: 'models', discoveryId: expect.any(String) } });
  });
  it('never remembers a Nano catalog in storage and never shows one from an earlier session', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'nano' as const };
    const snapshotKey = `piui.harness.catalog.v1:${JSON.stringify([request.workspaceId, request.harness])}`;
    const earlier = { protocol: 18, harness: 'nano', models: [{ id: 'smart', name: 'Smart' }], resources: { items: [], warnings: [] } };
    localStorage.setItem(snapshotKey, JSON.stringify({ at: Date.now(), result: earlier }));
    const listed = { ...earlier, models: [{ id: 'free', name: 'Free' }] };
    invoke.mockResolvedValueOnce(listed);
    invoke.mockResolvedValueOnce(listed);
    const { cachedHarnessModels, catalogSettled } = await import('./harnessModels');
    expect((await cachedHarnessModels(request)).models, 'the remembered modes are not shown').toEqual(listed.models);
    await vi.waitFor(() => expect(catalogSettled(request)).toBe(true));
    expect(JSON.parse(memory.get(snapshotKey) ?? 'null').result.models, 'the old snapshot is untouched, not rewritten').toEqual(earlier.models);
    // The full (non-split) load stores nothing either.
    localStorage.clear();
    invoke.mockResolvedValueOnce(listed).mockResolvedValueOnce(listed);
    await harnessModels({ ...request, workspaceId: 'other-project' });
    expect([...memory.keys()].filter((key) => key.includes('nano'))).toEqual([]);
  });
  it('never remembers the Nano group of an agent with a Nano source and never shows one from storage', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'acp:opencode' as const };
    const snapshotKey = (workspaceId: string) => `piui.harness.catalog.v1:${JSON.stringify([workspaceId, 'acp:opencode'])}`;
    const own = { id: 'default', name: 'Agent default' };
    const nativeNano = { id: 'nano/native', provider: 'nano', name: 'Native provider model' };
    const nano = { id: 'auto', provider: 'nano', name: 'Auto' };
    const native = [own, nativeNano];
    const listed = { protocol: 18, harness: 'acp:opencode', models: [...native, nano], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(listed).mockResolvedValueOnce(listed);
    const { cachedHarnessModels, catalogSettled } = await import('./harnessModels');
    expect((await cachedHarnessModels(request)).models, 'the live answer carries both groups').toEqual([...native, nano]);
    await vi.waitFor(() => expect(catalogSettled(request)).toBe(true));
    for (const key of [snapshotKey('project'), snapshotKey('*')]) {
      expect(JSON.parse(memory.get(key) ?? 'null').result.models, `${key} keeps only the agent's own models`).toEqual(native);
    }
    // A snapshot written with the group (an earlier build, or an earlier account) is read without it.
    localStorage.setItem(snapshotKey('later'), JSON.stringify({ at: Date.now(), result: listed }));
    invoke.mockResolvedValueOnce({ ...listed, models: native }).mockResolvedValueOnce({ ...listed, models: native });
    expect((await cachedHarnessModels({ ...request, workspaceId: 'later' })).models, 'a remembered Nano group is never shown').toEqual(native);
  });
  it('keeps a remembered catalog when the probe fails transiently', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'claude-code' as const };
    const old = { protocol: 18, harness: 'claude-code', models: [{ id: 'sonnet', name: 'Sonnet' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(old).mockResolvedValueOnce(old);
    await harnessModels(request);
    vi.resetModules();
    const fresh = await import('./harnessModels');
    invoke.mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
    const onError = vi.fn();
    expect(await fresh.cachedHarnessModels(request, { onError }), 'the snapshot shows at once').toEqual(old);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    vi.resetModules();
    const again = await import('./harnessModels');
    invoke.mockImplementationOnce(() => new Promise(() => undefined));
    expect(await again.cachedHarnessModels(request), 'a slow start did not forget it').toEqual(old);
  });
  it('shows another project’s models of the same harness as a provisional list', async () => {
    localStorage.clear();
    const listed = { protocol: 18, harness: 'claude-code', models: [{ id: 'opus', name: 'Opus' }], resources: { items: [{ kind: 'skill', id: 'review', name: 'review', enabled: true, configurable: false }], warnings: [] } };
    invoke.mockResolvedValueOnce(listed).mockResolvedValueOnce(listed);
    await harnessModels({ workspaceId: 'first', harness: 'claude-code' });
    vi.resetModules();
    const fresh = await import('./harnessModels');
    const own = { ...listed, models: [{ id: 'sonnet', name: 'Sonnet' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(own);
    invoke.mockImplementationOnce(() => new Promise(() => undefined));
    const onProvisional = vi.fn();
    const loading = fresh.cachedHarnessModels({ workspaceId: 'second', harness: 'claude-code' }, { onProvisional });
    expect(onProvisional, 'before the probe answers, without the other project’s resources').toHaveBeenCalledWith({ ...listed, resources: { items: [], warnings: [] } });
    expect(await loading, 'the call still answers with this project’s own models').toEqual(own);
    const other = vi.fn();
    invoke.mockImplementationOnce(() => new Promise(() => undefined));
    await Promise.race([fresh.cachedHarnessModels({ workspaceId: 'third', harness: 'pi' }, { onProvisional: other }), Promise.resolve()]);
    expect(other, 'another harness has nothing to offer').not.toHaveBeenCalled();
  });
  it('shows an old in-memory catalog at once and asks the harness again behind it', async () => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const request = { workspaceId: 'project', harness: 'claude-code' as const };
      const listed = { protocol: 18, harness: 'claude-code', models: [{ id: 'opus', name: 'Opus' }], resources: { items: [], warnings: [] } };
      invoke.mockResolvedValueOnce(listed);
      invoke.mockResolvedValueOnce(listed);
      const { cachedHarnessModels, catalogSettled } = await import('./harnessModels');
      await cachedHarnessModels(request);
      await vi.waitFor(() => expect(catalogSettled(request)).toBe(true));
      expect(await cachedHarnessModels(request), 'a recent catalog is reused').toEqual(listed);
      expect(invoke).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      const newer = { ...listed, models: [{ id: 'fable', name: 'Fable' }] };
      let complete!: (value: typeof newer) => void;
      invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      invoke.mockResolvedValueOnce(listed);
      const onFresh = vi.fn();
      expect(await cachedHarnessModels(request, { onFresh }), 'no wait for the probe').toEqual(listed);
      expect(invoke).toHaveBeenNthCalledWith(3, 'harness_models_v19', { request: { ...request, part: 'models', discoveryId: expect.any(String) } });
      complete(newer);
      await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith(newer));
    } finally {
      vi.useRealTimers();
    }
  });
  it('asks the harness again when its native version changed', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'claude-code' as const };
    const listed = { protocol: 18, harness: 'claude-code', models: [{ id: 'opus', name: 'Opus' }], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValue(listed);
    const { cachedHarnessModels, catalogSettled } = await import('./harnessModels');
    await cachedHarnessModels(request, { version: '2.1.318' });
    await vi.waitFor(() => expect(catalogSettled(request)).toBe(true));
    await cachedHarnessModels(request, { version: '2.1.318' });
    expect(invoke, 'the same version reuses the catalog').toHaveBeenCalledTimes(2);
    expect(await cachedHarnessModels(request, { version: '2.1.322' }), 'the old list shows first').toEqual(listed);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
    invoke.mockReset();
  });
  it('an older split load that answers after a refresh overwrites neither the snapshot nor the picker', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const snapshotKey = `piui.harness.catalog.v1:${JSON.stringify([request.workspaceId, request.harness])}`;
    const old = { protocol: 18, harness: 'codex', models: [{ id: 'old', name: 'Old' }], resources: { items: [], warnings: [] } };
    const newer = { ...old, models: [{ id: 'new', name: 'New' }] };
    let discover!: (value: typeof old) => void;
    invoke.mockResolvedValueOnce(old);
    invoke.mockImplementationOnce(() => new Promise(resolve => { discover = resolve; }));
    const { cachedHarnessModels } = await import('./harnessModels');
    const onFresh = vi.fn();
    await cachedHarnessModels(request, { onFresh });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    invoke.mockResolvedValueOnce(newer).mockResolvedValueOnce(newer);
    expect(await harnessModels(request, true)).toEqual(newer);
    discover(old);
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalled());
    expect(onFresh, 'the picker gets the refresh answer').toHaveBeenLastCalledWith(newer);
    expect(JSON.parse(memory.get(snapshotKey) ?? 'null').result.models).toEqual(newer.models);
  });
  it('a new native version does not join the load still answering for the old one', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'claude-code' as const };
    const listed = { protocol: 18, harness: 'claude-code', models: [{ id: 'opus', name: 'Opus' }], resources: { items: [], warnings: [] } };
    invoke.mockImplementationOnce(() => new Promise(() => undefined));
    const { cachedHarnessModels } = await import('./harnessModels');
    void cachedHarnessModels(request, { version: '2.1.318' });
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValueOnce(listed);
    invoke.mockResolvedValueOnce(listed);
    expect(await cachedHarnessModels(request, { version: '2.1.322' })).toEqual(listed);
    expect(invoke, 'the new CLI is asked').toHaveBeenNthCalledWith(2, 'harness_models_v19', { request: { ...request, part: 'models', discoveryId: expect.any(String) } });
  });
  it('the old version’s late load collects its own discovery and the new load gets its own resources', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'claude-code' as const };
    const before = { protocol: 18, harness: 'claude-code', models: [{ id: 'old', name: 'Old' }], resources: { items: [], warnings: [] } };
    const after = { ...before, models: [{ id: 'new', name: 'New' }] };
    const found = { ...before, models: [], resources: { items: [{ kind: 'skill', id: 'review', name: 'review', enabled: true, configurable: false }], warnings: [] } };
    let lateModels!: (value: typeof before) => void;
    let newModels!: (value: typeof after) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { lateModels = resolve; }));
    invoke.mockImplementationOnce(() => new Promise(resolve => { newModels = resolve; }));
    const stale = { ...found, resources: { items: [{ kind: 'skill', id: 'old-skill', name: 'old-skill', enabled: true, configurable: false }], warnings: [] } };
    invoke.mockResolvedValueOnce(stale);
    invoke.mockResolvedValueOnce(found);
    const { cachedHarnessModels } = await import('./harnessModels');
    const old = vi.fn();
    void cachedHarnessModels(request, { version: '1', onFresh: old });
    const onFresh = vi.fn();
    const loading = cachedHarnessModels(request, { version: '2', onFresh });
    lateModels(before);
    await Promise.resolve();
    newModels(after);
    expect(await loading).toEqual(after);
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith({ ...after, resources: found.resources }));
    expect(invoke, 'each load claims its own discovery').toHaveBeenCalledTimes(4);
    expect(onFresh, 'the old discovery never reaches the new picker').not.toHaveBeenCalledWith(expect.objectContaining({ resources: stale.resources }));
    await vi.waitFor(() => expect(old, 'the old picker gets the new answer').toHaveBeenCalledWith({ ...after, resources: found.resources }));
  });
  it('lets a picker join an explicit full refresh before its resources finish', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [{ id: 'gpt', name: 'GPT' }], resources: { items: [], warnings: [] } };
    let resources!: (value: typeof listed) => void;
    invoke.mockResolvedValueOnce(listed).mockImplementationOnce(() => new Promise(resolve => { resources = resolve; }));
    const full = harnessModels(request, true);
    const { cachedHarnessModels } = await import('./harnessModels');
    expect(await cachedHarnessModels(request)).toEqual(listed);
    expect(invoke).toHaveBeenCalledTimes(2);
    resources(listed);
    expect(await full).toEqual(listed);
  });
  it.each(['expiry', 'version'] as const)('revalidates models after degraded resources on %s', async (change) => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const request = { workspaceId: 'project', harness: 'codex' as const };
      const listed = { protocol: 18, harness: 'codex', models: [{ id: 'old', name: 'Old' }], resources: { items: [], warnings: [] } };
      invoke.mockResolvedValueOnce(listed).mockRejectedValueOnce({ code: 'RUNTIME_FAILED' });
      await harnessModels(request, false, '1');
      // Existing catalog freshness is five minutes; advance beyond that policy.
      if (change === 'expiry') vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      const newer = { ...listed, models: [{ id: 'new', name: 'New' }] };
      invoke.mockResolvedValueOnce(newer).mockResolvedValueOnce(newer);
      const { cachedHarnessModels } = await import('./harnessModels');
      const onFresh = vi.fn();
      await cachedHarnessModels(request, { version: change === 'version' ? '2' : '1', onFresh });
      await vi.waitFor(() => expect(onFresh).toHaveBeenLastCalledWith(newer));
      expect(invoke).toHaveBeenNthCalledWith(3, 'harness_models_v19', { request: { ...request, part: 'models', discoveryId: expect.any(String) } });
    } finally { vi.useRealTimers(); }
  });
  it.each([
    'Skills could not be loaded from Codex.',
    'MCP servers could not be loaded from Codex.',
    'MCP tools could not be loaded from Codex.',
    'MCP server docs could not start.',
    'Hermes tool inventory is unavailable.',
    'Hermes skill inventory is unavailable.',
    'Skills could not be loaded from Pi.',
    'Skills could not be loaded from Prime Agent.',
    'Tools could not be loaded from Prime Agent.',
  ])('retries partially failed resources: %s', async (warning) => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18 as const, harness: 'codex' as const, models: [], resources: { items: [], warnings: [] } };
    invoke.mockResolvedValueOnce(listed).mockResolvedValueOnce({ ...listed, resources: { items: [], warnings: [warning] } });
    const { catalogDegraded } = await import('./harnessModels');
    expect(catalogDegraded(await harnessModels(request))).toBe(true);
    invoke.mockResolvedValueOnce(listed);
    expect(await harnessModels(request)).toEqual(listed);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(catalogDegraded({ ...listed, resources: { items: [], warnings: ['A deprecated configuration option was used.'] } })).toBe(false);
  });
  it('pairs reversed model answers with their own discovery resources', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const answer = (id: string) => ({ protocol: 18, harness: 'codex', models: [{ id, name: id }], resources: { items: [], warnings: [] } });
    const pending = new Map<string, (result: ReturnType<typeof answer>) => void>();
    const ids = new Map<string, string>();
    invoke.mockImplementation((_command, args) => {
      const { discoveryId, part } = args.request;
      if (part === 'models') return new Promise(resolve => { pending.set(discoveryId, resolve); });
      return { ...answer(ids.get(discoveryId)!), resources: { items: [], warnings: [ids.get(discoveryId)!] } };
    });
    const first = harnessModels(request, false, '1');
    const second = harnessModels(request, false, '2');
    const [oldId, newId] = [...pending.keys()];
    expect(oldId).not.toBe(newId);
    ids.set(oldId!, 'old'); ids.set(newId!, 'new');
    pending.get(newId!)!(answer('new'));
    expect((await second).resources.warnings).toEqual(['new']);
    pending.get(oldId!)!(answer('old'));
    expect((await first).resources.warnings, 'a superseded direct caller receives the newest catalog').toEqual(['new']);
    expect(invoke).toHaveBeenLastCalledWith('harness_models_v19', { request: { ...request, part: 'resources', discoveryId: oldId } });
    expect((await harnessModels(request)).models).toEqual(answer('new').models);
  });
  it('does not restore forgotten snapshots when an old request settles', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [], resources: { items: [], warnings: [] } };
    let finish!: (value: typeof listed) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(listed);
    const pending = harnessModels(request);
    const { forgetHarnessCatalogs } = await import('./harnessModels');
    forgetHarnessCatalogs('codex');
    finish(listed);
    await pending;
    expect([...memory.keys()]).toEqual([]);
  });
  it('a superseded direct failure cannot replace a newer successful catalog', async () => {
    localStorage.clear();
    const request = { workspaceId: 'project', harness: 'codex' as const };
    const listed = { protocol: 18, harness: 'codex', models: [], resources: { items: [], warnings: [] } };
    let fail!: (error: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const old = harnessModels(request, false, '1');
    invoke.mockResolvedValueOnce(listed).mockResolvedValueOnce(listed);
    await harnessModels(request, false, '2');
    fail({ code: 'RUNTIME_FAILED' });
    expect(await old).toEqual(listed);
  });
  it('forwards only session model fields: the host rejects catalog-only fields', () => {
    const catalogEntry = { id: 'gpt-5.5', provider: null as unknown as string, name: 'GPT-5.5', thinkingLevels: ['low', 'high'], supportsFast: true };
    expect(workspaceModel(catalogEntry)).toEqual({ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'high'] });
    expect(workspaceModel({ id: 'sonnet', provider: 'anthropic', name: 'Sonnet' })).toEqual({ id: 'sonnet', provider: 'anthropic', name: 'Sonnet' });
  });
});
