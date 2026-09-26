//! Pinned step outputs (orchestration v6.3): validation, admission without
//! launching, the dependency hand-off and stored-data compatibility.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::*;

const PINNED_AT: &str = "2026-09-27T10:00:00Z";

fn pin(text: &str) -> Value {
    json!({"text": text, "pinnedAt": PINNED_AT, "sourceRunId": "run-old"})
}

/// agent `plan` (pinned) → script `metrics` → llm `summary`.
fn chain() -> Value {
    json!({
        "profiles": [
            {"id": "worker", "name": "Worker", "harness": "codex", "model": "model", "permissionMode": "workspace-write", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []},
            {"id": "caller", "name": "Caller", "harness": "pi", "model": "model", "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}
        ],
        "team": {"id": "team", "name": "Team", "members": [
            {"id": "planner", "profileId": "worker"},
            {"id": "summarizer", "profileId": "caller"}
        ], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "planner"},
        "pipeline": {"id": "pipeline", "name": "Pipeline", "steps": [
            {"id": "plan", "name": "Plan", "assignedMemberId": "planner", "instructions": "Plan.", "dependencyStepIds": [],
             "pinnedOutput": pin("The pinned plan")},
            {"id": "metrics", "name": "Metrics", "assignedMemberId": "metrics", "instructions": "",
             "executor": {"type": "script", "runtime": "node", "source": "console.log('{}')", "timeoutSeconds": 30},
             "resultFields": [{"name": "files", "kind": "number"}],
             "dependencyStepIds": ["plan"]},
            {"id": "summary", "name": "Summary", "assignedMemberId": "summarizer", "instructions": "Summarize.",
             "executor": {"type": "llm"},
             "inputBindings": [{"sourceStepId": "metrics", "field": "files", "name": "fileCount"}],
             "dependencyStepIds": ["metrics"]}
        ]}
    })
}

/// agent `writer` (pinned) → agent `reviewer` that retries from the writer.
fn review_loop() -> Value {
    json!({
        "profiles": [
            {"id": "worker", "name": "Worker", "harness": "codex", "model": "model", "permissionMode": "workspace-write", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}
        ],
        "team": {"id": "team", "name": "Team", "members": [
            {"id": "writer", "profileId": "worker"},
            {"id": "reviewer", "profileId": "worker"}
        ], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "writer"},
        "pipeline": {"id": "pipeline", "name": "Pipeline", "steps": [
            {"id": "writer", "name": "Writer", "assignedMemberId": "writer", "instructions": "Write.", "dependencyStepIds": [],
             "pinnedOutput": pin("Draft one")},
            {"id": "reviewer", "name": "Reviewer", "assignedMemberId": "reviewer", "instructions": "Review.",
             "review": {"field": "approved", "retryFromStepId": "writer"},
             "resultFields": [{"name": "approved", "kind": "boolean"}],
             "dependencyStepIds": ["writer"]}
        ]}
    })
}

fn snapshot(value: Value) -> RunDefinitionSnapshot {
    serde_json::from_value(value).expect("snapshot decodes")
}

fn with_pins(value: Value) -> Run {
    Coordinator::new_run_with_options(
        "run",
        snapshot(value),
        BTreeMap::new(),
        RunOptions {
            use_pinned_data: true,
        },
    )
    .expect("run starts with pinned data")
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

fn pinned_error(value: Value) -> &'static str {
    match validate_definition(&snapshot(value)) {
        Err(DefinitionError::InvalidPinnedOutput { reason, .. }) => reason,
        other => panic!("expected a pinned data error, got {other:?}"),
    }
}

fn round_trip(run: &Run) -> Run {
    deserialize_run(&serialize_run(run).expect("serializes")).expect("stored run loads")
}

#[test]
fn pinned_json_is_additive_exact_and_strict() {
    let steps = snapshot(chain()).pipeline.steps;
    assert_eq!(
        steps[0].pinned_output,
        Some(PinnedOutput {
            text: Some("The pinned plan".into()),
            truncated: false,
            data: None,
            pinned_at: PINNED_AT.into(),
            source_run_id: Some("run-old".into()),
        })
    );
    assert_eq!(
        serde_json::to_value(&steps[0]).expect("encodes")["pinnedOutput"],
        pin("The pinned plan")
    );
    // A step without pins keeps its exact v6.2 shape.
    assert!(
        serde_json::to_value(&steps[1])
            .expect("encodes")
            .get("pinnedOutput")
            .is_none()
    );
    for rejected in [
        json!({"text": "x", "pinnedAt": PINNED_AT, "author": "someone"}),
        json!({"text": "x"}),
        json!({"text": 3, "pinnedAt": PINNED_AT}),
    ] {
        assert!(
            serde_json::from_value::<PinnedOutput>(rejected.clone()).is_err(),
            "{rejected}"
        );
    }
    // Older task records and runs load unchanged and re-encode identically.
    let old_task =
        json!({"stepId": "plan", "status": "succeeded", "revision": 2, "execution": {"id": "s"}});
    let decoded: TaskRecord = serde_json::from_value(old_task.clone()).expect("loads");
    assert!(!decoded.pinned());
    assert_eq!(serde_json::to_value(&decoded).expect("encodes"), old_task);
    let mut legacy = chain();
    legacy["pipeline"]["steps"][0]
        .as_object_mut()
        .expect("step")
        .remove("pinnedOutput");
    let run = Coordinator::new_run("old", snapshot(legacy)).expect("starts");
    let bytes = serialize_run(&run).expect("serializes");
    let stored: Value = serde_json::from_slice(&bytes).expect("json");
    assert!(stored.get("usePinnedData").is_none());
    assert!(stored["tasks"][0].get("pinned").is_none());
    let loaded = deserialize_run(&bytes).expect("loads");
    assert!(!loaded.use_pinned_data());
    assert_eq!(serialize_run(&loaded).expect("serializes"), bytes);
}

#[test]
fn pins_are_refused_where_they_could_never_apply_or_are_unbounded() {
    validate_definition(&snapshot(chain())).expect("a pinned agent step validates");
    let patched = |patch: fn(&mut Value)| {
        let mut value = chain();
        patch(&mut value["pipeline"]["steps"][0]);
        value
    };
    assert_eq!(
        pinned_error(patched(
            |step| step["pinnedOutput"] = json!({"pinnedAt": PINNED_AT})
        )),
        "pinned data needs text or a result"
    );
    assert_eq!(
        pinned_error(patched(|step| {
            step["pinnedOutput"] =
                json!({"text": "x".repeat(MAX_PINNED_TEXT_BYTES + 1), "pinnedAt": PINNED_AT});
        })),
        "pinned text is larger than 256 KiB"
    );
    assert_eq!(
        pinned_error(patched(|step| {
            step["pinnedOutput"] = json!({"data": [1, 2], "pinnedAt": PINNED_AT});
        })),
        "a pinned result is a JSON object"
    );
    assert_eq!(
        pinned_error(patched(|step| {
            step["pinnedOutput"] =
                json!({"data": {"text": "x".repeat(MAX_PINNED_DATA_BYTES)}, "pinnedAt": PINNED_AT});
        })),
        "a pinned result is larger than 256 KiB"
    );
    assert_eq!(
        pinned_error(patched(|step| {
            step["pinnedOutput"] = json!({"data": {}, "truncated": true, "pinnedAt": PINNED_AT});
        })),
        "only pinned text can be marked as cut"
    );
    assert_eq!(
        pinned_error(patched(
            |step| step["pinnedOutput"]["pinnedAt"] = json!("  ")
        )),
        "pinned data needs the time it was pinned"
    );
    assert_eq!(
        pinned_error(patched(
            |step| step["pinnedOutput"]["sourceRunId"] = json!("")
        )),
        "the source run of pinned data is invalid"
    );
    let mut callable = chain();
    callable["pipeline"]["steps"]
        .as_array_mut()
        .expect("steps")
        .push(json!({
            "id": "helper", "name": "Helper", "assignedMemberId": "planner", "instructions": "Help.",
            "executionMode": "callable", "dependencyStepIds": [], "pinnedOutput": pin("Help")
        }));
    assert_eq!(
        pinned_error(callable),
        "a callable role runs only when an agent calls it; it cannot be pinned"
    );
    let mut reviewer = review_loop();
    reviewer["pipeline"]["steps"][1]["pinnedOutput"] = pin("{\"approved\": true}");
    assert_eq!(
        pinned_error(reviewer),
        "a reviewing step always runs: a pinned verdict would repeat the same round"
    );
    // Five steps of 250 KiB each exceed the pipeline's 1 MiB bound.
    let mut large = chain();
    let text = "x".repeat(250 * 1024);
    let steps = large["pipeline"]["steps"].as_array_mut().expect("steps");
    let template = steps[0].clone();
    for index in 0..5 {
        let mut step = template.clone();
        step["id"] = json!(format!("copy-{index}"));
        step["pinnedOutput"] = json!({"text": text, "pinnedAt": PINNED_AT});
        steps.push(step);
    }
    assert_eq!(
        pinned_error(large),
        "pinned data of a pipeline is larger than 1 MiB"
    );
    // The same rule guards a single saved pipeline.
    let mut declared = snapshot(chain()).pipeline;
    declared.steps[0].execution_mode = Some(ExecutionMode::Callable);
    assert!(matches!(
        validate_pipeline_declarations(&declared),
        Err(DefinitionError::InvalidPinnedOutput { .. })
    ));
}

#[test]
fn a_run_without_pinned_data_freezes_no_pins_and_runs_every_step() {
    let mut run = Coordinator::new_run("run", snapshot(chain())).expect("starts");
    assert!(!run.use_pinned_data());
    assert!(
        run.definition()
            .pipeline
            .steps
            .iter()
            .all(|step| step.pinned_output.is_none())
    );
    Coordinator::advance_automatic_steps(&mut run);
    assert_eq!(task(&run, "plan").status(), TaskStatus::Ready);
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference { id: "s1".into() },
    )
    .expect("dispatches")
    .expect("the plan runs natively");
    assert_eq!(launch.step_id, "plan");
    // Using pinned data needs something pinned: never a silent full run.
    let mut plain = chain();
    plain["pipeline"]["steps"][0]
        .as_object_mut()
        .expect("step")
        .remove("pinnedOutput");
    assert_eq!(
        Coordinator::new_run_with_options(
            "run",
            snapshot(plain),
            BTreeMap::new(),
            RunOptions {
                use_pinned_data: true
            },
        )
        .err(),
        Some(CoordinatorError::NoPinnedData)
    );
}

