import { describe, expect, it } from 'vitest';
import type { OrchestrationRunV6, PipelineStep, RunSummary, TaskRecord } from '../../host-api/orchestrationClient';
import {
  canCancelTask,
  canRecordSucceeded,
  canRepeat,
  matchesRunFilter,
  resultEntries,
  runCounts,
  sortRuns,
  stepState,
  stepViews,
} from './runPresentation';

function step(id: string, extra: Partial<PipelineStep> = {}): PipelineStep {
  return { id, name: id.toUpperCase(), assignedMemberId: id, instructions: '', dependencyStepIds: [], ...extra };
}

function task(stepId: string, status: TaskRecord['status'], extra: Partial<TaskRecord> = {}): TaskRecord {
  return { stepId, status, revision: 1, ...extra };
}

function run(steps: PipelineStep[], tasks: TaskRecord[], extra: Partial<OrchestrationRunV6> = {}): OrchestrationRunV6 {
  const definition = {
    profiles: [],
    team: { id: 'team', name: 'Team', members: steps.map((item) => ({ id: item.id, profileId: 'p' })), orchestratorMemberId: steps[0]?.id ?? '', sendEdges: [], observeEdges: [] },
    pipeline: { id: 'pipe', name: 'Pipe', steps },
  } as unknown as OrchestrationRunV6['definition'];
  return { schemaVersion: 6, id: 'run', definition, status: 'running', revision: 3, tasks, messages: [], agentRequests: [], ...extra };
}

describe('run presentation', () => {
  it('maps recorded task states without inferring outcomes', () => {
    expect(stepState(step('a'), undefined)).toBe('missing');
    expect(stepState(step('a', { executionMode: 'callable' }), task('a', 'ready'))).toBe('onCall');
    expect(stepState(step('a', { executionMode: 'callable' }), task('a', 'ready', { leaseId: 'lease' }))).toBe('ready');
    expect(stepState(step('a'), task('a', 'uncertain'))).toBe('uncertain');
  });

  it('never treats a script execution as a native session', () => {
    const script = step('check', { executor: { type: 'script', runtime: 'node', source: 'console.log(1)', timeoutSeconds: 60 } });
    const execution = { id: 'process-1' } as TaskRecord['execution'];
    const views = stepViews(run([step('a'), script], [task('a', 'succeeded', { execution: { id: 'session-a' } as TaskRecord['execution'] }), task('check', 'succeeded', { execution })]));
    expect(views.map((view) => view.sessionId)).toEqual(['session-a', undefined]);
  });

  it('marks steps added at run time and groups earlier attempts per step', () => {
    const initial = run([step('a')], []);
    const current = run([step('a'), step('helper')], [task('a', 'succeeded', { execution: { id: 's1' } }), task('helper', 'running')], {
      initialDefinition: initial.definition,
      attempts: [task('a', 'failed'), task('helper', 'cancelled'), task('a', 'succeeded')],
    });
    const views = stepViews(current);
    expect(views.map((view) => [view.stepId, view.spawned, view.attempts.length, view.sessionId])).toEqual([
      ['a', false, 2, 's1'],
      ['helper', true, 1, undefined],
    ]);
  });

  it('counts outstanding work without uncalled helpers or skipped branches', () => {
    const views = stepViews(
      run(
        [step('a'), step('b'), step('c', { executionMode: 'callable' }), step('d'), step('e')],
        [task('a', 'succeeded'), task('b', 'running'), task('c', 'ready'), task('d', 'skipped'), task('e', 'awaitingApproval')],
      ),
    );
    expect(runCounts(views)).toEqual({ total: 3, done: 1, working: 1, attention: 1 });
  });

  it('mirrors the coordinator rules for cancel, repeat and asserted success', () => {
    expect(canCancelTask(task('a', 'running'))).toBe(true);
    expect(canCancelTask(task('a', 'succeeded'))).toBe(false);
    expect(canRepeat(task('a', 'failed'))).toBe(true);
    expect(canRepeat(task('a', 'running'))).toBe(false);
    expect(canRepeat(task('a', 'uncertain'))).toBe(false);
    expect(canRecordSucceeded(step('a'))).toBe(true);
    expect(canRecordSucceeded(step('a', { resultFields: [{ name: 'ok', kind: 'boolean' }] }))).toBe(false);
    expect(canRecordSucceeded(step('a', { requireApproval: true }))).toBe(false);
  });

  it('filters and orders runs with active work first', () => {
    const summaries: RunSummary[] = [
      { id: '1', status: 'succeeded', revision: 1, teamName: 't', pipelineName: 'p' },
      { id: '2', status: 'failed', revision: 1, teamName: 't', pipelineName: 'p' },
      { id: '3', status: 'running', revision: 1, teamName: 't', pipelineName: 'p' },
      { id: '4', status: 'running', revision: 1, teamName: 't', pipelineName: 'p' },
    ];
    expect(sortRuns(summaries).map((item) => item.id)).toEqual(['4', '3', '2', '1']);
    expect(summaries.filter((item) => matchesRunFilter(item, 'attention')).map((item) => item.id)).toEqual(['2']);
    expect(summaries.filter((item) => matchesRunFilter(item, 'finished')).map((item) => item.id)).toEqual(['1']);
  });

  it('lists declared result fields first, then extra recorded keys', () => {
    const declared = step('a', { resultFields: [{ name: 'approved', kind: 'boolean' }, { name: 'feedback', kind: 'text' }] });
    expect(resultEntries(declared, { extra: 1, feedback: 'ok', approved: true })).toEqual([
      { name: 'approved', value: true },
      { name: 'feedback', value: 'ok' },
      { name: 'extra', value: 1 },
    ]);
    expect(resultEntries(declared, undefined)).toEqual([]);
  });
});
