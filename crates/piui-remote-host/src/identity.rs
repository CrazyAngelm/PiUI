//! The Ed25519 identity key of an installation and its custody.
//!
//! Each side of a channel authenticates with one Ed25519 key, presented in
//! TLS as a raw public key: its exact DER SubjectPublicKeyInfo ([`Spki`],
//! RFC 8410). A pin is that exact byte string.
//!
//! The private key exists only in memory and in an OS credential store. The
//! [`IdentitySecretStore`] abstraction declares which durable store holds the
//! secret; [`KeyCustody`] refuses a store that is not durable, so a platform
//! without a configured store (for example Linux without a Secret Service
//! backend compiled in) cannot enable the feature instead of silently keeping
//! a key that changes at every start. There is no file store for this secret
//! anywhere in this crate. The store must also give one owner at a time
//! exclusive access to its entry, across handles and processes, so that two
//! first uses cannot create two identities (see [`IdentitySecretStore`]).

use std::fmt;
use std::sync::Arc;

use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair as _};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use rustls::sign::{CertifiedKey, SigningKey};
use subtle::ConstantTimeEq as _;
use thiserror::Error;
use zeroize::Zeroizing;

use crate::b64;

/// The fixed DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410
/// section 4): `SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING }`.
pub const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// The length of an Ed25519 SubjectPublicKeyInfo.
pub const ED25519_SPKI_LEN: usize = 44;

/// Why a public key was refused as an identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum SpkiError {
    #[error("not the exact DER SubjectPublicKeyInfo of an Ed25519 key")]
    NotEd25519,
    #[error("the Ed25519 public key does not decode to a curve point")]
    InvalidPoint,
    #[error("the Ed25519 public key has small order")]
    SmallOrder,
    #[error("not the canonical unpadded base64url text of a SubjectPublicKeyInfo")]
    Text,
}

/// The exact DER SubjectPublicKeyInfo of a valid Ed25519 identity key.
///
/// Only the 44-byte RFC 8410 encoding is accepted, and its key must decode to
/// a point that is not of small order, so no weak key can be observed,
/// pinned or authenticated.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Spki([u8; ED25519_SPKI_LEN]);

impl Spki {
    /// # Errors
    /// [`SpkiError`] unless `der` is the exact encoding of a valid key.
    pub fn from_der(der: &[u8]) -> Result<Self, SpkiError> {
        let bytes: [u8; ED25519_SPKI_LEN] = der.try_into().map_err(|_| SpkiError::NotEd25519)?;
        if bytes[..ED25519_SPKI_PREFIX.len()] != ED25519_SPKI_PREFIX {
            return Err(SpkiError::NotEd25519);
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes[ED25519_SPKI_PREFIX.len()..]);
        check_ed25519_key(&key)?;
        Ok(Self(bytes))
    }

    /// The SubjectPublicKeyInfo of a raw Ed25519 public key.
    ///
    /// # Errors
    /// [`SpkiError::InvalidPoint`] or [`SpkiError::SmallOrder`].
    pub fn from_ed25519_key(key: &[u8; 32]) -> Result<Self, SpkiError> {
        check_ed25519_key(key)?;
        let mut bytes = [0u8; ED25519_SPKI_LEN];
        bytes[..ED25519_SPKI_PREFIX.len()].copy_from_slice(&ED25519_SPKI_PREFIX);
        bytes[ED25519_SPKI_PREFIX.len()..].copy_from_slice(key);
        Ok(Self(bytes))
    }

    /// Parses the canonical text form ([`Spki::to_text`]).
    ///
    /// # Errors
    /// [`SpkiError::Text`] for other text, or the DER errors.
    pub fn from_text(text: &str) -> Result<Self, SpkiError> {
        let der = b64::decode(text).ok_or(SpkiError::Text)?;
        Self::from_der(&der)
    }

    /// The DER bytes: what TLS carries and what a pin compares.
    #[must_use]
    pub fn as_der(&self) -> &[u8] {
        &self.0
    }

