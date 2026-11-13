import { hostInvoke, type HostInvoke } from './transport';
import { BUILTIN_HARNESSES, type BuiltinHarness } from '../../../../contracts/harness-identity-v3';
import {
  HARNESS_CONNECT_PROTOCOL,
  type HarnessConnectErrorCodeV1,
  type HarnessConnectInfoV1,
} from '../../../../contracts/harness-connect-v1';

/**
 * Typed client for Settings → Harnesses → Connect (`harness_connect_v1`,
 * ADR-054). The WebView sends only a harness name; the host owns the program
 * and its arguments, so no command text ever travels from here. Listing never
 * runs anything. Host messages are never shown: every failure maps to one of
 * the fixed locale keys below.
 */
const COULD_NOT_OPEN = 'Could not open a terminal. Run the command yourself.';

export const HARNESS_CONNECT_ERRORS: Readonly<Record<HarnessConnectErrorCodeV1, string>> = {
  SAFE_MODE: 'Safe mode is on: Nano Desktop starts no agent program.',
  NOT_SUPPORTED: COULD_NOT_OPEN,
  NOT_INSTALLED: COULD_NOT_OPEN,
  NO_TERMINAL: 'A terminal app was not found. Run the command yourself.',
  LAUNCH_FAILED: COULD_NOT_OPEN,
};

export type HarnessConnectFailureCode = HarnessConnectErrorCodeV1 | 'UNAVAILABLE';

export class HarnessConnectError extends Error {
  /** `message` is an English locale key. */
  constructor(readonly code: HarnessConnectFailureCode, message: string) {
    super(message);
    this.name = 'HarnessConnectError';
  }
}

export function harnessConnectError(cause: unknown): HarnessConnectError {
  if (cause instanceof HarnessConnectError) return cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' && Object.hasOwn(HARNESS_CONNECT_ERRORS, cause.code)) {
    const code = cause.code as HarnessConnectErrorCodeV1;
    return new HarnessConnectError(code, HARNESS_CONNECT_ERRORS[code]);
  }
  return new HarnessConnectError('UNAVAILABLE', COULD_NOT_OPEN);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const shortText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);

function isInfo(value: unknown): value is HarnessConnectInfoV1 {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Partial<HarnessConnectInfoV1>;
  return typeof info.harness === 'string' && (BUILTIN_HARNESSES as readonly string[]).includes(info.harness)
    && shortText(info.command, 64)
    && (info.then === undefined || shortText(info.then, 32))
    && typeof info.terminal === 'boolean';
}

export interface HarnessConnectClient {
  /** The harnesses with a terminal sign-in; others are absent. */
  describe(): Promise<readonly HarnessConnectInfoV1[]>;
  /** Asks the host to open its terminal for one harness's own sign-in. */
  openTerminal(harness: BuiltinHarness): Promise<void>;
}

export function createHarnessConnectClient(invoke: HostInvoke): HarnessConnectClient {
  async function run(command: { type: 'describe' } | { type: 'openTerminal'; harness: BuiltinHarness }): Promise<unknown> {
    try {
      return await invoke<unknown>('harness_connect_v1', { command });
    } catch (error) {
      throw harnessConnectError(error);
    }
  }
  const unavailable = () => new HarnessConnectError('UNAVAILABLE', COULD_NOT_OPEN);
  return {
    async describe() {
      const result = await run({ type: 'describe' }) as { protocol?: unknown; type?: unknown; harnesses?: unknown } | null;
      if (result?.protocol !== HARNESS_CONNECT_PROTOCOL || result.type !== 'described' || !Array.isArray(result.harnesses) || !result.harnesses.every(isInfo)) {
        throw unavailable();
      }
      return result.harnesses;
    },
    async openTerminal(harness) {
      const result = await run({ type: 'openTerminal', harness }) as { protocol?: unknown; type?: unknown; harness?: unknown } | null;
      if (result?.protocol !== HARNESS_CONNECT_PROTOCOL || result.type !== 'opened' || result.harness !== harness) throw unavailable();
    },
  };
}

export const harnessConnectHost: HarnessConnectClient = createHarnessConnectClient(hostInvoke);
