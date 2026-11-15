//! The outbound link to the Nano server (`GET /api/desktop/v1/remote/link`).
//!
//! The host opens it only while it is wanted (see the application's
//! supervisor) and the owner of the link drops the [`LinkHandle`] to close it.
//! The upgrade request goes through the account's own HTTP client, so the
//! issuer pin, the platform certificate verifier, `https_only`, the system
//! proxy and `X-Nano-Client` apply, and the access token is fetched from the
//! account for every attempt and sent only as the `Authorization` header.
//! `tokio-tungstenite` only frames the stream `reqwest` upgraded.
//!
//! Nothing here logs. No header, frame, URL query or token is ever printed,
//! and `Debug` of the handles prints a placeholder.
//!
//! # Lifecycle
//!
//! `connecting`, then `online` once the server's `hello` arrived. A lost
//! connection or a transient refusal is `retrying` with a delay of 1 s
//! doubling to 60 s, with +-20 % jitter, reset after a connection that lasted
//! a minute. HTTP 403, 404 and 426 are `refused` and end the task: the
//! owner decides when to try again. A 401 refreshes once, then expires the
//! account (`device_revoked` at once) and ends the task. The task also ends
//! when the account's generation changes.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::StatusCode;
use reqwest::header::{
    CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL,
    SEC_WEBSOCKET_VERSION, UPGRADE,
};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use url::Url;

use super::frames::{
    DropReason, HostMessage, MAX_FRAME_BYTES, SUBPROTOCOL, ServerFrame, ViewerMessage, encode_drop,
    encode_message, parse_server_frame,
};
use crate::account::{AccountGeneration, NanoAccount};
use crate::error::NanoError;
use crate::pkce::random_bytes;

/// Frames waiting to be written. A full queue refuses [`LinkSender::send`].
const OUTBOUND_QUEUE: usize = 512;
/// The RFC 6455 handshake GUID.
const HANDSHAKE_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// Time allowed to write the close frame when the link is dropped.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

type Socket = WebSocketStream<reqwest::Upgraded>;

/// Where the link is, as the application shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Connecting,
    Online,
    Retrying,
    /// The server answered 403, 404 or 426. The task has ended.
    Refused,
}

/// What the link reports to its owner, in order.
#[derive(Debug)]
pub enum LinkEvent {
    State(LinkState),
    ViewerOpen(String),
    ViewerClose(String),
    Message {
        viewer: String,
        body: ViewerMessage,
    },
    /// A message of a known kind whose fields were unusable.
    Malformed {
        viewer: String,
    },
}

/// Owns the link task: dropping it closes the socket (a close frame is
/// attempted for two seconds) and ends the task. No event follows a drop that
/// the owner can observe, because the owner drops the receiver with it.
pub struct LinkHandle {
    _stop: oneshot::Sender<()>,
}

impl fmt::Debug for LinkHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LinkHandle(<link>)")
    }
}

/// Queues frames for the server. Cheap to clone; a clone outlives its link
/// and then refuses everything.
#[derive(Clone)]
pub struct LinkSender {
    frames: mpsc::Sender<String>,
    reconnect: Arc<Notify>,
}

impl fmt::Debug for LinkSender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LinkSender(<link>)")
    }
}

impl LinkSender {
    /// Queues `{"t":"msg","viewer":..,"d":..}` without waiting. `false` when
    /// the queue is full, the link is gone or the frame exceeds the frame
    /// limit: the caller drops that viewer.
    pub fn send(&self, viewer: &str, message: &HostMessage) -> bool {
        encode_message(viewer, message).is_some_and(|text| self.frames.try_send(text).is_ok())
    }

    /// Like [`LinkSender::send`] but waits for room in the queue, for large
    /// results sent as many `part` frames.
    pub async fn send_wait(&self, viewer: &str, message: &HostMessage) -> bool {
        match encode_message(viewer, message) {
            Some(text) => self.frames.send(text).await.is_ok(),
            None => false,
        }
    }

