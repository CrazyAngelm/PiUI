import { describe, expect, it } from 'vitest';
import type { OrchestrationRunV6, PipelineInput, PipelineStep, TaskRecord } from '../../../../contracts/orchestration-v6';
import { isHostExecutedStep } from './stepExecutors';
import {
  kindsCompatible, mappingProblems, pipelineOutputIssues, reaches, referencedCommands, resolveSubpipelineInputs,
  SUBPIPELINE_FAILURE_CODES, SUBPIPELINE_ISSUES, SUBPIPELINE_REASONS, subpipelineResult, subpipelineStepIssue,
  type PipelineExecutor,
} from './subpipelines';

const step = (id: string, patch: Partial<PipelineStep> = {}): PipelineStep => ({
  id, name: id, assignedMemberId: id, instructions: '', dependencyStepIds: [], ...patch,
});

const executor = (inputs: PipelineExecutor['inputs'] = {}, launchCommandId = 'child'): PipelineExecutor => ({ type: 'pipeline', launchCommandId, inputs });

const childInputs: PipelineInput[] = [
  { name: 'topic', label: 'Topic', kind: 'text', required: true },
  { name: 'count', label: 'Count', kind: 'number' },
  { name: 'mode', label: 'Mode', kind: 'choice', options: ['fast', 'slow'], defaultValue: 'fast', required: true },
];

function childRun(status: OrchestrationRunV6['status'], tasks: TaskRecord[], outputs: NonNullable<OrchestrationRunV6['definition']['pipeline']['outputs']> = []): Pick<OrchestrationRunV6, 'status' | 'tasks' | 'definition'> {
  return {
    status,
    tasks,
    definition: {
      profiles: [],
      team: { id: 'team', name: 'Team', members: [], sendEdges: [], observeEdges: [], orchestratorMemberId: '' },
      pipeline: { id: 'pipe', name: 'Pipe', steps: [step('plan'), step('write')], ...(outputs.length ? { outputs } : {}) },
    },
  };
}

