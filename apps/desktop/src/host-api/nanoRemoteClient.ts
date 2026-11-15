import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import {
  NANO_REMOTE_EVENT_V1,
  NANO_REMOTE_PROTOCOL,
  type NanoRemoteBrowserV1,
  type NanoRemoteDecisionV1,
  type NanoRemoteErrorCodeV1,
  type NanoRemoteEventV1,
  type NanoRemoteGrantV1,
  type NanoRemoteLinkStateV1,
  type NanoRemotePairingV1,
  type NanoRemoteStatusV1,
  type NanoRemoteUnavailableV1,
  type NanoRemoteViewerV1,
} from '../../../../contracts/nano-remote-v1';

export type * from '../../../../contracts/nano-remote-v1';
export { NANO_REMOTE_EVENT_V1, NANO_REMOTE_PROTOCOL } from '../../../../contracts/nano-remote-v1';

/**
 * Client of Nano remote access v1 (ADR-062). The Rust host owns the link, the
 * pairing and every grant; this client validates answers and maps typed
 * failures to safe copy. No token, key or server detail ever reaches it, and
 * it never forwards host text.
 *
 * Host commands: `nano_remote_status_v1`, `nano_remote_set_enabled_v1`,
 * `nano_remote_decide_v1`, `nano_remote_kick_v1` and `nano_remote_forget_v1`;
 * requests travel as `{ request: {...} }` and every answer is the status. None
 * of them can be called from a remote browser, and this client is inert there.
 */
export type NanoRemoteClientErrorCode = NanoRemoteErrorCodeV1 | 'unknown';

/** English source strings of the locale catalog. */
export const NANO_REMOTE_ERROR_COPY: Readonly<Record<NanoRemoteClientErrorCode, string>> = {
  invalid: 'The remote access request was not valid.',
  'safe-mode': 'Not available in safe mode.',
  'sign-in-required': 'Sign in to use remote access.',
  'unsupported-server': 'This Nano server does not support remote access yet.',
  'not-found': 'That request or browser is no longer available.',
  limit: 'This computer already remembers as many browsers as it can. Remove one first.',
  io: 'Nano Desktop could not save the remote access settings.',
  unknown: 'The remote access action could not be completed.',
};

export class NanoRemoteOperationError extends Error {
  constructor(readonly code: NanoRemoteClientErrorCode, message: string = NANO_REMOTE_ERROR_COPY[code]) {
    super(message);
    this.name = 'NanoRemoteOperationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps a rejected invoke to a typed error; host details are never forwarded. */
export function nanoRemoteError(cause: unknown): NanoRemoteOperationError {
  if (cause instanceof NanoRemoteOperationError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const code =
    isRecord(value) && typeof value.code === 'string' && value.code !== 'unknown' && Object.hasOwn(NANO_REMOTE_ERROR_COPY, value.code)
      ? (value.code as NanoRemoteClientErrorCode)
      : 'unknown';
  return new NanoRemoteOperationError(code);
}

const LINKS: readonly NanoRemoteLinkStateV1[] = ['off', 'connecting', 'online', 'retrying', 'refused'];
const UNAVAILABLE: readonly NanoRemoteUnavailableV1[] = ['safe-mode', 'signed-out', 'unsupported-server'];
const GRANTS: readonly NanoRemoteGrantV1[] = ['once', 'always'];

const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown): boolean => value === null || typeof value === 'string';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === 'string' && (allowed as readonly string[]).includes(value);

function isViewer(value: unknown): value is NanoRemoteViewerV1 {
  return isRecord(value) && text(value.id) && text(value.label) && text(value.fingerprint) && oneOf(value.grant, GRANTS) && text(value.connectedAt);
}

function isPairing(value: unknown): value is NanoRemotePairingV1 {
  return isRecord(value) && text(value.requestId) && text(value.label) && text(value.code) && /^\d{6}$/.test(value.code) && text(value.fingerprint) && text(value.expiresAt);
}

function isBrowser(value: unknown): value is NanoRemoteBrowserV1 {
  return isRecord(value) && text(value.id) && text(value.label) && text(value.fingerprint) && text(value.createdAt) && optionalText(value.lastUsedAt);
}

/** The status exactly as the contract describes it, or undefined. */
export function decodeNanoRemoteStatus(value: unknown): NanoRemoteStatusV1 | undefined {
  if (!isRecord(value) || value.protocol !== NANO_REMOTE_PROTOCOL || !count(value.revision)) return undefined;
  if (!(value.unavailable === null || oneOf(value.unavailable, UNAVAILABLE))) return undefined;
  if (typeof value.enabled !== 'boolean' || !oneOf(value.link, LINKS)) return undefined;
  if (!Array.isArray(value.viewers) || !value.viewers.every(isViewer)) return undefined;
  if (!(value.pending === null || isPairing(value.pending))) return undefined;
  if (!Array.isArray(value.browsers) || !value.browsers.every(isBrowser)) return undefined;
  return value as unknown as NanoRemoteStatusV1;
}

export function decodeNanoRemoteEvent(value: unknown): NanoRemoteEventV1 | undefined {
  if (!isRecord(value) || value.type !== 'status') return undefined;
  const status = decodeNanoRemoteStatus(value.status);
  return status ? { type: 'status', status } : undefined;
}

export interface NanoRemoteClient {
  /** Local only: reads the host's state without any network call; also answers in safe mode. */
  status(): Promise<NanoRemoteStatusV1>;
  setEnabled(enabled: boolean): Promise<NanoRemoteStatusV1>;
  decide(requestId: string, decision: NanoRemoteDecisionV1): Promise<NanoRemoteStatusV1>;
  kick(viewerId: string): Promise<NanoRemoteStatusV1>;
  forget(browserId: string): Promise<NanoRemoteStatusV1>;
  listen(handler: (event: NanoRemoteEventV1) => void): Promise<() => void>;
}

export function createNanoRemoteClient(invoke: HostInvoke, listen: HostListen): NanoRemoteClient {
  async function status(command: string, args?: Record<string, unknown>): Promise<NanoRemoteStatusV1> {
    let answer: unknown;
    try {
      answer = await invoke<unknown>(command, args);
    } catch (error) {
      throw nanoRemoteError(error);
    }
    const decoded = decodeNanoRemoteStatus(answer);
    if (!decoded) throw new NanoRemoteOperationError('unknown');
    return decoded;
  }
  return {
    status: () => status('nano_remote_status_v1'),
    setEnabled: (enabled) => status('nano_remote_set_enabled_v1', { request: { enabled } }),
    decide: (requestId, decision) => status('nano_remote_decide_v1', { request: { requestId, decision } }),
    kick: (viewerId) => status('nano_remote_kick_v1', { request: { viewerId } }),
    forget: (browserId) => status('nano_remote_forget_v1', { request: { browserId } }),
    listen: (handler) =>
      listen<unknown>(NANO_REMOTE_EVENT_V1, (payload) => {
        const event = decodeNanoRemoteEvent(payload);
        if (event) handler(event);
      }),
  };
}

export const nanoRemoteHost: NanoRemoteClient = createNanoRemoteClient(hostInvoke, hostListen);
