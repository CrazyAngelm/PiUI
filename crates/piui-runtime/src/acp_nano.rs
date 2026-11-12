//! Host-owned Nano model sources for OpenCode and Goose.
//!
//! A session started on the Nano source runs the user's installed, built-in
//! OpenCode (`acp:opencode`, never a shadow descriptor) with one isolated,
//! fixed provider: Chat Completions at the loopback relay's connector-lease
//! URL (`http://127.0.0.1:<port>/c/<lease>/v1`), a per-session lease key, and
//! exactly the modes the account is entitled to. The host builds an
//! [`AcpNanoSource`]; the runtime turns it into the process environment of
//! that session's bridge and agent.
//!
//! **Key path (exact).** The lease key is part of `OPENCODE_CONFIG_CONTENT`,
//! one environment variable of that session's own bridge process (the only
//! place the verified OpenCode accepts an inline provider configuration
//! without a file). The bridge removes it from its own environment after the
//! agent started; the agent inherits it. It is never in the `initialize`
//! frame or any other bridge frame, never in argv, never a file, an IPC
//! payload, a log, the descriptor registry or a catalog cache, and
//! [`AcpNanoSource`] has no `Display`, serialization or non-redacted `Debug`.
//!
//! **Reach of the key.** A single trusted host plugin uses OpenCode's native
//! `shell.env` hook to blank the inline configuration for shell descendants.
//! The bridge refuses prompts unless that plugin acknowledged this process.
//! MCP, LSP, formatters and ambient plugins are disabled. The OpenCode process
//! retains the key because ACP re-reads configuration on session creation.
//! Nothing here is a sandbox; the loopback lease is still session-bound and
//! revoked on sign-out. Shell commands and edits retain native approval.
//!
//! **Isolation.** The configuration enables only the `nano` provider, and the
//! agent's XDG directories point below a host-owned private folder, so the
//! user's own OpenCode configuration, credentials and history are neither read
//! nor written by a Nano-source session, and the user's global files are never
//! modified. The descriptor's pass-through names (API keys, proxies, a
//! configuration path) are not passed on this source.

use crate::nano::NanoRelayKey;
use serde_json::{Map, Value, json};
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// The only ACP agent with a Nano source (the built-in descriptor id).
pub const NANO_SOURCE_AGENT: &str = "opencode";
/// `WorkspaceModel.provider` of a Nano mode, as in the Nano lane; also the
/// provider id inside OpenCode (`nano/<mode>`).
pub const NANO_SOURCE_PROVIDER: &str = "nano";
pub const GOOSE_NANO_SOURCE_AGENT: &str = "goose";
pub const GOOSE_NANO_SOURCE_PROVIDER: &str = "nano-goose-subscription";
pub const GOOSE_NANO_VERSION: &str = "1.59.0";
/// SHA-256 of bin/goose.exe in the official Windows x64 npm package.
pub const GOOSE_NANO_EXE_SHA256: &str =
    "5a424ab992d75aaefdc54ccf27719f62c3995e6d9b283d1cca016ec4d4b055ef";
pub const GOOSE_NANO_SHELL_ENV: &str = "PIUI_GOOSE_NANO_SHELL";
pub const GOOSE_NANO_KEY_ENV: &str = "OPENAI_API_KEY";
/// The one variable that carries the inline OpenCode configuration.
pub const OPENCODE_CONFIG_CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";

/// The one app-owned OpenCode plugin, never a user or project plugin.
pub const OPENCODE_SHELL_PLUGIN: &str = "opencode-shell-env.mjs";
pub const OPENCODE_SHELL_PLUGIN_SOURCE: &str =
    include_str!("../bridge/bundled/opencode-shell-env.mjs");

