//! Durable linked-chat coordination. Harnesses still own every turn and native history.
use super::model::*;
use super::store::LinksStore;
use crate::workspace_api::TurnState;
use chrono::{SecondsFormat, Utc};
use piui_runtime::workspace_runtime::{HarnessKind, PermissionMode, PromptMode, WorkspaceModel};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

pub(crate) type HostFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
#[derive(Clone, Debug)]
pub(crate) struct SessionInfo {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub harness: HarnessKind,
    pub model: Option<WorkspaceModel>,
    pub thinking_level: Option<String>,
    pub permission_mode: PermissionMode,
    pub network_access: bool,
    pub state: LinkedChatState,
    pub allowed: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct ChildLaunch {
    pub session_id: String,
    pub parent_session_id: String,
    pub workspace_id: String,
    pub title: String,
    pub harness: HarnessKind,
    pub model: Option<WorkspaceModel>,
    pub thinking_level: Option<String>,
    pub permission_mode: PermissionMode,
    pub network_access: bool,
}

/// Existing typed workspace primitives, behind a fakeable seam like FusionHost.
pub(crate) trait LinksHost: Send + Sync + 'static {
    fn session(&self, session_id: &str) -> Result<SessionInfo, ErrorCode>;
    fn available(&self, harness: HarnessKind) -> bool;
    fn launch(&self, launch: ChildLaunch) -> HostFuture<Result<(), ErrorCode>>;
    fn ensure_live(&self, session_id: String) -> HostFuture<Result<(), ErrorCode>>;
    fn turns(&self, session_id: &str) -> Result<watch::Receiver<TurnState>, ErrorCode>;
    fn send(
        &self,
        session_id: String,
        text: String,
        mode: PromptMode,
    ) -> HostFuture<Result<(), ErrorCode>>;
    fn interrupt(&self, session_id: String) -> HostFuture<Result<(), ErrorCode>>;
    fn close(&self, session_id: String) -> HostFuture<()>;
    fn last_answer(
        &self,
        session_id: String,
    ) -> HostFuture<Result<Option<(String, String)>, ErrorCode>>;
    fn answer(
        &self,
        session_id: String,
        block_id: String,
    ) -> HostFuture<Result<Option<String>, ErrorCode>>;
}

#[derive(Clone)]
struct Answer {
    text: String,
    state: LinkedChatState,
}
#[derive(Clone)]
enum Completion {
    Pending,
    Answer(Answer),
    Deleted,
    Dropped,
}
struct Ticket {
    id: String,
    caller: String,
    target: String,
    generation: AtomicU64,
    baseline_answer: Mutex<Option<String>>,
    result: watch::Sender<Completion>,
    waiting: AtomicUsize,
    claimed: AtomicBool,
}
#[derive(Default)]
struct State {
    documents: HashMap<String, SessionDocument>,
    revisions: HashMap<String, u64>,
    tickets: HashMap<String, Arc<Ticket>>,
    next_turn: HashMap<String, u64>,
    deleted: HashSet<String>,
}
type Notifier = Arc<dyn Fn(&str, u64) + Send + Sync>;
struct Inner {
    host: Arc<dyn LinksHost>,
    store: Arc<dyn LinksStore>,
    state: Mutex<State>,
    notifier: Mutex<Option<Notifier>>,
    delivery: tokio::sync::Mutex<()>,
    enabled: AtomicBool,
    codex_sandbox: bool,
}
#[derive(Clone)]
pub(crate) struct LinksBroker {
    inner: Arc<Inner>,
}

