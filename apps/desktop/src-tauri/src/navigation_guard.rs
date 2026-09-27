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
}
