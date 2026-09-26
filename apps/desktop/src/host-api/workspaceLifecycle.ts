import { hostInvoke } from './transport';
import type { WorkspaceLifecycleCommand, WorkspaceLifecycleResult } from '../../../../contracts/workspace-lifecycle-v17';
import { workspaceError } from './workspaceClient';

export async function deleteWorkspaceSession(sessionId: string): Promise<void> {
  const command: WorkspaceLifecycleCommand = { type: 'deleteSession', sessionId };
  try {
    const result = await hostInvoke<WorkspaceLifecycleResult>('workspace_lifecycle_v17', { command });
    if (result.protocol !== 17 || result.sessionId !== sessionId) throw new Error('Invalid lifecycle response');
  } catch (error) { throw workspaceError(error); }
}
