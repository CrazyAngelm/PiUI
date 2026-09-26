import { hostInvoke } from './transport';
import type { WorkspaceHistoryRequestV1, WorkspaceHistoryResultV1 } from '../../../../contracts/workspace-history-v1';
import { workspaceError } from './workspaceClient';

export async function readWorkspaceHistory(sessionId: string): Promise<WorkspaceHistoryResultV1['blocks']> {
  const request: WorkspaceHistoryRequestV1 = { sessionId };
  try {
    const result = await hostInvoke<WorkspaceHistoryResultV1>('workspace_history_v1', { request });
    if (result.protocol !== 1 || result.sessionId !== sessionId) throw new Error('History identity mismatch');
    return result.blocks;
  } catch (error) { throw workspaceError(error); }
}