#[test]
fn pinned_steps_are_admitted_without_launching_and_feed_downstream_steps() {
    let mut run = with_pins(chain());
    assert!(run.use_pinned_data());
    assert_eq!(task(&run, "plan").status(), TaskStatus::Ready);
    Coordinator::advance_automatic_steps(&mut run);
    let plan = task(&run, "plan");
    assert_eq!(plan.status(), TaskStatus::Succeeded);
    assert!(plan.pinned());
    assert!(plan.execution().is_none());
    assert!(plan.result_reference().is_none());
    assert_eq!(
        plan.output().map(|output| output.text.as_str()),
        Some("The pinned plan")
    );
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["metrics"]);
    // The script reads the pinned text where a native result would be.
    let revision = run.revision();
    let lease = Coordinator::lease_next_script(&mut run, revision, "lease".into())
        .expect("leases")
        .expect("the script is next");
    assert_eq!(lease.dependencies.len(), 1);
    assert_eq!(lease.dependencies[0].reference, None);
    assert_eq!(
        lease.dependencies[0].text.as_deref(),
        Some("The pinned plan")
    );
    assert_eq!(
        lease.stdin_document()["dependencies"]["plan"]["text"],
        json!("The pinned plan")
    );
    // A stored run with pinned tasks loads and keeps them exactly.
    let loaded = round_trip(&run);
    assert_eq!(loaded, run);
    let stored = serde_json::to_value(&run).expect("json");
    assert_eq!(stored["usePinnedData"], json!(true));
    assert_eq!(stored["tasks"][0]["pinned"], json!(true));
}

