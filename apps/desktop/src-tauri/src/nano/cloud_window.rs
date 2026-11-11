//! The Nano Cloud window (ADR-049): the Nano web app in a separate window.
//!
//! - Label `nano-cloud`, title "Nano Cloud", no IPC: no capability lists the
//!   label and the command guard (`guarded_commands`) refuses every invoke
//!   that does not come from the main window on an app origin.
//! - Its own WebView profile folder, cleared when the account signs out or
//!   its credential expires.
//! - Navigation is limited to https Nano hosts (`nanoagents.ru` and its
//!   subdomains; the development issuer's origin in development). Every other
//!   link and every new-window request opens in the system browser. Downloads
//!   are refused.

use std::path::{Path, PathBuf};

use piui_nano::NanoError;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

use super::browser;

/// The window label. Never listed in a capability.
pub(crate) const CLOUD_LABEL: &str = "nano-cloud";
/// Where the window starts when the server names no cloud link.
pub(crate) const DEFAULT_CLOUD_URL: &str = "https://hermes.nanoagents.ru/";
const NANO_SITE: &str = "nanoagents.ru";

fn is_nano_host(host: &str) -> bool {
    host == NANO_SITE
        || host
            .strip_suffix(NANO_SITE)
            .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
}

/// Whether the cloud window may navigate to `url`: an https Nano host on the
/// default port, or the development issuer's origin (`development_origin`,
/// set only while a development issuer is configured). Credentials in the URL
/// are never allowed.
pub(crate) fn navigation_allowed(url: &Url, development_origin: Option<&str>) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.scheme() == "https" && url.port().is_none() && url.host_str().is_some_and(is_nano_host) {
        return true;
    }
    development_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin)
}

/// The URL the window opens when the server offers none: the production web
/// app, or the development issuer's `/cloud` page.
pub(crate) fn default_cloud_url(config: &piui_nano::NanoConfig) -> Url {
    if config.development
        && let Ok(url) = config.issuer.join("cloud")
    {
        return url;
    }
    Url::parse(DEFAULT_CLOUD_URL).unwrap_or_else(|_| config.issuer.clone())
}

/// What the window's handlers need, owned by the closures.
#[derive(Clone)]
pub(crate) struct CloudPolicy {
    /// The development issuer's origin; `None` for the production issuer.
    pub(crate) development_origin: Option<String>,
    /// Whether plain-http loopback links may open in the system browser.
    pub(crate) allow_loopback_http: bool,
}

/// Shows and focuses the cloud window when it is open.
pub(crate) fn focus_existing<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(CLOUD_LABEL) else {
        return false;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    true
}

/// Opens the cloud window on `url`, or shows and focuses the open one.
///
/// # Errors
/// [`NanoError::Invalid`] when `url` is not an allowed Nano origin;
/// [`NanoError::FeatureUnavailable`] when the window cannot be created.
pub(crate) fn open_or_focus<R: Runtime>(
    app: &AppHandle<R>,
    url: Url,
    profile_dir: PathBuf,
    policy: CloudPolicy,
) -> Result<(), NanoError> {
    if focus_existing(app) {
        return Ok(());
    }
    if !navigation_allowed(&url, policy.development_origin.as_deref()) {
        return Err(NanoError::Invalid);
    }
    std::fs::create_dir_all(&profile_dir).map_err(|_| NanoError::FeatureUnavailable)?;
    let navigation = policy.clone();
    let new_window = policy;
    WebviewWindowBuilder::new(app, CLOUD_LABEL, WebviewUrl::External(url))
        .title("Nano Cloud")
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 360.0)
        .data_directory(profile_dir)
        .on_navigation(move |target| {
            if navigation_allowed(target, navigation.development_origin.as_deref()) {
                return true;
            }
            // A link to anywhere else leaves the app for the system browser.
            let _ = browser::open_external(target, navigation.allow_loopback_http);
            false
        })
        .on_new_window(move |target, _features| {
            let _ = browser::open_external(&target, new_window.allow_loopback_http);
            NewWindowResponse::Deny
        })
        .on_download(|_, _| false)
        .build()
        .map(|_| ())
        .map_err(|_| NanoError::FeatureUnavailable)
}

