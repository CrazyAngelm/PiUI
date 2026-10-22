//! The sidekick broker (ADR-043). It owns every sidekick turn: a round is one
//! admitted turn of the persistent sidekick session, collected into a report
//! that reaches the lead exactly once, either as a `sidekick` tool result or
//! as an automatic follow-up when the lead is idle. Stopping, resetting and
//! a restart pass through states that never let a second writer start while
//! the end of a round is unproven.
//!
//! The workspace is behind [`FusionHost`] so the whole flow runs in tests
//! without native processes.

use super::logic::{
    brief_prompt, build_report, check_brief, file_facts, message_prompt, policy_text, preview,
    progress_text, report_envelope, report_page, truncate_utf8,
};
use super::model::{
    BriefFields, BriefOutcome, BriefState, CORRECTION_HINT_ROUNDS, CallRecord,
    DEFAULT_WAIT_SECONDS, DeliveryState, DeliveryVia, FUSION_PROTOCOL, FactApprovals, FactSource,
    FusionBrief, FusionDelivery, FusionDocument, FusionPair, FusionRoleName, FusionRound,
    FusionSidekickSession, FusionStateV1, FusionStats, MAX_LIVE_BRIEFS, MAX_WAIT_SECONDS,
    RoundKind, RoundOutcome, RoundState, SidekickErrorCode, SidekickOperation, SidekickProgress,
    SidekickState,
};
use super::store::FusionStore;
use crate::review_api::{ReviewArea, ReviewContentV1, ReviewFileV1};
use crate::workspace_api::TurnState;
use chrono::{DateTime, SecondsFormat, Utc};
use piui_runtime::workspace_runtime::{
    PromptMode, SessionStatus, SidekickCallIdentity, TurnOutcome,
};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

pub(crate) type HostFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Why a host action did not happen.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostFailure {
    Unavailable,
    SignInRequired,
}

/// One sidekick session start; the policy (instructions, no board, no
/// plugin MCP, no native subagents) comes from the session hooks.
#[derive(Clone, Debug)]
pub(crate) struct SidekickLaunch {
    pub session_id: String,
    pub workspace_id: String,
    pub lead_session_id: String,
    pub role: super::model::FusionRole,
}

/// What the sidekick is doing right now (live state, never history).
#[derive(Clone, Debug, Default)]
pub(crate) struct SessionActivity {
    pub approval_ids: Vec<String>,
    pub latest: Option<String>,
}

/// The workspace as the broker sees it. Every future owns its arguments.
pub(crate) trait FusionHost: Send + Sync + 'static {
    fn launch_sidekick(&self, launch: SidekickLaunch) -> HostFuture<Result<(), HostFailure>>;
    /// Opens a session that is not live through the ordinary open path,
    /// which applies the frozen sidekick policy again.
    fn ensure_live(&self, session_id: String) -> HostFuture<Result<(), HostFailure>>;
    fn turns(&self, session_id: &str) -> Result<watch::Receiver<TurnState>, HostFailure>;
    fn send(
        &self,
        session_id: String,
        text: String,
        mode: PromptMode,
    ) -> HostFuture<Result<(), HostFailure>>;
    fn interrupt(&self, session_id: String) -> HostFuture<Result<(), HostFailure>>;
    fn close(&self, session_id: String) -> HostFuture<()>;
    /// The id and text of the session's last assistant answer.
    fn last_answer(
        &self,
        session_id: String,
    ) -> HostFuture<Result<Option<(String, String)>, HostFailure>>;
    /// The text of one assistant block of a live session (`None`: the
    /// session has no such block).
    fn answer(
        &self,
        session_id: String,
        block_id: String,
    ) -> HostFuture<Result<Option<String>, HostFailure>>;
    fn activity(&self, session_id: String) -> HostFuture<SessionActivity>;
    /// Working-tree changes of the chat's folder (`None`: not a repository).
    fn changes(&self, lead_session_id: String) -> HostFuture<Option<(Vec<ReviewFileV1>, bool)>>;
    fn file_view(
        &self,
        lead_session_id: String,
        path: String,
        area: ReviewArea,
    ) -> HostFuture<Result<(ReviewContentV1, String), HostFailure>>;
}

type Notifier = Arc<dyn Fn(&str, u64) + Send + Sync>;

/// Time a stop waits for the native turn to end before the round is
/// `uncertain` (and no second writer may start).
const STOP_PROOF: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_secs(1);
const MAX_CACHED_ANSWERS: usize = 256;
const MAX_CALL_RECORDS: usize = 4000;
const DELIVERY_ATTEMPTS: u32 = 3;
const DIFF_PAGE_BYTES: usize = 16 * 1024;

/// One answered call: its operation hash, the answer, and the round whose
/// report the answer handed over.
struct CachedAnswer {
    op_hash: String,
    answer: Value,
    claimed: Option<String>,
}

/// Answers by call key and their insertion order.
type AnswerCache = (HashMap<String, CachedAnswer>, VecDeque<String>);

struct LeadSlot {
    lead_session_id: String,
    pair: FusionPair,
    document: tokio::sync::Mutex<FusionDocument>,
    revision: watch::Sender<u64>,
    /// Tool calls currently waiting for a round's report.
    waiting: Mutex<HashMap<String, usize>>,
    /// Retry answers by call key (memory only).
    answers: Mutex<AnswerCache>,
    activity: Mutex<HashMap<String, String>>,
    /// Send admission of a round's prompt: a stop takes it after marking the
    /// round `stopping`, so either the prompt was already accepted (and the
    /// stop interrupts it) or the start sees the stop and never sends.
    send_gate: tokio::sync::Mutex<()>,
    /// The lead chat was deleted: deliveries and waiters end.
    forgotten: AtomicBool,
}

struct BrokerInner {
    host: Arc<dyn FusionHost>,
    store: Arc<dyn FusionStore>,
    codex_sandbox: bool,
    leads: Mutex<HashMap<String, Arc<LeadSlot>>>,
    /// Session id → (role, lead session id).
    members: Mutex<HashMap<String, (FusionRoleName, String)>>,
    /// Sidekick sessions the broker no longer uses.
    retired: Mutex<HashSet<String>>,
    notifier: Mutex<Option<Notifier>>,
}

/// One tool call waiting for a round's report. Dropping it (the call
/// returned, or its task was aborted when the lead closed) hands a finished
/// report that no tool result took to the follow-up queue.
struct Waiter {
    broker: FusionBroker,
    slot: Arc<LeadSlot>,
    round_id: String,
}

impl Waiter {
    fn new(broker: &FusionBroker, slot: &Arc<LeadSlot>, round_id: &str) -> Self {
        if let Ok(mut waiting) = slot.waiting.lock() {
            *waiting.entry(round_id.to_owned()).or_default() += 1;
        }
        Self {
            broker: broker.clone(),
            slot: Arc::clone(slot),
            round_id: round_id.to_owned(),
        }
    }
}

impl Drop for Waiter {
    fn drop(&mut self) {
        let last = self.slot.waiting.lock().is_ok_and(|mut waiting| {
            let Some(count) = waiting.get_mut(&self.round_id) else {
                return false;
            };
            *count = count.saturating_sub(1);
            let last = *count == 0;
            if last {
                waiting.remove(&self.round_id);
            }
            last
        });
        if last && let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let broker = self.broker.clone();
            let slot = Arc::clone(&self.slot);
            let round_id = std::mem::take(&mut self.round_id);
            runtime.spawn(async move { broker.queue_unclaimed(&slot, &round_id).await });
        }
    }
}

/// Why a round's turn did not start.
enum TurnStart {
    Refused(HostFailure),
    /// A stop reached the round before its prompt was sent.
    Cancelled,
}

fn set_delivery(document: &mut FusionDocument, round_id: &str, delivery: Option<FusionDelivery>) {
    if let Some((brief, index)) = find_round(document, round_id) {
        brief.rounds[index].delivery = delivery;
    }
}

fn delivery(via: DeliveryVia, state: DeliveryState) -> Option<FusionDelivery> {
    Some(FusionDelivery {
        via,
        state,
        updated_at: now(),
    })
}

fn withdrawn(round: &FusionRound) -> bool {
    round
        .delivery
        .as_ref()
        .is_some_and(|delivery| delivery.state == DeliveryState::Withdrawn)
}

fn stopped_error() -> ToolError {
    error(
        SidekickErrorCode::PairStopping,
        "The person stopped this round; its report is not handed over.",
    )
}

fn duration_between(started_at: &str, finished_at: Option<&str>) -> u64 {
    let parse = |text: &str| DateTime::parse_from_rfc3339(text).ok();
    match (parse(started_at), finished_at.and_then(parse)) {
        (Some(start), Some(end)) => u64::try_from((end - start).num_milliseconds()).unwrap_or(0),
        _ => 0,
    }
}

#[derive(Clone)]
pub(crate) struct FusionBroker {
    inner: Arc<BrokerInner>,
}

type ToolError = (SidekickErrorCode, String);

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn epoch_ms() -> u64 {
    u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0)
}

fn error_result(op: &str, code: SidekickErrorCode, message: &str) -> Value {
    let label = serde_json::to_value(code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    json!({
        "ok": false,
        "op": op,
        "code": code,
        "message": message,
        "text": format!("[PiUI sidekick {op} refused: {label}] {message}"),
    })
}

fn error(code: SidekickErrorCode, message: &str) -> ToolError {
    (code, message.to_owned())
}

fn find_round<'a>(
    document: &'a mut FusionDocument,
    round_id: &str,
) -> Option<(&'a mut FusionBrief, usize)> {
    document.briefs.iter_mut().find_map(|brief| {
        let index = brief
            .rounds
            .iter()
            .position(|round| round.round_id == round_id)?;
        Some((brief, index))
    })
}

fn open_round(document: &FusionDocument) -> Option<(&FusionBrief, &FusionRound)> {
    document.briefs.iter().find_map(|brief| {
        brief
            .rounds
            .iter()
            .find(|round| round.state.open())
            .map(|round| (brief, round))
    })
}

