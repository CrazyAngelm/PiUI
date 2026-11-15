//! Frames of `nano-remote` v1: the envelope the Nano server reads and the
//! inner messages between a browser and this host (`contracts/nano-remote-v1.ts`).
//!
//! Inbound frames tolerate unknown fields so additive changes within v1 pass;
//! outbound frames are exactly the contract. `Debug` of a message prints its
//! kind only: payloads carry chat content.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// `NANO_REMOTE_PROTOCOL`.
pub const PROTOCOL: u32 = 1;
/// `NANO_REMOTE_SUBPROTOCOL`.
pub const SUBPROTOCOL: &str = "nano-remote.v1";
/// `NANO_REMOTE_LIMITS.maxFrameBytes`.
pub const MAX_FRAME_BYTES: usize = 262_144;
/// `NANO_REMOTE_LIMITS.singleResultBytes`: a larger `res` frame is sent as `part` frames.
pub const SINGLE_RESULT_BYTES: usize = 200_000;
/// `NANO_REMOTE_LIMITS.partBytes`.
pub const PART_BYTES: usize = 100_000;
/// `NANO_REMOTE_LIMITS.maxResultBytes`.
pub const MAX_RESULT_BYTES: usize = 67_108_864;
/// `NANO_REMOTE_LIMITS.maxViewers`.
pub const MAX_VIEWERS: usize = 2;
/// `NANO_REMOTE_LIMITS.maxBrowsers`.
pub const MAX_BROWSERS: usize = 8;
/// `NANO_REMOTE_LIMITS.maxInFlight`.
pub const MAX_IN_FLIGHT: usize = 8;
/// `NANO_REMOTE_LIMITS.pairingSeconds`.
pub const PAIRING_SECONDS: u64 = 120;
/// The largest request id a browser can express exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_REQUEST_ID: u64 = 9_007_199_254_740_991;

/// `NanoRemoteGrantV1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Grant {
    Once,
    Always,
}

/// `NanoRemoteDropReasonV1`: why the host drops a viewer (envelope `drop`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DropReason {
    Denied,
    Kicked,
    Disabled,
    Protocol,
}

/// `NanoRemoteByeReasonV1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ByeReason {
    Kicked,
    Disabled,
    SignedOut,
    Quit,
}

/// `NanoRemoteDeniedReasonV1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeniedReason {
    Denied,
    Timeout,
    Busy,
}

/// `NanoRemoteRefusalCodeV1`: refusals of the remote layer itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalCode {
    NotAllowed,
    Busy,
    TooLarge,
    Invalid,
    NotConnected,
}

impl RefusalCode {
    /// The `code` of the `error` of a `res` frame.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotAllowed => "remote-not-allowed",
            Self::Busy => "remote-busy",
            Self::TooLarge => "remote-too-large",
            Self::Invalid => "remote-invalid",
            Self::NotConnected => "remote-not-connected",
        }
    }
}

/// Whether `id` is a viewer id this host accepts: `vw_` and up to 64
/// URL-safe characters. The server issues `vw_` + 22 base64url characters.
pub fn valid_viewer_id(id: &str) -> bool {
    id.strip_prefix("vw_").is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 64
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/// A browser's message (`NanoRemoteViewerMessageV1`). An unknown `k` parses
/// as [`ViewerMessage::Unknown`]: ignored after `welcome`, a protocol error
/// before it.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(tag = "k")]
pub enum ViewerMessage {
    #[serde(rename = "hello")]
    Hello {
        proto: u32,
        key: String,
        #[serde(default)]
        label: String,
    },
    #[serde(rename = "proof")]
    Proof { sig: String },
    #[serde(rename = "req")]
    Req {
        id: u64,
        cmd: String,
        #[serde(default)]
        args: serde_json::Value,
    },
    #[serde(other)]
    Unknown,
}

impl fmt::Debug for ViewerMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::Hello { .. } => "hello",
            Self::Proof { .. } => "proof",
            Self::Req { .. } => "req",
            Self::Unknown => "unknown",
        };
        f.debug_struct("ViewerMessage")
            .field("k", &kind)
            .finish_non_exhaustive()
    }
}

