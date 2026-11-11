//! Tested version ranges for native harnesses.
//!
//! A range records the releases whose protocol surface was audited against the
//! bridge and exercised with fixtures. It is `minimum <= version < ceiling`,
//! compared on `MAJOR.MINOR.PATCH`, and its two ends differ in strength:
//!
//! - The **minimum is enforced**: an older release is refused
//!   ([`VersionCheck::Older`]), because the bridge relies on protocol surface
//!   that release does not have.
//! - The **ceiling is advisory**: a newer release ([`VersionCheck::Newer`]) is
//!   admitted and reported as "newer than tested". Whether it really works is
//!   decided by the identity and protocol handshake of the bridge, which stays
//!   fail-closed; a version number alone never disables a working harness.
//!
//! [`VersionCheck::admits`] is the single admission decision. An unrecognized
//! version text is not admitted: for Codex and Claude Code it is the identity
//! proof itself.
//!
//! Version text is parsed as follows:
//!
//! - A pre-release precedes its release (semver), so `0.147.0-alpha.1` is older
//!   than a `0.147.0` minimum.
//! - A pre-release at or above the ceiling previews an untested release line,
//!   so `0.158.0-alpha.2` is newer than a `0.158.0` ceiling even though semver
//!   orders it before `0.158.0`.
//! - A leading `v` and build metadata (`+...`) are ignored; anything that is
//!   not `MAJOR.MINOR.PATCH` with optional suffixes is unrecognized.
//!
//! Raising a ceiling is a verification step, not a gate: audit the new protocol
//! (`bridge/CONTRACT.md`), extend the fixtures, then change the constant here.
//! The minimum is also declared in the bridge that enforces it
//! (`VERIFIED_CODEX_VERSIONS` in `codex.mjs`, `MINIMUM_PRIME_VERSION` in
//! `prime.mjs`, `MINIMUM_HERMES_VERSION` in `hermes.mjs`); the unit tests below
//! keep each copy equal to the constant.

use serde::{Deserialize, Serialize};

/// Parsed `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]` version.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct NativeVersion {
    core: (u64, u64, u64),
    prerelease: bool,
}

impl NativeVersion {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        let text = match text.split_once('+') {
            Some((version, build)) if identifiers(build) => version,
            Some(_) => return None,
            None => text,
        };
        let (core, prerelease) = match text.split_once('-') {
            Some((core, prerelease)) if identifiers(prerelease) => (core, true),
            Some(_) => return None,
            None => (text, false),
        };
        let mut parts = core.split('.');
        let major = number(parts.next()?)?;
        let minor = number(parts.next()?)?;
        let patch = number(parts.next()?)?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            core: (major, minor, patch),
            prerelease,
        })
    }
}

fn number(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn identifiers(text: &str) -> bool {
    text.split('.').all(|identifier| {
        !identifier.is_empty()
            && identifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

/// Result of checking an installed version against a verified range.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VersionCheck {
    Verified,
    Older,
    Newer,
    Unrecognized,
}

/// How an admitted version relates to the tested range, for Settings. Only
/// admitted versions have a status; it serializes as `"verified"` / `"newer"`.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeVersionStatus {
    /// Inside the tested range.
    Verified,
    /// Above the advisory ceiling: launchable, but not tested with PiUI.
    Newer,
}

impl VersionCheck {
    /// Whether the version may launch: inside the range or newer than its
    /// advisory ceiling. An older or unrecognized version never does.
    pub(crate) const fn admits(self) -> bool {
        matches!(self, Self::Verified | Self::Newer)
    }

    /// The status of an admitted version; `None` when it is not admitted.
    pub(crate) const fn status(self) -> Option<NativeVersionStatus> {
        match self {
            Self::Verified => Some(NativeVersionStatus::Verified),
            Self::Newer => Some(NativeVersionStatus::Newer),
            Self::Older | Self::Unrecognized => None,
        }
    }

    /// Fixed discovery reason a version is not admitted (a locale-catalog key,
    /// never native text). An admitted version, newer ones included, has none.
    pub(crate) const fn unverified_reason(self) -> Option<&'static str> {
        match self {
            Self::Verified | Self::Newer => None,
            Self::Older => Some("Older than the oldest version supported by Nano Desktop."),
            Self::Unrecognized => Some("The installed version could not be recognized."),
        }
    }
}

/// `minimum <= version < ceiling`; see the module documentation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedRange {
    /// Oldest supported release, inclusive. Enforced.
    pub(crate) minimum: (u64, u64, u64),
    /// First release line that is not tested yet, exclusive. Advisory.
    pub(crate) ceiling: (u64, u64, u64),
}

