//! Offline intake for a fixed, observed npm evidence packet.
//!
//! This module accepts only caller-supplied bytes. It has no filesystem,
//! environment, process, network, runtime-verification, or supervisor surface.
//! A successfully parsed packet is still observation only and can produce only
//! [`EvidenceDisposition::NonAuthorizing`].

#![allow(
    dead_code,
    reason = "Phase 0 retains this crate-private intake as an offline observation fixture until a separately approved release-policy slice selects any evidence input."
)]

use serde::Deserialize;
use serde::de::{self, DeserializeOwned, Deserializer, MapAccess, SeqAccess, Visitor};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

const MAX_RECEIPT_BYTES: usize = 16 * 1024;
const MAX_ATTACHMENTS: usize = 4;
const MAX_ATTACHMENT_BYTES: usize = 32 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: usize = 96 * 1024;
const MAX_ATTACHMENT_NAME_BYTES: usize = 96;

const OBSERVED_PACKAGE: &str = "@earendil-works/pi-coding-agent";
const OBSERVED_VERSION: &str = "0.81.1";
const OBSERVED_SRI: &str = "sha512-r6ovAsZOgAqbC/aU6s+/dPnv/sGZBuWyZNvi3pXjpbuX5wvp3XvGkQI7/VLvX2o9XpmpFaPUxKNym1WfkN/P8A==";
const OBSERVED_SIGNATURE_KEY_ID: &str = "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U";
const OBSERVED_REPOSITORY: &str = "https://github.com/earendil-works/pi";
const OBSERVED_TAG: &str = "refs/tags/v0.81.1";
const OBSERVED_COMMIT: &str = "20be4b18d4c57487f8993d2762bace129f0cf7c6";
const OBSERVED_WORKFLOW: &str = ".github/workflows/build-binaries.yml";
const SANITIZED_LOCAL_SUMMARY: &str = "sanitized-local-summary";
const UPSTREAM_CRYPTOGRAPHIC_VERIFICATION: &str = "not-retained";
const EXPECTED_ATTACHMENT_NAMES: [&str; MAX_ATTACHMENTS] = [
    "isolated-graph.json",
    "npm-audit-signatures.json",
    "registry-version.json",
    "slsa-provenance.json",
];

/// Byte-only attachment input. Names are constrained metadata, never paths.
#[derive(Clone, Copy)]
pub(crate) struct EvidenceAttachment<'a> {
    pub(crate) name: &'a [u8],
    pub(crate) bytes: &'a [u8],
}

/// The only disposition that this observed packet can yield.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EvidenceDisposition {
    NonAuthorizing,
}

/// Opaque confirmation that one bounded, fixed observation packet was coherent.
/// It deliberately retains no caller bytes or upstream subject fields.
#[derive(Eq, PartialEq)]
pub(crate) struct ObservedNpmEvidence(());

impl ObservedNpmEvidence {
    #[must_use]
    pub(crate) const fn disposition(&self) -> EvidenceDisposition {
        EvidenceDisposition::NonAuthorizing
    }
}

impl fmt::Debug for ObservedNpmEvidence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ObservedNpmEvidence(<redacted>)")
    }
}

/// Path-free, content-free categories for evidence-intake failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EvidenceIntakeError {
    ReceiptTooLarge,
    AttachmentCountExceeded,
    AttachmentTooLarge,
    AttachmentAggregateTooLarge,
    ReceiptDuplicateKey,
    ReceiptMalformed,
    AttachmentDuplicateKey,
    AttachmentMalformed,
    UnsafeAttachmentName,
    AttachmentManifestMismatch,
    AttachmentDigestMismatch,
    SubjectMismatch,
    CrossCheckMismatch,
}

