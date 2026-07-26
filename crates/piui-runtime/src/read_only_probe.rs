//! Documentation-derived, read-only Pi RPC capability-probe protocol.
//!
//! This module is deliberately only a data/framing layer. It does not locate
//! or launch Pi, open a session, send a prompt, access a filesystem, inspect
//! credentials, or authorize a production runtime. A future handle-owning
//! supervisor may use these fixed request frames only after every Phase 0 and
//! managed-runtime gate is independently closed.

use crate::{RpcCodec, RpcCodecConfig};
use serde::Serialize;
use serde_json::{Value, json};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_SAFE_COUNT: usize = 1_024;
const MAX_PROBE_TRANSPORT_FRAME_BYTES: usize = 1024 * 1024;
const MAX_PROBE_TRANSPORT_CHUNK_BYTES: usize = 8 * 1024;
const MAX_PROBE_TRANSPORT_BYTES_TOTAL: usize = 4 * MAX_PROBE_TRANSPORT_FRAME_BYTES;
const MAX_PROBE_VALUES_PER_CHUNK: usize = 32;
const MAX_PROBE_VALUES_TOTAL: usize = 64;
static NEXT_PROBE_INSTANCE: AtomicU64 = AtomicU64::new(1);

const PROBE_COMMANDS: [(&str, ProbeSlot); 4] = [
    ("get_state", ProbeSlot::State),
    ("get_available_models", ProbeSlot::Models),
    ("get_available_thinking_levels", ProbeSlot::Thinking),
    ("get_commands", ProbeSlot::Commands),
];

struct ProbeRequest {
    id: String,
    command: &'static str,
    slot: ProbeSlot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProbeSlot {
    State,
    Models,
    Thinking,
    Commands,
}

/// Payload-free state for one fixed, documentation-derived RPC getter.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeCommandOutcome {
    #[default]
    Pending,
    Supported,
    Unsupported,
    Malformed,
}

/// Thinking levels PiUI may safely present after a successful capability
/// response. Unknown future levels are counted but never exposed as actions.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ProbeThinkingLevel {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "minimal" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" => Some(Self::Xhigh),
            "max" => Some(Self::Max),
            _ => None,
        }
    }
}

/// Sanitized result of a read-only capability probe. It intentionally has no
/// session path, session ID, model identifier, provider, command name/path,
/// error text, raw response, or authentication detail.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyProbeSnapshot {
    pub transport_ready: bool,
    pub state: ProbeCommandOutcome,
    pub models: ProbeCommandOutcome,
    pub thinking: ProbeCommandOutcome,
    pub commands: ProbeCommandOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_count: Option<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thinking_levels: Vec<ProbeThinkingLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unknown_thinking_level_count: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_command_count: Option<u16>,
}

/// How an incoming parsed JSON value was handled. Uncorrelated events are
/// ignored because Pi documents responses and events on the same stdout stream;
/// they never influence capability state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProbeFrameDisposition {
    Accepted,
    IgnoredNonResponse,
}

/// Path-free capability-probe protocol errors. Display and Debug intentionally
/// omit raw RPC values, request IDs, command spellings, and upstream errors.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReadOnlyProbeError {
    FrameEncoding,
    RequestsNotIssued,
    RequestsAlreadyIssued,
    Terminal,
    MalformedResponse,
    UnexpectedResponse,
    CommandMismatch,
    DuplicateResponse,
}

impl fmt::Display for ReadOnlyProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::FrameEncoding => "read-only probe request encoding failed",
            Self::RequestsNotIssued => {
                "read-only probe responses arrived before requests were issued"
            }
            Self::RequestsAlreadyIssued => "read-only probe requests were already issued",
            Self::Terminal => "read-only probe is terminal after a protocol failure",
            Self::MalformedResponse => "read-only probe received a malformed response",
            Self::UnexpectedResponse => "read-only probe received an unexpected response",
            Self::CommandMismatch => "read-only probe response did not match its request",
            Self::DuplicateResponse => "read-only probe received a duplicate response",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ReadOnlyProbeError {}

/// Fixed-whitelist capability probe state machine. Its constructor accepts no
/// user values, executable paths, command strings, session identifiers, or
/// handles. It cannot initiate any I/O by itself.
struct ReadOnlyCapabilityProbe {
    snapshot: ReadOnlyProbeSnapshot,
    requests: [ProbeRequest; 4],
    requests_issued: bool,
    terminal: bool,
}

impl fmt::Debug for ReadOnlyCapabilityProbe {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReadOnlyCapabilityProbe(<redacted>)")
    }
}

impl Default for ReadOnlyCapabilityProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadOnlyCapabilityProbe {
    #[must_use]
    fn new() -> Self {
        let instance = next_probe_instance();
        let mut commands = PROBE_COMMANDS.into_iter();
        let requests = std::array::from_fn(|ordinal| {
            let (command, slot) = commands
                .next()
                .expect("fixed read-only probe command list has four entries");
            ProbeRequest {
                id: format!("piui-probe-{instance}-{ordinal}"),
                command,
                slot,
            }
        });
        Self {
            snapshot: ReadOnlyProbeSnapshot::default(),
            requests,
            requests_issued: false,
            terminal: false,
        }
    }

    /// Encodes exactly four per-instance, host-owned getter requests as strict
    /// LF JSONL. The returned bytes are data only; this module has no
    /// pipe/process API and refuses response correlation before this succeeds.
    fn encoded_requests(&mut self) -> Result<Vec<Vec<u8>>, ReadOnlyProbeError> {
        if self.requests_issued {
            return Err(ReadOnlyProbeError::RequestsAlreadyIssued);
        }
        let codec = RpcCodec::new(RpcCodecConfig::default())
            .map_err(|_| ReadOnlyProbeError::FrameEncoding)?;
        let frames: Result<Vec<_>, _> = self
            .requests
            .iter()
            .map(|request| {
                codec
                    .encode(&json!({ "id": request.id, "type": request.command }))
                    .map_err(|_| ReadOnlyProbeError::FrameEncoding)
            })
            .collect();
        if frames.is_ok() {
            self.requests_issued = true;
        }
        frames
    }

    /// Accepts one already-framed/parsed stdout JSON value. Only a correlated
    /// response may change state; events cannot become a capability signal.
    fn ingest(&mut self, value: &Value) -> Result<ProbeFrameDisposition, ReadOnlyProbeError> {
        if self.terminal {
            return Err(ReadOnlyProbeError::Terminal);
        }
        if !self.requests_issued {
            return self.fail(ReadOnlyProbeError::RequestsNotIssued);
        }
        let Some(object) = value.as_object() else {
            return Ok(ProbeFrameDisposition::IgnoredNonResponse);
        };
        if object.get("type").and_then(Value::as_str) != Some("response") {
            return Ok(ProbeFrameDisposition::IgnoredNonResponse);
        }

        let Some(id) = object.get("id").and_then(Value::as_str) else {
            return self.fail(ReadOnlyProbeError::MalformedResponse);
        };
        let Some(request) = self.requests.iter().find(|request| request.id == id) else {
            return self.fail(ReadOnlyProbeError::UnexpectedResponse);
        };
        let slot = request.slot;
        let expected_command = request.command;
        let Some(command) = object.get("command").and_then(Value::as_str) else {
            return self.fail_for(slot, ReadOnlyProbeError::MalformedResponse);
        };
        if command != expected_command {
            return self.fail_for(slot, ReadOnlyProbeError::CommandMismatch);
        }
        let Some(success) = object.get("success").and_then(Value::as_bool) else {
            return self.fail_for(slot, ReadOnlyProbeError::MalformedResponse);
        };
        if self.outcome(slot) != ProbeCommandOutcome::Pending {
            return self.fail(ReadOnlyProbeError::DuplicateResponse);
        }

        if !success {
            self.set_outcome(slot, ProbeCommandOutcome::Unsupported);
            return Ok(ProbeFrameDisposition::Accepted);
        }

        let Some(data) = object.get("data") else {
            return self.fail_for(slot, ReadOnlyProbeError::MalformedResponse);
        };
        if let Err(error) = self.accept_success(slot, data) {
            return self.fail_for(slot, error);
        }
        Ok(ProbeFrameDisposition::Accepted)
    }

    /// Returns a payload-free copy that is safe for an eventual host/UI DTO.
    /// It is never transport-ready after any protocol failure.
    #[must_use]
    fn snapshot(&self) -> ReadOnlyProbeSnapshot {
        let mut snapshot = self.snapshot.clone();
        snapshot.transport_ready = !self.terminal
            && snapshot.state == ProbeCommandOutcome::Supported
            // `get_commands` must succeed and be empty to prove the fixed
            // resource-discovery flags actually took effect.
            && snapshot.commands == ProbeCommandOutcome::Supported
            && [snapshot.models, snapshot.thinking]
                .into_iter()
                .all(|outcome| {
                    matches!(
                        outcome,
                        ProbeCommandOutcome::Supported | ProbeCommandOutcome::Unsupported
                    )
                });
        snapshot
    }

