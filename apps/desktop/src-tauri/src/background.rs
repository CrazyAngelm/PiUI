//! Background mode (contract `background-v1`): a tray icon, "keep running in
//! the tray when the window is closed" and "start PiUI when I sign in".
//!
//! Both are off until a person turns them on in Settings. The WebView gets no
//! tray, autostart-plugin or OS permission: it calls three host commands and
//! the host applies the change. Sign-in registration is the OS's record
//! (through `tauri-plugin-autostart`); only "keep in tray" is a PiUI
//! preference. Safe mode never shows a tray and keeps these settings
//! read-only. Quit from the tray takes the ordinary exit path, which stops
//! every harness process before the app ends.

use crate::orchestration_api::{OrchestrationApiState, apply_automations_paused};
use crate::state::HostState;
use piui_index::BackgroundPreferences;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};

/// Passed by the sign-in registration so a start at sign-in can stay in the
/// tray instead of opening the window.
pub(crate) const AUTOSTART_ARG: &str = "--autostart";
const TRAY_ID: &str = "piui-background";
const MAIN_WINDOW: &str = "main";
const MENU_OPEN: &str = "piui-open";
const MENU_PAUSE: &str = "piui-pause";
const MENU_QUIT: &str = "piui-quit";
const MAX_LABEL_CHARS: usize = 80;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundSettingsV1 {
    pub protocol: u8,
    pub keep_in_tray: bool,
    pub launch_at_login: bool,
    pub tray_available: bool,
    pub launch_at_login_available: bool,
    /// Safe mode: shown, but not changeable.
    pub read_only: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundSettingsRequest {}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundUpdateRequest {
    #[serde(default)]
    pub keep_in_tray: Option<bool>,
    #[serde(default)]
    pub launch_at_login: Option<bool>,
}

/// Tray menu copy from the UI's locale catalog (English until it arrives).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayLabels {
    pub open: String,
    pub pause: String,
    pub resume: String,
    pub quit: String,
    pub tooltip: String,
    pub paused_tooltip: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open PiUI".to_owned(),
            pause: "Pause all automations".to_owned(),
            resume: "Resume automations".to_owned(),
            quit: "Quit PiUI".to_owned(),
            tooltip: "PiUI".to_owned(),
            paused_tooltip: "PiUI (automations paused)".to_owned(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundError {
    pub code: &'static str,
}

impl BackgroundError {
    fn invalid() -> Self {
        Self { code: "invalid" }
    }
    fn read_only() -> Self {
        Self { code: "read-only" }
    }
    fn unavailable() -> Self {
        Self {
            code: "unavailable",
        }
    }
    fn io() -> Self {
        Self { code: "io" }
    }
}

/// The OS sign-in registration.
pub(crate) trait AutostartBackend {
    fn is_enabled(&self) -> Result<bool, BackgroundError>;
    fn set_enabled(&self, enabled: bool) -> Result<(), BackgroundError>;
}

/// Where "keep in tray" is remembered.
pub(crate) trait PreferenceStore {
    fn load(&self) -> Result<BackgroundPreferences, BackgroundError>;
    fn save(&self, value: BackgroundPreferences) -> Result<(), BackgroundError>;
}

/// Showing and removing the tray icon.
pub(crate) trait TrayControl {
    fn show(&self) -> Result<(), BackgroundError>;
    fn remove(&self);
}

/// Setting rules, independent of Tauri and the OS so tests use fakes and
/// never touch a real sign-in entry.
pub(crate) struct Controller<'a> {
    pub autostart: Option<&'a dyn AutostartBackend>,
    pub store: &'a dyn PreferenceStore,
    pub tray: &'a dyn TrayControl,
    pub read_only: bool,
}

impl Controller<'_> {
    pub(crate) fn settings(&self) -> Result<BackgroundSettingsV1, BackgroundError> {
        let preferences = self.store.load()?;
        let launch_at_login = match self.autostart {
            // An unreadable registration is reported as off, never guessed on.
            Some(backend) => backend.is_enabled().unwrap_or(false),
            None => false,
        };
        Ok(BackgroundSettingsV1 {
            protocol: 1,
            keep_in_tray: preferences.keep_in_tray && !self.read_only,
            launch_at_login,
            tray_available: !self.read_only,
            launch_at_login_available: self.autostart.is_some(),
            read_only: self.read_only,
        })
    }

    /// Applies one explicit change. Turning the tray on shows it first and
    /// saves only when that worked; turning it off saves first.
    pub(crate) fn update(
        &self,
        request: &BackgroundUpdateRequest,
    ) -> Result<BackgroundSettingsV1, BackgroundError> {
        if request.keep_in_tray.is_none() && request.launch_at_login.is_none() {
            return Err(BackgroundError::invalid());
        }
        if self.read_only {
            return Err(BackgroundError::read_only());
        }
        if let Some(enabled) = request.launch_at_login {
            let backend = self.autostart.ok_or_else(BackgroundError::unavailable)?;
            if backend.is_enabled().unwrap_or(!enabled) != enabled {
                backend.set_enabled(enabled)?;
            }
        }
        if let Some(keep) = request.keep_in_tray {
            let mut preferences = self.store.load()?;
            if keep {
                self.tray.show()?;
                preferences.keep_in_tray = true;
                self.store.save(preferences)?;
            } else {
                preferences.keep_in_tray = false;
                self.store.save(preferences)?;
                self.tray.remove();
            }
        }
        self.settings()
    }
}