    /// The raw 32-byte Ed25519 public key.
    #[must_use]
    pub fn ed25519_key(&self) -> &[u8] {
        &self.0[ED25519_SPKI_PREFIX.len()..]
    }

    /// The canonical text form: unpadded base64url of the DER bytes. It is the
    /// form in transcripts, messages and stored pins.
    #[must_use]
    pub fn to_text(&self) -> String {
        b64::encode(&self.0)
    }
}

impl fmt::Debug for Spki {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Spki({})", self.to_text())
    }
}

impl serde::Serialize for Spki {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_text())
    }
}

impl<'de> serde::Deserialize<'de> for Spki {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::from_text(&text).map_err(serde::de::Error::custom)
    }
}

fn check_ed25519_key(key: &[u8; 32]) -> Result<(), SpkiError> {
    let point =
        ed25519_dalek::VerifyingKey::from_bytes(key).map_err(|_| SpkiError::InvalidPoint)?;
    if point.is_weak() {
        return Err(SpkiError::SmallOrder);
    }
    Ok(())
}

/// Why an identity key could not be created or used.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum IdentityError {
    #[error("the system random generator failed")]
    Random,
    #[error("the stored secret is not a PKCS#8 v2 Ed25519 private key")]
    InvalidPrivateKey,
    #[error("the private key's public key is not a valid identity: {0}")]
    PublicKey(SpkiError),
}

/// An Ed25519 identity key pair. Its secret is a PKCS#8 v2 document (RFC
/// 5958) held in zeroizing memory; `Debug` shows only the public key.
pub struct IdentityKey {
    pkcs8: Zeroizing<Vec<u8>>,
    spki: Spki,
    signing: Arc<dyn SigningKey>,
}

impl IdentityKey {
    /// A new key from the system random generator.
    ///
    /// # Errors
    /// [`IdentityError::Random`], or a key the checks refuse.
    pub fn generate() -> Result<Self, IdentityError> {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| IdentityError::Random)?;
        Self::from_pkcs8(document.as_ref())
    }

    /// Loads a key from its PKCS#8 v2 document. ring checks that the embedded
    /// public key belongs to the private key.
    ///
    /// # Errors
    /// [`IdentityError::InvalidPrivateKey`] or [`IdentityError::PublicKey`].
    pub fn from_pkcs8(pkcs8: &[u8]) -> Result<Self, IdentityError> {
        let pair =
            Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| IdentityError::InvalidPrivateKey)?;
        let public: [u8; 32] = pair
            .public_key()
            .as_ref()
            .try_into()
            .map_err(|_| IdentityError::InvalidPrivateKey)?;
        let spki = Spki::from_ed25519_key(&public).map_err(IdentityError::PublicKey)?;
        let signing = rustls::crypto::ring::sign::any_eddsa_type(&PrivatePkcs8KeyDer::from(pkcs8))
            .map_err(|_| IdentityError::InvalidPrivateKey)?;
        let presented = signing
            .public_key()
            .ok_or(IdentityError::InvalidPrivateKey)?;
        if presented.as_ref() != spki.as_der() {
            return Err(IdentityError::InvalidPrivateKey);
        }
        Ok(Self {
            pkcs8: Zeroizing::new(pkcs8.to_vec()),
            spki,
            signing,
        })
    }

    /// The public identity.
    #[must_use]
    pub fn spki(&self) -> &Spki {
        &self.spki
    }

    /// The TLS credential: the raw public key and its signer.
    pub(crate) fn certified_key(&self) -> Arc<CertifiedKey> {
        Arc::new(CertifiedKey::new(
            vec![CertificateDer::from(self.spki.as_der().to_vec())],
            Arc::clone(&self.signing),
        ))
    }

    /// The signer, for tests that pair it with another key.
    #[cfg(test)]
    pub(crate) fn signer_for_tests(&self) -> Arc<dyn SigningKey> {
        Arc::clone(&self.signing)
    }

    /// The secret document, only for the custody store.
    fn secret(&self) -> &[u8] {
        &self.pkcs8
    }
}

