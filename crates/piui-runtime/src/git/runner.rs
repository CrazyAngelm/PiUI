//! Contained, bounded `git` invocations with fixed argument vectors.
//!
//! Git is resolved from absolute `PATH` entries only and started without a
//! shell, in the repository folder the host verified. Every invocation turns
//! repository hooks off (an empty PiUI-owned `core.hooksPath`), turns off
//! `core.fsmonitor`, the pager and quoting of paths, treats pathspecs
//! literally, removes repository-redirecting `GIT_*` variables from the
//! environment and never prompts for credentials. Read operations also set
//! `GIT_OPTIONAL_LOCKS=0`, so a status never rewrites the index. The process
//! tree is contained (a Windows Job Object assigned before the process
//! resumes, or a Unix process group), stdout is bounded and the invocation
//! has a timeout. Nothing here logs arguments, paths or output.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(any(unix, windows))]
use piui_platform::ProcessContainment;
#[cfg(unix)]
use piui_platform::{ProcessGroupId, UnixProcessGroup};
#[cfg(windows)]
use piui_platform::{ProcessId, SuspendedProcess, WindowsJob};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Notify;

/// Most stderr bytes kept (its tail); only used to classify refusals.
const STDERR_LIMIT: usize = 8 * 1024;
const READ_CHUNK_BYTES: usize = 16 * 1024;
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const REAP_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a git invocation produced no usable output.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum GitRunError {
    #[error("git is not installed")]
    Unavailable,
    #[error("git could not be started")]
    NotStarted,
    #[error("git did not finish in time")]
    TimedOut,
    #[error("git produced more output than PiUI reads")]
    TooLarge,
    #[error("git started but its outcome could not be observed")]
    Unobserved,
}

/// Whether an invocation may change the repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitAccess {
    /// Never takes optional locks, so it never rewrites the index.
    Read,
    /// May change the index, the working tree or refs.
    Write,
}

/// One invocation: arguments follow PiUI's fixed global options.
pub struct GitRequest<'a> {
    pub cwd: &'a Path,
    pub args: Vec<OsString>,
    pub stdin: &'a [u8],
    pub stdout_limit: usize,
    pub timeout: Duration,
    pub access: GitAccess,
}

/// A finished invocation. A non-zero exit code is not an error here; the
/// caller interprets it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    /// The tail of stderr, lossily decoded; used only to classify refusals.
    pub stderr: String,
}

impl GitOutput {
    #[must_use]
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// A resolved git executable plus the empty hooks folder PiUI points
/// `core.hooksPath` at.
#[derive(Clone, Debug)]
pub struct GitRunner {
    program: PathBuf,
    hooks_dir: PathBuf,
}

impl GitRunner {
    /// Finds git on `PATH` without running it. `hooks_dir` must be an
    /// existing, empty folder owned by PiUI.
    ///
    /// # Errors
    ///
    /// [`GitRunError::Unavailable`] when no git executable is found.
    pub fn resolve(hooks_dir: PathBuf) -> Result<Self, GitRunError> {
        let name = if cfg!(windows) { "git.exe" } else { "git" };
        let program = find_in(name, std::env::var_os("PATH").as_deref())?;
        Ok(Self { program, hooks_dir })
    }

    /// A runner for an explicit executable (tests and diagnostics).
    #[must_use]
    pub fn with_program(program: PathBuf, hooks_dir: PathBuf) -> Self {
        Self { program, hooks_dir }
    }

    /// The fixed options every invocation starts with.
    fn global_args(&self) -> Vec<OsString> {
        let mut hooks = OsString::from("core.hooksPath=");
        hooks.push(self.hooks_dir.as_os_str());
        let mut args: Vec<OsString> = vec!["--no-pager".into(), "--literal-pathspecs".into()];
        for setting in [
            hooks,
            "core.fsmonitor=false".into(),
            "core.quotePath=false".into(),
            "color.ui=false".into(),
            "advice.detachedHead=false".into(),
        ] {
            args.push("-c".into());
            args.push(setting);
        }
        args
    }

