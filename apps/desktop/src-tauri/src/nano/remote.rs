//! Remote access to this computer from Nano Web (ADR-062,
//! `contracts/nano-remote-v1.ts`): the actor, the WebView's commands and the
//! event tap.
//!
//! The link to the Nano server is opened only here, only while the person's
//! toggle is on, the account is signed in, the server offers it and the
//! application is not in safe mode. A signed-out application and safe mode
//! make no remote call: no link, no discovery of its own. There is no new
//! listener; the loopback relay stays the only one.
//!
//! One task owns all state ([`Core`]). Everything reaches it through one
//! queue: the WebView's commands, the allowlisted host events, the finished
//! remote commands, and, on their own channels, the account's status and the
//! link's events. A browser reaches only what `remote_dispatch` admits.
//!
//! Remote access lets a paired browser do in chats what the person at the
//! keyboard can do, approvals included. It is not a sandbox.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use piui_nano::remote::frames::{HostMessage, RefusalCode, split_result};
use piui_nano::remote::link::{self, LinkEvent, LinkHandle, LinkSender};
use piui_nano::status::NanoAccountStatusV1;
use piui_nano::{AccountGeneration, NanoAccount};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::MissedTickBehavior;

use super::remote_core::{
    AccountView, Command, Core, CoreConfig, Decision, DeviceView, Effect, Hooks, Moment,
    NanoRemoteEventV1, NanoRemoteStatusV1, RemoteError,
};
use super::remote_dispatch::{self, Admitted};
use super::{MAIN_WINDOW, NanoHost};
use crate::background;

/// `NANO_REMOTE_EVENT_V1`.
pub(crate) const NANO_REMOTE_EVENT_V1: &str = "piui://nano-remote-v1";
/// The toggle and the remembered browsers (public keys), in the app data folder.
pub(crate) const STORE_FILE: &str = "nano-remote-v1.json";
/// Queue of commands, host events and finished remote commands.
const QUEUE: usize = 1024;
/// Events of the link waiting for the actor.
const LINK_EVENTS: usize = 64;
/// A link being closed keeps its socket this long so the frames queued just
/// before (a `bye`, a `drop`) can go out.
const FLUSH: Duration = Duration::from_millis(300);

// ---------------------------------------------------------------------------
// WebView commands
// ---------------------------------------------------------------------------

/// A failed command. Serializes as `{"code": "<NanoRemoteErrorCodeV1>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{code}")]
pub struct RemoteCommandError {
    pub code: RemoteError,
}

impl From<RemoteError> for RemoteCommandError {
    fn from(code: RemoteError) -> Self {
        Self { code }
    }
}

/// `nano_remote_set_enabled_v1` request.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoRemoteSetEnabledRequestV1 {
    pub enabled: bool,
}

/// `nano_remote_decide_v1` request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoRemoteDecideRequestV1 {
    pub request_id: String,
    pub decision: Decision,
}

/// `nano_remote_kick_v1` request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoRemoteKickRequestV1 {
    pub viewer_id: String,
}

/// `nano_remote_forget_v1` request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoRemoteForgetRequestV1 {
    pub browser_id: String,
}

/// What the actor receives besides the account and the link.
enum Input {
    Command(Command, oneshot::Sender<Result<(), RemoteError>>),
    HostEvent {
        channel: &'static str,
        payload: String,
    },
    Done {
        viewer: String,
        id: u64,
        sent: bool,
    },
}

/// The remote-access host, managed as `Arc<RemoteHost>`.
pub(crate) struct RemoteHost {
    inputs: mpsc::Sender<Input>,
    status: watch::Receiver<NanoRemoteStatusV1>,
}

impl RemoteHost {
    #[cfg(all(windows, debug_assertions, feature = "native-remote-workbench-test"))]
    pub(super) fn subscribe_for_tests(&self) -> watch::Receiver<NanoRemoteStatusV1> {
        self.status.clone()
    }

