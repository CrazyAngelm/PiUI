import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import {
  HARNESS_REGISTRY_EVENT_V1,
  HARNESS_REGISTRY_PROTOCOL,
  type HarnessRegistryChangedV1,
  type HarnessRegistryCommandV1,
  type HarnessRegistryErrorCode,
  type HarnessRegistryV1,
} from '../../../../contracts/harness-registry-v1';

/**
 * Typed client for Settings → Harnesses (`harness_registry_v1`, ADR-034).
 * Listing never runs an agent. Host messages are fixed English locale keys;
 * anything unexpected becomes a generic, translatable failure, so no native
 * output reaches the UI through an error.
 */
const REGISTRY_CODES: ReadonlySet<string> = new Set<HarnessRegistryErrorCode>([
  'SAFE_MODE', 'CONFLICT', 'INVALID_DESCRIPTOR', 'DUPLICATE', 'NOT_FOUND', 'BUILT_IN',
  'TRUST_CHANGED', 'NOT_INSTALLED', 'NOTHING_TO_CONFIRM', 'LIMIT', 'IO_ERROR',
]);

const UNAVAILABLE_MESSAGE = 'PiUI could not read the harness list.';
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type HarnessRegistryFailureCode = HarnessRegistryErrorCode | 'UNAVAILABLE';

export class HarnessRegistryError extends Error {
  constructor(readonly code: HarnessRegistryFailureCode, message: string) {
    super(message);
    this.name = 'HarnessRegistryError';
  }
}

export function harnessRegistryError(cause: unknown): HarnessRegistryError {
  if (cause instanceof HarnessRegistryError) return cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' && REGISTRY_CODES.has(cause.code)) {
    const message = 'message' in cause && typeof cause.message === 'string' && cause.message.length <= 300 && !CONTROL.test(cause.message)
      ? cause.message
      : UNAVAILABLE_MESSAGE;
    return new HarnessRegistryError(cause.code as HarnessRegistryErrorCode, message);
  }
  return new HarnessRegistryError('UNAVAILABLE', UNAVAILABLE_MESSAGE);
}

function isRegistry(value: unknown): value is HarnessRegistryV1 {
  if (typeof value !== 'object' || value === null) return false;
  const registry = value as Partial<HarnessRegistryV1>;
  return registry.protocol === HARNESS_REGISTRY_PROTOCOL
    && typeof registry.revision === 'number' && Number.isSafeInteger(registry.revision) && registry.revision >= 0
    && typeof registry.safeMode === 'boolean'
    && typeof registry.checked === 'boolean'
    && Array.isArray(registry.harnesses)
    && Array.isArray(registry.agents);
}

function isChange(value: unknown): value is HarnessRegistryChangedV1 {
  if (typeof value !== 'object' || value === null) return false;
  const change = value as Partial<HarnessRegistryChangedV1>;
  return change.protocol === HARNESS_REGISTRY_PROTOCOL && typeof change.revision === 'number' && Number.isSafeInteger(change.revision);
}

export interface HarnessRegistryClient {
  run(command: HarnessRegistryCommandV1): Promise<HarnessRegistryV1>;
  /** Discovery finished or the registry changed: list again. */
  listen(handler: (change: HarnessRegistryChangedV1) => void): Promise<() => void>;
}

export function createHarnessRegistryClient(invoke: HostInvoke, listen: HostListen): HarnessRegistryClient {
  return {
    async run(command) {
      let result: unknown;
      try {
        result = await invoke<unknown>('harness_registry_v1', { command });
      } catch (error) {
        throw harnessRegistryError(error);
      }
      if (!isRegistry(result)) throw new HarnessRegistryError('UNAVAILABLE', UNAVAILABLE_MESSAGE);
      return result;
    },
    listen(handler) {
      return listen<unknown>(HARNESS_REGISTRY_EVENT_V1, (payload) => {
        if (isChange(payload)) handler(payload);
      });
    },
  };
}

export const harnessRegistryHost: HarnessRegistryClient = createHarnessRegistryClient(hostInvoke, hostListen);
