//! The loopback model relay between a Nano-lane Pi process and the Nano
//! gateway (ADR-048).
//!
//! Pi talks OpenAI chat completions to `http://127.0.0.1:<port>/v1` (or the
//! session-scoped `http://127.0.0.1:<port>/s/<session>/v1`) with a per-session
//! 256-bit key. Before the body is read the relay checks the `Host`, the
//! absence of browser headers, the method and path, and the key (constant
//! time); then it takes a concurrency slot (before any body byte is read) and
//! reads the body within the size cap and [`UPLOAD_DEADLINE`], then checks
//! the entitled mode. It forwards the body bytes unchanged to the gateway of
//! the selected workspace with the host's access token, on a URL built only
//! from the issuer, and streams the answer back without buffering. It builds
//! no prompt, runs no agent loop and logs nothing.
//!
//! Every session is bound to the account generation it was registered under
//! ([`AccountGeneration`]). Its requests are refused, and its open uploads,
//! upstream requests and streams cut, as soon as that generation ends
//! (sign-out, device revocation, a dead refresh token, a new sign-in) or the
//! session is dropped, so a later sign-in (possibly of another person) never
//! serves an earlier session.
//!
//! Connector leases (ADR-050) are a second, separate key kind on the same
//! listener: a [`ConnectorLease`] is bound to one harness session (the
//! OpenCode ACP pilot), the Chat Completions dialect and the account
//! generation, and its [`ConnectorKey`] opens only
//! `http://127.0.0.1:<port>/c/<lease>/v1`. Lease keys are never accepted on
//! `/v1` or `/s/<session>/v1`, and Pi session keys never on `/c/<lease>/v1`.
//! After the key check a lease request takes exactly the Pi path above:
//! the same entitlement checks and caps, the same upstream request and the
//! same unbuffered stream.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use bytes::Bytes;
use futures_util::Stream;
use http::header::{ACCEPT, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HOST};
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt as _, Full, LengthLimitError, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use subtle::{Choice, ConditionallySelectable as _, ConstantTimeEq};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};
use tokio::task::{AbortHandle, JoinSet};

use crate::account::{AccountGeneration, NanoAccount};
use crate::error::NanoError;
use crate::net::ServerFailure;
use crate::pkce::{random_bytes, random_token};
use crate::secret::SecretString;
use crate::status::{NanoAccountStateV1, NanoAccountStatusV1};
use crate::wire::{NanoModeIdV1, NanoRelayErrorCodeV1};

/// Request body cap when the entitlements give none.
pub const DEFAULT_MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;
/// Hard ceiling regardless of entitlements.
const HARD_MAX_REQUEST_BYTES: u64 = 64 * 1024 * 1024;
/// Concurrency cap when the entitlements give none.
const DEFAULT_MAX_CONCURRENT: usize = 4;
/// Retired keys remembered to answer `nano_sign_in_required` instead of a bare 401.
const RETIRED_KEYS: usize = 64;
/// How long a caller has to upload one request body. Pi sends its body over
/// loopback at once; a caller that trickles bytes only holds a concurrency
/// slot, which it takes before the first body byte is read.
pub const UPLOAD_DEADLINE: Duration = Duration::from_secs(60);

type RelayBody = UnsyncBoxBody<Bytes, std::io::Error>;

/// A running relay. Dropping it stops the listener and open connections.
#[derive(Debug)]
pub struct Relay {
    shared: Arc<Shared>,
    _shutdown: oneshot::Sender<()>,
}

mod external;
pub use external::ExternalProviderLease;

struct Shared {
    account: NanoAccount,
    port: u16,
    host: String,
    upload_deadline: Duration,
    keys: Mutex<Keys>,
    next_session: AtomicU64,
    inflight: Arc<AtomicUsize>,
}

#[derive(Default)]
struct Keys {
    live: HashMap<u64, LiveSession>,
    retired: Vec<SecretString>,
    /// Connector leases (`/c/<id>/v1`); never consulted for `/v1` or `/s/`.
    connectors: HashMap<u64, LiveConnector>,
    /// Retired lease keys with their lease number: they answer
    /// `nano_sign_in_required` on their own `/c/<id>/v1` only.
    retired_connectors: Vec<(u64, SecretString)>,
    external_providers: HashMap<u64, external::LiveExternalProvider>,
}

/// A registered session (or the grant of a connector lease). Removing it
/// from [`Keys::live`] (or [`Keys::connectors`]) drops `alive`, which ends
/// every upload, upstream request and stream it admitted.
struct LiveSession {
    key: SecretString,
    generation: AccountGeneration,
    /// Opaque random id sent upstream as `X-Nano-Session` (diagnostics and
    /// metering). Not a credential.
    tag: Arc<str>,
    alive: watch::Sender<()>,
}

impl LiveSession {
    fn ticket(&self) -> Ticket {
        Ticket {
            generation: self.generation,
            tag: self.tag.clone(),
            alive: self.alive.subscribe(),
            allowed_modes: None,
            workspace: None,
        }
    }
}

