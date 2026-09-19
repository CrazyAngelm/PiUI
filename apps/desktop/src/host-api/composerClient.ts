import { invoke } from '@tauri-apps/api/core';
import type { ComposerCommand, ComposerSnapshot } from '../../../../contracts/workspace-composer-v19';
import { workspaceError } from './workspaceClient';
export type { ComposerSnapshot, ComposerCommand };
export async function composerRequest(command: ComposerCommand): Promise<ComposerSnapshot> {
  try {
    const result = await invoke<ComposerSnapshot>('workspace_composer_v19', { command });
    if (result.protocol !== 19 || result.sessionId !== command.sessionId) throw new Error('Invalid composer response');
    return result;
  } catch (error) { throw workspaceError(error); }
}
