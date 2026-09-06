import {
  orchestrationError, OrchestrationOperationError,
  type OrchestrationClient, type OrchestrationRunV1, type TaskRecord,
  type StartRunRequest, type RunMutationRequest, type RetryUncertainTaskRequest, type ReconcileUncertainTaskRequest,
} from '../../host-api/orchestrationClient';
import { checkedRunSnapshot } from './runUpdates';

export type RunAction =
  | { readonly type: 'start'; readonly request: StartRunRequest }
  | { readonly type: 'cancel'; readonly request: RunMutationRequest }
  | { readonly type: 'retry'; readonly request: RetryUncertainTaskRequest }
  | { readonly type: 'reconcile'; readonly request: ReconcileUncertainTaskRequest };

export type RunActionResult =
  | { readonly type: 'recorded'; readonly run: OrchestrationRunV1; readonly actionError?: OrchestrationOperationError }
  | { readonly type: 'unconfirmed'; readonly error: OrchestrationOperationError; readonly recovery: 'missing' | 'unavailable' | 'blocked' };

export function uncertainTaskMutation(workspaceId: string, run: OrchestrationRunV1, task: TaskRecord): RetryUncertainTaskRequest {
  const current = run.tasks.find((candidate) => candidate.stepId === task.stepId);
  if (task.status !== 'uncertain' || current?.status !== 'uncertain' || current.revision !== task.revision) {
    throw new OrchestrationOperationError('conflict', 'This task changed. Review its current native session and recorded revision before acting.');
  }
  return { workspaceId, runId: run.id, expectedRunRevision: run.revision, stepId: current.stepId, expectedTaskRevision: current.revision };
}

/** One requested command, followed only by read-only recovery on failure. Never replay native work. */
export async function performRunAction(client: OrchestrationClient, action: RunAction, safeMode: boolean): Promise<RunActionResult> {
  if (safeMode) return { type: 'unconfirmed', error: new OrchestrationOperationError('denied', 'Safe mode keeps runs read-only.'), recovery: 'blocked' };
  const { workspaceId, runId } = action.request;
  const minimumRevision = action.type === 'start' ? 0 : action.request.expectedRunRevision;
  try {
    let result: OrchestrationRunV1;
    switch (action.type) {
      case 'start': result = await client.orchestration_start_run_v1(action.request); break;
      case 'cancel': result = await client.orchestration_cancel_run_v1(action.request); break;
      case 'retry': result = await client.orchestration_retry_uncertain_task_v1(action.request); break;
      case 'reconcile': result = await client.orchestration_reconcile_uncertain_task_v1(action.request); break;
      default: { const exhaustive: never = action; return exhaustive; }
    }
    return { type: 'recorded', run: checkedRunSnapshot(result, runId, minimumRevision) };
  } catch (cause) {
    const error = orchestrationError(cause);
    try {
      const recorded = await client.orchestration_get_run_v1({ workspaceId, runId });
      if (recorded === null) return { type: 'unconfirmed', error, recovery: 'missing' };
      return { type: 'recorded', run: checkedRunSnapshot(recorded, runId, minimumRevision), actionError: error };
    } catch { return { type: 'unconfirmed', error, recovery: 'unavailable' }; }
  }
}