/// A frame from the server (`NanoRemoteServerToDeviceV1`).
#[derive(Debug, Clone, PartialEq)]
pub enum ServerFrame {
    Hello {
        device: String,
    },
    ViewerOpen {
        viewer: String,
    },
    ViewerClose {
        viewer: String,
    },
    Message {
        viewer: String,
        body: ViewerMessage,
    },
    /// A `msg` whose `d` is a known message with unusable fields.
    Malformed {
        viewer: String,
    },
}

/// Parses one text frame; `None` for anything that is not a well-formed
/// server frame (invalid JSON, unknown `t`, missing or invalid fields).
pub fn parse_server_frame(text: &str) -> Option<ServerFrame> {
    let mut value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.as_object_mut()?;
    let kind = object.get("t")?.as_str()?.to_owned();
    let viewer = |object: &serde_json::Map<String, serde_json::Value>| {
        let id = object.get("viewer")?.as_str()?;
        valid_viewer_id(id).then(|| id.to_owned())
    };
    match kind.as_str() {
        "hello" => Some(ServerFrame::Hello {
            device: object.get("device")?.as_str()?.to_owned(),
        }),
        "viewer-open" => Some(ServerFrame::ViewerOpen {
            viewer: viewer(object)?,
        }),
        "viewer-close" => Some(ServerFrame::ViewerClose {
            viewer: viewer(object)?,
        }),
        "msg" => {
            let viewer = viewer(object)?;
            let body = object.remove("d")?;
            Some(match serde_json::from_value::<ViewerMessage>(body) {
                Ok(body) => ServerFrame::Message { viewer, body },
                Err(_) => ServerFrame::Malformed { viewer },
            })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/// `NanoRemoteShellContractsV1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellContracts {
    pub workspace: u32,
    pub composer: u32,
    pub settings: u32,
    pub history: u32,
    pub models: u32,
}

/// The `device` of a `welcome`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
}

/// The `app` of a `welcome`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub version: String,
}

/// `NanoRemoteWelcomeV1` without its `k`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Welcome {
    pub proto: u32,
    pub device: DeviceInfo,
    pub app: AppInfo,
    pub grant: Grant,
    pub shell: ShellContracts,
    pub commands: Vec<String>,
    pub channels: Vec<String>,
}

/// A host message to a browser (`NanoRemoteHostMessageV1`).
#[derive(Clone, Serialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum HostMessage {
    Challenge {
        nonce: String,
    },
    Approval {
        code: String,
        #[serde(rename = "expiresIn")]
        expires_in: u64,
    },
    Denied {
        reason: DeniedReason,
    },
    Welcome(Welcome),
    Res {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<Box<RawValue>>,
    },
    Part {
        id: u64,
        seq: u32,
        last: bool,
        ok: bool,
        data: String,
    },
    Ev {
        ch: String,
        p: Box<RawValue>,
    },
    /// An event on `ch` was too large for one frame and was not sent: the
    /// browser reads its state again (additive within `nano-remote.v1`;
    /// `sid` names the one session concerned, when the event had one).
    Gap {
        ch: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sid: Option<String>,
    },
    Bye {
        reason: ByeReason,
    },
}

impl fmt::Debug for HostMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostMessage")
            .field("k", &self.kind())
            .finish_non_exhaustive()
    }
}

fn raw(json: String) -> Option<Box<RawValue>> {
    RawValue::from_string(json).ok()
}

