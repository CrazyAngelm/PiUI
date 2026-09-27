//! Typed git operations for the review panel and worktree chats.
//!
//! Every function builds a fixed argument vector (paths only after `--`,
//! pathspecs literal) and runs it through [`GitRunner`] in a folder the host
//! already verified. Nothing here decides trust, reads credentials or
//! touches files itself; callers own authorization and fingerprints.

pub mod patch;
pub mod runner;
pub mod status;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub use patch::{FilePatch, PatchError, looks_binary, new_file_display, sha256_hex};
pub use runner::{GitAccess, GitOutput, GitRequest, GitRunError, GitRunner, plain_path};
pub use status::{LineCounts, StatusCode, StatusEntry, StatusReport, parse_numstat, parse_status};

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// A checkout of a large repository (and its filters) can take a while.
const WORKTREE_ADD_TIMEOUT: Duration = Duration::from_secs(600);
const WORKTREE_REMOVE_TIMEOUT: Duration = Duration::from_secs(180);
const SMALL_OUTPUT: usize = 64 * 1024;
/// Upper bound of `git status` output PiUI reads.
pub const STATUS_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
/// Upper bound of one path's diff (including binary patch data).
pub const DIFF_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const NUMSTAT_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

/// What a failed git step means for the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GitError {
    /// The folder is not inside a git work tree.
    NotRepository,
    /// Git refused the folder (for example "dubious ownership").
    Refused,
    /// Another git process holds the index lock.
    Busy,
    /// The repository has no commits yet.
    NoCommits,
    /// The patch no longer applies: the file changed.
    DoesNotApply,
    /// Git exited with an error PiUI does not classify.
    Failed,
    /// Output could not be parsed.
    Malformed,
    Run(GitRunError),
}

impl From<GitRunError> for GitError {
    fn from(error: GitRunError) -> Self {
        Self::Run(error)
    }
}

/// Classifies a failed invocation by its stable stderr text (`LC_ALL=C`).
fn failure(output: &GitOutput) -> GitError {
    let stderr = output.stderr.to_ascii_lowercase();
    if stderr.contains("not a git repository") || stderr.contains("must be run in a work tree") {
        GitError::NotRepository
    } else if stderr.contains("dubious ownership") || stderr.contains("safe.directory") {
        GitError::Refused
    } else if stderr.contains("index.lock") || stderr.contains("another git process") {
        GitError::Busy
    } else if stderr.contains("patch does not apply")
        || stderr.contains("does not match index")
        || stderr.contains("does not exist in index")
        || stderr.contains("already exists in")
        || stderr.contains("patch failed")
    {
        GitError::DoesNotApply
    } else {
        GitError::Failed
    }
}

fn args<const N: usize>(values: [&str; N]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

async fn read(
    runner: &GitRunner,
    cwd: &Path,
    arguments: Vec<OsString>,
    limit: usize,
) -> Result<GitOutput, GitError> {
    Ok(runner
        .run(GitRequest {
            cwd,
            args: arguments,
            stdin: &[],
            stdout_limit: limit,
            timeout: READ_TIMEOUT,
            access: GitAccess::Read,
        })
        .await?)
}

async fn write(
    runner: &GitRunner,
    cwd: &Path,
    arguments: Vec<OsString>,
    stdin: &[u8],
    timeout: Duration,
) -> Result<GitOutput, GitError> {
    Ok(runner
        .run(GitRequest {
            cwd,
            args: arguments,
            stdin,
            stdout_limit: SMALL_OUTPUT,
            timeout,
            access: GitAccess::Write,
        })
        .await?)
}

fn succeeded(output: GitOutput) -> Result<GitOutput, GitError> {
    if output.success() {
        Ok(output)
    } else {
        Err(failure(&output))
    }
}

/// Where a folder sits in its repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryLocation {
    /// Canonical top of the work tree.
    pub top: PathBuf,
    /// The folder relative to `top` with a trailing `/`, or empty at the top.
    pub prefix: String,
    /// Canonical common git directory (shared by every worktree).
    pub common_dir: PathBuf,
}

