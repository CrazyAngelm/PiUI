//! The plugin registry document: what the user installed or loaded for
//! development, what they trusted (the package code hash, permissions and
//! backend entry), whether each plugin is enabled, its settings values and
//! the active plugin theme. Written as complete create-only generations, like
//! the ACP registry: a failed write leaves the previous generation untouched.
//! Package files live beside it under `packages/`; nothing here reads them.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use piui_plugins::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const DOCUMENT_VERSION: u32 = 1;
const GENERATION_PREFIX: &str = "registry-";
const GENERATION_SUFFIX: &str = ".json";

/// Where a plugin's files are.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum StoredSource {
    /// A copy PiUI owns under `packages/<directory>`.
    Installed { directory: String },
    /// Development mode: the user's folder, read in place.
    Development { folder: PathBuf },
}

/// One plugin and the decisions bound to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredPlugin {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub source: StoredSource,
    /// The package code hash the user trusted (installed plugins must still
    /// match it; development plugins may change code, not permissions).
    pub code_hash: String,
    pub permissions: Vec<Permission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_entry: Option<String>,
    pub enabled: bool,
    pub installed_at: String,
    /// The plugin's private folder under `data/`.
    pub data_directory: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub settings: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThemeRef {
    pub plugin_id: String,
    pub theme_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document {
    pub version: u32,
    pub generation: u64,
    pub plugins: Vec<StoredPlugin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_theme: Option<ThemeRef>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            version: DOCUMENT_VERSION,
            generation: 0,
            plugins: Vec::new(),
            active_theme: None,
        }
    }
}

impl Document {
    pub fn plugin(&self, id: &str) -> Option<&StoredPlugin> {
        self.plugins.iter().find(|plugin| plugin.id == id)
    }

    pub fn plugin_mut(&mut self, id: &str) -> Option<&mut StoredPlugin> {
        self.plugins.iter_mut().find(|plugin| plugin.id == id)
    }
}

/// The document with its folder and the next free generation.
pub(crate) struct Registry {
    directory: PathBuf,
    pub document: Document,
    next_generation: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TransactError<E> {
    Conflict,
    Io,
    Rejected(E),
}

impl Registry {
    /// Opens the newest complete generation under `directory`.
    pub fn open(directory: &Path) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        let mut newest: Option<Document> = None;
        let mut next_generation = 0_u64;
        for entry in fs::read_dir(directory)?.flatten() {
            let Some(generation) = generation_from_path(&entry.path()) else {
                continue;
            };
            next_generation = next_generation.max(generation);
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(document) = serde_json::from_slice::<Document>(&bytes) else {
                continue;
            };
            if document.version != DOCUMENT_VERSION || document.generation != generation {
                continue;
            }
            if newest
                .as_ref()
                .is_none_or(|current| document.generation > current.generation)
            {
                newest = Some(document);
            }
        }
        Ok(Self {
            directory: directory.to_path_buf(),
            document: newest.unwrap_or_default(),
            next_generation,
        })
    }

    pub fn revision(&self) -> u64 {
        self.document.generation
    }

    /// Applies `change` to a copy and writes it as a new generation when the
    /// revision still matches. Nothing changes on any failure.
    pub fn transact<E>(
        &mut self,
        expected_revision: Option<u64>,
        change: impl FnOnce(&mut Document) -> Result<(), E>,
    ) -> Result<(), TransactError<E>> {
        if expected_revision.is_some_and(|revision| revision != self.document.generation) {
            return Err(TransactError::Conflict);
        }
        let mut staged = self.document.clone();
        change(&mut staged).map_err(TransactError::Rejected)?;
        staged.generation = self
            .next_generation
            .checked_add(1)
            .ok_or(TransactError::Io)?;
        let bytes = serde_json::to_vec_pretty(&staged).map_err(|_| TransactError::Io)?;
        let path = generation_path(&self.directory, staged.generation);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| TransactError::Io)?;
        if write_complete(&mut file, &bytes).is_err() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(TransactError::Io);
        }
        self.next_generation = staged.generation;
        self.document = staged;
        remove_older_generations(&self.directory, self.document.generation);
        Ok(())
    }
}

fn write_complete(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}

fn generation_path(directory: &Path, generation: u64) -> PathBuf {
    directory.join(format!(
        "{GENERATION_PREFIX}{generation:020}{GENERATION_SUFFIX}"
    ))
}

fn generation_from_path(path: &Path) -> Option<u64> {
    let name = path.file_name()?.to_str()?;
    let number = name
        .strip_prefix(GENERATION_PREFIX)?
        .strip_suffix(GENERATION_SUFFIX)?;
    (number.len() == 20).then(|| number.parse().ok()).flatten()
}

fn remove_older_generations(directory: &Path, current: u64) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if generation_from_path(&path).is_some_and(|generation| generation < current) {
            let _ = fs::remove_file(path);
        }
    }
}
