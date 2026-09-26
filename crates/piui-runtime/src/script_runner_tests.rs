//! Script runner tests. The process tests run real tiny scripts through the
//! installed interpreters; they never start a model or a native harness.

use super::*;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

/// A private project folder and script root, removed on drop.
struct Fixture {
    root: PathBuf,
    project: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let unique = format!(
            "piui-script-runner-{name}-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        );
        let root = std::env::temp_dir().join(unique);
        let project = root.join("project");
        std::fs::create_dir_all(&project).expect("creates the project folder");
        // Like the host's trusted project directory: canonical, which is a
        // verbatim `\\?\` path on Windows.
        let project = std::fs::canonicalize(&project).expect("canonical project");
        Self { root, project }
    }

    fn work_dir(&self, name: &str) -> PathBuf {
        self.root
            .join("app-data")
            .join("orchestration-scripts")
            .join(name)
    }

    fn file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The real host environment with a planted credential that must not leak.
fn host_environment() -> Vec<(OsString, OsString)> {
    let mut environment = std::env::vars_os().collect::<Vec<_>>();
    environment.push(("ANTHROPIC_API_KEY".into(), "sk-ant-planted-secret".into()));
    environment.push((
        "PIUI_AGENT_API_TOKEN".into(),
        "planted-operator-token".into(),
    ));
    environment
}

struct Launch<'a> {
    fixture: &'a Fixture,
    kind: ScriptInterpreter,
    source: &'a str,
    stdin: Value,
    timeout: Duration,
    name: &'a str,
}

impl Launch<'_> {
    async fn run(self, cancel: watch::Receiver<bool>) -> Result<ScriptRun, ScriptRunError> {
        let interpreter = resolve_interpreter(self.kind).expect("the interpreter is installed");
        let stdin = serde_json::to_vec(&self.stdin).expect("stdin encodes");
        let environment = host_environment();
        let work_dir = self.fixture.work_dir(self.name);
        let result = run_script(
            ScriptRequest {
                interpreter: &interpreter,
                source: self.source,
                stdin: &stdin,
                project_dir: &self.fixture.project,
                work_dir: &work_dir,
                timeout: self.timeout,
                host_environment: &environment,
            },
            cancel,
        )
        .await;
        assert!(!work_dir.exists(), "the private script folder is removed");
        result
    }

    async fn finish(self) -> ScriptRun {
        let (_keep, cancel) = watch::channel(false);
        self.run(cancel).await.expect("the script runs")
    }
}

fn exited(run: &ScriptRun) -> (Option<i32>, &str, &str) {
    match &run.outcome {
        ScriptOutcome::Exited {
            code,
            stdout,
            stderr,
        } => (*code, stdout.text.as_str(), stderr.text.as_str()),
        other => panic!("expected an exit, got {other:?}"),
    }
}

fn document(task: &str) -> Value {
    json!({
        "inputs": {"task": task},
        "dependencies": {"plan": {"text": "Plan: count", "data": null}},
        "step": {"id": "metrics", "name": "Metrics"}
    })
}

/// Waits until `path` has content (the grandchild is alive), then proves
/// that nothing writes to it any more.
async fn assert_heartbeat_stopped(path: &Path) {
    let first = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    assert!(first > 0, "the grandchild process ran before termination");
    tokio::time::sleep(Duration::from_millis(700)).await;
    let second = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    assert_eq!(first, second, "a descendant kept running after termination");
}

