//! A local toolbar and separate, unprivileged site views (ADR-081).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Runtime, State, Url,
    Webview, WebviewUrl, Window, window::WindowBuilder,
};
#[cfg(not(target_os = "linux"))]
use tauri::{Rect, WindowEvent};
use tokio::sync::Mutex;

use crate::chat_link::{self, ChatOpenLinkRequestV1};
use crate::nano::browser;
use crate::state::HostState;

const WINDOW: &str = "site-browser";
const CHROME: &str = "site-browser-chrome";
const CHROME_FILE: &str = "browser.html";
const CHANGED: &str = "piui://site-browser-changed-v1";
const POPUP_BLOCKED: &str = "piui://site-browser-popup-blocked-v1";
const DOWNLOAD_BLOCKED: &str = "piui://site-browser-download-blocked-v1";
// The two toolbar rows in SiteBrowser.svelte occupy 88 CSS pixels.
const CHROME_HEIGHT: f64 = 88.0;
const SUPPORTED: bool = cfg!(any(windows, target_os = "linux"));

pub struct SiteBrowser {
    profile: Option<PathBuf>,
    chrome_profile: Option<PathBuf>,
    next_id: AtomicU32,
    tabs: Mutex<Tabs>,
}

#[derive(Default)]
struct Tabs {
    ids: Vec<u32>,
    active: Option<u32>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SiteBrowserAction {
    Read,
    New,
    Select { tab: u32 },
    Close { tab: u32 },
    Navigate { tab: u32, address: String },
    Back { tab: u32 },
    Forward { tab: u32 },
    Reload { tab: u32 },
    External { tab: u32, language: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteBrowserSnapshot {
    tabs: Vec<TabSnapshot>,
    active: Option<u32>,
}

#[derive(Serialize)]
struct TabSnapshot {
    id: u32,
    url: Option<String>,
    host: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SiteBrowserError {
    Unavailable,
    InvalidAddress,
    MissingTab,
    OperationFailed,
}

impl From<tauri::Error> for SiteBrowserError {
    fn from(_: tauri::Error) -> Self {
        Self::OperationFailed
    }
}

impl SiteBrowser {
    pub(crate) fn new(profile_root: Option<PathBuf>, chrome_profile: Option<PathBuf>) -> Self {
        Self {
            // WebView2 passes this directory to its child processes.
            profile: profile_root.map(|root| {
                piui_runtime::script_runner::process_directory(&root.join("browser-profile"))
            }),
            chrome_profile,
            next_id: AtomicU32::new(1),
            tabs: Mutex::new(Tabs::default()),
        }
    }

    fn new_tab(&self, tabs: &mut Tabs) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        tabs.ids.push(id);
        tabs.active = Some(id);
    }
}

fn same_dev_origin(url: &Url, dev_url: Option<&Url>) -> bool {
    cfg!(debug_assertions) && dev_url.is_some_and(|dev| url.origin() == dev.origin())
}

fn internal_host(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        let host = host.trim_end_matches('.');
        host == "tauri.localhost"
            || host.ends_with(".tauri.localhost")
            || host == "piui-plugin.localhost"
            || host.ends_with(".piui-plugin.localhost")
            || host == "asset.localhost"
            || host == "ipc.localhost"
    }) || crate::navigation_guard::is_plugin_url(url)
}

fn chrome_origin(url: &Url, dev_url: Option<&Url>) -> bool {
    url.path() == "/browser.html"
        && match (url.scheme(), url.host_str()) {
            ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")) => {
                url.port().is_none() && url.username().is_empty() && url.password().is_none()
            }
            _ => same_dev_origin(url, dev_url),
        }
}

pub(crate) fn allows_chrome_command(
    label: &str,
    url: Option<&Url>,
    command: &str,
    dev_url: Option<&Url>,
) -> bool {
    label == CHROME
        && command == "site_browser_action_v1"
        && url.is_some_and(|url| chrome_origin(url, dev_url))
}

fn site_url(url: &Url, dev_url: Option<&Url>) -> bool {
    browser::is_web_link(url) && !internal_host(url) && !same_dev_origin(url, dev_url)
}

fn site_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
    url.as_str() == "about:blank" || site_url(url, dev_url)
}

