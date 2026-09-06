import {
  orchestrationError, OrchestrationOperationError,
  type OrchestrationRunChangedEventV3, type OrchestrationRunV3, type RunRequest, type RunSummary,
} from '../../host-api/orchestrationClient';

export interface RunUpdateScope {
  readonly workspaceId: string;
  readonly generation: number;
  readonly visible: boolean;
  readonly revision: (runId: string) => number;
}

export interface RunLiveUpdateOptions {
  readonly scope: () => RunUpdateScope;
  readonly read: (request: RunRequest) => Promise<OrchestrationRunV3 | null>;
  readonly apply: (run: OrchestrationRunV3) => void;
  readonly failed: (error: OrchestrationOperationError, runId: string) => void;
}

export function checkedRunSnapshot(run: OrchestrationRunV3 | null, runId: string, minimumRevision: number): OrchestrationRunV3 {
  if (run === null) throw new OrchestrationOperationError('not-found');
  if (run.id !== runId || !Number.isSafeInteger(run.revision) || run.revision < 0 || run.revision < minimumRevision) {
    throw new OrchestrationOperationError('conflict', 'A newer run revision is known. Refresh the recorded run before acting.');
  }
  return run;
}

export function mergeSelectedRun(current: OrchestrationRunV3 | undefined, incoming: OrchestrationRunV3): OrchestrationRunV3 | undefined {
  return current?.id === incoming.id && incoming.revision > current.revision ? incoming : current;
}

export function runSummary(run: OrchestrationRunV3): RunSummary {
  return { id: run.id, revision: run.revision, status: run.status, teamName: run.definition.team.name, pipelineName: run.definition.pipeline.name };
}

/** Run history has no delete route. An older in-flight list read must not drop a newly committed run. */
export function mergeRunSummaries(current: readonly RunSummary[], incoming: readonly RunSummary[]): readonly RunSummary[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const previous = byId.get(run.id);
    if (previous === undefined || run.revision > previous.revision) byId.set(run.id, run);
  }
  return [...byId.values()];
}

/** Coalesce only received durable invalidations. No timer, heartbeat, retry loop or synthetic event. */
export function createRunLiveUpdates(options: RunLiveUpdateOptions): {
  invalidate(event: OrchestrationRunChangedEventV3): void;
  dispose(): void;
} {
  const pending = new Map<string, OrchestrationRunChangedEventV3>();
  let scheduled = false;
  let running = false;
  let disposed = false;

  function isCurrent(before: RunUpdateScope): boolean {
    const current = options.scope();
    return !disposed && current.visible && current.workspaceId === before.workspaceId && current.generation === before.generation;
  }

  async function refresh(event: OrchestrationRunChangedEventV3): Promise<void> {
    const before = options.scope();
    if (!before.visible || before.workspaceId !== event.workspaceId || before.revision(event.runId) >= event.revision) return;
    try {
      const result = await options.read({ workspaceId: event.workspaceId, runId: event.runId });
      if (!isCurrent(before)) return;
      const known = options.scope().revision(event.runId);
      if (known >= event.revision && result?.id === event.runId && result.revision <= known) return;
      const run = checkedRunSnapshot(result, event.runId, event.revision);
      options.apply(run);
    } catch (error) {
      if (isCurrent(before) && options.scope().revision(event.runId) < event.revision) options.failed(orchestrationError(error), event.runId);
    }
  }

  function schedule(): void {
    if (disposed || scheduled || running || pending.size === 0) return;
    scheduled = true;
    queueMicrotask(() => { void flush(); });
  }

  async function flush(): Promise<void> {
    scheduled = false;
    if (disposed) return;
    const batch = [...pending.values()];
    pending.clear();
    running = true;
    try { await Promise.all(batch.map(refresh)); }
    finally { running = false; schedule(); }
  }

  return {
    invalidate(event) {
      const scope = options.scope();
      if (disposed || !scope.visible || scope.workspaceId !== event.workspaceId || scope.revision(event.runId) >= event.revision) return;
      const key = JSON.stringify([event.workspaceId, event.runId]);
      const previous = pending.get(key);
      if (previous === undefined || event.revision > previous.revision) pending.set(key, event);
      schedule();
    },
    dispose() { disposed = true; pending.clear(); },
  };
}
