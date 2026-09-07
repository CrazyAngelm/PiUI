//! Atomic durable storage for user-authored orchestration data.
//!
//! This is separate application data, not the rebuildable session index. Each
//! complete generation is create-only and fsynced before it becomes current in
//! memory. A failed write leaves the previous generation authoritative.

use piui_orchestration::{
    AgentProfile, Coordinator, LaunchCommandReference, PipelineDefinition, Run, TeamDefinition,
    deserialize_run, serialize_run,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

const STORE_VERSION: u32 = 1;
const STORE_DIRECTORY: &str = "orchestration-v1";
const GENERATION_PREFIX: &str = "orchestration-";
const GENERATION_SUFFIX: &str = ".json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredDefinition<T> {
    pub revision: u64,
    pub value: T,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceOrchestration {
    pub workspace_id: String,
    pub profiles: Vec<StoredDefinition<AgentProfile>>,
    pub teams: Vec<StoredDefinition<TeamDefinition>>,
    pub pipelines: Vec<StoredDefinition<PipelineDefinition>>,
    pub launch_commands: Vec<StoredDefinition<LaunchCommandReference>>,
    pub runs: Vec<Run>,
}

impl WorkspaceOrchestration {
    pub fn empty(workspace_id: String) -> Self {
        Self {
            workspace_id,
            profiles: Vec::new(),
            teams: Vec::new(),
            pipelines: Vec::new(),
            launch_commands: Vec::new(),
            runs: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreDocument {
    version: u32,
    generation: u64,
    workspaces: Vec<WorkspaceOrchestration>,
}

impl Default for StoreDocument {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            generation: 0,
            workspaces: Vec::new(),
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum StoreError {
    #[error("orchestration data was changed by another operation")]
    Conflict,
    #[error("orchestration object already exists")]
    AlreadyExists,
    #[error("orchestration object was not found")]
    NotFound,
    #[error("orchestration input is invalid")]
    Invalid,
    #[error("orchestration operation is denied")]
    Denied,
    #[error("orchestration storage failed")]
    Io(#[source] io::Error),
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub(crate) struct OrchestrationStore {
    directory: PathBuf,
    document: StoreDocument,
}

impl OrchestrationStore {
    pub fn open(app_data_dir: &Path) -> Result<Self, StoreError> {
        let directory = app_data_dir.join(STORE_DIRECTORY);
        fs::create_dir_all(&directory)?;
        let mut newest: Option<(u64, StoreDocument)> = None;
        for entry in fs::read_dir(&directory)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let Some(generation) = generation_from_path(&path) else {
                continue;
            };
            let valid = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<StoreDocument>(&bytes).ok())
                .and_then(|mut document| {
                    let valid = document.version == STORE_VERSION
                        && document.generation == generation
                        && migrate_document(&mut document);
                    valid.then_some(document)
                });
            let Some(document) = valid else {
                // An interrupted create-only generation is never authoritative.
                let _ = fs::remove_file(path);
                continue;
            };
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
        })
    }

    pub fn workspace(&self, workspace_id: &str) -> Option<&WorkspaceOrchestration> {
        self.document
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
    }

    pub fn transact<T>(
        &mut self,
        change: impl FnOnce(&mut Vec<WorkspaceOrchestration>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut staged = self.document.clone();
        let result = change(&mut staged.workspaces)?;
        staged.generation = staged
            .generation
            .checked_add(1)
            .ok_or(StoreError::Invalid)?;
        self.persist(&staged)?;
        self.document = staged;
        self.remove_older_generations();
        Ok(result)
    }

    /// Marks only work that had crossed the native boundary uncertain. Ready
    /// work is safe to schedule later because it has no native side effect.
    pub fn recover_interrupted_runs(&mut self) -> Result<(), StoreError> {
        let needs_recovery = self.document.workspaces.iter().any(|workspace| {
            workspace.runs.iter().any(|run| {
                run.tasks().iter().any(|task| {
                    task.status() == piui_orchestration::TaskStatus::Running
                        || (task.status() == piui_orchestration::TaskStatus::Ready
                            && task.lease_id().is_some())
                })
            })
        });
        if !needs_recovery {
            return Ok(());
        }
        self.transact(|workspaces| {
            for workspace in workspaces {
                for run in &mut workspace.runs {
                    let revision = run.revision();
                    Coordinator::restore(run, revision).map_err(|_| StoreError::Invalid)?;
                }
            }
            Ok(())
        })
    }

    fn persist(&self, document: &StoreDocument) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(document)
            .map_err(|error| StoreError::Io(io::Error::other(error)))?;
        let path = generation_path(&self.directory, document.generation);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        if let Err(error) = write_complete(&mut file, &bytes) {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(StoreError::Io(error));
        }
        Ok(())
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

fn migrate_document(document: &mut StoreDocument) -> bool {
    let mut workspace_ids = std::collections::BTreeSet::new();
    for workspace in &mut document.workspaces {
        if workspace.workspace_id.trim().is_empty()
            || !workspace_ids.insert(workspace.workspace_id.as_str())
        {
            return false;
        }
        for run in &mut workspace.runs {
            let Ok(bytes) = serialize_run(run) else {
                return false;
            };
            let Ok(migrated) = deserialize_run(&bytes) else {
                return false;
            };
            *run = migrated;
        }
    }
    true
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
    use super::*;
    use uuid::Uuid;

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("piui-orchestration-store-{}", Uuid::new_v4()))
    }

    #[test]
    fn opening_v1_generation_returns_migrated_runs_without_rewriting_source() {
        let root = root();
        let directory = root.join(STORE_DIRECTORY);
        fs::create_dir_all(&directory).unwrap();
        let document = serde_json::json!({
            "version":1,"generation":1,"workspaces":[{
                "workspaceId":"project","profiles":[],"teams":[],"pipelines":[],"launchCommands":[],
                "runs":[{
                    "schemaVersion":1,"id":"old-run","status":"running","revision":0,"messages":[],"agentRequests":[],
                    "tasks":[{"stepId":"task","status":"ready","revision":0}],
                    "definition":{
                        "profiles":[{"id":"profile","name":"Worker","harness":"codex","model":"native","permissionMode":"native","instructions":"Keep this prompt","toolPolicy":{"rules":[]},"allowedSpawnProfileIds":[]}],
                        "team":{"id":"team","name":"Team","members":[{"id":"member","profileId":"profile"}],"sendEdges":[],"observeEdges":[],"orchestratorMemberId":"member"},
                        "pipeline":{"id":"pipeline","name":"Pipeline","steps":[{"id":"task","name":"Task","assignedMemberId":"member","instructions":"Work","dependencyStepIds":[]}]}
                    }
                }]
            }]
        });
        let source = serde_json::to_vec(&document).unwrap();
        let path = generation_path(&directory, 1);
        fs::write(&path, &source).unwrap();
        let store = OrchestrationStore::open(&root).unwrap();
        let run = &store.workspace("project").unwrap().runs[0];
        assert_eq!(run.schema_version(), 6);
        assert_eq!(
            run.definition().profiles[0].instructions,
            "Keep this prompt"
        );
        assert_eq!(run.definition().profiles[0].base_instructions, None);
        assert!(!run.definition().team.spawned_agents_join_team);
        assert_eq!(fs::read(path).unwrap(), source);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_transaction_rolls_back_memory_and_disk() {
        let root = root();
        let mut store = OrchestrationStore::open(&root).expect("opens store");
        store
            .transact(|workspaces| {
                workspaces.push(WorkspaceOrchestration::empty("kept".to_owned()));
                Ok(())
            })
            .expect("writes baseline");
        let result: Result<(), StoreError> = store.transact(|workspaces| {
            workspaces.clear();
            Err(StoreError::Invalid)
        });
        assert!(result.is_err());
        assert!(store.workspace("kept").is_some());
        let restored = OrchestrationStore::open(&root).expect("restores baseline");
        assert!(restored.workspace("kept").is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_generation_publish_keeps_previous_document() {
        let root = root();
        let mut store = OrchestrationStore::open(&root).expect("opens store");
        store
            .transact(|workspaces| {
                workspaces.push(WorkspaceOrchestration::empty("kept".to_owned()));
                Ok(())
            })
            .expect("writes baseline");
        fs::write(generation_path(&store.directory, 2), b"collision").expect("creates collision");
        let result = store.transact(|workspaces| {
            workspaces.clear();
            Ok(())
        });
        assert!(result.is_err());
        assert!(store.workspace("kept").is_some());
        fs::remove_file(generation_path(&store.directory, 2)).expect("removes collision");
        let restored = OrchestrationStore::open(&root).expect("restores baseline");
        assert!(restored.workspace("kept").is_some());
        let _ = fs::remove_dir_all(root);
    }
}
