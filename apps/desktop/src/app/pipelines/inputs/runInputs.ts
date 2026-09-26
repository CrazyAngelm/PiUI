/**
 * Form helpers for run inputs. Validation delegates to the shared rules in
 * `host-api/runInputs.ts`, which mirror the Rust coordinator; the host checks
 * again and stays authoritative. This file only adds per-field presentation.
 */
import type { PipelineInput, PipelineInputKind, RunInputValue } from '../../../host-api/orchestrationClient';
import {
  MAX_PIPELINE_INPUTS,
  pipelineInputIssues,
  resolveRunInputs,
  type RunInputError,
} from '../../../host-api/runInputs';

export const INPUT_KINDS: readonly PipelineInputKind[] = ['long-text', 'text', 'number', 'boolean', 'choice'];

export const INPUT_KIND_LABEL: Record<PipelineInputKind, string> = {
  'long-text': 'Long text',
  text: 'Short text',
  number: 'Number',
  boolean: 'Yes / no',
  choice: 'Choice',
};

/** "What should be reviewed?" -> "whatShouldBeReviewed", unique among `taken`. */
export function inputNameFrom(label: string, taken: ReadonlySet<string>): string {
  const words = label
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(/[^A-Za-z0-9]/gu, ''))
    .filter(Boolean);
  let base = words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase())).join('');
  if (!/^[a-z]/u.test(base)) base = `input${base ? base[0]!.toUpperCase() + base.slice(1) : ''}`;
  base = base.slice(0, 56);
  let name = base;
  for (let index = 2; taken.has(name); index += 1) name = `${base}${index}`;
  return name;
}

export interface DeclarationProblem {
  index: number;
  message: string;
}

/** The coordinator's declaration rules, attributed to the input they concern. */
export function declarationProblems(inputs: readonly PipelineInput[]): DeclarationProblem[] {
  const problems: DeclarationProblem[] = [];
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    for (const message of pipelineInputIssues([input])) problems.push({ index, message });
    if (seen.has(input.name)) problems.push({ index, message: 'Two inputs use the same name.' });
    seen.add(input.name);
  });
  if (inputs.length > MAX_PIPELINE_INPUTS) problems.push({ index: MAX_PIPELINE_INPUTS, message: 'A pipeline can ask for at most 20 inputs.' });
  return problems;
}

export function initialValues(inputs: readonly PipelineInput[]): Record<string, RunInputValue | undefined> {
  return Object.fromEntries(
    inputs.map((input) => [input.name, input.defaultValue ?? (input.kind === 'boolean' ? false : undefined)]),
  );
}

export function inputErrorMessage(error: RunInputError): string {
  switch (error.kind) {
    case 'undeclared':
      return 'This pipeline does not ask for this value.';
    case 'missing-required':
      return 'This input is required.';
    case 'wrong-kind':
      return error.inputKind === 'number'
        ? 'Enter a number.'
        : error.inputKind === 'boolean'
          ? 'Choose yes or no.'
          : error.inputKind === 'choice'
            ? 'Choose one of the options.'
            : 'Enter text.';
    case 'not-an-option':
      return 'Choose one of the options.';
    case 'too-long':
      return 'This text is too long (32 KB at most).';
    case 'total-too-long':
      return 'All inputs together are too long (128 KB at most).';
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

export interface ValuesCheck {
  values: Record<string, RunInputValue>;
  errors: Record<string, string>;
}

/**
 * Per-field errors for a start form. Blank optional text is left out; the
 * resulting values are exactly what the shared rules accept.
 */
export function checkValues(inputs: readonly PipelineInput[], raw: Readonly<Record<string, RunInputValue | undefined>>): ValuesCheck {
  const supplied: Record<string, RunInputValue> = {};
  for (const input of inputs) {
    const value = raw[input.name];
    if (value === undefined || (typeof value === 'string' && input.kind !== 'choice' && value.trim() === '')) continue;
    supplied[input.name] = value;
  }
  const errors: Record<string, string> = {};
  for (const input of inputs) {
    const single = resolveRunInputs([input], Object.hasOwn(supplied, input.name) ? { [input.name]: supplied[input.name] } : {});
    if (!single.ok) errors[input.name] = inputErrorMessage(single.error);
  }
  const whole = resolveRunInputs(inputs, supplied);
  if (!whole.ok && whole.error.kind === 'total-too-long') {
    const last = [...inputs].reverse().find((input) => typeof supplied[input.name] === 'string');
    if (last) errors[last.name] = inputErrorMessage(whole.error);
  }
  return { values: whole.ok ? { ...whole.values } : supplied, errors };
}

/** The default first input for new pipelines: the task itself. */
export function taskInput(label = 'What should the pipeline do?'): PipelineInput {
  return { name: 'task', label, kind: 'long-text', required: true };
}
