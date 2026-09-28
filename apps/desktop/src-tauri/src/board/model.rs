//! Serde model of the project board protocol v1 (`contracts/board-v1.ts`).
//! Field names are camelCase; persisted and IPC data reject unknown fields.

use piui_orchestration::{BoardPermissions, BoardRunCause};
use serde::{Deserialize, Deserializer, Serialize};

pub(crate) const BOARD_PROTOCOL: u8 = 1;
pub(crate) const BOARD_CHANGED_EVENT_V1: &str = "piui://board-changed-v1";

pub(crate) const MAX_CARDS: usize = 2000;
pub(crate) const MAX_COMMENTS_PER_CARD: usize = 500;
pub(crate) const MAX_CARD_TITLE_CHARS: usize = 200;
pub(crate) const MAX_CARD_DESCRIPTION_BYTES: usize = 64 * 1024;
pub(crate) const MAX_COMMENT_BYTES: usize = 16 * 1024;
pub(crate) const MAX_LABELS_PER_CARD: usize = 12;
pub(crate) const MAX_ACTIVITY_PER_CARD: usize = 300;
pub(crate) const MAX_AGENT_WRITES_PER_TURN: u32 = 8;
pub(crate) const CLAIM_LEASE_SECONDS: i64 = 30 * 60;
/// Longest label, in characters (host bound; the contract only caps the count).
pub(crate) const MAX_LABEL_CHARS: usize = 40;
/// Most resolved proposals kept; pending ones are never dropped.
pub(crate) const MAX_RESOLVED_PROPOSALS: usize = 200;
/// Most pending proposals and pending starts kept per board.
pub(crate) const MAX_PENDING: usize = 500;
pub(crate) const MIN_BOARD_CONCURRENCY: u8 = 1;
pub(crate) const MAX_BOARD_CONCURRENCY: u8 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CardStatus {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Blocked,
    Done,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardStatusCategory {
    Unstarted,
    Active,
    Blocked,
    Closed,
}

impl CardStatus {
    pub fn category(self) -> CardStatusCategory {
        match self {
            Self::Backlog | Self::Todo => CardStatusCategory::Unstarted,
            Self::InProgress | Self::InReview => CardStatusCategory::Active,
            Self::Blocked => CardStatusCategory::Blocked,
            Self::Done | Self::Cancelled => CardStatusCategory::Closed,
        }
    }

    pub fn is_closed(self) -> bool {
        self.category() == CardStatusCategory::Closed
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Todo => "todo",
            Self::InProgress => "inProgress",
            Self::InReview => "inReview",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CardPriority {
    Urgent,
    High,
    Normal,
    Low,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoardAgentMode {
    Auto,
    Proposal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardSettings {
    pub agent_mode: BoardAgentMode,
    pub chat_agent_permissions: BoardPermissions,
    pub max_concurrent_runs: u8,
}

impl Default for BoardSettings {
    fn default() -> Self {
        Self {
            agent_mode: BoardAgentMode::Auto,
            chat_agent_permissions: BoardPermissions {
                read: true,
                comment: true,
                create: true,
                move_cards: true,
                claim: false,
                assign: true,
            },
            max_concurrent_runs: 4,
        }
    }
}

impl BoardSettings {
    pub fn valid(&self) -> bool {
        (MIN_BOARD_CONCURRENCY..=MAX_BOARD_CONCURRENCY).contains(&self.max_concurrent_runs)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BoardActor {
    Person,
    ChatAgent {
        session_id: String,
        harness: String,
    },
    RunMember {
        run_id: String,
        member_id: String,
        profile_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        teammate_id: Option<String>,
    },
    Host,
}

impl BoardActor {
    pub fn is_person(&self) -> bool {
        matches!(self, Self::Person)
    }

    pub fn is_agent(&self) -> bool {
        matches!(self, Self::ChatAgent { .. } | Self::RunMember { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardClaim {
    pub actor: BoardActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub claimed_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CardLink {
    Session {
        session_id: String,
        harness: String,
        since: String,
    },
    Run {
        run_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        teammate_id: Option<String>,
        since: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentMention {
    pub teammate_id: String,
    /// UTF-16 offset/length of the `@handle` text in `body`.
    pub start: u32,
    pub length: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardComment {
    pub id: String,
    pub actor: BoardActor,
    pub body: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<CommentMention>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// `Partial<CardEditableFieldsV1>`: an absent field is unchanged. `parentId`
/// distinguishes absent (`None`) from `null` (`Some(None)`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<CardPriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_id: Option<Option<String>>,
}

impl CardPatch {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.description.is_none()
            && self.priority.is_none()
            && self.labels.is_none()
            && self.blocked_by.is_none()
            && self.parent_id.is_none()
    }
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `Partial<CardEditableFieldsV1> & { title: string }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardDraft {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<CardPriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseReason {
    Done,
    Expired,
    Released,
    RunEnded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[allow(clippy::large_enum_variant)]
pub enum CardChange {
    Created,
    Edited {
        fields: Vec<String>,
        previous: CardPatch,
    },
    Moved {
        from: CardStatus,
        to: CardStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Assigned {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
    },
    Claimed,
    Released {
        reason: ReleaseReason,
    },
    Linked {
        link: CardLink,
    },
    Unlinked {
        link: CardLink,
    },
    Commented {
        comment_id: String,
    },
    RunStarted {
        run_id: String,
        teammate_id: String,
    },
    /// A start for `teammate_id` waits for a free concurrency slot.
    Queued {
        teammate_id: String,
    },
    RunFinished {
        run_id: String,
        outcome: RunOutcome,
    },
    Unblocked,
    Reverted {
        activity_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardActivity {
    pub id: String,
    pub actor: BoardActor,
    pub at: String,
    pub change: CardChange,
    /// Serialized as `true` when set, omitted otherwise (`undoable?: true`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub undoable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Card {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub description: String,
    pub priority: CardPriority,
    pub labels: Vec<String>,
    pub blocked_by: Vec<String>,
    /// Serialized as `null` when absent (`parentId: string | null`).
    pub parent_id: Option<String>,
    pub status: CardStatus,
    /// Sort key inside a column (ascending).
    pub order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<CardClaim>,
    pub links: Vec<CardLink>,
    pub comments: Vec<CardComment>,
    pub activity: Vec<CardActivity>,
    pub revision: u64,
    pub created_by: BoardActor,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BoardOperation {
    Create {
        card: CardDraft,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<CardStatus>,
    },
    Update {
        card_id: String,
        patch: CardPatch,
    },
    Move {
        card_id: String,
        to: CardStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Comment {
        card_id: String,
        body: String,
    },
    Assign {
        card_id: String,
        teammate_id: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardProposal {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    pub operation: BoardOperation,
    pub actor: BoardActor,
    pub created_at: String,
    pub status: ProposalStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingStart {
    pub id: String,
    pub card_id: String,
    pub teammate_id: String,
    pub cause: BoardRunCause,
    pub requested_by: BoardActor,
    pub created_at: String,
}

/// A run start waiting for a free concurrency slot (`QueuedStartV1`).
/// Stored in arrival order; starts in card priority order, then age.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedStartRecord {
    pub id: String,
    pub card_id: String,
    pub teammate_id: String,
    pub cause: BoardRunCause,
    pub chain_depth: u8,
    pub requested_by: BoardActor,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Board {
    pub workspace_id: String,
    pub enabled: bool,
    pub settings: BoardSettings,
    pub cards: Vec<Card>,
    pub proposals: Vec<BoardProposal>,
    pub pending_starts: Vec<PendingStart>,
    /// Starts waiting for a free slot; survives a host restart.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queued_starts: Vec<QueuedStartRecord>,
    pub next_number: u64,
    pub revision: u64,
    pub updated_at: String,
}

impl Board {
    /// A board that was never saved: disabled, default settings, no cards.
    pub fn empty(workspace_id: &str, now: &str) -> Self {
        Self {
            workspace_id: workspace_id.to_owned(),
            enabled: false,
            settings: BoardSettings::default(),
            cards: Vec::new(),
            proposals: Vec::new(),
            pending_starts: Vec::new(),
            queued_starts: Vec::new(),
            next_number: 1,
            revision: 0,
            updated_at: now.to_owned(),
        }
    }

    pub fn card(&self, card_id: &str) -> Option<&Card> {
        self.cards.iter().find(|card| card.id == card_id)
    }

    pub fn card_mut(&mut self, card_id: &str) -> Option<&mut Card> {
        self.cards.iter_mut().find(|card| card.id == card_id)
    }

    pub fn card_by_number(&self, number: u64) -> Option<&Card> {
        self.cards.iter().find(|card| card.number == number)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CardStartMode {
    Ask,
    Now,
    Later,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[allow(clippy::large_enum_variant)]
pub enum BoardCommandV1 {
    Get {
        workspace_id: String,
    },
    SetEnabled {
        workspace_id: String,
        enabled: bool,
    },
    UpdateSettings {
        workspace_id: String,
        expected_revision: u64,
        settings: BoardSettings,
    },
    CreateCard {
        workspace_id: String,
        card: CardDraft,
        #[serde(default)]
        status: Option<CardStatus>,
        #[serde(default)]
        session_id: Option<String>,
    },
    UpdateCard {
        workspace_id: String,
        card_id: String,
        expected_revision: u64,
        patch: CardPatch,
    },
    MoveCard {
        workspace_id: String,
        card_id: String,
        to: CardStatus,
        #[serde(default)]
        order: Option<i64>,
    },
    DeleteCard {
        workspace_id: String,
        card_id: String,
        expected_revision: u64,
    },
    Comment {
        workspace_id: String,
        card_id: String,
        body: String,
        #[serde(default)]
        mentions: Option<Vec<CommentMention>>,
    },
    Assign {
        workspace_id: String,
        card_id: String,
        teammate_id: Option<String>,
        start: CardStartMode,
    },
    StartRun {
        workspace_id: String,
        card_id: String,
    },
    ResolvePendingStart {
        workspace_id: String,
        pending_start_id: String,
        accept: bool,
    },
    ReleaseClaim {
        workspace_id: String,
        card_id: String,
    },
    LinkSession {
        workspace_id: String,
        card_id: String,
        session_id: String,
    },
    UnlinkSession {
        workspace_id: String,
        card_id: String,
        session_id: String,
    },
    SessionCards {
        workspace_id: String,
        session_id: String,
    },
    Undo {
        workspace_id: String,
        card_id: String,
        activity_id: String,
    },
    ResolveProposal {
        workspace_id: String,
        proposal_id: String,
        accept: bool,
    },
}

impl BoardCommandV1 {
    pub fn workspace_id(&self) -> &str {
        match self {
            Self::Get { workspace_id }
            | Self::SetEnabled { workspace_id, .. }
            | Self::UpdateSettings { workspace_id, .. }
            | Self::CreateCard { workspace_id, .. }
            | Self::UpdateCard { workspace_id, .. }
            | Self::MoveCard { workspace_id, .. }
            | Self::DeleteCard { workspace_id, .. }
            | Self::Comment { workspace_id, .. }
            | Self::Assign { workspace_id, .. }
            | Self::StartRun { workspace_id, .. }
            | Self::ResolvePendingStart { workspace_id, .. }
            | Self::ReleaseClaim { workspace_id, .. }
            | Self::LinkSession { workspace_id, .. }
            | Self::UnlinkSession { workspace_id, .. }
            | Self::SessionCards { workspace_id, .. }
            | Self::Undo { workspace_id, .. }
            | Self::ResolveProposal { workspace_id, .. } => workspace_id,
        }
    }

    /// Commands that work in safe mode and never write.
    pub fn read_only(&self) -> bool {
        matches!(self, Self::Get { .. } | Self::SessionCards { .. })
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[allow(clippy::large_enum_variant)]
pub enum BoardResultV1 {
    Board {
        protocol: u8,
        board: Board,
    },
    Card {
        protocol: u8,
        card: Card,
        board_revision: u64,
    },
    SessionCards {
        protocol: u8,
        cards: Vec<Card>,
    },
    Deleted {
        protocol: u8,
        card_id: String,
        board_revision: u64,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoardChangedEventV1 {
    pub protocol: u8,
    pub workspace_id: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_ids: Option<Vec<String>>,
}

/// Board refusals, mapped to `BoardErrorCodeV1`. Messages are one line and
/// never contain card text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoardError {
    SafeMode,
    Invalid(&'static str),
    NotFound(&'static str),
    Disabled,
    RevisionConflict,
    AlreadyClaimed,
    Forbidden(&'static str),
    Limit(&'static str),
    RateLimited,
    NotAssignable(&'static str),
    Io,
}

impl BoardError {
    pub fn code(self) -> &'static str {
        match self {
            Self::SafeMode => "SAFE_MODE",
            Self::Invalid(_) => "INVALID_ARGUMENT",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Disabled => "DISABLED",
            Self::RevisionConflict => "REVISION_CONFLICT",
            Self::AlreadyClaimed => "ALREADY_CLAIMED",
            Self::Forbidden(_) => "FORBIDDEN",
            Self::Limit(_) => "LIMIT",
            Self::RateLimited => "RATE_LIMITED",
            Self::NotAssignable(_) => "NOT_ASSIGNABLE",
            Self::Io => "IO_ERROR",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::SafeMode => "Safe mode is on: PiUI does not change the board.",
            Self::Invalid(message)
            | Self::NotFound(message)
            | Self::Forbidden(message)
            | Self::Limit(message)
            | Self::NotAssignable(message) => message,
            Self::Disabled => "The board of this project is turned off.",
            Self::RevisionConflict => {
                "This card changed since you opened it. Reload and try again."
            }
            Self::AlreadyClaimed => {
                "Someone else is already working on this card. Do not retry; pick other work."
            }
            Self::RateLimited => {
                "Too many board changes in this turn. Stop changing the board and summarize instead."
            }
            Self::Io => "PiUI could not save the board.",
        }
    }
}

impl From<BoardError> for crate::workspace_api::WorkspaceError {
    fn from(error: BoardError) -> Self {
        crate::workspace_api::WorkspaceError {
            code: error.code(),
            message: error.message(),
            recoverable: !matches!(error, BoardError::Io),
        }
    }
}
