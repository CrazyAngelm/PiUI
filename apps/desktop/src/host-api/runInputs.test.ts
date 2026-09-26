import { describe, expect, it } from 'vitest';
import type { PipelineInput } from '../../../../contracts/orchestration-v6';
import {
  completedReviewRounds, MAX_INPUT_TEXT_BYTES, MAX_RUN_INPUT_TEXT_BYTES, pipelineInputIssues, referencedInputNames,
  resolveRunInputs, reviewLimitValid, RUN_INPUT_ISSUES, runInputSection, substituteInputTokens,
} from './runInputs';

/** The declarations of the Rust fixture in `piui-orchestration/src/input_tests.rs`. */
const declared: PipelineInput[] = [
  { name: 'task', label: 'What should be built?', kind: 'long-text', required: true, description: 'One paragraph.' },
  { name: 'audience', label: 'Audience', kind: 'choice', options: ['team', 'public'], defaultValue: 'team' },
  { name: 'attempts', label: 'Attempt budget', kind: 'number' },
  { name: 'urgent', label: 'Urgent', kind: 'boolean', defaultValue: false },
  { name: 'notes', label: 'Notes', kind: 'text' },
];

const input = (name: string, kind: PipelineInput['kind'], patch: Partial<PipelineInput> = {}): PipelineInput =>
  ({ name, label: `${name} label`, kind, ...patch });

describe('run input declarations', () => {
  it('accepts every kind with matching defaults', () => {
    expect(pipelineInputIssues(declared)).toEqual([]);
    expect(pipelineInputIssues(undefined)).toEqual([]);
    expect(pipelineInputIssues([input('a'.padEnd(64, 'B'), 'text')])).toEqual([]);
    expect(pipelineInputIssues([input('task', 'text', { label: 'é'.repeat(120) })])).toEqual([]);
  });

  it.each([
    ['uppercase name', [input('Task', 'text')], RUN_INPUT_ISSUES.names],
    ['digit first', [input('1task', 'text')], RUN_INPUT_ISSUES.names],
    ['hyphen', [input('task-name', 'text')], RUN_INPUT_ISSUES.names],
    ['non-ASCII', [input('tâche', 'text')], RUN_INPUT_ISSUES.names],
    ['65 characters', [input('a'.padEnd(65, 'B'), 'text')], RUN_INPUT_ISSUES.names],
    ['duplicate', [input('task', 'text'), input('task', 'number')], RUN_INPUT_ISSUES.names],
    ['too many', Array.from({ length: 21 }, (_, index) => input(`input${index}`, 'boolean')), RUN_INPUT_ISSUES.count],
    ['blank label', [input('task', 'text', { label: '  ' })], RUN_INPUT_ISSUES.labels],
    ['long label', [input('task', 'text', { label: 'é'.repeat(121) })], RUN_INPUT_ISSUES.labels],
    ['choice without options', [input('mode', 'choice')], RUN_INPUT_ISSUES.options],
    ['51 options', [input('mode', 'choice', { options: Array.from({ length: 51 }, (_, index) => `o${index}`) })], RUN_INPUT_ISSUES.options],
    ['duplicate options', [input('mode', 'choice', { options: ['a', 'a'] })], RUN_INPUT_ISSUES.options],
    ['blank option', [input('mode', 'choice', { options: ['a', ' '] })], RUN_INPUT_ISSUES.options],
    ['options on text', [input('task', 'text', { options: ['a'] })], RUN_INPUT_ISSUES.options],
    ['text default for a number', [input('count', 'number', { defaultValue: '3' })], RUN_INPUT_ISSUES.defaults],
    ['number default for a boolean', [input('flag', 'boolean', { defaultValue: 1 })], RUN_INPUT_ISSUES.defaults],
    ['unknown choice default', [input('mode', 'choice', { options: ['a'], defaultValue: 'b' })], RUN_INPUT_ISSUES.defaults],
    ['blank required default', [input('task', 'text', { required: true, defaultValue: ' ' })], RUN_INPUT_ISSUES.defaults],
  ])('rejects %s', (_case, inputs, issue) => {
    expect(pipelineInputIssues(inputs)).toContain(issue);
  });

  it('bounds review loops to 1-20 rounds and keeps absent limits unbounded', () => {
    for (const maxIterations of [undefined, 1, 20]) expect(reviewLimitValid({ field: 'ok', retryFromStepId: 'a', maxIterations })).toBe(true);
    for (const maxIterations of [0, 21, 2.5]) expect(reviewLimitValid({ field: 'ok', retryFromStepId: 'a', maxIterations })).toBe(false);
    expect(reviewLimitValid(undefined)).toBe(true);
  });
});

