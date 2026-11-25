import type { ComputerUseSettings } from '../../../../contracts/computer-use-v1';
import { hostInvoke } from './transport';

export type { ComputerUseSettings } from '../../../../contracts/computer-use-v1';

export function computerUseSettings(sessionId: string, enabled: boolean | undefined = undefined): Promise<ComputerUseSettings> {
  return hostInvoke<ComputerUseSettings>('workspace_computer_use_v1', { sessionId, enabled });
}
