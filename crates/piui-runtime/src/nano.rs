//! Launch contract of the built-in `nano` harness (ADR-048).
//!
//! Nano is the user's installed upstream Pi (>= 1.4.0) driven by the Pi bridge
//! in a "nano lane": a host-owned agent directory whose `models.json` points at
//! the host relay, an optional host-written approval guard extension, and a
//! per-session relay key that only the Pi child process may see. The host fills
//! [`NanoRuntimeLaunch`] before a start; the runtime refuses a Nano launch
//! without it ([`crate::workspace_runtime::NativeRuntimeError::NanoNotReady`])
//! and never lets the key reach any other harness bridge.
//!
//! **Key path.** The key is never part of the `initialize` frame. The runtime
//! starts each Nano bridge (one Node process per Nano session) from a cleared
//! environment: [`nano_bridge_environment`] plus [`NANO_RELAY_KEY_BRIDGE_ENV`].
//! The bridge reads that variable once, removes it from its own environment
//! and hands the key only to its Pi child, as `NANO_RELAY_KEY`.

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::PathBuf;

/// Source of the approval guard extension. The host writes it next to the
/// private `models.json` and passes the path as
/// [`NanoRuntimeLaunch::guard_extension`] (Pi loads it with `-e`). Pi asks the
/// guard before `bash`, `write` and `edit` in `native` permission mode.
pub const NANO_GUARD_EXTENSION_SOURCE: &str = include_str!("../bridge/nano-guard.ts");

/// Trusted files written below the Nano agent directory's `bundled/` folder.
pub const NANO_BUNDLED_ASSETS: &[(&str, &str)] = &[
    (
        "relay-auth.cjs",
        include_str!("../bridge/bundled/relay-auth.cjs"),
    ),
    (
        "skill-paths.ts",
        include_str!("../bridge/bundled/skill-paths.ts"),
    ),
    (
        "windows-powershell.ts",
        include_str!("../bridge/bundled/windows-powershell.ts"),
    ),
    (
        "bes-deep-mode/SKILL.md",
        include_str!("../bridge/bundled/bes-deep-mode/SKILL.md"),
    ),
    (
        "bes-deep-mode/LICENSE",
        include_str!("../bridge/bundled/bes-deep-mode/LICENSE"),
    ),
];

/// Longest relay key the runtime accepts, in bytes.
const MAX_RELAY_KEY_BYTES: usize = 512;

/// The Nano bridge process variable that carries the relay key. Set only on
/// a Nano bridge; `bridge/pi.mjs` reads and removes it at startup.
pub const NANO_RELAY_KEY_BRIDGE_ENV: &str = "PIUI_NANO_RELAY_KEY";

/// What a Nano bridge (and the Pi it starts, and the programs Pi's tools run)
/// needs from the user's environment on Windows: system and profile
/// locations, executable lookup, temp, locale. No secrets. Kept identical to
/// the Pi child allowlist in `bridge/pi.mjs` (a test compares them).
pub const NANO_WINDOWS_ENVIRONMENT: &[&str] = &[
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PATH",
    "NODEFAULTCURRENTDIRECTORYINEXEPATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "ALLUSERSPROFILE",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "PSMODULEPATH",
    "LANG",
    "TZ",
    "TERM",
];

/// The POSIX counterpart of [`NANO_WINDOWS_ENVIRONMENT`].
pub const NANO_POSIX_ENVIRONMENT: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "TZ",
    "TERM",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
];

/// The inherited part of a Nano bridge environment: the platform allowlist
/// and `LC_*`, filtered from `host`. Names compare case-insensitively on
/// Windows (`windows`), where the environment block is; a name that is not
/// Unicode never matches. Proxy variables are left out on purpose: they can
/// embed credentials and the relay is on loopback.
#[must_use]
pub fn nano_bridge_environment(
    host: &[(OsString, OsString)],
    windows: bool,
) -> Vec<(OsString, OsString)> {
    let allowed = if windows {
        NANO_WINDOWS_ENVIRONMENT
    } else {
        NANO_POSIX_ENVIRONMENT
    };
    let kept = |name: &OsStr| {
        name.to_str().is_some_and(|name| {
            let canonical = if windows {
                name.to_ascii_uppercase()
            } else {
                name.to_owned()
            };
            canonical.starts_with("LC_") || allowed.iter().any(|entry| *entry == canonical)
        })
    };
    host.iter()
        .filter(|(name, _)| kept(name))
        .cloned()
        .collect()
}

/// Per-session secret the host relay accepts from the Pi child.
///
/// It reaches the bridge only through its process environment
/// ([`NANO_RELAY_KEY_BRIDGE_ENV`]). Every other surface is closed: it does not
/// serialize, `Debug` is redacted and there is no `Display`.
#[derive(Clone, PartialEq, Eq)]
pub struct NanoRelayKey(String);

impl NanoRelayKey {
    #[must_use]
    pub fn new(key: impl Into<String>) -> Self {
        Self(key.into())
    }

    /// The secret itself. Call only to hand it to the bridge process
    /// environment or the relay.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// A key is 1-512 visible ASCII characters: it becomes an environment
    /// value and an HTTP bearer token, so whitespace and controls never fit.
    #[must_use]
    pub fn is_well_formed(&self) -> bool {
        !self.0.is_empty()
            && self.0.len() <= MAX_RELAY_KEY_BYTES
            && self.0.bytes().all(|byte| byte.is_ascii_graphic())
    }
}

