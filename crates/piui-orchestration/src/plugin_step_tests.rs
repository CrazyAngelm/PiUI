//! Plugin node steps (orchestration v6.5): definition rules, leasing,
//! results checked like script output, hand-off to native steps and
//! uncertainty after a restart.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::*;

/// agent `collect` → plugin `reshape` → llm `review`.
fn fixture() -> Value {
    json!({
        "profiles": [
            {"id": "worker", "name": "Worker", "harness": "codex", "model": "model", "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []},
            {"id": "caller", "name": "Caller", "harness": "pi", "model": "model", "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}
        ],
        "team": {"id": "team", "name": "Team", "members": [
            {"id": "collector", "profileId": "worker"},
            {"id": "reviewer", "profileId": "caller"}
        ], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "collector"},
        "pipeline": {
            "id": "pipeline", "name": "Pipeline",
            "steps": [
                {"id": "collect", "name": "Collect", "assignedMemberId": "collector", "instructions": "Collect.", "dependencyStepIds": []},
                {"id": "reshape", "name": "Reshape", "assignedMemberId": "reshape", "instructions": "Keep findings.",
                 "executor": {"type": "plugin", "pluginId": "example.pipeline-pack", "nodeType": "json-transform", "config": {"pick": "findings", "wrap": ""}},
                 "resultFields": [{"name": "findings", "kind": "text-list"}],
                 "dependencyStepIds": ["collect"]},
                {"id": "review", "name": "Review", "assignedMemberId": "reviewer", "instructions": "Review.",
                 "executor": {"type": "llm"},
                 "inputBindings": [{"sourceStepId": "reshape", "field": "findings", "name": "findings"}],
                 "dependencyStepIds": ["reshape"]}
            ]
        }
    })
}

fn started(value: Value) -> Result<Run, CoordinatorError> {
    let snapshot: RunDefinitionSnapshot = serde_json::from_value(value).expect("snapshot decodes");
    Coordinator::new_run_with_inputs("run", snapshot, BTreeMap::new())
}

fn task<'a>(run: &'a Run, step_id: &str) -> &'a TaskRecord {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .expect("task exists")
}

fn finish_collect(run: &mut Run) {
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
            result_reference: Some(NativeHistoryReference {
                fields: Vec::new(),
                session_id: "collect-session".into(),
                block_id: Some("answer".into()),
                content_hash: Some("ab".repeat(32)),
            }),
        },
        Some(r#"{"findings":["a"],"risks":["b"]}"#),
    )
    .expect("completes");
}

fn lease_step(run: &mut Run) -> PluginStepLease {
    let revision = run.revision();
    Coordinator::lease_next_plugin_step(run, revision, "lease-reshape".into())
        .expect("leases")
        .expect("a ready plugin step")
}

fn dispatch(run: &mut Run, lease: &PluginStepLease) {
    let revision = run.revision();
    Coordinator::dispatch_leased_script(
        run,
        revision,
        &lease.step_id,
        lease.task_revision,
        &lease.lease_id,
        NativeExecutionReference {
            id: "plugin-execution".into(),
        },
    )
    .expect("dispatches");
}

fn complete(run: &mut Run, completion: ScriptCompletion) {
    let revision = run.revision();
    let task_revision = task(run, "reshape").revision();
    Coordinator::complete_script_task(
        run,
        revision,
        "reshape",
        task_revision,
        "plugin-execution",
        completion,
    )
    .expect("records the plugin outcome");
}

#[test]
fn a_plugin_step_round_trips_and_is_host_work() {
    let value = fixture();
    let snapshot: RunDefinitionSnapshot = serde_json::from_value(value.clone()).expect("decodes");
    let encoded = serde_json::to_value(&snapshot).expect("encodes");
    assert_eq!(
        encoded["pipeline"]["steps"][1]["executor"],
        value["pipeline"]["steps"][1]["executor"]
    );
    let step = &snapshot.pipeline.steps[1];
    assert!(step.is_plugin() && step.is_host_executed() && !step.is_script());
    assert_eq!(step.executor_kind(), ExecutorKind::Plugin);
    assert!(started(value).is_ok());
}

