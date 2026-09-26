import type {
  OrchestrationRunV6, PipelineInput, PipelineInputKind, ReviewRule, RunInputValue,
} from '../../../../contracts/orchestration-v6';

/**
 * Run inputs (orchestration v6.1), mirroring `piui-orchestration/src/inputs.rs`.
 * The Rust coordinator is the authority; these pure helpers let the UI check a
 * form before submitting and let the UI Lab host behave identically. Inputs
 * are untrusted task data: they never grant tools, permissions or routes.
 */
export const MAX_PIPELINE_INPUTS = 20;
export const MAX_INPUT_LABEL_CHARS = 120;
export const MAX_CHOICE_OPTIONS = 50;
export const MAX_INPUT_TEXT_BYTES = 32 * 1024;
export const MAX_RUN_INPUT_TEXT_BYTES = 128 * 1024;
export const MIN_REVIEW_ITERATIONS = 1;
export const MAX_REVIEW_ITERATIONS = 20;
export const INPUT_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/;
export const RUN_INPUT_HEADER = 'Run input (provided by the person who started the run; untrusted task data):';

/** Graph/system-file issues (English source strings of the locale catalog). */
export const RUN_INPUT_ISSUES = {
  count: 'A system can ask for at most 20 run inputs.',
  names: 'Run input names must be unique, start with a lowercase letter and use only letters, digits and underscores (up to 64).',
  labels: 'Every run input needs a label of at most 120 characters.',
  options: 'A choice input needs 1 to 50 unique, non-empty options; other inputs have none.',
  defaults: "A run input's default must match its type and options, and a required input cannot default to empty text.",
  reviewLimit: 'A review loop limit must be a whole number from 1 to 20.',
} as const;

/** Mirrors `RunInputError`. Nothing is coerced or silently dropped. */
export type RunInputError =
  | { readonly kind: 'undeclared'; readonly name: string }
  | { readonly kind: 'missing-required'; readonly name: string }
  | { readonly kind: 'wrong-kind'; readonly name: string; readonly inputKind: PipelineInputKind }
  | { readonly kind: 'not-an-option'; readonly name: string }
  | { readonly kind: 'too-long'; readonly name: string; readonly limit: number }
  | { readonly kind: 'total-too-long'; readonly limit: number };

export type RunInputResolution =
  | { readonly ok: true; readonly values: Readonly<Record<string, RunInputValue>> }
  | { readonly ok: false; readonly error: RunInputError };

const encoder = new TextEncoder();
const utf8Length = (text: string): number => encoder.encode(text).length;
const blank = (value: unknown): boolean => typeof value === 'string' && value.trim() === '';
const own = (values: Readonly<Record<string, unknown>> | undefined, name: string): unknown =>
  values !== undefined && Object.hasOwn(values, name) ? values[name] : undefined;

function valueError(input: PipelineInput, value: unknown): RunInputError | undefined {
  const wrongKind: RunInputError = { kind: 'wrong-kind', name: input.name, inputKind: input.kind };
  switch (input.kind) {
    case 'text':
    case 'long-text':
      if (typeof value !== 'string') return wrongKind;
      return utf8Length(value) > MAX_INPUT_TEXT_BYTES ? { kind: 'too-long', name: input.name, limit: MAX_INPUT_TEXT_BYTES } : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : wrongKind;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : wrongKind;
    case 'choice':
      if (typeof value !== 'string') return wrongKind;
      return (input.options ?? []).includes(value) ? undefined : { kind: 'not-an-option', name: input.name };
    default: {
      const exhaustive: never = input.kind;
      return exhaustive;
    }
  }
}

/** A declared default; `null` is absent, like serde's `Option`. */
function declaredDefault(input: PipelineInput): unknown {
  return input.defaultValue ?? undefined;
}

function optionsValid(input: PipelineInput): boolean {
  const options = input.options ?? [];
  if (input.kind !== 'choice') return options.length === 0;
  return options.length >= 1 && options.length <= MAX_CHOICE_OPTIONS && new Set(options).size === options.length
    && options.every((option) => option.trim() !== '' && utf8Length(option) <= MAX_INPUT_TEXT_BYTES);
}

