import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceLifecycleCommand, WorkspaceLifecycleResult } from '../../../../contracts/workspace-lifecycle-v13';
import { workspaceError } from './workspaceClient';

export async function deleteWorkspaceSession(sessionId: string): Promise<void> {
  const command: WorkspaceLifecycleCommand = { type: 'deleteSession', sessionId };
  try {
    const result = await invoke<WorkspaceLifecycleResult>('workspace_lifecycle_v13', { command });
    if (result.protocol !== 13 || result.sessionId !== sessionId) throw new Error('Invalid lifecycle response');
  } catch (error) { throw workspaceError(error); }
}