async fn wait_for_heartbeat(path: &Path) {
    for _ in 0..200 {
        if std::fs::metadata(path).is_ok_and(|meta| meta.len() > 0) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the grandchild never started");
}

/// Node source that starts heartbeat grandchildren and then never exits.
fn node_tree_source(detached: bool) -> String {
    format!(
        "import {{ spawn }} from 'node:child_process';\n\
         import {{ readFileSync }} from 'node:fs';\n\
         const input = JSON.parse(readFileSync(0, 'utf8'));\n\
         const beat = `setInterval(() => require('node:fs').appendFileSync(${{JSON.stringify(input.inputs.task)}}, '.'), 40)`;\n\
         spawn(process.execPath, ['-e', beat], {{ stdio: 'ignore', detached: {detached} }}).unref();\n\
         setInterval(() => {{}}, 1000);\n"
    )
}

#[test]
fn environment_keeps_only_the_allowlist() {
    let host = [
        ("PATH", "/bin"),
        ("HOME", "/home/user"),
        ("ANTHROPIC_API_KEY", "sk-ant-secret"),
        ("OPENAI_API_KEY", "sk-secret"),
        ("GITHUB_TOKEN", "ghp_secret"),
        ("PIUI_AGENT_API_TOKEN", "operator"),
        ("PIUI_NODE", "/usr/bin/node"),
        ("LANG", "C.UTF-8"),
    ]
    .map(|(name, value)| (OsString::from(name), OsString::from(value)));
    let names = script_environment(&host)
        .iter()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(names, ["PATH", "HOME", "LANG"]);
}

#[cfg(windows)]
#[test]
fn windows_environment_names_match_case_insensitively() {
    let host = [
        ("Path", "C:\\bin"),
        ("SYSTEMROOT", "C:\\Windows"),
        ("temp", "C:\\t"),
    ]
    .map(|(name, value)| (OsString::from(name), OsString::from(value)));
    assert_eq!(script_environment(&host).len(), 3);
}

#[test]
fn captured_text_keeps_character_boundaries() {
    let head = SharedCapture::default();
    if let Ok(mut capture) = head.lock() {
        capture.bytes = [UTF8_BOM, "ab€".as_bytes()].concat();
        capture.bytes.truncate(UTF8_BOM.len() + 4);
        capture.truncated = true;
    }
    assert_eq!(
        head_text(&head),
        CapturedOutput {
            text: "ab".into(),
            truncated: true
        }
    );
    let tail = SharedCapture::default();
    if let Ok(mut capture) = tail.lock() {
        capture.bytes = "€xy".as_bytes()[1..].to_vec();
        capture.truncated = true;
    }
    assert_eq!(tail_text(&tail).text, "xy");
}

#[cfg(windows)]
#[test]
fn verbatim_project_paths_become_plain_working_directories() {
    assert_eq!(
        process_directory(Path::new(r"\\?\C:\Users\me\project")),
        PathBuf::from(r"C:\Users\me\project")
    );
    assert_eq!(
        process_directory(Path::new(r"\\?\UNC\server\share\repo")),
        PathBuf::from(r"\\server\share\repo")
    );
    assert_eq!(
        process_directory(Path::new(r"C:\plain")),
        PathBuf::from(r"C:\plain")
    );
}

#[test]
fn interpreters_are_found_only_on_absolute_path_entries() {
    assert_eq!(
        find_in("python3", None),
        Err(ScriptRunError::RuntimeUnavailable)
    );
    assert_eq!(
        find_in("python3", Some(OsStr::new(""))),
        Err(ScriptRunError::RuntimeUnavailable)
    );
    let fixture = Fixture::new("path");
    let bin = fixture.root.join("bin");
    std::fs::create_dir_all(&bin).expect("bin");
    std::fs::write(bin.join("python3"), b"").expect("fake interpreter");
    assert_eq!(
        find_in("python3", Some(bin.as_os_str())),
        Ok(bin.join("python3"))
    );
    // A relative entry would resolve against the project folder.
    assert_eq!(
        find_in("python3", Some(OsStr::new("bin"))),
        Err(ScriptRunError::RuntimeUnavailable)
    );
}

#[tokio::test]
async fn node_json_result_reads_stdin_in_the_project_folder() {
    let fixture = Fixture::new("node-json");
    let source = "import { readFileSync } from 'node:fs';\n\
        const input = JSON.parse(readFileSync(0, 'utf8'));\n\
        console.log(JSON.stringify({ task: input.inputs.task, length: [...input.inputs.task].length, \
        step: input.step.name, dependency: input.dependencies.plan.text, cwd: process.cwd() }));";
    let run = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Node,
        source,
        stdin: document("Ünïcödé ✓ задача"),
        timeout: Duration::from_secs(30),
        name: "node-json",
    }
    .finish()
    .await;
    let (code, stdout, _) = exited(&run);
    assert_eq!(code, Some(0));
    let value: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    assert_eq!(value["task"], "Ünïcödé ✓ задача");
    assert_eq!(value["length"], 16);
    assert_eq!(value["step"], "Metrics");
    assert_eq!(value["dependency"], "Plan: count");
    let cwd = PathBuf::from(value["cwd"].as_str().expect("cwd"));
    assert!(
        !value["cwd"]
            .as_str()
            .unwrap_or_default()
            .starts_with(r"\\?\")
    );
    assert_eq!(
        std::fs::canonicalize(cwd).expect("cwd exists"),
        std::fs::canonicalize(&fixture.project).expect("project exists")
    );
    // The source was never written into the project.
    assert_eq!(
        std::fs::read_dir(&fixture.project)
            .expect("lists project")
            .count(),
        0
    );
}

#[tokio::test]
async fn node_plain_text_and_non_zero_exit_are_observed() {
    let fixture = Fixture::new("node-exit");
    let run = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Node,
        source: "console.log('3 files changed');\nconsole.error('warning: one\\nError: two failed');\nprocess.exit(3);",
        stdin: document("x"),
        timeout: Duration::from_secs(30),
        name: "node-exit",
    }
    .finish()
    .await;
    let (code, stdout, stderr) = exited(&run);
    assert_eq!(code, Some(3));
    assert_eq!(stdout, "3 files changed\n");
    assert_eq!(stderr, "warning: one\nError: two failed\n");

    let run = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Node,
        source: "throw new Error('boom from the script');",
        stdin: document("x"),
        timeout: Duration::from_secs(30),
        name: "node-throw",
    }
    .finish()
    .await;
    let (code, _, stderr) = exited(&run);
    assert_ne!(code, Some(0));
    assert!(stderr.contains("boom from the script"), "{stderr}");
}

