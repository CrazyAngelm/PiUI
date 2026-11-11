import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import {
  NANO_ACCOUNT_EVENT_V1,
  NANO_ACCOUNT_PROTOCOL,
  type NanoAccountErrorCodeV1,
  type NanoAccountEventV1,
  type NanoAccountStateV1,
  type NanoAccountStatusV1,
  type NanoEntitlementsV1,
  type NanoLinkV1,
  type NanoModeV1,
  type NanoUsageV1,
} from '../../../../contracts/nano-account-v1';
import { NANO_MODE_IDS } from '../../../../contracts/nano-server-v1';

export type * from '../../../../contracts/nano-account-v1';
export { NANO_ACCOUNT_EVENT_V1, NANO_ACCOUNT_PROTOCOL, NANO_HARNESS, NANO_MODEL_PROVIDER, nanoModeAvailable } from '../../../../contracts/nano-account-v1';
export { NANO_MODE_IDS } from '../../../../contracts/nano-server-v1';

/**
 * Client of Nano account v1 (ADR-047). The Rust host owns every credential and
 * every rule (PKCE sign-in, token refresh, entitlements); this client validates
 * answers and maps typed failures to safe copy. No token, code or server detail
 * ever reaches it, and it never forwards host text.
 *
 * Host commands: `nano_account_status_v1`, `nano_account_sign_in_v1`,
 * `nano_account_cancel_sign_in_v1`, `nano_account_sign_out_v1`,
 * `nano_account_select_workspace_v1`, `nano_account_refresh_v1`,
 * `nano_account_open_link_v1`, `nano_cloud_open_v1`, and `nano_dictation_v1`
 * (`NanoDictationRequest` -> `NanoDictationAnswer`; the host adds it, see
 * {@link NANO_DICTATION_COMMAND}). Requests with arguments travel as
 * `{ request: {...} }`, as in app update v1.
 */
export type NanoAccountErrorCode = NanoAccountErrorCodeV1 | 'unknown';

/** English source strings of the locale catalog. */
export const NANO_ACCOUNT_ERROR_COPY: Readonly<Record<NanoAccountErrorCode, string>> = {
  invalid: 'The Nano request was not valid.',
  'safe-mode': 'Nano account actions are off in safe mode.',
  busy: 'Another Nano account action is still running.',
  offline: 'Could not reach Nano. Check your connection and try again.',
  'unsupported-server': 'This Nano server does not support Nano Desktop yet.',
  'client-too-old': 'This version of Nano Desktop is too old for the Nano server. Update the app to continue.',
  'sign-in-required': 'Sign in to your Nano account to continue.',
  'sign-in-cancelled': 'Sign-in was cancelled.',
  'sign-in-timeout': 'Sign-in took too long and was stopped. Try again.',
  'sign-in-failed': 'Sign-in did not finish. Try again.',
  'device-revoked': 'This device was signed out of your Nano account. Sign in again.',
  'workspace-not-found': 'That workspace is no longer available.',
  'credential-store-failed': 'Nano Desktop could not save your sign-in in the system credential store. You stay signed in until the app closes.',
  'browser-failed': 'Could not open the system browser.',
  'credits-exhausted': 'You are out of Nano credits.',
  'mode-locked': 'This Nano mode is not available to you.',
  'rate-limited': 'Nano is receiving too many requests. Try again in a moment.',
  'feature-unavailable': 'This feature is not available on your plan.',
  unknown: 'The Nano account action could not be completed.',
};

export class NanoAccountOperationError extends Error {
  constructor(readonly code: NanoAccountErrorCode, message: string = NANO_ACCOUNT_ERROR_COPY[code]) {
    super(message);
    this.name = 'NanoAccountOperationError';
  }
}

