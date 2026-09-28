//! Board service (ADR-041): every change to a project board goes through one
//! mutex-guarded transaction that validates, applies to a staged copy and
//! stores a complete generation before the change becomes current.
//!
//! Person commands (`board_command_v1`), the agent `board` tool
//! (`agent.rs`) and, later, the board run engine share these methods. Run
//! creation itself is behind [`BoardRunStarter`] so the board never reaches
//! into the orchestration store while it holds its own lock.

// The agent tool (phase 2) and the run engine (phase 3) call parts of this
// API that the phase 1 host does not use yet.
#![allow(dead_code)]

use super::model::{
    BOARD_PROTOCOL, Board, BoardActor, BoardChangedEventV1, BoardError, BoardOperation,
    BoardProposal, BoardSettings, CLAIM_LEASE_SECONDS, Card, CardActivity, CardChange, CardClaim,
    CardComment, CardDraft, CardLink, CardPatch, CardPriority, CardStartMode, CardStatus,
    CommentMention, MAX_ACTIVITY_PER_CARD, MAX_CARD_DESCRIPTION_BYTES, MAX_CARD_TITLE_CHARS,
    MAX_CARDS, MAX_COMMENT_BYTES, MAX_COMMENTS_PER_CARD, MAX_LABEL_CHARS, MAX_LABELS_PER_CARD,
    MAX_PENDING, MAX_RESOLVED_PROPOSALS, PendingStart, ProposalStatus, QueuedStartRecord,
    ReleaseReason, RunOutcome,
};
use super::store::{BoardStore, FileBoardStore, workspace_directory_name};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use piui_orchestration::{
    BoardRunCause, MAX_INPUT_TEXT_BYTES, MAX_TRIGGER_CHAIN_DEPTH, TeammateStartRule,
};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use uuid::Uuid;

pub(crate) const RUNS_UNAVAILABLE: BoardError =
    BoardError::Invalid("Runs from the board are not available yet.");
/// Most mentions one comment may carry.
const MAX_MENTIONS: usize = 20;
/// Longest move reason, in characters.
const MAX_REASON_CHARS: usize = 500;
/// Longest session or run identity stored on a card.
const MAX_REFERENCE_BYTES: usize = 128;
/// Comments included in the card text handed to a run.
const RUN_TEXT_COMMENTS: usize = 5;
/// Rate-limit counters kept before the oldest turn keys are forgotten.
const MAX_TURN_KEYS: usize = 4096;
/// Seconds between two automatic run starts of one card.
pub(crate) const START_COOLDOWN_SECONDS: i64 = 60;
/// Longest run result copied into a card comment, in UTF-8 bytes.
pub(crate) const MAX_RUN_RESULT_BYTES: usize = 4 * 1024;
/// Most starts waiting for a concurrency slot per board.
const MAX_QUEUED_STARTS: usize = 500;

/// Availability of a teammate (`TeammateStatusV1.availability`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Availability {
    Idle,
    Queued,
    Working,
}

/// What the board needs to know about one teammate of its project. Built
/// by `teammates_api::teammate_refs` from the orchestration store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TeammateRef {
    pub id: String,
    pub handle: String,
    pub name: String,
    pub role: String,
    /// `simple` or `pipeline`.
    pub kind: &'static str,
    pub on_assign: TeammateStartRule,
    pub on_mention: bool,
    pub enabled: bool,
    pub not_assignable_reason: Option<String>,
    pub availability: Availability,
}

impl TeammateRef {
    pub fn assignable(&self) -> bool {
        self.enabled && self.not_assignable_reason.is_none()
    }
}

/// A chat a card is linked to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionRef {
    pub session_id: String,
    pub harness: String,
}

/// A run the board asks the orchestration layer to create. `run_id` is
/// already recorded on the card (claim, link, activity).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BoardRunRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub card_id: String,
    pub card_number: u64,
    pub teammate_id: String,
    pub cause: BoardRunCause,
    pub chain_depth: u8,
    /// Card text for the teammate's resolved card input; labelled untrusted
    /// task data and bounded to `MAX_INPUT_TEXT_BYTES`.
    pub card_text: String,
}

/// Creates the orchestration run for a board card (phase 3 provides the
/// real implementation). Called without the board lock held.
pub(crate) trait BoardRunStarter: Send + Sync {
    /// Whether runs can be started at all; when false a start that a rule
    /// asks for becomes a pending start for the person.
    fn available(&self) -> bool;
    /// Whether one more run for `teammate_id` fits the teammate's
    /// `maxConcurrentRuns` and the board's `settings.maxConcurrentRuns`
    /// (`board_limit`). When not, the start waits in the queue.
    fn has_capacity(&self, _workspace_id: &str, _teammate_id: &str, _board_limit: u8) -> bool {
        true
    }
    /// Creates the run. An error makes the board roll the start back.
    fn start(&self, request: &BoardRunRequest) -> Result<(), BoardError>;
}

/// Default starter until board-driven runs ship.
pub(crate) struct UnavailableRunStarter;

impl BoardRunStarter for UnavailableRunStarter {
    fn available(&self) -> bool {
        false
    }

    fn start(&self, _request: &BoardRunRequest) -> Result<(), BoardError> {
        Err(RUNS_UNAVAILABLE)
    }
}

/// What an assignment did about starting a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AssignOutcome {
    Assigned,
    PendingStart,
    Started,
    /// The start waits for a concurrency slot.
    Queued,
}

pub(crate) type BoardNotifier = Arc<dyn Fn(&BoardChangedEventV1) + Send + Sync>;
type Clock = Box<dyn Fn() -> DateTime<Utc> + Send + Sync>;

/// Host time of one transaction.
pub(crate) struct Now {
    pub at: DateTime<Utc>,
    pub text: String,
}

impl Now {
    fn at_time(at: DateTime<Utc>) -> Self {
        Self {
            at,
            text: at.to_rfc3339_opts(SecondsFormat::Millis, true),
        }
    }

    fn plus_seconds(&self, seconds: i64) -> String {
        (self.at + Duration::seconds(seconds)).to_rfc3339_opts(SecondsFormat::Millis, true)
    }
}

/// A run start decided inside a transaction, executed after it committed.
#[derive(Clone, Debug)]
pub(crate) struct StartPlan {
    card_id: String,
    teammate_id: String,
    cause: BoardRunCause,
    chain_depth: u8,
    actor: BoardActor,
}

/// A start waiting for a concurrency slot (per teammate or per board), as
/// the queue order sees it: the stored `QueuedStartRecord` (board document,
/// so it survives a restart) plus the card's current priority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct QueuedStart {
    pub workspace_id: String,
    pub card_id: String,
    pub teammate_id: String,
    pub cause: BoardRunCause,
    pub chain_depth: u8,
    pub actor: BoardActor,
    pub priority: CardPriority,
    /// Arrival order (1-based position in the document); the age
    /// tie-breaker.
    pub seq: u64,
}

/// Queue order: priority (urgent first), then age.
pub(crate) fn queue_order(left: &QueuedStart, right: &QueuedStart) -> std::cmp::Ordering {
    priority_rank(left.priority)
        .cmp(&priority_rank(right.priority))
        .then(left.seq.cmp(&right.seq))
}

pub(crate) fn priority_rank(priority: CardPriority) -> u8 {
    match priority {
        CardPriority::Urgent => 0,
        CardPriority::High => 1,
        CardPriority::Normal => 2,
        CardPriority::Low => 3,
    }
}

/// How a run ended, as the board records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RunEnd {
    /// `result`: the final text of the run, if it had one.
    Succeeded {
        result: Option<String>,
    },
    /// `reason`: a short, non-secret failure description.
    Failed {
        reason: String,
    },
    Cancelled,
}

impl RunEnd {
    pub(crate) fn outcome(&self) -> RunOutcome {
        match self {
            Self::Succeeded { .. } => RunOutcome::Succeeded,
            Self::Failed { .. } => RunOutcome::Failed,
            Self::Cancelled => RunOutcome::Cancelled,
        }
    }
}

/// The status a card moves to when its run ends: `inReview` after success,
/// `blocked` after failure, unchanged after cancel. Only a card whose claim
/// the run still held moves, and a closed card never does.
pub(crate) fn run_end_status(
    outcome: RunOutcome,
    run_held_claim: bool,
    status: CardStatus,
) -> Option<CardStatus> {
    if !run_held_claim || status.is_closed() {
        return None;
    }
    let to = match outcome {
        RunOutcome::Succeeded => CardStatus::InReview,
        RunOutcome::Failed => CardStatus::Blocked,
        RunOutcome::Cancelled => return None,
    };
    (to != status).then_some(to)
}

/// Whether the board already recorded the end of `run_id` on this card: a
/// `runFinished` activity or a host comment carrying the run id.
pub(crate) fn run_end_recorded(card: &Card, run_id: &str) -> bool {
    card.activity.iter().any(|activity| {
        matches!(&activity.change, CardChange::RunFinished { run_id: finished, .. } if finished == run_id)
    }) || card.comments.iter().any(|comment| {
        comment.actor == BoardActor::Host && comment.run_id.as_deref() == Some(run_id)
    })
}

/// Whether a run started on this card less than `START_COOLDOWN_SECONDS`
/// ago. Only successful starts count: a rolled-back start removes its run
/// link, so its `runStarted` activity no longer matches.
pub(crate) fn start_cooldown_active(card: &Card, now: &Now) -> bool {
    card.activity.iter().rev().any(|activity| {
        matches!(&activity.change, CardChange::RunStarted { run_id, .. } if card.links.iter().any(
            |link| matches!(link, CardLink::Run { run_id: linked, .. } if linked == run_id)
        )) && DateTime::parse_from_rfc3339(&activity.at).is_ok_and(|at| {
            now.at
                .signed_duration_since(at.with_timezone(&Utc))
                .num_seconds()
                < START_COOLDOWN_SECONDS
        })
    })
}

/// A run's own board writes never wake the card it works on.
pub(crate) fn own_run_card(card: &Card, actor: &BoardActor) -> bool {
    let BoardActor::RunMember { run_id, .. } = actor else {
        return false;
    };
    card.claim
        .as_ref()
        .is_some_and(|claim| claim.run_id.as_deref() == Some(run_id.as_str()))
        || card
            .links
            .iter()
            .any(|link| matches!(link, CardLink::Run { run_id: linked, .. } if linked == run_id))
}