/// A registered connector lease: its grant and what it is bound to.
struct LiveConnector {
    grant: LiveSession,
    harness: ConnectorHarness,
    session_id: String,
    dialect: ConnectorDialect,
    allowed_modes: Option<Arc<[NanoModeIdV1]>>,
    workspace: Option<Arc<str>>,
}

/// What one admitted request carries from its session.
struct Ticket {
    generation: AccountGeneration,
    tag: Arc<str>,
    /// Closes when the session is dropped or closed.
    alive: watch::Receiver<()>,
    allowed_modes: Option<Arc<[NanoModeIdV1]>>,
    workspace: Option<Arc<str>>,
}

impl Ticket {
    /// Whether the session is still registered and its generation current.
    fn valid(&self, account: &NanoAccount) -> bool {
        self.alive.has_changed().is_ok()
            && account.generation() == self.generation
            && self.workspace.as_deref().is_none_or(|workspace| {
                account.status().selected_workspace_id.as_deref() == Some(workspace)
            })
    }

    /// Completes when the session ends.
    fn ended(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut alive = self.alive.clone();
        async move { while alive.changed().await.is_ok() {} }
    }
}

impl std::fmt::Debug for Shared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Shared")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

/// A Pi session's access to the relay. Dropping it unregisters its key and
/// ends the session's open requests and streams.
pub struct RelaySession {
    id: u64,
    port: u16,
    key: SecretString,
    shared: Weak<Shared>,
}

impl std::fmt::Debug for RelaySession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelaySession")
            .field("id", &self.id)
            .field("key", &"<redacted>")
            .finish()
    }
}

impl RelaySession {
    /// The session key. It reaches only the Pi child of this session (through
    /// its bridge's process environment); never a file, an IPC payload or a
    /// log.
    pub fn key(&self) -> &SecretString {
        &self.key
    }

    /// The session number used in [`RelaySession::base_url`] (not secret).
    pub fn id(&self) -> u64 {
        self.id
    }

    /// `http://127.0.0.1:<port>/s/<id>/v1`: accepts only this session's key.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/s/{}/v1", self.port, self.id)
    }
}

impl Drop for RelaySession {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            let removed = shared
                .keys
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .live
                .remove(&self.id);
            // Dropped outside the lock: closes `alive` for its requests.
            drop(removed);
        }
    }
}

/// The harness a connector lease is issued to (ADR-050).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorHarness {
    /// OpenCode driven over ACP: the pilot connector.
    OpenCodeAcp,
    /// Prime Agent driven by its native SDK in the session bridge.
    PrimeAgent,
    /// A native Codex app-server session using OpenAI Responses.
    Codex,
    /// A native Goose ACP session using OpenAI Chat Completions.
    GooseAcp,
}

/// The model API dialect a connector lease speaks (ADR-050).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorDialect {
    /// OpenAI Chat Completions: `POST chat/completions`, `GET models`.
    ChatCompletions,
    /// OpenAI Responses: `POST responses`, `GET models`.
    Responses,
}

impl ConnectorDialect {
    /// Whether the dialect serves `route` (the relay's fixed allowlist).
    fn serves(self, route: Route) -> bool {
        match self {
            Self::ChatCompletions => matches!(route, Route::Chat | Route::Models),
            Self::Responses => matches!(route, Route::Responses | Route::Models),
        }
    }
}

/// Why [`Relay::register_connector`] issued no lease. Nothing is registered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorLeaseError {
    /// The account generation is no longer current (signed out, expired,
    /// revoked or signed in again since the launch was gated).
    SignInRequired,
    /// This harness session already holds a live lease of this generation.
    AlreadyLeased,
    /// The harness session id is empty or contains a control character.
    InvalidSessionId,
    InvalidDialect,
    /// The OS random number generator is unavailable.
    RandomUnavailable,
}

impl std::fmt::Display for ConnectorLeaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::SignInRequired => "the Nano account generation of the launch has ended",
            Self::AlreadyLeased => "the harness session already holds a Nano connector lease",
            Self::InvalidSessionId => "the session id is empty or has a control character",
            Self::InvalidDialect => "the connector has no verified modes for this dialect",
            Self::RandomUnavailable => "the OS random number generator is unavailable",
        })
    }
}

impl std::error::Error for ConnectorLeaseError {}

/// The bearer key of one connector lease: 256 bits from the OS RNG, valid
/// only on its lease's `/c/<id>/v1`. It is not an account credential: the
/// access and refresh tokens never leave the host. `Debug` is redacted, and
/// the type has no `Display`, `Clone` or serialization.
pub struct ConnectorKey(SecretString);

impl ConnectorKey {
    /// The key text, for the host to hand to its own harness session only
    /// (the delivery path is fixed by the host wiring, ADR-050); never a
    /// WebView, an IPC payload or event, a bridge frame, a file or a log.
    pub fn expose(&self) -> &str {
        self.0.expose()
    }
}

impl std::fmt::Debug for ConnectorKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ConnectorKey(<redacted>)")
    }
}