fn address(input: &str, dev_url: Option<&Url>) -> Result<Url, SiteBrowserError> {
    let input = input.trim();
    if input.is_empty()
        || input
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(SiteBrowserError::InvalidAddress);
    }
    let has_scheme = input.split_once("://").is_some_and(|(scheme, _)| {
        scheme.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
    });
    let url = if has_scheme {
        Url::parse(input)
    } else {
        Url::parse(&format!("https://{input}"))
    }
    .map_err(|_| SiteBrowserError::InvalidAddress)?;
    site_url(&url, dev_url)
        .then_some(url)
        .ok_or(SiteBrowserError::InvalidAddress)
}

fn tab_label(tab: u32) -> String {
    format!("site-browser-tab-{tab}")
}

fn signal<R: Runtime>(app: &AppHandle<R>, name: &str) {
    let _ = app.emit_to(EventTarget::webview(CHROME), name, ());
}

fn watch_address<R: Runtime>(view: &Webview<R>) -> tauri::Result<()> {
    let app = view.app_handle().clone();
    view.with_webview(move |platform| {
        #[cfg(windows)]
        {
            use webview2_com::SourceChangedEventHandler;
            // The controller and its event sink are only accessed on the UI thread.
            unsafe {
                if let Ok(core) = platform.controller().CoreWebView2() {
                    let handler = SourceChangedEventHandler::create(Box::new(move |_, _| {
                        signal(&app, CHANGED);
                        Ok(())
                    }));
                    let _ = core.add_SourceChanged(&handler, &mut 0);
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::WebViewExt;
            platform
                .inner()
                .connect_uri_notify(move |_| signal(&app, CHANGED));
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        let _ = (platform, app);
    })
}

fn move_history<R: Runtime>(view: &Webview<R>, forward: bool) -> tauri::Result<()> {
    view.with_webview(move |platform| {
        #[cfg(windows)]
        // The dispatcher runs this call on the controller's UI thread.
        unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                let _ = if forward {
                    core.GoForward()
                } else {
                    core.GoBack()
                };
            }
        }
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::WebViewExt;
            if forward {
                platform.inner().go_forward();
            } else {
                platform.inner().go_back();
            }
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        let _ = (platform, forward);
    })
}

#[cfg(not(target_os = "linux"))]
fn configure_layout<R: Runtime>(chrome: &Webview<R>) -> tauri::Result<()> {
    let window = chrome.window();
    apply_layout(&window)?;
    let resized = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            let _ = apply_layout(&resized);
        }
    });
    Ok(())
}

#[cfg(target_os = "linux")]
fn configure_layout<R: Runtime>(chrome: &Webview<R>) -> tauri::Result<()> {
    chrome.with_webview(|platform| {
        use gtk::prelude::*;
        let toolbar = platform.inner();
        toolbar.set_height_request(CHROME_HEIGHT as i32);
        // Wry packs each WebView into Tauri's GtkBox with expand=true by default.
        if let Some(parent) = toolbar
            .parent()
            .and_then(|parent| parent.downcast::<gtk::Box>().ok())
        {
            parent.set_child_packing(&toolbar, false, false, 0, gtk::PackType::Start);
        }
    })
}

#[cfg(not(target_os = "linux"))]
fn apply_layout<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    for view in window.webviews() {
        let (top, height) = if view.label() == CHROME {
            (0.0, CHROME_HEIGHT)
        } else {
            (CHROME_HEIGHT, (size.height - CHROME_HEIGHT).max(0.0))
        };
        view.set_bounds(Rect {
            position: LogicalPosition::new(0.0, top).into(),
            size: LogicalSize::new(size.width, height).into(),
        })?;
    }
    Ok(())
}

fn visibility<R: Runtime>(window: &Window<R>, active: Option<u32>) -> tauri::Result<()> {
    let selected = active.map(tab_label);
    for view in window.webviews() {
        if view.label() != CHROME && Some(view.label()) != selected.as_deref() {
            view.hide()?;
        }
    }
    if let Some(view) = selected
        .as_deref()
        .and_then(|label| window.get_webview(label))
    {
        view.show()?;
    }
    Ok(())
}

