import {
  HARNESS_CONNECT_PROTOCOL,
  type HarnessConnectCommandV1,
  type HarnessConnectErrorCodeV1,
  type HarnessConnectInfoV1,
  type HarnessConnectResultV1,
} from '../../../../../contracts/harness-connect-v1';
import { isBuiltinHarness, type BuiltinHarness } from '../../../../../contracts/harness-identity-v3';
import type { HostErrorPayload } from './labErrors';
import type { LabHandlers } from './labHandlers';
import type { LabState } from './labState';

/**
 * UI Lab fake of `harness_connect_v1` (ADR-054). Like the host it knows only
 * three harnesses with a terminal sign-in (a fixed table, not the request);
 * nothing is opened. Safe mode describes `terminal: false` and refuses
 * `openTerminal`; a harness that is not installed cannot be opened either.
 */
const ENTRIES: readonly { harness: BuiltinHarness; command: string; then?: string }[] = [
  { harness: 'pi', command: 'pi', then: '/login' },
  { harness: 'codex', command: 'codex login' },
  { harness: 'claude-code', command: 'claude', then: '/login' },
];

const MESSAGES: Readonly<Record<HarnessConnectErrorCodeV1, string>> = {
  SAFE_MODE: 'Safe mode is on: Nano Desktop starts no agent program.',
  NOT_SUPPORTED: 'This harness has no terminal sign-in.',
  NOT_INSTALLED: 'The harness is not installed.',
  NO_TERMINAL: 'A terminal app was not found.',
  LAUNCH_FAILED: 'The terminal did not open.',
};

function failure(code: HarnessConnectErrorCodeV1): HostErrorPayload {
  return { code, message: MESSAGES[code], recoverable: true };
}

export function harnessConnectHandlers(state: LabState): LabHandlers {
  const installed = (harness: BuiltinHarness): boolean => state.harnesses.some((summary) => summary.kind === harness && summary.installed);
  return {
    harness_connect_v1: (args): HarnessConnectResultV1 => {
      const command = args.command as HarnessConnectCommandV1 | undefined;
      if (command?.type === 'describe') {
        const harnesses: HarnessConnectInfoV1[] = ENTRIES.map((entry) => ({
          harness: entry.harness,
          command: entry.command,
          ...(entry.then === undefined ? {} : { then: entry.then }),
          terminal: !state.safeMode && installed(entry.harness),
        }));
        return { protocol: HARNESS_CONNECT_PROTOCOL, type: 'described', harnesses };
      }
      if (command?.type === 'openTerminal') {
        const harness = command.harness;
        if (state.safeMode) throw failure('SAFE_MODE');
        if (typeof harness !== 'string' || !isBuiltinHarness(harness) || !ENTRIES.some((entry) => entry.harness === harness)) throw failure('NOT_SUPPORTED');
        if (!installed(harness)) throw failure('NOT_INSTALLED');
        return { protocol: HARNESS_CONNECT_PROTOCOL, type: 'opened', harness };
      }
      throw failure('NOT_SUPPORTED');
    },
  };
}
