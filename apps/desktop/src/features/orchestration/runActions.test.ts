import { describe, expect, it, vi } from 'vitest';
import {
  createOrchestrationClient,
  type OrchestrationCommandName, type OrchestrationRequest, type OrchestrationRunV6, type StartRunRequest,
} from '../../host-api/orchestrationClient';
import { performRunAction, uncertainTaskMutation } from './runActions';

const run: OrchestrationRunV6 = {
  schemaVersion: 6, id: 'fixture-run', revision: 4, status: 'uncertain',
  definition: {
    profiles: [],
    team: { id: 'fixture-team', name: 'Fixture team', members: [], sendEdges: [], observeEdges: [], orchestratorMemberId: 'fixture-member' },
    pipeline: { id: 'fixture-pipeline', name: 'Fixture pipeline', steps: [] },
  },
  tasks: [{ stepId: 'fixture-step', revision: 2, status: 'uncertain', execution: { id: 'fixture-session' } }],
  messages: [], agentRequests: [],
};
const start: StartRunRequest = { workspaceId: 'fixture-workspace', runId: run.id, teamId: 'fixture-team', pipelineId: 'fixture-pipeline' };

function testClient(handler: (route: OrchestrationCommandName, request: OrchestrationRequest) => unknown) {
  const calls: { route: OrchestrationCommandName; request: OrchestrationRequest }[] = [];
  return {
    calls,
    client: createOrchestrationClient(async <T>(route: OrchestrationCommandName, { request }: { request: OrchestrationRequest }): Promise<T> => {
      calls.push({ route, request });
      return handler(route, request) as T;
    }),
  };
}

describe('real run action requests', () => {
  it('shows the durable failed run when host-native preflight rejects, not a fabricated launch success', async () => {
    const failed = { ...run, revision: 5, status: 'failed' as const };
    const { client, calls } = testClient((route) => {
      if (route === 'orchestration_start_run_v6') throw { code: 'unsupported-policy', message: 'private model configuration' };
      return failed;
    });
    const result = await performRunAction(client, { type: 'start', request: start }, false);
    expect(result).toMatchObject({ type: 'recorded', run: { status: 'failed', revision: 5 }, actionError: { code: 'unsupported-policy' } });
    expect(calls).toEqual([{ route: 'orchestration_start_run_v6', request: start }, { route: 'orchestration_get_run_v6', request: { workspaceId: start.workspaceId, runId: start.runId } }]);
    expect(JSON.stringify(result)).not.toContain('private model configuration');
  });

  it('passes exact cancellation CAS and preserves an uncertain native outcome', async () => {
    const { client, calls } = testClient(() => ({ ...run, revision: 5, status: 'uncertain' }));
    const request = { workspaceId: start.workspaceId, runId: run.id, expectedRunRevision: 4 };
    const result = await performRunAction(client, { type: 'cancel', request }, false);
    expect(calls).toEqual([{ route: 'orchestration_cancel_run_v6', request }]);
    expect(result).toMatchObject({ type: 'recorded', run: { status: 'uncertain' } });
    expect(result).not.toHaveProperty('actionError');
  });

  it('builds uncertain retry/reconcile requests from current task and run revisions only', async () => {
    const request = uncertainTaskMutation(start.workspaceId, run, run.tasks[0]);
    expect(request).toEqual({ workspaceId: start.workspaceId, runId: run.id, expectedRunRevision: 4, stepId: 'fixture-step', expectedTaskRevision: 2 });
    expect(() => uncertainTaskMutation(start.workspaceId, run, { ...run.tasks[0], revision: 1 })).toThrow('task changed');
    expect(() => uncertainTaskMutation(start.workspaceId, run, { ...run.tasks[0], status: 'failed' })).toThrow('task changed');
    const { client, calls } = testClient(() => ({ ...run, revision: 5 }));
    await performRunAction(client, { type: 'retry', request }, false);
    const reconciliation = { ...request, resolution: { status: 'succeeded' as const } };
    await performRunAction(client, { type: 'reconcile', request: reconciliation }, false);
    expect(calls).toEqual([{ route: 'orchestration_retry_uncertain_task_v6', request }, { route: 'orchestration_reconcile_uncertain_task_v6', request: reconciliation }]);
  });

  it('does not replay a command or change the request ID after an unconfirmed native failure', async () => {
    const original = { ...start };
    const { client, calls } = testClient(() => { throw { code: 'native-outcome-uncertain' }; });
    const result = await performRunAction(client, { type: 'start', request: start }, false);
    expect(result).toMatchObject({ type: 'unconfirmed', error: { code: 'native-outcome-uncertain' }, recovery: 'unavailable' });
    expect(calls.map((call) => call.route)).toEqual(['orchestration_start_run_v6', 'orchestration_get_run_v6']);
    expect(start).toEqual(original);
  });

  it('fails closed in safe mode without sending an execution or recovery command', async () => {
    const handler = vi.fn();
    const { client, calls } = testClient(handler);
    expect(await performRunAction(client, { type: 'start', request: start }, true)).toMatchObject({ type: 'unconfirmed', recovery: 'blocked' });
    expect(calls).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('never installs a wrong-run or older-than-request response as the action outcome', async () => {
    const { client, calls } = testClient((route) => route === 'orchestration_cancel_run_v6' ? { ...run, id: 'another-run' } : { ...run, revision: 5 });
    const request = { workspaceId: start.workspaceId, runId: run.id, expectedRunRevision: 4 };
    expect(await performRunAction(client, { type: 'cancel', request }, false)).toMatchObject({ type: 'recorded', run: { id: run.id, revision: 5 }, actionError: { code: 'conflict' } });
    expect(calls).toHaveLength(2);
    const stale = testClient(() => ({ ...run, revision: 3 }));
    expect(await performRunAction(stale.client, { type: 'cancel', request }, false)).toMatchObject({ type: 'unconfirmed', error: { code: 'conflict' } });
  });
});
