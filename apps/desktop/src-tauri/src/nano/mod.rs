//! The Nano account, the model relay, the `nano` harness launch and the Nano
//! Cloud window in the Rust host (ADR-047 to ADR-049).
//!
//! Everything secret stays here: tokens live in `piui-nano`, the relay key
//! goes from `NativeRuntimeConfig.nano` only into the environment of that
//! session's own Nano bridge process and from there into its Pi child (never
//! a bridge frame), and the WebView sees [`NanoAccountStatusV1`] and nothing
//! else.
//!
//! Safe mode makes no Nano network call: nothing is restored, no relay is
//! started, no Nano session launches, and every command except the status
//! and the local sign-out answers `safe-mode`. A signed-out application never
//! contacts a Nano server either: after first paint the host only reads the
//! credential store for a stored refresh token (`NanoAccount::restore`).

pub(crate) mod browser;
pub(crate) mod catalog;
pub(crate) mod cloud_window;
pub(crate) mod commands;
pub(crate) mod launch;
pub(crate) mod provider_commands;
mod provider_prompt;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use piui_nano::external_providers::ExternalProviderRegistry;
use piui_nano::status::{
    NanoAccountProtocolV1, NanoAccountStateV1, NanoAccountStatusV1, NanoServerInfoV1,
};
use piui_nano::{
    AccountGeneration, NANO_ACCOUNT_EVENT_V1, NanoAccount, NanoAccountEventV1, NanoConfig,
    NanoError, Relay,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Preferences file (selected workspace) in the app data folder.
pub(crate) const PREFS_FILE: &str = "nano-account-v1.json";
/// The first credential-store read waits until the window has painted.
const RESTORE_DELAY: Duration = Duration::from_millis(1500);
/// The only window that receives account events and may call app commands.
const MAIN_WINDOW: &str = "main";

/// The host's Nano state, managed as `Arc<NanoHost>`.
pub(crate) struct NanoHost {
    safe_mode: bool,
    /// The account, or why it could not be built (an unusable development
    /// issuer, no TLS client): every command then answers that error.
    account: Result<NanoAccount, NanoError>,
    /// The private Pi agent directory shared by all Nano sessions.
    agent_dir: PathBuf,
    /// The cloud window's WebView profile folder.
    cloud_profile_dir: PathBuf,
    /// Started by the first Nano launch; dropped with the application.
    relay: tokio::sync::OnceCell<Relay>,
    external_providers: Arc<ExternalProviderRegistry>,
    external_provider_prompt: tokio::sync::Mutex<()>,
    /// Fingerprint of the agent directory's current content.
    prepared: tokio::sync::Mutex<Option<String>>,
}

impl NanoHost {
    /// Builds the account without any network call or credential read.
    /// `memory_store_only` (E2E hosts) never touches the OS credential store.
    pub(crate) fn open(
        app_data_dir: &Path,
        cloud_profile_dir: PathBuf,
        safe_mode: bool,
        memory_store_only: bool,
        app_version: &str,
        allow_issuer_override: bool,
    ) -> Self {
        let account = NanoConfig::resolve(app_version, allow_issuer_override).and_then(|config| {
            let prefs = Some(app_data_dir.join(PREFS_FILE));
            if memory_store_only {
                NanoAccount::with_store(config, prefs, None)
            } else {
                NanoAccount::new(config, prefs)
            }
        });
        let provider_path = app_data_dir.join("nano-external-providers-v1.json");
        let external_providers = if memory_store_only {
            ExternalProviderRegistry::with_memory(provider_path)
        } else {
            ExternalProviderRegistry::new(provider_path)
        };
        Self {
            safe_mode,
            account,
            agent_dir: app_data_dir.join("nano").join("pi-agent"),
            cloud_profile_dir,
            relay: tokio::sync::OnceCell::new(),
            external_providers: Arc::new(external_providers),
            external_provider_prompt: tokio::sync::Mutex::new(()),
            prepared: tokio::sync::Mutex::new(None),
        }
    }

    /// The account, or the error that kept it from being built.
    pub(crate) fn account(&self) -> Result<&NanoAccount, NanoError> {
        self.account.as_ref().map_err(|error| *error)
    }

    /// The account for a command that needs the network or the relay: refused
    /// in safe mode.
    pub(crate) fn live_account(&self) -> Result<&NanoAccount, NanoError> {
        if self.safe_mode {
            return Err(NanoError::SafeMode);
        }
        self.account()
    }

    /// What the host last learned; never touches the network.
    pub(crate) fn status(&self) -> NanoAccountStatusV1 {
        match &self.account {
            Ok(account) => account.status(),
            Err(error) => unavailable_status(*error),
        }
    }

    /// The model catalog rows of the signed-in account (empty otherwise).
    pub(crate) fn catalog_models(
        &self,
    ) -> Vec<piui_runtime::workspace_runtime::NativeCatalogModel> {
        catalog::catalog_models(&self.status())
    }

    pub(crate) async fn external_catalog(
        &self,
    ) -> Vec<piui_runtime::workspace_runtime::NativeCatalogModel> {
        if self.safe_mode || !cfg!(windows) {
            return Vec::new();
        }
        let registry = self.external_providers.clone();
        let api_key_registry = registry.clone();
        let mut models: Vec<_> = tokio::task::spawn_blocking(move || {
            api_key_registry
                .available()
                .unwrap_or_default()
                .into_iter()
                .map(
                    |provider| piui_runtime::workspace_runtime::NativeCatalogModel {
                        provider: Some(provider.provider_id()),
                        id: provider.spec.model_id.clone(),
                        name: provider.spec.name,
                        thinking_levels: None,
                        supports_fast: false,
                    },
                )
                .collect()
        })
        .await
        .unwrap_or_default();
        if let Ok(status) = registry.chatgpt.status().await {
            models.extend(status.models.into_iter().map(|model| {
                piui_runtime::workspace_runtime::NativeCatalogModel {
                    provider: Some(piui_nano::openai_subscription::CHATGPT_PROVIDER_ID.to_owned()),
                    id: model.id,
                    name: model.name,
                    thinking_levels: None,
                    supports_fast: false,
                }
            }));
        }
        models
    }

    /// Narrows a live Nano session's model list to the modes the account may
    /// use now ([`catalog::retain_entitled`]).
    pub(crate) fn retain_entitled_models(
        &self,
        models: &mut Vec<piui_runtime::workspace_runtime::WorkspaceModel>,
        provider: &str,
    ) {
        catalog::retain_entitled(models, &self.status(), provider);
    }

    /// Whether the account can start a Nano session now (the harness list
    /// shows "sign in" otherwise).
    pub(crate) fn can_launch(&self) -> bool {
        !self.safe_mode && launch::launch_gate(&self.status()).is_some()
    }

    /// Whether plain-http loopback links may open in the system browser: only
    /// while a development issuer on a loopback host is configured.
    fn allow_loopback_http(&self) -> bool {
        self.account.as_ref().is_ok_and(|account| {
            let config = account.config();
            config.development && config.is_loopback()
        })
    }

    /// A host for tests: an account with no credential store and no prefs.
    #[cfg(test)]
    pub(crate) fn for_tests(app_data_dir: &Path, safe_mode: bool) -> Self {
        let account = NanoConfig::from_parts(None, "0.3.0")
            .and_then(|config| NanoAccount::with_store(config, None, None));
        Self {
            safe_mode,
            account,
            agent_dir: app_data_dir.join("nano").join("pi-agent"),
            cloud_profile_dir: app_data_dir.join("nano").join("cloud-profile"),
            relay: tokio::sync::OnceCell::new(),
            external_providers: Arc::new(ExternalProviderRegistry::with_memory(
                app_data_dir.join("nano-external-providers-v1.json"),
            )),
            external_provider_prompt: tokio::sync::Mutex::new(()),
            prepared: tokio::sync::Mutex::new(None),
        }
    }
}

/// The signed-out status shown when the account could not be built.
fn unavailable_status(error: NanoError) -> NanoAccountStatusV1 {
    NanoAccountStatusV1 {
        protocol: NanoAccountProtocolV1,
        revision: 1,
        state: NanoAccountStateV1::SignedOut,
        server: NanoServerInfoV1 {
            origin: piui_nano::wire::NANO_DEFAULT_ISSUER.to_owned(),
            development: false,
        },
        user: None,
        device: None,
        workspaces: Vec::new(),
        selected_workspace_id: None,
        entitlements: None,
        usage: None,
        capabilities: None,
        credential_store: None,
        busy: false,
        last_error: Some(error),
    }
}

/// Creates and manages the Nano host, forwards account changes to the main
/// window, and restores a stored session after first paint. Returns the host
/// so the workspace can launch Nano sessions through it.
pub(crate) fn install<R: Runtime>(
    app: &tauri::App<R>,
    app_data_dir: &Path,
    safe_mode: bool,
    e2e_isolated: bool,
) -> Arc<NanoHost> {
    let cloud_profile_dir = if e2e_isolated {
        app_data_dir.join("nano").join("cloud-profile")
    } else {
        app.path()
            .app_local_data_dir()
            .unwrap_or_else(|_| app_data_dir.to_path_buf())
            .join("nano-cloud")
    };
    let host = Arc::new(NanoHost::open(
        app_data_dir,
        cloud_profile_dir,
        safe_mode,
        e2e_isolated,
        env!("CARGO_PKG_VERSION"),
        cfg!(debug_assertions) || cfg!(feature = "e2e-webview-automation"),
    ));
    app.manage(Arc::clone(&host));
    spawn_status_forwarder(app.handle().clone(), Arc::clone(&host));
    if !safe_mode {
        let restoring = Arc::clone(&host);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(RESTORE_DELAY).await;
            if let Ok(account) = restoring.account() {
                account.restore().await;
            }
        });
    }
    host
}