/// A harness session's revocable access to the relay (ADR-050). Dropping it
/// (or [`ConnectorLease::revoke`]) unregisters its key and ends the lease's
/// open requests and streams; the end of its account generation does the
/// same.
pub struct ConnectorLease {
    id: u64,
    port: u16,
    harness: ConnectorHarness,
    session_id: String,
    dialect: ConnectorDialect,
    key: ConnectorKey,
    shared: Weak<Shared>,
}

impl std::fmt::Debug for ConnectorLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectorLease")
            .field("id", &self.id)
            .field("harness", &self.harness)
            .field("session_id", &self.session_id)
            .field("dialect", &self.dialect)
            .field("key", &"<redacted>")
            .finish()
    }
}

impl ConnectorLease {
    /// The lease key, accepted only by [`ConnectorLease::base_url`].
    pub fn key(&self) -> &ConnectorKey {
        &self.key
    }

    /// The lease number used in [`ConnectorLease::base_url`] (not secret).
    pub fn id(&self) -> u64 {
        self.id
    }

    /// The harness the lease is bound to.
    pub fn harness(&self) -> ConnectorHarness {
        self.harness
    }

    /// The harness session the lease is bound to.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The dialect the lease is bound to.
    pub fn dialect(&self) -> ConnectorDialect {
        self.dialect
    }

    /// `http://127.0.0.1:<port>/c/<id>/v1`: accepts only this lease's key.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/c/{}/v1", self.port, self.id)
    }

    /// Revokes the lease now: the same as dropping it.
    pub fn revoke(self) {
        drop(self);
    }
}

impl Drop for ConnectorLease {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            let removed = shared
                .keys
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .connectors
                .remove(&self.id);
            // Dropped outside the lock: closes `alive` for its requests.
            drop(removed);
        }
    }
}

impl Relay {
    /// Binds `127.0.0.1:0` and serves in a spawned task.
    ///
    /// # Errors
    /// [`NanoError::FeatureUnavailable`] when no loopback port can be bound.
    pub async fn start(account: NanoAccount) -> Result<Self, NanoError> {
        Self::start_with(account, UPLOAD_DEADLINE).await
    }