/** Maps a rejected invoke to a typed error; host details are never forwarded. */
export function nanoAccountError(cause: unknown): NanoAccountOperationError {
  if (cause instanceof NanoAccountOperationError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const code =
    isRecord(value) && typeof value.code === 'string' && value.code !== 'unknown' && Object.hasOwn(NANO_ACCOUNT_ERROR_COPY, value.code)
      ? (value.code as NanoAccountErrorCode)
      : 'unknown';
  return new NanoAccountOperationError(code);
}

const STATES: readonly NanoAccountStateV1[] = ['signed-out', 'signing-in', 'signed-in', 'expired', 'unsupported', 'offline'];
const ERROR_CODES = Object.keys(NANO_ACCOUNT_ERROR_COPY).filter((code) => code !== 'unknown');
const ROLES = ['owner', 'admin', 'member'];
const TIERS = ['mixed', 'free', 'cheap', 'paid'];
const LOCKS = ['plan', 'credits', 'disabled'];
const PLAN_KINDS = ['free', 'trial', 'paid'];
const INPUTS = ['text', 'image'];
const STORES = ['os', 'memory'];
const CAPABILITY_KEYS = ['gateway', 'cloudLaunch', 'deviceCode', 'dictation', 'voice', 'imageGeneration', 'avatars'];
const FEATURE_KEYS = ['localAgent', 'cloud', 'dictation', 'imageGeneration', 'voice', 'avatars'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown): boolean => value === null || typeof value === 'string';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optionalCount = (value: unknown): boolean => value === null || count(value);
// Credits are signed whole numbers (`i64` in the host): an overdrawn balance is negative and still a valid status.
const credit = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const optionalCredit = (value: unknown): boolean => value === null || credit(value);
const oneOf = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);
const allBooleans = (value: unknown, keys: readonly string[]): boolean => isRecord(value) && keys.every((key) => typeof value[key] === 'boolean');

function isMode(value: unknown): value is NanoModeV1 {
  return (
    isRecord(value) &&
    oneOf(value.id, NANO_MODE_IDS) &&
    text(value.name) &&
    oneOf(value.tier, TIERS) &&
    typeof value.available === 'boolean' &&
    // `lockedReason` is set exactly when the mode is not available.
    (value.available ? value.lockedReason === null : oneOf(value.lockedReason, LOCKS)) &&
    optionalText(value.costHint) &&
    optionalCount(value.contextWindow) &&
    optionalCount(value.maxOutputTokens) &&
    Array.isArray(value.input) &&
    value.input.every((entry) => oneOf(entry, INPUTS)) &&
    typeof value.reasoning === 'boolean'
  );
}

function isEntitlements(value: unknown): value is NanoEntitlementsV1 {
  if (!isRecord(value) || !text(value.workspaceId)) return false;
  const { plan, credits, modes, features, limits } = value;
  return (
    isRecord(plan) &&
    text(plan.id) &&
    text(plan.name) &&
    oneOf(plan.kind, PLAN_KINDS) &&
    optionalText(plan.renewsAt) &&
    isRecord(credits) &&
    credit(credits.balance) &&
    optionalCredit(credits.included) &&
    optionalText(credits.periodEndsAt) &&
    Array.isArray(modes) &&
    modes.every(isMode) &&
    allBooleans(features, FEATURE_KEYS) &&
    isRecord(limits) &&
    count(limits.maxConcurrentRequests) &&
    count(limits.maxRequestBytes) &&
    count(limits.dictationMaxBytes)
  );
}

function isUsage(value: unknown): value is NanoUsageV1 {
  return (
    isRecord(value) &&
    text(value.workspaceId) &&
    text(value.periodStart) &&
    text(value.periodEnd) &&
    credit(value.creditsUsed) &&
    credit(value.creditsRemaining) &&
    Array.isArray(value.byMode) &&
    value.byMode.every((row) => isRecord(row) && oneOf(row.mode, NANO_MODE_IDS) && credit(row.credits) && count(row.requests))
  );
}

