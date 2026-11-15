//! The exact inputs of the pairing derivations. `nano-host-v1.ts` documents
//! the same encodings and `nano-host-v1.json` holds vectors for them.
//!
//! Every variable part is a *field*: `|`, the length of the part in bytes as
//! ASCII decimal without leading zeros, `:`, then the bytes of the part. A
//! string is a fixed ASCII label followed by its fields in a fixed order, so
//! two different sequences of parts never give the same string. Keys, the
//! channel binding and the TLS keys appear as unpadded base64url text; the TLS
//! keys as the text of their exact 44-byte SubjectPublicKeyInfo.
//!
//! - SAS info (HKDF-SHA-256 info of the 6 SAS bytes):
//!   `NANO_HOST_PAIRING_SAS_V1` + protocol + key agreement + hash + MAC
//!   method + SAS method + account + host + controller device + target TLS
//!   key + controller TLS key + target ephemeral key + controller ephemeral
//!   key + channel binding.
//! - MAC info of a sender (HKDF-SHA-256 info of its HMAC-SHA-256 key):
//!   `NANO_HOST_PAIRING_MAC_V1` + protocol + sender role + account + host +
//!   controller device + target TLS key + controller TLS key + channel
//!   binding + `tls-spki`. The MAC input is the sender's TLS key text, taken
//!   by the receiver from its own TLS observation, so a valid MAC proves the
//!   sender authenticated with exactly the key the receiver saw.
//! - Commitment (`pairing.accept`): SHA-256 of
//!   `NANO_HOST_PAIRING_COMMITMENT_V1` + target ephemeral key + the exact
//!   bytes of `pairing.start`.
//!
//! Both sides build these strings from their own view: the target from its
//! account, its host registration and the relay's channel announcement, the
//! controller from its account, the host it chose and its own device. Any
//! difference, including a TLS key substituted by a relay that terminated
//! TLS, changes the SAS and the MAC keys.

use ring::digest;

use super::{HASH, KEY_AGREEMENT, MAC_METHOD, PairingIdentity, SAS_METHOD};
use crate::PROTOCOL;
use crate::b64;
use crate::identity::Spki;
use crate::tls::{CHANNEL_BINDING_LEN, ChannelEndpoints, ChannelRole};

/// The label of the SAS info.
pub const SAS_LABEL: &str = "NANO_HOST_PAIRING_SAS_V1";
/// The label of the MAC info.
pub const MAC_LABEL: &str = "NANO_HOST_PAIRING_MAC_V1";
/// The label of the commitment.
pub const COMMITMENT_LABEL: &str = "NANO_HOST_PAIRING_COMMITMENT_V1";
/// The key identifier inside the MAC info.
pub const MAC_KEY_ID: &str = "tls-spki";

/// Appends one field.
pub fn push_field(out: &mut String, value: &str) {
    out.push('|');
    out.push_str(&value.len().to_string());
    out.push(':');
    out.push_str(value);
}

/// What both sides must have seen identically.
#[derive(Clone, PartialEq, Eq)]
pub struct Transcript {
    /// The account, the target host and the controller device.
    pub identity: PairingIdentity,
    /// The target's TLS key.
    pub target_spki: Spki,
    /// The controller's TLS key.
    pub controller_spki: Spki,
    /// The RFC 9266 `tls-exporter` value of the pairing channel.
    pub channel_binding: [u8; CHANNEL_BINDING_LEN],
}

impl std::fmt::Debug for Transcript {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Transcript")
            .field("identity", &self.identity)
            .field("target_spki", &self.target_spki)
            .field("controller_spki", &self.controller_spki)
            .finish_non_exhaustive()
    }
}

/// The two ephemeral X25519 public keys, by role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EphemeralKeys {
    pub target: [u8; 32],
    pub controller: [u8; 32],
}

impl Transcript {
    /// This side's view of a pairing channel.
    #[must_use]
    pub fn new(identity: PairingIdentity, endpoints: &ChannelEndpoints) -> Self {
        Self {
            identity,
            target_spki: endpoints.target_spki().clone(),
            controller_spki: endpoints.controller_spki().clone(),
            channel_binding: endpoints.channel_binding,
        }
    }

    fn push_parties(&self, out: &mut String) {
        push_field(out, self.identity.account_id.as_str());
        push_field(out, self.identity.host_id.as_str());
        push_field(out, self.identity.controller_device_id.as_str());
        push_field(out, &self.target_spki.to_text());
        push_field(out, &self.controller_spki.to_text());
    }

    /// The HKDF info of the SAS bytes.
    #[must_use]
    pub fn sas_info(&self, keys: &EphemeralKeys) -> String {
        let mut out = String::from(SAS_LABEL);
        for part in [PROTOCOL, KEY_AGREEMENT, HASH, MAC_METHOD, SAS_METHOD] {
            push_field(&mut out, part);
        }
        self.push_parties(&mut out);
        push_field(&mut out, &b64::encode(&keys.target));
        push_field(&mut out, &b64::encode(&keys.controller));
        push_field(&mut out, &b64::encode(&self.channel_binding));
        out
    }

