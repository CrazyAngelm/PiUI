//! Signed application updates (`contracts/app-update-v1.ts`).
//!
//! Every build compiles the updater, but it is active only when the build's
//! Tauri configuration carries `plugins.updater` with a minisign public key and
//! HTTPS endpoints. Release builds merge that section with
//! `tauri build --config` (`scripts/release-config.mjs`); local and CI builds
//! do not, so they never register the updater plugin, never contact an update
//! endpoint and report `configured: false` (the About page then shows no update
//! controls).
//!
//! Policy owned by the host:
//! - automatic checks run only after the person turned on "Check for updates
//!   automatically" (`app-update.json`, off by default), start well after the
//!   window opened, never run in safe mode and never install anything;
//! - an install needs an explicit request for the exact version that the last
//!   check found (the version the person confirmed). The Tauri updater verifies
//!   the download's minisign signature against the compiled public key before
//!   anything is written or run; there is no way to skip that check;
//! - native agent runtimes and running script steps stop the same way as on
//!   quit before the installer replaces PiUI (Windows) or before the restart
//!   into the replaced bundle (Linux, macOS).
//!
//! The WebView never receives the updater plugin's own commands: only the
//! typed commands below are exposed, and no capability grants `updater:*`.
//!
//! The module is public (hidden from docs) only for `tests/app_update.rs`: on
//! Windows, Tauri's MockRuntime needs the common-controls manifest that only
//! integration tests receive (see `build.rs`). Nothing here is a plugin API.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

use crate::orchestration_scheduler::OrchestrationScheduler;
use crate::state::HostState;

pub const APP_UPDATE_PROTOCOL: u8 = 1;
/// Status and download progress events (`AppUpdateEventV1`).
pub const APP_UPDATE_EVENT: &str = "piui://app-update";
/// Host-saved "Check for updates automatically" preference, in the app data folder.
pub const SETTINGS_FILE: &str = "app-update.json";
const SETTINGS_VERSION: u8 = 1;
/// The first automatic check waits until the window has long been usable.
const FIRST_AUTOMATIC_CHECK_DELAY: Duration = Duration::from_secs(45);
const AUTOMATIC_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(200);
const MAX_NOTES_CHARS: usize = 16 * 1024;
const MAX_VERSION_CHARS: usize = 64;
const MAX_ENDPOINTS: usize = 8;
const MAX_PUBLIC_KEY_CHARS: usize = 4096;
/// Plugin switches that would weaken transport security or allow downgrades.
const UNSAFE_SWITCHES: [&str; 8] = [
    "dangerousInsecureTransportProtocol",
    "dangerous-insecure-transport-protocol",
    "dangerousAcceptInvalidCerts",
    "dangerous-accept-invalid-certs",
    "dangerousAcceptInvalidHostnames",
    "dangerous-accept-invalid-hostnames",
    "allowDowngrades",
    "allow-downgrades",
];

/// Why a present `plugins.updater` section does not turn updates on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GateRefusal {
    #[error("plugins.updater must be an object")]
    NotAnObject,
    #[error("the updater public key is missing or is not a minisign public key")]
    PublicKey,
    #[error("the updater needs one to eight HTTPS endpoints without credentials")]
    Endpoints,
    #[error("insecure transport and downgrade switches are not allowed")]
    UnsafeSwitch,
}

/// What a configured build enables.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UpdaterGate {
    /// Host of the first endpoint, shown to the person as where checks go.
    feed_host: String,
}