fn current_session(document: &FusionDocument) -> Option<&FusionSidekickSession> {
    document
        .sessions
        .iter()
        .rev()
        .find(|session| !session.retired)
}

fn sidekick_state(document: &FusionDocument) -> SidekickState {
    if let Some((_, round)) = open_round(document) {
        return match round.state {
            RoundState::WaitingApproval => SidekickState::WaitingApproval,
            RoundState::Stopping => SidekickState::Stopping,
            _ => SidekickState::Working,
        };
    }
    let uncertain = document
        .briefs
        .iter()
        .flat_map(|brief| &brief.rounds)
        .any(|round| round.state == RoundState::Uncertain);
    match current_session(document) {
        _ if uncertain => SidekickState::Unavailable,
        Some(_) => SidekickState::Idle,
        None => SidekickState::None,
    }
}

fn wait_seconds(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_WAIT_SECONDS)
        .min(MAX_WAIT_SECONDS)
}

impl FusionBroker {
    /// Loads every stored chat. A round or delivery that was in flight when
    /// PiUI stopped is `uncertain`: it is reconciled, never replayed.
    pub(crate) fn new(
        host: Arc<dyn FusionHost>,
        store: Arc<dyn FusionStore>,
        codex_sandbox: bool,
    ) -> Self {
        let broker = Self {
            inner: Arc::new(BrokerInner {
                host,
                store,
                codex_sandbox,
                leads: Mutex::new(HashMap::new()),
                members: Mutex::new(HashMap::new()),
                retired: Mutex::new(HashSet::new()),
                notifier: Mutex::new(None),
            }),
        };
        for mut document in broker.inner.store.load_all() {
            let mut changed = false;
            for round in document
                .briefs
                .iter_mut()
                .flat_map(|brief| &mut brief.rounds)
            {
                if round.state.open() {
                    round.state = RoundState::Uncertain;
                    changed = true;
                }
                // A handoff in flight (a tool result or a follow-up) may or
                // may not have reached the lead: never sent again.
                if let Some(delivery) = round.delivery.as_mut()
                    && delivery.state == DeliveryState::Sending
                {
                    delivery.state = DeliveryState::Uncertain;
                    changed = true;
                }
            }
            if changed {
                document.revision += 1;
                let _ = broker.inner.store.save(&document);
            }
            broker.install(document);
        }
        broker
    }

    pub(crate) fn codex_sandbox(&self) -> bool {
        self.inner.codex_sandbox
    }

    pub(crate) fn set_notifier(&self, notifier: Notifier) {
        if let Ok(mut slot) = self.inner.notifier.lock() {
            *slot = Some(notifier);
        }
    }

    fn install(&self, document: FusionDocument) -> Arc<LeadSlot> {
        let lead = document.lead_session_id.clone();
        if let Ok(mut members) = self.inner.members.lock() {
            members.insert(lead.clone(), (FusionRoleName::Lead, lead.clone()));
            for session in &document.sessions {
                members.insert(
                    session.session_id.clone(),
                    (FusionRoleName::Sidekick, lead.clone()),
                );
            }
        }
        if let Ok(mut retired) = self.inner.retired.lock() {
            retired.extend(
                document
                    .sessions
                    .iter()
                    .filter(|session| session.retired)
                    .map(|session| session.session_id.clone()),
            );
        }
        let slot = Arc::new(LeadSlot {
            lead_session_id: lead.clone(),
            pair: document.pair.clone(),
            revision: watch::channel(document.revision).0,
            document: tokio::sync::Mutex::new(document),
            waiting: Mutex::new(HashMap::new()),
            answers: Mutex::new((HashMap::new(), VecDeque::new())),
            activity: Mutex::new(HashMap::new()),
            send_gate: tokio::sync::Mutex::new(()),
            forgotten: AtomicBool::new(false),
        });
        if let Ok(mut leads) = self.inner.leads.lock() {
            leads.insert(lead, Arc::clone(&slot));
        }
        slot
    }

    /// Starts the deliveries left queued by an earlier process.
    pub(crate) async fn resume_deliveries(&self) {
        let slots: Vec<_> = self
            .inner
            .leads
            .lock()
            .map(|leads| leads.values().cloned().collect())
            .unwrap_or_default();
        for slot in slots {
            let queued: Vec<String> = slot
                .document
                .lock()
                .await
                .briefs
                .iter()
                .flat_map(|brief| &brief.rounds)
                .filter(|round| {
                    round
                        .delivery
                        .as_ref()
                        .is_some_and(|delivery| delivery.state == DeliveryState::Queued)
                })
                .map(|round| round.round_id.clone())
                .collect();
            for round_id in queued {
                self.spawn_delivery(&slot, round_id);
            }
        }
    }

    fn slot(&self, lead: &str) -> Option<Arc<LeadSlot>> {
        self.inner
            .leads
            .lock()
            .ok()
            .and_then(|leads| leads.get(lead).cloned())
    }

    /// The Fusion role of a session and its lead, with the pair.
    pub(crate) fn membership(
        &self,
        session_id: &str,
    ) -> Option<(FusionRoleName, String, FusionPair)> {
        let (role, lead) = self.inner.members.lock().ok()?.get(session_id).cloned()?;
        let pair = self.slot(&lead)?.pair.clone();
        Some((role, lead, pair))
    }

    /// A sidekick session the broker may still use (not retired).
    pub(crate) fn is_current_sidekick(&self, session_id: &str) -> bool {
        self.membership(session_id)
            .is_some_and(|(role, ..)| role == FusionRoleName::Sidekick)
            && self
                .inner
                .retired
                .lock()
                .is_ok_and(|retired| !retired.contains(session_id))
    }

    fn mark_retired(&self, session_id: &str) {
        if let Ok(mut retired) = self.inner.retired.lock() {
            retired.insert(session_id.to_owned());
        }
    }

    /// Whether the person may delete this session's chat: a lead only while
    /// no sidekick round of its pair is open or uncertain.
    pub(crate) async fn deletable(&self, session_id: &str) -> bool {
        let Some((role, lead, _)) = self.membership(session_id) else {
            return true;
        };
        if role != FusionRoleName::Lead {
            return !self.is_current_sidekick(session_id);
        }
        let Some(slot) = self.slot(&lead) else {
            return true;
        };
        let document = slot.document.lock().await;
        open_round(&document).is_none()
            && !document
                .briefs
                .iter()
                .flat_map(|brief| &brief.rounds)
                .any(|round| round.state == RoundState::Uncertain)
    }

    /// A chat was deleted. A deleted lead takes its pair with it: the broker
    /// forgets the chat, removes its journal, ends queued deliveries and
    /// closes the idle sidekick (its catalog entry and history stay). A
    /// deleted retired sidekick is forgotten.
    pub(crate) async fn session_deleted(&self, session_id: &str) {
        let Some((role, lead, _)) = self.membership(session_id) else {
            return;
        };
        if role == FusionRoleName::Sidekick {
            if let Ok(mut members) = self.inner.members.lock() {
                members.remove(session_id);
            }
            if let Ok(mut retired) = self.inner.retired.lock() {
                retired.remove(session_id);
            }
            return;
        }
        let Some(slot) = self.slot(&lead) else {
            return;
        };
        slot.forgotten.store(true, Ordering::Release);
        let (sessions, current) = {
            let document = slot.document.lock().await;
            (
                document
                    .sessions
                    .iter()
                    .map(|session| session.session_id.clone())
                    .collect::<Vec<_>>(),
                current_session(&document).map(|session| session.session_id.clone()),
            )
        };
        self.forget_lead(&lead);
        if let Ok(mut retired) = self.inner.retired.lock() {
            retired.retain(|session| !sessions.contains(session));
        }
        if self.inner.store.forget(&lead).is_err() {
            eprintln!("event=fusion_forget_failed");
        }
        // Wake waiters so they see the chat is gone.
        slot.revision.send_modify(|revision| *revision += 1);
        if let Some(current) = current {
            self.inner.host.close(current).await;
        }
    }

    /// Records a new Fusion chat before its lead session starts, so the start
    /// already gets the `sidekick` tool and the lead instructions.
    pub(crate) fn register_lead(
        &self,
        lead_session_id: &str,
        workspace_id: &str,
        pair: FusionPair,
    ) -> Result<(), ()> {
        let document = FusionDocument {
            protocol: FUSION_PROTOCOL,
            lead_session_id: lead_session_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            pair,
            sessions: Vec::new(),
            briefs: Vec::new(),
            stats: FusionStats::default(),
            revision: 1,
            next_brief: 0,
            next_round: 0,
            calls: Vec::new(),
            folded_briefs: 0,
            round_hosts: Vec::new(),
        };
        self.inner.store.save(&document).map_err(|_| ())?;
        self.install(document);
        Ok(())
    }

    /// Forgets a chat whose lead never started (the stored document stays as
    /// a harmless orphan: no session refers to it).
    pub(crate) fn forget_lead(&self, lead_session_id: &str) {
        if let Ok(mut leads) = self.inner.leads.lock()
            && let Some(slot) = leads.remove(lead_session_id)
        {
            slot.forgotten.store(true, Ordering::Release);
        }
        if let Ok(mut members) = self.inner.members.lock() {
            members.retain(|_, (_, lead)| lead != lead_session_id);
        }
    }

    async fn persist(&self, slot: &LeadSlot, document: &mut FusionDocument) -> bool {
        document.revision += 1;
        let saved = self.inner.store.save(document).is_ok();
        if !saved {
            eprintln!("event=fusion_persist_failed revision={}", document.revision);
        }
        let revision = document.revision;
        slot.revision.send_replace(revision);
        let notifier = self
            .inner
            .notifier
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        if let Some(notifier) = notifier {
            notifier(&slot.lead_session_id, revision);
        }
        saved
    }

    pub(crate) async fn state(&self, lead: &str) -> Option<FusionStateV1> {
        let slot = self.slot(lead)?;
        let document = slot.document.lock().await;
        Some(FusionStateV1 {
            protocol: FUSION_PROTOCOL,
            lead_session_id: document.lead_session_id.clone(),
            workspace_id: document.workspace_id.clone(),
            pair: document.pair.clone(),
            sidekick: sidekick_state(&document),
            sessions: document.sessions.clone(),
            briefs: document.briefs.clone(),
            stats: document.stats,
            revision: document.revision,
        })
    }

