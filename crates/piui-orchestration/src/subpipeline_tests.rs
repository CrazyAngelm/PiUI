//! Sub-pipeline steps (orchestration v6.7, ADR-042): contract shapes,
//! definition rules, leasing, results checked like script output, restart
//! behaviour, child input resolution, output projection and cycle checks.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::*;

fn profiles() -> Value {
    json!([
        {"id": "worker", "name": "Worker", "harness": "codex", "model": "model", "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}
    ])
}

/// agent `collect` → sub-pipeline `test` (launch command `testing`) → agent `report`.
fn parent() -> Value {
    json!({
        "profiles": profiles(),
        "team": {"id": "team", "name": "Team", "members": [
            {"id": "collector", "profileId": "worker"},
            {"id": "reporter", "profileId": "worker"}
        ], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "collector"},
        "pipeline": {
            "id": "development", "name": "Development",
            "inputs": [
                {"name": "branch", "label": "Branch", "kind": "text"},
                {"name": "ticket", "label": "Ticket", "kind": "text"}
            ],
            "steps": [
                {"id": "collect", "name": "Collect", "assignedMemberId": "collector", "instructions": "Collect.",
                 "resultFields": [{"name": "count", "kind": "number"}],
                 "dependencyStepIds": []},
                {"id": "test", "name": "Test", "assignedMemberId": "test", "instructions": "",
                 "executor": {"type": "pipeline", "launchCommandId": "testing", "inputs": {
                     "branch": {"kind": "input", "name": "branch"},
                     "ticket": {"kind": "input", "name": "ticket"},
                     "notes": {"kind": "step", "stepId": "collect"},
                     "count": {"kind": "step", "stepId": "collect", "field": "count"},
                     "strict": {"kind": "value", "value": true}
                 }},
                 "resultFields": [{"name": "passed", "kind": "boolean"}],
                 "dependencyStepIds": ["collect"]},
                {"id": "report", "name": "Report", "assignedMemberId": "reporter", "instructions": "Report.",
                 "dependencyStepIds": ["test"]}
            ],
            "outputs": [
                {"name": "summary", "kind": "text", "sourceStepId": "report"},
                {"name": "passed", "kind": "boolean", "sourceStepId": "test", "field": "passed"}
            ]
        }
    })
}

/// A child pipeline: agents `summary` and `unit` with two declared outputs.
fn child() -> Value {
    json!({
        "profiles": profiles(),
        "team": {"id": "team", "name": "Team", "members": [
            {"id": "tester", "profileId": "worker"}
        ], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "tester"},
        "pipeline": {
            "id": "testing", "name": "Testing",
            "steps": [
                {"id": "summary", "name": "Summary", "assignedMemberId": "tester", "instructions": "Sum up.",
                 "dependencyStepIds": []},
                {"id": "unit", "name": "Unit", "assignedMemberId": "tester", "instructions": "Test.",
                 "resultFields": [{"name": "passed", "kind": "boolean"}],
                 "dependencyStepIds": []}
            ],
            "outputs": [
                {"name": "passed", "kind": "boolean", "sourceStepId": "unit", "field": "passed"},
                {"name": "report", "kind": "text", "sourceStepId": "summary"}
            ]
        }
    })
}

fn snapshot(value: Value) -> RunDefinitionSnapshot {
    serde_json::from_value(value).expect("snapshot decodes")
}

fn started(value: Value) -> Result<Run, CoordinatorError> {
    let mut inputs = BTreeMap::new();
    inputs.insert("branch".to_owned(), json!("main"));
    Coordinator::new_run_with_inputs("run", snapshot(value), inputs)
}

fn task<'a>(run: &'a Run, step_id: &str) -> &'a TaskRecord {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .expect("task exists")
}

fn reference(session: &str) -> NativeHistoryReference {
    NativeHistoryReference {
        fields: Vec::new(),
        session_id: session.into(),
        block_id: Some("answer".into()),
        content_hash: Some("ab".repeat(32)),
    }
}

