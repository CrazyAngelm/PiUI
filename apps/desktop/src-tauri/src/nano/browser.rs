//! Opens a Nano page in the system browser (sign-in, billing, devices,
//! sign-up and links the cloud window hands over).
//!
//! The WebView never supplies a URL: every caller passes a URL the host
//! resolved itself. This module still refuses anything but `https` (and plain
//! `http` on a loopback host while a development issuer is in use), and it
//! never builds a shell string: Windows calls `ShellExecuteW`, macOS and Linux
//! start `open` / `xdg-open` with the URL as one argument.

use std::process::Child;
use std::time::{Duration, Instant};

use tauri::Url;

/// How long a launcher (`xdg-open`, `open`) may take to report that it
/// failed. One still running after that has handed the page to a browser that
/// stays open, and counts as started.
#[cfg_attr(windows, allow(dead_code))]
const LAUNCHER_WAIT: Duration = Duration::from_secs(3);

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

/// Whether `url` is an ordinary web address a person may be asked about:
/// `http` or `https`, a host, no user name or password. Unlike
/// [`is_openable`] it allows plain `http` on any host, so it is only for a
/// caller that shows the person the exact address and asks first (chat links,
/// ADR-075); Nano's own links keep the stricter rule above.
pub(crate) fn is_web_link(url: &Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| !host.is_empty())
        && matches!(url.scheme(), "https" | "http")
}

/// Opens a web address the host has already validated and the person has
/// confirmed. `Err(())` is `browser-failed`; an address that is not a web link
/// is never launched. On Linux and macOS the launcher's exit status is read,
/// so a missing handler is reported instead of looking like success: call it
/// off the UI thread (it can wait up to [`LAUNCHER_WAIT`]).
pub(crate) fn open_web_link(url: &Url) -> Result<(), ()> {
    if !is_web_link(url) {
        return Err(());
    }
    platform::open_checked(url.as_str())
}

/// Waits for a launcher to exit. A failing exit status is `Err`. A launcher
/// still running when `limit` passes is reaped in the background and counts
/// as started.
#[cfg_attr(windows, allow(dead_code))]
fn await_launcher(mut child: Child, limit: Duration) -> Result<(), ()> {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(()) },
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(_) => return Err(()),
        }
    }
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

    /// `ShellExecuteW` already reports failure synchronously.
    pub(super) fn open_checked(url: &str) -> Result<(), ()> {
        open(url)
    }
}

#[cfg(not(windows))]
mod platform {
    use std::process::{Child, Command, Stdio};

    fn launcher(url: &str) -> Result<Child, ()> {
        let program = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        Command::new(program)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ())
    }

    /// Starts the launcher and reads its exit status (see `open_web_link`).
    pub(super) fn open_checked(url: &str) -> Result<(), ()> {
        super::await_launcher(launcher(url)?, super::LAUNCHER_WAIT)
    }

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
    fn a_web_link_is_http_or_https_without_credentials() {
        assert!(is_web_link(&url("https://example.com/a?b=c#d")));
        assert!(is_web_link(&url("http://example.com/")));
        for refused in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,hi",
            "ms-settings:privacy",
            "ftp://example.com/",
            concat!("https://user", "@example.com/"),
            concat!("http://user:secret", "@example.com/"),
        ] {
            if let Ok(parsed) = Url::parse(refused) {
                assert!(!is_web_link(&parsed), "{refused}");
                assert_eq!(open_web_link(&parsed), Err(()), "{refused}");
            }
        }
    }

    /// A short-lived program that exits with `code`.
    fn exits_with(code: i32) -> Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", &format!("exit {code}")]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", &format!("exit {code}")]);
            command
        };
        command.spawn().expect("starts a test program")
    }

    #[test]
    fn a_launcher_that_fails_is_an_error_so_the_page_falls_back_to_copy() {
        assert_eq!(
            await_launcher(exits_with(0), Duration::from_secs(10)),
            Ok(())
        );
        assert_eq!(
            await_launcher(exits_with(3), Duration::from_secs(10)),
            Err(())
        );
    }

    #[test]
    fn a_launcher_still_running_after_the_wait_counts_as_started() {
        #[cfg(windows)]
        let child = std::process::Command::new("cmd")
            .args(["/C", "ping -n 3 127.0.0.1 > nul"])
            .spawn()
            .expect("starts a slow program");
        #[cfg(not(windows))]
        let child = std::process::Command::new("sh")
            .args(["-c", "sleep 2"])
            .spawn()
            .expect("starts a slow program");
        let started = Instant::now();
        assert_eq!(await_launcher(child, Duration::from_millis(100)), Ok(()));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_refused_url_is_never_launched() {
        assert_eq!(open_external(&url("file:///etc/passwd"), true), Err(()));
        assert_eq!(open_external(&url("http://example.com/"), false), Err(()));
    }
}