    // -----------------------------------------------------------------------
    // Tool calls
    // -----------------------------------------------------------------------

    /// Answers one `sidekick` call of `lead`. The second value names a round
    /// whose report this answer hands over; if the answer cannot reach the
    /// lead, [`Self::delivery_failed`] puts it back.
    pub(crate) async fn handle(
        &self,
        lead: &str,
        identity: &SidekickCallIdentity,
        operation: Map<String, Value>,
    ) -> (Value, Option<String>) {
        let op_name = operation
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let Some(slot) = self.slot(lead) else {
            return (
                error_result(
                    &op_name,
                    SidekickErrorCode::SidekickUnavailable,
                    "This chat is not a Fusion chat.",
                ),
                None,
            );
        };
        let key = identity.call_ref.as_ref().map_or_else(
            || format!("seq:{}:{}", identity.epoch, identity.seq),
            |call_ref| format!("ref:{call_ref}"),
        );
        if let Some(replayed) = self
            .replayed(&slot, &key, &identity.op_hash, &op_name)
            .await
        {
            return replayed;
        }
        let parsed: Result<SidekickOperation, _> = serde_json::from_value(Value::Object(operation));
        let (answer, claimed) = match parsed {
            Err(_) => (
                error_result(
                    &op_name,
                    if op_name == "brief" {
                        SidekickErrorCode::InvalidBrief
                    } else {
                        SidekickErrorCode::UnknownRound
                    },
                    "The sidekick operation is invalid.",
                ),
                None,
            ),
            Ok(operation) => {
                let name = operation.name();
                match self.dispatch(&slot, operation).await {
                    Ok((value, claimed)) => (value, claimed),
                    Err((code, message)) => (error_result(name, code, &message), None),
                }
            }
        };
        if let Ok(mut answers) = slot.answers.lock() {
            let (map, order) = &mut *answers;
            map.insert(
                key.clone(),
                CachedAnswer {
                    op_hash: identity.op_hash.clone(),
                    answer: answer.clone(),
                    claimed: claimed.clone(),
                },
            );
            order.push_back(key);
            while order.len() > MAX_CACHED_ANSWERS {
                if let Some(old) = order.pop_front() {
                    map.remove(&old);
                }
            }
        }
        (answer, claimed)
    }

    /// The same call again: the same answer, or a refusal when its operation
    /// differs. A call handled before a restart is never run again. When the
    /// first answer handed over a report that went back to the follow-up
    /// queue (its write-back failed), the replay takes the report back from
    /// the queue, so the lead never gets it twice.
    async fn replayed(
        &self,
        slot: &LeadSlot,
        key: &str,
        op_hash: &str,
        op_name: &str,
    ) -> Option<(Value, Option<String>)> {
        let cached = slot.answers.lock().ok().and_then(|answers| {
            answers.0.get(key).map(|cached| {
                (
                    cached.op_hash.clone(),
                    cached.answer.clone(),
                    cached.claimed.clone(),
                )
            })
        });
        if let Some((hash, answer, claimed)) = cached {
            if hash != op_hash {
                return Some((
                    error_result(
                        op_name,
                        SidekickErrorCode::IdentityConflict,
                        "This tool call id was already used for another operation.",
                    ),
                    None,
                ));
            }
            let reclaimed = match claimed {
                Some(round_id) => self.reclaim(slot, &round_id).await,
                None => None,
            };
            return Some((answer, reclaimed));
        }
        let mut document = slot.document.lock().await;
        if let Some(record) = document.calls.iter().find(|record| record.key == key) {
            return Some((
                if record.op_hash == op_hash {
                    error_result(
                        op_name,
                        SidekickErrorCode::Uncertain,
                        "This call was handled before PiUI restarted. Use status or wait.",
                    )
                } else {
                    error_result(
                        op_name,
                        SidekickErrorCode::IdentityConflict,
                        "This tool call id was already used for another operation.",
                    )
                },
                None,
            ));
        }
        document.calls.push(CallRecord {
            key: key.to_owned(),
            op_hash: op_hash.to_owned(),
        });
        let excess = document.calls.len().saturating_sub(MAX_CALL_RECORDS);
        document.calls.drain(..excess);
        None
    }

    /// Takes a report queued as a follow-up back for a replayed tool answer
    /// (`queued → tool/sending`). Anything else (the first handoff still in
    /// flight or done, a follow-up already sending or sent) stays as it is.
    async fn reclaim(&self, slot: &LeadSlot, round_id: &str) -> Option<String> {
        let mut document = slot.document.lock().await;
        let (brief, index) = find_round(&mut document, round_id)?;
        let round = &mut brief.rounds[index];
        let previous = round.delivery.clone();
        if !previous.as_ref().is_some_and(|delivery| {
            delivery.via == DeliveryVia::FollowUp && delivery.state == DeliveryState::Queued
        }) {
            return None;
        }
        round.delivery = delivery(DeliveryVia::Tool, DeliveryState::Sending);
        if !self.persist(slot, &mut document).await {
            // Not durably taken: it stays with the follow-up queue.
            set_delivery(&mut document, round_id, previous);
            return None;
        }
        Some(round_id.to_owned())
    }

    async fn dispatch(
        &self,
        slot: &Arc<LeadSlot>,
        operation: SidekickOperation,
    ) -> Result<(Value, Option<String>), ToolError> {
        match operation {
            SidekickOperation::Brief {
                title,
                goal,
                done_when,
                context,
                scope,
                leave_alone,
                constraints,
                verify,
                stop_if,
                wait,
                wait_seconds: seconds,
            } => {
                let fields = BriefFields {
                    title,
                    goal,
                    done_when,
                    context,
                    scope,
                    leave_alone,
                    constraints,
                    verify,
                    stop_if,
                };
                self.brief(slot, fields, wait.unwrap_or(true), seconds)
                    .await
            }
            SidekickOperation::Wait {
                round_id,
                wait_seconds: seconds,
            } => self.wait(slot, round_id, wait_seconds(seconds)).await,
            SidekickOperation::Status {} => Ok((self.status(slot).await, None)),
            SidekickOperation::Message {
                brief_id,
                text,
                wait,
                wait_seconds: seconds,
            } => {
                self.message(slot, &brief_id, &text, wait.unwrap_or(true), seconds)
                    .await
            }
            SidekickOperation::Steer { round_id, text } => self
                .steer(slot, &round_id, text)
                .await
                .map(|value| (value, None)),
            SidekickOperation::Stop {
                round_id,
                take_over,
            } => {
                self.stop(slot, &round_id, take_over.unwrap_or(false), false)
                    .await
            }
            SidekickOperation::Diff {
                paths,
                page,
                fingerprint,
            } => self
                .diff(slot, paths, page.unwrap_or(1), fingerprint)
                .await
                .map(|value| (value, None)),
            SidekickOperation::Report { round_id, page } => self
                .report(slot, &round_id, page.unwrap_or(1))
                .await
                .map(|value| (value, None)),
            SidekickOperation::Close {
                brief_id,
                outcome,
                note,
            } => self
                .close_brief(slot, &brief_id, outcome, note)
                .await
                .map(|value| (value, None)),
            SidekickOperation::Reset { reason } => self
                .reset(slot, reason.as_deref().unwrap_or("lead reset"))
                .await
                .map(|value| (value, None)),
        }
    }

    async fn brief(
        &self,
        slot: &Arc<LeadSlot>,
        fields: BriefFields,
        wait: bool,
        seconds: Option<u64>,
    ) -> Result<(Value, Option<String>), ToolError> {
        let warnings = check_brief(&fields)
            .map_err(|message| error(SidekickErrorCode::InvalidBrief, &message))?;
        let (brief_id, round_id) = {
            let mut document = slot.document.lock().await;
            Self::admit_round(&document)?;
            let before = document.clone();
            document.next_brief += 1;
            document.next_round += 1;
            let brief_id = format!("b{}", document.next_brief);
            let round_id = format!("r{}", document.next_round);
            let session_id = self.sidekick_session_for_new_brief(&mut document);
            let prompt = brief_prompt(&brief_id, &round_id, &fields);
            document.briefs.push(FusionBrief {
                brief_id: brief_id.clone(),
                title: fields.title.trim().to_owned(),
                goal: preview(&fields.goal),
                done_when: fields.done_when.clone(),
                state: BriefState::Active,
                outcome: None,
                note: None,
                sidekick_session_id: session_id.clone(),
                rounds: vec![Self::queued_round(
                    &round_id,
                    RoundKind::Brief,
                    &fields.goal,
                )],
                created_at: now(),
            });
            document.stats.briefs += 1;
            self.fold_old_briefs(&mut document);
            if !self.persist(slot, &mut document).await {
                // Nothing of the refused brief stays, not even a new
                // sidekick session id; the revision stays monotonic.
                let revision = document.revision;
                if !before
                    .sessions
                    .iter()
                    .any(|session| session.session_id == session_id)
                    && let Ok(mut members) = self.inner.members.lock()
                {
                    members.remove(&session_id);
                }
                *document = before;
                document.revision = revision;
                return Err(error(
                    SidekickErrorCode::SidekickUnavailable,
                    "PiUI could not record the brief.",
                ));
            }
            drop(document);
            self.run_round(slot, &brief_id, &round_id, &session_id, prompt)
                .await?;
            (brief_id, round_id)
        };
        let mut result = if wait {
            self.collect(slot, &round_id, wait_seconds(seconds)).await?
        } else {
            (self.progress_result(slot, "brief", &round_id).await, None)
        };
        Self::decorate(
            &mut result.0,
            &brief_id,
            &round_id,
            &warnings,
            slot.pair.options.brief_policy,
        );
        Ok(result)
    }

