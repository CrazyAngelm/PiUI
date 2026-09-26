//! Host-owned runner for pipeline script steps (orchestration v6.2).
//!
//! A script is trusted user code, not a sandbox: it runs with the user's file
//! and network access. The host writes its source to a fresh private
//! directory under application data (never into the project), starts the
//! resolved interpreter with the trusted project folder as the working
//! directory, a minimal allowlisted environment and one JSON document on
//! stdin, and contains the whole process tree (a Windows Job Object assigned
//! before the process resumes, or a Unix process group). The end of the
//! script, its timeout or a cancellation terminates the tree. Output is
//! bounded; nothing here logs source, stdin or output.

use std::ffi::{OsStr, OsString};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(any(unix, windows))]
use piui_platform::ProcessContainment;
#[cfg(unix)]
use piui_platform::{ProcessGroupId, UnixProcessGroup};
#[cfg(windows)]
use piui_platform::{ProcessId, SuspendedProcess, WindowsJob};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::watch;

/// Most stdout bytes kept from one script (its head).
pub const SCRIPT_STDOUT_LIMIT: usize = 256 * 1024;
/// Most stderr bytes kept from one script (its tail).
pub const SCRIPT_STDERR_LIMIT: usize = 64 * 1024;
/// Host environment variables a script inherits. Everything else, including
/// API keys, tokens and PiUI operator variables, is removed. `TMPDIR` is the
/// Unix spelling of `TEMP`/`TMP`.
pub const SCRIPT_ENVIRONMENT_ALLOWLIST: &[&str] = &[
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LANG",
];

/// How long pipes may stay open after the tree was terminated, for example
/// held by a descendant that left its Unix process group.
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Bound on reaping the root process after its tree was terminated.
const REAP_TIMEOUT: Duration = Duration::from_secs(10);
const READ_CHUNK_BYTES: usize = 16 * 1024;
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// Windows PowerShell reads a piped stdin and writes stdout in the console
/// code page. This fixed host wrapper switches both to UTF-8 and then runs
/// the step's script unchanged, keeping its `param`/`using` header and its
/// exit code.
const POWERSHELL_WRAPPER: &str = "# PiUI host wrapper: UTF-8 stdin and stdout, then the step's own script.\r\n\
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\r\n\
$global:LASTEXITCODE = 0\r\n\
& (Join-Path $PSScriptRoot 'main.ps1')\r\n\
exit $LASTEXITCODE\r\n";

/// Interpreter family of a script step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScriptInterpreter {
    /// Node.js, the same executable the native bridges use (`PIUI_NODE`
    /// first). The source is an ES module.
    Node,
    /// `py -3` on Windows, `python3` elsewhere, in UTF-8 mode.
    Python,
    /// Windows PowerShell on Windows, `pwsh` elsewhere.
    PowerShell,
}

impl ScriptInterpreter {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Python => "python",
            Self::PowerShell => "powershell",
        }
    }

    const fn source_file(self) -> &'static str {
        match self {
            Self::Node => "main.mjs",
            Self::Python => "main.py",
            Self::PowerShell => "main.ps1",
        }
    }
}

/// An interpreter executable found on this machine. Never user-supplied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedInterpreter {
    kind: ScriptInterpreter,
    program: PathBuf,
    args: Vec<&'static str>,
}