/// Fixed, non-secret OpenCode switches: no project/default plugins, no other
/// agent ecosystems' skills, no dependency downloads, update check, model list
/// fetch or telemetry. Verified names of OpenCode 1.19.4's environment.
const OPENCODE_SWITCHES: [(&str, &str); 9] = [
    ("OPENCODE_DISABLE_PROJECT_CONFIG", "true"),
    ("OPENCODE_DISABLE_DEFAULT_PLUGINS", "true"),
    ("OPENCODE_DISABLE_EXTERNAL_SKILLS", "true"),
    ("OPENCODE_DISABLE_CLAUDE_CODE", "true"),
    ("OPENCODE_DISABLE_LSP_DOWNLOAD", "true"),
    ("OPENCODE_DISABLE_AUTOUPDATE", "true"),
    ("OPENCODE_DISABLE_MODELS_FETCH", "true"),
    ("npm_config_offline", "true"),
    ("DO_NOT_TRACK", "1"),
];

/// XDG variable -> folder below the private home.
const OPENCODE_HOME_FOLDERS: [(&str, &str); 9] = [
    ("XDG_CONFIG_HOME", "config"),
    ("XDG_DATA_HOME", "data"),
    ("XDG_STATE_HOME", "state"),
    ("XDG_CACHE_HOME", "cache"),
    ("HOME", "home"),
    ("USERPROFILE", "home"),
    ("APPDATA", "appdata"),
    ("LOCALAPPDATA", "localappdata"),
    ("PROGRAMDATA", "programdata"),
];

const GOOSE_HOME_FOLDERS: [(&str, &str); 7] = [
    ("HOME", "home"),
    ("USERPROFILE", "home"),
    ("APPDATA", "appdata"),
    ("LOCALAPPDATA", "localappdata"),
    ("PROGRAMDATA", "programdata"),
    ("TEMP", "tmp"),
    ("TMP", "tmp"),
];

const GOOSE_SWITCHES: [(&str, &str); 7] = [
    ("GOOSE_DISABLE_KEYRING", "1"),
    ("GOOSE_PROVIDER", "openai"),
    ("GOOSE_MODE", "approve"),
    ("GOOSE_DISABLE_SESSION_NAMING", "true"),
    ("GOOSE_TELEMETRY_ENABLED", "false"),
    ("OTEL_SDK_DISABLED", "true"),
    (GOOSE_NANO_SHELL_ENV, "1"),
];

/// One entitled Nano mode offered by the source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcpNanoMode {
    pub id: String,
    pub name: String,
}

/// Why a source was not built. Nothing is started.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum AcpNanoSourceError {
    #[error("the relay URL is not a loopback connector-lease URL")]
    Url,
    #[error("the lease key is empty, too long or has characters that cannot be a bearer token")]
    Key,
    #[error("the entitled modes are empty, duplicated or have invalid ids")]
    Modes,
    #[error("the private home is not an absolute path")]
    Home,
    #[error("the Goose shell helper is not an absolute path")]
    ShellHelper,
    #[error("the provider configuration could not be built")]
    Config,
}

#[derive(Clone)]
enum AcpNanoConfig {
    OpenCode(String),
    Goose {
        base_url: String,
        key: NanoRelayKey,
        context_window: Option<u64>,
        shell_helper: PathBuf,
    },
}

/// Isolated Nano provider wiring of one ACP start. Holds the lease key.
#[derive(Clone)]
pub struct AcpNanoSource {
    /// The source-specific configuration, including the lease key.
    config: AcpNanoConfig,
    home: PathBuf,
    modes: Vec<AcpNanoMode>,
}

impl fmt::Debug for AcpNanoSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AcpNanoSource")
            .field("modes", &self.modes.len())
            .field("config", &"<redacted>")
            .finish()
    }
}

fn valid_mode_id(id: &str) -> bool {
    !id.is_empty()
        && id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.'
        })
}

fn valid_lease_url(base_url: &str) -> bool {
    base_url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.split_once("/c/"))
        .is_some_and(|(port, lease)| {
            port.parse::<u16>().is_ok_and(|port| port != 0)
                && lease
                    .strip_suffix("/v1")
                    .is_some_and(|id| id.parse::<u64>().is_ok_and(|id| id != 0))
        })
}

