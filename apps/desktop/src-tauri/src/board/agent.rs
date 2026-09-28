//! The agent-facing `board` host tool (ADR-041, `BoardToolOperationV1`).
//!
//! The bridge validates arguments with exact key sets; this module decodes
//! them again with `deny_unknown_fields`. The actor, the project and the
//! permissions come from the session binding ([`AgentContext`]), never from
//! arguments. Every answer is plain JSON for the agent; refusals carry a
//! code and a one-line instruction.

// The host tool handler (phase 2) is the caller of this API.
#![allow(dead_code)]

use super::model::ReleaseReason;
use super::model::{
    Board, BoardActor, BoardAgentMode, BoardError, BoardOperation, Card, CardDraft, CardPatch,
    CardPriority, CardStatus,
};
use super::ops::{
    Availability, BoardService, CARD_NOT_FOUND, SessionRef, StartPlan, TEAMMATE_NOT_ASSIGNABLE,
    TeammateRef, apply_patch_in, assign_in, cause_depth, claim_in, comment_in, create_in,
    link_session_in, propose_in, release_in, require_enabled, session_cards_of, set_status_in,
    validate_title,
};
use super::similarity::{self, DUPLICATE_THRESHOLD, MAX_SIMILAR};
use piui_orchestration::BoardPermissions;
use serde::{Deserialize, Serialize};

/// Most cards one `search` or `list` answer carries.
const MAX_TOOL_CARDS: usize = 50;
/// Comments shown by `get`.
const RECENT_COMMENTS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentCreateStatus {
    Backlog,
    Todo,
}

impl From<AgentCreateStatus> for CardStatus {
    fn from(status: AgentCreateStatus) -> Self {
        match status {
            AgentCreateStatus::Backlog => Self::Backlog,
            AgentCreateStatus::Todo => Self::Todo,
        }
    }
}

/// `BoardToolOperationV1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[allow(clippy::large_enum_variant)]
pub(crate) enum BoardToolOperation {
    Context {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
    },
    Search {
        query: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        include_closed: Option<bool>,
    },
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<CardStatus>,
    },
    Get {
        card: u64,
    },
    Create {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        priority: Option<CardPriority>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        labels: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<AgentCreateStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirm_new: Option<bool>,
    },
    Update {
        card: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        priority: Option<CardPriority>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        labels: Option<Vec<String>>,
    },
    Move {
        card: u64,
        to: CardStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Comment {
        card: u64,
        body: String,
    },
    Claim {
        card: u64,
    },
    Release {
        card: u64,
    },
    Link {
        card: u64,
    },
    Roster {},
    Assign {
        card: u64,
        handle: String,
    },
    Handoff {
        handle: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        priority: Option<CardPriority>,
    },
}

