//! Serde mirror of `contracts/nano-server-v1.ts` (host <-> Nano server).
//!
//! OAuth documents (RFC 8414 metadata, RFC 6749 token answers) are
//! snake_case; every desktop API document is camelCase. Server documents
//! tolerate unknown fields (a newer server may add some) but closed value sets
//! (`NanoModeIdV1`, roles, tiers, error codes) reject unknown values.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::NanoError;
use crate::secret::SecretString;

/// `NANO_SERVER_API_VERSION`.
pub const NANO_SERVER_API_VERSION: u32 = 1;
/// `NANO_DESKTOP_API_PREFIX`.
pub const NANO_DESKTOP_API_PREFIX: &str = "/api/desktop/v1";
/// `NANO_DESKTOP_CLIENT_ID`.
pub const NANO_DESKTOP_CLIENT_ID: &str = "nano-desktop";
/// `NANO_DESKTOP_SCOPES`, space-joined for the authorization request.
pub const NANO_DESKTOP_SCOPE: &str = "openid profile offline_access nano.desktop";
/// `NANO_REDIRECT_PATH`.
pub const NANO_REDIRECT_PATH: &str = "/callback";
/// `NANO_DEFAULT_ISSUER`.
pub const NANO_DEFAULT_ISSUER: &str = "https://nanoagents.ru";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// RFC 8414 metadata; only the fields the host reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NanoAuthServerMetadataV1 {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_authorization_endpoint: Option<String>,
    pub code_challenge_methods_supported: Vec<String>,
    pub grant_types_supported: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes_supported: Option<Vec<String>>,
}

/// What the server offers to desktop clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoCapabilitiesV1 {
    pub gateway: bool,
    pub cloud_launch: bool,
    pub device_code: bool,
    pub dictation: bool,
    pub voice: bool,
    pub image_generation: bool,
    pub avatars: bool,
}

/// Absolute https URLs on the issuer's site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoLinksV1 {
    pub billing: String,
    pub devices: String,
    pub signup: String,
    pub cloud: String,
}

/// `GET /api/desktop/v1/meta` (no authentication).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoDesktopMetaV1 {
    /// Must be 1; checked by discovery so a newer server reports
    /// `unsupported-server` instead of a parse failure.
    pub api_version: u32,
    pub server_version: String,
    pub min_client_version: String,
    pub client_id: String,
    pub capabilities: NanoCapabilitiesV1,
    pub links: NanoLinksV1,
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/// RFC 6749 token response. `Debug` is redacted.
#[derive(Clone, Deserialize)]
pub struct NanoTokenResponseV1 {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub refresh_token: String,
    #[serde(default)]
    pub scope: Option<String>,
}

impl fmt::Debug for NanoTokenResponseV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NanoTokenResponseV1")
            .field("access_token", &"<redacted>")
            .field("token_type", &self.token_type)
            .field("expires_in", &self.expires_in)
            .field("refresh_token", &"<redacted>")
            .field("scope", &self.scope)
            .finish()
    }
}

impl NanoTokenResponseV1 {
    /// Moves the two tokens into [`SecretString`]s.
    pub fn into_secrets(self) -> (SecretString, SecretString, u64) {
        let Self {
            access_token,
            refresh_token,
            expires_in,
            ..
        } = self;
        (
            SecretString::new(access_token),
            SecretString::new(refresh_token),
            expires_in,
        )
    }
}

/// RFC 6749 section 5.2 error code of the token endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NanoTokenErrorCodeV1 {
    InvalidGrant,
    InvalidClient,
    InvalidRequest,
    UnauthorizedClient,
    UnsupportedGrantType,
    InvalidScope,
}

