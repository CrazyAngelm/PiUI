//! The host's HTTP client to the Nano server and response helpers.

use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::config::NanoConfig;
use crate::error::NanoError;
use crate::wire::{NanoErrorBodyV1, NanoServerErrorCodeV1};

/// Timeout of ordinary account requests (not of gateway streams).
pub(crate) const API_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest account document the host reads.
pub(crate) const MAX_API_BODY: usize = 2 * 1024 * 1024;
/// Largest error document the host reads.
pub(crate) const MAX_ERROR_BODY: usize = 64 * 1024;

/// `X-Nano-Client: nano-desktop/<version>`, on every request to the server.
pub(crate) const CLIENT_HEADER: &str = "x-nano-client";
/// `X-Nano-Device: <device id>`, on gateway requests (informational).
pub(crate) const DEVICE_HEADER: &str = "x-nano-device";
/// `X-Nano-Session: <relay session tag>`, on gateway requests (informational).
pub(crate) const SESSION_HEADER: &str = "x-nano-session";

/// A rustls client with the ring provider and the platform verifier
/// (Windows/macOS trust store), no redirects, https only for an https issuer
/// and no proxy for a loopback development issuer. Every request carries
/// `X-Nano-Client` (informational, never an authentication input).
pub(crate) fn build_client(config: &NanoConfig) -> Result<reqwest::Client, NanoError> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::HeaderName::from_static(CLIENT_HEADER),
        reqwest::header::HeaderValue::from_str(&client_header_value(config))
            .map_err(|_| NanoError::Offline)?,
    );
    let mut builder = base_builder()?
        .user_agent(format!("NanoDesktop/{}", config.app_version))
        .default_headers(headers)
        .https_only(config.issuer.scheme() == "https");
    if config.is_loopback() {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| NanoError::Offline)
}

/// `nano-desktop/<app version>`.
pub(crate) fn client_header_value(config: &NanoConfig) -> String {
    format!("{}/{}", config.client_id, config.app_version)
}

pub(crate) fn base_builder() -> Result<reqwest::ClientBuilder, NanoError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone())
        .map_err(|_| NanoError::Offline)?;
    let mut tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| NanoError::Offline)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(300)))
}

/// Reads at most `cap` bytes of a body; a longer body is
/// [`NanoError::UnsupportedServer`], a broken one [`NanoError::Offline`].
pub(crate) async fn read_capped(
    response: &mut reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, NanoError> {
    if response
        .content_length()
        .is_some_and(|length| length > cap as u64)
    {
        return Err(NanoError::UnsupportedServer);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| NanoError::Offline)? {
        if body.len() + chunk.len() > cap {
            return Err(NanoError::UnsupportedServer);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// A refused server response: its status and, when the body was a
/// `NanoErrorBodyV1`, its code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ServerFailure {
    pub status: u16,
    pub code: Option<NanoServerErrorCodeV1>,
}

impl ServerFailure {
    pub(crate) async fn read(mut response: reqwest::Response) -> Self {
        let status = response.status().as_u16();
        let code = read_capped(&mut response, MAX_ERROR_BODY)
            .await
            .ok()
            .and_then(|body| serde_json::from_slice::<NanoErrorBodyV1>(&body).ok())
            .map(|body| body.error.code);
        Self { status, code }
    }

    pub(crate) fn account_error(self) -> NanoError {
        match self.code {
            Some(code) => NanoError::from_server_code(code),
            None => NanoError::from_http_status(self.status),
        }
    }

    pub(crate) fn too_large(self) -> bool {
        self.status == 413 || self.code == Some(NanoServerErrorCodeV1::PayloadTooLarge)
    }
}

/// Parses a successful JSON answer or maps a refused one.
pub(crate) async fn json_answer<T: DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, NanoError> {
    if !response.status().is_success() {
        return Err(ServerFailure::read(response).await.account_error());
    }
    let body = read_capped(&mut response, MAX_API_BODY).await?;
    serde_json::from_slice(&body).map_err(|_| NanoError::UnsupportedServer)
}
