//! Create-only generations, mirrored from fusion/store.rs. These files contain PiUI metadata only.
use super::model::{PROTOCOL, SessionDocument};
use crate::board::store::workspace_directory_name;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

const PREFIX: &str = "links-";
const SUFFIX: &str = ".json";
// The Fusion store's create-only retention policy, explicitly required by the brief.
const KEPT_GENERATIONS: u64 = 3;
#[derive(Debug)]
pub(crate) struct StoreError;
pub(crate) trait LinksStore: Send + Sync {
    fn load_all(&self) -> Vec<SessionDocument>;
    fn save(&self, document: &SessionDocument) -> Result<(), StoreError>;
    fn forget(&self, session_id: &str) -> Result<(), StoreError>;
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    generation: u64,
    document: SessionDocument,
}
pub(crate) struct FileLinksStore {
    root: PathBuf,
}
impl FileLinksStore {
    pub(crate) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let root = app_data_dir.join("session-links-v1");
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }
}
fn generation_of(path: &Path) -> Option<u64> {
    let number = path
        .file_name()?
        .to_str()?
        .strip_prefix(PREFIX)?
        .strip_suffix(SUFFIX)?;
    (number.len() == 20).then(|| number.parse().ok()).flatten()
}
fn newest(directory: &Path) -> Option<(u64, SessionDocument)> {
    let mut best: Option<(u64, SessionDocument)> = None;
    for entry in fs::read_dir(directory).ok()?.flatten() {
        let path = entry.path();
        if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
            continue;
        }
        let Some(generation) = generation_of(&path) else {
            continue;
        };
        if best
            .as_ref()
            .is_some_and(|(current, _)| *current >= generation)
        {
            continue;
        }
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let Ok(envelope) = serde_json::from_slice::<Envelope>(&bytes) else {
            continue;
        };
        if envelope.version == PROTOCOL
            && envelope.document.protocol == PROTOCOL
            && envelope.generation == generation
        {
            best = Some((generation, envelope.document));
        }
    }
    best
}
impl LinksStore for FileLinksStore {
    fn load_all(&self) -> Vec<SessionDocument> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let directory = entry.path();
                if !fs::symlink_metadata(&directory).is_ok_and(|meta| meta.is_dir()) {
                    return None;
                }
                let (_, document) = newest(&directory)?;
                (directory.file_name()?.to_str()?
                    == workspace_directory_name(&document.session_id).ok()?)
                .then_some(document)
            })
            .collect()
    }
    fn save(&self, document: &SessionDocument) -> Result<(), StoreError> {
        let directory = self
            .root
            .join(workspace_directory_name(&document.session_id).map_err(|_| StoreError)?);
        if fs::symlink_metadata(&directory).is_ok_and(|meta| !meta.is_dir()) {
            return Err(StoreError);
        }
        fs::create_dir_all(&directory).map_err(|_| StoreError)?;
        let previous = fs::read_dir(&directory)
            .map_err(|_| StoreError)?
            .flatten()
            .filter_map(|entry| generation_of(&entry.path()))
            .max()
            .unwrap_or(0);
        let generation = previous.checked_add(1).ok_or(StoreError)?;
        let bytes = serde_json::to_vec(&Envelope {
            version: PROTOCOL,
            generation,
            document: document.clone(),
        })
        .map_err(|_| StoreError)?;
        let path = directory.join(format!("{PREFIX}{generation:020}{SUFFIX}"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| StoreError)?;
        if file
            .write_all(&bytes)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_all())
            .is_err()
        {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(StoreError);
        }
        let keep_from = generation.saturating_sub(KEPT_GENERATIONS - 1);
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                if generation_of(&entry.path()).is_some_and(|old| old < keep_from)
                    && fs::symlink_metadata(entry.path()).is_ok_and(|meta| meta.is_file())
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }
    fn forget(&self, session_id: &str) -> Result<(), StoreError> {
        let directory = self
            .root
            .join(workspace_directory_name(session_id).map_err(|_| StoreError)?);
        let Ok(metadata) = fs::symlink_metadata(&directory) else {
            return Ok(());
        };
        if !metadata.is_dir() {
            return Err(StoreError);
        }
        for entry in fs::read_dir(&directory).map_err(|_| StoreError)?.flatten() {
            if generation_of(&entry.path()).is_some()
                && fs::symlink_metadata(entry.path()).is_ok_and(|meta| meta.is_file())
            {
                fs::remove_file(entry.path()).map_err(|_| StoreError)?;
            }
        }
        let _ = fs::remove_dir(directory);
        Ok(())
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryLinksStore {
    pub documents: std::sync::Mutex<std::collections::BTreeMap<String, SessionDocument>>,
}
#[cfg(test)]
impl LinksStore for MemoryLinksStore {
    fn load_all(&self) -> Vec<SessionDocument> {
        self.documents
            .lock()
            .expect("documents")
            .values()
            .cloned()
            .collect()
    }
    fn save(&self, document: &SessionDocument) -> Result<(), StoreError> {
        self.documents
            .lock()
            .map_err(|_| StoreError)?
            .insert(document.session_id.clone(), document.clone());
        Ok(())
    }
    fn forget(&self, session_id: &str) -> Result<(), StoreError> {
        self.documents
            .lock()
            .map_err(|_| StoreError)?
            .remove(session_id);
        Ok(())
    }
}