    fn decorate(
        value: &mut Value,
        brief_id: &str,
        round_id: &str,
        warnings: &[String],
        policy: super::model::BriefPolicy,
    ) {
        if let Some(object) = value.as_object_mut() {
            object.insert("briefId".into(), json!(brief_id));
            object.insert("roundId".into(), json!(round_id));
            if !warnings.is_empty() {
                object.insert("warnings".into(), json!(warnings));
            }
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                let mut text = format!("brief {brief_id} · round {round_id}\n{text}");
                for warning in warnings {
                    text.push_str(&format!("\nwarning: {warning}"));
                }
                text.push_str(&format!("\nbriefing policy: {}", policy_text(policy)));
                object.insert("text".into(), json!(text));
            }
        }
    }

    fn queued_round(round_id: &str, kind: RoundKind, input: &str) -> FusionRound {
        FusionRound {
            round_id: round_id.to_owned(),
            kind,
            state: RoundState::Queued,
            outcome: None,
            status: None,
            started_at: now(),
            finished_at: None,
            answer_block_id: None,
            answer_hash: None,
            preview: preview(input),
            delivery: None,
            take_over: false,
            baseline_block_id: None,
            baseline_known: false,
            started_ms: epoch_ms(),
            report: None,
            full_body: None,
        }
    }

    /// One writer: no round may start while another is open or unproven.
    fn admit_round(document: &FusionDocument) -> Result<(), ToolError> {
        if let Some((brief, round)) = open_round(document) {
            return Err(if round.state == RoundState::Stopping {
                error(
                    SidekickErrorCode::PairStopping,
                    "The sidekick is stopping; wait for it to finish.",
                )
            } else {
                (
                    SidekickErrorCode::BriefActive,
                    format!(
                        "The sidekick is still working on brief {} round {}. Use wait, steer or stop.",
                        brief.brief_id, round.round_id
                    ),
                )
            });
        }
        if document
            .briefs
            .iter()
            .flat_map(|brief| &brief.rounds)
            .any(|round| round.state == RoundState::Uncertain)
        {
            return Err(error(
                SidekickErrorCode::Uncertain,
                "A sidekick round is uncertain after a restart; the person must reconcile it first.",
            ));
        }
        Ok(())
    }

    fn sidekick_session_for_new_brief(&self, document: &mut FusionDocument) -> String {
        if let Some(session) = current_session(document) {
            return session.session_id.clone();
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        document.sessions.push(FusionSidekickSession {
            session_id: session_id.clone(),
            harness: document.pair.sidekick.harness,
            retired: false,
            retired_reason: None,
            created_at: now(),
        });
        if let Ok(mut members) = self.inner.members.lock() {
            members.insert(
                session_id.clone(),
                (FusionRoleName::Sidekick, document.lead_session_id.clone()),
            );
        }
        session_id
    }

    fn fold_old_briefs(&self, document: &mut FusionDocument) {
        while document.briefs.len() > MAX_LIVE_BRIEFS {
            let Some(index) = document.briefs.iter().position(|brief| {
                brief
                    .rounds
                    .iter()
                    .all(|round| !round.state.open() && round.state != RoundState::Uncertain)
            }) else {
                break;
            };
            document.briefs.remove(index);
            document.folded_briefs += 1;
        }
    }

    /// Starts the sidekick (if needed) and sends one round as a new turn.
    async fn run_round(
        &self,
        slot: &Arc<LeadSlot>,
        brief_id: &str,
        round_id: &str,
        session_id: &str,
        prompt: String,
    ) -> Result<(), ToolError> {
        let started = self.start_turn(slot, round_id, session_id, prompt).await;
        let mut document = slot.document.lock().await;
        let Some((brief, index)) = find_round(&mut document, round_id) else {
            return Err(error(SidekickErrorCode::UnknownRound, "The round is gone."));
        };
        match started {
            Ok((receiver, generation)) => {
                let round = &mut brief.rounds[index];
                if round.state == RoundState::Queued {
                    round.state = RoundState::Running;
                }
                self.persist(slot, &mut document).await;
                drop(document);
                self.spawn_watcher(
                    slot,
                    round_id.to_owned(),
                    session_id.to_owned(),
                    receiver,
                    generation,
                );
                Ok(())
            }
            Err(TurnStart::Cancelled) => {
                // Stopped before its prompt was sent: nothing ran, and the
                // stop barrier sees the round finish.
                let round = &mut brief.rounds[index];
                if round.state.open() {
                    round.state = RoundState::Finished;
                    round.outcome = Some(RoundOutcome::Interrupted);
                    round.finished_at = Some(now());
                    round.report = Some(build_report(
                        brief_id,
                        round_id,
                        "",
                        RoundOutcome::Interrupted,
                        0,
                        file_facts(None),
                        FactApprovals {
                            source: FactSource::Host,
                            requested: 0,
                        },
                    ));
                    round.full_body = Some(String::new());
                }
                self.persist(slot, &mut document).await;
                Err(error(
                    SidekickErrorCode::PairStopping,
                    "The round was stopped before the sidekick started it.",
                ))
            }
            Err(TurnStart::Refused(failure)) => {
                let round = &mut brief.rounds[index];
                round.state = RoundState::Finished;
                round.outcome = Some(RoundOutcome::Failed);
                round.finished_at = Some(now());
                if brief.rounds.len() == 1 {
                    brief.state = BriefState::Stopped;
                }
                // A sidekick that never started is retired; the next brief
                // gets a fresh one.
                let fresh = !brief_used_session(&document.briefs, session_id, brief_id);
                if fresh
                    && let Some(session) = document
                        .sessions
                        .iter_mut()
                        .find(|session| session.session_id == session_id && !session.retired)
                {
                    session.retired = true;
                    session.retired_reason = Some("could not start".into());
                    self.mark_retired(session_id);
                }
                self.persist(slot, &mut document).await;
                Err(match failure {
                    HostFailure::SignInRequired => error(
                        SidekickErrorCode::SidekickSignInRequired,
                        "The sidekick's harness needs the person to sign in.",
                    ),
                    HostFailure::Unavailable => error(
                        SidekickErrorCode::SidekickUnavailable,
                        "The sidekick could not start or receive the brief.",
                    ),
                })
            }
        }
    }

    /// A stop that reached the round while it was not yet sent cancels it.
    async fn still_queued(&self, slot: &LeadSlot, round_id: &str) -> Result<(), TurnStart> {
        let document = slot.document.lock().await;
        let queued = document
            .briefs
            .iter()
            .flat_map(|brief| &brief.rounds)
            .any(|round| round.round_id == round_id && round.state == RoundState::Queued);
        if queued {
            Ok(())
        } else {
            Err(TurnStart::Cancelled)
        }
    }

    async fn start_turn(
        &self,
        slot: &LeadSlot,
        round_id: &str,
        session_id: &str,
        prompt: String,
    ) -> Result<(watch::Receiver<TurnState>, u64), TurnStart> {
        let host = &self.inner.host;
        if host.turns(session_id).is_err() {
            let launched = {
                let document = slot.document.lock().await;
                let exists = document.briefs.iter().any(|brief| {
                    brief.sidekick_session_id == session_id
                        && brief
                            .rounds
                            .iter()
                            .any(|round| round.answer_block_id.is_some() || round.outcome.is_some())
                });
                (exists, document.workspace_id.clone())
            };
            let opened = if launched.0 {
                host.ensure_live(session_id.to_owned()).await
            } else {
                match host.ensure_live(session_id.to_owned()).await {
                    Ok(()) => Ok(()),
                    Err(_) => {
                        host.launch_sidekick(SidekickLaunch {
                            session_id: session_id.to_owned(),
                            workspace_id: launched.1,
                            lead_session_id: slot.lead_session_id.clone(),
                            role: slot.pair.sidekick.clone(),
                        })
                        .await
                    }
                }
            };
            opened.map_err(TurnStart::Refused)?;
            self.still_queued(slot, round_id).await?;
        }
        let baseline = host
            .last_answer(session_id.to_owned())
            .await
            .map_err(TurnStart::Refused)?
            .map(|(id, _)| id);
        let _admission = slot.send_gate.lock().await;
        let receiver = host.turns(session_id).map_err(TurnStart::Refused)?;
        let generation = receiver.borrow().generation;
        {
            let mut document = slot.document.lock().await;
            let Some((brief, index)) = find_round(&mut document, round_id) else {
                return Err(TurnStart::Cancelled);
            };
            let round = &mut brief.rounds[index];
            if round.state != RoundState::Queued {
                return Err(TurnStart::Cancelled);
            }
            // The baseline reaches the journal before the turn starts, so a
            // restart can tell this round's answer from an earlier one. A
            // failed write leaves the round without one: after a restart it
            // is unprovable (`uncertain`), never completed by mistake.
            round.baseline_block_id = baseline;
            round.baseline_known = true;
            round.started_ms = epoch_ms();
            self.persist(slot, &mut document).await;
        }
        host.send(session_id.to_owned(), prompt, PromptMode::Prompt)
            .await
            .map_err(TurnStart::Refused)?;
        Ok((receiver, generation))
    }

    fn spawn_watcher(
        &self,
        slot: &Arc<LeadSlot>,
        round_id: String,
        session_id: String,
        mut receiver: watch::Receiver<TurnState>,
        generation: u64,
    ) {
        let broker = self.clone();
        let slot = Arc::clone(slot);
        tokio::spawn(async move {
            let mut approvals: HashSet<String> = HashSet::new();
            let mut waiting_approval = false;
            let outcome = loop {
                let state = *receiver.borrow_and_update();
                if state.generation > generation {
                    break state.outcome;
                }
                if matches!(state.status, SessionStatus::Closed | SessionStatus::Failed) {
                    break Some(TurnOutcome::Failed);
                }
                let activity = broker.inner.host.activity(session_id.clone()).await;
                approvals.extend(activity.approval_ids.iter().cloned());
                if let (Some(latest), Ok(mut map)) = (activity.latest, slot.activity.lock()) {
                    map.insert(round_id.clone(), latest);
                }
                let now_waiting = !activity.approval_ids.is_empty();
                if now_waiting != waiting_approval {
                    waiting_approval = now_waiting;
                    let mut document = slot.document.lock().await;
                    if let Some((brief, index)) = find_round(&mut document, &round_id) {
                        let round = &mut brief.rounds[index];
                        if matches!(
                            round.state,
                            RoundState::Running | RoundState::WaitingApproval
                        ) {
                            round.state = if now_waiting {
                                RoundState::WaitingApproval
                            } else {
                                RoundState::Running
                            };
                            broker.persist(&slot, &mut document).await;
                        }
                    }
                }
                tokio::select! {
                    changed = receiver.changed() => {
                        if changed.is_err() {
                            break Some(TurnOutcome::Failed);
                        }
                    }
                    () = tokio::time::sleep(POLL) => {}
                }
            };
            broker
                .finish_round(&slot, &round_id, &session_id, outcome, approvals.len())
                .await;
        });
    }

    async fn finish_round(
        &self,
        slot: &Arc<LeadSlot>,
        round_id: &str,
        session_id: &str,
        outcome: Option<TurnOutcome>,
        approvals: usize,
    ) {
        let answer = self.inner.host.last_answer(session_id.to_owned()).await;
        let changes = self.inner.host.changes(slot.lead_session_id.clone()).await;
        let mut document = slot.document.lock().await;
        let auto_deliver = document.pair.options.auto_deliver;
        let Some((brief, index)) = find_round(&mut document, round_id) else {
            return;
        };
        let brief_id = brief.brief_id.clone();
        let round = &mut brief.rounds[index];
        if !round.state.open() {
            return;
        }
        let stopping = round.state == RoundState::Stopping;
        let (text, block) = match &answer {
            Ok(Some((block_id, text))) if round.baseline_block_id.as_ref() != Some(block_id) => {
                (text.clone(), Some(block_id.clone()))
            }
            _ => (String::new(), None),
        };
        let round_outcome = match (answer.is_ok(), block.is_some(), outcome) {
            (false, ..) => RoundOutcome::Failed,
            (_, _, Some(TurnOutcome::Interrupted)) => RoundOutcome::Interrupted,
            (_, _, Some(TurnOutcome::Failed) | None) => RoundOutcome::Failed,
            (_, false, Some(TurnOutcome::Succeeded)) => RoundOutcome::NoAnswer,
            (_, true, Some(TurnOutcome::Succeeded)) => RoundOutcome::Completed,
        };
        let elapsed = epoch_ms().saturating_sub(round.started_ms);
        let report = build_report(
            &brief_id,
            round_id,
            &text,
            round_outcome,
            elapsed,
            file_facts(changes),
            FactApprovals {
                source: FactSource::Host,
                requested: approvals as u64,
            },
        );
        round.state = RoundState::Finished;
        round.outcome = Some(round_outcome);
        round.status = Some(report.status);
        round.finished_at = Some(now());
        round.answer_hash = block
            .as_ref()
            .map(|_| piui_runtime::git::sha256_hex(text.as_bytes()));
        round.answer_block_id = block;
        round.report = Some(report);
        round.full_body = Some(text);
        let waiting = slot
            .waiting
            .lock()
            .map(|waiting| waiting.get(round_id).copied().unwrap_or(0))
            .unwrap_or(0);
        let mut deliver = false;
        if stopping && round.delivery.is_some() {
            // A stop of the pair withdrew the delivery in advance.
        } else if waiting == 0
            && auto_deliver
            && !stopping
            && !slot.forgotten.load(Ordering::Acquire)
        {
            round.delivery = Some(FusionDelivery {
                via: DeliveryVia::FollowUp,
                state: DeliveryState::Queued,
                updated_at: now(),
            });
            deliver = true;
        }
        if brief.state == BriefState::Active {
            brief.state = BriefState::Reported;
        }
        document.stats.rounds += 1;
        self.persist(slot, &mut document).await;
        drop(document);
        if let Ok(mut activity) = slot.activity.lock() {
            activity.remove(round_id);
        }
        if deliver {
            self.spawn_delivery(slot, round_id.to_owned());
        }
    }

    /// Waits up to `seconds` for a round and hands its report over. The
    /// waiter registration ends on every path, cancellation included.
    async fn collect(
        &self,
        slot: &Arc<LeadSlot>,
        round_id: &str,
        seconds: u64,
    ) -> Result<(Value, Option<String>), ToolError> {
        let _waiter = Waiter::new(self, slot, round_id);
        self.collect_inner(slot, round_id, seconds).await
    }

    /// A report that finished while a waiter was present but that no tool
    /// result took goes to the follow-up queue.
    async fn queue_unclaimed(&self, slot: &Arc<LeadSlot>, round_id: &str) {
        let queued = {
            let mut document = slot.document.lock().await;
            let auto = document.pair.options.auto_deliver;
            let Some((brief, index)) = find_round(&mut document, round_id) else {
                return;
            };
            let round = &mut brief.rounds[index];
            if !auto
                || round.state != RoundState::Finished
                || round.delivery.is_some()
                || slot.forgotten.load(Ordering::Acquire)
            {
                return;
            }
            round.delivery = delivery(DeliveryVia::FollowUp, DeliveryState::Queued);
            self.persist(slot, &mut document).await;
            true
        };
        if queued {
            self.spawn_delivery(slot, round_id.to_owned());
        }
    }

    async fn collect_inner(
        &self,
        slot: &Arc<LeadSlot>,
        round_id: &str,
        seconds: u64,
    ) -> Result<(Value, Option<String>), ToolError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
        let mut revisions = slot.revision.subscribe();
        let mut expired = false;
        loop {
            if slot.forgotten.load(Ordering::Acquire) {
                return Err(error(
                    SidekickErrorCode::SidekickUnavailable,
                    "The Fusion chat was deleted.",
                ));
            }
            let mut restore = false;
            {
                let mut document = slot.document.lock().await;
                let Some((brief, index)) = find_round(&mut document, round_id) else {
                    return Err(error(
                        SidekickErrorCode::UnknownRound,
                        "There is no such round.",
                    ));
                };
                let round = &mut brief.rounds[index];
                if round.state == RoundState::Uncertain {
                    return Err(error(
                        SidekickErrorCode::Uncertain,
                        "This round is uncertain after a restart; the person reconciles it.",
                    ));
                }
                if round.state == RoundState::Finished && withdrawn(round) {
                    return Err(stopped_error());
                }
                if round.state == RoundState::Finished && round.report.is_none() {
                    // After a restart: read the report back first.
                    restore = true;
                } else if round.state == RoundState::Finished {
                    let claimed = Self::claim(round);
                    let value = Self::report_result("wait", round, !claimed);
                    let rejected = brief
                        .rounds
                        .iter()
                        .filter(|round| round.status != Some(super::model::ReportStatus::Done))
                        .count();
                    let mut value = value;
                    if rejected >= CORRECTION_HINT_ROUNDS
                        && let Some(text) = value.get("text").and_then(Value::as_str)
                    {
                        let hint = format!(
                            "{text}\nhint: {rejected} rounds of this brief did not finish as done. Dictate the exact change, or stop with takeOver and do it yourself."
                        );
                        value["text"] = json!(hint);
                    }
                    self.persist(slot, &mut document).await;
                    return Ok((value, claimed.then(|| round_id.to_owned())));
                }
            }
            if restore {
                self.restore_report(slot, round_id).await?;
                continue;
            }
            // The state is checked once more after the deadline, so a round
            // that finished at that moment is still handed over here.
            if expired {
                return Ok((self.progress_result(slot, "wait", round_id).await, None));
            }
            tokio::select! {
                changed = revisions.changed() => {
                    if changed.is_err() {
                        return Err(error(SidekickErrorCode::SidekickUnavailable, "The Fusion chat closed."));
                    }
                }
                () = tokio::time::sleep_until(deadline) => expired = true,
            }
        }
    }

    /// Takes a finished round's report for a tool result: true when this
    /// call delivers it (it was not delivered, or is queued as a follow-up
    /// that has not been sent yet). A withdrawn delivery is never taken. The
    /// record is `tool/sending` until the workspace confirms the answer
    /// reached the lead ([`Self::delivery_sent`]).
    fn claim(round: &mut FusionRound) -> bool {
        let unclaimed = match &round.delivery {
            None => true,
            Some(delivery) => {
                delivery.via == DeliveryVia::FollowUp && delivery.state == DeliveryState::Queued
            }
        };
        if unclaimed {
            round.delivery = delivery(DeliveryVia::Tool, DeliveryState::Sending);
        }
        unclaimed
    }

    /// Reads a finished round's report back from the sidekick's native
    /// history after a restart: the saved answer block, verified against its
    /// hash. A round without an answer gets its report from the journal
    /// alone. When the answer cannot be read back, the delivery becomes
    /// `uncertain` (never a placeholder marked sent).
    async fn restore_report(&self, slot: &LeadSlot, round_id: &str) -> Result<(), ToolError> {
        let found = {
            let mut document = slot.document.lock().await;
            let (brief, index) = find_round(&mut document, round_id)
                .ok_or_else(|| error(SidekickErrorCode::UnknownRound, "There is no such round."))?;
            let round = &brief.rounds[index];
            if round.report.is_some() || round.state != RoundState::Finished {
                return Ok(());
            }
            (
                brief.brief_id.clone(),
                brief.sidekick_session_id.clone(),
                round.answer_block_id.clone(),
                round.answer_hash.clone(),
                round.outcome.unwrap_or(RoundOutcome::Uncertain),
                duration_between(&round.started_at, round.finished_at.as_deref()),
            )
        };
        let (brief_id, session_id, block, hash, outcome, duration) = found;
        let text = match (block, hash) {
            (None, _) => Some(String::new()),
            (Some(block), Some(hash)) => {
                let host = &self.inner.host;
                match host.ensure_live(session_id.clone()).await {
                    Ok(()) => host
                        .answer(session_id, block)
                        .await
                        .ok()
                        .flatten()
                        .filter(|text| piui_runtime::git::sha256_hex(text.as_bytes()) == hash),
                    Err(_) => None,
                }
            }
            (Some(_), None) => None,
        };
        let mut document = slot.document.lock().await;
        let Some((brief, index)) = find_round(&mut document, round_id) else {
            return Err(error(SidekickErrorCode::UnknownRound, "The round is gone."));
        };
        let round = &mut brief.rounds[index];
        let Some(text) = text else {
            let pending = round.delivery.as_ref().is_none_or(|delivery| {
                delivery.via == DeliveryVia::FollowUp && delivery.state == DeliveryState::Queued
            });
            if pending {
                round.delivery = delivery(DeliveryVia::FollowUp, DeliveryState::Uncertain);
                self.persist(slot, &mut document).await;
            }
            return Err(error(
                SidekickErrorCode::Uncertain,
                "PiUI could not read this report back from the sidekick's history; open the sidekick's chat to read it.",
            ));
        };
        if round.report.is_none() {
            round.report = Some(build_report(
                &brief_id,
                round_id,
                &text,
                outcome,
                duration,
                file_facts(None),
                FactApprovals {
                    source: FactSource::Unknown,
                    requested: 0,
                },
            ));
            round.full_body = Some(text);
        }
        Ok(())
    }

    fn report_result(op: &str, round: &FusionRound, already_delivered: bool) -> Value {
        match &round.report {
            Some(report) => json!({
                "ok": true,
                "op": op,
                "briefId": report.brief_id,
                "roundId": report.round_id,
                "report": report,
                "alreadyDelivered": already_delivered,
                "text": report_envelope(report, already_delivered),
            }),
            None => json!({
                "ok": true,
                "op": op,
                "roundId": round.round_id,
                "alreadyDelivered": already_delivered,
                "text": format!(
                    "[PiUI sidekick round {} finished: {}. The report text is in the sidekick's own history after a restart.]",
                    round.round_id,
                    round.outcome.map_or("unknown", RoundOutcome::label)
                ),
            }),
        }
    }

    async fn progress_result(&self, slot: &LeadSlot, op: &str, round_id: &str) -> Value {
        let document = slot.document.lock().await;
        let found = document.briefs.iter().find_map(|brief| {
            brief
                .rounds
                .iter()
                .find(|round| round.round_id == round_id)
                .map(|round| (brief.brief_id.clone(), round.state, round.started_ms))
        });
        let Some((brief_id, state, started)) = found else {
            return error_result(
                op,
                SidekickErrorCode::UnknownRound,
                "There is no such round.",
            );
        };
        let progress = SidekickProgress {
            brief_id,
            round_id: round_id.to_owned(),
            state,
            elapsed_ms: epoch_ms().saturating_sub(started),
            activity: slot
                .activity
                .lock()
                .ok()
                .and_then(|activity| activity.get(round_id).cloned())
                .map(|line| truncate_utf8(&line, 200).0),
        };
        json!({
            "ok": true,
            "op": op,
            "roundId": round_id,
            "text": progress_text(&progress),
            "progress": progress,
        })
    }

    async fn wait(
        &self,
        slot: &Arc<LeadSlot>,
        round_id: Option<String>,
        seconds: u64,
    ) -> Result<(Value, Option<String>), ToolError> {
        let round_id = match round_id {
            Some(round_id) => round_id,
            None => {
                let document = slot.document.lock().await;
                let open = open_round(&document).map(|(_, round)| round.round_id.clone());
                let pending = document
                    .briefs
                    .iter()
                    .rev()
                    .flat_map(|brief| brief.rounds.iter().rev())
                    .find(|round| {
                        round.state == RoundState::Finished
                            && round
                                .delivery
                                .as_ref()
                                .is_none_or(|delivery| delivery.state == DeliveryState::Queued)
                    })
                    .map(|round| round.round_id.clone());
                match open.or(pending) {
                    Some(round_id) => round_id,
                    None => {
                        return Ok((
                            json!({
                                "ok": true,
                                "op": "wait",
                                "text": "No sidekick round is running and no report is waiting.",
                            }),
                            None,
                        ));
                    }
                }
            }
        };
        self.collect(slot, &round_id, seconds).await
    }

    async fn status(&self, slot: &LeadSlot) -> Value {
        let document = slot.document.lock().await;
        let state = sidekick_state(&document);
        let mut text = format!(
            "[PiUI sidekick status: {}]\nsidekick: {} ({})",
            match state {
                SidekickState::None => "no sidekick session yet (the first brief starts one)",
                SidekickState::Idle => "idle",
                SidekickState::Working => "working",
                SidekickState::WaitingApproval => "waiting for the person to answer an approval",
                SidekickState::Stopping => "stopping",
                SidekickState::Unavailable =>
                    "unavailable until the person reconciles an uncertain round",
            },
            document.pair.sidekick.harness.display_name(),
            document
                .pair
                .sidekick
                .model
                .as_ref()
                .map_or("default model", |model| model.name.as_str())
        );
        if let Some((brief, round)) = open_round(&document) {
            text.push_str(&format!(
                "\nactive: brief {} round {} ({:?})",
                brief.brief_id, round.round_id, round.state
            ));
        }
        for brief in document.briefs.iter().rev().take(5) {
            text.push_str(&format!(
                "\nbrief {} \"{}\": {:?}{}",
                brief.brief_id,
                brief.title,
                brief.state,
                brief
                    .outcome
                    .map(|outcome| format!(" ({outcome:?})"))
                    .unwrap_or_default()
            ));
        }
        text.push_str(&format!(
            "\nbriefing policy: {}",
            policy_text(document.pair.options.brief_policy)
        ));
        json!({ "ok": true, "op": "status", "text": text, "sidekick": state })
    }

    async fn message(
        &self,
        slot: &Arc<LeadSlot>,
        brief_id: &str,
        text: &str,
        wait: bool,
        seconds: Option<u64>,
    ) -> Result<(Value, Option<String>), ToolError> {
        let (round_id, session_id, prompt) = {
            let mut document = slot.document.lock().await;
            Self::admit_round(&document).map_err(|(code, message)| {
                if code == SidekickErrorCode::BriefActive {
                    (SidekickErrorCode::RoundActive, message)
                } else {
                    (code, message)
                }
            })?;
            let before = document.clone();
            let current = current_session(&document).map(|session| session.session_id.clone());
            document.next_round += 1;
            let round_id = format!("r{}", document.next_round);
            let Some(brief) = document
                .briefs
                .iter_mut()
                .find(|brief| brief.brief_id == brief_id)
            else {
                document.next_round -= 1;
                return Err(error(
                    SidekickErrorCode::UnknownBrief,
                    "There is no such brief.",
                ));
            };
            if brief.state == BriefState::Closed {
                document.next_round -= 1;
                return Err(error(
                    SidekickErrorCode::UnknownBrief,
                    "This brief is closed; send a new brief.",
                ));
            }
            if current.as_deref() != Some(brief.sidekick_session_id.as_str()) {
                document.next_round -= 1;
                return Err(error(
                    SidekickErrorCode::SidekickUnavailable,
                    "The sidekick that worked on this brief was reset; send a new brief with the context it needs.",
                ));
            }
            brief
                .rounds
                .push(Self::queued_round(&round_id, RoundKind::Message, text));
            brief.state = BriefState::Active;
            let session_id = brief.sidekick_session_id.clone();
            let prompt = message_prompt(brief_id, &round_id, text);
            if !self.persist(slot, &mut document).await {
                // No correction runs without its durable round and call
                // record; the revision stays monotonic.
                let revision = document.revision;
                *document = before;
                document.revision = revision;
                return Err(error(
                    SidekickErrorCode::SidekickUnavailable,
                    "PiUI could not record the correction.",
                ));
            }
            (round_id, session_id, prompt)
        };
        self.run_round(slot, brief_id, &round_id, &session_id, prompt)
            .await?;
        let mut result = if wait {
            self.collect(slot, &round_id, wait_seconds(seconds)).await?
        } else {
            (self.progress_result(slot, "message", &round_id).await, None)
        };
        Self::decorate(
            &mut result.0,
            brief_id,
            &round_id,
            &[],
            slot.pair.options.brief_policy,
        );
        Ok(result)
    }

    async fn steer(
        &self,
        slot: &LeadSlot,
        round_id: &str,
        text: String,
    ) -> Result<Value, ToolError> {
        let session_id = {
            let mut document = slot.document.lock().await;
            let Some((brief, index)) = find_round(&mut document, round_id) else {
                return Err(error(
                    SidekickErrorCode::UnknownRound,
                    "There is no such round.",
                ));
            };
            match brief.rounds[index].state {
                RoundState::Running | RoundState::WaitingApproval => {}
                RoundState::Finished => {
                    return Err(error(
                        SidekickErrorCode::RoundFinished,
                        "That round already finished; use message for a new round.",
                    ));
                }
                _ => {
                    return Err(error(
                        SidekickErrorCode::RoundActive,
                        "That round cannot take a steer now.",
                    ));
                }
            }
            brief.sidekick_session_id.clone()
        };
        self.inner
            .host
            .send(session_id, text, PromptMode::Steer)
            .await
            .map_err(|_| {
                error(
                    SidekickErrorCode::SteerUnsupported,
                    "The sidekick did not accept the steer.",
                )
            })?;
        Ok(
            json!({ "ok": true, "op": "steer", "roundId": round_id, "text": format!("Steer sent into round {round_id}.") }),
        )
    }

    /// The stop barrier: mark `stopping` before interrupting, wait for the
    /// proof that the turn ended, and only then let anything else start.
    async fn stop(
        &self,
        slot: &Arc<LeadSlot>,
        round_id: &str,
        take_over: bool,
        withdraw_delivery: bool,
    ) -> Result<(Value, Option<String>), ToolError> {
        let session_id = {
            let mut document = slot.document.lock().await;
            let Some((brief, index)) = find_round(&mut document, round_id) else {
                return Err(error(
                    SidekickErrorCode::UnknownRound,
                    "There is no such round.",
                ));
            };
            let round = &mut brief.rounds[index];
            if round.state == RoundState::Finished {
                return Err(error(
                    SidekickErrorCode::RoundFinished,
                    "That round already finished.",
                ));
            }
            if round.state == RoundState::Uncertain {
                return Err(error(
                    SidekickErrorCode::Uncertain,
                    "That round is uncertain; the person reconciles it.",
                ));
            }
            round.state = RoundState::Stopping;
            round.take_over = take_over;
            if withdraw_delivery {
                round.delivery = delivery(DeliveryVia::FollowUp, DeliveryState::Withdrawn);
            }
            let session_id = brief.sidekick_session_id.clone();
            self.persist(slot, &mut document).await;
            session_id
        };
        // A start in progress either sent its prompt already (the interrupt
        // below reaches it) or sees `stopping` and never sends.
        drop(slot.send_gate.lock().await);
        let _ = self.inner.host.interrupt(session_id).await;
        let proven = self.wait_finished(slot, round_id, STOP_PROOF).await;
        let mut document = slot.document.lock().await;
        let Some((brief, index)) = find_round(&mut document, round_id) else {
            return Err(error(SidekickErrorCode::UnknownRound, "The round is gone."));
        };
        if !proven {
            brief.rounds[index].state = RoundState::Uncertain;
            self.persist(slot, &mut document).await;
            return Err(error(
                SidekickErrorCode::Uncertain,
                "The sidekick did not confirm that it stopped; nothing else starts until the person reconciles it.",
            ));
        }
        if take_over {
            brief.state = BriefState::Stopped;
            document.stats.taken_over += 1;
        }
        let Some((_, index)) = find_round(&mut document, round_id) else {
            return Err(error(SidekickErrorCode::UnknownRound, "The round is gone."));
        };
        let brief = document
            .briefs
            .iter_mut()
            .find(|brief| brief.rounds.iter().any(|round| round.round_id == round_id))
            .ok_or_else(|| error(SidekickErrorCode::UnknownRound, "The round is gone."))?;
        let round = &mut brief.rounds[index];
        if !withdraw_delivery && withdrawn(round) {
            // The person withdrew this report while the lead's stop waited.
            self.persist(slot, &mut document).await;
            return Err(stopped_error());
        }
        let claimed = !withdraw_delivery && Self::claim(round);
        let value = Self::report_result("stop", round, !claimed);
        self.persist(slot, &mut document).await;
        Ok((value, claimed.then(|| round_id.to_owned())))
    }

    async fn wait_finished(&self, slot: &LeadSlot, round_id: &str, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        let mut revisions = slot.revision.subscribe();
        loop {
            {
                let document = slot.document.lock().await;
                let finished = document
                    .briefs
                    .iter()
                    .flat_map(|brief| &brief.rounds)
                    .find(|round| round.round_id == round_id)
                    .is_none_or(|round| round.state == RoundState::Finished);
                if finished {
                    return true;
                }
            }
            tokio::select! {
                changed = revisions.changed() => if changed.is_err() { return false; },
                () = tokio::time::sleep_until(deadline) => return false,
            }
        }
    }

    async fn diff(
        &self,
        slot: &LeadSlot,
        paths: Vec<String>,
        page: u32,
        fingerprint: Option<String>,
    ) -> Result<Value, ToolError> {
        let lead = slot.lead_session_id.clone();
        let Some((files, truncated)) = self.inner.host.changes(lead.clone()).await else {
            return Err(error(
                SidekickErrorCode::DiffUnavailable,
                "This folder is not a git repository, so PiUI cannot show a diff.",
            ));
        };
        let selected: Vec<&ReviewFileV1> = files
            .iter()
            .filter(|file| {
                paths.is_empty()
                    || paths.iter().any(|path| {
                        file.path == *path
                            || file
                                .path
                                .starts_with(&format!("{}/", path.trim_end_matches('/')))
                    })
            })
            .collect();
        // The fingerprint binds the page to the file list and to each shown
        // file's content fingerprint, so an edit that keeps the line counts
        // still makes later pages stale.
        let mut listing = files
            .iter()
            .map(|file| {
                format!(
                    "{}\u{0}{:?}\u{0}{:?}\u{0}{:?}",
                    file.path, file.area, file.added, file.removed
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut views = Vec::with_capacity(selected.len());
        for file in selected {
            let view = self
                .inner
                .host
                .file_view(lead.clone(), file.path.clone(), file.area)
                .await;
            listing.push_str(&format!(
                "\n{}\u{0}{:?}\u{0}{}",
                file.path,
                file.area,
                view.as_ref()
                    .map_or("(unreadable)", |(_, content)| content.as_str())
            ));
            views.push((file, view));
        }
        let current = piui_runtime::git::sha256_hex(listing.as_bytes());
        if fingerprint.as_ref().is_some_and(|given| given != &current) {
            return Err(error(
                SidekickErrorCode::DiffStale,
                "The working tree changed since that page; start again from page 1.",
            ));
        }
        let mut pages: Vec<String> = vec![String::new()];
        for (file, view) in views {
            let content = match view {
                Ok((ReviewContentV1::Text { text, .. }, _)) => text,
                Ok((ReviewContentV1::Binary { .. }, _)) => "(binary file)".into(),
                Ok((ReviewContentV1::TooLarge { .. }, _)) => "(too large to show)".into(),
                Ok(_) => "(not shown)".into(),
                Err(_) => "(changed while reading; ask for the diff again)".into(),
            };
            let section = format!("=== {} ({:?})\n{}\n", file.path, file.area, content);
            let (section, _) = truncate_utf8(&section, DIFF_PAGE_BYTES);
            if pages.last().is_some_and(|last| {
                !last.is_empty() && last.len() + section.len() > DIFF_PAGE_BYTES
            }) {
                pages.push(String::new());
            }
            if let Some(last) = pages.last_mut() {
                last.push_str(&section);
            }
        }
        let total = pages.len();
        let index = usize::try_from(page.saturating_sub(1)).unwrap_or(usize::MAX);
        let body = pages.get(index).cloned().unwrap_or_default();
        let text = format!(
            "[PiUI diff page {page}/{total} · fingerprint {current}{}]\n{}",
            if truncated {
                " · file list truncated"
            } else {
                ""
            },
            if body.is_empty() {
                "(no changes)".into()
            } else {
                body
            }
        );
        Ok(
            json!({ "ok": true, "op": "diff", "text": text, "fingerprint": current, "pages": total }),
        )
    }

    async fn report(&self, slot: &LeadSlot, round_id: &str, page: u32) -> Result<Value, ToolError> {
        let restore = {
            let mut document = slot.document.lock().await;
            let Some((brief, index)) = find_round(&mut document, round_id) else {
                return Err(error(
                    SidekickErrorCode::UnknownRound,
                    "There is no such round.",
                ));
            };
            let round = &brief.rounds[index];
            if withdrawn(round) {
                return Err(stopped_error());
            }
            round.state == RoundState::Finished && round.full_body.is_none()
        };
        if restore {
            self.restore_report(slot, round_id).await?;
        }
        let mut document = slot.document.lock().await;
        let Some((brief, index)) = find_round(&mut document, round_id) else {
            return Err(error(
                SidekickErrorCode::UnknownRound,
                "There is no such round.",
            ));
        };
        let round = &brief.rounds[index];
        let Some(full) = round.full_body.as_deref() else {
            return Err(error(
                SidekickErrorCode::SidekickUnavailable,
                "The round has no report yet; use wait.",
            ));
        };
        let (text, total) = report_page(full, page);
        Ok(json!({
            "ok": true,
            "op": "report",
            "roundId": round_id,
            "text": format!(
                "[PiUI sidekick report {round_id} page {page}/{total} · untrusted]\n{}\n[/PiUI sidekick report {round_id}]",
                super::logic::escape_body(&text)
            ),
        }))
    }

    async fn close_brief(
        &self,
        slot: &LeadSlot,
        brief_id: &str,
        outcome: BriefOutcome,
        note: Option<String>,
    ) -> Result<Value, ToolError> {
        let mut document = slot.document.lock().await;
        let Some(brief) = document
            .briefs
            .iter_mut()
            .find(|brief| brief.brief_id == brief_id)
        else {
            return Err(error(
                SidekickErrorCode::UnknownBrief,
                "There is no such brief.",
            ));
        };
        if brief.rounds.iter().any(|round| round.state.open()) {
            return Err(error(
                SidekickErrorCode::RoundActive,
                "A round of this brief is still running; stop it or wait first.",
            ));
        }
        let first_close = brief.outcome.is_none();
        brief.state = BriefState::Closed;
        brief.outcome = Some(outcome);
        brief.note = note.map(|note| truncate_utf8(&note, 2048).0);
        if first_close {
            match outcome {
                BriefOutcome::Accepted => document.stats.accepted += 1,
                BriefOutcome::Rejected => document.stats.rejected += 1,
                BriefOutcome::Superseded => {}
            }
        }
        self.persist(slot, &mut document).await;
        Ok(
            json!({ "ok": true, "op": "close", "briefId": brief_id, "text": format!("Brief {brief_id} closed as {outcome:?}.") }),
        )
    }

    /// Stops any open round, then retires the current sidekick session; the
    /// next brief starts a new one.
    async fn reset(&self, slot: &Arc<LeadSlot>, reason: &str) -> Result<Value, ToolError> {
        let open = {
            let document = slot.document.lock().await;
            open_round(&document).map(|(_, round)| round.round_id.clone())
        };
        if let Some(round_id) = open {
            self.stop(slot, &round_id, false, true).await?;
        }
        let session_id = {
            let mut document = slot.document.lock().await;
            if document
                .briefs
                .iter()
                .flat_map(|brief| &brief.rounds)
                .any(|round| round.state == RoundState::Uncertain)
            {
                return Err(error(
                    SidekickErrorCode::Uncertain,
                    "A sidekick round is uncertain; the person reconciles it first.",
                ));
            }
            let Some(session) = document
                .sessions
                .iter_mut()
                .rev()
                .find(|session| !session.retired)
            else {
                return Ok(
                    json!({ "ok": true, "op": "reset", "text": "There is no sidekick session to reset; the next brief starts one." }),
                );
            };
            session.retired = true;
            session.retired_reason = Some(truncate_utf8(reason, 200).0);
            let session_id = session.session_id.clone();
            self.mark_retired(&session_id);
            self.persist(slot, &mut document).await;
            session_id
        };
        self.inner.host.close(session_id).await;
        Ok(
            json!({ "ok": true, "op": "reset", "text": "The sidekick was reset. The next brief starts a fresh sidekick session; give it the context it needs." }),
        )
    }

    /// The tool answer handing over a round's report reached the lead
    /// (`tool/sending → tool/sent`).
    pub(crate) async fn delivery_sent(&self, lead: &str, round_id: &str) {
        let Some(slot) = self.slot(lead) else {
            return;
        };
        let mut document = slot.document.lock().await;
        let Some((brief, index)) = find_round(&mut document, round_id) else {
            return;
        };
        let round = &mut brief.rounds[index];
        if !round.delivery.as_ref().is_some_and(|delivery| {
            delivery.via == DeliveryVia::Tool && delivery.state == DeliveryState::Sending
        }) {
            return;
        }
        round.delivery = delivery(DeliveryVia::Tool, DeliveryState::Sent);
        self.persist(&slot, &mut document).await;
    }

    /// An answer that could not reach the lead goes back to the queue.
    pub(crate) async fn delivery_failed(&self, lead: &str, round_id: &str) {
        let Some(slot) = self.slot(lead) else {
            return;
        };
        let deliver = {
            let mut document = slot.document.lock().await;
            let auto = document.pair.options.auto_deliver;
            let Some((brief, index)) = find_round(&mut document, round_id) else {
                return;
            };
            let round = &mut brief.rounds[index];
            if !round.delivery.as_ref().is_some_and(|delivery| {
                delivery.via == DeliveryVia::Tool && delivery.state == DeliveryState::Sending
            }) {
                return;
            }
            round.delivery = if auto {
                delivery(DeliveryVia::FollowUp, DeliveryState::Queued)
            } else {
                None
            };
            self.persist(&slot, &mut document).await;
            auto
        };
        if deliver {
            self.spawn_delivery(&slot, round_id.to_owned());
        }
    }

    /// Delivers one queued report as a follow-up once the lead is idle. The
    /// record goes `queued → sending → sent`; a tool call can still take the
    /// report while it is queued, never after it is sending.
    fn spawn_delivery(&self, slot: &Arc<LeadSlot>, round_id: String) {
        let broker = self.clone();
        let slot = Arc::clone(slot);
        tokio::spawn(async move {
            let lead = slot.lead_session_id.clone();
            let mut attempts = 0;
            let mut store_failures = 0;
            loop {
                // Wait for an idle, live lead.
                loop {
                    if !broker.delivery_queued(&slot, &round_id).await {
                        return;
                    }
                    match broker.inner.host.turns(&lead) {
                        Ok(mut receiver) => {
                            if receiver.borrow_and_update().status == SessionStatus::Idle {
                                break;
                            }
                            tokio::select! {
                                _ = receiver.changed() => {}
                                () = tokio::time::sleep(Duration::from_secs(2)) => {}
                            }
                        }
                        Err(_) => tokio::time::sleep(Duration::from_secs(3)).await,
                    }
                }
                // After a restart the report is read back from the native
                // history first; if that fails the delivery is `uncertain`.
                if broker.restore_report(&slot, &round_id).await.is_err() {
                    return;
                }
                let text = {
                    let mut document = slot.document.lock().await;
                    let Some((brief, index)) = find_round(&mut document, &round_id) else {
                        return;
                    };
                    let round = &mut brief.rounds[index];
                    if !round
                        .delivery
                        .as_ref()
                        .is_some_and(|delivery| delivery.state == DeliveryState::Queued)
                    {
                        return;
                    }
                    let Some(report) = round.report.as_ref() else {
                        return;
                    };
                    let text = format!(
                        "{}\nThe sidekick finished while you were idle. Review the report and continue.",
                        report_envelope(report, false)
                    );
                    let previous = round.delivery.clone();
                    round.delivery = delivery(DeliveryVia::FollowUp, DeliveryState::Sending);
                    // `sending` is durable before the prompt leaves, so a
                    // restart never sends it a second time.
                    if !broker.persist(&slot, &mut document).await {
                        set_delivery(&mut document, &round_id, previous);
                        drop(document);
                        store_failures += 1;
                        if store_failures >= DELIVERY_ATTEMPTS {
                            // It stays queued: a tool call can take it, and
                            // the next start resumes it.
                            return;
                        }
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                    text
                };
                let sent = broker
                    .inner
                    .host
                    .send(lead.clone(), text, PromptMode::Prompt)
                    .await;
                attempts += 1;
                let mut document = slot.document.lock().await;
                let Some((brief, index)) = find_round(&mut document, &round_id) else {
                    return;
                };
                let round = &mut brief.rounds[index];
                let state = match sent {
                    Ok(()) => DeliveryState::Sent,
                    Err(_) if attempts >= DELIVERY_ATTEMPTS => DeliveryState::Uncertain,
                    Err(_) => DeliveryState::Queued,
                };
                round.delivery = Some(FusionDelivery {
                    via: DeliveryVia::FollowUp,
                    state,
                    updated_at: now(),
                });
                broker.persist(&slot, &mut document).await;
                drop(document);
                if state != DeliveryState::Queued {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
    }

    async fn delivery_queued(&self, slot: &LeadSlot, round_id: &str) -> bool {
        if slot.forgotten.load(Ordering::Acquire) {
            return false;
        }
        let document = slot.document.lock().await;
        document
            .briefs
            .iter()
            .flat_map(|brief| &brief.rounds)
            .find(|round| round.round_id == round_id)
            .and_then(|round| round.delivery.as_ref())
            .is_some_and(|delivery| delivery.state == DeliveryState::Queued)
    }

    // -----------------------------------------------------------------------
    // The person's commands
    // -----------------------------------------------------------------------

    /// Stops the sidekick's open round without delivering its report.
    pub(crate) async fn stop_sidekick(&self, lead: &str) -> Result<(), SidekickErrorCode> {
        let slot = self
            .slot(lead)
            .ok_or(SidekickErrorCode::SidekickUnavailable)?;
        let open = {
            let document = slot.document.lock().await;
            open_round(&document).map(|(_, round)| round.round_id.clone())
        };
        if let Some(round_id) = open {
            self.stop(&slot, &round_id, false, true)
                .await
                .map_err(|(code, _)| code)?;
        }
        Ok(())
    }

    pub(crate) async fn reset_sidekick(&self, lead: &str) -> Result<(), SidekickErrorCode> {
        let slot = self
            .slot(lead)
            .ok_or(SidekickErrorCode::SidekickUnavailable)?;
        self.reset(&slot, "reset by the person")
            .await
            .map(|_| ())
            .map_err(|(code, _)| code)
    }

    /// Settles an uncertain round from the sidekick's own history: an answer
    /// after the round's baseline finishes it (marked recovered); otherwise
    /// it stays uncertain for the person to abandon. Never starts work.
    pub(crate) async fn reconcile(
        &self,
        lead: &str,
        round_id: &str,
    ) -> Result<bool, SidekickErrorCode> {
        let slot = self
            .slot(lead)
            .ok_or(SidekickErrorCode::SidekickUnavailable)?;
        let session_id = {
            let mut document = slot.document.lock().await;
            let (brief, index) =
                find_round(&mut document, round_id).ok_or(SidekickErrorCode::UnknownRound)?;
            let round = &brief.rounds[index];
            if round.state != RoundState::Uncertain {
                return Err(SidekickErrorCode::RoundFinished);
            }
            // Without a recorded baseline (an older journal, or a round that
            // never reached its send) no answer can be proven to be this
            // round's: it stays uncertain for the person to abandon.
            if !round.baseline_known {
                return Ok(false);
            }
            brief.sidekick_session_id.clone()
        };
        let host = &self.inner.host;
        host.ensure_live(session_id.clone())
            .await
            .map_err(|_| SidekickErrorCode::SidekickUnavailable)?;
        let running = host
            .turns(&session_id)
            .map(|receiver| receiver.borrow().status == SessionStatus::Running)
            .unwrap_or(true);
        if running {
            return Ok(false);
        }
        let answer = host.last_answer(session_id.clone()).await.ok().flatten();
        let has_new = {
            let mut document = slot.document.lock().await;
            let (brief, index) =
                find_round(&mut document, round_id).ok_or(SidekickErrorCode::UnknownRound)?;
            let round = &mut brief.rounds[index];
            let fresh = answer
                .as_ref()
                .is_some_and(|(id, _)| round.baseline_block_id.as_ref() != Some(id));
            if fresh {
                // `finish_round` takes it from here, from an open state.
                round.state = RoundState::Running;
            }
            fresh
        };
        if !has_new {
            return Ok(false);
        }
        self.finish_round(
            &slot,
            round_id,
            &session_id,
            Some(TurnOutcome::Succeeded),
            0,
        )
        .await;
        Ok(true)
    }

    pub(crate) async fn abandon(
        &self,
        lead: &str,
        round_id: &str,
    ) -> Result<(), SidekickErrorCode> {
        let slot = self
            .slot(lead)
            .ok_or(SidekickErrorCode::SidekickUnavailable)?;
        let mut document = slot.document.lock().await;
        let (brief, index) =
            find_round(&mut document, round_id).ok_or(SidekickErrorCode::UnknownRound)?;
        let round = &mut brief.rounds[index];
        if round.state != RoundState::Uncertain {
            return Err(SidekickErrorCode::RoundFinished);
        }
        round.state = RoundState::Finished;
        round.outcome = Some(RoundOutcome::Uncertain);
        round.finished_at = Some(now());
        if let Some(delivery) = round.delivery.as_mut()
            && delivery.state == DeliveryState::Uncertain
        {
            delivery.state = DeliveryState::Withdrawn;
        }
        brief.state = BriefState::Stopped;
        self.persist(&slot, &mut document).await;
        Ok(())
    }
}

fn brief_used_session(briefs: &[FusionBrief], session_id: &str, except: &str) -> bool {
    briefs.iter().any(|brief| {
        brief.brief_id != except
            && brief.sidekick_session_id == session_id
            && brief.rounds.iter().any(|round| round.outcome.is_some())
    })
}