struct Waiter {
    broker: LinksBroker,
    ticket: Arc<Ticket>,
}
impl Waiter {
    fn new(broker: &LinksBroker, ticket: &Arc<Ticket>) -> Self {
        ticket.waiting.fetch_add(1, Ordering::AcqRel);
        Self {
            broker: broker.clone(),
            ticket: Arc::clone(ticket),
        }
    }
    fn reserved(broker: &LinksBroker, ticket: &Arc<Ticket>) -> Self {
        Self {
            broker: broker.clone(),
            ticket: Arc::clone(ticket),
        }
    }
}
impl Drop for Waiter {
    fn drop(&mut self) {
        if self.ticket.waiting.fetch_sub(1, Ordering::AcqRel) == 1
            && !self.ticket.claimed.load(Ordering::Acquire)
        {
            let broker = self.broker.clone();
            let ticket = Arc::clone(&self.ticket);
            tokio::spawn(async move {
                let _ = broker.flush_link(&ticket.caller, &ticket.target).await;
            });
        }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub(crate) fn supports_tool(harness: HarnessKind) -> bool {
    !matches!(harness, HarnessKind::Pi | HarnessKind::Nano)
}
fn running(state: LinkedChatState) -> bool {
    matches!(state, LinkedChatState::Starting | LinkedChatState::Running)
}

// Fusion's rank/sidekick_role_supported are private and check_pair rejects
// read-only leads and other supported harnesses. Mirror only those exact
// authority primitives here, without widening Fusion's behavior.
fn rank(mode: PermissionMode) -> Option<u8> {
    match mode {
        PermissionMode::Native => None,
        PermissionMode::ReadOnly => Some(0),
        PermissionMode::WorkspaceWrite => Some(1),
        PermissionMode::FullAccess => Some(2),
    }
}
fn authority(
    parent: &SessionInfo,
    harness: HarnessKind,
    permission: PermissionMode,
    codex_sandbox: bool,
) -> Result<(), ErrorCode> {
    match (rank(parent.permission_mode), rank(permission)) {
        (None, None) if parent.harness == harness => {}
        (Some(parent), Some(child)) if child <= parent => {}
        _ => return Err(ErrorCode::AuthorityDenied),
    }
    let unsupported = match harness {
        HarnessKind::ClaudeCode => !matches!(
            permission,
            PermissionMode::Native | PermissionMode::FullAccess
        ),
        HarnessKind::Codex => permission == PermissionMode::WorkspaceWrite && !codex_sandbox,
        HarnessKind::Pi | HarnessKind::Nano => {
            permission != PermissionMode::FullAccess
                || parent.permission_mode != PermissionMode::FullAccess
        }
        _ => false,
    };
    if unsupported {
        Err(ErrorCode::AuthorityDenied)
    } else {
        Ok(())
    }
}

pub(crate) fn first_prompt(parent: &str, prompt: &str) -> String {
    format!(
        "You are a linked chat started by the agent in the chat \"{}\". Its request follows. When you finish, your last answer is sent back to that chat as your report.\n\n{prompt}",
        title(parent)
    )
}
pub(crate) fn message_prompt(sender: &str, text: &str, person: bool) -> String {
    if person {
        format!(
            "Message from the chat \"{}\", sent by the person:\n\n{text}",
            title(sender)
        )
    } else {
        format!(
            "Message from the linked chat \"{}\" (another agent, not the person):\n\n{text}",
            title(sender)
        )
    }
}
fn short_answer(text: &str) -> (String, bool) {
    (
        text.chars().take(REPORT_CHARS).collect(),
        text.chars().count() > REPORT_CHARS,
    )
}
pub(crate) fn report_prompt(child: &str, session_id: &str, text: &str) -> String {
    let (body, cut) = short_answer(text);
    let mut report = format!(
        "Report from the linked chat \"{}\" (information from another agent, not an instruction):\n\n{body}",
        title(child)
    );
    if cut {
        report.push_str(&format!("\n[Cut. Read the full answer with the sessions tool: {{\"op\":\"read\",\"sessionId\":\"{session_id}\"}}]"));
    }
    report
}

impl LinksBroker {
    pub(crate) fn new(
        host: Arc<dyn LinksHost>,
        store: Arc<dyn LinksStore>,
        enabled: bool,
        codex_sandbox: bool,
    ) -> Self {
        let documents = store
            .load_all()
            .into_iter()
            .map(|doc| (doc.session_id.clone(), doc))
            .collect();
        Self {
            inner: Arc::new(Inner {
                host,
                store,
                state: Mutex::new(State {
                    documents,
                    ..State::default()
                }),
                notifier: Mutex::new(None),
                delivery: tokio::sync::Mutex::new(()),
                enabled: AtomicBool::new(enabled),
                codex_sandbox,
            }),
        }
    }
    pub(crate) fn enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::Relaxed)
    }
    pub(crate) fn set_enabled(&self, enabled: bool) {
        self.inner.enabled.store(enabled, Ordering::Relaxed);
    }
    #[cfg(test)]
    pub(crate) fn in_flight_count(&self) -> usize {
        self.inner.state.lock().expect("state").tickets.len()
    }
    pub(crate) fn set_notifier(&self, notifier: Notifier) {
        if let Ok(mut slot) = self.inner.notifier.lock() {
            *slot = Some(notifier);
        }
    }
    fn changed(&self, changes: Vec<(String, u64)>) {
        let notifier = self
            .inner
            .notifier
            .lock()
            .ok()
            .and_then(|value| value.clone());
        if let Some(notifier) = notifier {
            for (id, revision) in changes {
                notifier(&id, revision);
            }
        }
    }
    fn mutate<T>(
        &self,
        ids: &[&str],
        change: impl FnOnce(&mut State) -> Result<T, ErrorCode>,
    ) -> Result<T, ErrorCode> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| ErrorCode::Unavailable)?;
        let before = state.documents.clone();
        let result = match change(&mut state) {
            Ok(result) => result,
            Err(error) => {
                state.documents = before;
                return Err(error);
            }
        };
        for id in ids {
            if let Some(document) = state.documents.get(*id)
                && self.inner.store.save(document).is_err()
            {
                state.documents = before.clone();
                for id in ids {
                    if let Some(document) = before.get(*id) {
                        let _ = self.inner.store.save(document);
                    } else {
                        let _ = self.inner.store.forget(id);
                    }
                }
                return Err(ErrorCode::Io);
            }
        }
        let changes = ids
            .iter()
            .map(|id| {
                let revision = state.revisions.entry((*id).to_owned()).or_default();
                *revision = revision.saturating_add(1);
                ((*id).to_owned(), *revision)
            })
            .collect();
        drop(state);
        self.changed(changes);
        Ok(result)
    }
    fn document<'a>(state: &'a mut State, id: &str) -> &'a mut SessionDocument {
        state
            .documents
            .entry(id.to_owned())
            .or_insert_with(|| SessionDocument::new(id))
    }
    pub(crate) fn record_branch(&self, child: &str, origin: BranchOrigin) -> Result<(), ErrorCode> {
        self.mutate(&[child], |state| {
            Self::document(state, child).branch = Some(origin);
            Ok(())
        })
    }
    pub(crate) fn forget_branch(&self, child: &str) {
        let _ = self.mutate(&[child], |state| {
            if let Some(document) = state.documents.get_mut(child) {
                document.branch = None;
            }
            Ok(())
        });
    }
    pub(crate) fn branch_origin(&self, child: &str) -> Option<BranchOrigin> {
        self.inner
            .state
            .lock()
            .ok()?
            .documents
            .get(child)?
            .branch
            .clone()
    }
    fn linked(&self, caller: &str, target: &str) -> Result<Link, ErrorCode> {
        self.inner
            .state
            .lock()
            .map_err(|_| ErrorCode::Unavailable)?
            .documents
            .get(caller)
            .and_then(|doc| {
                doc.links
                    .iter()
                    .find(|link| link.other_session_id == target)
            })
            .cloned()
            .ok_or(ErrorCode::UnknownSession)
    }
    fn eligible(&self, id: &str) -> Result<SessionInfo, ErrorCode> {
        let session = self.inner.host.session(id)?;
        if session.allowed {
            Ok(session)
        } else {
            Err(ErrorCode::NotAllowed)
        }
    }
    pub(crate) fn list(&self, session_id: &str) -> Result<(Vec<LinkedChat>, u64), ErrorCode> {
        self.inner.host.session(session_id)?;
        let (links, revision) = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| ErrorCode::Unavailable)?;
            (
                state
                    .documents
                    .get(session_id)
                    .map(|doc| doc.links.clone())
                    .unwrap_or_default(),
                state.revisions.get(session_id).copied().unwrap_or(0),
            )
        };
        let chats = links
            .into_iter()
            .filter_map(|link| {
                let info = self.inner.host.session(&link.other_session_id).ok()?;
                Some(LinkedChat {
                    session_id: info.id,
                    title: info.title,
                    harness: info.harness,
                    kind: link.kind,
                    relation: link.relation,
                    state: info.state,
                    pending: link.pending.len(),
                    last_report: link.last_report,
                })
            })
            .collect();
        Ok((chats, revision))
    }
    fn add_pair(&self, parent: &str, child: &str, kind: LinkKind) -> Result<(), ErrorCode> {
        if parent == child {
            return Err(ErrorCode::InvalidOperation);
        }
        self.mutate(&[parent, child], |state| {
            if state.deleted.contains(parent) || state.deleted.contains(child) {
                return Err(ErrorCode::UnknownSession);
            }
            if kind != LinkKind::Peer
                && state.documents.get(parent).is_some_and(|doc| {
                    doc.links.iter().any(|link| {
                        link.relation == Relation::Parent
                            && matches!(link.kind, LinkKind::Agent | LinkKind::Branch)
                    })
                })
            {
                return Err(ErrorCode::DepthLimit);
            }
            for (id, other, relation) in [
                (
                    parent,
                    child,
                    if kind == LinkKind::Peer {
                        Relation::Peer
                    } else {
                        Relation::Child
                    },
                ),
                (
                    child,
                    parent,
                    if kind == LinkKind::Peer {
                        Relation::Peer
                    } else {
                        Relation::Parent
                    },
                ),
            ] {
                let document = Self::document(state, id);
                if !document
                    .links
                    .iter()
                    .any(|link| link.other_session_id == other)
                {
                    document.links.push(Link {
                        other_session_id: other.to_owned(),
                        kind,
                        relation,
                        created_at: now(),
                        pending: Vec::new(),
                        last_report: None,
                        asked_turn: false,
                        asked_answer_id: None,
                    });
                }
            }
            Ok(())
        })
    }
    pub(crate) async fn adopt_child(
        &self,
        parent: &str,
        child: &str,
        kind: LinkKind,
    ) -> Result<(), ErrorCode> {
        self.eligible(parent)?;
        self.eligible(child)?;
        self.add_pair(parent, child, kind)
    }
    pub(crate) fn link(&self, session: &str, other: &str) -> Result<(), ErrorCode> {
        self.eligible(session)?;
        self.eligible(other)?;
        self.add_pair(session, other, LinkKind::Peer)
    }
    pub(crate) fn unlink(&self, session: &str, other: &str) -> Result<(), ErrorCode> {
        self.eligible(session)?;
        self.linked(session, other)?;
        self.mutate(&[session, other], |state| {
            for (id, target) in [(session, other), (other, session)] {
                Self::document(state, id)
                    .links
                    .retain(|link| link.other_session_id != target);
            }
            Ok(())
        })
    }
    fn queue(&self, recipient: &str, from: &str, pending: PendingText) -> Result<(), ErrorCode> {
        self.mutate(&[recipient], |state| {
            let link = Self::document(state, recipient)
                .links
                .iter_mut()
                .find(|link| link.other_session_id == from)
                .ok_or(ErrorCode::UnknownSession)?;
            link.pending.push(pending);
            let dropped = if link.pending.len() > MAX_PENDING {
                link.pending
                    .drain(..link.pending.len() - MAX_PENDING)
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            for pending in dropped {
                if let Some(ticket) = state.tickets.remove(&pending.id) {
                    ticket.claimed.store(true, Ordering::Release);
                    ticket.result.send_replace(Completion::Dropped);
                }
            }
            Ok(())
        })
    }
    fn remove_pending(
        &self,
        recipient: &str,
        from: &str,
        pending_id: &str,
    ) -> Result<(), ErrorCode> {
        self.mutate(&[recipient], |state| {
            let link = Self::document(state, recipient)
                .links
                .iter_mut()
                .find(|link| link.other_session_id == from)
                .ok_or(ErrorCode::UnknownSession)?;
            let report = link
                .pending
                .iter()
                .any(|pending| pending.id == pending_id && pending.report);
            link.pending.retain(|pending| pending.id != pending_id);
            if report {
                state.tickets.remove(pending_id);
            }
            Ok(())
        })
    }
    async fn flush_link(&self, recipient: &str, from: &str) -> Result<bool, ErrorCode> {
        let _delivery = self.inner.delivery.lock().await;
        loop {
            let link = self.linked(recipient, from)?;
            let Some(pending) = link.pending.first().cloned() else {
                return Ok(true);
            };
            let ticket = {
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| ErrorCode::Unavailable)?;
                let existing = state.tickets.get(&pending.id).cloned();
                if existing.is_none() && pending.agent_origin && !pending.report {
                    // A queued request is durable, but its waiter/observer is process-local.
                    // Restore that observer before sending it after a restart.
                    let restored = Arc::new(Ticket {
                        id: pending.id.clone(),
                        caller: from.to_owned(),
                        target: recipient.to_owned(),
                        generation: AtomicU64::new(0),
                        baseline_answer: Mutex::new(None),
                        result: watch::channel(Completion::Pending).0,
                        waiting: AtomicUsize::new(0),
                        claimed: AtomicBool::new(false),
                    });
                    state
                        .tickets
                        .insert(pending.id.clone(), Arc::clone(&restored));
                    Some(restored)
                } else {
                    existing
                }
            };
            if pending.report
                && let Some(ticket) = &ticket
            {
                if ticket.waiting.load(Ordering::Acquire) > 0 {
                    return Ok(false);
                }
                if ticket
                    .claimed
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return Ok(false);
                }
            }
            if self
                .inner
                .host
                .ensure_live(recipient.to_owned())
                .await
                .is_err()
            {
                if pending.report
                    && let Some(ticket) = ticket
                {
                    ticket.claimed.store(false, Ordering::Release);
                }
                return Ok(false);
            }
            let info = self.inner.host.session(recipient)?;
            let idle = info.state == LinkedChatState::Idle;
            let wakes = self
                .inner
                .state
                .lock()
                .map_err(|_| ErrorCode::Unavailable)?
                .documents
                .get(recipient)
                .map_or(0, |doc| doc.wakes);
            if pending.agent_origin && idle && wakes >= MAX_WAKES {
                if pending.report
                    && let Some(ticket) = ticket
                {
                    ticket.claimed.store(false, Ordering::Release);
                }
                return Ok(false);
            }
            if pending.agent_origin && idle {
                self.mutate(&[recipient], |state| {
                    Self::document(state, recipient).wakes += 1;
                    Ok(())
                })?;
            }
            let mode = if running(info.state) {
                PromptMode::FollowUp
            } else {
                PromptMode::Prompt
            };
            let turns = if !pending.report && ticket.is_some() {
                Some(self.inner.host.turns(recipient)?)
            } else {
                None
            };
            let generation = if let Some(turns) = &turns {
                let initial = *turns.borrow();
                let first =
                    initial
                        .generation
                        .saturating_add(if running(info.state) { 2 } else { 1 });
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| ErrorCode::Unavailable)?;
                let next = state.next_turn.entry(recipient.to_owned()).or_default();
                (*next).max(first.saturating_sub(1)).saturating_add(1)
            } else {
                0
            };
            let baseline = if turns.is_some() {
                self.inner
                    .host
                    .last_answer(recipient.to_owned())
                    .await?
                    .map(|(id, _)| id)
            } else {
                None
            };
            if self
                .inner
                .host
                .send(recipient.to_owned(), pending.text, mode)
                .await
                .is_err()
            {
                if pending.agent_origin && idle {
                    let _ = self.mutate(&[recipient], |state| {
                        Self::document(state, recipient).wakes = wakes;
                        Ok(())
                    });
                }
                if pending.report
                    && let Some(ticket) = ticket
                {
                    ticket.claimed.store(false, Ordering::Release);
                }
                return Ok(false);
            }
            self.remove_pending(recipient, from, &pending.id)?;
            if let (Some(ticket), Some(turns)) = (ticket, turns) {
                ticket.generation.store(generation, Ordering::Release);
                if let Ok(mut value) = ticket.baseline_answer.lock() {
                    *value = baseline.clone();
                }
                if let Ok(mut state) = self.inner.state.lock() {
                    state.next_turn.insert(recipient.to_owned(), generation);
                }
                self.mutate(&[&ticket.caller], |state| {
                    if let Some(link) = Self::document(state, &ticket.caller)
                        .links
                        .iter_mut()
                        .find(|link| link.other_session_id == ticket.target)
                    {
                        link.asked_turn = true;
                        link.asked_answer_id = baseline;
                    }
                    Ok(())
                })?;
                let broker = self.clone();
                tokio::spawn(async move {
                    broker.monitor(ticket, turns).await;
                });
            }
        }
    }
    pub(crate) async fn person_message(&self, session_id: &str) {
        if self.inner.host.session(session_id).is_err() {
            return;
        }
        let mut ids = vec![session_id.to_owned()];
        if let Ok(state) = self.inner.state.lock()
            && let Some(document) = state.documents.get(session_id)
        {
            ids.extend(
                document
                    .links
                    .iter()
                    .filter(|link| {
                        link.relation == Relation::Child
                            && matches!(link.kind, LinkKind::Agent | LinkKind::Branch)
                    })
                    .map(|link| link.other_session_id.clone()),
            );
        }
        ids.sort();
        ids.dedup();
        let references: Vec<&str> = ids.iter().map(String::as_str).collect();
        let _ = self.mutate(&references, |state| {
            for id in &ids {
                Self::document(state, id).wakes = 0;
            }
            Ok(())
        });
    }
    pub(crate) async fn send_person(
        &self,
        from: &str,
        to: &str,
        text: &str,
    ) -> Result<(), ErrorCode> {
        if !text_valid(text) {
            return Err(ErrorCode::InvalidOperation);
        }
        let sender = self.eligible(from)?;
        self.eligible(to)?;
        self.linked(to, from)?;
        self.mutate(&[to], |state| {
            Self::document(state, to).wakes = 0;
            Ok(())
        })?;
        self.queue(
            to,
            from,
            PendingText {
                id: uuid::Uuid::new_v4().to_string(),
                text: message_prompt(&sender.title, text, true),
                agent_origin: false,
                report: false,
            },
        )?;
        let _ = self.flush_link(to, from).await?;
        Ok(())
    }
    pub(crate) async fn deliver(&self, session: &str, from: &str) -> Result<(), ErrorCode> {
        self.eligible(session)?;
        self.linked(session, from)?;
        self.mutate(&[session], |state| {
            Self::document(state, session).wakes = 0;
            Ok(())
        })?;
        let _ = self.flush_link(session, from).await?;
        Ok(())
    }
    pub(crate) async fn session_deleted(&self, session_id: &str) {
        let ids = self
            .inner
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .documents
                    .iter()
                    .filter(|(id, doc)| {
                        id.as_str() != session_id
                            && doc
                                .links
                                .iter()
                                .any(|link| link.other_session_id == session_id)
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let references: Vec<&str> = ids.iter().map(String::as_str).collect();
        let _ = self.mutate(&references, |state| {
            state.deleted.insert(session_id.to_owned());
            state.documents.remove(session_id);
            for document in state.documents.values_mut() {
                document
                    .links
                    .retain(|link| link.other_session_id != session_id);
            }
            for ticket in state
                .tickets
                .values()
                .filter(|ticket| ticket.caller == session_id || ticket.target == session_id)
            {
                ticket.claimed.store(true, Ordering::Release);
                ticket.result.send_replace(Completion::Deleted);
            }
            state
                .tickets
                .retain(|_, ticket| ticket.caller != session_id && ticket.target != session_id);
            Ok(())
        });
        let _ = self.inner.store.forget(session_id);
    }
    pub(crate) async fn handle(&self, caller: &str, operation: Map<String, Value>) -> Value {
        let operation = match serde_json::from_value::<ToolOperation>(Value::Object(operation)) {
            Ok(operation) if operation.valid() => operation,
            _ => return refusal(ErrorCode::InvalidOperation),
        };
        match self.execute(caller, operation).await {
            Ok(answer) => answer,
            Err(code) => refusal(code),
        }
    }
    async fn execute(&self, caller: &str, operation: ToolOperation) -> Result<Value, ErrorCode> {
        let parent = self.eligible(caller)?;
        if !self.enabled() || !supports_tool(parent.harness) {
            return Err(ErrorCode::NotAllowed);
        }
        match operation {
            ToolOperation::List {} => self
                .list(caller)
                .map(|(chats, _)| json!({"ok":true,"chats":chats})),
            ToolOperation::Start {
                title,
                prompt,
                harness,
                model,
                permission_mode,
                wait,
                wait_seconds,
            } => {
                self.start(
                    parent,
                    title,
                    prompt,
                    harness,
                    model,
                    permission_mode,
                    wait.unwrap_or(false),
                    wait_seconds,
                )
                .await
            }
            ToolOperation::Message {
                session_id,
                text,
                wait,
                wait_seconds,
            } => {
                self.message(
                    &parent,
                    &session_id,
                    &text,
                    wait.unwrap_or(false),
                    wait_seconds,
                )
                .await
            }
            ToolOperation::Read { session_id, page } => {
                self.read(caller, &session_id, page.unwrap_or(1)).await
            }
            ToolOperation::Wait {
                session_id,
                wait_seconds,
            } => self.wait(caller, &session_id, wait_seconds).await,
            ToolOperation::Stop { session_id } => {
                if self.linked(caller, &session_id)?.relation != Relation::Child {
                    return Err(ErrorCode::NotAllowed);
                }
                let target = self.inner.host.session(&session_id)?;
                if running(target.state) {
                    self.inner.host.interrupt(session_id.clone()).await?;
                }
                self.inner.host.close(session_id).await;
                Ok(json!({"ok":true,"state":"closed"}))
            }
        }
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "the start operation's exact v1 fields"
    )]
    async fn start(
        &self,
        parent: SessionInfo,
        requested_title: String,
        prompt: String,
        harness: Option<HarnessKind>,
        model: Option<ToolModel>,
        permission: Option<PermissionMode>,
        wait: bool,
        seconds: Option<u64>,
    ) -> Result<Value, ErrorCode> {
        let harness = harness.unwrap_or(parent.harness);
        let same = harness == parent.harness;
        let permission = permission.unwrap_or(if same {
            parent.permission_mode
        } else {
            PermissionMode::Native
        });
        authority(&parent, harness, permission, self.inner.codex_sandbox)?;
        if !self.inner.host.available(harness) {
            return Err(ErrorCode::HarnessUnavailable);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let child_title = title(&requested_title);
        self.mutate(&[&parent.id, &id], |state| {
            let links = &Self::document(state, &parent.id).links;
            if links.iter().any(|link| {
                link.relation == Relation::Parent
                    && matches!(link.kind, LinkKind::Agent | LinkKind::Branch)
            }) {
                return Err(ErrorCode::DepthLimit);
            }
            let active = links
                .iter()
                .filter(|link| {
                    link.relation == Relation::Child
                        && link.kind == LinkKind::Agent
                        && self
                            .inner
                            .host
                            .session(&link.other_session_id)
                            .map_or(true, |info| info.state != LinkedChatState::Closed)
                })
                .count();
            if active >= MAX_AGENT_CHILDREN {
                return Err(ErrorCode::ChildLimit);
            }
            let created = now();
            Self::document(state, &parent.id).links.push(Link {
                other_session_id: id.clone(),
                kind: LinkKind::Agent,
                relation: Relation::Child,
                created_at: created.clone(),
                pending: Vec::new(),
                last_report: None,
                asked_turn: true,
                asked_answer_id: None,
            });
            Self::document(state, &id).links.push(Link {
                other_session_id: parent.id.clone(),
                kind: LinkKind::Agent,
                relation: Relation::Parent,
                created_at: created,
                pending: Vec::new(),
                last_report: None,
                asked_turn: false,
                asked_answer_id: None,
            });
            Ok(())
        })?;
        let launch = ChildLaunch {
            session_id: id.clone(),
            parent_session_id: parent.id.clone(),
            workspace_id: parent.workspace_id.clone(),
            title: child_title.clone(),
            harness,
            model: model
                .map(|model| WorkspaceModel {
                    name: model.id.clone(),
                    id: model.id,
                    provider: Some(model.provider),
                    thinking_levels: None,
                })
                .or_else(|| same.then(|| parent.model.clone()).flatten()),
            thinking_level: same.then(|| parent.thinking_level.clone()).flatten(),
            permission_mode: permission,
            network_access: same && parent.network_access,
        };
        if let Err(error) = self.inner.host.launch(launch).await {
            let _ = self.remove_pair(&parent.id, &id);
            return Err(error);
        }
        let ticket = self
            .request_turn(&parent.id, &id, first_prompt(&parent.title, &prompt), wait)
            .await?;
        let _waiter = wait.then(|| Waiter::reserved(self, &ticket));
        let mut result = json!({"ok":true,"sessionId":id,"title":self.inner.host.session(&id).map_or(child_title, |info| info.title),"state":self.inner.host.session(&id).map_or(LinkedChatState::Starting, |info| info.state)});
        if wait {
            self.attach_wait_result(&ticket, seconds, &mut result)
                .await?;
        }
        Ok(result)
    }
    fn remove_pair(&self, a: &str, b: &str) -> Result<(), ErrorCode> {
        self.mutate(&[a, b], |state| {
            Self::document(state, a)
                .links
                .retain(|link| link.other_session_id != b);
            Self::document(state, b)
                .links
                .retain(|link| link.other_session_id != a);
            Ok(())
        })
    }
    async fn message(
        &self,
        parent: &SessionInfo,
        target: &str,
        text: &str,
        wait: bool,
        seconds: Option<u64>,
    ) -> Result<Value, ErrorCode> {
        self.linked(&parent.id, target)?;
        let ticket = self
            .request_turn(
                &parent.id,
                target,
                message_prompt(&parent.title, text, false),
                wait,
            )
            .await?;
        let _waiter = wait.then(|| Waiter::reserved(self, &ticket));
        let queued = self
            .linked(target, &parent.id)?
            .pending
            .iter()
            .any(|pending| pending.id == ticket.id);
        let mut result =
            json!({"ok":true,"state":self.inner.host.session(target)?.state,"queued":queued});
        if wait && !queued {
            self.attach_wait_result(&ticket, seconds, &mut result)
                .await?;
        }
        Ok(result)
    }
    async fn request_turn(
        &self,
        caller: &str,
        target: &str,
        body: String,
        waiting: bool,
    ) -> Result<Arc<Ticket>, ErrorCode> {
        self.inner.host.ensure_live(target.to_owned()).await?;
        let baseline_answer = self
            .inner
            .host
            .last_answer(target.to_owned())
            .await?
            .map(|(id, _)| id);
        let ticket = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ErrorCode::Unavailable)?;
            let ticket = Arc::new(Ticket {
                id: uuid::Uuid::new_v4().to_string(),
                caller: caller.to_owned(),
                target: target.to_owned(),
                generation: AtomicU64::new(0),
                baseline_answer: Mutex::new(baseline_answer.clone()),
                result: watch::channel(Completion::Pending).0,
                waiting: AtomicUsize::new(usize::from(waiting)),
                claimed: AtomicBool::new(false),
            });
            state.tickets.insert(ticket.id.clone(), Arc::clone(&ticket));
            ticket
        };
        self.mutate(&[caller], |state| {
            let link = Self::document(state, caller)
                .links
                .iter_mut()
                .find(|link| link.other_session_id == target)
                .ok_or(ErrorCode::UnknownSession)?;
            link.asked_turn = true;
            link.asked_answer_id = baseline_answer;
            Ok(())
        })?;
        // Reserve the wait before sending: an immediate answer must not also auto-deliver.
        self.queue(
            target,
            caller,
            PendingText {
                id: ticket.id.clone(),
                text: body,
                agent_origin: true,
                report: false,
            },
        )?;
        let _ = self.flush_link(target, caller).await?;
        Ok(ticket)
    }
    fn monitor(&self, ticket: Arc<Ticket>, turns: watch::Receiver<TurnState>) -> HostFuture<()> {
        let broker = self.clone();
        Box::pin(async move { broker.monitor_turn(ticket, turns).await })
    }
    async fn monitor_turn(&self, ticket: Arc<Ticket>, mut turns: watch::Receiver<TurnState>) {
        loop {
            let turn = *turns.borrow_and_update();
            if turn.generation >= ticket.generation.load(Ordering::Acquire)
                || matches!(
                    turn.status,
                    piui_runtime::workspace_runtime::SessionStatus::Failed
                        | piui_runtime::workspace_runtime::SessionStatus::Closed
                )
            {
                break;
            }
            if turns.changed().await.is_err() {
                break;
            }
        }
        let answer = self
            .inner
            .host
            .last_answer(ticket.target.clone())
            .await
            .ok()
            .flatten();
        let baseline = ticket
            .baseline_answer
            .lock()
            .ok()
            .and_then(|value| value.clone());
        let text = match answer {
            Some((id, text)) if Some(&id) != baseline.as_ref() => text,
            _ => "The linked chat finished without an answer.".to_owned(),
        };
        let state = self
            .inner
            .host
            .session(&ticket.target)
            .map_or(LinkedChatState::Closed, |info| info.state);
        let child_title = self
            .inner
            .host
            .session(&ticket.target)
            .map_or_else(|_| ticket.target.clone(), |info| info.title);
        let update = self.mutate(&[&ticket.caller], |state| {
            if state.deleted.contains(&ticket.caller) || state.deleted.contains(&ticket.target) {
                return Err(ErrorCode::UnknownSession);
            }
            let another = state.tickets.values().any(|other| {
                other.id != ticket.id
                    && other.caller == ticket.caller
                    && other.target == ticket.target
                    && matches!(*other.result.borrow(), Completion::Pending)
            });
            let link = Self::document(state, &ticket.caller)
                .links
                .iter_mut()
                .find(|link| link.other_session_id == ticket.target)
                .ok_or(ErrorCode::UnknownSession)?;
            link.asked_turn = another;
            if !another {
                link.asked_answer_id = None;
            }
            link.last_report = Some(LastReport {
                at: now(),
                excerpt: text.chars().take(EXCERPT_CHARS).collect(),
            });
            Ok(())
        });
        if update.is_err() {
            ticket.result.send_replace(Completion::Deleted);
            return;
        }
        if self
            .queue(
                &ticket.caller,
                &ticket.target,
                PendingText {
                    id: ticket.id.clone(),
                    text: report_prompt(&child_title, &ticket.target, &text),
                    agent_origin: true,
                    report: true,
                },
            )
            .is_err()
        {
            ticket.result.send_replace(Completion::Deleted);
            return;
        }
        ticket
            .result
            .send_replace(Completion::Answer(Answer { text, state }));
        if ticket.waiting.load(Ordering::Acquire) == 0 {
            let _ = self.flush_link(&ticket.caller, &ticket.target).await;
        }
    }
    async fn attach_wait_result(
        &self,
        ticket: &Arc<Ticket>,
        seconds: Option<u64>,
        result: &mut Value,
    ) -> Result<(), ErrorCode> {
        let mut receiver = ticket.result.subscribe();
        let ready = async {
            loop {
                let value = receiver.borrow_and_update().clone();
                match value {
                    Completion::Pending => {}
                    Completion::Answer(answer) => return Ok(answer),
                    Completion::Deleted => return Err(ErrorCode::UnknownSession),
                    Completion::Dropped => return Err(ErrorCode::Unavailable),
                }
                if receiver.changed().await.is_err() {
                    return Err(ErrorCode::Unavailable);
                }
            }
        };
        if let Ok(answer) = tokio::time::timeout(
            Duration::from_secs(seconds.unwrap_or(MAX_WAIT_SECONDS)),
            ready,
        )
        .await
        {
            let answer = answer?;
            if ticket
                .claimed
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                self.remove_pending(&ticket.caller, &ticket.target, &ticket.id)?;
                let (text, cut) = short_answer(&answer.text);
                result["state"] = json!(answer.state);
                result["answer"] = json!(text);
                result["cut"] = json!(cut);
            }
        }
        Ok(())
    }
    async fn wait(
        &self,
        caller: &str,
        target: &str,
        seconds: Option<u64>,
    ) -> Result<Value, ErrorCode> {
        self.linked(caller, target)?;
        let ticket = self
            .inner
            .state
            .lock()
            .map_err(|_| ErrorCode::Unavailable)?
            .tickets
            .values()
            .filter(|ticket| ticket.caller == caller && ticket.target == target)
            .max_by_key(|ticket| ticket.generation.load(Ordering::Acquire))
            .cloned();
        let mut result = json!({"ok":true,"state":self.inner.host.session(target)?.state});
        if let Some(ticket) = ticket {
            let _waiter = Waiter::new(self, &ticket);
            self.attach_wait_result(&ticket, seconds, &mut result)
                .await?;
            return Ok(result);
        }
        if running(self.inner.host.session(target)?.state) {
            let mut turns = self.inner.host.turns(target)?;
            let generation = turns.borrow().generation;
            let _ = tokio::time::timeout(
                Duration::from_secs(seconds.unwrap_or(MAX_WAIT_SECONDS)),
                async {
                    loop {
                        let turn = *turns.borrow_and_update();
                        if turn.generation > generation
                            || matches!(
                                turn.status,
                                piui_runtime::workspace_runtime::SessionStatus::Failed
                                    | piui_runtime::workspace_runtime::SessionStatus::Closed
                            )
                        {
                            break;
                        }
                        if turns.changed().await.is_err() {
                            break;
                        }
                    }
                },
            )
            .await;
        }
        result["state"] = json!(self.inner.host.session(target)?.state);
        if !running(self.inner.host.session(target)?.state)
            && let Some((_, text)) = self.inner.host.last_answer(target.to_owned()).await?
        {
            let (text, cut) = short_answer(&text);
            result["answer"] = json!(text);
            result["cut"] = json!(cut);
        }
        Ok(result)
    }
    async fn read(&self, caller: &str, target: &str, page: u64) -> Result<Value, ErrorCode> {
        self.linked(caller, target)?;
        let text = match self.inner.host.last_answer(target.to_owned()).await? {
            Some((id, _)) => self
                .inner
                .host
                .answer(target.to_owned(), id)
                .await?
                .unwrap_or_default(),
            None => String::new(),
        };
        let mut pages = Vec::new();
        let mut start = 0;
        while start < text.len() {
            let mut end = (start + PAGE_BYTES).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            pages.push(&text[start..end]);
            start = end;
        }
        if pages.is_empty() {
            pages.push("");
        }
        let index = usize::try_from(page - 1).map_err(|_| ErrorCode::InvalidOperation)?;
        let content = pages.get(index).ok_or(ErrorCode::InvalidOperation)?;
        Ok(json!({"ok":true,"text":content,"page":page,"pages":pages.len()}))
    }
    pub(crate) async fn resume_deliveries(&self) {
        let documents = self
            .inner
            .state
            .lock()
            .ok()
            .map(|state| state.documents.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for document in documents {
            for link in document.links {
                if !link.pending.is_empty() {
                    let _ = self
                        .flush_link(&document.session_id, &link.other_session_id)
                        .await;
                }
                if link.asked_turn
                    && let Ok(Some((id, text))) = self
                        .inner
                        .host
                        .last_answer(link.other_session_id.clone())
                        .await
                    && Some(id.as_str()) != link.asked_answer_id.as_deref()
                {
                    let child = self
                        .inner
                        .host
                        .session(&link.other_session_id)
                        .map_or_else(|_| link.other_session_id.clone(), |info| info.title);
                    let _ = self.mutate(&[&document.session_id], |state| {
                        if let Some(link) = Self::document(state, &document.session_id)
                            .links
                            .iter_mut()
                            .find(|entry| entry.other_session_id == link.other_session_id)
                        {
                            link.asked_turn = false;
                            link.asked_answer_id = None;
                            link.last_report = Some(LastReport {
                                at: now(),
                                excerpt: text.chars().take(EXCERPT_CHARS).collect(),
                            });
                        }
                        Ok(())
                    });
                    let _ = self.queue(
                        &document.session_id,
                        &link.other_session_id,
                        PendingText {
                            id: uuid::Uuid::new_v4().to_string(),
                            text: report_prompt(&child, &link.other_session_id, &text),
                            agent_origin: true,
                            report: true,
                        },
                    );
                    let _ = self
                        .flush_link(&document.session_id, &link.other_session_id)
                        .await;
                }
            }
        }
    }
}