/// Whether this launch should stay hidden in the tray: only a start at
/// sign-in, only with the tray on, and never in safe mode.
pub(crate) fn start_hidden(args: &[String], keep_in_tray: bool, safe_mode: bool) -> bool {
    !safe_mode && keep_in_tray && args.iter().any(|argument| argument == AUTOSTART_ARG)
}

/// Trimmed, bounded, control-free labels; `&` is literal in a native menu.
pub(crate) fn sanitized_labels(labels: TrayLabels) -> Result<TrayLabels, BackgroundError> {
    let clean = |value: String| -> Result<String, BackgroundError> {
        let value = value.trim().to_owned();
        if value.is_empty()
            || value.chars().count() > MAX_LABEL_CHARS
            || value.chars().any(char::is_control)
        {
            return Err(BackgroundError::invalid());
        }
        Ok(value)
    };
    Ok(TrayLabels {
        open: clean(labels.open)?,
        pause: clean(labels.pause)?,
        resume: clean(labels.resume)?,
        quit: clean(labels.quit)?,
        tooltip: clean(labels.tooltip)?,
        paused_tooltip: clean(labels.paused_tooltip)?,
    })
}

fn menu_text(label: &str) -> String {
    label.replace('&', "&&")
}

/// Host state of background mode.
pub(crate) struct BackgroundState {
    safe_mode: bool,
    autostart_allowed: bool,
    tray_active: AtomicBool,
    labels: Mutex<TrayLabels>,
}

impl BackgroundState {
    fn tray_active(&self) -> bool {
        self.tray_active.load(Ordering::Acquire)
    }

    fn labels(&self) -> TrayLabels {
        self.labels
            .lock()
            .map(|labels| labels.clone())
            .unwrap_or_default()
    }
}

struct IndexPreferences<'a>(&'a HostState);

impl PreferenceStore for IndexPreferences<'_> {
    fn load(&self) -> Result<BackgroundPreferences, BackgroundError> {
        let index = self.0.index.lock().map_err(|_| BackgroundError::io())?;
        index
            .background_preferences()
            .map_err(|_| BackgroundError::io())
    }

    fn save(&self, value: BackgroundPreferences) -> Result<(), BackgroundError> {
        let mut index = self.0.index.lock().map_err(|_| BackgroundError::io())?;
        index
            .update_background_preferences(value)
            .map(|_| ())
            .map_err(|_| BackgroundError::io())
    }
}

struct PluginAutostart<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> AutostartBackend for PluginAutostart<'_, R> {
    fn is_enabled(&self) -> Result<bool, BackgroundError> {
        let manager = self
            .0
            .try_state::<tauri_plugin_autostart::AutoLaunchManager>()
            .ok_or_else(BackgroundError::unavailable)?;
        manager
            .is_enabled()
            .map_err(|_| BackgroundError::unavailable())
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), BackgroundError> {
        let manager = self
            .0
            .try_state::<tauri_plugin_autostart::AutoLaunchManager>()
            .ok_or_else(BackgroundError::unavailable)?;
        let result = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        result.map_err(|_| {
            eprintln!("event=background_autostart_failed enabled={enabled}");
            BackgroundError::unavailable()
        })
    }
}

