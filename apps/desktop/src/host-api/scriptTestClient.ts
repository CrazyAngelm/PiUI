import { hostInvoke, type HostInvoke } from './transport';
import type {
  ScriptTestCancelRequestV1,
  ScriptTestCancelResultV1,
  ScriptTestErrorCodeV1,
  ScriptTestFieldIssueV1,
  ScriptTestOutcomeV1,
  ScriptTestRequestV1,
  ScriptTestResultV1,
} from '../../../../contracts/orchestration-script-test-v1';

export type * from '../../../../contracts/orchestration-script-test-v1';
export { MAX_SCRIPT_TEST_STDIN_BYTES } from '../../../../contracts/orchestration-script-test-v1';

/**
 * Client of the editor's script test (script test v1). A test runs the
 * node's draft once on the host with the same runner and checks as a run;
 * it never starts an agent or a model call. The host is the authority for
 * every rule; this client only maps its typed refusals to safe copy.
 */
export type ScriptTestErrorCode = ScriptTestErrorCodeV1 | 'unknown';

/** English source strings of the locale catalog. */
const ERROR_COPY: Readonly<Record<ScriptTestErrorCode, string>> = {
  invalid: 'Check the code, its time limit and the sample input before testing.',
  'not-found': 'This project is no longer registered. Refresh the project list.',
  'safe-mode': 'Scripts do not run in safe mode.',
  'not-trusted': 'Trust this project folder to test scripts.',
  'project-unavailable': 'The project folder is unavailable.',
  'shutting-down': 'PiUI is closing.',
  conflict: 'This test is already running.',
  busy: 'Too many script tests are running. Wait for one to finish.',
  'script-runtime-unavailable': 'The script runtime (Node.js, Python or PowerShell) was not found on this computer.',
  'script-start-failed': 'The script could not be started. Nothing ran.',
  'script-outcome-unknown': 'The script started, but PiUI could not observe how it ended.',
  unknown: 'The script test could not be completed.',
};

export class ScriptTestOperationError extends Error {
  constructor(readonly code: ScriptTestErrorCode, message: string = ERROR_COPY[code]) {
    super(message);
    this.name = 'ScriptTestOperationError';
  }
}

/** Maps a rejected invoke to a typed error; host details are never forwarded. */
export function scriptTestError(cause: unknown): ScriptTestOperationError {
  if (cause instanceof ScriptTestOperationError) return cause;
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
      ? (value.code as ScriptTestErrorCode)
      : 'unknown';
  return new ScriptTestOperationError(code);
}

const OUTCOMES: readonly ScriptTestOutcomeV1[] = ['exited', 'timedOut', 'cancelled'];
const FIELD_CODES: readonly ScriptTestFieldIssueV1['code'][] = ['result-missing-field', 'result-field-type'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldIssue(value: unknown): value is ScriptTestFieldIssueV1 {
  return isRecord(value) && typeof value.field === 'string' && FIELD_CODES.includes(value.code as ScriptTestFieldIssueV1['code']);
}

function isFailure(value: unknown): boolean {
  return value === null || (isRecord(value) && typeof value.code === 'string' && (value.detail === undefined || typeof value.detail === 'string'));
}

/** The result exactly as the contract describes it, or undefined. */
export function decodeScriptTestResult(value: unknown): ScriptTestResultV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1) return undefined;
  const valid =
    OUTCOMES.includes(value.outcome as ScriptTestOutcomeV1) &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    typeof value.stdout === 'string' &&
    typeof value.stdoutTruncated === 'boolean' &&
    typeof value.stderr === 'string' &&
    typeof value.stderrTruncated === 'boolean' &&
    (value.data === null || isRecord(value.data)) &&
    Array.isArray(value.fieldIssues) &&
    value.fieldIssues.every(isFieldIssue) &&
    isFailure(value.failure);
  return valid ? (value as unknown as ScriptTestResultV1) : undefined;
}

export interface ScriptTestClient {
  /** Resolves when the script ended, timed out or was cancelled. */
  run(request: ScriptTestRequestV1): Promise<ScriptTestResultV1>;
  /** True when a running test was asked to stop its process tree. */
  cancel(request: ScriptTestCancelRequestV1): Promise<boolean>;
}

export function createScriptTestClient(invoke: HostInvoke): ScriptTestClient {
  return {
    async run(request) {
      let result: unknown;
      try {
        result = await invoke<unknown>('orchestration_script_test_v1', { request });
      } catch (error) {
        throw scriptTestError(error);
      }
      const decoded = decodeScriptTestResult(result);
      if (decoded === undefined) throw new ScriptTestOperationError('unknown');
      return decoded;
    },
    async cancel(request) {
      let result: unknown;
      try {
        result = await invoke<ScriptTestCancelResultV1>('orchestration_cancel_script_test_v1', { request });
      } catch (error) {
        throw scriptTestError(error);
      }
      if (!isRecord(result) || result.protocol !== 1 || typeof result.cancelled !== 'boolean') {
        throw new ScriptTestOperationError('unknown');
      }
      return result.cancelled;
    },
  };
}

export const scriptTestHost: ScriptTestClient = createScriptTestClient((command, args) => hostInvoke(command, args));

/** English error copy, exported for the locale completeness test. */
export const SCRIPT_TEST_ERROR_COPY = ERROR_COPY;
