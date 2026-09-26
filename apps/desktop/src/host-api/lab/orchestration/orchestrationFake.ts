import type { LabEventBus } from '../labBus';
import {
  ORCHESTRATION_SCHEDULE_EVENT_V7,
  type AgentProfile, type CancelTaskRequest, type DeleteDefinitionRequest, type FlowControlRequest, type GetDefinitionRequest,
  type LaunchCommandReference, type OrchestrationCatalogV6, type OrchestrationRunV6, type OrchestrationScheduleChangedEventV7,
  type PipelineDefinition, type ReconcileUncertainTaskRequest, type RetryUncertainTaskRequest, type RunMutationRequest,
  type RunRequest, type RunSummary, type SaveDefinitionRequest, type SaveGraphRequest, type SaveScheduleRequest,
  type ScheduleMutationRequest, type ScheduleSnapshot, type SetScheduleEnabledRequest, type StartRunRequest,
  type TeamDefinition, type UsageReceipt, type WorkspaceRequest,
} from '../labContracts';
import { orchestrationFailure } from '../labErrors';
import type { LabHandler, LabHandlers } from '../labHandlers';
import { decodeArgument, type Schema } from '../labSchema';
import {
  cancelTaskSchema, deleteDefinitionSchema, flowControlSchema, getDefinitionSchema, launchCommandSchema, pipelineSchema,
  profileSchema, reconcileUncertainSchema, retryUncertainSchema, runMutationSchema, runRequestSchema, saveGraphSchema,
  saveRequest, saveScheduleSchema, scheduleMutationSchema, setScheduleEnabledSchema, startRunSchema, teamSchema,
  workspaceRequestSchema,
} from '../labSchemas';
import { emptyOrchestration, type LabOrchestrationWorkspace, type LabState } from '../labState';
import type { LabSessions } from '../sessionRuntime';
import { definitionIssue } from './definitionRules';
import {
  compareText, deleteDefinition, deleteSchedule, getDefinition, LAUNCH_COMMANDS, listSchedules, PIPELINES, PROFILES,
  saveDefinition, saveGraph, saveSchedule, setScheduleEnabled, summaries, TEAMS, type DefinitionKind,
} from './definitionStore';
import {
  controlFlow, CoordinatorFault, newRun, reconcileUncertain, retryUncertain, runSummary, runToWire, type LabRun,
} from './runEngine';
import type { LabRunScheduler } from './runScheduler';
import { resolveRunInputs } from '../../runInputs';
import { isScriptStep } from '../../stepExecutors';

/**
 * Every `orchestration_*` command the UI client calls, with the host's scope
 * checks: reads need a registered project, runtime actions a trusted one
 * outside safe mode (`runtime-unavailable` otherwise).
 */
interface Context {
  readonly state: LabState;
  readonly scheduler: LabRunScheduler;
  readonly bus: LabEventBus;
}

/** `validate_workspace_scope` */
function scope(state: LabState, workspaceId: string): LabOrchestrationWorkspace | undefined {
  if (workspaceId.trim() === '') throw orchestrationFailure('invalid');
  const project = state.projects.find((candidate) => candidate.id === workspaceId);
  if (project === undefined || project.missing) throw orchestrationFailure('not-found');
  return state.orchestration.get(workspaceId);
}

/** `validate_live_workspace_scope` */
function liveScope(state: LabState, workspaceId: string): LabOrchestrationWorkspace | undefined {
  if (workspaceId.trim() === '') throw orchestrationFailure('invalid');
  const project = state.projects.find((candidate) => candidate.id === workspaceId);
  if (state.safeMode || project === undefined || project.missing || project.trustState !== 'trusted') {
    throw orchestrationFailure('runtime-unavailable');
  }
  return state.orchestration.get(workspaceId);
}

function ensureWorkspace(state: LabState, workspaceId: string): LabOrchestrationWorkspace {
  const existing = state.orchestration.get(workspaceId);
  if (existing !== undefined) return existing;
  const created = emptyOrchestration(workspaceId);
  state.orchestration.set(workspaceId, created);
  return created;
}

/** `mutable_run` */
function requireRun(workspace: LabOrchestrationWorkspace | undefined, runId: string): LabRun {
  const run = workspace?.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) throw orchestrationFailure('not-found');
  return run;
}