impl fmt::Display for EvidenceIntakeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ReceiptTooLarge => {
                "observed upstream evidence receipt exceeds the safe size limit"
            }
            Self::AttachmentCountExceeded => "observed upstream evidence has too many attachments",
            Self::AttachmentTooLarge => {
                "observed upstream evidence attachment exceeds the safe size limit"
            }
            Self::AttachmentAggregateTooLarge => {
                "observed upstream evidence attachments exceed the aggregate safe size limit"
            }
            Self::ReceiptDuplicateKey => {
                "observed upstream evidence receipt has a duplicate JSON key"
            }
            Self::ReceiptMalformed => "observed upstream evidence receipt is malformed",
            Self::AttachmentDuplicateKey => {
                "observed upstream evidence attachment has a duplicate JSON key"
            }
            Self::AttachmentMalformed => "observed upstream evidence attachment is malformed",
            Self::UnsafeAttachmentName => "observed upstream evidence attachment name is unsafe",
            Self::AttachmentManifestMismatch => {
                "observed upstream evidence attachment manifest does not match supplied bytes"
            }
            Self::AttachmentDigestMismatch => {
                "observed upstream evidence attachment digest does not match the receipt"
            }
            Self::SubjectMismatch => {
                "observed upstream evidence subject does not match this packet"
            }
            Self::CrossCheckMismatch => "observed upstream evidence records are inconsistent",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for EvidenceIntakeError {}

/// Intakes one fixed v1 npm observation packet from bytes already held by a
/// caller. This function is deliberately not an artifact verifier and never
/// produces an authorization, provenance bundle, or supervisor input.
pub(crate) fn intake_npm_packet(
    receipt_bytes: &[u8],
    attachments: &[EvidenceAttachment<'_>],
) -> Result<ObservedNpmEvidence, EvidenceIntakeError> {
    if receipt_bytes.len() > MAX_RECEIPT_BYTES {
        return Err(EvidenceIntakeError::ReceiptTooLarge);
    }
    validate_attachment_limits(attachments)?;

    let receipt: ReceiptWire = parse_strict(receipt_bytes).map_err(map_receipt_parse_error)?;
    validate_receipt(&receipt)?;
    validate_manifest_bijection(&receipt.attachments, attachments)?;

    let graph: IsolatedGraphWire = parse_attachment(attachments[0].bytes)?;
    let audit: NpmAuditSignaturesWire = parse_attachment(attachments[1].bytes)?;
    let registry: RegistryVersionWire = parse_attachment(attachments[2].bytes)?;
    let slsa: SlsaProvenanceWire = parse_attachment(attachments[3].bytes)?;

    validate_graph(&graph, &receipt.subject)?;
    validate_audit(&audit, &receipt.subject)?;
    validate_registry(&registry, &receipt.subject)?;
    validate_slsa(&slsa, &receipt.subject)?;

    let sri_digest = decode_sha512_sri(&receipt.subject.integrity)
        .ok_or(EvidenceIntakeError::CrossCheckMismatch)?;
    let attestation_digest =
        decode_hex::<64>(&slsa.subject.sha512).ok_or(EvidenceIntakeError::CrossCheckMismatch)?;
    if sri_digest != attestation_digest {
        return Err(EvidenceIntakeError::CrossCheckMismatch);
    }

    Ok(ObservedNpmEvidence(()))
}

fn validate_attachment_limits(
    attachments: &[EvidenceAttachment<'_>],
) -> Result<(), EvidenceIntakeError> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(EvidenceIntakeError::AttachmentCountExceeded);
    }

    let mut aggregate = 0_usize;
    for attachment in attachments {
        if !safe_attachment_name(attachment.name) {
            return Err(EvidenceIntakeError::UnsafeAttachmentName);
        }
        if attachment.bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(EvidenceIntakeError::AttachmentTooLarge);
        }
        aggregate = aggregate
            .checked_add(attachment.bytes.len())
            .ok_or(EvidenceIntakeError::AttachmentAggregateTooLarge)?;
        if aggregate > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err(EvidenceIntakeError::AttachmentAggregateTooLarge);
        }
    }
    Ok(())
}

