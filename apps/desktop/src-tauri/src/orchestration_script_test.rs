//! Script step test v1: run one script step's draft once, without a pipeline
//! run (`contracts/orchestration-script-test-v1.ts`).
//!
//! A person's explicit Test click runs the node's current source with a
//! sample stdin document through the same host runner, admission rules and
//! result checks as a script step of a run: only a trusted, live project
//! outside safe mode (re-checked while it runs), the project folder as the
//! working directory, process-tree containment, the allowlisted environment,
//! the timeout and the output bounds. It is not a sandbox. Nothing is
//! recorded in any run, and the request can only name a script runtime, so a
//! test never starts an agent or a model call. Only metadata is logged, never
//! source, stdin or output.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use piui_orchestration::{
    FailureRecord, MAX_SCRIPT_SOURCE_BYTES, MAX_SCRIPT_TIMEOUT_SECONDS, MIN_SCRIPT_TIMEOUT_SECONDS,
    ResultField, ScriptCompletion, ScriptRuntime, ScriptStdoutResult, result_field_issues,
    script_stdout_result,
};
use piui_platform::ProjectDirectory;
use piui_runtime::script_runner::{
    CapturedOutput, ScriptOutcome, ScriptRequest, ScriptRun, ScriptRunError, resolve_interpreter,
    run_script,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tokio::sync::watch;

use crate::api::verified_project_directory;
use crate::orchestration_api::OrchestrationApiState;
use crate::orchestration_scheduler::{ScriptResolution, script_interpreter, script_resolution};
use crate::state::HostState;

pub const SCRIPT_TEST_PROTOCOL: u8 = 1;
/// Largest encoded sample stdin document.
pub const MAX_SCRIPT_TEST_STDIN_BYTES: usize = 256 * 1024;
const MAX_TEST_ID_BYTES: usize = 128;
const MAX_WORKSPACE_ID_BYTES: usize = 512;
const MAX_TEST_RESULT_FIELDS: usize = 64;
/// Tests running at once on this host; more are refused as `busy`.
const MAX_CONCURRENT_SCRIPT_TESTS: usize = 4;
/// How often a running test re-checks that its project is still trusted and
/// live, exactly like a script step of a run; a failed check stops its tree.
const SCRIPT_TEST_TRUST_POLL: Duration = Duration::from_millis(500);

/// Typed refusals, serialized as `{"code": "<kebab-case>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum ScriptTestError {
    #[error("the script test request is invalid")]
    Invalid,
    #[error("the project is not registered")]
    NotFound,
    #[error("scripts do not run in safe mode")]
    SafeMode,
    #[error("the project is not trusted")]
    NotTrusted,
    #[error("the project folder is unavailable")]
    ProjectUnavailable,
    #[error("PiUI is shutting down")]
    ShuttingDown,
    #[error("a test with this id is already running")]
    Conflict,
    #[error("too many script tests are running")]
    Busy,
    #[error("the script interpreter is not installed")]
    ScriptRuntimeUnavailable,
    #[error("the script could not be started; nothing ran")]
    ScriptStartFailed,
    #[error("the script started but its outcome could not be observed")]
    ScriptOutcomeUnknown,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptTestRequestV1 {
    pub(crate) workspace_id: String,
    pub(crate) test_id: String,
    pub(crate) runtime: ScriptRuntime,
    pub(crate) source: String,
    pub(crate) timeout_seconds: u32,
    #[serde(default)]
    pub(crate) result_fields: Vec<ResultField>,
    pub(crate) stdin: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptTestCancelRequestV1 {
    pub(crate) workspace_id: String,
    pub(crate) test_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTestCancelResultV1 {
    pub protocol: u8,
    pub cancelled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScriptTestOutcome {
    Exited,
    TimedOut,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTestFieldIssue {
    pub field: String,
    pub code: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTestResultV1 {
    pub protocol: u8,
    pub outcome: ScriptTestOutcome,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stdout_truncated: bool,
    pub stderr: String,
    pub stderr_truncated: bool,
    pub data: Option<Value>,
    pub field_issues: Vec<ScriptTestFieldIssue>,
    pub failure: Option<FailureRecord>,
}

type TestKey = (String, String);
/// A registered test: its registry entry and the two ends of its cancellation.
type TestHandles<'a> = (
    Registration<'a>,
    Arc<watch::Sender<bool>>,
    watch::Receiver<bool>,
);

/// Cancellation handles of running tests, by workspace and test id.
#[derive(Default)]
pub struct ScriptTestState {
    active: Mutex<HashMap<TestKey, Arc<watch::Sender<bool>>>>,
}

/// Removes a test from the registry however its command ends.
struct Registration<'a> {
    state: &'a ScriptTestState,
    key: TestKey,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Some(mut active) = self.state.lock() {
            active.remove(&self.key);
        }
    }
}

impl ScriptTestState {
    fn lock(&self) -> Option<MutexGuard<'_, HashMap<TestKey, Arc<watch::Sender<bool>>>>> {
        self.active.lock().ok()
    }

    fn register(
        &self,
        workspace_id: &str,
        test_id: &str,
    ) -> Result<TestHandles<'_>, ScriptTestError> {
        let mut active = self.lock().ok_or(ScriptTestError::ScriptStartFailed)?;
        let key = (workspace_id.to_owned(), test_id.to_owned());
        if active.contains_key(&key) {
            return Err(ScriptTestError::Conflict);
        }
        if active.len() >= MAX_CONCURRENT_SCRIPT_TESTS {
            return Err(ScriptTestError::Busy);
        }
        let (sender, receiver) = watch::channel(false);
        let sender = Arc::new(sender);
        active.insert(key.clone(), Arc::clone(&sender));
        Ok((Registration { state: self, key }, sender, receiver))
    }

    /// Asks a running test to stop its process tree. False when none runs.
    pub(crate) fn cancel(&self, workspace_id: &str, test_id: &str) -> bool {
        let sender = self.lock().and_then(|active| {
            active
                .get(&(workspace_id.to_owned(), test_id.to_owned()))
                .cloned()
        });
        sender.is_some_and(|sender| {
            sender.send_replace(true);
            true
        })
    }
}

fn valid_id(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit
}

/// Request rules; returns the encoded stdin document.
fn validate(request: &ScriptTestRequestV1) -> Result<Vec<u8>, ScriptTestError> {
    let fields_valid = request.result_fields.len() <= MAX_TEST_RESULT_FIELDS && {
        let mut names = BTreeSet::new();
        request
            .result_fields
            .iter()
            .all(|field| !field.name.trim().is_empty() && names.insert(field.name.as_str()))
    };
    if !valid_id(&request.workspace_id, MAX_WORKSPACE_ID_BYTES)
        || !valid_id(&request.test_id, MAX_TEST_ID_BYTES)
        || request.source.trim().is_empty()
        || request.source.len() > MAX_SCRIPT_SOURCE_BYTES
        || !(MIN_SCRIPT_TIMEOUT_SECONDS..=MAX_SCRIPT_TIMEOUT_SECONDS)
            .contains(&request.timeout_seconds)
        || !fields_valid
    {
        return Err(ScriptTestError::Invalid);
    }
    let stdin = serde_json::to_vec(&request.stdin).map_err(|_| ScriptTestError::Invalid)?;
    if stdin.len() > MAX_SCRIPT_TEST_STDIN_BYTES {
        return Err(ScriptTestError::Invalid);
    }
    Ok(stdin)
}

/// The admission of a script step of a run, with a distinct reason for each
/// refusal: a trusted, registered and live project outside safe mode.
fn authorize(host: &HostState, workspace_id: &str) -> Result<ProjectDirectory, ScriptTestError> {
    if host.safe_mode {
        return Err(ScriptTestError::SafeMode);
    }
    if host.is_shutting_down() {
        return Err(ScriptTestError::ShuttingDown);
    }
    verified_project_directory(host, workspace_id, true).map_err(|error| match error.code {
        "NOT_TRUSTED" => ScriptTestError::NotTrusted,
        "NOT_FOUND" => ScriptTestError::NotFound,
        _ => ScriptTestError::ProjectUnavailable,
    })
}

/// Runs one script test to its end. The caller's `tests` registry lets a
/// cancellation stop it; `work_root` is the host's private script folder.
pub(crate) async fn run_script_test(
    host: &HostState,
    work_root: &Path,
    tests: &ScriptTestState,
    request: ScriptTestRequestV1,
) -> Result<ScriptTestResultV1, ScriptTestError> {
    let stdin = validate(&request)?;
    // Authorized under the gate that trust changes take, like a run's start.
    let (directory, registration, cancel, cancelled) = {
        let _operation = host.live_runtime_operation_gate.lock().await;
        let directory = authorize(host, &request.workspace_id)?;
        let (registration, cancel, cancelled) =
            tests.register(&request.workspace_id, &request.test_id)?;
        (directory, registration, cancel, cancelled)
    };
    let interpreter = resolve_interpreter(script_interpreter(request.runtime))
        .map_err(|_| ScriptTestError::ScriptRuntimeUnavailable)?;
    let project_dir = directory.canonical_path().to_path_buf();
    let work_dir = work_root.join(format!("test-{}", uuid::Uuid::new_v4()));
    let environment = std::env::vars_os().collect::<Vec<_>>();
    let script = run_script(
        ScriptRequest {
            interpreter: &interpreter,
            source: &request.source,
            stdin: &stdin,
            project_dir: &project_dir,
            work_dir: &work_dir,
            timeout: Duration::from_secs(u64::from(request.timeout_seconds)),
            host_environment: &environment,
        },
        cancelled,
    );
    tokio::pin!(script);
    let result = loop {
        tokio::select! {
            result = &mut script => break result,
            () = tokio::time::sleep(SCRIPT_TEST_TRUST_POLL) => {
                if authorize(host, &request.workspace_id).is_err() {
                    cancel.send_replace(true);
                }
            }
        }
    };
    drop(registration);
    log_script_test_end(request.runtime, &result);
    match result {
        Ok(run) => Ok(test_result(&project_dir, &request.result_fields, run).await),
        Err(ScriptRunError::RuntimeUnavailable) => Err(ScriptTestError::ScriptRuntimeUnavailable),
        Err(ScriptRunError::NotStarted) => Err(ScriptTestError::ScriptStartFailed),
        Err(ScriptRunError::Unobserved) => Err(ScriptTestError::ScriptOutcomeUnknown),
    }
}

/// What the person sees: the observed process end, bounded output, the
/// parsed JSON object with its field check, and the failure a run would
/// record, computed by the run's own mapping and result checker.
async fn test_result(
    project_dir: &Path,
    fields: &[ResultField],
    run: ScriptRun,
) -> ScriptTestResultV1 {
    let duration_ms = u64::try_from(run.elapsed.as_millis()).unwrap_or(u64::MAX);
    let failure = match script_resolution(project_dir, fields, Ok(run.outcome.clone())).await {
        ScriptResolution::Record(ScriptCompletion::Exited { stdout, truncated }) => {
            match script_stdout_result(fields, stdout, truncated) {
                ScriptStdoutResult::Data(_) | ScriptStdoutResult::Output(_) => None,
                ScriptStdoutResult::Failed(failure) => Some(failure),
            }
        }
        ScriptResolution::Record(ScriptCompletion::Failed { failure }) => Some(failure),
        ScriptResolution::Stopped | ScriptResolution::Unobserved => None,
    };
    let (outcome, exit_code, stdout, stderr) = match run.outcome {
        ScriptOutcome::Exited {
            code,
            stdout,
            stderr,
        } => (ScriptTestOutcome::Exited, code, stdout, stderr),
        ScriptOutcome::TimedOut { stdout, stderr } => {
            (ScriptTestOutcome::TimedOut, None, stdout, stderr)
        }
        ScriptOutcome::Cancelled => (
            ScriptTestOutcome::Cancelled,
            None,
            CapturedOutput::default(),
            CapturedOutput::default(),
        ),
    };
    // Only the complete stdout of a script that ended is read as JSON, exactly
    // as in a run: a cut or interrupted output has an unknown end.
    let data = (outcome == ScriptTestOutcome::Exited && !stdout.truncated)
        .then(|| serde_json::from_str::<Value>(stdout.text.trim()).ok())
        .flatten()
        .filter(Value::is_object);
    let field_issues = data
        .as_ref()
        .map(|value| {
            result_field_issues(fields, value)
                .into_iter()
                .map(|issue| ScriptTestFieldIssue {
                    field: issue.field,
                    code: issue.code,
                })
                .collect()
        })
        .unwrap_or_default();
    ScriptTestResultV1 {
        protocol: SCRIPT_TEST_PROTOCOL,
        outcome,
        exit_code,
        duration_ms,
        stdout: stdout.text,
        stdout_truncated: stdout.truncated,
        stderr: stderr.text,
        stderr_truncated: stderr.truncated,
        data,
        field_issues,
        failure,
    }
}

/// Structured metadata only: never source, stdin or output.
fn log_script_test_end(runtime: ScriptRuntime, result: &Result<ScriptRun, ScriptRunError>) {
    let (outcome, exit_code, elapsed) = match result {
        Ok(run) => {
            let (outcome, code) = match &run.outcome {
                ScriptOutcome::Exited { code, .. } => ("exited", *code),
                ScriptOutcome::TimedOut { .. } => ("timed-out", None),
                ScriptOutcome::Cancelled => ("cancelled", None),
            };
            (outcome, code, run.elapsed.as_millis())
        }
        Err(ScriptRunError::RuntimeUnavailable) => ("runtime-unavailable", None, 0),
        Err(ScriptRunError::NotStarted) => ("not-started", None, 0),
        Err(ScriptRunError::Unobserved) => ("unobserved", None, 0),
    };
    let exit_code = exit_code.map_or_else(|| "none".to_owned(), |code| code.to_string());
    eprintln!(
        "event=orchestration_script_test_ended runtime={} outcome={outcome} exit_code={exit_code} duration_ms={elapsed}",
        runtime.as_str()
    );
}

/// Runs the editor's script test (see the module documentation).
#[tauri::command]
pub async fn orchestration_script_test_v1(
    host_state: State<'_, HostState>,
    api: State<'_, OrchestrationApiState>,
    tests: State<'_, ScriptTestState>,
    request: ScriptTestRequestV1,
) -> Result<ScriptTestResultV1, ScriptTestError> {
    run_script_test(&host_state, api.script_work_root(), &tests, request).await
}

/// Stops a running script test's process tree; its test command then
/// resolves with the `cancelled` outcome. Stopping is always allowed.
#[tauri::command]
pub async fn orchestration_cancel_script_test_v1(
    tests: State<'_, ScriptTestState>,
    request: ScriptTestCancelRequestV1,
) -> Result<ScriptTestCancelResultV1, ScriptTestError> {
    if !valid_id(&request.workspace_id, MAX_WORKSPACE_ID_BYTES)
        || !valid_id(&request.test_id, MAX_TEST_ID_BYTES)
    {
        return Err(ScriptTestError::Invalid);
    }
    Ok(ScriptTestCancelResultV1 {
        protocol: SCRIPT_TEST_PROTOCOL,
        cancelled: tests.cancel(&request.workspace_id, &request.test_id),
    })
}

#[cfg(test)]
#[path = "orchestration_script_test_tests.rs"]
mod tests;
