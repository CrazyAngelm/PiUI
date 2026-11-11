import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessModelsResult } from '../../../../../contracts/harness-models-v18';
import { createOrchestrationClient, type OrchestrationClient, type OrchestrationCommandName } from '../../host-api/orchestrationClient';
import { labHost } from '../../host-api/lab/labTestKit';
import { PipelineEditorStore } from './editorStore.svelte';
import { readLastPipeline } from './lastPipeline';

const { cached, refreshed, settled } = vi.hoisted(() => ({
  cached: vi.fn(),
  refreshed: vi.fn(),
  settled: vi.fn(),
}));
vi.mock('../../host-api/harnessModels', () => ({ cachedHarnessModels: cached, harnessModels: refreshed, catalogSettled: settled, catalogDegraded: () => false }));

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
});

function catalog(resources: HarnessModelsResult['resources']): HarnessModelsResult {
  return { protocol: 18, harness: 'codex', models: [{ id: 'model', name: 'Model' }], resources };
}
const MODELS_ONLY = catalog({ items: [], warnings: [] });
const FULL = catalog({ items: [{ kind: 'skill', id: 'review', name: 'Review', enabled: true, configurable: true }], warnings: [] });

function store(client: OrchestrationClient = {} as OrchestrationClient, safeMode = false) {
  return new PipelineEditorStore('workspace', safeMode, client);
}

function lab() {
  const host = labHost();
  const client = createOrchestrationClient(
    <T>(route: OrchestrationCommandName, args: { request: unknown }) => host.invoke<T>(route, args),
    (handler) => host.listen('piui://orchestration-event', handler),
    (handler) => host.listen('piui://orchestration-schedule-event', handler),
  );
  const workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
  return { client, workspaceId };
}

describe('catalog loading flags the resources that are still being discovered', () => {
  beforeEach(() => {
    cached.mockReset();
    refreshed.mockReset();
    settled.mockReset();
    memory.clear();
  });

  it('keeps remembered resources visible while the probe confirms them', async () => {
    cached.mockResolvedValue(FULL);
    settled.mockReturnValue(false);
    const editor = store();
    await editor.loadCatalog('codex');
    expect(editor.catalogs.codex).toBe(FULL);
    expect(editor.resourcesLoading.codex ?? false).toBe(false);
  });

  it('keeps resources loading after the models answer and clears it when the probe settles', async () => {
    let fresh: ((result: HarnessModelsResult) => void) | undefined;
    cached.mockImplementation((_request: unknown, handlers: { onFresh: (result: HarnessModelsResult) => void }) => {
      fresh = handlers.onFresh;
      return Promise.resolve(MODELS_ONLY);
    });
    settled.mockReturnValue(false);
    const editor = store();
    await editor.loadCatalog('codex');
    expect(editor.catalogs.codex).toBe(MODELS_ONLY);
    expect(editor.resourcesLoading.codex).toBe(true);
    expect(editor.resourcesLoading.pi).toBeUndefined();

    settled.mockReturnValue(true);
    fresh?.(FULL);
    expect(editor.catalogs.codex).toBe(FULL);
    expect(editor.resourcesLoading.codex ?? false).toBe(false);
  });

  it('does not wait for resources that are already known', async () => {
    cached.mockResolvedValue(FULL);
    settled.mockReturnValue(true);
    const editor = store();
    await editor.loadCatalog('codex');
    expect(editor.resourcesLoading.codex ?? false).toBe(false);
  });

  it('stops waiting when the probe fails after a remembered catalog was shown', async () => {
    let failed: ((error: unknown) => void) | undefined;
    cached.mockImplementation((_request: unknown, handlers: { onError: (error: unknown) => void }) => {
      failed = handlers.onError;
      return Promise.resolve(MODELS_ONLY);
    });
    settled.mockReturnValue(false);
    const editor = store();
    await editor.loadCatalog('codex');
    expect(editor.resourcesLoading.codex).toBe(true);

    failed?.(new Error('Could not load models.'));
    expect(editor.resourcesLoading.codex ?? false).toBe(false);
    expect(editor.catalogErrors.codex).toBe('Could not load models.');
  });

  it('stops waiting when the first answer fails', async () => {
    cached.mockRejectedValue(new Error('Could not load models.'));
    settled.mockReturnValue(false);
    const editor = store();
    await editor.loadCatalog('codex');
    expect(editor.resourcesLoading.codex ?? false).toBe(false);
    expect(editor.catalogErrors.codex).toBe('Could not load models.');
    expect(editor.catalogs.codex).toBeUndefined();
  });

  it('a refresh waits for the whole catalog and shows it settled', async () => {
    refreshed.mockResolvedValue(FULL);
    const editor = store();
    editor.resourcesLoading = { codex: true };
    await editor.loadCatalog('codex', true);
    expect(refreshed).toHaveBeenCalledWith({ workspaceId: 'workspace', harness: 'codex' }, true);
    expect(editor.catalogs.codex).toBe(FULL);
    expect(editor.resourcesLoading.codex ?? false).toBe(false);
  });

  it('safe mode never probes a harness', async () => {
    const editor = store({} as OrchestrationClient, true);
    await editor.loadCatalog('codex');
    expect(cached).not.toHaveBeenCalled();
    expect(editor.resourcesLoading.codex).toBeUndefined();
  });
});