    /// The last published status; never touches the network.
    pub(crate) fn status(&self) -> NanoRemoteStatusV1 {
        self.status.borrow().clone()
    }

    async fn call(&self, command: Command) -> Result<NanoRemoteStatusV1, RemoteCommandError> {
        let (reply, answer) = oneshot::channel();
        self.inputs
            .send(Input::Command(command, reply))
            .await
            .map_err(|_| RemoteError::Io)?;
        answer.await.map_err(|_| RemoteError::Io)??;
        Ok(self.status())
    }
}

#[tauri::command]
pub fn nano_remote_status_v1(host: State<'_, Arc<RemoteHost>>) -> NanoRemoteStatusV1 {
    host.status()
}

#[tauri::command]
pub async fn nano_remote_set_enabled_v1(
    host: State<'_, Arc<RemoteHost>>,
    request: NanoRemoteSetEnabledRequestV1,
) -> Result<NanoRemoteStatusV1, RemoteCommandError> {
    host.call(Command::SetEnabled(request.enabled)).await
}

#[tauri::command]
pub async fn nano_remote_decide_v1(
    host: State<'_, Arc<RemoteHost>>,
    request: NanoRemoteDecideRequestV1,
) -> Result<NanoRemoteStatusV1, RemoteCommandError> {
    host.call(Command::Decide {
        request_id: request.request_id,
        decision: request.decision,
    })
    .await
}

#[tauri::command]
pub async fn nano_remote_kick_v1(
    host: State<'_, Arc<RemoteHost>>,
    request: NanoRemoteKickRequestV1,
) -> Result<NanoRemoteStatusV1, RemoteCommandError> {
    host.call(Command::Kick {
        viewer_id: request.viewer_id,
    })
    .await
}

#[tauri::command]
pub async fn nano_remote_forget_v1(
    host: State<'_, Arc<RemoteHost>>,
    request: NanoRemoteForgetRequestV1,
) -> Result<NanoRemoteStatusV1, RemoteCommandError> {
    host.call(Command::Forget {
        browser_id: request.browser_id,
    })
    .await
}

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

/// The account and what the actor last saw of it.
struct AccountFeed {
    account: NanoAccount,
    changes: watch::Receiver<NanoAccountStatusV1>,
    generation: AccountGeneration,
    /// Counts generation changes: the core compares it, not the generation.
    epoch: u64,
}

/// A running link: dropping it closes the socket.
struct ActiveLink {
    _handle: LinkHandle,
    sender: LinkSender,
    events: mpsc::Receiver<LinkEvent>,
}

struct Actor {
    app: AppHandle,
    core: Core,
    feed: Option<AccountFeed>,
    link: Option<ActiveLink>,
    inputs: mpsc::Receiver<Input>,
    input_tx: mpsc::Sender<Input>,
    status_tx: watch::Sender<NanoRemoteStatusV1>,
    /// Welcomed browsers, read by the event tap without taking a lock.
    welcomed: Arc<AtomicUsize>,
    /// Set by the event tap when the queue was full and an event was lost.
    overflow: Arc<AtomicBool>,
}

fn view_of(status: &NanoAccountStatusV1, epoch: u64) -> AccountView {
    AccountView {
        epoch,
        state: status.state,
        remote_access: status
            .capabilities
            .map(|capabilities| capabilities.remote_access),
        device: status.device.as_ref().map(|device| DeviceView {
            id: device.id.clone(),
            name: device.name.clone(),
        }),
    }
}

async fn next_link_event(link: &mut Option<ActiveLink>) -> Option<LinkEvent> {
    match link {
        Some(link) => link.events.recv().await,
        None => std::future::pending().await,
    }
}

/// `true` when the account published a status, `false` when it is gone.
async fn next_account_change(feed: &mut Option<AccountFeed>) -> bool {
    match feed {
        Some(feed) => feed.changes.changed().await.is_ok(),
        None => std::future::pending().await,
    }
}