fn create_site_view<R: Runtime>(
    window: &Window<R>,
    profile: &Path,
    tab: u32,
    url: Url,
) -> Result<(), SiteBrowserError> {
    let mut directories = std::fs::DirBuilder::new();
    directories.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directories.mode(0o700);
    }
    directories
        .create(profile)
        .map_err(|_| SiteBrowserError::OperationFailed)?;
    let dev_url = window.app_handle().config().build.dev_url.clone();
    let popup_app = window.app_handle().clone();
    let download_app = popup_app.clone();
    let builder = WebviewBuilder::new(tab_label(tab), WebviewUrl::External(url))
        .data_directory(profile.to_owned())
        .devtools(false)
        .on_navigation(move |url| site_navigation(url, dev_url.as_ref()))
        .on_new_window(move |_, _| {
            signal(&popup_app, POPUP_BLOCKED);
            NewWindowResponse::Deny
        })
        .on_page_load(|view, event| {
            if event.event() == tauri::webview::PageLoadEvent::Finished {
                signal(view.app_handle(), CHANGED);
            }
        })
        .on_download(move |_, event| {
            if matches!(event, tauri::webview::DownloadEvent::Requested { .. }) {
                signal(&download_app, DOWNLOAD_BLOCKED);
            }
            false
        });
    #[cfg(windows)]
    // Wry disables SmartScreen by default. Keep it enabled on arbitrary sites.
    let builder = builder.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI");
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let view = window.add_child(
        builder,
        LogicalPosition::new(0.0, CHROME_HEIGHT),
        LogicalSize::new(size.width, (size.height - CHROME_HEIGHT).max(0.0)),
    )?;
    watch_address(&view)?;
    Ok(())
}

#[tauri::command]
pub async fn site_browser_open_v1<R: Runtime>(
    app: AppHandle<R>,
    host: State<'_, HostState>,
    browser: State<'_, SiteBrowser>,
    language: String,
) -> Result<(), SiteBrowserError> {
    if !SUPPORTED || host.safe_mode || host.is_shutting_down() {
        return Err(SiteBrowserError::Unavailable);
    }
    let mut tabs = browser.tabs.lock().await;
    if let Some(window) = app.get_window(WINDOW) {
        window.unminimize()?;
        window.set_focus()?;
        return Ok(());
    }
    *tabs = Tabs::default();
    browser.new_tab(&mut tabs);
    let title = if language == "ru" {
        "Нано · Браузер"
    } else {
        "Nano · Browser"
    };
    let window = WindowBuilder::new(&app, WINDOW)
        .title(title)
        .inner_size(1080.0, 740.0)
        .min_inner_size(460.0, 320.0)
        .visible(false)
        .build()?;
    let dev_url = app.config().build.dev_url.clone();
    let chrome = WebviewBuilder::new(CHROME, WebviewUrl::App(CHROME_FILE.into()))
        .devtools(false)
        .on_navigation(move |url| chrome_origin(url, dev_url.as_ref()))
        .on_new_window(|_, _| NewWindowResponse::Deny);
    let chrome = match &browser.chrome_profile {
        Some(directory) => chrome.data_directory(directory.clone()),
        None => chrome,
    };
    let result = window
        .inner_size()
        .and_then(|size| Ok(size.to_logical::<f64>(window.scale_factor()?)))
        .and_then(|size| {
            window.add_child(
                chrome,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(size.width, CHROME_HEIGHT),
            )
        });
    if let Err(error) = result.and_then(|chrome| configure_layout(&chrome)) {
        let _ = window.destroy();
        return Err(error.into());
    }
    window.show()?;
    Ok(())
}