fn validate_source(base_url: &str, key: &str, home: &Path) -> Result<(), AcpNanoSourceError> {
    if !valid_lease_url(base_url) {
        return Err(AcpNanoSourceError::Url);
    }
    if !NanoRelayKey::new(key).is_well_formed() {
        return Err(AcpNanoSourceError::Key);
    }
    if !home.is_absolute() {
        return Err(AcpNanoSourceError::Home);
    }
    Ok(())
}

fn normalize_mode(mode: AcpNanoMode) -> AcpNanoMode {
    let name: String = mode.name.chars().filter(|c| !c.is_control()).collect();
    let name = if name.trim().is_empty() {
        mode.id.clone()
    } else {
        name.trim().to_owned()
    };
    AcpNanoMode { id: mode.id, name }
}

impl AcpNanoSource {
    /// Builds the source of one session from the lease the host registered:
    /// `base_url` is `ConnectorLease::base_url()`, `key` its key, `modes` the
    /// account's available modes now (server order) and `home` the host's
    /// private OpenCode folder.
    ///
    /// # Errors
    /// [`AcpNanoSourceError`] for a URL that is not the loopback lease URL, a
    /// key that cannot be a bearer token, an invalid mode list or a relative
    /// home.
    pub fn opencode(
        base_url: &str,
        key: &str,
        modes: Vec<AcpNanoMode>,
        home: PathBuf,
    ) -> Result<Self, AcpNanoSourceError> {
        validate_source(base_url, key, &home)?;
        let mut seen = std::collections::HashSet::new();
        if modes.is_empty()
            || !modes
                .iter()
                .all(|mode| valid_mode_id(&mode.id) && seen.insert(mode.id.clone()))
        {
            return Err(AcpNanoSourceError::Modes);
        }
        let modes: Vec<AcpNanoMode> = modes.into_iter().map(normalize_mode).collect();

        let mut models = Map::new();
        for mode in &modes {
            models.insert(
                mode.id.clone(),
                json!({ "name": mode.name, "tool_call": true }),
            );
        }
        let first = modes
            .first()
            .map(|mode| mode.id.as_str())
            .ok_or(AcpNanoSourceError::Modes)?;
        let config = json!({
            "model": format!("{NANO_SOURCE_PROVIDER}/{first}"),
            "small_model": format!("{NANO_SOURCE_PROVIDER}/{first}"),
            "enabled_providers": [NANO_SOURCE_PROVIDER],
            "autoupdate": false,
            "share": "disabled",
            "plugin": [home.join("bundled").join(OPENCODE_SHELL_PLUGIN)],
            "mcp": {},
            "lsp": false,
            "formatter": false,
            // The Nano Pi lane asks before shell commands, writes and edits
            // in its default mode; the Nano source of OpenCode does too.
            "permission": { "edit": "ask", "bash": "ask" },
            "provider": {
                "nano": {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Nano",
                    "options": { "baseURL": base_url, "apiKey": key },
                    "models": Value::Object(models),
                }
            },
        });
        let config = serde_json::to_string(&config).map_err(|_| AcpNanoSourceError::Config)?;
        Ok(Self {
            config: AcpNanoConfig::OpenCode(config),
            home,
            modes,
        })
    }

    /// Creates a Goose session on one entitled mode.
    ///
    /// # Errors
    /// Returns an error for invalid lease data, mode or non-absolute paths.
    pub fn goose(
        base_url: &str,
        key: &str,
        mode: AcpNanoMode,
        context_window: Option<u64>,
        home: PathBuf,
        shell_helper: PathBuf,
    ) -> Result<Self, AcpNanoSourceError> {
        validate_source(base_url, key, &home)?;
        if !valid_mode_id(&mode.id) {
            return Err(AcpNanoSourceError::Modes);
        }
        if !shell_helper.is_absolute() {
            return Err(AcpNanoSourceError::ShellHelper);
        }
        Ok(Self {
            config: AcpNanoConfig::Goose {
                base_url: base_url.to_owned(),
                key: NanoRelayKey::new(key),
                context_window,
                shell_helper,
            },
            home,
            modes: vec![normalize_mode(mode)],
        })
    }

