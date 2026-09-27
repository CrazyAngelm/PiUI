//! The `piui-plugin` custom protocol: serves an active plugin's panel files
//! (the folder of its `ui.entry`) to the sandboxed panel frame, and nothing
//! else.
//!
//! `http://piui-plugin.localhost/<plugin id>/<path>` on Windows,
//! `piui-plugin://localhost/<plugin id>/<path>` elsewhere. Only GET; only
//! allowlisted content types; the HTML document carries the per-plugin
//! policy (`piui_plugins::csp::panel_policy`) that keeps it sandboxed with an
//! opaque origin, loads resources only from the plugin's UI folder and
//! forbids connections, frames and workers. Other responses allow any origin
//! to read them, because a sandboxed document has the opaque origin `null`
//! (module scripts and fonts are CORS requests); a panel's own policy stops
//! it from fetching anything. Safe mode and inactive plugins get 404.

use piui_plugins::csp::{panel_policy, plugin_origin};
use tauri::http::{Request, Response, StatusCode, header};

use super::PluginsState;

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

/// `<plugin id>` and the package path of a request, or nothing.
fn target(uri: &tauri::http::Uri) -> Option<(String, String)> {
    let path = uri.path().strip_prefix('/')?;
    let (id, rest) = path.split_once('/')?;
    if id.is_empty() || rest.is_empty() || rest.contains('%') || rest.contains('\\') {
        return None;
    }
    Some((id.to_owned(), rest.to_owned()))
}

/// Answers one protocol request. Blocking (reads one file).
pub(crate) fn handle_request(
    plugins: &PluginsState,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if request.method() != tauri::http::Method::GET {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some((id, path)) = target(request.uri()) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Some(file) = plugins.panel_file(&id, &path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let mut response = Response::new(file.bytes);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(file.content_type),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("no-referrer"),
    );
    if file.html {
        if let Ok(policy) =
            header::HeaderValue::from_str(&panel_policy(plugin_origin(), &file.base))
        {
            headers.insert(header::CONTENT_SECURITY_POLICY, policy);
        } else {
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
    } else {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            header::HeaderValue::from_static("*"),
        );
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            header::HeaderValue::from_static(piui_plugins::csp::ASSET_POLICY),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::target;

    #[test]
    fn targets_are_plugin_id_and_package_path_only() {
        let uri = |text: &str| text.parse::<tauri::http::Uri>().expect("uri");
        assert_eq!(
            target(&uri(
                "http://piui-plugin.localhost/example.hello/ui/index.html?panel=hello"
            )),
            Some(("example.hello".into(), "ui/index.html".into()))
        );
        assert_eq!(
            target(&uri("piui-plugin://localhost/example.hello/ui/a.js")).map(|(_, path)| path),
            Some("ui/a.js".into())
        );
        for invalid in [
            "http://piui-plugin.localhost/",
            "http://piui-plugin.localhost/example.hello",
            "http://piui-plugin.localhost/example.hello/",
            "http://piui-plugin.localhost/example.hello/ui/%2e%2e/backend/main.mjs",
        ] {
            assert_eq!(target(&uri(invalid)), None, "{invalid}");
        }
    }
}
