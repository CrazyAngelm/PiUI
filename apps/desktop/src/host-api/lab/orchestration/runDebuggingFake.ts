import type { PinnedOutput } from '../labContracts';
import type { LabHandlers } from '../labHandlers';
import { boolean, decodeArgument, object, string, u64 } from '../labSchema';
import { isHostErrorPayload } from '../labErrors';
import { verifiedProject, type LabOrchestrationWorkspace, type LabState } from '../labState';
import type { LabSessions } from '../sessionRuntime';
import { jsonBytes, MAX_PINNED_DATA_BYTES, MAX_PINNED_TEXT_BYTES, pinningRefusal, pipelinePinsIssue } from '../../pinnedData';
import type {
  DeleteRunRequestV1,
  DeleteRunResultV1,
  PinStepOutputRequestV1,
  PinStepOutputResultV1,
  RunDebuggingErrorCodeV1,
  RunOutputsRequestV1,
  RunOutputsResultV1,
  SetRunArchivedRequestV1,
  SetRunArchivedResultV1,
  StepOutputV1,
} from '../../../../../../contracts/orchestration-run-debugging-v1';
import { taskOf, type LabRun, type LabTask } from './runEngine';
import { nativeDependencyText } from './taskContent';

/**
 * Run debugging v1 in the UI Lab: recorded outputs, pinning into the saved
 * pipeline, archive and delete, with the host's refusals (safe mode, unknown
 * and missing projects, active runs, revisions, bounds). Deleting a run
 * removes only its lab record; its linked sessions stay, like native history.
 */
const MAX_ID_BYTES = 512;
const encoder = new TextEncoder();

const outputsSchema = object({ workspaceId: string, runId: string });
const pinSchema = object({ workspaceId: string, runId: string, stepId: string, pipelineId: string, expectedRevision: u64 });
const archiveSchema = object({ workspaceId: string, runId: string, archived: boolean });
const deleteSchema = object({ workspaceId: string, runId: string, expectedRunRevision: u64 });

function refusal(code: RunDebuggingErrorCodeV1): { readonly code: RunDebuggingErrorCodeV1 } {
  return { code };
}

function requireIds(...ids: readonly string[]): void {
  if (ids.some((id) => id.trim() === '' || encoder.encode(id).length > MAX_ID_BYTES)) throw refusal('invalid');
}

function writable(state: LabState): void {
  if (state.safeMode) throw refusal('safe-mode');
}

/** `verified_project_directory(.., false)`: a registered, present project. */
function workspaceOf(state: LabState, workspaceId: string): LabOrchestrationWorkspace | undefined {
  try {
    verifiedProject(state, workspaceId, false);
  } catch (error) {
    if (isHostErrorPayload(error)) throw refusal('not-found');
    throw error;
  }
  return state.orchestration.get(workspaceId);
}

function runOf(workspace: LabOrchestrationWorkspace | undefined, runId: string): LabRun {
  const run = workspace?.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) throw refusal('not-found');
  return run;
}

const active = (run: LabRun): boolean => run.status === 'running' || run.status === 'uncertain';

/** `step_output`: recorded text or the verified native answer, and the result, within the pinning bound. */
function stepOutput(state: LabState, run: LabRun, task: LabTask): StepOutputV1 {
  let text: string | undefined;
  let truncated = false;
  let issue: StepOutputV1['issue'];
  if (task.output !== undefined) {
    text = task.output.text;
    truncated = task.output.truncated === true;
  } else if (task.resultReference !== undefined) {
    const native = nativeDependencyText(state.sessions, run, task.stepId);
    if (native === null || native === '') issue = 'unavailable';
    else text = native;
  }
  if (text !== undefined && encoder.encode(text).length > MAX_PINNED_TEXT_BYTES) {
    text = undefined;
    truncated = false;
    issue = 'too-large';
  }
  let data: Record<string, unknown> | undefined;
  if (task.resultData !== undefined) {
    if (jsonBytes(task.resultData) > MAX_PINNED_DATA_BYTES) issue = 'too-large';
    else data = task.resultData;
  }
  return {
    stepId: task.stepId,
    ...(text === undefined ? {} : { text }),
    ...(truncated ? { truncated } : {}),
    ...(data === undefined ? {} : { data }),
    ...(issue === undefined ? {} : { issue }),
  };
}

