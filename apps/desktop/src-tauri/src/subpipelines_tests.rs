//! Sub-pipelines in the host (v6.7, ADR-042): save rules, deletion
//! protection, the atomic child start with its certain refusals, and the
//! pure observation of child ends.

use super::*;
use crate::orchestration_api::{SaveGraphRequest, save_graph};
use piui_orchestration::{
    CompletionOutcome, Coordinator, LaunchCommandReference, NativeExecutionReference,
    NativeHistoryReference, RunTriggerEvent, SUBPIPELINE_CANCELLED, SUBPIPELINE_DEPTH,
};
use serde_json::{Value, json};

const WORKSPACE: &str = "workspace";

fn state() -> OrchestrationApiState {
    let root = std::env::temp_dir().join(format!("piui-subpipelines-{}", uuid::Uuid::new_v4()));
    OrchestrationApiState::open(&root).expect("opens")
}

fn graph(
    profile: &str,
    team: &str,
    member: &str,
    pipeline: Value,
    command: &str,
) -> SaveGraphRequest {
    let pipeline_id = pipeline["id"].clone();
    serde_json::from_value(json!({
        "workspaceId": WORKSPACE,
        "profiles": [{"workspaceId": WORKSPACE, "value": {"id": profile, "name": "Agent", "harness": "codex",
            "model": "model", "permissionMode": "read-only", "instructions": "",
            "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}}],
        "team": {"workspaceId": WORKSPACE, "value": {"id": team, "name": "Team",
            "members": [{"id": member, "profileId": profile}], "sendEdges": [], "observeEdges": [],
            "orchestratorMemberId": member}},
        "pipeline": {"workspaceId": WORKSPACE, "value": pipeline},
        "command": {"workspaceId": WORKSPACE, "value": {"id": command, "name": command,
            "teamId": team, "pipelineId": pipeline_id}}
    }))
    .expect("graph request")
}

/// `testing`: one agent step, a required text input and an optional boolean.
fn testing() -> SaveGraphRequest {
    graph(
        "agent-t",
        "testing-team",
        "tester",
        json!({"id": "testing", "name": "Testing",
            "inputs": [
                {"name": "branch", "label": "Branch", "kind": "text", "required": true},
                {"name": "strict", "label": "Strict", "kind": "boolean"}
            ],
            "steps": [{"id": "unit", "name": "Unit", "assignedMemberId": "tester",
                "instructions": "Test.", "dependencyStepIds": []}]}),
        "testing",
    )
}

fn development_pipeline(test_executor: Value) -> Value {
    json!({"id": "development", "name": "Development",
    "inputs": [{"name": "branch", "label": "Branch", "kind": "text"}],
    "steps": [
        {"id": "collect", "name": "Collect", "assignedMemberId": "collector", "instructions": "Collect.",
         "resultFields": [{"name": "count", "kind": "number"}], "dependencyStepIds": []},
        {"id": "test", "name": "Test", "assignedMemberId": "test", "instructions": "",
         "executor": test_executor, "dependencyStepIds": ["collect"]}
    ]})
}

fn test_executor(inputs: Value) -> Value {
    json!({"type": "pipeline", "launchCommandId": "testing", "inputs": inputs})
}

fn valid_inputs() -> Value {
    json!({
        "branch": {"kind": "input", "name": "branch"},
        "strict": {"kind": "value", "value": true}
    })
}

fn development(executor: Value) -> SaveGraphRequest {
    graph(
        "agent-d",
        "dev-team",
        "collector",
        development_pipeline(executor),
        "develop",
    )
}

/// A project with `testing` and `development` (which runs `testing`).
fn saved() -> OrchestrationApiState {
    let state = state();
    save_graph(&state, testing()).expect("testing saves");
    save_graph(&state, development(test_executor(valid_inputs()))).expect("development saves");
    state
}

fn workspace(state: &OrchestrationApiState) -> WorkspaceOrchestration {
    state
        .snapshot()
        .expect("snapshot")
        .workspace(WORKSPACE)
        .cloned()
        .expect("workspace")
}

#[test]
fn saves_refuse_unknown_references_inputs_and_cycles() {
    let refused = [
        json!({"type": "pipeline", "launchCommandId": "missing", "inputs": valid_inputs()}),
        test_executor(json!({
            "branch": {"kind": "input", "name": "branch"},
            "unknown": {"kind": "value", "value": 1}
        })),
        test_executor(json!({
            "branch": {"kind": "input", "name": "branch"},
            "strict": {"kind": "value", "value": "yes"}
        })),
        test_executor(json!({"strict": {"kind": "value", "value": true}})),
        test_executor(json!({"branch": {"kind": "step", "stepId": "collect", "field": "count"}})),
        // The pipeline would run its own launch command.
        json!({"type": "pipeline", "launchCommandId": "develop", "inputs": {}}),
    ];
    for executor in refused {
        let state = state();
        save_graph(&state, testing()).expect("testing saves");
        assert!(
            save_graph(&state, development(executor.clone())).is_err(),
            "{executor} must be refused"
        );
        assert!(
            workspace(&state)
                .pipelines
                .iter()
                .all(|pipeline| pipeline.value.id != "development"),
            "a refused save writes nothing"
        );
    }
    // A whole dependency text may fill a text input.
    let state = state();
    save_graph(&state, testing()).expect("testing saves");
    save_graph(
        &state,
        development(test_executor(
            json!({"branch": {"kind": "step", "stepId": "collect"}}),
        )),
    )
    .expect("a whole text fills a text input");
}

#[test]
fn a_save_that_closes_a_cycle_is_refused() {
    let state = saved();
    // `testing` may not run `develop`, which runs `testing`.
    let mut looping: PipelineDefinition = serde_json::from_value(json!({
    "id": "testing", "name": "Testing",
    "inputs": [{"name": "branch", "label": "Branch", "kind": "text", "required": true}],
    "steps": [
        {"id": "unit", "name": "Unit", "assignedMemberId": "tester", "instructions": "Test.",
         "dependencyStepIds": []},
        {"id": "again", "name": "Again", "assignedMemberId": "again", "instructions": "",
         "executor": {"type": "pipeline", "launchCommandId": "develop", "inputs": {}},
         "dependencyStepIds": ["unit"]}
    ]}))
    .expect("pipeline");
    assert!(
        state
            .save_pipeline_for_test(WORKSPACE, Some(0), looping.clone())
            .is_err()
    );
    assert!(reference_cycle(&workspace(&state)).is_none());
    // Retargeting `testing` at the pipeline that runs it is a cycle too.
    let retargeted = LaunchCommandReference {
        id: "testing".into(),
        name: "testing".into(),
        team_id: "dev-team".into(),
        pipeline_id: "development".into(),
        managed_by_teammate_id: None,
    };
    assert!(
        state
            .save_launch_command_for_test(WORKSPACE, Some(0), retargeted)
            .is_err()
    );
    // Without the loop the same save is accepted.
    looping.steps.pop();
    state
        .save_pipeline_for_test(WORKSPACE, Some(0), looping)
        .expect("an acyclic save is accepted");
}

#[test]
fn a_referenced_launch_command_is_never_deleted() {
    let state = saved();
    let snapshot = workspace(&state);
    assert!(launch_command_referenced(&snapshot, "testing"));
    assert!(!launch_command_referenced(&snapshot, "develop"));
    assert!(
        state
            .delete_launch_command_for_test(WORKSPACE, "testing", 0)
            .is_err()
    );
    state
        .delete_launch_command_for_test(WORKSPACE, "develop", 0)
        .expect("an unreferenced command is deleted");
}

fn reference(session: &str) -> NativeHistoryReference {
    NativeHistoryReference {
        fields: Vec::new(),
        session_id: session.into(),
        block_id: Some("answer".into()),
        content_hash: Some("ab".repeat(32)),
    }
}

/// A `development` run whose `collect` succeeded and whose `test` is leased.
fn leased_parent(state: &OrchestrationApiState) -> PipelineStepLease {
    let mut inputs = BTreeMap::new();
    inputs.insert("branch".to_owned(), json!("main"));
    state
        .create_run(crate::orchestration_api::StartRunRequest {
            workspace_id: WORKSPACE.into(),
            run_id: "parent".into(),
            team_id: "dev-team".into(),
            pipeline_id: "development".into(),
            launch_command_id: Some("develop".into()),
            inputs,
            use_pinned_data: false,
        })
        .expect("parent run");
    state.update_run_for_test(WORKSPACE, "parent", |run| {
        let revision = run.revision();
        let launch = Coordinator::dispatch_next(
            run,
            revision,
            NativeExecutionReference {
                id: "collect-session".into(),
            },
        )
        .expect("dispatches")
        .expect("collect is ready");
        Coordinator::complete_checked_task(
            run,
            launch.run_revision,
            &launch.step_id,
            launch.task_revision,
            "collect-session",
            CompletionOutcome::Succeeded {
                result_reference: Some(reference("collect-session")),
            },
            Some(r#"{"count":3}"#),
        )
        .expect("completes");
    });
    let revision = state
        .get_run(WORKSPACE, "parent")
        .expect("reads")
        .expect("parent")
        .revision();
    state
        .lease_next_pipeline_step(WORKSPACE, "parent", revision, "lease".into())
        .expect("leases")
        .expect("test is ready")
}

#[test]
fn a_child_starts_atomically_and_its_end_is_observed() {
    let state = saved();
    let lease = leased_parent(&state);
    let (parent, child) = state
        .start_pipeline_child(WORKSPACE, &lease, "child".into())
        .expect("starts the child");
    let test = parent
        .tasks()
        .iter()
        .find(|task| task.step_id() == "test")
        .expect("test");
    assert_eq!(test.status(), TaskStatus::Running);
    assert_eq!(
        test.execution().map(|execution| execution.id.as_str()),
        Some("child")
    );
    assert_eq!(
        child.trigger(),
        Some(&RunTrigger::Pipeline {
            parent_run_id: "parent".into(),
            parent_step_id: "test".into(),
            launch_command_id: "testing".into(),
            depth: 1,
        })
    );
    assert_eq!(child.inputs().get("branch"), Some(&json!("main")));
    assert_eq!(child.inputs().get("strict"), Some(&json!(true)));
    assert!(!child.use_pinned_data());
    assert_eq!(
        child
            .definition()
            .launch_command
            .as_ref()
            .map(|command| command.id.as_str()),
        Some("testing")
    );

    let snapshot = workspace(&state);
    assert!(pending_subpipeline_ends(std::slice::from_ref(&snapshot)).is_empty());
    assert_eq!(
        running_children(&snapshot, "parent", None),
        vec!["child".to_owned()]
    );
    assert_eq!(
        running_children(&snapshot, "parent", Some("collect")),
        Vec::<String>::new()
    );
    let child_run = snapshot
        .runs
        .iter()
        .find(|run| run.id() == "child")
        .expect("child");
    assert!(parent_waits_for(&snapshot, child_run));

    // The child is cancelled on its own: the parent step records it.
    state.update_run_for_test(WORKSPACE, "child", |run| {
        let revision = run.revision();
        Coordinator::cancel_run(run, revision).expect("cancels");
    });
    let snapshot = workspace(&state);
    let pending = pending_subpipeline_ends(std::slice::from_ref(&snapshot));
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].child, ChildEnd::Ended);
    assert_eq!(pending[0].child_run_id, "child");
    let child_run = snapshot
        .runs
        .iter()
        .find(|run| run.id() == "child")
        .expect("child");
    let completion =
        piui_orchestration::child_completion(child_run, &BTreeMap::new()).expect("ended");
    let parent = state
        .record_pipeline_outcome(WORKSPACE, "parent", "test", "child", completion.clone())
        .expect("records");
    let test = parent
        .tasks()
        .iter()
        .find(|task| task.step_id() == "test")
        .expect("test");
    assert_eq!(
        test.failure().map(|failure| failure.code.as_str()),
        Some(SUBPIPELINE_CANCELLED)
    );
    assert!(
        state
            .record_pipeline_outcome(WORKSPACE, "parent", "test", "child", completion)
            .is_err(),
        "a second observation is ignored"
    );
    assert!(pending_subpipeline_ends(std::slice::from_ref(&workspace(&state))).is_empty());

    // A missing child record can never be observed.
    let mut orphaned = snapshot;
    orphaned.runs.retain(|run| run.id() != "child");
    let pending = pending_subpipeline_ends(std::slice::from_ref(&orphaned));
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].child, ChildEnd::Missing);
}