/// Whether the cloud window must close and forget its browsing data between
/// two observed account states: on every entry into `signed-out` or
/// `expired` (from any state, including `offline` and `signing-in`) and on
/// every generation change (sign-out, expiry, a new sign-in that may be
/// another person's, a cancelled one). `signed-in` <-> `offline` keeps it.
/// The generation also catches changes the status watch coalesced, such as
/// sign-out followed by another sign-in.
fn cloud_custody_ended(
    previous: (AccountGeneration, NanoAccountStateV1),
    current: (AccountGeneration, NanoAccountStateV1),
) -> bool {
    let ended_state = |state| {
        matches!(
            state,
            NanoAccountStateV1::SignedOut | NanoAccountStateV1::Expired
        )
    };
    previous.0 != current.0 || (ended_state(current.1) && previous.1 != current.1)
}

/// Emits every published status to the main window as
/// `piui://nano-account-v1`, and closes the cloud window and forgets its
/// browsing data when the account's custody ends ([`cloud_custody_ended`]).
fn spawn_status_forwarder<R: Runtime>(app: AppHandle<R>, host: Arc<NanoHost>) {
    let Ok(account) = host.account() else {
        return;
    };
    let account = account.clone();
    let mut changes = account.subscribe();
    let mut previous = (account.generation(), changes.borrow_and_update().state);
    tauri::async_runtime::spawn(async move {
        while changes.changed().await.is_ok() {
            let status = changes.borrow_and_update().clone();
            let current = (account.generation(), status.state);
            if cloud_custody_ended(previous, current) {
                cloud_window::clear(&app, &host.cloud_profile_dir);
            }
            previous = current;
            let _ = app.emit_to(
                MAIN_WINDOW,
                NANO_ACCOUNT_EVENT_V1,
                NanoAccountEventV1::Status { status },
            );
        }
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const ACCOUNT_FIXTURES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../contracts/fixtures/nano-account-v1.json"
    ));

    /// One synthetic status of the shared contract fixtures.
    pub(crate) fn fixture_status(key: &str) -> NanoAccountStatusV1 {
        let all: serde_json::Value = serde_json::from_str(ACCOUNT_FIXTURES).expect("fixtures");
        serde_json::from_value(all[key].clone()).expect(key)
    }

    /// A fresh folder under the system temp directory.
    pub(crate) fn test_dir(purpose: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("piui-nano-{purpose}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("test dir");
        path
    }

    #[test]
    fn an_unusable_issuer_leaves_a_signed_out_status_with_the_error() {
        let host = NanoHost {
            account: NanoConfig::from_parts(Some("http://example.com"), "0.3.0")
                .and_then(|config| NanoAccount::with_store(config, None, None)),
            ..NanoHost::for_tests(Path::new("unused"), false)
        };
        let status = host.status();
        assert_eq!(status.state, NanoAccountStateV1::SignedOut);
        assert_eq!(status.last_error, Some(NanoError::Invalid));
        assert_eq!(status.server.origin, "https://nanoagents.ru");
        assert!(host.catalog_models().is_empty());
        assert!(!host.can_launch());
        assert_eq!(host.account().err(), Some(NanoError::Invalid));
    }

    #[test]
    fn the_cloud_window_ends_with_every_custody_change_only() {
        use NanoAccountStateV1::{Expired, Offline, SignedIn, SignedOut, SigningIn};
        let host = NanoHost::for_tests(Path::new("unused"), false);
        let account = host.account().expect("account");
        let one = account.generation();

        // signed-in <-> offline keeps the window and its data.
        assert!(!cloud_custody_ended((one, SignedIn), (one, Offline)));
        assert!(!cloud_custody_ended((one, Offline), (one, SignedIn)));
        assert!(!cloud_custody_ended((one, SignedIn), (one, SignedIn)));
        // Entering signed-out or expired from any state clears it.
        for previous in [SignedIn, Offline, SigningIn, Expired] {
            assert!(cloud_custody_ended((one, previous), (one, SignedOut)));
        }
        for previous in [SignedIn, Offline, SigningIn, SignedOut] {
            assert!(cloud_custody_ended((one, previous), (one, Expired)));
        }
        // A new generation clears it even when the watch coalesced the
        // sign-out away (signed-in, then signed-in as maybe someone else).
        account.cancel_sign_in();
        assert_eq!(account.generation(), one, "no sign-in to cancel");
        let two = bump(account);
        assert_ne!(one, two);
        assert!(cloud_custody_ended((one, SignedIn), (two, SignedIn)));
        assert!(cloud_custody_ended((one, Offline), (two, SigningIn)));
    }

    /// Ends the current generation without any network call.
    fn bump(account: &NanoAccount) -> AccountGeneration {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime
            .block_on(account.sign_out(false))
            .expect("local sign-out");
        account.generation()
    }

    #[test]
    fn a_fresh_host_is_signed_out_and_cannot_launch() {
        let directory = test_dir("fresh");
        let host = NanoHost::for_tests(&directory, false);
        assert_eq!(host.status().state, NanoAccountStateV1::SignedOut);
        assert!(!host.can_launch());
        assert!(!host.allow_loopback_http());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn the_agent_directory_is_private_to_the_app_data_folder() {
        let directory = test_dir("paths");
        let host = NanoHost::for_tests(&directory, false);
        assert_eq!(host.agent_dir, directory.join("nano").join("pi-agent"));
        assert!(host.agent_dir.is_absolute());
        let _ = std::fs::remove_dir_all(directory);
    }
}
