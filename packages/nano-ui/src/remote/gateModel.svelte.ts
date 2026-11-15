import type { GateView } from './gateView';
import type { GateLanguage } from './launch';

/** State of the gate screen. `main.ts` writes it; `RemoteGate.svelte` only reads it. */
export interface GateModel {
  view: GateView;
  language: GateLanguage;
  /** True when this browser could not store its key, so each connection needs approval. */
  memoryKey: boolean;
  /** Seconds until an automatic reload, counting down; `undefined` when the person must press Reconnect. */
  retryIn: number | undefined;
}

export const gateModel: GateModel = $state({
  view: { kind: 'connecting' },
  language: 'ru',
  memoryKey: false,
  retryIn: undefined,
});
