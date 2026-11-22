//! Which installed Node.js can run a package.
//!
//! A desktop launch often sees a distribution Node.js (`/usr/bin/node`) before
//! the newer one a version manager installed (nvm, fnm, volta). A package that
//! declares `engines.node` (Pi 1.5 needs 22.19 or newer) must run on a Node.js
//! that satisfies it, not on whichever comes first. Versions are read from the
//! version-manager folder name when it carries one, otherwise from
//! `node --version` (bounded, cached per file and modification time). Nothing
//! is logged.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

/// `(major, minor, patch)`.
pub type NodeVersion = (u64, u64, u64);

const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const VERSION_OUTPUT_LIMIT: usize = 256;
/// How far above a package entry its `package.json` may be (`dist/cli.js`,
/// `dist/bundle/cli.js`, `bin/x.js`).
const PACKAGE_DEPTH: usize = 4;

type VersionCache = HashMap<PathBuf, (Option<SystemTime>, u64, Option<NodeVersion>)>;
static VERSIONS: Mutex<Option<VersionCache>> = Mutex::new(None);

/// `v24.14.1`, `24.14.1`, `22`, `v20.18.1\n`. Missing parts are zero.
#[must_use]
pub fn parse_version(text: &str) -> Option<NodeVersion> {
    let text = text.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let mut parts = text.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = match parts.next() {
        Some(part) => leading_number(part)?,
        None => 0,
    };
    let patch = match parts.next() {
        Some(part) => leading_number(part)?,
        None => 0,
    };
    Some((major, minor, patch))
}

fn leading_number(part: &str) -> Option<u64> {
    let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        // `x` / `*` wildcards count as zero.
        return matches!(part, "x" | "X" | "*").then_some(0);
    }
    digits.parse().ok()
}

/// The lowest Node.js version an `engines.node` range admits, or `None` when
/// the range sets no lower bound this reader understands. `>=22.19.0`,
/// `^20.19 || >=22.12`, `22.x`, `>=18 <25`.
#[must_use]
pub fn range_minimum(range: &str) -> Option<NodeVersion> {
    range
        .split("||")
        .filter_map(|alternative| {
            let first = alternative.split_whitespace().next()?;
            let bound = first
                .strip_prefix(">=")
                .or_else(|| first.strip_prefix('^'))
                .or_else(|| first.strip_prefix('~'))
                .or_else(|| first.strip_prefix('='))
                .or_else(|| {
                    first
                        .starts_with(|c: char| c.is_ascii_digit())
                        .then_some(first)
                })?;
            parse_version(bound.trim_start_matches('v'))
        })
        .min()
}

/// The minimum Node.js the package holding `entry` declares.
#[must_use]
pub fn package_minimum(entry: &Path) -> Option<NodeVersion> {
    for directory in entry.ancestors().skip(1).take(PACKAGE_DEPTH) {
        let Ok(bytes) = std::fs::read(directory.join("package.json")) else {
            continue;
        };
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        return manifest
            .get("engines")
            .and_then(|engines| engines.get("node"))
            .and_then(serde_json::Value::as_str)
            .and_then(range_minimum);
    }
    None
}

/// The version a version manager's folder names: `.../v24.14.1/bin/node`
/// (nvm, n, the official archives) or `.../v24.14.1/installation/bin/node`
/// (fnm).
fn version_from_layout(program: &Path) -> Option<NodeVersion> {
    let bin = program.parent()?;
    if bin.file_name()? != "bin" {
        return None;
    }
    let above = bin.parent()?;
    let named = if above.file_name()? == "installation" {
        above.parent()?
    } else {
        above
    };
    let name = named.file_name()?.to_str()?;
    if !name.starts_with('v') || name.split('.').count() != 3 {
        return None;
    }
    parse_version(name)
}

/// The version of one installed Node.js, or `None` when it cannot be told.
#[must_use]
pub fn installed_version(program: &Path) -> Option<NodeVersion> {
    if let Some(version) = version_from_layout(program) {
        return Some(version);
    }
    let resolved = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
    if let Some(version) = version_from_layout(&resolved) {
        return Some(version);
    }
    let metadata = std::fs::metadata(&resolved).ok()?;
    let stamp = (metadata.modified().ok(), metadata.len());
    {
        let cache = VERSIONS.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((modified, length, version)) = cache.as_ref().and_then(|map| map.get(&resolved))
            && (*modified, *length) == stamp
        {
            return *version;
        }
    }
    let version = ask_version(program);
    VERSIONS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .insert(resolved, (stamp.0, stamp.1, version));
    version
}

