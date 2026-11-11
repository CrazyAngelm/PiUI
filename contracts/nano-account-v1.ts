/**
 * Nano account v1 (ADR-047, docs/NANO_DESKTOP.md): the optional Nano sign-in,
 * workspace choice and entitlements as the WebView sees them.
 *
 * - The Rust host owns every credential. Access and refresh tokens,
 *   authorization codes, PKCE verifiers and relay keys never appear in a
 *   request, an answer, an event or a log.
 * - Signed out, nothing contacts a Nano server. `nano_account_status_v1`
 *   never touches the network: it reports what the host last learned.
 * - Sign-in opens the system browser (authorization code + PKCE S256,
 *   loopback redirect on 127.0.0.1). The command answers at once with
 *   `signing-in`; the outcome arrives as {@link NANO_ACCOUNT_EVENT_V1}.
 * - A stored refresh token is used in the background after first paint; the
 *   window never waits for it.
 * - Safe mode refuses every command except status and sign-out with
 *   `safe-mode`; sign-out there forgets the local credential without a
 *   network call.
 *
 * Commands: `nano_account_status_v1`, `nano_account_sign_in_v1`,
 * `nano_account_cancel_sign_in_v1`, `nano_account_sign_out_v1`,
 * `nano_account_select_workspace_v1` `{ workspaceId }`,
 * `nano_account_refresh_v1`, `nano_account_open_link_v1` `{ link }` and
 * `nano_cloud_open_v1`. Each answers {@link NanoAccountStatusV1}, except
 * `nano_cloud_open_v1`, which answers nothing. Requests reject unknown fields;
 * failures reject with `{ code }` ({@link NanoAccountErrorCodeV1}).
 */
import type {
  NanoCapabilitiesV1,
  NanoEntitlementsV1,
  NanoModeIdV1,
  NanoUsageV1,
  NanoWorkspaceRoleV1,
} from './nano-server-v1';

export type * from './nano-server-v1';

export const NANO_ACCOUNT_PROTOCOL = 1 as const;
export const NANO_ACCOUNT_EVENT_V1 = 'piui://nano-account-v1' as const;
/** Harness identity of the local Nano agent (harness identity v3). */
export const NANO_HARNESS = 'nano' as const;
/** `WorkspaceModel.provider` of every Nano mode row. */
export const NANO_MODEL_PROVIDER = 'nano' as const;

/**
 * - `signed-out`: no credential; nothing contacts the server.
 * - `signing-in`: the browser is open and the loopback listener waits.
 * - `signed-in`: a credential works; `entitlements` may still be loading.
 * - `expired`: the server refused the credential (revoked device, reused or
 *   expired refresh token); the user signs in again. Local data stays.
 * - `unsupported`: the server has no desktop API v1, or this client is older
 *   than its `minClientVersion` (`lastError` tells which).
 * - `offline`: a credential is stored but the server could not be reached.
 */
export type NanoAccountStateV1 = 'signed-out' | 'signing-in' | 'signed-in' | 'expired' | 'unsupported' | 'offline';

export type NanoAccountErrorCodeV1 =
  | 'invalid'
  | 'safe-mode'
  | 'busy'
  | 'offline'
  | 'unsupported-server'
  | 'client-too-old'
  | 'sign-in-required'
  | 'sign-in-cancelled'
  | 'sign-in-timeout'
  | 'sign-in-failed'
  | 'device-revoked'
  | 'workspace-not-found'
  | 'credential-store-failed'
  | 'browser-failed'
  | 'credits-exhausted'
  | 'mode-locked'
  | 'rate-limited'
  | 'feature-unavailable';

/** Where the host keeps the refresh token. `memory`: lost when the app quits. */
export type NanoCredentialStoreV1 = 'os' | 'memory';

/** Pages of the Nano site the host opens in the system browser. */
export type NanoLinkV1 = 'billing' | 'devices' | 'signup';

export interface NanoServerInfoV1 {
  /** `https://nanoagents.ru`, or the development override. */
  readonly origin: string;
  /** True only for a non-default issuer (development and E2E builds). */
  readonly development: boolean;
}

export interface NanoAccountUserV1 {
  readonly displayName: string;
  readonly email: string | null;
}

export interface NanoAccountDeviceV1 {
  readonly id: string;
  readonly name: string;
}

export interface NanoAccountWorkspaceV1 {
  readonly id: string;
  readonly name: string;
  readonly role: NanoWorkspaceRoleV1;
}

export interface NanoAccountStatusV1 {
  readonly protocol: 1;
  /** Increases with every change the host publishes. */
  readonly revision: number;
  readonly state: NanoAccountStateV1;
  readonly server: NanoServerInfoV1;
  readonly user: NanoAccountUserV1 | null;
  readonly device: NanoAccountDeviceV1 | null;
  readonly workspaces: readonly NanoAccountWorkspaceV1[];
  readonly selectedWorkspaceId: string | null;
  /** Of the selected workspace; null until loaded or while signed out. */
  readonly entitlements: NanoEntitlementsV1 | null;
  readonly usage: NanoUsageV1 | null;
  /** From the server's desktop meta; null until discovery answered. */
  readonly capabilities: NanoCapabilitiesV1 | null;
  readonly credentialStore: NanoCredentialStoreV1 | null;
  /** A refresh, sign-in or workspace load is in flight. */
  readonly busy: boolean;
  /** The last failure the person should see, cleared by the next success. */
  readonly lastError: NanoAccountErrorCodeV1 | null;
}

export interface NanoAccountEventV1 {
  readonly type: 'status';
  readonly status: NanoAccountStatusV1;
}

export interface NanoSelectWorkspaceRequestV1 {
  readonly workspaceId: string;
}

export interface NanoOpenLinkRequestV1 {
  readonly link: NanoLinkV1;
}

/** Whether a Nano mode can start a turn now, from the status alone. */
export function nanoModeAvailable(status: NanoAccountStatusV1, mode: NanoModeIdV1): boolean {
  return status.state === 'signed-in' && (status.entitlements?.modes.some((row) => row.id === mode && row.available) ?? false);
}
