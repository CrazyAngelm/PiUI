import { hostInvoke, hostListen } from './transport';
import {
  ORCHESTRATION_AUTOMATIONS_EVENT_V7,
  type AutomationsStateRequest,
  type AutomationsStateV7,
  type OrchestrationAutomationCommandsV7,
  type OrchestrationAutomationsChangedEventV7,
  type SetAutomationsPausedRequest,
} from '../../../../contracts/orchestration-host-v7';
import { orchestrationError } from './orchestrationClient';

export { ORCHESTRATION_AUTOMATIONS_EVENT_V7 };
export type { AutomationsStateV7, OrchestrationAutomationsChangedEventV7 };

/**
 * The global "pause all automations" switch (orchestration host v7.2). It is
 * not scoped to a project; the tray menu flips the same durable switch.
 */
export interface AutomationsClient {
  state(): Promise<AutomationsStateV7>;
  setPaused(paused: boolean): Promise<AutomationsStateV7>;
  listen(handler: (event: OrchestrationAutomationsChangedEventV7) => void): Promise<() => void>;
}

export type AutomationsRoute = keyof OrchestrationAutomationCommandsV7;
export type AutomationsInvoke = <T>(
  route: AutomationsRoute,
  args: { request: AutomationsStateRequest | SetAutomationsPausedRequest },
) => Promise<T>;
export type AutomationsSubscribe = (handler: (payload: unknown) => void) => Promise<() => void>;

/** Only the versioned scalar event crosses this boundary. */
export function automationsChanged(payload: unknown): OrchestrationAutomationsChangedEventV7 | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (!('protocol' in payload) || payload.protocol !== 7 || !('type' in payload) || payload.type !== 'automationsChanged') return undefined;
  if (!('paused' in payload) || typeof payload.paused !== 'boolean') return undefined;
  return { protocol: 7, type: 'automationsChanged', paused: payload.paused };
}

function stateOf(value: unknown): AutomationsStateV7 {
  if (typeof value === 'object' && value !== null && 'paused' in value && typeof value.paused === 'boolean') {
    return { paused: value.paused };
  }
  throw orchestrationError({ code: 'io' });
}

export function createAutomationsClient(invoke: AutomationsInvoke, subscribe: AutomationsSubscribe): AutomationsClient {
  async function call(route: AutomationsRoute, request: AutomationsStateRequest | SetAutomationsPausedRequest): Promise<AutomationsStateV7> {
    let result: unknown;
    try {
      result = await invoke<unknown>(route, { request });
    } catch (error) {
      throw orchestrationError(error);
    }
    return stateOf(result);
  }
  return {
    state: () => call('orchestration_automations_v7', {}),
    setPaused: (paused) => call('orchestration_set_automations_paused_v7', { paused }),
    async listen(handler) {
      try {
        return await subscribe((payload) => {
          const event = automationsChanged(payload);
          if (event !== undefined) handler(event);
        });
      } catch (error) {
        throw orchestrationError(error);
      }
    },
  };
}

export const automationsHost: AutomationsClient = createAutomationsClient(
  (route, args) => hostInvoke(route, args),
  (handler) => hostListen<unknown>(ORCHESTRATION_AUTOMATIONS_EVENT_V7, handler),
);
