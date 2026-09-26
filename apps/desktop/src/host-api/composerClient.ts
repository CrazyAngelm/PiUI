import { hostInvoke, hostListen } from './transport';
import type { ComposerCommand, ComposerSnapshot } from '../../../../contracts/workspace-composer-v19';
import { workspaceError } from './workspaceClient';
export type { ComposerSnapshot, ComposerCommand };
export const COMPOSER_EVENT_V19 = 'piui://composer-v19';
export async function composerRequest(command: ComposerCommand): Promise<ComposerSnapshot> {
  try {
    const result = await hostInvoke<ComposerSnapshot>('workspace_composer_v19', { command });
    if (result.protocol !== 19 || result.sessionId !== command.sessionId) throw new Error('Invalid composer response');
    return result;
  } catch (error) { throw workspaceError(error); }
}
/** Outbox invalidations carry only the opaque session id; read a fresh snapshot on each one. */
export function listenComposer(sessionId: string, handler: () => void): Promise<() => void> {
  return hostListen<unknown>(COMPOSER_EVENT_V19, (payload) => { if (payload === sessionId) handler(); });
}
