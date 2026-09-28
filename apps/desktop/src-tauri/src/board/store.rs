//! Durable board storage (ADR-041): one document per project written as
//! complete create-only generations under
//! `app_data/boards-v1/<workspace dir>/board-<20-digit generation>.json`,
//! the pattern of `pipeline_library.rs`. A failed write leaves the previous
//! generation authoritative; a damaged generation is skipped on load, never
//! partially applied; the newest three generations are kept. Never written
//! into the project folder. Behind [`BoardStore`] so ADR-031 can replace it.

use super::model::{Board, BoardError};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

const DOCUMENT_VERSION: u32 = 1;
pub(crate) const DIRECTORY: &str = "boards-v1";
const GENERATION_PREFIX: &str = "board-";
const GENERATION_SUFFIX: &str = ".json";
/// Generations kept on disk after a successful write.
pub(crate) const KEPT_GENERATIONS: usize = 3;
/// Longest workspace id accepted as a storage key.
const MAX_WORKSPACE_ID_BYTES: usize = 128;

/// Storage of whole board documents. Implementations must make `save`
/// atomic: after an error the previously saved board is still loaded.
pub(crate) trait BoardStore: Send + Sync {
    /// The newest intact board of a project, if one was ever saved.
    fn load(&self, workspace_id: &str) -> Result<Option<Board>, BoardError>;
    /// Durably stores `board` as the project's newest board.
    fn save(&self, board: &Board) -> Result<(), BoardError>;
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u32,
    generation: u64,
    board: Board,
}

/// Generation files in the application data folder.
pub(crate) struct FileBoardStore {
    root: PathBuf,
}

impl FileBoardStore {
    pub(crate) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let root = app_data_dir.join(DIRECTORY);
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn directory(&self, workspace_id: &str) -> Result<PathBuf, BoardError> {
        Ok(self.root.join(workspace_directory_name(workspace_id)?))
    }
}

/// A directory name for a workspace id that can never leave the store root:
/// ids made only of ASCII letters, digits, `-` and `_` are used as they are;
/// anything else is hex-encoded behind an `x-` prefix (which a plain id cannot
/// collide with, since plain ids are used only when they do not start `x-`).
pub(crate) fn workspace_directory_name(workspace_id: &str) -> Result<String, BoardError> {
    if workspace_id.is_empty() || workspace_id.len() > MAX_WORKSPACE_ID_BYTES {
        return Err(BoardError::Invalid("That project id is not valid."));
    }
    let plain = workspace_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && !workspace_id.starts_with("x-");
    if plain {
        return Ok(workspace_id.to_owned());
    }
    let mut name = String::with_capacity(2 + workspace_id.len() * 2);
    name.push_str("x-");
    for byte in workspace_id.bytes() {
        name.push_str(&format!("{byte:02x}"));
    }
    Ok(name)
}

impl BoardStore for FileBoardStore {
    fn load(&self, workspace_id: &str) -> Result<Option<Board>, BoardError> {
        let directory = self.directory(workspace_id)?;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(BoardError::Io),
        };
        let mut newest: Option<(u64, Board)> = None;
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(generation) = generation_from_path(&path) else {
                continue;
            };
            if newest
                .as_ref()
                .is_some_and(|(current, _)| *current >= generation)
            {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            let Ok(document) = serde_json::from_slice::<Document>(&bytes) else {
                continue;
            };
            // A damaged or foreign generation is skipped, never partially applied.
            if document.version != DOCUMENT_VERSION
                || document.generation != generation
                || document.board.workspace_id != workspace_id
            {
                continue;
            }
            newest = Some((generation, document.board));
        }
        Ok(newest.map(|(_, board)| board))
    }

    fn save(&self, board: &Board) -> Result<(), BoardError> {
        let directory = self.directory(&board.workspace_id)?;
        fs::create_dir_all(&directory).map_err(|_| BoardError::Io)?;
        let generation = newest_generation(&directory)
            .checked_add(1)
            .ok_or(BoardError::Io)?;
        let document = Document {
            version: DOCUMENT_VERSION,
            generation,
            board: board.clone(),
        };
        let bytes = serde_json::to_vec(&document).map_err(|_| BoardError::Io)?;
        let path = generation_path(&directory, generation);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| BoardError::Io)?;
        if write_complete(&mut file, &bytes).is_err() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(BoardError::Io);
        }
        remove_old_generations(&directory, generation);
        Ok(())
    }
}

fn newest_generation(directory: &Path) -> u64 {
    fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| generation_from_path(&entry.path()))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

fn write_complete(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}

pub(crate) fn generation_path(directory: &Path, generation: u64) -> PathBuf {
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

/// Keeps the newest `KEPT_GENERATIONS` generations up to `current`.
fn remove_old_generations(directory: &Path, current: u64) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let keep_from = current.saturating_sub(KEPT_GENERATIONS as u64 - 1);
    for entry in entries.flatten() {
        let path = entry.path();
        if generation_from_path(&path).is_some_and(|generation| generation < keep_from) {
            let _ = fs::remove_file(path);
        }
    }
}

/// In-memory store for tests and UI-less hosts.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryBoardStore {
    boards: std::sync::Mutex<std::collections::BTreeMap<String, Board>>,
    pub(crate) fail_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl BoardStore for MemoryBoardStore {
    fn load(&self, workspace_id: &str) -> Result<Option<Board>, BoardError> {
        Ok(self
            .boards
            .lock()
            .map_err(|_| BoardError::Io)?
            .get(workspace_id)
            .cloned())
    }

    fn save(&self, board: &Board) -> Result<(), BoardError> {
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(BoardError::Io);
        }
        self.boards
            .lock()
            .map_err(|_| BoardError::Io)?
            .insert(board.workspace_id.clone(), board.clone());
        Ok(())
    }
}