#[test]
fn a_native_step_receives_pinned_output_through_the_dependency_path() {
    let mut value = review_loop();
    // Without a review, the second agent simply consumes the pinned draft.
    let reviewer = value["pipeline"]["steps"][1].as_object_mut().expect("step");
    reviewer.remove("review");
    reviewer.remove("resultFields");
    let mut run = with_pins(value);
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference { id: "s1".into() },
    )
    .expect("dispatches")
    .expect("the reviewer runs");
    assert_eq!(launch.step_id, "reviewer");
    assert!(launch.dependency_result_references.is_empty());
    assert_eq!(launch.dependency_outputs.len(), 1);
    assert_eq!(launch.dependency_outputs[0].step_id, "writer");
    assert_eq!(
        launch.dependency_outputs[0].context_text().as_deref(),
        Ok("Draft one")
    );
}

#[test]
fn pinned_data_meets_the_result_contract_or_fails_certainly() {
    let mut value = chain();
    value["pipeline"]["steps"][0]["resultFields"] = json!([{"name": "files", "kind": "number"}]);
    value["pipeline"]["steps"][0]["pinnedOutput"] =
        json!({"data": {"files": "3"}, "pinnedAt": PINNED_AT});
    let mut run = with_pins(value.clone());
    Coordinator::advance_automatic_steps(&mut run);
    let plan = task(&run, "plan");
    assert_eq!(plan.status(), TaskStatus::Failed);
    assert!(plan.pinned());
    assert_eq!(
        plan.failure().map(|failure| failure.code.as_str()),
        Some("result-field-type")
    );
    assert_eq!(task(&run, "metrics").status(), TaskStatus::Cancelled);
    assert_eq!(run.status(), RunStatus::Failed);
    round_trip(&run);
    // Complete text that is one JSON object is the result, like a native answer.
    value["pipeline"]["steps"][0]["pinnedOutput"] =
        json!({"text": "{\"files\": 3}", "pinnedAt": PINNED_AT});
    let mut run = with_pins(value.clone());
    Coordinator::advance_automatic_steps(&mut run);
    assert_eq!(task(&run, "plan").status(), TaskStatus::Succeeded);
    assert_eq!(task(&run, "plan").result_data(), Some(&json!({"files": 3})));
    // Cut text is never read as JSON.
    value["pipeline"]["steps"][0]["pinnedOutput"] =
        json!({"text": "{\"files\": 3}", "truncated": true, "pinnedAt": PINNED_AT});
    let mut run = with_pins(value);
    Coordinator::advance_automatic_steps(&mut run);
    assert_eq!(
        task(&run, "plan")
            .failure()
            .map(|failure| failure.code.as_str()),
        Some("result-invalid-json")
    );
}