impl fmt::Debug for IdentityKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IdentityKey")
            .field("spki", &self.spki)
            .finish_non_exhaustive()
    }
}

/// A durable OS credential store that can keep the identity secret across
/// restarts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustodyBackend {
    /// The Windows Credential Manager (keyring `windows-native`).
    WindowsCredentialManager,
    /// The macOS Keychain (keyring `apple-native`).
    MacosKeychain,
    /// The freedesktop Secret Service. Its keyring backend is not compiled into
    /// the application yet: enabling it is a later root decision (ADR-080).
    SecretService,
    /// Test custody in process memory; it exists only in this crate's tests.
    #[cfg(test)]
    TestMemory,
}

/// Bytes of a secret, zeroized on drop; `Debug` never shows them.
pub struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    /// Takes ownership of `bytes`.
    #[must_use]
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// The secret bytes.
    #[must_use]
    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretBytes(..)")
    }
}

/// A store failure. It carries no detail of the store or the secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
#[error("the credential store failed")]
pub struct StoreError;

/// One entry of an OS credential store holding the identity secret. The
/// application implements it over the platform store; implementations are
/// blocking.
///
/// # Required ownership
///
/// The entry has at most one owner at a time, across every store value,
/// [`KeyCustody`] handle and process that reaches the same OS entry.
/// [`IdentitySecretStore::own`] waits until no one else owns the entry, or
/// fails, and only the [`OwnedSecretEntry`] it returns reads or changes the
/// entry until it is dropped. Custody runs each of its operations in one
/// ownership. Its first use (load, create, read back and, after a mismatch,
/// remove what it wrote) is therefore one exclusive transaction: two first
/// uses cannot both create a key, and a cleanup cannot remove a key that
/// another owner stored.
///
/// The platform stores do not provide this. keyring 3.6.3, which the
/// application already uses, replaces an existing entry on every write on
/// Windows, macOS and the Secret Service alike, and has neither a
/// create-if-absent nor a lock. An implementation must therefore add an
/// ownership that spans processes and ends with its owner's process, for
/// example an exclusive OS lock on an app-owned lock file that holds no
/// secret and is never deleted. A mutex per handle or per process is not
/// enough. No such implementation exists yet (ADR-080); this crate's tests
/// exercise the contract only with in-memory stores.
pub trait IdentitySecretStore: Send + Sync {
    /// The durable store this entry lives in, or `None` when this store would
    /// lose the secret on restart (a memory or mock store).
    fn durable_backend(&self) -> Option<CustodyBackend>;
    /// Exclusive ownership of the entry, as described above.
    ///
    /// # Errors
    /// [`StoreError`] when ownership cannot be taken; then nothing is read
    /// or changed.
    fn own(&self) -> Result<Box<dyn OwnedSecretEntry + '_>, StoreError>;
}

/// The exclusive access to the entry that [`IdentitySecretStore::own`]
/// returns. Dropping it ends the ownership.
pub trait OwnedSecretEntry {
    /// The stored secret, if any.
    ///
    /// # Errors
    /// [`StoreError`] when the store cannot be read.
    fn load(&self) -> Result<Option<SecretBytes>, StoreError>;
    /// Replaces the stored secret.
    ///
    /// # Errors
    /// [`StoreError`] when the store cannot be written.
    fn save(&mut self, secret: &[u8]) -> Result<(), StoreError>;
    /// Removes the secret; removing a missing secret succeeds.
    ///
    /// # Errors
    /// [`StoreError`] when the store cannot be written.
    fn delete(&mut self) -> Result<(), StoreError>;
}

