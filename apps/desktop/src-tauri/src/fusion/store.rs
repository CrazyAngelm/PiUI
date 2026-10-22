//! Durable Fusion storage (ADR-043): one document per Fusion chat written as
//! complete create-only generations under
//! `app_data/fusion-v1/<lead session dir>/fusion-<20-digit generation>.json`,
//! the pattern of the board store. A failed write leaves the previous
//! generation authoritative; a damaged generation is skipped on load; the
//! newest three are kept. Never written into the project folder.

use super::model::{FUSION_PROTOCOL, FusionDocument};
use crate::board::store::workspace_directory_name;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

pub(crate) const DIRECTORY: &str = "fusion-v1";
const PREFIX: &str = "fusion-";
const SUFFIX: &str = ".json";
const KEPT_GENERATIONS: u64 = 3;

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct StoreError;

pub(crate) trait FusionStore: Send + Sync {
    /// Every intact Fusion document.
    fn load_all(&self) -> Vec<FusionDocument>;
    /// Durably stores `document` as its chat's newest generation.
    fn save(&self, document: &FusionDocument) -> Result<(), StoreError>;
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    version: u8,
    generation: u64,
    document: FusionDocument,
}

pub(crate) struct FileFusionStore {
    root: PathBuf,
}

impl FileFusionStore {
    pub(crate) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let root = app_data_dir.join(DIRECTORY);
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }
}

fn generation_of(path: &Path) -> Option<u64> {
    let name = path.file_name()?.to_str()?;
    let number = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    (number.len() == 20).then(|| number.parse().ok()).flatten()
}

fn newest(directory: &Path) -> Option<(u64, FusionDocument)> {
    let mut best: Option<(u64, FusionDocument)> = None;
    for entry in fs::read_dir(directory).ok()?.flatten() {
        let path = entry.path();
        let Some(generation) = generation_of(&path) else {
            continue;
        };
        if best
            .as_ref()
            .is_some_and(|(current, _)| *current >= generation)
        {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(envelope) = serde_json::from_slice::<Envelope>(&bytes) else {
            continue;
        };
        if envelope.version != FUSION_PROTOCOL || envelope.generation != generation {
            continue;
        }
        best = Some((generation, envelope.document));
    }
    best
}

impl FusionStore for FileFusionStore {
    fn load_all(&self) -> Vec<FusionDocument> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let directory = entry.path();
                let (_, document) = newest(&directory)?;
                // A document stored under another chat's folder is foreign.
                let expected = workspace_directory_name(&document.lead_session_id).ok()?;
                (directory.file_name()?.to_str()? == expected).then_some(document)
            })
            .collect()
    }

    fn save(&self, document: &FusionDocument) -> Result<(), StoreError> {
        let directory = self
            .root
            .join(workspace_directory_name(&document.lead_session_id).map_err(|_| StoreError)?);
        fs::create_dir_all(&directory).map_err(|_| StoreError)?;
        let generation = newest(&directory)
            .map_or(0, |(generation, _)| generation)
            .max(
                fs::read_dir(&directory)
                    .map(|entries| {
                        entries
                            .flatten()
                            .filter_map(|entry| generation_of(&entry.path()))
                            .max()
                            .unwrap_or(0)
                    })
                    .unwrap_or(0),
            )
            .checked_add(1)
            .ok_or(StoreError)?;
        let bytes = serde_json::to_vec(&Envelope {
            version: FUSION_PROTOCOL,
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
        let written = file
            .write_all(&bytes)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_all());
        if written.is_err() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(StoreError);
        }
        if let Ok(entries) = fs::read_dir(&directory) {
            let keep_from = generation.saturating_sub(KEPT_GENERATIONS - 1);
            for entry in entries.flatten() {
                if generation_of(&entry.path()).is_some_and(|old| old < keep_from) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }
}

/// In-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryFusionStore {
    pub(crate) documents: std::sync::Mutex<std::collections::BTreeMap<String, FusionDocument>>,
    pub(crate) fail_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl FusionStore for MemoryFusionStore {
    fn load_all(&self) -> Vec<FusionDocument> {
        self.documents
            .lock()
            .map(|documents| documents.values().cloned().collect())
            .unwrap_or_default()
    }

    fn save(&self, document: &FusionDocument) -> Result<(), StoreError> {
        if self.fail_writes.load(std::sync::atomic::Ordering::Acquire) {
            return Err(StoreError);
        }
        self.documents
            .lock()
            .map_err(|_| StoreError)?
            .insert(document.lead_session_id.clone(), document.clone());
        Ok(())
    }
}
