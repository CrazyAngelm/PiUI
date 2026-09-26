/**
 * Client-side mirror of the coordinator's run-input rules, used to give
 * immediate feedback in forms. The host validates again and is authoritative.
 */
import type { PipelineInput, PipelineInputKind, RunInputValue } from '../../../host-api/orchestrationClient';

export const INPUT_NAME = /^[a-z][A-Za-z0-9_]{0,63}$/u;
export const MAX_INPUTS = 20;
export const MAX_LABEL = 120;
export const MAX_OPTIONS = 50;
export const MAX_TEXT_BYTES = 32 * 1024;
export const MAX_TOTAL_BYTES = 128 * 1024;

export const INPUT_KINDS: readonly PipelineInputKind[] = ['long-text', 'text', 'number', 'boolean', 'choice'];

export const INPUT_KIND_LABEL: Record<PipelineInputKind, string> = {
  'long-text': 'Long text',
  text: 'Short text',
  number: 'Number',
  boolean: 'Yes / no',
  choice: 'Choice',
};

const bytes = (value: string) => new TextEncoder().encode(value).length;

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

/** Problems in the pipeline's input declarations (editor side). */
export function declarationProblems(inputs: readonly PipelineInput[]): DeclarationProblem[] {
  const problems: DeclarationProblem[] = [];
  if (inputs.length > MAX_INPUTS) problems.push({ index: MAX_INPUTS, message: 'A pipeline can ask for at most 20 inputs.' });
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    if (!input.label.trim()) problems.push({ index, message: 'Give the input a label.' });
    else if (input.label.length > MAX_LABEL) problems.push({ index, message: 'Keep the label under 120 characters.' });
    if (!INPUT_NAME.test(input.name)) problems.push({ index, message: 'The name must start with a lowercase letter and use only letters, digits and _.' });
    else if (seen.has(input.name)) problems.push({ index, message: 'Two inputs use the same name.' });
    seen.add(input.name);
    if (input.kind === 'choice') {
      const options = input.options ?? [];
      if (options.length === 0 || options.length > MAX_OPTIONS) problems.push({ index, message: 'A choice needs between 1 and 50 options.' });
      else if (options.some((option) => !option.trim()) || new Set(options).size !== options.length) {
        problems.push({ index, message: 'Choice options must be unique and not empty.' });
      }
    }
    if (input.defaultValue !== undefined && valueProblem(input, input.defaultValue)) {
      problems.push({ index, message: 'The default value does not fit the input type.' });
    }
  });
  return problems;
}

function valueProblem(input: PipelineInput, value: RunInputValue): string {
  switch (input.kind) {
    case 'text':
    case 'long-text':
      if (typeof value !== 'string') return 'Enter text.';
      if (bytes(value) > MAX_TEXT_BYTES) return 'This text is too long (32 KB at most).';
      return '';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? '' : 'Enter a number.';
    case 'boolean':
      return typeof value === 'boolean' ? '' : 'Choose yes or no.';
    case 'choice':
      return typeof value === 'string' && (input.options ?? []).includes(value) ? '' : 'Choose one of the options.';
    default: {
      const exhaustive: never = input.kind;
      return exhaustive;
    }
  }
}

export function initialValues(inputs: readonly PipelineInput[]): Record<string, RunInputValue | undefined> {
  return Object.fromEntries(
    inputs.map((input) => [input.name, input.defaultValue ?? (input.kind === 'boolean' ? false : undefined)]),
  );
}

export interface ValuesCheck {
  values: Record<string, RunInputValue>;
  errors: Record<string, string>;
}

/** Drops empty optional values, applies defaults and reports per-field errors. */
export function checkValues(inputs: readonly PipelineInput[], raw: Readonly<Record<string, RunInputValue | undefined>>): ValuesCheck {
  const values: Record<string, RunInputValue> = {};
  const errors: Record<string, string> = {};
  let total = 0;
  for (const input of inputs) {
    let value = raw[input.name];
    if (typeof value === 'string' && input.kind !== 'choice' && value.trim() === '') value = undefined;
    value ??= input.defaultValue;
    if (value === undefined) {
      if (input.required) errors[input.name] = 'This input is required.';
      continue;
    }
    const problem = valueProblem(input, value);
    if (problem) {
      errors[input.name] = problem;
      continue;
    }
    if (typeof value === 'string') total += bytes(value);
    values[input.name] = value;
  }
  if (total > MAX_TOTAL_BYTES) {
    const last = [...inputs].reverse().find((input) => typeof values[input.name] === 'string');
    if (last) errors[last.name] = 'All inputs together are too long (128 KB at most).';
  }
  return { values, errors };
}

/** The default first input for new pipelines: the task itself. */
export function taskInput(label = 'What should the pipeline do?'): PipelineInput {
  return { name: 'task', label, kind: 'long-text', required: true };
}
