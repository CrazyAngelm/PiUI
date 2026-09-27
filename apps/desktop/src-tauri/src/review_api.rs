//! Workspace review v1 (`workspace_review_v1`): git changes of the folder a
//! chat works in (its trusted project folder or its PiUI-managed worktree).
//!
//! Reads work in safe mode; every change is refused there. Each action names
//! the fingerprint of the exact diff (or untracked file) the person reviewed
//! and PiUI recomputes it first: a change in between is refused as `STALE`.
//! Staging, unstaging and reverting replay that exact diff (or one of its
//! hunks, or one part of a hunk split at its context lines) through
//! `git apply`, which checks every context line again. A staged rename is
//! one change of its new path that names the path it came from.
//! Reverting an untracked file moves it to the system trash through the
//! platform layer; nothing is deleted permanently. Paths come only from the
//! current `git status` of the chat's folder.

use crate::api::verified_project_directory;
use crate::session_placement::{git_error, safe_mode_error, stale_error, tool_error};
use crate::state::HostState;
use crate::workspace_api::WorkspaceError;
use crate::workspace_api::placement::worktree_removed;
use piui_runtime::git::{
    self, ApplyTarget, FilePatch, GitRunner, PatchError, StatusCode, StatusEntry, StatusReport,
};
use serde::{Deserialize, Serialize};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