function faultCode(error: unknown, unknownTask: 'not-found' | 'invalid' = 'invalid'): never {
  if (!(error instanceof CoordinatorFault)) throw error;
  if (error.kind === 'revision-conflict') throw orchestrationFailure('conflict');
  throw orchestrationFailure(error.kind === 'unknown-task' ? unknownTask : 'invalid');
}

function emitSchedule(bus: LabEventBus, workspaceId: string, scheduleId: string, revision: number): void {
  const event: OrchestrationScheduleChangedEventV7 = { protocol: 7, type: 'scheduleChanged', workspaceId, scheduleId, revision };
  bus.emit(ORCHESTRATION_SCHEDULE_EVENT_V7, event);
}

function startRun({ state, scheduler }: Context, request: StartRunRequest): OrchestrationRunV6 {
  const workspace = liveScope(state, request.workspaceId);
  if (workspace === undefined) throw orchestrationFailure('not-found');
  if (workspace.runs.some((run) => run.id === request.runId)) throw orchestrationFailure('already-exists');
  const team = workspace.teams.find((stored) => stored.value.id === request.teamId)?.value;
  const pipeline = workspace.pipelines.find((stored) => stored.value.id === request.pipelineId)?.value;
  if (team === undefined || pipeline === undefined) throw orchestrationFailure('not-found');
  const commandId = request.launchCommandId ?? undefined;
  const launchCommand = commandId === undefined
    ? undefined
    : workspace.launchCommands.find((stored) => stored.value.id === commandId)?.value;
  if (commandId !== undefined && launchCommand === undefined) throw orchestrationFailure('not-found');
  const definition = structuredClone({
    profiles: workspace.profiles.map((stored) => stored.value),
    team,
    pipeline,
    ...(launchCommand === undefined ? {} : { launchCommand }),
  });
  if (request.runId.trim() === '' || definitionIssue(definition) !== undefined) throw orchestrationFailure('invalid');
  // `new_run_with_inputs`: values are validated and frozen before anything is scheduled.
  const inputs = resolveRunInputs(definition.pipeline.inputs, request.inputs);
  if (!inputs.ok) throw orchestrationFailure('invalid');
  const run = newRun(request.runId, definition, inputs.values);
  workspace.runs.push(run);
  scheduler.emit(request.workspaceId, run);
  const admission = scheduler.schedule(request.workspaceId, run);
  scheduler.emit(request.workspaceId, run);
  if (admission !== undefined) throw orchestrationFailure(admission);
  return runToWire(run);
}

function flow({ state, scheduler }: Context, request: FlowControlRequest): OrchestrationRunV6 {
  const run = requireRun(liveScope(state, request.workspaceId), request.runId);
  try {
    controlFlow(run, request.expectedRunRevision, request.action);
  } catch (error) {
    faultCode(error);
  }
  scheduler.emit(request.workspaceId, run);
  if (run.status === 'running' && !run.paused) scheduler.schedule(request.workspaceId, run);
  return runToWire(run);
}

function reconcile({ state, scheduler }: Context, request: ReconcileUncertainTaskRequest): OrchestrationRunV6 {
  const succeeded = request.resolution.status === 'succeeded';
  const workspace = succeeded ? liveScope(state, request.workspaceId) : scope(state, request.workspaceId);
  const run = requireRun(workspace, request.runId);
  try {
    reconcileUncertain(run, request.expectedRunRevision, request.stepId, request.expectedTaskRevision, request.resolution);
  } catch (error) {
    faultCode(error, 'not-found');
  }
  scheduler.emit(request.workspaceId, run);
  if (!succeeded) return runToWire(run);
  const admission = scheduler.schedule(request.workspaceId, run);
  scheduler.emit(request.workspaceId, run);
  if (admission !== undefined) throw orchestrationFailure(admission);
  return runToWire(run);
}

function retry({ state, scheduler }: Context, request: RetryUncertainTaskRequest): OrchestrationRunV6 {
  const run = requireRun(liveScope(state, request.workspaceId), request.runId);
  try {
    retryUncertain(run, request.expectedRunRevision, request.stepId, request.expectedTaskRevision);
  } catch (error) {
    faultCode(error, 'not-found');
  }
  scheduler.emit(request.workspaceId, run);
  const admission = scheduler.schedule(request.workspaceId, run);
  scheduler.emit(request.workspaceId, run);
  if (admission !== undefined) throw orchestrationFailure(admission);
  return runToWire(run);
}