/// Forgets the cloud window's browsing data and closes it: called when the
/// account signs out or its credential expires. The profile folder is also
/// removed (best effort: the WebView may still hold files for a moment).
pub(crate) fn clear<R: Runtime>(app: &AppHandle<R>, profile_dir: &Path) {
    if let Some(window) = app.get_webview_window(CLOUD_LABEL) {
        let _ = window.clear_all_browsing_data();
        let _ = window.destroy();
    }
    let profile_dir = profile_dir.to_path_buf();
    // Detached on purpose: nothing waits for the best-effort cleanup.
    std::thread::spawn(move || remove_profile(&profile_dir));
}

/// Removes the profile folder, retrying while the WebView releases its files.
fn remove_profile(profile_dir: &Path) {
    for attempt in 0..5 {
        match std::fs::remove_dir_all(profile_dir) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).expect("url")
    }

    #[test]
    fn nano_hosts_are_the_site_and_its_subdomains_only() {
        for allowed in [
            "https://nanoagents.ru/",
            "https://hermes.nanoagents.ru/chat?x=1",
            "https://a.b.nanoagents.ru/",
            "https://NANOAGENTS.RU/",
        ] {
            assert!(navigation_allowed(&url(allowed), None), "{allowed}");
        }
        for refused in [
            "http://nanoagents.ru/",
            "https://nanoagents.ru:8443/",
            "https://evilnanoagents.ru/",
            "https://nanoagents.ru.evil.example/",
            concat!("https://nanoagents.ru", "@evil.example/"),
            concat!("https://user:pass", "@nanoagents.ru/"),
            "https://example.com/?u=nanoagents.ru",
            "https://.nanoagents.ru/",
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "data:text/html,x",
            "blob:https://nanoagents.ru/abc",
            "ws://nanoagents.ru/",
        ] {
            if let Ok(parsed) = Url::parse(refused) {
                assert!(!navigation_allowed(&parsed, None), "{refused}");
            }
        }
        assert!(navigation_allowed(&url("about:blank"), None));
    }

    #[test]
    fn the_development_origin_is_allowed_only_when_configured() {
        let origin = "http://127.0.0.1:8787";
        assert!(!navigation_allowed(
            &url("http://127.0.0.1:8787/cloud"),
            None
        ));
        assert!(navigation_allowed(
            &url("http://127.0.0.1:8787/cloud"),
            Some(origin)
        ));
        assert!(!navigation_allowed(
            &url("http://127.0.0.1:9999/cloud"),
            Some(origin)
        ));
        assert!(!navigation_allowed(
            &url("http://localhost:8787/cloud"),
            Some(origin)
        ));
        assert!(navigation_allowed(
            &url("https://nanoagents.ru/"),
            Some(origin)
        ));
    }

    #[test]
    fn the_default_url_follows_the_issuer() {
        let production = piui_nano::NanoConfig::from_parts(None, "0.3.0").expect("production");
        assert_eq!(default_cloud_url(&production).as_str(), DEFAULT_CLOUD_URL);
        let development = piui_nano::NanoConfig::from_parts(Some("http://127.0.0.1:8787"), "0.3.0")
            .expect("development");
        assert_eq!(
            default_cloud_url(&development).as_str(),
            "http://127.0.0.1:8787/cloud"
        );
        assert!(navigation_allowed(&default_cloud_url(&production), None));
    }

    #[test]
    fn no_capability_lists_the_cloud_window() {
        let capabilities = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        for entry in std::fs::read_dir(capabilities).expect("capabilities folder") {
            let text = std::fs::read_to_string(entry.expect("entry").path()).expect("capability");
            assert!(
                !text.contains(CLOUD_LABEL),
                "a capability lists the cloud window"
            );
            assert!(
                !text.contains("\"remote\""),
                "a capability grants a remote origin"
            );
        }
    }
}