impl fmt::Debug for NanoRelayKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NanoRelayKey(<redacted>)")
    }
}

/// Host-owned launch data of one Nano session, serialized into the bridge
/// `initialize` config as `nano: { agentDir, guardExtension }`. The relay key
/// is not serialized: it goes to the bridge process environment.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoRuntimeLaunch {
    /// Pi agent directory (`PI_CODING_AGENT_DIR`) with the host-written
    /// `models.json`; never the user's own `~/.pi/agent`.
    pub agent_dir: PathBuf,
    /// Common application-owned cache for the verified bundled runtime.
    #[serde(skip)]
    pub bundle_cache_dir: PathBuf,
    /// Absolute path of the written guard extension; `None` in `full-access`.
    pub guard_extension: Option<PathBuf>,
    #[serde(skip)]
    pub relay_key: NanoRelayKey,
}

impl fmt::Debug for NanoRuntimeLaunch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NanoRuntimeLaunch")
            .field("has_guard_extension", &self.guard_extension.is_some())
            .field("relay_key", &self.relay_key)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_key_debug_is_redacted_and_the_key_is_never_serialized() {
        let key = NanoRelayKey::new("rk_secret-value");
        assert_eq!(format!("{key:?}"), "NanoRelayKey(<redacted>)");
        assert_eq!(format!("{key:#?}"), "NanoRelayKey(<redacted>)");
        let launch = NanoRuntimeLaunch {
            agent_dir: PathBuf::from("agent"),
            bundle_cache_dir: PathBuf::from("runtime"),
            guard_extension: None,
            relay_key: key,
        };
        let debug = format!("{launch:?}{launch:#?}");
        assert!(!debug.contains("rk_secret-value"));
        assert!(!debug.contains("agent"));
        assert_eq!(
            serde_json::to_value(&launch).expect("json"),
            serde_json::json!({
                "agentDir": "agent",
                "guardExtension": null,
            })
        );
        assert!(
            !serde_json::to_string(&launch)
                .expect("json")
                .contains("rk_secret")
        );
    }

    fn pairs(names: &[&str]) -> Vec<(OsString, OsString)> {
        names
            .iter()
            .map(|name| {
                (
                    OsString::from(*name),
                    OsString::from(format!("{name}-value")),
                )
            })
            .collect()
    }

    fn names(environment: &[(OsString, OsString)]) -> Vec<String> {
        environment
            .iter()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_bridge_environment_keeps_only_the_os_allowlist() {
        let host = pairs(&[
            "Path",
            "SystemRoot",
            "windir",
            "LC_ALL",
            "lc_ctype",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "HTTPS_PROXY",
            "NODE_OPTIONS",
            "PIUI_AGENT_API_TOKEN",
            "PI_CODING_AGENT_DIR",
            "NANO_RELAY_KEY",
            "PIUI_NANO_RELAY_KEY",
            "HOME",
            "XDG_CONFIG_HOME",
        ]);
        // Windows compares names case-insensitively and keeps their spelling.
        assert_eq!(
            names(&nano_bridge_environment(&host, true)),
            ["Path", "SystemRoot", "windir", "LC_ALL", "lc_ctype"]
        );
        // POSIX names are exact.
        assert_eq!(
            names(&nano_bridge_environment(&host, false)),
            ["LC_ALL", "HOME", "XDG_CONFIG_HOME"]
        );
        let lower = pairs(&["path", "home"]);
        assert!(nano_bridge_environment(&lower, false).is_empty());
    }

    /// The names of one `[...]` list of string literals in `source` after
    /// `start`.
    fn quoted_names(source: &str, start: &str, end: &str) -> Vec<String> {
        let begin = source.find(start).expect("start") + start.len();
        let rest = &source[begin..];
        let list = &rest[..rest.find(end).expect("end")];
        list.split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn the_bridge_allowlist_matches_the_pi_child_allowlist() {
        let source = include_str!("../bridge/pi.mjs");
        let set = &source[source.find("new Set(windows ? [").expect("allowlist")..];
        let windows = quoted_names(set, "[", "] : [");
        let posix = quoted_names(set, "] : [", "]);");
        assert_eq!(windows, NANO_WINDOWS_ENVIRONMENT);
        assert_eq!(posix, NANO_POSIX_ENVIRONMENT);
        assert!(source.contains("key.startsWith(\"LC_\")"));
        assert!(source.contains(NANO_RELAY_KEY_BRIDGE_ENV));
    }

    #[test]
    fn relay_key_must_be_visible_ascii_and_bounded() {
        assert!(NanoRelayKey::new("a".repeat(512)).is_well_formed());
        for bad in ["", "has space", "line\nbreak", "tab\t", "caf\u{e9}"] {
            assert!(!NanoRelayKey::new(bad).is_well_formed(), "{bad:?}");
        }
        assert!(!NanoRelayKey::new("a".repeat(513)).is_well_formed());
    }

    #[test]
    fn guard_extension_source_is_embedded() {
        assert!(!NANO_GUARD_EXTENSION_SOURCE.trim().is_empty());
    }
}
