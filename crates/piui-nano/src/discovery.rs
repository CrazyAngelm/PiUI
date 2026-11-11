//! Server discovery: RFC 8414 metadata and the desktop meta document.

use url::{Host, Url};

use crate::config::NanoConfig;
use crate::error::NanoError;
use crate::net::{API_TIMEOUT, json_answer};
use crate::wire::{NANO_SERVER_API_VERSION, NanoAuthServerMetadataV1, NanoDesktopMetaV1};

/// Validated site links (see [`site_url`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NanoSiteLinks {
    pub billing: Url,
    pub devices: Url,
    pub signup: Url,
    pub cloud: Url,
}

/// A validated Nano server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerDescription {
    /// The issuer origin, equal to the configured one.
    pub issuer: String,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub revocation_endpoint: Url,
    pub meta: NanoDesktopMetaV1,
    pub links: NanoSiteLinks,
}

/// Fetches and validates both discovery documents.
///
/// # Errors
/// [`NanoError::Offline`] when the server cannot be reached,
/// [`NanoError::ClientTooOld`] when `minClientVersion` is newer than this
/// app, [`NanoError::UnsupportedServer`] for anything else that is not a
/// desktop API v1 server on the configured issuer.
pub async fn discover(
    http: &reqwest::Client,
    config: &NanoConfig,
) -> Result<ServerDescription, NanoError> {
    let meta_request = fetch::<NanoDesktopMetaV1>(http, config.api_url(&["meta"]));
    let metadata_request = fetch::<NanoAuthServerMetadataV1>(http, config.metadata_url());
    let (meta, metadata) = tokio::join!(meta_request, metadata_request);
    validate(config, metadata?, meta?)
}

async fn fetch<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: Url,
) -> Result<T, NanoError> {
    let response = http
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|_| NanoError::Offline)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(NanoError::UnsupportedServer);
    }
    json_answer(response).await
}

/// Validates fetched documents against the configuration.
///
/// # Errors
/// As [`discover`], without [`NanoError::Offline`].
pub fn validate(
    config: &NanoConfig,
    metadata: NanoAuthServerMetadataV1,
    meta: NanoDesktopMetaV1,
) -> Result<ServerDescription, NanoError> {
    if meta.api_version != NANO_SERVER_API_VERSION || meta.client_id != config.client_id {
        return Err(NanoError::UnsupportedServer);
    }
    let minimum = semver::Version::parse(meta.min_client_version.trim())
        .map_err(|_| NanoError::UnsupportedServer)?;
    if config.app_version < minimum {
        return Err(NanoError::ClientTooOld);
    }

    let issuer = config.origin();
    if metadata.issuer.trim_end_matches('/') != issuer {
        return Err(NanoError::UnsupportedServer);
    }
    let has = |list: &[String], value: &str| list.iter().any(|item| item == value);
    if !has(&metadata.code_challenge_methods_supported, "S256")
        || !has(&metadata.grant_types_supported, "authorization_code")
        || !has(&metadata.grant_types_supported, "refresh_token")
    {
        return Err(NanoError::UnsupportedServer);
    }
    let authorization_endpoint = endpoint(config, &metadata.authorization_endpoint)?;
    let token_endpoint = endpoint(config, &metadata.token_endpoint)?;
    let revocation_endpoint = endpoint(config, &metadata.revocation_endpoint)?;

    let link = |raw: &str| site_url(config, raw).map_err(|_| NanoError::UnsupportedServer);
    let links = NanoSiteLinks {
        billing: link(&meta.links.billing)?,
        devices: link(&meta.links.devices)?,
        signup: link(&meta.links.signup)?,
        cloud: link(&meta.links.cloud)?,
    };

    Ok(ServerDescription {
        issuer,
        authorization_endpoint,
        token_endpoint,
        revocation_endpoint,
        meta,
        links,
    })
}

/// An OAuth endpoint: on the issuer origin (same scheme, host and port),
/// without credentials or fragment.
fn endpoint(config: &NanoConfig, raw: &str) -> Result<Url, NanoError> {
    let url = Url::parse(raw).map_err(|_| NanoError::UnsupportedServer)?;
    if url.origin() != config.issuer.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(NanoError::UnsupportedServer);
    }
    Ok(url)
}

