import type { ScriptRuntime } from '../labContracts';
import type { LabHandlers } from '../labHandlers';
import { arrayOf, decodeArgument, enumOf, json, mapOf, object, string, u32, withDefault } from '../labSchema';
import { isHostErrorPayload } from '../labErrors';
import { verifiedProject } from '../labState';
import type { LabSessions } from '../sessionRuntime';
import {
  MAX_SCRIPT_SOURCE_BYTES,
  MAX_SCRIPT_STDERR_BYTES,
  SCRIPT_FAILURE_CODES,
  boundedText,
  failureWithDetail,
  resultFieldIssues,
  scriptResult,
  scriptTimeoutValid,
} from '../../stepExecutors';
import type {
  ScriptTestCancelRequestV1,
  ScriptTestCancelResultV1,
  ScriptTestErrorCodeV1,
  ScriptTestRequestV1,
  ScriptTestResultV1,
} from '../../../../../../contracts/orchestration-script-test-v1';
import { MAX_SCRIPT_TEST_STDIN_BYTES } from '../../../../../../contracts/orchestration-script-test-v1';

/**
 * The editor's script test in the UI Lab (script test v1). Like the lab's
 * script steps it never evaluates the source: it answers deterministically
 * from lab markers after a short simulated run. `lab:fail` exits 1 with a
 * stderr line, `lab:timeout` runs into its time limit, `lab:text` prints plain
 * text, and anything else echoes a JSON summary of its stdin. Admission and
 * refusals mirror the host: safe mode, unknown, missing and untrusted
 * projects, a missing interpreter, a running id and too many tests.
 */
const TEST_RUN_MS = 400;
const MAX_CONCURRENT_TESTS = 4;
const MAX_ID_BYTES = 128;

const requestSchema = object({
  workspaceId: string,
  testId: string,
  runtime: enumOf(['node', 'python', 'powershell']),
  source: string,
  timeoutSeconds: u32,
  resultFields: withDefault(arrayOf(object({ name: string, kind: enumOf(['text', 'number', 'boolean', 'text-list', 'artifact']) }))),
  stdin: mapOf(json),
});
const cancelSchema = object({ workspaceId: string, testId: string });

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

function refusal(code: ScriptTestErrorCodeV1): { readonly code: ScriptTestErrorCodeV1 } {
  return { code };
}

function validId(value: string): boolean {
  return value.trim() !== '' && bytes(value) <= MAX_ID_BYTES;
}

function validRequest(request: ScriptTestRequestV1): boolean {
  const names = (request.resultFields ?? []).map((field) => field.name);
  return (
    validId(request.workspaceId) &&
    validId(request.testId) &&
    request.source.trim() !== '' &&
    bytes(request.source) <= MAX_SCRIPT_SOURCE_BYTES &&
    scriptTimeoutValid(request.timeoutSeconds) &&
    names.length <= 64 &&
    names.every((name) => name.trim() !== '') &&
    new Set(names).size === names.length &&
    bytes(JSON.stringify(request.stdin)) <= MAX_SCRIPT_TEST_STDIN_BYTES
  );
}

interface FakeRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function fakeRun(request: ScriptTestRequestV1): FakeRun {
  const stdin = request.stdin;
  const step = (typeof stdin.step === 'object' && stdin.step !== null ? stdin.step : {}) as Record<string, unknown>;
  const inputs = typeof stdin.inputs === 'object' && stdin.inputs !== null ? Object.keys(stdin.inputs) : [];
  const upstream = (typeof stdin.dependencies === 'object' && stdin.dependencies !== null ? stdin.dependencies : {}) as Record<string, { text?: unknown; data?: unknown } | null>;
  const dependencies = Object.keys(upstream);
  // The same summary as the run fake (runScheduler.ts), so a test predicts the run.
  const characters = dependencies.reduce((total, id) => {
    const value = upstream[id];
    return total + (typeof value?.text === 'string' ? value.text : JSON.stringify(value?.data ?? '')).length;
  }, 0);
  if (request.source.includes('lab:timeout')) return { exitCode: null, stdout: 'started\n', stderr: 'still waiting (lab:timeout)\n', timedOut: true };
  if (request.source.includes('lab:fail')) return { exitCode: 1, stdout: '', stderr: 'Error: the check failed (lab:fail)\n', timedOut: false };
  if (request.source.includes('lab:text')) {
    return { exitCode: 0, stdout: `${String(step.name ?? 'step')}: ${dependencies.length} dependencies, ${characters} characters\n`, stderr: '', timedOut: false };
  }
  return { exitCode: 0, stdout: `${JSON.stringify({ step: step.id ?? null, inputs, dependencies, characters })}\n`, stderr: '', timedOut: false };
}

