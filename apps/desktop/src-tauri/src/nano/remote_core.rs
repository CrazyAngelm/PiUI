//! The state machine of remote access (ADR-062): which browsers are talking
//! to this computer, which one is waiting for the person's decision, and when
//! the outbound link may exist.
//!
//! The core is plain data. It takes one input at a time together with the
//! current [`Moment`] and answers with [`Effect`]s for the actor in
//! `remote.rs` to carry out (open or close the link, write a frame, run an
//! admitted command, bring the window forward, publish the status). It never
//! touches the network, the clock, the window or the operating system's
//! random source on its own, so the tests in `remote_tests.rs` need no Tauri
//! runtime.
//!
//! Trust: a browser is welcomed only after it proved possession of its
//! non-extractable key with a signature bound to this device and to its relay
//! session ([`piui_nano::remote::pairing`]). A key this computer has never
//! seen needs the person's decision at this computer; a remembered key does
//! not. Nothing here reads a token or sees credentials, and no `Debug` output
//! prints a payload.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use piui_nano::remote::frames::{
    AppInfo, ByeReason, DeniedReason, DeviceInfo, DropReason, Grant, HostMessage, MAX_FRAME_BYTES,
    MAX_IN_FLIGHT, MAX_REQUEST_ID, MAX_VIEWERS, PAIRING_SECONDS, PROTOCOL, RefusalCode,
    ViewerMessage, Welcome,
};
use piui_nano::remote::grants::{RemoteStore, StoreError, StoredBrowser};
use piui_nano::remote::link::{LinkEvent, LinkState};
use piui_nano::remote::pairing::{
    RawKey, decode_key, encode_key, fingerprint, new_nonce, pairing_code, proof_message,
    sanitize_label, verify_proof,
};
use piui_nano::status::NanoAccountStateV1;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::remote_dispatch::{self, Admitted, Refusal};

/// Time a browser has to send its `hello` and then its `proof`.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);
/// Denials and timeouts are counted over this window.
const DENIAL_WINDOW: Duration = Duration::from_secs(600);
/// Unknown browsers are refused for this long after [`MAX_DENIALS`].
const LOCKOUT: Duration = Duration::from_secs(600);
const MAX_DENIALS: usize = 3;
/// A link that ended without being asked to waits this long before the
/// supervisor opens another.
const RESTART_DELAY: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Status (contracts/nano-remote-v1.ts)
// ---------------------------------------------------------------------------

/// `NanoRemoteLinkStateV1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LinkStateV1 {
    Off,
    Connecting,
    Online,
    Retrying,
    Refused,
}

/// `NanoRemoteUnavailableV1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum UnavailableV1 {
    SafeMode,
    SignedOut,
    UnsupportedServer,
}

/// `NanoRemoteViewerV1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ViewerV1 {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) fingerprint: String,
    pub(crate) grant: Grant,
    pub(crate) connected_at: String,
}

/// `NanoRemotePairingV1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PairingV1 {
    pub(crate) request_id: String,
    pub(crate) label: String,
    pub(crate) code: String,
    pub(crate) fingerprint: String,
    pub(crate) expires_at: String,
}

/// `NanoRemoteBrowserV1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserV1 {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) fingerprint: String,
    pub(crate) created_at: String,
    pub(crate) last_used_at: Option<String>,
}

/// `NanoRemoteStatusV1`: everything the WebView may know. It holds no token
/// and no key material beyond a short public-key fingerprint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NanoRemoteStatusV1 {
    pub(crate) protocol: u8,
    pub(crate) revision: u64,
    pub(crate) unavailable: Option<UnavailableV1>,
    pub(crate) enabled: bool,
    pub(crate) link: LinkStateV1,
    pub(crate) viewers: Vec<ViewerV1>,
    pub(crate) pending: Option<PairingV1>,
    pub(crate) browsers: Vec<BrowserV1>,
}

/// `NanoRemoteEventV1`, emitted as `piui://nano-remote-v1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum NanoRemoteEventV1 {
    Status { status: NanoRemoteStatusV1 },
}

/// `NanoRemoteDecisionV1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Decision {
    Deny,
    Once,
    Always,
}

/// `NanoRemoteErrorCodeV1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RemoteError {
    #[error("invalid")]
    #[expect(
        dead_code,
        reason = "frozen NanoRemoteErrorCodeV1 member; no settings command takes free-form input yet"
    )]
    Invalid,
    #[error("safe-mode")]
    SafeMode,
    #[error("sign-in-required")]
    SignInRequired,
    #[error("unsupported-server")]
    UnsupportedServer,
    #[error("not-found")]
    NotFound,
    #[error("limit")]
    Limit,
    #[error("io")]
    Io,
}

impl From<StoreError> for RemoteError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Full => Self::Limit,
            StoreError::Io => Self::Io,
            StoreError::NotFound => Self::NotFound,
        }
    }
}