impl Actor {
    async fn run(mut self) {
        let first = self.core.start(Moment::now());
        self.apply(first);
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                input = self.inputs.recv() => {
                    let Some(input) = input else { break };
                    self.on_input(input);
                }
                event = next_link_event(&mut self.link) => {
                    let moment = Moment::now();
                    let effects = match event {
                        Some(event) => self.core.link_event(event, moment),
                        None => {
                            // The link ended on its own (the account changed under it).
                            self.link = None;
                            self.core.link_ended(moment)
                        }
                    };
                    self.apply(effects);
                }
                changed = next_account_change(&mut self.feed) => {
                    if changed {
                        self.on_account();
                    } else {
                        self.feed = None;
                    }
                }
                _ = tick.tick() => {
                    let effects = self.core.tick(Moment::now());
                    self.apply(effects);
                }
            }
            if self.overflow.swap(false, Ordering::Relaxed) {
                let effects = self.core.overflowed();
                self.apply(effects);
            }
            self.welcomed.store(self.core.welcomed(), Ordering::Relaxed);
        }
    }

    fn on_input(&mut self, input: Input) {
        let moment = Moment::now();
        match input {
            Input::Command(command, reply) => {
                let (result, effects) = self.core.command(command, moment);
                self.apply(effects);
                let _ = reply.send(result);
            }
            Input::HostEvent { channel, payload } => {
                let effects = self.core.host_event(channel, &payload);
                self.apply(effects);
            }
            Input::Done { viewer, id, sent } => {
                let effects = self.core.dispatched(&viewer, id, sent);
                self.apply(effects);
            }
        }
    }

    fn on_account(&mut self) {
        let Some(feed) = &mut self.feed else {
            return;
        };
        let (generation, status) = feed.account.status_with_generation();
        if generation != feed.generation {
            feed.generation = generation;
            feed.epoch += 1;
        }
        let view = view_of(&status, feed.epoch);
        let effects = self.core.account_changed(view, Moment::now());
        self.apply(effects);
    }

    /// Carries out effects in order. A frame that cannot be queued drops its
    /// browser, which may produce more effects.
    fn apply(&mut self, effects: Vec<Effect>) {
        let mut queue: VecDeque<Effect> = effects.into();
        while let Some(effect) = queue.pop_front() {
            match effect {
                Effect::Start => self.start_link(),
                Effect::Stop => self.stop_link(),
                Effect::Send { viewer, message } => {
                    let sent = self
                        .link
                        .as_ref()
                        .is_some_and(|link| link.sender.send(&viewer, &message));
                    if !sent {
                        queue.extend(self.core.send_failed(&viewer));
                    }
                }
                Effect::Drop { viewer, reason } => {
                    if let Some(link) = &self.link {
                        link.sender.drop_viewer(&viewer, reason);
                    }
                }
                Effect::Dispatch {
                    viewer,
                    id,
                    admitted,
                } => self.dispatch(viewer, id, *admitted),
                Effect::ShowMain => background::show_main(&self.app),
                Effect::Publish(status) => self.publish(*status),
            }
        }
    }

    fn publish(&self, status: NanoRemoteStatusV1) {
        self.status_tx.send_replace(status.clone());
        let _ = self.app.emit_to(
            MAIN_WINDOW,
            NANO_REMOTE_EVENT_V1,
            NanoRemoteEventV1::Status { status },
        );
    }

    fn start_link(&mut self) {
        let Some(feed) = &self.feed else {
            return;
        };
        let (events_tx, events) = mpsc::channel(LINK_EVENTS);
        let (handle, sender) = link::spawn(feed.account.clone(), feed.generation, events_tx);
        self.link = Some(ActiveLink {
            _handle: handle,
            sender,
            events,
        });
    }

    fn stop_link(&mut self) {
        if let Some(link) = self.link.take() {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FLUSH).await;
                drop(link);
            });
        }
    }

    /// Runs an admitted command off the actor and answers on the link.
    fn dispatch(&self, viewer: String, id: u64, admitted: Admitted) {
        let Some(link) = &self.link else {
            let _ = self.input_tx.try_send(Input::Done {
                viewer,
                id,
                sent: false,
            });
            return;
        };
        let sender = link.sender.clone();
        let app = self.app.clone();
        let done = self.input_tx.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = remote_dispatch::run(&app, admitted).await;
            let (ok, value) = match outcome {
                Ok(value) => (true, value),
                Err(error) => (false, error),
            };
            let frames = match serde_json::to_string(&value) {
                Ok(text) => split_result(id, ok, &text),
                Err(_) => vec![HostMessage::refusal(id, RefusalCode::Invalid)],
            };
            let mut sent = true;
            for frame in &frames {
                if !sender.send_wait(&viewer, frame).await {
                    sent = false;
                    break;
                }
            }
            let _ = done.send(Input::Done { viewer, id, sent }).await;
        });
    }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/// Forwards every allowlisted host event to the actor while a browser is
