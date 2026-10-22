import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import {
  FUSION_CHANGED_EVENT_V1,
  FUSION_PROTOCOL,
  type FusionChangedEventV1,
  type FusionCommandV1,
  type FusionResultV1,
  type FusionStateV1,
} from '../../../../contracts/fusion-v1';
import { isRecord } from './sessionToolErrors';

export type * from '../../../../contracts/fusion-v1';
export {
  DEFAULT_FUSION_OPTIONS,
  DEFAULT_WAIT_SECONDS,
  FUSION_CHANGED_EVENT_V1,
  FUSION_PROTOCOL,
  MAX_WAIT_SECONDS,
} from '../../../../contracts/fusion-v1';

/**
 * Client of `fusion_command_v1` (ADR-043, docs/FUSION.md): the person's side
 * of a Fusion pair. The lead model never uses it; it acts through the host
 * `sidekick` tool. Host error text never reaches the UI: each code maps to a
 * locale key (`fusion.error.*`).
 */
export const FUSION_ERROR_CODES = [
  'SAFE_MODE',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'CONFLICT',
  'NOT_SUPPORTED',
  'IO_ERROR',
  'SIGN_IN_REQUIRED',
  'unknown',
] as const;

export type FusionErrorCode = (typeof FUSION_ERROR_CODES)[number];

export class FusionError extends Error {
  constructor(readonly code: FusionErrorCode) {
    super(`fusion:${code}`);
    this.name = 'FusionError';
  }
}

/** Maps a rejected invoke (object or JSON string) to a typed error. */
export function fusionError(cause: unknown): FusionError {
  if (cause instanceof FusionError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const code = isRecord(value) && typeof value.code === 'string' ? value.code : 'unknown';
  return new FusionError((FUSION_ERROR_CODES as readonly string[]).includes(code) ? (code as FusionErrorCode) : 'unknown');
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isFusionState(value: unknown): value is FusionStateV1 {
  return isRecord(value)
    && value.protocol === FUSION_PROTOCOL
    && text(value.leadSessionId)
    && text(value.workspaceId)
    && isRecord(value.pair)
    && isRecord(value.pair.lead)
    && isRecord(value.pair.sidekick)
    && isRecord(value.pair.options)
    && typeof value.sidekick === 'string'
    && Array.isArray(value.sessions)
    && Array.isArray(value.briefs)
    && value.briefs.every((brief) => isRecord(brief) && text(brief.briefId) && Array.isArray(brief.rounds))
    && isRecord(value.stats)
    && count(value.revision);
}

export function decodeFusionResult(value: unknown): FusionResultV1 | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case 'created':
      return text(value.leadSessionId) && isFusionState(value.state) ? (value as unknown as FusionResultV1) : undefined;
    case 'state':
      return isFusionState(value.state) ? (value as unknown as FusionResultV1) : undefined;
    case 'pairCheck':
      if (value.ok === true) return { type: 'pairCheck', ok: true };
      return value.ok === false && text(value.refusal) && (value.role === 'lead' || value.role === 'sidekick')
        ? (value as unknown as FusionResultV1)
        : undefined;
    case 'membership':
      return value.role === null || value.role === undefined
        ? { type: 'membership', role: null }
        : (value.role === 'lead' || value.role === 'sidekick') && text(value.leadSessionId)
          ? (value as unknown as FusionResultV1)
          : undefined;
    case 'accepted':
      return { type: 'accepted' };
    default:
      return undefined;
  }
}

export function decodeFusionChanged(value: unknown): FusionChangedEventV1 | undefined {
  if (!isRecord(value) || value.protocol !== FUSION_PROTOCOL || !text(value.leadSessionId) || !count(value.revision)) return undefined;
  return value as unknown as FusionChangedEventV1;
}

export interface FusionClient {
  request(command: FusionCommandV1): Promise<FusionResultV1>;
  /** Subscribes to `piui://fusion-changed-v1`; malformed payloads are dropped. */
  onChanged(handler: (event: FusionChangedEventV1) => void): Promise<() => void>;
}

export function createFusionClient(invoke: HostInvoke, listen: HostListen): FusionClient {
  return {
    async request(command) {
      let result: unknown;
      try {
        result = await invoke<unknown>('fusion_command_v1', { command });
      } catch (error) {
        throw fusionError(error);
      }
      const decoded = decodeFusionResult(result);
      if (decoded === undefined) throw new FusionError('unknown');
      return decoded;
    },
    onChanged(handler) {
      return listen<unknown>(FUSION_CHANGED_EVENT_V1, (payload) => {
        const event = decodeFusionChanged(payload);
        if (event !== undefined) handler(event);
      });
    },
  };
}

export const fusionHost: FusionClient = createFusionClient(
  (command, args) => hostInvoke(command, args),
  (channel, handler) => hostListen(channel, handler),
);
