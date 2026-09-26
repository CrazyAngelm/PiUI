//! What the plugin protocol serves: the per-plugin Content-Security-Policy
//! of a panel document and the content types of its static files.
//!
//! The host serves a plugin's UI only from the folder of its `ui.entry` on
//! the dedicated `piui-plugin` custom protocol. On Windows (WebView2) that
//! origin is `http://piui-plugin.localhost`; on macOS and Linux it is
//! `piui-plugin://localhost`. Panels are framed with
//! `sandbox="allow-scripts"`, and the document's own policy repeats the
//! sandbox, so it keeps an opaque origin even when opened directly.

/// The custom URI scheme registered with the WebView.
pub const PLUGIN_SCHEME: &str = "piui-plugin";

/// The origin panels load from on this platform.
#[must_use]
pub fn plugin_origin() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://piui-plugin.localhost"
    } else {
        "piui-plugin://localhost"
    }
}

/// The URL of `path` (inside the plugin's UI folder) for plugin `id`.
#[must_use]
pub fn plugin_url(origin: &str, id: &str, path: &str) -> String {
    format!("{origin}/{id}/{path}")
}

/// The folder panel files are served from: the folder of `ui.entry`, as a
/// URL path under the plugin id ending in `/` (`example.hello/ui/`).
#[must_use]
pub fn ui_base(id: &str, ui_entry: &str) -> String {
    match ui_entry.rsplit_once('/') {
        Some((folder, _)) => format!("{id}/{folder}/"),
        None => format!("{id}/"),
    }
}

/// The policy of one plugin's panel documents: scripts, styles, images and
/// fonts only from the plugin's UI folder on `origin`; no connections,
/// frames, workers, forms or base changes; always sandboxed with scripts
/// and without same-origin access. `base` comes from [`ui_base`].
#[must_use]
pub fn panel_policy(origin: &str, base: &str) -> String {
    let own = format!("{origin}/{base}");
    format!(
        "default-src 'none'; script-src {own}; style-src {own}; img-src {own} data:; font-src {own}; \
         connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; \
         manifest-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts"
    )
}

/// The content type of a served file, by extension. Anything else is not
/// served.
#[must_use]
pub fn content_type(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_limits_every_resource_to_the_plugin_folder() {
        assert_eq!(
            ui_base("example.hello", "ui/index.html"),
            "example.hello/ui/"
        );
        assert_eq!(ui_base("example.hello", "index.html"), "example.hello/");
        let base = ui_base("example.hello", "ui/index.html");
        let policy = panel_policy("http://piui-plugin.localhost", &base);
        assert!(policy.starts_with("default-src 'none';"));
        assert!(policy.contains("script-src http://piui-plugin.localhost/example.hello/ui/;"));
        assert!(policy.contains("connect-src 'none'"));
        assert!(policy.ends_with("sandbox allow-scripts"));
        assert!(
            !policy.contains("'unsafe-inline'")
                && !policy.contains("'unsafe-eval'")
                && !policy.contains("'self'")
        );
        assert_eq!(
            content_type("ui/index.HTML"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(content_type("backend/main.exe"), None);
        assert_eq!(content_type("README"), None);
    }
}
