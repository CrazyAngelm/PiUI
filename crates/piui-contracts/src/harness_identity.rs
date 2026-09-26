//! Harness identity grammar v2 (ADR-028, ADR-034).
//!
//! v1 was the closed set of built-in harness names (`pi`, `prime-agent`,
//! `codex`, `hermes`, `claude-code`). v2 keeps every v1 value with its exact
//! meaning and adds `acp:<descriptor id>`: an Agent Client Protocol agent
//! described by one registry descriptor. A v1 parser rejects an `acp:` value
//! with an explicit error instead of misreading it; nothing is renamed.
//!
//! The descriptor id is a lowercase slug of at most
//! [`ACP_AGENT_ID_MAX_BYTES`] bytes: ASCII letters, digits and single inner
//! hyphens. It is stored inline, so identities stay `Copy`.

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use std::fmt;
use thiserror::Error;

/// Version of the harness identity grammar described above.
pub const HARNESS_IDENTITY_VERSION: u32 = 2;
/// Prefix of an ACP agent identity.
pub const ACP_HARNESS_PREFIX: &str = "acp:";
/// Longest descriptor id, in bytes.
pub const ACP_AGENT_ID_MAX_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
#[error("an ACP agent id is a lowercase slug of 1-32 letters, digits and inner hyphens")]
pub struct InvalidAcpAgentId;

/// Validated ACP descriptor id (`gemini-cli`), without the `acp:` prefix.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AcpAgentId {
    length: u8,
    bytes: [u8; ACP_AGENT_ID_MAX_BYTES],
}

impl AcpAgentId {
    /// Validates `slug`: `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$` without
    /// consecutive hyphens.
    pub fn new(slug: &str) -> Result<Self, InvalidAcpAgentId> {
        let raw = slug.as_bytes();
        let length = raw.len();
        if length == 0 || length > ACP_AGENT_ID_MAX_BYTES {
            return Err(InvalidAcpAgentId);
        }
        let allowed =
            |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-';
        if !raw.iter().all(allowed)
            || raw.first() == Some(&b'-')
            || raw.last() == Some(&b'-')
            || slug.contains("--")
        {
            return Err(InvalidAcpAgentId);
        }
        let mut bytes = [0_u8; ACP_AGENT_ID_MAX_BYTES];
        bytes[..length].copy_from_slice(raw);
        Ok(Self {
            length: u8::try_from(length).map_err(|_| InvalidAcpAgentId)?,
            bytes,
        })
    }

    /// Parses a full `acp:<slug>` harness identity.
    pub fn from_harness_id(value: &str) -> Result<Self, InvalidAcpAgentId> {
        value
            .strip_prefix(ACP_HARNESS_PREFIX)
            .ok_or(InvalidAcpAgentId)
            .and_then(Self::new)
    }

    /// The slug. Validation admits ASCII only, so the fallback never applies.
    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.bytes[..usize::from(self.length)]).unwrap_or_default()
    }

    /// The full harness identity, `acp:<slug>`.
    pub fn harness_id(&self) -> String {
        format!("{ACP_HARNESS_PREFIX}{}", self.as_str())
    }
}

impl fmt::Display for AcpAgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Debug for AcpAgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AcpAgentId")
            .field(&self.as_str())
            .finish()
    }
}

impl Serialize for AcpAgentId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AcpAgentId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(&value).map_err(de::Error::custom)
    }
}

/// Parses a harness identity with `builtin` names first, then `acp:<slug>`.
/// Shared by the runtime and orchestration identity enums so both accept
/// exactly the same grammar.
pub fn parse_harness_identity<T: Copy>(
    value: &str,
    builtin: &[(&str, T)],
    acp: impl FnOnce(AcpAgentId) -> T,
) -> Option<T> {
    if let Some((_, harness)) = builtin.iter().find(|(name, _)| *name == value) {
        return Some(*harness);
    }
    AcpAgentId::from_harness_id(value).ok().map(acp)
}

/// Serde visitor error text for an unknown harness identity.
pub fn unknown_harness_identity<E: de::Error>(value: &str, builtin: &[&str]) -> E {
    E::custom(format!(
        "unknown harness `{}`; expected one of {} or acp:<agent id>",
        value.chars().take(64).collect::<String>(),
        builtin.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_lowercase_bounded_and_hyphenated_inside() {
        for slug in [
            "gemini-cli",
            "a",
            "0",
            "qwen-code2",
            "x".repeat(32).as_str(),
        ] {
            let id = AcpAgentId::new(slug).expect(slug);
            assert_eq!(id.as_str(), slug);
            assert_eq!(id.harness_id(), format!("acp:{slug}"));
            assert_eq!(AcpAgentId::from_harness_id(&id.harness_id()), Ok(id));
        }
        for slug in [
            "",
            "Gemini",
            "gemini_cli",
            "-gemini",
            "gemini-",
            "gem--ini",
            "gemini cli",
            "gémini",
            "acp:gemini",
            "x".repeat(33).as_str(),
        ] {
            assert_eq!(AcpAgentId::new(slug), Err(InvalidAcpAgentId), "{slug:?}");
        }
        assert!(AcpAgentId::from_harness_id("gemini-cli").is_err());
        assert!(AcpAgentId::from_harness_id("ACP:gemini-cli").is_err());
    }

    #[test]
    fn serializes_as_the_bare_slug_and_debug_names_it() {
        let id = AcpAgentId::new("gemini-cli").expect("id");
        assert_eq!(serde_json::to_value(id).expect("json"), "gemini-cli");
        assert_eq!(
            serde_json::from_value::<AcpAgentId>(serde_json::json!("gemini-cli")).expect("id"),
            id
        );
        assert!(serde_json::from_value::<AcpAgentId>(serde_json::json!("Gemini")).is_err());
        assert_eq!(format!("{id:?}"), "AcpAgentId(\"gemini-cli\")");
        assert_eq!(id.to_string(), "gemini-cli");
    }

    #[test]
    fn shared_parser_prefers_builtin_names() {
        #[derive(Clone, Copy, Debug, PartialEq)]
        enum Kind {
            Pi,
            Acp(AcpAgentId),
        }
        let builtin = [("pi", Kind::Pi)];
        assert_eq!(
            parse_harness_identity("pi", &builtin, Kind::Acp),
            Some(Kind::Pi)
        );
        assert_eq!(
            parse_harness_identity("acp:pi", &builtin, Kind::Acp),
            Some(Kind::Acp(AcpAgentId::new("pi").expect("id")))
        );
        assert_eq!(parse_harness_identity("acp:", &builtin, Kind::Acp), None);
        assert_eq!(parse_harness_identity("claude", &builtin, Kind::Acp), None);
    }
}