    /// Tells the server to close this viewer. When even this frame cannot be
    /// queued the link is torn down and reopened, which closes every viewer.
    pub fn drop_viewer(&self, viewer: &str, reason: DropReason) {
        let queued =
            encode_drop(viewer, reason).is_some_and(|text| self.frames.try_send(text).is_ok());
        if !queued {
            self.reconnect.notify_one();
        }
    }
}

/// Timing and target of a link. [`Settings::new`] holds the production values.
#[derive(Debug, Clone)]
pub(crate) struct Settings {
    pub(crate) url: Url,
    pub(crate) backoff_start: Duration,
    pub(crate) backoff_max: Duration,
    pub(crate) handshake_timeout: Duration,
    pub(crate) write_timeout: Duration,
    pub(crate) ping_every: Duration,
    /// Without any inbound frame for this long the connection is dead.
    pub(crate) silence: Duration,
    /// A connection that lasted this long resets the backoff.
    pub(crate) stable_after: Duration,
}

impl Settings {
    pub(crate) fn new(url: Url) -> Self {
        Self {
            url,
            backoff_start: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            handshake_timeout: Duration::from_secs(15),
            write_timeout: Duration::from_secs(20),
            ping_every: Duration::from_secs(25),
            silence: Duration::from_secs(75),
            stable_after: Duration::from_secs(60),
        }
    }
}

/// Starts the link of `generation` and returns its handle and sender. Events
/// arrive on `events`; the task ends when `events` is closed.
///
/// Must be called inside a Tokio runtime.
pub fn spawn(
    account: NanoAccount,
    generation: AccountGeneration,
    events: mpsc::Sender<LinkEvent>,
) -> (LinkHandle, LinkSender) {
    let settings = Settings::new(account.config().api_url(&["remote", "link"]));
    spawn_with(account, generation, events, settings)
}

pub(crate) fn spawn_with(
    account: NanoAccount,
    generation: AccountGeneration,
    events: mpsc::Sender<LinkEvent>,
    settings: Settings,
) -> (LinkHandle, LinkSender) {
    let (stop_tx, stop_rx) = oneshot::channel();
    let (frames_tx, frames_rx) = mpsc::channel(OUTBOUND_QUEUE);
    let reconnect = Arc::new(Notify::new());
    let task = Task {
        account,
        generation,
        events,
        frames: frames_rx,
        reconnect: Arc::clone(&reconnect),
        stop: stop_rx,
        settings,
    };
    tokio::spawn(task.run());
    (
        LinkHandle { _stop: stop_tx },
        LinkSender {
            frames: frames_tx,
            reconnect,
        },
    )
}

/// `Sec-WebSocket-Accept` for `Sec-WebSocket-Key` `key` (RFC 6455 section 4.2.2).
pub(crate) fn accept_key(key: &str) -> String {
    let mut data = Vec::with_capacity(key.len() + HANDSHAKE_GUID.len());
    data.extend_from_slice(key.as_bytes());
    data.extend_from_slice(HANDSHAKE_GUID.as_bytes());
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &data);
    STANDARD.encode(digest.as_ref())
}

/// The delay before retry number `failures` (0 for the first): `start`
/// doubling up to `max`, times a jitter factor in `0.8..=1.2` taken from
/// `unit` (`0.0..=1.0`).
pub(crate) fn backoff_delay(start: Duration, max: Duration, failures: u32, unit: f64) -> Duration {
    let factor = 2_u32.saturating_pow(failures.min(16));
    let base = start.saturating_mul(factor).min(max);
    let unit = if unit.is_finite() {
        unit.clamp(0.0, 1.0)
    } else {
        0.5
    };
    base.mul_f64(0.8 + 0.4 * unit)
}

fn jitter_unit() -> f64 {
    random_bytes::<2>()
        .map(|bytes| f64::from(u16::from_be_bytes(bytes)) / f64::from(u16::MAX))
        .unwrap_or(0.5)
}

enum Connect {
    Ready(Box<Socket>),
    /// 403, 404 or 426.
    Refused,
    Retry,
    /// Stopped, signed out, or the account no longer holds this generation.
    Stop,
}

enum Served {
    Stop,
    Lost { stable: bool },
}