/// RFC 6749 section 5.2 error body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NanoTokenErrorV1 {
    pub error: NanoTokenErrorCodeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_description: Option<String>,
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoUserV1 {
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoDeviceV1 {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
}

/// `GET /api/desktop/v1/devices`; `DELETE /api/desktop/v1/devices/{id}`
/// answers 204.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoDevicesV1 {
    pub devices: Vec<NanoDeviceV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoWorkspaceRoleV1 {
    Owner,
    Admin,
    Member,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoWorkspaceV1 {
    pub id: String,
    pub name: String,
    pub role: NanoWorkspaceRoleV1,
}

/// `GET /api/desktop/v1/me`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoMeV1 {
    pub user: NanoUserV1,
    pub device: NanoDeviceV1,
    pub workspaces: Vec<NanoWorkspaceV1>,
}

// ---------------------------------------------------------------------------
// Entitlements and usage
// ---------------------------------------------------------------------------

/// The four Nano modes; the server picks the provider model behind each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoModeIdV1 {
    Auto,
    Free,
    Fast,
    Smart,
}

impl NanoModeIdV1 {
    /// `NANO_MODE_IDS`, in contract order.
    pub const ALL: [Self; 4] = [Self::Auto, Self::Free, Self::Fast, Self::Smart];

    /// The wire id (`auto`, `free`, `fast`, `smart`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Free => "free",
            Self::Fast => "fast",
            Self::Smart => "smart",
        }
    }

    /// Parses a wire id; anything else is `None`.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.as_str() == value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoModeTierV1 {
    Mixed,
    Free,
    Cheap,
    Paid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoModeLockV1 {
    Plan,
    Credits,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoModeInputV1 {
    Text,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoModeV1 {
    pub id: NanoModeIdV1,
    /// Display name localized by the server.
    pub name: String,
    pub tier: NanoModeTierV1,
    pub available: bool,
    /// Set exactly when `available` is false.
    pub locked_reason: Option<NanoModeLockV1>,
    pub cost_hint: Option<String>,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub input: Vec<NanoModeInputV1>,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoPlanKindV1 {
    Free,
    Trial,
    Paid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoPlanV1 {
    pub id: String,
    pub name: String,
    pub kind: NanoPlanKindV1,
    pub renews_at: Option<String>,
}

/// Whole credits; their money value is a server concern.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoCreditsV1 {
    pub balance: i64,
    pub included: Option<i64>,
    pub period_ends_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoFeaturesV1 {
    pub local_agent: bool,
    pub cloud: bool,
    pub dictation: bool,
    pub image_generation: bool,
    pub voice: bool,
    pub avatars: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoLimitsV1 {
    /// Gateway requests in flight per device.
    pub max_concurrent_requests: u32,
    pub max_request_bytes: u64,
    pub dictation_max_bytes: u64,
}

/// `GET /api/desktop/v1/workspaces/{workspaceId}/entitlements`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoEntitlementsV1 {
    pub workspace_id: String,
    pub plan: NanoPlanV1,
    pub credits: NanoCreditsV1,
    pub modes: Vec<NanoModeV1>,
    pub features: NanoFeaturesV1,
    pub limits: NanoLimitsV1,
}

impl NanoEntitlementsV1 {
    /// Checks the invariants serde cannot express: `lockedReason` is set
    /// exactly when a mode is unavailable, and each mode appears once.
    ///
    /// # Errors
    /// [`NanoError::UnsupportedServer`] when an invariant does not hold.
    pub fn validate(&self) -> Result<(), NanoError> {
        let mut seen = Vec::with_capacity(self.modes.len());
        for mode in &self.modes {
            if mode.available == mode.locked_reason.is_some() || seen.contains(&mode.id) {
                return Err(NanoError::UnsupportedServer);
            }
            seen.push(mode.id);
        }
        Ok(())
    }

    /// Whether `mode` is listed and available.
    pub fn mode_available(&self, mode: NanoModeIdV1) -> bool {
        self.modes.iter().any(|row| row.id == mode && row.available)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoModeUsageV1 {
    pub mode: NanoModeIdV1,
    pub credits: i64,
    pub requests: u64,
}

/// `GET /api/desktop/v1/workspaces/{workspaceId}/usage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoUsageV1 {
    pub workspace_id: String,
    pub period_start: String,
    pub period_end: String,
    pub credits_used: i64,
    pub credits_remaining: i64,
    pub by_mode: Vec<NanoModeUsageV1>,
}

// ---------------------------------------------------------------------------
// Media and cloud
// ---------------------------------------------------------------------------

/// `POST /api/desktop/v1/workspaces/{workspaceId}/media/dictation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoDictationResultV1 {
    pub text: String,
    pub language: Option<String>,
    pub duration_ms: Option<u64>,
}

/// `POST /api/desktop/v1/workspaces/{workspaceId}/cloud/launch`. The URL
/// carries a one-time code, so `Debug` is redacted.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoCloudLaunchV1 {
    pub url: String,
    pub expires_at: String,
}

impl fmt::Debug for NanoCloudLaunchV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NanoCloudLaunchV1")
            .field("url", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// `NanoServerErrorCodeV1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NanoServerErrorCodeV1 {
    InvalidRequest,
    Unauthorized,
    TokenExpired,
    DeviceRevoked,
    ScopeMissing,
    CreditsExhausted,
    SubscriptionExpired,
    ModeNotInPlan,
    FeatureNotInPlan,
    DesktopLocalDisabled,
    WorkspaceNotFound,
    PayloadTooLarge,
    ClientTooOld,
    RateLimited,
    UpstreamUnavailable,
    Internal,
}

impl NanoServerErrorCodeV1 {
    /// Every code, in contract order.
    pub const ALL: [Self; 16] = [
        Self::InvalidRequest,
        Self::Unauthorized,
        Self::TokenExpired,
        Self::DeviceRevoked,
        Self::ScopeMissing,
        Self::CreditsExhausted,
        Self::SubscriptionExpired,
        Self::ModeNotInPlan,
        Self::FeatureNotInPlan,
        Self::DesktopLocalDisabled,
        Self::WorkspaceNotFound,
        Self::PayloadTooLarge,
        Self::ClientTooOld,
        Self::RateLimited,
        Self::UpstreamUnavailable,
        Self::Internal,
    ];

    /// The snake_case wire code.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Unauthorized => "unauthorized",
            Self::TokenExpired => "token_expired",
            Self::DeviceRevoked => "device_revoked",
            Self::ScopeMissing => "scope_missing",
            Self::CreditsExhausted => "credits_exhausted",
            Self::SubscriptionExpired => "subscription_expired",
            Self::ModeNotInPlan => "mode_not_in_plan",
            Self::FeatureNotInPlan => "feature_not_in_plan",
            Self::DesktopLocalDisabled => "desktop_local_disabled",
            Self::WorkspaceNotFound => "workspace_not_found",
            Self::PayloadTooLarge => "payload_too_large",
            Self::ClientTooOld => "client_too_old",
            Self::RateLimited => "rate_limited",
            Self::UpstreamUnavailable => "upstream_unavailable",
            Self::Internal => "internal",
        }
    }
}

/// The `error` member of [`NanoErrorBodyV1`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoErrorDetailV1 {
    pub code: NanoServerErrorCodeV1,
    /// Server-localized; never shown in the app.
    pub message: String,
    pub retryable: bool,
}

