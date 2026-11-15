//! Pairing: commitment-first SAS verification with bilateral human
//! confirmation, inside a TLS channel that only observes keys.
//!
//! Both computers are present. The controller (TLS client) opens a pairing
//! channel to a target whose owner opened the pairing window on it. TLS
//! authenticates nothing yet ([`crate::tls::PeerKeyPolicy::ObserveForPairing`]):
//! the relay could terminate it on both sides with its own keys. The SAS
//! exchange detects that:
//!
//! 1. controller → `pairing.start` with its view of the account, the target
//!    host and its own device, and the fixed v1 algorithms;
//! 2. target → `pairing.accept` with a commitment to its ephemeral X25519 key
//!    and the exact `pairing.start` bytes (it checks the identities first);
//! 3. controller → `pairing.key`, its ephemeral key;
//! 4. target → `pairing.key`; the controller checks the commitment;
//! 5. both derive the short authentication string from the X25519 secret
//!    with a transcript of the account, host, controller device, both exact
//!    TLS keys, both ephemeral keys, the TLS channel binding and the
//!    protocol ([`transcript`]). The controller shows it; the owner types it
//!    on the target, which compares in constant time. A wrong code ends the
//!    attempt: a new attempt is a new channel with new ephemeral keys.
//! 6. target → `pairing.mac` over its TLS key, only after the codes matched;
//! 7. the controller verifies it and asks its owner whether the target showed
//!    that the codes match. Only after "yes" does it persist the pin and
//!    send its own `pairing.mac`; without this second confirmation a relay
//!    that ran its own exchange with the controller could send a valid MAC
//!    and get its key pinned;
//! 8. the target verifies the controller's MAC, records the grant durably and
//!    sends `pairing.paired` with the grant identifier.
//!
//! Any other message, a message out of turn, a non-canonical message, a
//! non-contributory or malformed ephemeral key, a failed commitment or MAC,
//! or `pairing.cancel` ends pairing with nothing stored. The state machines
//! never retry by themselves.
//!
//! The X25519 agreement (with the contributory check), the HKDF-SHA-256
//! derivation of the SAS bytes and of the MAC keys, and HMAC-SHA-256 come
//! from vodozemac 0.11.2 (`vodozemac::sas`), as in Matrix `m.sas.v1` with
//! `curve25519-hkdf-sha256` and `hkdf-hmac-sha256.v2`. The message flow and
//! the transcript are this crate's own versioned protocol: they follow the
//! Matrix design but are not Matrix-interoperable.

mod controller;
mod target;
pub mod transcript;

use std::fmt;

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq as _;
use thiserror::Error;
use vodozemac::Curve25519PublicKey;
use vodozemac::sas::{EstablishedSas, Mac, Sas};

pub use controller::{ControllerPairing, ControllerStep, VerifiedTarget};
pub use target::{TargetPairing, TargetStep, VerifiedController};
use transcript::{EphemeralKeys, Transcript};

use crate::b64;
use crate::ids::{AccountId, DeviceId, GrantId, HostId};
use crate::tls::ChannelRole;

/// The key agreement of v1 (Matrix `curve25519-hkdf-sha256`).
pub const KEY_AGREEMENT: &str = "curve25519-hkdf-sha256";
/// The commitment hash of v1.
pub const HASH: &str = "sha256";
/// The MAC method of v1 (Matrix `hkdf-hmac-sha256.v2`).
pub const MAC_METHOD: &str = "hkdf-hmac-sha256.v2";
/// The SAS presentation of v1.
pub const SAS_METHOD: &str = "decimal";

/// The identities both sides must agree on. Each side builds it from its own
/// knowledge: the target from its sign-in, its host registration and the
/// relay's channel announcement; the controller from its sign-in, the host it
/// chose and its own device. A difference ends pairing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingIdentity {
    /// The signed-in account.
    pub account_id: AccountId,
    /// The target execution host.
    pub host_id: HostId,
    /// The controller's OAuth device.
    pub controller_device_id: DeviceId,
}

/// Why pairing ended, on the wire and locally.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CancelCode {
    /// An owner declined or closed the pairing dialog.
    User,
    /// The code typed on the target differs from the target's code.
    MismatchedSas,
    /// The target's key does not match its commitment.
    MismatchedCommitment,
    /// A MAC did not verify.
    KeyMismatch,
    /// The account, host or controller device differs from this side's view.
    IdentityMismatch,
    /// Algorithms other than the v1 set.
    UnknownMethod,
    /// A malformed or non-contributory ephemeral key.
    InvalidKey,
    /// A message out of turn or from the wrong role.
    UnexpectedMessage,
    /// Not a canonical pairing message.
    InvalidMessage,
    /// The target's owner has no pairing window open.
    WindowClosed,
}

/// The `pairing.cancel` a target sends on a pairing channel that arrives
/// while its owner has no pairing window open.
#[must_use]
pub fn window_closed_notice() -> Vec<u8> {
    PairingMessage::Cancel {
        code: CancelCode::WindowClosed,
    }
    .encode()
}