    fn accept_success(&mut self, slot: ProbeSlot, data: &Value) -> Result<(), ReadOnlyProbeError> {
        match slot {
            ProbeSlot::State => {
                let Some(object) = data.as_object() else {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                };
                // `--no-session` must not report a persistent session path.
                // A missing or explicit null field is safe; any value is not.
                if object
                    .get("sessionFile")
                    .is_some_and(|value| !value.is_null())
                {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                }
            }
            ProbeSlot::Models => {
                let Some(models) = data
                    .as_object()
                    .and_then(|object| object.get("models"))
                    .and_then(Value::as_array)
                else {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                };
                if !models.iter().all(Value::is_object) {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                }
                self.snapshot.model_count = bounded_count(models.len());
                if self.snapshot.model_count.is_none() {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                }
            }
            ProbeSlot::Thinking => {
                let Some(levels) = data
                    .as_object()
                    .and_then(|object| object.get("levels"))
                    .and_then(Value::as_array)
                else {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                };
                if levels.len() > MAX_SAFE_COUNT {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                }
                let mut known = Vec::new();
                let mut unknown = 0_usize;
                for level in levels {
                    let Some(level) = level.as_str() else {
                        return Err(ReadOnlyProbeError::MalformedResponse);
                    };
                    match ProbeThinkingLevel::parse(level) {
                        Some(level) if !known.contains(&level) => known.push(level),
                        Some(_) => {}
                        None => unknown = unknown.saturating_add(1),
                    }
                }
                self.snapshot.thinking_levels = known;
                self.snapshot.unknown_thinking_level_count =
                    (unknown > 0).then(|| bounded_count(unknown)).flatten();
                if unknown > 0 && self.snapshot.unknown_thinking_level_count.is_none() {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                }
            }
            ProbeSlot::Commands => {
                let Some(commands) = data
                    .as_object()
                    .and_then(|object| object.get("commands"))
                    .and_then(Value::as_array)
                else {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                };
                // All resource discovery is disabled by the fixed argv. Any
                // discovered command means that isolation did not hold.
                if !commands.is_empty() || !commands.iter().all(Value::is_object) {
                    return Err(ReadOnlyProbeError::MalformedResponse);
                }
                self.snapshot.extension_command_count = Some(0);
            }
        }
        self.set_outcome(slot, ProbeCommandOutcome::Supported);
        Ok(())
    }

    fn outcome(&self, slot: ProbeSlot) -> ProbeCommandOutcome {
        match slot {
            ProbeSlot::State => self.snapshot.state,
            ProbeSlot::Models => self.snapshot.models,
            ProbeSlot::Thinking => self.snapshot.thinking,
            ProbeSlot::Commands => self.snapshot.commands,
        }
    }

    fn set_outcome(&mut self, slot: ProbeSlot, outcome: ProbeCommandOutcome) {
        match slot {
            ProbeSlot::State => self.snapshot.state = outcome,
            ProbeSlot::Models => self.snapshot.models = outcome,
            ProbeSlot::Thinking => self.snapshot.thinking = outcome,
            ProbeSlot::Commands => self.snapshot.commands = outcome,
        }
    }

    fn fail<T>(&mut self, error: ReadOnlyProbeError) -> Result<T, ReadOnlyProbeError> {
        self.terminal = true;
        Err(error)
    }

    fn fail_for<T>(
        &mut self,
        slot: ProbeSlot,
        error: ReadOnlyProbeError,
    ) -> Result<T, ReadOnlyProbeError> {
        self.set_outcome(slot, ProbeCommandOutcome::Malformed);
        self.fail(error)
    }
}

/// Path-free errors for the non-spawning byte-transport coordinator. It maps
/// codec and correlation failures to finite categories so no raw stdout,
/// request ID, command spelling, path, or upstream error can escape.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadOnlyProbeTransportError {
    RequestsNotStarted,
    RequestsAlreadyStarted,
    StdoutAlreadyClosed,
    Terminal,
    ChunkTooLarge,
    ByteBudgetExceeded,
    EventBudgetExceeded,
    ProtocolRejected,
    CorrelationRejected,
    IncompleteCapabilities,
}

