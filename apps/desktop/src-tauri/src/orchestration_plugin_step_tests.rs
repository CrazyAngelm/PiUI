//! Plugin node steps through the host scheduling path (orchestration v6.5).
//!
//! The example `pipeline-pack` plugin is installed through the plugin host
//! and its real backend runs under Node with process containment; steps are
//! admitted, prepared, executed and recorded by the functions `schedule_run`,
//! `launch_plugin_step` and `watch_plugin_step` use (only the Tauri event
//! glue is left out, as in the script tests). No model or harness starts.

use super::*;
use crate::orchestration_api::{
    OrchestrationApiState, SaveGraphRequest, StartRunRequest, save_graph,
};
use crate::plugins::{PluginsState, ReviewSource};
use piui_index::TrustState;
use piui_platform::ProjectDirectory;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;

const PIUI: &str = "0.1.1";

struct Fixture {
    root: PathBuf,
    workspace_id: String,
    host: HostState,
    api: OrchestrationApiState,
    plugins: PluginsState,
}

fn example(name: &str) -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../examples/plugins")
        .join(name)
}

impl Fixture {
    fn new(name: &str, safe_mode: bool) -> Self {
        let root =
            std::env::temp_dir().join(format!("piui-plugin-steps-{name}-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        std::fs::create_dir_all(&project).expect("project folder");
        let app_data = root.join("app-data");
        let host = HostState::open(&app_data, safe_mode).expect("host state");
        let directory = ProjectDirectory::resolve(&project).expect("project directory");
        let workspace_id = host
            .index
            .lock()
            .expect("index")
            .register_project_directory(&directory, Some("Plugins"), TrustState::Trusted)
            .expect("registers the project")
            .id;
        let api = OrchestrationApiState::open(&app_data).expect("orchestration state");
        let plugins = PluginsState::open(&app_data, safe_mode, PIUI).expect("plugin host");
        Self {
            root,
            workspace_id,
            host,
            api,
            plugins,
        }
    }

    /// Installs the example pipeline pack exactly as a person would after
    /// the trust review.
    fn install_pack(&self) {
        let (staging_id, staged) = self
            .plugins
            .stage(ReviewSource::Folder, &example("pipeline-pack"))
            .expect("stages the example");
        self.plugins
            .install(
                self.plugins.revision(),
                &staging_id,
                &staged.package.code_hash,
            )
            .expect("installs the example");
    }

    fn save(&self, steps: Value) {
        let workspace = self.workspace_id.as_str();
        let request: SaveGraphRequest = serde_json::from_value(json!({
            "workspaceId": workspace,
            "profiles": [{"workspaceId": workspace, "value": {
                "id": "helper-profile", "name": "Helper", "harness": "codex", "model": "model",
                "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []},
                "allowedSpawnProfileIds": []}}],
            "team": {"workspaceId": workspace, "value": {"id": "team", "name": "Plugins",
                "members": [{"id": "helper", "profileId": "helper-profile"}],
                "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "helper"}},
            "pipeline": {"workspaceId": workspace, "value": {"id": "pipeline", "name": "Plugins",
                "inputs": [{"name": "task", "label": "Task", "kind": "text"}],
                "steps": steps}},
            "command": {"workspaceId": workspace, "value": {"id": "command", "name": "Plugins",
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
                use_pinned_data: false,
            })
            .expect("creates the run")
    }

    fn run(&self, run_id: &str) -> Run {
        self.api
            .get_run(&self.workspace_id, run_id)
            .expect("reads")
            .expect("run exists")
    }

    /// One scheduling pass for the next ready plugin step.
    async fn pass(&self, run_id: &str) -> Result<&'static str, &'static str> {
        let directory =
            authorize_live_workspace(&self.host, &self.workspace_id).map_err(|error| error.code)?;
        let run = self
            .api
            .advance_automatic_steps(&self.workspace_id, run_id)
            .map_err(|_| "conflict")?;
        let step = next_ready_step(&run).ok_or("conflict")?;
        let task_revision = task(&run, &step.id).revision();
        let (lease, spec, config) = match admit_plugin_step(
            Some(&self.plugins),
            &self.api,
            &self.workspace_id,
            &run,
            &step,
            task_revision,
            uuid::Uuid::new_v4().to_string(),
        ) {
            PluginAdmission::Leased {
                lease,
                spec,
                config,
                ..
            } => (*lease, *spec, config),
            PluginAdmission::Rejected { error, .. } => return Err(error.code),
            PluginAdmission::Idle => return Err("idle"),
        };
        let (launch, running) = prepare_plugin_step(
            &self.host,
            &self.api,
            &self.workspace_id,
            &directory,
            lease,
            spec,
            config,
            uuid::Uuid::new_v4().to_string(),
        )
        .await
        .map_err(|(_, error)| error.code)?;
        assert_eq!(
            task(&running, &launch.step_id).status(),
            TaskStatus::Running,
            "the task runs before node/run is sent"
        );
        let (_cancel, receiver) = watch::channel(false);
        match execute_plugin_step(Some(&self.plugins), &launch, receiver).await {
            ScriptResolution::Record(completion) => {
                self.api
                    .record_script_outcome(
                        &self.workspace_id,
                        run_id,
                        &launch.step_id,
                        &launch.execution_id,
                        completion,
                    )
                    .map_err(|_| "conflict")?;
                Ok("recorded")
            }
            ScriptResolution::Stopped => Ok("stopped"),
            ScriptResolution::Unobserved => Ok("unobserved"),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.plugins.begin_shutdown();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn task<'a>(run: &'a Run, step_id: &str) -> &'a piui_orchestration::TaskRecord {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .expect("task exists")
}

fn helper() -> Value {
    json!({"id": "helper", "name": "Helper", "assignedMemberId": "helper",
        "instructions": "Only when called.", "executionMode": "callable", "dependencyStepIds": []})
}

fn transform(id: &str, config: Value, dependencies: Value, fields: Value) -> Value {
    json!({"id": id, "name": id, "assignedMemberId": id, "instructions": "",
        "executor": {"type": "plugin", "pluginId": "example.pipeline-pack", "nodeType": "json-transform", "config": config},
        "resultFields": fields, "dependencyStepIds": dependencies})
}

#[tokio::test]
async fn a_plugin_node_runs_in_its_backend_and_feeds_the_next_step() {
    let fixture = Fixture::new("happy", false);
    fixture.install_pack();
    fixture.save(json!([
        helper(),
        transform(
            "read",
            json!({"source": "inputs", "wrap": "request"}),
            json!([]),
            json!([])
        ),
        transform(
            "pick",
            json!({"pick": "request"}),
            json!(["read"]),
            json!([])
        ),
    ]));
    fixture.start("run");
    assert_eq!(fixture.pass("run").await, Ok("recorded"));
    let run = fixture.run("run");
    let read = task(&run, "read");
    assert_eq!(read.status(), TaskStatus::Succeeded, "{:?}", read.failure());
    assert_eq!(
        read.result_data(),
        Some(&json!({"request": {"task": "demo"}}))
    );
    assert_eq!(fixture.pass("run").await, Ok("recorded"));
    let run = fixture.run("run");
    assert_eq!(
        task(&run, "pick").result_data(),
        Some(&json!({"request": {"task": "demo"}})),
        "a host dependency arrives as data"
    );
}

#[tokio::test]
async fn a_node_error_is_a_certain_failure_with_the_plugin_message() {
    let fixture = Fixture::new("error", false);
    fixture.install_pack();
    fixture.save(json!([
        helper(),
        transform("bad", json!({"rename": "not a pair"}), json!([]), json!([])),
    ]));
    fixture.start("run");
    assert_eq!(fixture.pass("run").await, Ok("recorded"));
    let run = fixture.run("run");
    let failure = task(&run, "bad").failure().expect("failed");
    assert_eq!(failure.code, PLUGIN_NODE_FAILED);
    assert!(
        failure
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("old=new"))
    );
}

#[tokio::test]
async fn declared_result_fields_are_checked_like_script_output() {
    let fixture = Fixture::new("fields", false);
    fixture.install_pack();
    fixture.save(json!([
        helper(),
        transform(
            "checked",
            json!({"source": "inputs"}),
            json!([]),
            json!([{"name": "missing", "kind": "text"}])
        ),
    ]));
    fixture.start("run");
    assert_eq!(fixture.pass("run").await, Ok("recorded"));
    let run = fixture.run("run");
    assert_eq!(
        task(&run, "checked")
            .failure()
            .map(|failure| failure.code.as_str()),
        Some("result-missing-field")
    );
}

#[tokio::test]
async fn a_missing_disabled_or_misconfigured_plugin_fails_before_anything_runs() {
    let fixture = Fixture::new("unavailable", false);
    fixture.save(json!([
        helper(),
        transform("orphan", json!({}), json!([]), json!([])),
    ]));
    fixture.start("missing");
    assert_eq!(fixture.pass("missing").await, Err(PLUGIN_UNAVAILABLE));
    assert_eq!(
        task(&fixture.run("missing"), "orphan")
            .failure()
            .map(|failure| failure.code.as_str()),
        Some(PLUGIN_UNAVAILABLE)
    );

    fixture.install_pack();
    fixture
        .plugins
        .set_enabled(fixture.plugins.revision(), "example.pipeline-pack", false)
        .expect("disables");
    fixture.start("disabled");
    assert_eq!(fixture.pass("disabled").await, Err(PLUGIN_UNAVAILABLE));

    let misconfigured = Fixture::new("config", false);
    misconfigured.install_pack();
    misconfigured.save(json!([
        helper(),
        transform("orphan", json!({"unknown": 1}), json!([]), json!([])),
    ]));
    misconfigured.start("config");
    assert_eq!(
        misconfigured.pass("config").await,
        Err(PLUGIN_CONFIG_INVALID)
    );
    assert_eq!(
        task(&misconfigured.run("config"), "orphan")
            .failure()
            .map(|failure| failure.code.as_str()),
        Some(PLUGIN_CONFIG_INVALID)
    );
}

#[tokio::test]
async fn safe_mode_runs_no_plugin_node() {
    let fixture = Fixture::new("safe", true);
    assert!(
        fixture
            .plugins
            .node_spec("example.pipeline-pack", "json-transform")
            .is_none()
    );
}

#[tokio::test]
async fn resolutions_map_every_backend_outcome() {
    let project = std::env::temp_dir();
    let resolve = |result| plugin_resolution(&project, &[], result);
    assert!(matches!(
        resolve(Ok(json!({"output": "plain text"}))).await,
        ScriptResolution::Record(ScriptCompletion::Exited { stdout, truncated: false }) if stdout == "plain text"
    ));
    assert!(matches!(
        resolve(Ok(json!({"output": {"a": 1}}))).await,
        ScriptResolution::Record(ScriptCompletion::Exited { stdout, .. }) if stdout == r#"{"a":1}"#
    ));
    assert!(matches!(
        resolve(Ok(json!({"answer": 1}))).await,
        ScriptResolution::Record(ScriptCompletion::Failed { failure }) if failure.code == PLUGIN_NODE_FAILED
    ));
    assert!(matches!(
        resolve(Err(CallError::Timeout)).await,
        ScriptResolution::Record(ScriptCompletion::Failed { failure }) if failure.code == PLUGIN_NODE_TIMEOUT
    ));
    assert!(matches!(
        resolve(Err(CallError::NotStarted(crate::plugins::StartFailure::NodeMissing))).await,
        ScriptResolution::Record(ScriptCompletion::Failed { failure }) if failure.code == PLUGIN_START_FAILED
    ));
    assert!(matches!(
        resolve(Err(CallError::Cancelled)).await,
        ScriptResolution::Stopped
    ));
    assert!(matches!(
        resolve(Err(CallError::Lost)).await,
        ScriptResolution::Unobserved
    ));
}
