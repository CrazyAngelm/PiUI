import type {
  AgentProfile, AgentRequestRecord, FailureRecord, FlowAction, MessageRecord, NativeHistoryReference, OrchestrationRunV6,
  PipelineStep, ReconcileUncertainTaskRequest, ResultField, RouterConfig, RouterPredicate, RunDefinitionSnapshot,
  RunInputValue, RunStatus, RunSummary, TaskOutput, TaskRecord,
} from '../labContracts';
import { runInputSection, substituteInputTokens } from '../../runInputs';
import { executorKind, isScriptStep, scriptResult } from '../../stepExecutors';

/**
 * Pure run transitions ported from `piui-orchestration` (coordinator.rs and
 * flow.rs). Every change bumps the task and run revisions exactly where the
 * Rust coordinator does, so revision-checked UI actions behave identically.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type LabTask = Mutable<TaskRecord>;

export interface LabRun {
  /** Validated input values frozen at creation (sorted keys, like the host's `BTreeMap`). */
  inputs: Readonly<Record<string, RunInputValue>>;
  paused: boolean;
  attempts: LabTask[];
  schemaVersion: 6;
  id: string;
  definition: RunDefinitionSnapshot;
  status: RunStatus;
  revision: number;
  tasks: LabTask[];
  messages: MessageRecord[];
  agentRequests: AgentRequestRecord[];
}

export type FaultKind = 'revision-conflict' | 'unknown-task' | 'invalid';

export class CoordinatorFault extends Error {
  constructor(readonly kind: FaultKind, readonly reason: string) {
    super(reason);
    this.name = 'CoordinatorFault';
  }
}

export type Completion =
  | { readonly status: 'succeeded'; readonly reference: NativeHistoryReference; readonly text: string }
  | { readonly status: 'failed'; readonly code: string };

/** `ScriptCompletion`: what the host observed when a script ended (v6.2). */
export type ScriptCompletion =
  | { readonly status: 'exited'; readonly stdout: string; readonly truncated?: boolean }
  | { readonly status: 'failed'; readonly failure: FailureRecord };

const SELECTION_FIELD = 'selectedBranchIds';

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** `new_run_with_inputs` after the caller resolved `inputs` (see `resolveRunInputs`). */
export function newRun(id: string, definition: RunDefinitionSnapshot, inputs: Readonly<Record<string, RunInputValue>> = {}): LabRun {
  return {
    inputs,
    paused: false,
    attempts: [],
    schemaVersion: 6,
    id,
    definition,
    status: 'running',
    revision: 0,
    tasks: definition.pipeline.steps.map((step): LabTask => ({ stepId: step.id, status: 'ready', revision: 0 })),
    messages: [],
    agentRequests: [],
  };
}

export function stepOf(run: LabRun, stepId: string): PipelineStep | undefined {
  return run.definition.pipeline.steps.find((step) => step.id === stepId);
}

export function taskOf(run: LabRun, stepId: string): LabTask | undefined {
  return run.tasks.find((task) => task.stepId === stepId);
}

function requireTask(run: LabRun, stepId: string): LabTask {
  const task = taskOf(run, stepId);
  if (task === undefined) throw new CoordinatorFault('unknown-task', `unknown task: ${stepId}`);
  return task;
}

export function profileForStep(run: LabRun, step: PipelineStep): AgentProfile | undefined {
  const member = run.definition.team.members.find((candidate) => candidate.id === step.assignedMemberId);
  return member === undefined ? undefined : run.definition.profiles.find((profile) => profile.id === member.profileId);
}

function checkRevision(expected: number, actual: number, scope: string): void {
  if (expected === actual) return;
  throw new CoordinatorFault('revision-conflict', `${scope} revision conflict: expected ${expected}, actual ${actual}`);
}

function ensureActive(run: LabRun): void {
  if (run.status !== 'running') throw new CoordinatorFault('invalid', `run is ${run.status}`);
}

function isCallable(run: LabRun, stepId: string): boolean {
  return stepOf(run, stepId)?.executionMode === 'callable';
}

function dependenciesSucceeded(run: LabRun, step: PipelineStep): boolean {
  return step.dependencyStepIds.every((id) => taskOf(run, id)?.status === 'succeeded');
}

