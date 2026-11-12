//! Dedicated Windows Codex app-server launch using a Nano Responses lease.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::acp_nano::AcpNanoMode;
use crate::nano::NanoRelayKey;

pub const PROVIDER: &str = "nano-codex-subscription";
pub(crate) const VERSION: &str = "0.165.0";
pub(crate) const SOURCE_ENV: &str = "PIUI_NANO_CODEX_SOURCE";
pub(crate) const NATIVE_ENTRY: &str =
    "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";
const NATIVE_SHA256: &str = "d4b2e6a054ea1dfe53217f9d8942c5f8a9f4b76171a1e0bb76ced5759915300a";

/// Exact executable in the official Windows x64 npm distribution.
pub(crate) fn verified_binary(path: &Path) -> bool {
    let Ok(mut binary) = File::open(path) else {
        return false;
    };
    let mut digest = Sha256::new();
    io::copy(&mut binary, &mut digest).is_ok()
        && format!("{:x}", digest.finalize()) == NATIVE_SHA256
}

pub struct CodexNanoSource {
    base_url: String,
    key: NanoRelayKey,
    modes: Vec<AcpNanoMode>,
    home: PathBuf,
}

impl CodexNanoSource {
    /// Accepts only a fixed loopback connector route and a private app-owned home.
    pub fn new(base_url: &str, key: &str, modes: Vec<AcpNanoMode>, home: PathBuf) -> Option<Self> {
        let (port, route) = base_url
            .strip_prefix("http://127.0.0.1:")?
            .split_once("/c/")?;
        let lease = route.strip_suffix("/v1")?;
        if port.parse::<u16>().ok()? == 0
            || lease.parse::<u64>().ok()? == 0
            || !port.bytes().all(|byte| byte.is_ascii_digit())
            || !lease.bytes().all(|byte| byte.is_ascii_digit())
            || key.len() != 43
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || modes.is_empty()
            || !home.is_absolute()
        {
            return None;
        }
        Some(Self {
            base_url: base_url.to_owned(),
            key: NanoRelayKey::new(key),
            modes,
            home,
        })
    }

    pub(crate) fn home(&self) -> &Path {
        &self.home
    }

    pub(crate) fn has_mode(&self, id: &str) -> bool {
        self.modes.iter().any(|mode| mode.id == id)
    }

    pub(crate) fn bridge_environment(&self) -> Result<String, serde_json::Error> {
        #[derive(Serialize)]
        struct Mode<'a> {
            id: &'a str,
            name: &'a str,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Source<'a> {
            base_url: &'a str,
            key: &'a str,
            modes: Vec<Mode<'a>>,
            home: &'a Path,
        }
        let modes = self
            .modes
            .iter()
            .map(|mode| Mode {
                id: &mode.id,
                name: &mode.name,
            })
            .collect();
        serde_json::to_string(&Source {
            base_url: &self.base_url,
            key: self.key.expose(),
            modes,
            home: &self.home,
        })
    }
}
