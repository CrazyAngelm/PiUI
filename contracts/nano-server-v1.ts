/**
 * Nano desktop server API v1 (ADR-047, ADR-048, docs/NANO_DESKTOP_API.md).
 *
 * What the Rust host expects from a Nano server. Only the host speaks it: the
 * WebView sees the results through `nano-account-v1.ts`, never a token.
 *
 * - Discovery: `GET /.well-known/oauth-authorization-server` (RFC 8414,
 *   snake_case) and `GET /api/desktop/v1/meta`.
 * - Sign-in: authorization code + PKCE S256 for the public client
 *   `nano-desktop`, redirect `http://127.0.0.1:<port>/callback` (RFC 8252,
 *   any port), rotating refresh tokens, revocation (RFC 7009).
 * - Every other path is under `/api/desktop/v1` with `Authorization: Bearer
 *   <access token>`. JSON is camelCase. A refused request answers
 *   {@link NanoErrorBodyV1} with the HTTP status listed at each code.
 * - The gateway serves Chat Completions and advertises additional native
 *   protocols under the workspace. The server picks the provider model.
 *
 * Fixtures: `fixtures/nano-server-v1.json` (all values synthetic).
 */

export const NANO_SERVER_API_VERSION = 1 as const;
export const NANO_DESKTOP_API_PREFIX = '/api/desktop/v1' as const;
export const NANO_DESKTOP_CLIENT_ID = 'nano-desktop' as const;
export const NANO_DESKTOP_SCOPES = ['openid', 'profile', 'offline_access', 'nano.desktop'] as const;
/** Path of the loopback redirect URI; host and port are `127.0.0.1:<ephemeral>`. */
export const NANO_REDIRECT_PATH = '/callback' as const;
/** The production issuer compiled into release builds. */
export const NANO_DEFAULT_ISSUER = 'https://nanoagents.ru' as const;