impl HostMessage {
    /// The wire `k`.
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Challenge { .. } => "challenge",
            Self::Approval { .. } => "approval",
            Self::Denied { .. } => "denied",
            Self::Welcome(_) => "welcome",
            Self::Res { .. } => "res",
            Self::Part { .. } => "part",
            Self::Ev { .. } => "ev",
            Self::Gap { .. } => "gap",
            Self::Bye { .. } => "bye",
        }
    }

    /// A `res` that refuses `id` with a remote-layer code.
    pub fn refusal(id: u64, code: RefusalCode) -> Self {
        Self::Res {
            id,
            ok: false,
            value: None,
            error: raw(format!("{{\"code\":\"{}\"}}", code.as_str())),
        }
    }

    /// An `ev` carrying `payload`, which must be one JSON document (the text
    /// of a host event). `None` when it is not valid JSON.
    pub fn event(channel: &str, payload: String) -> Option<Self> {
        Some(Self::Ev {
            ch: channel.to_owned(),
            p: raw(payload)?,
        })
    }
}

/// `{"k":"res","id":<id>,"ok":<bool>,"value"|"error":<json>}` byte length.
fn res_frame_len(id: u64, ok: bool, json_len: usize) -> usize {
    const FIXED: usize =
        "{\"k\":\"res\",\"id\":".len() + ",\"ok\":".len() + ",\"".len() + "\":}".len();
    FIXED
        + id.to_string().len()
        + if ok { "true".len() } else { "false".len() }
        + if ok { "value".len() } else { "error".len() }
        + json_len
}

/// Frames the answer of a command: one `res` when it fits
/// [`SINGLE_RESULT_BYTES`], else `part` frames of at most [`PART_BYTES`]
/// each, cut on `char` boundaries, in `seq` order with `last` on the final
/// one. Above [`MAX_RESULT_BYTES`] the answer is refused as too large.
/// `json` is the compact JSON text of the success value or of the error.
pub fn split_result(id: u64, ok: bool, json: &str) -> Vec<HostMessage> {
    if json.len() > MAX_RESULT_BYTES {
        return vec![HostMessage::refusal(id, RefusalCode::TooLarge)];
    }
    if res_frame_len(id, ok, json.len()) <= SINGLE_RESULT_BYTES {
        let Some(document) = raw(json.to_owned()) else {
            return vec![HostMessage::refusal(id, RefusalCode::Invalid)];
        };
        let (value, error) = if ok {
            (Some(document), None)
        } else {
            (None, Some(document))
        };
        return vec![HostMessage::Res {
            id,
            ok,
            value,
            error,
        }];
    }
    let mut parts = Vec::with_capacity(json.len() / PART_BYTES + 1);
    let mut start = 0;
    let mut seq = 0_u32;
    while start < json.len() {
        let mut end = (start + PART_BYTES).min(json.len());
        while end > start && !json.is_char_boundary(end) {
            end -= 1;
        }
        parts.push(HostMessage::Part {
            id,
            seq,
            last: end == json.len(),
            ok,
            data: json[start..end].to_owned(),
        });
        start = end;
        seq += 1;
    }
    parts
}

/// The server-bound envelope of `msg` and `drop`.
#[derive(Serialize)]
#[serde(tag = "t")]
enum DeviceFrame<'a> {
    #[serde(rename = "msg")]
    Message { viewer: &'a str, d: &'a HostMessage },
    #[serde(rename = "drop")]
    DropViewer { viewer: &'a str, reason: DropReason },
}

/// `{"t":"msg","viewer":..,"d":..}`; `None` when it would exceed
/// [`MAX_FRAME_BYTES`] (or cannot be serialized).
pub fn encode_message(viewer: &str, message: &HostMessage) -> Option<String> {
    let text = serde_json::to_string(&DeviceFrame::Message { viewer, d: message }).ok()?;
    (text.len() <= MAX_FRAME_BYTES).then_some(text)
}

/// `{"t":"drop","viewer":..,"reason":..}`.
pub fn encode_drop(viewer: &str, reason: DropReason) -> Option<String> {
    serde_json::to_string(&DeviceFrame::DropViewer { viewer, reason }).ok()
}
