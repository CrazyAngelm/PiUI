import { describe, expect, it } from 'vitest';
import type { OrchestrationRunV1 } from '../../../../../contracts/orchestration-v1';
import { memberById, memberLabel, sessionIdForTask, statusPresentation, taskDisplays } from './runView';

const run: OrchestrationRunV1 = {
  schemaVersion: 1, id: 'run-1', status: 'running', revision: 4,
  definition: {
    profiles: [{ id: 'profile-1', name: 'Planner', harness: 'pi', model: 'model', permissionMode: 'native', instructions: 'Plan.', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] }],
    team: { id: 'team-1', name: 'Team', members: [{ id: 'member-1', profileId: 'profile-1' }], sendEdges: [], observeEdges: [], orchestratorMemberId: 'member-1' },
    pipeline: { id: 'pipe-1', name: 'Pipeline', steps: [{ id: 'step-1', name: 'Plan', assignedMemberId: 'member-1', instructions: 'Make a plan.', dependencyStepIds: [] }] },
  },
  tasks: [{ stepId: 'step-1', status: 'failed', revision: 2, execution: { id: 'workspace-session-1' }, failure: { code: 'SAFE_CODE' }, resultReference: { sessionId: 'history-1', blockId: 'block-1' } }],
  messages: [],
  agentRequests: [],
};

describe('run inspector view helpers', () => {
  it('maps actual task state to its member and coordinator-bound workspace session', () => {
    const display = taskDisplays(run)[0];
    expect(display).toMatchObject({ stepName: 'Plan', profile: { name: 'Planner' }, sessionId: 'workspace-session-1', status: { label: 'Failed' } });
    expect(sessionIdForTask(run.tasks[0])).toBe('workspace-session-1');
    expect(memberById(run, 'member-1')).toEqual(run.definition.team.members[0]);
  });

  it('labels uncertain records as needing reconciliation, not success or failure', () => {
    expect(statusPresentation('uncertain')).toMatchObject({ icon: '?', label: 'Needs reconciliation', tone: 'warning' });
    const missingTaskRun = { ...run, tasks: [] };
    expect(taskDisplays(missingTaskRun)[0]?.status.label).toBe('Needs reconciliation');
    expect(memberLabel(run, 'missing-member')).toBe('Unknown member (missing-member)');
  });

  it('keeps safe failure and result references available from actual failed records', () => {
    const display = taskDisplays(run)[0]?.task;
    expect(display?.failure?.code).toBe('SAFE_CODE');
    expect(display?.resultReference).toEqual({ sessionId: 'history-1', blockId: 'block-1' });
  });
});