impl VerifiedRange {
    pub(crate) fn check(self, version: Option<&str>) -> VersionCheck {
        let Some(version) = version.and_then(NativeVersion::parse) else {
            return VersionCheck::Unrecognized;
        };
        if version.core < self.minimum || (version.core == self.minimum && version.prerelease) {
            VersionCheck::Older
        } else if version.core >= self.ceiling {
            VersionCheck::Newer
        } else {
            VersionCheck::Verified
        }
    }
}

/// Codex app-server versions tested against `bridge/codex.mjs`. The protocols
/// of 0.147.0, 0.153.4, 0.157.1, 0.163.0 and 0.165.0 were audited
/// (`bridge/CONTRACT.md`, Codex section); patch releases keep the protocol, so
/// the tested line ends with 0.165.x and anything from 0.166.0 on is reported
/// as newer than tested but launches. The bridge mirrors this constant as
/// `VERIFIED_CODEX_VERSIONS` and checks the running app-server's `initialize`
/// user agent against it.
pub(crate) const CODEX_APP_SERVER: VerifiedRange = VerifiedRange {
    minimum: (0, 147, 0),
    ceiling: (0, 166, 0),
};

/// Claude Code releases (`claude --version`, identified by its
/// `(Claude Code)` marker). The headless stream-json and control protocol was
/// verified against 2.1.232 and has been stable across 2.x; the bridge's
/// `initialize` and `init` checks stay authoritative for subscription
/// authentication and the applied permission mode.
pub(crate) const CLAUDE_CODE: VerifiedRange = VerifiedRange {
    minimum: (2, 1, 0),
    ceiling: (3, 0, 0),
};

/// Prime Agent package versions (`prime-agent` manifest). The SDK surface was
/// audited with 0.9.2 and 0.9.3; the 0.9 line is expected to keep it, so the
/// advisory ceiling is the next minor release. The bridge mirrors the minimum
/// as `MINIMUM_PRIME_VERSION` and validates the SDK it imports.
pub(crate) const PRIME_AGENT: VerifiedRange = VerifiedRange {
    minimum: (0, 9, 2),
    ceiling: (0, 9, 4),
};

/// Hermes Agent versions (`hermes_cli.__version__`, ACP `agentInfo`). Tested
/// with 0.21.0; the bridge mirrors the minimum as `MINIMUM_HERMES_VERSION`
/// and still requires ACP `protocolVersion` 1 and the history provenance
/// checks.
pub(crate) const HERMES: VerifiedRange = VerifiedRange {
    minimum: (0, 21, 0),
    ceiling: (0, 22, 0),
};

