//! Thin Tauri composition root for PiUI.
//!
//! Commands expose project registration, trust decisions, read-only session
//! projections, the deterministic fake runtime, and an explicit local Pi RPC
//! preview for trusted projects. The preview starts Pi only through the typed
//! host adapter; the WebView receives neither a general shell/filesystem API
//! nor credentials, raw process handles, or raw Pi RPC frames.

mod acp_agents;
mod agent_api;
mod api;
mod automation_paths;
mod autostart;
mod background;
mod catalog_watch;
mod contributions;
mod dto;
mod harness_configuration;
mod harness_registry_api;
mod orchestration_api;
mod orchestration_schedule;
mod orchestration_scheduler;
mod orchestration_script_test;
#[cfg(feature = "native-prime-scheduler-test")]
pub use orchestration_scheduler::run_native_prime_scheduler_two_step_dependency_dag;
mod orchestration_store;
mod orchestration_triggers;
mod state;
mod workspace_api;

use state::HostState;
#[cfg(debug_assertions)]
use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(debug_assertions)]
const E2E_APP_DATA_DIR_ENV: &str = "PIUI_E2E_APP_DATA_DIR";
#[cfg(debug_assertions)]
const E2E_FIXTURE_ROOT_ENV: &str = "PIUI_E2E_FIXTURE_ROOT";
#[cfg(debug_assertions)]
const E2E_WEBVIEW_DATA_DIR_ENV: &str = "PIUI_E2E_WEBVIEW_DATA_DIR";
#[cfg(debug_assertions)]
const TAURI_WEBVIEW_AUTOMATION_ENV: &str = "TAURI_WEBVIEW_AUTOMATION";
#[cfg(debug_assertions)]
const E2E_AUTOMATION_PORT_ENV: &str = "PIUI_E2E_AUTOMATION_PORT";
#[cfg(debug_assertions)]
const E2E_AUTOMATION_TOKEN_ENV: &str = "PIUI_E2E_AUTOMATION_TOKEN";
#[cfg(debug_assertions)]
const E2E_AUTOMATION_PAGE_ORIGIN_ENV: &str = "PIUI_E2E_AUTOMATION_PAGE_ORIGIN";
#[cfg(debug_assertions)]
const REPOSITORY_E2E_AREA_DIRECTORY: &str = "piui-e2e";
#[cfg(debug_assertions)]
const E2E_AUTOMATION_SCRIPT_PREFIX: &str = r#"(() => {
  const expectedPageOrigin = "#;
#[cfg(debug_assertions)]
const E2E_AUTOMATION_SCRIPT_MIDDLE: &str = r#";
  if (globalThis.top !== globalThis || location.origin !== expectedPageOrigin) return;
  const endpoint = "#;
