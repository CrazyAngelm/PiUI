//! Custody of the refresh token and the non-secret account preferences.
//!
//! The refresh token goes to the OS credential store (Windows Credential
//! Manager, macOS Keychain). When that store is missing or fails, the token
//! stays in memory for this run and the status reports `memory`. There is no
//! file fallback for a secret.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};

use crate::error::NanoError;
use crate::fsutil::atomic_write;
use crate::secret::SecretString;
use crate::status::NanoCredentialStoreV1;

/// Keyring service name of the refresh token; the keyring user is the issuer
/// origin, so a development server never sees the production token.
pub const KEYRING_SERVICE: &str = "dev.piui.desktop.nano";

/// Where a refresh token is kept. Implementations are blocking; the account
/// calls them from `spawn_blocking`.
pub trait CredentialStore: Send + Sync {
    /// What the status reports while this store holds the token.
    fn kind(&self) -> NanoCredentialStoreV1;
    /// The stored token, if any.
    ///
    /// # Errors
    /// [`NanoError::CredentialStoreFailed`] when the store cannot be read.
    fn load(&self) -> Result<Option<SecretString>, NanoError>;
    /// Replaces the stored token.
    ///
    /// # Errors
    /// [`NanoError::CredentialStoreFailed`] when the store cannot be written.
    fn save(&self, refresh_token: &SecretString) -> Result<(), NanoError>;
    /// Forgets the token; deleting a missing token succeeds.
    ///
    /// # Errors
    /// [`NanoError::CredentialStoreFailed`] when the store cannot be written.
    fn delete(&self) -> Result<(), NanoError>;
}

/// A process-memory store: the token is lost when the app quits.
#[derive(Debug, Default)]
pub struct MemoryStore {
    slot: Mutex<Option<SecretString>>,
}

impl MemoryStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// A store that already holds `token` (tests and migrations).
    pub fn with_token(token: SecretString) -> Self {
        Self {
            slot: Mutex::new(Some(token)),
        }
    }
}

impl CredentialStore for MemoryStore {
    fn kind(&self) -> NanoCredentialStoreV1 {
        NanoCredentialStoreV1::Memory
    }

    fn load(&self) -> Result<Option<SecretString>, NanoError> {
        Ok(self
            .slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone())
    }

    fn save(&self, refresh_token: &SecretString) -> Result<(), NanoError> {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(refresh_token.clone());
        Ok(())
    }

    fn delete(&self) -> Result<(), NanoError> {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }
}

/// The OS credential store entry `dev.piui.desktop.nano` / issuer origin.
#[cfg(any(windows, target_os = "macos"))]
#[derive(Debug, Clone)]
pub struct OsCredentialStore {
    service: String,
    user: String,
}

#[cfg(any(windows, target_os = "macos"))]
impl OsCredentialStore {
    /// The entry for `issuer_origin` (for example `https://nanoagents.ru`).
    pub fn new(issuer_origin: &str) -> Self {
        Self {
            service: KEYRING_SERVICE.to_owned(),
            user: issuer_origin.to_owned(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, NanoError> {
        keyring::Entry::new(&self.service, &self.user).map_err(|_| NanoError::CredentialStoreFailed)
    }
}

#[cfg(any(windows, target_os = "macos"))]
impl CredentialStore for OsCredentialStore {
    fn kind(&self) -> NanoCredentialStoreV1 {
        NanoCredentialStoreV1::Os
    }

    fn load(&self) -> Result<Option<SecretString>, NanoError> {
        match self.entry()?.get_password() {
            Ok(token) if token.is_empty() => Ok(None),
            Ok(token) => Ok(Some(SecretString::new(token))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(NanoError::CredentialStoreFailed),
        }
    }

    fn save(&self, refresh_token: &SecretString) -> Result<(), NanoError> {
        self.entry()?
            .set_password(refresh_token.expose())
            .map_err(|_| NanoError::CredentialStoreFailed)
    }

    fn delete(&self) -> Result<(), NanoError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(NanoError::CredentialStoreFailed),
        }
    }
}

/// The OS credential store for `issuer_origin`, or `None` on platforms
/// without one (Linux and others keep the token in memory only).
pub fn default_os_store(issuer_origin: &str) -> Option<Arc<dyn CredentialStore>> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        Some(Arc::new(OsCredentialStore::new(issuer_origin)))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = issuer_origin;
        None
    }
}

/// The persistent store plus the in-memory fallback.
pub(crate) struct TokenVault {
    persistent: Option<Arc<dyn CredentialStore>>,
    memory: MemoryStore,
    /// The persistent store failed this run; keep the token in memory.
    degraded: AtomicBool,
}

impl TokenVault {
    pub(crate) fn new(persistent: Option<Arc<dyn CredentialStore>>) -> Self {
        Self {
            persistent,
            memory: MemoryStore::new(),
            degraded: AtomicBool::new(false),
        }
    }

    /// The current token and where it lives.
    pub(crate) fn load(&self) -> Result<Option<(SecretString, NanoCredentialStoreV1)>, NanoError> {
        if let Some(token) = self.memory.load()? {
            return Ok(Some((token, NanoCredentialStoreV1::Memory)));
        }
        match &self.persistent {
            Some(store) => Ok(store.load()?.map(|token| (token, store.kind()))),
            None => Ok(None),
        }
    }

