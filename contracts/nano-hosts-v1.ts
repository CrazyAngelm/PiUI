/**
 * Execution hosts relay API v1 (ADR-080): the proposed section 13 of the
 * Desktop API (`docs/NANO_DESKTOP_API.md`) for connected execution hosts.
 *
 * STATUS: proposal. The Nano server does not implement these routes yet, and
 * the Desktop has no client for them. Of this file, only the frame rules are
 * implemented (`crates/piui-remote-host/src/relay.rs`). The routes, scopes,
 * statuses and events change freely until the server ships them.
 *
 * The relay is a rendezvous for two Desktops of one account. Both connect
 * outward over HTTPS; neither listens. It sees `{channelId, seq, data}`,
 * where `data` is opaque TLS bytes of the end-to-end channel
 * (`nano-host-v1.ts`); the command id, kind and body stay inside TLS, where
 * the target deduplicates. The relay's key directory is untrusted for end to
 * end authentication: a key it lists is only a candidate until pairing
 * verified it at both computers, and its records are never execution
 * authority on a target.
 *
 * Conventions of `nano-server-v1.ts` apply: prefix `/api/desktop/v1`,
 * `Authorization: Bearer <access token>`, camelCase JSON, refusals as
 * `NanoErrorBodyV1`. Request bodies are bounded by the Desktop API cap
 * (`MAX_API_BODY`, 2 MiB), answered with `payload_too_large` above it.
 *
 * No relay rate or volume limit is defined here: the existing limiter (4
 * concurrent, 60 per minute) is for dictation and the gateway and would choke
 * a target's event stream. A relay limit is chosen by measurement (open value
 * V2); the feature stays off in production until then.
 *
 * Fixtures: `fixtures/unified-shell/nano-hosts-v1.json` (synthetic).
 */
import type {
  NanoAccountIdV1,
  NanoBase64UrlV1,
  NanoDeviceIdV1,
  NanoHostGrantIdV1,
  NanoHostIdV1,
  NanoHostSpkiV1,
} from './nano-host-v1';

export const NANO_HOSTS_API_VERSION = 1 as const;

/**
 * The OAuth scopes of the two roles (proposed). `NANO_DESKTOP_SCOPES` of
 * `nano-server-v1.ts` is unchanged: it is the default set an empty scope
 * request expands to, and the roles are requested explicitly.
 */
export const NANO_DESKTOP_HOST_SCOPES = ['nano.desktop.host', 'nano.desktop.control'] as const;
export type NanoDesktopHostScopeV1 = (typeof NANO_DESKTOP_HOST_SCOPES)[number];

/**
 * Additive field of `NanoCapabilitiesV1` in `GET meta` (proposed). Without
 * it, or with `false`, the Desktop does not show the feature. The server
 * option that sets it defaults to off.
 */
export interface NanoHostsCapabilityV1 {
  readonly executionHosts: boolean;
}

// ---------------------------------------------------------------------------
// Host role (scope nano.desktop.host)
// ---------------------------------------------------------------------------

/**
 * `PUT hosts/self`: register or update this device as an execution host. A
 * new identity key deletes every grant of this host, so each controller must
 * pair again.
 */
export interface NanoPutHostSelfRequestV1 {
  readonly protocol: 'nano-host/1';
  readonly identitySpki: NanoHostSpkiV1;
}
export interface NanoPutHostSelfResponseV1 {
  readonly hostId: NanoHostIdV1;
  readonly accountId: NanoAccountIdV1;
}

// `DELETE hosts/self`: switch off; deletes the host record and its grants and
// closes its channels.

/**
 * `PUT hosts/self/grants/{grantId}`: register a grant the target recorded
 * after pairing. The grant id is the target's own; the server checks its
 * shape, that the controller device belongs to the same user, is active and
 * holds the control scope. Idempotent for the same grant and controller.
 */
export interface NanoPutHostGrantRequestV1 {
  readonly controllerDeviceId: NanoDeviceIdV1;
}

// `DELETE hosts/self/grants/{grantId}`: revoke on the target.

// ---------------------------------------------------------------------------
// Controller role (scope nano.desktop.control)
// ---------------------------------------------------------------------------

/** `GET hosts`: the execution hosts of the account. */
export interface NanoHostListResponseV1 {
  readonly hosts: readonly NanoHostV1[];
}
export interface NanoHostV1 {
  readonly hostId: NanoHostIdV1;
  /** The host's OAuth device. */
  readonly deviceId: NanoDeviceIdV1;
  readonly name: string;
  /** A candidate key only; the controller trusts its own pin, never this. */
  readonly identitySpki: NanoHostSpkiV1;
  /** Whether the host's stream is live now. */
  readonly online: boolean;
  /** The grant of this host for the calling controller, if any. */
  readonly grantId?: NanoHostGrantIdV1;
}

