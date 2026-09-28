import type {
  FailureRecord, OrchestrationRunV6, PipelineDefinition, PipelineInput, PipelineInputKind, PipelineOutput, PipelineStep,
  ResultField, RunInputValue, StepExecutor, SubpipelineInputSource,
} from '../../../../contracts/orchestration-v6';
import { MAX_SUBPIPELINE_DEPTH } from '../../../../contracts/orchestration-v6';
import { INPUT_NAME_PATTERN, resolveRunInputs } from './runInputs';
import { PIPELINE_MEMBER_REASON, resultValueIssue } from './stepExecutors';

/**
 * Sub-pipelines (orchestration v6.7, ADR-042): a step that starts an ordinary
 * child run of a saved launch command of the same project. These pure rules
 * mirror the coordinator so the editor can explain a problem before saving
 * and the UI Lab host behaves like the real one. The host is the authority:
 * it checks references, cycles and depth again at save and at admission.
 */
export { MAX_SUBPIPELINE_DEPTH };

/** At most this many child inputs are mapped by one step. */
export const MAX_SUBPIPELINE_INPUTS = 64;
/** At most this many declared outputs per pipeline. */
export const MAX_PIPELINE_OUTPUTS = 32;

export type PipelineExecutor = Extract<StepExecutor, { type: 'pipeline' }>;

/** Failure codes recorded on the parent task. */
export const SUBPIPELINE_FAILURE_CODES = {
  unavailable: 'subpipeline-unavailable',
  cycle: 'subpipeline-cycle',
  depth: 'subpipeline-depth',
  inputInvalid: 'subpipeline-input-invalid',
  inputUnavailable: 'subpipeline-input-unavailable',
  failed: 'subpipeline-failed',
  cancelled: 'subpipeline-cancelled',
  outputUnavailable: 'subpipeline-output-unavailable',
} as const;

/** Self-contained reasons a stored sub-pipeline step is refused (`validate_step_executor`). */
export const SUBPIPELINE_REASONS = {
  command: 'a sub-pipeline step names a saved launch command',
  inputs: 'a sub-pipeline step maps at most 64 child inputs with valid names',
  source: 'a sub-pipeline input reads a run input or a direct dependency',
  bindings: 'a sub-pipeline step reads its inputs from its own mapping; input bindings apply to agent and llm steps',
  member: PIPELINE_MEMBER_REASON,
  outputs: 'pipeline outputs need unique names, at most 32, and a declared field or the whole text of a scheduled step',
} as const;

/** Editor and system-file issues (English source strings of the locale catalog). */
export const SUBPIPELINE_ISSUES = {
  command: 'Choose which saved pipeline this sub-pipeline step runs.',
  missing: 'The pipeline this sub-pipeline step runs no longer exists.',
  self: 'A pipeline cannot run itself as a sub-pipeline.',
  cycle: 'These sub-pipelines run each other in a loop.',
  required: 'Map every required input of the sub-pipeline that has no default.',
  unknownInput: 'A mapped input is not declared by the sub-pipeline.',
  valueKind: 'A fixed value does not match the type of its sub-pipeline input.',
  parentInput: 'A sub-pipeline input uses a run input this pipeline does not declare.',
  stepSource: 'A sub-pipeline input can only use the result of a step connected directly before it.',
  stepField: 'A sub-pipeline input uses a result field the source step does not declare.',
  kindMismatch: 'A sub-pipeline input gets a value of a different type.',
  bindings: 'A sub-pipeline step maps its inputs itself; remove its input mappings.',
  outputs: 'Outputs need unique names (a lowercase letter, then letters, digits or underscores), at most 32, and a step with a declared field or its whole text.',
} as const;

/** What the editor knows about a saved pipeline it can run as a child. */
export interface SubpipelineInfo {
  readonly commandId: string;
  readonly name: string;
  readonly pipelineId: string;
  readonly inputs: readonly PipelineInput[];
  readonly outputs: readonly PipelineOutput[];
  /** Launch commands its own sub-pipeline steps run (for cycle checks). */
  readonly references: readonly string[];
}

export function isPipelineStep(step: Pick<PipelineStep, 'executor'>): boolean {
  return step.executor?.type === 'pipeline';
}

