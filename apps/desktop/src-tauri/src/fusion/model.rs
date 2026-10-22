//! Fusion v1 data types (`contracts/fusion-v1.ts`).

use piui_runtime::workspace_runtime::{HarnessKind, PermissionMode, WorkspaceModel};
use serde::{Deserialize, Serialize};

pub(crate) const FUSION_PROTOCOL: u8 = 1;
pub(crate) const FUSION_CHANGED_EVENT_V1: &str = "piui://fusion-changed-v1";
pub(crate) const REPORT_BODY_BYTES: usize = 8 * 1024;
pub(crate) const DEFAULT_WAIT_SECONDS: u64 = 240;
pub(crate) const MAX_WAIT_SECONDS: u64 = 540;
pub(crate) const MAX_LIVE_BRIEFS: usize = 200;
pub(crate) const CORRECTION_HINT_ROUNDS: usize = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FusionRoleName {
    Lead,
    Sidekick,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FusionRole {
    pub harness: HarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<WorkspaceModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    pub permission_mode: PermissionMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BriefPolicy {
    Prescriptive,
    Outline,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FusionOptions {
    pub brief_policy: BriefPolicy,
    pub pushback: bool,
    pub auto_deliver: bool,
    pub lead_native_subagents: bool,
}

impl Default for FusionOptions {
    fn default() -> Self {
        Self {
            brief_policy: BriefPolicy::Prescriptive,
            pushback: false,
            auto_deliver: true,
            lead_native_subagents: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FusionPair {
    pub lead: FusionRole,
    pub sidekick: FusionRole,
    pub options: FusionOptions,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FusionRefusal {
    LeadHarnessUnsupported,
    SidekickHarnessUnsupported,
    ExplicitModesRequired,
    SidekickExceedsLead,
    SidekickNeedsFullAccess,
    CodexSandboxUnverified,
    ReadOnlyLead,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BriefFields {
    pub title: String,
    pub goal: String,
    pub done_when: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scope: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub leave_alone: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verify: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop_if: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BriefOutcome {
    Accepted,
    Rejected,
    Superseded,
}

/// `SidekickToolOperationV1`, parsed again by the host.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SidekickOperation {
    Brief {
        title: String,
        goal: String,
        done_when: Vec<String>,
        #[serde(default)]
        context: Option<String>,
        #[serde(default)]
        scope: Vec<String>,
        #[serde(default)]
        leave_alone: Vec<String>,
        #[serde(default)]
        constraints: Vec<String>,
        #[serde(default)]
        verify: Vec<String>,
        #[serde(default)]
        stop_if: Vec<String>,
        #[serde(default)]
        wait: Option<bool>,
        #[serde(default)]
        wait_seconds: Option<u64>,
    },
    Wait {
        #[serde(default)]
        round_id: Option<String>,
        #[serde(default)]
        wait_seconds: Option<u64>,
    },
    Status {},
    Message {
        brief_id: String,
        text: String,
        #[serde(default)]
        wait: Option<bool>,
        #[serde(default)]
        wait_seconds: Option<u64>,
    },
    Steer {
        round_id: String,
        text: String,
    },
    Stop {
        round_id: String,
        #[serde(default)]
        take_over: Option<bool>,
    },
    Diff {
        #[serde(default)]
        paths: Vec<String>,
        #[serde(default)]
        page: Option<u32>,
        #[serde(default)]
        fingerprint: Option<String>,
    },
    Report {
        round_id: String,
        #[serde(default)]
        page: Option<u32>,
    },
    Close {
        brief_id: String,
        outcome: BriefOutcome,
        #[serde(default)]
        note: Option<String>,
    },
    Reset {
        #[serde(default)]
        reason: Option<String>,
    },
}

impl SidekickOperation {
    pub(crate) const fn name(&self) -> &'static str {
        match self {
            Self::Brief { .. } => "brief",
            Self::Wait { .. } => "wait",
            Self::Status {} => "status",
            Self::Message { .. } => "message",
            Self::Steer { .. } => "steer",
            Self::Stop { .. } => "stop",
            Self::Diff { .. } => "diff",
            Self::Report { .. } => "report",
            Self::Close { .. } => "close",
            Self::Reset { .. } => "reset",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SidekickErrorCode {
    InvalidBrief,
    BriefActive,
    RoundActive,
    UnknownBrief,
    UnknownRound,
    RoundFinished,
    SteerUnsupported,
    SidekickUnavailable,
    SidekickSignInRequired,
    AuthorityDenied,
    PairStopping,
    DiffUnavailable,
    DiffStale,
    IdentityConflict,
    Uncertain,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReportStatus {
    Done,
    Partial,
    Blocked,
    NeedsDecision,
    Unknown,
}

impl ReportStatus {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Partial => "partial",
            Self::Blocked => "blocked",
            Self::NeedsDecision => "needs-decision",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RoundOutcome {
    Completed,
    Interrupted,
    Failed,
    NoAnswer,
    Uncertain,
}

impl RoundOutcome {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
            Self::NoAnswer => "no-answer",
            Self::Uncertain => "uncertain",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RoundState {
    Queued,
    Running,
    WaitingApproval,
    Stopping,
    Finished,
    Uncertain,
}

impl RoundState {
    pub(crate) const fn open(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Running | Self::WaitingApproval | Self::Stopping
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FactSource {
    Native,
    Git,
    Host,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FactChange {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FactFile {
    pub path: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub change: FactChange,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FactFiles {
    pub source: FactSource,
    pub items: Vec<FactFile>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FactCommand {
    pub command: String,
    pub exit_code: Option<i64>,
    pub ok: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FactCommands {
    pub source: FactSource,
    pub items: Vec<FactCommand>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FactApprovals {
    pub source: FactSource,
    pub requested: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FactTokens {
    pub source: FactSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidekickFacts {
    pub outcome: RoundOutcome,
    pub duration_ms: u64,
    pub files: FactFiles,
    pub commands: FactCommands,
    pub approvals: FactApprovals,
    pub tokens: FactTokens,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidekickReport {
    pub brief_id: String,
    pub round_id: String,
    pub status: ReportStatus,
    pub open: String,
    pub deviations: String,
    pub body: String,
    pub truncated: bool,
    pub facts: SidekickFacts,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidekickProgress {
    pub brief_id: String,
    pub round_id: String,
    pub state: RoundState,
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BriefState {
    Active,
    Reported,
    Closed,
    Stopped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeliveryVia {
    Tool,
    FollowUp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeliveryState {
    Queued,
    Sending,
    Sent,
    Uncertain,
    Withdrawn,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusionDelivery {
    pub via: DeliveryVia,
    pub state: DeliveryState,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RoundKind {
    Brief,
    Message,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusionRound {
    pub round_id: String,
    pub kind: RoundKind,
    pub state: RoundState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RoundOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ReportStatus>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_hash: Option<String>,
    pub preview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<FusionDelivery>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub take_over: bool,
    /// Host-private: the sidekick's last assistant block before this round
    /// (an answer equal to it is "no answer"). Never sent to the WebView; the
    /// journal keeps it in [`FusionDocument::round_hosts`].
    #[serde(default, skip_serializing)]
    pub baseline_block_id: Option<String>,
    /// Host-private: the baseline was read before the turn was sent. A
    /// round without it (an older journal) cannot be reconciled.
    #[serde(skip)]
    pub baseline_known: bool,
    #[serde(default, skip_serializing)]
    pub started_ms: u64,
    /// Host-private: the report the lead receives (kept while this process
    /// lives; after a restart the native history stays authoritative).
    #[serde(skip)]
    pub report: Option<SidekickReport>,
    #[serde(skip)]
    pub full_body: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusionBrief {
    pub brief_id: String,
    pub title: String,
    pub goal: String,
    pub done_when: Vec<String>,
    pub state: BriefState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<BriefOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub sidekick_session_id: String,
    pub rounds: Vec<FusionRound>,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SidekickState {
    None,
    Idle,
    Working,
    WaitingApproval,
    Stopping,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusionSidekickSession {
    pub session_id: String,
    pub harness: HarnessKind,
    pub retired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_reason: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusionStats {
    pub briefs: u64,
    pub accepted: u64,
    pub rejected: u64,
    pub taken_over: u64,
    pub rounds: u64,
}

/// One handled tool call: a retry with the same key and hash gets the same
/// answer, the same key with another hash is refused (tombstones survive the
/// folding of old briefs). The answer itself lives only in memory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallRecord {
    pub key: String,
    pub op_hash: String,
}

/// The persisted document of one Fusion chat (`fusion-v1/<lead>.json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusionDocument {
    pub protocol: u8,
    pub lead_session_id: String,
    pub workspace_id: String,
    pub pair: FusionPair,
    pub sessions: Vec<FusionSidekickSession>,
    pub briefs: Vec<FusionBrief>,
    pub stats: FusionStats,
    pub revision: u64,
    #[serde(default)]
    pub next_brief: u64,
    #[serde(default)]
    pub next_round: u64,
    #[serde(default)]
    pub calls: Vec<CallRecord>,
    #[serde(default)]
    pub folded_briefs: u64,
    /// Journal only: the host-private facts of each round. Filled when a
    /// generation is written ([`Self::for_journal`]) and moved back into the
    /// rounds when it is read ([`Self::restore_round_hosts`]); empty in memory.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub round_hosts: Vec<RoundHostRecord>,
}

/// Host-private facts of one round that a restart needs; never part of
/// `FusionStateV1`. A journal written before this record existed has none,
/// and its rounds stay unprovable (`uncertain`) instead of being completed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoundHostRecord {
    pub round_id: String,
    #[serde(default)]
    pub baseline_known: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_block_id: Option<String>,
    #[serde(default)]
    pub started_ms: u64,
}

impl FusionDocument {
    /// The generation written to the journal: the document with each round's
    /// host-private facts in `round_hosts`.
    pub(crate) fn for_journal(&self) -> Self {
        let mut stored = self.clone();
        stored.round_hosts = self
            .briefs
            .iter()
            .flat_map(|brief| &brief.rounds)
            .map(|round| RoundHostRecord {
                round_id: round.round_id.clone(),
                baseline_known: round.baseline_known,
                baseline_block_id: round.baseline_block_id.clone(),
                started_ms: round.started_ms,
            })
            .collect();
        stored
    }

    /// Moves the journal's host-private round facts back into the rounds.
    pub(crate) fn restore_round_hosts(&mut self) {
        let records = std::mem::take(&mut self.round_hosts);
        for round in self.briefs.iter_mut().flat_map(|brief| &mut brief.rounds) {
            if let Some(record) = records
                .iter()
                .find(|record| record.round_id == round.round_id)
            {
                round.baseline_known = record.baseline_known;
                round
                    .baseline_block_id
                    .clone_from(&record.baseline_block_id);
                round.started_ms = record.started_ms;
            } else {
                round.baseline_known = false;
                round.baseline_block_id = None;
            }
        }
    }
}

/// `FusionStateV1`: what the WebView reads.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusionStateV1 {
    pub protocol: u8,
    pub lead_session_id: String,
    pub workspace_id: String,
    pub pair: FusionPair,
    pub sidekick: SidekickState,
    pub sessions: Vec<FusionSidekickSession>,
    pub briefs: Vec<FusionBrief>,
    pub stats: FusionStats,
    pub revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum FusionCommandV1 {
    CreateChat {
        workspace_id: String,
        pair: FusionPair,
        #[serde(default)]
        title: Option<String>,
    },
    CheckPair {
        workspace_id: String,
        pair: FusionPair,
    },
    State {
        lead_session_id: String,
    },
    Find {
        session_id: String,
    },
    StopPair {
        lead_session_id: String,
    },
    StopSidekick {
        lead_session_id: String,
    },
    ResetSidekick {
        lead_session_id: String,
    },
    ReconcileRound {
        lead_session_id: String,
        round_id: String,
    },
    AbandonRound {
        lead_session_id: String,
        round_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum FusionResultV1 {
    Created {
        lead_session_id: String,
        state: Box<FusionStateV1>,
    },
    PairCheck {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        refusal: Option<FusionRefusal>,
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<FusionRoleName>,
    },
    State {
        state: Box<FusionStateV1>,
    },
    Membership {
        role: Option<FusionRoleName>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lead_session_id: Option<String>,
    },
    Accepted {},
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FusionChangedEventV1 {
    pub protocol: u8,
    pub lead_session_id: String,
    pub revision: u64,
}