struct Task {
    account: NanoAccount,
    generation: AccountGeneration,
    events: mpsc::Sender<LinkEvent>,
    frames: mpsc::Receiver<String>,
    reconnect: Arc<Notify>,
    stop: oneshot::Receiver<()>,
    settings: Settings,
}

impl Task {
    async fn emit(&self, event: LinkEvent) -> bool {
        self.events.send(event).await.is_ok()
    }

    fn current(&self) -> bool {
        self.account.generation() == self.generation
    }

    async fn run(mut self) {
        let mut failures = 0_u32;
        let mut changes = self.account.subscribe();
        if !self.emit(LinkEvent::State(LinkState::Connecting)).await {
            return;
        }
        loop {
            if !self.current() {
                return;
            }
            match self.connect().await {
                Connect::Stop => return,
                Connect::Refused => {
                    let _ = self.emit(LinkEvent::State(LinkState::Refused)).await;
                    return;
                }
                Connect::Retry => {}
                Connect::Ready(socket) => match self.serve(*socket, &mut changes).await {
                    Served::Stop => return,
                    Served::Lost { stable } => {
                        if stable {
                            failures = 0;
                        }
                    }
                },
            }
            if !self.emit(LinkEvent::State(LinkState::Retrying)).await {
                return;
            }
            let delay = backoff_delay(
                self.settings.backoff_start,
                self.settings.backoff_max,
                failures,
                jitter_unit(),
            );
            failures = failures.saturating_add(1);
            let deadline = tokio::time::Instant::now() + delay;
            loop {
                tokio::select! {
                    _ = &mut self.stop => return,
                    () = tokio::time::sleep_until(deadline) => break,
                    changed = changes.changed() => {
                        if changed.is_err() || !self.current() {
                            return;
                        }
                    }
                }
            }
        }
    }

