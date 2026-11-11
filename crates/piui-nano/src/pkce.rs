//! PKCE (RFC 7636, S256), OAuth `state` and random keys from the OS RNG.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::error::NanoError;
use crate::secret::SecretString;

/// Fills a fixed-size array from the operating system's RNG.
///
/// # Errors
/// [`NanoError::SignInFailed`] when the OS RNG is unavailable.
pub fn random_bytes<const N: usize>() -> Result<[u8; N], NanoError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| NanoError::SignInFailed)?;
    Ok(bytes)
}

/// 32 random bytes encoded as unpadded base64url (43 characters, 256 bits).
///
/// Used for PKCE verifiers, `state` values and relay session keys.
///
/// # Errors
/// [`NanoError::SignInFailed`] when the OS RNG is unavailable.
pub fn random_token() -> Result<SecretString, NanoError> {
    let mut bytes = random_bytes::<32>()?;
    let token = URL_SAFE_NO_PAD.encode(bytes);
    bytes.fill(0);
    Ok(SecretString::new(token))
}

/// The S256 code challenge of a verifier: `BASE64URL(SHA256(ASCII(verifier)))`.
pub fn challenge_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// A PKCE verifier and its S256 challenge.
#[derive(Debug, Clone)]
pub struct PkcePair {
    /// Sent only to the token endpoint.
    pub verifier: SecretString,
    /// Sent in the authorization URL.
    pub challenge: String,
}

impl PkcePair {
    /// A fresh pair from 32 random bytes.
    ///
    /// # Errors
    /// [`NanoError::SignInFailed`] when the OS RNG is unavailable.
    pub fn generate() -> Result<Self, NanoError> {
        let verifier = random_token()?;
        let challenge = challenge_s256(verifier.expose());
        Ok(Self {
            verifier,
            challenge,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b_vector() {
        assert_eq!(
            challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_is_43_url_safe_characters_and_unique() {
        let a = PkcePair::generate().expect("rng");
        let b = PkcePair::generate().expect("rng");
        assert_eq!(a.verifier.expose().len(), 43);
        assert!(
            a.verifier
                .expose()
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        );
        assert_ne!(a.verifier.expose(), b.verifier.expose());
        assert_eq!(a.challenge, challenge_s256(a.verifier.expose()));
    }
}