/// Why custody of the identity key is unavailable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum CustodyError {
    #[error("no durable OS credential store is available, so the feature stays off")]
    NotDurable,
    #[error("the credential store failed")]
    Store,
    #[error("the stored identity secret is not a valid key")]
    StoredKeyInvalid,
    #[error("the credential store did not return the secret it accepted")]
    ReadBackMismatch,
    #[error("the identity key could not be created: {0}")]
    Identity(IdentityError),
}

impl From<StoreError> for CustodyError {
    fn from(_: StoreError) -> Self {
        Self::Store
    }
}

/// Custody of one identity key in a durable OS store. It fails closed: no
/// durable store, no identity, and the remote host stays off. Each operation
/// runs in one ownership of the store entry ([`IdentitySecretStore::own`]).
pub struct KeyCustody {
    store: Arc<dyn IdentitySecretStore>,
    backend: CustodyBackend,
}

impl KeyCustody {
    /// # Errors
    /// [`CustodyError::NotDurable`] when `store` would not keep the secret.
    pub fn open(store: Arc<dyn IdentitySecretStore>) -> Result<Self, CustodyError> {
        let backend = store.durable_backend().ok_or(CustodyError::NotDurable)?;
        Ok(Self { store, backend })
    }

    /// The store that keeps the key.
    #[must_use]
    pub fn backend(&self) -> CustodyBackend {
        self.backend
    }

    /// The stored key, if there is one.
    ///
    /// # Errors
    /// [`CustodyError::Store`] or [`CustodyError::StoredKeyInvalid`]. An
    /// invalid stored secret is never replaced silently: a new key would
    /// invalidate every pin of this installation.
    pub fn load(&self) -> Result<Option<IdentityKey>, CustodyError> {
        stored_key(&*self.store.own()?)
    }

    /// The stored key, or a new key that the store accepted and returned
    /// unchanged. The whole first use is one ownership of the entry: another
    /// first use, through any handle, waits for it and then loads this key.
    ///
    /// # Errors
    /// Every [`CustodyError`]; a store that does not return what it accepted
    /// has this call's own write removed again, in the same ownership, and
    /// fails with [`CustodyError::ReadBackMismatch`].
    pub fn load_or_create(&self) -> Result<IdentityKey, CustodyError> {
        let mut entry = self.store.own()?;
        if let Some(existing) = stored_key(&*entry)? {
            return Ok(existing);
        }
        let key = IdentityKey::generate().map_err(CustodyError::Identity)?;
        entry.save(key.secret())?;
        let returned = entry.load()?;
        if returned.is_some_and(|secret| bool::from(secret.expose().ct_eq(key.secret()))) {
            Ok(key)
        } else {
            // The ownership that found the entry empty still holds it, so
            // what the entry holds now is this call's own write.
            let _ = entry.delete();
            Err(CustodyError::ReadBackMismatch)
        }
    }

    /// Removes the key, at the end of account custody or when the feature is
    /// switched off.
    ///
    /// # Errors
    /// [`CustodyError::Store`].
    pub fn destroy(&self) -> Result<(), CustodyError> {
        self.store.own()?.delete().map_err(CustodyError::from)
    }
}