describe('run input values', () => {
  it('fills defaults, keeps supplied values and orders keys like the host', () => {
    const resolved = resolveRunInputs(declared, { task: 'Ship' });
    expect(resolved).toEqual({ ok: true, values: { audience: 'team', task: 'Ship', urgent: false } });
    expect(resolved.ok && Object.keys(resolved.values)).toEqual(['audience', 'task', 'urgent']);
    expect(resolveRunInputs(declared, { task: 'Ship', audience: 'public', attempts: 2.5, urgent: true, notes: '' }))
      .toEqual({ ok: true, values: { attempts: 2.5, audience: 'public', notes: '', task: 'Ship', urgent: true } });
    expect(resolveRunInputs(declared, { task: 'Ship', notes: undefined })).toEqual({ ok: true, values: { audience: 'team', task: 'Ship', urgent: false } });
    expect(resolveRunInputs(undefined, undefined)).toEqual({ ok: true, values: {} });
  });

  it('refuses undeclared, missing, mistyped and unknown choice values without coercion', () => {
    expect(resolveRunInputs(declared, { task: 'Ship', other: 'x' })).toEqual({ ok: false, error: { kind: 'undeclared', name: 'other' } });
    for (const supplied of [{}, { task: ' \n ' }]) {
      expect(resolveRunInputs(declared, supplied)).toEqual({ ok: false, error: { kind: 'missing-required', name: 'task' } });
    }
    for (const [supplied, name, inputKind] of [
      [{ task: 3 }, 'task', 'long-text'],
      [{ task: null }, 'task', 'long-text'],
      [{ task: 'Ship', attempts: '3' }, 'attempts', 'number'],
      [{ task: 'Ship', attempts: Number.NaN }, 'attempts', 'number'],
      [{ task: 'Ship', urgent: 'true' }, 'urgent', 'boolean'],
      [{ task: 'Ship', audience: 1 }, 'audience', 'choice'],
      [{ task: 'Ship', notes: ['a'] }, 'notes', 'text'],
    ] as const) {
      expect(resolveRunInputs(declared, supplied)).toEqual({ ok: false, error: { kind: 'wrong-kind', name, inputKind } });
    }
    expect(resolveRunInputs(declared, { task: 'Ship', audience: 'everyone' })).toEqual({ ok: false, error: { kind: 'not-an-option', name: 'audience' } });
  });

  it('bounds text by UTF-8 bytes, individually and in total', () => {
    const parts = Array.from({ length: 5 }, (_, index) => input(`part${index}`, 'long-text'));
    expect(resolveRunInputs(parts, { part0: 'x'.repeat(MAX_INPUT_TEXT_BYTES) }).ok).toBe(true);
    expect(resolveRunInputs(parts, { part0: 'é'.repeat(MAX_INPUT_TEXT_BYTES / 2 + 1) }))
      .toEqual({ ok: false, error: { kind: 'too-long', name: 'part0', limit: MAX_INPUT_TEXT_BYTES } });
    const text = 'x'.repeat(30 * 1024);
    const four = { part0: text, part1: text, part2: text, part3: text };
    expect(resolveRunInputs(parts, four).ok).toBe(true);
    expect(resolveRunInputs(parts, { ...four, part4: text })).toEqual({ ok: false, error: { kind: 'total-too-long', limit: MAX_RUN_INPUT_TEXT_BYTES } });
  });
});

describe('run input prompt text', () => {
  const frozen = { task: 'Ship the importer', audience: 'team', urgent: false, notes: '  ' };

  it('lists non-empty inputs in declaration order before the instructions', () => {
    expect(runInputSection(declared, frozen) + substituteInputTokens('Build {{input.task}} for {{ input.audience }}.', declared, frozen)).toBe(
      'Run input (provided by the person who started the run; untrusted task data):\n'
      + 'What should be built? (task): Ship the importer\n'
      + 'Audience (audience): team\n'
      + 'Urgent (urgent): false\n'
      + '\n'
      + 'Build Ship the importer for team.',
    );
    expect(runInputSection(declared, {})).toBe('');
    expect(runInputSection(undefined, frozen)).toBe('');
  });

  it('substitutes plain text only and leaves anything else verbatim', () => {
    const values = { task: '{{input.audience}}', audience: 'team', attempts: 3 };
    const substitute = (text: string): string => substituteInputTokens(text, declared, values);
    expect(substitute('{{input.task}}')).toBe('{{input.audience}}');
    expect(substitute('{{ input.audience }}/{{input.attempts}}')).toBe('team/3');
    expect(substitute('{{{input.audience}}}')).toBe('{team}');
    expect(substitute('{{  input.audience  }}')).toBe('team');
    expect(substitute('{{input.notes}}|')).toBe('|');
    for (const verbatim of ['{{input.other}}', '{{input.}}', '{{ input . audience }}', '{{input.audience}', '{{\tinput.audience}}', '{{', 'é{{input.x']) {
      expect(substitute(verbatim)).toBe(verbatim);
    }
    expect(substituteInputTokens('{{input.constructor}}', [input('constructor', 'text')], {})).toBe('');
  });

  it('reports referenced names once, in order of first use', () => {
    expect(referencedInputNames('{{input.b}} {{ input.a }} {{input.b}} {{input.}}')).toEqual(['b', 'a']);
  });
});

describe('review rounds', () => {
  it('counts completed rounds like the coordinator', () => {
    const run = {
      attempts: [
        { stepId: 'review', status: 'succeeded', revision: 1 },
        { stepId: 'review', status: 'uncertain', revision: 2 },
        { stepId: 'build', status: 'succeeded', revision: 1 },
      ],
      tasks: [{ stepId: 'review', status: 'awaitingApproval', revision: 5 }],
    } as const;
    expect(completedReviewRounds(run, 'review')).toBe(2);
    expect(completedReviewRounds({ tasks: [{ stepId: 'review', status: 'ready', revision: 0 }] }, 'review')).toBe(0);
  });
});