impl ResolvedInterpreter {
    pub fn kind(&self) -> ScriptInterpreter {
        self.kind
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum ScriptRunError {
    #[error("the script interpreter is not installed")]
    RuntimeUnavailable,
    /// Preparing or starting failed before any script code could run.
    #[error("the script could not be started; nothing ran")]
    NotStarted,
    /// The script may have run, but its outcome or cleanup is unknown.
    #[error("the script started but its outcome could not be observed")]
    Unobserved,
}

/// Bounded text captured from one output stream.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapturedOutput {
    pub text: String,
    /// Bytes beyond the bound were dropped.
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScriptOutcome {
    /// The script ended on its own. `code` is `None` when a signal ended it.
    Exited {
        code: Option<i32>,
        stdout: CapturedOutput,
        stderr: CapturedOutput,
    },
    /// The timeout elapsed and the whole process tree was terminated.
    TimedOut { stderr: CapturedOutput },
    /// Cancellation was requested and the whole process tree was terminated.
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptRun {
    pub outcome: ScriptOutcome,
    pub elapsed: Duration,
}

/// One script execution. `work_dir` must not exist yet: it is created
/// privately for this execution and removed afterwards.
pub struct ScriptRequest<'a> {
    pub interpreter: &'a ResolvedInterpreter,
    pub source: &'a str,
    pub stdin: &'a [u8],
    pub project_dir: &'a Path,
    pub work_dir: &'a Path,
    pub timeout: Duration,
    /// The host environment to filter, normally `std::env::vars_os()`.
    pub host_environment: &'a [(OsString, OsString)],
}

/// Finds the interpreter for `kind` without starting it.
pub fn resolve_interpreter(kind: ScriptInterpreter) -> Result<ResolvedInterpreter, ScriptRunError> {
    let (program, args) = match kind {
        ScriptInterpreter::Node => (
            crate::workspace_runtime::resolve_node()
                .map_err(|_| ScriptRunError::RuntimeUnavailable)?,
            Vec::new(),
        ),
        ScriptInterpreter::Python if cfg!(windows) => {
            (find_on_path("py.exe")?, vec!["-3", "-X", "utf8"])
        }
        ScriptInterpreter::Python => (find_on_path("python3")?, vec!["-X", "utf8"]),
        ScriptInterpreter::PowerShell if cfg!(windows) => (
            windows_powershell().map_or_else(|| find_on_path("powershell.exe"), Ok)?,
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ],
        ),
        ScriptInterpreter::PowerShell => (
            find_on_path("pwsh")?,
            vec!["-NoProfile", "-NonInteractive", "-File"],
        ),
    };
    Ok(ResolvedInterpreter {
        kind,
        program,
        args,
    })
}

fn find_on_path(name: &str) -> Result<PathBuf, ScriptRunError> {
    find_in(name, std::env::var_os("PATH").as_deref())
}

/// Only absolute `PATH` entries are searched: a relative entry would resolve
/// against the project folder, which may contain untrusted files.
fn find_in(name: &str, path: Option<&OsStr>) -> Result<PathBuf, ScriptRunError> {
    let path = path.ok_or(ScriptRunError::RuntimeUnavailable)?;
    std::env::split_paths(path)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .ok_or(ScriptRunError::RuntimeUnavailable)
}

fn windows_powershell() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot")?;
    let path = PathBuf::from(root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    path.is_file().then_some(path)
}

/// The allowlisted subset of `host`, matching names case-insensitively on
/// Windows where the environment block is case-insensitive.
pub fn script_environment(host: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
    host.iter()
        .filter(|(name, _)| {
            SCRIPT_ENVIRONMENT_ALLOWLIST.iter().any(|allowed| {
                if cfg!(windows) {
                    name.to_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(allowed))
                } else {
                    name.as_os_str() == OsStr::new(allowed)
                }
            })
        })
        .cloned()
        .collect()
}

/// Runs one script to completion, timeout or cancellation. `cancel`
/// becoming `true` terminates the tree; a dropped sender never cancels.
pub async fn run_script(
    request: ScriptRequest<'_>,
    mut cancel: watch::Receiver<bool>,
) -> Result<ScriptRun, ScriptRunError> {
    let entry = prepare_work_dir(request.work_dir, request.interpreter.kind, request.source)
        .map_err(|_| ScriptRunError::NotStarted);
    let result = match entry {
        Ok(entry) => run_prepared(&request, &entry, &mut cancel).await,
        Err(error) => Err(error),
    };
    remove_work_dir(request.work_dir).await;
    result
}

fn prepare_work_dir(
    work_dir: &Path,
    kind: ScriptInterpreter,
    source: &str,
) -> std::io::Result<PathBuf> {
    if let Some(parent) = work_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt as _;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    // A fresh directory per execution: an existing one is never reused.
    builder.create(work_dir)?;
    let source_path = work_dir.join(kind.source_file());
    if kind == ScriptInterpreter::PowerShell {
        // Windows PowerShell reads a BOM-less script in the ANSI code page.
        write_private(&source_path, &[UTF8_BOM, source.as_bytes()].concat())?;
        let wrapper = work_dir.join("run.ps1");
        write_private(
            &wrapper,
            &[UTF8_BOM, POWERSHELL_WRAPPER.as_bytes()].concat(),
        )?;
        return Ok(wrapper);
    }
    write_private(&source_path, source.as_bytes())?;
    Ok(source_path)
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.flush()
}