#[tokio::test]
async fn scripts_never_see_host_credentials() {
    let fixture = Fixture::new("node-env");
    let run = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Node,
        source: "console.log(JSON.stringify({ keys: Object.keys(process.env), \
            key: process.env.ANTHROPIC_API_KEY ?? null, token: process.env.PIUI_AGENT_API_TOKEN ?? null }));",
        stdin: document("x"),
        timeout: Duration::from_secs(30),
        name: "node-env",
    }
    .finish()
    .await;
    let (code, stdout, _) = exited(&run);
    assert_eq!(code, Some(0));
    assert!(!stdout.contains("planted"), "{stdout}");
    let value: Value = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(value["key"], Value::Null);
    assert_eq!(value["token"], Value::Null);
    for key in value["keys"].as_array().expect("keys") {
        let key = key.as_str().expect("name");
        // Windows keeps hidden per-drive `=C:` entries in every process.
        if key.starts_with('=') {
            continue;
        }
        assert!(
            SCRIPT_ENVIRONMENT_ALLOWLIST
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(key)),
            "unexpected variable {key}"
        );
    }
}

#[tokio::test]
async fn timeout_terminates_the_whole_process_tree() {
    let fixture = Fixture::new("node-timeout");
    let heartbeat = fixture.file("heartbeat.txt");
    let source = node_tree_source(false);
    let run = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Node,
        source: &source,
        stdin: json!({"inputs": {"task": heartbeat}, "dependencies": {}, "step": {"id": "s", "name": "S"}}),
        timeout: Duration::from_secs(2),
        name: "node-timeout",
    }
    .finish()
    .await;
    assert!(
        matches!(run.outcome, ScriptOutcome::TimedOut { .. }),
        "{run:?}"
    );
    assert!(run.elapsed >= Duration::from_secs(2));
    assert!(run.elapsed < Duration::from_secs(20));
    assert_heartbeat_stopped(&heartbeat).await;
}

#[cfg(windows)]
#[tokio::test]
async fn job_containment_also_ends_detached_descendants() {
    let fixture = Fixture::new("node-detached");
    let heartbeat = fixture.file("detached.txt");
    let source = node_tree_source(true);
    let run = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Node,
        source: &source,
        stdin: json!({"inputs": {"task": heartbeat}, "dependencies": {}, "step": {"id": "s", "name": "S"}}),
        timeout: Duration::from_secs(2),
        name: "node-detached",
    }
    .finish()
    .await;
    assert!(matches!(run.outcome, ScriptOutcome::TimedOut { .. }));
    assert_heartbeat_stopped(&heartbeat).await;
}

#[tokio::test]
async fn cancellation_terminates_the_tree_and_reports_cancelled() {
    let fixture = Fixture::new("node-cancel");
    let heartbeat = fixture.file("cancel.txt");
    let source = node_tree_source(false);
    let (cancel, receiver) = watch::channel(false);
    let launch = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Node,
        source: &source,
        stdin: json!({"inputs": {"task": heartbeat}, "dependencies": {}, "step": {"id": "s", "name": "S"}}),
        timeout: Duration::from_secs(600),
        name: "node-cancel",
    };
    let canceller = async {
        wait_for_heartbeat(&heartbeat).await;
        cancel.send_replace(true);
    };
    let (run, ()) = tokio::join!(launch.run(receiver), canceller);
    let run = run.expect("the script ran");
    assert_eq!(run.outcome, ScriptOutcome::Cancelled);
    assert!(run.elapsed < Duration::from_secs(60));
    assert_heartbeat_stopped(&heartbeat).await;
}