#[derive(Default)]
struct Inner {
    boards: HashMap<String, Board>,
    turn_writes: HashMap<String, u32>,
}

/// The boards of one host process. Cheap to clone: clones share one state.
#[derive(Clone)]
pub(crate) struct BoardService {
    shared: Arc<BoardShared>,
}

impl std::ops::Deref for BoardService {
    type Target = BoardShared;

    fn deref(&self) -> &BoardShared {
        &self.shared
    }
}

pub(crate) struct BoardShared {
    store: Box<dyn BoardStore>,
    safe_mode: bool,
    inner: Mutex<Inner>,
    /// Serializes run starts, so the concurrency check and the start agree.
    start_gate: Mutex<()>,
    run_starter: RwLock<Arc<dyn BoardRunStarter>>,
    notifier: RwLock<Option<BoardNotifier>>,
    clock: Clock,
}

impl BoardService {
    pub(crate) fn new(store: Box<dyn BoardStore>, safe_mode: bool) -> Self {
        Self {
            shared: Arc::new(BoardShared {
                store,
                safe_mode,
                inner: Mutex::new(Inner::default()),
                start_gate: Mutex::new(()),
                run_starter: RwLock::new(Arc::new(UnavailableRunStarter)),
                notifier: RwLock::new(None),
                clock: Box::new(Utc::now),
            }),
        }
    }

    pub(crate) fn open(app_data_dir: &Path, safe_mode: bool) -> std::io::Result<Self> {
        Ok(Self::new(
            Box::new(FileBoardStore::open(app_data_dir)?),
            safe_mode,
        ))
    }

    /// Replaces the host clock (tests).
    #[cfg(test)]
    pub(crate) fn with_clock(
        mut self,
        clock: impl Fn() -> DateTime<Utc> + Send + Sync + 'static,
    ) -> Self {
        if let Some(shared) = Arc::get_mut(&mut self.shared) {
            shared.clock = Box::new(clock);
        }
        self
    }

    /// Installs the run engine (phase 3).
    pub(crate) fn set_run_starter(&self, starter: Arc<dyn BoardRunStarter>) {
        if let Ok(mut current) = self.run_starter.write() {
            *current = starter;
        }
    }

    /// Called after every committed change (the host emits
    /// `piui://board-changed-v1`).
    pub(crate) fn set_notifier(&self, notifier: BoardNotifier) {
        if let Ok(mut current) = self.notifier.write() {
            *current = Some(notifier);
        }
    }

    fn starter(&self) -> Arc<dyn BoardRunStarter> {
        self.run_starter
            .read()
            .map(|starter| Arc::clone(&starter))
            .unwrap_or_else(|_| Arc::new(UnavailableRunStarter) as Arc<dyn BoardRunStarter>)
    }

    fn notify(&self, event: &BoardChangedEventV1) {
        let notifier = self
            .notifier
            .read()
            .ok()
            .and_then(|notifier| notifier.clone());
        if let Some(notifier) = notifier {
            notifier(event);
        }
    }

