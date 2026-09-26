//! Run debugging v1 through the host functions the Tauri commands call:
//! outputs, pinning, runs with pinned data, archive and delete. Scripts are
//! driven through the journal with synthetic outcomes; no process, native
//! harness or model is started.

use super::*;
use crate::orchestration_api::{
    RunSummary, SaveGraphRequest, StartRunRequest, WorkspaceRequest, orchestration_list_runs,
    save_graph,
};
use piui_index::TrustState;
use piui_orchestration::{Coordinator, ScriptCompletion};
use piui_platform::ProjectDirectory;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;

const NOW: &str = "2026-09-27T10:00:00Z";

struct Fixture {
    root: PathBuf,
    app_data: PathBuf,
    workspace_id: String,
    host: HostState,
    api: OrchestrationApiState,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Fixture {
    fn new(name: &str, safe_mode: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piui-run-debugging-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).expect("project folder");
        let app_data = root.join("app-data");
        let host = HostState::open(&app_data, safe_mode).expect("host state");
        let directory = ProjectDirectory::resolve(&project).expect("project directory");
        let workspace_id = host
            .index
            .lock()
            .expect("index")
            .register_project_directory(&directory, Some("Debugging"), TrustState::Trusted)
            .expect("registers the project")
            .id;
        let api = OrchestrationApiState::open(&app_data).expect("orchestration state");
        let fixture = Self {
            root,
            app_data,
            workspace_id,
            host,
            api,
        };
        fixture.save();
        fixture
    }

