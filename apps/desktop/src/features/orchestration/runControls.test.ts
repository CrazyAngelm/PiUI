import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { OrchestrationRunV5 } from '../../../../../contracts/orchestration-v5';
import RunInspector from './RunInspector.svelte';

const baseRun: OrchestrationRunV5 = {
  schemaVersion: 5, id: 'run-1', status: 'running', revision: 1,
  definition: {
    profiles: [{ id: 'profile-1', name: 'Planner', harness: 'pi', model: 'model', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] }],
    team: { id: 'team-1', name: 'Team', members: [{ id: 'member-1', profileId: 'profile-1' }], sendEdges: [], observeEdges: [], orchestratorMemberId: 'member-1' },
    pipeline: { id: 'pipeline-1', name: 'Pipeline', steps: [{ id: 'step-1', name: 'Plan', assignedMemberId: 'member-1', instructions: '', dependencyStepIds: [] }] },
  },
  tasks: [{ stepId: 'step-1', status: 'uncertain', revision: 1, execution: { id: 'workspace-session-1' } }],
  messages: [], agentRequests: [],
};

describe('RunInspector optional controls', () => {
  it('does not render scheduler controls without their callbacks', () => {
    const { body } = render(RunInspector, { props: { run: baseRun, onClose: () => {} } });
    expect(body).not.toContain('Cancel run');
    expect(body).not.toContain('Retry uncertain task');
    expect(body).not.toContain('Record succeeded');
  });

  it('renders cancel only for an actual running run when supplied', () => {
    const { body } = render(RunInspector, { props: { run: baseRun, onClose: () => {}, onCancelRun: () => {} } });
    expect(body).toContain('Cancel run');
    expect(body).toContain('distinct from stopping an individual session turn');
  });

  it('offers retry only for an uncertain task, never a failed task', () => {
    const enabled = render(RunInspector, { props: { run: baseRun, onClose: () => {}, onRetryTask: () => {} } }).body;
    const failedRun = { ...baseRun, tasks: [{ ...baseRun.tasks[0]!, status: 'failed' as const }] };
    const failed = render(RunInspector, { props: { run: failedRun, onClose: () => {}, onRetryTask: () => {} } }).body;
    expect(enabled).toContain('Retry uncertain task');
    expect(failed).not.toContain('Retry uncertain task');
    expect(failed).not.toContain('Record succeeded');
  });

  it('gates fixed-resolution reconciliation controls behind its callback', () => {
    const { body } = render(RunInspector, { props: { run: baseRun, onClose: () => {}, onReconcileTask: () => {} } });
    expect(body).toContain('Record succeeded');
    expect(body).toContain('Record failed');
    expect(body).toContain('Record cancelled');
  });
});
