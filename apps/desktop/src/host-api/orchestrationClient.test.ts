import { describe, expect, it, vi } from 'vitest';
import {
  createOrchestrationClient, createUnavailableOrchestrationClient, orchestrationError,
  type OrchestrationCommandName, type OrchestrationRequest, type AgentProfile, type StoredDefinition,
  type OrchestrationRunChangedEventV4, orchestrationRunChanged,
} from './orchestrationClient';

const profile: AgentProfile = {
  id: 'fixture-profile', name: 'Review profile', harness: 'codex', model: 'fixture-model', permissionMode: 'native',
  instructions: 'Fixture instructions', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [],
};

describe('orchestration host client', () => {
  it('keeps a create/read/update/delete flow scoped and revision-bound through the exact host commands', async () => {
    const calls: { route: OrchestrationCommandName; request: OrchestrationRequest }[] = [];
    let stored: StoredDefinition<AgentProfile> | null = null;
    const client = createOrchestrationClient(async <T>(route: OrchestrationCommandName, { request }: { request: OrchestrationRequest }): Promise<T> => {
      calls.push({ route, request });
      let result: unknown;
      if (route === 'orchestration_save_profile_v4' && 'value' in request && 'harness' in request.value) {
        if (stored && request.expectedRevision !== stored.revision) throw { code: 'conflict', message: 'private native detail' };
        stored = { revision: (stored?.revision ?? 0) + 1, value: request.value };
        result = stored;
      } else if (route === 'orchestration_get_profile_v4') result = stored;
      else if (route === 'orchestration_delete_profile_v4' && 'expectedRevision' in request) {
        if (request.expectedRevision !== stored?.revision) throw { code: 'conflict' };
        stored = null;
      } else throw { code: 'runtime-unavailable' };
      return result as T;
    });
    const created = await client.orchestration_save_profile_v4({ workspaceId: 'fixture-workspace', value: profile });
    expect(created.revision).toBe(1);
    expect(calls[0]).toEqual({ route: 'orchestration_save_profile_v4', request: { workspaceId: 'fixture-workspace', value: profile } });
    const opened = await client.orchestration_get_profile_v4({ workspaceId: 'fixture-workspace', id: profile.id });
    expect(opened).toEqual(created);
    const edited = { ...profile, name: 'Updated review profile' };
    const updated = await client.orchestration_save_profile_v4({ workspaceId: 'fixture-workspace', expectedRevision: created.revision, value: edited });
    expect(updated.revision).toBe(2);
    await expect(client.orchestration_save_profile_v4({ workspaceId: 'fixture-workspace', expectedRevision: created.revision, value: profile })).rejects.toMatchObject({ code: 'conflict' });
    expect((await client.orchestration_get_profile_v4({ workspaceId: 'fixture-workspace', id: profile.id }))?.value.name).toBe(edited.name);
    await client.orchestration_delete_profile_v4({ workspaceId: 'fixture-workspace', id: profile.id, expectedRevision: updated.revision });
    expect(await client.orchestration_get_profile_v4({ workspaceId: 'fixture-workspace', id: profile.id })).toBeNull();
    expect(calls.every((call) => call.request.workspaceId === 'fixture-workspace')).toBe(true);
  });

  it('uses request envelopes for catalog, run inspection and explicit run CAS without a sender or shell surface', async () => {
    const calls: { route: OrchestrationCommandName; request: OrchestrationRequest }[] = [];
    const client = createOrchestrationClient(async <T>(route: OrchestrationCommandName, { request }: { request: OrchestrationRequest }): Promise<T> => {
      calls.push({ route, request });
      return null as T;
    });
    await client.orchestration_catalog_v4({ workspaceId: 'fixture-workspace' });
    await client.orchestration_list_runs_v4({ workspaceId: 'fixture-workspace' });
    await client.orchestration_get_run_v4({ workspaceId: 'fixture-workspace', runId: 'fixture-run' });
    await client.orchestration_cancel_run_v4({ workspaceId: 'fixture-workspace', runId: 'fixture-run', expectedRunRevision: 4 });
    await client.orchestration_retry_uncertain_task_v4({ workspaceId: 'fixture-workspace', runId: 'fixture-run', expectedRunRevision: 4, stepId: 'fixture-step', expectedTaskRevision: 2 });
    expect(calls.map((call) => call.route)).toEqual(['orchestration_catalog_v4', 'orchestration_list_runs_v4', 'orchestration_get_run_v4', 'orchestration_cancel_run_v4', 'orchestration_retry_uncertain_task_v4']);
    expect(calls.at(-1)?.request).toEqual({ workspaceId: 'fixture-workspace', runId: 'fixture-run', expectedRunRevision: 4, stepId: 'fixture-step', expectedTaskRevision: 2 });
  });

  it('never returns fake catalog, CRUD or run success without the desktop host', async () => {
    const client = createUnavailableOrchestrationClient();
    await expect(client.orchestration_catalog_v4({ workspaceId: 'fixture-workspace' })).rejects.toMatchObject({ code: 'desktop-unavailable' });
    await expect(client.orchestration_save_profile_v4({ workspaceId: 'fixture-workspace', value: profile })).rejects.toThrow('desktop app');
    await expect(client.orchestration_list_runs_v4({ workspaceId: 'fixture-workspace' })).rejects.toMatchObject({ code: 'desktop-unavailable' });
    await expect(client.orchestration_start_run_v4({ workspaceId: 'fixture-workspace', runId: 'fixture-run', teamId: 'fixture-team', pipelineId: 'fixture-pipeline' })).rejects.toMatchObject({ code: 'desktop-unavailable' });
  });

  it('shows only known safe error copy, never a native path, prompt or arbitrary error code', () => {
    const rejected = orchestrationError(JSON.stringify({ code: 'conflict', message: 'D:/private/prompt-secret' }));
    expect(rejected.code).toBe('conflict');
    expect(rejected.message).toContain('Keep your draft');
    expect(rejected.message).not.toContain('prompt-secret');
    expect(orchestrationError({ code: 'secret-code', message: 'private text' }).code).toBe('unknown');
    expect(orchestrationError('private raw stderr').message).not.toContain('private');
    expect(orchestrationError({ code: 'unsupported-policy' }).message).toContain('Keep the requirement');
    expect(orchestrationError({ code: 'native-outcome-uncertain' }).message).toContain('Inspect the recorded run');
  });
});


