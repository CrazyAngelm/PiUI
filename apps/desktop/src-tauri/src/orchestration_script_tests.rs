//! Script and llm steps through the host scheduling path (orchestration v6.2).
//!
//! Scripts are real tiny Node programs run by the host with process
//! containment, admitted, prepared, executed and recorded by the same
//! functions `schedule_run`, `launch_script` and `watch_script` use; only the
//! Tauri event and task glue is left out (the lib unit-test binary cannot
//! load Tauri's MockRuntime on Windows without an application manifest). No
//! model, provider or native harness is started.

use super::*;
use crate::orchestration_api::{
    OrchestrationApiState, RunRequest, SaveGraphRequest, StartRunRequest, orchestration_run_usage,
    save_graph,
};
use piui_index::TrustState;
use piui_orchestration::{NativeHistoryReference, RunStatus, TaskRecord};
use piui_platform::ProjectDirectory;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;

const COLLECT: &str = "import { readFileSync, readdirSync } from 'node:fs';\n\
    const input = JSON.parse(readFileSync(0, 'utf8'));\n\
    console.log(JSON.stringify({ files: readdirSync('.').length, task: input.inputs.task, step: input.step.id }));\n";

const REPORT: &str = "import { readFileSync } from 'node:fs';\n\
    const input = JSON.parse(readFileSync(0, 'utf8'));\n\
    const collect = input.dependencies.collect;\n\
    process.stdout.write(`report: ${collect.data.files} files for ${input.inputs.task}${collect.text === null ? '' : ' (text?)'}`);\n";

/// Starts a heartbeat grandchild writing next to the project folder and
/// never exits on its own.
const TREE: &str = "import { spawn } from 'node:child_process';\n\
    import { readFileSync } from 'node:fs';\n\
    import { join } from 'node:path';\n\
    JSON.parse(readFileSync(0, 'utf8'));\n\
    const path = join(process.cwd(), '..', 'heartbeat.txt');\n\
    spawn(process.execPath, ['-e', `setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(path)}, '.'), 40)`], { stdio: 'ignore' }).unref();\n\
    setInterval(() => {}, 1000);\n";

struct Fixture {
    root: PathBuf,
    project: PathBuf,
    workspace_id: String,
    host: HostState,
    api: OrchestrationApiState,
}

impl Fixture {
    fn new(name: &str, trust: TrustState, safe_mode: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piui-orchestration-scripts-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        std::fs::create_dir_all(&project).expect("project folder");
        std::fs::write(project.join("a.txt"), "a").expect("project file");
        std::fs::write(project.join("b.txt"), "b").expect("project file");
        let app_data = root.join("app-data");
        let host = HostState::open(&app_data, safe_mode).expect("host state");
        let directory = ProjectDirectory::resolve(&project).expect("project directory");
        let workspace_id = host
            .index
            .lock()
            .expect("index")
            .register_project_directory(&directory, Some("Scripts"), trust)
            .expect("registers the project")
            .id;
        let api = OrchestrationApiState::open(&app_data).expect("orchestration state");
        Self {
            root,
            project,
            workspace_id,
            host,
            api,
        }
    }