struct RuntimeTray<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> TrayControl for RuntimeTray<'_, R> {
    fn show(&self) -> Result<(), BackgroundError> {
        ensure_tray(self.0)
    }

    fn remove(&self) {
        remove_tray(self.0);
    }
}

fn with_controller<R: Runtime, T>(
    app: &AppHandle<R>,
    action: impl FnOnce(&Controller<'_>) -> Result<T, BackgroundError>,
) -> Result<T, BackgroundError> {
    let host = app
        .try_state::<HostState>()
        .ok_or_else(BackgroundError::unavailable)?;
    let state = app
        .try_state::<BackgroundState>()
        .ok_or_else(BackgroundError::unavailable)?;
    let store = IndexPreferences(&host);
    let tray = RuntimeTray(app);
    let plugin = PluginAutostart(app);
    let autostart = (state.autostart_allowed
        && app
            .try_state::<tauri_plugin_autostart::AutoLaunchManager>()
            .is_some())
    .then_some(&plugin as &dyn AutostartBackend);
    action(&Controller {
        autostart,
        store: &store,
        tray: &tray,
        read_only: state.safe_mode,
    })
}

/// What a second launch of PiUI asks the running one to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SecondLaunch {
    /// Show and focus the main window, restoring it from the tray.
    ShowWindow,
    /// A sign-in start while PiUI already runs: change nothing.
    StayAsIs,
}

/// Decides from the second process's arguments; it exits right after.
pub(crate) fn second_launch(args: &[String]) -> SecondLaunch {
    if args.iter().any(|argument| argument == AUTOSTART_ARG) {
        SecondLaunch::StayAsIs
    } else {
        SecondLaunch::ShowWindow
    }
}

/// The single-instance guard's callback in the running PiUI.
pub(crate) fn on_second_launch<R: Runtime>(app: &AppHandle<R>, args: &[String]) {
    match second_launch(args) {
        SecondLaunch::ShowWindow => show_main(app),
        SecondLaunch::StayAsIs => {}
    }
}

/// Whether this process joins the one-instance-per-session guard. E2E hosts
/// run in isolated data folders, several at a time, and stay outside it.
pub(crate) fn single_instance_guard(e2e_isolated: bool) -> bool {
    !e2e_isolated
}

/// Manages background state at startup, shows the tray when it is on and
/// keeps a sign-in start hidden in it. Nothing here blocks first paint: the
/// OS registration is read only when Settings asks for it.
pub(crate) fn setup<R: Runtime>(app: &AppHandle<R>, safe_mode: bool, autostart_allowed: bool) {
    app.manage(BackgroundState {
        safe_mode,
        autostart_allowed,
        tray_active: AtomicBool::new(false),
        labels: Mutex::new(TrayLabels::default()),
    });
    if safe_mode {
        return;
    }
    let keep_in_tray = app
        .try_state::<HostState>()
        .and_then(|host| IndexPreferences(&host).load().ok())
        .is_some_and(|preferences| preferences.keep_in_tray);
    if !keep_in_tray {
        return;
    }
    if ensure_tray(app).is_err() {
        eprintln!("event=background_tray_unavailable");
        return;
    }
    let args: Vec<String> = std::env::args().collect();
    if start_hidden(&args, keep_in_tray, safe_mode)
        && let Some(window) = app.get_webview_window(MAIN_WINDOW)
    {
        let _ = window.hide();
    }
}

