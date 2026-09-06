import { invoke } from '@tauri-apps/api/core';
import type { RuntimeSettings, RuntimeSettingsCommand } from '../../../../contracts/workspace-settings-v12';
import { workspaceError } from './workspaceClient';
export async function runtimeSettings(command: RuntimeSettingsCommand): Promise<RuntimeSettings> {
  try {
    const result = await invoke<RuntimeSettings>('workspace_settings_v12', { command });
    if (result.protocol !== 12 || result.sessionId !== command.sessionId) throw new Error('Invalid settings response');
    return result;
  } catch (error) { throw workspaceError(error); }
}
