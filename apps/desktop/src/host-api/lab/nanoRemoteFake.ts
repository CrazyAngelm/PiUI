import fixture from '../../../../../contracts/fixtures/nano-remote-v1.json';
import { NANO_ACCOUNT_EVENT_V1, type NanoAccountStatusV1 } from '../../../../../contracts/nano-account-v1';
import {
  NANO_REMOTE_EVENT_V1,
  NANO_REMOTE_LIMITS,
  type NanoRemoteBrowserV1,
  type NanoRemoteDecisionV1,
  type NanoRemoteErrorCodeV1,
  type NanoRemotePairingV1,
  type NanoRemoteStatusV1,
  type NanoRemoteUnavailableV1,
  type NanoRemoteViewerV1,
} from '../../../../../contracts/nano-remote-v1';
import type { LabEventBus } from './labBus';
import type { LabClock } from './labClock';
import type { LabHandlers } from './labHandlers';
import { boolean, decodeArgument, enumOf, object, string } from './labSchema';

/**
 * Remote access v1 in the UI Lab (ADR-062). Nothing leaves the browser: no link
 * is opened and no browser connects. The fake answers the five desktop commands
 * with the host's shapes and emits `piui://nano-remote-v1` after each change.
 * Pick a state with `?remote=`:
 *
 * - `off` (default): the switch is off;
 * - `on`: remote access is on and waiting for connections;
 * - `pending`: a browser waits for a decision, with the fixture's code;
 * - `viewer`: a paired browser is connected now;
 * - `unsupported`: the Nano server does not offer remote access.
 *
 * The account decides the rest, as in the host: safe mode and a signed-out
 * account make the switch unavailable, and a safe-mode host refuses every
 * command but the status and turning the switch off.
 */
export const LAB_REMOTE_SCENARIOS = ['off', 'on', 'pending', 'viewer', 'unsupported'] as const;
export type LabRemoteScenario = (typeof LAB_REMOTE_SCENARIOS)[number];

/** The simulated delay between turning the switch on and the link being online. */
export const LAB_REMOTE_CONNECT_MS = 600;

export function remoteScenarioFromSearch(search: string): LabRemoteScenario {
  const requested = new URLSearchParams(search).get('remote');
  return LAB_REMOTE_SCENARIOS.find((name) => name === requested) ?? 'off';
}

const VIEWER: NanoRemoteViewerV1 = fixture.statusViewer.viewers[0] as NanoRemoteViewerV1;
const BROWSER: NanoRemoteBrowserV1 = fixture.statusViewer.browsers[0] as NanoRemoteBrowserV1;
const PENDING = fixture.statusPending.pending;

const refusal = (code: NanoRemoteErrorCodeV1): { readonly code: NanoRemoteErrorCodeV1 } => ({ code });

/** Why the switch cannot be turned on now (the host's `unavailable`), or null. */
export function labRemoteUnavailable(account: NanoAccountStatusV1, safeMode: boolean, scenario: LabRemoteScenario): NanoRemoteUnavailableV1 | null {
  if (safeMode) return 'safe-mode';
  if (account.state !== 'signed-in' && account.state !== 'offline') return 'signed-out';
  return scenario === 'unsupported' ? 'unsupported-server' : null;
}

/** The fake remote access: its host handlers and its current status. */
export interface LabNanoRemote {
  readonly handlers: LabHandlers;
  status(): NanoRemoteStatusV1;
}