/// Who ended pairing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Party {
    /// This side.
    Local,
    /// The other side, with `pairing.cancel`.
    Peer,
}

/// A pairing failure.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum PairingError {
    /// Pairing is over and nothing may be stored. `notify_peer` is the
    /// `pairing.cancel` to send, when this side ended it and has not sent one.
    #[error("pairing ended: {code:?} ({by:?})")]
    Aborted {
        code: CancelCode,
        by: Party,
        notify_peer: Option<Vec<u8>>,
    },
    /// The typed text is not three numbers from 1000 to 9191. The attempt
    /// goes on: the owner may correct the typing.
    #[error("the typed code is not three numbers from 1000 to 9191")]
    InvalidCode,
    /// The local call does not fit the current step; nothing changed.
    #[error("this step is not expected now")]
    OutOfTurn,
    /// The channel is not an observing channel of this role.
    #[error("the channel is not a pairing channel of this role")]
    NotAPairingChannel,
    /// The system random generator failed; pairing did not start.
    #[error("the system random generator failed")]
    Random,
}

/// A message of the pairing channel. Its encoding is canonical: exactly the
/// bytes `serde_json` produces for it, fields in declaration order, no
/// whitespace. Anything else is refused, so both sides hash the same bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum PairingMessage {
    #[serde(rename = "pairing.start")]
    Start {
        key_agreement: String,
        hash: String,
        mac: String,
        sas: String,
        account_id: AccountId,
        host_id: HostId,
        controller_device_id: DeviceId,
    },
    #[serde(rename = "pairing.accept")]
    Accept { commitment: String },
    #[serde(rename = "pairing.key")]
    Key { key: String },
    #[serde(rename = "pairing.mac")]
    Mac { mac: String },
    #[serde(rename = "pairing.paired")]
    Paired { grant_id: GrantId },
    #[serde(rename = "pairing.cancel")]
    Cancel { code: CancelCode },
}

impl PairingMessage {
    /// The canonical bytes. Serializing these field types cannot fail; an
    /// empty result would be refused by the framing as an empty message.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// Parses canonical bytes.
    ///
    /// # Errors
    /// [`CancelCode::InvalidMessage`] for anything else.
    pub fn decode(bytes: &[u8]) -> Result<Self, CancelCode> {
        let message: Self =
            serde_json::from_slice(bytes).map_err(|_| CancelCode::InvalidMessage)?;
        if message.encode() != bytes {
            return Err(CancelCode::InvalidMessage);
        }
        Ok(message)
    }
}

/// The short authentication string: three numbers from 1000 to 9191 (Matrix
/// `decimal`, 39 bits).
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SasCode([u16; 3]);

impl SasCode {
    pub(crate) fn from_decimals((first, second, third): (u16, u16, u16)) -> Self {
        Self([first, second, third])
    }

    /// The three numbers, for display.
    #[must_use]
    pub fn numbers(&self) -> [u16; 3] {
        self.0
    }

    /// Parses what the owner typed: twelve ASCII digits, optionally grouped
    /// with spaces or hyphens, as three numbers from 1000 to 9191.
    #[must_use]
    pub fn parse(typed: &str) -> Option<Self> {
        let digits: Vec<u8> = typed
            .bytes()
            .filter(|byte| !matches!(byte, b' ' | b'-'))
            .collect();
        if digits.len() != 12 || !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let mut numbers = [0u16; 3];
        for (number, group) in numbers.iter_mut().zip(digits.chunks(4)) {
            *number = group
                .iter()
                .fold(0u16, |value, digit| value * 10 + u16::from(digit - b'0'));
            if !(1000..=9191).contains(number) {
                return None;
            }
        }
        Some(Self(numbers))
    }

    fn bytes(&self) -> [u8; 6] {
        let [first, second, third] = self.0.map(u16::to_be_bytes);
        [first[0], first[1], second[0], second[1], third[0], third[1]]
    }

    pub(crate) fn matches(&self, other: &Self) -> bool {
        bool::from(self.bytes().ct_eq(&other.bytes()))
    }
}

impl fmt::Display for SasCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [first, second, third] = self.0;
        write!(formatter, "{first} {second} {third}")
    }
}

impl fmt::Debug for SasCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "SasCode({self})")
    }
}

/// Parses an ephemeral X25519 public key of the wire: unpadded base64url of
/// its 32 bytes in the canonical RFC 7748 encoding (the little-endian
/// u-coordinate below 2^255 - 19, so the unused top bit is clear). Honest
/// peers only produce this encoding; the X25519 function itself is
/// vodozemac's.
pub(crate) fn parse_ephemeral(text: &str) -> Result<[u8; 32], CancelCode> {
    let key = b64::decode_array::<32>(text).ok_or(CancelCode::InvalidKey)?;
    let at_least_prime =
        key[31] == 0x7f && key[1..31].iter().all(|byte| *byte == 0xff) && key[0] >= 0xed;
    if key[31] & 0x80 != 0 || at_least_prime {
        return Err(CancelCode::InvalidKey);
    }
    Ok(key)
}

