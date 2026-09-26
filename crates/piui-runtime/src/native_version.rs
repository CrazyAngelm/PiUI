//! Verified version ranges for native harnesses.
//!
//! PiUI admits a native harness version only inside a range whose protocol
//! surface was audited against the bridge and exercised with fixtures. A range
//! is `minimum <= version < ceiling`, compared on `MAJOR.MINOR.PATCH`:
//!
//! - A pre-release precedes its release (semver), so `0.147.0-alpha.1` is older
//!   than a `0.147.0` minimum.
//! - A pre-release at or above the ceiling previews an untested release line,
//!   so `0.158.0-alpha.2` is newer than a `0.158.0` ceiling even though semver
//!   orders it before `0.158.0`.
//! - A leading `v` and build metadata (`+...`) are ignored; anything that is
//!   not `MAJOR.MINOR.PATCH` with optional suffixes is unrecognized.
//!
//! A version above the ceiling is reported as unverified instead of being
//! accepted silently. Raising a ceiling is a verification step: audit the new
//! protocol (`bridge/CONTRACT.md`, Codex section), extend the fixtures, then
//! change the single constant here together with its bridge mirror; the unit
//! test below keeps both copies equal.

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

impl VersionCheck {
    pub(crate) const fn is_verified(self) -> bool {
        matches!(self, Self::Verified)
    }

    /// Fixed discovery reason (a locale-catalog key, never native text).
    pub(crate) const fn unverified_reason(self) -> Option<&'static str> {
        match self {
            Self::Verified => None,
            Self::Newer => Some("Unverified: newer than the versions tested with PiUI."),
            Self::Older => Some("Older than the oldest version supported by PiUI."),
            Self::Unrecognized => Some("The installed version could not be recognized."),
        }
    }
}

/// `minimum <= version < ceiling`; see the module documentation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedRange {
    /// Oldest verified release, inclusive.
    pub(crate) minimum: (u64, u64, u64),
    /// First release line that is not verified yet, exclusive.
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

/// Codex app-server versions verified against `bridge/codex.mjs`. The
/// protocols of 0.147.0, 0.153.4 and 0.157.1 were audited (`bridge/CONTRACT.md`,
/// Codex section); patch releases keep the protocol, so the ceiling admits the
/// 0.157.x line and nothing from 0.158.0 on. The bridge mirrors this constant
/// as `VERIFIED_CODEX_VERSIONS` and checks the running app-server's
/// `initialize` user agent against it.
pub(crate) const CODEX_APP_SERVER: VerifiedRange = VerifiedRange {
    minimum: (0, 147, 0),
    ceiling: (0, 158, 0),
};

#[cfg(test)]
mod tests {
    use super::*;

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
        ] {
            assert_eq!(check(version), VersionCheck::Verified, "{version}");
        }
        for version in ["0.146.9", "0.147.0-alpha.1", "0.100.0"] {
            assert_eq!(check(version), VersionCheck::Older, "{version}");
        }
        for version in ["0.158.0", "0.158.0-alpha.2", "0.159.0-alpha.4", "1.0.0"] {
            assert_eq!(check(version), VersionCheck::Newer, "{version}");
        }
        assert_eq!(CODEX_APP_SERVER.check(None), VersionCheck::Unrecognized);
        assert_eq!(check("unknown"), VersionCheck::Unrecognized);
        assert_eq!(
            VersionCheck::Newer.unverified_reason(),
            Some("Unverified: newer than the versions tested with PiUI.")
        );
        assert_eq!(VersionCheck::Verified.unverified_reason(), None);
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
}
