//! The isolated Nano model source of verified Windows Prime Agent 0.9.5.

use serde::Serialize;
use std::path::{Path, PathBuf};
use thiserror::Error;

pub(crate) const VERSION: &str = "0.9.5";
pub(crate) const SOURCE_ENV: &str = "PIUI_PRIME_NANO_SOURCE";
/// Model identity reserved by Nano Desktop. A native Prime provider named
/// `nano` retains its original catalog identity and saved model choices.
pub const PROVIDER: &str = "nano-desktop-subscription";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeNanoMode {
    pub id: String,
    pub name: String,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PrimeNanoSourceError {
    #[error("the Prime Nano connector has an invalid loopback lease URL")]
    Url,
    #[error("the Prime Nano connector has an invalid lease key")]
    Key,
    #[error("the Prime Nano connector has invalid entitled modes")]
    Modes,
    #[error("the Prime Nano connector home must be absolute")]
    Home,
    #[error("the Prime Nano connector configuration could not be built")]
    Config,
}

pub struct PrimeNanoSource {
    home: PathBuf,
    mode_ids: Vec<String>,
    bridge_environment_value: String,
}

impl std::fmt::Debug for PrimeNanoSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PrimeNanoSource(<redacted>)")
    }
}

impl PrimeNanoSource {
    /// # Errors
    /// Rejects an invalid lease URL, key, private home or entitled model list.
    pub fn new(
        base_url: &str,
        key: &str,
        modes: Vec<PrimeNanoMode>,
        home: PathBuf,
    ) -> Result<Self, PrimeNanoSourceError> {
        let loopback = base_url
            .strip_prefix("http://127.0.0.1:")
            .and_then(|rest| rest.split_once("/c/"))
            .is_some_and(|(port, lease)| {
                port.parse::<u16>()
                    .is_ok_and(|number| number != 0 && number.to_string() == port)
                    && lease.strip_suffix("/v1").is_some_and(|id| {
                        id.parse::<u64>()
                            .is_ok_and(|number| number != 0 && number.to_string() == id)
                    })
            });
        if !loopback {
            return Err(PrimeNanoSourceError::Url);
        }
        // Relay::register_connector issues an unpadded base64url key from 32 bytes.
        if key.len() != 43
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(PrimeNanoSourceError::Key);
        }
        if !home.is_absolute() {
            return Err(PrimeNanoSourceError::Home);
        }
        let mut mode_ids = Vec::new();
        for mode in &modes {
            if mode.id.is_empty()
                || !mode.id.bytes().all(|byte| byte.is_ascii_lowercase())
                || mode_ids.contains(&mode.id)
            {
                return Err(PrimeNanoSourceError::Modes);
            }
            mode_ids.push(mode.id.clone());
        }
        if mode_ids.is_empty() {
            return Err(PrimeNanoSourceError::Modes);
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Environment<'a> {
            base_url: &'a str,
            key: &'a str,
            modes: Vec<PrimeNanoMode>,
        }
        let bridge_environment_value = serde_json::to_string(&Environment {
            base_url,
            key,
            modes,
        })
        .map_err(|_| PrimeNanoSourceError::Config)?;
        Ok(Self {
            home,
            mode_ids,
            bridge_environment_value,
        })
    }

    pub(crate) fn has_mode(&self, id: &str) -> bool {
        self.mode_ids.iter().any(|mode| mode == id)
    }

    pub(crate) fn home(&self) -> &Path {
        &self.home
    }

    pub(crate) fn bridge_environment_value(&self) -> &str {
        &self.bridge_environment_value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_is_lease_scoped_and_redacts_the_key() {
        let home = std::env::temp_dir();
        let key = "z".repeat(43);
        let modes = || {
            vec![PrimeNanoMode {
                id: "auto".into(),
                name: "Auto".into(),
                context_window: None,
                max_output_tokens: None,
            }]
        };
        let base = "http://127.0.0.1:3219/c/1/v1";
        let source = PrimeNanoSource::new(base, &key, modes(), home.clone()).expect("valid source");
        assert!(source.has_mode("auto"));
        assert!(!source.has_mode("fast"));
        assert!(!format!("{source:?}").contains(&key));
        assert_eq!(
            PrimeNanoSource::new(base, "!some-command", modes(), home.clone()).err(),
            Some(PrimeNanoSourceError::Key)
        );
        assert_eq!(
            PrimeNanoSource::new("http://127.0.0.1:3219/v1", &key, modes(), home).err(),
            Some(PrimeNanoSourceError::Url)
        );
    }
}
