import {
  MAX_PINNED_DATA_BYTES,
  MAX_PINNED_TEXT_BYTES,
  MAX_PIPELINE_PINNED_BYTES,
  type FailureRecord,
  type PinnedOutput,
  type PipelineStep,
  type TaskOutput,
} from '../../../../contracts/orchestration-v6';
import { resultValueIssue } from './stepExecutors';

/**
 * Pinned data (orchestration v6.3), mirroring `piui-orchestration/src/pinned.rs`.
 * The Rust coordinator and host are the authority; these pure helpers let the
 * editor check a graph before saving, the run views explain pinned tasks and
 * the UI Lab host admit pinned steps exactly like the coordinator.
 */
export { MAX_PINNED_DATA_BYTES, MAX_PINNED_TEXT_BYTES, MAX_PIPELINE_PINNED_BYTES };

/** Failure code of a review that would repeat a pinned correction step. */
export const REVIEW_RETRY_PINNED = 'review-retry-pinned';
export const MAX_PINNED_AT_BYTES = 64;
export const MAX_PINNED_SOURCE_RUN_ID_BYTES = 256;

/** Rust `DefinitionError::InvalidPinnedOutput` reasons, verbatim. */
export const PINNED_REASONS = {
  callable: 'a callable role runs only when an agent calls it; it cannot be pinned',
  programRouter: 'a program router is evaluated by the coordinator; it cannot be pinned',
  review: 'a reviewing step always runs: a pinned verdict would repeat the same round',
  empty: 'pinned data needs text or a result',
  cutWithoutText: 'only pinned text can be marked as cut',
  textSize: 'pinned text is larger than 256 KiB',
  notObject: 'a pinned result is a JSON object',
  dataSize: 'a pinned result is larger than 256 KiB',
  time: 'pinned data needs the time it was pinned',
  source: 'the source run of pinned data is invalid',
  total: 'pinned data of a pipeline is larger than 1 MiB',
} as const;

/** Graph issues (English source strings of the locale catalog). */
export const PINNED_ISSUES = {
  notPinnable: 'Reviewing steps, callable roles and program routers always run: unpin this step.',
  invalid: 'The pinned data of this step is invalid or larger than 256 KiB: unpin it.',
  total: 'Pinned data of this pipeline is larger than 1 MiB: unpin some steps.',
} as const;

