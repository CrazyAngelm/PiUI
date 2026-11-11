//! OAuth 2.0 for the public client `nano-desktop`: authorization code with
//! PKCE (S256), rotating refresh tokens and revocation (RFC 7009).

use std::fmt;
use std::time::Duration;

use url::Url;
use url::form_urlencoded::Serializer;

use crate::config::NanoConfig;
use crate::discovery::ServerDescription;
use crate::error::NanoError;
use crate::net::{API_TIMEOUT, MAX_ERROR_BODY, read_capped};
use crate::secret::SecretString;
use crate::wire::{
    NANO_DESKTOP_SCOPE, NanoErrorBodyV1, NanoTokenErrorCodeV1, NanoTokenErrorV1,
    NanoTokenResponseV1,
};

const MAX_TOKEN_LIFETIME_SECS: u64 = 24 * 60 * 60;

/// The device name the server shows in the device list. It names the
/// platform only, never the host or user name.
pub const fn device_name() -> &'static str {
    if cfg!(windows) {
        "Nano Desktop on Windows"
    } else if cfg!(target_os = "macos") {
        "Nano Desktop on macOS"
    } else {
        "Nano Desktop on Linux"
    }
}

/// The `device_platform` sent with the code exchange.
pub const fn device_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// A token answer. `Debug` is redacted.
#[derive(Clone)]
pub struct TokenSet {
    pub access_token: SecretString,
    /// Rotated on every refresh; store it before using `access_token`.
    pub refresh_token: SecretString,
    pub expires_in: Duration,
}

impl fmt::Debug for TokenSet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenSet")
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

/// Why a token request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenFailure {
    /// `invalid_grant`: the code or refresh token is no longer valid
    /// (revoked device, reused or expired refresh token).
    Rejected,
    /// The server could not be reached or answered 5xx.
    Offline,
    /// Any other refusal.
    Server(NanoError),
}

impl TokenFailure {
    /// The account error of a failed authorization-code exchange.
    pub const fn sign_in_error(self) -> NanoError {
        match self {
            Self::Rejected => NanoError::SignInFailed,
            Self::Offline => NanoError::Offline,
            Self::Server(error) => error,
        }
    }
}

/// The authorization URL to open in the system browser.
pub fn authorization_url(
    server: &ServerDescription,
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &SecretString,
) -> Url {
    let mut url = server.authorization_endpoint.clone();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", NANO_DESKTOP_SCOPE)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state.expose())
        .append_pair("device_name", device_name());
    url
}

/// Exchanges an authorization code; `device_name` names the new device.
///
/// # Errors
/// See [`TokenFailure`].
pub async fn exchange_code(
    http: &reqwest::Client,
    server: &ServerDescription,
    config: &NanoConfig,
    code: &SecretString,
    verifier: &SecretString,
    redirect_uri: &str,
) -> Result<TokenSet, TokenFailure> {
    let form = Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", code.expose())
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("client_id", &config.client_id)
        .append_pair("code_verifier", verifier.expose())
        .append_pair("device_name", device_name())
        .append_pair("device_platform", device_platform())
        .append_pair("app_version", &config.app_version.to_string())
        .finish();
    token_request(http, &server.token_endpoint, SecretString::new(form)).await
}

/// Uses a refresh token. The answer carries a new refresh token that
/// replaces the old one, which the server no longer accepts.
///
/// # Errors
/// See [`TokenFailure`].
pub async fn refresh(
    http: &reqwest::Client,
    server: &ServerDescription,
    config: &NanoConfig,
    refresh_token: &SecretString,
) -> Result<TokenSet, TokenFailure> {
    let form = Serializer::new(String::new())
        .append_pair("grant_type", "refresh_token")
        .append_pair("refresh_token", refresh_token.expose())
        .append_pair("client_id", &config.client_id)
        .finish();
    token_request(http, &server.token_endpoint, SecretString::new(form)).await
}

/// Revokes a refresh token (RFC 7009).
///
/// # Errors
/// [`NanoError::Offline`] when the server cannot be reached, else the
/// refusal; callers treat revocation as best effort.
pub async fn revoke(
    http: &reqwest::Client,
    server: &ServerDescription,
    config: &NanoConfig,
    refresh_token: &SecretString,
) -> Result<(), NanoError> {
    let form = SecretString::new(
        Serializer::new(String::new())
            .append_pair("token", refresh_token.expose())
            .append_pair("token_type_hint", "refresh_token")
            .append_pair("client_id", &config.client_id)
            .finish(),
    );
    let response = http
        .post(server.revocation_endpoint.clone())
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(form.expose().to_owned())
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| NanoError::Offline)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(NanoError::from_http_status(response.status().as_u16()))
    }
}

