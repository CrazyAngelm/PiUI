//! Chat links v1 (`chat_open_link_v1`, see `contracts/chat-link-v1.ts`,
//! ADR-075): opens an `http` or `https` link from a chat message in the system
//! browser.
//!
//! The WebView supplies the address, so it never decides alone. The host
//! parses it again, accepts only `http` and `https` with a host and no user
//! name or password (at most 2048 bytes, no whitespace or control character),
//! refuses safe mode, then asks the person in a native dialog that shows the
//! exact address the browser would receive. Only a Yes opens it, through the
//! same launcher Nano's own links use (`nano::browser`, which never builds a
//! shell string). One dialog is open at a time, so a page cannot stack them.
//! The address is never logged.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State, Url};

use crate::nano::browser;
use crate::state::HostState;

/// Longest address the host accepts, in bytes.
pub(crate) const MAX_LINK_BYTES: usize = 2048;
const MAIN_WINDOW: &str = "main";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatOpenLinkRequestV1 {
    url: String,
    /// Language of the question (`ru`; anything else is English). Only picks
    /// the wording of the dialog.
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOpenLinkResultV1 {
    /// `false` when the person answered No.
    opened: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChatLinkError {
    /// Not an openable web address.
    InvalidLink,
    SafeMode,
    /// A confirmation is already on screen.
    Busy,
    /// The person said Yes and the system browser could not be started.
    OpenFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wording {
    English,
    Russian,
}

impl Wording {
    fn from_hint(hint: Option<&str>) -> Self {
        match hint {
            Some("ru") => Self::Russian,
            _ => Self::English,
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::English => "Open link",
            Self::Russian => "Открыть ссылку",
        }
    }

    fn question(self) -> &'static str {
        match self {
            Self::English => "Open this link in your browser?",
            Self::Russian => "Открыть эту ссылку в браузере?",
        }
    }
}

/// The address the browser would receive, or why it is refused. The text shown
/// to the person is [`Url::as_str`] of the result (an international host name
/// appears in its ASCII form), never the raw request text.
pub(crate) fn validate_link(raw: &str) -> Result<Url, ChatLinkError> {
    if raw.is_empty()
        || raw.len() > MAX_LINK_BYTES
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(ChatLinkError::InvalidLink);
    }
    let url = Url::parse(raw).map_err(|_| ChatLinkError::InvalidLink)?;
    if url.as_str().len() > MAX_LINK_BYTES || !browser::is_web_link(&url) {
        return Err(ChatLinkError::InvalidLink);
    }
    Ok(url)
}

/// Holds the single confirmation slot until dropped.
struct DialogTurn<'a>(&'a AtomicBool);

impl<'a> DialogTurn<'a> {
    fn acquire(slot: &'a AtomicBool) -> Option<Self> {
        slot.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(slot))
    }
}

impl Drop for DialogTurn<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

/// Validation, the single dialog slot, the question and the launch, with the
/// dialog and the launcher injected so the order of the checks is testable.
async fn open_after_confirmation<Confirm, Pending, Open, Opening>(
    safe_mode: bool,
    slot: &AtomicBool,
    request: ChatOpenLinkRequestV1,
    confirm: Confirm,
    open: Open,
) -> Result<ChatOpenLinkResultV1, ChatLinkError>
where
    Confirm: FnOnce(Wording, String) -> Pending,
    Pending: Future<Output = bool>,
    Open: FnOnce(Url) -> Opening,
    Opening: Future<Output = Result<(), ()>>,
{
    if safe_mode {
        return Err(ChatLinkError::SafeMode);
    }
    let url = validate_link(&request.url)?;
    let wording = Wording::from_hint(request.language.as_deref());
    let Some(_turn) = DialogTurn::acquire(slot) else {
        return Err(ChatLinkError::Busy);
    };
    let text = format!("{}\n\n{}", wording.question(), url.as_str());
    if !confirm(wording, text).await {
        return Ok(ChatOpenLinkResultV1 { opened: false });
    }
    // A launcher that fails is `OPEN_FAILED`, not `opened: false` (which is a No):
    // the page then copies the address instead.
    open(url).await.map_err(|()| ChatLinkError::OpenFailed)?;
    Ok(ChatOpenLinkResultV1 { opened: true })
}