    async fn start_with(
        account: NanoAccount,
        upload_deadline: Duration,
    ) -> Result<Self, NanoError> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .map_err(|_| NanoError::FeatureUnavailable)?;
        let port = listener
            .local_addr()
            .map_err(|_| NanoError::FeatureUnavailable)?
            .port();
        let shared = Arc::new(Shared {
            account,
            port,
            host: format!("127.0.0.1:{port}"),
            upload_deadline,
            keys: Mutex::new(Keys::default()),
            next_session: AtomicU64::new(1),
            inflight: Arc::new(AtomicUsize::new(0)),
        });
        // Subscribed before any session can be registered, so the loop sees
        // every generation change that follows, even before it first runs.
        let mut status = shared.account.subscribe();
        status.borrow_and_update();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(accept_loop(listener, shared.clone(), status, shutdown_rx));
        Ok(Self {
            shared,
            _shutdown: shutdown_tx,
        })
    }

    /// The bound port.
    pub fn port(&self) -> u16 {
        self.shared.port
    }

    /// `http://127.0.0.1:<port>/v1`: accepts any live session's key (never
    /// a connector lease's).
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.shared.port)
    }

    /// Registers a session with a fresh 256-bit key, bound to `generation`
    /// (read together with the status the launch was gated on, see
    /// [`NanoAccount::status_with_generation`]).
    ///
    /// # Errors
    /// [`NanoError::SignInRequired`] when `generation` is no longer current
    /// (the account signed out or a new sign-in started since): nothing is
    /// registered. [`NanoError::SignInFailed`] when the OS RNG is unavailable.
    pub fn register_session(
        &self,
        generation: AccountGeneration,
    ) -> Result<RelaySession, NanoError> {
        let key = random_token()?;
        let tag = session_tag()?;
        let mut keys = self
            .shared
            .keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Checked under the key lock: a generation that already ended is
        // refused here, and one that ends after this check retires the key
        // (the retirement sweep waits for this lock).
        if self.shared.account.generation() != generation {
            return Err(NanoError::SignInRequired);
        }
        let id = self.shared.next_session.fetch_add(1, Ordering::Relaxed);
        let (alive, _) = watch::channel(());
        keys.live.insert(
            id,
            LiveSession {
                key: key.clone(),
                generation,
                tag,
                alive,
            },
        );
        drop(keys);
        Ok(RelaySession {
            id,
            port: self.shared.port,
            key,
            shared: Arc::downgrade(&self.shared),
        })
    }

    /// Issues a connector lease (ADR-050) with a fresh 256-bit key, bound to
    /// `harness`, its `session_id`, `dialect` and `generation` (read together
    /// with the status the launch was gated on, see
    /// [`NanoAccount::status_with_generation`]). A harness session holds at
    /// most one live lease; dropping or revoking it frees the session.
    ///
    /// # Errors
    /// [`ConnectorLeaseError::SignInRequired`] when `generation` is no longer
    /// current, [`ConnectorLeaseError::AlreadyLeased`] when the session
    /// already holds a live lease, [`ConnectorLeaseError::InvalidSessionId`]
    /// for an empty id or one with a control character, and
    /// [`ConnectorLeaseError::RandomUnavailable`] when the OS RNG fails.
    /// Nothing is registered on error.
    pub fn register_connector(
        &self,
        harness: ConnectorHarness,
        session_id: &str,
        dialect: ConnectorDialect,
        generation: AccountGeneration,
    ) -> Result<ConnectorLease, ConnectorLeaseError> {
        if dialect == ConnectorDialect::Responses
            || matches!(
                harness,
                ConnectorHarness::Codex | ConnectorHarness::GooseAcp
            )
        {
            return Err(ConnectorLeaseError::InvalidDialect);
        }
        self.register_connector_with_modes(harness, session_id, dialect, generation, None, None)
    }

    /// Registers a Codex lease restricted to the server-advertised modes.
    pub fn register_codex_connector(
        &self,
        session_id: &str,
        generation: AccountGeneration,
        workspace: &str,
        modes: Vec<NanoModeIdV1>,
    ) -> Result<ConnectorLease, ConnectorLeaseError> {
        if modes.is_empty() {
            return Err(ConnectorLeaseError::InvalidDialect);
        }
        self.register_connector_with_modes(
            ConnectorHarness::Codex,
            session_id,
            ConnectorDialect::Responses,
            generation,
            Some(modes.into()),
            Some(workspace),
        )
    }

    /// Registers a Goose lease for the mode fixed at process launch.
    pub fn register_goose_connector(
        &self,
        session_id: &str,
        generation: AccountGeneration,
        mode: NanoModeIdV1,
    ) -> Result<ConnectorLease, ConnectorLeaseError> {
        self.register_connector_with_modes(
            ConnectorHarness::GooseAcp,
            session_id,
            ConnectorDialect::ChatCompletions,
            generation,
            Some(Arc::from([mode])),
            None,
        )
    }

    fn register_connector_with_modes(
        &self,
        harness: ConnectorHarness,
        session_id: &str,
        dialect: ConnectorDialect,
        generation: AccountGeneration,
        allowed_modes: Option<Arc<[NanoModeIdV1]>>,
        workspace: Option<&str>,
    ) -> Result<ConnectorLease, ConnectorLeaseError> {
        if session_id.is_empty() || session_id.chars().any(char::is_control) {
            return Err(ConnectorLeaseError::InvalidSessionId);
        }
        let key = random_token().map_err(|_| ConnectorLeaseError::RandomUnavailable)?;
        let tag = session_tag().map_err(|_| ConnectorLeaseError::RandomUnavailable)?;
        let mut keys = self
            .shared
            .keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Checked under the key lock, as in `register_session`.
        if self.shared.account.generation() != generation
            || workspace.is_some_and(|workspace| {
                self.shared
                    .account
                    .status()
                    .selected_workspace_id
                    .as_deref()
                    != Some(workspace)
            })
        {
            return Err(ConnectorLeaseError::SignInRequired);
        }
        // A lease of an ended generation does not hold the session: it is
        // already refused and is retired when the relay sees the change.
        let leased = keys.connectors.values().any(|lease| {
            lease.harness == harness
                && lease.session_id == session_id
                && lease.grant.generation == generation
        });
        if leased {
            return Err(ConnectorLeaseError::AlreadyLeased);
        }
        let id = self.shared.next_session.fetch_add(1, Ordering::Relaxed);
        let (alive, _) = watch::channel(());
        keys.connectors.insert(
            id,
            LiveConnector {
                grant: LiveSession {
                    key: key.clone(),
                    generation,
                    tag,
                    alive,
                },
                harness,
                session_id: session_id.to_owned(),
                dialect,
                allowed_modes,
                workspace: workspace.map(Arc::from),
            },
        );
        drop(keys);
        Ok(ConnectorLease {
            id,
            port: self.shared.port,
            harness,
            session_id: session_id.to_owned(),
            dialect,
            key: ConnectorKey(key),
            shared: Arc::downgrade(&self.shared),
        })
    }

    /// Retires every session key and connector lease key and cuts every open
    /// request and stream. Sessions and leases of an ended generation are
    /// also retired automatically.
    pub fn close_all_sessions(&self) {
        self.shared.retire(true);
    }
}

/// `ses_` and 32 hex digits of fresh randomness.
fn session_tag() -> Result<Arc<str>, NanoError> {
    let bytes = random_bytes::<16>()?;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("ses_{hex}").into())
}

