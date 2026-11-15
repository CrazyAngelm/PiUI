//! Identifiers of nano-host/1 and the identifiers derived from a command.
//!
//! The server issues `dev_` OAuth device identifiers (its `GenerateDeviceId`:
//! the prefix and 128 random bits as unpadded base64url) and the `hst_`
//! execution host identifiers of `nano-hosts-v1.ts` in the same shape. The
//! target host creates the `hgr_` grant identifiers itself, in the same shape.
//! The account identifier is the server's opaque `NanoUserV1.id`. A command
//! identifier is a random UUID version 4 created by the controller.
//!
//! None of these identifiers is a secret or an authority: a grant is
//! authority only on the target that recorded it, and only on a channel
//! authenticated by the grant's pinned controller key.

use std::fmt;

use ring::digest;
use ring::rand::{SecureRandom as _, SystemRandom};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;
use uuid::Uuid;

use crate::b64;

/// Why an identifier was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum IdError {
    #[error("the identifier is not `{prefix}` followed by 128 bits of unpadded base64url")]
    Shape { prefix: &'static str },
    #[error("the account identifier is empty or contains a control character")]
    Account,
    #[error("the command identifier is not a canonical random (version 4) UUID")]
    Command,
    #[error("the system random generator failed")]
    Random,
}

fn parse_prefixed(value: &str, prefix: &'static str) -> Result<(), IdError> {
    value
        .strip_prefix(prefix)
        .and_then(b64::decode_array::<16>)
        .map(|_| ())
        .ok_or(IdError::Shape { prefix })
}

macro_rules! prefixed_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            /// The identifier prefix.
            pub const PREFIX: &'static str = $prefix;

            /// Accepts exactly the prefix and 22 unpadded base64url characters
            /// that encode 128 bits.
            ///
            /// # Errors
            /// [`IdError::Shape`] for any other text.
            pub fn parse(value: &str) -> Result<Self, IdError> {
                parse_prefixed(value, $prefix).map(|()| Self(value.to_owned()))
            }

            /// The identifier text.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                Self::parse(&value).map_err(serde::de::Error::custom)
            }
        }
    };
}

prefixed_id!(
    /// A server-issued OAuth device identifier (`dev_…`). It names a signed-in
    /// installation; it is never execution authority by itself.
    DeviceId,
    "dev_"
);

prefixed_id!(
    /// A server-issued execution host identifier (`hst_…`).
    HostId,
    "hst_"
);

prefixed_id!(
    /// A grant identifier (`hgr_…`) that the target host creates when its
    /// owner completes pairing with one controller.
    GrantId,
    "hgr_"
);

impl GrantId {
    /// A new grant identifier: the prefix and 128 bits from the system random
    /// generator, the server's `GenerateDeviceId` shape.
    ///
    /// # Errors
    /// [`IdError::Random`] when the system generator fails.
    pub fn generate() -> Result<Self, IdError> {
        let mut bytes = [0u8; 16];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| IdError::Random)?;
        Ok(Self(format!("{}{}", Self::PREFIX, b64::encode(&bytes))))
    }
}

/// The server's account identifier (`NanoUserV1.id`). Opaque: the only
/// requirements are that it is non-empty and has no control character.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AccountId(String);

impl AccountId {
    /// # Errors
    /// [`IdError::Account`] for an empty value or a control character.
    pub fn parse(value: &str) -> Result<Self, IdError> {
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(IdError::Account);
        }
        Ok(Self(value.to_owned()))
    }

    /// The identifier text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AccountId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for AccountId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for AccountId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// A command identifier: a random (version 4, RFC 9562 variant) UUID in its
/// canonical lowercase hyphenated text. Its text is also a journal file name.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CommandId(Uuid);

impl CommandId {
    /// A new random command identifier (the controller side).
    #[must_use]
    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    /// # Errors
    /// [`IdError::Command`] unless `value` is the canonical text of a version 4
    /// UUID with the RFC 9562 variant.
    pub fn parse(value: &str) -> Result<Self, IdError> {
        let uuid = Uuid::parse_str(value).map_err(|_| IdError::Command)?;
        let canonical = uuid.hyphenated().to_string();
        if canonical != value
            || uuid.get_version_num() != 4
            || uuid.get_variant() != uuid::Variant::RFC4122
        {
            return Err(IdError::Command);
        }
        Ok(Self(uuid))
    }

    /// The canonical text.
    #[must_use]
    pub fn text(&self) -> String {
        self.0.hyphenated().to_string()
    }
}

impl fmt::Debug for CommandId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0.hyphenated(), formatter)
    }
}

impl fmt::Display for CommandId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0.hyphenated(), formatter)
    }
}

impl Serialize for CommandId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0.hyphenated())
    }
}

impl<'de> Deserialize<'de> for CommandId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// The owner store a derived identifier is used in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DerivedDomain {
    /// The session identifier of a remotely created session.
    Session,
    /// The request identifier of a remotely queued composer message.
    Composer,
    /// The run identifier of a remotely started run.
    Run,
}

impl DerivedDomain {
    /// The domain text inside the derivation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Composer => "composer",
            Self::Run => "run",
        }
    }
}