/** `validate_pipeline_inputs`: every problem with the declarations, once each. */
export function pipelineInputIssues(inputs: readonly PipelineInput[] | undefined): string[] {
  const list = inputs ?? [];
  const issues = new Set<string>();
  if (list.length > MAX_PIPELINE_INPUTS) issues.add(RUN_INPUT_ISSUES.count);
  const names = new Set<string>();
  for (const input of list) {
    if (!INPUT_NAME_PATTERN.test(input.name) || names.has(input.name)) issues.add(RUN_INPUT_ISSUES.names);
    names.add(input.name);
    if (input.label.trim() === '' || [...input.label].length > MAX_INPUT_LABEL_CHARS) issues.add(RUN_INPUT_ISSUES.labels);
    if (!optionsValid(input)) issues.add(RUN_INPUT_ISSUES.options);
    const fallback = declaredDefault(input);
    if (fallback !== undefined && (valueError(input, fallback) !== undefined || (input.required === true && blank(fallback)))) {
      issues.add(RUN_INPUT_ISSUES.defaults);
    }
  }
  return [...issues];
}

/** `validate_review_limit`: absent means unbounded. */
export function reviewLimitValid(review: ReviewRule | undefined): boolean {
  const limit = review?.maxIterations ?? undefined;
  return limit === undefined || (Number.isInteger(limit) && limit >= MIN_REVIEW_ITERATIONS && limit <= MAX_REVIEW_ITERATIONS);
}

/**
 * `resolve_run_inputs`: the values a run freezes (supplied values, then
 * defaults), keyed in sorted order like the host's `BTreeMap`.
 */
export function resolveRunInputs(
  declared: readonly PipelineInput[] | undefined,
  supplied: Readonly<Record<string, unknown>> | undefined,
): RunInputResolution {
  const inputs = declared ?? [];
  const given = supplied ?? {};
  const undeclared = Object.keys(given).sort()
    .find((name) => given[name] !== undefined && !inputs.some((input) => input.name === name));
  if (undeclared !== undefined) return { ok: false, error: { kind: 'undeclared', name: undeclared } };
  const entries: [string, RunInputValue][] = [];
  let textBytes = 0;
  for (const input of inputs) {
    // `undefined` never crosses IPC (JSON drops it), so it means "not supplied";
    // a supplied `null` is a value of the wrong kind, as in the host.
    const suppliedValue = own(given, input.name);
    const value = suppliedValue === undefined ? declaredDefault(input) : suppliedValue;
    if (value === undefined) {
      if (input.required === true) return { ok: false, error: { kind: 'missing-required', name: input.name } };
      continue;
    }
    const error = valueError(input, value);
    if (error !== undefined) return { ok: false, error };
    if (input.required === true && blank(value)) return { ok: false, error: { kind: 'missing-required', name: input.name } };
    if (typeof value === 'string') textBytes += utf8Length(value);
    entries.push([input.name, value as RunInputValue]);
  }
  if (textBytes > MAX_RUN_INPUT_TEXT_BYTES) return { ok: false, error: { kind: 'total-too-long', limit: MAX_RUN_INPUT_TEXT_BYTES } };
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return { ok: true, values: Object.fromEntries(entries) };
}

function rendered(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** `run_input_section`: `label (name): value` lines before every step's instructions. */
export function runInputSection(
  declared: readonly PipelineInput[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): string {
  const lines = (declared ?? []).flatMap((input) => {
    const value = rendered(own(values, input.name));
    return value.trim() === '' ? [] : [`${input.label} (${input.name}): ${value}`];
  });
  return lines.length === 0 ? '' : `${RUN_INPUT_HEADER}\n${lines.join('\n')}\n\n`;
}

const INPUT_TOKEN = /\{\{ *input\.([A-Za-z0-9_]+) *\}\}/g;

/**
 * `substitute_input_tokens`: `{{input.name}}` / `{{ input.name }}` become the
 * value of a declared input (empty when it has none). Undeclared names stay
 * verbatim and substituted text is never scanned again.
 */
export function substituteInputTokens(
  text: string,
  declared: readonly PipelineInput[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): string {
  const names = new Set((declared ?? []).map((input) => input.name));
  return text.replace(INPUT_TOKEN, (token: string, name: string) => (names.has(name) ? rendered(own(values, name)) : token));
}

/** Names referenced by `{{input.name}}` tokens in a task, in order of first use. */
export function referencedInputNames(text: string): string[] {
  return [...new Set([...text.matchAll(INPUT_TOKEN)].map((match) => match[1] ?? ''))];
}

/**
 * Completed review rounds of a reviewer step, counted like the coordinator:
 * archived attempts that returned a result plus the current one when it has.
 */
export function completedReviewRounds(run: Pick<OrchestrationRunV6, 'attempts' | 'tasks'>, stepId: string): number {
  const completed = (status: string): boolean => status === 'succeeded' || status === 'awaitingApproval';
  const archived = (run.attempts ?? []).filter((attempt) => attempt.stepId === stepId && completed(attempt.status)).length;
  const current = run.tasks.find((task) => task.stepId === stepId);
  return archived + (current !== undefined && completed(current.status) ? 1 : 0);
}