async fn accept_loop(
    listener: TcpListener,
    shared: Arc<Shared>,
    mut status: watch::Receiver<NanoAccountStatusV1>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let mut connections = JoinSet::new();
    let mut watching = true;
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            changed = status.changed(), if watching => {
                if changed.is_err() {
                    watching = false;
                    continue;
                }
                status.borrow_and_update();
                // A generation ends inside a published change (sign-out,
                // expiry, a new sign-in): retire the sessions it held.
                shared.retire(false);
            }
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let shared = shared.clone();
                connections.spawn(async move {
                    let service = service_fn(move |request| {
                        let shared = shared.clone();
                        async move { Ok::<_, Infallible>(handle(&shared, request).await) }
                    });
                    let mut builder = http1::Builder::new();
                    builder
                        .timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(30))
                        .keep_alive(true);
                    let _ = builder.serve_connection(TokioIo::new(stream), service).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    Chat,
    Responses,
    Models,
}

/// Which keys a path accepts. The namespaces share no key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Namespace {
    /// `/v1` (`None`: any live session's key) or `/s/<id>/v1` (that
    /// session's key only).
    Session(Option<u64>),
    /// `/c/<id>/v1`: that connector lease's key only.
    Connector(u64),
    /// `/p/<id>/v1`: an external provider session lease.
    ExternalProvider(u64),
}

/// `/v1/<leaf>`, `/s/<session>/v1/<leaf>` or `/c/<lease>/v1/<leaf>`; `Err` is
/// the status to answer.
fn parse_route(method: &Method, path: &str) -> Result<(Route, Namespace), StatusCode> {
    let (namespace, rest) = if let Some(rest) = path.strip_prefix("/s/") {
        let (id, rest) = scoped(rest)?;
        (Namespace::Session(Some(id)), rest)
    } else if let Some(rest) = path.strip_prefix("/c/") {
        let (id, rest) = scoped(rest)?;
        (Namespace::Connector(id), rest)
    } else if let Some(rest) = path.strip_prefix("/p/") {
        let (id, rest) = scoped(rest)?;
        (Namespace::ExternalProvider(id), rest)
    } else {
        let rest = path.strip_prefix('/').ok_or(StatusCode::NOT_FOUND)?;
        (Namespace::Session(None), rest)
    };
    let route = match rest {
        "v1/chat/completions" => Route::Chat,
        "v1/responses" if !matches!(namespace, Namespace::Session(_)) => Route::Responses,
        "v1/models" => Route::Models,
        _ => return Err(StatusCode::NOT_FOUND),
    };
    let expected = match route {
        Route::Chat | Route::Responses => Method::POST,
        Route::Models => Method::GET,
    };
    if *method != expected {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    Ok((route, namespace))
}

/// `<id>/<rest>` after a scoped prefix: a decimal `u64` and the remainder.
fn scoped(path: &str) -> Result<(u64, &str), StatusCode> {
    let (id, rest) = path.split_once('/').ok_or(StatusCode::NOT_FOUND)?;
    if id.is_empty() || id.len() > 19 || !id.bytes().all(|c| c.is_ascii_digit()) {
        return Err(StatusCode::NOT_FOUND);
    }
    let id = id.parse::<u64>().map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((id, rest))
}

enum KeyCheck {
    Live(Ticket),
    Retired,
    Refused,
}

async fn handle(shared: &Shared, request: Request<Incoming>) -> Response<RelayBody> {
    if !shared.host_allowed(&request) || from_browser(request.headers()) {
        return plain(StatusCode::FORBIDDEN);
    }
    let (route, namespace) = match parse_route(request.method(), request.uri().path()) {
        Ok(found) => found,
        Err(status) => return plain(status),
    };
    let checked = match namespace {
        Namespace::Session(session) => shared.check_key(request.headers(), session),
        Namespace::Connector(id) => shared.check_connector_key(request.headers(), id, route),
        Namespace::ExternalProvider(id) => {
            return external::handle(shared, request, id, route).await;
        }
    };
    let ticket = match checked {
        KeyCheck::Live(ticket) => ticket,
        KeyCheck::Retired => return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired),
        KeyCheck::Refused => return plain(StatusCode::UNAUTHORIZED),
    };
    let (generation, status) = shared.account.status_with_generation();
    if generation != ticket.generation || !ticket.valid(&shared.account) {
        return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired);
    }
    if let Err(code) = availability(&status) {
        return openai_error(code);
    }
    match route {
        Route::Models => models(&status, ticket.allowed_modes.as_deref()),
        Route::Chat | Route::Responses => complete(shared, request, &status, ticket, route).await,
    }
}

impl Shared {
    fn host_allowed(&self, request: &Request<Incoming>) -> bool {
        let mut hosts = request.headers().get_all(HOST).iter();
        let host_ok = matches!(
            (hosts.next(), hosts.next()),
            (Some(value), None) if value.as_bytes() == self.host.as_bytes()
        );
        let authority_ok = request
            .uri()
            .authority()
            .is_none_or(|authority| authority.as_str() == self.host);
        host_ok && authority_ok
    }

