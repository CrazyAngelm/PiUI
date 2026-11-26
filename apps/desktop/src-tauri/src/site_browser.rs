//! A local toolbar and separate, unprivileged site views (ADR-081).

use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, Runtime, State, Url, Webview, WebviewUrl, Window,
};
#[cfg(not(windows))]
use tauri::{LogicalPosition, LogicalSize, Rect, window::WindowBuilder};
use tokio::sync::Mutex;

use crate::chat_link::{self, ChatOpenLinkRequestV1};
use crate::nano::browser;
use crate::state::HostState;

#[cfg(windows)]
mod dock;

#[cfg(windows)]
const WINDOW: &str = "main";
#[cfg(not(windows))]
const WINDOW: &str = "site-browser";
const CHROME: &str = "site-browser-chrome";
const TAB_PREFIX: &str = "site-browser-tab-";
const ACTION: &str = "site_browser_action_v1";
const HIDE: &str = "site_browser_hide_v1";
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
    #[cfg(windows)]
    dock_open: AtomicBool,
}

#[derive(Default)]
struct Tabs {
    ids: Vec<u32>,
    active: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteBrowserOpenLinkRequestV1 {
    url: String,
    language: String,
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
            #[cfg(windows)]
            dock_open: AtomicBool::new(false),
        }
    }

    fn new_tab(&self, tabs: &mut Tabs) {
        tabs.push(self.next_id.fetch_add(1, Ordering::Relaxed));
    }
}

