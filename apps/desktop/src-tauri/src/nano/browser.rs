//! Opens a Nano page in the system browser (sign-in, billing, devices,
//! sign-up and links the cloud window hands over).
//!
//! The WebView never supplies a URL: every caller passes a URL the host
//! resolved itself. This module still refuses anything but `https` (and plain
//! `http` on a loopback host while a development issuer is in use), and it
//! never builds a shell string: Windows calls `ShellExecuteW`, macOS and Linux
//! start `open` / `xdg-open` with the URL as one argument.

use tauri::Url;

/// Whether `url` may be handed to the system browser.
pub(crate) fn is_openable(url: &Url, allow_loopback_http: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str().filter(|host| !host.is_empty()) else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => allow_loopback_http && is_loopback_host(host),
        _ => false,
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// Opens `url` in the system browser. `Err(())` is `browser-failed`.
pub(crate) fn open_external(url: &Url, allow_loopback_http: bool) -> Result<(), ()> {
    if !is_openable(url, allow_loopback_http) {
        return Err(());
    }
    platform::open(url.as_str())
}

#[cfg(windows)]
mod platform {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt as _;

    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    pub(super) fn open(url: &str) -> Result<(), ()> {
        let verb: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = OsStr::new(url).encode_wide().chain(Some(0)).collect();
        if target[..target.len() - 1].contains(&0) {
            return Err(());
        }
        // SAFETY: `verb` and `target` are NUL-terminated UTF-16 buffers that
        // outlive the call; the remaining pointer arguments are documented as
        // optional and are null. The call does not retain any pointer.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // `ShellExecuteW` returns a value greater than 32 on success.
        if (result as usize) > 32 {
            Ok(())
        } else {
            Err(())
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::process::{Command, Stdio};

    pub(super) fn open(url: &str) -> Result<(), ()> {
        let program = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        let mut child = Command::new(program)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ())?;
        // Reap the launcher without blocking the caller.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).expect("url")
    }

    #[test]
    fn only_https_and_development_loopback_http_are_openable() {
        assert!(is_openable(&url("https://nanoagents.ru/billing"), false));
        assert!(is_openable(&url("https://hermes.nanoagents.ru/"), true));
        assert!(!is_openable(&url("http://nanoagents.ru/"), false));
        assert!(!is_openable(&url("http://nanoagents.ru/"), true));
        assert!(!is_openable(&url("http://127.0.0.1:8787/signup"), false));
        assert!(is_openable(&url("http://127.0.0.1:8787/signup"), true));
        assert!(is_openable(&url("http://localhost:8787/signup"), true));
        assert!(is_openable(&url("http://[::1]:8787/signup"), true));
        for refused in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "data:text/html,hi",
            "ftp://nanoagents.ru/",
            concat!("https://user:secret", "@nanoagents.ru/"),
        ] {
            if let Ok(parsed) = Url::parse(refused) {
                assert!(!is_openable(&parsed, true), "{refused}");
            }
        }
    }

    #[test]
    fn a_refused_url_is_never_launched() {
        assert_eq!(open_external(&url("file:///etc/passwd"), true), Err(()));
        assert_eq!(open_external(&url("http://example.com/"), false), Err(()));
    }
}
