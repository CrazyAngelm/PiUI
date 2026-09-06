//! Host-private durable workspace session bindings.
//!
//! The registry stores only opaque PiUI ids, native resume references and
//! catalog metadata. Native transcripts remain owned by their harnesses.

use super::{HarnessKind, PermissionMode, WorkspaceModel};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const REGISTRY_VERSION: u32 = 1;
const REGISTRY_DIRECTORY: &str = "workspace-registry-v11";
const GENERATION_PREFIX: &str = "registry-";
const GENERATION_SUFFIX: &str = ".json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PersistedSession {
    pub id: String,
    pub workspace_id: String,
    pub harness: HarnessKind,
    pub title: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<WorkspaceModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    pub permission_mode: PermissionMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_path: Option<String>,
    #[serde(default)]
    pub revision: u64,
    /// Monotonic native history materialization proof. None is conservative
    /// legacy/unknown state and never authorizes an empty-history fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialized: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    version: u32,
    generation: u64,
    sessions: Vec<PersistedSession>,
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            generation: 0,
            sessions: Vec::new(),
        }
    }
}

pub(super) struct WorkspaceRegistry {
    directory: PathBuf,
    document: RegistryDocument,
    next_generation: u64,
}

impl WorkspaceRegistry {
    pub(super) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let directory = app_data_dir.join(REGISTRY_DIRECTORY);
        fs::create_dir_all(&directory)?;
        let mut newest: Option<(u64, RegistryDocument)> = None;
        let mut next_generation = 0_u64;
        for entry in fs::read_dir(&directory)? {
            let Ok(entry) = entry else { continue };
            let Some(generation) = generation_from_path(&entry.path()) else {
                continue;
            };
            next_generation = next_generation.max(generation);
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(document) = serde_json::from_slice::<RegistryDocument>(&bytes) else {
                continue;
            };
            if document.version != REGISTRY_VERSION || document.generation != generation {
                continue;
            }
            if newest
                .as_ref()
                .is_none_or(|(current, _)| generation > *current)
            {
                newest = Some((generation, document));
            }
        }
        Ok(Self {
            directory,
            document: newest.map(|(_, document)| document).unwrap_or_default(),
            next_generation,
        })
    }

    pub(super) fn sessions(&self) -> &[PersistedSession] {
        &self.document.sessions
    }

    pub(super) fn session(&self, session_id: &str) -> Option<PersistedSession> {
        self.document
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
    }

    /// Writes a complete next generation before publishing it in memory.
    /// Generation files are create-only, so any failed write leaves the
    /// previous valid document untouched on Windows and Unix alike.
    pub(super) fn transact<T>(
        &mut self,
        change: impl FnOnce(&mut Vec<PersistedSession>) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut staged = self.document.clone();
        let result = change(&mut staged.sessions)?;
        staged.generation = self
            .next_generation
            .checked_add(1)
            .ok_or_else(|| io::Error::other("workspace registry generation is exhausted"))?;
        let bytes = serde_json::to_vec(&staged).map_err(io::Error::other)?;
        let path = generation_path(&self.directory, staged.generation);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        if let Err(error) = write_complete(&mut file, &bytes) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        self.next_generation = staged.generation;
        self.document = staged;
        self.remove_older_generations();
        Ok(result)
    }

    fn remove_older_generations(&self) {
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if generation_from_path(&path)
                .is_some_and(|generation| generation < self.document.generation)
            {
                let _ = fs::remove_file(path);
            }
        }
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

#[cfg(test)]
mod tests {
    use super::{PersistedSession, WorkspaceRegistry, generation_path};
    use crate::workspace_api::{HarnessKind, PermissionMode};
    use std::fs;
    use uuid::Uuid;

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("piui-workspace-store-{}", Uuid::new_v4()))
    }

    fn session(id: &str) -> PersistedSession {
        PersistedSession {
            id: id.into(),
            workspace_id: "workspace".into(),
            harness: HarnessKind::Codex,
            title: "Session".into(),
            updated_at: "1".into(),
            model: None,
            thinking_level: None,
            permission_mode: PermissionMode::Native,
            profile_id: None,
            run_id: None,
            member_id: None,
            native_id: Some("host-private-native-id".into()),
            native_path: Some("host-private-native-path".into()),
            revision: 4,
            materialized: Some(true),
        }
    }

    #[test]
    fn restores_only_the_newest_complete_generation() {
        let root = test_root();
        let mut registry = WorkspaceRegistry::open(&root).expect("opens registry");
        registry
            .transact(|sessions| {
                sessions.push(session("first"));
                Ok(())
            })
            .expect("persists first generation");
        registry
            .transact(|sessions| {
                sessions.push(session("second"));
                Ok(())
            })
            .expect("persists second generation");
        fs::write(generation_path(&registry.directory, 3), b"truncated")
            .expect("writes interrupted generation fixture");

        let restored = WorkspaceRegistry::open(&root).expect("restores registry");
        assert_eq!(restored.sessions().len(), 2);
        assert_eq!(restored.sessions()[1].id, "second");
        let mut restored = restored;
        restored
            .transact(|sessions| {
                sessions.push(session("after-interruption"));
                Ok(())
            })
            .expect("skips occupied interrupted generation");
        assert_eq!(restored.sessions().len(), 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_change_does_not_modify_memory_or_disk() {
        let root = test_root();
        let mut registry = WorkspaceRegistry::open(&root).expect("opens registry");
        registry
            .transact(|sessions| {
                sessions.push(session("kept"));
                Ok(())
            })
            .expect("persists baseline");
        let result: std::io::Result<()> = registry.transact(|sessions| {
            sessions.clear();
            Err(std::io::Error::other("injected failure"))
        });
        assert!(result.is_err());
        assert_eq!(registry.sessions()[0].id, "kept");
        let restored = WorkspaceRegistry::open(&root).expect("restores baseline");
        assert_eq!(restored.sessions()[0].id, "kept");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn removed_chat_stays_removed_after_reload_without_touching_history() {
        let root = test_root();
        let mut registry = WorkspaceRegistry::open(&root).expect("opens registry");
        let history = root.join("native.jsonl");
        fs::write(&history, "native history").expect("writes native fixture");
        registry
            .transact(|sessions| {
                sessions.extend([session("removed"), session("kept")]);
                Ok(())
            })
            .expect("persists chats");
        registry
            .transact(|sessions| {
                sessions.retain(|session| session.id != "removed");
                Ok(())
            })
            .expect("deletes chat entry");
        let restored = WorkspaceRegistry::open(&root).expect("reloads registry");
        assert!(restored.session("removed").is_none());
        assert!(restored.session("kept").is_some());
        assert_eq!(
            fs::read_to_string(history).expect("native history remains"),
            "native history"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn serialized_registry_is_host_private_and_contains_no_transcript() {
        let root = test_root();
        let mut registry = WorkspaceRegistry::open(&root).expect("opens registry");
        registry
            .transact(|sessions| {
                sessions.push(session("opaque-session"));
                Ok(())
            })
            .expect("persists registry");
        let path = generation_path(&registry.directory, 1);
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(path).expect("reads registry"))
                .expect("parses registry");
        let row = &value["sessions"][0];
        assert!(row.get("blocks").is_none());
        assert!(row.get("approvals").is_none());
        assert_eq!(row["nativeId"], "host-private-native-id");
        let _ = fs::remove_dir_all(root);
    }
}