/// A refused desktop API request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoErrorBodyV1 {
    pub error: NanoErrorDetailV1,
}

/// `NanoRelayErrorCodeV1`: errors the loopback relay answers to Pi in
/// OpenAI shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NanoRelayErrorCodeV1 {
    NanoSignInRequired,
    NanoCreditsExhausted,
    NanoModeLocked,
    NanoRateLimited,
    NanoOffline,
    NanoClientTooOld,
    NanoRequestTooLarge,
    NanoUpstreamError,
}

impl NanoRelayErrorCodeV1 {
    /// Every code, in contract order.
    pub const ALL: [Self; 8] = [
        Self::NanoSignInRequired,
        Self::NanoCreditsExhausted,
        Self::NanoModeLocked,
        Self::NanoRateLimited,
        Self::NanoOffline,
        Self::NanoClientTooOld,
        Self::NanoRequestTooLarge,
        Self::NanoUpstreamError,
    ];

    /// The snake_case wire code.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NanoSignInRequired => "nano_sign_in_required",
            Self::NanoCreditsExhausted => "nano_credits_exhausted",
            Self::NanoModeLocked => "nano_mode_locked",
            Self::NanoRateLimited => "nano_rate_limited",
            Self::NanoOffline => "nano_offline",
            Self::NanoClientTooOld => "nano_client_too_old",
            Self::NanoRequestTooLarge => "nano_request_too_large",
            Self::NanoUpstreamError => "nano_upstream_error",
        }
    }

    /// The HTTP status the relay answers with this code.
    pub const fn http_status(self) -> u16 {
        match self {
            Self::NanoSignInRequired => 401,
            Self::NanoCreditsExhausted => 402,
            Self::NanoModeLocked => 403,
            Self::NanoRateLimited => 429,
            Self::NanoOffline => 503,
            Self::NanoClientTooOld => 426,
            Self::NanoRequestTooLarge => 413,
            Self::NanoUpstreamError => 502,
        }
    }

    /// The English message Pi shows in the chat.
    pub const fn message(self) -> &'static str {
        match self {
            Self::NanoSignInRequired => "Sign in to Nano in Nano Desktop to use this model.",
            Self::NanoCreditsExhausted => {
                "Your Nano credits are used up. Top up or change your plan to continue."
            }
            Self::NanoModeLocked => "This Nano mode is not available on your plan.",
            Self::NanoRateLimited => "Too many Nano requests at once. Try again shortly.",
            Self::NanoOffline => "Nano is unreachable. Check your connection and try again.",
            Self::NanoClientTooOld => {
                "This version of Nano Desktop is too old. Update it to continue."
            }
            Self::NanoRequestTooLarge => "The request is too large for Nano.",
            Self::NanoUpstreamError => "Nano could not complete the request.",
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::Value;

    pub(crate) const SERVER_FIXTURES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/fixtures/nano-server-v1.json"
    ));
    pub(crate) const SERVER_CONTRACT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/nano-server-v1.ts"
    ));

    pub(crate) fn server_fixture(key: &str) -> Value {
        let all: Value = serde_json::from_str(SERVER_FIXTURES).expect("fixture json");
        all.get(key)
            .cloned()
            .unwrap_or_else(|| panic!("fixture {key}"))
    }

    /// The string members of `export type <name> = 'a' | 'b' ...;`.
    pub(crate) fn ts_union(source: &str, name: &str) -> Vec<String> {
        let start = source
            .find(&format!("export type {name} ="))
            .unwrap_or_else(|| panic!("union {name}"));
        let rest = &source[start..];
        let end = rest.find(';').expect("union end");
        rest[..end]
            .split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    fn round_trip<T: serde::de::DeserializeOwned + Serialize>(key: &str) {
        let value = server_fixture(key);
        let parsed: T = serde_json::from_value(value.clone()).expect(key);
        assert_eq!(
            serde_json::to_value(&parsed).expect("serialize"),
            value,
            "{key}"
        );
    }

    #[test]
    fn every_server_fixture_deserializes() {
        round_trip::<NanoAuthServerMetadataV1>("oauthMetadata");
        round_trip::<NanoDesktopMetaV1>("meta");
        round_trip::<NanoTokenErrorV1>("tokenError");
        round_trip::<NanoMeV1>("me");
        round_trip::<NanoEntitlementsV1>("entitlementsFree");
        round_trip::<NanoEntitlementsV1>("entitlementsPaid");
        round_trip::<NanoUsageV1>("usage");
        round_trip::<NanoDictationResultV1>("dictation");

        let token: NanoTokenResponseV1 =
            serde_json::from_value(server_fixture("token")).expect("token");
        assert_eq!(token.token_type, "Bearer");
        assert_eq!(token.expires_in, 600);
        assert!(!format!("{token:?}").contains("synthetic-access-token"));

        let launch: NanoCloudLaunchV1 =
            serde_json::from_value(server_fixture("cloudLaunch")).expect("launch");
        assert!(!format!("{launch:?}").contains("synthetic-one-time-code"));

        let errors = server_fixture("errors");
        let errors = errors.as_object().expect("errors object");
        assert!(!errors.is_empty());
        for (code, entry) in errors {
            let body: NanoErrorBodyV1 =
                serde_json::from_value(entry["body"].clone()).expect("error body");
            assert_eq!(body.error.code.as_str(), code);
            assert!(entry["status"].as_u64().is_some());
        }
    }

    #[test]
    fn entitlement_fixtures_validate() {
        for key in ["entitlementsFree", "entitlementsPaid"] {
            let parsed: NanoEntitlementsV1 =
                serde_json::from_value(server_fixture(key)).expect(key);
            parsed.validate().expect(key);
        }
    }

    #[test]
    fn closed_sets_reject_unknown_values() {
        let mut value = server_fixture("entitlementsPaid");
        value["modes"][0]["id"] = Value::from("ultra");
        assert!(serde_json::from_value::<NanoEntitlementsV1>(value).is_err());

        let mut me = server_fixture("me");
        me["workspaces"][0]["role"] = Value::from("guest");
        assert!(serde_json::from_value::<NanoMeV1>(me).is_err());

        let body = serde_json::json!({ "error": { "code": "teapot", "message": "x", "retryable": false } });
        assert!(serde_json::from_value::<NanoErrorBodyV1>(body).is_err());
    }

    #[test]
    fn locked_reason_must_match_availability() {
        let mut value = server_fixture("entitlementsFree");
        value["modes"][1]["lockedReason"] = Value::from("plan");
        let parsed: NanoEntitlementsV1 = serde_json::from_value(value).expect("parse");
        assert_eq!(parsed.validate(), Err(NanoError::UnsupportedServer));

        let mut value = server_fixture("entitlementsFree");
        value["modes"][2]["id"] = Value::from("free");
        let parsed: NanoEntitlementsV1 = serde_json::from_value(value).expect("parse");
        assert_eq!(parsed.validate(), Err(NanoError::UnsupportedServer));
    }

    #[test]
    fn rust_code_sets_match_the_typescript_contract() {
        let server: Vec<String> = NanoServerErrorCodeV1::ALL
            .iter()
            .map(|code| code.as_str().to_owned())
            .collect();
        assert_eq!(server, ts_union(SERVER_CONTRACT, "NanoServerErrorCodeV1"));

        let relay: Vec<String> = NanoRelayErrorCodeV1::ALL
            .iter()
            .map(|code| code.as_str().to_owned())
            .collect();
        assert_eq!(relay, ts_union(SERVER_CONTRACT, "NanoRelayErrorCodeV1"));

        let modes: Vec<String> = NanoModeIdV1::ALL
            .iter()
            .map(|m| m.as_str().to_owned())
            .collect();
        assert_eq!(modes, ts_union(SERVER_CONTRACT, "NanoModeIdV1"));

        for code in NanoServerErrorCodeV1::ALL {
            assert_eq!(
                serde_json::to_value(code).expect("code"),
                Value::from(code.as_str())
            );
        }
        for code in NanoRelayErrorCodeV1::ALL {
            assert_eq!(
                serde_json::to_value(code).expect("code"),
                Value::from(code.as_str())
            );
        }
    }

    #[test]
    fn devices_list_parses() {
        let value = serde_json::json!({ "devices": [server_fixture("me")["device"].clone()] });
        let parsed: NanoDevicesV1 = serde_json::from_value(value.clone()).expect("devices");
        assert_eq!(parsed.devices.len(), 1);
        assert_eq!(serde_json::to_value(&parsed).expect("serialize"), value);
    }
}