    pub(crate) fn now(&self) -> Now {
        Now::at_time((self.clock)())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Inner>, BoardError> {
        self.inner.lock().map_err(|_| BoardError::Io)
    }

    fn current(
        &self,
        inner: &mut Inner,
        workspace_id: &str,
        now: &str,
    ) -> Result<Board, BoardError> {
        if let Some(board) = inner.boards.get(workspace_id) {
            return Ok(board.clone());
        }
        let board = self
            .store
            .load(workspace_id)?
            .unwrap_or_else(|| Board::empty(workspace_id, now));
        inner.boards.insert(workspace_id.to_owned(), board.clone());
        Ok(board)
    }

    /// The board of a project; a board never saved reads as disabled with
    /// default settings. Works in safe mode.
    pub(crate) fn get(&self, workspace_id: &str) -> Result<Board, BoardError> {
        workspace_directory_name(workspace_id)?;
        let now = self.now();
        let mut inner = self.lock()?;
        self.current(&mut inner, workspace_id, &now.text)
    }

    /// Applies `change` to a staged copy and stores it as a new generation;
    /// nothing is written when the board did not change. Returns the value,
    /// the board revision and the cards whose stored data changed.
    pub(crate) fn transact<T>(
        &self,
        workspace_id: &str,
        change: impl FnOnce(&mut Board, &Now) -> Result<T, BoardError>,
    ) -> Result<(T, u64), BoardError> {
        if self.safe_mode {
            return Err(BoardError::SafeMode);
        }
        workspace_directory_name(workspace_id)?;
        let now = self.now();
        let event;
        let result = {
            let mut inner = self.lock()?;
            let current = self.current(&mut inner, workspace_id, &now.text)?;
            let mut staged = current.clone();
            let value = change(&mut staged, &now)?;
            if staged == current {
                return Ok((value, current.revision));
            }
            staged.revision = current.revision.checked_add(1).ok_or(BoardError::Io)?;
            staged.updated_at = now.text.clone();
            self.store.save(&staged)?;
            let touched = touched_cards(&current, &staged);
            let revision = staged.revision;
            inner.boards.insert(workspace_id.to_owned(), staged);
            event = BoardChangedEventV1 {
                protocol: BOARD_PROTOCOL,
                workspace_id: workspace_id.to_owned(),
                revision,
                card_ids: (!touched.is_empty()).then_some(touched),
            };
            (value, revision)
        };
        self.notify(&event);
        Ok(result)
    }

    fn card_now(&self, workspace_id: &str, card_id: &str) -> Result<(Card, u64), BoardError> {
        let board = self.get(workspace_id)?;
        let card = board
            .card(card_id)
            .cloned()
            .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
        Ok((card, board.revision))
    }

    pub(crate) fn set_enabled(
        &self,
        workspace_id: &str,
        enabled: bool,
    ) -> Result<Board, BoardError> {
        self.transact(workspace_id, |board, _| {
            board.enabled = enabled;
            Ok(())
        })?;
        self.get(workspace_id)
    }

    pub(crate) fn update_settings(
        &self,
        workspace_id: &str,
        expected_revision: u64,
        settings: BoardSettings,
    ) -> Result<Board, BoardError> {
        if !settings.valid() {
            return Err(BoardError::Invalid(
                "Board concurrency must be between 1 and 16.",
            ));
        }
        self.transact(workspace_id, |board, _| {
            if board.revision != expected_revision {
                return Err(BoardError::RevisionConflict);
            }
            board.settings = settings;
            Ok(())
        })?;
        self.get(workspace_id)
    }

    pub(crate) fn create_card(
        &self,
        workspace_id: &str,
        actor: &BoardActor,
        draft: CardDraft,
        status: Option<CardStatus>,
        session: Option<&SessionRef>,
    ) -> Result<(Card, u64), BoardError> {
        let (card_id, _) = self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            create_in(board, actor, draft, status, session, now)
        })?;
        self.card_now(workspace_id, &card_id)
    }

    /// `expected_revision` is the card revision (person edits); agents pass
    /// `None`. `undoable` marks an auto-mode agent edit.
    pub(crate) fn update_card(
        &self,
        workspace_id: &str,
        actor: &BoardActor,
        card_id: &str,
        expected_revision: Option<u64>,
        patch: CardPatch,
        undoable: bool,
    ) -> Result<(Card, u64), BoardError> {
        self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            let card = board
                .card(card_id)
                .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
            if expected_revision.is_some_and(|expected| expected != card.revision) {
                return Err(BoardError::RevisionConflict);
            }
            apply_patch_in(board, card_id, &patch, actor, now, undoable).map(|_| ())
        })?;
        self.card_now(workspace_id, card_id)
    }

    /// Moves a card (and, with `order`, places it at that 0-based position
    /// of the target column). A person's move to `todo` of an assigned card
    /// wakes its teammate by rule; closing unblocks dependents.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn move_card(
        &self,
        workspace_id: &str,
        actor: &BoardActor,
        card_id: &str,
        to: CardStatus,
        order: Option<i64>,
        reason: Option<String>,
        undoable: bool,
        teammates: &[TeammateRef],
    ) -> Result<(Card, u64), BoardError> {
        let reason = reason.map(|reason| validate_reason(&reason)).transpose()?;
        let starter_available = self.starter().available();
        let (plans, _) = self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            let moved = set_status_in(board, card_id, to, reason, actor, now, undoable)?;
            if let Some(position) = order {
                reorder_in(board, card_id, position);
            }
            let mut plans = Vec::new();
            let depth = cause_depth(actor, 0);
            if moved.changed && to == CardStatus::Todo && actor.is_person() {
                wake_assignee(
                    board,
                    card_id,
                    teammates,
                    BoardRunCause::MovedToTodo,
                    actor,
                    depth,
                    starter_available,
                    now,
                    &mut plans,
                );
            }
            for unblocked in &moved.unblocked {
                wake_assignee(
                    board,
                    unblocked,
                    teammates,
                    BoardRunCause::Unblocked,
                    actor,
                    depth,
                    starter_available,
                    now,
                    &mut plans,
                );
            }
            Ok(plans)
        })?;
        self.run_plans(workspace_id, plans, teammates);
        self.card_now(workspace_id, card_id)
    }

    pub(crate) fn delete_card(
        &self,
        workspace_id: &str,
        card_id: &str,
        expected_revision: u64,
    ) -> Result<u64, BoardError> {
        let ((), revision) = self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            let card = board
                .card(card_id)
                .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
            if card.revision != expected_revision {
                return Err(BoardError::RevisionConflict);
            }
            if card
                .claim
                .as_ref()
                .is_some_and(|claim| claim.run_id.is_some() && claim_live(claim, now))
            {
                return Err(BoardError::AlreadyClaimed);
            }
            board.cards.retain(|card| card.id != card_id);
            for other in &mut board.cards {
                let before = other.blocked_by.len();
                other.blocked_by.retain(|id| id != card_id);
                let orphaned = other.parent_id.as_deref() == Some(card_id);
                if orphaned {
                    other.parent_id = None;
                }
                if orphaned || before != other.blocked_by.len() {
                    touch(other, now);
                }
            }
            board
                .proposals
                .retain(|proposal| proposal.card_id.as_deref() != Some(card_id));
            board
                .pending_starts
                .retain(|pending| pending.card_id != card_id);
            board
                .queued_starts
                .retain(|queued| queued.card_id != card_id);
            Ok(())
        })?;
        Ok(revision)
    }

    /// Adds a comment. A person's `@handle` mention wakes that teammate by
    /// its rule when it has `wake.onMention`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn comment(
        &self,
        workspace_id: &str,
        actor: &BoardActor,
        card_id: &str,
        body: String,
        mentions: Vec<CommentMention>,
        run_id: Option<String>,
        teammates: &[TeammateRef],
    ) -> Result<(Card, u64), BoardError> {
        validate_mentions(&body, &mentions, teammates)?;
        let starter_available = self.starter().available();
        let (plans, _) = self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            comment_in(board, card_id, actor, body, mentions.clone(), run_id, now)?;
            let mut plans = Vec::new();
            if actor.is_person() {
                let mentioned: BTreeSet<&str> = mentions
                    .iter()
                    .map(|mention| mention.teammate_id.as_str())
                    .collect();
                for teammate in teammates.iter().filter(|teammate| {
                    teammate.on_mention && mentioned.contains(teammate.id.as_str())
                }) {
                    if let Some(plan) = wake_in(
                        board,
                        card_id,
                        teammate,
                        teammate.on_assign,
                        BoardRunCause::Mention,
                        actor,
                        0,
                        starter_available,
                        now,
                    ) {
                        plans.push(plan);
                    }
                }
            }
            Ok(plans)
        })?;
        self.run_plans(workspace_id, plans, teammates);
        self.card_now(workspace_id, card_id)
    }

    /// Assigns (or, with `None`, unassigns) a card and applies the start
    /// rule: `ask` follows the teammate's `wake.onAssign`, `now` starts,
    /// `later` only assigns. `chain_depth` is the depth a started run gets.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn assign(
        &self,
        workspace_id: &str,
        actor: &BoardActor,
        card_id: &str,
        teammate_id: Option<&str>,
        start: CardStartMode,
        chain_depth: u8,
        undoable: bool,
        teammates: &[TeammateRef],
    ) -> Result<(Card, u64, AssignOutcome), BoardError> {
        let teammate = teammate_id
            .map(|id| find_teammate(teammates, id))
            .transpose()?;
        let starter_available = self.starter().available();
        let (plan, _) = self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            let changed = assign_in(board, card_id, teammate, actor, now, undoable)?;
            let Some(teammate) = teammate else {
                return Ok(None);
            };
            let rule = match start {
                CardStartMode::Ask => teammate.on_assign,
                CardStartMode::Now => TeammateStartRule::Always,
                CardStartMode::Later => TeammateStartRule::Never,
            };
            // Re-assigning the same teammate only starts on an explicit `now`.
            if !changed && start != CardStartMode::Now {
                return Ok(None);
            }
            let pending_before = board.pending_starts.len();
            let plan = wake_in(
                board,
                card_id,
                teammate,
                rule,
                BoardRunCause::Assigned,
                actor,
                chain_depth,
                starter_available,
                now,
            );
            Ok(match plan {
                Some(plan) => Some(Ok(plan)),
                None if board.pending_starts.len() > pending_before => Some(Err(())),
                None => None,
            })
        })?;
        let outcome = match plan {
            None => AssignOutcome::Assigned,
            Some(Err(())) => AssignOutcome::PendingStart,
            Some(Ok(plan)) => match self.run_plan(workspace_id, &plan, teammates) {
                Ok(Some(_)) => AssignOutcome::Started,
                Ok(None) => AssignOutcome::Queued,
                Err(_) => AssignOutcome::Assigned,
            },
        };
        let (card, revision) = self.card_now(workspace_id, card_id)?;
        Ok((card, revision, outcome))
    }

    /// A person's explicit start of the card's assignee.
    pub(crate) fn start_run(
        &self,
        workspace_id: &str,
        card_id: &str,
        teammates: &[TeammateRef],
    ) -> Result<(Card, u64), BoardError> {
        let board = self.get(workspace_id)?;
        require_enabled(&board)?;
        let card = board
            .card(card_id)
            .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
        let assignee = card.assignee.clone().ok_or(BoardError::NotAssignable(
            "Assign the card to a teammate first.",
        ))?;
        let teammate = find_teammate(teammates, &assignee)?;
        self.start_card_run(
            workspace_id,
            card_id,
            teammate,
            BoardRunCause::Manual,
            &BoardActor::Person,
            0,
        )?;
        self.card_now(workspace_id, card_id)
    }

    pub(crate) fn resolve_pending_start(
        &self,
        workspace_id: &str,
        pending_start_id: &str,
        accept: bool,
        teammates: &[TeammateRef],
    ) -> Result<Board, BoardError> {
        let board = self.get(workspace_id)?;
        let pending = board
            .pending_starts
            .iter()
            .find(|pending| pending.id == pending_start_id)
            .cloned()
            .ok_or(BoardError::NotFound(
                "That start request is no longer waiting.",
            ))?;
        if accept {
            let teammate = find_teammate(teammates, &pending.teammate_id)?;
            self.start_card_run(
                workspace_id,
                &pending.card_id,
                teammate,
                pending.cause,
                &BoardActor::Person,
                0,
            )?;
        }
        self.transact(workspace_id, |board, _| {
            board
                .pending_starts
                .retain(|pending| pending.id != pending_start_id);
            Ok(())
        })?;
        self.get(workspace_id)
    }

    /// Starts a run for a card: one board generation (claim held by the
    /// run, `inProgress`, run link, `runStarted`), then the run creation; if
    /// that fails the board change is rolled back and a comment says why.
    /// `Ok(None)`: no concurrency slot is free; the start waits in the
    /// queue and begins when a run of the teammate or board ends.
    pub(crate) fn start_card_run(
        &self,
        workspace_id: &str,
        card_id: &str,
        teammate: &TeammateRef,
        cause: BoardRunCause,
        actor: &BoardActor,
        chain_depth: u8,
    ) -> Result<Option<String>, BoardError> {
        let _start = self.start_gate.lock().map_err(|_| BoardError::Io)?;
        self.start_card_run_gated(workspace_id, card_id, teammate, cause, actor, chain_depth)
    }

    /// `start_card_run` with the start gate held.
    fn start_card_run_gated(
        &self,
        workspace_id: &str,
        card_id: &str,
        teammate: &TeammateRef,
        cause: BoardRunCause,
        actor: &BoardActor,
        chain_depth: u8,
    ) -> Result<Option<String>, BoardError> {
        let starter = self.starter();
        if !starter.available() {
            return Err(RUNS_UNAVAILABLE);
        }
        if !teammate.assignable() {
            return Err(BoardError::NotAssignable(TEAMMATE_NOT_ASSIGNABLE));
        }
        if chain_depth > MAX_TRIGGER_CHAIN_DEPTH {
            return Err(BoardError::Invalid(
                "This start is too far down an automatic chain; start it yourself.",
            ));
        }
        let board = self.get(workspace_id)?;
        require_enabled(&board)?;
        let card = board
            .card(card_id)
            .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
        if card.status.is_closed() {
            return Err(BoardError::Invalid(
                "Reopen the card before starting a run.",
            ));
        }
        if card
            .claim
            .as_ref()
            .is_some_and(|claim| claim_live(claim, &self.now()))
        {
            return Err(BoardError::AlreadyClaimed);
        }
        if !starter.has_capacity(
            workspace_id,
            &teammate.id,
            board.settings.max_concurrent_runs,
        ) {
            self.enqueue(
                workspace_id,
                card_id,
                &teammate.id,
                cause,
                actor,
                chain_depth,
            )?;
            return Ok(None);
        }
        let run_id = Uuid::new_v4().to_string();
        let ((previous_status, card_text, card_number), _) =
            self.transact(workspace_id, |board, now| {
                require_enabled(board)?;
                let card = board
                    .card(card_id)
                    .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
                if card.status.is_closed() {
                    return Err(BoardError::Invalid(
                        "Reopen the card before starting a run.",
                    ));
                }
                if card
                    .claim
                    .as_ref()
                    .is_some_and(|claim| claim_live(claim, now))
                {
                    return Err(BoardError::AlreadyClaimed);
                }
                let previous = card.status;
                let number = card.number;
                if previous != CardStatus::InProgress {
                    set_status_in(
                        board,
                        card_id,
                        CardStatus::InProgress,
                        None,
                        actor,
                        now,
                        false,
                    )?;
                }
                let card = board
                    .card_mut(card_id)
                    .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
                card.claim = Some(CardClaim {
                    actor: BoardActor::Host,
                    run_id: Some(run_id.clone()),
                    claimed_at: now.text.clone(),
                    expires_at: now.plus_seconds(CLAIM_LEASE_SECONDS),
                });
                card.links.push(CardLink::Run {
                    run_id: run_id.clone(),
                    teammate_id: Some(teammate.id.clone()),
                    since: now.text.clone(),
                });
                push_activity(
                    card,
                    actor,
                    now,
                    CardChange::RunStarted {
                        run_id: run_id.clone(),
                        teammate_id: teammate.id.clone(),
                    },
                    false,
                );
                touch(card, now);
                let text = card_task_text(card);
                board
                    .pending_starts
                    .retain(|pending| pending.card_id != card_id);
                // Taken from the queue in the generation that starts it.
                board
                    .queued_starts
                    .retain(|queued| queued.card_id != card_id);
                Ok((previous, text, number))
            })?;
        let request = BoardRunRequest {
            workspace_id: workspace_id.to_owned(),
            run_id: run_id.clone(),
            card_id: card_id.to_owned(),
            card_number,
            teammate_id: teammate.id.clone(),
            cause,
            chain_depth,
            card_text,
        };
        if let Err(error) = starter.start(&request) {
            let _ = self.transact(workspace_id, |board, now| {
                let Some(card) = board.card_mut(card_id) else {
                    return Ok(());
                };
                if card
                    .claim
                    .as_ref()
                    .is_some_and(|claim| claim.run_id.as_deref() == Some(run_id.as_str()))
                {
                    card.claim = None;
                }
                card.links.retain(
                    |link| !matches!(link, CardLink::Run { run_id: linked, .. } if *linked == run_id),
                );
                let restore = card.status == CardStatus::InProgress
                    && previous_status != CardStatus::InProgress;
                touch(card, now);
                if restore {
                    let order = next_order(board, previous_status, Some(card_id));
                    if let Some(card) = board.card_mut(card_id) {
                        card.status = previous_status;
                        card.order = order;
                    }
                }
                comment_in(
                    board,
                    card_id,
                    &BoardActor::Host,
                    format!("Could not start @{}: {}", teammate.handle, error.message()),
                    Vec::new(),
                    None,
                    now,
                )
            });
            return Err(error);
        }
        Ok(Some(run_id))
    }

    /// Adds a start to the concurrency queue of the board document, with a
    /// `queued` activity on the card, in one generation; a card waits there
    /// once (a start for another teammate is replaced).
    fn enqueue(
        &self,
        workspace_id: &str,
        card_id: &str,
        teammate_id: &str,
        cause: BoardRunCause,
        actor: &BoardActor,
        chain_depth: u8,
    ) -> Result<(), BoardError> {
        self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            if board.card(card_id).is_none() {
                return Err(BoardError::NotFound(CARD_NOT_FOUND));
            }
            if board
                .queued_starts
                .iter()
                .any(|queued| queued.card_id == card_id && queued.teammate_id == teammate_id)
            {
                return Ok(());
            }
            board
                .queued_starts
                .retain(|queued| queued.card_id != card_id);
            if board.queued_starts.len() >= MAX_QUEUED_STARTS {
                return Err(BoardError::Limit(
                    "Too many runs wait for a free slot. Try again later.",
                ));
            }
            board.queued_starts.push(QueuedStartRecord {
                id: Uuid::new_v4().to_string(),
                card_id: card_id.to_owned(),
                teammate_id: teammate_id.to_owned(),
                cause,
                chain_depth,
                requested_by: actor.clone(),
                created_at: now.text.clone(),
            });
            let card = board
                .card_mut(card_id)
                .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
            push_activity(
                card,
                actor,
                now,
                CardChange::Queued {
                    teammate_id: teammate_id.to_owned(),
                },
                false,
            );
            touch(card, now);
            Ok(())
        })
        .map(|_| ())
    }

    /// Drops the queued start of a card (it no longer applies).
    fn dequeue_card(&self, workspace_id: &str, card_id: &str) {
        let _ = self.transact(workspace_id, |board, _| {
            board
                .queued_starts
                .retain(|queued| queued.card_id != card_id);
            Ok(())
        });
    }

    /// Drops every queued start of a teammate (disabled or deleted).
    pub(crate) fn forget_queued_starts(
        &self,
        workspace_id: &str,
        teammate_id: &str,
    ) -> Result<(), BoardError> {
        self.transact(workspace_id, |board, _| {
            board
                .queued_starts
                .retain(|queued| queued.teammate_id != teammate_id);
            Ok(())
        })
        .map(|_| ())
    }

    /// Starts waiting in the queue of one project, in start order (card
    /// priority, then age). Read from the board document.
    pub(crate) fn queued_starts(&self, workspace_id: &str) -> Vec<QueuedStart> {
        let Ok(board) = self.get(workspace_id) else {
            return Vec::new();
        };
        let mut queued: Vec<QueuedStart> = board
            .queued_starts
            .iter()
            .enumerate()
            .map(|(index, record)| QueuedStart {
                workspace_id: workspace_id.to_owned(),
                card_id: record.card_id.clone(),
                teammate_id: record.teammate_id.clone(),
                cause: record.cause,
                chain_depth: record.chain_depth,
                actor: record.requested_by.clone(),
                priority: board
                    .card(&record.card_id)
                    .map_or(CardPriority::Normal, |card| card.priority),
                seq: u64::try_from(index).unwrap_or(u64::MAX).saturating_add(1),
            })
            .collect();
        queued.sort_by(queue_order);
        queued
    }

    /// Loaded projects with starts waiting for a slot. After a restart the
    /// run engine loads the boards of projects with teammates first.
    pub(crate) fn queued_workspaces(&self) -> BTreeSet<String> {
        self.lock().map_or_else(
            |_| BTreeSet::new(),
            |inner| {
                inner
                    .boards
                    .iter()
                    .filter(|(_, board)| !board.queued_starts.is_empty())
                    .map(|(workspace_id, _)| workspace_id.clone())
                    .collect()
            },
        )
    }

    /// Starts queued runs of a project while slots are free, in priority
    /// then age order. A start that no longer applies (card closed, moved
    /// to backlog, claimed, reassigned, teammate gone or disabled) leaves
    /// the queue; one still waiting for a slot stays in place.
    /// Returns the number of runs started.
    pub(crate) fn drain_queue(&self, workspace_id: &str, teammates: &[TeammateRef]) -> usize {
        let Ok(_start) = self.start_gate.lock() else {
            return 0;
        };
        // Without a run engine nothing can start; keep the queue.
        if !self.starter().available() {
            return 0;
        }
        let mut started = 0;
        for queued in self.queued_starts(workspace_id) {
            let Ok(board) = self.get(workspace_id) else {
                break;
            };
            if !board.queued_starts.iter().any(|record| {
                record.card_id == queued.card_id && record.teammate_id == queued.teammate_id
            }) {
                continue;
            }
            let applies = board.enabled
                && board.card(&queued.card_id).is_some_and(|card| {
                    card.assignee.as_deref() == Some(queued.teammate_id.as_str())
                        && matches!(
                            card.status,
                            CardStatus::Todo | CardStatus::InProgress | CardStatus::Blocked
                        )
                });
            let Some(teammate) = teammates
                .iter()
                .find(|teammate| teammate.id == queued.teammate_id)
                .filter(|teammate| applies && teammate.assignable())
            else {
                self.dequeue_card(workspace_id, &queued.card_id);
                continue;
            };
            match self.start_card_run_gated(
                workspace_id,
                &queued.card_id,
                teammate,
                queued.cause,
                &queued.actor,
                queued.chain_depth,
            ) {
                Ok(Some(_)) => started += 1,
                // Still no slot: the start keeps its place.
                Ok(None) => {}
                Err(_) => self.dequeue_card(workspace_id, &queued.card_id),
            }
        }
        started
    }

    /// Records the end of a board run on its card, once: a comment with the
    /// truncated result or the failure, the `runFinished` activity, the
    /// claim release and the move to `inReview`/`blocked` (only while the
    /// run still held the card). Returns whether the board changed. Works on
    /// a disabled board: the run belongs to the card either way.
    pub(crate) fn finish_run(
        &self,
        workspace_id: &str,
        card_id: &str,
        run_id: &str,
        teammate_handle: Option<&str>,
        end: &RunEnd,
    ) -> Result<bool, BoardError> {
        let outcome = end.outcome();
        let (changed, _) = self.transact(workspace_id, |board, now| {
            let Some(card) = board.card_mut(card_id) else {
                return Ok(false);
            };
            let holds = card
                .claim
                .as_ref()
                .is_some_and(|claim| claim.run_id.as_deref() == Some(run_id));
            if run_end_recorded(card, run_id) {
                // Recorded before: only a claim left behind is released.
                if holds {
                    card.claim = None;
                    push_activity(
                        card,
                        &BoardActor::Host,
                        now,
                        CardChange::Released {
                            reason: ReleaseReason::RunEnded,
                        },
                        false,
                    );
                    touch(card, now);
                    return Ok(true);
                }
                return Ok(false);
            }
            let status = card.status;
            if holds {
                card.claim = None;
                push_activity(
                    card,
                    &BoardActor::Host,
                    now,
                    CardChange::Released {
                        reason: ReleaseReason::RunEnded,
                    },
                    false,
                );
            }
            push_activity(
                card,
                &BoardActor::Host,
                now,
                CardChange::RunFinished {
                    run_id: run_id.to_owned(),
                    outcome,
                },
                false,
            );
            touch(card, now);
            if let Some(body) = run_end_comment(end, teammate_handle) {
                // A card at its comment limit still records the outcome.
                let _ = comment_in(
                    board,
                    card_id,
                    &BoardActor::Host,
                    body,
                    Vec::new(),
                    Some(run_id.to_owned()),
                    now,
                );
            }
            if let Some(to) = run_end_status(outcome, holds, status) {
                set_status_in(board, card_id, to, None, &BoardActor::Host, now, false)?;
            }
            Ok(true)
        })?;
        Ok(changed)
    }

    /// Releases expired agent claims and run claims whose run is no longer
    /// active (`run_active` answers from the orchestration store). Returns
    /// the number of claims released.
    pub(crate) fn sweep_claims(
        &self,
        workspace_id: &str,
        run_active: &dyn Fn(&str) -> bool,
    ) -> Result<usize, BoardError> {
        let board = self.get(workspace_id)?;
        let now = self.now();
        let stale = |claim: &CardClaim| match claim.run_id.as_deref() {
            Some(run_id) => !run_active(run_id),
            None => !claim_live(claim, &now),
        };
        if !board
            .cards
            .iter()
            .any(|card| card.claim.as_ref().is_some_and(stale))
        {
            return Ok(0);
        }
        let (released, _) = self.transact(workspace_id, |board, now| {
            let mut released = 0;
            for card in &mut board.cards {
                let Some(claim) = card.claim.as_ref() else {
                    continue;
                };
                let reason = match claim.run_id.as_deref() {
                    Some(run_id) if !run_active(run_id) => ReleaseReason::RunEnded,
                    None if !claim_live(claim, now) => ReleaseReason::Expired,
                    _ => continue,
                };
                card.claim = None;
                push_activity(
                    card,
                    &BoardActor::Host,
                    now,
                    CardChange::Released { reason },
                    false,
                );
                touch(card, now);
                released += 1;
            }
            Ok(released)
        })?;
        Ok(released)
    }

    /// Projects whose board this host loaded.
    pub(crate) fn loaded_workspaces(&self) -> Vec<String> {
        self.lock()
            .map(|inner| inner.boards.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn run_plan(
        &self,
        workspace_id: &str,
        plan: &StartPlan,
        teammates: &[TeammateRef],
    ) -> Result<Option<String>, BoardError> {
        let teammate = find_teammate(teammates, &plan.teammate_id)?;
        self.start_card_run(
            workspace_id,
            &plan.card_id,
            teammate,
            plan.cause,
            &plan.actor,
            plan.chain_depth,
        )
    }

    fn run_plans(&self, workspace_id: &str, plans: Vec<StartPlan>, teammates: &[TeammateRef]) {
        for plan in plans {
            // A failed start was rolled back and explained on the card.
            let _ = self.run_plan(workspace_id, &plan, teammates);
        }
    }

    pub(crate) fn release_claim(
        &self,
        workspace_id: &str,
        actor: &BoardActor,
        card_id: &str,
    ) -> Result<(Card, u64), BoardError> {
        self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            release_in(board, card_id, actor, ReleaseReason::Released, now).map(|_| ())
        })?;
        self.card_now(workspace_id, card_id)
    }

    pub(crate) fn link_session(
        &self,
        workspace_id: &str,
        actor: &BoardActor,
        card_id: &str,
        session: &SessionRef,
    ) -> Result<(Card, u64), BoardError> {
        validate_reference(&session.session_id)?;
        self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            let card = board
                .card_mut(card_id)
                .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
            link_session_in(card, session, actor, now);
            Ok(())
        })?;
        self.card_now(workspace_id, card_id)
    }

    pub(crate) fn unlink_session(
        &self,
        workspace_id: &str,
        actor: &BoardActor,
        card_id: &str,
        session_id: &str,
    ) -> Result<(Card, u64), BoardError> {
        self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            let card = board
                .card_mut(card_id)
                .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
            let Some(index) = card.links.iter().position(|link| {
                matches!(link, CardLink::Session { session_id: linked, .. } if linked == session_id)
            }) else {
                return Ok(());
            };
            let link = card.links.remove(index);
            push_activity(card, actor, now, CardChange::Unlinked { link }, false);
            touch(card, now);
            Ok(())
        })?;
        self.card_now(workspace_id, card_id)
    }

    /// Cards linked to a chat: open cards by most recent link first (the
    /// first is the chat's active card), then closed ones.
    pub(crate) fn session_cards(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Vec<Card>, BoardError> {
        let board = self.get(workspace_id)?;
        Ok(session_cards_of(&board, session_id)
            .into_iter()
            .cloned()
            .collect())
    }

    /// Reverts one undoable activity (moved, assigned, edited, claimed) when
    /// the card still shows its result, and records `reverted`.
    pub(crate) fn undo(
        &self,
        workspace_id: &str,
        card_id: &str,
        activity_id: &str,
    ) -> Result<(Card, u64), BoardError> {
        self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            undo_in(board, card_id, activity_id, now)
        })?;
        self.card_now(workspace_id, card_id)
    }

    /// Accepts (applies as the person-accepted author) or rejects a proposal.
    pub(crate) fn resolve_proposal(
        &self,
        workspace_id: &str,
        proposal_id: &str,
        accept: bool,
        teammates: &[TeammateRef],
    ) -> Result<Board, BoardError> {
        let starter_available = self.starter().available();
        let (plans, _) = self.transact(workspace_id, |board, now| {
            require_enabled(board)?;
            let index = board
                .proposals
                .iter()
                .position(|proposal| {
                    proposal.id == proposal_id && proposal.status == ProposalStatus::Pending
                })
                .ok_or(BoardError::NotFound("That proposal is no longer waiting."))?;
            let proposal = board.proposals[index].clone();
            let mut plans = Vec::new();
            if accept {
                apply_proposal_in(
                    board,
                    &proposal,
                    teammates,
                    starter_available,
                    now,
                    &mut plans,
                )?;
            }
            if let Some(stored) = board
                .proposals
                .iter_mut()
                .find(|stored| stored.id == proposal_id)
            {
                stored.status = if accept {
                    ProposalStatus::Accepted
                } else {
                    ProposalStatus::Rejected
                };
            }
            prune_proposals(board);
            Ok(plans)
        })?;
        self.run_plans(workspace_id, plans, teammates);
        self.get(workspace_id)
    }

    /// Drops a deleted teammate from cards and pending starts.
    pub(crate) fn forget_teammate(
        &self,
        workspace_id: &str,
        teammate_id: &str,
    ) -> Result<(), BoardError> {
        self.transact(workspace_id, |board, now| {
            board
                .pending_starts
                .retain(|pending| pending.teammate_id != teammate_id);
            board
                .queued_starts
                .retain(|queued| queued.teammate_id != teammate_id);
            for card in &mut board.cards {
                if card.assignee.as_deref() == Some(teammate_id) {
                    card.assignee = None;
                    push_activity(
                        card,
                        &BoardActor::Host,
                        now,
                        CardChange::Assigned {
                            from: Some(teammate_id.to_owned()),
                            to: None,
                        },
                        false,
                    );
                    touch(card, now);
                }
            }
            Ok(())
        })
        .map(|_| ())
    }

    /// Work waiting for a teammate on this board: pending starts plus
    /// starts waiting for a concurrency slot.
    pub(crate) fn queued_count(&self, workspace_id: &str, teammate_id: &str) -> usize {
        self.queued_teammates(workspace_id)
            .iter()
            .filter(|queued| *queued == teammate_id)
            .count()
    }

    /// One entry per waiting start (pending or queued) of a project.
    pub(crate) fn queued_teammates(&self, workspace_id: &str) -> Vec<String> {
        self.get(workspace_id).map_or_else(
            |_| Vec::new(),
            |board| {
                board
                    .pending_starts
                    .into_iter()
                    .map(|pending| pending.teammate_id)
                    .chain(
                        board
                            .queued_starts
                            .into_iter()
                            .map(|queued| queued.teammate_id),
                    )
                    .collect()
            },
        )
    }

    /// Starts a new agent turn: its write budget is reset.
    pub(crate) fn begin_turn(&self, turn_key: &str) {
        if let Ok(mut inner) = self.lock() {
            if inner.turn_writes.len() >= MAX_TURN_KEYS {
                inner.turn_writes.clear();
            }
            inner.turn_writes.insert(turn_key.to_owned(), 0);
        }
    }

    /// Refuses a write once the turn used its budget.
    pub(crate) fn check_turn_budget(&self, turn_key: &str) -> Result<(), BoardError> {
        let inner = self.lock()?;
        if inner.turn_writes.get(turn_key).copied().unwrap_or(0)
            >= super::model::MAX_AGENT_WRITES_PER_TURN
        {
            return Err(BoardError::RateLimited);
        }
        Ok(())
    }

    pub(crate) fn note_turn_write(&self, turn_key: &str) {
        if let Ok(mut inner) = self.lock() {
            if inner.turn_writes.len() >= MAX_TURN_KEYS && !inner.turn_writes.contains_key(turn_key)
            {
                inner.turn_writes.clear();
            }
            let count = inner.turn_writes.entry(turn_key.to_owned()).or_insert(0);
            *count = count.saturating_add(1);
        }
    }

    /// Wakes a card's assignee by rule inside a transaction (agent paths).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn plan_assign_wake(
        board: &mut Board,
        card_id: &str,
        teammate: &TeammateRef,
        actor: &BoardActor,
        chain_depth: u8,
        starter_available: bool,
        now: &Now,
    ) -> Option<StartPlan> {
        wake_in(
            board,
            card_id,
            teammate,
            teammate.on_assign,
            BoardRunCause::Assigned,
            actor,
            chain_depth,
            starter_available,
            now,
        )
    }

    pub(crate) fn starter_available(&self) -> bool {
        self.starter().available()
    }

    pub(crate) fn execute_plans(
        &self,
        workspace_id: &str,
        plans: Vec<StartPlan>,
        teammates: &[TeammateRef],
    ) -> usize {
        let mut started = 0;
        for plan in plans {
            if let Ok(Some(_)) = self.run_plan(workspace_id, &plan, teammates) {
                started += 1;
            }
        }
        started
    }
}