describe('sub-pipeline rules', () => {
  it('treats a sub-pipeline step as host work', () => {
    expect(isHostExecutedStep(step('call', { executor: executor() }))).toBe(true);
    expect(referencedCommands({ steps: [step('a', { executor: executor({}, 'x') }), step('b', { executor: executor({}, 'x') }), step('c')] })).toEqual(['x']);
  });

  it('checks the self-contained shape of a step', () => {
    expect(subpipelineStepIssue(step('call', { executor: executor() }))).toBeUndefined();
    expect(subpipelineStepIssue(step('call', { executor: executor({}, ' ') }))).toBe(SUBPIPELINE_REASONS.command);
    expect(subpipelineStepIssue(step('call', { executor: executor({ 'Bad name': { kind: 'value', value: 1 } }) }))).toBe(SUBPIPELINE_REASONS.inputs);
    expect(subpipelineStepIssue(step('call', { executor: executor({ topic: { kind: 'step', stepId: 'plan' } }) }))).toBe(SUBPIPELINE_REASONS.source);
    expect(subpipelineStepIssue(step('call', { dependencyStepIds: ['plan'], executor: executor({ topic: { kind: 'step', stepId: 'plan' } }) }))).toBeUndefined();
    expect(subpipelineStepIssue(step('call', { executor: executor(), inputBindings: [{ sourceStepId: 'plan', field: 'a', name: 'a' }] }))).toBe(SUBPIPELINE_REASONS.bindings);
  });

  it('follows references to find cycles', () => {
    const graph = new Map<string, string[]>([['a', ['b']], ['b', ['c']], ['c', []]]);
    const refs = (id: string) => graph.get(id);
    expect(reaches('a', 'c', refs)).toBe(true);
    expect(reaches('c', 'a', refs)).toBe(false);
    expect(reaches('a', 'a', refs)).toBe(true);
    graph.set('c', ['a']);
    expect(reaches('b', 'a', refs)).toBe(true);
  });

  it('compares input and source kinds', () => {
    expect(kindsCompatible('text', 'long-text')).toBe(true);
    expect(kindsCompatible('long-text', 'artifact')).toBe(true);
    expect(kindsCompatible('choice', 'text')).toBe(true);
    expect(kindsCompatible('number', 'text')).toBe(false);
    expect(kindsCompatible('boolean', 'boolean')).toBe(true);
    expect(kindsCompatible('text', 'text-list')).toBe(false);
  });

  it('reports mapping problems against the child inputs', () => {
    const fields = (id: string) => (id === 'plan' ? [{ name: 'summary', kind: 'text' as const }, { name: 'score', kind: 'number' as const }] : []);
    const parentInputs: PipelineInput[] = [{ name: 'task', label: 'Task', kind: 'long-text' }];
    const check = (inputs: PipelineExecutor['inputs'], dependencies: string[] = ['plan']) =>
      mappingProblems(executor(inputs), { inputs: childInputs }, parentInputs, dependencies, fields).map((problem) => [problem.input, problem.message]);

    expect(check({ topic: { kind: 'input', name: 'task' } })).toEqual([]);
    expect(check({})).toEqual([['topic', SUBPIPELINE_ISSUES.required]]);
    expect(check({ topic: { kind: 'value', value: 'x' }, count: { kind: 'value', value: 'three' } })).toEqual([['count', SUBPIPELINE_ISSUES.valueKind]]);
    expect(check({ topic: { kind: 'value', value: 'x' }, extra: { kind: 'value', value: 1 } })).toEqual([['extra', SUBPIPELINE_ISSUES.unknownInput]]);
    expect(check({ topic: { kind: 'input', name: 'missing' } })).toEqual([['topic', SUBPIPELINE_ISSUES.parentInput]]);
    expect(check({ topic: { kind: 'step', stepId: 'plan' } }, [])).toEqual([['topic', SUBPIPELINE_ISSUES.stepSource]]);
    expect(check({ topic: { kind: 'step', stepId: 'plan', field: 'nope' } })).toEqual([['topic', SUBPIPELINE_ISSUES.stepField]]);
    expect(check({ topic: { kind: 'value', value: 'x' }, count: { kind: 'step', stepId: 'plan', field: 'summary' } })).toEqual([['count', SUBPIPELINE_ISSUES.kindMismatch]]);
    expect(check({ topic: { kind: 'step', stepId: 'plan', field: 'summary' }, count: { kind: 'step', stepId: 'plan', field: 'score' } })).toEqual([]);
    // Without the child nothing about its inputs is claimed.
    expect(mappingProblems(executor({}), undefined, parentInputs, [], fields)).toEqual([]);
  });

  it('validates declared outputs', () => {
    const steps = [step('plan', { resultFields: [{ name: 'score', kind: 'number' }] }), step('helper', { executionMode: 'callable' })];
    expect(pipelineOutputIssues({ steps, outputs: [{ name: 'score', kind: 'number', sourceStepId: 'plan', field: 'score' }] })).toEqual([]);
    expect(pipelineOutputIssues({ steps, outputs: [{ name: 'text', kind: 'text', sourceStepId: 'plan' }] })).toEqual([]);
    for (const outputs of [
      [{ name: 'score', kind: 'text' as const, sourceStepId: 'plan', field: 'score' }],
      [{ name: 'Score', kind: 'number' as const, sourceStepId: 'plan', field: 'score' }],
      [{ name: 'text', kind: 'number' as const, sourceStepId: 'plan' }],
      [{ name: 'text', kind: 'text' as const, sourceStepId: 'helper' }],
      [{ name: 'text', kind: 'text' as const, sourceStepId: 'gone' }],
      [{ name: 'a', kind: 'text' as const, sourceStepId: 'plan' }, { name: 'a', kind: 'text' as const, sourceStepId: 'plan' }],
    ]) {
      expect(pipelineOutputIssues({ steps, outputs })).toEqual([SUBPIPELINE_REASONS.outputs]);
    }
  });

  it('resolves child inputs from values, run inputs and dependency results', () => {
    const parent: Pick<OrchestrationRunV6, 'inputs' | 'tasks'> = {
      inputs: { task: 'Ship it' },
      tasks: [
        { stepId: 'plan', status: 'succeeded', revision: 2, resultData: { score: 3 }, output: undefined },
        { stepId: 'note', status: 'succeeded', revision: 2, resultReference: { sessionId: 's', blockId: 'b', contentHash: 'h' } },
      ],
    };
    const native = (id: string) => (id === 'note' ? 'Native text' : null);
    expect(resolveSubpipelineInputs(executor({ topic: { kind: 'input', name: 'task' }, count: { kind: 'step', stepId: 'plan', field: 'score' } }), childInputs, parent, native))
      .toEqual({ ok: true, values: { count: 3, mode: 'fast', topic: 'Ship it' } });
    expect(resolveSubpipelineInputs(executor({ topic: { kind: 'step', stepId: 'note' } }), childInputs, parent, native))
      .toEqual({ ok: true, values: { mode: 'fast', topic: 'Native text' } });
    expect(resolveSubpipelineInputs(executor({ topic: { kind: 'step', stepId: 'plan', field: 'missing' } }), childInputs, parent, native))
      .toEqual({ ok: false, code: SUBPIPELINE_FAILURE_CODES.inputUnavailable });
    expect(resolveSubpipelineInputs(executor({ topic: { kind: 'step', stepId: 'plan', field: 'score' } }), childInputs, parent, native))
      .toEqual({ ok: false, code: SUBPIPELINE_FAILURE_CODES.inputInvalid });
    expect(resolveSubpipelineInputs(executor({}), childInputs, parent, native)).toEqual({ ok: false, code: SUBPIPELINE_FAILURE_CODES.inputInvalid });
  });

  it('turns a finished child run into the step result', () => {
    const done = (stepId: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({ stepId, status: 'succeeded', revision: 1, ...patch });
    const outputs = [{ name: 'score', kind: 'number' as const, sourceStepId: 'plan', field: 'score' }, { name: 'note', kind: 'text' as const, sourceStepId: 'write' }];
    const tasks = [done('plan', { resultData: { score: 7 } }), done('write', { output: { text: 'All good' } })];
    const fields = [{ name: 'score', kind: 'number' as const }, { name: 'note', kind: 'text' as const }];
    const none = () => null;
    expect(subpipelineResult(childRun('succeeded', tasks, outputs), fields, none)).toEqual({ status: 'succeeded', data: { score: 7, note: 'All good' } });
    expect(subpipelineResult(childRun('succeeded', tasks, outputs), [{ name: 'score', kind: 'text' }], none)).toEqual({ status: 'failed', failure: { code: 'result-field-type' } });
    expect(subpipelineResult(childRun('succeeded', [done('plan'), done('write', { output: { text: 'x' } })], outputs), fields, none))
      .toEqual({ status: 'failed', failure: { code: SUBPIPELINE_FAILURE_CODES.outputUnavailable } });
    expect(subpipelineResult(childRun('succeeded', tasks), [], none)).toEqual({ status: 'succeeded', text: 'All good' });
    expect(subpipelineResult(childRun('failed', tasks), [], none)).toEqual({ status: 'failed', failure: { code: SUBPIPELINE_FAILURE_CODES.failed } });
    expect(subpipelineResult(childRun('cancelled', tasks), [], none)).toEqual({ status: 'failed', failure: { code: SUBPIPELINE_FAILURE_CODES.cancelled } });
  });
});