async fn native_confirm<R: Runtime>(app: &AppHandle<R>, wording: Wording, text: String) -> bool {
    let dialog = rfd::AsyncMessageDialog::new()
        .set_level(rfd::MessageLevel::Info)
        .set_title(wording.title())
        .set_description(text)
        .set_buttons(rfd::MessageButtons::YesNo);
    #[cfg(windows)]
    let dialog = match tauri::Manager::get_webview_window(app, MAIN_WINDOW) {
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    };
    #[cfg(not(windows))]
    let _ = (app, MAIN_WINDOW);
    matches!(dialog.show().await, rfd::MessageDialogResult::Yes)
}

/// Asks the person, in a native dialog, whether to open a link from a chat
/// message, and opens it only on Yes.
#[tauri::command]
pub async fn chat_open_link_v1<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HostState>,
    request: ChatOpenLinkRequestV1,
) -> Result<ChatOpenLinkResultV1, ChatLinkError> {
    open_after_confirmation(
        state.safe_mode,
        &DIALOG_OPEN,
        request,
        |wording, text| {
            let app = app.clone();
            async move { native_confirm(&app, wording, text).await }
        },
        // The launcher's exit status is read on the blocking pool, not on a
        // runtime worker or the UI thread.
        |url| async move {
            tauri::async_runtime::spawn_blocking(move || browser::open_web_link(&url))
                .await
                .unwrap_or(Err(()))
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    fn request(url: &str) -> ChatOpenLinkRequestV1 {
        ChatOpenLinkRequestV1 {
            url: url.to_owned(),
            language: None,
        }
    }

    #[test]
    fn only_http_and_https_without_credentials_are_accepted() {
        for accepted in [
            "https://example.com/",
            "https://example.com/a/b?c=d#e",
            "http://example.com:8080/path",
            "https://[::1]:8443/",
            // A page an agent serves on this computer opens like any other link.
            "http://127.0.0.1:8765/FISCAL_RECEIPTS_MAP.html",
            "http://localhost:3000/",
        ] {
            assert!(validate_link(accepted).is_ok(), "{accepted}");
        }
        for refused in [
            "",
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<script>alert(1)</script>",
            "mailto:someone@example.com",
            "ms-settings:privacy",
            "ftp://example.com/file",
            "vscode://file/C:/secret",
            "/relative/path",
            "example.com",
            "https://",
            concat!("https://user", "@example.com/"),
            concat!("https://user:secret", "@example.com/"),
            concat!("http://:secret", "@example.com/"),
            "https://example.com/a b",
            "https://example.com/\u{0007}",
            "https://example.com/\r\nHost: evil",
            " https://example.com/",
        ] {
            assert_eq!(
                validate_link(refused),
                Err(ChatLinkError::InvalidLink),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn a_link_over_the_length_limit_is_refused() {
        let prefix = "https://example.com/";
        let longest = format!("{prefix}{}", "a".repeat(MAX_LINK_BYTES - prefix.len()));
        assert_eq!(longest.len(), MAX_LINK_BYTES);
        assert!(validate_link(&longest).is_ok());
        let too_long = format!("{longest}a");
        assert_eq!(validate_link(&too_long), Err(ChatLinkError::InvalidLink));
    }

    #[test]
    fn an_international_host_is_accepted_and_shown_in_ascii() {
        let url = validate_link("https://пример.рф/путь").expect("idn link");
        assert_eq!(url.scheme(), "https");
        assert!(url.host_str().is_some_and(|host| host.starts_with("xn--")));
        assert!(url.as_str().is_ascii());
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    #[test]
    fn a_yes_opens_the_exact_address_that_was_shown() {
        let slot = AtomicBool::new(false);
        let shown = RefCell::new(String::new());
        let opened = RefCell::new(String::new());
        let mut asked = request("https://Example.com/a?b=c");
        asked.language = Some("ru".to_owned());
        let result = block_on(open_after_confirmation(
            false,
            &slot,
            asked,
            |wording, text| {
                assert_eq!(wording, Wording::Russian);
                *shown.borrow_mut() = text;
                async { true }
            },
            |url| {
                *opened.borrow_mut() = url.as_str().to_owned();
                async { Ok(()) }
            },
        ));
        assert_eq!(result, Ok(ChatOpenLinkResultV1 { opened: true }));
        assert_eq!(opened.borrow().as_str(), "https://example.com/a?b=c");
        assert_eq!(
            shown.borrow().as_str(),
            "Открыть эту ссылку в браузере?\n\nhttps://example.com/a?b=c"
        );
        assert!(!slot.load(Ordering::Acquire), "the slot is released");
    }

    #[test]
    fn a_no_opens_nothing() {
        let slot = AtomicBool::new(false);
        let launched = Cell::new(false);
        let result = block_on(open_after_confirmation(
            false,
            &slot,
            request("https://example.com/"),
            |wording, text| {
                assert_eq!(wording, Wording::English);
                assert!(text.starts_with("Open this link in your browser?\n\n"));
                async { false }
            },
            |_| {
                launched.set(true);
                async { Ok(()) }
            },
        ));
        assert_eq!(result, Ok(ChatOpenLinkResultV1 { opened: false }));
        assert!(!launched.get());
        assert!(!slot.load(Ordering::Acquire));
    }

    #[test]
    fn safe_mode_and_invalid_links_are_refused_before_any_dialog() {
        let slot = AtomicBool::new(false);
        let asked = Cell::new(false);
        for (safe_mode, url, expected) in [
            (true, "https://example.com/", ChatLinkError::SafeMode),
            (false, "javascript:alert(1)", ChatLinkError::InvalidLink),
        ] {
            let result = block_on(open_after_confirmation(
                safe_mode,
                &slot,
                request(url),
                |_, _| {
                    asked.set(true);
                    async { true }
                },
                |_| async { Ok(()) },
            ));
            assert_eq!(result, Err(expected));
        }
        assert!(!asked.get());
    }

    #[test]
    fn a_second_request_while_a_dialog_is_open_is_refused() {
        let slot = AtomicBool::new(false);
        let _held = DialogTurn::acquire(&slot).expect("first dialog");
        let asked = Cell::new(false);
        let result = block_on(open_after_confirmation(
            false,
            &slot,
            request("https://example.com/"),
            |_, _| {
                asked.set(true);
                async { true }
            },
            |_| async { Ok(()) },
        ));
        assert_eq!(result, Err(ChatLinkError::Busy));
        assert!(!asked.get());
        assert!(slot.load(Ordering::Acquire), "the open dialog keeps its slot");
    }

    #[test]
    fn a_launcher_failure_is_reported_and_releases_the_slot() {
        let slot = AtomicBool::new(false);
        let result = block_on(open_after_confirmation(
            false,
            &slot,
            request("https://example.com/"),
            |_, _| async { true },
            |_| async { Err(()) },
        ));
        assert_eq!(result, Err(ChatLinkError::OpenFailed));
        assert!(!slot.load(Ordering::Acquire));
    }

    #[test]
    fn requests_with_unknown_fields_and_errors_keep_their_wire_shape() {
        let accepted: ChatOpenLinkRequestV1 =
            serde_json::from_str(r#"{"url":"https://example.com/","language":"ru"}"#)
                .expect("request");
        assert_eq!(accepted.language.as_deref(), Some("ru"));
        assert!(
            serde_json::from_str::<ChatOpenLinkRequestV1>(
                r#"{"url":"https://example.com/","path":"C:/x"}"#
            )
            .is_err()
        );
        assert_eq!(
            serde_json::to_string(&ChatLinkError::InvalidLink).expect("json"),
            r#"{"code":"INVALID_LINK"}"#
        );
        assert_eq!(
            serde_json::to_string(&ChatOpenLinkResultV1 { opened: false }).expect("json"),
            r#"{"opened":false}"#
        );
    }
}
