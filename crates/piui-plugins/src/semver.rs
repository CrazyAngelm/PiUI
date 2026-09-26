//! The small SemVer subset plugin manifests use: `MAJOR.MINOR.PATCH` with an
//! optional pre-release, and `engines.piui` ranges of space-separated
//! comparators (`>=`, `>`, `<=`, `<`, `=`, `^`, `~`) that must all match.

use std::cmp::Ordering;

/// A parsed `MAJOR.MINOR.PATCH[-pre]` version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Dot-separated pre-release identifiers; empty for a release.
    pub pre: Vec<String>,
}

impl Version {
    /// Parses a version; build metadata and partial versions are rejected.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let mut parts = core.split('.');
        let major = number(parts.next()?)?;
        let minor = number(parts.next()?)?;
        let patch = number(parts.next()?)?;
        if parts.next().is_some() {
            return None;
        }
        let pre = match pre {
            None => Vec::new(),
            Some(pre) => {
                let identifiers = pre.split('.').map(str::to_owned).collect::<Vec<_>>();
                if identifiers.iter().any(|identifier| {
                    identifier.is_empty()
                        || !identifier
                            .chars()
                            .all(|character| character.is_ascii_alphanumeric() || character == '-')
                }) {
                    return None;
                }
                identifiers
            }
        };
        Some(Self {
            major,
            minor,
            patch,
            pre,
        })
    }

    const fn core(&self) -> (u64, u64, u64) {
        (self.major, self.minor, self.patch)
    }
}

fn number(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core().cmp(&other.core()).then_with(|| {
            // A release sorts after its pre-releases.
            match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => compare_pre(&self.pre, &other.pre),
            }
        })
    }
}

fn compare_pre(left: &[String], right: &[String]) -> Ordering {
    for (left, right) in left.iter().zip(right) {
        let order = match (left.parse::<u64>(), right.parse::<u64>()) {
            (Ok(left), Ok(right)) => left.cmp(&right),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => left.cmp(right),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    left.len().cmp(&right.len())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Operator {
    AtLeast,
    Above,
    AtMost,
    Below,
    Exactly,
    Caret,
    Tilde,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Comparator {
    operator: Operator,
    version: Version,
}

impl Comparator {
    fn matches(&self, current: &Version) -> bool {
        let version = &self.version;
        match self.operator {
            Operator::AtLeast => current >= version,
            Operator::Above => current > version,
            Operator::AtMost => current <= version,
            Operator::Below => current < version,
            Operator::Exactly => current == version,
            Operator::Caret => {
                let ceiling = if version.major > 0 {
                    (version.major + 1, 0, 0)
                } else if version.minor > 0 {
                    (0, version.minor + 1, 0)
                } else {
                    (0, 0, version.patch + 1)
                };
                current >= version && current.core() < ceiling
            }
            Operator::Tilde => {
                current >= version && current.core() < (version.major, version.minor + 1, 0)
            }
        }
    }
}

/// A parsed `engines.piui` range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionRange {
    comparators: Vec<Comparator>,
}

impl VersionRange {
    /// Parses one to four space-separated comparators.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        if text.is_empty() || text.len() > 100 || text.contains("  ") || text != text.trim() {
            return None;
        }
        let comparators = text
            .split(' ')
            .map(|token| {
                let (operator, version) = [
                    (">=", Operator::AtLeast),
                    ("<=", Operator::AtMost),
                    (">", Operator::Above),
                    ("<", Operator::Below),
                    ("=", Operator::Exactly),
                    ("^", Operator::Caret),
                    ("~", Operator::Tilde),
                ]
                .into_iter()
                .find_map(|(prefix, operator)| {
                    token
                        .strip_prefix(prefix)
                        .map(|version| (operator, version))
                })
                .unwrap_or((Operator::Exactly, token));
                Version::parse(version).map(|version| Comparator { operator, version })
            })
            .collect::<Option<Vec<_>>>()?;
        (!comparators.is_empty() && comparators.len() <= 4).then_some(Self { comparators })
    }

    #[must_use]
    pub fn matches(&self, current: &Version) -> bool {
        self.comparators
            .iter()
            .all(|comparator| comparator.matches(current))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(text: &str) -> Version {
        Version::parse(text).expect("version")
    }

    #[test]
    fn versions_parse_strictly_and_order_pre_releases_first() {
        for invalid in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.a.3",
            "1.2.3-",
            "1.2.3-a..b",
            "v1.2.3",
            "1.2.3+build",
        ] {
            assert!(Version::parse(invalid).is_none(), "{invalid}");
        }
        assert!(version("1.0.0-alpha") < version("1.0.0-alpha.1"));
        assert!(version("1.0.0-alpha.1") < version("1.0.0-beta"));
        assert!(version("1.0.0-beta.2") < version("1.0.0-beta.11"));
        assert!(version("1.0.0-rc.1") < version("1.0.0"));
        assert!(version("0.9.9") < version("0.10.0"));
    }

    #[test]
    fn ranges_match_every_comparator() {
        let range = |text: &str| VersionRange::parse(text).expect("range");
        assert!(range(">=0.1.0 <1.0.0").matches(&version("0.2.0")));
        assert!(!range(">=0.1.0 <1.0.0").matches(&version("1.0.0")));
        assert!(range("^0.1.1").matches(&version("0.1.5")));
        assert!(!range("^0.1.1").matches(&version("0.2.0")));
        assert!(range("^1.2.0").matches(&version("1.9.0")));
        assert!(!range("^1.2.0").matches(&version("2.0.0")));
        assert!(range("^0.0.3").matches(&version("0.0.3")));
        assert!(!range("^0.0.3").matches(&version("0.0.4")));
        assert!(range("~1.2.3").matches(&version("1.2.9")));
        assert!(!range("~1.2.3").matches(&version("1.3.0")));
        assert!(range("0.2.0").matches(&version("0.2.0")));
        assert!(range(">0.1.1").matches(&version("0.2.0")));
        assert!(!range("<=0.1.0").matches(&version("0.1.1")));
        for invalid in [
            "",
            " >=1.0.0",
            ">=1.0.0  <2.0.0",
            ">=1.0",
            "=>1.0.0",
            "1.0.0 || 2.0.0",
            "*",
            "1.0.0 2.0.0 3.0.0 4.0.0 5.0.0",
        ] {
            assert!(VersionRange::parse(invalid).is_none(), "{invalid}");
        }
        assert!(!range(">=2.0.0 <1.0.0").matches(&version("1.5.0")));
    }
}