    /// script `collect` → agent `report` → reviewing agent `check`.
    fn save(&self) {
        let workspace = self.workspace_id.as_str();
        let request: SaveGraphRequest = serde_json::from_value(json!({
            "workspaceId": workspace,
            "profiles": [{"workspaceId": workspace, "value": {
                "id": "helper-profile", "name": "Helper", "harness": "codex", "model": "model",
                "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []},
                "allowedSpawnProfileIds": []}}],
            "team": {"workspaceId": workspace, "value": {"id": "team", "name": "Debugging",
                "members": [{"id": "helper", "profileId": "helper-profile"}, {"id": "checker", "profileId": "helper-profile"}],
                "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "helper"}},
            "pipeline": {"workspaceId": workspace, "value": {"id": "pipeline", "name": "Debugging", "steps": [
                {"id": "collect", "name": "Collect", "assignedMemberId": "collect", "instructions": "",
                 "executor": {"type": "script", "runtime": "node", "source": "console.log('{}')", "timeoutSeconds": 30},
                 "dependencyStepIds": []},
                {"id": "report", "name": "Report", "assignedMemberId": "helper", "instructions": "Report.",
                 "dependencyStepIds": ["collect"]},
                {"id": "check", "name": "Check", "assignedMemberId": "checker", "instructions": "Check.",
                 "review": {"field": "approved", "retryFromStepId": "report"},
                 "resultFields": [{"name": "approved", "kind": "boolean"}],
                 "dependencyStepIds": ["report"]}
            ]}},
            "command": {"workspaceId": workspace, "value": {"id": "command", "name": "Debugging",
                "teamId": "team", "pipelineId": "pipeline"}}
        }))
        .expect("graph request");
        save_graph(&self.api, request).expect("saves the graph");
    }

    fn start(&self, run_id: &str, use_pinned_data: bool) -> Result<Run, &'static str> {
        self.api
            .create_run(StartRunRequest {
                workspace_id: self.workspace_id.clone(),
                run_id: run_id.into(),
                team_id: "team".into(),
                pipeline_id: "pipeline".into(),
                launch_command_id: Some("command".into()),
                inputs: BTreeMap::new(),
                use_pinned_data,
            })
            .map_err(|error| error.code)
    }

    fn run(&self, run_id: &str) -> Run {
        self.api
            .get_run(&self.workspace_id, run_id)
            .expect("reads")
            .expect("run exists")
    }

    /// Records `collect` as a script that printed `{"files": 2}` under `execution`.
    fn finish_collect(&self, run_id: &str, execution: &str) {
        let run = self.run(run_id);
        let lease = self
            .api
            .lease_next_script(
                &self.workspace_id,
                run_id,
                run.revision(),
                format!("lease-{execution}"),
            )
            .expect("leases")
            .expect("the script is ready");
        self.api
            .commit_script_lease(&self.workspace_id, &lease, execution.into())
            .expect("commits");
        self.api
            .record_script_outcome(
                &self.workspace_id,
                run_id,
                "collect",
                execution,
                ScriptCompletion::Exited {
                    stdout: "{\"files\": 2}\n".into(),
                    truncated: false,
                },
            )
            .expect("records");
    }

    fn cancel(&self, run_id: &str) {
        let revision = self.run(run_id).revision();
        self.api
            .commit_cancel_after_native_stop(&self.workspace_id, run_id, revision, None)
            .expect("cancels");
    }

    fn pipeline(&self) -> (u64, piui_orchestration::PipelineDefinition) {
        let snapshot = self.api.store().snapshot().expect("snapshot");
        let stored = snapshot
            .workspace(&self.workspace_id)
            .and_then(|workspace| {
                workspace
                    .pipelines
                    .iter()
                    .find(|stored| stored.value.id == "pipeline")
            })
            .expect("pipeline")
            .clone();
        (stored.revision, stored.value)
    }

    fn pin(&self, run_id: &str, step_id: &str, revision: u64) -> PinStepOutputRequestV1 {
        PinStepOutputRequestV1 {
            workspace_id: self.workspace_id.clone(),
            run_id: run_id.into(),
            step_id: step_id.into(),
            pipeline_id: "pipeline".into(),
            expected_revision: revision,
        }
    }

    fn archive(&self, run_id: &str, archived: bool) -> Result<bool, RunDebuggingError> {
        set_run_archived(
            &self.api,
            &self.host,
            SetRunArchivedRequestV1 {
                workspace_id: self.workspace_id.clone(),
                run_id: run_id.into(),
                archived,
            },
        )
        .map(|result| result.archived)
    }

    async fn delete(&self, run_id: &str, revision: u64) -> Result<(), RunDebuggingError> {
        delete_run(
            &self.api,
            &self.host,
            DeleteRunRequestV1 {
                workspace_id: self.workspace_id.clone(),
                run_id: run_id.into(),
                expected_run_revision: revision,
            },
        )
        .await
        .map(|_| ())
    }

    fn summaries(&self) -> Vec<RunSummary> {
        orchestration_list_runs(
            &self.api,
            &self.host,
            &WorkspaceRequest {
                workspace_id: self.workspace_id.clone(),
            },
        )
        .expect("lists runs")
    }
}

fn now() -> DateTime<Utc> {
    NOW.parse().expect("time")
}

fn task<'a>(run: &'a Run, step_id: &str) -> &'a TaskRecord {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .expect("task")
}

