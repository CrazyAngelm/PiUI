//! The host-owned Pi agent directory of the Nano lane (`PI_CODING_AGENT_DIR`).
//!
//! It holds only non-secret configuration: `models.json` (one provider
//! `nano` pointing at the loopback relay, key taken from the environment
//! variable `NANO_RELAY_KEY` at request time), `settings.json` and the
//! approval guard extension. The guard lives in `extensions-guard/`, not in
//! `extensions/`, so Pi never discovers it by itself; the bridge passes it
//! with `-e` when the permission mode needs it. No credential is ever written
//! here.

use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use url::{Host, Url};

use crate::fsutil::atomic_write;
use crate::status::NANO_MODEL_PROVIDER;
use crate::wire::{NanoModeInputV1, NanoModeV1};

/// The environment variable the bridge sets in the Pi child only.
pub const RELAY_KEY_ENV: &str = "NANO_RELAY_KEY";
/// Directory of the guard extension inside the agent directory.
pub const GUARD_DIR: &str = "extensions-guard";
/// File name of the guard extension.
pub const GUARD_FILE: &str = "nano-guard.ts";

/// Paths of a prepared agent directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedAgentDir {
    pub dir: PathBuf,
    pub models_path: PathBuf,
    pub settings_path: PathBuf,
    /// Pass to Pi with `-e` (absent in `full-access`).
    pub guard_path: PathBuf,
}

/// Why the agent directory could not be prepared.
#[derive(Debug, thiserror::Error)]
pub enum AgentDirError {
    #[error("the relay URL is not http://127.0.0.1:<port>[/s/<session>]/v1")]
    InvalidRelayUrl,
    #[error("the agent directory could not be written")]
    Io(#[from] io::Error),
}

/// Writes `models.json`, `settings.json` and `extensions-guard/nano-guard.ts`
/// into `dir`, each atomically. Only `available` modes become models.
///
/// # Errors
/// [`AgentDirError::InvalidRelayUrl`] unless `relay_base_url` is
/// `http://127.0.0.1:<port>/v1` or `http://127.0.0.1:<port>/s/<session>/v1`; [`AgentDirError::Io`] for write failures.
pub fn prepare_pi_agent_dir(
    dir: &Path,
    relay_base_url: &str,
    modes: &[NanoModeV1],
    guard_source: &str,
) -> Result<PreparedAgentDir, AgentDirError> {
    validate_relay_url(relay_base_url)?;
    let models_path = dir.join("models.json");
    let settings_path = dir.join("settings.json");
    let guard_path = dir.join(GUARD_DIR).join(GUARD_FILE);

    let models = models_document(relay_base_url, modes);
    atomic_write(&models_path, &pretty(&models)?)?;
    let settings = settings_document(modes);
    atomic_write(&settings_path, &pretty(&settings)?)?;
    atomic_write(&guard_path, guard_source.as_bytes())?;

    Ok(PreparedAgentDir {
        dir: dir.to_path_buf(),
        models_path,
        settings_path,
        guard_path,
    })
}

fn pretty(value: &Value) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn validate_relay_url(raw: &str) -> Result<(), AgentDirError> {
    let url = Url::parse(raw).map_err(|_| AgentDirError::InvalidRelayUrl)?;
    let loopback = matches!(url.host(), Some(Host::Ipv4(ip)) if ip == Ipv4Addr::LOCALHOST);
    if url.scheme() != "http"
        || !loopback
        || url.port().is_none()
        || !relay_path(url.path().trim_end_matches('/'))
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AgentDirError::InvalidRelayUrl);
    }
    Ok(())
}

/// `/v1` or `/s/<digits>/v1`.
fn relay_path(path: &str) -> bool {
    if path == "/v1" {
        return true;
    }
    path.strip_prefix("/s/")
        .and_then(|rest| rest.strip_suffix("/v1"))
        .is_some_and(|id| {
            !id.is_empty() && id.len() <= 19 && id.bytes().all(|c| c.is_ascii_digit())
        })
}

/// `models.json` per Pi's models configuration reference.
fn models_document(relay_base_url: &str, modes: &[NanoModeV1]) -> Value {
    let models: Vec<Value> = modes
        .iter()
        .filter(|mode| mode.available)
        .map(|mode| {
            let input: Vec<&str> = mode
                .input
                .iter()
                .map(|input| match input {
                    NanoModeInputV1::Text => "text",
                    NanoModeInputV1::Image => "image",
                })
                .collect();
            let input = if input.is_empty() {
                vec!["text"]
            } else {
                input
            };
            let mut model = json!({
                "id": mode.id.as_str(),
                "name": mode.name,
                "reasoning": false,
                "input": input,
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            });
            if let Some(window) = mode.context_window {
                model["contextWindow"] = json!(window);
            }
            if let Some(max) = mode.max_output_tokens {
                model["maxTokens"] = json!(max);
            }
            model
        })
        .collect();
    let api_key = format!("${RELAY_KEY_ENV}");
    let provider = json!({
        "name": "Nano",
        "baseUrl": relay_base_url,
        "api": "openai-completions",
        "apiKey": api_key,
        "models": models,
    });
    let mut providers = serde_json::Map::new();
    providers.insert(NANO_MODEL_PROVIDER.to_owned(), provider);
    json!({ "providers": providers })
}

