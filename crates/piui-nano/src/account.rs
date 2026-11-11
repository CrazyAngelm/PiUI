//! The Nano account: sign-in, token custody, workspace and entitlements.
//!
//! One [`NanoAccount`] (cheap to clone, `Arc`-shared) lives in the host. It
//! publishes every change as a [`NanoAccountStatusV1`] through a Tokio
//! `watch` channel; the host forwards those to the WebView as
//! `piui://nano-account-v1`. Tokens never leave this type: the access token
//! is in memory only, the refresh token is in the [`CredentialStore`].
//!
//! Background work is ordered by a *generation* counter: sign-in, cancel,
//! sign-out and expiry bump it, and every network result checks it before it
//! is applied, so a late answer never resurrects a signed-out account.
//! Authorized requests are bound to the generation they started in: a token
//! is handed out, and a 401 retried, only while that generation is current,
//! so a request of one account is never sent with the credentials of an
//! account signed in since. Relay sessions carry their generation
//! ([`AccountGeneration`]) for the same reason. Tokens the server issued but
//! a stale generation will not keep are revoked in the background.
//! Refresh-token rotation and credential-store writes are serialized by one
//! async lock, so a rotated token is always stored before its access token is
//! used and a sign-out can never be overtaken by a refresh.

use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use bytes::Bytes;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderValue};
use serde::de::DeserializeOwned;
use tokio::sync::{Mutex as AsyncMutex, oneshot, watch};
use url::Url;

use crate::config::NanoConfig;
use crate::discovery::{ServerDescription, discover, site_url};
use crate::error::NanoError;
use crate::loopback::{CallbackListener, SIGN_IN_TIMEOUT};
use crate::net::{
    API_TIMEOUT, DEVICE_HEADER, SESSION_HEADER, ServerFailure, build_client, json_answer,
};
use crate::oauth::{self, TokenFailure, TokenSet};
use crate::pkce::{PkcePair, random_bytes, random_token};
use crate::secret::SecretString;
use crate::status::{
    NanoAccountDeviceV1, NanoAccountProtocolV1, NanoAccountStateV1, NanoAccountStatusV1,
    NanoAccountUserV1, NanoAccountWorkspaceV1, NanoCredentialStoreV1, NanoLinkV1,
};
use crate::store::{CredentialStore, NanoPrefs, PrefsFile, TokenVault, default_os_store};
use crate::wire::{
    NanoCapabilitiesV1, NanoCloudLaunchV1, NanoDictationResultV1, NanoEntitlementsV1, NanoMeV1,
    NanoServerErrorCodeV1, NanoUsageV1,
};

/// Opens the authorization URL in the system browser. Runs on a blocking
/// thread; `Err(())` reports `browser-failed`.
pub type OpenBrowser = Box<dyn FnOnce(&Url) -> Result<(), ()> + Send + 'static>;

const DICTATION_TIMEOUT: Duration = Duration::from_secs(120);
const SIGN_OUT_NETWORK_TIMEOUT: Duration = Duration::from_secs(5);

/// The account generation a relay session, a launch or a request started
/// under (see the module documentation). It changes on sign-out, expiry and
/// when a new sign-in starts; work bound to an earlier generation is refused
/// with [`NanoError::SignInRequired`]. Opaque: compare with `==`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountGeneration(u64);

/// The host's Nano account. See the module documentation.
#[derive(Clone)]
pub struct NanoAccount {
    inner: Arc<Inner>,
}

struct Inner {
    config: NanoConfig,
    http: reqwest::Client,
    vault: Arc<TokenVault>,
    prefs: Option<PrefsFile>,
    state: Mutex<State>,
    status_tx: watch::Sender<NanoAccountStatusV1>,
    /// Single flight for token refresh and credential-store writes.
    token_lock: AsyncMutex<()>,
    /// One account/entitlement load at a time.
    load_lock: AsyncMutex<()>,
}

struct AccessToken {
    token: SecretString,
    refresh_at: Instant,
}

struct SignIn {
    /// Dropping the sender cancels the loopback wait.
    _cancel: oneshot::Sender<()>,
    previous: NanoAccountStateV1,
    /// Tokens were obtained; cancelling no longer reverts.
    exchanged: bool,
}

struct State {
    revision: u64,
    generation: u64,
    phase: NanoAccountStateV1,
    server: Option<Arc<ServerDescription>>,
    capabilities: Option<NanoCapabilitiesV1>,
    user: Option<NanoAccountUserV1>,
    device: Option<NanoAccountDeviceV1>,
    workspaces: Vec<NanoAccountWorkspaceV1>,
    selected: Option<String>,
    /// From the preferences file, for the first account load.
    preferred_workspace: Option<String>,
    entitlements: Option<NanoEntitlementsV1>,
    usage: Option<NanoUsageV1>,
    credential_store: Option<NanoCredentialStoreV1>,
    busy: u32,
    last_error: Option<NanoError>,
    refresh_token: Option<SecretString>,
    access: Option<AccessToken>,
    sign_in: Option<SignIn>,
}