/// The longest session id a `gap` frame carries.
const MAX_GAP_SESSION_BYTES: usize = 128;

/// The `sessionId` of a host event, when it has a short one: the browser then
/// reads only that session again. The rest of the (possibly huge) document is
/// skipped, never copied.
fn event_session(payload: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Probe {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    }
    serde_json::from_str::<Probe>(payload)
        .ok()?
        .session_id
        .filter(|id| !id.is_empty() && id.len() <= MAX_GAP_SESSION_BYTES)
}

// ---------------------------------------------------------------------------
// Inputs and effects
// ---------------------------------------------------------------------------

/// A command of the WebView's remote-access settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Command {
    SetEnabled(bool),
    Decide {
        request_id: String,
        decision: Decision,
    },
    Kick {
        viewer_id: String,
    },
    Forget {
        browser_id: String,
    },
}

/// The clock of one step: a monotonic instant for deadlines and the wall
/// time for stamps shown to the person.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Moment {
    pub(crate) mono: Instant,
    pub(crate) wall: DateTime<Utc>,
}

impl Moment {
    pub(crate) fn now() -> Self {
        Self {
            mono: Instant::now(),
            wall: Utc::now(),
        }
    }
}

/// What the account says that matters here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AccountView {
    /// Changes whenever the account's generation changes (sign-out, expiry,
    /// a new sign-in): everything bound to the old one ends.
    pub(crate) epoch: u64,
    pub(crate) state: NanoAccountStateV1,
    /// `None` until discovery answered.
    pub(crate) remote_access: Option<bool>,
    pub(crate) device: Option<DeviceView>,
}

/// The account's device on this computer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeviceView {
    pub(crate) id: String,
    pub(crate) name: String,
}

/// Replaceable sources of randomness and verification, so the tests are
/// deterministic. [`Hooks::real`] is the production set.
#[derive(Clone, Copy)]
pub(crate) struct Hooks {
    pub(crate) verify: fn(&RawKey, &[u8], &str) -> bool,
    pub(crate) nonce: fn() -> Option<String>,
    pub(crate) id: fn(&str) -> String,
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

impl Hooks {
    pub(crate) fn real() -> Self {
        Self {
            verify: verify_proof,
            nonce: new_nonce,
            id: random_id,
        }
    }
}

/// What the actor must do. Effects of one step are applied in order.
#[derive(Debug)]
pub(crate) enum Effect {
    /// Open the link.
    Start,
    /// Close the link (after the frames queued before it had a moment to go).
    Stop,
    Send {
        viewer: String,
        message: HostMessage,
    },
    Drop {
        viewer: String,
        reason: DropReason,
    },
    Dispatch {
        viewer: String,
        id: u64,
        admitted: Box<Admitted>,
    },
    /// Bring the main window to the front.
    ShowMain,
    Publish(Box<NanoRemoteStatusV1>),
}

/// The settings of a core.
pub(crate) struct CoreConfig {
    pub(crate) safe_mode: bool,
    pub(crate) version: String,
    /// The issuer origin the store is bound to.
    pub(crate) issuer: String,
    /// Where the store lives; `None` keeps it in memory (tests).
    pub(crate) store_path: Option<PathBuf>,
    pub(crate) hooks: Hooks,
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

enum ViewerState {
    AwaitHello {
        deadline: Instant,
    },
    AwaitProof {
        key: RawKey,
        key_text: String,
        label: String,
        nonce: String,
        deadline: Instant,
    },
    /// Waiting for the person; the details are in [`Core::pending`].
    Pending,
    Welcomed {
        key_text: String,
        label: String,
        fingerprint: String,
        grant: Grant,
        connected_at: DateTime<Utc>,
        in_flight: HashSet<u64>,
    },
}

struct Pending {
    viewer: String,
    request_id: String,
    who: Who,
    code: String,
    expires_at: DateTime<Utc>,
    deadline: Instant,
}

/// A browser as shown to the person and remembered by its key.
#[derive(Clone)]
struct Who {
    key_text: String,
    label: String,
    fingerprint: String,
}

#[derive(Clone, Copy)]
enum Phase {
    Hello,
    Proof,
    Pending,
    Welcomed,
}

pub(crate) struct Core {
    hooks: Hooks,
    safe_mode: bool,
    version: String,
    issuer: String,
    store_path: Option<PathBuf>,
    account: AccountView,
    store: Option<RemoteStore>,
    /// Set when switching off could not be written: the link stays closed
    /// until the person switches on again or the account changes.
    force_off: bool,
    /// The server answered 403, 404 or 426: no new link until the person
    /// toggles or the account changes.
    refused: bool,
    /// A link task exists.
    running: bool,
    link: LinkStateV1,
    restart_after: Option<Instant>,
    viewers: HashMap<String, ViewerState>,
    pending: Option<Pending>,
    denials: VecDeque<Instant>,
    locked_until: Option<Instant>,
    published: NanoRemoteStatusV1,
}

fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

impl Core {
    /// A core for `account`; reads the store of its device when it has one.
    pub(crate) fn new(config: CoreConfig, account: AccountView) -> Self {
        let mut core = Self {
            hooks: config.hooks,
            safe_mode: config.safe_mode,
            version: config.version,
            issuer: config.issuer,
            store_path: config.store_path,
            account,
            store: None,
            force_off: false,
            refused: false,
            running: false,
            link: LinkStateV1::Off,
            restart_after: None,
            viewers: HashMap::new(),
            pending: None,
            denials: VecDeque::new(),
            locked_until: None,
            published: NanoRemoteStatusV1 {
                protocol: 1,
                revision: 1,
                unavailable: None,
                enabled: false,
                link: LinkStateV1::Off,
                viewers: Vec::new(),
                pending: None,
                browsers: Vec::new(),
            },
        };
        core.sync_store();
        core.published = core.build(1);
        core
    }

