//! Browser keys, the pairing code and the signed proof of `nano-remote` v1.
//!
//! A browser holds a non-extractable ECDSA P-256 key. Its public key travels
//! as the 65-byte uncompressed point in unpadded base64url. The proof is an
//! ECDSA/SHA-256 signature in the fixed 64-byte `r || s` form (what WebCrypto
//! produces) over [`proof_message`], which binds it to this device and to one
//! relay session.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};
use sha2::{Digest, Sha256};

use crate::pkce::random_bytes;

/// An uncompressed P-256 point: `0x04 || x || y`.
pub type RawKey = [u8; KEY_BYTES];

/// Length of an uncompressed P-256 point.
pub const KEY_BYTES: usize = 65;
/// Length of a challenge nonce before encoding.
pub const NONCE_BYTES: usize = 32;
/// Length of an ECDSA P-256 signature in the fixed form.
pub const SIGNATURE_BYTES: usize = 64;
/// Longest label kept (characters).
pub const MAX_LABEL_CHARS: usize = 60;
/// The label of a browser that sent none.
pub const DEFAULT_LABEL: &str = "Browser";

/// Decodes a public key; `None` unless it is a 65-byte uncompressed point.
/// This does not prove the point is on the curve: [`verify_proof`] does.
pub fn decode_key(text: &str) -> Option<RawKey> {
    // 65 bytes encode to 87 characters; refuse anything longer unread.
    if text.len() > 128 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(text).ok()?;
    let key: RawKey = bytes.try_into().ok()?;
    (key[0] == 0x04).then_some(key)
}

/// The unpadded base64url text of a public key.
pub fn encode_key(key: &RawKey) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

/// A fresh challenge nonce: 32 random bytes as unpadded base64url. `None`
/// when the operating system's random source is unavailable.
pub fn new_nonce() -> Option<String> {
    let bytes = random_bytes::<NONCE_BYTES>().ok()?;
    Some(URL_SAFE_NO_PAD.encode(bytes))
}

/// The text a browser signs: device id, viewer id and nonce bind the proof to
/// one relay session (`nanoRemoteProofMessage`).
pub fn proof_message(device_id: &str, viewer_id: &str, nonce: &str) -> String {
    format!("nano-remote-v1\n{device_id}\n{viewer_id}\n{nonce}")
}

/// Whether `signature` (unpadded base64url, 64 bytes) is a valid ECDSA P-256
/// signature of `message` by `key`.
pub fn verify_proof(key: &RawKey, message: &[u8], signature: &str) -> bool {
    if signature.len() > 128 {
        return false;
    }
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    if signature.len() != SIGNATURE_BYTES {
        return false;
    }
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, key.as_slice())
        .verify(message, &signature)
        .is_ok()
}

/// The six-digit code both screens show: the decimal of the first four bytes
/// of `SHA-256(rawKey || nonce)`, big-endian, modulo 1,000,000, zero-padded.
/// `None` when `nonce` is not unpadded base64url.
pub fn pairing_code(key: &RawKey, nonce: &str) -> Option<String> {
    let nonce = URL_SAFE_NO_PAD.decode(nonce).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(&nonce);
    let digest = hasher.finalize();
    let head = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    Some(format!("{:06}", head % 1_000_000))
}

/// The first 16 hex characters of `SHA-256(rawKey)`: a short, stable name for
/// a browser key. Not a secret and not an authenticator.
pub fn fingerprint(key: &RawKey) -> String {
    let digest = Sha256::digest(key);
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A label fit to show a person: no control, format or bidirectional
/// override characters, trimmed, at most [`MAX_LABEL_CHARS`] characters;
/// [`DEFAULT_LABEL`] when nothing is left. The text is untrusted.
pub fn sanitize_label(label: &str) -> String {
    let kept: String = label
        .chars()
        .filter(|c| !c.is_control() && !is_invisible_format(*c))
        .collect();
    let kept: String = kept.trim().chars().take(MAX_LABEL_CHARS).collect();
    let kept = kept.trim();
    if kept.is_empty() {
        DEFAULT_LABEL.to_owned()
    } else {
        kept.to_owned()
    }
}

fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}
