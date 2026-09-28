import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import {
  TEAMMATES_CHANGED_EVENT_V1,
  type TeammateStatusV1,
  type TeammateV1,
  type TeammatesChangedEventV1,
  type TeammatesCommandV1,
  type TeammatesErrorCodeV1,
  type TeammatesResultV1,
} from '../../../../contracts/teammates-v1';
import { isRecord } from './sessionToolErrors';

export type * from '../../../../contracts/teammates-v1';
export {
  MAX_TEAMMATE_ROLE_CHARS,
  MAX_TEAMMATES_PER_WORKSPACE,
  TEAMMATE_HANDLE_PATTERN,
  TEAMMATES_CHANGED_EVENT_V1,
} from '../../../../contracts/teammates-v1';

/**
 * Client of `teammates_command_v1` (ADR-041): project-scoped `@handle`
 * addresses that resolve to one saved launch command each.
 */
export const TEAMMATES_ERROR_COPY: Readonly<Record<TeammatesErrorCodeV1 | 'unknown', string>> = {
  SAFE_MODE: 'Safe mode is on: PiUI does not change teammates.',
  INVALID_ARGUMENT: 'Check the teammate details and try again.',
  NOT_FOUND: 'This teammate or its pipeline is no longer available.',
  HANDLE_TAKEN: 'Another teammate of this project already uses this handle.',
  REVISION_CONFLICT: 'The teammate changed meanwhile. Reopen it and try again.',
  UNSUPPORTED: 'This harness cannot run a teammate with these settings.',
  LIMIT: 'This project has the most teammates allowed.',
  IO_ERROR: 'PiUI could not save the teammate. Nothing was lost.',
  unknown: 'The teammate operation could not be completed.',
};

export type TeammatesErrorKind = TeammatesErrorCodeV1 | 'unknown';

export class TeammatesError extends Error {
  constructor(readonly code: TeammatesErrorKind, message: string = TEAMMATES_ERROR_COPY[code]) {
    super(message);
    this.name = 'TeammatesError';
  }
}

function isErrorCode(value: unknown): value is TeammatesErrorCodeV1 {
  return typeof value === 'string' && value !== 'unknown' && Object.hasOwn(TEAMMATES_ERROR_COPY, value);
}

export function teammatesError(cause: unknown): TeammatesError {
  if (cause instanceof TeammatesError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  return new TeammatesError(isRecord(value) && isErrorCode(value.code) ? value.code : 'unknown');
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function isTeammate(value: unknown): value is TeammateV1 {
  return isRecord(value)
    && text(value.id)
    && text(value.handle)
    && typeof value.name === 'string'
    && typeof value.role === 'string'
    && isRecord(value.kind)
    && (value.kind.type === 'simple' || value.kind.type === 'pipeline')
    && text(value.launchCommandId)
    && isRecord(value.wake)
    && isRecord(value.board)
    && typeof value.enabled === 'boolean'
    && typeof value.revision === 'number';
}

export function isTeammateStatus(value: unknown): value is TeammateStatusV1 {
  return isRecord(value)
    && text(value.teammateId)
    && (value.availability === 'idle' || value.availability === 'queued' || value.availability === 'working')
    && Array.isArray(value.liveRunIds)
    && typeof value.queued === 'number'
    && (value.notAssignableReason === undefined || typeof value.notAssignableReason === 'string');
}

export function decodeTeammatesResult(value: unknown): TeammatesResultV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1) return undefined;
  switch (value.type) {
    case 'teammates':
      return Array.isArray(value.teammates) && value.teammates.every(isTeammate) && Array.isArray(value.status) && value.status.every(isTeammateStatus)
        ? (value as unknown as TeammatesResultV1)
        : undefined;
    case 'teammate':
      return isTeammate(value.teammate) && isTeammateStatus(value.status) ? (value as unknown as TeammatesResultV1) : undefined;
    case 'deleted':
      return text(value.teammateId) ? (value as unknown as TeammatesResultV1) : undefined;
    default:
      return undefined;
  }
}

export interface TeammatesClient {
  request(command: TeammatesCommandV1): Promise<TeammatesResultV1>;
  onChanged(handler: (event: TeammatesChangedEventV1) => void): Promise<() => void>;
}

export function createTeammatesClient(invoke: HostInvoke, listen: HostListen): TeammatesClient {
  return {
    async request(command) {
      let result: unknown;
      try {
        result = await invoke<unknown>('teammates_command_v1', { command });
      } catch (error) {
        throw teammatesError(error);
      }
      const decoded = decodeTeammatesResult(result);
      if (decoded === undefined) throw new TeammatesError('unknown');
      return decoded;
    },
    onChanged(handler) {
      return listen<unknown>(TEAMMATES_CHANGED_EVENT_V1, (payload) => {
        if (isRecord(payload) && payload.protocol === 1 && text(payload.workspaceId)) {
          handler({ protocol: 1, workspaceId: payload.workspaceId });
        }
      });
    },
  };
}

export const teammatesHost: TeammatesClient = createTeammatesClient(
  (command, args) => hostInvoke(command, args),
  (channel, handler) => hostListen(channel, handler),
);