async fn remove_work_dir(work_dir: &Path) {
    // The tree is gone; Windows may release file handles a moment later.
    for _ in 0..20 {
        match std::fs::remove_dir_all(work_dir) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

/// Owns the containment of one script process tree.
struct ScriptContainment {
    #[cfg(unix)]
    group: Option<UnixProcessGroup>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

impl ScriptContainment {
    /// Terminates every process still in the tree and releases the primitive.
    fn terminate(&mut self) -> Result<(), ScriptRunError> {
        #[cfg(unix)]
        if let Some(mut group) = self.group.take() {
            let result = group.force_terminate_tree();
            group.discard_after_supervisor_cleanup();
            result.map_err(|_| ScriptRunError::Unobserved)?;
        }
        #[cfg(windows)]
        if let Some(mut job) = self.job.take() {
            let terminated = job.force_terminate_tree();
            let closed = job.close();
            if terminated.is_err() || closed.is_err() {
                return Err(ScriptRunError::Unobserved);
            }
        }
        Ok(())
    }
}

impl Drop for ScriptContainment {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

/// The working directory as a program expects it. Windows `canonicalize`
/// returns verbatim `\\?\` paths, which many programs (cmd.exe among them)
/// cannot use as a working directory; the plain spelling names the same
/// folder.
pub fn process_directory(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        if let Some(Component::Prefix(prefix)) = components.next() {
            let root = match prefix.kind() {
                Prefix::VerbatimDisk(letter) => Some(format!("{}:\\", char::from(letter))),
                Prefix::VerbatimUNC(server, share) => Some(format!(
                    "\\\\{}\\{}\\",
                    server.to_string_lossy(),
                    share.to_string_lossy()
                )),
                _ => None,
            };
            if let Some(root) = root {
                let mut plain = PathBuf::from(root);
                plain.extend(components.filter(|component| *component != Component::RootDir));
                return plain;
            }
        }
    }
    path.to_path_buf()
}

async fn spawn_contained(
    request: &ScriptRequest<'_>,
    entry: &Path,
) -> Result<(Child, ScriptContainment), ScriptRunError> {
    #[cfg(windows)]
    let mut job = WindowsJob::new().map_err(|_| ScriptRunError::NotStarted)?;
    let mut standard = std::process::Command::new(&request.interpreter.program);
    standard
        .args(&request.interpreter.args)
        .arg(entry)
        .current_dir(process_directory(request.project_dir))
        .env_clear()
        .envs(script_environment(request.host_environment))
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
    let mut child = command.spawn().map_err(|_| ScriptRunError::NotStarted)?;

    #[cfg(windows)]
    let containment = {
        // The primary thread stays suspended until the Job owns the process,
        // so no script code runs outside containment.
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
            return Err(ScriptRunError::NotStarted);
        };
        if job.resume_assigned(assignment).is_err() {
            let _ = job.force_terminate_tree();
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(ScriptRunError::NotStarted);
        }
        ScriptContainment { job: Some(job) }
    };
    #[cfg(unix)]
    let containment = {
        let group = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .and_then(|pid| ProcessGroupId::new(pid).ok());
        let Some(group) = group else {
            // The process already runs: its outcome is unknown.
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(ScriptRunError::Unobserved);
        };
        ScriptContainment {
            group: Some(UnixProcessGroup::from_spawned_group(group)),
        }
    };
    Ok((child, containment))
}

/// A byte buffer filled by a reader task and readable after it is aborted.
#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

type SharedCapture = Arc<Mutex<Capture>>;

/// Keeps the first `limit` bytes and discards the rest, so the child never
/// blocks on a full pipe.
async fn read_head(mut stream: impl AsyncRead + Unpin, capture: SharedCapture, limit: usize) {
    let mut chunk = vec![0_u8; READ_CHUNK_BYTES];
    while let Ok(read) = stream.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        let Ok(mut capture) = capture.lock() else {
            break;
        };
        let room = limit.saturating_sub(capture.bytes.len());
        let kept = read.min(room);
        capture.bytes.extend_from_slice(&chunk[..kept]);
        if kept < read {
            capture.truncated = true;
        }
    }
}

/// Keeps the last `limit` bytes.
async fn read_tail(mut stream: impl AsyncRead + Unpin, capture: SharedCapture, limit: usize) {
    let mut chunk = vec![0_u8; READ_CHUNK_BYTES];
    while let Ok(read) = stream.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        let Ok(mut capture) = capture.lock() else {
            break;
        };
        capture.bytes.extend_from_slice(&chunk[..read]);
        if capture.bytes.len() > limit {
            let excess = capture.bytes.len() - limit;
            capture.bytes.drain(..excess);
            capture.truncated = true;
        }
    }
}