function selectedBranches(run: LabRun, routerId: string): unknown[] | undefined {
  const router = stepOf(run, routerId)?.router;
  const value = taskOf(run, routerId)?.resultData?.[router?.selectionField ?? SELECTION_FIELD];
  return Array.isArray(value) ? value : undefined;
}

export function routeGateSatisfied(run: LabRun, step: PipelineStep): boolean {
  const gates = step.routeGates ?? [];
  if (gates.length === 0) return true;
  return [...new Set(gates.map((gate) => gate.routerStepId))].every((routerId) => {
    if (taskOf(run, routerId)?.status !== 'succeeded') return false;
    const selected = selectedBranches(run, routerId);
    return gates.filter((gate) => gate.routerStepId === routerId).some((gate) => selected?.includes(gate.branchId) === true);
  });
}

function conditionHolds(run: LabRun, step: PipelineStep): boolean {
  const condition = step.condition;
  if (condition === undefined) return true;
  const value = taskOf(run, condition.sourceStepId)?.resultData?.[condition.field];
  return value !== undefined && jsonEqual(value, condition.equals);
}

/** Eligible tasks in lexical step-id order (`ready_task_ids`). */
export function readyTaskIds(run: LabRun): string[] {
  if (run.status !== 'running' || run.paused) return [];
  return run.tasks
    .filter((task) => {
      const step = stepOf(run, task.stepId);
      return step !== undefined
        && task.status === 'ready'
        && task.leaseId === undefined
        && !isCallable(run, task.stepId)
        && dependenciesSucceeded(run, step)
        && step.router?.mode !== 'program'
        && conditionHolds(run, step)
        && routeGateSatisfied(run, step);
    })
    .map((task) => task.stepId)
    .sort();
}

/** `refresh_status` */
export function refreshStatus(run: LabRun): void {
  const statuses = run.tasks.map((task) => task.status);
  if (statuses.includes('uncertain')) run.status = 'uncertain';
  else if (statuses.includes('running') || statuses.includes('awaitingApproval')) run.status = 'running';
  else if (statuses.includes('failed')) run.status = 'failed';
  else if (run.tasks.every((task) => task.status === 'succeeded' || task.status === 'skipped'
    || (task.status === 'ready' && task.leaseId === undefined && isCallable(run, task.stepId)))) run.status = 'succeeded';
  else if (statuses.includes('ready')) run.status = 'running';
  else if (statuses.includes('cancelled')) run.status = 'cancelled';
}

/** `advance_conditions`: skips steps whose condition, route or dependency rules out execution. */
export function advanceConditions(run: LabRun): void {
  for (;;) {
    const skipped = run.definition.pipeline.steps.filter((step) => {
      const task = taskOf(run, step.id);
      if (task?.status !== 'ready' || task.leaseId !== undefined) return false;
      const inherited = step.dependencyStepIds.some((id) => taskOf(run, id)?.status === 'skipped');
      const source = step.condition === undefined ? undefined : taskOf(run, step.condition.sourceStepId);
      const falseCondition = step.condition !== undefined && source?.status === 'succeeded'
        && !jsonEqual(source.resultData?.[step.condition.field], step.condition.equals);
      const gates = step.routeGates ?? [];
      const routersDone = [...new Set(gates.map((gate) => gate.routerStepId))]
        .every((routerId) => taskOf(run, routerId)?.status === 'succeeded');
      const routeNotSelected = gates.length > 0 && routersDone && !routeGateSatisfied(run, step);
      return inherited || falseCondition || routeNotSelected;
    });
    if (skipped.length === 0) return;
    for (const step of skipped) {
      const task = requireTask(run, step.id);
      task.status = 'skipped';
      task.revision += 1;
    }
  }
}

function evaluatePredicate(predicate: RouterPredicate, input: Record<string, unknown>): boolean {
  switch (predicate.op) {
    case 'equals': return Object.hasOwn(input, predicate.field) && jsonEqual(input[predicate.field], predicate.value);
    case 'exists': return Object.hasOwn(input, predicate.field);
    case 'all': return predicate.predicates.every((item) => evaluatePredicate(item, input));
    case 'any': return predicate.predicates.some((item) => evaluatePredicate(item, input));
    case 'not': return !evaluatePredicate(predicate.predicate, input);
    default: {
      const exhaustive: never = predicate;
      return exhaustive;
    }
  }
}