    fn save(&self, steps: Value) {
        let workspace = self.workspace_id.as_str();
        let request: SaveGraphRequest = serde_json::from_value(json!({
            "workspaceId": workspace,
            "profiles": [{"workspaceId": workspace, "value": {
                "id": "helper-profile", "name": "Helper", "harness": "codex", "model": "model",
                "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []},
                "allowedSpawnProfileIds": []}}],
            "team": {"workspaceId": workspace, "value": {"id": "team", "name": "Scripts",
                "members": [{"id": "helper", "profileId": "helper-profile"}],
                "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "helper"}},
            "pipeline": {"workspaceId": workspace, "value": {"id": "pipeline", "name": "Scripts",
                "inputs": [{"name": "task", "label": "Task", "kind": "text"}],
                "steps": steps}},
            "command": {"workspaceId": workspace, "value": {"id": "command", "name": "Scripts",
                "teamId": "team", "pipelineId": "pipeline"}}
        }))
        .expect("graph request");
        save_graph(&self.api, request).expect("saves the graph");
    }

    fn start(&self, run_id: &str) -> Run {
        self.api
            .create_run(StartRunRequest {
                workspace_id: self.workspace_id.clone(),
                run_id: run_id.into(),
                team_id: "team".into(),
                pipeline_id: "pipeline".into(),
                launch_command_id: Some("command".into()),
                inputs: BTreeMap::from([("task".to_owned(), json!("demo"))]),
            })
            .expect("creates the run")
    }

    fn run(&self, run_id: &str) -> Run {
        self.api
            .get_run(&self.workspace_id, run_id)
            .expect("reads")
            .expect("run exists")
    }

    /// One scheduling pass for the next ready script, exactly as
    /// `schedule_run` → `launch_script` → `watch_script` perform it; errors
    /// are the scheduler's typed codes.
    async fn run_next_script(
        &self,
        run_id: &str,
        cancel: watch::Receiver<bool>,
    ) -> Result<ScriptResolutionKind, &'static str> {
        self.scheduling_pass(run_id, cancel)
            .await
            .map_err(|error| error.code)
    }

    async fn scheduling_pass(
        &self,
        run_id: &str,
        cancel: watch::Receiver<bool>,
    ) -> Result<ScriptResolutionKind, OrchestrationSchedulerError> {
        let directory = authorize_live_workspace(&self.host, &self.workspace_id)?;
        let run = self
            .api
            .advance_automatic_steps(&self.workspace_id, run_id)
            .map_err(|_| OrchestrationSchedulerError::conflict())?;
        let step = next_ready_step(&run).ok_or_else(OrchestrationSchedulerError::conflict)?;
        let task_revision = task(&run, &step.id).revision();
        let (lease, interpreter) = match admit_script(
            &self.api,
            &self.workspace_id,
            &run,
            &step,
            task_revision,
            uuid::Uuid::new_v4().to_string(),
        ) {
            ScriptAdmission::Leased {
                lease, interpreter, ..
            } => (*lease, interpreter),
            ScriptAdmission::Rejected { error, .. } => return Err(error),
            ScriptAdmission::Idle => return Err(OrchestrationSchedulerError::conflict()),
        };
        let (launch, running) = prepare_script(
            &self.host,
            &self.api,
            &self.workspace_id,
            &directory,
            lease,
            interpreter,
            uuid::Uuid::new_v4().to_string(),
        )
        .await
        .map_err(|(_, error)| error)?;
        assert_eq!(
            task(&running, &launch.lease.step_id).status(),
            TaskStatus::Running,
            "the task runs before its process starts"
        );
        match execute_script(&launch, cancel).await {
            ScriptResolution::Record(completion) => {
                self.api
                    .record_script_outcome(
                        &self.workspace_id,
                        run_id,
                        &launch.lease.step_id,
                        &launch.execution_id,
                        completion,
                    )
                    .map_err(|_| OrchestrationSchedulerError::conflict())?;
                Ok(ScriptResolutionKind::Recorded)
            }
            ScriptResolution::Stopped => Ok(ScriptResolutionKind::Stopped),
            ScriptResolution::Unobserved => Ok(ScriptResolutionKind::Unobserved),
        }
    }

    fn heartbeat(&self) -> PathBuf {
        self.root.join("heartbeat.txt")
    }

    fn script_root_is_empty(&self) -> bool {
        std::fs::read_dir(self.api.script_work_root())
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ScriptResolutionKind {
    Recorded,
    Stopped,
    Unobserved,
}

fn quiet() -> watch::Receiver<bool> {
    let (sender, receiver) = watch::channel(false);
    // A dropped sender never cancels.
    drop(sender);
    receiver
}

fn helper() -> Value {
    json!({"id": "helper", "name": "Helper", "assignedMemberId": "helper",
        "instructions": "Only when called.", "executionMode": "callable", "dependencyStepIds": []})
}

fn script(id: &str, source: &str, timeout: u32, dependencies: Value) -> Value {
    json!({"id": id, "name": id, "assignedMemberId": id, "instructions": "",
        "executor": {"type": "script", "runtime": "node", "source": source, "timeoutSeconds": timeout},
        "dependencyStepIds": dependencies})
}

fn task<'a>(run: &'a Run, step_id: &str) -> &'a TaskRecord {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .expect("task")
}

#[tokio::test]
async fn host_runs_scripts_and_hands_results_to_the_next_script() {
    let harness = Fixture::new("chain", TrustState::Trusted, false);
    let mut collect = script("collect", COLLECT, 30, json!([]));
    collect["resultFields"] = json!([{"name": "files", "kind": "number"}]);
    harness.save(json!([
        helper(),
        collect,
        script("report", REPORT, 30, json!(["collect"]))
    ]));
    harness.start("run");
    for _ in 0..2 {
        assert_eq!(
            harness.run_next_script("run", quiet()).await,
            Ok(ScriptResolutionKind::Recorded)
        );
    }
    let run = harness.run("run");
    assert_eq!(run.status(), RunStatus::Succeeded, "{run:?}");
    let collect = task(&run, "collect");
    assert_eq!(
        collect.result_data(),
        Some(&json!({"files": 2, "task": "demo", "step": "collect"}))
    );
    assert_eq!(collect.output(), None);
    let execution = collect.execution().expect("execution id");
    assert!(uuid::Uuid::parse_str(&execution.id).is_ok());
    assert_eq!(
        task(&run, "report")
            .output()
            .map(|output| output.text.as_str()),
        Some("report: 2 files for demo")
    );
    assert_eq!(task(&run, "helper").status(), TaskStatus::Ready);
    // Nothing was written into the project and no source copy remains.
    assert_eq!(
        std::fs::read_dir(&harness.project)
            .expect("project")
            .count(),
        2
    );
    assert!(harness.script_root_is_empty());
    // Usage covers native sessions only; a script execution has none.
    let usage = orchestration_run_usage(
        &harness.api,
        &harness.host,
        &RunRequest {
            workspace_id: harness.workspace_id.clone(),
            run_id: "run".into(),
        },
    )
    .expect("usage skips script executions");
    assert!(usage.is_empty());
}

#[tokio::test]
async fn failing_and_timed_out_scripts_fail_with_typed_codes() {
    let harness = Fixture::new("fail", TrustState::Trusted, false);
    harness.save(json!([
        helper(),
        script(
            "collect",
            "console.log('partial');\nconsole.error('first line');\nconsole.error('Error: the check failed');\nprocess.exit(4);",
            30,
            json!([])
        ),
        script("report", REPORT, 30, json!(["collect"]))
    ]));
    harness.start("failed");
    assert_eq!(
        harness.run_next_script("failed", quiet()).await,
        Ok(ScriptResolutionKind::Recorded)
    );
    let run = harness.run("failed");
    assert_eq!(run.status(), RunStatus::Failed);
    let failure = task(&run, "collect").failure().expect("failure");
    assert_eq!(failure.code, "script-failed");
    assert_eq!(
        failure.detail.as_deref(),
        Some("first line\nError: the check failed")
    );
    assert_eq!(task(&run, "collect").output(), None);
    assert_eq!(task(&run, "report").status(), TaskStatus::Cancelled);

    let harness = Fixture::new("timeout", TrustState::Trusted, false);
    harness.save(json!([
        helper(),
        script(
            "collect",
            "console.error('still waiting');\nsetInterval(() => {}, 1000);",
            1,
            json!([])
        )
    ]));
    harness.start("slow");
    assert_eq!(
        harness.run_next_script("slow", quiet()).await,
        Ok(ScriptResolutionKind::Recorded)
    );
    let run = harness.run("slow");
    let failure = task(&run, "collect").failure().expect("failure");
    assert_eq!(failure.code, "script-timeout");
    assert_eq!(failure.detail.as_deref(), Some("still waiting"));
    assert!(harness.script_root_is_empty());
}

#[tokio::test]
async fn cancel_terminates_the_script_tree_and_the_run_commits_cancelled() {
    let harness = Fixture::new("cancel", TrustState::Trusted, false);
    harness.save(json!([helper(), script("collect", TREE, 600, json!([]))]));
    harness.start("cancel");
    let (cancel, receiver) = watch::channel(false);
    let heartbeat = harness.heartbeat();
    let canceller = async {
        for _ in 0..400 {
            if std::fs::metadata(&heartbeat).is_ok_and(|meta| meta.len() > 0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        cancel.send_replace(true);
    };
    let (resolution, ()) = tokio::join!(harness.run_next_script("cancel", receiver), canceller);
    assert_eq!(resolution, Ok(ScriptResolutionKind::Stopped));
    // The cancelling path commits the transition once the tree is proven gone.
    let running = harness.run("cancel");
    assert_eq!(task(&running, "collect").status(), TaskStatus::Running);
    let run = harness
        .api
        .commit_cancel_after_native_stop(&harness.workspace_id, "cancel", running.revision(), None)
        .expect("commits");
    assert_eq!(run.status(), RunStatus::Cancelled);
    assert_eq!(task(&run, "collect").status(), TaskStatus::Cancelled);
    let first = std::fs::metadata(&heartbeat)
        .map(|meta| meta.len())
        .unwrap_or(0);
    assert!(first > 0, "the grandchild ran before cancellation");
    tokio::time::sleep(Duration::from_millis(700)).await;
    let second = std::fs::metadata(&heartbeat)
        .map(|meta| meta.len())
        .unwrap_or(0);
    assert_eq!(first, second, "a descendant outlived the cancelled script");
    assert!(harness.script_root_is_empty());
}

#[tokio::test]
async fn cancellation_proof_maps_script_ends_like_native_turns() {
    for (end, expected) in [
        (Some(ScriptEnd::Stopped), Some(TurnOutcome::Interrupted)),
        (
            Some(ScriptEnd::Completed { succeeded: true }),
            Some(TurnOutcome::Succeeded),
        ),
        (
            Some(ScriptEnd::Completed { succeeded: false }),
            Some(TurnOutcome::Failed),
        ),
        (Some(ScriptEnd::Unobserved), None),
    ] {
        let (cancel, cancelled) = watch::channel(false);
        let (_ended, ended_receiver) = watch::channel(end);
        let script = ActiveScript {
            cancel: Arc::new(cancel),
            ended: ended_receiver,
        };
        assert_eq!(stop_script(&script).await, expected, "{end:?}");
        assert!(*cancelled.borrow(), "the tree is always asked to stop");
    }
    // A watcher that vanished without an end is no proof at all.
    let (cancel, _cancelled) = watch::channel(false);
    let (ended, ended_receiver) = watch::channel(None);
    drop(ended);
    let script = ActiveScript {
        cancel: Arc::new(cancel),
        ended: ended_receiver,
    };
    assert_eq!(stop_script(&script).await, None);
}

#[tokio::test]
async fn untrusted_projects_and_safe_mode_never_run_a_script() {
    let marker = "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'x');";
    for (name, trust, safe_mode) in [
        ("restricted", TrustState::Restricted, false),
        ("safe-mode", TrustState::Trusted, true),
    ] {
        let harness = Fixture::new(name, trust, safe_mode);
        harness.save(json!([helper(), script("collect", marker, 30, json!([]))]));
        harness.start("run");
        let result = harness.run_next_script("run", quiet()).await;
        assert!(result == Err("runtime-unavailable"), "{name}: {result:?}");
        assert!(!harness.project.join("ran.txt").exists(), "{name}");
        let run = harness.run("run");
        assert_eq!(task(&run, "collect").status(), TaskStatus::Ready, "{name}");
        assert_eq!(task(&run, "collect").execution(), None, "{name}");
    }
}

#[tokio::test]
async fn an_unreadable_native_dependency_fails_the_script_before_it_runs() {
    let harness = Fixture::new("input", TrustState::Trusted, false);
    let marker = "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'x');";
    harness.save(json!([
        {"id": "helper", "name": "Helper", "assignedMemberId": "helper", "instructions": "Plan.", "dependencyStepIds": []},
        script("collect", marker, 30, json!(["helper"]))
    ]));
    let run = harness.start("input");
    // The agent step completes with a reference to history this host does
    // not have; only its hash-verified text could feed the script.
    let capabilities = piui_orchestration::NativeBridgeCapabilities {
        permission_modes: vec![piui_orchestration::PermissionMode::ReadOnly],
        native_enforced_tools: Vec::new(),
        coordinator_enforced_tools: Vec::new(),
        agent_operations: piui_orchestration::AgentOperationCapabilities {
            roster: false,
            send: false,
            observe: false,
            spawn: false,
        },
    };
    let session = uuid::Uuid::new_v4().to_string();
    let lease = harness
        .api
        .lease_next_scheduled_task(
            &harness.workspace_id,
            "input",
            run.revision(),
            session.clone(),
            &capabilities,
        )
        .expect("leases")
        .expect("agent step");
    let launch = harness
        .api
        .commit_launch_lease(&harness.workspace_id, "input", &lease, session.clone())
        .expect("dispatches");
    harness
        .api
        .record_terminal_event(
            &harness.workspace_id,
            "input",
            launch.run_revision,
            "helper",
            launch.task_revision,
            &session,
            CompletionOutcome::Succeeded {
                result_reference: Some(NativeHistoryReference {
                    fields: Vec::new(),
                    session_id: uuid::Uuid::new_v4().to_string(),
                    block_id: Some("answer".into()),
                    content_hash: Some("ab".repeat(32)),
                }),
            },
            Some("Plan."),
        )
        .expect("records the native result");
    let result = harness.run_next_script("input", quiet()).await;
    assert!(result == Err("script-input-unavailable"), "{result:?}");
    let run = harness.run("input");
    assert_eq!(
        task(&run, "collect")
            .failure()
            .map(|failure| failure.code.as_str()),
        Some("script-input-unavailable")
    );
    assert_eq!(task(&run, "collect").execution(), None, "nothing started");
    assert_eq!(run.status(), RunStatus::Failed);
    assert!(!harness.project.join("ran.txt").exists());
}

#[test]
fn restart_makes_a_started_script_uncertain_and_never_resumes_it() {
    let root = std::env::temp_dir().join(format!("piui-script-restart-{}", uuid::Uuid::new_v4()));
    let app_data = root.join("app-data");
    let state = OrchestrationApiState::open(&app_data).expect("opens");
    let request: SaveGraphRequest = serde_json::from_value(json!({
        "workspaceId": "workspace",
        "profiles": [{"workspaceId": "workspace", "value": {
            "id": "helper-profile", "name": "Helper", "harness": "codex", "model": "model",
            "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []},
            "allowedSpawnProfileIds": []}}],
        "team": {"workspaceId": "workspace", "value": {"id": "team", "name": "Scripts",
            "members": [{"id": "helper", "profileId": "helper-profile"}],
            "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "helper"}},
        "pipeline": {"workspaceId": "workspace", "value": {"id": "pipeline", "name": "Scripts",
            "steps": [helper(), script("collect", COLLECT, 30, json!([]))]}},
        "command": {"workspaceId": "workspace", "value": {"id": "command", "name": "Scripts",
            "teamId": "team", "pipelineId": "pipeline"}}
    }))
    .expect("graph");
    save_graph(&state, request).expect("saves");
    let run = state
        .create_run(StartRunRequest {
            workspace_id: "workspace".into(),
            run_id: "run".into(),
            team_id: "team".into(),
            pipeline_id: "pipeline".into(),
            launch_command_id: None,
            inputs: BTreeMap::new(),
        })
        .expect("run");
    let lease = state
        .lease_next_script("workspace", "run", run.revision(), "lease".into())
        .expect("leases")
        .expect("script");
    state
        .commit_script_lease("workspace", &lease, "execution".into())
        .expect("marks the script running");
    // A folder of a possibly running script (of any host instance) stays.
    let fresh = state.script_work_root().join("fresh-execution");
    std::fs::create_dir_all(&fresh).expect("folder");
    drop(state);

    let reopened = OrchestrationApiState::open(&app_data).expect("reopens");
    let run = reopened
        .get_run("workspace", "run")
        .expect("reads")
        .expect("run");
    assert_eq!(run.status(), RunStatus::Uncertain);
    assert_eq!(task(&run, "collect").status(), TaskStatus::Uncertain);
    assert!(
        reopened.recoverable_runs().expect("recoverable").is_empty(),
        "a script that may have run is never resumed"
    );
    assert!(fresh.exists());
    drop(reopened);
    let _ = std::fs::remove_dir_all(root);
}

fn read_only(harness: Harness) -> AgentProfile {
    let mut profile = AgentProfile {
        when_to_call: None,
        input_instructions: None,
        expected_result: None,
        id: "caller".into(),
        name: "Caller".into(),
        harness,
        model_provider: Some("provider".into()),
        model: "model".into(),
        permission_mode: piui_orchestration::PermissionMode::ReadOnly,
        network_access: false,
        base_instructions: None,
        service_tier: None,
        resource_rules: vec![],
        reasoning: None,
        instructions: "Be brief".into(),
        tool_policy: piui_orchestration::DeclaredToolPolicy { rules: vec![] },
        allowed_spawn_profile_ids: vec![],
    };
    profile.tool_policy.rules = vec![piui_orchestration::ToolRule {
        tool: "bash".into(),
        decision: piui_orchestration::ToolDecision::Deny,
        enforcement: piui_orchestration::PolicyEnforcement::Native,
        mandatory: true,
    }];
    if harness != Harness::Pi {
        profile.tool_policy.rules.clear();
    }
    profile
}

fn capabilities(tool_policy: bool) -> crate::workspace_api::HarnessCapabilities {
    let capability = |supported: bool| piui_runtime::workspace_runtime::Capability {
        supported,
        enforcement: if supported {
            piui_runtime::workspace_runtime::Enforcement::Native
        } else {
            piui_runtime::workspace_runtime::Enforcement::Unsupported
        },
        reason: None,
    };
    crate::workspace_api::HarnessCapabilities {
        prompt: capability(true),
        resume: capability(true),
        models: capability(true),
        approvals: capability(true),
        instructions: capability(true),
        tool_policy: capability(tool_policy),
        native_subagents: capability(true),
    }
}

#[test]
fn llm_steps_launch_one_turn_without_tools_where_the_adapter_enforces_it() {
    // Pi enforces an empty allowlist natively (`--no-tools --no-extensions`).
    let pi = read_only(Harness::Pi);
    let (_, policy) = one_shot_launch_policy(&pi, &capabilities(true)).expect("Pi llm policy");
    assert_eq!(policy.allowed_tools, Some(Vec::new()));
    assert!(!policy.coordinator, "an llm step gets no coordinator tool");
    assert_eq!(policy.native_subagents, Some(false));
    let lease = ControlledSpawnLease {
        run_id: "run".into(),
        run_revision: 1,
        task_revision: 1,
        lease_id: "lease".into(),
        step_id: "summary".into(),
        member_id: "caller".into(),
        profile: pi,
        task_instructions: "Summarize".into(),
        dependency_result_references: vec![],
        dependency_outputs: vec![piui_orchestration::DependencyOutput {
            step_id: "metrics".into(),
            fields: vec![],
            text: Some("3 files".into()),
            data: None,
        }],
    };
    let request = workspace_launch_request("workspace", "session", &lease, policy, None);
    assert_eq!(request.permission_mode, WorkspacePermissionMode::ReadOnly);
    assert_eq!(request.allowed_tools, Some(Vec::new()));
    assert_eq!(request.native_subagents, Some(false));
    assert!(request.coordinator.is_none());
    assert!(!request.network_access);
    assert_eq!(request.dependency_outputs, lease.dependency_outputs);

    // Codex has no restrictive tool contract: the read-only sandbox is the
    // only boundary, so no allowlist is claimed.
    let codex = read_only(Harness::Codex);
    let (_, policy) =
        one_shot_launch_policy(&codex, &capabilities(false)).expect("Codex llm policy");
    assert_eq!(policy.allowed_tools, None);
    assert!(!policy.coordinator);
    assert_eq!(policy.native_subagents, Some(false));

    // Harnesses without a read-only mode refuse before anything starts.
    for harness in [Harness::PrimeAgent, Harness::Hermes] {
        let mut profile = read_only(harness);
        profile.permission_mode = piui_orchestration::PermissionMode::Native;
        assert_eq!(
            one_shot_launch_policy(&profile, &capabilities(true))
                .err()
                .map(|error| error.code),
            Some("llm-read-only-unsupported"),
            "{harness:?}"
        );
    }
    // A stored profile that lost least authority is refused, not widened.
    let mut writer = read_only(Harness::Codex);
    writer.permission_mode = piui_orchestration::PermissionMode::WorkspaceWrite;
    let mut networked = read_only(Harness::Codex);
    networked.network_access = true;
    let mut spawning = read_only(Harness::Codex);
    spawning.allowed_spawn_profile_ids = vec!["other".into()];
    for profile in [writer, networked, spawning] {
        assert_eq!(
            one_shot_launch_policy(&profile, &capabilities(false))
                .err()
                .map(|error| error.code),
            Some("unsupported-policy")
        );
    }
}