#[tokio::test]
async fn outputs_and_pins_copy_the_recorded_result_into_the_saved_pipeline() {
    let fixture = Fixture::new("pin", false);
    fixture.start("run-1", false).expect("starts");
    fixture.finish_collect("run-1", "exec-1");
    let outputs = run_outputs(
        &fixture.api,
        &fixture.host,
        RunOutputsRequestV1 {
            workspace_id: fixture.workspace_id.clone(),
            run_id: "run-1".into(),
        },
    )
    .await
    .expect("reads outputs");
    assert_eq!(
        serde_json::to_value(&outputs).expect("json"),
        json!({"protocol": 1, "runId": "run-1", "outputs": [{"stepId": "collect", "data": {"files": 2}}]})
    );

    let pinned = pin_step_output(
        &fixture.api,
        &fixture.host,
        fixture.pin("run-1", "collect", 0),
        now(),
    )
    .await
    .expect("pins");
    assert_eq!(pinned.revision, 1);
    let expected = PinnedOutput {
        text: None,
        truncated: false,
        data: Some(json!({"files": 2})),
        pinned_at: NOW.into(),
        source_run_id: Some("run-1".into()),
    };
    assert_eq!(pinned.pinned_output, expected);
    let (revision, pipeline) = fixture.pipeline();
    assert_eq!(revision, 1);
    assert_eq!(pipeline.steps[0].pinned_output.as_ref(), Some(&expected));
    // Everything else in the saved pipeline is unchanged.
    assert!(
        pipeline.steps[1..]
            .iter()
            .all(|step| step.pinned_output.is_none())
    );
    assert_eq!(pipeline.steps.len(), 3);

    for (request, refusal) in [
        (
            fixture.pin("run-1", "collect", 0),
            RunDebuggingError::Conflict,
        ),
        (
            fixture.pin("run-1", "report", 1),
            RunDebuggingError::StepNotSucceeded,
        ),
        (
            fixture.pin("run-1", "missing", 1),
            RunDebuggingError::NotFound,
        ),
        (
            fixture.pin("run-9", "collect", 1),
            RunDebuggingError::NotFound,
        ),
        (
            PinStepOutputRequestV1 {
                step_id: " ".into(),
                ..fixture.pin("run-1", "collect", 1)
            },
            RunDebuggingError::Invalid,
        ),
    ] {
        assert_eq!(
            pin_step_output(&fixture.api, &fixture.host, request, now())
                .await
                .err(),
            Some(refusal)
        );
    }
    assert_eq!(fixture.pipeline().0, 1, "refusals change nothing");

    // A reviewing step never holds pinned data.
    fixture
        .api
        .store()
        .transact(|workspaces| {
            let stored = workspaces[0]
                .pipelines
                .iter_mut()
                .find(|stored| stored.value.id == "pipeline")
                .ok_or(StoreError::NotFound)?;
            stored.value.steps[0].review = Some(piui_orchestration::ReviewRule {
                field: "approved".into(),
                retry_from_step_id: "report".into(),
                max_iterations: None,
            });
            stored.value.steps[0].pinned_output = None;
            Ok(())
        })
        .expect("test edit");
    assert_eq!(
        pin_step_output(
            &fixture.api,
            &fixture.host,
            fixture.pin("run-1", "collect", 1),
            now()
        )
        .await
        .err(),
        Some(RunDebuggingError::NotPinnable)
    );
}

#[tokio::test]
async fn a_run_with_pinned_data_admits_the_pinned_step_without_running_it() {
    let fixture = Fixture::new("pinned-run", false);
    // Nothing is pinned yet: using pinned data is refused, never a full run.
    assert_eq!(fixture.start("run-0", true).err(), Some("conflict"));
    fixture.start("run-1", false).expect("starts");
    fixture.finish_collect("run-1", "exec-1");
    pin_step_output(
        &fixture.api,
        &fixture.host,
        fixture.pin("run-1", "collect", 0),
        now(),
    )
    .await
    .expect("pins");

    let started = fixture
        .start("run-2", true)
        .expect("starts with pinned data");
    assert!(started.use_pinned_data());
    let run = fixture
        .api
        .advance_automatic_steps(&fixture.workspace_id, "run-2")
        .expect("advances");
    let collect = task(&run, "collect");
    assert_eq!(collect.status(), TaskStatus::Succeeded);
    assert!(collect.pinned());
    assert!(collect.execution().is_none());
    assert_eq!(collect.result_data(), Some(&json!({"files": 2})));
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["report"]);
    // The next scheduling pass launches the native step, never the script.
    let lease = fixture.api.lease_next_script(
        &fixture.workspace_id,
        "run-2",
        run.revision(),
        "lease-x".into(),
    );
    assert!(lease.is_err(), "the pinned script is never leased");

    // Without pinned data the same pipeline runs every step, and freezes no pins.
    let plain = fixture.start("run-3", false).expect("starts");
    assert!(
        plain
            .definition()
            .pipeline
            .steps
            .iter()
            .all(|step| step.pinned_output.is_none())
    );
    let plain = fixture
        .api
        .advance_automatic_steps(&fixture.workspace_id, "run-3")
        .expect("advances");
    assert_eq!(task(&plain, "collect").status(), TaskStatus::Ready);
    assert!(!task(&plain, "collect").pinned());

    // The journal reloads the pinned run exactly.
    let reopened = OrchestrationApiState::open(&fixture.app_data).expect("reopens");
    assert_eq!(
        reopened
            .get_run(&fixture.workspace_id, "run-2")
            .expect("reads")
            .expect("run"),
        run
    );
}

