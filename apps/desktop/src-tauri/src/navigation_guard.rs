//! The app window never shows the plugin panel origin (ADR-032).
//!
//! Tauri treats an app-registered protocol as a local origin, so a top-level
//! document on `piui-plugin` would get the app's IPC bridge. Panels and chat
//! renderers are framed with `sandbox="allow-scripts"` and cannot navigate
//! the top window, and PiUI renders links as text; these guards are the
//! defence in depth behind that:
//!
//! - **Windows:** WebView2 reports top-level navigations only to the
//!   navigation hook (`NavigationStarting`; frames use
//!   `FrameNavigationStarting`, which wry does not forward), so the hook
//!   refuses every navigation to the plugin origin before it starts.
//! - **Every platform:** a page load of the main document on the plugin origin
//!   is sent back to the last app page. wry reports page loads for the main
//!   frame only (WebView2 `NavigationCompleted`, WKWebView
//!   `didCommitNavigation`/`didFinishNavigation`, WebKitGTK `load-changed`),
//!   so panel frames are never touched. On macOS and Linux this is the guard:
//!   wry forwards frame navigations to the same navigation hook without
//!   saying which frame they are for, so refusing the origin there would
//!   break every panel. It acts after the load started, not before.
//! - **Every platform:** app commands are an allowlist ([`refuses_command_source`]):
//!   only the `main` webview, showing an app origin, may call them. The Nano
//!   Cloud window (`nano-cloud`, ADR-049) shows a remote origin and therefore
//!   never gets IPC; no capability lists it either.
//! - **Every platform:** app commands refuse a call whose webview shows the
//!   plugin origin ([`refuses_invoke`]), which closes that short window for
//!   PiUI's own commands. The core event listener remains reachable during
//!   it; closing that needs wry to report whether a navigation is for the
//!   main frame (not available in wry 0.55).

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::plugin::TauriPlugin;
use tauri::{Runtime, Url};

/// Whether `url` is on the plugin origin, in either spelling.
pub(crate) fn is_plugin_url(url: &Url) -> bool {
    piui_plugins::csp::is_plugin_location(url.scheme(), url.host_str().unwrap_or(""))
}

/// Whether an app command from a webview showing `url` must be refused.
pub(crate) fn refuses_invoke(url: Option<&Url>) -> bool {
    url.is_some_and(is_plugin_url)
}

/// The only webview allowed to call app commands.
const APP_WINDOW: &str = "main";

/// Whether `url` is an origin the application itself serves: the packaged
/// frontend (`tauri://localhost`, or `http(s)://tauri.localhost` on Windows)
/// and, in debug builds only, the local dev server.
pub(crate) fn is_app_origin(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "tauri" => host == "localhost",
        "http" | "https" => {
            host == "tauri.localhost"
                || (cfg!(debug_assertions) && matches!(host, "localhost" | "127.0.0.1"))
        }
        _ => false,
    }
}

/// Whether an app command from the webview `label` currently showing `url`
/// must be refused. Only the main window on an app origin may call commands;
/// the plugin origin is refused as well. A webview whose address cannot be
/// read is judged by its label alone.
pub(crate) fn refuses_command_source(label: &str, url: Option<&Url>) -> bool {
    label != APP_WINDOW || refuses_invoke(url) || url.is_some_and(|url| !is_app_origin(url))
}

/// The page a webview is sent back to: its last page off the plugin origin.
#[derive(Default)]
struct LastPages(Mutex<HashMap<String, Url>>);

impl LastPages {
    /// Records `url` for `label`, or returns where to go instead of it.
    fn visit(&self, label: &str, url: &Url) -> Option<Url> {
        let mut pages = self.0.lock().ok()?;
        if is_plugin_url(url) {
            return pages
                .get(label)
                .cloned()
                .or_else(|| Url::parse("about:blank").ok());
        }
        pages.insert(label.to_owned(), url.clone());
        None
    }
}

/// The `piui-navigation-guard` plugin (see the module documentation).
pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let pages = LastPages::default();
    let builder = tauri::plugin::Builder::<R>::new("piui-navigation-guard");
    #[cfg(windows)]
    let builder = builder.on_navigation(|_webview, url| !is_plugin_url(url));
    builder
        .on_page_load(move |webview, payload| {
            if let Some(back) = pages.visit(webview.label(), payload.url()) {
                eprintln!(
                    "event=plugin_origin_page_refused webview={:?}",
                    webview.label()
                );
                let _ = webview.navigate(back);
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).expect("url")
    }

    #[test]
    fn plugin_pages_are_sent_back_to_the_last_app_page() {
        let pages = LastPages::default();
        assert_eq!(
            pages.visit("main", &url("tauri://localhost/index.html")),
            None
        );
        assert_eq!(
            pages.visit("main", &url("http://tauri.localhost/?view=legacy")),
            None
        );
        for plugin in [
            "http://piui-plugin.localhost/example.hello/ui/index.html?panel=hello",
            "piui-plugin://localhost/example.hello/ui/index.html",
            "http://sub.piui-plugin.localhost/x",
        ] {
            assert_eq!(
                pages.visit("main", &url(plugin)),
                Some(url("http://tauri.localhost/?view=legacy")),
                "{plugin}"
            );
        }
        // Before any app page: a blank page, never the plugin one.
        assert_eq!(
            pages.visit("other", &url("piui-plugin://localhost/x/ui/a.html")),
            Some(url("about:blank"))
        );
    }

    #[test]
    fn app_commands_refuse_a_webview_on_the_plugin_origin() {
        assert!(refuses_invoke(Some(&url(
            "http://piui-plugin.localhost/example.hello/ui/index.html"
        ))));
        assert!(refuses_invoke(Some(&url(
            "piui-plugin://localhost/a/b.html"
        ))));
        assert!(!refuses_invoke(Some(&url("http://tauri.localhost/"))));
        assert!(!refuses_invoke(Some(&url("http://localhost:1420/"))));
        assert!(!refuses_invoke(None));
    }

    #[test]
    fn commands_come_only_from_the_main_window_on_an_app_origin() {
        for app in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/?view=settings",
        ] {
            assert!(!refuses_command_source("main", Some(&url(app))), "{app}");
        }
        assert!(!refuses_command_source("main", None));

        // The cloud window and any other label never get commands, even on
        // an app origin.
        for label in ["nano-cloud", "other", "", "Main", "main "] {
            assert!(
                refuses_command_source(label, Some(&url("http://tauri.localhost/"))),
                "{label:?}"
            );
            assert!(refuses_command_source(label, None), "{label:?}");
        }

        // The main window showing a remote or foreign origin is refused.
        for foreign in [
            "https://nanoagents.ru/",
            "https://hermes.nanoagents.ru/",
            "https://tauri.localhost.evil.example/",
            "http://evil.example/",
            "file:///C:/page.html",
            "about:blank",
            "http://piui-plugin.localhost/example.hello/ui/index.html",
            "piui-plugin://localhost/a/b.html",
            "ws://tauri.localhost/",
        ] {
            assert!(
                refuses_command_source("main", Some(&url(foreign))),
                "{foreign}"
            );
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_builds_also_accept_the_local_dev_server() {
        assert!(!refuses_command_source(
            "main",
            Some(&url("http://localhost:1420/"))
        ));
        assert!(!refuses_command_source(
            "main",
            Some(&url("http://127.0.0.1:1420/"))
        ));
        assert!(refuses_command_source(
            "nano-cloud",
            Some(&url("http://localhost:1420/"))
        ));
    }
}
