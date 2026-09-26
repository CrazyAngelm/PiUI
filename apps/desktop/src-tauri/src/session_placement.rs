//! Host-private chat placement (workspace placement v1).
//!
//! A placement records where a chat runs and where it came from: a
//! PiUI-managed git worktree of its project, the chat it continues, or a Pi
//! session adopted from the terminal. One JSON file per session is replaced
//! atomically next to, not inside, the v11 session registry, whose format is
//! unchanged. A placement file that cannot be read fails closed: that chat
//! does not start until the file is readable again.

use crate::workspace_api::WorkspaceError;
use piui_runtime::git::GitRunner;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const PLACEMENT_DIRECTORY: &str = "workspace-placement-v1";
const PLACEMENT_VERSION: u32 = 1;
/// PiUI-managed worktrees live here, outside every project.
pub(crate) const WORKTREE_DIRECTORY: &str = "worktrees";
/// An empty folder git uses as `core.hooksPath`, so no repository hook runs.
const HOOKS_OFF_DIRECTORY: &str = "git-hooks-off";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorktreeBinding {
    /// Canonical root of the managed worktree folder.
    pub root: PathBuf,
    /// The project folder inside its repository (`""` or `"apps/web/"`).
    pub prefix: String,
    pub branch: String,
    /// Canonical common git directory of the project's repository.
    pub common_dir: PathBuf,
    pub base_commit: String,
    pub created_at: String,
    /// Set once the worktree was removed; its chats stay readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<String>,
}

impl WorktreeBinding {
    /// The chat's working folder: the project's place inside the worktree.
    pub(crate) fn cwd(&self) -> PathBuf {
        let mut cwd = self.root.clone();
        for part in self.prefix.split('/').filter(|part| !part.is_empty()) {
            cwd.push(part);
        }
        cwd
    }

    pub(crate) fn removed(&self) -> bool {
        self.removed_at.is_some()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionPlacement {
    pub version: u32,
    pub session_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_from: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub adopted: bool,
}

impl SessionPlacement {
    pub(crate) fn new(session_id: &str, workspace_id: &str) -> Self {
        Self {
            version: PLACEMENT_VERSION,
            session_id: session_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            worktree: None,
            continued_from: None,
            adopted: false,
        }
    }

    /// The worktree this chat runs in, unless it was removed.
    pub(crate) fn active_worktree(&self) -> Option<&WorktreeBinding> {
        self.worktree.as_ref().filter(|binding| !binding.removed())
    }
}

/// Per-session placement files plus the paths session tools need.
pub(crate) struct SessionTools {
    directory: PathBuf,
    records: Mutex<HashMap<String, SessionPlacement>>,
    damaged: Mutex<HashSet<String>>,
    worktree_root: PathBuf,
    hooks_dir: PathBuf,
}

fn damaged_error() -> WorkspaceError {
    WorkspaceError {
        code: "IO_ERROR",
        message: "PiUI could not read where this chat runs. Its history has not been removed.",
        recoverable: true,
    }
}

fn io_error() -> WorkspaceError {
    WorkspaceError {
        code: "IO_ERROR",
        message: "PiUI could not save where this chat runs.",
        recoverable: true,
    }
}

impl SessionTools {
    pub(crate) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let directory = app_data_dir.join(PLACEMENT_DIRECTORY);
        fs::create_dir_all(&directory)?;
        let worktree_root = app_data_dir.join(WORKTREE_DIRECTORY);
        fs::create_dir_all(&worktree_root)?;
        let hooks_dir = app_data_dir.join(HOOKS_OFF_DIRECTORY);
        fs::create_dir_all(&hooks_dir)?;
        let mut records = HashMap::new();
        let mut damaged = HashSet::new();
        for entry in fs::read_dir(&directory)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let Some(session_id) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".json"))
                .filter(|id| Uuid::parse_str(id).is_ok())
                .map(str::to_owned)
            else {
                continue;
            };
            match fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<SessionPlacement>(&bytes).ok())
                .filter(|record| {
                    record.version == PLACEMENT_VERSION && record.session_id == session_id
                }) {
                Some(record) => {
                    records.insert(session_id, record);
                }
                None => {
                    damaged.insert(session_id);
                }
            }
        }
        Ok(Self {
            directory,
            records: Mutex::new(records),
            damaged: Mutex::new(damaged),
            worktree_root,
            hooks_dir,
        })
    }

    pub(crate) fn worktree_root(&self) -> &Path {
        &self.worktree_root
    }

    /// Git resolved from `PATH` with hooks turned off.
    pub(crate) fn git(&self) -> Result<GitRunner, WorkspaceError> {
        GitRunner::resolve(self.hooks_dir.clone()).map_err(|_| WorkspaceError {
            code: "GIT_UNAVAILABLE",
            message: "Git was not found. Install git and make sure it is on PATH.",
            recoverable: true,
        })
    }

    /// The placement of a session; a damaged record fails closed.
    pub(crate) fn placement(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionPlacement>, WorkspaceError> {
        if self
            .damaged
            .lock()
            .map_err(|_| damaged_error())?
            .contains(session_id)
        {
            return Err(damaged_error());
        }
        Ok(self
            .records
            .lock()
            .map_err(|_| damaged_error())?
            .get(session_id)
            .cloned())
    }

    pub(crate) fn placements(&self) -> Result<Vec<SessionPlacement>, WorkspaceError> {
        Ok(self
            .records
            .lock()
            .map_err(|_| damaged_error())?
            .values()
            .cloned()
            .collect())
    }

    /// Writes a complete file next to the target, then renames it into place.
    pub(crate) fn save(&self, record: &SessionPlacement) -> Result<(), WorkspaceError> {
        Uuid::parse_str(&record.session_id).map_err(|_| io_error())?;
        let mut records = self.records.lock().map_err(|_| io_error())?;
        let bytes = serde_json::to_vec_pretty(record).map_err(|_| io_error())?;
        let target = self.directory.join(format!("{}.json", record.session_id));
        let staging = self
            .directory
            .join(format!(".{}.{}.tmp", record.session_id, Uuid::new_v4()));
        let written = (|| -> io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&staging, &target)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&staging);
            return Err(io_error());
        }
        records.insert(record.session_id.clone(), record.clone());
        if let Ok(mut damaged) = self.damaged.lock() {
            damaged.remove(&record.session_id);
        }
        Ok(())
    }

    /// Forgets a placement written for a chat that never started.
    pub(crate) fn discard(&self, session_id: &str) {
        if let Ok(mut records) = self.records.lock() {
            records.remove(session_id);
        }
        let _ = fs::remove_file(self.directory.join(format!("{session_id}.json")));
    }
}