/// `settings.json`: Nano as the default provider, install telemetry and
/// analytics off, and the built-in MCP and llama.cpp extensions disabled
/// (the Nano lane has no MCP servers and no local models). Update checks are
/// off through `PI_SKIP_VERSION_CHECK` / `PI_OFFLINE` in the child env.
fn settings_document(modes: &[NanoModeV1]) -> Value {
    let mut settings = json!({
        "defaultProvider": NANO_MODEL_PROVIDER,
        "enableInstallTelemetry": false,
        "enableAnalytics": false,
        "extensions": ["-builtin:mcp", "-builtin:llama.cpp"],
    });
    if let Some(first) = modes.iter().find(|mode| mode.available) {
        settings["defaultModel"] = json!(first.id.as_str());
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::NanoEntitlementsV1;
    use crate::wire::tests::server_fixture;

    fn modes(key: &str) -> Vec<NanoModeV1> {
        let entitlements: NanoEntitlementsV1 =
            serde_json::from_value(server_fixture(key)).expect("entitlements");
        entitlements.modes
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).expect("read")).expect("json")
    }

    #[test]
    fn writes_provider_with_only_available_modes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let prepared = prepare_pi_agent_dir(
            dir.path(),
            "http://127.0.0.1:43123/v1",
            &modes("entitlementsFree"),
            "export default function () {}\n",
        )
        .expect("prepare");

        let models = read_json(&prepared.models_path);
        let provider = &models["providers"]["nano"];
        assert_eq!(provider["baseUrl"], "http://127.0.0.1:43123/v1");
        assert_eq!(provider["api"], "openai-completions");
        assert_eq!(provider["apiKey"], "$NANO_RELAY_KEY");
        let listed = provider["models"].as_array().expect("models");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["id"], "free");
        assert_eq!(listed[0]["name"], "Free");
        assert_eq!(listed[0]["contextWindow"], 131072);
        assert_eq!(listed[0]["maxTokens"], 8192);
        assert_eq!(listed[0]["reasoning"], false);
        assert_eq!(listed[0]["cost"]["output"], 0);

        let settings = read_json(&prepared.settings_path);
        assert_eq!(settings["defaultProvider"], "nano");
        assert_eq!(settings["defaultModel"], "free");
        assert_eq!(settings["enableInstallTelemetry"], false);

        assert_eq!(
            prepared.guard_path,
            dir.path().join("extensions-guard").join("nano-guard.ts")
        );
        assert!(!dir.path().join("extensions").exists());
        assert_eq!(
            std::fs::read_to_string(&prepared.guard_path).expect("guard"),
            "export default function () {}\n"
        );
        assert!(!dir.path().join("auth.json").exists());
    }

    #[test]
    fn paid_plan_lists_every_mode_and_rewrites_atomically() {
        let dir = tempfile::tempdir().expect("tempdir");
        let url = "http://127.0.0.1:43123/v1";
        prepare_pi_agent_dir(dir.path(), url, &modes("entitlementsFree"), "a").expect("first");
        let prepared =
            prepare_pi_agent_dir(dir.path(), url, &modes("entitlementsPaid"), "b").expect("second");
        let models = read_json(&prepared.models_path);
        let ids: Vec<&str> = models["providers"]["nano"]["models"]
            .as_array()
            .expect("models")
            .iter()
            .map(|model| model["id"].as_str().expect("id"))
            .collect();
        assert_eq!(ids, ["auto", "free", "fast", "smart"]);
        let leftovers = std::fs::read_dir(dir.path())
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn refuses_a_non_loopback_relay() {
        let dir = tempfile::tempdir().expect("tempdir");
        for url in [
            "https://nanoagents.ru/v1",
            "http://192.168.0.2:4000/v1",
            "http://localhost:4000/v1",
            "http://127.0.0.1:4000/other",
            "http://127.0.0.1/v1",
            "http://127.0.0.1:4000/s//v1",
            "http://127.0.0.1:4000/s/abc/v1",
            "http://127.0.0.1:4000/s/1/2/v1",
            "http://127.0.0.1:4000/v1#x",
        ] {
            assert!(
                matches!(
                    prepare_pi_agent_dir(dir.path(), url, &[], ""),
                    Err(AgentDirError::InvalidRelayUrl)
                ),
                "{url}"
            );
        }
        assert!(!dir.path().join("models.json").exists());
    }

    #[test]
    fn accepts_a_session_scoped_relay() {
        let dir = tempfile::tempdir().expect("tempdir");
        let url = "http://127.0.0.1:43123/s/7/v1";
        prepare_pi_agent_dir(dir.path(), url, &[], "").expect("session relay URL");
        let models: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("models.json")).expect("read"))
                .expect("json");
        assert_eq!(models["providers"]["nano"]["baseUrl"], url);
    }
}