/// The identifier an owner store receives for `command` of `grant`:
/// `SHA-256("nano-host-v1" 0x00 domain 0x00 grantId 0x00 commandId)`, the
/// first 16 bytes as a version 8 UUID (RFC 9562 section 5.8).
///
/// It is deterministic, so a repeated command with the same identifier
/// reaches the owner store with the same key and the store's own duplicate
/// refusal holds even when the journal was lost. It is not secret. A
/// controller cannot address an existing local identifier with it: the
/// controller chooses only the command identifier, the hash chooses the rest,
/// and every local identifier is a version 4 UUID.
#[must_use]
pub fn derive_id(domain: DerivedDomain, grant: &GrantId, command: &CommandId) -> Uuid {
    let mut context = digest::Context::new(&digest::SHA256);
    for (index, part) in [
        b"nano-host-v1".as_slice(),
        domain.as_str().as_bytes(),
        grant.as_str().as_bytes(),
        command.text().as_bytes(),
    ]
    .iter()
    .enumerate()
    {
        if index > 0 {
            context.update(&[0]);
        }
        context.update(part);
    }
    uuid_v8_from_digest(context.finish().as_ref())
}

/// The RFC 9562 version 8 UUID of the first 16 bytes of a SHA-256 digest.
pub(crate) fn uuid_v8_from_digest(digest: &[u8]) -> Uuid {
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_custom_bytes(bytes).into_uuid()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixed_identifiers_accept_only_the_server_shape() {
        let id = "dev_AAECAwQFBgcICQoLDA0ODw";
        assert_eq!(
            DeviceId::parse(id).map(|value| value.to_string()),
            Ok(id.to_owned())
        );
        for refused in [
            "dev_synthetic01",
            "dev_AAECAwQFBgcICQoLDA0ODw==",
            "dev_AAECAwQFBgcICQoLDA0ODx",
            "hst_AAECAwQFBgcICQoLDA0ODw",
            "dev_",
            "",
        ] {
            assert_eq!(
                DeviceId::parse(refused),
                Err(IdError::Shape { prefix: "dev_" }),
                "{refused}"
            );
        }
        assert!(HostId::parse("hst_AAECAwQFBgcICQoLDA0ODw").is_ok());
        assert!(GrantId::parse("hgr_AAECAwQFBgcICQoLDA0ODw").is_ok());
    }

    #[test]
    fn generated_grant_identifiers_have_the_grant_shape_and_differ() {
        let first = GrantId::generate().expect("random");
        let second = GrantId::generate().expect("random");
        assert!(GrantId::parse(first.as_str()).is_ok());
        assert_ne!(first, second);
    }

    #[test]
    fn command_identifiers_are_canonical_version_4_uuids() {
        let generated = CommandId::generate();
        assert_eq!(CommandId::parse(&generated.text()), Ok(generated));
        let canonical = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert!(CommandId::parse(canonical).is_ok());
        for refused in [
            "0F8FAD5B-D9CB-469F-A165-70867728950E",
            "0f8fad5bd9cb469fa16570867728950e",
            "{0f8fad5b-d9cb-469f-a165-70867728950e}",
            "urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e",
            // Version 8 and the nil UUID are not command identifiers.
            "0f8fad5b-d9cb-869f-a165-70867728950e",
            "00000000-0000-0000-0000-000000000000",
            // Version 4 with the Microsoft variant.
            "0f8fad5b-d9cb-469f-c165-70867728950e",
        ] {
            assert_eq!(
                CommandId::parse(refused),
                Err(IdError::Command),
                "{refused}"
            );
        }
    }

    #[test]
    fn account_identifiers_are_opaque_but_printable() {
        assert!(AccountId::parse("usr_synthetic01").is_ok());
        assert_eq!(AccountId::parse(""), Err(IdError::Account));
        assert_eq!(AccountId::parse("usr\n1"), Err(IdError::Account));
    }

    #[test]
    fn the_version_8_construction_matches_the_rfc_9562_example() {
        // RFC 9562 appendix B.2: SHA-256 over the DNS namespace identifier and
        // "www.example.com", truncated to 128 bits, version 8.
        let namespace_dns = Uuid::parse_str("6ba7b810-9dad-11d1-80b4-00c04fd430c8").expect("uuid");
        let mut input = namespace_dns.as_bytes().to_vec();
        input.extend_from_slice(b"www.example.com");
        let digest = digest::digest(&digest::SHA256, &input);
        assert_eq!(
            uuid_v8_from_digest(digest.as_ref())
                .hyphenated()
                .to_string(),
            "5c146b14-3c52-8afd-938a-375d0df1fbf6"
        );
    }

    #[test]
    fn derived_identifiers_separate_domains_grants_and_commands() {
        let grant = GrantId::parse("hgr_AAECAwQFBgcICQoLDA0ODw").expect("grant");
        let other_grant = GrantId::parse("hgr_EBESExQVFhcYGRobHB0eHw").expect("grant");
        let command = CommandId::parse("0f8fad5b-d9cb-469f-a165-70867728950e").expect("command");
        let session = derive_id(DerivedDomain::Session, &grant, &command);
        assert_eq!(session.get_version_num(), 8);
        assert_eq!(session, derive_id(DerivedDomain::Session, &grant, &command));
        assert_ne!(session, derive_id(DerivedDomain::Run, &grant, &command));
        assert_ne!(
            session,
            derive_id(DerivedDomain::Session, &other_grant, &command)
        );
    }
}