    /// Constant-time comparison against every candidate session key (no
    /// early exit). Connector lease keys are never candidates.
    fn check_key(&self, headers: &HeaderMap, session: Option<u64>) -> KeyCheck {
        let Some(presented) = bearer(headers) else {
            return KeyCheck::Refused;
        };
        let keys = self.keys.lock().unwrap_or_else(PoisonError::into_inner);
        let mut live = Choice::from(0);
        let mut matched = 0_u64;
        for (id, entry) in &keys.live {
            if session.is_none_or(|wanted| wanted == *id) {
                let equal = entry.key.expose().as_bytes().ct_eq(presented);
                matched.conditional_assign(id, equal);
                live |= equal;
            }
        }
        let mut retired = Choice::from(0);
        for key in &keys.retired {
            retired |= key.expose().as_bytes().ct_eq(presented);
        }
        if bool::from(live)
            && let Some(entry) = keys.live.get(&matched)
        {
            KeyCheck::Live(entry.ticket())
        } else if bool::from(retired) {
            KeyCheck::Retired
        } else {
            KeyCheck::Refused
        }
    }

    /// Constant-time comparison against the key of lease `id` only, which
    /// must serve `route` in its dialect, and against the retired keys of
    /// that lease. Session keys are never candidates.
    fn check_connector_key(&self, headers: &HeaderMap, id: u64, route: Route) -> KeyCheck {
        let Some(presented) = bearer(headers) else {
            return KeyCheck::Refused;
        };
        let keys = self.keys.lock().unwrap_or_else(PoisonError::into_inner);
        let lease = keys
            .connectors
            .get(&id)
            .filter(|lease| lease.dialect.serves(route));
        let live = lease.map_or(Choice::from(0), |lease| {
            lease.grant.key.expose().as_bytes().ct_eq(presented)
        });
        let mut retired = Choice::from(0);
        for (_, key) in keys
            .retired_connectors
            .iter()
            .filter(|(retired_id, _)| *retired_id == id)
        {
            retired |= key.expose().as_bytes().ct_eq(presented);
        }
        match lease {
            Some(lease) if bool::from(live) => {
                let mut ticket = lease.grant.ticket();
                ticket.allowed_modes = lease.allowed_modes.clone();
                ticket.workspace = lease.workspace.clone();
                KeyCheck::Live(ticket)
            }
            _ if bool::from(retired) => KeyCheck::Retired,
            _ => KeyCheck::Refused,
        }
    }

    /// Moves the keys of all sessions and leases, or those of ended
    /// generations, to their
    /// retired lists (they then answer `nano_sign_in_required`, each in its
    /// own namespace) and drops them, which ends their open uploads,
    /// upstream requests and streams.
    fn retire(&self, all: bool) {
        let ended: (Vec<LiveSession>, Vec<LiveConnector>) = {
            let mut keys = self.keys.lock().unwrap_or_else(PoisonError::into_inner);
            // Registration uses the same lock. A generation observed before
            // taking it could retire a fresh key admitted by a new sign-in.
            let (current, status) = self.account.status_with_generation();
            let retire = |session: &LiveSession| all || session.generation != current;
            let ids: Vec<u64> = keys
                .live
                .iter()
                .filter(|(_, session)| retire(session))
                .map(|(id, _)| *id)
                .collect();
            let ended: Vec<LiveSession> =
                ids.iter().filter_map(|id| keys.live.remove(id)).collect();
            keys.retired
                .extend(ended.iter().map(|session| session.key.clone()));
            let excess = keys.retired.len().saturating_sub(RETIRED_KEYS);
            keys.retired = keys.retired.split_off(excess);

            let ids: Vec<u64> = keys
                .connectors
                .iter()
                .filter(|(_, lease)| {
                    retire(&lease.grant)
                        || lease.workspace.as_deref().is_some_and(|workspace| {
                            status.selected_workspace_id.as_deref() != Some(workspace)
                        })
                })
                .map(|(id, _)| *id)
                .collect();
            let leases: Vec<(u64, LiveConnector)> = ids
                .iter()
                .filter_map(|id| keys.connectors.remove(id).map(|lease| (*id, lease)))
                .collect();
            keys.retired_connectors.extend(
                leases
                    .iter()
                    .map(|(id, lease)| (*id, lease.grant.key.clone())),
            );
            let excess = keys.retired_connectors.len().saturating_sub(RETIRED_KEYS);
            keys.retired_connectors = keys.retired_connectors.split_off(excess);
            (ended, leases.into_iter().map(|(_, lease)| lease).collect())
        };
        // Dropped outside the lock: closes `alive` for their requests.
        drop(ended);
    }

    fn try_acquire(&self, max: usize) -> Option<InflightPermit> {
        self.inflight
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < max).then_some(n + 1)
            })
            .ok()
            .map(|_| InflightPermit {
                counter: self.inflight.clone(),
            })
    }
}

/// The key of a single `Authorization: Bearer <key>` header.
fn bearer(headers: &HeaderMap) -> Option<&[u8]> {
    let mut values = headers.get_all(AUTHORIZATION).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return None;
    };
    let value = value.as_bytes();
    if value.len() < 7 || !value[..7].eq_ignore_ascii_case(b"bearer ") {
        return None;
    }
    Some(&value[7..])
}

