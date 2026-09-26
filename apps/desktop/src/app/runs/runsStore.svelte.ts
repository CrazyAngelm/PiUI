/**
 * State for the run view of one project: the run list, the opened run and
 * operator actions. Every mutation is one revision-checked host command
 * followed only by a read-only recovery read; native work is never replayed.
 */
import {
  orchestrationError,
  type FlowAction,
  type OrchestrationClient,
  type OrchestrationRunV6,
  type ReconcileUncertainTaskRequest,
  type RunSummary,
  type UsageReceipt,
} from '../../host-api/orchestrationClient';
import { performRunAction, type RunAction } from '../../features/orchestration/runActions';
import { createRunLiveUpdates, mergeRunSummaries, runSummary } from '../../features/orchestration/runUpdates';
import { sortRuns } from './runPresentation';

export class RunsStore {
  summaries = $state.raw<readonly RunSummary[]>([]);
  listLoading = $state(false);
  listError = $state('');
  run = $state.raw<OrchestrationRunV6 | undefined>();
  runLoading = $state(false);
  runError = $state('');
  selectedStepId = $state('');
  /** Index into `run.attempts`, or -1 for the current task record. */
  attemptIndex = $state(-1);
  usage = $state.raw<Record<string, UsageReceipt[]>>({});
  usageUnavailable = $state(false);
  busy = $state('');
  actionError = $state('');
  liveError = $state('');

  private generation = 0;
  private disposed = false;
  private stopLive: (() => void) | undefined;
  private live: ReturnType<typeof createRunLiveUpdates> | undefined;
  private usageRequest = 0;

  constructor(
    readonly workspaceId: string,
    readonly safeMode: boolean,
    private readonly client: OrchestrationClient,
  ) {}

  get selectedRunId(): string {
    return this.run?.id ?? '';
  }

  start(initialRunId?: string, initialRun?: OrchestrationRunV6): () => void {
    this.disposed = false;
    const generation = ++this.generation;
    this.live = createRunLiveUpdates({
      scope: () => ({
        workspaceId: this.workspaceId,
        generation: this.generation,
        visible: !this.disposed,
        revision: (runId) => Math.max(this.summaries.find((item) => item.id === runId)?.revision ?? -1, this.run?.id === runId ? this.run.revision : -1),
      }),
      read: (request) => this.client.orchestration_get_run_v6(request),
      apply: (run) => this.accept(run),
      failed: (error) => {
        this.liveError = error.message;
      },
    });
    void this.client
      .listen((event) => {
        // A run that is new to this list is read through the same path.
        this.live?.invalidate(event);
      })
      .then((stop) => {
        if (this.disposed || generation !== this.generation) stop();
        else this.stopLive = stop;
      })
      .catch(() => {
        if (!this.disposed) this.liveError = 'Live updates are unavailable. Refresh to read the recorded run.';
      });
    if (initialRun) this.accept(initialRun, true);
    void this.refresh().then(() => {
      if (this.disposed || generation !== this.generation) return;
      const target = initialRun?.id ?? initialRunId ?? sortRuns(this.summaries)[0]?.id;
      if (target && this.run?.id !== target) void this.open(target);
    });
    return () => this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.live?.dispose();
    this.live = undefined;
    this.stopLive?.();
    this.stopLive = undefined;
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    this.listLoading = true;
    this.listError = '';
    try {
      const incoming = await this.client.orchestration_list_runs_v6({ workspaceId: this.workspaceId });
      if (generation !== this.generation) return;
      this.summaries = mergeRunSummaries(this.summaries, incoming);
    } catch (error) {
      if (generation === this.generation) this.listError = orchestrationError(error).message;
    } finally {
      if (generation === this.generation) this.listLoading = false;
    }
  }

  async open(runId: string): Promise<void> {
    const generation = this.generation;
    if (this.run?.id !== runId) {
      this.selectedStepId = '';
      this.attemptIndex = -1;
      this.usage = {};
      this.usageUnavailable = false;
      this.actionError = '';
    }
    this.runLoading = true;
    this.runError = '';
    try {
      const run = await this.client.orchestration_get_run_v6({ workspaceId: this.workspaceId, runId });
      if (generation !== this.generation) return;
      if (run === null) {
        this.runError = 'This run is no longer available. Refresh the list.';
        return;
      }
      this.accept(run, true);
    } catch (error) {
      if (generation === this.generation) this.runError = orchestrationError(error).message;
    } finally {
      if (generation === this.generation) this.runLoading = false;
    }
  }

