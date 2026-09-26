import { hostInvoke, type HostInvoke } from './transport';
import type { WorkspaceAdoptRequestV1, WorkspaceAdoptResultV1 } from '../../../../contracts/workspace-adopt-v1';
import { isRecord, SessionToolError, sessionToolError } from './sessionToolErrors';

export type * from '../../../../contracts/workspace-adopt-v1';

/**
 * Client of `workspace_adopt_v1`: continue a Pi session started in the
 * terminal as a PiUI chat. The returned chat opens with the ordinary
 * workspace `openSession`.
 */
export function decodeAdoptResult(value: unknown): WorkspaceAdoptResultV1 | undefined {
  return isRecord(value) && value.protocol === 1 && typeof value.sessionId === 'string' && value.sessionId.length > 0 && typeof value.created === 'boolean'
    ? (value as unknown as WorkspaceAdoptResultV1)
    : undefined;
}

export interface AdoptClient {
  adopt(request: WorkspaceAdoptRequestV1): Promise<WorkspaceAdoptResultV1>;
}

export function createAdoptClient(invoke: HostInvoke): AdoptClient {
  return {
    async adopt(request) {
      let result: unknown;
      try {
        result = await invoke<unknown>('workspace_adopt_v1', { request });
      } catch (error) {
        throw sessionToolError(error);
      }
      const decoded = decodeAdoptResult(result);
      if (decoded === undefined) throw new SessionToolError('unknown', 'The operation could not be completed.');
      return decoded;
    },
  };
}

export const adoptHost: AdoptClient = createAdoptClient((command, args) => hostInvoke(command, args));