/** Launch commands the steps of `pipeline` run as sub-pipelines, once each. */
export function referencedCommands(pipeline: Pick<PipelineDefinition, 'steps'>): string[] {
  return [...new Set(pipeline.steps.flatMap((step) => (step.executor?.type === 'pipeline' ? [step.executor.launchCommandId] : [])))];
}

/**
 * True when following sub-pipeline references from `from` reaches `target`
 * (`from === target` counts). `references` is undefined for an unknown command.
 */
export function reaches(from: string, target: string, references: (commandId: string) => readonly string[] | undefined): boolean {
  const seen = new Set<string>();
  const pending = [from];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(references(id) ?? []));
  }
  return false;
}

/** The source kind a mapping offers, compared with the child input it fills. */
export type SourceKind = PipelineInputKind | ResultField['kind'];

/** Whether a value of `source` kind can fill a child input of `target` kind (checked again at runtime). */
export function kindsCompatible(target: PipelineInputKind, source: SourceKind): boolean {
  switch (target) {
    case 'text':
    case 'long-text':
      return source === 'text' || source === 'long-text' || source === 'choice' || source === 'artifact';
    case 'choice':
      return source === 'text' || source === 'long-text' || source === 'choice';
    case 'number':
      return source === 'number';
    case 'boolean':
      return source === 'boolean';
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/** `validate_step_executor` for a sub-pipeline step: its self-contained shape. */
export function subpipelineStepIssue(step: PipelineStep): string | undefined {
  if (step.executor?.type !== 'pipeline') return undefined;
  const executor = step.executor;
  if (executor.launchCommandId.trim() === '') return SUBPIPELINE_REASONS.command;
  const names = Object.keys(executor.inputs);
  if (names.length > MAX_SUBPIPELINE_INPUTS || !names.every((name) => INPUT_NAME_PATTERN.test(name))) return SUBPIPELINE_REASONS.inputs;
  for (const source of Object.values(executor.inputs)) {
    if (source.kind === 'input' && !INPUT_NAME_PATTERN.test(source.name)) return SUBPIPELINE_REASONS.source;
    if (source.kind === 'step' && !step.dependencyStepIds.includes(source.stepId)) return SUBPIPELINE_REASONS.source;
  }
  if ((step.inputBindings ?? []).length > 0) return SUBPIPELINE_REASONS.bindings;
  return undefined;
}

/** `validate_pipeline_outputs`: every output problem of one pipeline, once each. */
export function pipelineOutputIssues(pipeline: Pick<PipelineDefinition, 'steps' | 'outputs'>): string[] {
  const outputs = pipeline.outputs ?? [];
  if (outputs.length === 0) return [];
  const names = new Set<string>();
  let invalid = outputs.length > MAX_PIPELINE_OUTPUTS;
  for (const output of outputs) {
    if (!INPUT_NAME_PATTERN.test(output.name) || names.has(output.name)) invalid = true;
    names.add(output.name);
    const step = pipeline.steps.find((candidate) => candidate.id === output.sourceStepId);
    if (step === undefined || step.executionMode === 'callable') {
      invalid = true;
      continue;
    }
    const field = output.field ?? undefined;
    if (field === undefined) {
      if (output.kind !== 'text') invalid = true;
    } else if (!(step.resultFields ?? []).some((candidate) => candidate.name === field && candidate.kind === output.kind)) {
      invalid = true;
    }
  }
  return invalid ? [SUBPIPELINE_REASONS.outputs] : [];
}

/** One sub-pipeline problem in the editor, with the child input it concerns (if any). */
export interface SubpipelineProblem {
  readonly message: string;
  readonly input?: string;
}

/** The kind a mapping offers, or undefined when its source is unknown. */
export function sourceKind(
  source: SubpipelineInputSource,
  parentInputs: readonly PipelineInput[],
  fieldsOf: (stepId: string) => readonly ResultField[],
): SourceKind | undefined {
  switch (source.kind) {
    case 'value':
      return undefined;
    case 'input':
      return parentInputs.find((input) => input.name === source.name)?.kind;
    case 'step': {
      const field = source.field ?? undefined;
      if (field === undefined) return 'text';
      return fieldsOf(source.stepId).find((candidate) => candidate.name === field)?.kind;
    }
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/**
 * What the editor can check of one sub-pipeline step against the child it
 * names: required inputs are mapped, literals match their kinds, sources
 * exist and are direct dependencies, kinds are compatible. `child` is
 * undefined when it could not be read (nothing is reported then except what
 * the step shows by itself).
 */
export function mappingProblems(
  executor: PipelineExecutor,
  child: Pick<SubpipelineInfo, 'inputs'> | undefined,
  parentInputs: readonly PipelineInput[],
  dependencies: readonly string[],
  fieldsOf: (stepId: string) => readonly ResultField[],
): SubpipelineProblem[] {
  const problems: SubpipelineProblem[] = [];
  for (const [name, source] of Object.entries(executor.inputs)) {
    const input = child?.inputs.find((candidate) => candidate.name === name);
    if (child !== undefined && input === undefined) {
      problems.push({ message: SUBPIPELINE_ISSUES.unknownInput, input: name });
      continue;
    }
    if (source.kind === 'value') {
      if (input !== undefined && !resolveRunInputs([input], { [name]: source.value }).ok) problems.push({ message: SUBPIPELINE_ISSUES.valueKind, input: name });
      continue;
    }
    if (source.kind === 'input' && !parentInputs.some((candidate) => candidate.name === source.name)) {
      problems.push({ message: SUBPIPELINE_ISSUES.parentInput, input: name });
      continue;
    }
    if (source.kind === 'step') {
      if (!dependencies.includes(source.stepId)) {
        problems.push({ message: SUBPIPELINE_ISSUES.stepSource, input: name });
        continue;
      }
      const field = source.field ?? undefined;
      if (field !== undefined && !fieldsOf(source.stepId).some((candidate) => candidate.name === field)) {
        problems.push({ message: SUBPIPELINE_ISSUES.stepField, input: name });
        continue;
      }
    }
    const kind = sourceKind(source, parentInputs, fieldsOf);
    if (input !== undefined && kind !== undefined && !kindsCompatible(input.kind, kind)) problems.push({ message: SUBPIPELINE_ISSUES.kindMismatch, input: name });
  }
  for (const input of child?.inputs ?? []) {
    const hasDefault = input.defaultValue !== undefined && input.defaultValue !== null;
    if (input.required === true && !hasDefault && !Object.hasOwn(executor.inputs, input.name)) {
      problems.push({ message: SUBPIPELINE_ISSUES.required, input: input.name });
    }
  }
  return problems;
}

/** Result fields a sub-pipeline step declares from its child's outputs. */
export function outputFields(outputs: readonly PipelineOutput[]): ResultField[] {
  return outputs.map((output) => ({ name: output.name, kind: output.kind }));
}

export type InputResolution =
  | { readonly ok: true; readonly values: Readonly<Record<string, RunInputValue>> }
  | { readonly ok: false; readonly code: typeof SUBPIPELINE_FAILURE_CODES.inputInvalid | typeof SUBPIPELINE_FAILURE_CODES.inputUnavailable };

/** A recorded step result as text: its output, its native final answer or its data as JSON. */
function taskText(run: Pick<OrchestrationRunV6, 'tasks'>, stepId: string, nativeText: (stepId: string) => string | null): string | undefined {
  const task = run.tasks.find((candidate) => candidate.stepId === stepId);
  if (task?.status !== 'succeeded') return undefined;
  if (task.output !== undefined) return task.output.text;
  if (task.resultReference !== undefined) return nativeText(stepId) ?? undefined;
  return task.resultData === undefined ? undefined : JSON.stringify(task.resultData);
}

/**
 * `resolve_subpipeline_inputs`: the child run's values from the parent run.
 * A step result that cannot be read is `subpipeline-input-unavailable`; a
 * value the child refuses is `subpipeline-input-invalid` (nothing started).
 */
export function resolveSubpipelineInputs(
  executor: PipelineExecutor,
  childInputs: readonly PipelineInput[] | undefined,
  parent: Pick<OrchestrationRunV6, 'inputs' | 'tasks'>,
  nativeText: (stepId: string) => string | null,
): InputResolution {
  const supplied: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(executor.inputs)) {
    switch (source.kind) {
      case 'value':
        supplied[name] = source.value;
        break;
      case 'input': {
        const values = parent.inputs ?? {};
        // An optional parent input left empty leaves the child's default.
        if (Object.hasOwn(values, source.name)) supplied[name] = values[source.name];
        break;
      }
      case 'step': {
        const field = source.field ?? undefined;
        if (field === undefined) {
          const text = taskText(parent, source.stepId, nativeText);
          if (text === undefined) return { ok: false, code: SUBPIPELINE_FAILURE_CODES.inputUnavailable };
          supplied[name] = text;
        } else {
          const task = parent.tasks.find((candidate) => candidate.stepId === source.stepId);
          if (task?.status !== 'succeeded' || task.resultData === undefined || !Object.hasOwn(task.resultData, field)) {
            return { ok: false, code: SUBPIPELINE_FAILURE_CODES.inputUnavailable };
          }
          supplied[name] = task.resultData[field];
        }
        break;
      }
      default: {
        const exhaustive: never = source;
        return exhaustive;
      }
    }
  }
  const resolved = resolveRunInputs(childInputs, supplied);
  return resolved.ok ? { ok: true, values: resolved.values } : { ok: false, code: SUBPIPELINE_FAILURE_CODES.inputInvalid };
}

export type SubpipelineResult =
  | { readonly status: 'succeeded'; readonly data?: Record<string, unknown>; readonly text?: string }
  | { readonly status: 'failed'; readonly failure: FailureRecord };

/**
 * `complete_subpipeline_task`: what the parent step records when its child
 * run ends. Declared outputs become result data checked against the step's
 * result fields; without outputs the child's last succeeded step's text.
 */
export function subpipelineResult(
  child: Pick<OrchestrationRunV6, 'status' | 'tasks' | 'definition'>,
  fields: readonly ResultField[],
  nativeText: (stepId: string) => string | null,
): SubpipelineResult {
  if (child.status === 'cancelled') return { status: 'failed', failure: { code: SUBPIPELINE_FAILURE_CODES.cancelled } };
  if (child.status !== 'succeeded') return { status: 'failed', failure: { code: SUBPIPELINE_FAILURE_CODES.failed } };
  const outputs = child.definition.pipeline.outputs ?? [];
  if (outputs.length > 0) {
    const data: Record<string, unknown> = {};
    for (const output of outputs) {
      const field = output.field ?? undefined;
      if (field === undefined) {
        const text = taskText(child, output.sourceStepId, nativeText);
        if (text === undefined) return { status: 'failed', failure: { code: SUBPIPELINE_FAILURE_CODES.outputUnavailable } };
        data[output.name] = text;
      } else {
        const task = child.tasks.find((candidate) => candidate.stepId === output.sourceStepId);
        if (task?.status !== 'succeeded' || task.resultData === undefined || !Object.hasOwn(task.resultData, field)) {
          return { status: 'failed', failure: { code: SUBPIPELINE_FAILURE_CODES.outputUnavailable } };
        }
        data[output.name] = task.resultData[field];
      }
    }
    const issue = resultValueIssue(fields, data);
    return issue === undefined ? { status: 'succeeded', data } : { status: 'failed', failure: { code: issue } };
  }
  const last = [...child.definition.pipeline.steps].reverse().find((step) => child.tasks.some((task) => task.stepId === step.id && task.status === 'succeeded'));
  const text = last === undefined ? undefined : taskText(child, last.id, nativeText);
  if (text === undefined) return { status: 'failed', failure: { code: SUBPIPELINE_FAILURE_CODES.outputUnavailable } };
  if (fields.length === 0) return { status: 'succeeded', text };
  // Declared fields without child outputs: the text must be their JSON object.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { status: 'failed', failure: { code: 'result-invalid-json' } };
  }
  const issue = resultValueIssue(fields, parsed);
  return issue === undefined ? { status: 'succeeded', data: parsed as Record<string, unknown> } : { status: 'failed', failure: { code: issue } };
}
