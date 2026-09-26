/**
 * Run debugging v1: n8n-style debugging of pipeline runs without paid
 * re-runs. Four commands, independent of orchestration host v6/v7, whose run
 * and definition commands keep their shapes. Orchestration v6.4 adds the
 * matching additive fields: `PipelineStep.pinnedOutput`,
 * `StartRunRequest.usePinnedData`, `OrchestrationRunV6.usePinnedData`,
 * `TaskRecord.pinned` and `RunSummary.archived`.
 *
 * - `orchestration_run_outputs_v1` (read-only) lists the recorded output of
 *   every succeeded step of a run: script and pinned text from the run
 *   record, native final answers from native history, verified by their
 *   content hash. It never starts or resumes anything.
 * - `orchestration_pin_step_output_v1` copies one succeeded step's output
 *   (read by the host the same way) into the saved pipeline's step as pinned
 *   data, atomically and checked against the pipeline revision.
 * - `orchestration_set_run_archived_v1` hides a finished run from the default
 *   run list, or shows it again. The run record is unchanged.
 * - `orchestration_delete_run_v1` removes a finished run's PiUI records: its
 *   entry in PiUI's run journal (steps, results PiUI recorded, attempts,
 *   messages) and any script working copy left for it in PiUI's data folder.
 *   Native harness sessions and their histories, chats and project files are
 *   never touched. Running and uncertain runs are refused.
 *
 * Writes are refused in safe mode. Requests reject unknown fields; refusals
 * are typed `{code}` values. Nothing here is a shell, filesystem or session
 * surface: arguments are opaque workspace, run, pipeline and step ids.
 */

import type { OrchestrationId, PinnedOutput, Revision } from './orchestration-v6';

export const RUN_DEBUGGING_PROTOCOL_V1 = 1 as const;

export interface RunOutputsRequestV1 {
  readonly workspaceId: OrchestrationId;
  readonly runId: OrchestrationId;
}

/**
 * Why a succeeded step's output cannot be pinned: `too-large` (text or
 * result over 256 KiB), `unavailable` (its native history could not be read
 * or no longer matches the recorded hash).
 */
export type StepOutputIssueV1 = 'too-large' | 'unavailable';

export interface StepOutputV1 {
  readonly stepId: OrchestrationId;
  /** Native final answer, script stdout or pinned text; at most 256 KiB. */
  readonly text?: string;
  /** The text is the first part of a longer output (a cut script stdout). */
  readonly truncated?: boolean;
  /** The step's structured result. */
  readonly data?: Record<string, unknown>;
  readonly issue?: StepOutputIssueV1;
}

export interface RunOutputsResultV1 {
  readonly protocol: 1;
  readonly runId: OrchestrationId;
  /** Succeeded steps only, in the run's task order. */
  readonly outputs: readonly StepOutputV1[];
}

export interface PinStepOutputRequestV1 {
  readonly workspaceId: OrchestrationId;
  readonly runId: OrchestrationId;
  readonly stepId: OrchestrationId;
  /** The saved pipeline to pin into (normally the run's `definition.pipeline.id`). */
  readonly pipelineId: OrchestrationId;
  /** The saved pipeline revision the person saw. */
  readonly expectedRevision: Revision;
}

export interface PinStepOutputResultV1 {
  readonly protocol: 1;
  /** The pipeline's new revision. */
  readonly revision: Revision;
  readonly pinnedOutput: PinnedOutput;
}

export interface SetRunArchivedRequestV1 {
  readonly workspaceId: OrchestrationId;
  readonly runId: OrchestrationId;
  readonly archived: boolean;
}

export interface SetRunArchivedResultV1 {
  readonly protocol: 1;
  readonly runId: OrchestrationId;
  readonly archived: boolean;
}

export interface DeleteRunRequestV1 {
  readonly workspaceId: OrchestrationId;
  readonly runId: OrchestrationId;
  /** The run revision the person confirmed; a changed run is not deleted. */
  readonly expectedRunRevision: Revision;
}

export interface DeleteRunResultV1 {
  readonly protocol: 1;
  readonly runId: OrchestrationId;
}

/**
 * - `invalid`: malformed ids.
 * - `not-found`: unknown project, run, pipeline or step.
 * - `conflict`: the pipeline or run revision changed.
 * - `safe-mode` / `shutting-down`: writes are unavailable.
 * - `run-active`: the run is running or uncertain (delete, archive).
 * - `step-not-succeeded`: only a succeeded step's output can be pinned.
 * - `not-pinnable`: the saved step is a callable role, a program router or
 *   a reviewing step.
 * - `no-output`: the step succeeded without recorded text or result.
 * - `too-large`: over 256 KiB, or the pipeline's pins would pass 1 MiB.
 * - `output-unavailable`: its native history could not be read or verified.
 * - `io`: PiUI's data could not be saved; nothing changed.
 */
export type RunDebuggingErrorCodeV1 =
  | 'invalid'
  | 'not-found'
  | 'conflict'
  | 'safe-mode'
  | 'shutting-down'
  | 'run-active'
  | 'step-not-succeeded'
  | 'not-pinnable'
  | 'no-output'
  | 'too-large'
  | 'output-unavailable'
  | 'io';

export interface RunDebuggingErrorV1 {
  readonly code: RunDebuggingErrorCodeV1;
}

export interface RunDebuggingCommandsV1 {
  orchestration_run_outputs_v1(request: RunOutputsRequestV1): Promise<RunOutputsResultV1>;
  orchestration_pin_step_output_v1(request: PinStepOutputRequestV1): Promise<PinStepOutputResultV1>;
  orchestration_set_run_archived_v1(request: SetRunArchivedRequestV1): Promise<SetRunArchivedResultV1>;
  orchestration_delete_run_v1(request: DeleteRunRequestV1): Promise<DeleteRunResultV1>;
}
