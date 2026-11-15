import type { AttentionErrorCodeV1, AttentionSetRequestV1 } from '../../../../contracts/attention-v1';
import { ATTENTION_MAX_COUNT } from '../../../../contracts/attention-v1';
import { hostInvoke, type HostInvoke } from './transport';

export type * from '../../../../contracts/attention-v1';
export { ATTENTION_MAX_COUNT };

/**
 * Client of attention v1 (ADR-065): the number on the taskbar button and its
 * flash. A report never throws; a host that refuses or lacks the command (an
 * older build, a browser without the Lab fake) leaves the badge as it was.
 */
export interface AttentionClient {
  /** Reports the badge; resolves to the code of a refusal, or undefined when it was applied. */
  set(request: AttentionSetRequestV1): Promise<AttentionErrorCodeV1 | 'unknown' | undefined>;
}

function refusalCode(cause: unknown): AttentionErrorCodeV1 | 'unknown' {
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return code === 'unavailable' || code === 'failed' ? code : 'unknown';
}

export function createAttentionClient(invoke: HostInvoke): AttentionClient {
  return {
    set: async (request) => {
      const count = Number.isFinite(request.count) ? Math.min(Math.max(Math.trunc(request.count), 0), ATTENTION_MAX_COUNT) : 0;
      try {
        await invoke<unknown>('attention_set_v1', { request: { count, flash: request.flash === true } });
        return undefined;
      } catch (cause) {
        return refusalCode(cause);
      }
    },
  };
}

export const attentionHost: AttentionClient = createAttentionClient(hostInvoke);
