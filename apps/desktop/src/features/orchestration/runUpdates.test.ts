import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationRunChangedEventV5, OrchestrationRunV5 } from '../../host-api/orchestrationClient';
import { checkedRunSnapshot, createRunLiveUpdates, mergeRunSummaries, mergeSelectedRun, runSummary } from './runUpdates';

const run: OrchestrationRunV5 = {
  schemaVersion: 5, id: 'fixture-run', revision: 1, status: 'running',
  definition: {
    profiles: [],
    team: { id: 'fixture-team', name: 'Fixture team', members: [], sendEdges: [], observeEdges: [], orchestratorMemberId: 'fixture-member' },
    pipeline: { id: 'fixture-pipeline', name: 'Fixture pipeline', steps: [] },
  },
  tasks: [], messages: [], agentRequests: [],
};
function changed(revision: number, runId = run.id): OrchestrationRunChangedEventV5 {
  return { protocol: 5, type: 'runChanged', workspaceId: 'fixture-workspace', runId, revision };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

describe('run revision projection', () => {
  it('keeps the selected identity and never replaces its snapshot with an older revision', () => {
    const newer = { ...run, revision: 3, status: 'succeeded' as const };
    expect(mergeSelectedRun(newer, run)).toBe(newer);
    expect(mergeSelectedRun(run, newer)).toBe(newer);
    expect(mergeSelectedRun(run, { ...newer, id: 'another-run' })).toBe(run);
    expect(mergeSelectedRun(undefined, newer)).toBeUndefined();
    expect(() => checkedRunSnapshot(null, run.id, 1)).toThrow('no longer available');
    expect(() => checkedRunSnapshot(run, 'another-run', 1)).toThrow('newer run revision');
    expect(() => checkedRunSnapshot(run, run.id, 2)).toThrow('newer run revision');
  });

  it('does not regress a run list or drop a newly committed run when an older list fetch completes', () => {
    const latest = runSummary({ ...run, revision: 3, status: 'succeeded' });
    const added = runSummary({ ...run, id: 'new-run' });
    expect(mergeRunSummaries([latest, added], [runSummary(run)])).toEqual([latest, added]);
    expect(mergeRunSummaries([runSummary(run)], [latest, added])).toEqual([latest, added]);
  });
});

describe('durable run invalidations', () => {
  it('coalesces a synchronous burst by run and suppresses duplicate/older revisions', async () => {
    const started = deferred<void>();
    const response = deferred<OrchestrationRunV5>();
    const applied = deferred<void>();
    let revision = 1;
    const read = vi.fn(() => { started.resolve(); return response.promise; });
    const apply = vi.fn((value: OrchestrationRunV5) => { revision = value.revision; applied.resolve(); });
    const updates = createRunLiveUpdates({ scope: () => ({ workspaceId: 'fixture-workspace', generation: 1, visible: true, revision: () => revision }), read, apply, failed: vi.fn() });
    updates.invalidate(changed(2));
    updates.invalidate(changed(3));
    updates.invalidate(changed(2));
    await started.promise;
    expect(read).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'fixture-workspace', runId: run.id });
    response.resolve({ ...run, revision: 3 });
    await applied.promise;
    updates.invalidate(changed(3));
    updates.invalidate(changed(2));
    expect(read).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    updates.dispose();
  });

  it('reads again only when a newer durable event arrived during the current read', async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const first = deferred<OrchestrationRunV5>();
    const second = deferred<OrchestrationRunV5>();
    const complete = deferred<void>();
    let revision = 1;
    const read = vi.fn().mockImplementationOnce(() => { firstStarted.resolve(); return first.promise; }).mockImplementationOnce(() => { secondStarted.resolve(); return second.promise; });
    const updates = createRunLiveUpdates({
      scope: () => ({ workspaceId: 'fixture-workspace', generation: 1, visible: true, revision: () => revision }), read,
      apply: (value) => { revision = value.revision; if (revision === 6) complete.resolve(); }, failed: vi.fn(),
    });
    updates.invalidate(changed(4));
    await firstStarted.promise;
    updates.invalidate(changed(5));
    updates.invalidate(changed(6));
    updates.invalidate(changed(5));
    expect(read).toHaveBeenCalledOnce();
    first.resolve({ ...run, revision: 4 });
    await secondStarted.promise;
    expect(read).toHaveBeenCalledTimes(2);
    second.resolve({ ...run, revision: 6 });
    await complete.promise;
    updates.invalidate(changed(6));
    expect(read).toHaveBeenCalledTimes(2);
    updates.dispose();
  });

  it('drops a response from an earlier workspace visit, even after returning to the same workspace ID', async () => {
    const started = deferred<void>();
    const response = deferred<OrchestrationRunV5>();
    let generation = 1;
    const apply = vi.fn();
    const failed = vi.fn();
    const updates = createRunLiveUpdates({ scope: () => ({ workspaceId: 'fixture-workspace', generation, visible: true, revision: () => 1 }), read: () => { started.resolve(); return response.promise; }, apply, failed });
    updates.invalidate(changed(2));
    await started.promise;
    generation = 3;
    response.resolve({ ...run, revision: 2 });
    await response.promise;
    expect(apply).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    updates.dispose();
  });

  it('leaves editors alone and stops both pending and later updates after disposal', async () => {
    const started = deferred<void>();
    const response = deferred<OrchestrationRunV5>();
    let visible = true;
    const read = vi.fn(() => { started.resolve(); return response.promise; });
    const apply = vi.fn();
    const updates = createRunLiveUpdates({ scope: () => ({ workspaceId: 'fixture-workspace', generation: 1, visible, revision: () => 1 }), read, apply, failed: vi.fn() });
    updates.invalidate({ ...changed(2), workspaceId: 'other-workspace' });
    updates.invalidate(changed(2));
    await started.promise;
    visible = false;
    response.resolve({ ...run, revision: 2 });
    await response.promise;
    updates.invalidate(changed(3));
    expect(apply).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    visible = true;
    updates.invalidate(changed(4));
    updates.dispose();
    updates.invalidate(changed(5));
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
  });

  it('surfaces safe failure once without timer retries or synthetic state', async () => {
    const errorSeen = deferred<void>();
    const failed = vi.fn((_error: unknown) => errorSeen.resolve());
    const apply = vi.fn();
    const read = vi.fn(async () => { throw { code: 'io', message: 'private native prompt' }; });
    const updates = createRunLiveUpdates({ scope: () => ({ workspaceId: 'fixture-workspace', generation: 1, visible: true, revision: () => 1 }), read, apply, failed });
    updates.invalidate(changed(2));
    await errorSeen.promise;
    expect(read).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(failed.mock.calls[0]?.[0]).toMatchObject({ code: 'io' });
    expect(String(failed.mock.calls[0]?.[0])).not.toContain('private native prompt');
    updates.dispose();
  });
});