#[tokio::test]
async fn archive_is_persistent_ui_metadata_and_refuses_active_runs() {
    let fixture = Fixture::new("archive", false);
    fixture.start("run-1", false).expect("starts");
    let revision = fixture.run("run-1").revision();
    assert_eq!(
        fixture.archive("run-1", true),
        Err(RunDebuggingError::RunActive)
    );
    assert_eq!(
        fixture.archive("run-9", true),
        Err(RunDebuggingError::NotFound)
    );
    fixture.cancel("run-1");
    let revision_after_cancel = fixture.run("run-1").revision();
    assert!(revision_after_cancel > revision);
    assert_eq!(fixture.archive("run-1", true), Ok(true));
    assert_eq!(fixture.archive("run-1", true), Ok(true), "idempotent");
    assert_eq!(
        fixture.run("run-1").revision(),
        revision_after_cancel,
        "the run record is untouched"
    );
    let summaries = fixture.summaries();
    assert!(summaries[0].archived);
    assert_eq!(
        serde_json::to_value(&summaries[0]).expect("json")["archived"],
        json!(true)
    );
    let reopened = OrchestrationApiState::open(&fixture.app_data).expect("reopens");
    assert!(
        reopened
            .store()
            .snapshot()
            .expect("snapshot")
            .workspace(&fixture.workspace_id)
            .is_some_and(|workspace| workspace.archived_run_ids.contains("run-1"))
    );
    assert_eq!(fixture.archive("run-1", false), Ok(false));
    let summary = serde_json::to_value(&fixture.summaries()[0]).expect("json");
    assert!(summary.get("archived").is_none(), "omitted when false");
}

#[tokio::test]
async fn delete_removes_only_the_finished_runs_piui_records() {
    let fixture = Fixture::new("delete", false);
    fixture.start("run-1", false).expect("starts");
    fixture.finish_collect("run-1", "exec-1");
    fixture.start("run-2", false).expect("starts");
    let scripts = fixture.api.script_work_root().to_path_buf();
    fs::create_dir_all(scripts.join("exec-1")).expect("left-over working copy");
    fs::write(scripts.join("exec-1").join("step.mjs"), "x").expect("source copy");
    fs::create_dir_all(scripts.join("exec-other")).expect("another run's copy");
    let project_file = fixture.root.join("project").join("keep.txt");
    fs::write(&project_file, "project data").expect("project file");

    let revision = fixture.run("run-1").revision();
    assert_eq!(
        fixture.delete("run-1", revision).await,
        Err(RunDebuggingError::RunActive)
    );
    fixture.cancel("run-1");
    fixture.archive("run-1", true).expect("archives");
    assert_eq!(
        fixture.delete("run-1", revision).await,
        Err(RunDebuggingError::Conflict),
        "a changed run is not deleted"
    );
    let revision = fixture.run("run-1").revision();
    fixture.delete("run-1", revision).await.expect("deletes");
    assert!(
        fixture
            .api
            .get_run(&fixture.workspace_id, "run-1")
            .expect("reads")
            .is_none()
    );
    assert!(
        fixture
            .api
            .get_run(&fixture.workspace_id, "run-2")
            .expect("reads")
            .is_some()
    );
    assert!(!scripts.join("exec-1").exists());
    assert!(scripts.join("exec-other").exists());
    assert!(project_file.exists());
    assert_eq!(fixture.summaries().len(), 1);
    let snapshot = fixture.api.store().snapshot().expect("snapshot");
    let workspace = snapshot
        .workspace(&fixture.workspace_id)
        .expect("workspace");
    assert!(workspace.archived_run_ids.is_empty());
    assert_eq!(workspace.pipelines.len(), 1, "definitions are untouched");
    assert_eq!(
        fixture.delete("run-1", revision).await,
        Err(RunDebuggingError::NotFound)
    );
    // Durable: a reopened journal no longer has the run.
    let reopened = OrchestrationApiState::open(&fixture.app_data).expect("reopens");
    assert!(
        reopened
            .get_run(&fixture.workspace_id, "run-1")
            .expect("reads")
            .is_none()
    );
}

