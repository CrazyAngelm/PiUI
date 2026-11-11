//! The typed error of every Nano operation (`NanoAccountErrorCodeV1`).

use serde::{Deserialize, Serialize};

use crate::wire::{NanoRelayErrorCodeV1, NanoServerErrorCodeV1};

/// A Nano failure. Its serde form and [`NanoError::code`] are exactly the
/// kebab-case members of `NanoAccountErrorCodeV1` in
/// `contracts/nano-account-v1.ts`; the WebView receives only that code.
///
/// The `Display` text is English and contains no server text, token or URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "kebab-case")]
pub enum NanoError {
    #[error("the request is not valid")]
    Invalid,
    #[error("safe mode is on")]
    SafeMode,
    #[error("another Nano account operation is in progress")]
    Busy,
    #[error("the Nano server could not be reached")]
    Offline,
    #[error("the Nano server does not offer the desktop API v1")]
    UnsupportedServer,
    #[error("this Nano Desktop version is older than the server accepts")]
    ClientTooOld,
    #[error("sign in to Nano first")]
    SignInRequired,
    #[error("sign-in was cancelled")]
    SignInCancelled,
    #[error("sign-in timed out")]
    SignInTimeout,
    #[error("sign-in failed")]
    SignInFailed,
    #[error("this device was signed out of Nano")]
    DeviceRevoked,
    #[error("the Nano workspace was not found")]
    WorkspaceNotFound,
    #[error("the credential store failed")]
    CredentialStoreFailed,
    #[error("the system browser could not be opened")]
    BrowserFailed,
    #[error("Nano credits are used up")]
    CreditsExhausted,
    #[error("this Nano mode is locked")]
    ModeLocked,
    #[error("Nano rate limit reached")]
    RateLimited,
    #[error("this Nano feature is not available")]
    FeatureUnavailable,
}

impl NanoError {
    /// Every code, in contract order.
    pub const ALL: [Self; 18] = [
        Self::Invalid,
        Self::SafeMode,
        Self::Busy,
        Self::Offline,
        Self::UnsupportedServer,
        Self::ClientTooOld,
        Self::SignInRequired,
        Self::SignInCancelled,
        Self::SignInTimeout,
        Self::SignInFailed,
        Self::DeviceRevoked,
        Self::WorkspaceNotFound,
        Self::CredentialStoreFailed,
        Self::BrowserFailed,
        Self::CreditsExhausted,
        Self::ModeLocked,
        Self::RateLimited,
        Self::FeatureUnavailable,
    ];