fn ensure_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), BackgroundError> {
    let state = app
        .try_state::<BackgroundState>()
        .ok_or_else(BackgroundError::unavailable)?;
    if state.safe_mode {
        return Err(BackgroundError::read_only());
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        state.tray_active.store(true, Ordering::Release);
        return refresh_tray(app).map_err(|_| BackgroundError::unavailable());
    }
    let labels = state.labels();
    let paused = automations_paused(app);
    let menu = tray_menu(app, &labels, paused).map_err(|_| BackgroundError::unavailable())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(if paused {
            &labels.paused_tooltip
        } else {
            &labels.tooltip
        })
        .on_menu_event(on_menu_event::<R>)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .build(app)
        .map_err(|_| BackgroundError::unavailable())?;
    state.tray_active.store(true, Ordering::Release);
    Ok(())
}

fn remove_tray<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<BackgroundState>() {
        state.tray_active.store(false, Ordering::Release);
    }
    let _ = app.remove_tray_by_id(TRAY_ID);
}

fn automations_paused<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<OrchestrationApiState>()
        .and_then(|state| state.automations_paused().ok())
        .unwrap_or(false)
}

fn tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    labels: &TrayLabels,
    paused: bool,
) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, MENU_OPEN, menu_text(&labels.open), true, None::<&str>)?;
    let pause = MenuItem::with_id(
        app,
        MENU_PAUSE,
        menu_text(if paused {
            &labels.resume
        } else {
            &labels.pause
        }),
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, menu_text(&labels.quit), true, None::<&str>)?;
    Menu::with_items(app, &[&open, &pause, &separator, &quit])
}

/// Rebuilds the tray menu and tooltip for the current language and pause.
pub(crate) fn refresh_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let (Some(state), Some(tray)) = (app.try_state::<BackgroundState>(), app.tray_by_id(TRAY_ID))
    else {
        return Ok(());
    };
    let labels = state.labels();
    let paused = automations_paused(app);
    tray.set_menu(Some(tray_menu(app, &labels, paused)?))?;
    tray.set_tooltip(Some(if paused {
        &labels.paused_tooltip
    } else {
        &labels.tooltip
    }))
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_OPEN => show_main(app),
        MENU_PAUSE => {
            let app = app.clone();
            // The durable write runs off the event loop, under the same gate
            // as the Automations screen's request.
            tauri::async_runtime::spawn(async move {
                let Some(host) = app.try_state::<HostState>() else {
                    return;
                };
                let _operation = host.live_runtime_operation_gate.lock().await;
                if host.safe_mode || host.is_shutting_down() {
                    return;
                }
                let paused = automations_paused(&app);
                if let Err(error) = apply_automations_paused(&app, !paused) {
                    eprintln!("event=background_pause_failed code={}", error.code);
                }
            });
        }
        // The ordinary exit path stops harness processes before exiting.
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

/// Closing the main window keeps PiUI in the tray only while the tray is on.
pub(crate) fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != MAIN_WINDOW {
        return;
    }
    let Some(state) = window.try_state::<BackgroundState>() else {
        return;
    };
    let shutting_down = window
        .try_state::<HostState>()
        .is_some_and(|host| host.is_shutting_down());
    if state.tray_active() && !state.safe_mode && !shutting_down {
        api.prevent_close();
        let _ = window.hide();
    }
}

#[tauri::command]
pub async fn background_settings_v1(
    app: AppHandle,
    request: BackgroundSettingsRequest,
) -> Result<BackgroundSettingsV1, BackgroundError> {
    let BackgroundSettingsRequest {} = request;
    with_controller(&app, |controller| controller.settings())
}

#[tauri::command]
pub async fn background_update_v1(
    app: AppHandle,
    request: BackgroundUpdateRequest,
) -> Result<BackgroundSettingsV1, BackgroundError> {
    with_controller(&app, |controller| controller.update(&request))
}

