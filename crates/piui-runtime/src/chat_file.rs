//! Files a native agent reports for the chat feed.
//!
//! The bridge sends `{type:"file", blockId, origin, path | inline}` beside the
//! block it belongs to (`bridge/CONTRACT.md`, "File events"). This module is the
//! runtime boundary: it parses that frame into a typed [`ChatFileEvent`] and
//! stops there. Registering the file, scoping its path and serving its bytes are
//! host decisions; nothing here opens, canonicalizes or reads a path.
//!
//! A bridge frame that fails to parse as a [`NativeEvent`](crate::workspace_runtime::NativeEvent)
//! is a protocol error that ends the runtime, so [`NativeChatFile`] accepts any
//! JSON shape and [`NativeChatFile::into_event`] drops what it cannot use. A bad
//! `file` frame costs one chat file, never the session.

use std::fmt;
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// The largest inline payload, in decoded bytes.
pub const MAX_INLINE_BYTES: usize = 20 * 1024 * 1024;
/// Base64 length of [`MAX_INLINE_BYTES`] (padding included).
const MAX_INLINE_BASE64_CHARS: usize = MAX_INLINE_BYTES.div_ceil(3) * 4;
const MAX_PATH_CHARS: usize = 4096;
const MAX_BLOCK_ID_CHARS: usize = 256;
/// The media types a bridge may send inline; the host still sniffs the bytes.
const INLINE_MEDIA_TYPES: [&str; 13] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/ogg",
    "audio/webm",
    "audio/mp4",
    "audio/aac",
    "audio/flac",
];

/// How a file relates to the block that names it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatFileOrigin {
    /// An edit tool wrote or changed it.
    Written,
    /// A read tool opened it.
    Read,
    /// A generation tool saved it (for example an image).
    Generated,
    /// The agent handed it back as media or a `file:` link.
    Returned,
}

impl ChatFileOrigin {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "written" => Some(Self::Written),
            "read" => Some(Self::Read),
            "generated" => Some(Self::Generated),
            "returned" => Some(Self::Returned),
            _ => None,
        }
    }
}

/// Where the reported file's content is.
#[derive(Clone, Eq, PartialEq)]
pub enum ChatFileSource {
    /// An absolute path exactly as the bridge reported it. The host must
    /// canonicalize it and check it against its own policy before any use.
    Path(PathBuf),
    /// Bytes the agent returned without a file.
    Inline { mime: String, bytes: Vec<u8> },
}

impl fmt::Debug for ChatFileSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Neither a path nor bytes belong in a log line.
        match self {
            Self::Path(_) => formatter.write_str("Path(..)"),
            Self::Inline { mime, bytes } => formatter
                .debug_struct("Inline")
                .field("mime", mime)
                .field("len", &bytes.len())
                .finish(),
        }
    }
}

/// One file a session's native agent reported. `session_id` is the session the
/// runtime delivered the frame for; the frame itself carries none.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatFileEvent {
    pub session_id: String,
    /// The id of the tool block the file belongs to.
    pub block_id: String,
    pub source: ChatFileSource,
    pub origin: ChatFileOrigin,
}

/// The wire form of a `file` event. Every field is optional and every wrong
/// type reads as absent, so the frame always parses; see the module docs.
#[derive(Clone, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeChatFile {
    #[serde(
        default,
        deserialize_with = "lenient_string",
        skip_serializing_if = "Option::is_none"
    )]
    block_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient_string",
        skip_serializing_if = "Option::is_none"
    )]
    origin: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient_string",
        skip_serializing_if = "Option::is_none"
    )]
    path: Option<String>,
    /// Informational for a path (an image extension); the host sniffs content.
    #[serde(
        default,
        deserialize_with = "lenient_string",
        skip_serializing_if = "Option::is_none"
    )]
    mime_type: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient_inline",
        skip_serializing_if = "Option::is_none"
    )]
    inline: Option<NativeChatFileInline>,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeChatFileInline {
    mime_type: String,
    base64: String,
}