/// Reads the build's `plugins.updater` section. `Ok(None)` (no section) is the
/// normal unconfigured build; a present section must be complete and safe:
/// a minisign public key in the Tauri encoding, one to eight `https` endpoints
/// with a host and no credentials, and no `dangerous*`/downgrade switch.
pub(crate) fn updater_gate(section: Option<&Value>) -> Result<Option<UpdaterGate>, GateRefusal> {
    let Some(section) = section else {
        return Ok(None);
    };
    let Value::Object(section) = section else {
        return Err(GateRefusal::NotAnObject);
    };
    if UNSAFE_SWITCHES.iter().any(|switch| {
        section
            .get(*switch)
            .is_some_and(|value| value != &Value::Bool(false))
    }) {
        return Err(GateRefusal::UnsafeSwitch);
    }
    let public_key = section
        .get("pubkey")
        .and_then(Value::as_str)
        .ok_or(GateRefusal::PublicKey)?;
    if !is_tauri_minisign_public_key(public_key) {
        return Err(GateRefusal::PublicKey);
    }
    let endpoints = section
        .get("endpoints")
        .and_then(Value::as_array)
        .filter(|endpoints| (1..=MAX_ENDPOINTS).contains(&endpoints.len()))
        .ok_or(GateRefusal::Endpoints)?;
    let mut feed_host = None;
    for endpoint in endpoints {
        let url = endpoint
            .as_str()
            .and_then(|text| Url::parse(text).ok())
            .ok_or(GateRefusal::Endpoints)?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err(GateRefusal::Endpoints);
        }
        let host = url
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or(GateRefusal::Endpoints)?;
        feed_host.get_or_insert_with(|| host.to_owned());
    }
    Ok(feed_host.map(|feed_host| UpdaterGate { feed_host }))
}