/** The status exactly as the contract describes it, or undefined. */
export function decodeNanoAccountStatus(value: unknown): NanoAccountStatusV1 | undefined {
  if (!isRecord(value) || value.protocol !== NANO_ACCOUNT_PROTOCOL || !count(value.revision) || !oneOf(value.state, STATES)) return undefined;
  const { server, user, device, workspaces } = value;
  if (!isRecord(server) || !text(server.origin) || typeof server.development !== 'boolean') return undefined;
  if (!(user === null || (isRecord(user) && text(user.displayName) && optionalText(user.email)))) return undefined;
  if (!(device === null || (isRecord(device) && text(device.id) && text(device.name)))) return undefined;
  if (
    !Array.isArray(workspaces) ||
    !workspaces.every((entry) => isRecord(entry) && text(entry.id) && text(entry.name) && oneOf(entry.role, ROLES))
  ) {
    return undefined;
  }
  if (
    !optionalText(value.selectedWorkspaceId) ||
    !(value.entitlements === null || isEntitlements(value.entitlements)) ||
    !(value.usage === null || isUsage(value.usage)) ||
    !(value.capabilities === null || allBooleans(value.capabilities, CAPABILITY_KEYS)) ||
    !(value.credentialStore === null || oneOf(value.credentialStore, STORES)) ||
    typeof value.busy !== 'boolean' ||
    !(value.lastError === null || oneOf(value.lastError, ERROR_CODES))
  ) {
    return undefined;
  }
  return value as unknown as NanoAccountStatusV1;
}

export function decodeNanoAccountEvent(value: unknown): NanoAccountEventV1 | undefined {
  if (!isRecord(value) || value.type !== 'status') return undefined;
  const status = decodeNanoAccountStatus(value.status);
  return status ? { type: 'status', status } : undefined;
}

/** `{ text }` of a dictation, or undefined. */
export function decodeNanoDictation(value: unknown): NanoDictationAnswer | undefined {
  return isRecord(value) && text(value.text) ? { text: value.text } : undefined;
}

/** `nano_dictation_v1`: one recorded clip; the host sends it to the Nano server and keeps nothing. */
export const NANO_DICTATION_COMMAND = 'nano_dictation_v1' as const;

export interface NanoDictationRequest {
  readonly audioBase64: string;
  readonly mimeType: string;
}

export interface NanoDictationAnswer {
  readonly text: string;
}

export interface NanoAccountClient {
  status(): Promise<NanoAccountStatusV1>;
  /** Answers at once with `signing-in`; the outcome arrives as an event. */
  signIn(): Promise<NanoAccountStatusV1>;
  cancelSignIn(): Promise<NanoAccountStatusV1>;
  signOut(): Promise<NanoAccountStatusV1>;
  selectWorkspace(workspaceId: string): Promise<NanoAccountStatusV1>;
  refresh(): Promise<NanoAccountStatusV1>;
  /** Opens a page of the Nano site in the system browser. */
  openLink(link: NanoLinkV1): Promise<NanoAccountStatusV1>;
  /** Opens the person's server agent in the Nano Cloud window. */
  openCloud(): Promise<void>;
  dictate(request: NanoDictationRequest): Promise<NanoDictationAnswer>;
  subscribe(handler: (event: NanoAccountEventV1) => void): Promise<() => void>;
}

export function createNanoAccountClient(invoke: HostInvoke, listen: HostListen): NanoAccountClient {
  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    try {
      return await invoke<unknown>(command, args);
    } catch (error) {
      throw nanoAccountError(error);
    }
  }
  async function status(command: string, args?: Record<string, unknown>): Promise<NanoAccountStatusV1> {
    const decoded = decodeNanoAccountStatus(await call(command, args));
    if (!decoded) throw new NanoAccountOperationError('unknown');
    return decoded;
  }
  return {
    status: () => status('nano_account_status_v1'),
    signIn: () => status('nano_account_sign_in_v1'),
    cancelSignIn: () => status('nano_account_cancel_sign_in_v1'),
    signOut: () => status('nano_account_sign_out_v1'),
    selectWorkspace: (workspaceId) => status('nano_account_select_workspace_v1', { request: { workspaceId } }),
    refresh: () => status('nano_account_refresh_v1'),
    openLink: (link) => status('nano_account_open_link_v1', { request: { link } }),
    openCloud: async () => {
      await call('nano_cloud_open_v1');
    },
    dictate: async (request) => {
      const decoded = decodeNanoDictation(await call(NANO_DICTATION_COMMAND, { request }));
      if (!decoded) throw new NanoAccountOperationError('unknown');
      return decoded;
    },
    subscribe: (handler) =>
      listen<unknown>(NANO_ACCOUNT_EVENT_V1, (payload) => {
        const event = decodeNanoAccountEvent(payload);
        if (event) handler(event);
      }),
  };
}

export const nanoAccountHost: NanoAccountClient = createNanoAccountClient(hostInvoke, hostListen);
