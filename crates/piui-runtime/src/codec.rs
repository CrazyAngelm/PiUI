//! Byte-level LF framing for the Pi RPC transport.
//!
//! This module deliberately does not use `BufRead::lines`: that API accepts
//! Unicode line separators and loses the byte-level distinction required by
//! the RPC protocol.

use std::collections::BTreeSet;
use std::fmt;
use std::io;
use std::str;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use thiserror::Error;

/// Limits applied before a received RPC frame is allocated or decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RpcCodecConfig {
    /// Maximum number of bytes in a frame, excluding its LF delimiter.
    pub max_frame_bytes: usize,
}

impl RpcCodecConfig {
    pub const DEFAULT_MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

    #[must_use]
    pub const fn new(max_frame_bytes: usize) -> Self {
        Self { max_frame_bytes }
    }
}

impl Default for RpcCodecConfig {
    fn default() -> Self {
        Self::new(Self::DEFAULT_MAX_FRAME_BYTES)
    }
}

/// Non-sensitive framing counters for diagnostics and test assertions.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RpcCodecCounters {
    /// Empty LF or CRLF frames discarded by the codec.
    pub empty_frames: u64,
    /// Non-empty JSON frames successfully decoded.
    pub decoded_frames: u64,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RpcCodecError {
    #[error("RPC frame limit must be greater than zero")]
    InvalidFrameLimit,
    #[error("RPC frame exceeds the {limit}-byte limit (at least {observed} bytes)")]
    FrameTooLarge { limit: usize, observed: usize },
    #[error("RPC stream ended with an incomplete {bytes}-byte frame")]
    IncompleteEof { bytes: usize },
    #[error("RPC frame is not valid UTF-8")]
    InvalidUtf8,
    #[error("RPC frame is not valid JSON: {message}")]
    InvalidJson { message: String },
    #[error("RPC codec is terminal after a previous protocol error")]
    Terminal,
    #[error("value cannot be serialized as a JSON RPC frame: {message}")]
    EncodeJson { message: String },
}

/// Incremental, LF-only decoder for JSONL RPC streams.
#[derive(Debug)]
pub struct RpcCodec {
    config: RpcCodecConfig,
    pending: Vec<u8>,
    counters: RpcCodecCounters,
    terminal: bool,
}

impl RpcCodec {
    /// Creates a codec. A zero frame limit is always invalid rather than
    /// silently permitting unbounded memory use.
    pub fn new(config: RpcCodecConfig) -> Result<Self, RpcCodecError> {
        if config.max_frame_bytes == 0 {
            return Err(RpcCodecError::InvalidFrameLimit);
        }

        Ok(Self {
            config,
            pending: Vec::new(),
            counters: RpcCodecCounters::default(),
            terminal: false,
        })
    }

    #[must_use]
    pub const fn counters(&self) -> RpcCodecCounters {
        self.counters
    }

    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Feeds arbitrary byte chunks and returns each complete JSON value in
    /// order. Only byte `0x0A` delimits frames; CR is accepted solely as the
    /// one byte immediately before that delimiter.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, RpcCodecError> {
        if self.terminal {
            return Err(RpcCodecError::Terminal);
        }