    /// Stores a rotated token. Never fails: a failing persistent store is
    /// emptied (its token is now stale and its reuse would revoke the device)
    /// and the token is kept in memory.
    pub(crate) fn save(&self, token: &SecretString) -> NanoCredentialStoreV1 {
        if let Some(store) = &self.persistent
            && !self.degraded.load(Ordering::SeqCst)
        {
            match store.save(token) {
                Ok(()) => {
                    let _ = self.memory.delete();
                    return store.kind();
                }
                Err(_) => {
                    self.degraded.store(true, Ordering::SeqCst);
                    let _ = store.delete();
                }
            }
        }
        let _ = self.memory.save(token);
        NanoCredentialStoreV1::Memory
    }

    /// Forgets the token everywhere and retries the persistent store next time.
    pub(crate) fn delete(&self) -> Result<(), NanoError> {
        let _ = self.memory.delete();
        self.degraded.store(false, Ordering::SeqCst);
        match &self.persistent {
            Some(store) => store.delete(),
            None => Ok(()),
        }
    }
}

/// Non-secret account preferences kept in a small JSON file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoPrefs {
    /// The issuer origin the selection belongs to.
    pub issuer: Option<String>,
    pub selected_workspace_id: Option<String>,
}

/// The preferences file at a host-chosen path, replaced atomically.
#[derive(Debug, Clone)]
pub struct PrefsFile {
    path: PathBuf,
}

impl PrefsFile {
    /// Preferences at `path` (the file need not exist).
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// The file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The stored preferences; a missing or unreadable file is the default.
    pub fn load(&self) -> NanoPrefs {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Replaces the file atomically.
    ///
    /// # Errors
    /// [`NanoError::Invalid`] when the file cannot be written.
    pub fn save(&self, prefs: &NanoPrefs) -> Result<(), NanoError> {
        let bytes = serde_json::to_vec_pretty(prefs).map_err(|_| NanoError::Invalid)?;
        atomic_write(&self.path, &bytes).map_err(|_| NanoError::Invalid)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A persistent store whose writes fail.
    pub(crate) struct FailingStore {
        pub(crate) inner: MemoryStore,
    }

    impl CredentialStore for FailingStore {
        fn kind(&self) -> NanoCredentialStoreV1 {
            NanoCredentialStoreV1::Os
        }
        fn load(&self) -> Result<Option<SecretString>, NanoError> {
            self.inner.load()
        }
        fn save(&self, _: &SecretString) -> Result<(), NanoError> {
            Err(NanoError::CredentialStoreFailed)
        }
        fn delete(&self) -> Result<(), NanoError> {
            self.inner.delete()
        }
    }

    fn secret(value: &str) -> SecretString {
        SecretString::new(value.to_owned())
    }

    #[test]
    fn vault_uses_the_persistent_store() {
        let store = Arc::new(MemoryStore::new());
        let vault = TokenVault::new(Some(store.clone()));
        assert_eq!(vault.save(&secret("r1")), NanoCredentialStoreV1::Memory);
        assert_eq!(store.load().expect("load"), Some(secret("r1")));
        let (token, _) = vault.load().expect("load").expect("token");
        assert_eq!(token, secret("r1"));
        vault.delete().expect("delete");
        assert!(vault.load().expect("load").is_none());
        assert!(store.load().expect("load").is_none());
    }

    #[test]
    fn failing_os_store_falls_back_to_memory_and_drops_the_stale_token() {
        let failing = Arc::new(FailingStore {
            inner: MemoryStore::with_token(secret("old")),
        });
        let vault = TokenVault::new(Some(failing.clone()));
        assert_eq!(vault.save(&secret("new")), NanoCredentialStoreV1::Memory);
        assert!(failing.inner.load().expect("load").is_none());
        let (token, kind) = vault.load().expect("load").expect("token");
        assert_eq!(token, secret("new"));
        assert_eq!(kind, NanoCredentialStoreV1::Memory);
    }

    #[test]
    fn no_persistent_store_means_memory() {
        let vault = TokenVault::new(None);
        assert_eq!(vault.save(&secret("r")), NanoCredentialStoreV1::Memory);
        assert!(vault.load().expect("load").is_some());
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn other_platforms_have_no_os_store() {
        assert!(default_os_store("https://nanoagents.ru").is_none());
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn supported_platforms_report_an_os_store() {
        let store = default_os_store("https://nanoagents.ru").expect("store");
        assert_eq!(store.kind(), NanoCredentialStoreV1::Os);
    }

    #[test]
    fn prefs_round_trip_atomically() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = PrefsFile::new(dir.path().join("nano").join("account.json"));
        assert_eq!(file.load(), NanoPrefs::default());
        let prefs = NanoPrefs {
            issuer: Some("https://nanoagents.ru".to_owned()),
            selected_workspace_id: Some("ws_synthetic01".to_owned()),
        };
        file.save(&prefs).expect("save");
        assert_eq!(file.load(), prefs);
        std::fs::write(file.path(), b"{broken").expect("corrupt");
        assert_eq!(file.load(), NanoPrefs::default());
    }
}
