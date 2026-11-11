//! A string that holds a credential.

use std::fmt;

use subtle::ConstantTimeEq;
use zeroize::Zeroize;

/// A secret value (token, code, verifier, relay key).
///
/// `Debug` never prints the value, there is no `Display` and no `Serialize`,
/// and the memory is zeroed on drop. Read it only with [`SecretString::expose`]
/// at the point where it leaves the process on purpose (a request header or a
/// form field).
#[derive(Clone)]
pub struct SecretString(String);

impl SecretString {
    /// Wraps a secret value.
    pub fn new(value: String) -> Self {
        Self(value)
    }

    /// The secret value. Never log or persist the result.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Whether the value is empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Compares with `other` in constant time for equal lengths.
    pub fn ct_eq_bytes(&self, other: &[u8]) -> bool {
        bool::from(self.0.as_bytes().ct_eq(other))
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl PartialEq for SecretString {
    fn eq(&self, other: &Self) -> bool {
        self.ct_eq_bytes(other.0.as_bytes())
    }
}

impl Eq for SecretString {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let secret = SecretString::new("synthetic-secret".to_owned());
        let printed = format!("{secret:?}");
        assert!(!printed.contains("synthetic"));
        assert_eq!(printed, "SecretString(<redacted>)");
    }

    #[test]
    fn compares_by_value() {
        let a = SecretString::new("abc".to_owned());
        assert!(a.ct_eq_bytes(b"abc"));
        assert!(!a.ct_eq_bytes(b"abd"));
        assert!(!a.ct_eq_bytes(b"ab"));
        assert_eq!(a, SecretString::new("abc".to_owned()));
    }
}
