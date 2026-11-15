import type { NanoRemoteDeniedReasonV1 } from '../../../../contracts/nano-remote-v1';
import type { ClosedReason, ConnectionState } from './connection';

/** What the gate shows before and after the shell. */
export type GateView =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'approval'; readonly code: string; readonly deviceName: string }
  | { readonly kind: 'denied'; readonly reason: NanoRemoteDeniedReasonV1 }
  | { readonly kind: 'offline' }
  | { readonly kind: 'versions' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'disconnected'; readonly reason: Exclude<ClosedReason, 'local' | 'denied' | 'device-offline'> };

/** The gate view of a connection state; `undefined` when the shell shows (or this side closed on purpose). */
export function viewForState(state: ConnectionState): GateView | undefined {
  switch (state.kind) {
    case 'connecting':
      return { kind: 'connecting' };
    case 'approval':
      return { kind: 'approval', code: state.code, deviceName: state.deviceName };
    case 'denied':
      return { kind: 'denied', reason: state.reason };
    case 'welcomed':
      return undefined;
    case 'closed':
      if (state.reason === 'local') return undefined;
      if (state.reason === 'denied') return { kind: 'denied', reason: 'denied' };
      if (state.reason === 'device-offline') return { kind: 'offline' };
      return { kind: 'disconnected', reason: state.reason };
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