/** The host's result for a fake run, through the shared result checker. */
function testResult(request: ScriptTestRequestV1, run: FakeRun, durationMs: number): ScriptTestResultV1 {
  const fields = request.resultFields ?? [];
  const stdout = boundedText(run.stdout, 256 * 1024);
  const stderr = boundedText(run.stderr, MAX_SCRIPT_STDERR_BYTES);
  let data: Record<string, unknown> | null = null;
  if (!run.timedOut && run.exitCode === 0 && !stdout.truncated) {
    try {
      const parsed: unknown = JSON.parse(stdout.text.trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  let failure: ScriptTestResultV1['failure'];
  if (run.timedOut) failure = failureWithDetail(SCRIPT_FAILURE_CODES.timeout, run.stderr);
  else if (run.exitCode !== 0) failure = failureWithDetail(SCRIPT_FAILURE_CODES.failed, run.stderr.trim() === '' ? run.stdout : run.stderr);
  else {
    const verdict = scriptResult(fields, stdout.text, stdout.truncated);
    failure = verdict.status === 'failed' ? verdict.failure : null;
  }
  return {
    protocol: 1,
    outcome: run.timedOut ? 'timedOut' : 'exited',
    exitCode: run.exitCode,
    durationMs,
    stdout: stdout.text,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
    data,
    fieldIssues: data === null ? [] : resultFieldIssues(fields, data),
    failure,
  };
}

function cancelledResult(durationMs: number): ScriptTestResultV1 {
  return {
    protocol: 1, outcome: 'cancelled', exitCode: null, durationMs, stdout: '', stdoutTruncated: false,
    stderr: '', stderrTruncated: false, data: null, fieldIssues: [], failure: null,
  };
}

/** `authorize`: safe mode first, then the project's registration, trust and folder. */
function admit(runtime: LabSessions, workspaceId: string): void {
  if (runtime.state.safeMode) throw refusal('safe-mode');
  try {
    verifiedProject(runtime.state, workspaceId, true);
  } catch (error) {
    const code = isHostErrorPayload(error) ? error.code : '';
    throw refusal(code === 'NOT_TRUSTED' ? 'not-trusted' : code === 'NOT_FOUND' ? 'not-found' : 'project-unavailable');
  }
}

export function scriptTestHandlers(runtime: LabSessions): LabHandlers {
  const running = new Map<string, () => void>();
  const key = (workspaceId: string, testId: string): string => `${workspaceId}\u0000${testId}`;
  return {
    orchestration_script_test_v1: (args) => {
      const request = decodeArgument<ScriptTestRequestV1>(args, 'request', requestSchema);
      if (!validRequest(request)) throw refusal('invalid');
      admit(runtime, request.workspaceId);
      const id = key(request.workspaceId, request.testId);
      if (running.has(id)) throw refusal('conflict');
      if (running.size >= MAX_CONCURRENT_TESTS) throw refusal('busy');
      if ((runtime.state.missingScriptRuntimes ?? []).includes(request.runtime as ScriptRuntime)) throw refusal('script-runtime-unavailable');
      const run = fakeRun(request);
      const started = runtime.clock.now();
      return new Promise<ScriptTestResultV1>((resolve) => {
        let stopTimer = (): void => undefined;
        const finish = (result: ScriptTestResultV1): void => {
          if (!running.has(id)) return;
          running.delete(id);
          stopTimer();
          resolve(result);
        };
        running.set(id, () => finish(cancelledResult(runtime.clock.now() - started)));
        const delay = run.timedOut ? request.timeoutSeconds * 1_000 : TEST_RUN_MS;
        stopTimer = runtime.clock.after(delay, () => finish(testResult(request, run, runtime.clock.now() - started)));
      });
    },
    orchestration_cancel_script_test_v1: (args): ScriptTestCancelResultV1 => {
      const request = decodeArgument<ScriptTestCancelRequestV1>(args, 'request', cancelSchema);
      if (!validId(request.workspaceId) || !validId(request.testId)) throw refusal('invalid');
      const cancel = running.get(key(request.workspaceId, request.testId));
      cancel?.();
      return { protocol: 1, cancelled: cancel !== undefined };
    },
  };
}
