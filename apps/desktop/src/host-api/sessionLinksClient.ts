import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import { isHarnessId } from '../../../../contracts/harness-identity-v3';
import { SESSION_LINKS_EVENT_V1, type LinkedChatV1, type SessionLinksChangedV1, type SessionLinksCommandV1, type SessionLinksErrorCodeV1, type SessionLinksResultV1 } from '../../../../contracts/session-links-v1';

export * from '../../../../contracts/session-links-v1';
const errorCodes: readonly SessionLinksErrorCodeV1[] = ['invalid-operation', 'unknown-session', 'authority-denied', 'depth-limit', 'child-limit', 'harness-unavailable', 'not-allowed', 'busy', 'unavailable', 'read-only', 'io'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const oneOf = (value: unknown, values: readonly string[]): boolean => typeof value === 'string' && values.includes(value);

function chat(value: unknown): value is LinkedChatV1 {
  return isRecord(value) && text(value.sessionId) && typeof value.title === 'string' && isHarnessId(value.harness)
    && oneOf(value.kind, ['agent', 'branch', 'peer']) && oneOf(value.relation, ['child', 'parent', 'peer'])
    && oneOf(value.state, ['starting', 'running', 'idle', 'failed', 'closed']) && count(value.pending)
    && (value.lastReport === undefined || isRecord(value.lastReport) && text(value.lastReport.at) && Number.isFinite(Date.parse(value.lastReport.at))
      && typeof value.lastReport.excerpt === 'string' && [...value.lastReport.excerpt].length <= 400);
}

export function decodeSessionLinksResult(value: unknown): SessionLinksResultV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'done') return { type: 'done' };
  if (value.type === 'settings' && typeof value.enabled === 'boolean' && typeof value.readOnly === 'boolean') return { type: 'settings', enabled: value.enabled, readOnly: value.readOnly };
  if (value.type === 'links' && text(value.sessionId) && count(value.revision) && Array.isArray(value.chats) && value.chats.every(chat)) {
    return { type: 'links', sessionId: value.sessionId, chats: value.chats, revision: value.revision };
  }
  return undefined;
}

export function decodeSessionLinksChanged(value: unknown): SessionLinksChangedV1 | undefined {
  return isRecord(value) && text(value.sessionId) && count(value.revision) ? { sessionId: value.sessionId, revision: value.revision } : undefined;
}

export class SessionLinksOperationError extends Error {
  constructor(readonly code: SessionLinksErrorCodeV1, message: string) {
    super(message);
    this.name = 'SessionLinksOperationError';
  }
}
function operationError(cause: unknown): SessionLinksOperationError {
  if (cause instanceof SessionLinksOperationError) return cause;
  let value = cause;
  if (typeof value === 'string') { try { value = JSON.parse(value) as unknown; } catch { value = undefined; } }
  return isRecord(value) && oneOf(value.code, errorCodes) && text(value.message)
    ? new SessionLinksOperationError(value.code as SessionLinksErrorCodeV1, value.message)
    : new SessionLinksOperationError('unavailable', 'Linked chats are unavailable right now.');
}

export interface SessionLinksClient {
  request(command: SessionLinksCommandV1): Promise<SessionLinksResultV1>;
  onChanged(handler: (event: SessionLinksChangedV1) => void): Promise<() => void>;
}
export function createSessionLinksClient(invoke: HostInvoke, listen: HostListen): SessionLinksClient {
  return {
    async request(command) {
      try {
        const result = decodeSessionLinksResult(await invoke<unknown>('session_links_command_v1', { command }));
        if (!result || command.op === 'find' && (result.type !== 'links' || result.sessionId !== command.sessionId)
          || (command.op === 'settings' || command.op === 'update') && result.type !== 'settings'
          || ['link', 'unlink', 'send', 'deliver'].includes(command.op) && result.type !== 'done') {
          throw new SessionLinksOperationError('unavailable', 'Linked chats returned an invalid response.');
        }
        return result;
      } catch (cause) { throw operationError(cause); }
    },
    onChanged(handler) {
      return listen<unknown>(SESSION_LINKS_EVENT_V1, payload => {
        const event = decodeSessionLinksChanged(payload);
        if (event) handler(event);
      });
    },
  };
}

export const sessionLinksHost = createSessionLinksClient(hostInvoke, hostListen);
