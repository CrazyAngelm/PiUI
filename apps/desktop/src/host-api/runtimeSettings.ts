import { hostInvoke } from './transport';
import type { RuntimeSettings, RuntimeSettingsCommand } from '../../../../contracts/workspace-settings-v16';
import { workspaceError } from './workspaceClient';
export async function runtimeSettings(command: RuntimeSettingsCommand): Promise<RuntimeSettings> {
  try {
    const result = await hostInvoke<RuntimeSettings>('workspace_settings_v16', { command });
    if (result.protocol !== 16 || result.sessionId !== command.sessionId) throw new Error('Invalid settings response');
    return result;
  } catch (error) { throw workspaceError(error); }
}