/// The host comment recording a run's end (none for a cancel).
pub(crate) fn run_end_comment(end: &RunEnd, teammate_handle: Option<&str>) -> Option<String> {
    let who = teammate_handle.map_or_else(|| "The run".to_owned(), |handle| format!("@{handle}"));
    match end {
        RunEnd::Succeeded { result } => Some(match result.as_deref().map(str::trim) {
            Some(text) if !text.is_empty() => {
                let truncated = truncate_bytes(text.to_owned(), MAX_RUN_RESULT_BYTES);
                let more = if truncated.len() < text.len() {
                    "\n\n(Result truncated; open the run for the rest.)"
                } else {
                    ""
                };
                format!("{who} finished. Result:\n\n{truncated}{more}")
            }
            _ => format!("{who} finished without a text result."),
        }),
        RunEnd::Failed { reason } => Some(truncate_bytes(
            format!("{who} failed: {reason}"),
            MAX_RUN_RESULT_BYTES,
        )),
        RunEnd::Cancelled => None,
    }
}

pub(crate) const CARD_NOT_FOUND: &str = "That card is no longer on the board.";
pub(crate) const TEAMMATE_NOT_FOUND: &str = "That teammate no longer exists.";
pub(crate) const TEAMMATE_NOT_ASSIGNABLE: &str = "This teammate cannot take cards right now.";

