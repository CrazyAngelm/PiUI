/**
 * Pure projections of a recorded run for the run view. Nothing here infers a
 * native outcome: every label maps one recorded journal state.
 */
import type { OrchestrationRunV6, PipelineStep, RunStatus, RunSummary, TaskRecord, TaskStatus } from '../../host-api/orchestrationClient';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type StepState = TaskStatus | 'onCall' | 'missing';

export interface StepView {
  readonly stepId: string;
  readonly name: string;
  readonly step: PipelineStep;
  readonly state: StepState;
  readonly task: TaskRecord | undefined;
  /** Earlier attempts of this step, oldest first (loops, reviews, repeats). */
  readonly attempts: readonly TaskRecord[];
  /** PiUI workspace session id bound by the coordinator, never a native id. */
  readonly sessionId: string | undefined;
  readonly spawned: boolean;
}

export const STEP_LABEL: Record<StepState, string> = {
  awaitingApproval: 'Needs approval',
  skipped: 'Skipped',
  ready: 'Waiting',
  running: 'Working',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  uncertain: 'Needs checking',
  onCall: 'On call',
  missing: 'No record',
};

export const STEP_TONE: Record<StepState, Tone> = {
  awaitingApproval: 'warning',
  skipped: 'neutral',
  ready: 'neutral',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  uncertain: 'warning',
  onCall: 'neutral',
  missing: 'warning',
};

export const RUN_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  uncertain: 'Needs checking',
};

export const RUN_TONE: Record<RunStatus, Tone> = {
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  uncertain: 'warning',
};

export function stepState(step: PipelineStep, task: TaskRecord | undefined): StepState {
  if (!task) return 'missing';
  if (task.status === 'ready' && !task.leaseId && step.executionMode === 'callable') return 'onCall';
  return task.status;
}

export function stepViews(run: OrchestrationRunV6): StepView[] {
  const initial = new Set((run.initialDefinition ?? run.definition).pipeline.steps.map((step) => step.id));
  const tasks = new Map(run.tasks.map((task) => [task.stepId, task]));
  return run.definition.pipeline.steps.map((step) => {
    const task = tasks.get(step.id);
    return {
      stepId: step.id,
      name: step.name || step.id,
      step,
      state: stepState(step, task),
      task,
      attempts: (run.attempts ?? []).filter((attempt) => attempt.stepId === step.id),
      sessionId: step.executor?.type === 'script' ? undefined : task?.execution?.id,
      spawned: !initial.has(step.id),
    };
  });
}

export interface RunCounts {
  readonly total: number;
  readonly done: number;
  readonly working: number;
  readonly attention: number;
}

/** Callable templates that were never called do not count as outstanding work. */
export function runCounts(views: readonly StepView[]): RunCounts {
  const counted = views.filter((view) => view.state !== 'onCall' && view.state !== 'skipped');
  return {
    total: counted.length,
    done: counted.filter((view) => view.state === 'succeeded').length,
    working: counted.filter((view) => view.state === 'running').length,
    attention: views.filter((view) => needsAttention(view.state)).length,
  };
}

export function needsAttention(state: StepState): boolean {
  return state === 'awaitingApproval' || state === 'uncertain' || state === 'failed' || state === 'missing';
}

/** Mirrors the coordinator: only non-terminal tasks can be cancelled. */
export function canCancelTask(task: TaskRecord | undefined): boolean {
  return task?.status === 'ready' || task?.status === 'running' || task?.status === 'awaitingApproval';
}

/** Mirrors the coordinator: repeat needs a reconciled terminal attempt. */
export function canRepeat(task: TaskRecord | undefined): boolean {
  return task?.status === 'succeeded' || task?.status === 'failed' || task?.status === 'cancelled' || task?.status === 'awaitingApproval';
}

/** A reviewer cannot assert success for work whose result must be validated natively. */
export function canRecordSucceeded(step: PipelineStep): boolean {
  return !(step.resultFields?.length || step.requireApproval || step.review);
}

export type RunFilter = 'all' | 'active' | 'attention' | 'finished';

export function matchesRunFilter(run: RunSummary, filter: RunFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return run.status === 'running';
    case 'attention':
      return run.status === 'failed' || run.status === 'uncertain';
    case 'finished':
      return run.status === 'succeeded' || run.status === 'cancelled';
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

/** Running first, then problems, then finished runs; newest id first inside a group. */
export function sortRuns(runs: readonly RunSummary[]): RunSummary[] {
  const rank: Record<RunStatus, number> = { running: 0, uncertain: 1, failed: 2, succeeded: 3, cancelled: 4 };
  return [...runs].sort((left, right) => rank[left.status] - rank[right.status] || right.id.localeCompare(left.id));
}

/** Result fields in declaration order, then any extra recorded keys. */
export function resultEntries(step: PipelineStep, data: Record<string, unknown> | undefined): { name: string; value: unknown }[] {
  if (!data) return [];
  const declared = step.resultFields ?? [];
  const entries = declared.filter((field) => Object.hasOwn(data, field.name)).map((field) => ({ name: field.name, value: data[field.name] }));
  for (const [name, value] of Object.entries(data)) {
    if (!declared.some((field) => field.name === name)) entries.push({ name, value });
  }
  return entries;
}

export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function shortId(id: string): string {
  return id.replace(/-/gu, '').slice(0, 6);
}