/// Upstream Pi (`@earendil-works/pi-coding-agent` manifest) that the `nano`
/// lane drives. The minimum is enforced, unlike plain Pi, which has no version
/// gate: the lane relies on `models.json` custom providers and on explicit
/// extensions (`-e`) that 1.4.0 provides. The advisory ceiling is the next minor
/// release; a newer Pi launches and is shown as "newer than tested".
pub(crate) const NANO_PI: VerifiedRange = VerifiedRange {
    minimum: (1, 4, 0),
    ceiling: (1, 5, 0),
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nano_pi_range_starts_at_the_enforced_minimum() {
        assert_eq!(NANO_PI.check(Some("1.4.0")), VersionCheck::Verified);
        assert_eq!(NANO_PI.check(Some("1.4.9")), VersionCheck::Verified);
        assert_eq!(NANO_PI.check(Some("1.5.0")), VersionCheck::Newer);
        assert_eq!(NANO_PI.check(Some("1.3.9")), VersionCheck::Older);
        assert_eq!(NANO_PI.check(Some("1.4.0-beta.1")), VersionCheck::Older);
        assert_eq!(NANO_PI.check(None), VersionCheck::Unrecognized);
    }

    #[test]
    fn parses_release_prerelease_and_build_versions() {
        let release = NativeVersion::parse("0.157.1").expect("release");
        assert_eq!(release.core, (0, 157, 1));
        assert!(!release.prerelease);
        for text in [
            "0.157.1-alpha",
            "0.158.0-alpha.2.1",
            "v0.157.1-alpha.3",
            "0.157.1-win32-x64",
        ] {
            assert!(NativeVersion::parse(text).is_some_and(|version| version.prerelease));
        }
        assert_eq!(
            NativeVersion::parse(" 0.157.1+build.7 "),
            Some(NativeVersion {
                core: (0, 157, 1),
                prerelease: false,
            })
        );
        for text in [
            "",
            "0.157",
            "0.157.1.2",
            "0.157.x",
            "0.157.1-",
            "0.157.1-alpha..1",
            "0.157.1+",
            "codex-cli 0.157.1",
            "-1.0.0",
            "0.157.1 extra",
        ] {
            assert_eq!(NativeVersion::parse(text), None, "{text}");
        }
    }

    #[test]
    fn codex_range_admits_audited_versions_and_reports_the_rest() {
        let check = |version: &str| CODEX_APP_SERVER.check(Some(version));
        for version in [
            "0.147.0",
            "0.147.1",
            "0.153.4",
            "0.157.0",
            "0.157.1",
            "0.157.1-alpha",
            "0.157.9",
            "0.158.0",
            "0.163.0",
            "0.165.0",
        ] {
            assert_eq!(check(version), VersionCheck::Verified, "{version}");
        }
        for version in ["0.146.9", "0.147.0-alpha.1", "0.100.0"] {
            assert_eq!(check(version), VersionCheck::Older, "{version}");
        }
        for version in ["0.166.0", "0.166.0-alpha.2", "0.167.0-alpha.4", "1.0.0"] {
            assert_eq!(check(version), VersionCheck::Newer, "{version}");
        }
        assert_eq!(CODEX_APP_SERVER.check(None), VersionCheck::Unrecognized);
        assert_eq!(check("unknown"), VersionCheck::Unrecognized);
    }

    #[test]
    fn a_newer_version_is_admitted_but_an_older_or_unrecognized_one_is_not() {
        let check = |version: &str| CODEX_APP_SERVER.check(Some(version));
        // Releases above the advisory ceiling launch.
        assert_eq!(check("0.170.0"), VersionCheck::Newer);
        assert!(check("0.170.0").admits());
        assert!(check("1.0.0").admits());
        assert!(check("0.157.1").admits());
        assert!(check("0.147.0").admits());
        for version in ["0.146.9", "0.147.0-alpha.1", "0.100.0"] {
            assert!(!check(version).admits(), "{version}");
        }
        assert!(!check("unknown").admits());
        assert!(!CODEX_APP_SERVER.check(None).admits());
        assert!(VersionCheck::Verified.admits());
        assert!(VersionCheck::Newer.admits());
        assert!(!VersionCheck::Older.admits());
        assert!(!VersionCheck::Unrecognized.admits());
    }

    #[test]
    fn status_and_reasons_follow_admission() {
        assert_eq!(
            VersionCheck::Verified.status(),
            Some(NativeVersionStatus::Verified)
        );
        assert_eq!(
            VersionCheck::Newer.status(),
            Some(NativeVersionStatus::Newer)
        );
        assert_eq!(VersionCheck::Older.status(), None);
        assert_eq!(VersionCheck::Unrecognized.status(), None);
        for check in [
            VersionCheck::Verified,
            VersionCheck::Newer,
            VersionCheck::Older,
            VersionCheck::Unrecognized,
        ] {
            // Exactly the admitted versions have a status and no refusal reason.
            assert_eq!(check.status().is_some(), check.admits(), "{check:?}");
            assert_eq!(
                check.unverified_reason().is_none(),
                check.admits(),
                "{check:?}"
            );
        }
        assert_eq!(
            VersionCheck::Older.unverified_reason(),
            Some("Older than the oldest version supported by Nano Desktop.")
        );
        assert_eq!(
            VersionCheck::Unrecognized.unverified_reason(),
            Some("The installed version could not be recognized.")
        );
        assert_eq!(
            serde_json::to_string(&NativeVersionStatus::Verified).expect("status"),
            "\"verified\""
        );
        assert_eq!(
            serde_json::to_string(&NativeVersionStatus::Newer).expect("status"),
            "\"newer\""
        );
    }

    #[test]
    fn claude_code_range_enforces_the_minimum_only() {
        let check = |version: &str| CLAUDE_CODE.check(Some(version));
        for version in ["2.1.0", "2.1.232", "2.1.318", "2.9.14", "2.1.232-beta.1"] {
            assert_eq!(check(version), VersionCheck::Verified, "{version}");
        }
        // The former `<3.0.0` ceiling is advisory now.
        for version in ["3.0.0", "3.4.1", "10.1.0"] {
            assert_eq!(check(version), VersionCheck::Newer, "{version}");
            assert!(check(version).admits(), "{version}");
        }
        for version in ["2.0.99", "1.0.128", "2.1.0-beta.1"] {
            assert_eq!(check(version), VersionCheck::Older, "{version}");
        }
        assert_eq!(check("garbage"), VersionCheck::Unrecognized);
        assert_eq!(CLAUDE_CODE.check(None), VersionCheck::Unrecognized);
    }

    #[test]
    fn prime_agent_range_replaces_the_exact_pin() {
        let check = |version: &str| PRIME_AGENT.check(Some(version));
        for version in ["0.9.2", "0.9.3", "0.9.3-alpha.1"] {
            assert_eq!(check(version), VersionCheck::Verified, "{version}");
        }
        for version in ["0.9.4", "0.9.5", "0.10.0", "0.10.0-alpha.1", "1.0.0"] {
            assert_eq!(check(version), VersionCheck::Newer, "{version}");
            assert!(check(version).admits(), "{version}");
        }
        for version in ["0.9.1", "0.9.2-rc.1", "0.8.1"] {
            assert_eq!(check(version), VersionCheck::Older, "{version}");
        }
        assert_eq!(PRIME_AGENT.check(None), VersionCheck::Unrecognized);
    }

    #[test]
    fn hermes_range_replaces_the_exact_pin() {
        let check = |version: &str| HERMES.check(Some(version));
        for version in ["0.21.0", "0.21.7"] {
            assert_eq!(check(version), VersionCheck::Verified, "{version}");
        }
        for version in ["0.22.0", "0.30.1", "1.0.0"] {
            assert_eq!(check(version), VersionCheck::Newer, "{version}");
            assert!(check(version).admits(), "{version}");
        }
        for version in ["0.20.9", "0.21.0-rc.1"] {
            assert_eq!(check(version), VersionCheck::Older, "{version}");
        }
        assert_eq!(HERMES.check(None), VersionCheck::Unrecognized);
    }

    #[test]
    fn bridge_mirrors_the_codex_range() {
        let bridge = include_str!("../bridge/codex.mjs");
        let (minimum, ceiling) = (CODEX_APP_SERVER.minimum, CODEX_APP_SERVER.ceiling);
        let expected = format!(
            "const VERIFIED_CODEX_VERSIONS = {{ minimum: \"{}.{}.{}\", ceiling: \"{}.{}.{}\" }};",
            minimum.0, minimum.1, minimum.2, ceiling.0, ceiling.1, ceiling.2
        );
        assert!(
            bridge.contains(&expected),
            "bridge/codex.mjs must declare `{expected}`"
        );
    }

    #[test]
    fn bridges_mirror_the_enforced_minimums() {
        for (file, bridge, name, range) in [
            (
                "bridge/prime.mjs",
                include_str!("../bridge/prime.mjs"),
                "MINIMUM_PRIME_VERSION",
                PRIME_AGENT,
            ),
            (
                "bridge/hermes.mjs",
                include_str!("../bridge/hermes.mjs"),
                "MINIMUM_HERMES_VERSION",
                HERMES,
            ),
        ] {
            let (major, minor, patch) = range.minimum;
            let expected = format!("const {name} = \"{major}.{minor}.{patch}\";");
            assert!(
                bridge.contains(&expected),
                "{file} must declare `{expected}`"
            );
        }
        // The literal form the two tests above search for.
        assert_eq!(PRIME_AGENT.minimum, (0, 9, 2));
        assert_eq!(HERMES.minimum, (0, 21, 0));
    }
}
