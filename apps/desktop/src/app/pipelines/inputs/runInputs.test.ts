import { describe, expect, it } from 'vitest';
import type { PipelineInput } from '../../../host-api/orchestrationClient';
import { checkValues, declarationProblems, initialValues, inputNameFrom, taskInput } from './runInputs';

const inputs: PipelineInput[] = [
  taskInput(),
  { name: 'depth', label: 'Depth', kind: 'number', defaultValue: 2 },
  { name: 'strict', label: 'Strict', kind: 'boolean' },
  { name: 'tone', label: 'Tone', kind: 'choice', options: ['short', 'detailed'], required: true },
];

describe('run inputs', () => {
  it('derives unique identifier names from labels', () => {
    expect(inputNameFrom('What should be reviewed?', new Set())).toBe('whatShouldBeReviewed');
    expect(inputNameFrom('Task', new Set(['task']))).toBe('task2');
    expect(inputNameFrom('42 files', new Set())).toBe('input42Files');
    expect(inputNameFrom('Что проверить', new Set())).toBe('input');
  });

  it('reports declaration problems the coordinator would reject', () => {
    expect(declarationProblems(inputs)).toEqual([]);
    const broken: PipelineInput[] = [
      { name: 'Task', label: '', kind: 'text' },
      { name: 'tone', label: 'Tone', kind: 'choice', options: [] },
      { name: 'tone', label: 'Tone 2', kind: 'number', defaultValue: 'x' },
    ];
    expect(declarationProblems(broken).map((problem) => problem.index)).toEqual([0, 0, 1, 2, 2]);
  });

  it('applies defaults, drops empty optional values and flags missing required ones', () => {
    const start = initialValues(inputs);
    expect(start).toEqual({ task: undefined, depth: 2, strict: false, tone: undefined });
    const result = checkValues(inputs, { ...start, task: '   ' });
    expect(result.errors).toEqual({ task: 'This input is required.', tone: 'This input is required.' });
    const ok = checkValues(inputs, { task: 'Review the parser', depth: undefined, strict: true, tone: 'short' });
    expect(ok.errors).toEqual({});
    expect(ok.values).toEqual({ task: 'Review the parser', depth: 2, strict: true, tone: 'short' });
  });

  it('rejects values of the wrong kind and oversized text', () => {
    const result = checkValues(inputs, { task: 'x'.repeat(33 * 1024), depth: Number.NaN, strict: true, tone: 'loud' });
    expect(Object.keys(result.errors).sort()).toEqual(['depth', 'task', 'tone']);
  });
});
