//! Workspace placement v1 (`workspace_placement_v1`): chats that run in a
//! PiUI-managed git worktree of their project, chats that continue another
//! chat, and where each chat came from.
//!
//! A worktree is created with `git worktree add -b <new branch>` from the
//! project's current commit into `<app data>/worktrees/<project>/<folder>`,
//! only after the person confirmed the exact branch, folder and commit (a
//! change in between is refused as `STALE`). Its chats inherit the project's
//! trust once git confirms the worktree shares the project's common git
//! directory. Removing a worktree refuses uncommitted changes unless the
//! person confirmed losing exactly those changes; the branch is never
//! deleted. Nothing is copied from the project folder.

use crate::api::verified_project_directory;
use crate::session_placement::{
    SessionPlacement, SessionTools, WorktreeBinding, display_path, folder_slug, git_error,
    project_folder, safe_mode_error, stale_error, tool_error,
};
use crate::state::HostState;
use crate::workspace_api::placement::{worktree_missing, worktree_removed};
use crate::workspace_api::{
    HarnessKind, PermissionMode, SessionSnapshot, WorkspaceError, WorkspaceEventPublisher,
    WorkspaceLaunchRequest, WorkspaceModel, event_publisher,
};
use piui_platform::ProjectDirectory;
use piui_runtime::git::{self, GitRunner, StatusReport};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, State};
use uuid::Uuid;

pub const WORKSPACE_PLACEMENT_PROTOCOL: u8 = 1;
/// A folder name PiUI tries before giving up (`name`, `name-2`, …).
const FOLDER_ATTEMPTS: usize = 50;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorktreeRequestV1 {
    /// A new worktree on a new branch, exactly as previewed.
    New {
        branch: String,
        folder: String,
        expected_base: String,
    },
    /// The worktree another chat of the same project runs in.
    Shared { session_id: String },
}

