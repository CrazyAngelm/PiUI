//! Typed adapter for Pi's own global extension resource configuration.
//!
//! PiUI never parses or writes Pi settings files. A short-lived Node helper
//! imports Pi's `SettingsManager` and `DefaultPackageManager`, resolves only
//! user-scoped extension resources in offline mode, and returns a bounded
//! display-safe inventory. Toggle writes are delegated to the same upstream
//! setters used by `pi config`.

use crate::real_rpc::resolve_pi_launch;
use serde::Deserialize;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

const HELPER: &str = include_str!("extension_manager.mjs");
const RESULT_SENTINEL: &str = "PIUI_EXTENSION_RESULT\t";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const WAIT_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_EXTENSION_ITEMS: usize = 512;
const READ_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Eq, PartialEq)]
pub struct PiExtensionResource {
    pub path: PathBuf,
    pub name: String,
    pub enabled: bool,
    pub origin: PiExtensionOrigin,
    /// Canonical package root retained only for trusted host-side package operations.
    package_root: Option<PathBuf>,
}

impl PiExtensionResource {
    /// Returns host-private package metadata. Callers must never serialize this path.
    pub fn package_root(&self) -> Option<&Path> {
        self.package_root.as_deref()
    }
}

impl fmt::Debug for PiExtensionResource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PiExtensionResource")
            .field("path", &"<redacted>")
            .field("name", &self.name)
            .field("enabled", &self.enabled)
            .field("origin", &self.origin)
            .field(
                "package_root",
                &self.package_root.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiExtensionOrigin {
    TopLevel,
    Package,
}

#[derive(Debug, Error)]
pub enum ExtensionManagerError {
    #[error("Pi extension management is unavailable")]
    Unavailable,
    #[error("Pi extension management failed")]
    Failed,
    #[error("Pi extension management timed out")]
    Timeout,
}

#[derive(Deserialize)]
struct HelperResult {
    items: Vec<HelperItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperItem {
    path: String,
    name: String,
    enabled: bool,
    origin: String,
    base_dir: Option<String>,
}

pub async fn list_global_extensions(
    working_directory: &Path,
) -> Result<Vec<PiExtensionResource>, ExtensionManagerError> {
    run_helper(working_directory, "list", None, None).await
}

pub async fn set_global_extension_enabled(
    working_directory: &Path,
    path: &Path,
    enabled: bool,
) -> Result<Vec<PiExtensionResource>, ExtensionManagerError> {
    run_helper(working_directory, "set", Some(path), Some(enabled)).await
}

async fn run_helper(
    working_directory: &Path,
    action: &str,
    target: Option<&Path>,
    enabled: Option<bool>,
) -> Result<Vec<PiExtensionResource>, ExtensionManagerError> {
    let launch = resolve_pi_launch().map_err(|_| ExtensionManagerError::Unavailable)?;
    let cli_path = launch
        .leading_args
        .first()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .ok_or(ExtensionManagerError::Unavailable)?;
    let dist_path = cli_path
        .parent()
        .filter(|path| path.join("core/settings-manager.js").is_file())
        .ok_or(ExtensionManagerError::Unavailable)?;

    let mut standard = std::process::Command::new(&launch.program);
    standard
        .arg("--input-type=module")
        .arg("--eval")
        .arg(HELPER)
        .arg(dist_path)
        .arg(working_directory)
        .arg(action)
        .arg(target.unwrap_or_else(|| Path::new("")))
        .arg(enabled.map_or("", |value| if value { "true" } else { "false" }))
        .current_dir(working_directory)
        .env("PI_OFFLINE", "1")
        .env("PI_SKIP_VERSION_CHECK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        standard.creation_flags(CREATE_NO_WINDOW);
    }
    let mut command = Command::from(standard);
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .map_err(|_| ExtensionManagerError::Unavailable)?;
    let mut stdout = child.stdout.take().ok_or(ExtensionManagerError::Failed)?;
    let output = timeout(COMMAND_TIMEOUT, async {
        let mut output = Vec::new();
        let mut chunk = vec![0u8; READ_CHUNK_BYTES];
        loop {
            let count = stdout
                .read(&mut chunk)
                .await
                .map_err(|_| ExtensionManagerError::Failed)?;
            if count == 0 {
                return Ok(output);
            }
            if output.len().saturating_add(count) > MAX_OUTPUT_BYTES {
                return Err(ExtensionManagerError::Failed);
            }
            output.extend_from_slice(&chunk[..count]);
        }
    })
    .await;

    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            terminate_and_reap(&mut child).await;
            return Err(error);
        }
        Err(_) => {
            terminate_and_reap(&mut child).await;
            return Err(ExtensionManagerError::Timeout);
        }
    };
    let status = match timeout(WAIT_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        _ => {
            terminate_and_reap(&mut child).await;
            return Err(ExtensionManagerError::Timeout);
        }
    };
    if !status.success() {
        return Err(ExtensionManagerError::Failed);
    }

    parse_helper_output(&output)
}

async fn terminate_and_reap(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    let _ = timeout(WAIT_TIMEOUT, child.wait()).await;
}