/// The depth a run started because of `actor` gets: 0 for a person or the
/// host, the causing run's depth plus one for an agent.
pub(crate) fn cause_depth(actor: &BoardActor, causing_depth: u8) -> u8 {
    if actor.is_agent() {
        causing_depth.saturating_add(1)
    } else {
        0
    }
}

pub(crate) fn find_teammate<'a>(
    teammates: &'a [TeammateRef],
    teammate_id: &str,
) -> Result<&'a TeammateRef, BoardError> {
    teammates
        .iter()
        .find(|teammate| teammate.id == teammate_id)
        .ok_or(BoardError::NotFound(TEAMMATE_NOT_FOUND))
}

fn touched_cards(before: &Board, after: &Board) -> Vec<String> {
    let previous: HashMap<&str, &Card> = before
        .cards
        .iter()
        .map(|card| (card.id.as_str(), card))
        .collect();
    let mut touched: Vec<String> = after
        .cards
        .iter()
        .filter(|card| previous.get(card.id.as_str()).copied() != Some(card))
        .map(|card| card.id.clone())
        .collect();
    let remaining: BTreeSet<&str> = after.cards.iter().map(|card| card.id.as_str()).collect();
    touched.extend(
        before
            .cards
            .iter()
            .filter(|card| !remaining.contains(card.id.as_str()))
            .map(|card| card.id.clone()),
    );
    touched
}

