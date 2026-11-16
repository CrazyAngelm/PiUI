import { hostInvoke } from './transport';
import type { SessionTaskStopRequestV1, SessionTaskStopResultV1 } from '../../../../contracts/workspace-session-tasks-v1';
import { workspaceError } from './workspaceClient';

/** Stops one running task of a live session (`workspace_task_stop_v1`, ADR-072). */
export async function stopSessionTask(request: SessionTaskStopRequestV1): Promise<SessionTaskStopResultV1> {
  try {
    const result = await hostInvoke<SessionTaskStopResultV1>('workspace_task_stop_v1', { request });
    if (result.protocol !== 1 || result.sessionId !== request.sessionId) throw new Error('Invalid task stop response');
    return result;
  } catch (error) {
    throw workspaceError(error);
  }
}