/// Finds the work tree, the folder's prefix in it and the common git dir.
///
/// # Errors
///
/// [`GitError::NotRepository`] outside a work tree; other variants otherwise.
pub async fn locate(runner: &GitRunner, folder: &Path) -> Result<RepositoryLocation, GitError> {
    let output = succeeded(
        read(
            runner,
            folder,
            args([
                "rev-parse",
                "--show-toplevel",
                "--show-prefix",
                "--git-common-dir",
            ]),
            SMALL_OUTPUT,
        )
        .await?,
    )?;
    let text = String::from_utf8(output.stdout).map_err(|_| GitError::Malformed)?;
    let mut lines = text.lines();
    let (Some(top), Some(prefix), Some(common)) = (lines.next(), lines.next(), lines.next()) else {
        return Err(GitError::Malformed);
    };
    let top = std::fs::canonicalize(top).map_err(|_| GitError::Malformed)?;
    let common = Path::new(common);
    let common = if common.is_absolute() {
        common.to_path_buf()
    } else {
        folder.join(common)
    };
    let common_dir = std::fs::canonicalize(common).map_err(|_| GitError::Malformed)?;
    let prefix = prefix.trim().to_owned();
    if prefix.split('/').any(|part| part == "..") {
        return Err(GitError::Malformed);
    }
    Ok(RepositoryLocation {
        top,
        prefix,
        common_dir,
    })
}

/// `git status` of the work tree, limited to `prefix` when it is not empty.
///
/// # Errors
///
/// A run, git or parse failure.
pub async fn status(
    runner: &GitRunner,
    top: &Path,
    prefix: &str,
) -> Result<StatusReport, GitError> {
    let mut arguments = args([
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--find-renames",
        "--ignore-submodules=none",
    ]);
    if !prefix.is_empty() {
        arguments.push("--".into());
        arguments.push(prefix.into());
    }
    let output = succeeded(read(runner, top, arguments, STATUS_OUTPUT_LIMIT).await?)?;
    parse_status(&output.stdout).map_err(|_| GitError::Malformed)
}

/// Line counts of the staged (`cached`) or unstaged changes under `prefix`.
/// Staged renames are counted as renames under their new path, like the
/// status lists them.
///
/// # Errors
///
/// A run, git or parse failure.
pub async fn numstat(
    runner: &GitRunner,
    top: &Path,
    prefix: &str,
    cached: bool,
) -> Result<std::collections::HashMap<String, LineCounts>, GitError> {
    let mut arguments = args(["diff"]);
    if cached {
        arguments.push("--cached".into());
    }
    arguments.extend(args([
        "--numstat",
        "-z",
        if cached {
            "--find-renames"
        } else {
            "--no-renames"
        },
        "--no-ext-diff",
        "--no-textconv",
        "--submodule=short",
    ]));
    if !prefix.is_empty() {
        arguments.push("--".into());
        arguments.push(prefix.into());
    }
    let output = succeeded(read(runner, top, arguments, NUMSTAT_OUTPUT_LIMIT).await?)?;
    parse_numstat(&output.stdout).map_err(|_| GitError::Malformed)
}

/// The exact diff of one path: staged (`cached`) or unstaged. With
/// `original`, the staged rename from that path (both paths, with rename
/// detection).
///
/// # Errors
///
/// A run, git or parse failure; [`GitRunError::TooLarge`] for huge output.
pub async fn diff(
    runner: &GitRunner,
    top: &Path,
    path: &str,
    cached: bool,
    original: Option<&str>,
) -> Result<FilePatch, GitError> {
    let mut arguments = args(["diff"]);
    if cached {
        arguments.push("--cached".into());
    }
    arguments.extend(args([
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        if original.is_some() {
            "--find-renames"
        } else {
            "--no-renames"
        },
        "--submodule=short",
        "-U3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
    ]));
    if let Some(original) = original {
        arguments.push(original.into());
    }
    arguments.push(path.into());
    let output = succeeded(read(runner, top, arguments, DIFF_OUTPUT_LIMIT).await?)?;
    FilePatch::parse(output.stdout).map_err(|_| GitError::Malformed)
}

/// Where `git apply` writes a patch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyTarget {
    /// The index only (stage, or unstage with `reverse`).
    Index,
    /// The work tree only (revert with `reverse`).
    WorkTree,
}

