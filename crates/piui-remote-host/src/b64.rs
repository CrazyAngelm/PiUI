//! Strict unpadded base64url, the only binary text encoding of nano-host/1.
//!
//! Decoding accepts exactly the text [`encode`] produces: no padding, no
//! other alphabet, no non-zero trailing bits. Every binary value therefore
//! has one textual form, which the transcripts and the canonical message
//! check rely on.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub(crate) fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD.decode(text).ok()?;
    (encode(&bytes) == text).then_some(bytes)
}

pub(crate) fn decode_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    decode(text)?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_accepts_only_the_canonical_text() {
        assert_eq!(decode("AAE").as_deref(), Some(&[0u8, 1][..]));
        // Padding, the standard alphabet and non-zero trailing bits are refused.
        assert_eq!(decode("AAE="), None);
        assert_eq!(decode("+/8"), None);
        assert_eq!(decode("AAF"), None);
        assert_eq!(decode_array::<2>("AAE"), Some([0, 1]));
        assert_eq!(decode_array::<3>("AAE"), None);
    }
}