/// A typed, recoverable session-tool refusal.
pub(crate) fn tool_error(code: &'static str, message: &'static str) -> WorkspaceError {
    WorkspaceError {
        code,
        message,
        recoverable: true,
    }
}

pub(crate) fn safe_mode_error() -> WorkspaceError {
    tool_error(
        "SAFE_MODE",
        "Safe mode is on: PiUI does not change files, git or chats.",
    )
}

pub(crate) fn stale_error() -> WorkspaceError {
    tool_error(
        "STALE",
        "This changed since you reviewed it. Check it again before continuing.",
    )
}

/// Maps a git failure to what the person can do about it.
pub(crate) fn git_error(error: piui_runtime::git::GitError) -> WorkspaceError {
    use piui_runtime::git::{GitError, GitRunError};
    match error {
        GitError::NotRepository => {
            tool_error("NOT_A_REPOSITORY", "This folder is not a git repository.")
        }
        GitError::Refused => tool_error(
            "GIT_REFUSED",
            "Git refused this folder because it belongs to another account. Add it to safe.directory in your git settings.",
        ),
        GitError::Busy => tool_error(
            "GIT_BUSY",
            "Another git command is using this repository. Try again in a moment.",
        ),
        GitError::NoCommits => tool_error(
            "NO_COMMITS",
            "The repository has no commits yet. Make a first commit before creating a worktree.",
        ),
        GitError::DoesNotApply => stale_error(),
        GitError::Run(GitRunError::Unavailable) => tool_error(
            "GIT_UNAVAILABLE",
            "Git was not found. Install git and make sure it is on PATH.",
        ),
        GitError::Run(GitRunError::TooLarge) => tool_error(
            "TOO_LARGE",
            "This change is too large for PiUI to show. Use git directly for it.",
        ),
        GitError::Run(GitRunError::TimedOut) => {
            tool_error("GIT_FAILED", "Git did not finish in time.")
        }
        GitError::Failed
        | GitError::Malformed
        | GitError::Run(GitRunError::NotStarted | GitRunError::Unobserved) => {
            tool_error("GIT_FAILED", "Git could not complete the operation.")
        }
    }
}

