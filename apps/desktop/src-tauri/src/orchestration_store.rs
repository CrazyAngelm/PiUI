//! Atomic durable storage for user-authored orchestration data.
//!
//! This is separate application data, not the rebuildable session index. Each
//! complete generation is create-only and fsynced before it becomes current in
//! memory. A failed write leaves the previous generation authoritative.

use crate::orchestration_schedule::StoredSchedule;
use piui_orchestration::{
    AgentProfile, Coordinator, LaunchCommandReference, PipelineDefinition, Run, TeamDefinition,
    Teammate, deserialize_run, serialize_run,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use thiserror::Error;

const STORE_VERSION: u32 = 2;
const MIN_STORE_VERSION: u32 = 1;
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
    #[serde(default)]
    pub schedules: Vec<StoredSchedule>,
    /// Project teammates (ADR-041, additive). Saved and deleted in the same
    /// generation as the definitions they manage.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub teammates: Vec<Teammate>,
    pub runs: Vec<Run>,
    /// Runs hidden from the default run list (run debugging v1). UI metadata
    /// only: it never changes a run record, its revision or its scheduling.
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub archived_run_ids: std::collections::BTreeSet<String>,
}

impl WorkspaceOrchestration {
    pub fn empty(workspace_id: String) -> Self {
        Self {
            workspace_id,
            profiles: Vec::new(),
            teams: Vec::new(),
            pipelines: Vec::new(),
            launch_commands: Vec::new(),
            schedules: Vec::new(),
            teammates: Vec::new(),
            runs: Vec::new(),
            archived_run_ids: std::collections::BTreeSet::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreDocument {
    version: u32,
    generation: u64,
    workspaces: Vec<WorkspaceOrchestration>,
    /// Host v7.2: no automation starts a run while set. Omitted when false,
    /// so a store that never paused keeps its previous shape.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    automations_paused: bool,
}

impl Default for StoreDocument {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            generation: 0,
            workspaces: Vec::new(),
            automations_paused: false,
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

/// Immutable view of one durable generation. Holding it never blocks a writer.
#[derive(Clone)]
pub(crate) struct StoreSnapshot(Arc<StoreDocument>);

impl StoreSnapshot {
    pub fn workspace(&self, workspace_id: &str) -> Option<&WorkspaceOrchestration> {
        self.0
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
    }

    pub fn workspaces(&self) -> &[WorkspaceOrchestration] {
        &self.0.workspaces
    }

    /// Whether every automation is paused (host v7.2).
    pub fn automations_paused(&self) -> bool {
        self.0.automations_paused
    }
}

/// Durable orchestration journal.
///
/// Writers are serialized by `writer`, which is held across the staged clone,
/// the change and its create-only fsynced generation write, so write order and
/// every revision check are exactly those of a single global lock. The
/// published generation is swapped in afterwards under a brief `current` write
/// lock; readers only clone the `Arc` and never wait for serialization or
/// fsync.
pub(crate) struct OrchestrationStore {
    directory: PathBuf,
    writer: Mutex<()>,
    current: RwLock<Arc<StoreDocument>>,
    /// The newest committed generation, for observers such as event
    /// automations. Values are published after the commit is current.
    commits: tokio::sync::watch::Sender<u64>,
}

fn poisoned() -> StoreError {
    StoreError::Io(io::Error::other("orchestration store lock poisoned"))
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
                    let valid = (MIN_STORE_VERSION..=STORE_VERSION).contains(&document.version)
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
        let document = newest.map(|(_, document)| document).unwrap_or_default();
        let (commits, _) = tokio::sync::watch::channel(document.generation);
        Ok(Self {
            directory,
            writer: Mutex::new(()),
            current: RwLock::new(Arc::new(document)),
            commits,
        })
    }

    /// Wakes whenever a newer generation commits. Several quick commits may
    /// be observed once; observers read the latest snapshot.
    pub fn subscribe_commits(&self) -> tokio::sync::watch::Receiver<u64> {
        self.commits.subscribe()
    }

    /// The newest durable generation. Never waits for a writer's fsync.
    pub fn snapshot(&self) -> Result<StoreSnapshot, StoreError> {
        self.current
            .read()
            .map(|current| StoreSnapshot(Arc::clone(&current)))
            .map_err(|_| poisoned())
    }

    /// Applies `change` to a staged copy of the newest generation and makes it
    /// current only after its complete generation file has been fsynced.
    pub fn transact<T>(
        &self,
        change: impl FnOnce(&mut Vec<WorkspaceOrchestration>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.transact_document(|document| change(&mut document.workspaces))
    }

    /// Like `transact`, and the change also sees whether automations are
    /// paused in the same generation, so a pause can never race a claim.
    pub fn transact_automations<T>(
        &self,
        change: impl FnOnce(&mut Vec<WorkspaceOrchestration>, bool) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.transact_document(|document| {
            let paused = document.automations_paused;
            change(&mut document.workspaces, paused)
        })
    }

    /// Durably pauses or resumes every automation. Returns whether the value
    /// changed; an unchanged value writes nothing.
    pub fn set_automations_paused(&self, paused: bool) -> Result<bool, StoreError> {
        if self.snapshot()?.automations_paused() == paused {
            return Ok(false);
        }
        self.transact_document(|document| {
            let changed = document.automations_paused != paused;
            document.automations_paused = paused;
            Ok(changed)
        })
    }

    fn transact_document<T>(
        &self,
        change: impl FnOnce(&mut StoreDocument) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let _writer = self.writer.lock().map_err(|_| poisoned())?;
        let mut staged = StoreDocument::clone(&self.snapshot()?.0);
        let result = change(&mut staged)?;
        staged.generation = staged
            .generation
            .checked_add(1)
            .ok_or(StoreError::Invalid)?;
        self.persist(&staged)?;
        let generation = staged.generation;
        *self.current.write().map_err(|_| poisoned())? = Arc::new(staged);
        self.remove_older_generations(generation);
        self.commits.send_replace(generation);
        Ok(result)
    }

    /// Marks only work that had crossed the native boundary uncertain. Ready
    /// work is safe to schedule later because it has no native side effect.
    pub fn recover_interrupted_runs(&self) -> Result<(), StoreError> {
        let needs_recovery = self.snapshot()?.workspaces().iter().any(|workspace| {
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

    fn remove_older_generations(&self, current: u64) {
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if generation_from_path(&path).is_some_and(|generation| generation < current) {
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
    document.version = STORE_VERSION;
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
        let snapshot = store.snapshot().unwrap();
        let run = &snapshot.workspace("project").unwrap().runs[0];
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
    fn automation_pause_is_durable_observed_and_absent_until_used() {
        let root = root();
        let store = OrchestrationStore::open(&root).expect("opens store");
        let mut commits = store.subscribe_commits();
        store
            .transact(|workspaces| {
                workspaces.push(WorkspaceOrchestration::empty("kept".to_owned()));
                Ok(())
            })
            .expect("writes baseline");
        assert!(commits.has_changed().expect("sender alive"));
        assert_eq!(*commits.borrow_and_update(), 1);
        let baseline = fs::read(generation_path(&store.directory, 1)).expect("reads generation");
        assert!(!String::from_utf8_lossy(&baseline).contains("automationsPaused"));
        assert!(!store.snapshot().unwrap().automations_paused());

        assert!(store.set_automations_paused(true).expect("pauses"));
        assert!(!store.set_automations_paused(true).expect("already paused"));
        assert!(store.snapshot().unwrap().automations_paused());
        assert_eq!(*commits.borrow_and_update(), 2);
        let seen = store
            .transact_automations(|_, paused| Ok(paused))
            .expect("reads the flag inside the writer");
        assert!(seen);
        drop(store);

        let reopened = OrchestrationStore::open(&root).expect("reopens");
        assert!(reopened.snapshot().unwrap().automations_paused());
        assert!(reopened.snapshot().unwrap().workspace("kept").is_some());
        assert!(reopened.set_automations_paused(false).expect("resumes"));
        drop(reopened);
        let resumed = OrchestrationStore::open(&root).expect("reopens again");
        assert!(!resumed.snapshot().unwrap().automations_paused());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_transaction_rolls_back_memory_and_disk() {
        let root = root();
        let store = OrchestrationStore::open(&root).expect("opens store");
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
        assert!(store.snapshot().unwrap().workspace("kept").is_some());
        let restored = OrchestrationStore::open(&root).expect("restores baseline");
        assert!(restored.snapshot().unwrap().workspace("kept").is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_generation_publish_keeps_previous_document() {
        let root = root();
        let store = OrchestrationStore::open(&root).expect("opens store");
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
        assert!(store.snapshot().unwrap().workspace("kept").is_some());
        fs::remove_file(generation_path(&store.directory, 2)).expect("removes collision");
        let restored = OrchestrationStore::open(&root).expect("restores baseline");
        assert!(restored.snapshot().unwrap().workspace("kept").is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn readers_are_served_the_durable_generation_while_a_writer_commits() {
        let root = root();
        let store = Arc::new(OrchestrationStore::open(&root).expect("opens store"));
        store
            .transact(|workspaces| {
                workspaces.push(WorkspaceOrchestration::empty("first".to_owned()));
                Ok(())
            })
            .expect("writes baseline");
        let (entered, writer_inside) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let writer = std::thread::spawn({
            let store = Arc::clone(&store);
            move || {
                store.transact(|workspaces| {
                    entered.send(()).expect("signals");
                    released.recv().expect("released");
                    workspaces.push(WorkspaceOrchestration::empty("second".to_owned()));
                    Ok(())
                })
            }
        });
        writer_inside
            .recv()
            .expect("writer holds the write section");
        // With one store-wide lock this read would wait for the writer.
        let snapshot = store.snapshot().expect("reader is not blocked");
        assert!(snapshot.workspace("first").is_some());
        assert!(snapshot.workspace("second").is_none());
        release.send(()).expect("releases writer");
        writer.join().expect("writer thread").expect("commits");
        assert!(
            snapshot.workspace("second").is_none(),
            "snapshots are immutable"
        );
        assert!(
            store
                .snapshot()
                .expect("snapshot")
                .workspace("second")
                .is_some()
        );
        // Writers stay serialized: the next change starts from that commit.
        store
            .transact(|workspaces| {
                assert_eq!(workspaces.len(), 2);
                Ok(())
            })
            .expect("next write");
        let restored = OrchestrationStore::open(&root).expect("restores");
        assert_eq!(restored.snapshot().expect("snapshot").workspaces().len(), 2);
        drop(snapshot);
        drop(store);
        let _ = fs::remove_dir_all(root);
    }
}