#[tokio::test]
async fn safe_mode_keeps_runs_read_only() {
    let fixture = Fixture::new("safe", true);
    assert_eq!(
        pin_step_output(
            &fixture.api,
            &fixture.host,
            fixture.pin("run-1", "collect", 0),
            now()
        )
        .await
        .err(),
        Some(RunDebuggingError::SafeMode)
    );
    assert_eq!(
        fixture.archive("run-1", true),
        Err(RunDebuggingError::SafeMode)
    );
    assert_eq!(
        fixture.delete("run-1", 0).await,
        Err(RunDebuggingError::SafeMode)
    );
    // Reading outputs stays available.
    assert_eq!(
        run_outputs(
            &fixture.api,
            &fixture.host,
            RunOutputsRequestV1 {
                workspace_id: fixture.workspace_id.clone(),
                run_id: "run-1".into(),
            },
        )
        .await
        .err(),
        Some(RunDebuggingError::NotFound)
    );
}

#[tokio::test]
async fn step_outputs_are_bounded_and_unreadable_history_is_reported() {
    let fixture = Fixture::new("outputs", false);
    let project = fixture.root.join("project");
    let task =
        |value: serde_json::Value| -> TaskRecord { serde_json::from_value(value).expect("task") };
    let text = step_output(
        &fixture.host,
        &fixture.workspace_id,
        &project,
        &task(
            json!({"stepId": "a", "status": "succeeded", "revision": 1, "execution": {"id": "e"},
            "output": {"text": "first part", "truncated": true}}),
        ),
    )
    .await;
    assert_eq!(text.text.as_deref(), Some("first part"));
    assert!(text.truncated);
    let large = step_output(
        &fixture.host,
        &fixture.workspace_id,
        &project,
        &task(json!({"stepId": "b", "status": "succeeded", "revision": 1,
            "resultData": {"text": "x".repeat(MAX_PINNED_DATA_BYTES)}})),
    )
    .await;
    assert_eq!(large.issue, Some(StepOutputIssue::TooLarge));
    assert_eq!(large.data, None);
    let missing = step_output(
        &fixture.host,
        &fixture.workspace_id,
        &project,
        &task(json!({"stepId": "c", "status": "succeeded", "revision": 1, "execution": {"id": "gone"},
            "resultReference": {"sessionId": "gone", "blockId": "answer", "contentHash": "ab".repeat(32)}})),
    )
    .await;
    assert_eq!(missing.issue, Some(StepOutputIssue::Unavailable));
    assert_eq!(missing.text, None);
}

#[test]
fn only_plain_host_folders_directly_under_the_script_folder_are_removed() {
    let root = std::env::temp_dir().join(format!("piui-script-folders-{}", uuid::Uuid::new_v4()));
    let scripts = root.join("orchestration-scripts");
    let outside = root.join("outside");
    fs::create_dir_all(scripts.join("exec-1")).expect("folder");
    fs::create_dir_all(&outside).expect("outside folder");
    fs::write(outside.join("keep.txt"), "keep").expect("outside file");
    fs::write(scripts.join("exec-file"), "not a folder").expect("file");
    for rejected in ["", ".", "..", "a/b", "a\\b", "C:", &"a".repeat(200)] {
        assert!(!owned_folder_name(rejected), "{rejected:?}");
    }
    assert!(owned_folder_name("0b6c1c9e-2f4f-4b8e-9c55-2f5f7bf1a9d1"));
    let linked = link_directory(&outside, &scripts.join("exec-link"));
    let ids = ["exec-1", "exec-file", "exec-link", "../outside", "missing"]
        .into_iter()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    assert_eq!(remove_script_folders(&scripts, &ids), 1);
    assert!(!scripts.join("exec-1").exists());
    assert!(scripts.join("exec-file").exists());
    assert!(
        outside.join("keep.txt").exists(),
        "a link is never followed"
    );
    if linked {
        assert!(
            fs::symlink_metadata(scripts.join("exec-link")).is_ok(),
            "a link is left in place"
        );
    }
    // A script folder that is itself a link is never used.
    let linked_root = root.join("linked-scripts");
    if link_directory(&scripts, &linked_root) {
        fs::create_dir_all(scripts.join("exec-2")).expect("folder");
        let ids = BTreeSet::from(["exec-2".to_owned()]);
        assert_eq!(remove_script_folders(&linked_root, &ids), 0);
        assert!(scripts.join("exec-2").exists());
    }
    let _ = fs::remove_dir_all(&root);
}

