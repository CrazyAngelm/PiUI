import { hostInvoke } from './transport';
import type { RuntimeSettings, RuntimeSettingsCommand } from '../../../../contracts/workspace-settings-v16';
import { workspaceError } from './workspaceClient';

type SettingsListener = (settings: RuntimeSettings) => void;
const listeners = new Set<SettingsListener>();

/** Calls `listener` with the confirmed native settings after every successful change. */
export function onRuntimeSettingsSet(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function runtimeSettings(command: RuntimeSettingsCommand): Promise<RuntimeSettings> {
  let result: RuntimeSettings;
  try {
    result = await hostInvoke<RuntimeSettings>('workspace_settings_v16', { command });
    if (result.protocol !== 16 || result.sessionId !== command.sessionId) throw new Error('Invalid settings response');
  } catch (error) { throw workspaceError(error); }
  if (command.type === 'set') for (const listener of [...listeners]) listener(result);
  return result;
}
