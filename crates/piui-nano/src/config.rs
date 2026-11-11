//! Which Nano server the host talks to.

use std::net::{Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

use crate::error::NanoError;
use crate::status::NanoServerInfoV1;
use crate::wire::{NANO_DEFAULT_ISSUER, NANO_DESKTOP_CLIENT_ID};

/// The development issuer override (debug builds and the
/// `e2e-webview-automation` feature only).
pub const ISSUER_ENV: &str = "PIUI_NANO_ISSUER";

/// The resolved Nano server and client identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NanoConfig {
    /// The OAuth issuer; always an origin (path `/`, no query).
    pub issuer: Url,
    /// `nano-desktop`.
    pub client_id: String,
    /// This application's version, compared with `minClientVersion`.
    pub app_version: semver::Version,
    /// True for any issuer other than [`NANO_DEFAULT_ISSUER`].
    pub development: bool,
}

impl NanoConfig {
    /// Resolves the issuer: [`ISSUER_ENV`] when `allow_override` (debug or
    /// E2E builds) and set, else the production issuer.
    ///
    /// # Errors
    /// [`NanoError::Invalid`] for an unusable override or app version. An
    /// invalid override never falls back to production silently.
    pub fn resolve(app_version: &str, allow_override: bool) -> Result<Self, NanoError> {
        let issuer = if allow_override {
            std::env::var(ISSUER_ENV)
                .ok()
                .filter(|value| !value.trim().is_empty())
        } else {
            None
        };
        Self::from_parts(issuer.as_deref(), app_version)
    }

    /// Builds a configuration from an optional issuer override.
    ///
    /// The issuer must be `https`, or `http` on a loopback host
    /// (`127.0.0.1`, `localhost`, `[::1]`) for a development server. It must
    /// be a bare origin without credentials, path, query or fragment.
    ///
    /// # Errors
    /// [`NanoError::Invalid`] when the issuer or the version is not usable.
    pub fn from_parts(issuer_override: Option<&str>, app_version: &str) -> Result<Self, NanoError> {
        let raw = issuer_override.map_or(NANO_DEFAULT_ISSUER, str::trim);
        let issuer = validate_issuer(raw)?;
        let app_version = semver::Version::parse(app_version).map_err(|_| NanoError::Invalid)?;
        let development = issuer.origin().ascii_serialization() != NANO_DEFAULT_ISSUER;
        Ok(Self {
            issuer,
            client_id: NANO_DESKTOP_CLIENT_ID.to_owned(),
            app_version,
            development,
        })
    }

    /// The issuer origin without a trailing slash, e.g. `https://nanoagents.ru`.
    pub fn origin(&self) -> String {
        self.issuer.origin().ascii_serialization()
    }

    /// The `server` member of the account status.
    pub fn server_info(&self) -> NanoServerInfoV1 {
        NanoServerInfoV1 {
            origin: self.origin(),
            development: self.development,
        }
    }

    /// Whether the issuer is a loopback development server.
    pub fn is_loopback(&self) -> bool {
        self.issuer
            .host()
            .is_some_and(|host| is_loopback_host(&host))
    }

    /// `{issuer}/api/desktop/v1/{segments...}`, each segment percent-encoded.
    pub fn api_url(&self, segments: &[&str]) -> Url {
        let mut all: Vec<&str> = vec!["api", "desktop", "v1"];
        all.extend_from_slice(segments);
        self.issuer_path(&all)
    }

    /// `{issuer}/.well-known/oauth-authorization-server`.
    pub fn metadata_url(&self) -> Url {
        self.issuer_path(&[".well-known", "oauth-authorization-server"])
    }

    fn issuer_path(&self, segments: &[&str]) -> Url {
        let mut url = self.issuer.clone();
        url.set_query(None);
        url.set_fragment(None);
        if let Ok(mut path) = url.path_segments_mut() {
            path.clear();
            path.extend(segments);
        }
        url
    }
}

pub(crate) fn is_loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => *ip == Ipv4Addr::LOCALHOST,
        Host::Ipv6(ip) => *ip == Ipv6Addr::LOCALHOST,
    }
}

fn validate_issuer(raw: &str) -> Result<Url, NanoError> {
    let url = Url::parse(raw).map_err(|_| NanoError::Invalid)?;
    let host = url.host().ok_or(NanoError::Invalid)?;
    let scheme_ok = match url.scheme() {
        "https" => true,
        "http" => is_loopback_host(&host),
        _ => false,
    };
    if !scheme_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(NanoError::Invalid);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_by_default() {
        let config = NanoConfig::from_parts(None, "0.3.0").expect("config");
        assert_eq!(config.origin(), "https://nanoagents.ru");
        assert!(!config.development);
        assert!(!config.is_loopback());
        assert_eq!(config.client_id, "nano-desktop");
        assert_eq!(
            config
                .api_url(&["workspaces", "ws/1", "entitlements"])
                .as_str(),
            "https://nanoagents.ru/api/desktop/v1/workspaces/ws%2F1/entitlements"
        );
        assert_eq!(
            config.metadata_url().as_str(),
            "https://nanoagents.ru/.well-known/oauth-authorization-server"
        );
    }

    #[test]
    fn resolve_without_override_ignores_the_environment() {
        let config = NanoConfig::resolve("0.3.0", false).expect("config");
        assert_eq!(config.origin(), NANO_DEFAULT_ISSUER);
    }

    #[test]
    fn loopback_http_is_a_development_issuer() {
        for issuer in [
            "http://127.0.0.1:8787",
            "http://localhost:8787/",
            "http://[::1]:8787",
        ] {
            let config = NanoConfig::from_parts(Some(issuer), "0.3.0").expect(issuer);
            assert!(config.development, "{issuer}");
            assert!(config.is_loopback(), "{issuer}");
        }
        let staging = NanoConfig::from_parts(Some("https://staging.nanoagents.ru"), "0.3.0")
            .expect("staging");
        assert!(staging.development);
    }

    #[test]
    fn unsafe_issuers_are_refused() {
        for issuer in [
            "http://nanoagents.ru",
            "http://192.168.1.5:8787",
            "ftp://127.0.0.1",
            concat!("https://user:pass", "@nanoagents.ru"),
            "https://nanoagents.ru/prefix",
            "https://nanoagents.ru/?q=1",
            "not a url",
        ] {
            assert_eq!(
                NanoConfig::from_parts(Some(issuer), "0.3.0"),
                Err(NanoError::Invalid),
                "{issuer}"
            );
        }
        assert_eq!(
            NanoConfig::from_parts(None, "not-semver"),
            Err(NanoError::Invalid)
        );
    }
}