pub(crate) fn require_enabled(board: &Board) -> Result<(), BoardError> {
    if board.enabled {
        Ok(())
    } else {
        Err(BoardError::Disabled)
    }
}

pub(crate) fn claim_live(claim: &CardClaim, now: &Now) -> bool {
    // A run holds its claim until the run ends.
    claim.run_id.is_some()
        || DateTime::parse_from_rfc3339(&claim.expires_at)
            .is_ok_and(|expires| expires.with_timezone(&Utc) > now.at)
}

pub(crate) fn touch(card: &mut Card, now: &Now) {
    card.revision = card.revision.saturating_add(1);
    card.updated_at = now.text.clone();
}

pub(crate) fn push_activity(
    card: &mut Card,
    actor: &BoardActor,
    now: &Now,
    change: CardChange,
    undoable: bool,
) -> String {
    let id = Uuid::new_v4().to_string();
    card.activity.push(CardActivity {
        id: id.clone(),
        actor: actor.clone(),
        at: now.text.clone(),
        change,
        undoable,
    });
    let excess = card.activity.len().saturating_sub(MAX_ACTIVITY_PER_CARD);
    card.activity.drain(..excess);
    id
}

pub(crate) fn next_order(board: &Board, status: CardStatus, except: Option<&str>) -> i64 {
    board
        .cards
        .iter()
        .filter(|card| card.status == status && Some(card.id.as_str()) != except)
        .map(|card| card.order)
        .max()
        .map_or(0, |order| order.saturating_add(1))
}

fn no_controls(text: &str, allow_newlines: bool) -> bool {
    !text.chars().any(|character| {
        character.is_control() && !(allow_newlines && matches!(character, '\n' | '\r' | '\t'))
    })
}

pub(crate) fn validate_title(title: &str) -> Result<String, BoardError> {
    let title = title.trim();
    let count = title.chars().count();
    if (1..=MAX_CARD_TITLE_CHARS).contains(&count) && no_controls(title, false) {
        Ok(title.to_owned())
    } else {
        Err(BoardError::Invalid(
            "A card title needs 1-200 characters on one line.",
        ))
    }
}

pub(crate) fn validate_description(description: &str) -> Result<String, BoardError> {
    if description.len() <= MAX_CARD_DESCRIPTION_BYTES && no_controls(description, true) {
        Ok(description.to_owned())
    } else {
        Err(BoardError::Invalid(
            "A card description is limited to 64 KiB of text.",
        ))
    }
}

pub(crate) fn validate_labels(labels: &[String]) -> Result<Vec<String>, BoardError> {
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for label in labels {
        let label = label.trim();
        let count = label.chars().count();
        if !(1..=MAX_LABEL_CHARS).contains(&count) || !no_controls(label, false) {
            return Err(BoardError::Invalid(
                "Labels need 1-40 characters on one line.",
            ));
        }
        if seen.insert(label.to_lowercase()) {
            result.push(label.to_owned());
        }
    }
    if result.len() > MAX_LABELS_PER_CARD {
        return Err(BoardError::Invalid("A card can have at most 12 labels."));
    }
    Ok(result)
}

fn validate_reason(reason: &str) -> Result<String, BoardError> {
    let reason = reason.trim();
    if reason.chars().count() <= MAX_REASON_CHARS && no_controls(reason, true) {
        Ok(reason.to_owned())
    } else {
        Err(BoardError::Invalid(
            "A reason is limited to 500 characters.",
        ))
    }
}

fn validate_reference(value: &str) -> Result<(), BoardError> {
    if !value.is_empty() && value.len() <= MAX_REFERENCE_BYTES && no_controls(value, false) {
        Ok(())
    } else {
        Err(BoardError::Invalid("That chat id is not valid."))
    }
}

fn validate_blockers(
    board: &Board,
    card_id: Option<&str>,
    blockers: &[String],
) -> Result<Vec<String>, BoardError> {
    let mut result: Vec<String> = Vec::new();
    for blocker in blockers {
        if Some(blocker.as_str()) == card_id || board.card(blocker).is_none() {
            return Err(BoardError::Invalid(
                "A card can be blocked only by other cards of this board.",
            ));
        }
        if !result.contains(blocker) {
            result.push(blocker.clone());
        }
    }
    if result.len() > MAX_CARDS {
        return Err(BoardError::Invalid("Too many blockers."));
    }
    Ok(result)
}

fn validate_parent(
    board: &Board,
    card_id: Option<&str>,
    parent_id: Option<&str>,
) -> Result<Option<String>, BoardError> {
    let Some(parent_id) = parent_id else {
        return Ok(None);
    };
    const INVALID: BoardError =
        BoardError::Invalid("A parent must be another card of this board, without a cycle.");
    if Some(parent_id) == card_id || board.card(parent_id).is_none() {
        return Err(INVALID);
    }
    // Walk up from the parent; reaching the card itself would be a cycle.
    let mut current = board
        .card(parent_id)
        .and_then(|card| card.parent_id.clone());
    let mut steps = 0;
    while let Some(ancestor) = current {
        if Some(ancestor.as_str()) == card_id || steps > board.cards.len() {
            return Err(INVALID);
        }
        steps += 1;
        current = board
            .card(&ancestor)
            .and_then(|card| card.parent_id.clone());
    }
    Ok(Some(parent_id.to_owned()))
}

fn validate_comment_body(body: &str) -> Result<(), BoardError> {
    if !body.trim().is_empty() && body.len() <= MAX_COMMENT_BYTES && no_controls(body, true) {
        Ok(())
    } else {
        Err(BoardError::Invalid(
            "A comment needs text and is limited to 16 KiB.",
        ))
    }
}

fn validate_mentions(
    body: &str,
    mentions: &[CommentMention],
    teammates: &[TeammateRef],
) -> Result<(), BoardError> {
    if mentions.len() > MAX_MENTIONS {
        return Err(BoardError::Invalid(
            "A comment can mention at most 20 teammates.",
        ));
    }
    let length = body.encode_utf16().count() as u64;
    for mention in mentions {
        let end = u64::from(mention.start) + u64::from(mention.length);
        if mention.length == 0 || end > length {
            return Err(BoardError::Invalid(
                "A mention does not match the comment text.",
            ));
        }
        if !teammates
            .iter()
            .any(|teammate| teammate.id == mention.teammate_id)
        {
            return Err(BoardError::NotFound(TEAMMATE_NOT_FOUND));
        }
    }
    Ok(())
}

pub(crate) fn create_in(
    board: &mut Board,
    actor: &BoardActor,
    draft: CardDraft,
    status: Option<CardStatus>,
    session: Option<&SessionRef>,
    now: &Now,
) -> Result<String, BoardError> {
    if board.cards.len() >= MAX_CARDS {
        return Err(BoardError::Limit(
            "This board is full. Delete old cards, then try again.",
        ));
    }
    let title = validate_title(&draft.title)?;
    let description = draft
        .description
        .as_deref()
        .map(validate_description)
        .transpose()?
        .unwrap_or_default();
    let labels = validate_labels(draft.labels.as_deref().unwrap_or_default())?;
    let blocked_by =
        validate_blockers(board, None, draft.blocked_by.as_deref().unwrap_or_default())?;
    let parent_id = validate_parent(board, None, draft.parent_id.as_deref())?;
    if let Some(session) = session {
        validate_reference(&session.session_id)?;
    }
    let status = status.unwrap_or(CardStatus::Todo);
    let number = board.next_number;
    board.next_number = number.checked_add(1).ok_or(BoardError::Io)?;
    let id = Uuid::new_v4().to_string();
    let order = next_order(board, status, None);
    let mut card = Card {
        id: id.clone(),
        number,
        title,
        description,
        priority: draft.priority.unwrap_or(CardPriority::Normal),
        labels,
        blocked_by,
        parent_id,
        status,
        order,
        assignee: None,
        claim: None,
        links: Vec::new(),
        comments: Vec::new(),
        activity: Vec::new(),
        revision: 0,
        created_by: actor.clone(),
        created_at: now.text.clone(),
        updated_at: now.text.clone(),
        closed_at: status.is_closed().then(|| now.text.clone()),
    };
    push_activity(&mut card, actor, now, CardChange::Created, false);
    if let Some(session) = session {
        link_session_in(&mut card, session, actor, now);
        card.revision = 0;
    }
    board.cards.push(card);
    Ok(id)
}

/// Links a chat to a card or, when already linked, makes the link the most
/// recent (the chat's active card).
pub(crate) fn link_session_in(
    card: &mut Card,
    session: &SessionRef,
    actor: &BoardActor,
    now: &Now,
) {
    let existing = card.links.iter_mut().find_map(|link| match link {
        CardLink::Session {
            session_id, since, ..
        } if *session_id == session.session_id => Some(since),
        _ => None,
    });
    if let Some(since) = existing {
        *since = now.text.clone();
        touch(card, now);
        return;
    }
    let link = CardLink::Session {
        session_id: session.session_id.clone(),
        harness: session.harness.clone(),
        since: now.text.clone(),
    };
    card.links.push(link.clone());
    push_activity(card, actor, now, CardChange::Linked { link }, false);
    touch(card, now);
}