/// Parses a SHA-256 commitment of the wire.
pub(crate) fn parse_digest(text: &str) -> Option<[u8; 32]> {
    b64::decode_array::<32>(text)
}

pub(crate) fn digests_equal(first: &[u8; 32], second: &[u8; 32]) -> bool {
    bool::from(first.ct_eq(second))
}

/// The X25519 agreement with vodozemac's contributory check. A peer key
/// equal to this side's own key (a reflected message) is refused as well.
pub(crate) fn establish(
    sas: Sas,
    own: &[u8; 32],
    peer: &[u8; 32],
) -> Result<EstablishedSas, CancelCode> {
    if digests_equal(own, peer) {
        return Err(CancelCode::InvalidKey);
    }
    sas.diffie_hellman(Curve25519PublicKey::from_bytes(*peer))
        .map_err(|_| CancelCode::InvalidKey)
}

pub(crate) fn sas_code(
    sas: &EstablishedSas,
    transcript: &Transcript,
    keys: &EphemeralKeys,
) -> SasCode {
    SasCode::from_decimals(sas.bytes(&transcript.sas_info(keys)).decimals())
}

/// The `pairing.mac` of `sender` over its own TLS key.
pub(crate) fn mac_message(
    sas: &EstablishedSas,
    transcript: &Transcript,
    sender: ChannelRole,
) -> Vec<u8> {
    let mac = sas.calculate_mac(&transcript.mac_input(sender), &transcript.mac_info(sender));
    PairingMessage::Mac {
        mac: b64::encode(mac.as_bytes()),
    }
    .encode()
}

/// Verifies `sender`'s MAC over the TLS key this side observed for it, in
/// constant time (vodozemac `verify_mac`).
pub(crate) fn verify_mac(
    sas: &EstablishedSas,
    transcript: &Transcript,
    sender: ChannelRole,
    text: &str,
) -> Result<(), CancelCode> {
    let tag = b64::decode_array::<32>(text).ok_or(CancelCode::InvalidMessage)?;
    sas.verify_mac(
        &transcript.mac_input(sender),
        &transcript.mac_info(sender),
        &Mac::from_slice(&tag),
    )
    .map_err(|_| CancelCode::KeyMismatch)
}

/// The Matrix `decimal` mapping of SAS bytes (5 bytes, 13 bits per number,
/// plus 1000), used to check vodozemac's output against the specification.
#[cfg(test)]
pub(crate) fn decimals_from_bytes(bytes: &[u8; 6]) -> (u16, u16, u16) {
    let [b0, b1, b2, b3, b4, _] = bytes.map(u16::from);
    (
        ((b0 << 5) | (b1 >> 3)) + 1000,
        (((b1 & 0x7) << 10) | (b2 << 2) | (b3 >> 6)) + 1000,
        (((b3 & 0x3f) << 7) | (b4 >> 1)) + 1000,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_codes_are_twelve_digits_in_the_decimal_range() {
        let code = SasCode::parse("1234 5678-9012").expect("code");
        assert_eq!(code.numbers(), [1234, 5678, 9012]);
        assert_eq!(code.to_string(), "1234 5678 9012");
        assert_eq!(SasCode::parse("123456789012"), Some(code));
        for refused in [
            "",
            "1234 5678 901",
            "1234 5678 90123",
            "0999 1000 1000",
            "9192 1000 1000",
            "1234 5678 9O12",
            "１２３４ 5678 9012",
        ] {
            assert_eq!(SasCode::parse(refused), None, "{refused}");
        }
        assert!(code.matches(&SasCode::parse("1234-5678-9012").expect("code")));
        assert!(!code.matches(&SasCode::parse("1234 5678 9013").expect("code")));
    }

    #[test]
    fn the_decimal_mapping_matches_the_specification_bounds() {
        assert_eq!(decimals_from_bytes(&[0; 6]), (1000, 1000, 1000));
        assert_eq!(decimals_from_bytes(&[0xff; 6]), (9191, 9191, 9191));
    }

    #[test]
    fn pairing_messages_accept_only_their_canonical_bytes() {
        let message = PairingMessage::Key {
            key: String::from("AAEC"),
        };
        let bytes = message.encode();
        assert_eq!(bytes, br#"{"type":"pairing.key","key":"AAEC"}"#);
        assert_eq!(PairingMessage::decode(&bytes), Ok(message));
        for refused in [
            &br#"{"type":"pairing.key", "key":"AAEC"}"#[..],
            br#"{"key":"AAEC","type":"pairing.key"}"#,
            br#"{"type":"pairing.key","key":"AAEC","extra":1}"#,
            // The same text with an escaped character.
            br#"{"type":"pairing.key","key":"\u0041AEC"}"#,
            br#"{"type":"pairing.unknown"}"#,
            br#"{"type":"pairing.key","key":"AAEC"} "#,
        ] {
            assert_eq!(
                PairingMessage::decode(refused),
                Err(CancelCode::InvalidMessage),
                "{}",
                String::from_utf8_lossy(refused)
            );
        }
    }
}
