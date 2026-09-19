//! Typed adapter for runtime-owned global extension resource configuration.
//!
//! PiUI never parses or writes either runtime's settings files. A short-lived
//! Node helper imports the selected runtime package's `SettingsManager` and
//! `DefaultPackageManager`, resolves only user-scoped extension resources in
//! offline mode, and returns a bounded display-safe inventory. Toggle writes
//! are delegated to that same runtime's upstream setters.

use crate::real_rpc::{resolve_pi_launch, resolve_prime_launch};
use piui_contracts::AgentKind;
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
pub struct AgentExtensionResource {
    pub agent_kind: AgentKind,
    pub path: PathBuf,
    pub name: String,
    pub enabled: bool,
    pub origin: AgentExtensionOrigin,
    /// Canonical package root retained only for trusted host-side package operations.
    package_root: Option<PathBuf>,
}

impl AgentExtensionResource {
    /// Returns host-private package metadata. Callers must never serialize this path.
    pub fn package_root(&self) -> Option<&Path> {
        self.package_root.as_deref()
    }
}

impl fmt::Debug for AgentExtensionResource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentExtensionResource")
            .field("agent_kind", &self.agent_kind)
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
pub enum AgentExtensionOrigin {
    TopLevel,
    Package,
}

#[derive(Debug, Error)]
pub enum ExtensionManagerError {
    #[error("Agent extension management is unavailable")]
    Unavailable,
    #[error("Agent extension management failed")]
    Failed,
    #[error("Agent extension management timed out")]
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

pub async fn list_global_extensions_for_agent(
    working_directory: &Path,
    agent_kind: AgentKind,
) -> Result<Vec<AgentExtensionResource>, ExtensionManagerError> {
    run_helper(working_directory, agent_kind, "list", None, None).await
}

pub async fn set_global_extension_enabled_for_agent(
    working_directory: &Path,
    agent_kind: AgentKind,
    path: &Path,
    enabled: bool,
) -> Result<Vec<AgentExtensionResource>, ExtensionManagerError> {
    run_helper(
        working_directory,
        agent_kind,
        "set",
        Some(path),
        Some(enabled),
    )
    .await
}

fn runtime_dist_path(cli_path: &Path) -> Option<&Path> {
    cli_path.ancestors().skip(1).find(|path| {
        path.join("core/settings-manager.js").is_file()
            && path.join("core/package-manager.js").is_file()
            && path.join("config.js").is_file()
    })
}

async fn run_helper(
    working_directory: &Path,
    agent_kind: AgentKind,
    action: &str,
    target: Option<&Path>,
    enabled: Option<bool>,
) -> Result<Vec<AgentExtensionResource>, ExtensionManagerError> {
    let launch = match agent_kind {
        AgentKind::Pi => resolve_pi_launch(),
        AgentKind::PrimeAgent => resolve_prime_launch(),
    }
    .map_err(|_| ExtensionManagerError::Unavailable)?;
    let cli_path = launch
        .leading_args
        .first()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .ok_or(ExtensionManagerError::Unavailable)?;
    let dist_path = runtime_dist_path(&cli_path).ok_or(ExtensionManagerError::Unavailable)?;

    let mut standard = std::process::Command::new(&launch.program);
    // Keep the external operator capability out of native child environments.
    standard.env_remove("PIUI_AGENT_API_TOKEN");
    standard.env_remove("PIUI_AGENT_API_PORT");
    standard.env_remove("PIUI_AGENT_API_CONNECTION");
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

    parse_helper_output(&output, agent_kind)
}

async fn terminate_and_reap(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    let _ = timeout(WAIT_TIMEOUT, child.wait()).await;
}

fn parse_helper_output(
    output: &[u8],
    agent_kind: AgentKind,
) -> Result<Vec<AgentExtensionResource>, ExtensionManagerError> {
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
            "top-level" => AgentExtensionOrigin::TopLevel,
            "package" => AgentExtensionOrigin::Package,
            _ => return Err(ExtensionManagerError::Failed),
        };
        let package_root = match origin {
            AgentExtensionOrigin::TopLevel => None,
            AgentExtensionOrigin::Package => item.base_dir.and_then(|base_dir| {
                let base_dir = PathBuf::from(base_dir);
                if !base_dir.is_absolute() || !base_dir.is_dir() {
                    return None;
                }
                base_dir.canonicalize().ok()
            }),
        };
        resources.push(AgentExtensionResource {
            agent_kind,
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
    use super::{
        AgentExtensionOrigin, COMMAND_TIMEOUT, HELPER, RESULT_SENTINEL,
        list_global_extensions_for_agent, parse_helper_output as parse_helper_output_for_agent,
        runtime_dist_path,
    };
    use piui_contracts::AgentKind;
    use std::fs;
    use std::process::Stdio;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::process::Command;
    use tokio::time::timeout;

    fn parse_helper_output(
        output: &[u8],
    ) -> Result<Vec<super::AgentExtensionResource>, super::ExtensionManagerError> {
        parse_helper_output_for_agent(output, AgentKind::Pi)
    }

    fn temporary_directory(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("piui-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).expect("creates temporary test directory");
        path
    }

    #[derive(Clone, Copy, Debug)]
    enum SyntheticSettingsManagerShape {
        Pi,
        Prime,
    }

    #[derive(Clone, Copy, Debug)]
    enum SyntheticExtensionOrigin {
        Package,
        TopLevel,
    }

    const SYNTHETIC_REINVENTORY_MARKER: &str = "PIUI_SYNTHETIC_REINVENTORY";

    fn javascript_path(path: &std::path::Path) -> String {
        serde_json::to_string(&path.to_string_lossy().into_owned())
            .expect("serializes synthetic fixture path")
    }

    fn synthetic_settings_manager_source(shape: SyntheticSettingsManagerShape) -> String {
        let drain_errors = match shape {
            SyntheticSettingsManagerShape::Pi => {
                r#"  drainErrors() {
    if (arguments.length !== 0) return [];
    const errors = [...this.#errors];
    this.#errors = [];
    return errors;
  }
"#
            }
            SyntheticSettingsManagerShape::Prime => {
                r#"  drainErrors(scope) {
    if (scope !== "global") return [];
    const errors = [...this.#errors];
    this.#errors = [];
    return errors;
  }
"#
            }
        };
        let mut source = r#"import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export class SettingsManager {
  #errors = [];
  #writeQueue = Promise.resolve();
  #settings = { packages: ["synthetic-package"], extensions: [] };

  constructor(target) {
    this.target = target;
  }

  static create(_cwd, agentDir, _options) {
    return new SettingsManager(join(agentDir, "settings.json"));
  }

  getGlobalSettings() {
    return structuredClone(this.#settings);
  }

  setPackages(packages) {
    this.#settings.packages = structuredClone(packages);
    this.#queueGlobalWrite();
  }

  setExtensionPaths(paths) {
    this.#settings.extensions = structuredClone(paths);
    this.#queueGlobalWrite();
  }

  #queueGlobalWrite() {
    this.#writeQueue = this.#writeQueue
      .then(() => writeFile(this.target, JSON.stringify(this.#settings)))
      .catch((error) => {
        this.#errors.push({ scope: "global", error });
      });
  }

  async flush() {
    await this.#writeQueue;
  }

"#
        .to_owned();
        source.push_str(drain_errors);
        source.push('}');
        source.push('\n');
        source
    }

    fn synthetic_package_manager_source(
        origin: SyntheticExtensionOrigin,
        extension_path: &std::path::Path,
        package_root: &std::path::Path,
    ) -> String {
        let origin = match origin {
            SyntheticExtensionOrigin::Package => "package",
            SyntheticExtensionOrigin::TopLevel => "top-level",
        };
        let mut source = r#"let inventoryCalls = 0;

export class DefaultPackageManager {
  constructor(_options) {}

  async resolve(_prompt) {
    inventoryCalls += 1;
    if (inventoryCalls > 1) process.stdout.write("PIUI_SYNTHETIC_REINVENTORY\n");
    return {
      extensions: [{
        path: __EXTENSION_PATH__,
        enabled: false,
        metadata: {
          scope: "user",
          origin: "__ORIGIN__",
          source: "synthetic-package",
          baseDir: __PACKAGE_ROOT__,
        },
      }],
    };
  }
}
"#
        .to_owned();
        source = source.replace("__EXTENSION_PATH__", &javascript_path(extension_path));
        source = source.replace("__ORIGIN__", origin);
        source.replace("__PACKAGE_ROOT__", &javascript_path(package_root))
    }

    fn write_synthetic_runtime(
        root: &std::path::Path,
        shape: SyntheticSettingsManagerShape,
        origin: SyntheticExtensionOrigin,
    ) -> (
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let dist = root.join("runtime").join("dist");
        let agent_dir = root.join("isolated-agent");
        let working_directory = root.join("workspace");
        let package_root = root.join("synthetic-package");
        let extension_path = package_root.join("extension.mjs");
        let global_settings_target = agent_dir.join("settings.json");
        fs::create_dir_all(dist.join("core")).expect("creates synthetic runtime core");
        fs::create_dir_all(&working_directory).expect("creates synthetic working directory");
        fs::create_dir_all(&package_root).expect("creates synthetic package");
        // A directory in place of the settings file makes the queued global write
        // fail on every supported platform without relying on permissions.
        fs::create_dir_all(&global_settings_target).expect("creates malformed settings target");
        fs::write(dist.join("package.json"), r#"{"type":"module"}"#)
            .expect("marks synthetic runtime modules as ESM");
        fs::write(
            dist.join("core").join("settings-manager.js"),
            synthetic_settings_manager_source(shape),
        )
        .expect("writes synthetic settings manager");
        fs::write(
            dist.join("core").join("package-manager.js"),
            synthetic_package_manager_source(origin, &extension_path, &package_root),
        )
        .expect("writes synthetic package manager");
        fs::write(
            dist.join("config.js"),
            format!(
                "export function getAgentDir() {{ return {}; }}\n",
                javascript_path(&agent_dir)
            ),
        )
        .expect("writes synthetic runtime config");
        fs::write(
            package_root.join("package.json"),
            r#"{"name":"synthetic-package"}"#,
        )
        .expect("writes synthetic package manifest");
        fs::write(&extension_path, "export {};\n").expect("writes synthetic extension");
        (
            dist,
            working_directory,
            extension_path,
            global_settings_target,
        )
    }

    async fn run_synthetic_helper(
        dist: &std::path::Path,
        working_directory: &std::path::Path,
        extension_path: &std::path::Path,
    ) -> std::process::Output {
        let mut command = Command::new("node");
        command
            .arg("--input-type=module")
            .arg("--eval")
            .arg(HELPER)
            .arg(dist)
            .arg(working_directory)
            .arg("set")
            .arg(extension_path)
            .arg("true")
            .current_dir(working_directory)
            .env("PI_OFFLINE", "1")
            .env("PI_SKIP_VERSION_CHECK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        timeout(COMMAND_TIMEOUT, command.output())
            .await
            .expect("synthetic helper finishes within the command timeout")
            .expect("runs synthetic Node helper")
    }

    #[tokio::test]
    async fn synthetic_settings_manager_write_errors_prevent_toggle_success() {
        for shape in [
            SyntheticSettingsManagerShape::Pi,
            SyntheticSettingsManagerShape::Prime,
        ] {
            for origin in [
                SyntheticExtensionOrigin::Package,
                SyntheticExtensionOrigin::TopLevel,
            ] {
                let root = temporary_directory("extension-manager-write-error");
                let (dist, working_directory, extension_path, global_settings_target) =
                    write_synthetic_runtime(&root, shape, origin);

                let output = run_synthetic_helper(&dist, &working_directory, &extension_path).await;
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert!(
                    !output.status.success(),
                    "{shape:?}/{origin:?} queued write falsely succeeded: {stdout}"
                );
                assert!(
                    !stdout.contains(SYNTHETIC_REINVENTORY_MARKER),
                    "{shape:?}/{origin:?} re-inventoried after a failed write: {stdout}"
                );
                assert!(
                    !stdout.contains(RESULT_SENTINEL),
                    "{shape:?}/{origin:?} emitted a success sentinel after a failed write: {stdout}"
                );
                assert!(
                    global_settings_target.is_dir(),
                    "the isolated malformed settings target must remain a directory"
                );
                fs::remove_dir_all(root).expect("removes synthetic runtime fixture");
            }
        }
    }

    #[test]
    fn runtime_dist_resolution_accepts_pi_and_nested_prime_entrypoints() {
        let root = temporary_directory("extension-runtime-dist");
        let dist = root.join("dist");
        fs::create_dir_all(dist.join("core")).expect("creates runtime core fixture");
        fs::create_dir_all(dist.join("bundle")).expect("creates Prime bundle fixture");
        for relative in [
            "core/settings-manager.js",
            "core/package-manager.js",
            "config.js",
            "cli.js",
            "bundle/cli.js",
        ] {
            fs::write(dist.join(relative), "// fixture").expect("writes runtime fixture");
        }
        assert_eq!(
            runtime_dist_path(&dist.join("cli.js")),
            Some(dist.as_path())
        );
        assert_eq!(
            runtime_dist_path(&dist.join("bundle").join("cli.js")),
            Some(dist.as_path())
        );
        fs::remove_dir_all(root).expect("removes runtime dist fixture");
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
        assert_eq!(items[0].agent_kind, AgentKind::Pi);
        assert_eq!(items[0].origin, AgentExtensionOrigin::TopLevel);
        assert_eq!(items[0].package_root, None);
        assert!(items[0].enabled);
        let prime_items = parse_helper_output_for_agent(payload.as_bytes(), AgentKind::PrimeAgent)
            .expect("projects a separate Prime inventory");
        assert_eq!(prime_items[0].agent_kind, AgentKind::PrimeAgent);

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
        let items = list_global_extensions_for_agent(&cwd, AgentKind::Pi)
            .await
            .expect("lists global extension resources");
        assert!(items.len() <= 512);
        assert!(items.iter().all(|item| item.path.is_absolute()));
    }
}