#[tauri::command]
pub async fn background_tray_labels_v1(
    app: AppHandle,
    request: TrayLabels,
) -> Result<(), BackgroundError> {
    let labels = sanitized_labels(request)?;
    let state = app
        .try_state::<BackgroundState>()
        .ok_or_else(BackgroundError::unavailable)?;
    if let Ok(mut current) = state.labels.lock() {
        *current = labels;
    }
    refresh_tray(&app).map_err(|_| BackgroundError::unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct FakeAutostart {
        enabled: Cell<bool>,
        fail: Cell<bool>,
        writes: Cell<u32>,
    }

    impl AutostartBackend for FakeAutostart {
        fn is_enabled(&self) -> Result<bool, BackgroundError> {
            Ok(self.enabled.get())
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), BackgroundError> {
            if self.fail.get() {
                return Err(BackgroundError::unavailable());
            }
            self.writes.set(self.writes.get() + 1);
            self.enabled.set(enabled);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeStore(RefCell<BackgroundPreferences>);

    impl PreferenceStore for FakeStore {
        fn load(&self) -> Result<BackgroundPreferences, BackgroundError> {
            Ok(*self.0.borrow())
        }
        fn save(&self, value: BackgroundPreferences) -> Result<(), BackgroundError> {
            *self.0.borrow_mut() = value;
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeTray {
        shown: Cell<bool>,
        broken: Cell<bool>,
    }

    impl TrayControl for FakeTray {
        fn show(&self) -> Result<(), BackgroundError> {
            if self.broken.get() {
                return Err(BackgroundError::unavailable());
            }
            self.shown.set(true);
            Ok(())
        }
        fn remove(&self) {
            self.shown.set(false);
        }
    }

    fn update(
        keep_in_tray: Option<bool>,
        launch_at_login: Option<bool>,
    ) -> BackgroundUpdateRequest {
        BackgroundUpdateRequest {
            keep_in_tray,
            launch_at_login,
        }
    }

    #[test]
    fn everything_is_off_until_a_person_turns_it_on() {
        let (autostart, store, tray) = (
            FakeAutostart::default(),
            FakeStore::default(),
            FakeTray::default(),
        );
        let controller = Controller {
            autostart: Some(&autostart),
            store: &store,
            tray: &tray,
            read_only: false,
        };
        let settings = controller.settings().expect("reads");
        assert_eq!(
            settings,
            BackgroundSettingsV1 {
                protocol: 1,
                keep_in_tray: false,
                launch_at_login: false,
                tray_available: true,
                launch_at_login_available: true,
                read_only: false,
            }
        );
        assert_eq!(autostart.writes.get(), 0);
        assert!(!tray.shown.get());
    }

    #[test]
    fn explicit_toggles_register_sign_in_and_show_the_tray() {
        let (autostart, store, tray) = (
            FakeAutostart::default(),
            FakeStore::default(),
            FakeTray::default(),
        );
        let controller = Controller {
            autostart: Some(&autostart),
            store: &store,
            tray: &tray,
            read_only: false,
        };
        let on = controller
            .update(&update(Some(true), None))
            .expect("tray on");
        assert!(on.keep_in_tray && tray.shown.get());
        assert!(store.0.borrow().keep_in_tray);
        let login = controller
            .update(&update(None, Some(true)))
            .expect("sign-in on");
        assert!(login.launch_at_login && autostart.enabled.get());
        // An unchanged registration is not rewritten.
        controller.update(&update(None, Some(true))).expect("same");
        assert_eq!(autostart.writes.get(), 1);
        let off = controller
            .update(&update(Some(false), Some(false)))
            .expect("both off");
        assert!(!off.keep_in_tray && !off.launch_at_login);
        assert!(!tray.shown.get() && !store.0.borrow().keep_in_tray);
        assert!(controller.update(&update(None, None)).is_err());
    }

    #[test]
    fn failures_leave_the_previous_choice_in_place() {
        let (autostart, store, tray) = (
            FakeAutostart::default(),
            FakeStore::default(),
            FakeTray::default(),
        );
        let controller = Controller {
            autostart: Some(&autostart),
            store: &store,
            tray: &tray,
            read_only: false,
        };
        tray.broken.set(true);
        assert_eq!(
            controller.update(&update(Some(true), None)),
            Err(BackgroundError::unavailable())
        );
        assert!(!store.0.borrow().keep_in_tray, "not saved without a tray");
        autostart.fail.set(true);
        assert_eq!(
            controller.update(&update(None, Some(true))),
            Err(BackgroundError::unavailable())
        );
        assert!(!autostart.enabled.get());
        let unsupported = Controller {
            autostart: None,
            store: &store,
            tray: &tray,
            read_only: false,
        };
        assert!(
            !unsupported
                .settings()
                .expect("reads")
                .launch_at_login_available
        );
        assert_eq!(
            unsupported.update(&update(None, Some(true))),
            Err(BackgroundError::unavailable())
        );
    }

    #[test]
    fn safe_mode_is_read_only_and_never_shows_a_tray() {
        let (autostart, store, tray) = (
            FakeAutostart::default(),
            FakeStore::default(),
            FakeTray::default(),
        );
        *store.0.borrow_mut() = BackgroundPreferences { keep_in_tray: true };
        let controller = Controller {
            autostart: Some(&autostart),
            store: &store,
            tray: &tray,
            read_only: true,
        };
        let settings = controller.settings().expect("reads");
        assert!(settings.read_only && !settings.keep_in_tray && !settings.tray_available);
        assert_eq!(
            controller.update(&update(Some(false), None)),
            Err(BackgroundError::read_only())
        );
        assert_eq!(autostart.writes.get(), 0);
        assert!(!start_hidden(&[AUTOSTART_ARG.to_owned()], true, true));
    }

    #[test]
    fn a_second_launch_shows_the_running_window_unless_it_is_a_sign_in_start() {
        let args = |values: &[&str]| {
            values
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            second_launch(&args(&["piui-desktop"])),
            SecondLaunch::ShowWindow
        );
        assert_eq!(second_launch(&args(&[])), SecondLaunch::ShowWindow);
        assert_eq!(
            second_launch(&args(&["piui-desktop", "--safe-mode"])),
            SecondLaunch::ShowWindow
        );
        assert_eq!(
            second_launch(&args(&["piui-desktop", AUTOSTART_ARG])),
            SecondLaunch::StayAsIs
        );
        // E2E hosts run side by side in isolated folders, outside the guard.
        assert!(single_instance_guard(false));
        assert!(!single_instance_guard(true));
    }

    #[test]
    fn only_a_sign_in_start_with_the_tray_on_stays_hidden() {
        let autostart = vec!["piui-desktop".to_owned(), AUTOSTART_ARG.to_owned()];
        let manual = vec!["piui-desktop".to_owned()];
        assert!(start_hidden(&autostart, true, false));
        assert!(!start_hidden(&autostart, false, false));
        assert!(!start_hidden(&manual, true, false));
    }

    /// Shared with the TypeScript contract tests (`contracts/background-v1.ts`).
    #[test]
    fn golden_json_matches_the_typescript_contract() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/fixtures/triggers-v7-2.json"
        ))
        .expect("fixture JSON");
        let settings = BackgroundSettingsV1 {
            protocol: 1,
            keep_in_tray: true,
            launch_at_login: false,
            tray_available: true,
            launch_at_login_available: true,
            read_only: false,
        };
        assert_eq!(
            serde_json::to_value(&settings).expect("encodes"),
            fixture["backgroundSettings"]
        );
        let update: BackgroundUpdateRequest =
            serde_json::from_value(fixture["backgroundUpdate"].clone()).expect("decodes");
        assert_eq!(update.keep_in_tray, Some(true));
        assert_eq!(update.launch_at_login, None);
        assert!(
            serde_json::from_value::<BackgroundUpdateRequest>(
                serde_json::json!({"keepInTray": true, "startMinimized": true})
            )
            .is_err()
        );
        let labels: TrayLabels =
            serde_json::from_value(fixture["trayLabels"].clone()).expect("decodes");
        assert_eq!(labels, TrayLabels::default());
        assert!(serde_json::from_value::<BackgroundSettingsRequest>(serde_json::json!({})).is_ok());
    }

    #[test]
    fn tray_labels_are_bounded_and_literal() {
        let labels = sanitized_labels(TrayLabels {
            open: "  Открыть PiUI ".into(),
            ..TrayLabels::default()
        })
        .expect("valid");
        assert_eq!(labels.open, "Открыть PiUI");
        assert_eq!(menu_text("Save & quit"), "Save && quit");
        for invalid in [
            String::new(),
            "x".repeat(MAX_LABEL_CHARS + 1),
            "a\nb".into(),
        ] {
            assert!(
                sanitized_labels(TrayLabels {
                    quit: invalid,
                    ..TrayLabels::default()
                })
                .is_err()
            );
        }
    }
}