/** `cancel_scope`: live-workspace authorization precedes the revision-checked plan. */
function cancellableRun({ state, scheduler }: Context, request: RunMutationRequest): LabRun {
  const workspace = scope(state, request.workspaceId);
  if (!scheduler.admits(request.workspaceId)) throw orchestrationFailure('runtime-unavailable');
  const run = workspace?.runs.find((candidate) => candidate.id === request.runId);
  if (run === undefined) throw orchestrationFailure('conflict');
  return run;
}

function cancelRunCommand(context: Context, request: RunMutationRequest): OrchestrationRunV6 {
  const run = cancellableRun(context, request);
  context.scheduler.cancel(request.workspaceId, run, request.expectedRunRevision);
  return runToWire(run);
}

function cancelTaskCommand(context: Context, request: CancelTaskRequest): OrchestrationRunV6 {
  const run = cancellableRun(context, request);
  context.scheduler.cancel(request.workspaceId, run, request.expectedRunRevision, request.stepId);
  if (run.status === 'running' && !run.paused) context.scheduler.schedule(request.workspaceId, run);
  return runToWire(run);
}

function runUsage(state: LabState, request: RunRequest): Record<string, UsageReceipt[]> {
  const run = scope(state, request.workspaceId)?.runs.find((candidate) => candidate.id === request.runId);
  if (run === undefined) throw orchestrationFailure('not-found');
  const usage: Record<string, UsageReceipt[]> = {};
  for (const task of [...run.tasks, ...run.attempts]) {
    if (task.execution === undefined) continue;
    // A script execution is host work with no session or model usage.
    if (run.definition.pipeline.steps.some((step) => step.id === task.stepId && isScriptStep(step))) continue;
    const record = state.sessions.get(task.execution.id);
    if (record === undefined || record.workspaceId !== request.workspaceId) throw orchestrationFailure('not-found');
    usage[task.execution.id] = record.usage.map((receipt) => ({ ...receipt }));
  }
  return Object.fromEntries(Object.entries(usage).sort(([left], [right]) => compareText(left, right)));
}

function listRuns(state: LabState, request: WorkspaceRequest): RunSummary[] {
  return (scope(state, request.workspaceId)?.runs ?? []).map(runSummary).sort((left, right) => compareText(left.id, right.id));
}

function catalog(state: LabState, request: WorkspaceRequest): OrchestrationCatalogV6 {
  const workspace = scope(state, request.workspaceId);
  return {
    profiles: summaries(workspace?.profiles ?? []),
    teams: summaries(workspace?.teams ?? []),
    pipelines: summaries(workspace?.pipelines ?? []),
    launchCommands: summaries(workspace?.launchCommands ?? []),
  };
}

/** Schedule writes are refused in safe mode before any scope check (`validate_schedule_mutation_scope`). */
function scheduleScope(state: LabState, workspaceId: string): LabOrchestrationWorkspace | undefined {
  if (state.safeMode) throw orchestrationFailure('runtime-unavailable');
  return scope(state, workspaceId);
}

function definitionHandlers<T extends { readonly id: string; readonly name: string }>(
  context: Context,
  kind: DefinitionKind<T>,
  valueSchema: Schema,
): { get: LabHandler; save: LabHandler; remove: LabHandler } {
  const { state } = context;
  return {
    get: (args) => {
      const request = decodeArgument<GetDefinitionRequest>(args, 'request', getDefinitionSchema);
      return getDefinition(kind, scope(state, request.workspaceId), request.id);
    },
    save: (args) => {
      const request = decodeArgument<SaveDefinitionRequest<T>>(args, 'request', saveRequest(valueSchema));
      scope(state, request.workspaceId);
      return saveDefinition(kind, ensureWorkspace(state, request.workspaceId), request);
    },
    remove: (args) => {
      const request = decodeArgument<DeleteDefinitionRequest>(args, 'request', deleteDefinitionSchema);
      deleteDefinition(kind, scope(state, request.workspaceId), request);
      return null;
    },
  };
}