const encoder = new TextEncoder();
const utf8Length = (text: string): number => encoder.encode(text).length;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compact JSON bytes of a pinned result. */
export function jsonBytes(value: unknown): number {
  try {
    return utf8Length(JSON.stringify(value) ?? '');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** `PinnedOutput::size_bytes`: what counts toward the pipeline bound. */
export function pinnedSize(pinned: PinnedOutput): number {
  const text = pinned.text ?? undefined;
  const data = pinned.data ?? undefined;
  return (text === undefined ? 0 : utf8Length(text)) + (data === undefined ? 0 : jsonBytes(data));
}

type PinnableShape = Pick<PipelineStep, 'executionMode' | 'router' | 'review'>;

/** `pinning_refusal`: why a step can never use pinned data. */
export function pinningRefusal(step: PinnableShape): string | undefined {
  if (step.executionMode === 'callable') return PINNED_REASONS.callable;
  if (step.router?.mode === 'program') return PINNED_REASONS.programRouter;
  if (step.review !== undefined) return PINNED_REASONS.review;
  return undefined;
}

/** `validate_pinned_output`: shape and bounds of one pinned output (a `null` option is absent, like serde). */
export function pinnedOutputIssue(step: PinnableShape, pinned: PinnedOutput): string | undefined {
  const refusal = pinningRefusal(step);
  if (refusal !== undefined) return refusal;
  const text = pinned.text ?? undefined;
  const data = pinned.data ?? undefined;
  if (text === undefined && data === undefined) return PINNED_REASONS.empty;
  if (pinned.truncated === true && text === undefined) return PINNED_REASONS.cutWithoutText;
  if (text !== undefined && utf8Length(text) > MAX_PINNED_TEXT_BYTES) return PINNED_REASONS.textSize;
  if (data !== undefined) {
    if (!isObject(data)) return PINNED_REASONS.notObject;
    if (jsonBytes(data) > MAX_PINNED_DATA_BYTES) return PINNED_REASONS.dataSize;
  }
  if (pinned.pinnedAt.trim() === '' || utf8Length(pinned.pinnedAt) > MAX_PINNED_AT_BYTES || !/^[\x21-\x7e]+$/u.test(pinned.pinnedAt)) {
    return PINNED_REASONS.time;
  }
  const source = pinned.sourceRunId ?? undefined;
  if (source !== undefined && (source.trim() === '' || utf8Length(source) > MAX_PINNED_SOURCE_RUN_ID_BYTES)) return PINNED_REASONS.source;
  return undefined;
}

/** `validate_pipeline_pins`: the first invalid pin of a pipeline and the total bound. */
export function pipelinePinsIssue(steps: readonly (PinnableShape & Pick<PipelineStep, 'id' | 'pinnedOutput'>)[]): { stepId: string; reason: string } | undefined {
  let total = 0;
  for (const step of steps) {
    if (step.pinnedOutput === undefined) continue;
    const reason = pinnedOutputIssue(step, step.pinnedOutput);
    if (reason !== undefined) return { stepId: step.id, reason };
    total += pinnedSize(step.pinnedOutput);
    if (total > MAX_PIPELINE_PINNED_BYTES) return { stepId: step.id, reason: PINNED_REASONS.total };
  }
  return undefined;
}

export function hasPinnedSteps(steps: readonly Pick<PipelineStep, 'pinnedOutput'>[]): boolean {
  return steps.some((step) => step.pinnedOutput !== undefined);
}

export type PinnedResult =
  | { readonly ok: true; readonly data?: Record<string, unknown>; readonly output?: TaskOutput }
  | { readonly ok: false; readonly failure: FailureRecord };

function selection(step: Pick<PipelineStep, 'router'>, data: Record<string, unknown>): string[] | undefined {
  const router = step.router;
  if (router === undefined) return undefined;
  const values = data[router.selectionField ?? 'selectedBranchIds'];
  if (!Array.isArray(values)) return undefined;
  const known = new Set(router.branches.map((branch) => branch.id));
  const selected: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !known.has(value) || selected.includes(value)) return undefined;
    selected.push(value);
  }
  return selected;
}

/**
 * `pinned_result`: what a run records for a pinned step, checked against the
 * step's result fields like a native result. A structured result stands as
 * pinned; otherwise complete text that is one JSON object is the result.
 */
export function pinnedResult(step: Pick<PipelineStep, 'resultFields' | 'router'>, pinned: PinnedOutput): PinnedResult {
  const output: TaskOutput | undefined =
    pinned.text === undefined ? undefined : pinned.truncated === true ? { text: pinned.text, truncated: true } : { text: pinned.text };
  const completeText = pinned.truncated === true ? undefined : pinned.text;
  let parsed: unknown;
  let json = false;
  if (pinned.data === undefined && completeText !== undefined) {
    try {
      parsed = JSON.parse(completeText.trim());
      json = true;
    } catch {
      json = false;
    }
  }
  let data: Record<string, unknown> | undefined = pinned.data !== undefined ? { ...pinned.data } : json && isObject(parsed) ? parsed : undefined;
  const fields = step.resultFields ?? [];
  if (data !== undefined) {
    const issue = resultValueIssue(fields, data);
    if (issue !== undefined) return { ok: false, failure: { code: issue } };
  } else if (fields.length > 0) {
    return { ok: false, failure: { code: completeText === undefined || !json ? 'result-invalid-json' : 'result-not-object' } };
  }
  if (step.router?.mode === 'agent') {
    const selected = data === undefined ? undefined : selection(step, data);
    if (selected === undefined || data === undefined) return { ok: false, failure: { code: 'router-selection-invalid' } };
    data = { ...data, [step.router.selectionField ?? 'selectedBranchIds']: selected };
  }
  return { ok: true, ...(data === undefined ? {} : { data }), ...(output === undefined ? {} : { output }) };
}

/** A short, human preview of pinned data for badges and checklists. */
export function pinnedPreview(pinned: Pick<PinnedOutput, 'text' | 'data'>, limit = 160): string {
  const source = pinned.text ?? (pinned.data === undefined ? '' : JSON.stringify(pinned.data));
  const flat = source.replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