describe('leaving the editor with unsaved changes', () => {
  beforeEach(() => memory.clear());

  it('cancels the navigation and keeps the draft when the save from the dialog fails validation', async () => {
    const editor = store();
    editor.rename('Draft');
    editor.addNode('agent', { x: 0, y: 0 });
    expect(editor.dirty).toBe(true);
    const leave = vi.fn();
    editor.guard(leave);
    expect(editor.pending).toBeDefined();

    await editor.resolvePending('save');
    expect(editor.pending).toBeUndefined();
    expect(leave).not.toHaveBeenCalled();
    expect(editor.issues.map((issue) => issue.message)).toContain('Enter a name and model for every agent.');
    expect(editor.dirty).toBe(true);
  });

  it('cancels the navigation and shows the host error when the save from the dialog is refused', async () => {
    const client = { orchestration_save_graph_v6: vi.fn().mockRejectedValue(new Error('The host refused the save.')) } as unknown as OrchestrationClient;
    const editor = store(client);
    editor.rename('Draft');
    const id = editor.addNode('agent', { x: 0, y: 0 });
    editor.updateProfile(id, { name: 'Planner', model: 'model', modelProvider: 'provider' });
    const leave = vi.fn();
    editor.guard(leave);
    expect(editor.pending).toBeDefined();

    await editor.resolvePending('save');
    expect(client.orchestration_save_graph_v6).toHaveBeenCalledOnce();
    expect(editor.pending).toBeUndefined();
    expect(leave).not.toHaveBeenCalled();
    expect(editor.errors).toEqual(['The host refused the save.']);
    expect(editor.dirty).toBe(true);
  });

  it('keep editing closes the dialog without leaving; discard leaves without saving', async () => {
    const editor = store();
    editor.addNode('agent', { x: 0, y: 0 });
    const leave = vi.fn();
    editor.guard(leave);
    await editor.resolvePending('keep');
    expect(editor.pending).toBeUndefined();
    expect(leave).not.toHaveBeenCalled();

    editor.guard(leave);
    await editor.resolvePending('discard');
    expect(editor.pending).toBeUndefined();
    expect(leave).toHaveBeenCalledOnce();
  });
});

describe('the last open pipeline of a project', () => {
  beforeEach(() => memory.clear());

  it('is remembered on open and on save and forgotten when a new pipeline starts', async () => {
    const { client, workspaceId } = lab();
    const editor = new PipelineEditorStore(workspaceId, false, client);
    await editor.refresh();
    const review = editor.systems.find((item) => item.name === 'Code review');
    expect(review).toBeDefined();
    expect(readLastPipeline(workspaceId)).toBeUndefined();

    editor.open(review?.id ?? '');
    await vi.waitFor(() => expect(editor.graph.id).toBe(review?.id));
    expect(readLastPipeline(workspaceId)).toBe(review?.id);

    editor.newGraph();
    expect(editor.graph.nodes).toHaveLength(0);
    expect(readLastPipeline(workspaceId)).toBeUndefined();

    editor.rename('Ship');
    const agentId = editor.addNode('agent', { x: 0, y: 0 });
    editor.updateProfile(agentId, { name: 'Planner', model: 'gpt-lab-5-mini', modelProvider: 'openai-lab' });
    expect(await editor.save()).toBe(true);
    expect(readLastPipeline(workspaceId)).toBe(editor.graph.id);
  });

  it('never lets a slower, older open replace the pipeline opened after it', async () => {
    const { client, workspaceId } = lab();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const listed = new PipelineEditorStore(workspaceId, false, client);
    await listed.refresh();
    const [first, second] = listed.systems;
    expect(first && second).toBeTruthy();
    const slow: OrchestrationClient = {
      ...client,
      orchestration_get_launch_command_v6: async (request) => {
        if (request.id === first?.id) await gate;
        return client.orchestration_get_launch_command_v6(request);
      },
    };
    const editor = new PipelineEditorStore(workspaceId, false, slow);
    editor.open(first?.id ?? '');
    editor.open(second?.id ?? '');
    await vi.waitFor(() => expect(editor.graph.id).toBe(second?.id));
    expect(editor.busy).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(editor.graph.id).toBe(second?.id);
    expect(readLastPipeline(workspaceId)).toBe(second?.id);
  });

  it('a new draft supersedes an open in flight without leaving the editor busy', async () => {
    const { client, workspaceId } = lab();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const listed = new PipelineEditorStore(workspaceId, false, client);
    await listed.refresh();
    const target = listed.systems[0];
    const slow: OrchestrationClient = {
      ...client,
      orchestration_get_launch_command_v6: async (request) => {
        await gate;
        return client.orchestration_get_launch_command_v6(request);
      },
    };
    const editor = new PipelineEditorStore(workspaceId, false, slow);
    editor.open(target?.id ?? '');
    await vi.waitFor(() => expect(editor.busy).toBe(true));
    editor.newGraph();
    expect(editor.busy).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(editor.graph.nodes).toHaveLength(0);
    expect(editor.busy).toBe(false);
  });

  it('reports a pipeline list that could not be read', async () => {
    const { client, workspaceId } = lab();
    const failing: OrchestrationClient = { ...client, orchestration_catalog_v6: async () => { throw new Error('offline'); } };
    const editor = new PipelineEditorStore(workspaceId, false, failing);
    expect(await editor.refresh()).toBe(false);
    expect(editor.systems).toHaveLength(0);
    expect(await new PipelineEditorStore(workspaceId, false, client).refresh()).toBe(true);
  });

  it('is kept when New is cancelled', async () => {
    const { client, workspaceId } = lab();
    const editor = new PipelineEditorStore(workspaceId, false, client);
    await editor.refresh();
    const review = editor.systems.find((item) => item.name === 'Code review');
    editor.open(review?.id ?? '');
    await vi.waitFor(() => expect(editor.graph.id).toBe(review?.id));

    editor.rename('Changed');
    editor.newGraph();
    expect(editor.pending).toBeDefined();
    await editor.resolvePending('keep');
    expect(readLastPipeline(workspaceId)).toBe(review?.id);
  });
});