type Selection = { ok: true; value: string[] } | { ok: false; code: string };

function programSelection(router: RouterConfig, input: Record<string, unknown>): Selection {
  const selected: string[] = [];
  for (const branch of router.branches) {
    if (branch.predicate === undefined) return { ok: false, code: 'router-predicate-missing' };
    if (evaluatePredicate(branch.predicate, input)) selected.push(branch.id);
  }
  return { ok: true, value: selected };
}

/** `advance_program_routers`: coordinator-owned routing steps never launch a native turn. */
export function advanceProgramRouters(run: LabRun): boolean {
  let changed = false;
  for (;;) {
    const candidates = run.definition.pipeline.steps.filter((step) => {
      const task = taskOf(run, step.id);
      return step.router?.mode === 'program' && task?.status === 'ready' && task.leaseId === undefined
        && dependenciesSucceeded(run, step);
    });
    if (candidates.length === 0) return changed;
    for (const step of candidates) {
      const router = step.router as RouterConfig;
      const task = requireTask(run, step.id);
      const input = objectValue(taskOf(run, router.inputStepId)?.resultData);
      const result: Selection = input === undefined
        ? { ok: false, code: 'router-input-invalid' }
        : programSelection(router, input);
      if (result.ok) {
        task.status = 'succeeded';
        task.resultData = { [router.selectionField ?? SELECTION_FIELD]: result.value };
        delete task.failure;
      } else {
        task.status = 'failed';
        task.failure = { code: result.code };
        delete task.resultData;
      }
      task.revision += 1;
      run.revision += 1;
      changed = true;
    }
    advanceConditions(run);
    refreshStatus(run);
  }
}

/** Durable lease before any native side effect (`lease_next_task` for one step). */
export function leaseTask(run: LabRun, stepId: string, leaseId: string): void {
  ensureActive(run);
  const task = requireTask(run, stepId);
  task.leaseId = leaseId;
  task.revision += 1;
  run.revision += 1;
}

/** `dispatch_leased_task`: binds the reserved workspace session as the execution. */
export function dispatchTask(run: LabRun, stepId: string, executionId: string): void {
  ensureActive(run);
  const task = requireTask(run, stepId);
  if (task.status !== 'ready' || task.leaseId === undefined) throw new CoordinatorFault('invalid', 'task is not leased');
  task.status = 'running';
  delete task.leaseId;
  task.execution = { id: executionId };
  task.revision += 1;
  run.revision += 1;
}

/** `reject_ready_task`: a prelaunch policy refusal is a certain failure. */
export function rejectReadyTask(run: LabRun, stepId: string, code: string): void {
  const task = requireTask(run, stepId);
  if (task.status !== 'ready' || task.leaseId !== undefined) throw new CoordinatorFault('invalid', 'task is not ready');
  task.status = 'failed';
  task.failure = { code };
  task.revision += 1;
  cancelReady(run);
  run.revision += 1;
  refreshStatus(run);
}

function cancelReady(run: LabRun): void {
  for (const task of run.tasks) {
    if (task.status === 'ready') {
      task.status = 'cancelled';
      task.revision += 1;
    }
  }
}

/** `validate_result`: structured results are JSON objects with correctly typed fields. */
export function validateResult(fields: readonly ResultField[], text: string): string | undefined {
  if (fields.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return 'result-invalid-json';
  }
  const object = objectValue(value);
  if (object === undefined) return 'result-not-object';
  for (const field of fields) {
    if (!Object.hasOwn(object, field.name)) return 'result-missing-field';
    const item = object[field.name];
    const valid = field.kind === 'text' || field.kind === 'artifact'
      ? typeof item === 'string' && item.trim() !== ''
      : field.kind === 'number'
        ? typeof item === 'number'
        : field.kind === 'boolean'
          ? typeof item === 'boolean'
          : Array.isArray(item) && item.every((entry) => typeof entry === 'string' && entry.trim() !== '');
    if (!valid) return 'result-field-type';
  }
  return undefined;
}

function agentSelection(router: RouterConfig, data: Record<string, unknown>): string[] | undefined {
  const values = data[router.selectionField ?? SELECTION_FIELD];
  if (!Array.isArray(values)) return undefined;
  const known = new Set(router.branches.map((branch) => branch.id));
  const selected: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !known.has(value) || selected.includes(value)) return undefined;
    selected.push(value);
  }
  return selected;
}