impl State {
    fn forget_account(&mut self) {
        self.server = None;
        self.capabilities = None;
        self.device = None;
        self.workspaces.clear();
        self.selected = None;
        self.entitlements = None;
        self.usage = None;
        self.credential_store = None;
        self.refresh_token = None;
        self.access = None;
        self.sign_in = None;
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn snapshot(&self, s: &State) -> NanoAccountStatusV1 {
        NanoAccountStatusV1 {
            protocol: NanoAccountProtocolV1,
            revision: s.revision,
            state: s.phase,
            server: self.config.server_info(),
            user: s.user.clone(),
            device: s.device.clone(),
            workspaces: s.workspaces.clone(),
            selected_workspace_id: s.selected.clone(),
            entitlements: s.entitlements.clone(),
            usage: s.usage.clone(),
            capabilities: s.capabilities,
            credential_store: s.credential_store,
            busy: s.busy > 0 || s.phase == NanoAccountStateV1::SigningIn,
            last_error: s.last_error,
        }
    }

    /// Applies `change` and publishes the new status.
    fn mutate<R>(&self, change: impl FnOnce(&mut State) -> R) -> R {
        let mut s = self.lock();
        let result = change(&mut s);
        s.revision += 1;
        let status = self.snapshot(&s);
        self.status_tx.send_replace(status);
        result
    }
}

/// Marks the account busy while alive.
struct BusyGuard {
    inner: Arc<Inner>,
}

impl BusyGuard {
    fn new(inner: &Arc<Inner>) -> Self {
        inner.mutate(|s| s.busy += 1);
        Self {
            inner: inner.clone(),
        }
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.inner.mutate(|s| s.busy = s.busy.saturating_sub(1));
    }
}

impl fmt::Debug for NanoAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = self.inner.lock();
        f.debug_struct("NanoAccount")
            .field("origin", &self.inner.config.origin())
            .field("state", &s.phase)
            .field("revision", &s.revision)
            .finish_non_exhaustive()
    }
}

impl NanoAccount {
    /// An account using the platform's OS credential store (memory-only
    /// where there is none) and the preferences file at `prefs_path`.
    ///
    /// Constructing makes no network call and reads no credential; call
    /// [`NanoAccount::restore`] after first paint.
    ///
    /// # Errors
    /// [`NanoError::Offline`] when the TLS client cannot be built.
    pub fn new(config: NanoConfig, prefs_path: Option<PathBuf>) -> Result<Self, NanoError> {
        let store = default_os_store(&config.origin());
        Self::with_store(config, prefs_path, store)
    }