    /// Runs git to completion, timeout or the stdout bound.
    ///
    /// # Errors
    ///
    /// See [`GitRunError`]. The process tree is terminated in every case.
    pub async fn run(&self, request: GitRequest<'_>) -> Result<GitOutput, GitRunError> {
        let mut args = self.global_args();
        args.extend(request.args.iter().cloned());
        let environment = git_environment(&std::env::vars_os().collect::<Vec<_>>(), request.access);
        let (mut child, mut containment) =
            spawn_contained(&self.program, &args, request.cwd, &environment).await?;
        let stdin = child.stdin.take();
        let input = request.stdin.to_vec();
        let writer = tokio::spawn(async move {
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(&input).await;
                let _ = stdin.shutdown().await;
            }
        });
        let overflow = Arc::new(Notify::new());
        let stdout = Arc::new(Mutex::new(Capture::default()));
        let stderr = Arc::new(Mutex::new(Capture::default()));
        let stdout_reader = child.stdout.take().map(|stream| {
            tokio::spawn(read_bounded(
                stream,
                Arc::clone(&stdout),
                request.stdout_limit,
                Arc::clone(&overflow),
            ))
        });
        let stderr_reader = child
            .stderr
            .take()
            .map(|stream| tokio::spawn(read_tail(stream, Arc::clone(&stderr), STDERR_LIMIT)));

        enum Ended {
            Exited(Option<i32>),
            WaitFailed,
            TimedOut,
            TooLarge,
        }
        let ended = tokio::select! {
            status = child.wait() => status.map_or(Ended::WaitFailed, |status| Ended::Exited(status.code())),
            () = tokio::time::sleep(request.timeout) => Ended::TimedOut,
            () = overflow.notified() => Ended::TooLarge,
        };
        let terminated = containment.terminate();
        if !matches!(ended, Ended::Exited(_)) {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(REAP_TIMEOUT, child.wait()).await;
        }
        writer.abort();
        for reader in [stdout_reader, stderr_reader].into_iter().flatten() {
            let abort = reader.abort_handle();
            if tokio::time::timeout(PIPE_DRAIN_TIMEOUT, reader)
                .await
                .is_err()
            {
                abort.abort();
            }
        }
        terminated?;
        let (stdout, overflowed) = take_capture(&stdout);
        let (stderr, _) = take_capture(&stderr);
        match ended {
            Ended::Exited(_) if overflowed => Err(GitRunError::TooLarge),
            Ended::Exited(code) => Ok(GitOutput {
                code,
                stdout,
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            }),
            Ended::TooLarge => Err(GitRunError::TooLarge),
            Ended::TimedOut => Err(GitRunError::TimedOut),
            Ended::WaitFailed => Err(GitRunError::Unobserved),
        }
    }
}

/// Only absolute `PATH` entries are searched: a relative entry would resolve
/// against the repository folder, which may contain untrusted files.
fn find_in(name: &str, path: Option<&OsStr>) -> Result<PathBuf, GitRunError> {
    let path = path.ok_or(GitRunError::Unavailable)?;
    std::env::split_paths(path)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .ok_or(GitRunError::Unavailable)
}

/// The host environment without any `GIT_*` variable (they can point git at
/// another repository, index or object store), plus fixed settings.
pub fn git_environment(
    host: &[(OsString, OsString)],
    access: GitAccess,
) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<(OsString, OsString)> = host
        .iter()
        .filter(|(name, _)| {
            let name = name.to_string_lossy();
            let upper = name.to_ascii_uppercase();
            !upper.starts_with("GIT_")
                && upper != "LC_ALL"
                && upper != "LANGUAGE"
                && upper != "PAGER"
        })
        .cloned()
        .collect();
    environment.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    environment.push(("LC_ALL".into(), "C".into()));
    environment.push(("LANGUAGE".into(), "C".into()));
    if access == GitAccess::Read {
        environment.push(("GIT_OPTIONAL_LOCKS".into(), "0".into()));
    }
    environment
}

/// The folder as git expects it: Windows `canonicalize` returns verbatim
/// `\\?\` paths, which git cannot use as a working directory.
#[must_use]
pub fn plain_path(path: &Path) -> PathBuf {
    crate::script_runner::process_directory(path)
}

/// Owns the containment of one git process tree.
struct GitContainment {
    #[cfg(unix)]
    group: Option<UnixProcessGroup>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

impl GitContainment {
    fn terminate(&mut self) -> Result<(), GitRunError> {
        #[cfg(unix)]
        if let Some(mut group) = self.group.take() {
            let result = group.force_terminate_tree();
            group.discard_after_supervisor_cleanup();
            result.map_err(|_| GitRunError::Unobserved)?;
        }
        #[cfg(windows)]
        if let Some(mut job) = self.job.take() {
            let terminated = job.force_terminate_tree();
            let closed = job.close();
            if terminated.is_err() || closed.is_err() {
                return Err(GitRunError::Unobserved);
            }
        }
        Ok(())
    }
}

impl Drop for GitContainment {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

async fn spawn_contained(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Result<(tokio::process::Child, GitContainment), GitRunError> {
    #[cfg(windows)]
    let mut job = WindowsJob::new().map_err(|_| GitRunError::NotStarted)?;
    let mut standard = std::process::Command::new(program);
    standard
        .args(args)
        .current_dir(plain_path(cwd))
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        standard.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    }
    let mut command = Command::from(standard);
    command.kill_on_drop(false);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| GitRunError::NotStarted)?;

