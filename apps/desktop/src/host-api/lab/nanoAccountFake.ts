import {
  NANO_ACCOUNT_EVENT_V1,
  type NanoAccountErrorCodeV1,
  type NanoAccountStatusV1,
  type NanoCapabilitiesV1,
  type NanoEntitlementsV1,
  type NanoLinkV1,
  type NanoModeV1,
} from '../../../../../contracts/nano-account-v1';
import type { LabEventBus } from './labBus';
import type { LabClock } from './labClock';
import type { LabHandlers } from './labHandlers';
import { decodeArgument, enumOf, object, string } from './labSchema';
import { createLabNanoAvatar } from './nanoAvatarFake';

/**
 * Nano account v1 in the UI Lab. Nothing leaves the browser: no sign-in page
 * opens, no server is contacted. The fake answers with the host's shapes and
 * events after short simulated delays. Pick a state with `?nano=`:
 *
 * - `signed-out` (default): no credential; "Sign in" completes after about a
 *   second as the synthetic paid person;
 * - `signed-in`: a paid plan with two workspaces and every mode available;
 * - `free`: the free plan, two modes locked by the plan, no dictation or cloud;
 * - `exhausted`: a paid plan whose credits ran out, so only Free stays usable;
 * - `expired`: the server revoked this device; sign in again;
 * - `unsupported`: a development server without the desktop API;
 * - `offline`: a stored credential and an unreachable server.
 *
 * Safe mode behaves like the host: the status is always signed out (nothing is
 * restored), the local sign-out still works, and every other action is refused
 * with `{ code: 'safe-mode' }`.
 */
export const LAB_NANO_SCENARIOS = ['signed-out', 'signed-in', 'free', 'exhausted', 'expired', 'unsupported', 'offline'] as const;
export type LabNanoScenario = (typeof LAB_NANO_SCENARIOS)[number];

export const LAB_NANO_SIGN_IN_MS = 1_000;
const DICTATION_MS = 400;
export const LAB_NANO_DICTATION_TEXT = 'This is synthetic dictated text.';

export function nanoScenarioFromSearch(search: string): LabNanoScenario {
  const requested = new URLSearchParams(search).get('nano');
  return LAB_NANO_SCENARIOS.find((name) => name === requested) ?? 'signed-out';
}

const PRODUCTION = { origin: 'https://nanoagents.ru', development: false } as const;
const DEVELOPMENT = { origin: 'http://127.0.0.1:8787', development: true } as const;
const USER = { displayName: 'Synthetic Person', email: 'person@example.com' } as const;
const DEVICE = { id: 'dev_synthetic01', name: 'Nano Desktop on Windows' } as const;
const PERSONAL = { id: 'ws_synthetic01', name: 'Personal', role: 'owner' } as const;
const TEAM = { id: 'ws_synthetic02', name: 'Team', role: 'member' } as const;
const RENEWS = '2026-12-01T00:00:00Z';

const CAPABILITIES: NanoCapabilitiesV1 = { gateway: true, cloudLaunch: true, deviceCode: false, dictation: true, voice: false, imageGeneration: false, avatars: true };

const MODES: readonly NanoModeV1[] = [
  { id: 'auto', name: 'Auto', tier: 'mixed', available: true, lockedReason: null, costHint: 'Picks a model per request', contextWindow: 200000, maxOutputTokens: 32000, input: ['text', 'image'], reasoning: true },
  { id: 'free', name: 'Free', tier: 'free', available: true, lockedReason: null, costHint: 'Free', contextWindow: 131072, maxOutputTokens: 8192, input: ['text'], reasoning: false },
  { id: 'fast', name: 'Fast', tier: 'cheap', available: true, lockedReason: null, costHint: 'About 1 credit per 1K tokens', contextWindow: 200000, maxOutputTokens: 16384, input: ['text', 'image'], reasoning: false },
  { id: 'smart', name: 'Smart', tier: 'paid', available: true, lockedReason: null, costHint: 'About 8 credits per 1K tokens', contextWindow: 400000, maxOutputTokens: 64000, input: ['text', 'image'], reasoning: true },
];

function modes(locks: Readonly<Partial<Record<NanoModeV1['id'], 'plan' | 'credits'>>>): NanoModeV1[] {
  return MODES.map((mode) => {
    const lock = locks[mode.id];
    return lock === undefined ? { ...mode } : { ...mode, available: false, lockedReason: lock };
  });
}