    /// The status as last published.
    pub(crate) fn status(&self) -> &NanoRemoteStatusV1 {
        &self.published
    }

    /// How many browsers are welcomed (the event tap reads this).
    pub(crate) fn welcomed(&self) -> usize {
        self.viewers
            .values()
            .filter(|state| matches!(state, ViewerState::Welcomed { .. }))
            .count()
    }

    /// The first supervision after construction: opens the link when the
    /// stored toggle and the account call for it.
    pub(crate) fn start(&mut self, moment: Moment) -> Vec<Effect> {
        let mut effects = Vec::new();
        self.supervise(&mut effects, moment);
        self.finish(&mut effects);
        effects
    }

    // -- derived state ------------------------------------------------------

    fn unavailable(&self) -> Option<UnavailableV1> {
        if self.safe_mode {
            return Some(UnavailableV1::SafeMode);
        }
        match self.account.state {
            NanoAccountStateV1::SignedIn | NanoAccountStateV1::Offline => {}
            NanoAccountStateV1::Unsupported => return Some(UnavailableV1::UnsupportedServer),
            NanoAccountStateV1::SignedOut
            | NanoAccountStateV1::SigningIn
            | NanoAccountStateV1::Expired => return Some(UnavailableV1::SignedOut),
        }
        (self.account.remote_access == Some(false)).then_some(UnavailableV1::UnsupportedServer)
    }

    fn enabled(&self) -> bool {
        self.store.as_ref().is_some_and(RemoteStore::enabled)
    }