fn validate_receipt(receipt: &ReceiptWire) -> Result<(), EvidenceIntakeError> {
    if receipt.schema != "piui-observed-upstream-evidence" || receipt.version != 1 {
        return Err(EvidenceIntakeError::SubjectMismatch);
    }
    if receipt.collection.method != "isolated-npm-audit-signatures"
        || receipt.collection.record_kind != SANITIZED_LOCAL_SUMMARY
        || receipt.collection.upstream_cryptographic_verification
            != UPSTREAM_CRYPTOGRAPHIC_VERIFICATION
        || !receipt.collection.isolated_graph
        || !receipt.collection.ignore_scripts
        || receipt.collection.npm_audit_signatures != "observed-success"
    {
        return Err(EvidenceIntakeError::SubjectMismatch);
    }
    validate_subject(&receipt.subject)?;

    if receipt.attachments.len() != EXPECTED_ATTACHMENT_NAMES.len() {
        return Err(EvidenceIntakeError::AttachmentManifestMismatch);
    }
    let mut seen = BTreeSet::new();
    for (entry, expected_name) in receipt.attachments.iter().zip(EXPECTED_ATTACHMENT_NAMES) {
        if !safe_attachment_name(entry.name.as_bytes())
            || entry.name != expected_name
            || !seen.insert(entry.name.as_str())
            || decode_hex::<32>(&entry.sha256).is_none()
        {
            return Err(EvidenceIntakeError::AttachmentManifestMismatch);
        }
    }
    Ok(())
}

fn validate_subject(subject: &SubjectWire) -> Result<(), EvidenceIntakeError> {
    if subject.package != OBSERVED_PACKAGE
        || subject.package_version != OBSERVED_VERSION
        || subject.integrity != OBSERVED_SRI
        || subject.signature_key_id != OBSERVED_SIGNATURE_KEY_ID
        || subject.repository != OBSERVED_REPOSITORY
        || subject.tag != OBSERVED_TAG
        || subject.commit != OBSERVED_COMMIT
        || subject.workflow != OBSERVED_WORKFLOW
    {
        return Err(EvidenceIntakeError::SubjectMismatch);
    }
    Ok(())
}