    /// The `NanoAccountErrorCodeV1` code.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::SafeMode => "safe-mode",
            Self::Busy => "busy",
            Self::Offline => "offline",
            Self::UnsupportedServer => "unsupported-server",
            Self::ClientTooOld => "client-too-old",
            Self::SignInRequired => "sign-in-required",
            Self::SignInCancelled => "sign-in-cancelled",
            Self::SignInTimeout => "sign-in-timeout",
            Self::SignInFailed => "sign-in-failed",
            Self::DeviceRevoked => "device-revoked",
            Self::WorkspaceNotFound => "workspace-not-found",
            Self::CredentialStoreFailed => "credential-store-failed",
            Self::BrowserFailed => "browser-failed",
            Self::CreditsExhausted => "credits-exhausted",
            Self::ModeLocked => "mode-locked",
            Self::RateLimited => "rate-limited",
            Self::FeatureUnavailable => "feature-unavailable",
        }
    }

    /// Parses a `NanoAccountErrorCodeV1` code.
    pub fn from_code(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|error| error.code() == code)
    }

    /// The account error a server error body code stands for.
    pub const fn from_server_code(code: NanoServerErrorCodeV1) -> Self {
        match code {
            NanoServerErrorCodeV1::InvalidRequest | NanoServerErrorCodeV1::PayloadTooLarge => {
                Self::Invalid
            }
            NanoServerErrorCodeV1::Unauthorized
            | NanoServerErrorCodeV1::TokenExpired
            | NanoServerErrorCodeV1::ScopeMissing => Self::SignInRequired,
            NanoServerErrorCodeV1::DeviceRevoked => Self::DeviceRevoked,
            NanoServerErrorCodeV1::CreditsExhausted
            | NanoServerErrorCodeV1::SubscriptionExpired => Self::CreditsExhausted,
            NanoServerErrorCodeV1::ModeNotInPlan => Self::ModeLocked,
            NanoServerErrorCodeV1::FeatureNotInPlan
            | NanoServerErrorCodeV1::DesktopLocalDisabled => Self::FeatureUnavailable,
            NanoServerErrorCodeV1::WorkspaceNotFound => Self::WorkspaceNotFound,
            NanoServerErrorCodeV1::ClientTooOld => Self::ClientTooOld,
            NanoServerErrorCodeV1::RateLimited => Self::RateLimited,
            NanoServerErrorCodeV1::UpstreamUnavailable | NanoServerErrorCodeV1::Internal => {
                Self::Offline
            }
        }
    }

    /// The account error for a refused response without a readable
    /// `NanoErrorBodyV1`, by HTTP status.
    pub const fn from_http_status(status: u16) -> Self {
        match status {
            401 => Self::SignInRequired,
            402 => Self::CreditsExhausted,
            403 => Self::FeatureUnavailable,
            413 => Self::Invalid,
            426 => Self::ClientTooOld,
            429 => Self::RateLimited,
            500..=599 => Self::Offline,
            _ => Self::UnsupportedServer,
        }
    }

    /// The relay code Pi sees for this failure.
    pub const fn relay_code(self) -> NanoRelayErrorCodeV1 {
        match self {
            Self::SignInRequired
            | Self::SignInCancelled
            | Self::SignInTimeout
            | Self::SignInFailed
            | Self::DeviceRevoked => NanoRelayErrorCodeV1::NanoSignInRequired,
            Self::CreditsExhausted => NanoRelayErrorCodeV1::NanoCreditsExhausted,
            Self::ModeLocked | Self::FeatureUnavailable => NanoRelayErrorCodeV1::NanoModeLocked,
            Self::RateLimited => NanoRelayErrorCodeV1::NanoRateLimited,
            Self::Offline => NanoRelayErrorCodeV1::NanoOffline,
            Self::ClientTooOld => NanoRelayErrorCodeV1::NanoClientTooOld,
            Self::Invalid
            | Self::SafeMode
            | Self::Busy
            | Self::UnsupportedServer
            | Self::WorkspaceNotFound
            | Self::CredentialStoreFailed
            | Self::BrowserFailed => NanoRelayErrorCodeV1::NanoUpstreamError,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::tests::ts_union;

    const ACCOUNT_CONTRACT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/nano-account-v1.ts"
    ));

    #[test]
    fn codes_match_the_typescript_contract_exactly() {
        let ours: Vec<String> = NanoError::ALL.iter().map(|e| e.code().to_owned()).collect();
        assert_eq!(ours, ts_union(ACCOUNT_CONTRACT, "NanoAccountErrorCodeV1"));
        for error in NanoError::ALL {
            assert_eq!(
                serde_json::to_value(error).expect("serialize"),
                serde_json::Value::from(error.code())
            );
            assert_eq!(NanoError::from_code(error.code()), Some(error));
        }
        assert_eq!(NanoError::from_code("teapot"), None);
        assert!(serde_json::from_value::<NanoError>(serde_json::Value::from("teapot")).is_err());
    }

    #[test]
    fn server_codes_map_to_account_codes() {
        use NanoServerErrorCodeV1 as S;
        assert_eq!(
            NanoError::from_server_code(S::CreditsExhausted),
            NanoError::CreditsExhausted
        );
        assert_eq!(
            NanoError::from_server_code(S::ModeNotInPlan),
            NanoError::ModeLocked
        );
        assert_eq!(
            NanoError::from_server_code(S::FeatureNotInPlan),
            NanoError::FeatureUnavailable
        );
        assert_eq!(
            NanoError::from_server_code(S::DeviceRevoked),
            NanoError::DeviceRevoked
        );
        assert_eq!(
            NanoError::from_server_code(S::ClientTooOld),
            NanoError::ClientTooOld
        );
        assert_eq!(
            NanoError::from_server_code(S::RateLimited),
            NanoError::RateLimited
        );
        assert_eq!(
            NanoError::from_server_code(S::TokenExpired),
            NanoError::SignInRequired
        );
        assert_eq!(NanoError::from_http_status(503), NanoError::Offline);
        assert_eq!(
            NanoError::CreditsExhausted.relay_code(),
            NanoRelayErrorCodeV1::NanoCreditsExhausted
        );
    }
}