    fn build(&self, revision: u64) -> NanoRemoteStatusV1 {
        let link = if self.running {
            self.link
        } else if self.refused && self.enabled() {
            LinkStateV1::Refused
        } else {
            LinkStateV1::Off
        };
        let mut viewers: Vec<ViewerV1> = self
            .viewers
            .iter()
            .filter_map(|(id, state)| match state {
                ViewerState::Welcomed {
                    label,
                    fingerprint,
                    grant,
                    connected_at,
                    ..
                } => Some(ViewerV1 {
                    id: id.clone(),
                    label: label.clone(),
                    fingerprint: fingerprint.clone(),
                    grant: *grant,
                    connected_at: stamp(*connected_at),
                }),
                _ => None,
            })
            .collect();
        viewers.sort_by(|a, b| {
            a.connected_at
                .cmp(&b.connected_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        NanoRemoteStatusV1 {
            protocol: 1,
            revision,
            unavailable: self.unavailable(),
            enabled: self.enabled(),
            link,
            viewers,
            pending: self.pending.as_ref().map(|pending| PairingV1 {
                request_id: pending.request_id.clone(),
                label: pending.who.label.clone(),
                code: pending.code.clone(),
                fingerprint: pending.who.fingerprint.clone(),
                expires_at: stamp(pending.expires_at),
            }),
            browsers: self
                .store
                .as_ref()
                .map(|store| {
                    store
                        .browsers()
                        .iter()
                        .map(|browser| BrowserV1 {
                            id: browser.id.clone(),
                            label: browser.label.clone(),
                            fingerprint: browser.fingerprint.clone(),
                            created_at: browser.created_at.clone(),
                            last_used_at: browser.last_used_at.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// Publishes the status when something visible changed.
    fn finish(&mut self, effects: &mut Vec<Effect>) {
        let next = self.build(self.published.revision);
        if next != self.published {
            let mut next = next;
            next.revision += 1;
            self.published = next.clone();
            effects.push(Effect::Publish(Box::new(next)));
        }
    }

    /// Makes the store belong to the account's device on this computer.
    fn sync_store(&mut self) {
        let wanted = self.account.device.as_ref().map(|device| device.id.clone());
        let current = self
            .store
            .as_ref()
            .map(|store| store.device_id().to_owned());
        if wanted == current {
            return;
        }
        self.store = wanted.map(|device| match &self.store_path {
            Some(path) => RemoteStore::load(path, &self.issuer, &device),
            None => RemoteStore::in_memory(&self.issuer, &device),
        });
    }

    // -- link supervision -----------------------------------------------------

    /// Opens or closes the link as the toggle, the account and the server's
    /// capability call for it.
    fn supervise(&mut self, effects: &mut Vec<Effect>, moment: Moment) {
        let eligible = self.unavailable().is_none()
            && self.enabled()
            && !self.force_off
            && !self.refused
            && self.account.remote_access == Some(true)
            && self.account.device.is_some();
        let state = self.account.state;
        let may_start = state == NanoAccountStateV1::SignedIn
            && self.restart_after.is_none_or(|after| moment.mono >= after);
        let may_keep = state == NanoAccountStateV1::SignedIn
            || (state == NanoAccountStateV1::Offline && self.running);
        if self.running {
            if !(eligible && may_keep) {
                let bye = match self.unavailable() {
                    Some(UnavailableV1::SignedOut) => ByeReason::SignedOut,
                    _ => ByeReason::Disabled,
                };
                self.close_link(effects, bye);
            }
        } else if eligible && may_start {
            self.running = true;
            self.link = LinkStateV1::Connecting;
            self.restart_after = None;
            effects.push(Effect::Start);
        }
    }

    /// Tells every browser why, then closes the link. No-op without a link.
    fn close_link(&mut self, effects: &mut Vec<Effect>, bye: ByeReason) {
        if !self.running {
            return;
        }
        let drop_reason = match bye {
            ByeReason::Kicked => DropReason::Kicked,
            ByeReason::Disabled | ByeReason::SignedOut | ByeReason::Quit => DropReason::Disabled,
        };
        let mut ids: Vec<String> = self.viewers.keys().cloned().collect();
        ids.sort();
        for id in ids {
            match self.viewers.get(&id) {
                Some(ViewerState::Welcomed { .. }) => effects.push(Effect::Send {
                    viewer: id.clone(),
                    message: HostMessage::Bye { reason: bye },
                }),
                Some(ViewerState::Pending) => effects.push(Effect::Send {
                    viewer: id.clone(),
                    message: HostMessage::Denied {
                        reason: DeniedReason::Denied,
                    },
                }),
                _ => {}
            }
            effects.push(Effect::Drop {
                viewer: id,
                reason: drop_reason,
            });
        }
        self.viewers.clear();
        self.pending = None;
        self.running = false;
        self.link = LinkStateV1::Off;
        effects.push(Effect::Stop);
    }

    /// Forgets every browser without writing anything (the link is down or
    /// was replaced: the server closed them).
    fn reset_viewers(&mut self) {
        self.viewers.clear();
        self.pending = None;
    }

    fn drop_viewer(&mut self, effects: &mut Vec<Effect>, viewer: &str, reason: DropReason) {
        self.viewers.remove(viewer);
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.viewer == viewer)
        {
            self.pending = None;
        }
        effects.push(Effect::Drop {
            viewer: viewer.to_owned(),
            reason,
        });
    }

    fn send(effects: &mut Vec<Effect>, viewer: &str, message: HostMessage) {
        effects.push(Effect::Send {
            viewer: viewer.to_owned(),
            message,
        });
    }

    fn record_denial(&mut self, now: Instant) {
        while self
            .denials
            .front()
            .is_some_and(|first| now.duration_since(*first) > DENIAL_WINDOW)
        {
            self.denials.pop_front();
        }
        self.denials.push_back(now);
        if self.denials.len() >= MAX_DENIALS {
            self.locked_until = Some(now + LOCKOUT);
            self.denials.clear();
        }
    }

    fn locked(&self, now: Instant) -> bool {
        self.locked_until.is_some_and(|until| now < until)
    }

    // -- account ------------------------------------------------------------

    /// The account changed: a new generation ends everything bound to the old
    /// one; otherwise the link follows the new state.
    pub(crate) fn account_changed(&mut self, view: AccountView, moment: Moment) -> Vec<Effect> {
        let mut effects = Vec::new();
        if view.epoch != self.account.epoch {
            self.close_link(&mut effects, ByeReason::SignedOut);
            self.store = None;
            self.force_off = false;
            self.refused = false;
            self.restart_after = None;
            self.denials.clear();
            self.locked_until = None;
        }
        self.account = view;
        self.sync_store();
        self.supervise(&mut effects, moment);
        self.finish(&mut effects);
        effects
    }

    // -- commands -----------------------------------------------------------

    /// Runs a command of the WebView. The effects are returned even when the
    /// command failed, because a failed switch-off still closes the link.
    pub(crate) fn command(
        &mut self,
        command: Command,
        moment: Moment,
    ) -> (Result<(), RemoteError>, Vec<Effect>) {
        let mut effects = Vec::new();
        let result = match command {
            Command::SetEnabled(enabled) => self.set_enabled(enabled, moment, &mut effects),
            Command::Decide {
                request_id,
                decision,
            } => self.decide(&request_id, decision, moment, &mut effects),
            Command::Kick { viewer_id } => self.kick(&viewer_id, &mut effects),
            Command::Forget { browser_id } => self.forget(&browser_id, &mut effects),
        };
        self.finish(&mut effects);
        (result, effects)
    }

    fn set_enabled(
        &mut self,
        enabled: bool,
        moment: Moment,
        effects: &mut Vec<Effect>,
    ) -> Result<(), RemoteError> {
        if enabled {
            match self.unavailable() {
                Some(UnavailableV1::SafeMode) => return Err(RemoteError::SafeMode),
                Some(UnavailableV1::SignedOut) => return Err(RemoteError::SignInRequired),
                Some(UnavailableV1::UnsupportedServer) => {
                    return Err(RemoteError::UnsupportedServer);
                }
                None => {}
            }
            let store = self.store.as_mut().ok_or(RemoteError::SignInRequired)?;
            store.set_enabled(true).map_err(|_| RemoteError::Io)?;
            self.force_off = false;
            self.refused = false;
            self.restart_after = None;
            self.supervise(effects, moment);
            return Ok(());
        }
        let written = match self.store.as_mut() {
            Some(store) if store.enabled() => store.set_enabled(false).map_err(|_| RemoteError::Io),
            _ => Ok(()),
        };
        if written.is_err() {
            // The switch could not be saved, but the person asked for off:
            // the link closes and stays closed.
            self.force_off = true;
        }
        self.refused = false;
        self.close_link(effects, ByeReason::Disabled);
        written
    }

    fn decide(
        &mut self,
        request_id: &str,
        decision: Decision,
        moment: Moment,
        effects: &mut Vec<Effect>,
    ) -> Result<(), RemoteError> {
        let waiting = self
            .pending
            .as_ref()
            .filter(|pending| pending.request_id == request_id)
            .ok_or(RemoteError::NotFound)?;
        let viewer = waiting.viewer.clone();
        match decision {
            Decision::Deny => {
                self.pending = None;
                Self::send(
                    effects,
                    &viewer,
                    HostMessage::Denied {
                        reason: DeniedReason::Denied,
                    },
                );
                self.drop_viewer(effects, &viewer, DropReason::Denied);
                self.record_denial(moment.mono);
            }
            Decision::Once => {
                let who = waiting.who.clone();
                self.pending = None;
                self.welcome(effects, &viewer, who, Grant::Once, moment);
            }
            Decision::Always => {
                let who = waiting.who.clone();
                let id = (self.hooks.id)("br");
                let store = self.store.as_mut().ok_or(RemoteError::SignInRequired)?;
                store
                    .remember(StoredBrowser {
                        id,
                        label: who.label.clone(),
                        fingerprint: who.fingerprint.clone(),
                        key: who.key_text.clone(),
                        created_at: stamp(moment.wall),
                        last_used_at: Some(stamp(moment.wall)),
                        workbench: true,
                    })
                    .map_err(RemoteError::from)?;
                self.pending = None;
                self.welcome(effects, &viewer, who, Grant::Always, moment);
            }
        }
        Ok(())
    }

    fn kick(&mut self, viewer_id: &str, effects: &mut Vec<Effect>) -> Result<(), RemoteError> {
        if !matches!(
            self.viewers.get(viewer_id),
            Some(ViewerState::Welcomed { .. })
        ) {
            return Err(RemoteError::NotFound);
        }
        Self::send(
            effects,
            viewer_id,
            HostMessage::Bye {
                reason: ByeReason::Kicked,
            },
        );
        self.drop_viewer(effects, viewer_id, DropReason::Kicked);
        Ok(())
    }

    fn forget(&mut self, browser_id: &str, effects: &mut Vec<Effect>) -> Result<(), RemoteError> {
        let store = self.store.as_mut().ok_or(RemoteError::NotFound)?;
        let forgotten = store.forget(browser_id).map_err(RemoteError::from)?;
        let mut using: Vec<String> = self
            .viewers
            .iter()
            .filter(|(_, state)| {
                matches!(state, ViewerState::Welcomed { key_text, .. } if *key_text == forgotten.key)
            })
            .map(|(id, _)| id.clone())
            .collect();
        using.sort();
        for viewer in using {
            Self::send(
                effects,
                &viewer,
                HostMessage::Bye {
                    reason: ByeReason::Kicked,
                },
            );
            self.drop_viewer(effects, &viewer, DropReason::Kicked);
        }
        Ok(())
    }

    // -- link events --------------------------------------------------------

    /// One event of the link.
    pub(crate) fn link_event(&mut self, event: LinkEvent, moment: Moment) -> Vec<Effect> {
        let mut effects = Vec::new();
        if !self.running {
            return effects;
        }
        match event {
            LinkEvent::State(state) => match state {
                LinkState::Connecting => self.restate(LinkStateV1::Connecting),
                LinkState::Online => self.restate(LinkStateV1::Online),
                LinkState::Retrying => self.restate(LinkStateV1::Retrying),
                LinkState::Refused => {
                    self.reset_viewers();
                    self.link = LinkStateV1::Off;
                    self.running = false;
                    self.refused = true;
                    effects.push(Effect::Stop);
                }
            },
            LinkEvent::ViewerOpen(viewer) => {
                if self.viewers.contains_key(&viewer) {
                    // The server never reuses an id; start that viewer over.
                    self.drop_viewer(&mut effects, &viewer, DropReason::Protocol);
                } else if self.viewers.len() >= MAX_VIEWERS {
                    effects.push(Effect::Drop {
                        viewer,
                        reason: DropReason::Protocol,
                    });
                } else {
                    self.viewers.insert(
                        viewer,
                        ViewerState::AwaitHello {
                            deadline: moment.mono + HANDSHAKE_DEADLINE,
                        },
                    );
                }
            }
            LinkEvent::ViewerClose(viewer) => {
                self.viewers.remove(&viewer);
                if self
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.viewer == viewer)
                {
                    self.pending = None;
                }
            }
            LinkEvent::Message { viewer, body } => {
                self.on_message(&viewer, body, moment, &mut effects);
            }
            LinkEvent::Malformed { viewer } => {
                if self.viewers.contains_key(&viewer) {
                    self.drop_viewer(&mut effects, &viewer, DropReason::Protocol);
                }
            }
        }
        self.finish(&mut effects);
        effects
    }

    /// The link task ended without being asked to (its events stopped).
    pub(crate) fn link_ended(&mut self, moment: Moment) -> Vec<Effect> {
        let mut effects = Vec::new();
        if self.running {
            self.reset_viewers();
            self.running = false;
            self.link = LinkStateV1::Off;
            self.restart_after = Some(moment.mono + RESTART_DELAY);
            effects.push(Effect::Stop);
        }
        self.finish(&mut effects);
        effects
    }

    /// A connection state: every browser of the previous connection is gone.
    fn restate(&mut self, link: LinkStateV1) {
        self.link = link;
        self.reset_viewers();
    }

    fn on_message(
        &mut self,
        viewer: &str,
        body: ViewerMessage,
        moment: Moment,
        effects: &mut Vec<Effect>,
    ) {
        let phase = match self.viewers.get(viewer) {
            Some(ViewerState::AwaitHello { .. }) => Phase::Hello,
            Some(ViewerState::AwaitProof { .. }) => Phase::Proof,
            Some(ViewerState::Pending) => Phase::Pending,
            Some(ViewerState::Welcomed { .. }) => Phase::Welcomed,
            None => {
                effects.push(Effect::Drop {
                    viewer: viewer.to_owned(),
                    reason: DropReason::Protocol,
                });
                return;
            }
        };
        match (phase, body) {
            (Phase::Hello, ViewerMessage::Hello { proto, key, label }) => {
                self.on_hello(viewer, proto, &key, &label, moment, effects);
            }
            (Phase::Proof, ViewerMessage::Proof { sig }) => {
                self.on_proof(viewer, &sig, moment, effects);
            }
            (Phase::Welcomed, ViewerMessage::Req { id, cmd, args }) => {
                self.on_request(viewer, id, &cmd, &args, effects);
            }
            // An unknown kind after the welcome carries nothing for us.
            (Phase::Welcomed, ViewerMessage::Unknown) => {}
            // Anything else is out of order: a second hello, a proof before a
            // hello, a request before the welcome, any message while waiting
            // for the person, an unknown kind before the welcome.
            _ => self.drop_viewer(effects, viewer, DropReason::Protocol),
        }
    }

    fn on_hello(
        &mut self,
        viewer: &str,
        proto: u32,
        key: &str,
        label: &str,
        moment: Moment,
        effects: &mut Vec<Effect>,
    ) {
        let Some(raw) = decode_key(key).filter(|_| proto == PROTOCOL) else {
            self.drop_viewer(effects, viewer, DropReason::Protocol);
            return;
        };
        let Some(nonce) = (self.hooks.nonce)() else {
            self.drop_viewer(effects, viewer, DropReason::Protocol);
            return;
        };
        self.viewers.insert(
            viewer.to_owned(),
            ViewerState::AwaitProof {
                key: raw,
                key_text: encode_key(&raw),
                label: sanitize_label(label),
                nonce: nonce.clone(),
                deadline: moment.mono + HANDSHAKE_DEADLINE,
            },
        );
        Self::send(effects, viewer, HostMessage::Challenge { nonce });
    }

    fn on_proof(&mut self, viewer: &str, sig: &str, moment: Moment, effects: &mut Vec<Effect>) {
        let Some(ViewerState::AwaitProof {
            key,
            key_text,
            label,
            nonce,
            ..
        }) = self.viewers.get(viewer)
        else {
            self.drop_viewer(effects, viewer, DropReason::Protocol);
            return;
        };
        let (key, key_text, label, nonce) = (*key, key_text.clone(), label.clone(), nonce.clone());
        let Some(device_id) = self.account.device.as_ref().map(|device| device.id.clone()) else {
            self.drop_viewer(effects, viewer, DropReason::Protocol);
            return;
        };
        let message = proof_message(&device_id, viewer, &nonce);
        if !(self.hooks.verify)(&key, message.as_bytes(), sig) {
            self.drop_viewer(effects, viewer, DropReason::Protocol);
            return;
        }
        let known = self
            .store
            .as_ref()
            .and_then(|store| store.find_by_key(&key_text))
            .filter(|browser| browser.workbench)
            .map(|browser| (browser.id.clone(), browser.label.clone()));
        if let Some((browser_id, stored_label)) = known {
            if let Some(store) = self.store.as_mut() {
                // Only the "last used" stamp is lost when this cannot be written.
                let _ = store.touch(&browser_id, &stamp(moment.wall));
            }
            let who = Who {
                key_text,
                label: stored_label,
                fingerprint: fingerprint(&key),
            };
            self.welcome(effects, viewer, who, Grant::Always, moment);
            return;
        }
        if self.pending.is_some() || self.locked(moment.mono) {
            Self::send(
                effects,
                viewer,
                HostMessage::Denied {
                    reason: DeniedReason::Busy,
                },
            );
            self.drop_viewer(effects, viewer, DropReason::Denied);
            return;
        }
        let Some(code) = pairing_code(&key, &nonce) else {
            self.drop_viewer(effects, viewer, DropReason::Protocol);
            return;
        };
        let seconds = i64::try_from(PAIRING_SECONDS).unwrap_or(120);
        self.pending = Some(Pending {
            viewer: viewer.to_owned(),
            request_id: (self.hooks.id)("req"),
            who: Who {
                key_text,
                label,
                fingerprint: fingerprint(&key),
            },
            code: code.clone(),
            expires_at: moment.wall + chrono::Duration::seconds(seconds),
            deadline: moment.mono + Duration::from_secs(PAIRING_SECONDS),
        });
        self.viewers.insert(viewer.to_owned(), ViewerState::Pending);
        Self::send(
            effects,
            viewer,
            HostMessage::Approval {
                code,
                expires_in: PAIRING_SECONDS,
            },
        );
        effects.push(Effect::ShowMain);
    }

    /// Welcomes `viewer` with `grant`.
    fn welcome(
        &mut self,
        effects: &mut Vec<Effect>,
        viewer: &str,
        who: Who,
        grant: Grant,
        moment: Moment,
    ) {
        let Some(device) = self.account.device.clone() else {
            self.drop_viewer(effects, viewer, DropReason::Protocol);
            return;
        };
        self.viewers.insert(
            viewer.to_owned(),
            ViewerState::Welcomed {
                key_text: who.key_text,
                label: who.label,
                fingerprint: who.fingerprint,
                grant,
                connected_at: moment.wall,
                in_flight: HashSet::new(),
            },
        );
        Self::send(
            effects,
            viewer,
            HostMessage::Welcome(Welcome {
                proto: PROTOCOL,
                device: DeviceInfo {
                    id: device.id,
                    name: device.name,
                },
                app: AppInfo {
                    version: self.version.clone(),
                },
                grant,
                shell: remote_dispatch::SHELL_CONTRACTS,
                commands: remote_dispatch::REMOTE_COMMANDS
                    .iter()
                    .map(|command| (*command).to_owned())
                    .collect(),
                channels: remote_dispatch::REMOTE_CHANNELS
                    .iter()
                    .map(|channel| (*channel).to_owned())
                    .collect(),
            }),
        );
    }

    fn on_request(
        &mut self,
        viewer: &str,
        id: u64,
        command: &str,
        args: &Value,
        effects: &mut Vec<Effect>,
    ) {
        if id == 0 || id > MAX_REQUEST_ID {
            self.drop_viewer(effects, viewer, DropReason::Protocol);
            return;
        }
        let refuse = |effects: &mut Vec<Effect>, code: RefusalCode| {
            Self::send(effects, viewer, HostMessage::refusal(id, code));
        };
        let admitted = match remote_dispatch::admit(command, args) {
            Ok(admitted) => admitted,
            Err(Refusal::NotAllowed) => return refuse(effects, RefusalCode::NotAllowed),
            Err(Refusal::Invalid) => return refuse(effects, RefusalCode::Invalid),
        };
        let Some(ViewerState::Welcomed { in_flight, .. }) = self.viewers.get_mut(viewer) else {
            return;
        };
        if in_flight.contains(&id) {
            return refuse(effects, RefusalCode::Invalid);
        }
        if in_flight.len() >= MAX_IN_FLIGHT {
            return refuse(effects, RefusalCode::Busy);
        }
        in_flight.insert(id);
        effects.push(Effect::Dispatch {
            viewer: viewer.to_owned(),
            id,
            admitted: Box::new(admitted),
        });
    }

    // -- host events and housekeeping -----------------------------------------

    /// A host event on an allowlisted channel, as the text of its JSON
    /// payload, for every welcomed browser. A payload that would not fit one
    /// frame is not forwarded; each browser gets a small `gap` frame instead,
    /// so it reads the state again rather than waiting for an event that
    /// never comes (an oversized approval has no successor).
    pub(crate) fn host_event(&mut self, channel: &str, payload: &str) -> Vec<Effect> {
        let mut ids: Vec<&String> = self
            .viewers
            .iter()
            .filter(|(_, state)| matches!(state, ViewerState::Welcomed { .. }))
            .map(|(id, _)| id)
            .collect();
        ids.sort();
        let oversized = payload.len() + channel.len() + 64 > MAX_FRAME_BYTES;
        let session = if oversized && !ids.is_empty() {
            event_session(payload)
        } else {
            None
        };
        let mut effects = Vec::new();
        for id in ids {
            let message = if oversized {
                Some(HostMessage::Gap {
                    ch: channel.to_owned(),
                    sid: session.clone(),
                })
            } else {
                HostMessage::event(channel, payload.to_owned())
            };
            if let Some(message) = message {
                effects.push(Effect::Send {
                    viewer: id.clone(),
                    message,
                });
            }
        }
        effects
    }

    /// The event queue overflowed: events were lost, so every welcomed
    /// browser is dropped and reloads when it reconnects.
    pub(crate) fn overflowed(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        let mut ids: Vec<String> = self
            .viewers
            .iter()
            .filter(|(_, state)| matches!(state, ViewerState::Welcomed { .. }))
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        for id in ids {
            self.drop_viewer(&mut effects, &id, DropReason::Protocol);
        }
        self.finish(&mut effects);
        effects
    }

    /// A frame for `viewer` could not be queued: the browser is dropped.
    pub(crate) fn send_failed(&mut self, viewer: &str) -> Vec<Effect> {
        let mut effects = Vec::new();
        if self.viewers.contains_key(viewer) {
            self.drop_viewer(&mut effects, viewer, DropReason::Protocol);
        }
        self.finish(&mut effects);
        effects
    }

    /// An admitted command finished and its frames were queued (`sent`) or
    /// could not be.
    pub(crate) fn dispatched(&mut self, viewer: &str, id: u64, sent: bool) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Some(ViewerState::Welcomed { in_flight, .. }) = self.viewers.get_mut(viewer) {
            in_flight.remove(&id);
            if !sent {
                self.drop_viewer(&mut effects, viewer, DropReason::Protocol);
            }
        }
        self.finish(&mut effects);
        effects
    }

    /// Deadlines: a handshake that stalls, a pairing request nobody answered,
    /// and a link waiting to be restarted.
    pub(crate) fn tick(&mut self, moment: Moment) -> Vec<Effect> {
        let mut effects = Vec::new();
        let mut stalled: Vec<String> =
            self.viewers
                .iter()
                .filter(|(_, state)| match state {
                    ViewerState::AwaitHello { deadline }
                    | ViewerState::AwaitProof { deadline, .. } => moment.mono >= *deadline,
                    _ => false,
                })
                .map(|(id, _)| id.clone())
                .collect();
        stalled.sort();
        for id in stalled {
            self.drop_viewer(&mut effects, &id, DropReason::Protocol);
        }
        if let Some(pending) = &self.pending
            && moment.mono >= pending.deadline
        {
            let viewer = pending.viewer.clone();
            self.pending = None;
            Self::send(
                &mut effects,
                &viewer,
                HostMessage::Denied {
                    reason: DeniedReason::Timeout,
                },
            );
            self.drop_viewer(&mut effects, &viewer, DropReason::Denied);
            self.record_denial(moment.mono);
        }
        if self.locked_until.is_some_and(|until| moment.mono >= until) {
            self.locked_until = None;
        }
        self.supervise(&mut effects, moment);
        self.finish(&mut effects);
        effects
    }
}