fn validate_manifest_bijection(
    manifest: &[AttachmentManifestWire],
    attachments: &[EvidenceAttachment<'_>],
) -> Result<(), EvidenceIntakeError> {
    if manifest.len() != attachments.len() {
        return Err(EvidenceIntakeError::AttachmentManifestMismatch);
    }

    for (entry, attachment) in manifest.iter().zip(attachments) {
        if entry.name.as_bytes() != attachment.name
            || u64::try_from(attachment.bytes.len()).ok() != Some(entry.bytes)
        {
            return Err(EvidenceIntakeError::AttachmentManifestMismatch);
        }
        let expected_digest = decode_hex::<32>(&entry.sha256)
            .ok_or(EvidenceIntakeError::AttachmentManifestMismatch)?;
        let actual_digest: [u8; 32] = Sha256::digest(attachment.bytes).into();
        if actual_digest != expected_digest {
            return Err(EvidenceIntakeError::AttachmentDigestMismatch);
        }
    }
    Ok(())
}

fn validate_graph(
    graph: &IsolatedGraphWire,
    subject: &SubjectWire,
) -> Result<(), EvidenceIntakeError> {
    if graph.schema != "piui-isolated-npm-graph-observation"
        || graph.version != 1
        || graph.record_kind != SANITIZED_LOCAL_SUMMARY
        || graph.package != subject.package
        || graph.package_version != subject.package_version
        || graph.lockfile_version != 3
        || !graph.isolated_graph
        || !graph.ignore_scripts
    {
        return Err(EvidenceIntakeError::CrossCheckMismatch);
    }
    Ok(())
}

fn validate_audit(
    audit: &NpmAuditSignaturesWire,
    subject: &SubjectWire,
) -> Result<(), EvidenceIntakeError> {
    if audit.schema != "piui-npm-audit-signatures-observation"
        || audit.version != 1
        || audit.record_kind != SANITIZED_LOCAL_SUMMARY
        || audit.package != subject.package
        || audit.package_version != subject.package_version
        || audit.integrity != subject.integrity
        || audit.signature_key_id != subject.signature_key_id
        || audit.npm_audit_signatures != "observed-success"
    {
        return Err(EvidenceIntakeError::CrossCheckMismatch);
    }
    Ok(())
}

fn validate_registry(
    registry: &RegistryVersionWire,
    subject: &SubjectWire,
) -> Result<(), EvidenceIntakeError> {
    if registry.schema != "piui-npm-registry-version-observation"
        || registry.version != 1
        || registry.record_kind != SANITIZED_LOCAL_SUMMARY
        || registry.package != subject.package
        || registry.package_version != subject.package_version
        || registry.integrity != subject.integrity
        || registry.signature_key_id != subject.signature_key_id
        || registry.repository != subject.repository
        || registry.git_head != subject.commit
    {
        return Err(EvidenceIntakeError::CrossCheckMismatch);
    }
    Ok(())
}

fn validate_slsa(
    slsa: &SlsaProvenanceWire,
    subject: &SubjectWire,
) -> Result<(), EvidenceIntakeError> {
    if slsa.schema != "piui-slsa-provenance-observation"
        || slsa.version != 1
        || slsa.record_kind != SANITIZED_LOCAL_SUMMARY
        || slsa.subject.package != subject.package
        || slsa.subject.package_version != subject.package_version
        || slsa.source.repository != subject.repository
        || slsa.source.tag != subject.tag
        || slsa.source.commit != subject.commit
        || slsa.source.workflow != subject.workflow
        || decode_hex::<64>(&slsa.subject.sha512).is_none()
    {
        return Err(EvidenceIntakeError::CrossCheckMismatch);
    }
    Ok(())
}

fn parse_attachment<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, EvidenceIntakeError> {
    parse_strict(bytes).map_err(|error| match error {
        StrictJsonError::DuplicateKey => EvidenceIntakeError::AttachmentDuplicateKey,
        StrictJsonError::Malformed => EvidenceIntakeError::AttachmentMalformed,
    })
}

fn map_receipt_parse_error(error: StrictJsonError) -> EvidenceIntakeError {
    match error {
        StrictJsonError::DuplicateKey => EvidenceIntakeError::ReceiptDuplicateKey,
        StrictJsonError::Malformed => EvidenceIntakeError::ReceiptMalformed,
    }
}

fn safe_attachment_name(bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && bytes.len() <= MAX_ATTACHMENT_NAME_BYTES
        && bytes.ends_with(b".json")
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn decode_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N.checked_mul(2)? {
        return None;
    }
    let mut decoded = [0_u8; N];
    for (index, output) in decoded.iter_mut().enumerate() {
        let high = hex_value(value.as_bytes()[index * 2])?;
        let low = hex_value(value.as_bytes()[index * 2 + 1])?;
        *output = (high << 4) | low;
    }
    Some(decoded)
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn decode_sha512_sri(value: &str) -> Option<[u8; 64]> {
    let encoded = value.strip_prefix("sha512-")?;
    let decoded = decode_standard_base64(encoded)?;
    decoded.try_into().ok()
}

fn decode_standard_base64(value: &str) -> Option<Vec<u8>> {
    let encoded = value.as_bytes();
    if encoded.is_empty() || encoded.len() % 4 != 0 {
        return None;
    }

    let mut decoded = Vec::with_capacity((encoded.len() / 4) * 3);
    for (group_index, group) in encoded.chunks_exact(4).enumerate() {
        let final_group = group_index + 1 == encoded.len() / 4;
        let first = base64_value(group[0])?;
        let second = base64_value(group[1])?;
        let third = if group[2] == b'=' {
            if !final_group || group[3] != b'=' {
                return None;
            }
            None
        } else {
            Some(base64_value(group[2])?)
        };
        let fourth = if group[3] == b'=' {
            if !final_group {
                return None;
            }
            None
        } else {
            Some(base64_value(group[3])?)
        };

        decoded.push((first << 2) | (second >> 4));
        if let Some(third) = third {
            decoded.push((second << 4) | (third >> 2));
            if let Some(fourth) = fourth {
                decoded.push((third << 6) | fourth);
            }
        } else if fourth.is_some() {
            return None;
        }
    }
    Some(decoded)
}

const fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiptWire {
    schema: String,
    version: u32,
    collection: CollectionWire,
    subject: SubjectWire,
    attachments: Vec<AttachmentManifestWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CollectionWire {
    method: String,
    record_kind: String,
    upstream_cryptographic_verification: String,
    isolated_graph: bool,
    ignore_scripts: bool,
    npm_audit_signatures: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubjectWire {
    #[serde(rename = "package")]
    package: String,
    package_version: String,
    integrity: String,
    signature_key_id: String,
    repository: String,
    tag: String,
    commit: String,
    workflow: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachmentManifestWire {
    name: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IsolatedGraphWire {
    schema: String,
    version: u32,
    record_kind: String,
    #[serde(rename = "package")]
    package: String,
    package_version: String,
    lockfile_version: u32,
    isolated_graph: bool,
    ignore_scripts: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NpmAuditSignaturesWire {
    schema: String,
    version: u32,
    record_kind: String,
    #[serde(rename = "package")]
    package: String,
    package_version: String,
    integrity: String,
    signature_key_id: String,
    npm_audit_signatures: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryVersionWire {
    schema: String,
    version: u32,
    record_kind: String,
    #[serde(rename = "package")]
    package: String,
    package_version: String,
    integrity: String,
    signature_key_id: String,
    repository: String,
    git_head: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SlsaProvenanceWire {
    schema: String,
    version: u32,
    record_kind: String,
    subject: SlsaSubjectWire,
    source: SlsaSourceWire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SlsaSubjectWire {
    #[serde(rename = "package")]
    package: String,
    package_version: String,
    sha512: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SlsaSourceWire {
    repository: String,
    tag: String,
    commit: String,
    workflow: String,
}

enum StrictJsonError {
    DuplicateKey,
    Malformed,
}

fn parse_strict<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, StrictJsonError> {
    serde_json::from_slice::<DuplicateFreeJson>(bytes).map_err(|error| {
        if error.to_string().contains("duplicate JSON key") {
            StrictJsonError::DuplicateKey
        } else {
            StrictJsonError::Malformed
        }
    })?;
    serde_json::from_slice(bytes).map_err(|_| StrictJsonError::Malformed)
}

struct DuplicateFreeJson;

impl<'de> Deserialize<'de> for DuplicateFreeJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(DuplicateFreeJson)
    }
}

impl<'de> Visitor<'de> for DuplicateFreeJson {
    type Value = Self;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Self)
    }

    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Self)
    }

    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Self)
    }

    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Self)
    }

    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Self)
    }

    fn visit_string<E>(self, _: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Self)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Self)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Self)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<Self>()?.is_some() {}
        Ok(Self)
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom("duplicate JSON key"));
            }
            map.next_value::<Self>()?;
        }
        Ok(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provenance::{ManagedRuntimeVerifier, ProvenanceError};

    fn receipt() -> &'static [u8] {
        include_bytes!(
            "../../../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/receipt-v1.json"
        )
    }

    fn packet_attachments() -> [EvidenceAttachment<'static>; MAX_ATTACHMENTS] {
        [
            EvidenceAttachment {
                name: b"isolated-graph.json",
                bytes: include_bytes!(
                    "../../../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/isolated-graph.json"
                ),
            },
            EvidenceAttachment {
                name: b"npm-audit-signatures.json",
                bytes: include_bytes!(
                    "../../../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/npm-audit-signatures.json"
                ),
            },
            EvidenceAttachment {
                name: b"registry-version.json",
                bytes: include_bytes!(
                    "../../../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/registry-version.json"
                ),
            },
            EvidenceAttachment {
                name: b"slsa-provenance.json",
                bytes: include_bytes!(
                    "../../../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/slsa-provenance.json"
                ),
            },
        ]
    }

    fn receipt_with_current_attachment_digests(attachments: &[EvidenceAttachment<'_>]) -> Vec<u8> {
        let mut value: serde_json::Value =
            serde_json::from_slice(receipt()).expect("checked-in receipt is JSON");
        let manifest = value
            .get_mut("attachments")
            .and_then(serde_json::Value::as_array_mut)
            .expect("checked-in receipt has attachments");
        for (entry, attachment) in manifest.iter_mut().zip(attachments) {
            entry["bytes"] = serde_json::Value::from(attachment.bytes.len() as u64);
            entry["sha256"] =
                serde_json::Value::from(format!("{:x}", Sha256::digest(attachment.bytes)));
        }
        serde_json::to_vec(&value).expect("receipt value is serializable")
    }

    fn append_root_member(bytes: &[u8], member: &[u8]) -> Vec<u8> {
        let closing = bytes
            .iter()
            .rposition(|byte| !byte.is_ascii_whitespace())
            .expect("test JSON is not empty");
        assert_eq!(bytes[closing], b'}', "test JSON has closing object");
        let mut result = bytes[..closing].to_vec();
        result.extend_from_slice(member);
        result.extend_from_slice(b"}\n");
        result
    }

    #[test]
    fn checked_in_packet_is_observed_and_non_authorizing() {
        let attachments = packet_attachments();
        let observed = intake_npm_packet(receipt(), &attachments).expect("packet is coherent");
        assert_eq!(observed.disposition(), EvidenceDisposition::NonAuthorizing);
        assert_eq!(format!("{observed:?}"), "ObservedNpmEvidence(<redacted>)");
    }

    #[test]
    fn attachment_mutation_is_rejected_by_the_receipt_digest() {
        let mut attachments = packet_attachments();
        let mut altered = attachments[1].bytes.to_vec();
        altered[0] ^= 1;
        attachments[1].bytes = &altered;
        assert_eq!(
            intake_npm_packet(receipt(), &attachments),
            Err(EvidenceIntakeError::AttachmentDigestMismatch)
        );
    }

    #[test]
    fn packet_requires_an_exact_manifest_order_bijection() {
        let attachments = packet_attachments();
        assert_eq!(
            intake_npm_packet(receipt(), &attachments[..3]),
            Err(EvidenceIntakeError::AttachmentManifestMismatch)
        );

        let mut extra = attachments.to_vec();
        extra.push(attachments[0]);
        assert_eq!(
            intake_npm_packet(receipt(), &extra),
            Err(EvidenceIntakeError::AttachmentCountExceeded)
        );

        let mut duplicate = attachments;
        duplicate[2] = duplicate[1];
        assert_eq!(
            intake_npm_packet(receipt(), &duplicate),
            Err(EvidenceIntakeError::AttachmentManifestMismatch)
        );

        let mut reordered = attachments;
        reordered.swap(0, 1);
        assert_eq!(
            intake_npm_packet(receipt(), &reordered),
            Err(EvidenceIntakeError::AttachmentManifestMismatch)
        );
    }

    #[test]
    fn duplicate_unknown_oversized_and_unsafe_input_fail_closed() {
        let attachments = packet_attachments();
        let duplicate = append_root_member(receipt(), b",\"schema\":\"repeat\"");
        assert_eq!(
            intake_npm_packet(&duplicate, &attachments),
            Err(EvidenceIntakeError::ReceiptDuplicateKey)
        );
        let unknown = append_root_member(receipt(), b",\"unexpected\":true");
        assert_eq!(
            intake_npm_packet(&unknown, &attachments),
            Err(EvidenceIntakeError::ReceiptMalformed)
        );

        let receipt_too_large = vec![b' '; MAX_RECEIPT_BYTES + 1];
        assert_eq!(
            intake_npm_packet(&receipt_too_large, &attachments),
            Err(EvidenceIntakeError::ReceiptTooLarge)
        );

        let oversized = vec![b'x'; MAX_ATTACHMENT_BYTES + 1];
        let oversized_attachment = [EvidenceAttachment {
            name: b"isolated-graph.json",
            bytes: &oversized,
        }];
        assert_eq!(
            intake_npm_packet(receipt(), &oversized_attachment),
            Err(EvidenceIntakeError::AttachmentTooLarge)
        );

        let mut unsafe_name = attachments;
        unsafe_name[0].name = b"C:\\sentinel\\isolated-graph.json";
        assert_eq!(
            intake_npm_packet(receipt(), &unsafe_name),
            Err(EvidenceIntakeError::UnsafeAttachmentName)
        );
    }

    #[test]
    fn subject_and_attestation_cross_checks_reject_mismatches() {
        let mut attachments = packet_attachments();
        let bad_slsa = String::from_utf8(attachments[3].bytes.to_vec())
            .expect("fixture is UTF-8")
            .replace("refs/tags/v0.81.1", "refs/tags/v0.81.0");
        attachments[3].bytes = bad_slsa.as_bytes();
        let receipt = receipt_with_current_attachment_digests(&attachments);
        assert_eq!(
            intake_npm_packet(&receipt, &attachments),
            Err(EvidenceIntakeError::CrossCheckMismatch)
        );

        let mut attachments = packet_attachments();
        let bad_audit = String::from_utf8(attachments[1].bytes.to_vec())
            .expect("fixture is UTF-8")
            .replace("\"observed-success\"", "\"observed-failure\"");
        attachments[1].bytes = bad_audit.as_bytes();
        let receipt = receipt_with_current_attachment_digests(&attachments);
        assert_eq!(
            intake_npm_packet(&receipt, &attachments),
            Err(EvidenceIntakeError::CrossCheckMismatch)
        );
    }

    #[test]
    fn error_debug_and_display_do_not_leak_sentinel_content() {
        let attachments = packet_attachments();
        let sentinel = "C:\\\\private\\\\auth-token";
        let unknown = append_root_member(
            receipt(),
            format!(",\"sentinel\":\"{sentinel}\"").as_bytes(),
        );
        let error = intake_npm_packet(&unknown, &attachments).expect_err("unknown key must fail");
        assert!(!error.to_string().contains(sentinel));
        assert!(!format!("{error:?}").contains(sentinel));
    }

    #[test]
    fn accepting_observation_does_not_add_production_trusted_keys() {
        let attachments = packet_attachments();
        intake_npm_packet(receipt(), &attachments).expect("packet is coherent");
        assert_eq!(
            ManagedRuntimeVerifier::production().verify_app_managed_bundle(".", b"{}", b""),
            Err(ProvenanceError::NoTrustedKeys)
        );
    }

    #[test]
    fn observation_module_has_no_runtime_or_supervisor_coupling() {
        let source = include_str!("upstream_evidence.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("module has a production section");
        for forbidden in [
            "std::fs",
            "std::process",
            "std::net",
            "Command",
            "TcpStream",
            "reqwest",
            "tauri",
            "VerifiedManagedRuntimeBundle",
            "ProbeAuthorization",
        ] {
            assert!(
                !source.contains(forbidden),
                "forbidden dependency: {forbidden}"
            );
        }
        assert!(!include_str!("supervisor.rs").contains("ObservedNpmEvidence"));
        assert!(!include_str!("provenance.rs").contains(OBSERVED_SIGNATURE_KEY_ID));
        assert!(!include_str!("lib.rs").contains("pub use upstream_evidence"));
    }
}