export function runDebuggingHandlers(runtime: LabSessions): LabHandlers {
  const { state } = runtime;
  return {
    orchestration_run_outputs_v1: (args): RunOutputsResultV1 => {
      const request = decodeArgument<RunOutputsRequestV1>(args, 'request', outputsSchema);
      requireIds(request.workspaceId, request.runId);
      const run = runOf(workspaceOf(state, request.workspaceId), request.runId);
      return {
        protocol: 1,
        runId: run.id,
        outputs: run.tasks.filter((task) => task.status === 'succeeded').map((task) => stepOutput(state, run, task)),
      };
    },
    orchestration_pin_step_output_v1: (args): PinStepOutputResultV1 => {
      const request = decodeArgument<PinStepOutputRequestV1>(args, 'request', pinSchema);
      requireIds(request.workspaceId, request.runId, request.stepId, request.pipelineId);
      writable(state);
      const workspace = workspaceOf(state, request.workspaceId);
      const run = runOf(workspace, request.runId);
      const task = taskOf(run, request.stepId);
      if (task === undefined) throw refusal('not-found');
      if (task.status !== 'succeeded') throw refusal('step-not-succeeded');
      const output = stepOutput(state, run, task);
      if (output.issue === 'too-large') throw refusal('too-large');
      if (output.issue === 'unavailable') throw refusal('output-unavailable');
      if (output.text === undefined && output.data === undefined) throw refusal('no-output');
      const position = workspace?.pipelines.findIndex((candidate) => candidate.value.id === request.pipelineId) ?? -1;
      const stored = workspace?.pipelines[position];
      if (workspace === undefined || stored === undefined) throw refusal('not-found');
      if (stored.revision !== request.expectedRevision) throw refusal('conflict');
      const index = stored.value.steps.findIndex((step) => step.id === request.stepId);
      const step = stored.value.steps[index];
      if (step === undefined) throw refusal('not-found');
      if (pinningRefusal(step) !== undefined) throw refusal('not-pinnable');
      const pinnedOutput: PinnedOutput = {
        ...(output.text === undefined ? {} : { text: output.text }),
        ...(output.truncated ? { truncated: true } : {}),
        ...(output.data === undefined ? {} : { data: structuredClone(output.data) }),
        pinnedAt: runtime.clock.iso().replace(/\.\d{3}Z$/u, 'Z'),
        sourceRunId: run.id,
      };
      const steps = stored.value.steps.map((candidate, at) => (at === index ? { ...candidate, pinnedOutput } : candidate));
      if (pipelinePinsIssue(steps) !== undefined) throw refusal('too-large');
      const revision = stored.revision + 1;
      workspace.pipelines[position] = { revision, value: { ...stored.value, steps } };
      return { protocol: 1, revision, pinnedOutput };
    },
    orchestration_set_run_archived_v1: (args): SetRunArchivedResultV1 => {
      const request = decodeArgument<SetRunArchivedRequestV1>(args, 'request', archiveSchema);
      requireIds(request.workspaceId, request.runId);
      writable(state);
      const workspace = workspaceOf(state, request.workspaceId);
      const run = runOf(workspace, request.runId);
      if (workspace === undefined) throw refusal('not-found');
      const archived = workspace.archivedRunIds ?? new Set<string>();
      if (request.archived && !archived.has(run.id) && active(run)) throw refusal('run-active');
      if (request.archived) archived.add(run.id);
      else archived.delete(run.id);
      workspace.archivedRunIds = archived;
      return { protocol: 1, runId: run.id, archived: request.archived };
    },
    orchestration_delete_run_v1: (args): DeleteRunResultV1 => {
      const request = decodeArgument<DeleteRunRequestV1>(args, 'request', deleteSchema);
      requireIds(request.workspaceId, request.runId);
      writable(state);
      const workspace = workspaceOf(state, request.workspaceId);
      const run = runOf(workspace, request.runId);
      if (workspace === undefined) throw refusal('not-found');
      if (run.revision !== request.expectedRunRevision) throw refusal('conflict');
      if (active(run)) throw refusal('run-active');
      workspace.runs = workspace.runs.filter((candidate) => candidate.id !== run.id);
      workspace.archivedRunIds?.delete(run.id);
      return { protocol: 1, runId: run.id };
    },
  };
}
