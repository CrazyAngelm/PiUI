//! Script step tests (script test v1) through the host path the Tauri command
//! uses. Scripts are real tiny Node programs run under process containment;
//! no model, provider or native harness is started, and no run is created.

use super::*;
use piui_index::TrustState;
use serde_json::json;
use std::path::PathBuf;

/// Counts the project files (proving the working directory) and echoes one
/// run input and the step id from stdin.
const COLLECT: &str = "import { readFileSync, readdirSync } from 'node:fs';\n\
    const input = JSON.parse(readFileSync(0, 'utf8'));\n\
    console.log(JSON.stringify({ files: readdirSync('.').length, task: input.inputs.task, step: input.step.id }));\n";

/// Starts a heartbeat grandchild writing next to the project folder and
/// never exits on its own.
const TREE: &str = "import { spawn } from 'node:child_process';\n\
    import { readFileSync } from 'node:fs';\n\
    import { join } from 'node:path';\n\
    JSON.parse(readFileSync(0, 'utf8'));\n\
    const path = join(process.cwd(), '..', 'heartbeat.txt');\n\
    spawn(process.execPath, ['-e', `setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(path)}, '.'), 40)`], { stdio: 'ignore' }).unref();\n\
    console.log('started');\n\
    setInterval(() => {}, 1000);\n";

const MARKER: &str = "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'x');\n";

struct Fixture {
    root: PathBuf,
    project: PathBuf,
    workspace_id: String,
    host: HostState,
    tests: ScriptTestState,
}

