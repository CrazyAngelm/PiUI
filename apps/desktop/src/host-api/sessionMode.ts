import { hostInvoke } from './transport';
import type { SessionModeRequestV1, SessionModeResultV1 } from '../../../../contracts/workspace-session-mode-v1';
import { workspaceError } from './workspaceClient';

/** Selects an agent-advertised session mode (`workspace_session_mode_v1`, ADR-034). */
export async function setSessionMode(request: SessionModeRequestV1): Promise<SessionModeResultV1> {
  try {
    const result = await hostInvoke<SessionModeResultV1>('workspace_session_mode_v1', { request });
    if (result.protocol !== 1 || result.sessionId !== request.sessionId) throw new Error('Invalid session mode response');
    return result;
  } catch (error) {
    throw workspaceError(error);
  }
}