/// Creates a directory link (a junction on Windows, which needs no special
/// privilege; a symlink elsewhere). False when the platform refuses.
fn link_directory(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|output| output.status.success())
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[test]
fn run_debugging_contract_matches_the_shared_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/orchestration-run-debugging-v1.json"
    ))
    .expect("fixture");
    let outputs: RunOutputsRequestV1 =
        serde_json::from_value(fixture["outputsRequest"].clone()).expect("outputs request");
    assert_eq!(outputs.run_id, "run-1");
    let pin: PinStepOutputRequestV1 =
        serde_json::from_value(fixture["pinRequest"].clone()).expect("pin request");
    assert_eq!(pin.expected_revision, 3);
    let archive: SetRunArchivedRequestV1 =
        serde_json::from_value(fixture["archiveRequest"].clone()).expect("archive request");
    assert!(archive.archived);
    let delete: DeleteRunRequestV1 =
        serde_json::from_value(fixture["deleteRequest"].clone()).expect("delete request");
    assert_eq!(delete.expected_run_revision, 12);
    for (name, value) in [
        ("outputsRequest", fixture["outputsRequest"].clone()),
        ("pinRequest", fixture["pinRequest"].clone()),
        ("deleteRequest", fixture["deleteRequest"].clone()),
    ] {
        let mut extra = value;
        extra["path"] = json!("C:/Windows");
        let rejected = match name {
            "outputsRequest" => serde_json::from_value::<RunOutputsRequestV1>(extra).is_err(),
            "pinRequest" => serde_json::from_value::<PinStepOutputRequestV1>(extra).is_err(),
            _ => serde_json::from_value::<DeleteRunRequestV1>(extra).is_err(),
        };
        assert!(rejected, "{name} rejects unknown fields");
    }

    let issue = |value: &str| match value {
        "too-large" => Some(StepOutputIssue::TooLarge),
        "unavailable" => Some(StepOutputIssue::Unavailable),
        _ => None,
    };
    let result = RunOutputsResultV1 {
        protocol: RUN_DEBUGGING_PROTOCOL,
        run_id: "run-1".into(),
        outputs: fixture["outputsResult"]["outputs"]
            .as_array()
            .expect("outputs")
            .iter()
            .map(|item| StepOutputV1 {
                step_id: item["stepId"].as_str().expect("id").into(),
                text: item["text"].as_str().map(str::to_owned),
                truncated: item["truncated"].as_bool().unwrap_or(false),
                data: item.get("data").cloned(),
                issue: item["issue"].as_str().and_then(issue),
            })
            .collect(),
    };
    assert_eq!(
        serde_json::to_value(&result).expect("json"),
        fixture["outputsResult"]
    );
    let pinned: PinnedOutput =
        serde_json::from_value(fixture["pinResult"]["pinnedOutput"].clone()).expect("pinned");
    let pin_result = PinStepOutputResultV1 {
        protocol: RUN_DEBUGGING_PROTOCOL,
        revision: 4,
        pinned_output: pinned,
    };
    assert_eq!(
        serde_json::to_value(&pin_result).expect("json"),
        fixture["pinResult"]
    );
    assert_eq!(
        serde_json::to_value(SetRunArchivedResultV1 {
            protocol: RUN_DEBUGGING_PROTOCOL,
            run_id: "run-1".into(),
            archived: true,
        })
        .expect("json"),
        fixture["archiveResult"]
    );
    assert_eq!(
        serde_json::to_value(DeleteRunResultV1 {
            protocol: RUN_DEBUGGING_PROTOCOL,
            run_id: "run-1".into(),
        })
        .expect("json"),
        fixture["deleteResult"]
    );
    let errors = [
        RunDebuggingError::Invalid,
        RunDebuggingError::NotFound,
        RunDebuggingError::Conflict,
        RunDebuggingError::SafeMode,
        RunDebuggingError::ShuttingDown,
        RunDebuggingError::RunActive,
        RunDebuggingError::StepNotSucceeded,
        RunDebuggingError::NotPinnable,
        RunDebuggingError::NoOutput,
        RunDebuggingError::TooLarge,
        RunDebuggingError::OutputUnavailable,
        RunDebuggingError::Io,
    ];
    assert_eq!(
        serde_json::to_value(errors).expect("json"),
        fixture["errors"]
    );

    // v6.3 additive fields of the orchestration contracts.
    let start: StartRunRequest =
        serde_json::from_value(fixture["startRequest"].clone()).expect("start request");
    assert!(start.use_pinned_data);
    let mut legacy_start = fixture["startRequest"].clone();
    legacy_start
        .as_object_mut()
        .expect("object")
        .remove("usePinnedData");
    let legacy_start: StartRunRequest =
        serde_json::from_value(legacy_start).expect("a v6.2 start request decodes");
    assert!(!legacy_start.use_pinned_data);
    let summary = RunSummary {
        id: "run-1".into(),
        status: RunStatus::Succeeded,
        revision: 12,
        team_name: "Team".into(),
        pipeline_name: "Pipeline".into(),
        archived: true,
    };
    assert_eq!(
        serde_json::to_value(&summary).expect("json"),
        fixture["runSummary"]
    );
    let step: piui_orchestration::PipelineStep =
        serde_json::from_value(fixture["pinnedStep"].clone()).expect("pinned step");
    assert_eq!(
        serde_json::to_value(&step).expect("json"),
        fixture["pinnedStep"]
    );
    let pinned_task: TaskRecord =
        serde_json::from_value(fixture["pinnedTask"].clone()).expect("pinned task");
    assert!(pinned_task.pinned());
    assert_eq!(
        serde_json::to_value(&pinned_task).expect("json"),
        fixture["pinnedTask"]
    );
}