        let mut values = Vec::new();
        for &byte in chunk {
            if byte == b'\n' {
                let frame = std::mem::take(&mut self.pending);
                match self.decode_frame(&frame) {
                    Ok(Some(value)) => values.push(value),
                    Ok(None) => {}
                    Err(error) => return self.fail(error),
                }
                continue;
            }

            if self.pending.len() == self.config.max_frame_bytes {
                return self.fail(RpcCodecError::FrameTooLarge {
                    limit: self.config.max_frame_bytes,
                    observed: self.config.max_frame_bytes.saturating_add(1),
                });
            }
            self.pending.push(byte);
        }
        Ok(values)
    }

    /// Decodes received JSON into a contract DTO without reparsing framing.
    pub fn push_as<T: DeserializeOwned>(&mut self, chunk: &[u8]) -> Result<Vec<T>, RpcCodecError> {
        self.push(chunk)?
            .into_iter()
            .map(|value| {
                serde_json::from_value(value).map_err(|error| RpcCodecError::InvalidJson {
                    message: error.to_string(),
                })
            })
            .collect()
    }

    /// Marks the stream complete. A nonempty tail is never interpreted as a
    /// message because the sender did not commit it with LF.
    pub fn finish(&mut self) -> Result<(), RpcCodecError> {
        if self.terminal {
            return Err(RpcCodecError::Terminal);
        }
        if self.pending.is_empty() {
            return Ok(());
        }

        self.fail(RpcCodecError::IncompleteEof {
            bytes: self.pending.len(),
        })
        .map(|_: Vec<Value>| ())
    }

    /// Produces one compact JSON frame terminated by exactly one LF.
    pub fn encode<T: serde::Serialize>(&self, value: &T) -> Result<Vec<u8>, RpcCodecError> {
        let mut encoded = serde_json::to_vec(value).map_err(|error| RpcCodecError::EncodeJson {
            message: error.to_string(),
        })?;
        if encoded.len() > self.config.max_frame_bytes {
            return Err(RpcCodecError::FrameTooLarge {
                limit: self.config.max_frame_bytes,
                observed: encoded.len(),
            });
        }
        encoded.push(b'\n');
        Ok(encoded)
    }

    fn fail<T>(&mut self, error: RpcCodecError) -> Result<T, RpcCodecError> {
        self.pending.clear();
        self.terminal = true;
        Err(error)
    }

    fn decode_frame(&mut self, frame: &[u8]) -> Result<Option<Value>, RpcCodecError> {
        let frame = frame.strip_suffix(b"\r").unwrap_or(frame);
        if frame.is_empty() {
            self.counters.empty_frames = self.counters.empty_frames.saturating_add(1);
            return Ok(None);
        }

        str::from_utf8(frame).map_err(|_| RpcCodecError::InvalidUtf8)?;
        let value = serde_json::from_slice(frame).map_err(|error| RpcCodecError::InvalidJson {
            message: error.to_string(),
        })?;
        self.counters.decoded_frames = self.counters.decoded_frames.saturating_add(1);
        Ok(Some(value))
    }
}

/// Safe classification of the top-level JSON value for an unknown event.
///
/// This enum is finite and never includes JSON keys or values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JsonValueKind {
    Null,
    Boolean,
    Number,
    String,
    Array,
    Object,
}

impl JsonValueKind {
    const fn from_value(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(_) => Self::Boolean,
            Value::Number(_) => Self::Number,
            Value::String(_) => Self::String,
            Value::Array(_) => Self::Array,
            Value::Object(_) => Self::Object,
        }
    }
}

/// Safe category for the unrecognized event's top-level `type` field.
///
/// The field's spelling is intentionally not retained: an unknown event type is
/// untrusted input and could itself contain a prompt, token, or credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownEventTypeCategory {
    /// The top-level JSON value was not an object.
    NotAnObject,
    /// The top-level object had no `type` member.
    Missing,
    /// The top-level object had a `type` member that was not a string.
    NonString,
    /// The top-level object had an unrecognized string `type` member.
    UnrecognizedString,
}

/// Payload-free representation of a future/unknown RPC event.
///
/// Every public field is finite metadata or a number. No JSON prefix, key,
/// event-type spelling, or payload value is retained, so `Debug`, `Display`,
/// and serialization cannot expose arbitrary RPC content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct OpaqueRpcEvent {
    /// Safe category of the unrecognized `type` field.
    pub event_type_category: UnknownEventTypeCategory,
    /// Safe category of the top-level JSON shape.
    pub top_level_kind: JsonValueKind,
    /// Byte length of the compact JSON representation without retaining it.
    pub original_byte_len: usize,
}

impl fmt::Display for OpaqueRpcEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "unknown RPC event (type_category={:?}, top_level_kind={:?}, bytes={})",
            self.event_type_category, self.top_level_kind, self.original_byte_len
        )
    }
}

/// Separates known events from forward-compatible payload-free generic events.
#[derive(Debug, Clone, PartialEq)]
pub enum NormalizedRpcEvent {
    Known { event_type: String, value: Value },
    Unknown(OpaqueRpcEvent),
}

/// Validates event shape while retaining metadata only for unrecognized types.
#[derive(Debug, Clone)]
pub struct RpcEventNormalizer {
    known_types: BTreeSet<String>,
}