fn parse_helper_output(output: &[u8]) -> Result<Vec<PiExtensionResource>, ExtensionManagerError> {
    let text = std::str::from_utf8(output).map_err(|_| ExtensionManagerError::Failed)?;
    let payload = text
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(RESULT_SENTINEL))
        .ok_or(ExtensionManagerError::Failed)?;
    let result: HelperResult =
        serde_json::from_str(payload).map_err(|_| ExtensionManagerError::Failed)?;
    if result.items.len() > MAX_EXTENSION_ITEMS {
        return Err(ExtensionManagerError::Failed);
    }

    let mut resources = Vec::with_capacity(result.items.len());
    for item in result.items {
        let path = PathBuf::from(item.path);
        if !path.is_absolute()
            || item.name.is_empty()
            || item.name.len() > 160
            || item.name.chars().any(char::is_control)
        {
            return Err(ExtensionManagerError::Failed);
        }
        let origin = match item.origin.as_str() {
            "top-level" => PiExtensionOrigin::TopLevel,
            "package" => PiExtensionOrigin::Package,
            _ => return Err(ExtensionManagerError::Failed),
        };
        let package_root = match origin {
            PiExtensionOrigin::TopLevel => None,
            PiExtensionOrigin::Package => item.base_dir.and_then(|base_dir| {
                let base_dir = PathBuf::from(base_dir);
                if !base_dir.is_absolute() || !base_dir.is_dir() {
                    return None;
                }
                base_dir.canonicalize().ok()
            }),
        };
        resources.push(PiExtensionResource {
            path,
            name: item.name,
            enabled: item.enabled,
            origin,
            package_root,
        });
    }
    resources.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(resources)
}

#[cfg(test)]
mod tests {
    use super::{PiExtensionOrigin, list_global_extensions, parse_helper_output};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("piui-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).expect("creates temporary test directory");
        path
    }

    #[test]
    fn helper_projection_requires_sentinel_absolute_paths_and_known_origins() {
        let path = if cfg!(windows) {
            r"C:\safe\extension.ts"
        } else {
            "/safe/extension.ts"
        };
        let payload = format!(
            "PIUI_EXTENSION_RESULT\t{}\n",
            serde_json::json!({
                "items": [{
                    "path": path,
                    "name": "extension",
                    "enabled": true,
                    "origin": "top-level",
                    "baseDir": "/ignored-for-top-level"
                }]
            })
        );
        let items = parse_helper_output(payload.as_bytes()).expect("projects safe helper output");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].origin, PiExtensionOrigin::TopLevel);
        assert_eq!(items[0].package_root, None);
        assert!(items[0].enabled);

        assert!(parse_helper_output(b"{\"items\":[]}").is_err());
        assert!(parse_helper_output(b"PIUI_EXTENSION_RESULT\t{\"items\":[{\"path\":\"relative.ts\",\"name\":\"x\",\"enabled\":true,\"origin\":\"package\"}]}\n").is_err());
    }

    #[test]
    fn helper_projection_canonicalizes_absolute_package_roots() {
        let root = temporary_directory("extension-package-root");
        let extension_path = root.join("extension.ts");
        let payload = format!(
            "PIUI_EXTENSION_RESULT\t{}\n",
            serde_json::json!({
                "items": [{
                    "path": extension_path,
                    "name": "extension",
                    "enabled": true,
                    "origin": "package",
                    "baseDir": root,
                }]
            })
        );

        let items = parse_helper_output(payload.as_bytes()).expect("accepts package root");
        assert_eq!(
            items[0].package_root,
            Some(fs::canonicalize(&root).expect("canonical root"))
        );
        assert!(!format!("{:?}", items[0]).contains(&root.to_string_lossy().to_string()));
        fs::remove_dir_all(root).expect("removes temporary test directory");
    }

    #[test]
    fn helper_projection_ignores_unsafe_package_roots_without_path_disclosure() {
        let root = temporary_directory("extension-package-root-errors");
        let extension_path = root.join("extension.ts");
        let non_directory = root.join("not-a-directory");
        fs::write(&non_directory, "x").expect("creates test file");

        for base_dir in [
            std::path::PathBuf::from("relative-root"),
            non_directory.clone(),
        ] {
            let payload = format!(
                "PIUI_EXTENSION_RESULT\t{}\n",
                serde_json::json!({
                    "items": [{
                        "path": extension_path,
                        "name": "extension",
                        "enabled": true,
                        "origin": "package",
                        "baseDir": base_dir,
                    }]
                })
            );
            let items = parse_helper_output(payload.as_bytes()).expect("retains backend resource");
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].package_root, None);
            assert!(!format!("{:?}", items[0]).contains(&base_dir.to_string_lossy().to_string()));
        }
        let missing_base_dir = format!(
            "PIUI_EXTENSION_RESULT\t{}\n",
            serde_json::json!({
                "items": [{
                    "path": extension_path,
                    "name": "extension",
                    "enabled": true,
                    "origin": "package",
                }]
            })
        );
        let items = parse_helper_output(missing_base_dir.as_bytes())
            .expect("retains package without optional baseDir metadata");
        assert_eq!(items[0].package_root, None);
        fs::remove_dir_all(root).expect("removes temporary test directory");
    }

    #[tokio::test]
    #[ignore = "requires a locally installed Pi CLI"]
    async fn live_pi_extension_inventory_uses_upstream_settings_manager() {
        let cwd = std::env::temp_dir();
        let items = list_global_extensions(&cwd)
            .await
            .expect("lists global extension resources");
        assert!(items.len() <= 512);
        assert!(items.iter().all(|item| item.path.is_absolute()));
    }
}