impl fmt::Display for ReadOnlyProbeTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::RequestsNotStarted => {
                "read-only probe stdout arrived before fixed requests were issued"
            }
            Self::RequestsAlreadyStarted => "read-only probe fixed requests were already issued",
            Self::StdoutAlreadyClosed => "read-only probe stdout was already closed",
            Self::Terminal => "read-only probe transport is terminal after a protocol failure",
            Self::ChunkTooLarge => "read-only probe stdout chunk exceeded its fixed budget",
            Self::ByteBudgetExceeded => "read-only probe stdout exceeded its fixed byte budget",
            Self::EventBudgetExceeded => "read-only probe stdout exceeded its fixed event budget",
            Self::ProtocolRejected => "read-only probe stdout violated LF JSONL framing",
            Self::CorrelationRejected => "read-only probe stdout failed response correlation",
            Self::IncompleteCapabilities => {
                "read-only probe ended before required capabilities were confirmed"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ReadOnlyProbeTransportError {}

/// Bounded LF JSONL coordinator for the fixed read-only capability probe.
///
/// This is still only a data transport: callers supply bytes and receive
/// fixed request frames/sanitized state. It has no process, stdin/stdout pipe,
/// filesystem, executable, environment, or Tauri API. A future handle-owning
/// launcher can use this exact coordinator only after every separate Phase 0,
/// provenance, and containment gate is accepted.
pub struct ReadOnlyProbeTransport {
    codec: RpcCodec,
    probe: ReadOnlyCapabilityProbe,
    requests_started: bool,
    stdout_closed: bool,
    terminal: bool,
    observed_bytes: usize,
    observed_values: usize,
}

impl fmt::Debug for ReadOnlyProbeTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReadOnlyProbeTransport(<redacted>)")
    }
}

impl Default for ReadOnlyProbeTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadOnlyProbeTransport {
    #[must_use]
    pub fn new() -> Self {
        let codec = RpcCodec::new(RpcCodecConfig::new(MAX_PROBE_TRANSPORT_FRAME_BYTES))
            .expect("fixed read-only probe codec configuration is valid");
        Self {
            codec,
            probe: ReadOnlyCapabilityProbe::new(),
            requests_started: false,
            stdout_closed: false,
            terminal: false,
            observed_bytes: 0,
            observed_values: 0,
        }
    }

    /// Returns exactly the four host-owned request frames once. These bytes are
    /// intended for a future controlled stdin writer; this method does not
    /// write them anywhere.
    pub fn begin(&mut self) -> Result<Vec<Vec<u8>>, ReadOnlyProbeTransportError> {
        if self.terminal {
            return Err(ReadOnlyProbeTransportError::Terminal);
        }
        if self.requests_started {
            return Err(ReadOnlyProbeTransportError::RequestsAlreadyStarted);
        }
        let frames = match self.probe.encoded_requests() {
            Ok(frames) => frames,
            Err(_) => return self.fail(ReadOnlyProbeTransportError::ProtocolRejected),
        };
        self.requests_started = true;
        Ok(frames)
    }

    /// Accepts one bounded arbitrary stdout chunk. Complete LF frames are
    /// decoded through [`RpcCodec`] and correlated exclusively by the owned
    /// fixed probe. Unrelated events consume the same finite event budget but
    /// cannot influence capability state.
    pub fn push_stdout(&mut self, chunk: &[u8]) -> Result<(), ReadOnlyProbeTransportError> {
        if self.terminal {
            return Err(ReadOnlyProbeTransportError::Terminal);
        }
        if !self.requests_started {
            return self.fail(ReadOnlyProbeTransportError::RequestsNotStarted);
        }
        if self.stdout_closed {
            return self.fail(ReadOnlyProbeTransportError::StdoutAlreadyClosed);
        }
        if chunk.len() > MAX_PROBE_TRANSPORT_CHUNK_BYTES {
            return self.fail(ReadOnlyProbeTransportError::ChunkTooLarge);
        }
        let Some(total_bytes) = self.observed_bytes.checked_add(chunk.len()) else {
            return self.fail(ReadOnlyProbeTransportError::ByteBudgetExceeded);
        };
        if total_bytes > MAX_PROBE_TRANSPORT_BYTES_TOTAL {
            return self.fail(ReadOnlyProbeTransportError::ByteBudgetExceeded);
        }
        self.observed_bytes = total_bytes;
        let values = match self.codec.push(chunk) {
            Ok(values) => values,
            Err(_) => return self.fail(ReadOnlyProbeTransportError::ProtocolRejected),
        };
        if values.len() > MAX_PROBE_VALUES_PER_CHUNK
            || self.observed_values.saturating_add(values.len()) > MAX_PROBE_VALUES_TOTAL
        {
            return self.fail(ReadOnlyProbeTransportError::EventBudgetExceeded);
        }
        self.observed_values = self.observed_values.saturating_add(values.len());
        for value in values {
            if self.probe.ingest(&value).is_err() {
                return self.fail(ReadOnlyProbeTransportError::CorrelationRejected);
            }
        }
        Ok(())
    }