impl RpcEventNormalizer {
    pub fn new<I, S>(known_types: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            known_types: known_types.into_iter().map(Into::into).collect(),
        }
    }

    #[must_use]
    pub fn normalize(&self, value: Value) -> NormalizedRpcEvent {
        let known_event_type = value
            .as_object()
            .and_then(|object| object.get("type"))
            .and_then(Value::as_str)
            .filter(|event_type| self.known_types.contains(*event_type));

        if let Some(event_type) = known_event_type {
            return NormalizedRpcEvent::Known {
                event_type: event_type.to_owned(),
                value,
            };
        }

        NormalizedRpcEvent::Unknown(OpaqueRpcEvent {
            event_type_category: unknown_event_type_category(&value),
            top_level_kind: JsonValueKind::from_value(&value),
            original_byte_len: compact_json_byte_len(&value),
        })
    }
}

fn unknown_event_type_category(value: &Value) -> UnknownEventTypeCategory {
    let Some(object) = value.as_object() else {
        return UnknownEventTypeCategory::NotAnObject;
    };
    match object.get("type") {
        None => UnknownEventTypeCategory::Missing,
        Some(Value::String(_)) => UnknownEventTypeCategory::UnrecognizedString,
        Some(_) => UnknownEventTypeCategory::NonString,
    }
}

fn compact_json_byte_len(value: &Value) -> usize {
    let mut counter = DiscardingByteCounter::default();
    // `Value` is serializable and this writer never fails. If serde_json were to
    // fail unexpectedly, retaining no length is safer than retaining its message
    // or a raw fallback payload.
    if serde_json::to_writer(&mut counter, value).is_err() {
        return 0;
    }
    counter.bytes
}

#[derive(Default)]
struct DiscardingByteCounter {
    bytes: usize,
}