function entitlementsFor(scenario: LabNanoScenario, workspaceId: string): NanoEntitlementsV1 {
  const limits = { maxConcurrentRequests: 4, maxRequestBytes: 8388608, dictationMaxBytes: 20971520 };
  if (scenario === 'free') {
    return {
      workspaceId,
      plan: { id: 'free', name: 'Free', kind: 'free', renewsAt: null },
      credits: { balance: 400, included: 500, periodEndsAt: RENEWS },
      modes: modes({ fast: 'plan', smart: 'plan' }),
      features: { localAgent: true, cloud: false, dictation: false, imageGeneration: false, voice: false, avatars: false },
      limits,
    };
  }
  if (scenario === 'exhausted') {
    return {
      workspaceId,
      plan: { id: 'pro', name: 'Pro', kind: 'paid', renewsAt: RENEWS },
      credits: { balance: 0, included: 25000, periodEndsAt: RENEWS },
      modes: modes({ auto: 'credits', fast: 'credits', smart: 'credits' }),
      features: { localAgent: true, cloud: true, dictation: true, imageGeneration: false, voice: true, avatars: true },
      limits,
    };
  }
  const team = workspaceId === TEAM.id;
  return {
    workspaceId,
    plan: { id: team ? 'team' : 'pro', name: team ? 'Team' : 'Pro', kind: 'paid', renewsAt: RENEWS },
    credits: team ? { balance: 90500, included: 100000, periodEndsAt: RENEWS } : { balance: 18250, included: 25000, periodEndsAt: RENEWS },
    modes: modes(team ? { smart: 'plan' } : {}),
    features: { localAgent: true, cloud: true, dictation: true, imageGeneration: false, voice: true, avatars: true },
    limits,
  };
}

const LINKS: readonly NanoLinkV1[] = ['billing', 'devices', 'signup'];

function refusal(code: NanoAccountErrorCodeV1): { readonly code: NanoAccountErrorCodeV1 } {
  return { code };
}

/** The modes an account may use now, in server order; none unless it is signed in (the host's `catalog_models`). */
export function labNanoOpenModes(status: NanoAccountStatusV1): readonly NanoModeV1[] {
  if (status.state !== 'signed-in' || status.entitlements === null) return [];
  return status.entitlements.modes.filter((mode) => mode.available);
}

/**
 * Whether the account can start a Nano session now (the host's `launch_gate`):
 * signed in, a workspace, the gateway, the local agent in the plan and a mode open.
 */
export function labNanoLaunchReady(status: NanoAccountStatusV1): boolean {
  const { entitlements } = status;
  return (
    status.state === 'signed-in' &&
    status.selectedWorkspaceId !== null &&
    status.capabilities?.gateway === true &&
    entitlements !== null &&
    entitlements.features.localAgent &&
    entitlements.modes.some((mode) => mode.available)
  );
}

/** The fake account: its host handlers and its current status for the catalog and session fakes. */
export interface LabNanoAccount {
  readonly handlers: LabHandlers;
  status(): NanoAccountStatusV1;
}