/// The Tauri updater expects the base64 text of a minisign `.pub` file. It
/// does not trim, so surrounding whitespace would break every verification.
fn is_tauri_minisign_public_key(value: &str) -> bool {
    use base64::Engine as _;
    if value.is_empty() || value.len() > MAX_PUBLIC_KEY_CHARS || value.trim() != value {
        return false;
    }
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(value) else {
        return false;
    };
    std::str::from_utf8(&decoded)
        .is_ok_and(|text| minisign_verify::PublicKey::decode(text.trim_end()).is_ok())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppUpdatePhase {
    Idle,
    Checking,
    Downloading,
    Installing,
    /// Linux/macOS: the bundle was replaced; PiUI is stopping and restarting.
    #[cfg_attr(windows, allow(dead_code))]
    Restarting,
    /// Windows: agents were stopped but the installer did not start.
    RestartRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppUpdateCheckOutcome {
    UpToDate,
    Available,
    Failed,
}

/// Typed refusals and failures. Commands reject with `{"code": "<code>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "kebab-case")]
pub enum AppUpdateErrorCode {
    #[error("the request is invalid")]
    Invalid,
    #[error("updates are not configured in this build")]
    NotConfigured,
    #[error("another update check or install is running")]
    Busy,
    #[error("PiUI is closing")]
    ShuttingDown,
    #[error("this version is not the update found by the last check")]
    NotAvailable,
    #[error("the update server could not be reached")]
    Network,
    #[error("the update information is invalid")]
    FeedInvalid,
    #[error("the update has no package for this system")]
    PlatformMissing,
    #[error("the update check failed")]
    CheckFailed,
    #[error("the update could not be downloaded")]
    DownloadFailed,
    #[error("the update signature is invalid; nothing was installed")]
    SignatureInvalid,
    #[error("the update could not be installed")]
    InstallFailed,
    #[error("the update preference could not be saved")]
    SettingsFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{code}")]
pub struct AppUpdateError {
    pub code: AppUpdateErrorCode,
}

impl From<AppUpdateErrorCode> for AppUpdateError {
    fn from(code: AppUpdateErrorCode) -> Self {
        Self { code }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateLastCheckV1 {
    /// RFC 3339, UTC.
    pub at: String,
    pub automatic: bool,
    pub outcome: AppUpdateCheckOutcome,
    pub error: Option<AppUpdateErrorCode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateAvailableV1 {
    pub version: String,
    /// RFC 3339, UTC, when the release feed names a valid date.
    pub date: Option<String>,
    /// Plain text; never rendered as HTML.
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatusV1 {
    pub protocol: u8,
    pub configured: bool,
    pub current_version: String,
    pub feed_host: Option<String>,
    pub auto_check: bool,
    pub phase: AppUpdatePhase,
    pub last_check: Option<AppUpdateLastCheckV1>,
    pub available: Option<AppUpdateAvailableV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppUpdateEventV1 {
    Status {
        status: AppUpdateStatusV1,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppUpdateInstallRequestV1 {
    pub version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppUpdateAutoCheckRequestV1 {
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettings {
    version: u8,
    auto_check: bool,
}

struct Pending {
    summary: AppUpdateAvailableV1,
    update: Update,
}

struct Inner {
    auto_check: bool,
    phase: AppUpdatePhase,
    last_check: Option<AppUpdateLastCheckV1>,
    pending: Option<Pending>,
}

/// Host-owned update state; managed in every build, active only when configured.
pub struct AppUpdateState {
    gate: Option<UpdaterGate>,
    settings_path: PathBuf,
    inner: Mutex<Inner>,
    /// Serializes checks and installs; a second request is refused as busy.
    operation: tokio::sync::Mutex<()>,
    /// Wakes the automatic check loop when the person turns checks on.
    wake: Notify,
}

impl AppUpdateState {
    fn new(gate: Option<UpdaterGate>, app_data_dir: &Path) -> Self {
        let settings_path = app_data_dir.join(SETTINGS_FILE);
        let auto_check = gate.is_some() && load_auto_check(&settings_path);
        Self {
            gate,
            settings_path,
            inner: Mutex::new(Inner {
                auto_check,
                phase: AppUpdatePhase::Idle,
                last_check: None,
                pending: None,
            }),
            operation: tokio::sync::Mutex::new(()),
            wake: Notify::new(),
        }
    }

    /// Test support: a configured state for a loopback feed, which the host
    /// gate refuses because it is plain HTTP. Debug builds only.
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn configured_for_tests(feed_host: &str, app_data_dir: &Path) -> Self {
        Self::new(
            Some(UpdaterGate {
                feed_host: feed_host.to_owned(),
            }),
            app_data_dir,
        )
    }

    /// The updater's own offer object for the version the last check found.
    pub fn pending_update(&self) -> Option<Update> {
        self.lock()
            .pending
            .as_ref()
            .map(|pending| pending.update.clone())
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // The state holds plain values; a panic elsewhere never leaves it half-written.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn auto_check(&self) -> bool {
        self.lock().auto_check
    }

    pub fn status<R: Runtime>(&self, app: &AppHandle<R>) -> AppUpdateStatusV1 {
        let inner = self.lock();
        AppUpdateStatusV1 {
            protocol: APP_UPDATE_PROTOCOL,
            configured: self.gate.is_some(),
            current_version: app.package_info().version.to_string(),
            feed_host: self.gate.as_ref().map(|gate| gate.feed_host.clone()),
            auto_check: inner.auto_check,
            phase: inner.phase,
            last_check: inner.last_check.clone(),
            available: inner
                .pending
                .as_ref()
                .map(|pending| pending.summary.clone()),
        }
    }

    fn set_phase<R: Runtime>(&self, app: &AppHandle<R>, phase: AppUpdatePhase) {
        self.lock().phase = phase;
        self.publish(app);
    }

    fn publish<R: Runtime>(&self, app: &AppHandle<R>) -> AppUpdateStatusV1 {
        let status = self.status(app);
        let _ = app.emit(
            APP_UPDATE_EVENT,
            AppUpdateEventV1::Status {
                status: status.clone(),
            },
        );
        status
    }
}

/// Setup hook: registers the updater plugin only for a configured build and
/// starts automatic checks (which still wait for the person's opt-in).
pub fn install<R: Runtime>(app: &tauri::App<R>, app_data_dir: &Path, safe_mode: bool) {
    // A malformed section keeps updates off rather than failing startup.
    let gate = updater_gate(app.config().plugins.0.get("updater")).unwrap_or(None);
    // The plugin validates the same section again; if it refuses, stay off.
    let gate = gate.filter(|_| {
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .is_ok()
    });
    let configured = gate.is_some();
    app.manage(AppUpdateState::new(gate, app_data_dir));
    if configured && !safe_mode {
        start_automatic_checks(app.handle().clone());
    }
}

fn start_automatic_checks<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut delay = FIRST_AUTOMATIC_CHECK_DELAY;
        loop {
            {
                let updates = app.state::<AppUpdateState>();
                tokio::select! {
                    () = tokio::time::sleep(delay) => {}
                    () = updates.wake.notified() => {}
                }
            }
            delay = AUTOMATIC_CHECK_INTERVAL;
            if shutting_down(&app) {
                return;
            }
            let updates = app.state::<AppUpdateState>();
            if updates.auto_check() {
                // Failures are recorded in the status; the next check is a day later.
                let _ = check(&app, &updates, true).await;
            }
        }
    });
}

fn shutting_down<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<HostState>()
        .is_some_and(|host| host.is_shutting_down())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// The release feed's own words, bounded and made safe for plain-text display.
fn summarize(update: &Update) -> AppUpdateAvailableV1 {
    let date = update
        .raw_json
        .get("pub_date")
        .and_then(Value::as_str)
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|date| {
            date.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        });
    let notes = update
        .body
        .as_deref()
        .map(plain_notes)
        .filter(|notes| !notes.is_empty());
    AppUpdateAvailableV1 {
        version: update.version.clone(),
        date,
        notes,
    }
}

fn plain_notes(text: &str) -> String {
    let mut notes: String = text
        .replace("\r\n", "\n")
        .chars()
        .filter(|character| *character == '\n' || *character == '\t' || !character.is_control())
        .take(MAX_NOTES_CHARS)
        .collect();
    notes.truncate(notes.trim_end().len());
    notes
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Check,
    Download,
    Install,
}

fn classify(error: &tauri_plugin_updater::Error, stage: Stage) -> AppUpdateErrorCode {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => AppUpdateErrorCode::SignatureInvalid,
        Error::EmptyEndpoints | Error::InsecureTransportProtocol => {
            AppUpdateErrorCode::NotConfigured
        }
        Error::UnsupportedArch
        | Error::UnsupportedOs
        | Error::TargetNotFound(_)
        | Error::TargetsNotFound(_) => AppUpdateErrorCode::PlatformMissing,
        Error::ReleaseNotFound
        | Error::Serialization(_)
        | Error::Semver(_)
        | Error::UrlParse(_)
        | Error::FormatDate => AppUpdateErrorCode::FeedInvalid,
        // The feed answered, but not with JSON.
        Error::Reqwest(error) if stage == Stage::Check && error.is_decode() => {
            AppUpdateErrorCode::FeedInvalid
        }
        Error::Reqwest(_) | Error::Network(_) | Error::Http(_) => match stage {
            Stage::Check => AppUpdateErrorCode::Network,
            Stage::Download | Stage::Install => AppUpdateErrorCode::DownloadFailed,
        },
        _ => match stage {
            Stage::Check => AppUpdateErrorCode::CheckFailed,
            Stage::Download => AppUpdateErrorCode::DownloadFailed,
            Stage::Install => AppUpdateErrorCode::InstallFailed,
        },
    }
}

pub async fn check<R: Runtime>(
    app: &AppHandle<R>,
    updates: &AppUpdateState,
    automatic: bool,
) -> Result<AppUpdateStatusV1, AppUpdateError> {
    if updates.gate.is_none() {
        return Err(AppUpdateErrorCode::NotConfigured.into());
    }
    if shutting_down(app) {
        return Err(AppUpdateErrorCode::ShuttingDown.into());
    }
    let Ok(_operation) = updates.operation.try_lock() else {
        return Err(AppUpdateErrorCode::Busy.into());
    };
    if updates.lock().phase != AppUpdatePhase::Idle {
        return Err(AppUpdateErrorCode::Busy.into());
    }
    updates.set_phase(app, AppUpdatePhase::Checking);
    let result = match app.updater_builder().timeout(CHECK_TIMEOUT).build() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let failure = {
        let mut inner = updates.lock();
        inner.phase = AppUpdatePhase::Idle;
        let (outcome, failure) = match result {
            Ok(Some(update)) => {
                inner.pending = Some(Pending {
                    summary: summarize(&update),
                    update,
                });
                (AppUpdateCheckOutcome::Available, None)
            }
            Ok(None) => {
                inner.pending = None;
                (AppUpdateCheckOutcome::UpToDate, None)
            }
            // A previously found update stays offered after a failed check.
            Err(error) => (
                AppUpdateCheckOutcome::Failed,
                Some(classify(&error, Stage::Check)),
            ),
        };
        inner.last_check = Some(AppUpdateLastCheckV1 {
            at: now_rfc3339(),
            automatic,
            outcome,
            error: failure,
        });
        failure
    };
    let status = updates.publish(app);
    match failure {
        Some(code) => Err(code.into()),
        None => Ok(status),
    }
}

/// Downloads the update and verifies its minisign signature against the
/// compiled public key (inside the plugin; failure means nothing is kept).
pub async fn download_verified<R: Runtime>(
    app: &AppHandle<R>,
    update: &Update,
) -> Result<Vec<u8>, AppUpdateErrorCode> {
    let mut downloaded: u64 = 0;
    let mut last_event: Option<Instant> = None;
    update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let finished = total.is_some_and(|total| downloaded >= total);
                if finished || last_event.is_none_or(|at| at.elapsed() >= PROGRESS_EVENT_INTERVAL) {
                    last_event = Some(Instant::now());
                    let _ = app.emit(
                        APP_UPDATE_EVENT,
                        AppUpdateEventV1::Progress {
                            downloaded_bytes: downloaded,
                            total_bytes: total,
                        },
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|error| classify(&error, Stage::Download))
}

fn valid_version_text(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= MAX_VERSION_CHARS
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

pub async fn install_version<R: Runtime>(
    app: &AppHandle<R>,
    updates: &AppUpdateState,
    version: &str,
) -> Result<AppUpdateStatusV1, AppUpdateError> {
    if !valid_version_text(version) {
        return Err(AppUpdateErrorCode::Invalid.into());
    }
    if updates.gate.is_none() {
        return Err(AppUpdateErrorCode::NotConfigured.into());
    }
    if shutting_down(app) {
        return Err(AppUpdateErrorCode::ShuttingDown.into());
    }
    let Ok(_operation) = updates.operation.try_lock() else {
        return Err(AppUpdateErrorCode::Busy.into());
    };
    let update = {
        let inner = updates.lock();
        if inner.phase != AppUpdatePhase::Idle {
            return Err(AppUpdateErrorCode::Busy.into());
        }
        inner
            .pending
            .as_ref()
            .filter(|pending| pending.summary.version == version)
            .map(|pending| pending.update.clone())
            .ok_or(AppUpdateErrorCode::NotAvailable)?
    };
    updates.set_phase(app, AppUpdatePhase::Downloading);
    let bytes = match download_verified(app, &update).await {
        Ok(bytes) => bytes,
        Err(code) => {
            updates.set_phase(app, AppUpdatePhase::Idle);
            return Err(code.into());
        }
    };
    updates.set_phase(app, AppUpdatePhase::Installing);
    install_downloaded(app, updates, update, bytes).await
}

/// Windows: the installer replaces this executable and PiUI exits when it
/// starts, so native runtimes and their process trees stop first, exactly as
/// on quit. The installer restarts PiUI when it finishes.
#[cfg(windows)]
async fn install_downloaded<R: Runtime>(
    app: &AppHandle<R>,
    updates: &AppUpdateState,
    update: Update,
    bytes: Vec<u8>,
) -> Result<AppUpdateStatusV1, AppUpdateError> {
    stop_native_runtimes(app).await;
    // On success `install` starts the installer and exits the process.
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    // The installer did not start. Agents are already stopped, and the
    // updater's exit preparation may have hidden the window: show it again and
    // offer a restart into the current version.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    updates.set_phase(app, AppUpdatePhase::RestartRequired);
    Err(install_failure(installed).into())
}

/// Linux and macOS: replacing the AppImage or app bundle does not affect the
/// running process, so agents stop only after the files were replaced.
#[cfg(not(windows))]
async fn install_downloaded<R: Runtime>(
    app: &AppHandle<R>,
    updates: &AppUpdateState,
    update: Update,
    bytes: Vec<u8>,
) -> Result<AppUpdateStatusV1, AppUpdateError> {
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    if !matches!(installed, Ok(Ok(()))) {
        updates.set_phase(app, AppUpdatePhase::Idle);
        return Err(install_failure(installed).into());
    }
    updates.lock().phase = AppUpdatePhase::Restarting;
    let status = updates.publish(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        stop_native_runtimes(&app).await;
        app.request_restart();
    });
    Ok(status)
}

fn install_failure(
    installed: tauri::Result<Result<(), tauri_plugin_updater::Error>>,
) -> AppUpdateErrorCode {
    match installed {
        Ok(Err(error)) => classify(&error, Stage::Install),
        _ => AppUpdateErrorCode::InstallFailed,
    }
}

/// The quit sequence without exiting: refuse new native work, stop running
/// script steps' process trees and every native runtime.
async fn stop_native_runtimes<R: Runtime>(app: &AppHandle<R>) {
    let Some(host) = app.try_state::<HostState>() else {
        return;
    };
    if host.begin_shutdown() {
        if let Some(scheduler) = app.try_state::<OrchestrationScheduler>() {
            scheduler.begin_shutdown();
        }
        crate::api::shutdown_application_runtimes(&host).await;
        host.finish_shutdown();
    }
}

pub fn set_auto_check<R: Runtime>(
    app: &AppHandle<R>,
    updates: &AppUpdateState,
    enabled: bool,
) -> Result<AppUpdateStatusV1, AppUpdateError> {
    if updates.gate.is_none() {
        return Err(AppUpdateErrorCode::NotConfigured.into());
    }
    {
        let mut inner = updates.lock();
        if inner.auto_check != enabled {
            save_auto_check(&updates.settings_path, enabled)
                .map_err(|_| AppUpdateErrorCode::SettingsFailed)?;
            inner.auto_check = enabled;
        }
    }
    if enabled {
        updates.wake.notify_one();
    }
    Ok(updates.publish(app))
}

pub fn load_auto_check(path: &Path) -> bool {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StoredSettings>(&bytes).ok())
        .is_some_and(|settings| settings.version == SETTINGS_VERSION && settings.auto_check)
}

/// Writes a complete sibling file, flushes it and renames it over the
/// previous one, so a failed write keeps the earlier preference.
pub fn save_auto_check(path: &Path, auto_check: bool) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(&StoredSettings {
        version: SETTINGS_VERSION,
        auto_check,
    })
    .map_err(io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// Current update state; never touches the network.
#[tauri::command]
pub fn app_update_status_v1<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, AppUpdateState>,
) -> AppUpdateStatusV1 {
    updates.status(&app)
}

/// One check requested by the person (Settings → About).
#[tauri::command]
pub async fn app_update_check_v1<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, AppUpdateState>,
) -> Result<AppUpdateStatusV1, AppUpdateError> {
    check(&app, &updates, false).await
}

/// Downloads, verifies and installs the confirmed version, then restarts.
#[tauri::command]
pub async fn app_update_install_v1<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, AppUpdateState>,
    request: AppUpdateInstallRequestV1,
) -> Result<AppUpdateStatusV1, AppUpdateError> {
    install_version(&app, &updates, &request.version).await
}

#[tauri::command]
pub fn app_update_set_auto_check_v1<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, AppUpdateState>,
    request: AppUpdateAutoCheckRequestV1,
) -> Result<AppUpdateStatusV1, AppUpdateError> {
    set_auto_check(&app, &updates, request.enabled)
}

/// Restarts into the current version after an install that could not start.
#[tauri::command]
pub fn app_update_restart_v1<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, AppUpdateState>,
) -> Result<(), AppUpdateError> {
    if updates.lock().phase != AppUpdatePhase::RestartRequired {
        return Err(AppUpdateErrorCode::Invalid.into());
    }
    app.request_restart();
    Ok(())
}

#[cfg(test)]
#[path = "app_update_tests.rs"]
mod tests;
