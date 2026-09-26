//! Managed Claude Code steps whose native login is refused (ADR-029).
//!
//! The launch runs through the real workspace host with a test runtime
//! spawner in place of the installed `claude` executable: the refusal is the
//! same typed bridge failure a signed-out CLI produces at its `initialize`
//! handshake, before PiUI writes any task text. No model turn, provider or
//! native harness is started.

use super::*;
use crate::orchestration_api::{
    FlowControlRequest, OrchestrationApiState, StartRunRequest, save_graph,
};
use crate::workspace_api::{WorkspaceError, WorkspaceRuntimeHandle};
use piui_index::TrustState;
use piui_orchestration::{RunStatus, TaskRecord};
use piui_platform::ProjectDirectory;
use piui_runtime::workspace_runtime::{
    BridgeFailureCode, Capability, NativeRuntime, NativeRuntimeConfig, NativeRuntimeError,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// A signed-in Claude Code for the retry: answers snapshots, admits prompts.
const SIGNED_IN_ADAPTER: &str = r#"
    const native = {supported:true,enforcement:'native'};
    return {
      snapshot() {
        return {nativeId:'00000000-0000-4000-8000-000000000001',materialized:false,title:config.title ?? 'Writer',
          status:'idle',blocks:[],approvals:[],models:[],
          capabilities:{prompt:native,resume:native,models:native,approvals:native,instructions:native,toolPolicy:native,nativeSubagents:native}};
      },
      prompt() { return {accepted:true}; },
      interrupt() { return null; },
      dispose() { return null; },
    };
"#;

struct Fixture {
    root: PathBuf,
    workspace_id: String,
    host: HostState,
    api: OrchestrationApiState,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piui-orchestration-sign-in-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        std::fs::create_dir_all(&project).expect("project folder");
        let app_data = root.join("app-data");
        let host = HostState::open(&app_data, false).expect("host state");
        let directory = ProjectDirectory::resolve(&project).expect("project directory");
        let workspace_id = host
            .index
            .lock()
            .expect("index")
            .register_project_directory(&directory, Some("Sign-in"), TrustState::Trusted)
            .expect("registers the project")
            .id;
        let api = OrchestrationApiState::open(&app_data).expect("orchestration state");
        let fixture = Self {
            root,
            workspace_id,
            host,
            api,
        };
        fixture.save();
        fixture
    }

    /// Writer -> Reviewer, both on Claude Code.
    fn save(&self) {
        let workspace = self.workspace_id.as_str();
        let request = serde_json::from_value(json!({
            "workspaceId": workspace,
            "profiles": [{"workspaceId": workspace, "value": {
                "id": "writer-profile", "name": "Writer", "harness": "claude-code", "model": "sonnet",
                "modelProvider": "anthropic", "permissionMode": "read-only", "instructions": "",
                "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}}],
            "team": {"workspaceId": workspace, "value": {"id": "team", "name": "Writers",
                "members": [{"id": "writer", "profileId": "writer-profile"}, {"id": "reviewer", "profileId": "writer-profile"}],
                "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "writer"}},
            "pipeline": {"workspaceId": workspace, "value": {"id": "pipeline", "name": "Writers", "steps": [
                {"id": "write", "name": "Write", "assignedMemberId": "writer", "instructions": "Write it.", "dependencyStepIds": []},
                {"id": "review", "name": "Review", "assignedMemberId": "reviewer", "instructions": "Review it.", "dependencyStepIds": ["write"]}
            ]}},
            "command": {"workspaceId": workspace, "value": {"id": "command", "name": "Writers",
                "teamId": "team", "pipelineId": "pipeline"}}
        }))
        .expect("graph request");
        save_graph(&self.api, request).expect("saves the graph");
        self.api
            .create_run(StartRunRequest {
                workspace_id: self.workspace_id.clone(),
                run_id: "run".into(),
                team_id: "team".into(),
                pipeline_id: "pipeline".into(),
                launch_command_id: Some("command".into()),
                inputs: BTreeMap::new(),
            })
            .expect("creates the run");
    }

    fn run(&self) -> Run {
        self.api
            .get_run(&self.workspace_id, "run")
            .expect("reads")
            .expect("run exists")
    }

    /// The admission `schedule_run` performs: the next ready step, its
    /// adapter launch policy and a durable lease.
    fn admit(&self) -> (ControlledSpawnLease, LaunchPolicy, String) {
        let run = self
            .api
            .advance_automatic_steps(&self.workspace_id, "run")
            .expect("advances");
        let step = next_ready_step(&run).expect("a ready step");
        let profile = profile_for_step(&run, &step).expect("profile");
        let (capabilities, policy) =
            launch_policy(&profile, &verified_capabilities()).expect("launch policy");
        let session_id = self.host.workspace.allocate_orchestration_session_id();
        let lease = self
            .api
            .lease_next_scheduled_task(
                &self.workspace_id,
                "run",
                run.revision(),
                session_id.clone(),
                &capabilities,
            )
            .expect("leases")
            .expect("a lease");
        (lease, policy, session_id)
    }

    async fn launch(
        &self,
        lease: &ControlledSpawnLease,
        policy: LaunchPolicy,
        session_id: &str,
    ) -> Result<WorkspaceRuntimeHandle, WorkspaceError> {
        let directory = authorize_live_workspace(&self.host, &self.workspace_id)
            .expect("trusted live workspace");
        let request = workspace_launch_request(&self.workspace_id, session_id, lease, policy, None);
        let publisher: crate::workspace_api::WorkspaceEventPublisher = Arc::new(|_| {});
        self.host
            .workspace
            .launch_for_orchestration(&directory, request, publisher)
            .await
    }

    fn refuse_sign_in(&self) {
        self.host
            .workspace
            .replace_native_spawner(|config: NativeRuntimeConfig| async move {
                assert_eq!(config.harness, HarnessKind::ClaudeCode);
                Err(NativeRuntimeError::Bridge(
                    BridgeFailureCode::SubscriptionRequired,
                ))
            });
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn verified_capabilities() -> crate::workspace_api::HarnessCapabilities {
    let native = Capability {
        supported: true,
        enforcement: Enforcement::Native,
        reason: None,
    };
    crate::workspace_api::HarnessCapabilities {
        prompt: native.clone(),
        resume: native.clone(),
        models: native.clone(),
        approvals: native.clone(),
        instructions: native.clone(),
        tool_policy: native.clone(),
        native_subagents: Capability {
            supported: true,
            enforcement: Enforcement::Coordinator,
            reason: None,
        },
    }
}

fn task<'a>(run: &'a Run, step_id: &str) -> &'a TaskRecord {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .expect("task")
}

#[test]
fn only_a_refused_login_is_a_certain_launch_refusal() {
    assert_eq!(
        certain_launch_refusal(&WorkspaceError::subscription_required()),
        Some(HARNESS_SIGN_IN_REQUIRED)
    );
    // Any other start failure may have run something: it stays uncertain.
    for code in ["RUNTIME_FAILED", "CONFLICT", "IO_ERROR", "NOT_SUPPORTED"] {
        let error = WorkspaceError {
            code,
            message: "fixture",
            recoverable: true,
        };
        assert_eq!(certain_launch_refusal(&error), None, "{code}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_claude_code_login_fails_the_step_before_execution_and_it_runs_again_after_sign_in()
 {
    let fixture = Fixture::new("scheduled");
    fixture.refuse_sign_in();
    let (lease, policy, session_id) = fixture.admit();
    assert_eq!(lease.step_id, "write");
    let error = fixture
        .launch(&lease, policy, &session_id)
        .await
        .err()
        .expect("a signed-out Claude Code never starts");
    let code = certain_launch_refusal(&error).expect("a certain refusal");
    let run = record_launch_refusal(
        &fixture.api,
        &fixture.workspace_id,
        &lease,
        LaunchOrigin::Scheduled,
        code,
    )
    .expect("records the refusal");
    let write = task(&run, "write");
    assert_eq!(write.status(), TaskStatus::Failed);
    assert_eq!(
        write.failure().map(|failure| failure.code.as_str()),
        Some(HARNESS_SIGN_IN_REQUIRED)
    );
    assert!(write.execution().is_none(), "nothing was started");
    assert_eq!(task(&run, "review").status(), TaskStatus::Cancelled);
    assert_eq!(run.status(), RunStatus::Failed, "failed, not uncertain");
    assert_eq!(
        fixture
            .host
            .workspace
            .usage(&session_id, &fixture.workspace_id)
            .err()
            .map(|error| error.code),
        Some("NOT_FOUND"),
        "a refused start leaves no session row"
    );

    // The user signs in; "Run again from here" admits and starts the step.
    let repeat: FlowControlRequest = serde_json::from_value(json!({
        "workspaceId": fixture.workspace_id, "runId": "run", "expectedRunRevision": run.revision(),
        "action": {"type": "repeat", "stepId": "write", "taskRevision": write.revision()}
    }))
    .expect("repeat request");
    let repeated = fixture.api.control_flow(repeat).expect("repeats");
    assert_eq!(repeated.status(), RunStatus::Running);
    assert_eq!(task(&repeated, "write").status(), TaskStatus::Ready);
    fixture
        .host
        .workspace
        .replace_native_spawner(|config: NativeRuntimeConfig| {
            NativeRuntime::spawn_test_adapter(config, SIGNED_IN_ADAPTER)
        });
    let (lease, policy, session_id) = fixture.admit();
    assert_eq!(lease.step_id, "write");
    let handle = fixture
        .launch(&lease, policy, &session_id)
        .await
        .expect("a signed-in Claude Code starts");
    let launched = fixture
        .api
        .commit_launch_lease(&fixture.workspace_id, "run", &lease, session_id.clone())
        .expect("commits the launch");
    assert_eq!(launched.step_id, "write");
    let run = fixture.run();
    assert_eq!(task(&run, "write").status(), TaskStatus::Running);
    assert_eq!(run.attempts().len(), 0, "the refused attempt never ran");
    let _ = handle.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_login_of_a_spawned_step_returns_it_to_its_caller() {
    let fixture = Fixture::new("spawned");
    fixture.refuse_sign_in();
    let (lease, policy, session_id) = fixture.admit();
    let error = fixture
        .launch(&lease, policy, &session_id)
        .await
        .err()
        .expect("refused");
    let code = certain_launch_refusal(&error).expect("a certain refusal");
    let run = record_launch_refusal(
        &fixture.api,
        &fixture.workspace_id,
        &lease,
        LaunchOrigin::Spawned,
        code,
    )
    .expect("releases the lease");
    let write = task(&run, "write");
    assert_eq!(write.status(), TaskStatus::Ready);
    assert!(write.lease_id().is_none() && write.failure().is_none());
    assert_eq!(run.status(), RunStatus::Running);
}