#[cfg(debug_assertions)]
const E2E_AUTOMATION_SCRIPT_SUFFIX: &str = r#";
  const marker = '__PIUI_E2E_AUTOMATION_ACTIVE__';
  if (globalThis[marker] === endpoint) return;
  Object.defineProperty(globalThis, marker, { value: endpoint, configurable: false });
  const clientId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function request(route, options = {}) {
    const response = await fetch(`${endpoint}/${route}`, {
      cache: 'no-store',
      mode: 'cors',
      ...options,
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Automation request failed with ${response.status}.`);
    }
    return response;
  }

  function errorPayload(error) {
    return {
      name: typeof error?.name === 'string' ? error.name : 'Error',
      message: typeof error?.message === 'string' ? error.message : String(error),
    };
  }

  async function postResult(command, outcome) {
    let body;
    try {
      body = JSON.stringify({ clientId, id: command.id, ...outcome });
    } catch (error) {
      body = JSON.stringify({ clientId, id: command.id, ok: false, error: errorPayload(error) });
    }
    await request('result', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body,
    });
  }

  async function execute(command) {
    if (command.kind === 'evaluate') return await (0, eval)(command.expression);
    if (command.kind === 'dispatchKey') {
      const target = document.activeElement ?? document;
      const init = { ...command.key, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return true;
    }
    if (command.kind === 'reload') return true;
    throw new Error('Unknown WebView automation command.');
  }

  async function run() {
    while (true) {
      try {
        await request('ready', {
          method: 'POST',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({
            clientId,
            href: location.href,
            webviewVersion: navigator.userAgent.match(/\bEdg\/([0-9.]+)/)?.[1] ?? 'unknown',
          }),
        });
        while (true) {
          const response = await request(`next?clientId=${encodeURIComponent(clientId)}`);
          const command = await response.json();
          try {
            const value = await execute(command);
            await postResult(command, { ok: true, value: value === undefined ? null : value });
          } catch (error) {
            await postResult(command, { ok: false, error: errorPayload(error) });
          }
          if (command.kind === 'reload') {
            location.reload();
            return;
          }
        }
      } catch {
        await delay(50);
      }
    }
  }

  void run();
})();"#;

#[cfg(debug_assertions)]
struct E2eDataDirectories {
    app_data_dir: PathBuf,
    webview_data_dir: PathBuf,
}

#[cfg(debug_assertions)]
fn e2e_automation_enabled() -> bool {
    cfg!(feature = "e2e-webview-automation")
        && std::env::var_os(TAURI_WEBVIEW_AUTOMATION_ENV).as_deref()
            == Some(std::ffi::OsStr::new("true"))
}

#[cfg(debug_assertions)]
fn e2e_automation_initialization_script_from_values(
    page_origin: Option<std::ffi::OsString>,
    port: Option<std::ffi::OsString>,
    token: Option<std::ffi::OsString>,
) -> Result<String, std::io::Error> {
    let page_origin = page_origin
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{E2E_AUTOMATION_PAGE_ORIGIN_ENV} must be an exact loopback HTTP origin"),
            )
        })?;
    let page_port = page_origin
        .strip_prefix("http://127.0.0.1:")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .filter(|port| page_origin == format!("http://127.0.0.1:{port}"))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{E2E_AUTOMATION_PAGE_ORIGIN_ENV} must be an exact loopback HTTP origin"),
            )
        })?;
    let port = port
        .and_then(|value| value.into_string().ok())
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{E2E_AUTOMATION_PORT_ENV} must be a non-zero loopback port"),
            )
        })?;
    let token = token
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{E2E_AUTOMATION_TOKEN_ENV} must be a 64-character hexadecimal capability"),
            )
        })?;
    // The Node harness creates 32 random bytes and encodes them as 64 hex
    // characters. Accept only that exact capability format.
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{E2E_AUTOMATION_TOKEN_ENV} must be a 64-character hexadecimal capability"),
        ));
    }
    let page_origin = serde_json::to_string(&format!("http://127.0.0.1:{page_port}"))
        .map_err(std::io::Error::other)?;
    let endpoint = serde_json::to_string(&format!("http://127.0.0.1:{port}/{token}"))
        .map_err(std::io::Error::other)?;
    Ok([
        E2E_AUTOMATION_SCRIPT_PREFIX,
        page_origin.as_str(),
        E2E_AUTOMATION_SCRIPT_MIDDLE,
        endpoint.as_str(),
        E2E_AUTOMATION_SCRIPT_SUFFIX,
    ]
    .concat())
}

#[cfg(debug_assertions)]
fn resolved_e2e_automation_initialization_script() -> Result<String, std::io::Error> {
    e2e_automation_initialization_script_from_values(
        std::env::var_os(E2E_AUTOMATION_PAGE_ORIGIN_ENV),
        std::env::var_os(E2E_AUTOMATION_PORT_ENV),
        std::env::var_os(E2E_AUTOMATION_TOKEN_ENV),
    )
}

#[cfg(debug_assertions)]
fn canonical_existing_directory(
    directory: &Path,
    description: &str,
) -> Result<PathBuf, std::io::Error> {
    let canonical_directory = std::fs::canonicalize(directory)?;
    if !canonical_directory.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{description} must name an existing directory"),
        ));
    }
    Ok(canonical_directory)
}

#[cfg(debug_assertions)]
fn required_e2e_directory(
    e2e_override: Option<PathBuf>,
    environment: &str,
) -> Result<PathBuf, std::io::Error> {
    let Some(e2e_override) = e2e_override.filter(|path| !path.as_os_str().is_empty()) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{environment} must name an existing directory"),
        ));
    };
    canonical_existing_directory(&e2e_override, environment)
}

#[cfg(debug_assertions)]
fn is_strict_descendant(parent: &Path, directory: &Path) -> bool {
    match directory.strip_prefix(parent) {
        Ok(relative) => !relative.as_os_str().is_empty(),
        Err(_) => false,
    }
}

#[cfg(debug_assertions)]
fn canonical_repository_root() -> Result<PathBuf, std::io::Error> {
    let manifest_directory = canonical_existing_directory(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        "PiUI desktop source directory",
    )?;
    let repository_root = manifest_directory.ancestors().nth(3).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PiUI desktop source directory has no repository root",
        )
    })?;
    if !repository_root.join("Cargo.toml").is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PiUI repository root is unavailable",
        ));
    }
    Ok(repository_root.to_path_buf())
}

#[cfg(debug_assertions)]
fn canonical_repository_target_directory(
    repository_root: &Path,
) -> Result<PathBuf, std::io::Error> {
    let repository_root = canonical_existing_directory(repository_root, "PiUI repository root")?;
    let repository_target_directory = canonical_existing_directory(
        &repository_root.join("target"),
        "PiUI repository target directory",
    )?;
    if !is_strict_descendant(&repository_root, &repository_target_directory) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PiUI repository target directory must stay inside the repository root",
        ));
    }
    Ok(repository_target_directory)
}

#[cfg(debug_assertions)]
fn canonical_repository_target_e2e_area_from_root(
    repository_root: &Path,
) -> Result<PathBuf, std::io::Error> {
    let repository_target_directory = canonical_repository_target_directory(repository_root)?;
    let target_e2e_area = canonical_existing_directory(
        &repository_target_directory.join(REPOSITORY_E2E_AREA_DIRECTORY),
        "PiUI repository target E2E area",
    )?;
    if !is_strict_descendant(&repository_target_directory, &target_e2e_area) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PiUI repository target E2E area must stay inside the repository target directory",
        ));
    }
    Ok(target_e2e_area)
}

#[cfg(debug_assertions)]
fn canonical_repository_target_e2e_area() -> Result<PathBuf, std::io::Error> {
    canonical_repository_target_e2e_area_from_root(&canonical_repository_root()?)
}

/// Selects host-only E2E directories without exposing a filesystem surface to
/// the WebView. Automation requires every override and accepts only canonical
/// strict descendants of the repository-owned target E2E area.
#[cfg(debug_assertions)]
fn select_e2e_data_directories(
    automation_enabled: bool,
    fixture_root: Option<PathBuf>,
    app_data_override: Option<PathBuf>,
    webview_data_override: Option<PathBuf>,
) -> Result<Option<E2eDataDirectories>, std::io::Error> {
    if !automation_enabled {
        return Ok(None);
    }
    let target_e2e_area = canonical_repository_target_e2e_area()?;
    let fixture_root = required_e2e_directory(fixture_root, E2E_FIXTURE_ROOT_ENV)?;
    let app_data_dir = required_e2e_directory(app_data_override, E2E_APP_DATA_DIR_ENV)?;
    let webview_data_dir = required_e2e_directory(webview_data_override, E2E_WEBVIEW_DATA_DIR_ENV)?;
    if !is_strict_descendant(&target_e2e_area, &fixture_root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PIUI_E2E_FIXTURE_ROOT must be inside the repository target E2E area",
        ));
    }
    if !is_strict_descendant(&fixture_root, &app_data_dir) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PIUI_E2E_APP_DATA_DIR must be inside PIUI_E2E_FIXTURE_ROOT",
        ));
    }
    if !is_strict_descendant(&fixture_root, &webview_data_dir) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PIUI_E2E_WEBVIEW_DATA_DIR must be inside PIUI_E2E_FIXTURE_ROOT",
        ));
    }
    Ok(Some(E2eDataDirectories {
        app_data_dir,
        webview_data_dir,
    }))
}

#[cfg(debug_assertions)]
fn resolved_e2e_data_directories() -> Result<Option<E2eDataDirectories>, std::io::Error> {
    select_e2e_data_directories(
        e2e_automation_enabled(),
        std::env::var_os(E2E_FIXTURE_ROOT_ENV).map(PathBuf::from),
        std::env::var_os(E2E_APP_DATA_DIR_ENV).map(PathBuf::from),
        std::env::var_os(E2E_WEBVIEW_DATA_DIR_ENV).map(PathBuf::from),
    )
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::{
        REPOSITORY_E2E_AREA_DIRECTORY, canonical_repository_root,
        canonical_repository_target_directory, canonical_repository_target_e2e_area,
        canonical_repository_target_e2e_area_from_root,
        e2e_automation_initialization_script_from_values, select_e2e_data_directories,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_TEST_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

    fn next_test_directory(parent: &Path, purpose: &str) -> PathBuf {
        let sequence = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        parent.join(format!(
            "piui-e2e-{purpose}-{}-{sequence}",
            std::process::id()
        ))
    }

    fn repository_target_e2e_area() -> PathBuf {
        let repository_root = canonical_repository_root().expect("finds the PiUI repository root");
        let target_directory = canonical_repository_target_directory(&repository_root)
            .expect("finds the repository-owned target directory");
        let target_e2e_area = target_directory.join(REPOSITORY_E2E_AREA_DIRECTORY);
        fs::create_dir_all(&target_e2e_area).expect("creates the repository target E2E area");
        canonical_repository_target_e2e_area()
            .expect("canonicalizes the repository target E2E area")
    }

    #[test]
    fn e2e_automation_script_requires_the_exact_loopback_capability_shape() {
        let token = "ab".repeat(32);
        let script = e2e_automation_initialization_script_from_values(
            Some("http://127.0.0.1:43122".into()),
            Some("43123".into()),
            Some(token.clone().into()),
        )
        .expect("builds the debug-only automation script");
        assert!(script.contains("http://127.0.0.1:43122"));
        assert!(script.contains(&format!("http://127.0.0.1:43123/{token}")));
        assert!(script.contains("globalThis.top !== globalThis"));
        assert!(script.contains("command.kind === 'dispatchKey'"));
        assert!(script.contains("command.kind === 'reload'"));

        assert!(e2e_automation_initialization_script_from_values(None, None, None).is_err());
        assert!(
            e2e_automation_initialization_script_from_values(
                Some("http://localhost:43122".into()),
                Some("43123".into()),
                Some(token.clone().into()),
            )
            .is_err()
        );
        assert!(
            e2e_automation_initialization_script_from_values(
                Some("http://127.0.0.1:43122".into()),
                Some("0".into()),
                Some(token.clone().into()),
            )
            .is_err()
        );
        assert!(
            e2e_automation_initialization_script_from_values(
                Some("http://127.0.0.1:43122".into()),
                Some("43123".into()),
                Some("not-a-capability".into()),
            )
            .is_err()
        );
    }

    #[test]
    fn e2e_automation_directories_require_target_owned_existing_overrides() {
        let target_e2e_area = repository_target_e2e_area();
        let root = next_test_directory(&target_e2e_area, "app-data-selector");
        let app_data = root.join("app-data");
        let webview_data = root.join("webview-data");
        let override_file = root.join("not-a-directory");
        let missing_directory = root.join("missing");
        let escaped_root = root.join("..");
        let sibling = next_test_directory(&target_e2e_area, "app-data-selector-sibling");
        let outside_target_e2e_area = next_test_directory(
            target_e2e_area
                .parent()
                .expect("target E2E area has a target-directory parent"),
            "outside-e2e-area",
        );
        let temporary_root = next_test_directory(&std::env::temp_dir(), "outside-temporary-root");
        let temporary_app_data = temporary_root.join("app-data");
        let temporary_webview_data = temporary_root.join("webview-data");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&sibling);
        let _ = fs::remove_dir_all(&outside_target_e2e_area);
        let _ = fs::remove_dir_all(&temporary_root);
        fs::create_dir_all(&app_data).expect("creates app-data directory");
        fs::create_dir_all(&webview_data).expect("creates webview-data directory");
        fs::create_dir_all(&sibling).expect("creates sibling directory");
        fs::create_dir_all(&outside_target_e2e_area).expect("creates target sibling directory");
        fs::create_dir_all(&temporary_app_data).expect("creates temporary app-data directory");
        fs::create_dir_all(&temporary_webview_data)
            .expect("creates temporary webview-data directory");
        fs::write(&override_file, "fixture").expect("creates override file");

        let ignored = select_e2e_data_directories(
            false,
            Some(temporary_root.clone()),
            Some(temporary_app_data.clone()),
            Some(temporary_webview_data.clone()),
        )
        .expect("ignores overrides unless automation is explicitly enabled");
        assert!(ignored.is_none());
        assert!(select_e2e_data_directories(true, None, None, None).is_err());
        assert!(
            select_e2e_data_directories(true, Some(root.clone()), None, Some(webview_data.clone()))
                .is_err()
        );
        assert!(
            select_e2e_data_directories(true, Some(root.clone()), Some(app_data.clone()), None)
                .is_err()
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(root.clone()),
                Some(missing_directory),
                Some(webview_data.clone()),
            )
            .is_err()
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(root.clone()),
                Some(override_file),
                Some(webview_data.clone()),
            )
            .is_err()
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(root.clone()),
                Some(PathBuf::new()),
                Some(webview_data.clone()),
            )
            .is_err()
        );

        let selected = select_e2e_data_directories(
            true,
            Some(root.clone()),
            Some(app_data.clone()),
            Some(webview_data.clone()),
        )
        .expect("accepts owned existing override directories")
        .expect("automation selects both owned directories");
        assert_eq!(
            selected.app_data_dir,
            fs::canonicalize(&app_data).expect("canonicalizes app-data directory")
        );
        assert_eq!(
            selected.webview_data_dir,
            fs::canonicalize(&webview_data).expect("canonicalizes webview-data directory")
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(target_e2e_area.clone()),
                Some(app_data.clone()),
                Some(webview_data.clone()),
            )
            .is_err()
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(outside_target_e2e_area.clone()),
                Some(app_data.clone()),
                Some(webview_data.clone()),
            )
            .is_err()
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(temporary_root.clone()),
                Some(temporary_app_data),
                Some(temporary_webview_data),
            )
            .is_err()
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(root.clone()),
                Some(sibling.clone()),
                Some(webview_data.clone()),
            )
            .is_err()
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(root.clone()),
                Some(app_data.clone()),
                Some(sibling.clone()),
            )
            .is_err()
        );
        assert!(
            select_e2e_data_directories(
                true,
                Some(root.clone()),
                Some(escaped_root),
                Some(webview_data),
            )
            .is_err()
        );

        fs::remove_dir_all(root).expect("removes selector fixture");
        fs::remove_dir_all(sibling).expect("removes selector sibling");
        fs::remove_dir_all(outside_target_e2e_area)
            .expect("removes target sibling outside the E2E area");
        fs::remove_dir_all(temporary_root).expect("removes temporary selector fixture");
    }

    #[cfg(any(unix, windows))]
    fn create_directory_link(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).expect("creates directory symlink");
            true
        }
        #[cfg(windows)]
        {
            if let Err(error) = std::os::windows::fs::symlink_dir(target, link) {
                if std::env::var_os("PIUI_REQUIRE_WINDOWS_REPARSE_TEST").as_deref()
                    == Some(std::ffi::OsStr::new("1"))
                {
                    panic!(
                        "required Windows reparse test could not create a directory symlink: {error}"
                    );
                }
                eprintln!(
                    "SKIP: Windows reparse test could not create a directory symlink ({error}); \
                     set PIUI_REQUIRE_WINDOWS_REPARSE_TEST=1 to require this capability"
                );
                return false;
            }
            true
        }
    }

    #[cfg(any(unix, windows))]
    fn remove_directory_link(link: &Path) {
        let _ = fs::remove_file(link);
        let _ = fs::remove_dir(link);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn repository_target_e2e_area_rejects_reparse_escapes_when_available() {
        let test_root = next_test_directory(&std::env::temp_dir(), "reparse-escape");
        let target_alias_repository = test_root.join("target-alias-repository");
        let target_alias_outside = test_root.join("target-alias-outside");
        let base_alias_repository = test_root.join("base-alias-repository");
        let base_alias_outside = test_root.join("base-alias-outside");
        let target_alias = target_alias_repository.join("target");
        let base_alias = base_alias_repository
            .join("target")
            .join(REPOSITORY_E2E_AREA_DIRECTORY);
        let _ = fs::remove_dir_all(&test_root);
        fs::create_dir_all(&target_alias_repository).expect("creates target-alias repository root");
        fs::create_dir_all(&target_alias_outside).expect("creates target-alias escape destination");

        if !create_directory_link(&target_alias_outside, &target_alias) {
            fs::remove_dir_all(test_root).expect("removes unavailable reparse fixture");
            return;
        }
        assert!(canonical_repository_target_directory(&target_alias_repository).is_err());
        remove_directory_link(&target_alias);

        fs::create_dir_all(base_alias_repository.join("target"))
            .expect("creates base-alias target directory");
        fs::create_dir_all(&base_alias_outside).expect("creates base-alias escape destination");
        assert!(create_directory_link(&base_alias_outside, &base_alias));
        assert!(canonical_repository_target_e2e_area_from_root(&base_alias_repository).is_err());
        remove_directory_link(&base_alias);
        fs::remove_dir_all(test_root).expect("removes reparse fixture");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), tauri::Error> {
    let agent_server = agent_api::Server::from_environment()?;
    let safe_mode = std::env::args().any(|argument| argument == "--safe-mode");
    #[cfg(debug_assertions)]
    let e2e_directories = resolved_e2e_data_directories()?;
    #[cfg(debug_assertions)]
    let e2e_automation_script = if e2e_directories.is_some() {
        Some(resolved_e2e_automation_initialization_script()?)
    } else {
        None
    };
    let context = tauri::generate_context!();
    // E2E hosts never touch the person's real sign-in registration, and run
    // side by side in isolated data folders outside the single-instance guard.
    #[cfg(debug_assertions)]
    let e2e_isolated = e2e_directories.is_some();
    #[cfg(not(debug_assertions))]
    let e2e_isolated = false;
    let autostart_allowed = !e2e_isolated;
    #[cfg(debug_assertions)]
    if e2e_directories.is_some()
        && context
            .config()
            .app
            .windows
            .iter()
            .any(|window| window.create)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "E2E WebView automation requires its window config to disable automatic creation",
        )
        .into());
    }

    let mut builder = tauri::Builder::default();
    // Registered first: a second launch hands its arguments to the running
    // PiUI and exits before any window, journal or runtime opens.
    if background::single_instance_guard(e2e_isolated) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            background::on_second_launch(app, &args);
        }));
    }
    // Host-driven only: the WebView has no autostart permission. Windows
    // writes its own quoted Run value instead (autostart.rs).
    #[cfg(not(windows))]
    {
        builder = builder.plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(background::AUTOSTART_ARG)
                .build(),
        );
    }
    let app = builder
        .on_window_event(background::on_window_event)
        .setup(move |app| {
            #[cfg(debug_assertions)]
            if let Some(e2e_directories) = &e2e_directories {
                let main_config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|window| window.label == "main" && !window.create)
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "E2E WebView automation requires a manually created main window",
                        )
                    })?;
                let mut builder =
                    tauri::WebviewWindowBuilder::from_config(app.handle(), main_config)?
                        .data_directory(e2e_directories.webview_data_dir.clone());
                if let Some(script) = &e2e_automation_script {
                    builder = builder.initialization_script(script.as_str());
                }
                builder.build()?;
            }
            #[cfg(debug_assertions)]
            let app_data_dir = match &e2e_directories {
                Some(e2e_directories) => e2e_directories.app_data_dir.clone(),
                None => app.path().app_data_dir()?,
            };
            #[cfg(not(debug_assertions))]
            let app_data_dir = app.path().app_data_dir()?;
            let state = HostState::open(&app_data_dir, safe_mode)
                .map_err(Box::<dyn std::error::Error>::from)?;
            let extension_ui = app.handle().clone();
            state
                .workspace
                .set_extension_ui_publisher(std::sync::Arc::new(move |event| {
                    use tauri::Emitter;
                    let _ = extension_ui.emit(workspace_api::WORKSPACE_EXTENSION_UI_EVENT, event);
                }));
            let orchestration = orchestration_api::OrchestrationApiState::open(&app_data_dir)
                .map_err(|_| std::io::Error::other("Could not open local orchestration data"))?;
            app.manage(orchestration);
            let orchestration_scheduler =
                orchestration_scheduler::OrchestrationScheduler::default();
            app.manage(orchestration_scheduler.clone());
            app.manage(orchestration_script_test::ScriptTestState::default());
            let watcher = catalog_watch::start_catalog_watcher(
                app.handle().clone(),
                state.all_session_roots(),
            );
            state.set_catalog_watcher(watcher);
            app.manage(state);
            let trigger_engine = orchestration_triggers::TriggerEngine::default();
            app.manage(trigger_engine.clone());
            background::setup(app.handle(), safe_mode, autostart_allowed);
            if !safe_mode {
                orchestration_scheduler.start_timed_schedule_worker(app.handle().clone());
                trigger_engine.start(app.handle().clone());
                harness_registry_api::start_background_discovery(app.handle().clone());
            }
            if let Some(server) = agent_server {
                server.start(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace_api::workspace_command_v15,
            workspace_api::workspace_history_v1,
            workspace_api::workspace_settings_v16,
            workspace_api::composer::workspace_composer_v19,
            workspace_api::workspace_lifecycle_v17,
            workspace_api::harness_models_v18,
            workspace_api::workspace_session_mode_v1,
            harness_registry_api::harness_registry_v1,
            api::bootstrap,
            api::bootstrap_v10,
            api::update_preferences,
            api::update_preferences_v8,
            api::list_extensions,
            api::list_extensions_v10,
            api::list_piui_contributions,
            api::set_extension_enabled,
            api::set_extension_enabled_v10,
            api::add_project,
            api::add_project_v10,
            api::pick_and_add_project,
            api::pick_and_add_project_v10,
            api::set_project_trust,
            api::rename_project,
            api::set_project_pinned,
            api::remove_project,
            api::search_sessions,
            api::list_sessions,
            api::list_personal_sessions,
            api::get_session_catalog,
            api::get_personal_session_catalog,
            api::refresh_session_catalog,
            api::refresh_personal_session_catalog,
            api::get_timeline,
            api::get_timeline_page,
            api::get_personal_timeline_page,
            api::get_tree,
            api::get_personal_tree,
            api::probe_system_runtime,
            api::run_fake_scenario,
            api::start_fake_runtime,
            api::stop_runtime,
            api::start_runtime,
            api::start_personal_chat,
            api::send_prompt,
            api::send_steer,
            api::send_follow_up,
            api::abort_runtime,
            api::stop_live_runtime,
            api::get_runtime_state,
            api::get_runtime_models,
            api::get_runtime_thinking_levels,
            api::get_runtime_commands,
            api::respond_extension_ui,
            api::set_runtime_model,
            api::set_runtime_thinking,
            api::set_runtime_session_name,
            orchestration_api::orchestration_cancel_task_v6,
            orchestration_api::orchestration_control_flow_v6,
            orchestration_api::orchestration_run_usage_v6,
            orchestration_api::orchestration_catalog_v6,
            orchestration_api::orchestration_save_graph_v6,
            orchestration_api::orchestration_get_profile_v6,
            orchestration_api::orchestration_save_profile_v6,
            orchestration_api::orchestration_delete_profile_v6,
            orchestration_api::orchestration_get_team_v6,
            orchestration_api::orchestration_save_team_v6,
            orchestration_api::orchestration_delete_team_v6,
            orchestration_api::orchestration_get_pipeline_v6,
            orchestration_api::orchestration_save_pipeline_v6,
            orchestration_api::orchestration_delete_pipeline_v6,
            orchestration_api::orchestration_get_launch_command_v6,
            orchestration_api::orchestration_save_launch_command_v6,
            orchestration_api::orchestration_delete_launch_command_v6,
            orchestration_api::orchestration_list_schedules_v7,
            orchestration_api::orchestration_save_schedule_v7,
            orchestration_api::orchestration_set_schedule_enabled_v7,
            orchestration_api::orchestration_delete_schedule_v7,
            orchestration_api::orchestration_automations_v7,
            orchestration_api::orchestration_set_automations_paused_v7,
            background::background_settings_v1,
            background::background_update_v1,
            background::background_tray_labels_v1,
            orchestration_api::orchestration_list_runs_v6,
            orchestration_api::orchestration_get_run_v6,
            orchestration_api::orchestration_start_run_v6,
            orchestration_api::orchestration_cancel_run_v6,
            orchestration_api::orchestration_reconcile_uncertain_task_v6,
            orchestration_api::orchestration_retry_uncertain_task_v6,
            orchestration_script_test::orchestration_script_test_v1,
            orchestration_script_test::orchestration_cancel_script_test_v1,
        ])
        .build(context)?;
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            let state = app.state::<HostState>();
            if state.is_shutdown_complete() {
                return;
            }
            api.prevent_exit();
            if state.begin_shutdown() {
                app.state::<orchestration_scheduler::OrchestrationScheduler>()
                    .begin_shutdown();
                if let Some(engine) = app.try_state::<orchestration_triggers::TriggerEngine>() {
                    engine.begin_shutdown();
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<HostState>();
                    api::shutdown_application_runtimes(&state).await;
                    state.finish_shutdown();
                    app.exit(code.unwrap_or_default());
                });
            }
        }
    });
    Ok(())
}
