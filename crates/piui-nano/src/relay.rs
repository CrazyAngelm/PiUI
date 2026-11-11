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

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::task::{Context, Poll};
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
use tokio::task::JoinSet;

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
}

/// A registered session. Removing it from [`Keys::live`] drops `alive`,
/// which ends every upload, upstream request and stream it admitted.
struct LiveSession {
    key: SecretString,
    generation: AccountGeneration,
    /// Opaque random id sent upstream as `X-Nano-Session` (diagnostics and
    /// metering). Not a credential.
    tag: Arc<str>,
    alive: watch::Sender<()>,
}

/// What one admitted request carries from its session.
struct Ticket {
    generation: AccountGeneration,
    tag: Arc<str>,
    /// Closes when the session is dropped or closed.
    alive: watch::Receiver<()>,
}

impl Ticket {
    /// Whether the session is still registered and its generation current.
    fn valid(&self, account: &NanoAccount) -> bool {
        self.alive.has_changed().is_ok() && account.generation() == self.generation
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

    /// `http://127.0.0.1:<port>/v1`: accepts any live session's key.
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
        // (`retire_stale` waits for this lock).
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

    /// Retires every session key and cuts every open request and stream.
    /// Sessions of an ended generation are also retired automatically.
    pub fn close_all_sessions(&self) {
        self.shared.retire_where(|_| true);
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
                shared.retire_stale(shared.account.generation());
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
    Models,
}

/// `/v1/<leaf>` or `/s/<session>/v1/<leaf>`; `Err` is the status to answer.
fn parse_route(method: &Method, path: &str) -> Result<(Route, Option<u64>), StatusCode> {
    let (session, rest) = match path.strip_prefix("/s/") {
        Some(rest) => {
            let (id, rest) = rest.split_once('/').ok_or(StatusCode::NOT_FOUND)?;
            if id.is_empty() || id.len() > 19 || !id.bytes().all(|c| c.is_ascii_digit()) {
                return Err(StatusCode::NOT_FOUND);
            }
            let id = id.parse::<u64>().map_err(|_| StatusCode::NOT_FOUND)?;
            (Some(id), rest)
        }
        None => (None, path.strip_prefix('/').ok_or(StatusCode::NOT_FOUND)?),
    };
    let route = match rest {
        "v1/chat/completions" => Route::Chat,
        "v1/models" => Route::Models,
        _ => return Err(StatusCode::NOT_FOUND),
    };
    let expected = match route {
        Route::Chat => Method::POST,
        Route::Models => Method::GET,
    };
    if *method != expected {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    Ok((route, session))
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
    let (route, session) = match parse_route(request.method(), request.uri().path()) {
        Ok(found) => found,
        Err(status) => return plain(status),
    };
    let ticket = match shared.check_key(request.headers(), session) {
        KeyCheck::Live(ticket) => ticket,
        KeyCheck::Retired => return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired),
        KeyCheck::Refused => return plain(StatusCode::UNAUTHORIZED),
    };
    if !ticket.valid(&shared.account) {
        return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired);
    }
    let status = shared.account.status();
    if let Err(code) = availability(&status) {
        return openai_error(code);
    }
    match route {
        Route::Models => models(&status),
        Route::Chat => chat(shared, request, &status, ticket).await,
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

    /// Constant-time comparison against every candidate key (no early exit).
    fn check_key(&self, headers: &HeaderMap, session: Option<u64>) -> KeyCheck {
        let mut values = headers.get_all(AUTHORIZATION).iter();
        let (Some(value), None) = (values.next(), values.next()) else {
            return KeyCheck::Refused;
        };
        let value = value.as_bytes();
        if value.len() < 7 || !value[..7].eq_ignore_ascii_case(b"bearer ") {
            return KeyCheck::Refused;
        }
        let presented = &value[7..];
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
            KeyCheck::Live(Ticket {
                generation: entry.generation,
                tag: entry.tag.clone(),
                alive: entry.alive.subscribe(),
            })
        } else if bool::from(retired) {
            KeyCheck::Retired
        } else {
            KeyCheck::Refused
        }
    }

    /// Retires the sessions of an ended generation.
    fn retire_stale(&self, current: AccountGeneration) {
        self.retire_where(|session| session.generation != current);
    }

    /// Moves the matching sessions' keys to the retired list (they then
    /// answer `nano_sign_in_required`) and drops the sessions, which ends
    /// their open uploads, upstream requests and streams.
    fn retire_where(&self, retire: impl Fn(&LiveSession) -> bool) {
        let ended: Vec<LiveSession> = {
            let mut keys = self.keys.lock().unwrap_or_else(PoisonError::into_inner);
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
            ended
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

fn models(status: &NanoAccountStatusV1) -> Response<RelayBody> {
    let data: Vec<serde_json::Value> = status
        .entitlements
        .iter()
        .flat_map(|entitlements| entitlements.modes.iter())
        .filter(|mode| mode.available)
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

async fn chat(
    shared: &Shared,
    request: Request<Incoming>,
    status: &NanoAccountStatusV1,
    ticket: Ticket,
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
            "The request is not a JSON chat completion with a model.",
        );
    };
    let entitled =
        NanoModeIdV1::parse(&field.model).is_some_and(|mode| entitlements.mode_available(mode));
    if !entitled {
        return openai_error(NanoRelayErrorCodeV1::NanoModeLocked);
    }
    // The account may have signed out (and another one in) during the
    // upload: forward only for the generation the session belongs to.
    if !ticket.valid(&shared.account) {
        return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired);
    }

    let upstream = tokio::select! {
        () = ticket.ended() => return openai_error(NanoRelayErrorCodeV1::NanoSignInRequired),
        upstream = shared.account.send_gateway(
            ticket.generation,
            &ticket.tag,
            &["chat", "completions"],
            reqwest::Method::POST,
            Some(body),
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
    let stream = Guarded {
        inner: Box::pin(response.bytes_stream()),
        closed,
        done: false,
        _permit: permit,
    };
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
    inner: UpstreamStream,
    closed: ClosedFuture,
    done: bool,
    _permit: InflightPermit,
}

impl Stream for Guarded {
    type Item = Result<Frame<Bytes>, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.done {
            return Poll::Ready(None);
        }
        if self.closed.as_mut().poll(cx).is_ready() {
            self.done = true;
            return Poll::Ready(Some(Err(std::io::Error::other(
                "the Nano session was closed",
            ))));
        }
        self.inner
            .as_mut()
            .poll_next(cx)
            .map(|item| item.map(|chunk| chunk.map(Frame::data).map_err(std::io::Error::other)))
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