    /// An account with an explicit persistent store; `None` keeps the
    /// refresh token in memory only.
    ///
    /// # Errors
    /// [`NanoError::Offline`] when the TLS client cannot be built.
    pub fn with_store(
        config: NanoConfig,
        prefs_path: Option<PathBuf>,
        store: Option<Arc<dyn CredentialStore>>,
    ) -> Result<Self, NanoError> {
        let http = build_client(&config)?;
        let prefs = prefs_path.map(PrefsFile::new);
        let preferred_workspace = prefs.as_ref().and_then(|file| {
            let stored = file.load();
            (stored.issuer.as_deref() == Some(config.origin().as_str()))
                .then_some(stored.selected_workspace_id)
                .flatten()
        });
        let state = State {
            revision: 1,
            generation: 0,
            phase: NanoAccountStateV1::SignedOut,
            server: None,
            capabilities: None,
            user: None,
            device: None,
            workspaces: Vec::new(),
            selected: None,
            preferred_workspace,
            entitlements: None,
            usage: None,
            credential_store: None,
            busy: 0,
            last_error: None,
            refresh_token: None,
            access: None,
            sign_in: None,
        };
        let initial = NanoAccountStatusV1 {
            protocol: NanoAccountProtocolV1,
            revision: 1,
            state: NanoAccountStateV1::SignedOut,
            server: config.server_info(),
            user: None,
            device: None,
            workspaces: Vec::new(),
            selected_workspace_id: None,
            entitlements: None,
            usage: None,
            capabilities: None,
            credential_store: None,
            busy: false,
            last_error: None,
        };
        let (status_tx, _) = watch::channel(initial);
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                http,
                vault: Arc::new(TokenVault::new(store)),
                prefs,
                state: Mutex::new(state),
                status_tx,
                token_lock: AsyncMutex::new(()),
                load_lock: AsyncMutex::new(()),
            }),
        })
    }

    /// The configuration.
    pub fn config(&self) -> &NanoConfig {
        &self.inner.config
    }

    /// What the host last learned; never touches the network.
    pub fn status(&self) -> NanoAccountStatusV1 {
        self.inner.status_tx.borrow().clone()
    }

    /// Every published status, starting with the current one.
    pub fn subscribe(&self) -> watch::Receiver<NanoAccountStatusV1> {
        self.inner.status_tx.subscribe()
    }

    /// The current account generation.
    pub fn generation(&self) -> AccountGeneration {
        AccountGeneration(self.current_generation())
    }

    /// The status and the generation it belongs to, read together: gate a
    /// launch on this status and bind what it registers to this generation.
    pub fn status_with_generation(&self) -> (AccountGeneration, NanoAccountStatusV1) {
        let s = self.inner.lock();
        (AccountGeneration(s.generation), self.inner.snapshot(&s))
    }

    fn current_generation(&self) -> u64 {
        self.inner.lock().generation
    }

    fn ensure_generation(&self, generation: u64) -> Result<(), NanoError> {
        if self.current_generation() == generation {
            Ok(())
        } else {
            Err(NanoError::SignInCancelled)
        }
    }

    // -----------------------------------------------------------------------
    // Restore and refresh
    // -----------------------------------------------------------------------

    /// Restores a stored session in the background after first paint: loads
    /// the refresh token, refreshes it, then loads the account and the
    /// selected workspace's entitlements. Without a stored token nothing
    /// contacts the server. A network failure leaves `offline`; a refused
    /// token leaves `expired` and deletes it.
    pub async fn restore(&self) {
        let _load = self.inner.load_lock.lock().await;
        let generation = {
            let s = self.inner.lock();
            if s.phase != NanoAccountStateV1::SignedOut
                || s.sign_in.is_some()
                || s.refresh_token.is_some()
            {
                return;
            }
            s.generation
        };
        let _busy = BusyGuard::new(&self.inner);
        let vault = self.inner.vault.clone();
        let (token, kind) = match tokio::task::spawn_blocking(move || vault.load()).await {
            Ok(Ok(Some(found))) => found,
            Ok(Ok(None)) => return,
            Ok(Err(error)) => {
                self.inner.mutate(|s| s.last_error = Some(error));
                return;
            }
            Err(_) => {
                self.inner
                    .mutate(|s| s.last_error = Some(NanoError::CredentialStoreFailed));
                return;
            }
        };
        let adopted = self.inner.mutate(|s| {
            if s.generation != generation || s.phase != NanoAccountStateV1::SignedOut {
                return false;
            }
            s.refresh_token = Some(token);
            s.credential_store = Some(kind);
            s.phase = NanoAccountStateV1::Offline;
            true
        });
        if adopted && let Err(error) = self.connect(generation).await {
            self.record_failure(generation, error);
        }
    }

    /// Reloads the account and entitlements (`nano_account_refresh_v1`).
    /// From `offline` or `unsupported` it rediscovers the server first.
    ///
    /// # Errors
    /// [`NanoError::SignInRequired`] when signed out or expired,
    /// [`NanoError::Busy`] while another load or a sign-in runs, else the
    /// failure (also recorded in `lastError`).
    pub async fn refresh(&self) -> Result<NanoAccountStatusV1, NanoError> {
        let Ok(_load) = self.inner.load_lock.try_lock() else {
            return Err(NanoError::Busy);
        };
        let (phase, generation) = {
            let s = self.inner.lock();
            (s.phase, s.generation)
        };
        match phase {
            NanoAccountStateV1::SignedOut | NanoAccountStateV1::Expired => {
                return Err(NanoError::SignInRequired);
            }
            NanoAccountStateV1::SigningIn => return Err(NanoError::Busy),
            NanoAccountStateV1::Offline | NanoAccountStateV1::Unsupported => {
                self.inner.mutate(|s| s.server = None);
            }
            NanoAccountStateV1::SignedIn => {}
        }
        let result = {
            let _busy = BusyGuard::new(&self.inner);
            self.connect(generation).await
        };
        match result {
            Ok(()) => Ok(self.status()),
            Err(error) => {
                self.record_failure(generation, error);
                Err(error)
            }
        }
    }

    async fn connect(&self, generation: u64) -> Result<(), NanoError> {
        self.server().await?;
        self.ensure_access_token(generation, None).await?;
        self.load_account(generation).await
    }

    /// The validated server, discovering it when not known yet.
    async fn server(&self) -> Result<Arc<ServerDescription>, NanoError> {
        let cached = self.inner.lock().server.clone();
        if let Some(server) = cached {
            return Ok(server);
        }
        let server = Arc::new(discover(&self.inner.http, &self.inner.config).await?);
        self.inner.mutate(|s| {
            s.capabilities = Some(server.meta.capabilities);
            s.server = Some(server.clone());
        });
        Ok(server)
    }

    fn record_failure(&self, generation: u64, error: NanoError) {
        self.inner.mutate(|s| {
            if s.generation != generation {
                return;
            }
            match error {
                NanoError::UnsupportedServer | NanoError::ClientTooOld => {
                    s.phase = NanoAccountStateV1::Unsupported;
                    s.sign_in = None;
                }
                NanoError::Offline if s.refresh_token.is_some() => {
                    s.phase = NanoAccountStateV1::Offline;
                    s.sign_in = None;
                }
                _ => {}
            }
            s.last_error = Some(error);
        });
    }

    async fn load_account(&self, generation: u64) -> Result<(), NanoError> {
        let _busy = BusyGuard::new(&self.inner);
        let me: NanoMeV1 = self
            .get_json(generation, self.inner.config.api_url(&["me"]))
            .await?;
        let preferred = {
            let s = self.inner.lock();
            s.selected.clone().or_else(|| s.preferred_workspace.clone())
        };
        let selected = preferred
            .filter(|id| me.workspaces.iter().any(|workspace| &workspace.id == id))
            .or_else(|| me.workspaces.first().map(|workspace| workspace.id.clone()));
        let applied = self.inner.mutate(|s| {
            if s.generation != generation {
                return false;
            }
            if s.selected != selected {
                s.entitlements = None;
                s.usage = None;
            }
            s.phase = NanoAccountStateV1::SignedIn;
            s.sign_in = None;
            s.last_error = None;
            s.user = Some(NanoAccountUserV1 {
                display_name: me.user.display_name.clone(),
                email: me.user.email.clone(),
            });
            s.device = Some(NanoAccountDeviceV1 {
                id: me.device.id.clone(),
                name: me.device.name.clone(),
            });
            s.workspaces = me
                .workspaces
                .iter()
                .map(|workspace| NanoAccountWorkspaceV1 {
                    id: workspace.id.clone(),
                    name: workspace.name.clone(),
                    role: workspace.role,
                })
                .collect();
            s.selected = selected.clone();
            true
        });
        if !applied {
            return Ok(());
        }
        self.save_prefs(selected.clone());
        match selected {
            Some(workspace) => self.load_entitlements(generation, &workspace).await,
            None => Ok(()),
        }
    }

    async fn load_entitlements(&self, generation: u64, workspace: &str) -> Result<(), NanoError> {
        let _busy = BusyGuard::new(&self.inner);
        let config = &self.inner.config;
        let entitlements: NanoEntitlementsV1 = self
            .get_json(
                generation,
                config.api_url(&["workspaces", workspace, "entitlements"]),
            )
            .await?;
        entitlements.validate()?;
        if entitlements.workspace_id != workspace {
            return Err(NanoError::UnsupportedServer);
        }
        let current =
            |s: &State| s.generation == generation && s.selected.as_deref() == Some(workspace);
        self.inner.mutate(|s| {
            if current(s) {
                s.entitlements = Some(entitlements);
            }
        });
        if let Ok(usage) = self
            .get_json::<NanoUsageV1>(
                generation,
                config.api_url(&["workspaces", workspace, "usage"]),
            )
            .await
        {
            self.inner.mutate(|s| {
                if current(s) {
                    s.usage = Some(usage);
                }
            });
        }
        Ok(())
    }

    fn save_prefs(&self, selected: Option<String>) {
        if let Some(file) = &self.inner.prefs {
            let prefs = NanoPrefs {
                issuer: Some(self.inner.config.origin()),
                selected_workspace_id: selected.clone(),
            };
            // Preferences are a convenience; a failed write changes nothing else.
            let _ = file.save(&prefs);
        }
        self.inner.lock().preferred_workspace = selected;
    }

    // -----------------------------------------------------------------------
    // Tokens
    // -----------------------------------------------------------------------

    /// A valid access token, refreshed at 80 % of its lifetime (single
    /// flight). Only the relay and media calls need it; never pass it to the
    /// WebView, a bridge or a native runtime.
    ///
    /// # Errors
    /// [`NanoError::SignInRequired`] without a usable credential,
    /// [`NanoError::Offline`] when the server cannot be reached.
    pub async fn access_token(&self) -> Result<SecretString, NanoError> {
        self.ensure_access_token(self.current_generation(), None)
            .await
    }

    /// The cached access token of `generation`, `Ok(None)` when it must be
    /// refreshed, [`NanoError::SignInRequired`] when the generation is over.
    fn current_access(
        &self,
        generation: u64,
        rejected: Option<&SecretString>,
    ) -> Result<Option<SecretString>, NanoError> {
        let s = self.inner.lock();
        if s.generation != generation {
            return Err(NanoError::SignInRequired);
        }
        let Some(access) = s.access.as_ref() else {
            return Ok(None);
        };
        if Instant::now() >= access.refresh_at || rejected.is_some_and(|r| *r == access.token) {
            return Ok(None);
        }
        Ok(Some(access.token.clone()))
    }

    /// A valid access token of `generation` (never of a later one).
    async fn ensure_access_token(
        &self,
        generation: u64,
        rejected: Option<&SecretString>,
    ) -> Result<SecretString, NanoError> {
        if let Some(token) = self.current_access(generation, rejected)? {
            return Ok(token);
        }
        let _flight = self.inner.token_lock.lock().await;
        if let Some(token) = self.current_access(generation, rejected)? {
            return Ok(token);
        }
        let refresh_token = {
            let s = self.inner.lock();
            if s.generation != generation {
                return Err(NanoError::SignInRequired);
            }
            match (s.phase, &s.refresh_token) {
                (NanoAccountStateV1::SignedOut | NanoAccountStateV1::Expired, _) | (_, None) => {
                    return Err(NanoError::SignInRequired);
                }
                (_, Some(token)) => token.clone(),
            }
        };
        let server = self.server().await?;
        match oauth::refresh(
            &self.inner.http,
            &server,
            &self.inner.config,
            &refresh_token,
        )
        .await
        {
            Ok(tokens) => self.adopt_tokens_locked(generation, &server, tokens).await,
            Err(TokenFailure::Rejected) => {
                self.expire_locked(generation, NanoError::SignInRequired)
                    .await;
                Err(NanoError::SignInRequired)
            }
            Err(TokenFailure::Offline) => Err(NanoError::Offline),
            Err(TokenFailure::Server(error)) => Err(error),
        }
    }

    /// Stores the rotated refresh token, then adopts the access token.
    /// The caller holds `token_lock`. When `generation` is over (signed out
    /// or cancelled meanwhile) the new tokens are not kept and their refresh
    /// token is revoked, so no orphan device stays on the server.
    async fn adopt_tokens_locked(
        &self,
        generation: u64,
        server: &Arc<ServerDescription>,
        tokens: TokenSet,
    ) -> Result<SecretString, NanoError> {
        if self.current_generation() != generation {
            self.revoke_in_background(server.clone(), tokens.refresh_token);
            return Err(NanoError::SignInRequired);
        }
        let vault = self.inner.vault.clone();
        let rotated = tokens.refresh_token.clone();
        let kind = tokio::task::spawn_blocking(move || vault.save(&rotated))
            .await
            .unwrap_or(NanoCredentialStoreV1::Memory);
        let access = tokens.access_token.clone();
        let TokenSet {
            access_token,
            refresh_token,
            expires_in,
        } = tokens;
        let unadopted = refresh_token.clone();
        let adopted = self.inner.mutate(|s| {
            if s.generation != generation {
                return false;
            }
            s.refresh_token = Some(refresh_token);
            s.credential_store = Some(kind);
            s.access = Some(AccessToken {
                token: access_token,
                refresh_at: Instant::now() + expires_in * 4 / 5,
            });
            true
        });
        if adopted {
            Ok(access)
        } else {
            // Signed out while the token was being stored: forget it again.
            let _ = self.delete_stored().await;
            self.revoke_in_background(server.clone(), unadopted);
            Err(NanoError::SignInRequired)
        }
    }

    /// Revokes a refresh token the server issued that this account does not
    /// keep (a sign-in cancelled during the code exchange, a sign-out during a
    /// refresh). Best effort, in the background; the token is never stored
    /// or logged.
    fn revoke_in_background(&self, server: Arc<ServerDescription>, token: SecretString) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let account = self.clone();
        runtime.spawn(async move {
            account.revoke_best_effort(Some(server), &token).await;
        });
    }

    async fn delete_stored(&self) -> Result<(), NanoError> {
        let vault = self.inner.vault.clone();
        tokio::task::spawn_blocking(move || vault.delete())
            .await
            .unwrap_or(Err(NanoError::CredentialStoreFailed))
    }

    async fn expire(&self, generation: u64, error: NanoError) {
        let _flight = self.inner.token_lock.lock().await;
        self.expire_locked(generation, error).await;
    }

    /// The server refused the credential: `expired`, token deleted, the user
    /// name kept for the sign-in prompt. The caller holds `token_lock`.
    async fn expire_locked(&self, generation: u64, error: NanoError) {
        let expired = self.inner.mutate(|s| {
            if s.generation != generation {
                return false;
            }
            s.generation += 1;
            s.forget_account();
            s.phase = NanoAccountStateV1::Expired;
            s.last_error = Some(error);
            true
        });
        if expired {
            // A stale token left behind is refused again on the next restore.
            let _ = self.delete_stored().await;
        }
    }

    /// Sends an authorized request of `generation` built by `build` (called
    /// with the access token). A 401 refreshes once and retries; a second 401
    /// or `device_revoked` expires the account. Other statuses are returned.
    /// The token is obtained, and the retry made, only while `generation` is
    /// current: once the account signed out or a new sign-in started, the
    /// request fails with [`NanoError::SignInRequired`] and is never sent with
    /// another account's credentials.
    pub(crate) async fn send_authorized<F>(
        &self,
        generation: u64,
        build: F,
    ) -> Result<reqwest::Response, NanoError>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        let token = self.ensure_access_token(generation, None).await?;
        let response = build(&self.inner.http, token.expose())
            .send()
            .await
            .map_err(|_| NanoError::Offline)?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        if ServerFailure::read(response).await.code == Some(NanoServerErrorCodeV1::DeviceRevoked) {
            self.expire(generation, NanoError::DeviceRevoked).await;
            return Err(NanoError::DeviceRevoked);
        }
        let token = self.ensure_access_token(generation, Some(&token)).await?;
        let response = build(&self.inner.http, token.expose())
            .send()
            .await
            .map_err(|_| NanoError::Offline)?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        let error = if ServerFailure::read(response).await.code
            == Some(NanoServerErrorCodeV1::DeviceRevoked)
        {
            NanoError::DeviceRevoked
        } else {
            NanoError::SignInRequired
        };
        self.expire(generation, error).await;
        Err(error)
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        generation: u64,
        url: Url,
    ) -> Result<T, NanoError> {
        let response = self
            .send_authorized(generation, |http, token| {
                http.get(url.clone())
                    .bearer_auth(token)
                    .header(ACCEPT, "application/json")
                    .timeout(API_TIMEOUT)
            })
            .await?;
        json_answer(response).await
    }

    /// Forwards a gateway request of a relay session bound to `generation`
    /// for the selected workspace:
    /// `{issuer}/api/desktop/v1/workspaces/{id}/gateway/v1/{leaf...}`, with
    /// `X-Nano-Device` (this device's id) and `X-Nano-Session` (`session`,
    /// the relay session's opaque tag). Neither is a credential.
    pub(crate) async fn send_gateway(
        &self,
        generation: AccountGeneration,
        session: &str,
        leaf: &[&str],
        method: reqwest::Method,
        body: Option<Bytes>,
        accept: Option<HeaderValue>,
    ) -> Result<reqwest::Response, NanoError> {
        let (workspace, device) = {
            let s = self.inner.lock();
            if s.generation != generation.0 {
                return Err(NanoError::SignInRequired);
            }
            let workspace = s.selected.clone().ok_or(NanoError::SignInRequired)?;
            let device = s
                .device
                .as_ref()
                .and_then(|device| HeaderValue::from_str(&device.id).ok());
            (workspace, device)
        };
        let session = HeaderValue::from_str(session).ok();
        let mut segments = vec!["workspaces", workspace.as_str(), "gateway", "v1"];
        segments.extend_from_slice(leaf);
        let url = self.inner.config.api_url(&segments);
        self.send_authorized(generation.0, |http, token| {
            let mut request = http.request(method.clone(), url.clone()).bearer_auth(token);
            if let Some(device) = &device {
                request = request.header(DEVICE_HEADER, device.clone());
            }
            if let Some(session) = &session {
                request = request.header(SESSION_HEADER, session.clone());
            }
            if let Some(accept) = &accept {
                request = request.header(ACCEPT, accept.clone());
            }
            if let Some(body) = &body {
                request = request
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.clone());
            }
            request
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Sign-in and sign-out
    // -----------------------------------------------------------------------

    /// Starts sign-in and answers at once with `signing-in`. A spawned task
    /// discovers the server, binds the loopback listener, calls
    /// `open_browser` with the authorization URL, waits up to five minutes
    /// for the callback, exchanges the code, stores the refresh token and
    /// loads the account. The outcome arrives as a published status.
    ///
    /// # Errors
    /// [`NanoError::Busy`] while a sign-in runs, [`NanoError::Invalid`] when
    /// already signed in.
    pub async fn begin_sign_in(
        &self,
        open_browser: OpenBrowser,
    ) -> Result<NanoAccountStatusV1, NanoError> {
        let (generation, cancel) = {
            let s = self.inner.lock();
            if s.sign_in.is_some() || s.phase == NanoAccountStateV1::SigningIn {
                return Err(NanoError::Busy);
            }
            if s.phase == NanoAccountStateV1::SignedIn {
                return Err(NanoError::Invalid);
            }
            drop(s);
            let (tx, rx) = oneshot::channel();
            let generation = self.inner.mutate(|s| {
                s.generation += 1;
                s.sign_in = Some(SignIn {
                    _cancel: tx,
                    previous: s.phase,
                    exchanged: false,
                });
                s.phase = NanoAccountStateV1::SigningIn;
                s.last_error = None;
                s.generation
            });
            (generation, rx)
        };
        let account = self.clone();
        tokio::spawn(async move {
            if let Err(error) = account.sign_in_flow(generation, cancel, open_browser).await {
                account.finish_sign_in_failure(generation, error);
            }
        });
        Ok(self.status())
    }

    async fn sign_in_flow(
        &self,
        generation: u64,
        cancel: oneshot::Receiver<()>,
        open_browser: OpenBrowser,
    ) -> Result<(), NanoError> {
        let server = self.server().await?;
        self.ensure_generation(generation)?;
        let listener = CallbackListener::bind().await?;
        let pkce = PkcePair::generate()?;
        let state = random_token()?;
        let redirect_uri = listener.redirect_uri();
        let url = oauth::authorization_url(
            &server,
            &self.inner.config.client_id,
            &redirect_uri,
            &pkce.challenge,
            &state,
        );
        let opened = tokio::task::spawn_blocking(move || open_browser(&url)).await;
        if !matches!(opened, Ok(Ok(()))) {
            return Err(NanoError::BrowserFailed);
        }
        let cancelled = async move {
            let _ = cancel.await;
        };
        let code = listener
            .wait(&state, &server.issuer, SIGN_IN_TIMEOUT, cancelled)
            .await?;
        self.ensure_generation(generation)?;
        let tokens = oauth::exchange_code(
            &self.inner.http,
            &server,
            &self.inner.config,
            &code.0,
            &pkce.verifier,
            &redirect_uri,
        )
        .await
        .map_err(TokenFailure::sign_in_error)?;
        {
            let _flight = self.inner.token_lock.lock().await;
            let current = self.inner.mutate(|s| {
                if s.generation != generation {
                    return false;
                }
                if let Some(sign_in) = s.sign_in.as_mut() {
                    sign_in.exchanged = true;
                }
                true
            });
            if !current {
                // Cancelled while the code was being exchanged: the server
                // already created a device for these tokens. Revoke it rather
                // than leave an orphan; the tokens are never stored.
                self.revoke_in_background(server.clone(), tokens.refresh_token);
                return Err(NanoError::SignInCancelled);
            }
            self.adopt_tokens_locked(generation, &server, tokens)
                .await?;
        }
        self.load_account(generation).await
    }

    fn finish_sign_in_failure(&self, generation: u64, error: NanoError) {
        self.inner.mutate(|s| {
            if s.generation != generation {
                return;
            }
            let previous = s.sign_in.take().map(|sign_in| sign_in.previous);
            if s.phase == NanoAccountStateV1::SigningIn {
                s.phase = match error {
                    NanoError::UnsupportedServer | NanoError::ClientTooOld => {
                        NanoAccountStateV1::Unsupported
                    }
                    _ if s.refresh_token.is_some() => NanoAccountStateV1::Offline,
                    _ if previous == Some(NanoAccountStateV1::Expired) => {
                        NanoAccountStateV1::Expired
                    }
                    _ => NanoAccountStateV1::SignedOut,
                };
            }
            s.last_error = Some(error);
        });
    }

    /// Cancels a sign-in that has not obtained tokens yet and restores the
    /// previous state. Without one it changes nothing.
    pub fn cancel_sign_in(&self) -> NanoAccountStatusV1 {
        self.inner.mutate(|s| {
            if s.sign_in.as_ref().is_some_and(|sign_in| !sign_in.exchanged)
                && let Some(sign_in) = s.sign_in.take()
            {
                s.generation += 1;
                s.phase = sign_in.previous;
                s.last_error = None;
            }
        });
        self.status()
    }

    /// Signs out: forgets everything in memory at once, revokes the refresh
    /// token when `network` (best effort, five seconds), and deletes it from
    /// the credential store. With `network == false` (safe mode) nothing
    /// contacts the server.
    ///
    /// # Errors
    /// [`NanoError::CredentialStoreFailed`] when the stored token could not
    /// be deleted; the account is signed out in memory regardless.
    pub async fn sign_out(&self, network: bool) -> Result<NanoAccountStatusV1, NanoError> {
        let (refresh_token, server) = self.inner.mutate(|s| {
            let token = s.refresh_token.take();
            let server = s.server.take();
            s.generation += 1;
            s.forget_account();
            s.phase = NanoAccountStateV1::SignedOut;
            s.user = None;
            s.last_error = None;
            (token, server)
        });
        if network {
            let refresh_token = match refresh_token {
                Some(token) => Some(token),
                None => {
                    let vault = self.inner.vault.clone();
                    tokio::task::spawn_blocking(move || vault.load())
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .flatten()
                        .map(|(token, _)| token)
                }
            };
            if let Some(token) = refresh_token {
                self.revoke_best_effort(server, &token).await;
            }
        }
        let deleted = {
            let _flight = self.inner.token_lock.lock().await;
            self.delete_stored().await
        };
        self.save_prefs(None);
        match deleted {
            Ok(()) => Ok(self.status()),
            Err(error) => {
                self.inner.mutate(|s| s.last_error = Some(error));
                Err(error)
            }
        }
    }

    async fn revoke_best_effort(
        &self,
        server: Option<Arc<ServerDescription>>,
        token: &SecretString,
    ) {
        let config = &self.inner.config;
        let http = &self.inner.http;
        let attempt = async {
            let server = match server {
                Some(server) => server,
                None => Arc::new(discover(http, config).await?),
            };
            oauth::revoke(http, &server, config, token).await
        };
        let _ = tokio::time::timeout(SIGN_OUT_NETWORK_TIMEOUT, attempt).await;
    }

    // -----------------------------------------------------------------------
    // Workspace, links, media
    // -----------------------------------------------------------------------

    /// Selects a workspace of the signed-in account, remembers it and loads
    /// its entitlements in the background.
    ///
    /// # Errors
    /// [`NanoError::SignInRequired`] unless signed in,
    /// [`NanoError::WorkspaceNotFound`] for an id not in `workspaces`.
    pub async fn select_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<NanoAccountStatusV1, NanoError> {
        {
            let s = self.inner.lock();
            if s.phase != NanoAccountStateV1::SignedIn {
                return Err(NanoError::SignInRequired);
            }
            if !s
                .workspaces
                .iter()
                .any(|workspace| workspace.id == workspace_id)
            {
                return Err(NanoError::WorkspaceNotFound);
            }
            if s.selected.as_deref() == Some(workspace_id) {
                drop(s);
                return Ok(self.status());
            }
        }
        let generation = self.inner.mutate(|s| {
            s.selected = Some(workspace_id.to_owned());
            s.entitlements = None;
            s.usage = None;
            s.generation
        });
        self.save_prefs(Some(workspace_id.to_owned()));
        let account = self.clone();
        let workspace = workspace_id.to_owned();
        tokio::spawn(async move {
            let _load = account.inner.load_lock.lock().await;
            if let Err(error) = account.load_entitlements(generation, &workspace).await {
                account.record_failure(generation, error);
            }
        });
        Ok(self.status())
    }

    /// A page of the Nano site for the system browser. While the server is
    /// not known yet (signed out), the sign-up page is the fixed issuer path
    /// `/signup` so nothing contacts the server (ADR-047); other links
    /// discover the server first.
    ///
    /// # Errors
    /// The discovery failure.
    pub async fn link(&self, link: NanoLinkV1) -> Result<Url, NanoError> {
        if link == NanoLinkV1::Signup && self.inner.lock().server.is_none() {
            return self
                .inner
                .config
                .issuer
                .join("signup")
                .map_err(|_| NanoError::Invalid);
        }
        let server = self.server().await?;
        Ok(match link {
            NanoLinkV1::Billing => server.links.billing.clone(),
            NanoLinkV1::Devices => server.links.devices.clone(),
            NanoLinkV1::Signup => server.links.signup.clone(),
        })
    }

    /// The URL of the cloud window: a one-time launch URL when the server
    /// offers `cloudLaunch` and a workspace is selected, else `links.cloud`
    /// (the user signs in there as on the website).
    ///
    /// # Errors
    /// [`NanoError::SignInRequired`] unless signed in (a signed-out account
    /// contacts no Nano server), else the discovery failure.
    pub async fn cloud_url(&self) -> Result<Url, NanoError> {
        let generation = {
            let s = self.inner.lock();
            if s.phase != NanoAccountStateV1::SignedIn {
                return Err(NanoError::SignInRequired);
            }
            s.generation
        };
        let server = self.server().await?;
        let workspace = {
            let s = self.inner.lock();
            let cloud_allowed = s.entitlements.as_ref().is_none_or(|e| e.features.cloud);
            (server.meta.capabilities.cloud_launch
                && s.generation == generation
                && s.phase == NanoAccountStateV1::SignedIn
                && cloud_allowed)
                .then(|| s.selected.clone())
                .flatten()
        };
        if let Some(workspace) = workspace {
            let url = self
                .inner
                .config
                .api_url(&["workspaces", &workspace, "cloud", "launch"]);
            let launched = self
                .send_authorized(generation, |http, token| {
                    http.post(url.clone())
                        .bearer_auth(token)
                        .header(ACCEPT, "application/json")
                        .timeout(API_TIMEOUT)
                })
                .await;
            if let Ok(response) = launched
                && let Ok(launch) = json_answer::<NanoCloudLaunchV1>(response).await
                && let Ok(url) = site_url(&self.inner.config, &launch.url)
            {
                return Ok(url);
            }
        }
        Ok(server.links.cloud.clone())
    }

    /// Transcribes one audio recording of the selected workspace.
    ///
    /// # Errors
    /// [`NanoError::SignInRequired`] unless signed in,
    /// [`NanoError::FeatureUnavailable`] when the server or plan has no
    /// dictation, [`NanoError::Invalid`] for an empty, oversized or
    /// non-audio input, else the server refusal.
    pub async fn dictate(
        &self,
        audio: Vec<u8>,
        mime: &str,
    ) -> Result<NanoDictationResultV1, NanoError> {
        // The recording belongs to the account signed in now: the request is
        // bound to this generation and never retried with a later account's
        // credentials.
        let (workspace, generation) = {
            let s = self.inner.lock();
            if s.phase != NanoAccountStateV1::SignedIn {
                return Err(NanoError::SignInRequired);
            }
            let entitlements = s
                .entitlements
                .as_ref()
                .ok_or(NanoError::FeatureUnavailable)?;
            let offered = s.capabilities.is_some_and(|c| c.dictation);
            if !offered || !entitlements.features.dictation {
                return Err(NanoError::FeatureUnavailable);
            }
            if audio.is_empty() || audio.len() as u64 > entitlements.limits.dictation_max_bytes {
                return Err(NanoError::Invalid);
            }
            let workspace = s.selected.clone().ok_or(NanoError::WorkspaceNotFound)?;
            (workspace, s.generation)
        };
        let mime = audio_mime(mime).ok_or(NanoError::Invalid)?;
        let nonce = random_bytes::<12>()?;
        let boundary: String = format!(
            "nano-{}",
            nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let mut body = Vec::with_capacity(audio.len() + 256);
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"dictation\"\r\nContent-Type: {mime}\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(&audio);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let body = Bytes::from(body);
        let content_type = format!("multipart/form-data; boundary={boundary}");
        let url = self
            .inner
            .config
            .api_url(&["workspaces", &workspace, "media", "dictation"]);
        let response = self
            .send_authorized(generation, |http, token| {
                http.post(url.clone())
                    .bearer_auth(token)
                    .header(ACCEPT, "application/json")
                    .header(CONTENT_TYPE, content_type.as_str())
                    .body(body.clone())
                    .timeout(DICTATION_TIMEOUT)
            })
            .await?;
        let result = json_answer(response).await;
        if let Err(error) = result {
            self.report_server_error(AccountGeneration(generation), error);
        }
        result
    }

    /// Records a failure that a request of `generation` saw (`lastError`)
    /// and, for plan or credit refusals, reloads the entitlements in the
    /// background. A failure of an earlier generation is not this account's
    /// and is dropped.
    pub fn report_server_error(&self, generation: AccountGeneration, error: NanoError) {
        let Some(phase) = self.inner.mutate(|s| {
            if s.generation != generation.0 {
                return None;
            }
            s.last_error = Some(error);
            Some(s.phase)
        }) else {
            return;
        };
        let generation = generation.0;
        let reload = matches!(
            error,
            NanoError::CreditsExhausted
                | NanoError::ModeLocked
                | NanoError::FeatureUnavailable
                | NanoError::WorkspaceNotFound
        );
        if phase != NanoAccountStateV1::SignedIn || !reload {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let account = self.clone();
        runtime.spawn(async move {
            let Ok(_load) = account.inner.load_lock.try_lock() else {
                return;
            };
            let selected = account.inner.lock().selected.clone();
            if let Some(workspace) = selected
                && let Err(error) = account.load_entitlements(generation, &workspace).await
            {
                account.record_failure(generation, error);
            }
        });
    }
}

/// The essence of an `audio/*` media type, or `None`.
fn audio_mime(mime: &str) -> Option<&str> {
    let essence = mime.split(';').next()?.trim();
    let subtype = essence.strip_prefix("audio/")?;
    let token = !subtype.is_empty()
        && subtype.len() <= 64
        && subtype
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"+-.".contains(&c));
    token.then_some(essence)
}

#[cfg(test)]
mod tests;