export function orchestrationHandlers(runtime: LabSessions, scheduler: LabRunScheduler, bus: LabEventBus): LabHandlers {
  const context: Context = { state: runtime.state, scheduler, bus };
  const { state } = context;
  const profiles = definitionHandlers<AgentProfile>(context, PROFILES, profileSchema);
  const teams = definitionHandlers<TeamDefinition>(context, TEAMS, teamSchema);
  const pipelines = definitionHandlers<PipelineDefinition>(context, PIPELINES, pipelineSchema);
  const commands = definitionHandlers<LaunchCommandReference>(context, LAUNCH_COMMANDS, launchCommandSchema);
  const request = <T>(args: Parameters<LabHandler>[0], schema: Schema): T => decodeArgument<T>(args, 'request', schema);
  return {
    orchestration_catalog_v6: (args) => catalog(state, request<WorkspaceRequest>(args, workspaceRequestSchema)),
    orchestration_get_profile_v6: profiles.get,
    orchestration_save_profile_v6: profiles.save,
    orchestration_delete_profile_v6: profiles.remove,
    orchestration_get_team_v6: teams.get,
    orchestration_save_team_v6: teams.save,
    orchestration_delete_team_v6: teams.remove,
    orchestration_get_pipeline_v6: pipelines.get,
    orchestration_save_pipeline_v6: pipelines.save,
    orchestration_delete_pipeline_v6: pipelines.remove,
    orchestration_get_launch_command_v6: commands.get,
    orchestration_save_launch_command_v6: commands.save,
    orchestration_delete_launch_command_v6: commands.remove,
    orchestration_save_graph_v6: (args) => {
      const graph = request<SaveGraphRequest>(args, saveGraphSchema);
      scope(state, graph.workspaceId);
      saveGraph(ensureWorkspace(state, graph.workspaceId), graph);
      return null;
    },
    orchestration_list_schedules_v7: (args): ScheduleSnapshot[] =>
      listSchedules(scope(state, request<WorkspaceRequest>(args, workspaceRequestSchema).workspaceId)),
    orchestration_save_schedule_v7: (args) => {
      const save = request<SaveScheduleRequest>(args, saveScheduleSchema);
      const saved = saveSchedule(scheduleScope(state, save.workspaceId), save);
      emitSchedule(bus, save.workspaceId, save.value.id, saved.revision);
      return saved;
    },
    orchestration_set_schedule_enabled_v7: (args) => {
      const change = request<SetScheduleEnabledRequest>(args, setScheduleEnabledSchema);
      const workspace = change.enabled ? liveScope(state, change.workspaceId) : scheduleScope(state, change.workspaceId);
      const saved = setScheduleEnabled(workspace, change);
      emitSchedule(bus, change.workspaceId, change.id, saved.revision);
      return saved;
    },
    orchestration_delete_schedule_v7: (args) => {
      const removal = request<ScheduleMutationRequest>(args, scheduleMutationSchema);
      deleteSchedule(scheduleScope(state, removal.workspaceId), removal.id, removal.expectedRevision);
      emitSchedule(bus, removal.workspaceId, removal.id, removal.expectedRevision + 1);
      return null;
    },
    orchestration_list_runs_v6: (args) => listRuns(state, request<WorkspaceRequest>(args, workspaceRequestSchema)),
    orchestration_get_run_v6: (args) => {
      const read = request<RunRequest>(args, runRequestSchema);
      const run = scope(state, read.workspaceId)?.runs.find((candidate) => candidate.id === read.runId);
      return run === undefined ? null : runToWire(run);
    },
    orchestration_start_run_v6: (args) => startRun(context, request<StartRunRequest>(args, startRunSchema)),
    orchestration_cancel_run_v6: (args) => cancelRunCommand(context, request<RunMutationRequest>(args, runMutationSchema)),
    orchestration_cancel_task_v6: (args) => cancelTaskCommand(context, request<CancelTaskRequest>(args, cancelTaskSchema)),
    orchestration_control_flow_v6: (args) => flow(context, request<FlowControlRequest>(args, flowControlSchema)),
    orchestration_reconcile_uncertain_task_v6: (args) =>
      reconcile(context, request<ReconcileUncertainTaskRequest>(args, reconcileUncertainSchema)),
    orchestration_retry_uncertain_task_v6: (args) =>
      retry(context, request<RetryUncertainTaskRequest>(args, retryUncertainSchema)),
    orchestration_run_usage_v6: (args) => runUsage(state, request<RunRequest>(args, runRequestSchema)),
  };
}