impl Tabs {
    fn push(&mut self, id: u32) {
        self.ids.push(id);
        self.active = Some(id);
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
        && (command == ACTION || (cfg!(windows) && command == HIDE))
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

fn chat_site_url(input: &str, dev_url: Option<&Url>) -> Result<Url, SiteBrowserError> {
    let url = chat_link::validate_link(input).map_err(|_| SiteBrowserError::InvalidAddress)?;
    site_url(&url, dev_url)
        .then_some(url)
        .ok_or(SiteBrowserError::InvalidAddress)
}

fn tab_label(tab: u32) -> String {
    format!("{TAB_PREFIX}{tab}")
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

#[cfg(not(windows))]
fn browser_bounds<R: Runtime>(window: &Window<R>, toolbar: bool) -> tauri::Result<Rect> {
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let (top, height) = if toolbar {
        (0.0, CHROME_HEIGHT)
    } else {
        (CHROME_HEIGHT, (size.height - CHROME_HEIGHT).max(0.0))
    };
    Ok(Rect {
        position: LogicalPosition::new(0.0, top).into(),
        size: LogicalSize::new(size.width, height).into(),
    })
}

#[cfg(windows)]
use dock::bounds as browser_bounds;

fn visibility<R: Runtime>(window: &Window<R>, active: Option<u32>) -> tauri::Result<()> {
    let selected = active.map(tab_label);
    let mut result = Ok(());
    for view in window.webviews() {
        if view.label().starts_with(TAB_PREFIX) && Some(view.label()) != selected.as_deref() {
            result = result.and(view.hide());
        }
    }
    if let Some(view) = selected
        .as_deref()
        .and_then(|label| window.get_webview(label))
    {
        result = result.and(view.show());
    }
    result
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
    let builder = builder
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI")
        .focused(false);
    let bounds = browser_bounds(window, false)?;
    let view = window.add_child(builder, bounds.position, bounds.size)?;
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
    open_browser(&app, &browser, &language, None).await
}

/// Opens a clicked chat link in the isolated browser. Only an unsupported OS
/// returns false so the caller can offer the existing confirmed external path.
#[tauri::command]
pub async fn site_browser_open_link_v1<R: Runtime>(
    app: AppHandle<R>,
    host: State<'_, HostState>,
    browser: State<'_, SiteBrowser>,
    request: SiteBrowserOpenLinkRequestV1,
) -> Result<bool, SiteBrowserError> {
    if host.safe_mode || host.is_shutting_down() {
        return Err(SiteBrowserError::Unavailable);
    }
    let url = chat_site_url(&request.url, app.config().build.dev_url.as_ref())?;
    if !SUPPORTED {
        return Ok(false);
    }
    open_browser(&app, &browser, &request.language, Some(url)).await?;
    Ok(true)
}

#[cfg(windows)]
async fn open_browser<R: Runtime>(
    app: &AppHandle<R>,
    browser: &SiteBrowser,
    _language: &str,
    link: Option<Url>,
) -> Result<(), SiteBrowserError> {
    let mut tabs = browser.tabs.lock().await;
    let window = app
        .get_window(WINDOW)
        .ok_or(SiteBrowserError::Unavailable)?;
    window.unminimize()?;
    window.set_focus()?;
    if window.get_webview(CHROME).is_none() {
        let chrome = add_toolbar(&window, browser)?;
        if let Err(error) = dock::configure(&chrome) {
            let _ = chrome.close();
            return Err(error.into());
        }
        *tabs = Tabs::default();
    }
    let was_open = browser.dock_open.load(Ordering::Acquire);
    // Reserve the right half before adding a visible child WebView.
    dock::set_open(&window, browser, tabs.active, true)?;
    if let Some(url) = link {
        if let Err(error) = open_link_tab(browser, &mut tabs, &window, url) {
            let _ = dock::set_open(&window, browser, tabs.active, was_open);
            return Err(error);
        }
    } else if tabs.active.is_none() {
        browser.new_tab(&mut tabs);
    }
    signal(app, CHANGED);
    Ok(())
}

#[cfg(not(windows))]
async fn open_browser<R: Runtime>(
    app: &AppHandle<R>,
    browser: &SiteBrowser,
    language: &str,
    link: Option<Url>,
) -> Result<(), SiteBrowserError> {
    let mut tabs = browser.tabs.lock().await;
    let existing = app
        .get_window(WINDOW)
        .filter(|window| window.get_webview(CHROME).is_some());
    if let Some(window) = existing {
        window.unminimize()?;
        window.set_focus()?;
        if let Some(url) = link {
            open_link_tab(browser, &mut tabs, &window, url)?;
            signal(app, CHANGED);
        }
        return Ok(());
    }

    let window = create_browser_window(app, browser, language)?;
    let mut initial = Tabs::default();
    let result = match link {
        Some(url) => open_link_tab(browser, &mut initial, &window, url),
        None => {
            browser.new_tab(&mut initial);
            Ok(())
        }
    };
    if let Err(error) = result.and_then(|()| window.show().map_err(Into::into)) {
        let _ = window.destroy();
        return Err(error);
    }
    *tabs = initial;
    signal(app, CHANGED);
    Ok(())
}

fn open_link_tab<R: Runtime>(
    browser: &SiteBrowser,
    tabs: &mut Tabs,
    window: &Window<R>,
    url: Url,
) -> Result<(), SiteBrowserError> {
    let profile = browser
        .profile
        .as_deref()
        .ok_or(SiteBrowserError::Unavailable)?;
    let id = browser.next_id.fetch_add(1, Ordering::Relaxed);
    if let Err(error) = create_site_view(window, profile, id, url)
        .and_then(|()| visibility(window, Some(id)).map_err(Into::into))
    {
        if let Some(view) = window.get_webview(&tab_label(id)) {
            let _ = view.close();
        }
        let _ = visibility(window, tabs.active);
        return Err(error);
    }
    tabs.push(id);
    Ok(())
}

#[cfg(not(windows))]
fn create_browser_window<R: Runtime>(
    app: &AppHandle<R>,
    browser: &SiteBrowser,
    language: &str,
) -> Result<Window<R>, SiteBrowserError> {
    let title = if language == "ru" {
        "Нано · Браузер"
    } else {
        "Nano · Browser"
    };
    let window = WindowBuilder::new(app, WINDOW)
        .title(title)
        .inner_size(1080.0, 740.0)
        .min_inner_size(460.0, 320.0)
        .visible(false)
        .build()?;
    let result = add_toolbar(&window, browser).and_then(|chrome| {
        #[cfg(target_os = "linux")]
        configure_layout(&chrome)?;
        let _ = chrome;
        Ok(())
    });
    if let Err(error) = result {
        let _ = window.destroy();
        return Err(error.into());
    }
    Ok(window)
}

fn add_toolbar<R: Runtime>(window: &Window<R>, browser: &SiteBrowser) -> tauri::Result<Webview<R>> {
    let dev_url = window.app_handle().config().build.dev_url.clone();
    let chrome = WebviewBuilder::new(CHROME, WebviewUrl::App(CHROME_FILE.into()))
        .devtools(false)
        .on_navigation(move |url| chrome_origin(url, dev_url.as_ref()))
        .on_new_window(|_, _| NewWindowResponse::Deny);
    let chrome = match &browser.chrome_profile {
        Some(directory) => chrome.data_directory(directory.clone()),
        None => chrome,
    };
    #[cfg(windows)]
    let chrome = chrome.focused(false);
    let bounds = browser_bounds(window, true)?;
    window.add_child(chrome, bounds.position, bounds.size)
}

#[tauri::command]
pub async fn site_browser_hide_v1<R: Runtime>(
    chrome: Webview<R>,
    host: State<'_, HostState>,
    browser: State<'_, SiteBrowser>,
) -> Result<(), SiteBrowserError> {
    if !allows_chrome_command(
        chrome.label(),
        chrome.url().ok().as_ref(),
        HIDE,
        chrome.app_handle().config().build.dev_url.as_ref(),
    ) || host.safe_mode
        || host.is_shutting_down()
    {
        return Err(SiteBrowserError::Unavailable);
    }
    #[cfg(windows)]
    {
        let tabs = browser.tabs.lock().await;
        dock::set_open(&chrome.window(), &browser, tabs.active, false)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = browser;
        Err(SiteBrowserError::Unavailable)
    }
}

#[tauri::command]
pub async fn site_browser_action_v1<R: Runtime>(
    chrome: Webview<R>,
    host: State<'_, HostState>,
    browser: State<'_, SiteBrowser>,
    request: SiteBrowserAction,
) -> Result<SiteBrowserSnapshot, SiteBrowserError> {
    let dev_url = chrome.app_handle().config().build.dev_url.as_ref();
    if !allows_chrome_command(chrome.label(), chrome.url().ok().as_ref(), ACTION, dev_url)
        || host.safe_mode
        || host.is_shutting_down()
    {
        return Err(SiteBrowserError::Unavailable);
    }
    let window = chrome.window();
    let mut tabs = browser.tabs.lock().await;
    #[cfg(windows)]
    if !matches!(&request, SiteBrowserAction::Read) && !browser.dock_open.load(Ordering::Acquire) {
        return Err(SiteBrowserError::Unavailable);
    }
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
    fn chat_link_keeps_both_url_boundaries() {
        let dev = Url::parse("http://localhost:1420").expect("dev server");
        assert_eq!(
            chat_site_url("http://127.0.0.1:8000/page?part=1#heading", Some(&dev))
                .expect("agent-served page")
                .as_str(),
            "http://127.0.0.1:8000/page?part=1#heading"
        );
        for input in [
            "example.org",
            " https://example.org/",
            "file:///C:/secret",
            "https://tauri.localhost./browser.html",
            "http://nested.piui-plugin.localhost/test",
            "https://asset.localhost/x",
            "http://ipc.localhost/",
        ] {
            assert_eq!(
                chat_site_url(input, Some(&dev)),
                Err(SiteBrowserError::InvalidAddress),
                "{input}"
            );
        }
        assert_eq!(
            chat_site_url("http://localhost:1420/index.html", Some(&dev)).is_err(),
            cfg!(debug_assertions)
        );
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
            Some(&local),
            "site_browser_open_link_v1",
            None
        ));
        assert!(!allows_chrome_command(
            "site-browser-tab-1",
            Some(&local),
            "site_browser_open_link_v1",
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

    #[test]
    fn only_the_local_windows_toolbar_can_hide_the_dock() {
        let local = Url::parse("http://tauri.localhost/browser.html").expect("toolbar");
        let remote = Url::parse("https://example.org/browser.html").expect("site");
        assert_eq!(
            allows_chrome_command(CHROME, Some(&local), HIDE, None),
            cfg!(windows)
        );
        for (label, url) in [
            ("main", &local),
            ("site-browser-tab-1", &local),
            (CHROME, &remote),
        ] {
            assert!(!allows_chrome_command(label, Some(url), HIDE, None));
        }
    }

    #[test]
    fn main_events_are_scoped_to_the_workbench_webview_not_its_window() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("main capability");
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(capability.get("windows").is_none());
    }
}