export function createLabNanoAccount(scenario: LabNanoScenario, bus: LabEventBus, clock: LabClock, safeMode: boolean = false): LabNanoAccount {
  const workspaces = scenario === 'free' || scenario === 'exhausted' ? [PERSONAL] : [PERSONAL, TEAM];
  // Safe mode restores nothing: the host reports a signed-out account whatever is stored.
  let status: NanoAccountStatusV1 = initial(safeMode ? 'signed-out' : scenario, workspaces);
  let cancelSignIn: (() => void) | undefined;
  const avatar = createLabNanoAvatar(bus, () => status, safeMode);

  function initial(name: LabNanoScenario, rows: readonly (typeof PERSONAL | typeof TEAM)[]): NanoAccountStatusV1 {
    const base: NanoAccountStatusV1 = {
      protocol: 1,
      revision: 1,
      state: 'signed-out',
      server: PRODUCTION,
      user: null,
      device: null,
      workspaces: [],
      selectedWorkspaceId: null,
      entitlements: null,
      usage: null,
      capabilities: null,
      credentialStore: null,
      busy: false,
      lastError: null,
    };
    switch (name) {
      case 'signed-in':
      case 'free':
      case 'exhausted':
        return signedIn(base, rows, name);
      case 'expired':
        return { ...base, state: 'expired', user: USER, lastError: 'device-revoked' };
      case 'unsupported':
        return { ...base, state: 'unsupported', server: DEVELOPMENT, lastError: 'unsupported-server' };
      case 'offline':
        return { ...base, state: 'offline', user: USER, device: DEVICE, workspaces: rows, selectedWorkspaceId: PERSONAL.id, credentialStore: 'os', lastError: 'offline' };
      case 'signed-out':
        return base;
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  }

  function signedIn(base: NanoAccountStatusV1, rows: readonly (typeof PERSONAL | typeof TEAM)[], variant: LabNanoScenario, workspaceId: string = PERSONAL.id): NanoAccountStatusV1 {
    return {
      ...base,
      state: 'signed-in',
      user: USER,
      device: DEVICE,
      workspaces: rows,
      selectedWorkspaceId: workspaceId,
      entitlements: entitlementsFor(variant, workspaceId),
      capabilities: CAPABILITIES,
      credentialStore: 'os',
      busy: false,
      lastError: null,
    };
  }

  const publish = (next: Partial<NanoAccountStatusV1>): NanoAccountStatusV1 => {
    status = { ...status, ...next, revision: status.revision + 1 };
    avatar.publish();
    bus.emit(NANO_ACCOUNT_EVENT_V1, { type: 'status', status });
    return status;
  };
  /** The variant a fresh sign-in lands in: the scenario's own, else the paid person. */
  const signedInVariant: LabNanoScenario = scenario === 'free' || scenario === 'exhausted' ? scenario : 'signed-in';
  const requireSignedIn = (): void => {
    if (status.state === 'signed-out' || status.state === 'signing-in' || status.state === 'unsupported') throw refusal('sign-in-required');
    if (status.state === 'expired') throw refusal('device-revoked');
    if (status.state === 'offline') throw refusal('offline');
  };
  /** The host decodes the arguments first, then refuses everything but the status and the local sign-out in safe mode. */
  const requireLive = (): void => {
    if (safeMode) throw refusal('safe-mode');
  };

  const handlers: LabHandlers = {
    nano_avatar_scope_v1: () => avatar.scope(),
    nano_avatar_load_v1: (args) => {
      const request = decodeArgument<{ context: string }>(args, 'request', object({ context: string }));
      return avatar.load(request.context);
    },
    nano_account_status_v1: () => status,
    nano_account_sign_in_v1: () => {
      requireLive();
      if (status.state === 'unsupported') throw refusal('unsupported-server');
      if (status.state === 'signing-in') throw refusal('busy');
      if (status.state === 'signed-in') return status;
      if (status.state === 'offline') throw refusal('offline');
      const waiting = publish({ state: 'signing-in', busy: true, lastError: null, capabilities: CAPABILITIES });
      cancelSignIn = clock.after(LAB_NANO_SIGN_IN_MS, () => {
        cancelSignIn = undefined;
        const base = { ...status, revision: status.revision + 1 };
        status = signedIn(base, workspaces, signedInVariant);
        avatar.publish();
        bus.emit(NANO_ACCOUNT_EVENT_V1, { type: 'status', status });
      });
      return waiting;
    },
    nano_account_cancel_sign_in_v1: () => {
      requireLive();
      if (status.state !== 'signing-in') return status;
      cancelSignIn?.();
      cancelSignIn = undefined;
      return publish({ state: 'signed-out', busy: false, capabilities: null, lastError: null });
    },
    nano_account_sign_out_v1: () => {
      cancelSignIn?.();
      cancelSignIn = undefined;
      return publish({
        state: 'signed-out',
        user: null,
        device: null,
        workspaces: [],
        selectedWorkspaceId: null,
        entitlements: null,
        usage: null,
        capabilities: null,
        credentialStore: null,
        busy: false,
        lastError: null,
      });
    },
    nano_account_select_workspace_v1: (args) => {
      const request = decodeArgument<{ workspaceId: string }>(args, 'request', object({ workspaceId: string }));
      requireLive();
      requireSignedIn();
      if (!status.workspaces.some((row) => row.id === request.workspaceId)) throw refusal('workspace-not-found');
      return publish({ selectedWorkspaceId: request.workspaceId, entitlements: entitlementsFor(signedInVariant, request.workspaceId), lastError: null });
    },
    nano_account_refresh_v1: () => {
      requireLive();
      requireSignedIn();
      return publish({ lastError: null });
    },
    nano_account_open_link_v1: (args) => {
      const request = decodeArgument<{ link: NanoLinkV1 }>(args, 'request', object({ link: enumOf(LINKS) }));
      requireLive();
      // The browser would open here; the lab has no page to show.
      if (request.link !== 'signup') requireSignedIn();
      return status;
    },
    nano_cloud_open_v1: () => {
      requireLive();
      requireSignedIn();
      if (status.entitlements?.features.cloud !== true) throw refusal('feature-unavailable');
      return null;
    },
    nano_dictation_v1: async (args) => {
      decodeArgument<{ audioBase64: string; mimeType: string }>(args, 'request', object({ audioBase64: string, mimeType: string }));
      requireLive();
      requireSignedIn();
      const entitlements = status.entitlements;
      if (status.capabilities?.dictation !== true || entitlements === null || !entitlements.features.dictation) throw refusal('feature-unavailable');
      if (entitlements.credits.balance <= 0) throw refusal('credits-exhausted');
      await clock.delay(DICTATION_MS);
      return { text: LAB_NANO_DICTATION_TEXT };
    },
  };

  return { handlers, status: () => status };
}