    #[cfg(windows)]
    let containment = {
        // The primary thread stays suspended until the Job owns the process.
        let assignment = child
            .id()
            .and_then(|pid| ProcessId::new(pid).ok())
            .and_then(|pid| {
                job.assign_before_resume(SuspendedProcess::from_created_suspended(pid))
                    .ok()
            });
        let Some(assignment) = assignment else {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(GitRunError::NotStarted);
        };
        if job.resume_assigned(assignment).is_err() {
            let _ = job.force_terminate_tree();
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(GitRunError::NotStarted);
        }
        GitContainment { job: Some(job) }
    };
    #[cfg(unix)]
    let containment = {
        let group = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .and_then(|pid| ProcessGroupId::new(pid).ok());
        let Some(group) = group else {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(GitRunError::Unobserved);
        };
        GitContainment {
            group: Some(UnixProcessGroup::from_spawned_group(group)),
        }
    };
    Ok((child, containment))
}

#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    overflowed: bool,
}

fn take_capture(capture: &Arc<Mutex<Capture>>) -> (Vec<u8>, bool) {
    capture.lock().map_or_else(
        |_| (Vec::new(), true),
        |mut capture| (std::mem::take(&mut capture.bytes), capture.overflowed),
    )
}

/// Keeps up to `limit` bytes; one more byte signals `overflow` and stops.
async fn read_bounded(
    mut stream: impl AsyncRead + Unpin,
    capture: Arc<Mutex<Capture>>,
    limit: usize,
    overflow: Arc<Notify>,
) {
    let mut chunk = vec![0_u8; READ_CHUNK_BYTES];
    while let Ok(read) = stream.read(&mut chunk).await {
        if read == 0 {
            return;
        }
        let Ok(mut capture) = capture.lock() else {
            return;
        };
        if capture.bytes.len().saturating_add(read) > limit {
            capture.overflowed = true;
            drop(capture);
            overflow.notify_one();
            return;
        }
        capture.bytes.extend_from_slice(&chunk[..read]);
    }
}

async fn read_tail(mut stream: impl AsyncRead + Unpin, capture: Arc<Mutex<Capture>>, limit: usize) {
    let mut chunk = vec![0_u8; READ_CHUNK_BYTES];
    while let Ok(read) = stream.read(&mut chunk).await {
        if read == 0 {
            return;
        }
        let Ok(mut capture) = capture.lock() else {
            return;
        };
        capture.bytes.extend_from_slice(&chunk[..read]);
        if capture.bytes.len() > limit {
            let excess = capture.bytes.len() - limit;
            capture.bytes.drain(..excess);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{GitAccess, git_environment};
    use std::ffi::OsString;

    #[test]
    fn environment_drops_repository_redirects_and_fixes_prompts_and_locale() {
        let host: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), "/bin".into()),
            ("GIT_DIR".into(), "/elsewhere/.git".into()),
            ("git_index_file".into(), "/elsewhere/index".into()),
            ("GIT_CONFIG_PARAMETERS".into(), "'core.hooksPath=/x'".into()),
            ("LC_ALL".into(), "de_DE.UTF-8".into()),
            ("HOME".into(), "/home/a".into()),
        ];
        let read = git_environment(&host, GitAccess::Read);
        let names: Vec<String> = read
            .iter()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"PATH".to_owned()));
        assert!(names.contains(&"HOME".to_owned()));
        assert!(
            !names
                .iter()
                .any(|name| name.eq_ignore_ascii_case("GIT_DIR"))
        );
        assert!(
            !names
                .iter()
                .any(|name| name.eq_ignore_ascii_case("GIT_INDEX_FILE"))
        );
        assert!(!names.iter().any(|name| name == "GIT_CONFIG_PARAMETERS"));
        let value = |key: &str| {
            read.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.to_string_lossy().into_owned())
        };
        assert_eq!(value("LC_ALL").as_deref(), Some("C"));
        assert_eq!(value("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(value("GIT_OPTIONAL_LOCKS").as_deref(), Some("0"));
        let write = git_environment(&host, GitAccess::Write);
        assert!(!write.iter().any(|(name, _)| name == "GIT_OPTIONAL_LOCKS"));
    }
}
