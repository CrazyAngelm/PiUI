//! Linked-chat metadata and the v1 wire contract. Native histories are never stored here.

use piui_runtime::workspace_runtime::{HarnessKind, PermissionMode};
use serde::{Deserialize, Serialize};

pub(crate) const PROTOCOL: u8 = 1;
pub(crate) const CHANGED_EVENT: &str = "piui://session-links-v1";
pub(crate) const TEXT_CHARS: usize = 16_000;
pub(crate) const REPORT_CHARS: usize = 4_000;
pub(crate) const EXCERPT_CHARS: usize = 400;
pub(crate) const PAGE_BYTES: usize = 16 * 1024;
pub(crate) const MAX_WAIT_SECONDS: u64 = 240;
pub(crate) const MAX_AGENT_CHILDREN: usize = 5;
pub(crate) const MAX_PENDING: usize = 20;
pub(crate) const MAX_WAKES: u32 = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LinkKind {
    Agent,
    Branch,
    Peer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Relation {
    Child,
    Parent,
    Peer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LinkedChatState {
    Starting,
    Running,
    Idle,
    Failed,
    Closed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LastReport {
    pub at: String,
    pub excerpt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LinkedChat {
    pub session_id: String,
    pub title: String,
    pub harness: HarnessKind,
    pub kind: LinkKind,
    pub relation: Relation,
    pub state: LinkedChatState,
    pub pending: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report: Option<LastReport>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PendingText {
    pub id: String,
    pub text: String,
    pub agent_origin: bool,
    pub report: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Link {
    pub other_session_id: String,
    pub kind: LinkKind,
    pub relation: Relation,
    pub created_at: String,
    pub pending: Vec<PendingText>,
    pub last_report: Option<LastReport>,
    pub asked_turn: bool,
    /// A native answer identity, not answer contents: avoids reporting an older answer after restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_answer_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BranchMode {
    Native,
    Linked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BranchOrigin {
    pub source_session_id: String,
    pub mode: BranchMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_block_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SessionDocument {
    pub protocol: u8,
    pub session_id: String,
    pub links: Vec<Link>,
    pub wakes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<BranchOrigin>,
}

impl SessionDocument {
    pub(crate) fn new(session_id: &str) -> Self {
        Self {
            protocol: PROTOCOL,
            session_id: session_id.to_owned(),
            links: Vec::new(),
            wakes: 0,
            branch: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolModel {
    pub provider: String,
    pub id: String,
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ToolOperation {
    Start {
        title: String,
        prompt: String,
        #[serde(default, deserialize_with = "present")]
        harness: Option<HarnessKind>,
        #[serde(default, deserialize_with = "present")]
        model: Option<ToolModel>,
        #[serde(default, deserialize_with = "present")]
        permission_mode: Option<PermissionMode>,
        #[serde(default, deserialize_with = "present")]
        wait: Option<bool>,
        #[serde(default, deserialize_with = "present")]
        wait_seconds: Option<u64>,
    },
    List {},
    Message {
        session_id: String,
        text: String,
        #[serde(default, deserialize_with = "present")]
        wait: Option<bool>,
        #[serde(default, deserialize_with = "present")]
        wait_seconds: Option<u64>,
    },
    Read {
        session_id: String,
        #[serde(default, deserialize_with = "present")]
        page: Option<u64>,
    },
    Wait {
        session_id: String,
        #[serde(default, deserialize_with = "present")]
        wait_seconds: Option<u64>,
    },
    Stop {
        session_id: String,
    },
}

impl ToolOperation {
    pub(crate) fn valid(&self) -> bool {
        let wait = |value: &Option<u64>| value.is_none_or(|seconds| seconds <= MAX_WAIT_SECONDS);
        let id = |value: &str| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_')
        };
        match self {
            Self::Start {
                title,
                prompt,
                model,
                wait_seconds,
                ..
            } => {
                !title.trim().is_empty()
                    && text_valid(prompt)
                    && wait(wait_seconds)
                    && model
                        .as_ref()
                        .is_none_or(|model| !model.provider.is_empty() && !model.id.is_empty())
            }
            Self::List {} => true,
            Self::Message {
                session_id,
                text,
                wait_seconds,
                ..
            } => id(session_id) && text_valid(text) && wait(wait_seconds),
            Self::Read { session_id, page } => id(session_id) && page.is_none_or(|page| page >= 1),
            Self::Wait {
                session_id,
                wait_seconds,
            } => id(session_id) && wait(wait_seconds),
            Self::Stop { session_id } => id(session_id),
        }
    }
}

pub(crate) fn text_valid(text: &str) -> bool {
    (1..=TEXT_CHARS).contains(&text.chars().count())
}
pub(crate) fn title(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_control())
        .take(80)
        .collect()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Command {
    Find {
        session_id: String,
    },
    Link {
        session_id: String,
        other_session_id: String,
    },
    Unlink {
        session_id: String,
        other_session_id: String,
    },
    Send {
        from_session_id: String,
        to_session_id: String,
        text: String,
    },
    Deliver {
        session_id: String,
        from_session_id: String,
    },
    Settings {},
    Update {
        enabled: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum CommandResult {
    Links {
        session_id: String,
        chats: Vec<LinkedChat>,
        revision: u64,
    },
    Done,
    Settings {
        enabled: bool,
        read_only: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ErrorCode {
    InvalidOperation,
    UnknownSession,
    AuthorityDenied,
    DepthLimit,
    ChildLimit,
    HarnessUnavailable,
    NotAllowed,
    Busy,
    Unavailable,
    ReadOnly,
    Io,
}

impl ErrorCode {
    pub(crate) const fn message(self) -> &'static str {
        match self {
            Self::InvalidOperation => "The sessions operation is invalid. Check op and its fields.",
            Self::UnknownSession => "This chat is not linked to the caller.",
            Self::AuthorityDenied => {
                "The linked chat would have more authority than this chat, or the two cannot be compared. On another harness set permissionMode at or below this chat's explicit mode."
            }
            Self::DepthLimit => "A linked child chat cannot start another chat.",
            Self::ChildLimit => "This chat already has five open agent children.",
            Self::HarnessUnavailable => "The requested harness is unavailable.",
            Self::NotAllowed => "Linked chats are not allowed for this session.",
            Self::Busy => "This linked chat operation is already in progress.",
            Self::Unavailable => "The linked chat operation could not be completed.",
            Self::ReadOnly => "Linked chats are read-only in safe mode.",
            Self::Io => "Linked chats could not be saved. Nothing was changed.",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct LinksError {
    pub code: ErrorCode,
    pub message: &'static str,
}
impl From<ErrorCode> for LinksError {
    fn from(code: ErrorCode) -> Self {
        Self {
            code,
            message: code.message(),
        }
    }
}

pub(crate) fn refusal(code: ErrorCode) -> serde_json::Value {
    let code = match code {
        ErrorCode::Io => ErrorCode::Unavailable,
        ErrorCode::ReadOnly => ErrorCode::NotAllowed,
        other => other,
    };
    serde_json::json!({ "ok": false, "code": code, "message": code.message() })
}