#[test]
fn an_older_journal_without_archive_or_pin_fields_loads_and_stays_unchanged() {
    let root = std::env::temp_dir().join(format!(
        "piui-run-debugging-compat-{}",
        uuid::Uuid::new_v4()
    ));
    let directory = root.join("orchestration-v1");
    fs::create_dir_all(&directory).expect("store folder");
    let document = json!({
        "version": 2, "generation": 7, "workspaces": [{
            "workspaceId": "project", "profiles": [], "teams": [], "pipelines": [], "launchCommands": [], "schedules": [],
            "runs": [{
                "schemaVersion": 6, "id": "old-run", "status": "succeeded", "revision": 3, "messages": [], "agentRequests": [],
                "tasks": [{"stepId": "task", "status": "succeeded", "revision": 2, "execution": {"id": "session"},
                    "resultData": {"ok": true}}],
                "definition": {
                    "profiles": [{"id": "profile", "name": "Worker", "harness": "codex", "model": "native", "permissionMode": "native", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}],
                    "team": {"id": "team", "name": "Team", "members": [{"id": "member", "profileId": "profile"}], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "member"},
                    "pipeline": {"id": "pipeline", "name": "Pipeline", "steps": [{"id": "task", "name": "Task", "assignedMemberId": "member", "instructions": "Work", "dependencyStepIds": []}]}
                }
            }]
        }]
    });
    fs::write(
        directory.join("orchestration-00000000000000000007.json"),
        serde_json::to_vec(&document).expect("bytes"),
    )
    .expect("writes the older generation");
    let api = OrchestrationApiState::open(&root).expect("opens");
    let run = api
        .get_run("project", "old-run")
        .expect("reads")
        .expect("run");
    assert!(!run.use_pinned_data());
    assert!(!run.tasks()[0].pinned());
    api.store()
        .transact(|_| Ok(()))
        .expect("writes the next generation");
    let written: serde_json::Value = serde_json::from_slice(
        &fs::read(directory.join("orchestration-00000000000000000008.json")).expect("reads"),
    )
    .expect("json");
    let workspace = &written["workspaces"][0];
    assert!(workspace.get("archivedRunIds").is_none());
    assert_eq!(workspace["runs"][0], document["workspaces"][0]["runs"][0]);
    let _ = fs::remove_dir_all(root);
}