    #[must_use]
    pub fn agent(&self) -> &'static str {
        match self.config {
            AcpNanoConfig::OpenCode(_) => NANO_SOURCE_AGENT,
            AcpNanoConfig::Goose { .. } => GOOSE_NANO_SOURCE_AGENT,
        }
    }

    #[must_use]
    pub fn provider(&self) -> &'static str {
        match self.config {
            AcpNanoConfig::OpenCode(_) => NANO_SOURCE_PROVIDER,
            AcpNanoConfig::Goose { .. } => GOOSE_NANO_SOURCE_PROVIDER,
        }
    }

    #[must_use]
    pub fn args(&self) -> Option<&'static [&'static str]> {
        match self.config {
            AcpNanoConfig::OpenCode(_) => None,
            AcpNanoConfig::Goose { .. } => Some(&["acp", "--with-builtin", "developer"]),
        }
    }

    fn home_folders(&self) -> &[(&str, &str)] {
        match self.config {
            AcpNanoConfig::OpenCode(_) => &OPENCODE_HOME_FOLDERS,
            AcpNanoConfig::Goose { .. } => &GOOSE_HOME_FOLDERS,
        }
    }

    /// The modes the session offers, in server order.
    #[must_use]
    pub fn modes(&self) -> &[AcpNanoMode] {
        &self.modes
    }

    /// The private folders the agent's XDG variables name; the host creates
    /// them before the start.
    #[must_use]
    pub fn directories(&self) -> Vec<PathBuf> {
        self.home_folders()
            .iter()
            .map(|(_, folder)| self.home.join(folder))
            .collect()
    }

    /// Exactly the variables this source adds to the bridge environment, on
    /// top of the base environment and without the descriptor's pass-through
    /// names. The first value is the secret one.
    #[must_use]
    pub fn environment(&self) -> Vec<(OsString, OsString)> {
        let (mut variables, switches) = match &self.config {
            AcpNanoConfig::OpenCode(config) => (
                vec![(OPENCODE_CONFIG_CONTENT_ENV.into(), config.as_str().into())],
                OPENCODE_SWITCHES.as_slice(),
            ),
            AcpNanoConfig::Goose {
                base_url,
                key,
                context_window,
                shell_helper,
            } => {
                let mut variables = vec![
                    (GOOSE_NANO_KEY_ENV.into(), key.expose().into()),
                    ("OPENAI_BASE_URL".into(), base_url.as_str().into()),
                    ("GOOSE_PATH_ROOT".into(), self.home.as_os_str().into()),
                    ("GOOSE_SHELL".into(), shell_helper.as_os_str().into()),
                    ("GOOSE_MODEL".into(), self.modes[0].id.as_str().into()),
                ];
                if let Some(limit) = context_window {
                    variables.push(("GOOSE_CONTEXT_LIMIT".into(), limit.to_string().into()));
                }
                (variables, GOOSE_SWITCHES.as_slice())
            }
        };
        variables.extend(
            switches
                .iter()
                .map(|(name, value)| (OsString::from(*name), OsString::from(*value))),
        );
        variables.extend(self.home_folders().iter().map(|(name, folder)| {
            (
                OsString::from(*name),
                self.home.join(folder).into_os_string(),
            )
        }));
        variables
    }

    /// The private home (for tests and diagnostics; never secret).
    #[must_use]
    pub fn home(&self) -> &Path {
        &self.home
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "ck_0123456789abcdef-secret";
    const URL: &str = "http://127.0.0.1:4455/c/7/v1";

    fn mode(id: &str, name: &str) -> AcpNanoMode {
        AcpNanoMode {
            id: id.to_owned(),
            name: name.to_owned(),
        }
    }

    fn home() -> PathBuf {
        std::env::temp_dir().join("piui-acp-nano-home")
    }

    fn source() -> AcpNanoSource {
        AcpNanoSource::opencode(
            URL,
            KEY,
            vec![mode("auto", "Auto"), mode("fast", " ")],
            home(),
        )
        .expect("source")
    }

    #[test]
    fn the_configuration_enables_only_the_nano_provider_with_the_entitled_modes() {
        let AcpNanoConfig::OpenCode(config) = source().config else {
            panic!("expected OpenCode configuration");
        };
        let value: Value = serde_json::from_str(&config).expect("json");
        assert_eq!(NANO_SOURCE_PROVIDER, "nano");
        assert_eq!(value["enabled_providers"], json!(["nano"]));
        assert_eq!(value["model"], json!("nano/auto"));
        assert_eq!(value["autoupdate"], json!(false));
        assert_eq!(value["share"], json!("disabled"));
        assert_eq!(
            value["plugin"],
            json!([home().join("bundled").join(OPENCODE_SHELL_PLUGIN)])
        );
        assert_eq!(value["mcp"], json!({}));
        assert_eq!(value["lsp"], json!(false));
        assert_eq!(value["formatter"], json!(false));
        assert_eq!(value["permission"], json!({"edit": "ask", "bash": "ask"}));
        let provider = &value["provider"]["nano"];
        assert_eq!(provider["npm"], json!("@ai-sdk/openai-compatible"));
        assert_eq!(provider["options"]["baseURL"], json!(URL));
        assert_eq!(provider["options"]["apiKey"], json!(KEY));
        let models: Vec<&str> = provider["models"]
            .as_object()
            .expect("models")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(models.len(), 2);
        assert!(models.contains(&"auto") && models.contains(&"fast"));
        // A blank name falls back to the id; no provider model is ever named.
        assert_eq!(provider["models"]["fast"]["name"], json!("fast"));
        assert_eq!(value["provider"].as_object().expect("providers").len(), 1);
    }

    #[test]
    fn the_key_is_only_in_the_one_secret_variable_and_never_in_debug() {
        let source = source();
        let debug = format!("{source:?}{source:#?}");
        assert!(!debug.contains(KEY) && !debug.contains("4455") && !debug.contains("apiKey"));
        let environment = source.environment();
        let holders: Vec<&OsString> = environment
            .iter()
            .filter(|(_, value)| value.to_string_lossy().contains(KEY))
            .map(|(name, _)| name)
            .collect();
        assert_eq!(holders, [&OsString::from(OPENCODE_CONFIG_CONTENT_ENV)]);
    }

    #[test]
    fn the_environment_is_the_fixed_set_below_the_private_home() {
        let source = source();
        let names: Vec<String> = source
            .environment()
            .iter()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "OPENCODE_CONFIG_CONTENT",
                "OPENCODE_DISABLE_PROJECT_CONFIG",
                "OPENCODE_DISABLE_DEFAULT_PLUGINS",
                "OPENCODE_DISABLE_EXTERNAL_SKILLS",
                "OPENCODE_DISABLE_CLAUDE_CODE",
                "OPENCODE_DISABLE_LSP_DOWNLOAD",
                "OPENCODE_DISABLE_AUTOUPDATE",
                "OPENCODE_DISABLE_MODELS_FETCH",
                "npm_config_offline",
                "DO_NOT_TRACK",
                "XDG_CONFIG_HOME",
                "XDG_DATA_HOME",
                "XDG_STATE_HOME",
                "XDG_CACHE_HOME",
                "HOME",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
                "PROGRAMDATA",
            ]
        );
        for (name, value) in source.environment() {
            if name.to_string_lossy().starts_with("XDG_") {
                assert!(PathBuf::from(value).starts_with(home()));
            }
        }
        assert_eq!(source.directories().len(), OPENCODE_HOME_FOLDERS.len());
        assert!(
            source
                .directories()
                .iter()
                .all(|path| path.starts_with(home()))
        );
        assert_eq!(source.modes().len(), 2);
    }

    #[test]
    fn goose_keeps_the_key_in_one_environment_variable_and_one_mode() {
        let home = home();
        let helper = home.join("nano-desktop.exe");
        let source = AcpNanoSource::goose(
            URL,
            KEY,
            mode("fast", "Fast"),
            Some(128_000),
            home.clone(),
            helper.clone(),
        )
        .expect("source");
        assert_eq!(source.agent(), GOOSE_NANO_SOURCE_AGENT);
        assert_eq!(source.provider(), GOOSE_NANO_SOURCE_PROVIDER);
        assert_eq!(source.modes(), &[mode("fast", "Fast")]);
        assert_eq!(
            source.args(),
            Some(["acp", "--with-builtin", "developer"].as_slice())
        );
        let env: std::collections::HashMap<_, _> = source.environment().into_iter().collect();
        let value = |name: &str| env.get(std::ffi::OsStr::new(name)).map(OsString::as_os_str);
        assert_eq!(value(GOOSE_NANO_KEY_ENV), Some(std::ffi::OsStr::new(KEY)));
        assert_eq!(value("GOOSE_SHELL"), Some(helper.as_os_str()));
        assert_eq!(value("GOOSE_PATH_ROOT"), Some(home.as_os_str()));
        assert_eq!(value("GOOSE_MODEL"), Some(std::ffi::OsStr::new("fast")));
        assert_eq!(value("GOOSE_MODE"), Some(std::ffi::OsStr::new("approve")));
        assert!(
            source
                .directories()
                .iter()
                .all(|path| path.starts_with(&home))
        );
        assert_eq!(
            env.values()
                .filter(|value| value.to_string_lossy().contains(KEY))
                .count(),
            1
        );
        assert!(!format!("{source:?}").contains(KEY));
        assert_eq!(
            AcpNanoSource::goose(
                URL,
                KEY,
                mode("fast", "Fast"),
                None,
                home,
                PathBuf::from("relative")
            )
            .err(),
            Some(AcpNanoSourceError::ShellHelper)
        );
    }

    #[test]
    fn a_source_needs_a_loopback_lease_url_a_bearer_key_modes_and_an_absolute_home() {
        let modes = || vec![mode("auto", "Auto")];
        let build = |url: &str, key: &str, modes: Vec<AcpNanoMode>, home: PathBuf| {
            AcpNanoSource::opencode(url, key, modes, home).err()
        };
        for url in [
            "https://127.0.0.1:4455/c/7/v1",
            "http://example.com/c/7/v1",
            "http://127.0.0.1:4455/v1",
            "http://127.0.0.1:4455/s/7/v1",
            "http://127.0.0.1:4455/c/7/v1 ",
            "http://127.0.0.1:4455/c/7/v2",
            "http://127.0.0.1:4455@example.test/c/7/v1",
            "http://127.0.0.1:4455/c/not-a-lease/v1",
        ] {
            assert_eq!(
                build(url, KEY, modes(), home()),
                Some(AcpNanoSourceError::Url),
                "{url}"
            );
        }
        let too_long = "k".repeat(513);
        for key in ["", "has space", "line\nbreak", too_long.as_str()] {
            assert_eq!(
                build(URL, key, modes(), home()),
                Some(AcpNanoSourceError::Key)
            );
        }
        assert_eq!(
            build(URL, KEY, modes(), PathBuf::from("relative")),
            Some(AcpNanoSourceError::Home)
        );
        for bad in [
            Vec::new(),
            vec![mode("auto", "A"), mode("auto", "B")],
            vec![mode("a/b", "A")],
            vec![mode("", "A")],
            vec![mode("has space", "A")],
        ] {
            assert_eq!(
                build(URL, KEY, bad, home()),
                Some(AcpNanoSourceError::Modes)
            );
        }
    }
}