// A decoded command lives for one request; boxing its largest variant would
// only complicate the serde grammar.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlacementCommandV1 {
    List {},
    PreviewWorktree {
        workspace_id: String,
        #[serde(default)]
        branch: Option<String>,
    },
    CreateChat {
        workspace_id: String,
        harness: HarnessKind,
        permission_mode: PermissionMode,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        model: Option<WorkspaceModel>,
        #[serde(default)]
        worktree: Option<WorktreeRequestV1>,
        #[serde(default)]
        continued_from: Option<String>,
    },
    RemoveWorktree {
        session_id: String,
        discard_changes: bool,
        #[serde(default)]
        expected_changes: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeState {
    Ready,
    Missing,
    Removed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatWorktreeV1 {
    pub branch: String,
    pub path: String,
    pub state: WorktreeState,
    pub base: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatPlacementV1 {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<ChatWorktreeV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continued_from: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub adopted: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBaseV1 {
    pub commit: String,
    pub short: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePreviewV1 {
    pub workspace_id: String,
    pub branch: String,
    pub folder: String,
    pub path: String,
    pub base: WorktreeBaseV1,
    pub project_changes: bool,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlacementResultV1 {
    Placements {
        protocol: u8,
        placements: Vec<ChatPlacementV1>,
    },
    Preview {
        protocol: u8,
        preview: WorktreePreviewV1,
    },
    Created {
        protocol: u8,
        snapshot: Box<SessionSnapshot>,
        placement: ChatPlacementV1,
    },
    Removed {
        protocol: u8,
        session_id: String,
        placement: ChatPlacementV1,
    },
    /// Not removed: the worktree has uncommitted changes or untracked files.
    Dirty {
        protocol: u8,
        session_id: String,
        changes: usize,
        fingerprint: String,
    },
}

fn short(commit: &str) -> String {
    commit.chars().take(12).collect()
}

/// The UI view of a stored placement.
pub(crate) fn placement_view(placement: &SessionPlacement) -> ChatPlacementV1 {
    ChatPlacementV1 {
        session_id: placement.session_id.clone(),
        worktree: placement.worktree.as_ref().map(|binding| ChatWorktreeV1 {
            branch: binding.branch.clone(),
            path: display_path(&binding.root),
            state: if binding.removed() {
                WorktreeState::Removed
            } else if binding.cwd().is_dir() {
                WorktreeState::Ready
            } else {
                WorktreeState::Missing
            },
            base: short(&binding.base_commit),
        }),
        continued_from: placement.continued_from.clone(),
        adopted: placement.adopted,
    }
}

/// Git confirms that `binding` is a PiUI-managed worktree of the project's
/// repository: same common git directory, recorded top folder.
pub(crate) async fn verify_worktree(
    tools: &SessionTools,
    binding: &WorktreeBinding,
    project: &ProjectDirectory,
) -> Result<(), WorkspaceError> {
    let managed = std::fs::canonicalize(tools.worktree_root()).map_err(|_| worktree_missing())?;
    let root = std::fs::canonicalize(&binding.root).map_err(|_| worktree_missing())?;
    if !root.starts_with(&managed) || root != binding.root {
        return Err(worktree_missing());
    }
    let git = tools.git()?;
    let inside = git::locate(&git, &binding.cwd())
        .await
        .map_err(|_| worktree_missing())?;
    let project_location = git::locate(&git, project.canonical_path())
        .await
        .map_err(|_| worktree_missing())?;
    if inside.top != root
        || inside.common_dir != binding.common_dir
        || project_location.common_dir != binding.common_dir
    {
        return Err(worktree_missing());
    }
    Ok(())
}

/// A stable fingerprint of what removing a worktree would lose.
fn changes_fingerprint(report: &StatusReport) -> String {
    let mut listing: Vec<String> = report
        .entries
        .iter()
        .map(|entry| format!("{entry:?}"))
        .collect();
    listing.sort();
    git::sha256_hex(listing.join("\n").as_bytes())
}

fn workspace_name(host: &HostState, workspace_id: &str) -> Result<String, WorkspaceError> {
    let index = host
        .index
        .lock()
        .map_err(|_| tool_error("IO_ERROR", "PiUI could not read its project list."))?;
    index
        .list_projects()
        .map_err(|_| tool_error("IO_ERROR", "PiUI could not read its project list."))?
        .into_iter()
        .find(|project| project.id == workspace_id)
        .map(|project| project.name)
        .ok_or_else(|| tool_error("NOT_FOUND", "This project is no longer in PiUI."))
}

/// A trusted project folder that can hold worktrees (not personal chats).
fn project_for_worktrees(
    host: &HostState,
    workspace_id: &str,
) -> Result<ProjectDirectory, WorkspaceError> {
    if workspace_id.trim().is_empty() || workspace_id.chars().any(char::is_control) {
        return Err(tool_error(
            "INVALID_ARGUMENT",
            "Check the required fields and try again.",
        ));
    }
    if host.is_personal_workspace(workspace_id) {
        return Err(tool_error(
            "NOT_SUPPORTED",
            "Worktrees are for project folders. Personal chats have no repository.",
        ));
    }
    Ok(verified_project_directory(host, workspace_id, true)?)
}

fn suggested_branch() -> String {
    let id = Uuid::new_v4().simple().to_string();
    format!("piui/chat-{}", &id[..6])
}

fn valid_folder(folder: &str) -> bool {
    !folder.is_empty()
        && folder.len() <= 64
        && folder
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !folder.starts_with('-')
        && !folder.ends_with('-')
}

struct Planned {
    git: GitRunner,
    top: PathBuf,
    prefix: String,
    common_dir: PathBuf,
    head: String,
    branch: String,
    folder: String,
    path: PathBuf,
    current_branch: Option<String>,
    project_changes: bool,
}

/// Everything a worktree needs, checked without changing anything.
async fn plan_worktree(
    host: &HostState,
    workspace_id: &str,
    branch: Option<String>,
    folder: Option<String>,
) -> Result<Planned, WorkspaceError> {
    let project = project_for_worktrees(host, workspace_id)?;
    let tools = host.workspace.tools();
    let git = tools.git()?;
    let location = git::locate(&git, project.canonical_path())
        .await
        .map_err(git_error)?;
    let head = git::head_commit(&git, &location.top)
        .await
        .map_err(git_error)?;
    let branch = branch.unwrap_or_else(suggested_branch);
    if git::check_branch_name(&git, &location.top, &branch)
        .await
        .is_err()
    {
        return Err(tool_error(
            "INVALID_BRANCH",
            "Choose a branch name with letters, digits, '.', '_', '-' and '/'.",
        ));
    }
    if git::branch_exists(&git, &location.top, &branch)
        .await
        .map_err(git_error)?
    {
        return Err(tool_error(
            "BRANCH_EXISTS",
            "A branch with this name already exists. Choose another name.",
        ));
    }
    let parent = tools.worktree_root().join(project_folder(
        &workspace_name(host, workspace_id)?,
        workspace_id,
    ));
    let folder = match folder {
        Some(folder) => {
            if !valid_folder(&folder) || parent.join(&folder).exists() {
                return Err(stale_error());
            }
            folder
        }
        None => {
            let base = folder_slug(&branch);
            (0..FOLDER_ATTEMPTS)
                .map(|attempt| {
                    if attempt == 0 {
                        base.clone()
                    } else {
                        format!("{base}-{}", attempt + 1)
                    }
                })
                .find(|candidate| !parent.join(candidate).exists())
                .ok_or_else(|| {
                    tool_error(
                        "GIT_FAILED",
                        "PiUI could not choose a free worktree folder.",
                    )
                })?
        }
    };
    let report = git::status(&git, &location.top, &location.prefix)
        .await
        .map_err(git_error)?;
    Ok(Planned {
        path: parent.join(&folder),
        git,
        top: location.top,
        prefix: location.prefix,
        common_dir: location.common_dir,
        head,
        branch,
        folder,
        current_branch: report.branch,
        project_changes: !report.entries.is_empty(),
    })
}

async fn preview(
    host: &HostState,
    workspace_id: String,
    branch: Option<String>,
) -> Result<PlacementResultV1, WorkspaceError> {
    if host.safe_mode {
        return Err(safe_mode_error());
    }
    let planned = plan_worktree(host, &workspace_id, branch, None).await?;
    Ok(PlacementResultV1::Preview {
        protocol: WORKSPACE_PLACEMENT_PROTOCOL,
        preview: WorktreePreviewV1 {
            workspace_id,
            path: display_path(&planned.path),
            branch: planned.branch,
            folder: planned.folder,
            base: WorktreeBaseV1 {
                short: short(&planned.head),
                commit: planned.head,
                branch: planned.current_branch,
            },
            project_changes: planned.project_changes,
        },
    })
}

/// Creates the worktree exactly as previewed and verifies it.
async fn create_worktree(
    host: &HostState,
    workspace_id: &str,
    branch: String,
    folder: String,
    expected_base: &str,
) -> Result<(WorktreeBinding, GitRunner, PathBuf), WorkspaceError> {
    let planned = plan_worktree(host, workspace_id, Some(branch), Some(folder)).await?;
    if planned.head != expected_base {
        return Err(stale_error());
    }
    if let Some(parent) = planned.path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| tool_error("IO_ERROR", "PiUI could not create the worktree folder."))?;
    }
    git::worktree_add(
        &planned.git,
        &planned.top,
        &planned.path,
        &planned.branch,
        &planned.head,
    )
    .await
    .map_err(git_error)?;
    let verified = async {
        let root = std::fs::canonicalize(&planned.path).map_err(|_| worktree_missing())?;
        let inside = git::locate(&planned.git, &root)
            .await
            .map_err(|_| worktree_missing())?;
        if inside.top != root || inside.common_dir != planned.common_dir {
            return Err(worktree_missing());
        }
        let binding = WorktreeBinding {
            root,
            prefix: planned.prefix.clone(),
            branch: planned.branch.clone(),
            common_dir: planned.common_dir.clone(),
            base_commit: planned.head.clone(),
            created_at: now_millis(),
            removed_at: None,
        };
        if !binding.cwd().is_dir() {
            return Err(worktree_missing());
        }
        Ok(binding)
    }
    .await;
    match verified {
        Ok(binding) => Ok((binding, planned.git, planned.top)),
        Err(error) => {
            // A fresh, unchanged worktree; git itself refuses if it is not.
            let _ = git::worktree_remove(&planned.git, &planned.top, &planned.path, false).await;
            Err(error)
        }
    }
}

fn now_millis() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}

#[allow(clippy::too_many_arguments)]
async fn create_chat(
    host: &HostState,
    publisher: WorkspaceEventPublisher,
    workspace_id: String,
    harness: HarnessKind,
    permission_mode: PermissionMode,
    title: Option<String>,
    model: Option<WorkspaceModel>,
    worktree: Option<WorktreeRequestV1>,
    continued_from: Option<String>,
) -> Result<PlacementResultV1, WorkspaceError> {
    if host.safe_mode {
        return Err(safe_mode_error());
    }
    if worktree.is_none() && continued_from.is_none() {
        return Err(tool_error(
            "INVALID_ARGUMENT",
            "Check the required fields and try again.",
        ));
    }
    if let Some(source) = &continued_from
        && (Uuid::parse_str(source).is_err()
            || host.workspace.session_workspace_id(source)? != workspace_id)
    {
        return Err(tool_error(
            "NOT_FOUND",
            "The chat this one continues is no longer available.",
        ));
    }
    let session_id = Uuid::new_v4().to_string();
    let mut placement = SessionPlacement::new(&session_id, &workspace_id);
    placement.continued_from = continued_from;
    let mut created_worktree: Option<(GitRunner, PathBuf, PathBuf)> = None;
    match worktree {
        None => {}
        Some(WorktreeRequestV1::New {
            branch,
            folder,
            expected_base,
        }) => {
            let (binding, git, top) =
                create_worktree(host, &workspace_id, branch, folder, &expected_base).await?;
            created_worktree = Some((git, top, binding.root.clone()));
            placement.worktree = Some(binding);
        }
        Some(WorktreeRequestV1::Shared { session_id: source }) => {
            if Uuid::parse_str(&source).is_err()
                || host.workspace.session_workspace_id(&source)? != workspace_id
            {
                return Err(tool_error("NOT_FOUND", "That chat is no longer available."));
            }
            let binding = host
                .workspace
                .worktree_binding(&source)?
                .ok_or_else(|| tool_error("NOT_FOUND", "That chat does not run in a worktree."))?;
            if binding.removed() {
                return Err(worktree_removed());
            }
            let project = project_for_worktrees(host, &workspace_id)?;
            verify_worktree(host.workspace.tools(), &binding, &project).await?;
            placement.worktree = Some(binding);
        }
    }
    let authorize =
        |id: &str| verified_project_directory(host, id, true).map_err(WorkspaceError::from);
    let request = WorkspaceLaunchRequest {
        session_id: Some(session_id),
        workspace_id: workspace_id.clone(),
        harness,
        title,
        profile_id: None,
        run_id: None,
        member_id: None,
        task_id: None,
        model,
        thinking_level: None,
        instructions: None,
        base_instructions: None,
        service_tier: None,
        resource_rules: None,
        permission_mode,
        network_access: false,
        allowed_tools: None,
        native_subagents: None,
        dependency_history_references: Vec::new(),
        dependency_outputs: Vec::new(),
        coordinator: None,
    };
    let view = placement_view(&placement);
    match host
        .workspace
        .create_placed_session(
            &host.live_runtime_operation_gate,
            &authorize,
            request,
            placement,
            publisher,
        )
        .await
    {
        Ok(snapshot) => Ok(PlacementResultV1::Created {
            protocol: WORKSPACE_PLACEMENT_PROTOCOL,
            snapshot: Box::new(snapshot),
            placement: view,
        }),
        Err(error) => {
            // The worktree was created for this chat and is still pristine;
            // git refuses to remove it otherwise. The branch stays.
            if let Some((git, top, root)) = created_worktree {
                let _ = git::worktree_remove(&git, &top, &root, false).await;
            }
            Err(error)
        }
    }
}

async fn remove_worktree(
    host: &HostState,
    session_id: String,
    discard_changes: bool,
    expected_changes: Option<String>,
) -> Result<PlacementResultV1, WorkspaceError> {
    if host.safe_mode {
        return Err(safe_mode_error());
    }
    if Uuid::parse_str(&session_id).is_err() {
        return Err(tool_error(
            "INVALID_ARGUMENT",
            "Check the required fields and try again.",
        ));
    }
    let workspace_id = host.workspace.session_workspace_id(&session_id)?;
    let binding = host
        .workspace
        .worktree_binding(&session_id)?
        .ok_or_else(|| tool_error("NOT_FOUND", "This chat does not run in a worktree."))?;
    if binding.removed() {
        return Err(worktree_removed());
    }
    let project = project_for_worktrees(host, &workspace_id)?;
    let tools = host.workspace.tools();
    let git = tools.git()?;
    let project_location = git::locate(&git, project.canonical_path())
        .await
        .map_err(git_error)?;
    let present = binding.root.is_dir();
    let mut force = false;
    if present {
        verify_worktree(tools, &binding, &project).await?;
        let report = git::status(&git, &binding.root, "")
            .await
            .map_err(git_error)?;
        if !report.entries.is_empty() {
            let fingerprint = changes_fingerprint(&report);
            if !discard_changes {
                return Ok(PlacementResultV1::Dirty {
                    protocol: WORKSPACE_PLACEMENT_PROTOCOL,
                    session_id,
                    changes: report.entries.len() + report.unrepresentable,
                    fingerprint,
                });
            }
            if expected_changes.as_deref() != Some(fingerprint.as_str()) {
                return Err(stale_error());
            }
            force = true;
        }
    }
    {
        // Under the operation gate: stop the worktree's chats and mark it
        // removed, so no chat starts in it while git deletes it.
        let _gate = host.live_runtime_operation_gate.lock().await;
        for bound in host.workspace.sessions_in_worktree(&binding.root)? {
            host.workspace.stop_idle_session(&bound).await?;
        }
        host.workspace.mark_worktree_removed(&binding.root, true)?;
    }
    if present
        && let Err(error) =
            git::worktree_remove(&git, &project_location.top, &binding.root, force).await
    {
        host.workspace.mark_worktree_removed(&binding.root, false)?;
        return Err(git_error(error));
    }
    // An empty folder keeps the chats' native history readable: harness
    // histories name the folder they ran in.
    let _ = std::fs::create_dir_all(binding.cwd());
    let placement = host
        .workspace
        .tools()
        .placement(&session_id)?
        .ok_or_else(|| tool_error("NOT_FOUND", "This chat is no longer available."))?;
    Ok(PlacementResultV1::Removed {
        protocol: WORKSPACE_PLACEMENT_PROTOCOL,
        session_id,
        placement: placement_view(&placement),
    })
}

fn list(host: &HostState) -> Result<PlacementResultV1, WorkspaceError> {
    let mut placements: Vec<ChatPlacementV1> = host
        .workspace
        .tools()
        .placements()?
        .iter()
        .filter(|placement| host.workspace.session_exists(&placement.session_id))
        .map(placement_view)
        .collect();
    placements.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    Ok(PlacementResultV1::Placements {
        protocol: WORKSPACE_PLACEMENT_PROTOCOL,
        placements,
    })
}

/// Body of `workspace_placement_v1`, independent of the Tauri app handle.
pub(crate) async fn dispatch_placement(
    host: &HostState,
    command: PlacementCommandV1,
    publisher: WorkspaceEventPublisher,
) -> Result<PlacementResultV1, WorkspaceError> {
    match command {
        PlacementCommandV1::List {} => list(host),
        PlacementCommandV1::PreviewWorktree {
            workspace_id,
            branch,
        } => preview(host, workspace_id, branch).await,
        PlacementCommandV1::CreateChat {
            workspace_id,
            harness,
            permission_mode,
            title,
            model,
            worktree,
            continued_from,
        } => {
            create_chat(
                host,
                publisher,
                workspace_id,
                harness,
                permission_mode,
                title,
                model,
                worktree,
                continued_from,
            )
            .await
        }
        PlacementCommandV1::RemoveWorktree {
            session_id,
            discard_changes,
            expected_changes,
        } => remove_worktree(host, session_id, discard_changes, expected_changes).await,
    }
}

#[tauri::command]
pub async fn workspace_placement_v1(
    app: AppHandle,
    state: State<'_, HostState>,
    command: PlacementCommandV1,
) -> Result<PlacementResultV1, WorkspaceError> {
    dispatch_placement(state.inner(), command, event_publisher(app)).await
}

#[cfg(test)]
#[path = "placement_api_tests.rs"]
mod tests;