function parseData(text: string): Record<string, unknown> | undefined {
  try {
    return objectValue(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** `repeat_from`: resets a step and its transitive dependents, keeping executed attempts. */
function repeatFrom(run: LabRun, stepId: string): void {
  const affected = new Set([stepId]);
  for (let size = 0; size !== affected.size;) {
    size = affected.size;
    for (const step of run.definition.pipeline.steps) {
      if (step.dependencyStepIds.some((id) => affected.has(id))) affected.add(step.id);
    }
  }
  if (run.tasks.some((task) => affected.has(task.stepId)
    && (task.status === 'running' || task.status === 'uncertain' || task.leaseId !== undefined))) {
    throw new CoordinatorFault('invalid', 'repeat would overwrite active or uncertain work');
  }
  for (const task of run.tasks) {
    if (!affected.has(task.stepId)) continue;
    if (task.execution !== undefined) run.attempts.push(structuredClone(task));
    task.status = 'ready';
    delete task.execution;
    delete task.resultReference;
    delete task.resultData;
    delete task.failure;
    delete task.output;
    task.revision += 1;
  }
  run.status = 'running';
}

/** `complete_checked_task`: host-read native text validated against the step's result contract. */
export function completeTask(run: LabRun, stepId: string, executionId: string, completion: Completion): void {
  const step = stepOf(run, stepId);
  if (step === undefined) throw new CoordinatorFault('unknown-task', `unknown task: ${stepId}`);
  if (isScriptStep(step)) throw new CoordinatorFault('invalid', `step ${stepId} is not run by this executor`);
  let data: Record<string, unknown> | undefined;
  let outcome: Completion = completion;
  if (completion.status === 'succeeded') {
    const invalid = validateResult(step.resultFields ?? [], completion.text);
    if (invalid !== undefined) outcome = { status: 'failed', code: invalid };
    else {
      data = parseData(completion.text);
      if (step.router?.mode === 'agent') {
        const selection = data === undefined ? undefined : agentSelection(step.router, data);
        if (selection === undefined) outcome = { status: 'failed', code: 'router-selection-invalid' };
        else if (data !== undefined) data[step.router.selectionField ?? SELECTION_FIELD] = selection;
      }
    }
  }
  const task = requireTask(run, stepId);
  if (task.status !== 'running') throw new CoordinatorFault('invalid', `task ${stepId} is ${task.status}`);
  if (task.execution?.id !== executionId) throw new CoordinatorFault('invalid', `stale native result for task ${stepId}`);
  if (outcome.status === 'succeeded') {
    task.status = 'succeeded';
    task.resultReference = outcome.reference;
  } else {
    task.status = 'failed';
    task.failure = { code: outcome.code };
  }
  task.revision += 1;
  if (outcome.status === 'failed') cancelReady(run);
  run.revision += 1;
  refreshStatus(run);
  if (data === undefined) delete task.resultData;
  else task.resultData = data;
  if (task.status === 'succeeded') applyReviewAndApproval(run, step, task);
  advanceConditions(run);
  refreshStatus(run);
}

/**
 * `complete_script_task`: exit status 0 succeeds; complete stdout that is one
 * JSON object becomes result data checked like a native result, any other
 * stdout the recorded text output. Review and approval then apply.
 */
export function completeScript(run: LabRun, stepId: string, executionId: string, completion: ScriptCompletion): void {
  const step = stepOf(run, stepId);
  if (step === undefined) throw new CoordinatorFault('unknown-task', `unknown task: ${stepId}`);
  if (!isScriptStep(step)) throw new CoordinatorFault('invalid', `step ${stepId} is not run by this executor`);
  const result = completion.status === 'exited'
    ? scriptResult(step.resultFields ?? [], completion.stdout, completion.truncated === true)
    : { status: 'failed' as const, failure: completion.failure };
  const task = requireTask(run, stepId);
  if (task.status !== 'running') throw new CoordinatorFault('invalid', `task ${stepId} is ${task.status}`);
  if (task.execution?.id !== executionId) throw new CoordinatorFault('invalid', `stale native result for task ${stepId}`);
  if (result.status === 'succeeded') task.status = 'succeeded';
  else {
    task.status = 'failed';
    task.failure = result.failure;
  }
  task.revision += 1;
  if (result.status === 'failed') cancelReady(run);
  run.revision += 1;
  refreshStatus(run);
  const data = result.status === 'succeeded' ? result.data : undefined;
  const output: TaskOutput | undefined = result.status === 'succeeded' ? result.output : undefined;
  if (data === undefined) delete task.resultData;
  else task.resultData = data;
  if (output === undefined) delete task.output;
  else task.output = output;
  if (task.status === 'succeeded') applyReviewAndApproval(run, step, task);
  advanceConditions(run);
  refreshStatus(run);
}

/**
 * `review_limit_reached`: rounds are this reviewer's archived attempts that
 * returned a result, plus the one completing now.
 */
function reviewLimitReached(run: LabRun, step: PipelineStep): boolean {
  const limit = step.review?.maxIterations ?? undefined;
  if (limit === undefined) return false;
  const rounds = run.attempts
    .filter((attempt) => attempt.stepId === step.id && (attempt.status === 'succeeded' || attempt.status === 'awaitingApproval'))
    .length + 1;
  return rounds >= limit;
}

function applyReviewAndApproval(run: LabRun, step: PipelineStep, task: LabTask): void {
  if (step.review === undefined) {
    if (step.requireApproval) task.status = 'awaitingApproval';
    return;
  }
  const verdict = task.resultData?.[step.review.field];
  if (verdict === false && reviewLimitReached(run, step)) {
    // Another round would exceed the bound: a person approves, rejects or repeats.
    task.status = 'awaitingApproval';
    task.failure = { code: 'review-limit-reached' };
  } else if (verdict === false) {
    const previous = [...run.attempts].reverse().find((attempt) => attempt.stepId === step.id);
    const repeated = previous !== undefined && jsonEqual(previous.resultData, task.resultData);
    try {
      repeatFrom(run, step.review.retryFromStepId);
    } catch {
      task.status = 'failed';
      task.failure = { code: 'review-retry-conflict' };
    }
    // Two identical rejections in a row pause admissions instead of looping forever.
    if (repeated) run.paused = true;
  } else if (verdict === true) {
    if (step.requireApproval) task.status = 'awaitingApproval';
  } else {
    task.status = 'failed';
    task.failure = { code: 'review-verdict-missing' };
  }
}

/** Running executions the caller must interrupt before `cancelRun` commits. */
export function runningExecutions(run: LabRun, expectedRevision: number, stepId?: string): string[] {
  checkRevision(expectedRevision, run.revision, 'run');
  ensureActive(run);
  return run.tasks
    .filter((task) => task.status === 'running' && (stepId === undefined || task.stepId === stepId))
    .flatMap((task) => (task.execution ? [task.execution.id] : []));
}

/** `cancel_run` */
export function cancelRun(run: LabRun): void {
  ensureActive(run);
  for (const task of run.tasks) {
    if (task.status === 'running' || task.status === 'ready' || task.status === 'awaitingApproval') {
      delete task.leaseId;
      task.status = 'cancelled';
      task.revision += 1;
    }
  }
  run.status = 'cancelled';
  run.revision += 1;
}

/** `cancel_task`: cancels one step and every ready step blocked by it. */
export function cancelTask(run: LabRun, stepId: string): void {
  const task = requireTask(run, stepId);
  if (task.status !== 'ready' && task.status !== 'running' && task.status !== 'awaitingApproval') {
    throw new CoordinatorFault('invalid', 'task is already terminal');
  }
  task.status = 'cancelled';
  delete task.leaseId;
  task.revision += 1;
  for (;;) {
    const blocked = new Set(run.definition.pipeline.steps
      .filter((step) => step.dependencyStepIds.some((id) => taskOf(run, id)?.status === 'cancelled'))
      .map((step) => step.id));
    const newlyCancelled = run.tasks.filter((candidate) => candidate.status === 'ready' && blocked.has(candidate.stepId));
    if (newlyCancelled.length === 0) break;
    for (const candidate of newlyCancelled) {
      candidate.status = 'cancelled';
      candidate.revision += 1;
    }
  }
  run.revision += 1;
  refreshStatus(run);
}

/** `mark_task_uncertain`: a native execution ended without terminal evidence. */
export function markUncertain(run: LabRun, stepId: string, executionId: string): boolean {
  const task = taskOf(run, stepId);
  if (task?.status !== 'running' || task.execution?.id !== executionId) return false;
  task.status = 'uncertain';
  delete task.leaseId;
  task.revision += 1;
  run.revision += 1;
  run.status = 'uncertain';
  return true;
}

/** `control_flow`: pause/resume admissions, decide approvals, repeat a finished step. */
export function controlFlow(run: LabRun, expectedRevision: number, action: FlowAction): void {
  checkRevision(expectedRevision, run.revision, 'run');
  switch (action.type) {
    case 'pause':
    case 'resume':
      if (run.status !== 'running') throw new CoordinatorFault('invalid', `run is ${run.status}`);
      run.paused = action.type === 'pause';
      break;
    case 'decide': {
      const task = requireTask(run, action.stepId);
      if (task.revision !== action.taskRevision || task.status !== 'awaitingApproval') {
        throw new CoordinatorFault('invalid', 'decision is stale');
      }
      task.status = action.approved ? 'succeeded' : 'failed';
      // Approval accepts the recorded result, including one held by a review limit.
      if (action.approved) delete task.failure;
      else task.failure = { code: 'result-rejected' };
      task.revision += 1;
      break;
    }
    case 'repeat': {
      const task = requireTask(run, action.stepId);
      const terminal = task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled'
        || task.status === 'awaitingApproval';
      if (task.revision !== action.taskRevision || !terminal) {
        throw new CoordinatorFault('invalid', 'repeat requires a reconciled terminal attempt');
      }
      repeatFrom(run, action.stepId);
      break;
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
  advanceConditions(run);
  run.revision += 1;
  refreshStatus(run);
}

type Resolution = ReconcileUncertainTaskRequest['resolution'];

/** `reconcile_uncertain_task`: an operator assertion; never launches work. */
export function reconcileUncertain(
  run: LabRun,
  expectedRevision: number,
  stepId: string,
  taskRevision: number,
  resolution: Resolution,
): void {
  checkRevision(expectedRevision, run.revision, 'run');
  const task = requireTask(run, stepId);
  checkRevision(taskRevision, task.revision, 'task');
  if (task.status !== 'uncertain') throw new CoordinatorFault('invalid', `task ${stepId} is ${task.status}`);
  const step = stepOf(run, stepId);
  // A script has no native history: a reference cannot stand in for its result.
  if (resolution.status === 'succeeded' && resolution.resultReference && step !== undefined && isScriptStep(step)) {
    throw new CoordinatorFault('invalid', `step ${stepId} is not run by this executor`);
  }
  const structured = (step?.resultFields?.length ?? 0) > 0 || step?.requireApproval === true || step?.review !== undefined;
  if (resolution.status === 'succeeded' && structured) {
    throw new CoordinatorFault('invalid', 'structured results require native validation');
  }
  if (resolution.status === 'succeeded') {
    task.status = 'succeeded';
    if (resolution.resultReference) task.resultReference = resolution.resultReference;
  } else if (resolution.status === 'failed') {
    task.status = 'failed';
    task.failure = { code: resolution.failureCode };
  } else {
    task.status = 'cancelled';
  }
  task.revision += 1;
  if (resolution.status !== 'succeeded') cancelReady(run);
  run.revision += 1;
  refreshStatus(run);
}

/** `retry_uncertain_task`: explicit user replay of an uncertain task as a new attempt. */
export function retryUncertain(run: LabRun, expectedRevision: number, stepId: string, taskRevision: number): void {
  checkRevision(expectedRevision, run.revision, 'run');
  const task = requireTask(run, stepId);
  checkRevision(taskRevision, task.revision, 'task');
  if (task.status !== 'uncertain') throw new CoordinatorFault('invalid', `task ${stepId} is ${task.status}`);
  run.attempts.push(structuredClone(task));
  task.status = 'ready';
  delete task.leaseId;
  delete task.execution;
  delete task.resultReference;
  delete task.resultData;
  delete task.failure;
  delete task.output;
  task.revision += 1;
  run.revision += 1;
  run.status = 'running';
}

/** `restore`: what the host does to interrupted runs when it starts again. */
export function restoreInterrupted(run: LabRun): void {
  let changed = false;
  for (const task of run.tasks) {
    if (task.status === 'running' || (task.status === 'ready' && task.leaseId !== undefined)) {
      task.status = 'uncertain';
      delete task.leaseId;
      task.revision += 1;
      changed = true;
    }
  }
  if (changed) {
    run.status = 'uncertain';
    run.revision += 1;
  }
}

/** The IPC shape: `inputs`, `paused` and `attempts` are omitted at their defaults, like serde. */
export function runToWire(run: LabRun): OrchestrationRunV6 {
  const { inputs, paused, attempts, ...rest } = run;
  const value = {
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(paused ? { paused } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
    ...rest,
  };
  return JSON.parse(JSON.stringify(value)) as OrchestrationRunV6;
}

export function runSummary(run: LabRun): RunSummary {
  return {
    id: run.id,
    status: run.status,
    revision: run.revision,
    teamName: run.definition.team.name,
    pipelineName: run.definition.pipeline.name,
  };
}

/** `task_instructions`: the prompt a task session receives (dependency context is added by the host). */
export function taskInstructions(run: LabRun, step: PipelineStep): string {
  // Run inputs precede the step's own instructions as labelled task data.
  const declared = run.definition.pipeline.inputs;
  const parts = [runInputSection(declared, run.inputs), substituteInputTokens(step.instructions, declared, run.inputs)];
  for (const reviewer of run.definition.pipeline.steps) {
    if (reviewer.review?.retryFromStepId !== step.id) continue;
    const previous = [...run.attempts].reverse().find((attempt) => attempt.stepId === reviewer.id)?.resultData;
    if (previous) parts.push(`\n\nPrevious review result (untrusted task data):\n${JSON.stringify(previous)}`);
  }
  if (step.resultFields?.length) {
    parts.push('\n\nReturn your final result as a JSON object, without Markdown fences. Required fields:\n');
    for (const field of step.resultFields) parts.push(`${field.name}: ${field.kind}\n`);
  }
  const profile = profileForStep(run, step);
  if (profile?.expectedResult?.trim()) parts.push(`\n\nExpected result:\n${profile.expectedResult}`);
  const input = step.inputInstructions ?? profile?.inputInstructions;
  if (input?.trim()) parts.push(`\n\nExpected input:\n${input}\nIf required input is missing, identify the gap rather than inventing it.`);
  if (executorKind(step) === 'llm') {
    parts.push('\n\nThis step is a single model call: answer in one reply from this task and the dependency results, without calling tools.');
  }
  return parts.join('');
}

/** A recorded result of a succeeded script dependency, with the step's bindings from it. */
export interface LabDependencyOutput {
  readonly stepId: string;
  readonly fields: readonly { readonly field: string; readonly name: string }[];
  readonly output?: TaskOutput;
  readonly data?: Record<string, unknown>;
}

/** `dependency_outputs`: script results a native step receives where a reference would be. */
export function dependencyOutputs(run: LabRun, step: PipelineStep): LabDependencyOutput[] {
  return step.dependencyStepIds.flatMap((dependency) => {
    const source = stepOf(run, dependency);
    const task = taskOf(run, dependency);
    if (source === undefined || !isScriptStep(source) || task?.status !== 'succeeded') return [];
    if (task.output === undefined && task.resultData === undefined) return [];
    const fields = (step.inputBindings ?? [])
      .filter((binding) => binding.sourceStepId === dependency)
      .map((binding) => ({ field: binding.field, name: binding.name }));
    return [{
      stepId: dependency,
      fields,
      ...(task.output === undefined ? {} : { output: task.output }),
      ...(task.resultData === undefined ? {} : { data: task.resultData }),
    }];
  });
}

/** Result references of succeeded dependencies with the step's input bindings applied. */
export function dependencyReferences(run: LabRun, step: PipelineStep): NativeHistoryReference[] {
  return step.dependencyStepIds.flatMap((dependency) => {
    const reference = taskOf(run, dependency)?.resultReference;
    if (reference === undefined) return [];
    const fields = (step.inputBindings ?? [])
      .filter((binding) => binding.sourceStepId === dependency)
      .map((binding) => ({ field: binding.field, name: binding.name }));
    return [{ ...reference, ...(fields.length > 0 ? { fields } : {}) }];
  });
}
