import { hostInvoke, type HostInvoke } from './transport';
import type {
  DeleteRunRequestV1,
  PinStepOutputRequestV1,
  PinStepOutputResultV1,
  RunDebuggingErrorCodeV1,
  RunOutputsRequestV1,
  RunOutputsResultV1,
  SetRunArchivedRequestV1,
  StepOutputV1,
} from '../../../../contracts/orchestration-run-debugging-v1';
import type { PinnedOutput } from '../../../../contracts/orchestration-v6';

export type * from '../../../../contracts/orchestration-run-debugging-v1';

/**
 * Client of run debugging v1: recorded step outputs, pinning one into the
 * saved pipeline, archiving and deleting finished runs. The host is the
 * authority for every rule (safe mode, active runs, bounds, revisions); this
 * client maps its typed refusals to safe copy and checks result shapes.
 */
export type RunDebuggingErrorCode = RunDebuggingErrorCodeV1 | 'unknown';

/** English source strings of the locale catalog. */
const ERROR_COPY: Readonly<Record<RunDebuggingErrorCode, string>> = {
  invalid: 'This request is not valid. Refresh the run and try again.',
  'not-found': 'This run, pipeline or step is no longer available. Refresh the list.',
  conflict: 'This run or pipeline changed meanwhile. Nothing was changed; check it and try again.',
  'safe-mode': 'Safe mode keeps runs and pipelines read-only.',
  'shutting-down': 'PiUI is closing.',
  'run-active': 'This run is still running or needs checking. Stop or reconcile it first.',
  'step-not-succeeded': 'Only the output of a step that succeeded can be pinned.',
  'not-pinnable': 'This step always runs (a reviewing step, callable role or program router), so it cannot be pinned.',
  'no-output': 'This step finished without a recorded output.',
  'too-large': 'This output is larger than pinned data allows (256 KiB per step, 1 MiB per pipeline).',
  'output-unavailable': 'The agent’s history could not be read, so its output cannot be pinned.',
  io: 'PiUI could not save this change. Nothing was changed.',
  unknown: 'The operation could not be completed. Nothing was changed.',
};

export class RunDebuggingOperationError extends Error {
  constructor(readonly code: RunDebuggingErrorCode, message: string = ERROR_COPY[code]) {
    super(message);
    this.name = 'RunDebuggingOperationError';
  }
}

/** Maps a rejected invoke to a typed error; host details are never forwarded. */
export function runDebuggingError(cause: unknown): RunDebuggingOperationError {
  if (cause instanceof RunDebuggingOperationError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const code =
    typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' && Object.hasOwn(ERROR_COPY, value.code)
      ? (value.code as RunDebuggingErrorCode)
      : 'unknown';
  return new RunDebuggingOperationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const optional = (value: unknown, check: (item: unknown) => boolean): boolean => value === undefined || check(value);
const isString = (value: unknown): boolean => typeof value === 'string';

function isStepOutput(value: unknown): value is StepOutputV1 {
  return (
    isRecord(value) &&
    typeof value.stepId === 'string' &&
    optional(value.text, isString) &&
    optional(value.truncated, (item) => typeof item === 'boolean') &&
    optional(value.data, isRecord) &&
    optional(value.issue, (item) => item === 'too-large' || item === 'unavailable')
  );
}

export function isPinnedOutput(value: unknown): value is PinnedOutput {
  return (
    isRecord(value) &&
    typeof value.pinnedAt === 'string' &&
    optional(value.text, isString) &&
    optional(value.truncated, (item) => typeof item === 'boolean') &&
    optional(value.data, isRecord) &&
    optional(value.sourceRunId, isString) &&
    (value.text !== undefined || value.data !== undefined)
  );
}

/** The outputs result exactly as the contract describes it, or undefined. */
export function decodeRunOutputs(value: unknown): RunOutputsResultV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1 || typeof value.runId !== 'string' || !Array.isArray(value.outputs)) return undefined;
  return value.outputs.every(isStepOutput) ? (value as unknown as RunOutputsResultV1) : undefined;
}

export function decodePinResult(value: unknown): PinStepOutputResultV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1 || !Number.isSafeInteger(value.revision) || !isPinnedOutput(value.pinnedOutput)) return undefined;
  return value as unknown as PinStepOutputResultV1;
}

export interface RunDebuggingClient {
  outputs(request: RunOutputsRequestV1): Promise<RunOutputsResultV1>;
  pin(request: PinStepOutputRequestV1): Promise<PinStepOutputResultV1>;
  /** Resolves with the archived state the host recorded. */
  setArchived(request: SetRunArchivedRequestV1): Promise<boolean>;
  delete(request: DeleteRunRequestV1): Promise<void>;
}

export function createRunDebuggingClient(invoke: HostInvoke): RunDebuggingClient {
  async function call(command: string, request: object): Promise<unknown> {
    try {
      return await invoke<unknown>(command, { request });
    } catch (error) {
      throw runDebuggingError(error);
    }
  }
  return {
    async outputs(request) {
      const decoded = decodeRunOutputs(await call('orchestration_run_outputs_v1', request));
      if (decoded === undefined) throw new RunDebuggingOperationError('unknown');
      return decoded;
    },
    async pin(request) {
      const decoded = decodePinResult(await call('orchestration_pin_step_output_v1', request));
      if (decoded === undefined) throw new RunDebuggingOperationError('unknown');
      return decoded;
    },
    async setArchived(request) {
      const result = await call('orchestration_set_run_archived_v1', request);
      if (!isRecord(result) || result.protocol !== 1 || typeof result.archived !== 'boolean' || result.runId !== request.runId) {
        throw new RunDebuggingOperationError('unknown');
      }
      return result.archived;
    },
    async delete(request) {
      const result = await call('orchestration_delete_run_v1', request);
      if (!isRecord(result) || result.protocol !== 1 || result.runId !== request.runId) throw new RunDebuggingOperationError('unknown');
    },
  };
}

export const runDebuggingHost: RunDebuggingClient = createRunDebuggingClient((command, args) => hostInvoke(command, args));

/** English error copy, exported for the locale completeness test. */
export const RUN_DEBUGGING_ERROR_COPY = ERROR_COPY;
