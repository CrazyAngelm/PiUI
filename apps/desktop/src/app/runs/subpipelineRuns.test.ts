import { describe, expect, it } from 'vitest';
import type { OrchestrationRunV6, PipelineStep, TaskRecord } from '../../host-api/orchestrationClient';
import { SUBPIPELINE_FAILURE_CODES } from '../../host-api/subpipelines';
import { failureText } from './runGraph';
import { childRunId, knownParents, stepViews } from './runPresentation';

const call: PipelineStep = {
  id: 'call', name: 'Testing', assignedMemberId: 'call', instructions: '', dependencyStepIds: [],
  executor: { type: 'pipeline', launchCommandId: 'testing', inputs: {} },
};
const plan: PipelineStep = { id: 'plan', name: 'Plan', assignedMemberId: 'plan', instructions: '', dependencyStepIds: [] };

function run(tasks: TaskRecord[], extra: Partial<OrchestrationRunV6> = {}): OrchestrationRunV6 {
  const definition = {
    profiles: [],
    team: { id: 'team', name: 'Team', members: [{ id: 'plan', profileId: 'p' }], orchestratorMemberId: 'plan', sendEdges: [], observeEdges: [] },
    pipeline: { id: 'pipe', name: 'Pipe', steps: [plan, call] },
  } as unknown as OrchestrationRunV6['definition'];
  return { schemaVersion: 6, id: 'parent', definition, status: 'running', revision: 3, tasks, messages: [], agentRequests: [], ...extra };
}

describe('sub-pipeline runs', () => {
  it('treats a sub-pipeline execution as a child run, never a session', () => {
    const tasks: TaskRecord[] = [
      { stepId: 'plan', status: 'succeeded', revision: 2, execution: { id: 'session-1' } },
      { stepId: 'call', status: 'running', revision: 2, execution: { id: 'child-run' } },
    ];
    const views = stepViews(run(tasks));
    expect(views.map((view) => view.sessionId)).toEqual(['session-1', undefined]);
    expect(childRunId(call, tasks[1])).toBe('child-run');
    expect(childRunId(plan, tasks[0])).toBeUndefined();
    expect(childRunId(call, undefined)).toBeUndefined();
  });

  it('learns parent runs from triggers and from sub-pipeline steps, including earlier attempts', () => {
    const parent = run(
      [{ stepId: 'call', status: 'succeeded', revision: 4, execution: { id: 'child-2' } }],
      { attempts: [{ stepId: 'call', status: 'failed', revision: 2, execution: { id: 'child-1' }, failure: { code: SUBPIPELINE_FAILURE_CODES.failed } }] },
    );
    expect(knownParents(parent)).toEqual([['child-2', 'parent'], ['child-1', 'parent']]);
    const child = run([], { id: 'child-2', trigger: { kind: 'pipeline', parentRunId: 'parent', parentStepId: 'call', launchCommandId: 'testing', depth: 1 } });
    expect(knownParents(child)).toEqual([['child-2', 'parent']]);
  });

  it('describes every sub-pipeline failure code for people', () => {
    const texts = Object.values(SUBPIPELINE_FAILURE_CODES).map((code) => failureText(code));
    expect(texts.every((text) => !text.startsWith('subpipeline-'))).toBe(true);
    expect(new Set(texts).size).toBe(texts.length);
  });
});