impl fmt::Debug for NativeChatFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeChatFile")
            .field("origin", &self.origin)
            .field("has_path", &self.path.is_some())
            .field("has_inline", &self.inline.is_some())
            .finish()
    }
}

fn lenient_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => Some(text),
        _ => None,
    })
}

fn lenient_inline<'de, D>(deserializer: D) -> Result<Option<NativeChatFileInline>, D::Error>
where
    D: Deserializer<'de>,
{
    let Value::Object(mut fields) = Value::deserialize(deserializer)? else {
        return Ok(None);
    };
    Ok(match (fields.remove("mimeType"), fields.remove("base64")) {
        (Some(Value::String(mime_type)), Some(Value::String(base64))) => {
            Some(NativeChatFileInline { mime_type, base64 })
        }
        _ => None,
    })
}

impl NativeChatFile {
    /// Checks the frame and decodes inline bytes. `None` drops a frame that is
    /// unusable: no block id, an unknown origin, no source or two, a relative,
    /// oversized or NUL-bearing path, an unlisted media type, bytes that are
    /// not base64 or exceed [`MAX_INLINE_BYTES`].
    ///
    /// Decoding can take a few milliseconds for a large payload: call it from
    /// the forwarder, not from the transport reader.
    #[must_use]
    pub fn into_event(self, session_id: &str) -> Option<ChatFileEvent> {
        let block_id = self.block_id?;
        if block_id.is_empty() || block_id.len() > MAX_BLOCK_ID_CHARS {
            return None;
        }
        let origin = ChatFileOrigin::parse(&self.origin?)?;
        let source = match (self.path, self.inline) {
            (Some(path), None) => {
                if path.is_empty() || path.len() > MAX_PATH_CHARS || path.contains('\0') {
                    return None;
                }
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return None;
                }
                ChatFileSource::Path(path)
            }
            (None, Some(inline)) => {
                let mime = inline.mime_type.to_ascii_lowercase();
                if !INLINE_MEDIA_TYPES.contains(&mime.as_str())
                    || inline.base64.is_empty()
                    || inline.base64.len() > MAX_INLINE_BASE64_CHARS
                {
                    return None;
                }
                let bytes = STANDARD.decode(inline.base64.as_bytes()).ok()?;
                if bytes.is_empty() || bytes.len() > MAX_INLINE_BYTES {
                    return None;
                }
                ChatFileSource::Inline { mime, bytes }
            }
            // Neither source, or two: the frame is ambiguous.
            _ => return None,
        };
        Some(ChatFileEvent {
            session_id: session_id.to_owned(),
            block_id,
            source,
            origin,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_runtime::NativeEvent;
    use serde_json::json;

    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAH8wD3AAAAABJRU5ErkJggg==";

    fn parse(frame: Value) -> NativeChatFile {
        match serde_json::from_value::<NativeEvent>(frame).expect("a file frame always parses") {
            NativeEvent::File(file) => file,
            other => panic!("expected a file event, got {other:?}"),
        }
    }

    fn absolute(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn a_path_frame_becomes_a_typed_event_for_the_delivering_session() {
        let path = absolute("chat-file-test.png");
        let file = parse(json!({
            "type": "file",
            "blockId": "pi-tool-abc",
            "path": path.to_string_lossy(),
            "origin": "written",
            "mimeType": "image/png",
        }));
        assert_eq!(
            file.into_event("session-1"),
            Some(ChatFileEvent {
                session_id: "session-1".to_owned(),
                block_id: "pi-tool-abc".to_owned(),
                source: ChatFileSource::Path(path),
                origin: ChatFileOrigin::Written,
            })
        );
    }

    #[test]
    fn an_inline_frame_is_decoded_and_every_origin_is_known() {
        for (name, origin) in [
            ("written", ChatFileOrigin::Written),
            ("read", ChatFileOrigin::Read),
            ("generated", ChatFileOrigin::Generated),
            ("returned", ChatFileOrigin::Returned),
        ] {
            let event = parse(json!({
                "type": "file",
                "blockId": "codex-item",
                "origin": name,
                "inline": { "mimeType": "IMAGE/PNG", "base64": TINY_PNG },
            }))
            .into_event("s")
            .expect("inline frame");
            assert_eq!(event.origin, origin);
            let ChatFileSource::Inline { mime, bytes } = event.source else {
                panic!("expected inline bytes");
            };
            assert_eq!(mime, "image/png");
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        }
    }

    #[test]
    fn a_malformed_frame_still_parses_and_is_dropped() {
        let path = absolute("chat-file-test.png")
            .to_string_lossy()
            .into_owned();
        let oversized = "A".repeat(MAX_INLINE_BASE64_CHARS + 4);
        let cases = [
            json!({ "type": "file" }),
            json!({ "type": "file", "origin": "written", "path": path }),
            json!({ "type": "file", "blockId": "", "origin": "written", "path": path }),
            json!({ "type": "file", "blockId": 5, "origin": "written", "path": path }),
            json!({ "type": "file", "blockId": "b", "origin": "deleted", "path": path }),
            json!({ "type": "file", "blockId": "b", "origin": "written" }),
            json!({ "type": "file", "blockId": "b", "origin": "written", "path": "relative/x.png" }),
            json!({ "type": "file", "blockId": "b", "origin": "written", "path": "" }),
            json!({ "type": "file", "blockId": "b", "origin": "written", "path": format!("{path}\u{0}") }),
            json!({ "type": "file", "blockId": "b", "origin": "written", "path": path, "inline": { "mimeType": "image/png", "base64": TINY_PNG } }),
            json!({ "type": "file", "blockId": "b", "origin": "returned", "inline": "text" }),
            json!({ "type": "file", "blockId": "b", "origin": "returned", "inline": { "mimeType": "image/svg+xml", "base64": TINY_PNG } }),
            json!({ "type": "file", "blockId": "b", "origin": "returned", "inline": { "mimeType": "image/png", "base64": "not base64!" } }),
            json!({ "type": "file", "blockId": "b", "origin": "returned", "inline": { "mimeType": "image/png", "base64": "" } }),
            json!({ "type": "file", "blockId": "b", "origin": "returned", "inline": { "mimeType": "image/png", "base64": oversized } }),
            json!({ "type": "file", "blockId": "b", "origin": "returned", "inline": { "mimeType": 7, "base64": TINY_PNG } }),
            json!({ "type": "file", "blockId": "b", "origin": "written", "path": path, "future": [1, 2] }),
        ];
        let kept = cases
            .into_iter()
            .map(|frame| parse(frame).into_event("s").is_some())
            .collect::<Vec<_>>();
        // Only the last frame is usable: an unknown extra field is ignored.
        let mut expected = vec![false; kept.len()];
        *expected.last_mut().expect("cases") = true;
        assert_eq!(kept, expected);
    }

    #[test]
    fn the_wire_form_round_trips_and_debug_hides_paths_and_bytes() {
        let path = absolute("secret-name.png");
        let frame = json!({
            "type": "file",
            "blockId": "b",
            "path": path.to_string_lossy(),
            "origin": "read",
        });
        let event: NativeEvent = serde_json::from_value(frame.clone()).expect("file frame");
        assert_eq!(serde_json::to_value(&event).expect("serializes"), frame);

        let debug = format!("{event:?}");
        assert!(!debug.contains("secret-name"), "{debug}");
        let typed = parse(frame).into_event("s").expect("typed");
        assert!(!format!("{typed:?}").contains("secret-name"));
        let inline = ChatFileSource::Inline {
            mime: "image/png".to_owned(),
            bytes: vec![1, 2, 3],
        };
        assert_eq!(
            format!("{inline:?}"),
            "Inline { mime: \"image/png\", len: 3 }"
        );
    }
}