/// welcomed. A full queue loses the event and raises `overflow`.
fn register_taps(
    app: &AppHandle,
    inputs: &mpsc::Sender<Input>,
    welcomed: &Arc<AtomicUsize>,
    overflow: &Arc<AtomicBool>,
) {
    for channel in remote_dispatch::REMOTE_CHANNELS {
        let inputs = inputs.clone();
        let welcomed = Arc::clone(welcomed);
        let overflow = Arc::clone(overflow);
        app.listen_any(channel, move |event| {
            if welcomed.load(Ordering::Relaxed) == 0 {
                return;
            }
            let input = Input::HostEvent {
                channel,
                payload: event.payload().to_owned(),
            };
            if inputs.try_send(input).is_err() {
                overflow.store(true, Ordering::Relaxed);
            }
        });
    }
}

/// Creates and manages the remote-access host and starts its actor. Nothing
/// here contacts a server: the actor opens the link only when it is wanted,
/// and never in safe mode.
pub(crate) fn install(
    app: AppHandle,
    app_data_dir: &Path,
    nano: Arc<NanoHost>,
    safe_mode: bool,
) -> tauri::async_runtime::JoinHandle<()> {
    // Subscribe before reading the status: a change in between is not missed.
    let started = nano.account().ok().map(|account| {
        let account = account.clone();
        let changes = account.subscribe();
        let (generation, status) = account.status_with_generation();
        let view = view_of(&status, 0);
        let issuer = account.config().origin();
        let feed = AccountFeed {
            account,
            changes,
            generation,
            epoch: 0,
        };
        (feed, view, issuer)
    });
    let (feed, view, issuer) = match started {
        Some((feed, view, issuer)) => (Some(feed), view, issuer),
        None => (
            None,
            AccountView {
                epoch: 0,
                state: piui_nano::status::NanoAccountStateV1::SignedOut,
                remote_access: None,
                device: None,
            },
            piui_nano::wire::NANO_DEFAULT_ISSUER.to_owned(),
        ),
    };
    let core = Core::new(
        CoreConfig {
            safe_mode,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            issuer,
            store_path: Some(app_data_dir.join(STORE_FILE)),
            hooks: Hooks::real(),
        },
        view,
    );
    let (status_tx, status) = watch::channel(core.status().clone());
    let (input_tx, inputs) = mpsc::channel(QUEUE);
    let welcomed = Arc::new(AtomicUsize::new(0));
    let overflow = Arc::new(AtomicBool::new(false));
    if !safe_mode {
        register_taps(&app, &input_tx, &welcomed, &overflow);
    }
    app.manage(Arc::new(RemoteHost {
        inputs: input_tx.clone(),
        status,
    }));
    let actor = Actor {
        app,
        core,
        feed,
        link: None,
        inputs,
        input_tx,
        status_tx,
        welcomed,
        overflow,
    };
    tauri::async_runtime::spawn(actor.run())
}