pub const WORKSPACE_REVIEW_PROTOCOL: u8 = 1;
/// Most changed files listed; more are reported as `truncated`.
const MAX_FILES: usize = 2000;
/// Longest diff text shown; a longer change is `too-large`.
const DISPLAY_LIMIT: usize = 512 * 1024;
/// Largest untracked text file shown in full.
const UNTRACKED_PREVIEW_LIMIT: u64 = 256 * 1024;
/// Bytes of an untracked file that enter its fingerprint (with size and time).
const FINGERPRINT_SAMPLE: u64 = 1024 * 1024;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewArea {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReviewRequestV1 {
    Status {
        session_id: String,
    },
    Diff {
        session_id: String,
        path: String,
        area: ReviewArea,
    },
    Stage {
        session_id: String,
        path: String,
        area: ReviewArea,
        fingerprint: String,
        #[serde(default)]
        hunk: Option<usize>,
        /// A part of `hunk` split at its context lines (additive in v1).
        #[serde(default)]
        part: Option<usize>,
    },
    Unstage {
        session_id: String,
        path: String,
        fingerprint: String,
        #[serde(default)]
        hunk: Option<usize>,
        /// A part of `hunk` split at its context lines (additive in v1).
        #[serde(default)]
        part: Option<usize>,
    },
    Revert {
        session_id: String,
        path: String,
        area: ReviewArea,
        fingerprint: String,
        #[serde(default)]
        hunk: Option<usize>,
        /// A part of `hunk` split at its context lines (additive in v1).
        #[serde(default)]
        part: Option<usize>,
    },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewChange {
    Modified,
    Added,
    Deleted,
    TypeChanged,
    IntentToAdd,
    Conflict,
    Submodule,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFileV1 {
    pub path: String,
    pub area: ReviewArea,
    pub change: ReviewChange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
    /// A staged rename: the path it came from (additive in v1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewRepositoryV1 {
    Ready {
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        head: Option<String>,
        worktree: bool,
        folder: String,
    },
    NotRepository {},
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewContentV1 {
    Text {
        text: String,
        hunks: usize,
        hunk_actions: bool,
    },
    Binary {
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
    },
    TooLarge {
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
    },
    Symlink {},
    Submodule {},
    Conflict {},
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewActionsV1 {
    pub stage: bool,
    pub unstage: bool,
    pub revert: bool,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReviewResultV1 {
    Status {
        protocol: u8,
        session_id: String,
        repository: ReviewRepositoryV1,
        files: Vec<ReviewFileV1>,
        truncated: bool,
        hidden: usize,
        read_only: bool,
    },
    Diff {
        protocol: u8,
        session_id: String,
        path: String,
        area: ReviewArea,
        fingerprint: String,
        content: ReviewContentV1,
        actions: ReviewActionsV1,
    },
}

fn invalid() -> WorkspaceError {
    tool_error(
        "INVALID_ARGUMENT",
        "Check the required fields and try again.",
    )
}

fn not_repository() -> WorkspaceError {
    tool_error("NOT_A_REPOSITORY", "This folder is not a git repository.")
}

/// The git folder a chat works in.
struct ReviewFolder {
    git: GitRunner,
    top: PathBuf,
    prefix: String,
    worktree: bool,
    folder: String,
}

/// Resolves the chat's working folder: trusted project, or its verified
/// worktree. `None` when it is not in a git work tree (or personal chats).
async fn review_folder(
    host: &HostState,
    session_id: &str,
) -> Result<Option<ReviewFolder>, WorkspaceError> {
    Uuid::parse_str(session_id).map_err(|_| invalid())?;
    let workspace_id = host.workspace.session_workspace_id(session_id)?;
    let project = verified_project_directory(host, &workspace_id, true)?;
    if host.is_personal_workspace(&workspace_id) {
        return Ok(None);
    }
    let tools = host.workspace.tools();
    let binding = host.workspace.worktree_binding(session_id)?;
    let (cwd, worktree) = match &binding {
        Some(binding) if binding.removed() => return Err(worktree_removed()),
        Some(binding) => {
            crate::placement_api::verify_worktree(tools, binding, &project).await?;
            (binding.cwd(), true)
        }
        None => (project.canonical_path().to_path_buf(), false),
    };
    let git = tools.git()?;
    let location = match git::locate(&git, &cwd).await {
        Ok(location) => location,
        Err(git::GitError::NotRepository) => return Ok(None),
        Err(error) => return Err(git_error(error)),
    };
    let folder = cwd
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some(ReviewFolder {
        git,
        top: location.top,
        prefix: location.prefix,
        worktree,
        folder,
    }))
}

/// A repository-relative path as git prints it: `/` separators, no empty,
/// `.` or `..` component, no drive or root, no control characters.
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && !path.chars().any(char::is_control)
        && !path.contains('\\')
        && !path.starts_with('/')
        && !path.contains(':')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn change_of(code: StatusCode) -> ReviewChange {
    match code {
        StatusCode::Added => ReviewChange::Added,
        StatusCode::Deleted => ReviewChange::Deleted,
        StatusCode::TypeChanged => ReviewChange::TypeChanged,
        StatusCode::Unmerged => ReviewChange::Conflict,
        StatusCode::Unmodified
        | StatusCode::Modified
        | StatusCode::Renamed
        | StatusCode::Copied => ReviewChange::Modified,
    }
}

/// One status entry as it appears in `area`, if it does.
#[derive(Clone, Debug)]
struct AreaEntry {
    change: ReviewChange,
    intent_to_add: bool,
    /// The source of a staged rename.
    original: Option<String>,
}

fn entry_in(report: &StatusReport, path: &str, area: ReviewArea) -> Option<AreaEntry> {
    report.entries.iter().find_map(|entry| match (entry, area) {
        (StatusEntry::Untracked { path: candidate }, ReviewArea::Untracked)
            if candidate == path =>
        {
            Some(AreaEntry {
                change: ReviewChange::Added,
                intent_to_add: false,
                original: None,
            })
        }
        (StatusEntry::Unmerged { path: candidate }, ReviewArea::Unstaged) if candidate == path => {
            Some(AreaEntry {
                change: ReviewChange::Conflict,
                intent_to_add: false,
                original: None,
            })
        }
        (
            StatusEntry::Changed {
                path: candidate,
                index,
                worktree,
                submodule,
                intent_to_add,
                original,
            },
            ReviewArea::Staged | ReviewArea::Unstaged,
        ) if candidate == path => {
            let code = if area == ReviewArea::Staged {
                *index
            } else {
                *worktree
            };
            (code != StatusCode::Unmodified).then(|| AreaEntry {
                change: if *submodule {
                    ReviewChange::Submodule
                } else if area == ReviewArea::Unstaged && *intent_to_add {
                    ReviewChange::IntentToAdd
                } else {
                    change_of(code)
                },
                intent_to_add: area == ReviewArea::Unstaged && *intent_to_add,
                original: if area == ReviewArea::Staged && *index == StatusCode::Renamed {
                    original.clone()
                } else {
                    None
                },
            })
        }
        _ => None,
    })
}

fn files_of(
    report: &StatusReport,
    staged: &std::collections::HashMap<String, git::LineCounts>,
    unstaged: &std::collections::HashMap<String, git::LineCounts>,
) -> Vec<ReviewFileV1> {
    let with_counts = |path: &str,
                       area: ReviewArea,
                       found: AreaEntry,
                       counts: Option<&git::LineCounts>| ReviewFileV1 {
        path: path.to_owned(),
        area,
        change: found.change,
        added: counts.and_then(|counts| counts.added),
        removed: counts.and_then(|counts| counts.removed),
        binary: counts.is_some_and(|counts| counts.added.is_none() && counts.removed.is_none()),
        renamed_from: found.original,
    };
    let mut files = Vec::new();
    for entry in &report.entries {
        let path = entry.path();
        for area in [
            ReviewArea::Staged,
            ReviewArea::Unstaged,
            ReviewArea::Untracked,
        ] {
            if let Some(found) = entry_in(report, path, area) {
                let counts = match area {
                    ReviewArea::Staged => staged.get(path),
                    ReviewArea::Unstaged => unstaged.get(path),
                    ReviewArea::Untracked => None,
                };
                files.push(with_counts(path, area, found, counts));
            }
        }
    }
    files
}

async fn status(host: &HostState, session_id: String) -> Result<ReviewResultV1, WorkspaceError> {
    let Some(folder) = review_folder(host, &session_id).await? else {
        return Ok(ReviewResultV1::Status {
            protocol: WORKSPACE_REVIEW_PROTOCOL,
            session_id,
            repository: ReviewRepositoryV1::NotRepository {},
            files: Vec::new(),
            truncated: false,
            hidden: 0,
            read_only: host.safe_mode,
        });
    };
    let report = git::status(&folder.git, &folder.top, &folder.prefix)
        .await
        .map_err(git_error)?;
    let staged = git::numstat(&folder.git, &folder.top, &folder.prefix, true)
        .await
        .map_err(git_error)?;
    let unstaged = git::numstat(&folder.git, &folder.top, &folder.prefix, false)
        .await
        .map_err(git_error)?;
    let mut files = files_of(&report, &staged, &unstaged);
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    Ok(ReviewResultV1::Status {
        protocol: WORKSPACE_REVIEW_PROTOCOL,
        session_id,
        repository: ReviewRepositoryV1::Ready {
            branch: report.branch.clone(),
            head: report
                .head
                .as_deref()
                .map(|head| head.chars().take(12).collect()),
            worktree: folder.worktree,
            folder: folder.folder,
        },
        files,
        truncated,
        hidden: report.unrepresentable,
        read_only: host.safe_mode,
    })
}

/// The file behind a repository path, inside the chat's folder only.
fn contained_file(folder: &ReviewFolder, path: &str) -> Result<PathBuf, WorkspaceError> {
    let mut full = folder.top.clone();
    for part in path.split('/') {
        full.push(part);
    }
    let mut scope = folder.top.clone();
    for part in folder.prefix.split('/').filter(|part| !part.is_empty()) {
        scope.push(part);
    }
    let scope = std::fs::canonicalize(&scope).map_err(|_| stale_error())?;
    let parent = full
        .parent()
        .and_then(|parent| std::fs::canonicalize(parent).ok())
        .ok_or_else(stale_error)?;
    if !parent.starts_with(&scope) {
        return Err(invalid());
    }
    Ok(parent.join(full.file_name().ok_or_else(invalid)?))
}

/// An untracked file's view: size, a bounded sample and its fingerprint.
struct UntrackedView {
    content: ReviewContentV1,
    fingerprint: String,
    regular: bool,
}

fn untracked_view(folder: &ReviewFolder, path: &str) -> Result<UntrackedView, WorkspaceError> {
    let file = contained_file(folder, path)?;
    let metadata = std::fs::symlink_metadata(&file).map_err(|_| stale_error())?;
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(&file).map_err(|_| stale_error())?;
        return Ok(UntrackedView {
            content: ReviewContentV1::Symlink {},
            fingerprint: git::sha256_hex(
                format!("symlink\0{}", target.to_string_lossy()).as_bytes(),
            ),
            regular: false,
        });
    }
    if !metadata.is_file() {
        return Err(stale_error());
    }
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos());
    let mut sample = Vec::new();
    std::fs::File::open(&file)
        .and_then(|handle| handle.take(FINGERPRINT_SAMPLE).read_to_end(&mut sample))
        .map_err(|_| stale_error())?;
    let mut fingerprint_input = format!("untracked\0{size}\0{modified}\0").into_bytes();
    fingerprint_input.extend_from_slice(&sample);
    let content = if git::looks_binary(&sample) {
        ReviewContentV1::Binary { size: Some(size) }
    } else if size > UNTRACKED_PREVIEW_LIMIT {
        ReviewContentV1::TooLarge { size: Some(size) }
    } else {
        ReviewContentV1::Text {
            text: git::new_file_display(path, &sample),
            hunks: usize::from(!sample.is_empty()),
            hunk_actions: false,
        }
    };
    Ok(UntrackedView {
        content,
        fingerprint: git::sha256_hex(&fingerprint_input),
        regular: true,
    })
}

fn tracked_content(patch: &FilePatch, file: Option<&Path>, intent_to_add: bool) -> ReviewContentV1 {
    if patch.binary() {
        return ReviewContentV1::Binary {
            size: file
                .and_then(|file| std::fs::metadata(file).ok())
                .map(|metadata| metadata.len()),
        };
    }
    match patch.display_text(DISPLAY_LIMIT) {
        Some(text) => ReviewContentV1::Text {
            text,
            hunks: patch.hunk_count(),
            hunk_actions: patch.hunks_selectable() && !intent_to_add,
        },
        None => ReviewContentV1::TooLarge {
            size: u64::try_from(patch.bytes().len()).ok(),
        },
    }
}

/// The folder, current status and area entry of a path, or `STALE`.
async fn locate_entry(
    host: &HostState,
    session_id: &str,
    path: &str,
    area: ReviewArea,
) -> Result<(ReviewFolder, AreaEntry), WorkspaceError> {
    if !valid_path(path) {
        return Err(invalid());
    }
    let folder = review_folder(host, session_id)
        .await?
        .ok_or_else(not_repository)?;
    let report = git::status(&folder.git, &folder.top, &folder.prefix)
        .await
        .map_err(git_error)?;
    let entry = entry_in(&report, path, area).ok_or_else(stale_error)?;
    Ok((folder, entry))
}

async fn diff(
    host: &HostState,
    session_id: String,
    path: String,
    area: ReviewArea,
) -> Result<ReviewResultV1, WorkspaceError> {
    let (folder, entry) = locate_entry(host, &session_id, &path, area).await?;
    let (content, fingerprint, actions) = match (area, entry.change) {
        (ReviewArea::Untracked, _) => {
            let view = untracked_view(&folder, &path)?;
            let actions = ReviewActionsV1 {
                stage: true,
                unstage: false,
                revert: view.regular,
            };
            (view.content, view.fingerprint, actions)
        }
        (_, ReviewChange::Conflict) => (
            ReviewContentV1::Conflict {},
            git::sha256_hex(b"conflict"),
            ReviewActionsV1::default(),
        ),
        (_, ReviewChange::Submodule) => (
            ReviewContentV1::Submodule {},
            git::sha256_hex(b"submodule"),
            ReviewActionsV1::default(),
        ),
        (ReviewArea::Staged | ReviewArea::Unstaged, _) => {
            let patch = git::diff(
                &folder.git,
                &folder.top,
                &path,
                area == ReviewArea::Staged,
                entry.original.as_deref(),
            )
            .await
            .map_err(git_error)?;
            if patch.is_empty() {
                return Err(stale_error());
            }
            let file = (area == ReviewArea::Unstaged)
                .then(|| contained_file(&folder, &path).ok())
                .flatten();
            let content = tracked_content(&patch, file.as_deref(), entry.intent_to_add);
            let showable = !matches!(content, ReviewContentV1::TooLarge { .. });
            let actions = if area == ReviewArea::Staged {
                ReviewActionsV1 {
                    stage: false,
                    unstage: true,
                    revert: false,
                }
            } else {
                ReviewActionsV1 {
                    stage: true,
                    unstage: false,
                    // What a revert loses must be shown first; an
                    // intent-to-add file is unstaged before it can go.
                    revert: showable && !entry.intent_to_add,
                }
            };
            (content, patch.fingerprint(), actions)
        }
    };
    Ok(ReviewResultV1::Diff {
        protocol: WORKSPACE_REVIEW_PROTOCOL,
        session_id,
        path,
        area,
        fingerprint,
        content,
        actions,
    })
}

/// The exact bytes of the reviewed change, one hunk of it, or one part of a
/// hunk split at its context lines.
fn hunk_bytes(
    patch: &FilePatch,
    hunk: Option<usize>,
    part: Option<usize>,
) -> Result<Vec<u8>, WorkspaceError> {
    let result = match (hunk, part) {
        (None, None) => return Ok(patch.bytes().to_vec()),
        (None, Some(_)) => return Err(invalid()),
        (Some(index), None) => patch.hunk_patch(index),
        (Some(index), Some(part)) => patch.hunk_part_patch(index, part),
    };
    result.map_err(|error| match error {
        PatchError::NoSuchHunk | PatchError::NoSuchPart => stale_error(),
        PatchError::WholeFileOnly | PatchError::Malformed => tool_error(
            "NOT_SUPPORTED",
            "This change can only be handled as a whole file.",
        ),
    })
}

fn fixed_change(entry: &AreaEntry) -> Result<(), WorkspaceError> {
    match entry.change {
        ReviewChange::Conflict => Err(tool_error(
            "NOT_SUPPORTED",
            "Resolve this conflict with your tools or the agent first.",
        )),
        ReviewChange::Submodule => Err(tool_error(
            "NOT_SUPPORTED",
            "Manage submodules with git directly.",
        )),
        _ => Ok(()),
    }
}

/// A tracked diff recomputed and matched against the reviewed fingerprint.
async fn reviewed_patch(
    folder: &ReviewFolder,
    path: &str,
    entry: &AreaEntry,
    staged: bool,
    fingerprint: &str,
) -> Result<FilePatch, WorkspaceError> {
    let original = if staged {
        entry.original.as_deref()
    } else {
        None
    };
    let patch = git::diff(&folder.git, &folder.top, path, staged, original)
        .await
        .map_err(git_error)?;
    if patch.is_empty() || patch.fingerprint() != fingerprint {
        return Err(stale_error());
    }
    Ok(patch)
}

async fn stage(
    host: &HostState,
    session_id: &str,
    path: &str,
    area: ReviewArea,
    fingerprint: &str,
    selection: Selection,
) -> Result<(), WorkspaceError> {
    let Selection { hunk, part } = selection;
    let (folder, entry) = locate_entry(host, session_id, path, area).await?;
    fixed_change(&entry)?;
    match area {
        ReviewArea::Untracked => {
            if hunk.is_some() || part.is_some() {
                return Err(tool_error("NOT_SUPPORTED", "Stage a new file as a whole."));
            }
            if untracked_view(&folder, path)?.fingerprint != fingerprint {
                return Err(stale_error());
            }
            git::add_path(&folder.git, &folder.top, path)
                .await
                .map_err(git_error)
        }
        ReviewArea::Unstaged => {
            let patch = reviewed_patch(&folder, path, &entry, false, fingerprint).await?;
            if entry.intent_to_add {
                if hunk.is_some() || part.is_some() {
                    return Err(tool_error("NOT_SUPPORTED", "Stage a new file as a whole."));
                }
                return git::add_path(&folder.git, &folder.top, path)
                    .await
                    .map_err(git_error);
            }
            let bytes = hunk_bytes(&patch, hunk, part)?;
            git::apply(&folder.git, &folder.top, &bytes, ApplyTarget::Index, false)
                .await
                .map_err(git_error)
        }
        ReviewArea::Staged => Err(invalid()),
    }
}

async fn unstage(
    host: &HostState,
    session_id: &str,
    path: &str,
    fingerprint: &str,
    selection: Selection,
) -> Result<(), WorkspaceError> {
    let (folder, entry) = locate_entry(host, session_id, path, ReviewArea::Staged).await?;
    fixed_change(&entry)?;
    let patch = reviewed_patch(&folder, path, &entry, true, fingerprint).await?;
    let bytes = hunk_bytes(&patch, selection.hunk, selection.part)?;
    git::apply(&folder.git, &folder.top, &bytes, ApplyTarget::Index, true)
        .await
        .map_err(git_error)
}

/// Moves one file to the trash; tests use a private folder instead.
#[cfg(not(test))]
fn trash(path: &Path) -> Result<(), piui_platform::TrashError> {
    piui_platform::move_file_to_trash(path)
}

#[cfg(test)]
fn trash(path: &Path) -> Result<(), piui_platform::TrashError> {
    let bin = std::env::temp_dir().join(format!("piui-review-test-trash-{}", std::process::id()));
    std::fs::create_dir_all(&bin).map_err(piui_platform::TrashError::Io)?;
    let name = format!(
        "{}-{}",
        Uuid::new_v4(),
        path.file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
    );
    std::fs::rename(path, bin.join(name)).map_err(piui_platform::TrashError::Io)
}

async fn revert(
    host: &HostState,
    session_id: &str,
    path: &str,
    area: ReviewArea,
    fingerprint: &str,
    selection: Selection,
) -> Result<(), WorkspaceError> {
    let Selection { hunk, part } = selection;
    let (folder, entry) = locate_entry(host, session_id, path, area).await?;
    fixed_change(&entry)?;
    match area {
        ReviewArea::Untracked => {
            if hunk.is_some() || part.is_some() {
                return Err(tool_error(
                    "NOT_SUPPORTED",
                    "Move a new file to the trash as a whole.",
                ));
            }
            let view = untracked_view(&folder, path)?;
            if !view.regular {
                return Err(tool_error(
                    "NOT_SUPPORTED",
                    "PiUI moves only regular files to the trash. Remove this link yourself.",
                ));
            }
            if view.fingerprint != fingerprint {
                return Err(stale_error());
            }
            let file = contained_file(&folder, path)?;
            tokio::task::spawn_blocking(move || trash(&file))
                .await
                .map_err(|_| {
                    tool_error("TRASH_FAILED", "The file could not be moved to the trash.")
                })?
                .map_err(|error| match error {
                    piui_platform::TrashError::Unsupported => tool_error(
                        "TRASH_UNAVAILABLE",
                        "This system has no trash PiUI can use. The file was not changed.",
                    ),
                    piui_platform::TrashError::NotFound => stale_error(),
                    piui_platform::TrashError::NotARegularFile => tool_error(
                        "NOT_SUPPORTED",
                        "PiUI moves only regular files to the trash. Remove this link yourself.",
                    ),
                    piui_platform::TrashError::Declined | piui_platform::TrashError::Io(_) => {
                        tool_error(
                            "TRASH_FAILED",
                            "The file could not be moved to the trash and was left in place.",
                        )
                    }
                })
        }
        ReviewArea::Unstaged => {
            if entry.intent_to_add {
                return Err(tool_error(
                    "NOT_SUPPORTED",
                    "Unstage this new file first, then move it to the trash.",
                ));
            }
            let patch = reviewed_patch(&folder, path, &entry, false, fingerprint).await?;
            if patch.display_text(DISPLAY_LIMIT).is_none() && !patch.binary() {
                return Err(tool_error(
                    "NOT_SUPPORTED",
                    "This change is too large to show, so PiUI does not revert it.",
                ));
            }
            let bytes = hunk_bytes(&patch, hunk, part)?;
            git::apply(
                &folder.git,
                &folder.top,
                &bytes,
                ApplyTarget::WorkTree,
                true,
            )
            .await
            .map_err(git_error)
        }
        ReviewArea::Staged => Err(tool_error(
            "NOT_SUPPORTED",
            "Unstage these changes first, then revert them.",
        )),
    }
}

/// Which part of a reviewed change an action applies to.
#[derive(Clone, Copy, Debug)]
struct Selection {
    hunk: Option<usize>,
    part: Option<usize>,
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Body of `workspace_review_v1`, independent of the Tauri state wrapper.
pub(crate) async fn dispatch_review(
    host: &HostState,
    request: ReviewRequestV1,
) -> Result<ReviewResultV1, WorkspaceError> {
    match request {
        ReviewRequestV1::Status { session_id } => status(host, session_id).await,
        ReviewRequestV1::Diff {
            session_id,
            path,
            area,
        } => diff(host, session_id, path, area).await,
        ReviewRequestV1::Stage {
            session_id,
            path,
            area,
            fingerprint,
            hunk,
            part,
        } => {
            if host.safe_mode {
                return Err(safe_mode_error());
            }
            if !valid_fingerprint(&fingerprint) {
                return Err(invalid());
            }
            stage(
                host,
                &session_id,
                &path,
                area,
                &fingerprint,
                Selection { hunk, part },
            )
            .await?;
            status(host, session_id).await
        }
        ReviewRequestV1::Unstage {
            session_id,
            path,
            fingerprint,
            hunk,
            part,
        } => {
            if host.safe_mode {
                return Err(safe_mode_error());
            }
            if !valid_fingerprint(&fingerprint) {
                return Err(invalid());
            }
            unstage(
                host,
                &session_id,
                &path,
                &fingerprint,
                Selection { hunk, part },
            )
            .await?;
            status(host, session_id).await
        }
        ReviewRequestV1::Revert {
            session_id,
            path,
            area,
            fingerprint,
            hunk,
            part,
        } => {
            if host.safe_mode {
                return Err(safe_mode_error());
            }
            if !valid_fingerprint(&fingerprint) {
                return Err(invalid());
            }
            revert(
                host,
                &session_id,
                &path,
                area,
                &fingerprint,
                Selection { hunk, part },
            )
            .await?;
            status(host, session_id).await
        }
    }
}

#[tauri::command]
pub async fn workspace_review_v1(
    state: State<'_, HostState>,
    request: ReviewRequestV1,
) -> Result<ReviewResultV1, WorkspaceError> {
    dispatch_review(state.inner(), request).await
}

#[cfg(test)]
#[path = "review_api_tests.rs"]
mod tests;