impl io::Write for DiscardingByteCounter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buffer.len());
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codec(limit: usize) -> RpcCodec {
        RpcCodec::new(RpcCodecConfig::new(limit)).expect("valid test codec")
    }

    #[test]
    fn frames_only_on_lf_across_every_chunk_boundary() {
        let bytes = b"{\"type\":\"one\"}\n{\"type\":\"two\"}\n";
        for split in 0..=bytes.len() {
            let mut codec = codec(128);
            let mut values = codec.push(&bytes[..split]).expect("first chunk");
            values.extend(codec.push(&bytes[split..]).expect("second chunk"));
            assert_eq!(values.len(), 2, "split at {split}");
            assert_eq!(values[0]["type"], "one");
            codec.finish().expect("complete stream");
        }
    }

    #[test]
    fn accepts_cr_only_immediately_before_lf_and_counts_empty_frames() {
        let mut codec = codec(128);
        let values = codec
            .push(b"\r\n\n{\"ok\":true}\r\n")
            .expect("valid frames");
        assert_eq!(values, vec![serde_json::json!({"ok": true})]);
        assert_eq!(
            codec.counters(),
            RpcCodecCounters {
                empty_frames: 2,
                decoded_frames: 1
            }
        );
    }

    #[test]
    fn unicode_line_separator_is_json_content_not_a_delimiter() {
        let mut codec = codec(128);
        assert!(
            codec
                .push("{\"text\":\"a\u{2028}b\"}".as_bytes())
                .expect("no LF")
                .is_empty()
        );
        assert_eq!(codec.pending_len(), "{\"text\":\"a\u{2028}b\"}".len());
        assert_eq!(
            codec.push(b"\n").expect("LF frame")[0]["text"],
            "a\u{2028}b"
        );
    }

    #[test]
    fn rejects_invalid_utf8_json_oversize_and_incomplete_eof() {
        let mut invalid_utf8 = codec(128);
        assert_eq!(
            invalid_utf8.push(&[b'{', 0xff, b'}', b'\n']),
            Err(RpcCodecError::InvalidUtf8)
        );

        let mut invalid_json = codec(128);
        assert!(matches!(
            invalid_json.push(b"{oops}\n"),
            Err(RpcCodecError::InvalidJson { .. })
        ));

        let mut oversize = codec(3);
        assert_eq!(
            oversize.push(b"1234"),
            Err(RpcCodecError::FrameTooLarge {
                limit: 3,
                observed: 4
            })
        );
        assert_eq!(oversize.push(b"\n"), Err(RpcCodecError::Terminal));

        let mut incomplete = codec(128);
        incomplete
            .push(b"{\"x\":")
            .expect("partial data is buffered");
        assert_eq!(
            incomplete.finish(),
            Err(RpcCodecError::IncompleteEof { bytes: 5 })
        );
    }

    #[test]
    fn unknown_event_retains_only_payload_free_metadata() {
        let normalizer = RpcEventNormalizer::new(["message.delta"]);
        let value = serde_json::json!({
            "type": "future.event",
            "payload": "abcdefghijklmnopqrstuvwxyz"
        });
        let expected_byte_len = serde_json::to_vec(&value)
            .expect("test Value is serializable")
            .len();
        let NormalizedRpcEvent::Unknown(event) = normalizer.normalize(value) else {
            panic!("future event must be generic");
        };

        assert_eq!(
            event.event_type_category,
            UnknownEventTypeCategory::UnrecognizedString
        );
        assert_eq!(event.top_level_kind, JsonValueKind::Object);
        assert_eq!(event.original_byte_len, expected_byte_len);
    }

    #[test]
    fn unknown_event_never_exposes_adversarial_payload_in_public_views() {
        const TYPE_SECRET: &str = "TYPE_SECRET_4e46f509";
        const PROMPT_SECRET: &str = "PROMPT_SECRET_b2bdc920";
        const TOOL_SECRET: &str = "TOOL_SECRET_8e7606c3";
        const TOKEN_SECRET: &str = "TOKEN_SECRET_390e5894";
        const CREDENTIAL_SECRET: &str = "CREDENTIAL_SECRET_5b9f2d84";

        let normalizer = RpcEventNormalizer::new(["message.delta"]);
        let value = serde_json::json!({
            "type": TYPE_SECRET,
            "prompt": PROMPT_SECRET,
            "tool": {
                "arguments": TOOL_SECRET,
                "token": TOKEN_SECRET
            },
            "credentials": CREDENTIAL_SECRET
        });
        let normalized = normalizer.normalize(value);
        let normalized_debug_view = format!("{normalized:?}");
        let NormalizedRpcEvent::Unknown(event) = normalized else {
            panic!("adversarial future event must be generic");
        };

        let debug_view = format!("{event:?}");
        let display_view = event.to_string();
        let serialized_view = serde_json::to_string(&event).expect("metadata serializes");
        for view in [
            &normalized_debug_view,
            &debug_view,
            &display_view,
            &serialized_view,
        ] {
            for secret in [
                TYPE_SECRET,
                PROMPT_SECRET,
                TOOL_SECRET,
                TOKEN_SECRET,
                CREDENTIAL_SECRET,
            ] {
                assert!(!view.contains(secret), "secret leaked through public view");
            }
            for untrusted_key in ["prompt", "tool", "arguments", "token", "credentials"] {
                assert!(
                    !view.contains(untrusted_key),
                    "key leaked through public view"
                );
            }
        }
        assert_eq!(
            event.event_type_category,
            UnknownEventTypeCategory::UnrecognizedString
        );
        assert_eq!(event.top_level_kind, JsonValueKind::Object);
    }

    #[test]
    fn unknown_type_categories_are_finite_and_content_free() {
        let normalizer = RpcEventNormalizer::new(Vec::<String>::new());
        let cases = [
            (
                serde_json::json!("SECRET_ROOT_VALUE"),
                UnknownEventTypeCategory::NotAnObject,
                JsonValueKind::String,
            ),
            (
                serde_json::json!({"payload": "SECRET_MISSING_TYPE"}),
                UnknownEventTypeCategory::Missing,
                JsonValueKind::Object,
            ),
            (
                serde_json::json!({"type": {"nested": "SECRET_NON_STRING"}}),
                UnknownEventTypeCategory::NonString,
                JsonValueKind::Object,
            ),
        ];

        for (value, expected_category, expected_kind) in cases {
            let NormalizedRpcEvent::Unknown(event) = normalizer.normalize(value) else {
                panic!("unknown event must be generic");
            };
            assert_eq!(event.event_type_category, expected_category);
            assert_eq!(event.top_level_kind, expected_kind);
        }
    }
}