    /// One upgrade attempt.
    async fn connect(&mut self) -> Connect {
        let Ok(raw_key) = random_bytes::<16>() else {
            return Connect::Retry;
        };
        let key = STANDARD.encode(raw_key);
        let expected = accept_key(&key);
        let url = self.settings.url.clone();
        let attempt = tokio::time::timeout(
            self.settings.handshake_timeout,
            self.account
                .send_link_request(self.generation, |http, token| {
                    http.get(url.clone())
                        .version(reqwest::Version::HTTP_11)
                        .bearer_auth(token)
                        .header(CONNECTION, "Upgrade")
                        .header(UPGRADE, "websocket")
                        .header(SEC_WEBSOCKET_VERSION, "13")
                        .header(SEC_WEBSOCKET_KEY, key.as_str())
                        .header(SEC_WEBSOCKET_PROTOCOL, SUBPROTOCOL)
                }),
        );
        let answer = tokio::select! {
            _ = &mut self.stop => return Connect::Stop,
            answer = attempt => answer,
        };
        let response = match answer {
            Err(_elapsed) => return Connect::Retry,
            Ok(Err(NanoError::Offline)) => return Connect::Retry,
            // Signed out, expired, revoked or a newer generation.
            Ok(Err(_)) => return Connect::Stop,
            Ok(Ok(response)) => response,
        };
        match response.status() {
            StatusCode::SWITCHING_PROTOCOLS => {}
            StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::UPGRADE_REQUIRED => {
                return Connect::Refused;
            }
            _ => return Connect::Retry,
        }
        let header = |name: &reqwest::header::HeaderName| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        let upgrade_ok =
            header(&UPGRADE).is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
        let accept_ok = header(&SEC_WEBSOCKET_ACCEPT).is_some_and(|value| value == expected);
        let protocol_ok = header(&SEC_WEBSOCKET_PROTOCOL).is_some_and(|value| value == SUBPROTOCOL);
        if !(upgrade_ok && accept_ok && protocol_ok) {
            return Connect::Retry;
        }
        let upgraded =
            match tokio::time::timeout(self.settings.handshake_timeout, response.upgrade()).await {
                Ok(Ok(upgraded)) => upgraded,
                _ => return Connect::Retry,
            };
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));
        Connect::Ready(Box::new(
            WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await,
        ))
    }

    /// Reads the server's `hello`, then relays frames until the connection
    /// ends or the link is stopped.
    async fn serve(
        &mut self,
        mut socket: Socket,
        changes: &mut tokio::sync::watch::Receiver<crate::status::NanoAccountStatusV1>,
    ) -> Served {
        let first = tokio::select! {
            _ = &mut self.stop => {
                close(&mut socket).await;
                return Served::Stop;
            }
            first = tokio::time::timeout(self.settings.handshake_timeout, next_text(&mut socket)) => first,
        };
        let Ok(Some(text)) = first else {
            return Served::Lost { stable: false };
        };
        let device = self.account.status().device.map(|device| device.id);
        match parse_server_frame(&text) {
            Some(ServerFrame::Hello { device: announced })
                if device.as_deref() == Some(announced.as_str()) => {}
            _ => return Served::Lost { stable: false },
        }
        if !self.emit(LinkEvent::State(LinkState::Online)).await {
            close(&mut socket).await;
            return Served::Stop;
        }
        let started = Instant::now();
        let mut last_inbound = started;
        let mut ping = tokio::time::interval(self.settings.ping_every);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // The first tick is immediate.
        ping.tick().await;
        let lost = |started: Instant, stable_after: Duration| Served::Lost {
            stable: started.elapsed() >= stable_after,
        };
        loop {
            if !self.current() {
                close(&mut socket).await;
                return Served::Stop;
            }
            tokio::select! {
                biased;
                _ = &mut self.stop => {
                    close(&mut socket).await;
                    return Served::Stop;
                }
                changed = changes.changed() => {
                    if changed.is_err() || !self.current() {
                        close(&mut socket).await;
                        return Served::Stop;
                    }
                }
                () = self.reconnect.notified() => {
                    close(&mut socket).await;
                    return lost(started, self.settings.stable_after);
                }
                frame = self.frames.recv() => {
                    let Some(text) = frame else {
                        close(&mut socket).await;
                        return Served::Stop;
                    };
                    if !write(&mut socket, Message::text(text), self.settings.write_timeout).await {
                        return lost(started, self.settings.stable_after);
                    }
                }
                _ = ping.tick() => {
                    if last_inbound.elapsed() >= self.settings.silence {
                        return lost(started, self.settings.stable_after);
                    }
                    let probe = Message::Ping(bytes::Bytes::new());
                    if !write(&mut socket, probe, self.settings.write_timeout).await {
                        return lost(started, self.settings.stable_after);
                    }
                }
                incoming = socket.next() => {
                    let Some(Ok(message)) = incoming else {
                        return lost(started, self.settings.stable_after);
                    };
                    last_inbound = Instant::now();
                    match message {
                        Message::Text(text) => {
                            let event = match parse_server_frame(text.as_str()) {
                                Some(ServerFrame::ViewerOpen { viewer }) => Some(LinkEvent::ViewerOpen(viewer)),
                                Some(ServerFrame::ViewerClose { viewer }) => Some(LinkEvent::ViewerClose(viewer)),
                                Some(ServerFrame::Message { viewer, body }) => Some(LinkEvent::Message { viewer, body }),
                                Some(ServerFrame::Malformed { viewer }) => Some(LinkEvent::Malformed { viewer }),
                                // A second `hello` or an unknown frame carries nothing for the owner.
                                Some(ServerFrame::Hello { .. }) | None => None,
                            };
                            if let Some(event) = event
                                && !self.emit(event).await
                            {
                                close(&mut socket).await;
                                return Served::Stop;
                            }
                        }
                        Message::Close(_) => return lost(started, self.settings.stable_after),
                        // Pings are answered by the protocol layer; pongs and binary frames carry nothing.
                        Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => {}
                    }
                }
            }
        }
    }
}

/// The next text frame, skipping control and binary frames; `None` when the
/// connection ended.
async fn next_text(socket: &mut Socket) -> Option<String> {
    loop {
        match socket.next().await? {
            Ok(Message::Text(text)) => return Some(text.as_str().to_owned()),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

async fn write(socket: &mut Socket, message: Message, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn close(socket: &mut Socket) {
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, socket.close(None)).await;
}