export function createLabNanoRemote(
  scenario: LabRemoteScenario,
  bus: LabEventBus,
  clock: LabClock,
  account: () => NanoAccountStatusV1,
  safeMode: boolean = false,
): LabNanoRemote {
  let revision = 1;
  let enabled = !safeMode && (scenario === 'on' || scenario === 'pending' || scenario === 'viewer');
  let online = enabled;
  let viewers: readonly NanoRemoteViewerV1[] = !safeMode && scenario === 'viewer' ? [VIEWER] : [];
  let browsers: readonly NanoRemoteBrowserV1[] = !safeMode && scenario === 'viewer' ? [BROWSER] : [];
  let pending: NanoRemotePairingV1 | null = !safeMode && scenario === 'pending' ? pairing() : null;
  let cancelConnect: (() => void) | undefined;
  let lastKey = '';

  function pairing(): NanoRemotePairingV1 {
    return { ...PENDING, expiresAt: new Date(clock.now() + NANO_REMOTE_LIMITS.pairingSeconds * 1000).toISOString().replace('.000Z', 'Z') };
  }

  const unavailable = (): NanoRemoteUnavailableV1 | null => labRemoteUnavailable(account(), safeMode, scenario);

  /** Like the host's supervisor: an unusable account has no link, no viewer and no pending request. */
  function status(): NanoRemoteStatusV1 {
    const reason = unavailable();
    const usable = reason === null;
    return {
      protocol: 1,
      revision,
      unavailable: reason,
      enabled,
      link: usable && enabled ? (online ? 'online' : 'connecting') : 'off',
      viewers: usable && enabled ? viewers : [],
      pending: usable && enabled ? pending : null,
      browsers: usable ? browsers : [],
    };
  }

  const key = (value: NanoRemoteStatusV1): string => JSON.stringify({ ...value, revision: 0 });
  const publish = (): NanoRemoteStatusV1 => {
    revision += 1;
    const next = status();
    lastKey = key(next);
    bus.emit(NANO_REMOTE_EVENT_V1, { type: 'status', status: next });
    return next;
  };

  // The account's state (sign-out, a lapsed device) changes what the switch may do.
  bus.on(NANO_ACCOUNT_EVENT_V1, () => {
    if (key(status()) !== lastKey) publish();
  });
  lastKey = key(status());

  const requireLive = (): void => {
    if (safeMode) throw refusal('safe-mode');
  };

  const handlers: LabHandlers = {
    nano_remote_status_v1: () => status(),
    nano_remote_set_enabled_v1: (args) => {
      const request = decodeArgument<{ enabled: boolean }>(args, 'request', object({ enabled: boolean }));
      if (request.enabled) {
        const reason = unavailable();
        if (reason === 'safe-mode') throw refusal('safe-mode');
        if (reason === 'signed-out') throw refusal('sign-in-required');
        if (reason === 'unsupported-server') throw refusal('unsupported-server');
        if (enabled) return status();
        enabled = true;
        online = false;
        cancelConnect?.();
        cancelConnect = clock.after(LAB_REMOTE_CONNECT_MS, () => {
          cancelConnect = undefined;
          online = true;
          publish();
        });
        return publish();
      }
      // Turning off always works: the browsers connected now are told and dropped.
      cancelConnect?.();
      cancelConnect = undefined;
      enabled = false;
      online = false;
      viewers = [];
      pending = null;
      return publish();
    },
    nano_remote_decide_v1: (args) => {
      const request = decodeArgument<{ requestId: string; decision: NanoRemoteDecisionV1 }>(
        args,
        'request',
        object({ requestId: string, decision: enumOf(['deny', 'once', 'always']) }),
      );
      requireLive();
      if (pending === null || pending.requestId !== request.requestId) throw refusal('not-found');
      const waiting = pending;
      if (request.decision === 'always' && browsers.length >= NANO_REMOTE_LIMITS.maxBrowsers) throw refusal('limit');
      pending = null;
      if (request.decision === 'deny') return publish();
      const connectedAt = clock.iso();
      viewers = [...viewers, { id: `vw_synthetic${String(revision).padStart(11, '0')}`, label: waiting.label, fingerprint: waiting.fingerprint, grant: request.decision, connectedAt }];
      if (request.decision === 'always') {
        browsers = [
          ...browsers,
          { id: `br_synthetic${String(browsers.length + 1).padStart(2, '0')}`, label: waiting.label, fingerprint: waiting.fingerprint, createdAt: connectedAt, lastUsedAt: connectedAt },
        ];
      }
      return publish();
    },
    nano_remote_kick_v1: (args) => {
      const request = decodeArgument<{ viewerId: string }>(args, 'request', object({ viewerId: string }));
      requireLive();
      if (!viewers.some((viewer) => viewer.id === request.viewerId)) throw refusal('not-found');
      viewers = viewers.filter((viewer) => viewer.id !== request.viewerId);
      return publish();
    },
    nano_remote_forget_v1: (args) => {
      const request = decodeArgument<{ browserId: string }>(args, 'request', object({ browserId: string }));
      requireLive();
      const browser = browsers.find((item) => item.id === request.browserId);
      if (browser === undefined) throw refusal('not-found');
      browsers = browsers.filter((item) => item.id !== browser.id);
      viewers = viewers.filter((viewer) => viewer.fingerprint !== browser.fingerprint);
      return publish();
    },
  };

  return { handlers, status };
}