/// A page the host may open in the system browser: `https` on the issuer
/// host or one of its subdomains, default port, no credentials. A loopback
/// development issuer also allows its own origin over `http`.
///
/// # Errors
/// [`NanoError::Invalid`] for any other URL.
pub fn site_url(config: &NanoConfig, raw: &str) -> Result<Url, NanoError> {
    let url = Url::parse(raw).map_err(|_| NanoError::Invalid)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NanoError::Invalid);
    }
    if config.is_loopback() && url.origin() == config.issuer.origin() {
        return Ok(url);
    }
    let Some(Host::Domain(issuer_host)) = config.issuer.host() else {
        return Err(NanoError::Invalid);
    };
    let Some(Host::Domain(host)) = url.host() else {
        return Err(NanoError::Invalid);
    };
    let issuer_host = issuer_host.to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    let on_site = host == issuer_host || host.ends_with(&format!(".{issuer_host}"));
    if url.scheme() != "https" || url.port().is_some() || !on_site {
        return Err(NanoError::Invalid);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::tests::server_fixture;

    fn production() -> NanoConfig {
        NanoConfig::from_parts(None, "0.3.0").expect("config")
    }

    fn documents() -> (NanoAuthServerMetadataV1, NanoDesktopMetaV1) {
        (
            serde_json::from_value(server_fixture("oauthMetadata")).expect("metadata"),
            serde_json::from_value(server_fixture("meta")).expect("meta"),
        )
    }

    #[test]
    fn fixtures_describe_a_valid_server() {
        let (metadata, meta) = documents();
        let server = validate(&production(), metadata, meta).expect("valid");
        assert_eq!(server.issuer, "https://nanoagents.ru");
        assert_eq!(
            server.token_endpoint.as_str(),
            "https://nanoagents.ru/connect/token"
        );
        assert_eq!(server.links.cloud.as_str(), "https://hermes.nanoagents.ru/");
    }

    #[test]
    fn older_client_is_too_old() {
        let (metadata, meta) = documents();
        let config = NanoConfig::from_parts(None, "0.2.11").expect("config");
        assert_eq!(
            validate(&config, metadata, meta),
            Err(NanoError::ClientTooOld)
        );
    }

    #[test]
    fn issuer_mismatch_and_foreign_endpoints_are_unsupported() {
        let (mut metadata, meta) = documents();
        metadata.issuer = "https://evil.example".to_owned();
        assert_eq!(
            validate(&production(), metadata, meta),
            Err(NanoError::UnsupportedServer)
        );

        let (mut metadata, meta) = documents();
        metadata.token_endpoint = "https://evil.example/connect/token".to_owned();
        assert_eq!(
            validate(&production(), metadata, meta),
            Err(NanoError::UnsupportedServer)
        );

        let (mut metadata, meta) = documents();
        metadata.token_endpoint = "http://nanoagents.ru/connect/token".to_owned();
        assert_eq!(
            validate(&production(), metadata, meta),
            Err(NanoError::UnsupportedServer)
        );

        let (mut metadata, meta) = documents();
        metadata.authorization_endpoint = "https://nanoagents.ru:8443/connect/authorize".to_owned();
        assert_eq!(
            validate(&production(), metadata, meta),
            Err(NanoError::UnsupportedServer)
        );
    }

    #[test]
    fn missing_s256_or_wrong_api_version_is_unsupported() {
        let (mut metadata, meta) = documents();
        metadata.code_challenge_methods_supported = vec!["plain".to_owned()];
        assert_eq!(
            validate(&production(), metadata, meta),
            Err(NanoError::UnsupportedServer)
        );

        let (metadata, mut meta) = documents();
        meta.api_version = 2;
        assert_eq!(
            validate(&production(), metadata, meta),
            Err(NanoError::UnsupportedServer)
        );

        let (metadata, mut meta) = documents();
        meta.client_id = "other".to_owned();
        assert_eq!(
            validate(&production(), metadata, meta),
            Err(NanoError::UnsupportedServer)
        );
    }

    #[test]
    fn links_stay_on_the_issuer_site() {
        let config = production();
        assert!(site_url(&config, "https://nanoagents.ru/billing").is_ok());
        assert!(site_url(&config, "https://hermes.nanoagents.ru/").is_ok());
        for bad in [
            "http://nanoagents.ru/billing",
            "https://nanoagents.ru.evil.example/",
            "https://evilnanoagents.ru/",
            "https://nanoagents.ru:8443/",
            concat!("https://user", "@nanoagents.ru/"),
            "javascript:alert(1)",
        ] {
            assert_eq!(site_url(&config, bad), Err(NanoError::Invalid), "{bad}");
        }

        let (metadata, mut meta) = documents();
        meta.links.billing = "https://evil.example/pay".to_owned();
        assert_eq!(
            validate(&config, metadata, meta),
            Err(NanoError::UnsupportedServer)
        );
    }

    #[test]
    fn loopback_development_links_may_use_http_on_the_issuer() {
        let config = NanoConfig::from_parts(Some("http://127.0.0.1:8787"), "0.3.0").expect("dev");
        assert!(site_url(&config, "http://127.0.0.1:8787/billing").is_ok());
        assert!(site_url(&config, "http://127.0.0.1:9999/billing").is_err());
    }
}