/// Browsers send `Sec-Fetch-Site` on every request (and `Origin` on
/// cross-origin POSTs). Node's `fetch`, which Pi's OpenAI client uses, sends
/// only `Sec-Fetch-Mode: cors`, so that one header alone is allowed.
fn from_browser(headers: &HeaderMap) -> bool {
    headers.contains_key("origin")
        || headers.contains_key("referer")
        || headers.keys().any(|name| {
            let name = name.as_str();
            name.starts_with("sec-fetch-") && name != "sec-fetch-mode"
        })
}

fn availability(status: &NanoAccountStatusV1) -> Result<(), NanoRelayErrorCodeV1> {
    match status.state {
        NanoAccountStateV1::SignedIn => Ok(()),
        NanoAccountStateV1::SignedOut
        | NanoAccountStateV1::SigningIn
        | NanoAccountStateV1::Expired => Err(NanoRelayErrorCodeV1::NanoSignInRequired),
        NanoAccountStateV1::Offline => Err(NanoRelayErrorCodeV1::NanoOffline),
        NanoAccountStateV1::Unsupported => Err(match status.last_error {
            Some(NanoError::ClientTooOld) => NanoRelayErrorCodeV1::NanoClientTooOld,
            _ => NanoRelayErrorCodeV1::NanoUpstreamError,
        }),
    }
}

fn models(status: &NanoAccountStatusV1, allowed: Option<&[NanoModeIdV1]>) -> Response<RelayBody> {
    let data: Vec<serde_json::Value> = status
        .entitlements
        .iter()
        .flat_map(|entitlements| entitlements.modes.iter())
        .filter(|mode| mode.available && allowed.is_none_or(|ids| ids.contains(&mode.id)))
        .map(|mode| {
            serde_json::json!({
                "id": mode.id.as_str(),
                "object": "model",
                "created": 0,
                "owned_by": "nano",
            })
        })
        .collect();
    json_response(
        StatusCode::OK,
        &serde_json::json!({ "object": "list", "data": data }),
    )
}

#[derive(Deserialize)]
struct ModelField {
    model: String,
}

async fn complete(
    shared: &Shared,
    request: Request<Incoming>,
    status: &NanoAccountStatusV1,
    ticket: Ticket,
    route: Route,
) -> Response<RelayBody> {
    let Some(entitlements) = status.entitlements.as_ref() else {
        return openai_error_with(
            NanoRelayErrorCodeV1::NanoOffline,
            StatusCode::SERVICE_UNAVAILABLE,
            "Nano is still loading your plan. Try again shortly.",
        );
    };
    let limits = entitlements.limits;
    let max_bytes = Some(limits.max_request_bytes)
        .filter(|bytes| *bytes > 0)
        .unwrap_or(DEFAULT_MAX_REQUEST_BYTES)
        .min(HARD_MAX_REQUEST_BYTES);
    let max_concurrent = usize::try_from(limits.max_concurrent_requests)
        .ok()
        .filter(|count| *count > 0)
        .unwrap_or(DEFAULT_MAX_CONCURRENT);

    let declared = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > max_bytes) {
        return openai_error(NanoRelayErrorCodeV1::NanoRequestTooLarge);
    }
    // The slot is taken before any body byte is read, so a key holder cannot
    // park more uploads than the cap, and each upload has a deadline.
    let Some(permit) = shared.try_acquire(max_concurrent) else {
        return openai_error(NanoRelayErrorCodeV1::NanoRateLimited);
    };
    let accept = request.headers().get(ACCEPT).cloned();
    let limit = usize::try_from(max_bytes).unwrap_or(usize::MAX);
    let upload = tokio::time::timeout(
        shared.upload_deadline,
        Limited::new(request.into_body(), limit).collect(),
    );
    let body = tokio::select! {
        () = ticket.ended() => return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired),
        read = upload => match read {
            Err(_elapsed) => return plain(StatusCode::REQUEST_TIMEOUT),
            Ok(Ok(collected)) => collected.to_bytes(),
            Ok(Err(error)) if error.downcast_ref::<LengthLimitError>().is_some() => {
                return openai_error(NanoRelayErrorCodeV1::NanoRequestTooLarge);
            }
            Ok(Err(_)) => return plain(StatusCode::BAD_REQUEST),
        },
    };

    let Ok(field) = serde_json::from_slice::<ModelField>(&body) else {
        return openai_error_with(
            NanoRelayErrorCodeV1::NanoUpstreamError,
            StatusCode::BAD_REQUEST,
            "The request is not a JSON inference request with a model.",
        );
    };
    let Some(mode) = NanoModeIdV1::parse(&field.model).filter(|mode| {
        entitlements.mode_available(*mode)
            && ticket
                .allowed_modes
                .as_ref()
                .is_none_or(|allowed| allowed.contains(mode))
    }) else {
        return openai_error(NanoRelayErrorCodeV1::NanoModeLocked);
    };
    // The account may have signed out (and another one in) during the
    // upload: forward only for the generation the session belongs to.
    if !ticket.valid(&shared.account) {
        return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired);
    }

    let upstream = tokio::select! {
        biased;
        () = ticket.ended() => return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired),
        upstream = shared.account.send_gateway(
            ticket.generation,
            &ticket.tag,
            &entitlements.workspace_id,
            match route {
                Route::Chat => crate::account::GatewayRequest::Chat(mode),
                Route::Responses => crate::account::GatewayRequest::Responses(mode),
                Route::Models => unreachable!("model discovery is handled before forwarding"),
            },
            body,
            accept,
        ) => upstream,
    };
    let response = match upstream {
        Ok(response) => response,
        Err(error) => {
            shared.account.report_server_error(ticket.generation, error);
            return openai_error(error.relay_code());
        }
    };
    if !response.status().is_success() {
        let failure = tokio::select! {
            () = ticket.ended() => return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired),
            failure = ServerFailure::read(response) => failure,
        };
        let error = failure.account_error();
        shared.account.report_server_error(ticket.generation, error);
        let code = if failure.too_large() {
            NanoRelayErrorCodeV1::NanoRequestTooLarge
        } else {
            error.relay_code()
        };
        return openai_error(code);
    }
    stream_back(response, permit, Box::pin(ticket.ended()))
}

type ClosedFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Streams the upstream answer through without buffering; the concurrency
/// permit is released when the body ends or the client goes away, and the
/// stream is cut when its session ends.
fn stream_back(
    response: reqwest::Response,
    permit: InflightPermit,
    closed: ClosedFuture,
) -> Response<RelayBody> {
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::OK);
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/json"));
    let stream = Guarded::new(Box::pin(response.bytes_stream()), permit, closed);
    let body = StreamBody::new(stream).boxed_unsync();
    let mut answer = Response::new(body);
    *answer.status_mut() = status;
    answer.headers_mut().insert(CONTENT_TYPE, content_type);
    answer
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    answer
}

type UpstreamStream = Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>;

struct Guarded {
    upstream: Arc<Mutex<Upstream>>,
    cancellation: AbortHandle,
    done: bool,
}

struct Upstream {
    active: Option<(UpstreamStream, InflightPermit)>,
    reader: Option<Waker>,
}

impl Guarded {
    fn new(stream: UpstreamStream, permit: InflightPermit, closed: ClosedFuture) -> Self {
        let upstream = Arc::new(Mutex::new(Upstream {
            active: Some((stream, permit)),
            reader: None,
        }));
        let cancelled = upstream.clone();
        // Hyper may stop polling the body when its downstream socket blocks.
        // Revoke the upstream and release the slot even in that state.
        let cancellation = tokio::spawn(async move {
            closed.await;
            let mut state = cancelled.lock().unwrap_or_else(PoisonError::into_inner);
            state.active.take();
            if let Some(reader) = state.reader.take() {
                drop(state);
                reader.wake();
            }
        })
        .abort_handle();
        Self {
            upstream,
            cancellation,
            done: false,
        }
    }
}

impl Drop for Guarded {
    fn drop(&mut self) {
        self.cancellation.abort();
        self.upstream
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .active
            .take();
    }
}

impl Stream for Guarded {
    type Item = Result<Frame<Bytes>, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.done {
            return Poll::Ready(None);
        }
        let result = {
            let mut upstream = self.upstream.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some((stream, _permit)) = upstream.active.as_mut() {
                let result = stream.as_mut().poll_next(cx);
                match &result {
                    Poll::Pending => upstream.reader = Some(cx.waker().clone()),
                    Poll::Ready(None | Some(Err(_))) => {
                        upstream.active.take();
                    }
                    Poll::Ready(Some(Ok(_))) => {}
                }
                Some(result)
            } else {
                None
            }
        };
        let Some(result) = result else {
            self.done = true;
            return Poll::Ready(Some(Err(std::io::Error::other(
                "the Nano session was closed",
            ))));
        };
        if matches!(result, Poll::Ready(None | Some(Err(_)))) {
            self.done = true;
        }
        result.map(|item| item.map(|chunk| chunk.map(Frame::data).map_err(std::io::Error::other)))
    }
}

struct InflightPermit {
    counter: Arc<AtomicUsize>,
}

impl Drop for InflightPermit {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

fn full(bytes: impl Into<Bytes>) -> RelayBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

/// A policy refusal for a caller that is not a legitimate Pi session.
fn plain(status: StatusCode) -> Response<RelayBody> {
    let mut response = Response::new(full(status.canonical_reason().unwrap_or("Error")));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn json_response(status: StatusCode, value: &serde_json::Value) -> Response<RelayBody> {
    let mut response = Response::new(full(value.to_string()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn openai_error(code: NanoRelayErrorCodeV1) -> Response<RelayBody> {
    let status = StatusCode::from_u16(code.http_status()).unwrap_or(StatusCode::BAD_GATEWAY);
    openai_error_with(code, status, code.message())
}

fn openai_error_with(
    code: NanoRelayErrorCodeV1,
    status: StatusCode,
    message: &str,
) -> Response<RelayBody> {
    json_response(
        status,
        &serde_json::json!({
            "error": { "message": message, "type": "nano", "code": code.as_str() }
        }),
    )
}

#[cfg(test)]
mod tests;
