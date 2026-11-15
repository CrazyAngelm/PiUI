/**
 * Nano remote access v1 (ADR-062, docs/NANO_DESKTOP.md "Remote access").
 *
 * A signed-in Nano Desktop whose owner switched "Allow remote access from
 * Nano Web" on keeps one outbound WebSocket to the Nano server. A browser of
 * the same account, paired on this computer, drives an allowlisted part of the
 * host API through it. The server relays frames and stores nothing.
 *
 * - Off by default. Signed out or in safe mode nothing is contacted.
 * - The WebView sees {@link NanoRemoteStatusV1} only: no token, no key
 *   material beyond a public-key fingerprint.
 * - WebView commands: `nano_remote_status_v1`, `nano_remote_set_enabled_v1`
 *   `{ request: NanoRemoteSetEnabledRequestV1 }`, `nano_remote_decide_v1`
 *   `{ request: NanoRemoteDecideRequestV1 }`, `nano_remote_kick_v1`
 *   `{ request: NanoRemoteKickRequestV1 }`, `nano_remote_forget_v1`
 *   `{ request: NanoRemoteForgetRequestV1 }`. Each answers
 *   {@link NanoRemoteStatusV1}; failures reject with `{ code }`
 *   ({@link NanoRemoteErrorCodeV1}). Requests reject unknown fields.
 * - None of these commands, and nothing outside {@link NANO_REMOTE_COMMANDS},
 *   can be called by a remote viewer.
 *
 * Fixtures: `fixtures/nano-remote-v1.json` (all values synthetic).
 */
export const NANO_REMOTE_PROTOCOL = 1 as const;
export const NANO_REMOTE_EVENT_V1 = 'piui://nano-remote-v1' as const;
export const NANO_REMOTE_SUBPROTOCOL = 'nano-remote.v1' as const;
/** Desktop side, bearer-authenticated. */
export const NANO_REMOTE_LINK_PATH = '/api/desktop/v1/remote/link' as const;
/** Web side, cookie-authenticated, same origin as the page. */
export const NANO_REMOTE_DEVICES_PATH = '/api/hermes/remote/devices' as const;
export function nanoRemoteViewerSocketPath(deviceId: string): string {
  return `${NANO_REMOTE_DEVICES_PATH}/${encodeURIComponent(deviceId)}/socket`;
}

export const NANO_REMOTE_LIMITS = {
  maxFrameBytes: 262144,
  /** A `res` frame larger than this is sent as `part` frames. */
  singleResultBytes: 200000,
  partBytes: 100000,
  maxResultBytes: 67108864,
  maxViewers: 2,
  maxBrowsers: 8,
  maxInFlight: 8,
  pairingSeconds: 120,
  requestTimeoutMs: 120000,
} as const;

export const NANO_REMOTE_CLOSE = {
  protocol: 4400,
  unauthorized: 4401,
  dropped: 4403,
  deviceOffline: 4404,
  idle: 4408,
  replaced: 4409,
  limited: 4429,
  tooBig: 1009,
  restart: 1012,
} as const;

/** Host commands a welcomed viewer may call. Everything else is refused. */
export const NANO_REMOTE_COMMANDS = [
  'bootstrap_v10',
  'workspace_command_v15',
  'workspace_history_v1',
  'workspace_settings_v16',
  'workspace_session_mode_v1',
  'workspace_composer_v19',
  'harness_models_v19',
  'harness_registry_v1',
  'get_session_catalog',
  'get_personal_session_catalog',
  'refresh_session_catalog',
  'refresh_personal_session_catalog',
  'get_timeline_page',
  'get_personal_timeline_page',
  'search_sessions',
  'nano_account_status_v1',
] as const;
export type NanoRemoteCommandV1 = (typeof NANO_REMOTE_COMMANDS)[number];

/** Event channels forwarded to every welcomed viewer. */
export const NANO_REMOTE_CHANNELS = [
  'piui://workspace-event',
  'piui://composer-v19',
  'piui://session-catalog',
  'piui://harness-registry-v1',
  'piui://nano-account-v1',
] as const;
export type NanoRemoteChannelV1 = (typeof NANO_REMOTE_CHANNELS)[number];

/** Protocol numbers of the shell contracts; host and browser must agree before the shell mounts. */
export const NANO_REMOTE_SHELL_CONTRACTS = { workspace: 15, composer: 19, settings: 16, history: 1, models: 19 } as const;
export type NanoRemoteShellContractsV1 = { readonly [K in keyof typeof NANO_REMOTE_SHELL_CONTRACTS]: number };

// ---------------------------------------------------------------------------
// WebView <-> host
// ---------------------------------------------------------------------------

/** `off`: toggle off or unavailable. `refused`: the server answered 403, 404 or 426. */
export type NanoRemoteLinkStateV1 = 'off' | 'connecting' | 'online' | 'retrying' | 'refused';
export type NanoRemoteUnavailableV1 = 'safe-mode' | 'signed-out' | 'unsupported-server';
export type NanoRemoteGrantV1 = 'once' | 'always';
export type NanoRemoteDecisionV1 = 'deny' | 'once' | 'always';
export type NanoRemoteErrorCodeV1 = 'invalid' | 'safe-mode' | 'sign-in-required' | 'unsupported-server' | 'not-found' | 'limit' | 'io';