fn head_text(capture: &SharedCapture) -> CapturedOutput {
    let Ok(capture) = capture.lock() else {
        return CapturedOutput::default();
    };
    let mut bytes = capture.bytes.as_slice();
    if capture.truncated
        && let Err(error) = std::str::from_utf8(bytes)
        && error.error_len().is_none()
    {
        // Drop a character cut at the bound.
        bytes = &bytes[..error.valid_up_to()];
    }
    let bytes = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    CapturedOutput {
        text: String::from_utf8_lossy(bytes).into_owned(),
        truncated: capture.truncated,
    }
}

fn tail_text(capture: &SharedCapture) -> CapturedOutput {
    let Ok(capture) = capture.lock() else {
        return CapturedOutput::default();
    };
    let mut bytes = capture.bytes.as_slice();
    if capture.truncated {
        // Start at a character boundary after the cut.
        let skip = bytes
            .iter()
            .take(3)
            .take_while(|byte| **byte & 0b1100_0000 == 0b1000_0000)
            .count();
        bytes = &bytes[skip..];
    }
    CapturedOutput {
        text: String::from_utf8_lossy(bytes).into_owned(),
        truncated: capture.truncated,
    }
}

async fn cancellation(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            // A dropped sender can never request cancellation.
            std::future::pending::<()>().await;
        }
    }
}

enum Ended {
    Exited(ExitStatus),
    WaitFailed,
    TimedOut,
    Cancelled,
}

async fn run_prepared(
    request: &ScriptRequest<'_>,
    entry: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<ScriptRun, ScriptRunError> {
    let (mut child, mut containment) = spawn_contained(request, entry).await?;
    let started = Instant::now();
    let stdin = child.stdin.take();
    let input = request.stdin.to_vec();
    // Written concurrently so a script that does not read stdin can never
    // block the host; a closed pipe is the script's choice.
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        }
    });
    let stdout_capture = SharedCapture::default();
    let stderr_capture = SharedCapture::default();
    let stdout_reader = child.stdout.take().map(|stream| {
        tokio::spawn(read_head(
            stream,
            Arc::clone(&stdout_capture),
            SCRIPT_STDOUT_LIMIT,
        ))
    });
    let stderr_reader = child.stderr.take().map(|stream| {
        tokio::spawn(read_tail(
            stream,
            Arc::clone(&stderr_capture),
            SCRIPT_STDERR_LIMIT,
        ))
    });

    let ended = tokio::select! {
        status = child.wait() => status.map_or(Ended::WaitFailed, Ended::Exited),
        () = tokio::time::sleep(request.timeout) => Ended::TimedOut,
        () = cancellation(cancel) => Ended::Cancelled,
    };
    let elapsed = started.elapsed();
    // Every case ends the whole tree: leftover descendants of a finished
    // script, and the script itself on timeout or cancellation.
    let terminated = containment.terminate();
    if !matches!(ended, Ended::Exited(_)) {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(REAP_TIMEOUT, child.wait()).await;
    }
    writer.abort();
    for (reader, capture) in [
        (stdout_reader, &stdout_capture),
        (stderr_reader, &stderr_capture),
    ] {
        let Some(reader) = reader else {
            continue;
        };
        let abort = reader.abort_handle();
        if tokio::time::timeout(PIPE_DRAIN_TIMEOUT, reader)
            .await
            .is_err()
        {
            // A descendant outside the tree holds the pipe; keep what arrived.
            abort.abort();
            if let Ok(mut capture) = capture.lock() {
                capture.truncated = true;
            }
        }
    }
    terminated?;
    let outcome = match ended {
        Ended::Exited(status) => ScriptOutcome::Exited {
            code: status.code(),
            stdout: head_text(&stdout_capture),
            stderr: tail_text(&stderr_capture),
        },
        Ended::TimedOut => ScriptOutcome::TimedOut {
            stderr: tail_text(&stderr_capture),
        },
        Ended::Cancelled => ScriptOutcome::Cancelled,
        Ended::WaitFailed => return Err(ScriptRunError::Unobserved),
    };
    Ok(ScriptRun { outcome, elapsed })
}

#[cfg(test)]
#[path = "script_runner_tests.rs"]
mod tests;