/// Applies a patch; returns whether any field changed.
pub(crate) fn apply_patch_in(
    board: &mut Board,
    card_id: &str,
    patch: &CardPatch,
    actor: &BoardActor,
    now: &Now,
    undoable: bool,
) -> Result<bool, BoardError> {
    let title = patch.title.as_deref().map(validate_title).transpose()?;
    let description = patch
        .description
        .as_deref()
        .map(validate_description)
        .transpose()?;
    let labels = patch.labels.as_deref().map(validate_labels).transpose()?;
    let blocked_by = patch
        .blocked_by
        .as_deref()
        .map(|blockers| validate_blockers(board, Some(card_id), blockers))
        .transpose()?;
    let parent_id = patch
        .parent_id
        .as_ref()
        .map(|parent| validate_parent(board, Some(card_id), parent.as_deref()))
        .transpose()?;
    let card = board
        .card_mut(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
    let mut fields = Vec::new();
    let mut previous = CardPatch::default();
    if let Some(title) = title.filter(|title| *title != card.title) {
        previous.title = Some(std::mem::replace(&mut card.title, title));
        fields.push("title".to_owned());
    }
    if let Some(description) = description.filter(|value| *value != card.description) {
        previous.description = Some(std::mem::replace(&mut card.description, description));
        fields.push("description".to_owned());
    }
    if let Some(priority) = patch.priority.filter(|value| *value != card.priority) {
        previous.priority = Some(std::mem::replace(&mut card.priority, priority));
        fields.push("priority".to_owned());
    }
    if let Some(labels) = labels.filter(|value| *value != card.labels) {
        previous.labels = Some(std::mem::replace(&mut card.labels, labels));
        fields.push("labels".to_owned());
    }
    if let Some(blocked_by) = blocked_by.filter(|value| *value != card.blocked_by) {
        previous.blocked_by = Some(std::mem::replace(&mut card.blocked_by, blocked_by));
        fields.push("blockedBy".to_owned());
    }
    if let Some(parent_id) = parent_id.filter(|value| *value != card.parent_id) {
        previous.parent_id = Some(std::mem::replace(&mut card.parent_id, parent_id));
        fields.push("parentId".to_owned());
    }
    if fields.is_empty() {
        return Ok(false);
    }
    push_activity(
        card,
        actor,
        now,
        CardChange::Edited { fields, previous },
        undoable,
    );
    touch(card, now);
    Ok(true)
}

pub(crate) struct Moved {
    pub changed: bool,
    /// Blocked cards moved to `todo` because this move closed their last blocker.
    pub unblocked: Vec<String>,
}

pub(crate) fn set_status_in(
    board: &mut Board,
    card_id: &str,
    to: CardStatus,
    reason: Option<String>,
    actor: &BoardActor,
    now: &Now,
    undoable: bool,
) -> Result<Moved, BoardError> {
    let from = board
        .card(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?
        .status;
    if from == to {
        return Ok(Moved {
            changed: false,
            unblocked: Vec::new(),
        });
    }
    let order = next_order(board, to, Some(card_id));
    let card = board
        .card_mut(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
    card.status = to;
    card.order = order;
    card.closed_at = to.is_closed().then(|| now.text.clone());
    if to.is_closed() && card.claim.take().is_some() {
        push_activity(
            card,
            &BoardActor::Host,
            now,
            CardChange::Released {
                reason: ReleaseReason::Done,
            },
            false,
        );
    }
    push_activity(
        card,
        actor,
        now,
        CardChange::Moved { from, to, reason },
        undoable,
    );
    touch(card, now);
    // A closed or backlog card no longer waits for a slot.
    if to.is_closed() || to == CardStatus::Backlog {
        board
            .queued_starts
            .retain(|queued| queued.card_id != card_id);
    }
    let unblocked = if to.is_closed() {
        unblock_dependents(board, card_id, now)
    } else {
        Vec::new()
    };
    Ok(Moved {
        changed: true,
        unblocked,
    })
}

fn unblock_dependents(board: &mut Board, closed_id: &str, now: &Now) -> Vec<String> {
    let closed: BTreeSet<&str> = board
        .cards
        .iter()
        .filter(|card| card.status.is_closed())
        .map(|card| card.id.as_str())
        .collect();
    let ids: Vec<String> = board
        .cards
        .iter()
        .filter(|card| {
            card.status == CardStatus::Blocked
                && card.blocked_by.iter().any(|blocker| blocker == closed_id)
                && card
                    .blocked_by
                    .iter()
                    .all(|blocker| closed.contains(blocker.as_str()))
        })
        .map(|card| card.id.clone())
        .collect();
    for id in &ids {
        let order = next_order(board, CardStatus::Todo, Some(id));
        if let Some(card) = board.card_mut(id) {
            card.status = CardStatus::Todo;
            card.order = order;
            push_activity(card, &BoardActor::Host, now, CardChange::Unblocked, false);
            touch(card, now);
        }
    }
    ids
}

/// Places a card at `position` (0-based) of its column and renumbers the
/// column's sort keys. Sort keys are layout, not content: no revision bump.
pub(crate) fn reorder_in(board: &mut Board, card_id: &str, position: i64) {
    let Some(status) = board.card(card_id).map(|card| card.status) else {
        return;
    };
    let mut column: Vec<(i64, u64, String)> = board
        .cards
        .iter()
        .filter(|card| card.status == status && card.id != card_id)
        .map(|card| (card.order, card.number, card.id.clone()))
        .collect();
    column.sort();
    let index = usize::try_from(position.max(0))
        .unwrap_or(usize::MAX)
        .min(column.len());
    column.insert(index, (0, 0, card_id.to_owned()));
    for (order, (_, _, id)) in column.iter().enumerate() {
        if let Some(card) = board.card_mut(id) {
            card.order = i64::try_from(order).unwrap_or(i64::MAX);
        }
    }
}

pub(crate) fn comment_in(
    board: &mut Board,
    card_id: &str,
    actor: &BoardActor,
    body: String,
    mentions: Vec<CommentMention>,
    run_id: Option<String>,
    now: &Now,
) -> Result<(), BoardError> {
    validate_comment_body(&body)?;
    let card = board
        .card_mut(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
    if card.comments.len() >= MAX_COMMENTS_PER_CARD {
        return Err(BoardError::Limit(
            "This card has too many comments. Start a new card to continue.",
        ));
    }
    let id = Uuid::new_v4().to_string();
    card.comments.push(CardComment {
        id: id.clone(),
        actor: actor.clone(),
        body,
        mentions,
        created_at: now.text.clone(),
        run_id,
    });
    push_activity(
        card,
        actor,
        now,
        CardChange::Commented { comment_id: id },
        false,
    );
    touch(card, now);
    Ok(())
}

/// Returns whether the assignee changed.
pub(crate) fn assign_in(
    board: &mut Board,
    card_id: &str,
    teammate: Option<&TeammateRef>,
    actor: &BoardActor,
    now: &Now,
    undoable: bool,
) -> Result<bool, BoardError> {
    if teammate.is_some_and(|teammate| !teammate.assignable()) {
        return Err(BoardError::NotAssignable(TEAMMATE_NOT_ASSIGNABLE));
    }
    let to = teammate.map(|teammate| teammate.id.clone());
    let card = board
        .card_mut(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
    if card.assignee == to {
        return Ok(false);
    }
    let from = std::mem::replace(&mut card.assignee, to.clone());
    push_activity(
        card,
        actor,
        now,
        CardChange::Assigned {
            from: from.clone(),
            to: to.clone(),
        },
        undoable,
    );
    touch(card, now);
    // Starts waiting for the previous assignee no longer apply.
    board
        .pending_starts
        .retain(|pending| pending.card_id != card_id || Some(&pending.teammate_id) == to.as_ref());
    board
        .queued_starts
        .retain(|queued| queued.card_id != card_id || Some(&queued.teammate_id) == to.as_ref());
    Ok(true)
}

/// Claims a card for `actor` (renewing its own claim).
pub(crate) fn claim_in(
    board: &mut Board,
    card_id: &str,
    actor: &BoardActor,
    now: &Now,
    undoable: bool,
) -> Result<(), BoardError> {
    let card = board
        .card_mut(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
    if card.status.is_closed() {
        return Err(BoardError::Invalid("A closed card cannot be claimed."));
    }
    if let Some(claim) = card.claim.as_mut().filter(|claim| claim_live(claim, now)) {
        if claim.actor != *actor {
            return Err(BoardError::AlreadyClaimed);
        }
        claim.expires_at = now.plus_seconds(CLAIM_LEASE_SECONDS);
        return Ok(());
    }
    card.claim = Some(CardClaim {
        actor: actor.clone(),
        run_id: None,
        claimed_at: now.text.clone(),
        expires_at: now.plus_seconds(CLAIM_LEASE_SECONDS),
    });
    push_activity(card, actor, now, CardChange::Claimed, undoable);
    touch(card, now);
    Ok(())
}

/// Releases a claim; an agent may release only its own. Returns whether a
/// claim was released.
pub(crate) fn release_in(
    board: &mut Board,
    card_id: &str,
    actor: &BoardActor,
    reason: ReleaseReason,
    now: &Now,
) -> Result<bool, BoardError> {
    let card = board
        .card_mut(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
    let Some(claim) = card.claim.as_ref() else {
        return Ok(false);
    };
    if !actor.is_person() && claim.actor != *actor && claim_live(claim, now) {
        return Err(BoardError::Forbidden(
            "Only the agent holding this card can release it. Do not retry.",
        ));
    }
    card.claim = None;
    push_activity(card, actor, now, CardChange::Released { reason }, false);
    touch(card, now);
    Ok(true)
}

fn add_pending_start(
    board: &mut Board,
    card_id: &str,
    teammate_id: &str,
    cause: BoardRunCause,
    actor: &BoardActor,
    now: &Now,
) -> bool {
    if board
        .pending_starts
        .iter()
        .any(|pending| pending.card_id == card_id && pending.teammate_id == teammate_id)
    {
        return false;
    }
    if board.pending_starts.len() >= MAX_PENDING {
        return false;
    }
    board.pending_starts.push(PendingStart {
        id: Uuid::new_v4().to_string(),
        card_id: card_id.to_owned(),
        teammate_id: teammate_id.to_owned(),
        cause,
        requested_by: actor.clone(),
        created_at: now.text.clone(),
    });
    true
}

/// Applies a start rule for `teammate` on a card: nothing, a pending start
/// for the person, or a start to run after the transaction commits. Backlog
/// and closed cards and cards claimed by a live holder never start.
#[allow(clippy::too_many_arguments)]
pub(crate) fn wake_in(
    board: &mut Board,
    card_id: &str,
    teammate: &TeammateRef,
    rule: TeammateStartRule,
    cause: BoardRunCause,
    actor: &BoardActor,
    chain_depth: u8,
    starter_available: bool,
    now: &Now,
) -> Option<StartPlan> {
    let card = board.card(card_id)?;
    if !matches!(
        card.status,
        CardStatus::Todo | CardStatus::InProgress | CardStatus::Blocked
    ) || card
        .claim
        .as_ref()
        .is_some_and(|claim| claim_live(claim, now))
        || !teammate.assignable()
        || own_run_card(card, actor)
    {
        return None;
    }
    let cooling = start_cooldown_active(card, now);
    match rule {
        TeammateStartRule::Never => None,
        TeammateStartRule::Ask => {
            add_pending_start(board, card_id, &teammate.id, cause, actor, now);
            None
        }
        TeammateStartRule::Always => {
            // Too deep an automatic chain, a start moments ago or no run
            // engine: the person decides.
            if chain_depth > MAX_TRIGGER_CHAIN_DEPTH || cooling || !starter_available {
                add_pending_start(board, card_id, &teammate.id, cause, actor, now);
                return None;
            }
            Some(StartPlan {
                card_id: card_id.to_owned(),
                teammate_id: teammate.id.clone(),
                cause,
                chain_depth,
                actor: actor.clone(),
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn wake_assignee(
    board: &mut Board,
    card_id: &str,
    teammates: &[TeammateRef],
    cause: BoardRunCause,
    actor: &BoardActor,
    chain_depth: u8,
    starter_available: bool,
    now: &Now,
    plans: &mut Vec<StartPlan>,
) {
    let Some(assignee) = board.card(card_id).and_then(|card| card.assignee.clone()) else {
        return;
    };
    let Some(teammate) = teammates.iter().find(|teammate| teammate.id == assignee) else {
        return;
    };
    if let Some(plan) = wake_in(
        board,
        card_id,
        teammate,
        teammate.on_assign,
        cause,
        actor,
        chain_depth,
        starter_available,
        now,
    ) {
        plans.push(plan);
    }
}

fn undo_in(
    board: &mut Board,
    card_id: &str,
    activity_id: &str,
    now: &Now,
) -> Result<(), BoardError> {
    let card = board
        .card(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
    let activity = card
        .activity
        .iter()
        .find(|activity| activity.id == activity_id)
        .cloned()
        .ok_or(BoardError::NotFound(
            "That change is no longer in the card history.",
        ))?;
    let already = card.activity.iter().any(|entry| {
        matches!(&entry.change, CardChange::Reverted { activity_id: reverted } if reverted == activity_id)
    });
    if !activity.undoable || already {
        return Err(BoardError::Invalid("That change cannot be undone."));
    }
    let person = BoardActor::Person;
    match activity.change {
        CardChange::Moved { from, to, .. } => {
            if card.status != to {
                return Err(BoardError::RevisionConflict);
            }
            set_status_in(board, card_id, from, None, &person, now, false)?;
        }
        CardChange::Assigned { from, to } => {
            if card.assignee != to {
                return Err(BoardError::RevisionConflict);
            }
            let card = board
                .card_mut(card_id)
                .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
            card.assignee = from.clone();
            push_activity(
                card,
                &person,
                now,
                CardChange::Assigned { from: to, to: from },
                false,
            );
            touch(card, now);
        }
        CardChange::Edited { previous, .. } => {
            let mut restore = previous;
            // A parent or blocker deleted since cannot come back.
            if let Some(Some(parent)) = &restore.parent_id
                && board.card(parent).is_none()
            {
                restore.parent_id = Some(None);
            }
            if let Some(blockers) = restore.blocked_by.as_mut() {
                blockers.retain(|blocker| board.card(blocker).is_some());
            }
            apply_patch_in(board, card_id, &restore, &person, now, false)?;
        }
        CardChange::Claimed => {
            let holds = card
                .claim
                .as_ref()
                .is_some_and(|claim| claim.actor == activity.actor && claim.run_id.is_none());
            if !holds {
                return Err(BoardError::RevisionConflict);
            }
            release_in(board, card_id, &person, ReleaseReason::Released, now)?;
        }
        _ => return Err(BoardError::Invalid("That change cannot be undone.")),
    }
    let card = board
        .card_mut(card_id)
        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
    push_activity(
        card,
        &person,
        now,
        CardChange::Reverted {
            activity_id: activity_id.to_owned(),
        },
        false,
    );
    touch(card, now);
    Ok(())
}

/// Adds a pending proposal; returns its id.
pub(crate) fn propose_in(
    board: &mut Board,
    actor: &BoardActor,
    card_id: Option<String>,
    operation: BoardOperation,
    now: &Now,
) -> Result<String, BoardError> {
    let pending = board
        .proposals
        .iter()
        .filter(|proposal| proposal.status == ProposalStatus::Pending)
        .count();
    if pending >= MAX_PENDING {
        return Err(BoardError::Limit(
            "Too many proposals wait for the person. Do not retry; ask them to review the Inbox.",
        ));
    }
    let id = Uuid::new_v4().to_string();
    board.proposals.push(BoardProposal {
        id: id.clone(),
        card_id,
        operation,
        actor: actor.clone(),
        created_at: now.text.clone(),
        status: ProposalStatus::Pending,
    });
    Ok(id)
}

fn apply_proposal_in(
    board: &mut Board,
    proposal: &BoardProposal,
    teammates: &[TeammateRef],
    starter_available: bool,
    now: &Now,
    plans: &mut Vec<StartPlan>,
) -> Result<(), BoardError> {
    let author = &proposal.actor;
    match proposal.operation.clone() {
        BoardOperation::Create { card, status } => {
            let session = match author {
                BoardActor::ChatAgent {
                    session_id,
                    harness,
                } => Some(SessionRef {
                    session_id: session_id.clone(),
                    harness: harness.clone(),
                }),
                _ => None,
            };
            create_in(board, author, card, status, session.as_ref(), now).map(|_| ())
        }
        BoardOperation::Update { card_id, patch } => {
            apply_patch_in(board, &card_id, &patch, author, now, false).map(|_| ())
        }
        BoardOperation::Move {
            card_id,
            to,
            reason,
        } => {
            let moved = set_status_in(board, &card_id, to, reason, author, now, false)?;
            for unblocked in &moved.unblocked {
                wake_assignee(
                    board,
                    unblocked,
                    teammates,
                    BoardRunCause::Unblocked,
                    &BoardActor::Person,
                    0,
                    starter_available,
                    now,
                    plans,
                );
            }
            Ok(())
        }
        BoardOperation::Comment { card_id, body } => {
            comment_in(board, &card_id, author, body, Vec::new(), None, now)
        }
        BoardOperation::Assign {
            card_id,
            teammate_id,
        } => {
            let teammate = teammate_id
                .as_deref()
                .map(|id| find_teammate(teammates, id))
                .transpose()?;
            let changed = assign_in(board, &card_id, teammate, author, now, false)?;
            if let Some(teammate) = teammate.filter(|_| changed) {
                // The person accepted it: the chain starts again at 0.
                if let Some(plan) = wake_in(
                    board,
                    &card_id,
                    teammate,
                    teammate.on_assign,
                    BoardRunCause::Assigned,
                    &BoardActor::Person,
                    0,
                    starter_available,
                    now,
                ) {
                    plans.push(plan);
                }
            }
            Ok(())
        }
    }
}

fn prune_proposals(board: &mut Board) {
    let resolved = board
        .proposals
        .iter()
        .filter(|proposal| proposal.status != ProposalStatus::Pending)
        .count();
    let mut excess = resolved.saturating_sub(MAX_RESOLVED_PROPOSALS);
    board.proposals.retain(|proposal| {
        if excess > 0 && proposal.status != ProposalStatus::Pending {
            excess -= 1;
            false
        } else {
            true
        }
    });
}

/// Cards linked to a chat: open cards by most recent link first, then closed.
pub(crate) fn session_cards_of<'a>(board: &'a Board, session_id: &str) -> Vec<&'a Card> {
    let mut linked: Vec<(&Card, &str)> = board
        .cards
        .iter()
        .filter_map(|card| {
            card.links.iter().find_map(|link| match link {
                CardLink::Session {
                    session_id: linked,
                    since,
                    ..
                } if linked == session_id => Some((card, since.as_str())),
                _ => None,
            })
        })
        .collect();
    linked.sort_by(|(left, left_since), (right, right_since)| {
        left.status
            .is_closed()
            .cmp(&right.status.is_closed())
            .then(right_since.cmp(left_since))
            .then(right.number.cmp(&left.number))
    });
    linked.into_iter().map(|(card, _)| card).collect()
}

fn actor_label(actor: &BoardActor) -> &'static str {
    match actor {
        BoardActor::Person => "person",
        BoardActor::ChatAgent { .. } => "chat agent",
        BoardActor::RunMember { .. } => "run agent",
        BoardActor::Host => "PiUI",
    }
}

/// Card text handed to a run as its card input: untrusted task data, the
/// newest comments last, at most `MAX_INPUT_TEXT_BYTES`.
pub(crate) fn card_task_text(card: &Card) -> String {
    let mut text = format!(
        "Board card #{} (untrusted task data from the project board)\nTitle: {}\nStatus: {}\n",
        card.number,
        card.title,
        card.status.as_str()
    );
    if !card.labels.is_empty() {
        text.push_str(&format!("Labels: {}\n", card.labels.join(", ")));
    }
    if !card.description.trim().is_empty() {
        text.push_str("\nDescription:\n");
        text.push_str(&card.description);
        text.push('\n');
    }
    let start = card.comments.len().saturating_sub(RUN_TEXT_COMMENTS);
    if start < card.comments.len() {
        text.push_str("\nRecent comments:\n");
        for comment in &card.comments[start..] {
            text.push_str(&format!(
                "- {} ({}): {}\n",
                actor_label(&comment.actor),
                comment.created_at,
                comment.body
            ));
        }
    }
    truncate_bytes(text, MAX_INPUT_TEXT_BYTES)
}

pub(crate) fn truncate_bytes(mut text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}