fn ask_version(program: &Path) -> Option<NodeVersion> {
    use std::io::Read as _;
    let mut command = Command::new(program);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if started.elapsed() >= VERSION_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
        }
    }
    let mut output = Vec::new();
    child
        .stdout
        .take()?
        .take(VERSION_OUTPUT_LIMIT as u64)
        .read_to_end(&mut output)
        .ok()?;
    parse_version(std::str::from_utf8(&output).ok()?)
}

/// Every `node` executable on `path_env`, in order.
#[must_use]
pub fn nodes_on_path(path_env: Option<&OsString>) -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    };
    let Some(path_env) = path_env else {
        return Vec::new();
    };
    let mut nodes = Vec::new();
    for directory in std::env::split_paths(path_env) {
        if let Some(candidate) = names
            .iter()
            .map(|name| directory.join(name))
            .find(|candidate| candidate.is_file())
            && !nodes.contains(&candidate)
        {
            nodes.push(candidate);
        }
    }
    nodes
}

/// The first candidate that satisfies `minimum`. With no minimum, or when no
/// candidate is known to satisfy it, the first candidate: the old choice, and
/// [`shortfall`] then names the gap.
#[must_use]
pub fn choose(candidates: &[PathBuf], minimum: Option<NodeVersion>) -> Option<PathBuf> {
    choose_with(candidates, minimum, installed_version)
}

fn choose_with(
    candidates: &[PathBuf],
    minimum: Option<NodeVersion>,
    version_of: impl Fn(&Path) -> Option<NodeVersion>,
) -> Option<PathBuf> {
    let first = candidates.first()?;
    let Some(minimum) = minimum else {
        return Some(first.clone());
    };
    candidates
        .iter()
        .find(|candidate| version_of(candidate).is_some_and(|version| version >= minimum))
        .or(Some(first))
        .cloned()
}

/// `(required, found)` when `program` is known to be older than the package
/// holding `entry` requires.
#[must_use]
pub fn shortfall(program: &Path, entry: &Path) -> Option<(NodeVersion, NodeVersion)> {
    let required = package_minimum(entry)?;
    let found = installed_version(program)?;
    (found < required).then_some((required, found))
}

/// `22.19.0`.
#[must_use]
pub fn display(version: NodeVersion) -> String {
    format!("{}.{}.{}", version.0, version.1, version.2)
}

#[cfg(test)]
mod tests {
    use super::{choose_with, parse_version, range_minimum, version_from_layout};
    use std::path::{Path, PathBuf};

    #[test]
    fn versions_and_ranges_parse() {
        assert_eq!(parse_version("v24.14.1\n"), Some((24, 14, 1)));
        assert_eq!(parse_version("22"), Some((22, 0, 0)));
        assert_eq!(parse_version("node"), None);
        assert_eq!(range_minimum(">=22.19.0"), Some((22, 19, 0)));
        assert_eq!(range_minimum("^20.19 || >=22.12"), Some((20, 19, 0)));
        assert_eq!(range_minimum(">=18 <25"), Some((18, 0, 0)));
        assert_eq!(range_minimum("22.x"), Some((22, 0, 0)));
        assert_eq!(range_minimum("<25"), None);
        assert_eq!(range_minimum("*"), None);
    }

    #[test]
    fn version_manager_folders_name_the_version() {
        assert_eq!(
            version_from_layout(Path::new("/h/.nvm/versions/node/v24.14.1/bin/node")),
            Some((24, 14, 1))
        );
        assert_eq!(
            version_from_layout(Path::new(
                "/h/.local/share/fnm/node-versions/v22.19.0/installation/bin/node"
            )),
            Some((22, 19, 0))
        );
        assert_eq!(version_from_layout(Path::new("/usr/bin/node")), None);
    }

    #[test]
    fn the_first_node_new_enough_wins_and_the_first_stays_the_fallback() {
        let system = PathBuf::from("/usr/bin/node");
        let unknown = PathBuf::from("/opt/odd/node");
        let nvm = PathBuf::from("/h/.nvm/versions/node/v24.14.1/bin/node");
        let version_of = |path: &Path| match path.to_str() {
            Some("/usr/bin/node") => Some((20, 18, 1)),
            Some("/opt/odd/node") => None,
            other => other.and_then(|_| version_from_layout(path)),
        };
        let all = [system.clone(), unknown.clone(), nvm.clone()];
        // Pi 1.5 needs 22.19: the distribution Node.js 20 is skipped.
        assert_eq!(choose_with(&all, Some((22, 19, 0)), version_of), Some(nvm));
        // No requirement: PATH order, unchanged.
        assert_eq!(choose_with(&all, None, version_of), Some(system.clone()));
        // Nothing satisfies it: the first one, and the shortfall is reported.
        assert_eq!(
            choose_with(&[system.clone(), unknown], Some((26, 0, 0)), version_of),
            Some(system)
        );
        assert_eq!(choose_with(&[], Some((1, 0, 0)), version_of), None);
    }
}
