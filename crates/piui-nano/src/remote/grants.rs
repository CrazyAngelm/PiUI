//! What the person approved on this computer: the remote-access toggle and
//! the browsers (public keys) remembered with "Always allow this browser".
//!
//! The file holds no token and no secret: a public key is not a credential.
//! It is bound to the issuer origin and to the device id of the account that
//! wrote it. A new sign-in creates a new device id, so a store read for
//! another account starts disabled with no browsers (the old file is replaced
//! by the next write). Writes replace the file atomically; a failed write
//! leaves both the file and the in-memory state as they were.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::frames::MAX_BROWSERS;
use super::pairing::{decode_key, fingerprint, sanitize_label};
use crate::fsutil::atomic_write;

/// A remembered browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBrowser {
    pub id: String,
    pub label: String,
    /// `fingerprint(key)`, recomputed when the file is read.
    pub fingerprint: String,
    /// The public key as unpadded base64url (`pairing::encode_key`).
    pub key: String,
    /// RFC 3339, UTC.
    pub created_at: String,
    pub last_used_at: Option<String>,
    /// Older keys only authorized chats; the owner must approve workbench access locally.
    #[serde(default)]
    pub workbench: bool,
}

/// Why a store operation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    #[error("the maximum number of remembered browsers is reached")]
    Full,
    #[error("the remote access file could not be written")]
    Io,
    #[error("no such browser")]
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    issuer: String,
    device_id: String,
    enabled: bool,
    #[serde(default)]
    browsers: Vec<StoredBrowser>,
}

/// The toggle and the remembered browsers of one account on one computer.
#[derive(Debug, Clone)]
pub struct RemoteStore {
    path: Option<PathBuf>,
    file: StoreFile,
}

impl RemoteStore {
    /// An empty, disabled store that is never written (tests, and the state
    /// of a signed-out host).
    pub fn in_memory(issuer: &str, device_id: &str) -> Self {
        Self {
            path: None,
            file: StoreFile {
                issuer: issuer.to_owned(),
                device_id: device_id.to_owned(),
                enabled: false,
                browsers: Vec::new(),
            },
        }
    }

    /// Reads the store at `path`. A missing, unreadable or malformed file, or
    /// one bound to another issuer or device id, yields an empty disabled
    /// store that writes to `path`. Entries whose key is unusable are dropped,
    /// the rest are capped and their labels and fingerprints recomputed.
    pub fn load(path: &Path, issuer: &str, device_id: &str) -> Self {
        let mut store = Self::in_memory(issuer, device_id);
        store.path = Some(path.to_path_buf());
        let Some(stored) = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoreFile>(&bytes).ok())
        else {
            return store;
        };
        if stored.issuer != issuer || stored.device_id != device_id {
            return store;
        }
        store.file.enabled = stored.enabled;
        store.file.browsers = stored
            .browsers
            .into_iter()
            .filter_map(|mut browser| {
                let key = decode_key(&browser.key)?;
                browser.fingerprint = fingerprint(&key);
                browser.label = sanitize_label(&browser.label);
                Some(browser)
            })
            .take(MAX_BROWSERS)
            .collect();
        store
    }

    /// The device id this store belongs to.
    pub fn device_id(&self) -> &str {
        &self.file.device_id
    }

    /// Whether the person switched remote access on.
    pub fn enabled(&self) -> bool {
        self.file.enabled
    }

    /// The remembered browsers, oldest first.
    pub fn browsers(&self) -> &[StoredBrowser] {
        &self.file.browsers
    }

    /// Switches the toggle and writes the file.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the file cannot be written; nothing changes.
    pub fn set_enabled(&mut self, enabled: bool) -> Result<(), StoreError> {
        self.apply(|file| {
            file.enabled = enabled;
            Ok(())
        })
    }

    /// The remembered browser with this public key (unpadded base64url).
    pub fn find_by_key(&self, key: &str) -> Option<&StoredBrowser> {
        self.file.browsers.iter().find(|browser| browser.key == key)
    }

    /// Remembers a browser. A browser with the same key is replaced (and
    /// does not count against the limit).
    ///
    /// # Errors
    /// [`StoreError::Full`] when [`MAX_BROWSERS`] others are remembered,
    /// [`StoreError::Io`] when the file cannot be written.
    pub fn remember(&mut self, browser: StoredBrowser) -> Result<(), StoreError> {
        self.apply(|file| {
            file.browsers.retain(|known| known.key != browser.key);
            if file.browsers.len() >= MAX_BROWSERS {
                return Err(StoreError::Full);
            }
            file.browsers.push(browser);
            Ok(())
        })
    }

    /// Records that a remembered browser connected at `at` (RFC 3339).
    ///
    /// # Errors
    /// [`StoreError::NotFound`] or [`StoreError::Io`].
    pub fn touch(&mut self, browser_id: &str, at: &str) -> Result<(), StoreError> {
        self.apply(|file| {
            let browser = file
                .browsers
                .iter_mut()
                .find(|browser| browser.id == browser_id)
                .ok_or(StoreError::NotFound)?;
            browser.last_used_at = Some(at.to_owned());
            Ok(())
        })
    }

    /// Forgets one browser and returns it.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] or [`StoreError::Io`].
    pub fn forget(&mut self, browser_id: &str) -> Result<StoredBrowser, StoreError> {
        let mut forgotten = None;
        self.apply(|file| {
            let index = file
                .browsers
                .iter()
                .position(|browser| browser.id == browser_id)
                .ok_or(StoreError::NotFound)?;
            forgotten = Some(file.browsers.remove(index));
            Ok(())
        })?;
        forgotten.ok_or(StoreError::NotFound)
    }

    /// Forgets every browser.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the file cannot be written.
    pub fn clear(&mut self) -> Result<(), StoreError> {
        self.apply(|file| {
            file.browsers.clear();
            Ok(())
        })
    }

    /// Applies `change` to a copy, writes it, and only then adopts it.
    fn apply(
        &mut self,
        change: impl FnOnce(&mut StoreFile) -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        let mut next = self.file.clone();
        change(&mut next)?;
        if let Some(path) = &self.path {
            let bytes = serde_json::to_vec_pretty(&next).map_err(|_| StoreError::Io)?;
            atomic_write(path, &bytes).map_err(|_| StoreError::Io)?;
        }
        self.file = next;
        Ok(())
    }
}