#[test]
fn refusals_before_the_child_exists_are_certain() {
    let state = saved();
    let lease = leased_parent(&state);
    let snapshot = workspace(&state);
    let parent = snapshot
        .runs
        .iter()
        .find(|run| run.id() == "parent")
        .expect("parent");
    assert!(plan_child_start(&snapshot, parent, &lease, "child").is_ok());

    let mut missing = lease.clone();
    missing.launch_command_id = "missing".into();
    assert_eq!(
        plan_child_start(&snapshot, parent, &missing, "child").map(|_| ()),
        Err(SUBPIPELINE_UNAVAILABLE)
    );

    let mut deep = lease.clone();
    deep.parent_trigger = Some(RunTrigger::Pipeline {
        parent_run_id: "above".into(),
        parent_step_id: "step".into(),
        launch_command_id: "other".into(),
        depth: MAX_SUBPIPELINE_DEPTH,
    });
    assert_eq!(
        plan_child_start(&snapshot, parent, &deep, "child").map(|_| ()),
        Err(SUBPIPELINE_DEPTH)
    );

    // The parent runs `develop`: running it again below itself is a cycle.
    let mut itself = lease.clone();
    itself.launch_command_id = "develop".into();
    assert_eq!(
        plan_child_start(&snapshot, parent, &itself, "child").map(|_| ()),
        Err(SUBPIPELINE_CYCLE)
    );

    let mut invalid = lease.clone();
    invalid.sources.insert(
        "strict".into(),
        SubpipelineInputSource::Value { value: json!(5) },
    );
    assert_eq!(
        plan_child_start(&snapshot, parent, &invalid, "child").map(|_| ()),
        Err(SUBPIPELINE_INPUT_INVALID)
    );
    assert_eq!(
        state
            .start_pipeline_child(WORKSPACE, &invalid, "child".into())
            .map(|_| ()),
        Err(ChildStartError::Refused(SUBPIPELINE_INPUT_INVALID))
    );
    // Nothing was written: no child, the step is still leased.
    let after = workspace(&state);
    assert!(after.runs.iter().all(|run| run.id() != "child"));
    let test = after
        .runs
        .iter()
        .find(|run| run.id() == "parent")
        .and_then(|run| run.tasks().iter().find(|task| task.step_id() == "test"))
        .expect("test");
    assert_eq!(test.status(), TaskStatus::Ready);
    assert_eq!(test.lease_id(), Some("lease"));
}

#[test]
fn a_child_inherits_its_top_level_runs_event_hops() {
    let state = saved();
    let lease = leased_parent(&state);
    let (parent, child) = state
        .start_pipeline_child(WORKSPACE, &lease, "child".into())
        .expect("starts the child");
    let top = Coordinator::new_triggered_run(
        "parent",
        parent.definition().clone(),
        parent.inputs().clone(),
        Some(RunTrigger::Event {
            schedule_id: "automation".into(),
            schedule_name: "Automation".into(),
            occurrence_id: "occurrence".into(),
            event: RunTriggerEvent::RunFinished,
            source_run_id: None,
            chain_depth: 2,
        }),
    )
    .expect("top run");
    let runs = [top, child];
    assert_eq!(runs[1].chain_depth(), 0);
    assert_eq!(inherited_chain_depth(&runs, &runs[1]), 2);
    assert_eq!(inherited_chain_depth(&runs, &runs[0]), 2);
}