    /// Closes the synthetic stdout source. A partial LF frame, a malformed
    /// response, or an incomplete capability set is terminal and never yields
    /// a transport-ready snapshot.
    pub fn finish_stdout(&mut self) -> Result<ReadOnlyProbeSnapshot, ReadOnlyProbeTransportError> {
        if self.terminal {
            return Err(ReadOnlyProbeTransportError::Terminal);
        }
        if !self.requests_started {
            return self.fail(ReadOnlyProbeTransportError::RequestsNotStarted);
        }
        if self.stdout_closed {
            return Err(ReadOnlyProbeTransportError::StdoutAlreadyClosed);
        }
        if self.codec.finish().is_err() {
            return self.fail(ReadOnlyProbeTransportError::ProtocolRejected);
        }
        self.stdout_closed = true;
        let snapshot = self.snapshot();
        if !snapshot.transport_ready {
            return self.fail(ReadOnlyProbeTransportError::IncompleteCapabilities);
        }
        Ok(snapshot)
    }

    /// Returns a payload-free snapshot. It cannot be transport-ready until
    /// all required responses have correlated *and* LF stdout has closed
    /// cleanly.
    #[must_use]
    pub fn snapshot(&self) -> ReadOnlyProbeSnapshot {
        let mut snapshot = self.probe.snapshot();
        snapshot.transport_ready &= self.stdout_closed && !self.terminal;
        snapshot
    }

    fn fail<T>(
        &mut self,
        error: ReadOnlyProbeTransportError,
    ) -> Result<T, ReadOnlyProbeTransportError> {
        self.terminal = true;
        Err(error)
    }
}

fn bounded_count(value: usize) -> Option<u16> {
    (value <= MAX_SAFE_COUNT)
        .then(|| u16::try_from(value).ok())
        .flatten()
}