async fn token_request(
    http: &reqwest::Client,
    endpoint: &Url,
    form: SecretString,
) -> Result<TokenSet, TokenFailure> {
    let mut response = http
        .post(endpoint.clone())
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .header(reqwest::header::ACCEPT, "application/json")
        .body(form.expose().to_owned())
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|_| TokenFailure::Offline)?;
    let status = response.status();
    let body = read_capped(&mut response, MAX_ERROR_BODY)
        .await
        .map_err(|error| match error {
            NanoError::Offline => TokenFailure::Offline,
            other => TokenFailure::Server(other),
        })?;
    if status.is_success() {
        let answer: NanoTokenResponseV1 = serde_json::from_slice(&body)
            .map_err(|_| TokenFailure::Server(NanoError::UnsupportedServer))?;
        if !answer.token_type.eq_ignore_ascii_case("bearer")
            || answer.access_token.is_empty()
            || answer.refresh_token.is_empty()
            || answer.expires_in == 0
        {
            return Err(TokenFailure::Server(NanoError::UnsupportedServer));
        }
        let (access_token, refresh_token, expires_in) = answer.into_secrets();
        // Clamp absurd lifetimes so `Instant` arithmetic cannot overflow.
        let expires_in = Duration::from_secs(expires_in.min(MAX_TOKEN_LIFETIME_SECS));
        return Ok(TokenSet {
            access_token,
            refresh_token,
            expires_in,
        });
    }
    if let Ok(error) = serde_json::from_slice::<NanoTokenErrorV1>(&body) {
        return Err(match error.error {
            NanoTokenErrorCodeV1::InvalidGrant => TokenFailure::Rejected,
            NanoTokenErrorCodeV1::InvalidScope => TokenFailure::Server(NanoError::SignInFailed),
            NanoTokenErrorCodeV1::InvalidClient
            | NanoTokenErrorCodeV1::InvalidRequest
            | NanoTokenErrorCodeV1::UnauthorizedClient
            | NanoTokenErrorCodeV1::UnsupportedGrantType => {
                TokenFailure::Server(NanoError::UnsupportedServer)
            }
        });
    }
    if let Ok(error) = serde_json::from_slice::<NanoErrorBodyV1>(&body) {
        return Err(match NanoError::from_server_code(error.error.code) {
            NanoError::DeviceRevoked => TokenFailure::Rejected,
            NanoError::Offline => TokenFailure::Offline,
            other => TokenFailure::Server(other),
        });
    }
    if status.is_server_error() {
        Err(TokenFailure::Offline)
    } else {
        Err(TokenFailure::Server(NanoError::from_http_status(
            status.as_u16(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::validate;
    use crate::wire::tests::server_fixture;

    #[test]
    fn authorization_url_carries_pkce_and_state() {
        let config = NanoConfig::from_parts(None, "0.3.0").expect("config");
        let server = validate(
            &config,
            serde_json::from_value(server_fixture("oauthMetadata")).expect("metadata"),
            serde_json::from_value(server_fixture("meta")).expect("meta"),
        )
        .expect("server");
        let state = SecretString::new("st".to_owned());
        let url = authorization_url(
            &server,
            "nano-desktop",
            "http://127.0.0.1:5555/callback",
            "ch",
            &state,
        );
        assert!(
            url.as_str()
                .starts_with("https://nanoagents.ru/connect/authorize?")
        );
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("response_type"), Some("code"));
        assert_eq!(get("client_id"), Some("nano-desktop"));
        assert_eq!(get("redirect_uri"), Some("http://127.0.0.1:5555/callback"));
        assert_eq!(
            get("scope"),
            Some("openid profile offline_access nano.desktop")
        );
        assert_eq!(get("code_challenge"), Some("ch"));
        assert_eq!(get("code_challenge_method"), Some("S256"));
        assert_eq!(get("state"), Some("st"));
        assert_eq!(get("device_name"), Some(device_name()));
    }

    #[test]
    fn device_name_names_only_the_platform() {
        assert!(device_name().starts_with("Nano Desktop on "));
        assert!(
            ["Windows", "macOS", "Linux"]
                .iter()
                .any(|os| device_name().ends_with(os))
        );
    }

    #[test]
    fn token_set_debug_is_redacted() {
        let tokens = TokenSet {
            access_token: SecretString::new("synthetic-access".to_owned()),
            refresh_token: SecretString::new("synthetic-refresh".to_owned()),
            expires_in: Duration::from_secs(600),
        };
        assert!(!format!("{tokens:?}").contains("synthetic"));
    }
}