#[test]
fn definition_rules_refuse_bad_plugin_steps_before_any_run() {
    let rules: [(&str, Value); 6] = [
        ("/pipeline/steps/1/executor/pluginId", json!("Not An Id")),
        (
            "/pipeline/steps/1/executor/nodeType",
            json!("JSON transform"),
        ),
        (
            "/pipeline/steps/1/executor/config",
            json!({ "nested": { "a": 1 } }),
        ),
        (
            "/pipeline/steps/1/inputBindings",
            json!([{ "sourceStepId": "collect", "field": "findings", "name": "x" }]),
        ),
        ("/pipeline/steps/1/assignedMemberId", json!("collector")),
        ("/pipeline/steps/1/executionMode", json!("callable")),
    ];
    for (pointer, replacement) in rules {
        let mut value = fixture();
        if let Some((parent, key)) = pointer.rsplit_once('/') {
            value
                .pointer_mut(parent)
                .and_then(Value::as_object_mut)
                .expect(parent)
                .insert(key.to_owned(), replacement);
        }
        assert!(started(value).is_err(), "{pointer} must be refused");
    }
    let mut unknown = fixture();
    unknown["pipeline"]["steps"][1]["executor"]["timeoutSeconds"] = json!(5);
    assert!(
        serde_json::from_value::<RunDefinitionSnapshot>(unknown).is_err(),
        "unknown executor fields are refused, never dropped"
    );
}

#[test]
fn leasing_is_executor_specific_and_frozen() {
    let mut run = started(fixture()).expect("run");
    finish_collect(&mut run);
    let revision = run.revision();
    assert!(matches!(
        Coordinator::lease_next_script(&mut run, revision, "lease".into()),
        Err(CoordinatorError::ExecutorMismatch { .. })
    ));
    let lease = lease_step(&mut run);
    assert_eq!(lease.plugin_id, "example.pipeline-pack");
    assert_eq!(lease.node_type, "json-transform");
    let params = lease.node_run_params();
    assert_eq!(params["config"]["pick"], "findings");
    assert_eq!(
        params["step"],
        json!({ "id": "reshape", "name": "Reshape" })
    );
    assert_eq!(params["run"]["id"], "run");
    assert_eq!(params["dependencies"]["collect"]["text"], Value::Null);
    assert_eq!(
        params["dependencies"]["collect"]["data"]["findings"],
        json!(["a"])
    );
    assert_eq!(lease.task_revision, task(&run, "reshape").revision());
}

#[test]
fn a_json_answer_becomes_checked_result_data_for_native_dependents() {
    let mut run = started(fixture()).expect("run");
    finish_collect(&mut run);
    let lease = lease_step(&mut run);
    dispatch(&mut run, &lease);
    assert_eq!(task(&run, "reshape").status(), TaskStatus::Running);
    complete(
        &mut run,
        ScriptCompletion::Exited {
            stdout: r#"{"findings":["a"]}"#.into(),
            truncated: false,
        },
    );
    let reshape = task(&run, "reshape");
    assert_eq!(reshape.status(), TaskStatus::Succeeded);
    assert_eq!(reshape.result_data(), Some(&json!({ "findings": ["a"] })));
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference {
            id: "review-session".into(),
        },
    )
    .expect("dispatches")
    .expect("review is ready");
    assert_eq!(launch.step_id, "review");
    let outputs = launch.dependency_outputs;
    assert_eq!(outputs.len(), 1);
    assert_eq!(
        outputs[0].context_text().expect("context"),
        r#"{"findings":["a"]}"#
    );
}

#[test]
fn a_result_that_misses_declared_fields_fails_the_step() {
    let mut run = started(fixture()).expect("run");
    finish_collect(&mut run);
    let lease = lease_step(&mut run);
    dispatch(&mut run, &lease);
    complete(
        &mut run,
        ScriptCompletion::Exited {
            stdout: r#"{"other":1}"#.into(),
            truncated: false,
        },
    );
    let reshape = task(&run, "reshape");
    assert_eq!(reshape.status(), TaskStatus::Failed);
    assert_eq!(
        reshape.failure().map(|failure| failure.code.as_str()),
        Some("result-missing-field")
    );
}

#[test]
fn a_certain_refusal_fails_and_an_interrupted_step_becomes_uncertain() {
    let mut run = started(fixture()).expect("run");
    finish_collect(&mut run);
    let lease = lease_step(&mut run);
    let revision = run.revision();
    Coordinator::release_task_lease(
        &mut run,
        revision,
        &lease.step_id,
        lease.task_revision,
        &lease.lease_id,
    )
    .expect("releases");
    let task_revision = task(&run, "reshape").revision();
    let revision = run.revision();
    Coordinator::reject_ready_task(
        &mut run,
        revision,
        "reshape",
        task_revision,
        FailureRecord::new(PLUGIN_UNAVAILABLE),
    )
    .expect("rejects");
    assert_eq!(task(&run, "reshape").status(), TaskStatus::Failed);

    let mut run = started(fixture()).expect("run");
    finish_collect(&mut run);
    let lease = lease_step(&mut run);
    dispatch(&mut run, &lease);
    let revision = run.revision();
    Coordinator::restore(&mut run, revision).expect("restores");
    assert_eq!(task(&run, "reshape").status(), TaskStatus::Uncertain);
}