/// The key in an owned entry, if there is one.
fn stored_key(entry: &dyn OwnedSecretEntry) -> Result<Option<IdentityKey>, CustodyError> {
    match entry.load()? {
        None => Ok(None),
        Some(secret) => IdentityKey::from_pkcs8(secret.expose())
            .map(Some)
            .map_err(|_| CustodyError::StoredKeyInvalid),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, MutexGuard};

    use super::*;

    /// What a [`MemoryStore`] handle does, reported to its observer.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Step {
        /// About to wait for the ownership.
        Requested,
        Owned,
        Loaded,
        Saved,
        Deleted,
        /// About to end the ownership, still holding it.
        Released,
    }

    /// One in-memory entry that several [`MemoryStore`] handles can reach.
    /// Its single lock is the ownership of the contract, shared by every
    /// handle; that is all a test in one process needs.
    #[derive(Default)]
    pub(crate) struct MemoryEntry {
        pub(crate) slot: Mutex<Option<Vec<u8>>>,
    }

    /// A handle of a [`MemoryEntry`] that declares itself durable for tests,
    /// or not.
    #[derive(Default)]
    pub(crate) struct MemoryStore {
        pub(crate) entry: Arc<MemoryEntry>,
        pub(crate) durable: bool,
        pub(crate) corrupt_read_back: bool,
        pub(crate) observer: Option<Box<dyn Fn(Step) + Send + Sync>>,
    }

    impl MemoryStore {
        fn report(&self, step: Step) {
            if let Some(observer) = &self.observer {
                observer(step);
            }
        }
    }

    struct Owned<'a> {
        store: &'a MemoryStore,
        slot: MutexGuard<'a, Option<Vec<u8>>>,
    }

    impl IdentitySecretStore for MemoryStore {
        fn durable_backend(&self) -> Option<CustodyBackend> {
            self.durable.then_some(CustodyBackend::TestMemory)
        }

        fn own(&self) -> Result<Box<dyn OwnedSecretEntry + '_>, StoreError> {
            self.report(Step::Requested);
            let slot = self.entry.slot.lock().map_err(|_| StoreError)?;
            self.report(Step::Owned);
            Ok(Box::new(Owned { store: self, slot }))
        }
    }

    impl OwnedSecretEntry for Owned<'_> {
        fn load(&self) -> Result<Option<SecretBytes>, StoreError> {
            let loaded = self.slot.as_ref().map(|bytes| {
                let mut bytes = bytes.clone();
                if self.store.corrupt_read_back
                    && let Some(last) = bytes.last_mut()
                {
                    *last ^= 1;
                }
                SecretBytes::new(bytes)
            });
            self.store.report(Step::Loaded);
            Ok(loaded)
        }

        fn save(&mut self, secret: &[u8]) -> Result<(), StoreError> {
            *self.slot = Some(secret.to_vec());
            self.store.report(Step::Saved);
            Ok(())
        }

        fn delete(&mut self) -> Result<(), StoreError> {
            *self.slot = None;
            self.store.report(Step::Deleted);
            Ok(())
        }
    }

    impl Drop for Owned<'_> {
        fn drop(&mut self) {
            self.store.report(Step::Released);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Receiver};
    use std::sync::{Barrier, Mutex};

    use super::test_support::{MemoryEntry, MemoryStore, Step};
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex"))
            .collect()
    }

    #[test]
    fn the_rfc_8410_example_public_key_is_an_accepted_identity() {
        // RFC 8410 section 10.1.
        let spki = Spki::from_text("MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE");
        assert_eq!(
            spki.as_ref().map(|spki| spki.ed25519_key().to_vec()),
            Ok(hex(
                "19bf44096984cdfe8541bac167dc3b96c85086aa30b6b6cb0c5c38ad703166e1"
            ))
        );
    }

    #[test]
    fn the_rfc_8032_test_1_seed_gives_its_published_public_key() {
        // RFC 8032 section 7.1, TEST 1.
        let seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        let pair = Ed25519KeyPair::from_seed_unchecked(&seed).expect("seed");
        assert_eq!(
            pair.public_key().as_ref(),
            hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a").as_slice()
        );
    }

    #[test]
    fn only_the_exact_encoding_of_a_strong_key_is_accepted() {
        let valid = IdentityKey::generate().expect("key");
        let der = valid.spki().as_der().to_vec();
        assert_eq!(Spki::from_der(&der).as_ref(), Ok(valid.spki()));
        assert_eq!(Spki::from_der(&der[1..]), Err(SpkiError::NotEd25519));
        let mut longer = der.clone();
        longer.push(0);
        assert_eq!(Spki::from_der(&longer), Err(SpkiError::NotEd25519));
        let mut other_algorithm = der.clone();
        other_algorithm[8] = 0x71; // 1.3.101.113 is Ed448
        assert_eq!(Spki::from_der(&other_algorithm), Err(SpkiError::NotEd25519));
        // The all-zero encoding and the neutral element have small order.
        assert_eq!(
            Spki::from_ed25519_key(&[0u8; 32]),
            Err(SpkiError::SmallOrder)
        );
        let mut neutral = [0u8; 32];
        neutral[0] = 1;
        assert_eq!(Spki::from_ed25519_key(&neutral), Err(SpkiError::SmallOrder));
        // About half of all y coordinates have no point; take the first one.
        let off_curve = (2u8..=u8::MAX)
            .map(|y| {
                let mut key = [0u8; 32];
                key[0] = y;
                key
            })
            .find(|key| ed25519_dalek::VerifyingKey::from_bytes(key).is_err())
            .expect("an encoding without a point");
        assert_eq!(
            Spki::from_ed25519_key(&off_curve),
            Err(SpkiError::InvalidPoint)
        );
        assert_eq!(
            Spki::from_text(&format!("{}=", valid.spki().to_text())),
            Err(SpkiError::Text)
        );
    }

    #[test]
    fn identity_keys_round_trip_through_their_secret_and_hide_it() {
        let key = IdentityKey::generate().expect("key");
        let again = IdentityKey::from_pkcs8(key.secret()).expect("reload");
        assert_eq!(key.spki(), again.spki());
        let shown = format!("{key:?}");
        assert!(shown.contains(&key.spki().to_text()));
        assert!(!shown.contains(&b64::encode(key.secret())));
        assert_eq!(
            IdentityKey::from_pkcs8(b"not a key").map(|_| ()),
            Err(IdentityError::InvalidPrivateKey)
        );
        assert_eq!(
            format!("{:?}", SecretBytes::new(vec![1, 2, 3])),
            "SecretBytes(..)"
        );
    }

    #[test]
    fn custody_refuses_a_store_that_is_not_durable() {
        let store = Arc::new(MemoryStore::default());
        assert_eq!(
            KeyCustody::open(store).map(|_| ()),
            Err(CustodyError::NotDurable)
        );
    }

    #[test]
    fn custody_creates_once_and_then_returns_the_same_key() {
        let store = Arc::new(MemoryStore {
            durable: true,
            ..MemoryStore::default()
        });
        let custody = KeyCustody::open(store.clone()).expect("custody");
        assert_eq!(custody.backend(), CustodyBackend::TestMemory);
        let created = custody.load_or_create().expect("create");
        let loaded = custody.load_or_create().expect("load");
        assert_eq!(created.spki(), loaded.spki());
        custody.destroy().expect("destroy");
        assert!(custody.load().expect("load").is_none());
    }

    #[test]
    fn custody_fails_closed_when_the_store_changes_the_secret() {
        let store = Arc::new(MemoryStore {
            durable: true,
            corrupt_read_back: true,
            ..MemoryStore::default()
        });
        let custody = KeyCustody::open(store.clone()).expect("custody");
        assert_eq!(
            custody.load_or_create().map(|_| ()),
            Err(CustodyError::ReadBackMismatch)
        );
        assert!(
            store.entry.slot.lock().expect("slot").is_none(),
            "the refused secret is removed"
        );
    }

    #[test]
    fn an_invalid_stored_secret_is_not_replaced() {
        let store = Arc::new(MemoryStore {
            durable: true,
            ..MemoryStore::default()
        });
        *store.entry.slot.lock().expect("slot") = Some(b"garbage".to_vec());
        let custody = KeyCustody::open(store.clone()).expect("custody");
        assert_eq!(
            custody.load_or_create().map(|_| ()),
            Err(CustodyError::StoredKeyInvalid)
        );
        assert_eq!(
            store.entry.slot.lock().expect("slot").as_deref(),
            Some(&b"garbage"[..])
        );
    }

    fn stored(entry: &MemoryEntry) -> Option<Spki> {
        entry
            .slot
            .lock()
            .expect("slot")
            .as_deref()
            .map(|secret| IdentityKey::from_pkcs8(secret).expect("key").spki().clone())
    }

    /// Reads the step log up to `wanted`, keeping what it read.
    fn wait_for(
        log: &Receiver<(usize, Step)>,
        seen: &mut Vec<(usize, Step)>,
        wanted: (usize, Step),
    ) {
        for step in log {
            seen.push(step);
            if step == wanted {
                return;
            }
        }
        panic!("the log ended before {wanted:?}");
    }

    fn position(steps: &[(usize, Step)], wanted: (usize, Step)) -> usize {
        steps
            .iter()
            .position(|step| *step == wanted)
            .expect("logged")
    }

    /// What two overlapping first uses left: the entry, every step of both
    /// handles in order, and their results.
    struct Overlap {
        entry: Arc<MemoryEntry>,
        steps: Vec<(usize, Step)>,
        results: [Result<IdentityKey, CustodyError>; 2],
    }

    /// Two first uses of one entry through two custody handles: handle 0
    /// takes the ownership and waits in it until handle 1 has asked for it.
    fn overlapping_first_uses(first_corrupts_read_back: bool) -> Overlap {
        let entry = Arc::new(MemoryEntry::default());
        let (sender, log) = mpsc::channel();
        let inside = Arc::new(Barrier::new(2));
        let custody = |index: usize, corrupt_read_back: bool, pause: Option<Arc<Barrier>>| {
            let sender = sender.clone();
            // Only the first ownership of handle 0 waits, and only once.
            let pause = Mutex::new(pause);
            KeyCustody::open(Arc::new(MemoryStore {
                entry: Arc::clone(&entry),
                durable: true,
                corrupt_read_back,
                observer: Some(Box::new(move |step| {
                    sender.send((index, step)).expect("log");
                    if step == Step::Owned
                        && let Some(pause) = pause.lock().expect("pause").take()
                    {
                        pause.wait();
                    }
                })),
            }))
            .expect("custody")
        };
        let first = custody(0, first_corrupts_read_back, Some(Arc::clone(&inside)));
        let second = custody(1, false, None);
        let mut seen = Vec::new();
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| first.load_or_create());
            wait_for(&log, &mut seen, (0, Step::Owned));
            let second = scope.spawn(|| second.load_or_create());
            wait_for(&log, &mut seen, (1, Step::Requested));
            inside.wait();
            [first.join().expect("first"), second.join().expect("second")]
        });
        seen.extend(log.try_iter());
        Overlap {
            entry,
            steps: seen,
            results,
        }
    }

    #[test]
    fn two_first_uses_of_one_entry_return_its_one_identity() {
        let Overlap {
            entry,
            steps,
            results: [first, second],
        } = overlapping_first_uses(false);
        let (first, second) = (first.expect("first use"), second.expect("first use"));
        assert_eq!(
            first.spki(),
            second.spki(),
            "two first uses returned two identities"
        );
        assert_eq!(stored(&entry).as_ref(), Some(first.spki()));
        assert!(
            position(&steps, (0, Step::Released)) < position(&steps, (1, Step::Owned)),
            "{steps:?}"
        );
        assert_eq!(
            steps
                .iter()
                .filter(|(_, step)| *step == Step::Saved)
                .count(),
            1,
            "one key was stored"
        );
    }

    #[test]
    fn a_failed_first_use_never_removes_another_identity() {
        let Overlap {
            entry,
            steps,
            results: [first, second],
        } = overlapping_first_uses(true);
        assert_eq!(first.map(|_| ()), Err(CustodyError::ReadBackMismatch));
        let second = second.expect("the other first use");
        assert_eq!(
            stored(&entry).as_ref(),
            Some(second.spki()),
            "a returned identity is no longer stored"
        );
        assert!(
            position(&steps, (0, Step::Deleted)) < position(&steps, (1, Step::Owned)),
            "{steps:?}"
        );
    }
}