#[tauri::command]
pub async fn site_browser_action_v1<R: Runtime>(
    chrome: Webview<R>,
    host: State<'_, HostState>,
    browser: State<'_, SiteBrowser>,
    request: SiteBrowserAction,
) -> Result<SiteBrowserSnapshot, SiteBrowserError> {
    let dev_url = chrome.app_handle().config().build.dev_url.as_ref();
    if !allows_chrome_command(
        chrome.label(),
        chrome.url().ok().as_ref(),
        "site_browser_action_v1",
        dev_url,
    ) || host.safe_mode
        || host.is_shutting_down()
    {
        return Err(SiteBrowserError::Unavailable);
    }
    let window = chrome.window();
    let mut tabs = browser.tabs.lock().await;
    let get_view = |tab| {
        window
            .get_webview(&tab_label(tab))
            .ok_or(SiteBrowserError::MissingTab)
    };
    let mut external = None;
    match request {
        SiteBrowserAction::Read => {}
        SiteBrowserAction::New => {
            browser.new_tab(&mut tabs);
            visibility(&window, tabs.active)?;
        }
        SiteBrowserAction::Select { tab } => {
            if !tabs.ids.contains(&tab) {
                return Err(SiteBrowserError::MissingTab);
            }
            visibility(&window, Some(tab))?;
            tabs.active = Some(tab);
        }
        SiteBrowserAction::Close { tab } => {
            let position = tabs
                .ids
                .iter()
                .position(|&id| id == tab)
                .ok_or(SiteBrowserError::MissingTab)?;
            if let Ok(view) = get_view(tab) {
                view.close()?;
            }
            tabs.ids.remove(position);
            if tabs.active == Some(tab) {
                tabs.active = tabs.ids.get(position).or_else(|| tabs.ids.last()).copied();
                if tabs.active.is_none() {
                    browser.new_tab(&mut tabs);
                }
                visibility(&window, tabs.active)?;
            }
        }
        SiteBrowserAction::Navigate {
            tab,
            address: input,
        } => {
            if tabs.active != Some(tab) {
                return Err(SiteBrowserError::MissingTab);
            }
            let url = address(&input, dev_url)?;
            match get_view(tab) {
                Ok(view) => view.navigate(url)?,
                Err(_) => create_site_view(
                    &window,
                    browser
                        .profile
                        .as_deref()
                        .ok_or(SiteBrowserError::Unavailable)?,
                    tab,
                    url,
                )?,
            }
        }
        SiteBrowserAction::Back { tab } => move_history(&get_view(tab)?, false)?,
        SiteBrowserAction::Forward { tab } => move_history(&get_view(tab)?, true)?,
        SiteBrowserAction::Reload { tab } => get_view(tab)?.reload()?,
        SiteBrowserAction::External { tab, language } => {
            let url = get_view(tab)?.url()?;
            if !site_url(&url, dev_url) {
                return Err(SiteBrowserError::InvalidAddress);
            }
            external = Some(ChatOpenLinkRequestV1::for_browser(url, language));
        }
    }
    let snapshot = SiteBrowserSnapshot {
        tabs: tabs
            .ids
            .iter()
            .map(|&id| {
                let url = get_view(id)
                    .ok()
                    .and_then(|view| view.url().ok())
                    .filter(|url| site_url(url, dev_url));
                TabSnapshot {
                    id,
                    host: url
                        .as_ref()
                        .and_then(|url| url.host_str().map(str::to_owned)),
                    url: url.map(Into::into),
                }
            })
            .collect(),
        active: tabs.active,
    };
    drop(tabs);
    if let Some(request) = external {
        chat_link::open_confirmed(chrome.app_handle().clone(), WINDOW, host.safe_mode, request)
            .await
            .map_err(|_| SiteBrowserError::OperationFailed)?;
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entered_address_only_accepts_web_locations() {
        assert_eq!(
            address(" example.org/docs ", None)
                .expect("domain")
                .as_str(),
            "https://example.org/docs"
        );
        assert!(address("http://127.0.0.1:8000/page", None).is_ok());
        assert_eq!(
            address("example.org/r?u=https://example.net", None)
                .expect("address with URL in query")
                .as_str(),
            "https://example.org/r?u=https://example.net"
        );
        for input in [
            "",
            "file:///C:/secret",
            "javascript:alert(1)",
            "https://user:pass@example.org",
            "https://tauri.localhost./browser.html",
            "http://piui-plugin.localhost/test",
            "https://example.org/a b",
        ] {
            assert_eq!(
                address(input, None),
                Err(SiteBrowserError::InvalidAddress),
                "{input}"
            );
        }
    }

    #[test]
    fn toolbar_can_only_use_its_own_action_at_its_own_origin() {
        let local = Url::parse("http://tauri.localhost/browser.html").expect("app");
        let remote = Url::parse("https://example.org/browser.html").expect("site");
        assert!(allows_chrome_command(
            CHROME,
            Some(&local),
            "site_browser_action_v1",
            None
        ));
        assert!(!allows_chrome_command(
            CHROME,
            Some(&local),
            "site_browser_open_v1",
            None
        ));
        assert!(!allows_chrome_command(
            CHROME,
            Some(&remote),
            "site_browser_action_v1",
            None
        ));
        assert!(!allows_chrome_command(
            "site-browser-tab-1",
            Some(&local),
            "site_browser_action_v1",
            None
        ));
        assert!(!allows_chrome_command(
            CHROME,
            None,
            "site_browser_action_v1",
            None
        ));
    }
}