/// Dispatches the next ready native step, which must be `step_id`, and
/// completes it with `text` (recorded as data when it is a JSON object).
fn finish_native(run: &mut Run, step_id: &str, text: &str) {
    let revision = run.revision();
    let session = format!("{step_id}-session");
    let launch = Coordinator::dispatch_next(
        run,
        revision,
        NativeExecutionReference {
            id: session.clone(),
        },
    )
    .expect("dispatches")
    .expect("a native step is ready");
    assert_eq!(launch.step_id, step_id);
    Coordinator::complete_checked_task(
        run,
        launch.run_revision,
        &launch.step_id,
        launch.task_revision,
        &session,
        CompletionOutcome::Succeeded {
            result_reference: Some(reference(&session)),
        },
        Some(text),
    )
    .expect("completes");
}

fn lease_test(run: &mut Run) -> PipelineStepLease {
    let revision = run.revision();
    Coordinator::lease_next_pipeline_step(run, revision, "lease-test".into())
        .expect("leases")
        .expect("a ready sub-pipeline step")
}

fn dispatch(run: &mut Run, lease: &PipelineStepLease) {
    let revision = run.revision();
    Coordinator::dispatch_leased_script(
        run,
        revision,
        &lease.step_id,
        lease.task_revision,
        &lease.lease_id,
        NativeExecutionReference {
            id: "child-run".into(),
        },
    )
    .expect("dispatches under the child run id");
}

fn complete(run: &mut Run, completion: PipelineCompletion) {
    let revision = run.revision();
    let task_revision = task(run, "test").revision();
    Coordinator::complete_pipeline_task(
        run,
        revision,
        "test",
        task_revision,
        "child-run",
        completion,
    )
    .expect("records the child's end");
}

