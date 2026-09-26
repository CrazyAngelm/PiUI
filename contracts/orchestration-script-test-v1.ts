/**
 * Script step test v1: runs one script step's current draft once, without a
 * pipeline run, when a person clicks Test in the editor.
 *
 * The host uses the same runner, admission and result checks as a script step
 * in a run (orchestration v6.2): only a trusted, live project outside safe
 * mode; the project folder as working directory; process-tree containment;
 * the allowlisted environment; the timeout; stdout 256 KiB (head) and stderr
 * 64 KiB (tail). A test is not a sandbox, records nothing in any run and can
 * only name a script runtime: it never starts an agent or a model call. The
 * host logs metadata only, never source, stdin or output.
 *
 * Commands: `orchestration_script_test_v1` (resolves when the script ended,
 * timed out or was cancelled) and `orchestration_cancel_script_test_v1`.
 * Both reject unknown fields. Independent of orchestration host v6/v7.
 */

import type { FailureRecord, OrchestrationId, ResultField, ScriptRuntime } from './orchestration-v6';

/** Largest encoded sample stdin document, in UTF-8 bytes. */
export const MAX_SCRIPT_TEST_STDIN_BYTES = 256 * 1024;

export interface ScriptTestRequestV1 {
  readonly workspaceId: OrchestrationId;
  /** Chosen by the caller (a UUID); names the test for cancellation. At most 128 bytes. */
  readonly testId: OrchestrationId;
  readonly runtime: ScriptRuntime;
  /** Non-blank, at most 64 KiB (UTF-8). */
  readonly source: string;
  /** Whole seconds, 1-3600. */
  readonly timeoutSeconds: number;
  /** The step's declared result fields (unique, non-empty names), checked like a run. */
  readonly resultFields?: readonly ResultField[];
  /**
   * The one JSON document written to stdin, normally
   * `{inputs, dependencies: {<stepId>: {text, data}}, step: {id, name}}`.
   * Any JSON object is accepted; encoded at most 256 KiB.
   */
  readonly stdin: Readonly<Record<string, unknown>>;
}

export interface ScriptTestCancelRequestV1 {
  readonly workspaceId: OrchestrationId;
  readonly testId: OrchestrationId;
}

export interface ScriptTestCancelResultV1 {
  readonly protocol: 1;
  /** False when no such test was running (it already ended). */
  readonly cancelled: boolean;
}

/** `exited`: ended on its own; `timedOut`/`cancelled`: its whole process tree was stopped. */
export type ScriptTestOutcomeV1 = 'exited' | 'timedOut' | 'cancelled';

export interface ScriptTestFieldIssueV1 {
  readonly field: string;
  readonly code: 'result-missing-field' | 'result-field-type';
}

export interface ScriptTestResultV1 {
  readonly protocol: 1;
  readonly outcome: ScriptTestOutcomeV1;
  /** Exit status; null unless the script exited on its own with a code. */
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** The first 256 KiB of stdout (what arrived before a timeout or cancellation). */
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  /** The last 64 KiB of stderr. */
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  /** Complete stdout parsed as one JSON object, whatever the verdict; otherwise null. */
  readonly data: Record<string, unknown> | null;
  /** Declared fields `data` does not satisfy, in declared order (the run's checker). */
  readonly fieldIssues: readonly ScriptTestFieldIssueV1[];
  /**
   * What a run would record as this step's failure (`script-failed` with the
   * stderr tail, `script-timeout`, `result-*`, `result-artifact-unavailable`);
   * null when a run would succeed, or when the test was cancelled.
   */
  readonly failure: FailureRecord | null;
}

/**
 * Typed refusals, serialized as `{code}`. Nothing ran for any of them except
 * `script-outcome-unknown` (the script started but its end or cleanup could
 * not be observed).
 */
export type ScriptTestErrorCodeV1 =
  | 'invalid'
  | 'not-found'
  | 'safe-mode'
  | 'not-trusted'
  | 'project-unavailable'
  | 'shutting-down'
  | 'conflict'
  | 'busy'
  | 'script-runtime-unavailable'
  | 'script-start-failed'
  | 'script-outcome-unknown';

export interface ScriptTestErrorV1 {
  readonly code: ScriptTestErrorCodeV1;
}

export interface ScriptTestCommandsV1 {
  orchestration_script_test_v1(request: ScriptTestRequestV1): Promise<ScriptTestResultV1>;
  orchestration_cancel_script_test_v1(request: ScriptTestCancelRequestV1): Promise<ScriptTestCancelResultV1>;
}