// `DELETE hosts/{hostId}/grants/{grantId}`: revoke from any Desktop of the
// owner.

/**
 * `POST hosts/channels`: open a channel to a host. `pairing` needs the host's
 * owner to have its pairing window open (the target answers `window-closed`
 * inside TLS otherwise); `grant` needs a registered grant of this host for
 * the calling controller.
 */
export type NanoOpenHostChannelRequestV1 =
  | { readonly hostId: NanoHostIdV1; readonly purpose: 'pairing' }
  | { readonly hostId: NanoHostIdV1; readonly purpose: 'grant'; readonly grantId: NanoHostGrantIdV1 };
export interface NanoOpenHostChannelResponseV1 {
  /** Opaque. */
  readonly channelId: string;
}

// ---------------------------------------------------------------------------
// Both roles
// ---------------------------------------------------------------------------

/**
 * One relay frame. Rules (implemented by `relay.rs`):
 * - each channel direction numbers its frames from 1 in steps of 1, up to
 *   `Number.MAX_SAFE_INTEGER`;
 * - `data` is non-empty canonical {@link NanoBase64UrlV1} of TLS bytes;
 * - the receiver accepts exactly the next number; a repeated, missing or
 *   reordered frame, or other data, ends the channel. There is no
 *   retransmission at this layer: recovery is a new channel with a full
 *   handshake, and a command is repeated with its own command id;
 * - at most one frames POST per channel and direction is in flight (an order
 *   requirement, not a quota), and a sender splits its bytes so that each
 *   POST body stays within `MAX_API_BODY`.
 */
export interface NanoHostFrameV1 {
  readonly seq: number;
  readonly data: NanoBase64UrlV1;
}

/**
 * `POST hosts/channels/{channelId}/frames`, by a party of the channel. The
 * server forwards the frames to the peer's live stream in the same process
 * and answers only after writing them there: that is the backpressure. There
 * is no queue, no frame table, and `data` is never logged. `peer_offline` or
 * `channel_closed` otherwise.
 */
export interface NanoPostHostFramesRequestV1 {
  readonly frames: readonly NanoHostFrameV1[];
}
export interface NanoPostHostFramesResponseV1 {
  readonly status: 'delivered';
}

// `DELETE hosts/channels/{channelId}`: a party closes the channel.

/**
 * `GET hosts/stream`: one Server-Sent Events stream per device (scope
 * `nano.desktop` and at least one role), with `: keepalive` comments while
 * silent. `ready` lists the grants this device takes part in, as target or as
 * controller. The stream ends when the device is revoked and when its access
 * token expires; the device then opens a new one.
 */
export type NanoHostStreamEventV1 =
  | {
      readonly type: 'ready';
      readonly grants: readonly {
        readonly grantId: NanoHostGrantIdV1;
        readonly hostId: NanoHostIdV1;
        readonly controllerDeviceId: NanoDeviceIdV1;
      }[];
    }
  | {
      readonly type: 'channel-open';
      readonly channelId: string;
      readonly purpose: 'pairing';
      readonly hostId: NanoHostIdV1;
      readonly controllerDeviceId: NanoDeviceIdV1;
    }
  | {
      readonly type: 'channel-open';
      readonly channelId: string;
      readonly purpose: 'grant';
      readonly hostId: NanoHostIdV1;
      readonly controllerDeviceId: NanoDeviceIdV1;
      readonly grantId: NanoHostGrantIdV1;
    }
  | { readonly type: 'frames'; readonly channelId: string; readonly frames: readonly NanoHostFrameV1[] }
  | { readonly type: 'channel-closed'; readonly channelId: string }
  | { readonly type: 'grant-revoked'; readonly grantId: NanoHostGrantIdV1; readonly hostId: NanoHostIdV1 }
  | { readonly type: 'host-changed'; readonly hostId: NanoHostIdV1 };

/**
 * Error codes. Reused from `NanoServerErrorCodeV1` with their existing
 * statuses: `scope_missing`, `device_revoked`, `payload_too_large`,
 * `rate_limited`, `feature_not_in_plan`. New codes; their HTTP statuses are
 * decided with the server implementation.
 */
export type NanoHostsErrorCodeV1 =
  | 'peer_offline'
  | 'channel_closed'
  | 'host_not_found'
  | 'grant_not_found';