#[tokio::test]
async fn stdout_is_bounded_and_a_silent_stdin_reader_never_blocks() {
    let fixture = Fixture::new("node-bounded");
    let run = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Node,
        // Ignores stdin entirely and prints 1 MiB.
        source: "process.stdout.write('é'.repeat(512 * 1024));",
        stdin: json!({"inputs": {"task": "x".repeat(512 * 1024)}, "dependencies": {}, "step": {"id": "s", "name": "S"}}),
        timeout: Duration::from_secs(60),
        name: "node-bounded",
    }
    .finish()
    .await;
    match &run.outcome {
        ScriptOutcome::Exited { code, stdout, .. } => {
            assert_eq!(*code, Some(0));
            assert!(stdout.truncated);
            assert!(stdout.text.len() <= SCRIPT_STDOUT_LIMIT);
            assert!(stdout.text.chars().all(|character| character == 'é'));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn an_existing_work_folder_is_never_reused() {
    let fixture = Fixture::new("node-reuse");
    let work_dir = fixture.work_dir("taken");
    std::fs::create_dir_all(&work_dir).expect("pre-existing folder");
    let interpreter = resolve_interpreter(ScriptInterpreter::Node).expect("node");
    let (_keep, cancel) = watch::channel(false);
    let result = run_script(
        ScriptRequest {
            interpreter: &interpreter,
            source: "console.log(1)",
            stdin: b"{}",
            project_dir: &fixture.project,
            work_dir: &work_dir,
            timeout: Duration::from_secs(5),
            host_environment: &[],
        },
        cancel,
    )
    .await;
    assert_eq!(result, Err(ScriptRunError::NotStarted));
}

#[cfg(windows)]
mod powershell {
    use super::*;

    fn launch<'a>(
        fixture: &'a Fixture,
        source: &'a str,
        name: &'a str,
        timeout: u64,
    ) -> Launch<'a> {
        Launch {
            fixture,
            kind: ScriptInterpreter::PowerShell,
            source,
            stdin: document("Ünïcödé ✓ задача"),
            timeout: Duration::from_secs(timeout),
            name,
        }
    }

    #[tokio::test]
    async fn json_result_round_trips_utf8_stdin() {
        let fixture = Fixture::new("ps-json");
        let source = "param()\r\n\
            $doc = [Console]::In.ReadToEnd() | ConvertFrom-Json\r\n\
            [pscustomobject]@{ task = $doc.inputs.task; length = $doc.inputs.task.Length; step = $doc.step.id } | ConvertTo-Json -Compress\r\n";
        let run = launch(&fixture, source, "ps-json", 60).finish().await;
        let (code, stdout, stderr) = exited(&run);
        assert_eq!(code, Some(0), "{stderr}");
        let value: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
        assert_eq!(value["task"], "Ünïcödé ✓ задача");
        assert_eq!(
            value["length"], 16,
            "decoded as UTF-8, not the console code page"
        );
        assert_eq!(value["step"], "metrics");
    }

    #[tokio::test]
    async fn plain_text_and_explicit_exit_codes_are_observed() {
        let fixture = Fixture::new("ps-exit");
        let run = launch(
            &fixture,
            "Write-Output 'plain text'\r\n[Console]::Error.WriteLine('bad input: ж')\r\nexit 7\r\n",
            "ps-exit",
            60,
        )
        .finish()
        .await;
        let (code, stdout, stderr) = exited(&run);
        assert_eq!(code, Some(7));
        assert_eq!(stdout.trim_end(), "plain text");
        assert_eq!(stderr.trim_end(), "bad input: ж");

        let run = launch(&fixture, "throw 'boom from PowerShell'\r\n", "ps-throw", 60)
            .finish()
            .await;
        let (code, _, stderr) = exited(&run);
        assert_eq!(code, Some(1));
        assert!(stderr.contains("boom from PowerShell"), "{stderr}");
    }

    #[tokio::test]
    async fn timeout_terminates_powershell() {
        let fixture = Fixture::new("ps-timeout");
        let run = launch(&fixture, "Start-Sleep -Seconds 60\r\n", "ps-timeout", 2)
            .finish()
            .await;
        assert!(
            matches!(run.outcome, ScriptOutcome::TimedOut { .. }),
            "{run:?}"
        );
        assert!(run.elapsed < Duration::from_secs(20));
    }
}

#[tokio::test]
async fn python_json_result_when_python_is_installed() {
    if resolve_interpreter(ScriptInterpreter::Python).is_err() {
        eprintln!("python is not installed; the python script test is skipped");
        return;
    }
    let fixture = Fixture::new("python-json");
    let run = Launch {
        fixture: &fixture,
        kind: ScriptInterpreter::Python,
        source: "import json, sys\ndoc = json.load(sys.stdin)\nprint(json.dumps({'task': doc['inputs']['task'], 'length': len(doc['inputs']['task'])}, ensure_ascii=False))\n",
        stdin: document("Ünïcödé ✓ задача"),
        timeout: Duration::from_secs(60),
        name: "python-json",
    }
    .finish()
    .await;
    let (code, stdout, stderr) = exited(&run);
    assert_eq!(code, Some(0), "{stderr}");
    let value: Value = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(value, json!({"task": "Ünïcödé ✓ задача", "length": 16}));
}