/// Applies exactly `patch` (forward or reversed). Git checks every context
/// line, so a patch built from an older state does not apply.
///
/// # Errors
///
/// [`GitError::DoesNotApply`] when the target changed; others otherwise.
pub async fn apply(
    runner: &GitRunner,
    top: &Path,
    patch: &[u8],
    target: ApplyTarget,
    reverse: bool,
) -> Result<(), GitError> {
    let mut arguments = args(["apply"]);
    if target == ApplyTarget::Index {
        arguments.push("--cached".into());
    }
    if reverse {
        arguments.push("--reverse".into());
    }
    arguments.extend(args(["--whitespace=nowarn", "-"]));
    succeeded(write(runner, top, arguments, patch, WRITE_TIMEOUT).await?).map(|_| ())
}

/// `git add` of one untracked path.
///
/// # Errors
///
/// A run or git failure.
pub async fn add_path(runner: &GitRunner, top: &Path, path: &str) -> Result<(), GitError> {
    let mut arguments = args(["add", "--"]);
    arguments.push(path.into());
    succeeded(write(runner, top, arguments, &[], WRITE_TIMEOUT).await?).map(|_| ())
}

/// A branch name PiUI accepts before asking git: letters, digits, `.`, `_`,
/// `-` and `/`, no leading `-`, `.` or `/`, no `..`, `//`, `@{` or `.lock`
/// component, at most 100 characters.
#[must_use]
pub fn plain_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-/".contains(character))
        && !name.starts_with(['-', '.', '/'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

/// Git's own check of `refs/heads/<name>`.
///
/// # Errors
///
/// [`GitError::Failed`] for a name git rejects.
pub async fn check_branch_name(runner: &GitRunner, top: &Path, name: &str) -> Result<(), GitError> {
    if !plain_branch_name(name) {
        return Err(GitError::Failed);
    }
    let mut arguments = args(["check-ref-format"]);
    arguments.push(format!("refs/heads/{name}").into());
    succeeded(read(runner, top, arguments, SMALL_OUTPUT).await?).map(|_| ())
}

/// Whether `refs/heads/<name>` exists.
///
/// # Errors
///
/// A run failure.
pub async fn branch_exists(runner: &GitRunner, top: &Path, name: &str) -> Result<bool, GitError> {
    let mut arguments = args(["rev-parse", "--verify", "--quiet"]);
    arguments.push(format!("refs/heads/{name}").into());
    let output = read(runner, top, arguments, SMALL_OUTPUT).await?;
    Ok(output.success())
}

/// The full commit id HEAD names.
///
/// # Errors
///
/// [`GitError::NoCommits`] before the first commit.
pub async fn head_commit(runner: &GitRunner, top: &Path) -> Result<String, GitError> {
    let output = read(
        runner,
        top,
        args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
        SMALL_OUTPUT,
    )
    .await?;
    if !output.success() {
        return Err(GitError::NoCommits);
    }
    let id = String::from_utf8(output.stdout).map_err(|_| GitError::Malformed)?;
    let id = id.trim();
    if id.len() < 40 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::Malformed);
    }
    Ok(id.to_owned())
}

/// `git worktree add -b <branch> <path> <commit>`; the folder must not exist.
///
/// # Errors
///
/// A run or git failure.
pub async fn worktree_add(
    runner: &GitRunner,
    top: &Path,
    path: &Path,
    branch: &str,
    commit: &str,
) -> Result<(), GitError> {
    if !plain_branch_name(branch) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::Failed);
    }
    let mut arguments = args(["worktree", "add", "-b"]);
    arguments.push(branch.into());
    arguments.push("--".into());
    arguments.push(plain_path(path).into_os_string());
    arguments.push(commit.into());
    succeeded(write(runner, top, arguments, &[], WORKTREE_ADD_TIMEOUT).await?).map(|_| ())
}

/// `git worktree remove [--force] <path>`. Without `force` git refuses a
/// work tree with changes or untracked files.
///
/// # Errors
///
/// A run or git failure.
pub async fn worktree_remove(
    runner: &GitRunner,
    top: &Path,
    path: &Path,
    force: bool,
) -> Result<(), GitError> {
    let mut arguments = args(["worktree", "remove"]);
    if force {
        arguments.push("--force".into());
    }
    arguments.push("--".into());
    arguments.push(plain_path(path).into_os_string());
    succeeded(write(runner, top, arguments, &[], WORKTREE_REMOVE_TIMEOUT).await?).map(|_| ())
}

#[cfg(test)]
mod tests;