  /** Accept a recorded run only when it is newer; keep the list in step. */
  private accept(run: OrchestrationRunV6, select = false): void {
    const current = this.run;
    if (select || current?.id === run.id) {
      if (!current || current.id !== run.id || run.revision >= current.revision) {
        const switched = current?.id !== run.id;
        this.run = run;
        if (switched) {
          this.selectedStepId = '';
          this.attemptIndex = -1;
        }
        void this.loadUsage(run.id);
      }
    }
    this.summaries = mergeRunSummaries(this.summaries, [runSummary(run)]);
  }

  select(stepId: string): void {
    this.selectedStepId = stepId;
    this.attemptIndex = -1;
  }

  private async loadUsage(runId: string): Promise<void> {
    const request = ++this.usageRequest;
    try {
      const usage = await this.client.orchestration_run_usage_v6({ workspaceId: this.workspaceId, runId });
      if (request !== this.usageRequest || this.run?.id !== runId) return;
      this.usage = usage;
      this.usageUnavailable = false;
    } catch {
      if (request === this.usageRequest) this.usageUnavailable = true;
    }
  }

  // ---- operator actions --------------------------------------------------------

  private async perform(key: string, build: (run: OrchestrationRunV6) => RunAction): Promise<boolean> {
    const run = this.run;
    if (!run || this.busy) return false;
    this.busy = key;
    this.actionError = '';
    try {
      const result = await performRunAction(this.client, build(run), this.safeMode);
      if (result.type === 'recorded') {
        this.accept(result.run);
        if (result.actionError) this.actionError = result.actionError.message;
        return !result.actionError;
      }
      this.actionError = result.error.message;
      return false;
    } finally {
      this.busy = '';
    }
  }

  private base(run: OrchestrationRunV6) {
    return { workspaceId: this.workspaceId, runId: run.id, expectedRunRevision: run.revision };
  }

  private flow(key: string, action: (run: OrchestrationRunV6) => FlowAction): Promise<boolean> {
    return this.perform(key, (run) => ({ type: 'flow', request: { ...this.base(run), action: action(run) } }));
  }

  cancelRun(): Promise<boolean> {
    return this.perform('cancel-run', (run) => ({ type: 'cancel', request: this.base(run) }));
  }

  setPaused(paused: boolean): Promise<boolean> {
    return this.flow('pause', () => ({ type: paused ? 'pause' : 'resume' }));
  }

  decide(stepId: string, approved: boolean): Promise<boolean> {
    return this.flow(`decide:${stepId}`, (run) => ({ type: 'decide', stepId, taskRevision: this.taskRevision(run, stepId), approved }));
  }

  repeat(stepId: string): Promise<boolean> {
    return this.flow(`repeat:${stepId}`, (run) => ({ type: 'repeat', stepId, taskRevision: this.taskRevision(run, stepId) }));
  }

  cancelTask(stepId: string): Promise<boolean> {
    return this.perform(`cancel:${stepId}`, (run) => ({ type: 'cancelTask', request: { ...this.base(run), stepId } }));
  }

  retry(stepId: string): Promise<boolean> {
    return this.perform(`retry:${stepId}`, (run) => ({
      type: 'retry',
      request: { ...this.base(run), stepId, expectedTaskRevision: this.taskRevision(run, stepId) },
    }));
  }

  reconcile(stepId: string, resolution: ReconcileUncertainTaskRequest['resolution']): Promise<boolean> {
    return this.perform(`reconcile:${stepId}`, (run) => ({
      type: 'reconcile',
      request: { ...this.base(run), stepId, expectedTaskRevision: this.taskRevision(run, stepId), resolution },
    }));
  }

  private taskRevision(run: OrchestrationRunV6, stepId: string): number {
    return run.tasks.find((task) => task.stepId === stepId)?.revision ?? -1;
  }
}