export interface NanoRemoteViewerV1 {
  readonly id: string;
  /** Text the browser sent; untrusted, at most 60 characters. */
  readonly label: string;
  readonly fingerprint: string;
  readonly grant: NanoRemoteGrantV1;
  /** RFC 3339, UTC. */
  readonly connectedAt: string;
}

export interface NanoRemotePairingV1 {
  readonly requestId: string;
  readonly label: string;
  /** Six digits; the browser shows the same code. */
  readonly code: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
}

export interface NanoRemoteBrowserV1 {
  readonly id: string;
  readonly label: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface NanoRemoteStatusV1 {
  readonly protocol: 1;
  readonly revision: number;
  /** Why the toggle cannot be used now; null when it can. */
  readonly unavailable: NanoRemoteUnavailableV1 | null;
  readonly enabled: boolean;
  readonly link: NanoRemoteLinkStateV1;
  readonly viewers: readonly NanoRemoteViewerV1[];
  readonly pending: NanoRemotePairingV1 | null;
  readonly browsers: readonly NanoRemoteBrowserV1[];
}

export interface NanoRemoteEventV1 {
  readonly type: 'status';
  readonly status: NanoRemoteStatusV1;
}

export interface NanoRemoteSetEnabledRequestV1 { readonly enabled: boolean }
export interface NanoRemoteDecideRequestV1 { readonly requestId: string; readonly decision: NanoRemoteDecisionV1 }
export interface NanoRemoteKickRequestV1 { readonly viewerId: string }
export interface NanoRemoteForgetRequestV1 { readonly browserId: string }

// ---------------------------------------------------------------------------
// Wire: envelope (read by the server)
// ---------------------------------------------------------------------------

export type NanoRemoteDropReasonV1 = 'denied' | 'kicked' | 'disabled' | 'protocol';

export type NanoRemoteDeviceToServerV1 =
  | { readonly t: 'msg'; readonly viewer: string; readonly d: NanoRemoteHostMessageV1 }
  | { readonly t: 'drop'; readonly viewer: string; readonly reason: NanoRemoteDropReasonV1 };

export type NanoRemoteServerToDeviceV1 =
  | { readonly t: 'hello'; readonly device: string; readonly maxFrame: number; readonly maxViewers: number }
  | { readonly t: 'viewer-open'; readonly viewer: string }
  | { readonly t: 'viewer-close'; readonly viewer: string }
  | { readonly t: 'msg'; readonly viewer: string; readonly d: NanoRemoteViewerMessageV1 };

export type NanoRemoteWebToServerV1 = { readonly t: 'msg'; readonly d: NanoRemoteViewerMessageV1 };

export type NanoRemoteServerToWebV1 =
  | { readonly t: 'ready'; readonly viewer: string; readonly device: { readonly id: string; readonly name: string } }
  | { readonly t: 'msg'; readonly d: NanoRemoteHostMessageV1 };

// ---------------------------------------------------------------------------
// Wire: inner messages (opaque to the server)
// ---------------------------------------------------------------------------

export type NanoRemoteViewerMessageV1 =
  | { readonly k: 'hello'; readonly proto: 1; readonly key: string; readonly label: string }
  | { readonly k: 'proof'; readonly sig: string }
  | { readonly k: 'req'; readonly id: number; readonly cmd: string; readonly args: Readonly<Record<string, unknown>> };

export type NanoRemoteByeReasonV1 = 'kicked' | 'disabled' | 'signed-out' | 'quit';
export type NanoRemoteDeniedReasonV1 = 'denied' | 'timeout' | 'busy';

export interface NanoRemoteWelcomeV1 {
  readonly k: 'welcome';
  readonly proto: 1;
  readonly device: { readonly id: string; readonly name: string };
  readonly app: { readonly version: string };
  readonly grant: NanoRemoteGrantV1;
  readonly shell: NanoRemoteShellContractsV1;
  readonly commands: readonly string[];
  readonly channels: readonly string[];
}

export type NanoRemoteHostMessageV1 =
  | { readonly k: 'challenge'; readonly nonce: string }
  | { readonly k: 'approval'; readonly code: string; readonly expiresIn: number }
  | { readonly k: 'denied'; readonly reason: NanoRemoteDeniedReasonV1 }
  | NanoRemoteWelcomeV1
  | { readonly k: 'res'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly k: 'res'; readonly id: number; readonly ok: false; readonly error: unknown }
  | { readonly k: 'part'; readonly id: number; readonly seq: number; readonly last: boolean; readonly ok: boolean; readonly data: string }
  | { readonly k: 'ev'; readonly ch: string; readonly p: unknown }
  | { readonly k: 'bye'; readonly reason: NanoRemoteByeReasonV1 };

/** The text a browser signs: device id, viewer id and nonce bind the proof to one relay session. */
export function nanoRemoteProofMessage(deviceId: string, viewerId: string, nonce: string): string {
  return `nano-remote-v1\n${deviceId}\n${viewerId}\n${nonce}`;
}

/** Refusals of the remote layer itself (the `error` of a `res` frame). */
export type NanoRemoteRefusalCodeV1 = 'remote-not-allowed' | 'remote-busy' | 'remote-too-large' | 'remote-invalid' | 'remote-not-connected';