/** GET /workspaces/{workspaceId}/gateway/v1/capabilities, when implemented. */
export interface NanoGatewayCapabilitiesV1 {
  readonly dialects: Readonly<Partial<Record<
    'chat-completions' | 'responses' | 'messages' | 'gemini',
    readonly NanoModeIdV1[]
  >>>;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** RFC 8414 metadata; only the fields the host reads. */
export interface NanoAuthServerMetadataV1 {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint: string;
  readonly device_authorization_endpoint?: string;
  readonly code_challenge_methods_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly scopes_supported?: readonly string[];
}

export interface NanoCapabilitiesV1 {
  /** Local Nano agent through the gateway. */
  readonly gateway: boolean;
  /** One-time launch codes for the cloud window. */
  readonly cloudLaunch: boolean;
  readonly deviceCode: boolean;
  readonly dictation: boolean;
  readonly voice: boolean;
  readonly imageGeneration: boolean;
  readonly avatars: boolean;
}

/** Absolute https URLs; the host opens only those on the issuer's site. */
export interface NanoLinksV1 {
  readonly billing: string;
  readonly devices: string;
  readonly signup: string;
  readonly cloud: string;
}

/** `GET /api/desktop/v1/meta` (no authentication). */
export interface NanoDesktopMetaV1 {
  readonly apiVersion: 1;
  readonly serverVersion: string;
  /** Semver; an older client answers `client-too-old` and asks to update. */
  readonly minClientVersion: string;
  readonly clientId: string;
  readonly capabilities: NanoCapabilitiesV1;
  readonly links: NanoLinksV1;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** RFC 6749 token response (`authorization_code` and `refresh_token` grants). */
export interface NanoTokenResponseV1 {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  /** Seconds; the host refreshes at 80 % of it or on a 401. */
  readonly expires_in: number;
  /** Rotated on every refresh; reuse of an old one revokes the device. */
  readonly refresh_token: string;
  readonly scope: string;
}

/** RFC 6749 §5.2 error of the token endpoint. */
export interface NanoTokenErrorV1 {
  readonly error: 'invalid_grant' | 'invalid_client' | 'invalid_request' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope';
  readonly error_description?: string;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface NanoUserV1 {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
}

export interface NanoDeviceV1 {
  readonly id: string;
  readonly name: string;
  /** RFC 3339, UTC. */
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

export type NanoWorkspaceRoleV1 = 'owner' | 'admin' | 'member';

export interface NanoWorkspaceV1 {
  readonly id: string;
  readonly name: string;
  readonly role: NanoWorkspaceRoleV1;
}

/** `GET /api/desktop/v1/devices`; `DELETE /api/desktop/v1/devices/{id}` answers 204. */
export interface NanoDevicesV1 {
  readonly devices: readonly NanoDeviceV1[];
}

/** `GET /api/desktop/v1/me`. */
export interface NanoMeV1 {
  readonly user: NanoUserV1;
  /** The device this token belongs to. */
  readonly device: NanoDeviceV1;
  readonly workspaces: readonly NanoWorkspaceV1[];
}

// ---------------------------------------------------------------------------
// Entitlements and usage
// ---------------------------------------------------------------------------

export type NanoModeIdV1 = 'auto' | 'free' | 'fast' | 'smart';
export const NANO_MODE_IDS: readonly NanoModeIdV1[] = ['auto', 'free', 'fast', 'smart'];

/** `mixed`: the server routes between tiers (auto). */
export type NanoModeTierV1 = 'mixed' | 'free' | 'cheap' | 'paid';
export type NanoModeLockV1 = 'plan' | 'credits' | 'disabled';
export type NanoModeInputV1 = 'text' | 'image';

export interface NanoModeV1 {
  readonly id: NanoModeIdV1;
  /** Display name localized by the server. */
  readonly name: string;
  readonly tier: NanoModeTierV1;
  readonly available: boolean;
  /** Set exactly when `available` is false. */
  readonly lockedReason: NanoModeLockV1 | null;
  /** Short server-localized price hint shown next to the mode. */
  readonly costHint: string | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly input: readonly NanoModeInputV1[];
  readonly reasoning: boolean;
}

export type NanoPlanKindV1 = 'free' | 'trial' | 'paid';

export interface NanoPlanV1 {
  readonly id: string;
  readonly name: string;
  readonly kind: NanoPlanKindV1;
  readonly renewsAt: string | null;
}

/** Whole credits; their money value is a server concern. */
export interface NanoCreditsV1 {
  readonly balance: number;
  /** Credits included in the current period, when the plan has a period. */
  readonly included: number | null;
  readonly periodEndsAt: string | null;
}

export interface NanoFeaturesV1 {
  readonly localAgent: boolean;
  readonly cloud: boolean;
  readonly dictation: boolean;
  readonly imageGeneration: boolean;
  readonly voice: boolean;
  readonly avatars: boolean;
}

export interface NanoLimitsV1 {
  /** Gateway requests in flight per device. */
  readonly maxConcurrentRequests: number;
  readonly maxRequestBytes: number;
  readonly dictationMaxBytes: number;
}

/** `GET /api/desktop/v1/workspaces/{workspaceId}/entitlements`. */
export interface NanoEntitlementsV1 {
  readonly workspaceId: string;
  readonly plan: NanoPlanV1;
  readonly credits: NanoCreditsV1;
  readonly modes: readonly NanoModeV1[];
  readonly features: NanoFeaturesV1;
  readonly limits: NanoLimitsV1;
}

export interface NanoModeUsageV1 {
  readonly mode: NanoModeIdV1;
  readonly credits: number;
  readonly requests: number;
}

/** `GET /api/desktop/v1/workspaces/{workspaceId}/usage`. */
export interface NanoUsageV1 {
  readonly workspaceId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly creditsUsed: number;
  readonly creditsRemaining: number;
  readonly byMode: readonly NanoModeUsageV1[];
}

// ---------------------------------------------------------------------------
// Media and cloud
// ---------------------------------------------------------------------------

/** `POST /api/desktop/v1/workspaces/{workspaceId}/media/dictation` (one audio part). */
export interface NanoDictationResultV1 {
  readonly text: string;
  readonly language: string | null;
  readonly durationMs: number | null;
}

/** `POST /api/desktop/v1/workspaces/{workspaceId}/cloud/launch`: a one-time URL. */
export interface NanoCloudLaunchV1 {
  readonly url: string;
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * HTTP status per code: 400 `invalid_request`; 401 `unauthorized`,
 * `token_expired`, `device_revoked`; 402 `credits_exhausted`,
 * `subscription_expired`; 403 `scope_missing`, `mode_not_in_plan`,
 * `feature_not_in_plan`, `desktop_local_disabled`; 404 `workspace_not_found`; 413
 * `payload_too_large`; 426 `client_too_old`; 429 `rate_limited`; 502/503
 * `upstream_unavailable`; 500 `internal`.
 */
export type NanoServerErrorCodeV1 =
  | 'invalid_request'
  | 'unauthorized'
  | 'token_expired'
  | 'device_revoked'
  | 'scope_missing'
  | 'credits_exhausted'
  | 'subscription_expired'
  | 'mode_not_in_plan'
  | 'feature_not_in_plan'
  | 'desktop_local_disabled'
  | 'workspace_not_found'
  | 'payload_too_large'
  | 'client_too_old'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'internal';

export interface NanoErrorBodyV1 {
  readonly error: {
    readonly code: NanoServerErrorCodeV1;
    /** Server-localized; the host shows its own copy, never this text, in the app. */
    readonly message: string;
    readonly retryable: boolean;
  };
}

/**
 * Errors the local relay answers to Pi in OpenAI shape
 * (`{"error":{"message","type":"nano","code"}}`), so the chat shows them.
 */
export type NanoRelayErrorCodeV1 =
  | 'nano_sign_in_required'
  | 'nano_credits_exhausted'
  | 'nano_mode_locked'
  | 'nano_rate_limited'
  | 'nano_offline'
  | 'nano_client_too_old'
  | 'nano_request_too_large'
  | 'nano_upstream_error';