#[test]
fn an_agent_router_selection_from_pinned_data_is_checked() {
    let router: PipelineStep = serde_json::from_value(json!({
        "id": "route", "name": "Route", "assignedMemberId": "planner", "instructions": "", "dependencyStepIds": ["plan"],
        "router": {"mode": "agent", "inputStepId": "plan", "selectionField": "picked", "branches": [
            {"id": "docs", "label": "Docs", "description": "Documentation"},
            {"id": "code", "label": "Code", "description": "Code"}
        ]},
        "resultFields": [{"name": "picked", "kind": "text-list"}]
    }))
    .expect("router step");
    let pinned = |data: Value| PinnedOutput {
        text: None,
        truncated: false,
        data: Some(data),
        pinned_at: PINNED_AT.into(),
        source_run_id: None,
    };
    let (data, output) =
        pinned_result(&router, &pinned(json!({"picked": ["code"]}))).expect("selection");
    assert_eq!(data, Some(json!({"picked": ["code"]})));
    assert_eq!(output, None);
    assert_eq!(
        pinned_result(&router, &pinned(json!({"picked": ["deploy"]}))).err(),
        Some(FailureRecord::new("router-selection-invalid"))
    );
    assert_eq!(pinning_refusal(&router), None);
}

#[test]
fn approval_pause_and_repeat_apply_to_pinned_steps() {
    let mut value = chain();
    value["pipeline"]["steps"][0]["requireApproval"] = json!(true);
    let mut run = with_pins(value);
    // A paused run admits nothing, pinned or not.
    let revision = run.revision();
    Coordinator::control_flow(&mut run, revision, FlowAction::Pause).expect("pauses");
    Coordinator::advance_automatic_steps(&mut run);
    assert_eq!(task(&run, "plan").status(), TaskStatus::Ready);
    let revision = run.revision();
    Coordinator::control_flow(&mut run, revision, FlowAction::Resume).expect("resumes");
    Coordinator::advance_automatic_steps(&mut run);
    let plan = task(&run, "plan");
    assert_eq!(plan.status(), TaskStatus::AwaitingApproval);
    assert!(plan.pinned());
    round_trip(&run);
    let (revision, task_revision) = (run.revision(), plan.revision());
    Coordinator::control_flow(
        &mut run,
        revision,
        FlowAction::Decide {
            step_id: "plan".into(),
            task_revision,
            approved: true,
        },
    )
    .expect("approves");
    assert_eq!(task(&run, "plan").status(), TaskStatus::Succeeded);
    // Run again from the pinned step: it is admitted from its pin again.
    let (revision, task_revision) = (run.revision(), task(&run, "plan").revision());
    Coordinator::control_flow(
        &mut run,
        revision,
        FlowAction::Repeat {
            step_id: "plan".into(),
            task_revision,
        },
    )
    .expect("repeats");
    assert_eq!(task(&run, "plan").status(), TaskStatus::Ready);
    assert!(!task(&run, "plan").pinned());
    assert!(
        run.attempts().is_empty(),
        "a pin is not an executed attempt"
    );
    Coordinator::advance_automatic_steps(&mut run);
    assert_eq!(task(&run, "plan").status(), TaskStatus::AwaitingApproval);
    assert!(task(&run, "plan").pinned());
}