fn dispatched_parent() -> Run {
    let mut run = started(parent()).expect("run");
    finish_native(&mut run, "collect", r#"{"count":3}"#);
    let lease = lease_test(&mut run);
    dispatch(&mut run, &lease);
    run
}

fn data(value: Value) -> Option<Map<String, Value>> {
    value.as_object().cloned()
}

#[test]
fn contract_shapes_round_trip_and_older_data_is_unchanged() {
    let value = parent();
    let decoded = snapshot(value.clone());
    let encoded = serde_json::to_value(&decoded).expect("encodes");
    assert_eq!(
        encoded["pipeline"]["steps"][1]["executor"],
        value["pipeline"]["steps"][1]["executor"]
    );
    assert_eq!(encoded["pipeline"]["outputs"], value["pipeline"]["outputs"]);
    let step = &decoded.pipeline.steps[1];
    assert!(step.is_pipeline() && step.is_host_executed());
    assert!(!step.is_script() && !step.is_plugin());
    assert_eq!(step.executor_kind(), ExecutorKind::Pipeline);

    // A pipeline stored before v6.7 has no outputs and writes none.
    let mut older = child();
    older["pipeline"]
        .as_object_mut()
        .expect("pipeline")
        .remove("outputs");
    let encoded = serde_json::to_value(snapshot(older.clone())).expect("encodes");
    assert_eq!(
        encoded,
        serde_json::to_value(snapshot(older)).expect("same")
    );
    assert!(encoded["pipeline"].get("outputs").is_none());

    let trigger = json!({
        "kind": "pipeline", "parentRunId": "parent", "parentStepId": "test",
        "launchCommandId": "testing", "depth": 1
    });
    let decoded: RunTrigger = serde_json::from_value(trigger.clone()).expect("trigger decodes");
    assert_eq!(serde_json::to_value(&decoded).expect("encodes"), trigger);
    assert!(decoded.is_valid());
    assert_eq!(decoded.pipeline_parent(), Some(("parent", "test")));
    assert_eq!(decoded.subpipeline_depth(), 1);
    assert_eq!(decoded.chain_depth(), 0);
    assert_eq!(decoded.schedule_id(), None);
    for depth in [0, MAX_SUBPIPELINE_DEPTH + 1] {
        let mut invalid = trigger.clone();
        invalid["depth"] = json!(depth);
        let invalid: RunTrigger = serde_json::from_value(invalid).expect("decodes");
        assert!(!invalid.is_valid(), "depth {depth} is refused");
    }
    let mut unknown = trigger;
    unknown["chainDepth"] = json!(0);
    assert!(serde_json::from_value::<RunTrigger>(unknown).is_err());

    let mut unknown = parent();
    unknown["pipeline"]["steps"][1]["executor"]["inputs"]["strict"]["field"] = json!("x");
    assert!(
        serde_json::from_value::<RunDefinitionSnapshot>(unknown).is_err(),
        "unknown source fields are refused, never dropped"
    );
    assert!(started(parent()).is_ok());
}

#[test]
fn definition_rules_refuse_bad_sub_pipeline_steps() {
    let rules: [(&str, Value); 11] = [
        ("/pipeline/steps/1/executor/launchCommandId", json!(" ")),
        (
            "/pipeline/steps/1/executor/inputs/Bad-Name",
            json!({"kind": "value", "value": 1}),
        ),
        (
            "/pipeline/steps/1/executor/inputs/strict",
            json!({"kind": "value", "value": {"a": 1}}),
        ),
        (
            "/pipeline/steps/1/executor/inputs/branch",
            json!({"kind": "input", "name": "undeclared"}),
        ),
        (
            "/pipeline/steps/1/executor/inputs/notes",
            json!({"kind": "step", "stepId": "report"}),
        ),
        (
            "/pipeline/steps/1/executor/inputs/count",
            json!({"kind": "step", "stepId": "collect", "field": " "}),
        ),
        (
            "/pipeline/steps/1/inputBindings",
            json!([{ "sourceStepId": "collect", "field": "count", "name": "x" }]),
        ),
        ("/pipeline/steps/1/assignedMemberId", json!("collector")),
        ("/pipeline/steps/1/executionMode", json!("callable")),
        (
            "/pipeline/steps/1/router",
            json!({"mode": "agent", "inputStepId": "collect", "branches": [], "selectionField": "x"}),
        ),
        (
            "/pipeline/steps/1/executor/inputs",
            Value::Object(
                (0..=MAX_SUBPIPELINE_INPUTS)
                    .map(|index| {
                        (
                            format!("i{index}"),
                            json!({"kind": "value", "value": index}),
                        )
                    })
                    .collect(),
            ),
        ),
    ];
    for (pointer, replacement) in rules {
        let mut value = parent();
        if let Some((parent, key)) = pointer.rsplit_once('/') {
            value
                .pointer_mut(parent)
                .and_then(Value::as_object_mut)
                .expect(parent)
                .insert(key.to_owned(), replacement);
        }
        assert!(started(value).is_err(), "{pointer} must be refused");
    }
}

#[test]
fn definition_rules_refuse_bad_outputs() {
    let outputs = [
        json!([{"name": "Bad", "kind": "text", "sourceStepId": "report"}]),
        json!([
            {"name": "same", "kind": "text", "sourceStepId": "report"},
            {"name": "same", "kind": "text", "sourceStepId": "collect"}
        ]),
        json!([{"name": "gone", "kind": "text", "sourceStepId": "missing"}]),
        json!([{"name": "count", "kind": "text", "sourceStepId": "collect", "field": "count"}]),
        json!([{"name": "other", "kind": "text", "sourceStepId": "collect", "field": "other"}]),
        json!([{"name": "whole", "kind": "number", "sourceStepId": "report"}]),
        json!([{"name": "empty", "kind": "text", "sourceStepId": "report", "field": ""}]),
        Value::Array(
            (0..=MAX_PIPELINE_OUTPUTS)
                .map(|index| json!({"name": format!("o{index}"), "kind": "text", "sourceStepId": "report"}))
                .collect(),
        ),
    ];
    for outputs in outputs {
        let mut value = parent();
        value["pipeline"]["outputs"] = outputs.clone();
        assert!(started(value).is_err(), "{outputs} must be refused");
    }
    // A step without declared fields may name any field of its data.
    let mut value = parent();
    value["pipeline"]["outputs"] =
        json!([{"name": "free", "kind": "number", "sourceStepId": "report", "field": "anything"}]);
    assert!(started(value).is_ok());
    // A callable role is never an output source.
    let mut value = parent();
    value["pipeline"]["steps"]
        .as_array_mut()
        .expect("steps")
        .push(
            json!({"id": "helper", "name": "Helper", "assignedMemberId": "reporter",
            "instructions": "Help.", "executionMode": "callable", "dependencyStepIds": []}),
        );
    value["pipeline"]["outputs"] =
        json!([{"name": "help", "kind": "text", "sourceStepId": "helper"}]);
    assert!(started(value).is_err());
}

#[test]
fn leasing_is_executor_specific_and_carries_the_frozen_mapping() {
    let mut run = started(parent()).expect("run");
    let revision = run.revision();
    assert!(matches!(
        Coordinator::lease_next_pipeline_step(&mut run, revision, "lease".into()),
        Err(CoordinatorError::ExecutorMismatch { .. })
    ));
    finish_native(&mut run, "collect", r#"{"count":3}"#);
    let revision = run.revision();
    for result in [
        Coordinator::lease_next_script(&mut run, revision, "lease".into()).map(|_| ()),
        Coordinator::lease_next_plugin_step(&mut run, revision, "lease".into()).map(|_| ()),
        Coordinator::lease_next_task(&mut run, revision, "lease".into()).map(|_| ()),
    ] {
        assert!(matches!(
            result,
            Err(CoordinatorError::ExecutorMismatch { .. })
        ));
    }
    let lease = lease_test(&mut run);
    assert_eq!(lease.launch_command_id, "testing");
    assert_eq!(lease.step_name, "Test");
    assert_eq!(lease.sources.len(), 5);
    assert_eq!(lease.run_inputs.get("branch"), Some(&json!("main")));
    assert_eq!(lease.dependencies.len(), 1);
    assert_eq!(lease.dependencies[0].data, Some(json!({"count": 3})));
    assert!(lease.dependencies[0].reference.is_some());
    assert_eq!(lease.task_revision, task(&run, "test").revision());
    assert_eq!(
        lease.child_trigger(),
        Ok(RunTrigger::Pipeline {
            parent_run_id: "run".into(),
            parent_step_id: "test".into(),
            launch_command_id: "testing".into(),
            depth: 1,
        })
    );
    let mut deep = lease.clone();
    deep.parent_trigger = Some(RunTrigger::Pipeline {
        parent_run_id: "above".into(),
        parent_step_id: "step".into(),
        launch_command_id: "other".into(),
        depth: MAX_SUBPIPELINE_DEPTH,
    });
    assert_eq!(deep.child_trigger(), Err(SUBPIPELINE_DEPTH));
    assert_eq!(HostStepLease::lease_id(&lease), "lease-test");
}

#[test]
fn declared_outputs_become_checked_result_data_for_native_dependents() {
    let mut run = dispatched_parent();
    assert_eq!(task(&run, "test").status(), TaskStatus::Running);
    assert_eq!(
        task(&run, "test")
            .execution()
            .map(|execution| execution.id.as_str()),
        Some("child-run")
    );
    let revision = run.revision();
    let task_revision = task(&run, "test").revision();
    assert!(matches!(
        Coordinator::complete_script_task(
            &mut run.clone(),
            revision,
            "test",
            task_revision,
            "child-run",
            ScriptCompletion::Failed {
                failure: FailureRecord::new("x")
            },
        ),
        Err(CoordinatorError::ExecutorMismatch { .. })
    ));
    assert!(matches!(
        Coordinator::complete_task(
            &mut run.clone(),
            revision,
            "test",
            task_revision,
            "child-run",
            CompletionOutcome::Succeeded {
                result_reference: None
            },
        ),
        Err(CoordinatorError::ExecutorMismatch { .. })
    ));
    complete(
        &mut run,
        PipelineCompletion::Succeeded {
            data: data(json!({"passed": true, "report": "all green"})),
            text: None,
        },
    );
    let test = task(&run, "test");
    assert_eq!(test.status(), TaskStatus::Succeeded);
    assert_eq!(
        test.result_data(),
        Some(&json!({"passed": true, "report": "all green"}))
    );
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference {
            id: "report-session".into(),
        },
    )
    .expect("dispatches")
    .expect("report is ready");
    assert_eq!(launch.step_id, "report");
    assert_eq!(launch.dependency_outputs.len(), 1);
    assert_eq!(launch.dependency_outputs[0].step_id, "test");
}

#[test]
fn results_are_checked_like_script_output_and_failures_are_recorded() {
    // Declared fields are checked exactly like a script's JSON.
    let mut run = dispatched_parent();
    complete(
        &mut run,
        PipelineCompletion::Succeeded {
            data: data(json!({"passed": "yes"})),
            text: None,
        },
    );
    assert_eq!(
        task(&run, "test")
            .failure()
            .map(|failure| failure.code.as_str()),
        Some("result-field-type")
    );
    assert_eq!(run.status(), RunStatus::Failed);

    // A text result that is one JSON object becomes data.
    let mut run = dispatched_parent();
    complete(
        &mut run,
        PipelineCompletion::Succeeded {
            data: None,
            text: Some(r#"{"passed":false}"#.into()),
        },
    );
    assert_eq!(
        task(&run, "test").result_data(),
        Some(&json!({"passed": false}))
    );

    // Plain text cannot satisfy declared fields.
    let mut run = dispatched_parent();
    complete(
        &mut run,
        PipelineCompletion::Succeeded {
            data: None,
            text: Some("done".into()),
        },
    );
    assert_eq!(
        task(&run, "test")
            .failure()
            .map(|failure| failure.code.as_str()),
        Some("result-invalid-json")
    );

    // Without declared fields plain text is the recorded output.
    let mut value = parent();
    value["pipeline"]["steps"][1]
        .as_object_mut()
        .expect("step")
        .remove("resultFields");
    value["pipeline"]["outputs"] = json!([]);
    let mut run = started(value).expect("run");
    finish_native(&mut run, "collect", r#"{"count":3}"#);
    let lease = lease_test(&mut run);
    dispatch(&mut run, &lease);
    complete(
        &mut run,
        PipelineCompletion::Succeeded {
            data: None,
            text: Some("done".into()),
        },
    );
    let test = task(&run, "test");
    assert_eq!(test.status(), TaskStatus::Succeeded);
    assert_eq!(
        test.output().map(|output| output.text.as_str()),
        Some("done")
    );

    // A child failure is a certain failure of the step with its detail.
    let mut run = dispatched_parent();
    complete(
        &mut run,
        PipelineCompletion::Failed {
            failure: FailureRecord::with_detail(SUBPIPELINE_FAILED, "step \"unit\" failed"),
        },
    );
    let test = task(&run, "test");
    assert_eq!(test.status(), TaskStatus::Failed);
    assert_eq!(
        test.failure().map(|failure| failure.code.as_str()),
        Some(SUBPIPELINE_FAILED)
    );
    assert_eq!(task(&run, "report").status(), TaskStatus::Cancelled);

    // A stale child id is never recorded.
    let mut run = dispatched_parent();
    let revision = run.revision();
    let task_revision = task(&run, "test").revision();
    assert!(matches!(
        Coordinator::complete_pipeline_task(
            &mut run,
            revision,
            "test",
            task_revision,
            "other-run",
            PipelineCompletion::Failed {
                failure: FailureRecord::new(SUBPIPELINE_CANCELLED)
            },
        ),
        Err(CoordinatorError::StaleExecution { .. })
    ));
}

#[test]
fn a_restart_keeps_a_dispatched_step_running_and_a_lease_becomes_uncertain() {
    let mut run = dispatched_parent();
    assert!(!Coordinator::needs_restore(&run));
    let revision = run.revision();
    Coordinator::restore(&mut run, revision).expect("restores");
    assert_eq!(run.revision(), revision, "nothing changed");
    assert_eq!(task(&run, "test").status(), TaskStatus::Running);
    assert_eq!(run.status(), RunStatus::Running);

    let mut run = started(parent()).expect("run");
    finish_native(&mut run, "collect", r#"{"count":3}"#);
    lease_test(&mut run);
    assert!(Coordinator::needs_restore(&run));
    let revision = run.revision();
    Coordinator::restore(&mut run, revision).expect("restores");
    assert_eq!(task(&run, "test").status(), TaskStatus::Uncertain);
    assert_eq!(run.status(), RunStatus::Uncertain);
}

#[test]
fn child_inputs_come_from_values_run_inputs_and_dependency_results() {
    let mut run = started(parent()).expect("run");
    finish_native(&mut run, "collect", r#"{"count":3}"#);
    let mut lease = lease_test(&mut run);
    // The host resolved the native text of `collect` (hash-verified).
    lease.dependencies[0].text = Some("collected".into());
    let values = resolve_child_inputs(&lease.sources, &lease.run_inputs, &lease.dependencies)
        .expect("resolves");
    assert_eq!(values.get("branch"), Some(&json!("main")));
    assert_eq!(values.get("ticket"), None, "an unset run input is left out");
    assert_eq!(values.get("notes"), Some(&json!("collected")));
    assert_eq!(values.get("count"), Some(&json!(3)));
    assert_eq!(values.get("strict"), Some(&json!(true)));

    let mut without_text = lease.clone();
    without_text.dependencies[0].text = None;
    let values = resolve_child_inputs(
        &without_text.sources,
        &without_text.run_inputs,
        &without_text.dependencies,
    )
    .expect("resolves");
    assert_eq!(values.get("notes"), Some(&json!(r#"{"count":3}"#)));

    let mut missing = lease.clone();
    missing.dependencies[0].data = Some(json!({"other": 1}));
    assert_eq!(
        resolve_child_inputs(&missing.sources, &missing.run_inputs, &missing.dependencies),
        Err(SUBPIPELINE_INPUT_UNAVAILABLE)
    );
    missing.dependencies.clear();
    assert_eq!(
        resolve_child_inputs(&missing.sources, &missing.run_inputs, &missing.dependencies),
        Err(SUBPIPELINE_INPUT_UNAVAILABLE)
    );

    // The child's own declarations then decide.
    let declared: Vec<PipelineInput> = serde_json::from_value(json!([
        {"name": "count", "label": "Count", "kind": "text"}
    ]))
    .expect("inputs");
    let mut only_count = BTreeMap::new();
    only_count.insert("count".to_owned(), json!(3));
    assert!(resolve_run_inputs(&declared, &only_count).is_err());
}

fn succeeded_child() -> Run {
    let mut run = Coordinator::new_triggered_run(
        "child-run",
        snapshot(child()),
        BTreeMap::new(),
        Some(RunTrigger::Pipeline {
            parent_run_id: "run".into(),
            parent_step_id: "test".into(),
            launch_command_id: "testing".into(),
            depth: 1,
        }),
    )
    .expect("child run");
    finish_native(&mut run, "summary", "All green.");
    finish_native(&mut run, "unit", r#"{"passed":true}"#);
    assert_eq!(run.status(), RunStatus::Succeeded);
    run
}

#[test]
fn a_succeeded_child_projects_its_declared_outputs() {
    let run = succeeded_child();
    let references = child_output_references(&run);
    assert_eq!(references.len(), 1);
    assert_eq!(references[0].0, "summary");
    assert!(references[0].1.fields.is_empty());

    let mut texts = BTreeMap::new();
    assert_eq!(
        child_outputs(&run, &texts),
        Err(SUBPIPELINE_OUTPUT_UNAVAILABLE),
        "an unread native text is unavailable, never guessed"
    );
    texts.insert("summary".to_owned(), "All green.".to_owned());
    assert_eq!(
        child_completion(&run, &texts),
        Some(PipelineCompletion::Succeeded {
            data: data(json!({"passed": true, "report": "All green."})),
            text: None,
        })
    );

    texts.insert("summary".to_owned(), "   ".to_owned());
    assert_eq!(
        child_outputs(&run, &texts),
        Err(SUBPIPELINE_OUTPUT_UNAVAILABLE),
        "a text output is not blank"
    );

    // Without declared outputs the last succeeded step's text is the result.
    let mut value = child();
    value["pipeline"]
        .as_object_mut()
        .expect("pipeline")
        .remove("outputs");
    let mut run = Coordinator::new_run("child-run", snapshot(value)).expect("child run");
    finish_native(&mut run, "summary", "All green.");
    finish_native(&mut run, "unit", r#"{"passed":true}"#);
    let references = child_output_references(&run);
    assert_eq!(references.len(), 1);
    assert_eq!(references[0].0, "unit");
    assert_eq!(
        child_outputs(&run, &BTreeMap::new()),
        Ok((None, Some(r#"{"passed":true}"#.to_owned())))
    );
}

#[test]
fn a_failed_cancelled_or_running_child_maps_to_the_parent_outcome() {
    let mut run = Coordinator::new_run("child-run", snapshot(child())).expect("child run");
    assert_eq!(child_completion(&run, &BTreeMap::new()), None);

    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference {
            id: "summary-session".into(),
        },
    )
    .expect("dispatches")
    .expect("ready");
    Coordinator::complete_task(
        &mut run,
        launch.run_revision,
        &launch.step_id,
        launch.task_revision,
        "summary-session",
        CompletionOutcome::Failed {
            failure: FailureRecord::with_detail("harness-failed", "boom"),
        },
    )
    .expect("fails");
    assert_eq!(run.status(), RunStatus::Failed);
    let Some(PipelineCompletion::Failed { failure }) = child_completion(&run, &BTreeMap::new())
    else {
        panic!("a failed child fails the step");
    };
    assert_eq!(failure.code, SUBPIPELINE_FAILED);
    assert_eq!(
        failure.detail.as_deref(),
        Some("step \"summary\" failed (harness-failed): boom")
    );

    let mut run = Coordinator::new_run("child-run", snapshot(child())).expect("child run");
    let revision = run.revision();
    Coordinator::cancel_run(&mut run, revision).expect("cancels");
    assert_eq!(
        child_completion(&run, &BTreeMap::new()),
        Some(PipelineCompletion::Failed {
            failure: FailureRecord::new(SUBPIPELINE_CANCELLED)
        })
    );
}

#[test]
fn reference_cycles_and_ancestors_are_found() {
    let pipeline = |id: &str, commands: &[&str]| -> PipelineDefinition {
        let mut steps = vec![
            json!({"id": "entry", "name": "Entry", "assignedMemberId": "a",
            "instructions": "", "dependencyStepIds": []}),
        ];
        for (index, command) in commands.iter().enumerate() {
            steps.push(json!({"id": format!("sub{index}"), "name": "Sub", "assignedMemberId": format!("sub{index}"),
                "instructions": "", "executor": {"type": "pipeline", "launchCommandId": command, "inputs": {}},
                "dependencyStepIds": []}));
        }
        serde_json::from_value(json!({"id": id, "name": id, "steps": steps})).expect("pipeline")
    };
    let development = pipeline("development", &["testing", "lint"]);
    let testing = pipeline("testing", &["lint"]);
    let lint = pipeline("lint", &[]);
    assert_eq!(
        referenced_launch_commands(&development),
        vec!["lint".to_owned(), "testing".to_owned()]
    );
    let acyclic: BTreeMap<&str, &PipelineDefinition> = [
        ("development", &development),
        ("testing", &testing),
        ("lint", &lint),
    ]
    .into_iter()
    .collect();
    for start in ["development", "testing", "lint", "missing"] {
        assert!(!subpipeline_cycle(start, |id| acyclic.get(id).copied()));
    }
    let looping = pipeline("lint", &["development"]);
    let cyclic: BTreeMap<&str, &PipelineDefinition> = [
        ("development", &development),
        ("testing", &testing),
        ("lint", &looping),
    ]
    .into_iter()
    .collect();
    assert!(subpipeline_cycle("development", |id| cyclic
        .get(id)
        .copied()));
    assert!(subpipeline_cycle("testing", |id| cyclic.get(id).copied()));
    let own = pipeline("self", &["self"]);
    assert!(subpipeline_cycle("self", |id| (id == "self").then_some(&own)));

    let mut top_value = parent();
    top_value["launchCommand"] = json!({"id": "develop", "name": "Develop",
        "teamId": "team", "pipelineId": "development"});
    let top = Coordinator::new_run_with_inputs("run", snapshot(top_value), BTreeMap::new())
        .expect("top run");
    let middle = succeeded_child();
    let runs = [top, middle];
    let ancestors = ancestor_launch_commands(&runs[1], |id| runs.iter().find(|run| run.id() == id));
    assert_eq!(ancestors, vec!["testing".to_owned(), "develop".to_owned()]);
}