fn next_probe_instance() -> u64 {
    let instance = NEXT_PROBE_INSTANCE.fetch_add(1, Ordering::Relaxed);
    if instance == 0 {
        NEXT_PROBE_INSTANCE.fetch_add(1, Ordering::Relaxed)
    } else {
        instance
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RpcCodec, RpcCodecConfig};
    use serde_json::json;

    const SENTINEL: &str = "PIUI_PROBE_SECRET_PATH_TOKEN_9b0edc";

    fn response(id: &str, command: &str, success: bool, data: Value) -> Value {
        json!({
            "type": "response",
            "id": id,
            "command": command,
            "success": success,
            "data": data,
            "error": SENTINEL,
        })
    }

    fn issued_probe() -> (ReadOnlyCapabilityProbe, [String; 4]) {
        let mut probe = ReadOnlyCapabilityProbe::new();
        let frames = probe.encoded_requests().expect("issues fixed requests");
        let ids = request_ids(&frames);
        (probe, ids)
    }

    fn started_transport() -> (ReadOnlyProbeTransport, [String; 4]) {
        let mut transport = ReadOnlyProbeTransport::new();
        let frames = transport.begin().expect("issues fixed transport requests");
        let ids = request_ids(&frames);
        (transport, ids)
    }

    fn request_ids(frames: &[Vec<u8>]) -> [String; 4] {
        assert_eq!(frames.len(), 4);
        std::array::from_fn(|index| {
            let value: Value = serde_json::from_slice(&frames[index][..frames[index].len() - 1])
                .expect("request is JSON");
            value
                .get("id")
                .and_then(Value::as_str)
                .expect("request has host-owned ID")
                .to_owned()
        })
    }

    fn jsonl(value: &Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(value).expect("serializes JSONL fixture");
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn encodes_only_fixed_lf_delimited_read_only_getters() {
        let mut probe = ReadOnlyCapabilityProbe::new();
        let frames = probe.encoded_requests().expect("encodes fixed requests");
        assert_eq!(frames.len(), 4);
        let expected = [
            "get_state",
            "get_available_models",
            "get_available_thinking_levels",
            "get_commands",
        ];
        for (frame, command) in frames.iter().zip(expected) {
            assert!(frame.ends_with(b"\n"));
            assert!(!frame[..frame.len() - 1].contains(&b'\n'));
            let value: Value =
                serde_json::from_slice(&frame[..frame.len() - 1]).expect("valid JSON request");
            assert_eq!(value.get("type").and_then(Value::as_str), Some(command));
            assert!(value.get("id").and_then(Value::as_str).is_some());
        }
        for forbidden in [
            "prompt",
            "bash",
            "new_session",
            "switch_session",
            "fork",
            "clone",
            "abort",
        ] {
            assert!(
                !frames.iter().any(|frame| frame
                    .windows(forbidden.len())
                    .any(|window| window == forbidden.as_bytes())),
                "fixed probe must not encode {forbidden}"
            );
        }
    }

    #[test]
    fn correlates_fragmented_lf_frames_and_reduces_all_payloads() {
        let (mut probe, ids) = issued_probe();
        let stream = [
            response(
                &ids[0],
                "get_state",
                true,
                json!({"sessionFile": null, "model": {"id": SENTINEL}}),
            ),
            response(
                &ids[1],
                "get_available_models",
                true,
                json!({"models": [{"id": SENTINEL}, {"id": "second"}]}),
            ),
            response(
                &ids[2],
                "get_available_thinking_levels",
                true,
                json!({"levels": ["off", "high", SENTINEL, "high"]}),
            ),
            response(&ids[3], "get_commands", true, json!({"commands": []})),
        ];
        let mut bytes = Vec::new();
        for value in stream {
            bytes.extend_from_slice(&serde_json::to_vec(&value).expect("serializes fixture"));
            bytes.push(b'\n');
        }
        let mut codec = RpcCodec::new(RpcCodecConfig::new(8 * 1024)).expect("codec");
        let split = bytes.len() / 3;
        let mut values = codec.push(&bytes[..split]).expect("first fragment");
        values.extend(codec.push(&bytes[split..]).expect("second fragment"));
        for value in values {
            assert_eq!(probe.ingest(&value), Ok(ProbeFrameDisposition::Accepted));
        }
        codec.finish().expect("complete LF stream");

        let snapshot = probe.snapshot();
        assert!(snapshot.transport_ready);
        assert_eq!(snapshot.model_count, Some(2));
        assert_eq!(snapshot.extension_command_count, Some(0));
        assert_eq!(
            snapshot.thinking_levels,
            vec![ProbeThinkingLevel::Off, ProbeThinkingLevel::High]
        );
        assert_eq!(snapshot.unknown_thinking_level_count, Some(1));
        let serialized = serde_json::to_string(&snapshot).expect("safe snapshot serializes");
        assert!(!serialized.contains(SENTINEL));
        assert!(!format!("{snapshot:?}").contains(SENTINEL));
        assert!(!format!("{probe:?}").contains(&ids[0]));
    }

    #[test]
    fn unsupported_getter_is_safe_but_mismatch_duplicate_or_malformed_response_fails_closed() {
        let (mut unsupported, ids) = issued_probe();
        assert_eq!(
            unsupported.ingest(&response(
                &ids[1],
                "get_available_models",
                false,
                json!(null),
            )),
            Ok(ProbeFrameDisposition::Accepted)
        );
        assert_eq!(
            unsupported.snapshot().models,
            ProbeCommandOutcome::Unsupported
        );
        assert!(
            !unsupported.snapshot().transport_ready,
            "remaining probes are pending"
        );

        let (mut mismatched, ids) = issued_probe();
        assert_eq!(
            mismatched.ingest(&response(
                &ids[0],
                "get_available_models",
                true,
                json!({"models": []}),
            )),
            Err(ReadOnlyProbeError::CommandMismatch)
        );
        assert!(!mismatched.snapshot().transport_ready);
        assert_eq!(
            mismatched.ingest(&json!({"type":"event"})),
            Err(ReadOnlyProbeError::Terminal)
        );

        let (mut duplicate, ids) = issued_probe();
        let state = response(&ids[0], "get_state", true, json!({"sessionFile": null}));
        assert!(duplicate.ingest(&state).is_ok());
        assert_eq!(
            duplicate.ingest(&state),
            Err(ReadOnlyProbeError::DuplicateResponse)
        );

        let (mut malformed, ids) = issued_probe();
        assert_eq!(
            malformed.ingest(&response(
                &ids[2],
                "get_available_thinking_levels",
                true,
                json!({"levels": "not-an-array"}),
            )),
            Err(ReadOnlyProbeError::MalformedResponse)
        );
        assert_eq!(
            malformed.snapshot().thinking,
            ProbeCommandOutcome::Malformed
        );
    }

    #[test]
    fn command_enumeration_must_succeed_to_prove_resource_isolation() {
        let (mut probe, ids) = issued_probe();
        for value in [
            response(&ids[0], "get_state", true, json!({"sessionFile": null})),
            response(&ids[1], "get_available_models", false, json!(null)),
            response(&ids[2], "get_available_thinking_levels", false, json!(null)),
            response(&ids[3], "get_commands", false, json!(null)),
        ] {
            assert_eq!(probe.ingest(&value), Ok(ProbeFrameDisposition::Accepted));
        }
        assert!(!probe.snapshot().transport_ready);
    }

    #[test]
    fn rejects_preissue_or_cross_instance_responses_and_ignores_events_after_issue() {
        let mut not_issued = ReadOnlyCapabilityProbe::new();
        assert_eq!(
            not_issued.ingest(&json!({"type":"message_update","message":SENTINEL})),
            Err(ReadOnlyProbeError::RequestsNotIssued)
        );

        let (mut first, first_ids) = issued_probe();
        let (_second, second_ids) = issued_probe();
        assert_ne!(first_ids[0], second_ids[0]);
        assert_eq!(
            first.ingest(&response(
                &second_ids[0],
                "get_state",
                true,
                json!({"sessionFile": null})
            )),
            Err(ReadOnlyProbeError::UnexpectedResponse)
        );

        let (mut probe, _ids) = issued_probe();
        assert_eq!(
            probe.ingest(&json!({"type":"message_update","message":SENTINEL})),
            Ok(ProbeFrameDisposition::IgnoredNonResponse)
        );
        assert_eq!(probe.snapshot().state, ProbeCommandOutcome::Pending);
        assert!(!probe.snapshot().transport_ready);
    }

    #[test]
    fn rejects_evidence_that_ephemeral_resource_isolation_failed() {
        let (mut session_path, ids) = issued_probe();
        assert_eq!(
            session_path.ingest(&response(
                &ids[0],
                "get_state",
                true,
                json!({"sessionFile": SENTINEL}),
            )),
            Err(ReadOnlyProbeError::MalformedResponse)
        );

        let (mut commands, ids) = issued_probe();
        assert_eq!(
            commands.ingest(&response(
                &ids[3],
                "get_commands",
                true,
                json!({"commands": [{"name": SENTINEL}]}),
            )),
            Err(ReadOnlyProbeError::MalformedResponse)
        );

        let (mut malformed_members, ids) = issued_probe();
        assert_eq!(
            malformed_members.ingest(&response(
                &ids[1],
                "get_available_models",
                true,
                json!({"models": [null]}),
            )),
            Err(ReadOnlyProbeError::MalformedResponse)
        );
    }

    #[test]
    fn transport_coordinator_requires_clean_eof_after_fragmented_correlated_responses() {
        let (mut transport, ids) = started_transport();
        let stream = [
            response(
                &ids[0],
                "get_state",
                true,
                json!({"sessionFile": null, "model": {"id": SENTINEL}}),
            ),
            response(
                &ids[1],
                "get_available_models",
                true,
                json!({"models": [{"id": SENTINEL}]}),
            ),
            response(
                &ids[2],
                "get_available_thinking_levels",
                true,
                json!({"levels": ["minimal", "future-level"]}),
            ),
            response(&ids[3], "get_commands", true, json!({"commands": []})),
        ];
        let mut bytes = Vec::new();
        for value in stream {
            bytes.extend(jsonl(&value));
        }
        for chunk in bytes.chunks(7) {
            transport
                .push_stdout(chunk)
                .expect("accepts fragmented bytes");
        }
        assert!(
            !transport.snapshot().transport_ready,
            "EOF is required before a capability result becomes usable"
        );
        let snapshot = transport.finish_stdout().expect("cleanly closes stdout");
        assert!(snapshot.transport_ready);
        assert_eq!(snapshot.model_count, Some(1));
        assert_eq!(snapshot.thinking_levels, vec![ProbeThinkingLevel::Minimal]);
        assert_eq!(snapshot.unknown_thinking_level_count, Some(1));
        assert_eq!(snapshot.extension_command_count, Some(0));
        let serialized = serde_json::to_string(&snapshot).expect("serializes safe result");
        assert!(!serialized.contains(SENTINEL));
        assert!(!format!("{transport:?}").contains(&ids[0]));
    }

    #[test]
    fn transport_coordinator_rejects_prestart_duplicate_late_and_partial_streams() {
        let mut prestart = ReadOnlyProbeTransport::new();
        assert_eq!(
            prestart.push_stdout(b"{\"type\":\"event\"}\n"),
            Err(ReadOnlyProbeTransportError::RequestsNotStarted)
        );
        assert_eq!(prestart.begin(), Err(ReadOnlyProbeTransportError::Terminal));

        let (mut duplicate_begin, _ids) = started_transport();
        assert_eq!(
            duplicate_begin.begin(),
            Err(ReadOnlyProbeTransportError::RequestsAlreadyStarted)
        );

        let (mut partial, _ids) = started_transport();
        partial
            .push_stdout(b"{\"type\":\"event\"")
            .expect("buffers incomplete line");
        assert_eq!(
            partial.finish_stdout(),
            Err(ReadOnlyProbeTransportError::ProtocolRejected)
        );
        assert_eq!(
            partial.push_stdout(b"\n"),
            Err(ReadOnlyProbeTransportError::Terminal)
        );
    }

    #[test]
    fn transport_coordinator_fails_closed_for_uncorrelated_or_isolation_breaking_responses() {
        let (mut cross_instance, _ids) = started_transport();
        let (_other, other_ids) = started_transport();
        assert_eq!(
            cross_instance.push_stdout(&jsonl(&response(
                &other_ids[0],
                "get_state",
                true,
                json!({"sessionFile": null}),
            ))),
            Err(ReadOnlyProbeTransportError::CorrelationRejected)
        );
        assert_eq!(
            cross_instance.finish_stdout(),
            Err(ReadOnlyProbeTransportError::Terminal)
        );

        let (mut persistent_session, ids) = started_transport();
        let error = persistent_session.push_stdout(&jsonl(&response(
            &ids[0],
            "get_state",
            true,
            json!({"sessionFile": SENTINEL}),
        )));
        assert_eq!(error, Err(ReadOnlyProbeTransportError::CorrelationRejected));
        let snapshot = persistent_session.snapshot();
        for view in [
            format!("{persistent_session:?}"),
            format!("{snapshot:?}"),
            serde_json::to_string(&snapshot).expect("serializes safe snapshot"),
            error.expect_err("captures safe error").to_string(),
        ] {
            assert!(!view.contains(SENTINEL));
        }
        assert!(!snapshot.transport_ready);
    }

    #[test]
    fn transport_coordinator_never_promotes_incomplete_capabilities_at_eof() {
        let (mut transport, ids) = started_transport();
        for value in [
            response(&ids[0], "get_state", true, json!({"sessionFile": null})),
            response(&ids[1], "get_available_models", true, json!({"models": []})),
            response(&ids[2], "get_available_thinking_levels", false, json!(null)),
            response(&ids[3], "get_commands", false, json!(null)),
        ] {
            transport
                .push_stdout(&jsonl(&value))
                .expect("correlates deliberate unsupported response");
        }
        assert_eq!(
            transport.finish_stdout(),
            Err(ReadOnlyProbeTransportError::IncompleteCapabilities)
        );
        assert!(!transport.snapshot().transport_ready);
        assert_eq!(
            transport.push_stdout(b"\n"),
            Err(ReadOnlyProbeTransportError::Terminal)
        );
    }

    #[test]
    fn transport_coordinator_enforces_chunk_and_event_budgets() {
        let (mut oversized, _ids) = started_transport();
        assert_eq!(
            oversized.push_stdout(&vec![b'x'; MAX_PROBE_TRANSPORT_CHUNK_BYTES + 1]),
            Err(ReadOnlyProbeTransportError::ChunkTooLarge)
        );

        let (mut noisy, _ids) = started_transport();
        let mut events = Vec::new();
        for _ in 0..=MAX_PROBE_VALUES_PER_CHUNK {
            events.extend_from_slice(b"{\"type\":\"event\"}\n");
        }
        assert_eq!(
            noisy.push_stdout(&events),
            Err(ReadOnlyProbeTransportError::EventBudgetExceeded)
        );

        let (mut empty_frames, _ids) = started_transport();
        let blank_chunk = vec![b'\n'; MAX_PROBE_TRANSPORT_CHUNK_BYTES];
        for _ in 0..(MAX_PROBE_TRANSPORT_BYTES_TOTAL / MAX_PROBE_TRANSPORT_CHUNK_BYTES) {
            empty_frames
                .push_stdout(&blank_chunk)
                .expect("empty frame traffic remains bounded before the total limit");
        }
        assert_eq!(
            empty_frames.push_stdout(b"\n"),
            Err(ReadOnlyProbeTransportError::ByteBudgetExceeded)
        );
    }

    #[test]
    fn module_has_no_launch_shell_filesystem_or_environment_surface() {
        let source = include_str!("read_only_probe.rs");
        let forbidden = [
            ["Command", "::new"].concat(),
            [".sp", "awn("].concat(),
            ["std", "::process::Command"].concat(),
            ["tokio", "::process"].concat(),
            ["std", "::fs"].concat(),
            ["std", "::env::var"].concat(),
        ];
        for forbidden in forbidden {
            assert!(
                !source.contains(&forbidden),
                "read-only probe must not contain {forbidden}"
            );
        }
        assert!(
            !source.lines().any(|line| line
                .trim_start()
                .starts_with("pub struct ReadOnlyCapabilityProbe")),
            "only the LF transport may produce a readiness-bearing snapshot"
        );
        assert!(
            !include_str!("lib.rs").contains("ReadOnlyCapabilityProbe"),
            "the low-level parsed-Value probe must not be re-exported"
        );
    }
}