/// Who calls the tool, from the session binding.
pub(crate) struct AgentContext<'a> {
    pub workspace_id: &'a str,
    /// `chatAgent` or `runMember`; never `person` or `host`.
    pub actor: BoardActor,
    /// `settings.chatAgentPermissions` for chats, `teammate.board` for a
    /// teammate's managed run, read+comment for other runs.
    pub permissions: BoardPermissions,
    /// The chat the agent works in; cards it creates or links become the
    /// chat's active card.
    pub session: Option<SessionRef>,
    /// Rate-limit key of the current turn (see `BoardService::begin_turn`).
    pub turn_key: &'a str,
    /// Chain depth of the run the agent belongs to (0 for chats).
    pub causing_depth: u8,
    /// Every teammate of the project (enabled or not).
    pub teammates: &'a [TeammateRef],
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCardSummary {
    pub number: u64,
    pub title: String,
    pub status: CardStatus,
    pub priority: CardPriority,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    pub labels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCardDetail {
    #[serde(flatten)]
    pub summary: ToolCardSummary,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolComment {
    pub author: String,
    pub body: String,
    pub at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCardFull {
    #[serde(flatten)]
    pub summary: ToolCardSummary,
    pub description: String,
    pub recent_comments: Vec<ToolComment>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolRosterEntry {
    pub handle: String,
    pub name: String,
    pub role: String,
    pub kind: &'static str,
    pub availability: Availability,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WriteState {
    Applied,
    Proposed,
    PendingStart,
}

/// `BoardToolResultV1`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant)]
pub(crate) enum BoardToolResult {
    #[serde(rename_all = "camelCase")]
    Context {
        ok: bool,
        op: &'static str,
        mode: BoardAgentMode,
        permissions: BoardPermissions,
        #[serde(skip_serializing_if = "Option::is_none")]
        active_card: Option<ToolCardDetail>,
        similar: Vec<ToolCardSummary>,
    },
    #[serde(rename_all = "camelCase")]
    Cards {
        ok: bool,
        op: &'static str,
        cards: Vec<ToolCardSummary>,
    },
    #[serde(rename_all = "camelCase")]
    Card {
        ok: bool,
        op: &'static str,
        card: ToolCardFull,
    },
    #[serde(rename_all = "camelCase")]
    PossibleDuplicates {
        ok: bool,
        op: &'static str,
        candidates: Vec<ToolCardSummary>,
        hint: &'static str,
    },
    #[serde(rename_all = "camelCase")]
    Write {
        ok: bool,
        op: &'static str,
        card: ToolCardSummary,
        state: WriteState,
    },
    #[serde(rename_all = "camelCase")]
    Roster {
        ok: bool,
        op: &'static str,
        teammates: Vec<ToolRosterEntry>,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        ok: bool,
        code: &'static str,
        message: &'static str,
    },
}

impl BoardToolResult {
    pub(crate) fn error(error: BoardError) -> Self {
        Self::Error {
            ok: false,
            code: error.code(),
            message: error.message(),
        }
    }

    fn write(op: &'static str, card: ToolCardSummary, state: WriteState) -> Self {
        Self::Write {
            ok: true,
            op,
            card,
            state,
        }
    }
}

const FORBIDDEN: BoardError = BoardError::Forbidden(
    "This agent is not allowed to do that on this board. Do not retry; ask the person.",
);
const DUPLICATE_HINT: &str = "Similar open cards exist. Update or comment on one of them, or call create again with confirmNew: true only for a distinct deliverable.";

fn need(allowed: bool) -> Result<(), BoardError> {
    if allowed { Ok(()) } else { Err(FORBIDDEN) }
}

fn summary(card: &Card, teammates: &[TeammateRef]) -> ToolCardSummary {
    ToolCardSummary {
        number: card.number,
        title: card.title.clone(),
        status: card.status,
        priority: card.priority,
        assignee: card.assignee.as_deref().map(|id| {
            teammates
                .iter()
                .find(|teammate| teammate.id == id)
                .map_or_else(|| "unknown".to_owned(), |teammate| teammate.handle.clone())
        }),
        labels: card.labels.clone(),
    }
}

fn draft_summary(draft: &CardDraft, status: CardStatus) -> ToolCardSummary {
    ToolCardSummary {
        number: 0,
        title: draft.title.trim().to_owned(),
        status,
        priority: draft.priority.unwrap_or(CardPriority::Normal),
        assignee: None,
        labels: draft.labels.clone().unwrap_or_default(),
    }
}

fn author(actor: &BoardActor, teammates: &[TeammateRef]) -> String {
    match actor {
        BoardActor::Person => "person".to_owned(),
        BoardActor::ChatAgent { .. } => "chat agent".to_owned(),
        BoardActor::RunMember { teammate_id, .. } => teammate_id
            .as_deref()
            .and_then(|id| teammates.iter().find(|teammate| teammate.id == id))
            .map_or_else(
                || "run agent".to_owned(),
                |teammate| format!("@{}", teammate.handle),
            ),
        BoardActor::Host => "PiUI".to_owned(),
    }
}

fn card_id_of(board: &Board, number: u64) -> Result<String, BoardError> {
    board
        .card_by_number(number)
        .map(|card| card.id.clone())
        .ok_or(BoardError::NotFound(
            "No card has that number. Call list or search first.",
        ))
}

fn teammate_by_handle<'a>(
    teammates: &'a [TeammateRef],
    handle: &str,
) -> Result<&'a TeammateRef, BoardError> {
    let handle = handle.trim().trim_start_matches('@').to_lowercase();
    let teammate = teammates
        .iter()
        .find(|teammate| teammate.handle == handle)
        .ok_or(BoardError::NotFound(
            "No teammate has that handle. Call roster first.",
        ))?;
    if teammate.assignable() {
        Ok(teammate)
    } else {
        Err(BoardError::NotAssignable(TEAMMATE_NOT_ASSIGNABLE))
    }
}

fn run_id_of(actor: &BoardActor) -> Option<String> {
    match actor {
        BoardActor::RunMember { run_id, .. } => Some(run_id.clone()),
        _ => None,
    }
}

impl BoardService {
    /// Runs one `board` tool call for an agent. Never panics on input;
    /// every refusal is a `{ ok: false, code, message }` answer.
    pub(crate) fn apply_agent_operation(
        &self,
        context: &AgentContext<'_>,
        operation: BoardToolOperation,
    ) -> BoardToolResult {
        self.agent_operation(context, operation)
            .unwrap_or_else(BoardToolResult::error)
    }

    fn agent_operation(
        &self,
        context: &AgentContext<'_>,
        operation: BoardToolOperation,
    ) -> Result<BoardToolResult, BoardError> {
        if !context.actor.is_agent() {
            return Err(FORBIDDEN);
        }
        let board = self.get(context.workspace_id)?;
        require_enabled(&board)?;
        let permissions = context.permissions;
        let teammates = context.teammates;
        let proposal_mode = board.settings.agent_mode == BoardAgentMode::Proposal;
        match operation {
            BoardToolOperation::Context { query } => {
                need(permissions.read)?;
                let active = context.session.as_ref().and_then(|session| {
                    session_cards_of(&board, &session.session_id)
                        .into_iter()
                        .find(|card| !card.status.is_closed())
                });
                let similar: Vec<ToolCardSummary> = query
                    .as_deref()
                    .filter(|query| !query.trim().is_empty())
                    .map(|query| {
                        similarity::similar_open_cards(
                            &board.cards,
                            query,
                            &[],
                            DUPLICATE_THRESHOLD,
                            MAX_SIMILAR + 1,
                        )
                        .into_iter()
                        .filter(|card| active.is_none_or(|active| active.id != card.id))
                        .take(MAX_SIMILAR)
                        .map(|card| summary(card, teammates))
                        .collect()
                    })
                    .unwrap_or_default();
                Ok(BoardToolResult::Context {
                    ok: true,
                    op: "context",
                    mode: board.settings.agent_mode,
                    permissions,
                    active_card: active.map(|card| ToolCardDetail {
                        summary: summary(card, teammates),
                        description: card.description.clone(),
                    }),
                    similar,
                })
            }
            BoardToolOperation::Search {
                query,
                include_closed,
            } => {
                need(permissions.read)?;
                let cards = similarity::search(
                    &board.cards,
                    &query,
                    include_closed.unwrap_or(false),
                    MAX_TOOL_CARDS,
                )
                .into_iter()
                .map(|card| summary(card, teammates))
                .collect();
                Ok(BoardToolResult::Cards {
                    ok: true,
                    op: "search",
                    cards,
                })
            }
            BoardToolOperation::List { status } => {
                need(permissions.read)?;
                let mut cards: Vec<&Card> = board
                    .cards
                    .iter()
                    .filter(|card| match status {
                        Some(status) => card.status == status,
                        None => !card.status.is_closed(),
                    })
                    .collect();
                cards.sort_by_key(|card| (card.status, card.order, card.number));
                Ok(BoardToolResult::Cards {
                    ok: true,
                    op: "list",
                    cards: cards
                        .into_iter()
                        .take(MAX_TOOL_CARDS)
                        .map(|card| summary(card, teammates))
                        .collect(),
                })
            }
            BoardToolOperation::Get { card } => {
                need(permissions.read)?;
                let card = board
                    .card_by_number(card)
                    .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
                let start = card.comments.len().saturating_sub(RECENT_COMMENTS);
                Ok(BoardToolResult::Card {
                    ok: true,
                    op: "get",
                    card: ToolCardFull {
                        summary: summary(card, teammates),
                        description: card.description.clone(),
                        recent_comments: card.comments[start..]
                            .iter()
                            .map(|comment| ToolComment {
                                author: author(&comment.actor, teammates),
                                body: comment.body.clone(),
                                at: comment.created_at.clone(),
                            })
                            .collect(),
                    },
                })
            }
            BoardToolOperation::Roster {} => {
                need(permissions.read)?;
                Ok(BoardToolResult::Roster {
                    ok: true,
                    op: "roster",
                    teammates: teammates
                        .iter()
                        .filter(|teammate| teammate.assignable())
                        .map(|teammate| ToolRosterEntry {
                            handle: teammate.handle.clone(),
                            name: teammate.name.clone(),
                            role: teammate.role.clone(),
                            kind: teammate.kind,
                            availability: teammate.availability,
                        })
                        .collect(),
                })
            }
            BoardToolOperation::Create {
                title,
                description,
                priority,
                labels,
                status,
                confirm_new,
            } => {
                need(permissions.create)?;
                self.check_turn_budget(context.turn_key)?;
                let title = validate_title(&title)?;
                let labels_list = labels.clone().unwrap_or_default();
                if confirm_new != Some(true) {
                    let candidates: Vec<ToolCardSummary> = similarity::similar_open_cards(
                        &board.cards,
                        &title,
                        &labels_list,
                        DUPLICATE_THRESHOLD,
                        MAX_SIMILAR,
                    )
                    .into_iter()
                    .map(|card| summary(card, teammates))
                    .collect();
                    if !candidates.is_empty() {
                        return Ok(BoardToolResult::PossibleDuplicates {
                            ok: true,
                            op: "possibleDuplicates",
                            candidates,
                            hint: DUPLICATE_HINT,
                        });
                    }
                }
                let status = status.map_or(CardStatus::Todo, CardStatus::from);
                let draft = CardDraft {
                    title,
                    description,
                    priority,
                    labels,
                    blocked_by: None,
                    parent_id: None,
                };
                let result = self.agent_create(context, draft, status, proposal_mode)?;
                self.note_turn_write(context.turn_key);
                Ok(result)
            }
            BoardToolOperation::Update {
                card,
                title,
                description,
                priority,
                labels,
            } => {
                need(permissions.create)?;
                self.check_turn_budget(context.turn_key)?;
                let card_id = card_id_of(&board, card)?;
                let patch = CardPatch {
                    title,
                    description,
                    priority,
                    labels,
                    blocked_by: None,
                    parent_id: None,
                };
                if patch.is_empty() {
                    return Err(BoardError::Invalid("Nothing to update."));
                }
                let state = if proposal_mode {
                    self.transact(context.workspace_id, |board, now| {
                        propose_in(
                            board,
                            &context.actor,
                            Some(card_id.clone()),
                            BoardOperation::Update {
                                card_id: card_id.clone(),
                                patch,
                            },
                            now,
                        )
                    })?;
                    WriteState::Proposed
                } else {
                    self.transact(context.workspace_id, |board, now| {
                        apply_patch_in(board, &card_id, &patch, &context.actor, now, true)
                    })?;
                    WriteState::Applied
                };
                self.note_turn_write(context.turn_key);
                self.agent_write("update", context, &card_id, state)
            }
            BoardToolOperation::Move { card, to, reason } => {
                need(permissions.move_cards)?;
                self.check_turn_budget(context.turn_key)?;
                let card_id = card_id_of(&board, card)?;
                // Closing is always the person's decision.
                let state = if proposal_mode || to.is_closed() {
                    self.transact(context.workspace_id, |board, now| {
                        propose_in(
                            board,
                            &context.actor,
                            Some(card_id.clone()),
                            BoardOperation::Move {
                                card_id: card_id.clone(),
                                to,
                                reason,
                            },
                            now,
                        )
                    })?;
                    WriteState::Proposed
                } else {
                    self.transact(context.workspace_id, |board, now| {
                        set_status_in(board, &card_id, to, reason, &context.actor, now, true)
                            .map(|_| ())
                    })?;
                    WriteState::Applied
                };
                self.note_turn_write(context.turn_key);
                self.agent_write("move", context, &card_id, state)
            }
            BoardToolOperation::Comment { card, body } => {
                need(permissions.comment)?;
                self.check_turn_budget(context.turn_key)?;
                let card_id = card_id_of(&board, card)?;
                let state = if proposal_mode {
                    self.transact(context.workspace_id, |board, now| {
                        propose_in(
                            board,
                            &context.actor,
                            Some(card_id.clone()),
                            BoardOperation::Comment {
                                card_id: card_id.clone(),
                                body,
                            },
                            now,
                        )
                    })?;
                    WriteState::Proposed
                } else {
                    self.transact(context.workspace_id, |board, now| {
                        comment_in(
                            board,
                            &card_id,
                            &context.actor,
                            body,
                            Vec::new(),
                            run_id_of(&context.actor),
                            now,
                        )
                    })?;
                    WriteState::Applied
                };
                self.note_turn_write(context.turn_key);
                self.agent_write("comment", context, &card_id, state)
            }
            BoardToolOperation::Claim { card } => {
                need(permissions.claim)?;
                self.check_turn_budget(context.turn_key)?;
                let card_id = card_id_of(&board, card)?;
                self.transact(context.workspace_id, |board, now| {
                    claim_in(board, &card_id, &context.actor, now, !proposal_mode)
                })?;
                self.note_turn_write(context.turn_key);
                self.agent_write("claim", context, &card_id, WriteState::Applied)
            }
            BoardToolOperation::Release { card } => {
                need(permissions.claim)?;
                self.check_turn_budget(context.turn_key)?;
                let card_id = card_id_of(&board, card)?;
                self.transact(context.workspace_id, |board, now| {
                    release_in(
                        board,
                        &card_id,
                        &context.actor,
                        ReleaseReason::Released,
                        now,
                    )
                })?;
                self.note_turn_write(context.turn_key);
                self.agent_write("release", context, &card_id, WriteState::Applied)
            }
            BoardToolOperation::Link { card } => {
                need(permissions.read)?;
                let session = context.session.as_ref().ok_or(BoardError::Invalid(
                    "Only an agent in a chat can link a card to it.",
                ))?;
                self.check_turn_budget(context.turn_key)?;
                let card_id = card_id_of(&board, card)?;
                self.transact(context.workspace_id, |board, now| {
                    let card = board
                        .card_mut(&card_id)
                        .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
                    link_session_in(card, session, &context.actor, now);
                    Ok(())
                })?;
                self.note_turn_write(context.turn_key);
                self.agent_write("link", context, &card_id, WriteState::Applied)
            }
            BoardToolOperation::Assign { card, handle } => {
                need(permissions.assign)?;
                self.check_turn_budget(context.turn_key)?;
                let card_id = card_id_of(&board, card)?;
                let teammate = teammate_by_handle(teammates, &handle)?;
                let state = if proposal_mode {
                    self.transact(context.workspace_id, |board, now| {
                        propose_in(
                            board,
                            &context.actor,
                            Some(card_id.clone()),
                            BoardOperation::Assign {
                                card_id: card_id.clone(),
                                teammate_id: Some(teammate.id.clone()),
                            },
                            now,
                        )
                    })?;
                    WriteState::Proposed
                } else {
                    self.agent_assign(context, &card_id, teammate)?
                };
                self.note_turn_write(context.turn_key);
                self.agent_write("assign", context, &card_id, state)
            }
            BoardToolOperation::Handoff {
                handle,
                title,
                description,
                priority,
            } => {
                need(permissions.assign && permissions.create)?;
                self.check_turn_budget(context.turn_key)?;
                let teammate = teammate_by_handle(teammates, &handle)?;
                let title = validate_title(&title)?;
                let draft = CardDraft {
                    title,
                    description,
                    priority,
                    labels: None,
                    blocked_by: None,
                    parent_id: None,
                };
                if proposal_mode {
                    // A proposal carries one operation: the person accepts
                    // the card and assigns it themselves.
                    let result = self.agent_create(context, draft, CardStatus::Todo, true)?;
                    self.note_turn_write(context.turn_key);
                    return Ok(match result {
                        BoardToolResult::Write { card, state, .. } => {
                            BoardToolResult::write("handoff", card, state)
                        }
                        other => other,
                    });
                }
                let (card_id, _) = self.transact(context.workspace_id, |board, now| {
                    create_in(
                        board,
                        &context.actor,
                        draft,
                        Some(CardStatus::Todo),
                        context.session.as_ref(),
                        now,
                    )
                })?;
                let state = self.agent_assign(context, &card_id, teammate)?;
                self.note_turn_write(context.turn_key);
                self.agent_write("handoff", context, &card_id, state)
            }
        }
    }

    fn agent_create(
        &self,
        context: &AgentContext<'_>,
        draft: CardDraft,
        status: CardStatus,
        proposal_mode: bool,
    ) -> Result<BoardToolResult, BoardError> {
        if proposal_mode {
            let card = draft_summary(&draft, status);
            self.transact(context.workspace_id, |board, now| {
                propose_in(
                    board,
                    &context.actor,
                    None,
                    BoardOperation::Create {
                        card: draft,
                        status: Some(status),
                    },
                    now,
                )
            })?;
            return Ok(BoardToolResult::write("create", card, WriteState::Proposed));
        }
        let (card_id, _) = self.transact(context.workspace_id, |board, now| {
            create_in(
                board,
                &context.actor,
                draft,
                Some(status),
                context.session.as_ref(),
                now,
            )
        })?;
        self.agent_write("create", context, &card_id, WriteState::Applied)
    }

    /// Assigns in auto mode and applies the teammate's start rule.
    fn agent_assign(
        &self,
        context: &AgentContext<'_>,
        card_id: &str,
        teammate: &TeammateRef,
    ) -> Result<WriteState, BoardError> {
        let starter_available = self.starter_available();
        let depth = cause_depth(&context.actor, context.causing_depth);
        let ((plan, pending), _) = self.transact(context.workspace_id, |board, now| {
            let changed = assign_in(board, card_id, Some(teammate), &context.actor, now, true)?;
            if !changed {
                return Ok((None::<StartPlan>, false));
            }
            let before = board.pending_starts.len();
            let plan = BoardService::plan_assign_wake(
                board,
                card_id,
                teammate,
                &context.actor,
                depth,
                starter_available,
                now,
            );
            let pending = board.pending_starts.len() > before;
            Ok((plan, pending))
        })?;
        if let Some(plan) = plan {
            self.execute_plans(context.workspace_id, vec![plan], context.teammates);
        }
        Ok(if pending {
            WriteState::PendingStart
        } else {
            WriteState::Applied
        })
    }

    fn agent_write(
        &self,
        op: &'static str,
        context: &AgentContext<'_>,
        card_id: &str,
        state: WriteState,
    ) -> Result<BoardToolResult, BoardError> {
        let board = self.get(context.workspace_id)?;
        let card = board
            .card(card_id)
            .ok_or(BoardError::NotFound(CARD_NOT_FOUND))?;
        Ok(BoardToolResult::write(
            op,
            summary(card, context.teammates),
            state,
        ))
    }
}