/// A folder name PiUI chooses inside the managed worktree area: lowercase
/// letters, digits and `-`, from `text`, at most 48 characters.
pub(crate) fn folder_slug(text: &str) -> String {
    let mut slug = String::new();
    for character in text.chars() {
        let character = character.to_ascii_lowercase();
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 48 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() { "chat".into() } else { slug }
}

/// `<project name>-<8 hex of the project id>`: one folder per project.
pub(crate) fn project_folder(project_name: &str, project_id: &str) -> String {
    let digest = piui_runtime::git::sha256_hex(project_id.as_bytes());
    format!("{}-{}", folder_slug(project_name), &digest[..8])
}

/// A home-relative spelling for display (`~/…`), never a credential.
pub(crate) fn display_path(path: &Path) -> String {
    let plain = piui_runtime::git::plain_path(path);
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|home| home.is_absolute());
    if let Some(home) = home {
        let home = piui_runtime::git::plain_path(&home);
        if let Ok(rest) = plain.strip_prefix(&home) {
            let rest = rest.to_string_lossy().replace('\\', "/");
            return if rest.is_empty() {
                "~".into()
            } else {
                format!("~/{rest}")
            };
        }
    }
    plain.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        SessionPlacement, SessionTools, WorktreeBinding, display_path, folder_slug, project_folder,
    };
    use std::path::PathBuf;
    use uuid::Uuid;

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("piui-placement-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("creates root");
        root
    }

    #[test]
    fn placements_survive_a_restart_and_damaged_files_fail_closed() {
        let root = root();
        let session = Uuid::new_v4().to_string();
        let tools = SessionTools::open(&root).expect("opens");
        let mut record = SessionPlacement::new(&session, "workspace");
        record.continued_from = Some(Uuid::new_v4().to_string());
        record.worktree = Some(WorktreeBinding {
            root: root.join("worktrees").join("x"),
            prefix: "apps/web/".into(),
            branch: "piui/x".into(),
            common_dir: root.join(".git"),
            base_commit: "a".repeat(40),
            created_at: "1".into(),
            removed_at: None,
        });
        tools.save(&record).expect("saves");
        assert!(root.join("git-hooks-off").is_dir());
        let reopened = SessionTools::open(&root).expect("reopens");
        let restored = reopened
            .placement(&session)
            .expect("readable")
            .expect("present");
        assert_eq!(restored, record);
        assert_eq!(
            restored.active_worktree().expect("active").cwd(),
            root.join("worktrees").join("x").join("apps").join("web")
        );

        let damaged = Uuid::new_v4().to_string();
        std::fs::write(
            root.join("workspace-placement-v1")
                .join(format!("{damaged}.json")),
            b"{\"version\":1",
        )
        .expect("writes damaged file");
        let reopened = SessionTools::open(&root).expect("reopens with damage");
        assert_eq!(
            reopened.placement(&damaged).expect_err("fails closed").code,
            "IO_ERROR"
        );
        assert!(
            reopened
                .placement(&Uuid::new_v4().to_string())
                .expect("ok")
                .is_none()
        );
        reopened.discard(&session);
        assert!(
            SessionTools::open(&root)
                .expect("reopens")
                .placement(&session)
                .expect("ok")
                .is_none()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_fields_are_refused_not_dropped() {
        let text = format!(
            "{{\"version\":1,\"sessionId\":\"{}\",\"workspaceId\":\"w\",\"future\":true}}",
            Uuid::new_v4()
        );
        assert!(serde_json::from_str::<SessionPlacement>(&text).is_err());
    }

    #[test]
    fn folder_names_are_plain_and_stable() {
        assert_eq!(folder_slug("Fix the Login bug!"), "fix-the-login-bug");
        assert_eq!(folder_slug("piui/feature-x"), "piui-feature-x");
        assert_eq!(folder_slug("///"), "chat");
        assert_eq!(folder_slug(&"x".repeat(80)).len(), 48);
        let first = project_folder("My Project", "project-id");
        assert_eq!(first, project_folder("My Project", "project-id"));
        assert!(first.starts_with("my-project-"));
        assert_ne!(first, project_folder("My Project", "other-id"));
    }

    #[test]
    fn display_paths_abbreviate_the_home_folder() {
        let home =
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
        if let Some(home) = home.filter(|home| home.is_absolute()) {
            assert_eq!(display_path(&home.join("a").join("b")), "~/a/b");
        }
    }
}