impl Fixture {
    fn new(name: &str, trust: TrustState, safe_mode: bool) -> Self {
        let root =
            std::env::temp_dir().join(format!("piui-script-test-{name}-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        std::fs::create_dir_all(&project).expect("project folder");
        std::fs::write(project.join("a.txt"), "a").expect("project file");
        std::fs::write(project.join("b.txt"), "b").expect("project file");
        let host = HostState::open(&root.join("app-data"), safe_mode).expect("host state");
        let directory = ProjectDirectory::resolve(&project).expect("project directory");
        let workspace_id = host
            .index
            .lock()
            .expect("index")
            .register_project_directory(&directory, Some("Scripts"), trust)
            .expect("registers the project")
            .id;
        Self {
            root,
            project,
            workspace_id,
            host,
            tests: ScriptTestState::default(),
        }
    }

    fn work_root(&self) -> PathBuf {
        self.root.join("app-data").join("orchestration-scripts")
    }

    fn request(&self, source: &str, timeout: u32, fields: Value) -> ScriptTestRequestV1 {
        serde_json::from_value(json!({
            "workspaceId": self.workspace_id,
            "testId": uuid::Uuid::new_v4().to_string(),
            "runtime": "node",
            "source": source,
            "timeoutSeconds": timeout,
            "resultFields": fields,
            "stdin": {
                "inputs": {"task": "demo"},
                "dependencies": {"plan": {"text": null, "data": null}},
                "step": {"id": "collect", "name": "Collect"}
            }
        }))
        .expect("request")
    }

    async fn run(
        &self,
        request: ScriptTestRequestV1,
    ) -> Result<ScriptTestResultV1, ScriptTestError> {
        run_script_test(&self.host, &self.work_root(), &self.tests, request).await
    }

    fn heartbeat(&self) -> PathBuf {
        self.root.join("heartbeat.txt")
    }

    fn work_root_is_empty(&self) -> bool {
        std::fs::read_dir(self.work_root())
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    }

    fn project_files(&self) -> usize {
        std::fs::read_dir(&self.project).expect("project").count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Waits until the heartbeat grandchild wrote, then proves nothing writes any more.
async fn assert_heartbeat_stopped(path: &Path) {
    let first = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    assert!(first > 0, "the grandchild ran before the tree was stopped");
    tokio::time::sleep(Duration::from_millis(700)).await;
    let second = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    assert_eq!(first, second, "a descendant outlived the stopped script");
}

#[tokio::test]
async fn a_json_result_is_checked_like_a_run_in_the_project_folder() {
    let fixture = Fixture::new("json", TrustState::Trusted, false);
    let result = fixture
        .run(fixture.request(
            COLLECT,
            30,
            json!([{"name": "files", "kind": "number"}, {"name": "task", "kind": "text"}]),
        ))
        .await
        .expect("the test runs");
    assert_eq!(result.protocol, 1);
    assert_eq!(result.outcome, ScriptTestOutcome::Exited);
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(
        result.data,
        Some(json!({"files": 2, "task": "demo", "step": "collect"}))
    );
    assert!(result.field_issues.is_empty());
    assert_eq!(result.failure, None, "a run would succeed");
    assert!(!result.stdout_truncated);
    assert_eq!(result.stderr, "");
    // Nothing was written into the project and no source copy remains.
    assert_eq!(fixture.project_files(), 2);
    assert!(fixture.work_root_is_empty());
}

#[tokio::test]
async fn text_output_and_field_issues_follow_the_run_checker() {
    let fixture = Fixture::new("text", TrustState::Trusted, false);
    let text = "console.log('3 files');\n";
    let result = fixture
        .run(fixture.request(text, 30, json!([])))
        .await
        .expect("the test runs");
    assert_eq!(result.stdout.trim_end(), "3 files");
    assert_eq!(result.data, None);
    assert_eq!(result.failure, None, "text passes without declared fields");

    let result = fixture
        .run(fixture.request(text, 30, json!([{"name": "files", "kind": "number"}])))
        .await
        .expect("the test runs");
    assert_eq!(
        result.failure,
        Some(FailureRecord::new("result-invalid-json"))
    );

    let result = fixture
        .run(fixture.request(
            "console.log(JSON.stringify({ files: '3' }));\n",
            30,
            json!([{"name": "files", "kind": "number"}, {"name": "summary", "kind": "text"}]),
        ))
        .await
        .expect("the test runs");
    assert_eq!(result.data, Some(json!({"files": "3"})));
    assert_eq!(
        result.field_issues,
        vec![
            ScriptTestFieldIssue {
                field: "files".into(),
                code: "result-field-type",
            },
            ScriptTestFieldIssue {
                field: "summary".into(),
                code: "result-missing-field",
            },
        ]
    );
    assert_eq!(
        result.failure,
        Some(FailureRecord::new("result-field-type"))
    );

    // Declared artifacts must name a file in the project, as in a run.
    let result = fixture
        .run(fixture.request(
            "console.log(JSON.stringify({ report: 'missing.md' }));\n",
            30,
            json!([{"name": "report", "kind": "artifact"}]),
        ))
        .await
        .expect("the test runs");
    assert_eq!(
        result.failure,
        Some(FailureRecord::new("result-artifact-unavailable"))
    );
    let result = fixture
        .run(fixture.request(
            "console.log(JSON.stringify({ report: 'a.txt' }));\n",
            30,
            json!([{"name": "report", "kind": "artifact"}]),
        ))
        .await
        .expect("the test runs");
    assert_eq!(result.failure, None);
}

#[tokio::test]
async fn a_non_zero_exit_fails_with_the_stderr_tail() {
    let fixture = Fixture::new("exit", TrustState::Trusted, false);
    let result = fixture
        .run(fixture.request(
            "console.log('partial');\nconsole.error('first line');\nconsole.error('Error: the check failed');\nprocess.exit(4);\n",
            30,
            json!([]),
        ))
        .await
        .expect("the test runs");
    assert_eq!(result.outcome, ScriptTestOutcome::Exited);
    assert_eq!(result.exit_code, Some(4));
    assert_eq!(result.stdout.trim_end(), "partial");
    assert!(result.stderr.contains("Error: the check failed"));
    assert_eq!(
        result.failure,
        Some(FailureRecord::with_detail(
            "script-failed",
            "first line\nError: the check failed"
        ))
    );
}

#[tokio::test]
async fn a_timeout_stops_the_whole_tree() {
    let fixture = Fixture::new("timeout", TrustState::Trusted, false);
    let result = fixture
        .run(fixture.request(TREE, 3, json!([])))
        .await
        .expect("the test runs");
    assert_eq!(result.outcome, ScriptTestOutcome::TimedOut);
    assert_eq!(result.exit_code, None);
    assert_eq!(
        result.stdout.trim_end(),
        "started",
        "output before the timeout"
    );
    assert_eq!(result.data, None);
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.code.as_str()),
        Some("script-timeout")
    );
    assert!(result.duration_ms >= 3000);
    assert_heartbeat_stopped(&fixture.heartbeat()).await;
    assert!(fixture.work_root_is_empty());
}

#[tokio::test]
async fn cancel_stops_the_tree_and_reports_cancelled() {
    let fixture = Fixture::new("cancel", TrustState::Trusted, false);
    let request = fixture.request(TREE, 600, json!([]));
    let test_id = request.test_id.clone();
    let heartbeat = fixture.heartbeat();
    let canceller = async {
        for _ in 0..400 {
            if std::fs::metadata(&heartbeat).is_ok_and(|meta| meta.len() > 0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        fixture.tests.cancel(&fixture.workspace_id, &test_id)
    };
    let (result, cancelled) = tokio::join!(fixture.run(request), canceller);
    assert!(cancelled, "the running test was found");
    let result = result.expect("the test ends");
    assert_eq!(result.outcome, ScriptTestOutcome::Cancelled);
    assert_eq!(result.failure, None);
    assert_heartbeat_stopped(&heartbeat).await;
    // The registration is gone once the command returned.
    assert!(!fixture.tests.cancel(&fixture.workspace_id, &test_id));
    assert!(fixture.work_root_is_empty());
}

#[tokio::test]
async fn untrusted_projects_and_safe_mode_never_run_a_test() {
    for (name, trust, safe_mode, expected) in [
        (
            "restricted",
            TrustState::Restricted,
            false,
            ScriptTestError::NotTrusted,
        ),
        (
            "unknown-trust",
            TrustState::Unknown,
            false,
            ScriptTestError::NotTrusted,
        ),
        (
            "safe-mode",
            TrustState::Trusted,
            true,
            ScriptTestError::SafeMode,
        ),
    ] {
        let fixture = Fixture::new(name, trust, safe_mode);
        let result = fixture.run(fixture.request(MARKER, 30, json!([]))).await;
        assert_eq!(result, Err(expected), "{name}");
        assert!(!fixture.project.join("ran.txt").exists(), "{name}");
    }
    let fixture = Fixture::new("unknown-project", TrustState::Trusted, false);
    let mut request = fixture.request(MARKER, 30, json!([]));
    request.workspace_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(fixture.run(request).await, Err(ScriptTestError::NotFound));
    assert!(!fixture.project.join("ran.txt").exists());
}

#[tokio::test]
async fn invalid_requests_are_refused_before_anything_runs() {
    let fixture = Fixture::new("invalid", TrustState::Trusted, false);
    let large_source = format!("// {}\n{MARKER}", "x".repeat(MAX_SCRIPT_SOURCE_BYTES));
    let mut requests = vec![
        fixture.request(" \n", 30, json!([])),
        fixture.request(&large_source, 30, json!([])),
        fixture.request(MARKER, 0, json!([])),
        fixture.request(MARKER, 3601, json!([])),
        fixture.request(
            MARKER,
            30,
            json!([{"name": "files", "kind": "number"}, {"name": "files", "kind": "text"}]),
        ),
        fixture.request(MARKER, 30, json!([{"name": " ", "kind": "text"}])),
    ];
    let mut blank_id = fixture.request(MARKER, 30, json!([]));
    blank_id.test_id = " ".into();
    requests.push(blank_id);
    let mut long_id = fixture.request(MARKER, 30, json!([]));
    long_id.test_id = "x".repeat(129);
    requests.push(long_id);
    let mut large_stdin = fixture.request(MARKER, 30, json!([]));
    large_stdin.stdin.insert(
        "padding".into(),
        json!("x".repeat(MAX_SCRIPT_TEST_STDIN_BYTES)),
    );
    requests.push(large_stdin);
    for request in requests {
        assert_eq!(fixture.run(request).await, Err(ScriptTestError::Invalid));
    }
    assert!(!fixture.project.join("ran.txt").exists());

    // A running id is never reused, and the host bounds concurrent tests.
    let request = fixture.request(MARKER, 30, json!([]));
    let held = fixture
        .tests
        .register(&fixture.workspace_id, &request.test_id)
        .expect("registers");
    assert_eq!(fixture.run(request).await, Err(ScriptTestError::Conflict));
    let others = (1..MAX_CONCURRENT_SCRIPT_TESTS)
        .map(|index| {
            fixture
                .tests
                .register(&fixture.workspace_id, &format!("other-{index}"))
                .expect("registers")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        fixture.run(fixture.request(MARKER, 30, json!([]))).await,
        Err(ScriptTestError::Busy)
    );
    drop(others);
    drop(held);
    assert!(!fixture.project.join("ran.txt").exists());
}

#[test]
fn requests_name_only_a_script_runtime_and_reject_unknown_fields() {
    let valid = json!({
        "workspaceId": "workspace", "testId": "test", "runtime": "python",
        "source": "print(1)", "timeoutSeconds": 5, "stdin": {}
    });
    let request: ScriptTestRequestV1 = serde_json::from_value(valid.clone()).expect("valid");
    assert_eq!(request.runtime, ScriptRuntime::Python);
    assert!(
        request.result_fields.is_empty(),
        "result fields default to none"
    );
    for (field, value) in [
        ("runtime", json!("agent")),
        ("runtime", json!("llm")),
        ("runtime", json!("bash")),
        ("executor", json!({"type": "agent"})),
        ("profile", json!({"harness": "codex"})),
        ("cwd", json!("C:\\")),
        ("env", json!({"PATH": "."})),
        ("stdin", json!([1, 2])),
        ("stdin", json!("{}")),
        ("timeoutSeconds", json!(-1)),
    ] {
        let mut changed = valid.clone();
        changed[field] = value;
        assert!(
            serde_json::from_value::<ScriptTestRequestV1>(changed).is_err(),
            "{field}"
        );
    }
    assert!(
        serde_json::from_value::<ScriptTestCancelRequestV1>(
            json!({"workspaceId": "workspace", "testId": "test", "force": true})
        )
        .is_err()
    );
}

#[test]
fn script_test_v1_matches_the_public_contract_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/orchestration-script-test-v1.json"
    ))
    .expect("fixture");
    let request: ScriptTestRequestV1 =
        serde_json::from_value(fixture["request"].clone()).expect("request");
    assert_eq!(request.runtime, ScriptRuntime::Node);
    assert_eq!(request.result_fields.len(), 1);
    assert!(validate(&request).is_ok());
    let cancel: ScriptTestCancelRequestV1 =
        serde_json::from_value(fixture["cancelRequest"].clone()).expect("cancel request");
    assert_eq!(cancel.test_id, request.test_id);
    assert_eq!(
        serde_json::to_value(ScriptTestCancelResultV1 {
            protocol: SCRIPT_TEST_PROTOCOL,
            cancelled: true,
        })
        .expect("cancel result"),
        fixture["cancelResult"]
    );
    let result = ScriptTestResultV1 {
        protocol: SCRIPT_TEST_PROTOCOL,
        outcome: ScriptTestOutcome::Exited,
        exit_code: Some(0),
        duration_ms: 42,
        stdout: "{\"files\":\"1\"}\n".into(),
        stdout_truncated: false,
        stderr: String::new(),
        stderr_truncated: false,
        data: Some(json!({"files": "1"})),
        field_issues: vec![ScriptTestFieldIssue {
            field: "files".into(),
            code: "result-field-type",
        }],
        failure: Some(FailureRecord::new("result-field-type")),
    };
    assert_eq!(
        serde_json::to_value(result).expect("result"),
        fixture["result"]
    );
    let timed_out = ScriptTestResultV1 {
        protocol: SCRIPT_TEST_PROTOCOL,
        outcome: ScriptTestOutcome::TimedOut,
        exit_code: None,
        duration_ms: 1004,
        stdout: "first step done\n".into(),
        stdout_truncated: false,
        stderr: "still waiting\n".into(),
        stderr_truncated: false,
        data: None,
        field_issues: Vec::new(),
        failure: Some(FailureRecord::with_detail(
            "script-timeout",
            "still waiting\n",
        )),
    };
    assert_eq!(
        serde_json::to_value(timed_out).expect("timed out"),
        fixture["timedOut"]
    );
    assert_eq!(
        serde_json::to_value(ScriptTestError::NotTrusted).expect("error"),
        fixture["error"]
    );
    for (error, code) in [
        (ScriptTestError::Invalid, "invalid"),
        (ScriptTestError::SafeMode, "safe-mode"),
        (ScriptTestError::ProjectUnavailable, "project-unavailable"),
        (ScriptTestError::ShuttingDown, "shutting-down"),
        (
            ScriptTestError::ScriptRuntimeUnavailable,
            "script-runtime-unavailable",
        ),
        (ScriptTestError::ScriptStartFailed, "script-start-failed"),
        (
            ScriptTestError::ScriptOutcomeUnknown,
            "script-outcome-unknown",
        ),
    ] {
        assert_eq!(
            serde_json::to_value(error).expect("error"),
            json!({"code": code})
        );
    }
}