    /// The HKDF info of `sender`'s MAC key.
    #[must_use]
    pub fn mac_info(&self, sender: ChannelRole) -> String {
        let mut out = String::from(MAC_LABEL);
        push_field(&mut out, PROTOCOL);
        push_field(&mut out, sender.as_str());
        self.push_parties(&mut out);
        push_field(&mut out, &b64::encode(&self.channel_binding));
        push_field(&mut out, MAC_KEY_ID);
        out
    }

    /// The MAC input of `sender`: its TLS key as this side observed it.
    #[must_use]
    pub fn mac_input(&self, sender: ChannelRole) -> String {
        match sender {
            ChannelRole::Target => self.target_spki.to_text(),
            ChannelRole::Controller => self.controller_spki.to_text(),
        }
    }
}

/// The commitment of `pairing.accept` to the target's ephemeral key and the
/// exact `pairing.start` bytes.
#[must_use]
pub fn commitment(target_key: &[u8; 32], start: &[u8]) -> [u8; 32] {
    let key = b64::encode(target_key);
    let mut context = digest::Context::new(&digest::SHA256);
    context.update(COMMITMENT_LABEL.as_bytes());
    context.update(format!("|{}:{key}|{}:", key.len(), start.len()).as_bytes());
    context.update(start);
    let mut out = [0u8; 32];
    out.copy_from_slice(context.finish().as_ref());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{AccountId, DeviceId, HostId};

    fn sample() -> (Transcript, EphemeralKeys) {
        let rfc_8032_test_1: [u8; 32] = [
            0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64,
            0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68,
            0xf7, 0x07, 0x51, 0x1a,
        ];
        let transcript = Transcript {
            identity: PairingIdentity {
                account_id: AccountId::parse("usr_synthetic01").expect("account"),
                host_id: HostId::parse("hst_AAECAwQFBgcICQoLDA0ODw").expect("host"),
                controller_device_id: DeviceId::parse("dev_EBESExQVFhcYGRobHB0eHw")
                    .expect("device"),
            },
            target_spki: Spki::from_text(
                "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE",
            )
            .expect("RFC 8410 key"),
            controller_spki: Spki::from_ed25519_key(&rfc_8032_test_1).expect("RFC 8032 key"),
            channel_binding: [1; CHANNEL_BINDING_LEN],
        };
        let keys = EphemeralKeys {
            target: [2; 32],
            controller: [3; 32],
        };
        (transcript, keys)
    }

    #[test]
    fn every_part_of_the_transcript_changes_both_derivations() {
        let (base, keys) = sample();
        let mut variants = Vec::new();
        let mut changed = base.clone();
        changed.identity.account_id = AccountId::parse("usr_synthetic02").expect("account");
        variants.push(changed);
        let mut changed = base.clone();
        changed.identity.host_id = HostId::parse("hst_EBESExQVFhcYGRobHB0eHw").expect("host");
        variants.push(changed);
        let mut changed = base.clone();
        changed.identity.controller_device_id =
            DeviceId::parse("dev_AAECAwQFBgcICQoLDA0ODw").expect("device");
        variants.push(changed);
        let mut changed = base.clone();
        std::mem::swap(&mut changed.target_spki, &mut changed.controller_spki);
        variants.push(changed);
        let mut changed = base.clone();
        changed.channel_binding[31] ^= 1;
        variants.push(changed);
        for variant in &variants {
            assert_ne!(variant.sas_info(&keys), base.sas_info(&keys), "{variant:?}");
            for role in [ChannelRole::Target, ChannelRole::Controller] {
                assert_ne!(variant.mac_info(role), base.mac_info(role), "{variant:?}");
            }
        }
        // The ephemeral keys enter the SAS info in role order; the MAC keys
        // depend on them through the agreement itself.
        let swapped = EphemeralKeys {
            target: keys.controller,
            controller: keys.target,
        };
        assert_ne!(base.sas_info(&swapped), base.sas_info(&keys));
        // The roles separate the MAC keys and the MAC inputs.
        assert_ne!(
            base.mac_info(ChannelRole::Target),
            base.mac_info(ChannelRole::Controller)
        );
        assert_ne!(
            base.mac_input(ChannelRole::Target),
            base.mac_input(ChannelRole::Controller)
        );
    }

    #[test]
    fn fields_carry_their_byte_length() {
        let mut out = String::from("L");
        push_field(&mut out, "");
        push_field(&mut out, "ab|1:c");
        push_field(&mut out, "é");
        assert_eq!(out, "L|0:|6:ab|1:c|2:é");
    }

    #[test]
    fn the_commitment_hashes_the_label_the_key_field_and_the_start_field() {
        let key = [7u8; 32];
        let start = br#"{"type":"pairing.start"}"#;
        let mut expected = String::from(COMMITMENT_LABEL);
        push_field(&mut expected, &b64::encode(&key));
        push_field(&mut expected, std::str::from_utf8(start).expect("utf-8"));
        let digest = digest::digest(&digest::SHA256, expected.as_bytes());
        assert_eq!(commitment(&key, start).as_slice(), digest.as_ref());
        assert_ne!(commitment(&key, start), commitment(&[8u8; 32], start));
        assert_ne!(commitment(&key, start), commitment(&key, b"{}"));
    }
}
