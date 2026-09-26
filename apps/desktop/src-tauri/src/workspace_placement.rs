//! Placement-aware workspace host operations (workspace placement v1 and
//! adoption v1). A child module of `workspace_api`, so it shares the host's
//! private registry and lifecycle without widening them to the crate.

use super::{
    HarnessKind, PermissionMode, PersistedSession, SessionSnapshot, SessionStatus,
    WorkspaceAuthorization, WorkspaceError, WorkspaceEventPublisher, WorkspaceHost,
    WorkspaceLaunchRequest, lock, now_string,
};
use crate::session_placement::{SessionPlacement, SessionTools, WorktreeBinding};
use piui_platform::ProjectDirectory;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(crate) fn worktree_removed() -> WorkspaceError {
    WorkspaceError {
        code: "WORKTREE_REMOVED",
        message: "This chat's worktree was removed. Its history stays readable; start a new chat to keep working.",
        recoverable: true,
    }
}

pub(crate) fn worktree_missing() -> WorkspaceError {
    WorkspaceError {
        code: "WORKTREE_UNAVAILABLE",
        message: "This chat's worktree folder is missing or no longer belongs to the project's repository.",
        recoverable: true,
    }
}

/// Whether two native paths name the same existing file.
fn same_file(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn bound_pi(
    sessions: &[PersistedSession],
    workspace_id: &str,
    native_path: &Path,
) -> Option<String> {
    sessions
        .iter()
        .find(|record| {
            record.harness == HarnessKind::Pi
                && record.workspace_id == workspace_id
                && record
                    .native_path
                    .as_deref()
                    .is_some_and(|bound| same_file(Path::new(bound), native_path))
        })
        .map(|record| record.id.clone())
}

impl WorkspaceHost {
    pub(crate) fn tools(&self) -> &SessionTools {
        &self.inner.tools
    }

    /// The folder a start uses: a worktree chat runs in its worktree, every
    /// other chat in its project folder.
    pub(super) fn launch_cwd(
        &self,
        session_id: &str,
        directory: &ProjectDirectory,
    ) -> Result<PathBuf, WorkspaceError> {
        let project = directory.canonical_path().to_path_buf();
        let Some(placement) = self.inner.tools.placement(session_id)? else {
            return Ok(project);
        };
        match &placement.worktree {
            Some(binding) if binding.removed() => Err(worktree_removed()),
            Some(binding) => {
                let cwd = binding.cwd();
                if cwd.is_dir() {
                    Ok(cwd)
                } else {
                    Err(worktree_missing())
                }
            }
            None => Ok(project),
        }
    }

    /// Adopted terminal sessions keep their own name: PiUI never passes a
    /// title that Pi would write into the session file.
    pub(super) fn adopted(&self, session_id: &str) -> bool {
        matches!(self.inner.tools.placement(session_id), Ok(Some(placement)) if placement.adopted)
    }

    /// The folder a chat's native history belongs to: its worktree (kept as
    /// an empty folder after removal) or the project folder.
    pub(crate) fn history_directory(
        &self,
        session_id: &str,
        project: ProjectDirectory,
    ) -> Result<ProjectDirectory, WorkspaceError> {
        match self.inner.tools.placement(session_id)? {
            Some(SessionPlacement {
                worktree: Some(binding),
                ..
            }) => ProjectDirectory::resolve(&binding.cwd()).map_err(|_| worktree_missing()),
            _ => Ok(project),
        }
    }

    /// Before a worktree chat starts, git confirms that the worktree still
    /// belongs to the project's repository. Trust is the project's trust.
    pub(super) async fn verify_worktree_before_open(
        &self,
        session_id: &str,
        authorize: WorkspaceAuthorization<'_>,
    ) -> Result<(), WorkspaceError> {
        let Some(placement) = self.inner.tools.placement(session_id)? else {
            return Ok(());
        };
        let Some(binding) = placement.worktree else {
            return Ok(());
        };
        if binding.removed() {
            return Err(worktree_removed());
        }
        let project = authorize(&placement.workspace_id)?;
        crate::placement_api::verify_worktree(&self.inner.tools, &binding, &project).await
    }

    /// Creates a chat whose placement is recorded before its runtime starts,
    /// so the start already runs in the right folder. A failed start leaves
    /// neither a catalog row nor a placement.
    pub(crate) async fn create_placed_session(
        &self,
        gate: &tokio::sync::Mutex<()>,
        authorize: WorkspaceAuthorization<'_>,
        mut request: WorkspaceLaunchRequest,
        placement: SessionPlacement,
        publisher: WorkspaceEventPublisher,
    ) -> Result<SessionSnapshot, WorkspaceError> {
        let session_id = placement.session_id.clone();
        request.session_id = Some(session_id.clone());
        self.inner.tools.save(&placement)?;
        let result = self
            .create_session(gate, authorize, request, publisher)
            .await;
        if result.is_err() && self.record(&session_id).is_err() {
            self.inner.tools.discard(&session_id);
        }
        result
    }

    /// The Pi chat of `workspace_id` already bound to `native_path`, if any.
    pub(crate) fn bound_pi_session(
        &self,
        workspace_id: &str,
        native_path: &Path,
    ) -> Result<Option<String>, WorkspaceError> {
        Ok(bound_pi(
            lock(&self.inner.registry)?.sessions(),
            workspace_id,
            native_path,
        ))
    }

    /// Registers a Pi session file (already admitted by the caller) as a
    /// closed workspace chat, or returns the chat already bound to it. The
    /// session file is never written here.
    pub(crate) fn register_adopted_pi_session(
        &self,
        workspace_id: &str,
        native_id: String,
        native_path: &Path,
        title: String,
    ) -> Result<(String, bool), WorkspaceError> {
        let path = native_path
            .to_str()
            .ok_or_else(WorkspaceError::invalid)?
            .to_owned();
        let existing =
            |sessions: &[PersistedSession]| bound_pi(sessions, workspace_id, native_path);
        if let Some(id) = existing(lock(&self.inner.registry)?.sessions()) {
            return Ok((id, false));
        }
        let id = Uuid::new_v4().to_string();
        let mut placement = SessionPlacement::new(&id, workspace_id);
        placement.adopted = true;
        self.inner.tools.save(&placement)?;
        let record = PersistedSession {
            composer: Default::default(),
            usage: Vec::new(),
            id: id.clone(),
            workspace_id: workspace_id.to_owned(),
            harness: HarnessKind::Pi,
            title,
            updated_at: now_string(),
            model: None,
            thinking_level: None,
            permission_mode: PermissionMode::Native,
            profile_id: None,
            run_id: None,
            member_id: None,
            native_id: Some(native_id),
            native_path: Some(path),
            revision: 0,
            materialized: Some(true),
        };
        let inserted = lock(&self.inner.registry)?
            .transact(|sessions| {
                if let Some(bound) = existing(sessions) {
                    return Ok(Some(bound));
                }
                sessions.push(record);
                Ok(None)
            })
            .map_err(|_| WorkspaceError::io());
        match inserted {
            Ok(None) => Ok((id, true)),
            Ok(Some(bound)) => {
                self.inner.tools.discard(&id);
                Ok((bound, false))
            }
            Err(error) => {
                self.inner.tools.discard(&id);
                Err(error)
            }
        }
    }

    /// The project a chat belongs to.
    pub(crate) fn session_workspace_id(&self, session_id: &str) -> Result<String, WorkspaceError> {
        Ok(self.record(session_id)?.workspace_id)
    }

    /// Whether a chat exists in the registry.
    pub(crate) fn session_exists(&self, session_id: &str) -> bool {
        self.record(session_id).is_ok()
    }

    /// The live status of a chat; `Starting` while a start is reserved.
    pub(crate) fn live_status(&self, session_id: &str) -> Result<SessionStatus, WorkspaceError> {
        if self.pending_start(session_id).is_some() {
            return Ok(SessionStatus::Starting);
        }
        match self.live_runtime(session_id)? {
            Some((_, state)) => Ok(*lock(&state.status)?),
            None => Ok(SessionStatus::Closed),
        }
    }

    /// Stops an idle or failed chat's runtime; a working chat is a conflict.
    pub(crate) async fn stop_idle_session(&self, session_id: &str) -> Result<(), WorkspaceError> {
        match self.live_status(session_id)? {
            SessionStatus::Closed => Ok(()),
            SessionStatus::Idle | SessionStatus::Failed => self.close_session(session_id).await,
            SessionStatus::Starting | SessionStatus::Running | SessionStatus::Stopping => {
                Err(WorkspaceError::conflict())
            }
        }
    }

    /// Chats (still in the registry) that run in the worktree at `root`.
    pub(crate) fn sessions_in_worktree(&self, root: &Path) -> Result<Vec<String>, WorkspaceError> {
        let placements = self.inner.tools.placements()?;
        Ok(placements
            .into_iter()
            .filter(|placement| {
                placement
                    .active_worktree()
                    .is_some_and(|binding| binding.root == root)
            })
            .map(|placement| placement.session_id)
            .filter(|session_id| self.record(session_id).is_ok())
            .collect())
    }

    /// Marks every placement bound to the worktree at `root` removed, or
    /// back as present when git could not remove it.
    pub(crate) fn mark_worktree_removed(
        &self,
        root: &Path,
        removed: bool,
    ) -> Result<(), WorkspaceError> {
        let removed_at = now_string();
        for mut placement in self.inner.tools.placements()? {
            let Some(binding) = placement.worktree.as_mut() else {
                continue;
            };
            if binding.root == root && binding.removed_at.is_some() != removed {
                binding.removed_at = removed.then(|| removed_at.clone());
                self.inner.tools.save(&placement)?;
            }
        }
        Ok(())
    }

    /// The current binding of a chat's worktree, if any.
    pub(crate) fn worktree_binding(
        &self,
        session_id: &str,
    ) -> Result<Option<WorktreeBinding>, WorkspaceError> {
        Ok(self
            .inner
            .tools
            .placement(session_id)?
            .and_then(|placement| placement.worktree))
    }
}
