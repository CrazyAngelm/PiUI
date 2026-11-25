//! Microphone access for dictation on Linux.
//!
//! WebKitGTK denies every `getUserMedia` request unless the application
//! answers its `permission-request` signal; WebView2 on Windows asks the person
//! itself. The main window grants a request only when it is for audio alone
//! and the page is the application's own; camera, screen and every other
//! permission keep WebKitGTK's default (denied). The microphone is opened only
//! when the person presses the dictation button.

/// Whether a page at `uri` is the application's own: the bundled `tauri://`
/// page, or the loopback dev server in a debug build.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn app_page(uri: &str) -> bool {
    let host_then_path = |prefix: &str| {
        uri.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '?', '#']))
    };
    let loopback_port = |prefix: &str| {
        uri.strip_prefix(prefix).is_some_and(|rest| {
            let port: String = rest.chars().take_while(char::is_ascii_digit).collect();
            !port.is_empty()
                && rest[port.len()..]
                    .chars()
                    .next()
                    .is_none_or(|next| "/?#".contains(next))
        })
    };
    host_then_path("tauri://localhost")
        || (cfg!(debug_assertions)
            && (loopback_port("http://localhost:") || loopback_port("http://127.0.0.1:")))
}

/// The decision for one request.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn grants(audio: bool, video: bool, uri: Option<&str>) -> bool {
    audio && !video && uri.is_some_and(app_page)
}

#[cfg(target_os = "linux")]
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use webkit2gtk::{
        PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt, glib::object::Cast,
    };
    let _ = window.with_webview(|platform| {
        let view = platform.inner();
        if let Some(settings) = view.settings() {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|view, request| {
            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                // Not ours to decide: WebKitGTK's default applies.
                return false;
            };
            let uri = view.uri();
            if grants(
                media.is_for_audio_device(),
                media.is_for_video_device(),
                uri.as_deref(),
            ) {
                request.allow();
            } else {
                request.deny();
            }
            true
        });
    });
}

#[cfg(not(target_os = "linux"))]
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window;
}

#[cfg(test)]
mod tests {
    use super::grants;

    #[test]
    fn only_the_microphone_of_the_app_page_is_granted() {
        assert!(grants(true, false, Some("tauri://localhost/")));
        assert!(!grants(true, true, Some("tauri://localhost/")));
        assert!(!grants(false, true, Some("tauri://localhost/")));
        assert!(!grants(true, false, Some("https://nanoagents.ru/")));
        assert!(!grants(
            true,
            false,
            Some("tauri://localhost.evil.example/")
        ));
        assert!(!grants(true, false, None));
        assert!(!grants(
            true,
            false,
            Some("http://localhost.evil.example:1/")
        ));
        assert_eq!(
            grants(true, false, Some("http://localhost:1420/")),
            cfg!(debug_assertions)
        );
    }
}