describe('orchestration durable event boundary', () => {
  const changed: OrchestrationRunChangedEventV4 = { protocol: 4, type: 'runChanged', workspaceId: 'fixture-workspace', runId: 'fixture-run', revision: 4 };

  it('subscribes to versioned invalidations and exposes the real unsubscribe handle', async () => {
    let emit: (payload: unknown) => void = () => {};
    const stop = vi.fn();
    const received: OrchestrationRunChangedEventV4[] = [];
    const client = createOrchestrationClient(async <T>(): Promise<T> => null as T, async (handler) => { emit = handler; return stop; });
    const unlisten = await client.listen((event) => received.push(event));
    emit({ ...changed, nativePrivateField: 'not forwarded' });
    emit({ ...changed, protocol: 1 });
    emit({ ...changed, type: 'nativeOutput' });
    expect(received).toEqual([changed]);
    unlisten();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('rejects malformed revisions and incomplete scopes rather than inventing an update', () => {
    expect(orchestrationRunChanged({ ...changed, revision: 0 })).toEqual({ ...changed, revision: 0 });
    for (const value of [null, {}, { ...changed, workspaceId: ' ' }, { ...changed, runId: '' }, { ...changed, revision: -1 }, { ...changed, revision: 1.5 }, { ...changed, revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(orchestrationRunChanged(value)).toBeUndefined();
    }
  });

  it('reports unavailable or rejected subscriptions with safe code-only copy', async () => {
    await expect(createUnavailableOrchestrationClient().listen(() => {})).rejects.toMatchObject({ code: 'desktop-unavailable' });
    const client = createOrchestrationClient(async <T>(): Promise<T> => null as T, async () => { throw { code: 'denied', message: 'private native path' }; });
    await expect(client.listen(() => {})).rejects.toMatchObject({ code: 'denied' });
    await expect(client.listen(() => {})).rejects.not.toThrow('private native path');
  });
});