#[test]
fn a_rejected_review_of_pinned_work_waits_for_a_person() {
    let mut run = with_pins(review_loop());
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference { id: "s1".into() },
    )
    .expect("dispatches")
    .expect("the reviewer runs");
    assert_eq!(launch.step_id, "reviewer");
    assert!(task(&run, "writer").pinned());
    Coordinator::complete_checked_task(
        &mut run,
        launch.run_revision,
        "reviewer",
        launch.task_revision,
        "s1",
        CompletionOutcome::Succeeded {
            result_reference: Some(reference("s1")),
        },
        Some(r#"{"approved": false}"#),
    )
    .expect("completes");
    // Another round would repeat the same pinned draft: a person decides.
    let reviewer = task(&run, "reviewer");
    assert_eq!(reviewer.status(), TaskStatus::AwaitingApproval);
    assert_eq!(
        reviewer.failure().map(|failure| failure.code.as_str()),
        Some(REVIEW_RETRY_PINNED)
    );
    assert_eq!(task(&run, "writer").status(), TaskStatus::Succeeded);
    assert_eq!(run.status(), RunStatus::Running);
    round_trip(&run);
    // Without pinned data the same rejection repeats from the writer.
    let mut plain = Coordinator::new_run("plain", snapshot(review_loop())).expect("starts");
    for (execution, text) in [("w1", "Draft"), ("r1", r#"{"approved": false}"#)] {
        let revision = plain.revision();
        let launch = Coordinator::dispatch_next(
            &mut plain,
            revision,
            NativeExecutionReference {
                id: execution.into(),
            },
        )
        .expect("dispatches")
        .expect("ready work");
        Coordinator::complete_checked_task(
            &mut plain,
            launch.run_revision,
            &launch.step_id,
            launch.task_revision,
            execution,
            CompletionOutcome::Succeeded {
                result_reference: Some(reference(execution)),
            },
            Some(text),
        )
        .expect("completes");
    }
    assert_eq!(task(&plain, "writer").status(), TaskStatus::Ready);
}

#[test]
fn agents_cannot_spawn_a_pinned_step() {
    let mut value = review_loop();
    value["profiles"] = json!([
        {"id": "worker", "name": "Worker", "harness": "codex", "model": "model", "permissionMode": "workspace-write", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": ["worker"]}
    ]);
    // Make the reviewer the entry step so it can be running while it asks.
    value["pipeline"]["steps"][1]["dependencyStepIds"] = json!([]);
    let reviewer = value["pipeline"]["steps"][1].as_object_mut().expect("step");
    reviewer.remove("review");
    reviewer.remove("resultFields");
    let mut run = with_pins(value);
    let revision = run.revision();
    assert!(matches!(
        Coordinator::lease_controlled_spawn(
            &mut run,
            revision,
            "reviewer",
            "writer",
            "lease".into()
        ),
        Err(CoordinatorError::Authorization(
            AuthorizationError::StepPinned { .. }
        ))
    ));
}

#[test]
fn stored_pinned_tasks_must_be_consistent() {
    let mut run = with_pins(chain());
    Coordinator::advance_automatic_steps(&mut run);
    let stored = serde_json::to_value(&run).expect("json");
    let tampered = |patch: fn(&mut Value)| {
        let mut value = stored.clone();
        patch(&mut value);
        deserialize_run(&serde_json::to_vec(&value).expect("bytes"))
    };
    assert!(tampered(|_| {}).is_ok());
    assert!(
        tampered(|value| {
            value.as_object_mut().expect("run").remove("usePinnedData");
        })
        .is_err(),
        "a pinned task needs a run that used pinned data"
    );
    assert!(
        tampered(|value| value["tasks"][0]["execution"] = json!({"id": "s1"})).is_err(),
        "a pinned task never ran"
    );
    assert!(
        tampered(|value| {
            value["definition"]["pipeline"]["steps"][0]
                .as_object_mut()
                .expect("step")
                .remove("pinnedOutput");
        })
        .is_err(),
        "a pinned task's step holds its pinned data"
    );
    // Output stays reserved for scripts and pinned tasks.
    assert!(
        tampered(|value| {
            value["tasks"][0]
                .as_object_mut()
                .expect("task")
                .remove("pinned");
        })
        .is_err()
    );
}
