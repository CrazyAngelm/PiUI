//! Step executors (orchestration v6.2): llm one-shot calls and host scripts.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::*;

const SCRIPT_SOURCE: &str = "const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));\nconsole.log(JSON.stringify({files: 3}));";

/// agent `plan` → script `metrics` → llm `summary`, with a run input.
fn fixture() -> Value {
    json!({
        "profiles": [
            {"id": "worker", "name": "Worker", "harness": "codex", "model": "model", "permissionMode": "workspace-write", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []},
            {"id": "caller", "name": "Caller", "harness": "pi", "model": "model", "permissionMode": "read-only", "instructions": "Be brief.",
             "toolPolicy": {"rules": [{"tool": "bash", "decision": "deny", "enforcement": "native", "mandatory": true}]},
             "resourceRules": [{"kind": "skill", "id": "docs", "enabled": false}],
             "allowedSpawnProfileIds": []}
        ],
        "team": {"id": "team", "name": "Team", "members": [
            {"id": "planner", "profileId": "worker"},
            {"id": "summarizer", "profileId": "caller"}
        ], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "planner"},
        "pipeline": {
            "id": "pipeline", "name": "Pipeline",
            "inputs": [{"name": "task", "label": "Task", "kind": "text", "required": true}],
            "steps": [
                {"id": "plan", "name": "Plan", "assignedMemberId": "planner", "instructions": "Plan {{input.task}}.", "dependencyStepIds": []},
                {"id": "metrics", "name": "Metrics", "assignedMemberId": "metrics", "instructions": "Count files.",
                 "executor": {"type": "script", "runtime": "node", "source": SCRIPT_SOURCE, "timeoutSeconds": 30},
                 "resultFields": [{"name": "files", "kind": "number"}],
                 "dependencyStepIds": ["plan"]},
                {"id": "summary", "name": "Summary", "assignedMemberId": "summarizer", "instructions": "Summarize.",
                 "executor": {"type": "llm"},
                 "inputBindings": [{"sourceStepId": "metrics", "field": "files", "name": "fileCount"}],
                 "dependencyStepIds": ["metrics"]}
            ]
        }
    })
}

fn snapshot(value: Value) -> RunDefinitionSnapshot {
    serde_json::from_value(value).expect("snapshot decodes")
}

fn started(value: Value) -> Run {
    Coordinator::new_run_with_inputs(
        "run",
        snapshot(value),
        BTreeMap::from([("task".to_owned(), json!("the importer"))]),
    )
    .expect("run starts")
}

fn reference(session: &str) -> NativeHistoryReference {
    NativeHistoryReference {
        fields: Vec::new(),
        session_id: session.into(),
        block_id: Some("answer".into()),
        content_hash: Some("ab".repeat(32)),
    }
}

/// Dispatches the next ready native task and completes it with `text`.
fn finish_native(run: &mut Run, execution: &str, text: &str) -> LaunchRequest {
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        run,
        revision,
        NativeExecutionReference {
            id: execution.into(),
        },
    )
    .expect("dispatches")
    .expect("a ready native task");
    Coordinator::complete_checked_task(
        run,
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
    launch
}

/// Leases and dispatches the next ready script.
fn start_script(run: &mut Run, execution: &str) -> ScriptLease {
    let revision = run.revision();
    let lease = Coordinator::lease_next_script(run, revision, format!("lease-{execution}"))
        .expect("leases")
        .expect("a ready script");
    Coordinator::dispatch_leased_script(
        run,
        lease.run_revision,
        &lease.step_id,
        lease.task_revision,
        &lease.lease_id,
        NativeExecutionReference {
            id: execution.into(),
        },
    )
    .expect("dispatches");
    lease
}

fn finish_script(run: &mut Run, step_id: &str, execution: &str, completion: ScriptCompletion) {
    let revision = run.revision();
    let task_revision = task(run, step_id).revision();
    Coordinator::complete_script_task(run, revision, step_id, task_revision, execution, completion)
        .expect("records the script outcome");
}

fn exited(stdout: &str) -> ScriptCompletion {
    ScriptCompletion::Exited {
        stdout: stdout.into(),
        truncated: false,
    }
}

fn task<'a>(run: &'a Run, step_id: &str) -> &'a TaskRecord {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .expect("task exists")
}

/// The fixture reduced to `plan` and the step at `index`, with no result
/// dependencies, so rules about callable roles are reached.
fn alone(index: usize) -> Value {
    let mut value = fixture();
    let mut step = value["pipeline"]["steps"][index].take();
    step["dependencyStepIds"] = json!([]);
    step["inputBindings"] = json!([]);
    let plan = value["pipeline"]["steps"][0].take();
    value["pipeline"]["steps"] = json!([plan, step]);
    value
}

fn executor_error(value: Value) -> &'static str {
    match validate_definition(&snapshot(value)) {
        Err(DefinitionError::InvalidExecutor { reason, .. }) => reason,
        other => panic!("expected an executor error, got {other:?}"),
    }
}

#[test]
fn executor_json_is_additive_exact_and_strict() {
    let steps = snapshot(fixture()).pipeline.steps;
    assert_eq!(steps[0].executor, None);
    assert_eq!(steps[0].executor_kind(), ExecutorKind::Agent);
    assert_eq!(
        steps[1].executor,
        Some(StepExecutor::Script {
            runtime: ScriptRuntime::Node,
            source: SCRIPT_SOURCE.into(),
            timeout_seconds: 30,
        })
    );
    assert_eq!(steps[2].executor, Some(StepExecutor::Llm {}));
    // A v6.1 step keeps its exact shape: no `executor` key appears.
    let legacy = serde_json::to_value(&steps[0]).expect("serializes");
    assert!(legacy.get("executor").is_none());
    for executor in [
        json!({"type": "agent"}),
        json!({"type": "llm"}),
        json!({"type": "script", "runtime": "python", "source": "print(1)", "timeoutSeconds": 1}),
        json!({"type": "script", "runtime": "powershell", "source": "Write-Output 1", "timeoutSeconds": 3600}),
    ] {
        let decoded: StepExecutor = serde_json::from_value(executor.clone()).expect("decodes");
        assert_eq!(serde_json::to_value(&decoded).expect("encodes"), executor);
    }
    for rejected in [
        json!({"type": "http"}),
        json!({"type": "llm", "model": "other"}),
        json!({"type": "script", "runtime": "bash", "source": "true", "timeoutSeconds": 5}),
        json!({"type": "script", "runtime": "node", "source": "1", "timeoutSeconds": 5, "cwd": "/"}),
        json!({"type": "script", "runtime": "node", "source": "1", "timeoutSeconds": -5}),
        json!({"type": "script", "runtime": "node", "source": "1"}),
    ] {
        assert!(
            serde_json::from_value::<StepExecutor>(rejected.clone()).is_err(),
            "{rejected}"
        );
    }
}

#[test]
fn task_output_and_failure_detail_are_additive_in_stored_runs() {
    let old: TaskRecord = serde_json::from_value(json!({
        "stepId": "metrics", "status": "failed", "revision": 2, "failure": {"code": "native-turn-failed"}
    }))
    .expect("older task records load");
    assert_eq!(old.output(), None);
    assert_eq!(
        old.failure().and_then(|failure| failure.detail.clone()),
        None
    );
    let encoded = serde_json::to_value(&old).expect("encodes");
    assert_eq!(
        encoded,
        json!({"stepId": "metrics", "status": "failed", "revision": 2, "failure": {"code": "native-turn-failed"}})
    );
    let recorded = json!({
        "stepId": "metrics", "status": "succeeded", "revision": 3,
        "execution": {"id": "script-1"},
        "output": {"text": "3 files", "truncated": true},
        "failure": {"code": "script-failed", "detail": "Error: boom"}
    });
    let decoded: TaskRecord = serde_json::from_value(recorded.clone()).expect("decodes");
    assert_eq!(
        decoded.output(),
        Some(&TaskOutput {
            text: "3 files".into(),
            truncated: true
        })
    );
    assert_eq!(serde_json::to_value(&decoded).expect("encodes"), recorded);
    assert!(
        serde_json::from_value::<TaskRecord>(json!({
            "stepId": "metrics", "status": "ready", "revision": 0, "output": {"text": "", "lines": 1}
        }))
        .is_err()
    );
}

#[test]
fn valid_mixed_pipeline_passes_and_scripts_are_host_work() {
    validate_definition(&snapshot(fixture())).expect("agent, script and llm steps validate");
    let mut member_script = fixture();
    member_script["pipeline"]["steps"][1]["assignedMemberId"] = json!("planner");
    assert_eq!(
        executor_error(member_script),
        "a script runs on the host, not as a team member"
    );
}

#[test]
fn script_steps_need_bounded_source_timeout_and_no_agent_only_features() {
    let script = |patch: fn(&mut Value)| {
        let mut value = fixture();
        patch(&mut value["pipeline"]["steps"][1]);
        value
    };
    assert_eq!(
        executor_error(script(|step| step["executor"]["source"] = json!("  \n "))),
        "a script needs source code"
    );
    assert_eq!(
        executor_error(script(|step| {
            step["executor"]["source"] = json!("x".repeat(MAX_SCRIPT_SOURCE_BYTES + 1));
        })),
        "script source is larger than 64 KiB"
    );
    let mut largest = fixture();
    largest["pipeline"]["steps"][1]["executor"]["source"] =
        json!("x".repeat(MAX_SCRIPT_SOURCE_BYTES));
    validate_definition(&snapshot(largest)).expect("64 KiB exactly is allowed");
    for timeout in [0, 3601] {
        let mut value = fixture();
        value["pipeline"]["steps"][1]["executor"]["timeoutSeconds"] = json!(timeout);
        assert_eq!(
            executor_error(value),
            "a script timeout is 1 to 3600 seconds",
            "{timeout}"
        );
    }
    let mut callable = alone(1);
    callable["pipeline"]["steps"][1]["executionMode"] = json!("callable");
    assert_eq!(
        executor_error(callable),
        "only agent steps can be callable roles; llm and script steps are scheduled"
    );
    assert_eq!(
        executor_error(script(|step| {
            step["router"] = json!({"mode": "program", "inputStepId": "plan", "branches": []});
        })),
        "llm and script steps cannot be routers"
    );
    let mut bound = fixture();
    bound["pipeline"]["steps"][0]["resultFields"] = json!([{"name": "steps", "kind": "number"}]);
    bound["pipeline"]["steps"][1]["inputBindings"] =
        json!([{"sourceStepId": "plan", "field": "steps", "name": "count"}]);
    assert!(executor_error(bound).starts_with("a script reads every dependency result on stdin"));
    // Self-contained script rules also guard a pipeline save on its own.
    let mut stored = snapshot(fixture()).pipeline;
    stored.steps[1].executor = Some(StepExecutor::Script {
        runtime: ScriptRuntime::Python,
        source: String::new(),
        timeout_seconds: 10,
    });
    assert!(matches!(
        validate_pipeline_declarations(&stored),
        Err(DefinitionError::InvalidExecutor { ref step_id, .. }) if step_id == "metrics"
    ));
}

#[test]
fn llm_steps_hold_least_authority_and_no_collaboration() {
    let llm = |patch: fn(&mut Value)| {
        let mut value = fixture();
        patch(&mut value);
        executor_error(value)
    };
    let mut callable = alone(2);
    callable["pipeline"]["steps"][1]["executionMode"] = json!("callable");
    assert_eq!(
        executor_error(callable),
        "only agent steps can be callable roles; llm and script steps are scheduled"
    );
    assert_eq!(
        llm(|value| {
            value["pipeline"]["steps"][2]["router"] = json!({
                "mode": "agent", "inputStepId": "metrics", "selectionField": "routes",
                "branches": [{"id": "a", "label": "A", "description": "a"}]
            });
            value["pipeline"]["steps"][2]["inputBindings"] = json!([]);
            value["pipeline"]["steps"][2]["resultFields"] =
                json!([{"name": "routes", "kind": "text-list"}]);
        }),
        "llm and script steps cannot be routers"
    );
    for edges in ["sendEdges", "observeEdges"] {
        for (from, to) in [("planner", "summarizer"), ("summarizer", "planner")] {
            let mut value = fixture();
            value["team"][edges] = json!([{"fromMemberId": from, "toMemberId": to}]);
            assert_eq!(
                executor_error(value),
                "an llm step cannot send, receive or observe messages",
                "{edges} {from}->{to}"
            );
        }
    }
    assert_eq!(
        llm(|value| value["profiles"][1]["permissionMode"] = json!("workspace-write")),
        "an llm step's profile must be read-only"
    );
    assert_eq!(
        llm(|value| value["profiles"][1]["permissionMode"] = json!("native")),
        "an llm step's profile must be read-only"
    );
    assert_eq!(
        llm(|value| value["profiles"][1]["networkAccess"] = json!(true)),
        "an llm step's profile has no network access"
    );
    assert_eq!(
        llm(|value| {
            value["profiles"][1]["toolPolicy"]["rules"] = json!([{"tool": "read", "decision": "allow", "enforcement": "native", "mandatory": true}]);
        }),
        "an llm step's profile cannot allow tools"
    );
    assert_eq!(
        llm(|value| value["profiles"][1]["resourceRules"][0]["enabled"] = json!(true)),
        "an llm step's profile cannot enable skills or MCP servers"
    );
    assert_eq!(
        llm(|value| value["profiles"][1]["allowedSpawnProfileIds"] = json!(["worker"])),
        "an llm step cannot spawn agents"
    );
    assert_eq!(
        llm(|value| value["profiles"][0]["allowedSpawnProfileIds"] = json!(["caller"])),
        "an llm step's profile cannot be spawned"
    );
}

#[test]
fn agent_script_llm_pipeline_hands_results_through_the_dependency_path() {
    let mut run = started(fixture());
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["plan"]);
    // The native lease refuses nothing here; the script lease refuses native work.
    let revision = run.revision();
    assert!(matches!(
        Coordinator::lease_next_script(&mut run, revision, "wrong".into()),
        Err(CoordinatorError::ExecutorMismatch { ref step_id }) if step_id == "plan"
    ));
    finish_native(&mut run, "plan-session", "Plan: count the files.");

    // The native path never admits a script, whichever API is used.
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["metrics"]);
    let revision = run.revision();
    assert!(matches!(
        Coordinator::lease_next_task(&mut run, revision, "native".into()),
        Err(CoordinatorError::ExecutorMismatch { .. })
    ));
    assert!(matches!(
        Coordinator::dispatch_next(
            &mut run,
            revision,
            NativeExecutionReference {
                id: "native".into()
            }
        ),
        Err(CoordinatorError::ExecutorMismatch { .. })
    ));
    assert_eq!(run.revision(), revision, "refusals change nothing");

    let lease = start_script(&mut run, "script-1");
    assert_eq!(lease.step_id, "metrics");
    assert_eq!(lease.runtime, ScriptRuntime::Node);
    assert_eq!(lease.source, SCRIPT_SOURCE);
    assert_eq!(lease.timeout_seconds, 30);
    assert_eq!(
        lease.dependencies,
        vec![ScriptDependency {
            step_id: "plan".into(),
            reference: Some(reference("plan-session")),
            text: None,
            data: None,
        }]
    );
    let mut resolved = lease.clone();
    resolved.dependencies[0].text = Some("Plan: count the files.".into());
    assert_eq!(
        resolved.stdin_document(),
        json!({
            "inputs": {"task": "the importer"},
            "dependencies": {"plan": {"text": "Plan: count the files.", "data": null}},
            "step": {"id": "metrics", "name": "Metrics"}
        })
    );
    assert_eq!(task(&run, "metrics").status(), TaskStatus::Running);
    assert_eq!(
        task(&run, "metrics")
            .execution()
            .map(|value| value.id.as_str()),
        Some("script-1")
    );
    // A script outcome cannot be recorded through the native completion paths.
    let revision = run.revision();
    let task_revision = task(&run, "metrics").revision();
    for result in [
        Coordinator::complete_task(
            &mut run.clone(),
            revision,
            "metrics",
            task_revision,
            "script-1",
            CompletionOutcome::Succeeded {
                result_reference: None,
            },
        ),
        Coordinator::complete_checked_task(
            &mut run.clone(),
            revision,
            "metrics",
            task_revision,
            "script-1",
            CompletionOutcome::Succeeded {
                result_reference: None,
            },
            Some("{\"files\": 3}"),
        ),
    ] {
        assert!(matches!(
            result,
            Err(CoordinatorError::ExecutorMismatch { .. })
        ));
    }
    finish_script(
        &mut run,
        "metrics",
        "script-1",
        exited("{\"files\": 3}\r\n"),
    );
    let metrics = task(&run, "metrics");
    assert_eq!(metrics.status(), TaskStatus::Succeeded);
    assert_eq!(metrics.result_data(), Some(&json!({"files": 3})));
    assert_eq!(metrics.output(), None);
    assert_eq!(metrics.result_reference(), None);

    // The llm step receives the script result where a native reference would be.
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference {
            id: "summary-session".into(),
        },
    )
    .expect("dispatches")
    .expect("llm step is ready");
    assert_eq!(launch.step_id, "summary");
    assert_eq!(launch.profile.id, "caller");
    assert!(launch.dependency_result_references.is_empty());
    assert_eq!(
        launch.dependency_outputs,
        vec![DependencyOutput {
            step_id: "metrics".into(),
            fields: vec![ResultSelection {
                field: "files".into(),
                name: "fileCount".into()
            }],
            text: None,
            data: Some(json!({"files": 3})),
        }]
    );
    assert_eq!(
        launch.dependency_outputs[0].context_text(),
        Ok("{\"fileCount\":3}".into())
    );
    assert!(
        launch
            .task_instructions
            .ends_with("This step is a single model call: answer in one reply from this task and the dependency results, without calling tools.")
    );
    Coordinator::complete_checked_task(
        &mut run,
        launch.run_revision,
        "summary",
        launch.task_revision,
        "summary-session",
        CompletionOutcome::Succeeded {
            result_reference: Some(reference("summary-session")),
        },
        Some("Three files changed."),
    )
    .expect("completes");
    assert_eq!(run.status(), RunStatus::Succeeded);
    let restored = deserialize_run(&serialize_run(&run).expect("serializes")).expect("reloads");
    assert_eq!(restored, run);
}

#[test]
fn plain_and_truncated_script_output_is_recorded_text() {
    let mut value = fixture();
    value["pipeline"]["steps"][1]["resultFields"] = json!([]);
    value["pipeline"]["steps"][2]["inputBindings"] = json!([]);
    let mut run = started(value.clone());
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script-1");
    finish_script(&mut run, "metrics", "script-1", exited("3 files\n[1, 2]"));
    assert_eq!(
        task(&run, "metrics").output(),
        Some(&TaskOutput {
            text: "3 files\n[1, 2]".into(),
            truncated: false
        })
    );
    assert_eq!(task(&run, "metrics").result_data(), None);
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference { id: "llm".into() },
    )
    .expect("dispatches")
    .expect("ready");
    assert_eq!(
        launch.dependency_outputs[0].context_text(),
        Ok("3 files\n[1, 2]".into())
    );

    // A JSON array is text when no fields are declared; a cut stdout is never JSON.
    let mut run = started(value.clone());
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script-2");
    finish_script(
        &mut run,
        "metrics",
        "script-2",
        ScriptCompletion::Exited {
            stdout: "{\"files\": 3}".into(),
            truncated: true,
        },
    );
    assert_eq!(task(&run, "metrics").result_data(), None);
    assert_eq!(
        task(&run, "metrics")
            .output()
            .map(|output| output.truncated),
        Some(true)
    );

    // The coordinator bounds stdout itself and never splits a character.
    let mut run = started(value);
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script-3");
    let long = "é".repeat(MAX_SCRIPT_STDOUT_BYTES);
    finish_script(&mut run, "metrics", "script-3", exited(&long));
    let output = task(&run, "metrics").output().expect("output");
    assert!(output.truncated);
    assert_eq!(output.text.len(), MAX_SCRIPT_STDOUT_BYTES);
    assert!(output.text.chars().all(|character| character == 'é'));
}

#[test]
fn declared_script_results_fail_exactly_like_native_results() {
    for (stdout, code) in [
        ("3 files", "result-invalid-json"),
        ("[3]", "result-not-object"),
        ("{}", "result-missing-field"),
        ("{\"files\": \"3\"}", "result-field-type"),
    ] {
        let mut run = started(fixture());
        finish_native(&mut run, "plan-session", "Plan.");
        start_script(&mut run, "script");
        finish_script(&mut run, "metrics", "script", exited(stdout));
        let metrics = task(&run, "metrics");
        assert_eq!(metrics.status(), TaskStatus::Failed, "{stdout}");
        assert_eq!(
            metrics.failure(),
            Some(&FailureRecord::new(code)),
            "{stdout}"
        );
        assert_eq!(metrics.output(), None);
        assert_eq!(task(&run, "summary").status(), TaskStatus::Cancelled);
        assert_eq!(run.status(), RunStatus::Failed);
    }
    // A truncated stdout with declared fields is never parsed.
    let mut run = started(fixture());
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script");
    finish_script(
        &mut run,
        "metrics",
        "script",
        ScriptCompletion::Exited {
            stdout: "{\"files\": 3}".into(),
            truncated: true,
        },
    );
    assert_eq!(
        task(&run, "metrics").failure(),
        Some(&FailureRecord::new("result-invalid-json"))
    );
}

#[test]
fn failed_and_timed_out_scripts_fail_fast_with_bounded_detail() {
    let mut run = started(fixture());
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script");
    let stderr = format!(
        "{}\nTypeError: boom\n    at main (script.mjs:1:7)\u{1b}[0m\r\n",
        "noise line\n".repeat(400)
    );
    finish_script(
        &mut run,
        "metrics",
        "script",
        ScriptCompletion::Failed {
            failure: FailureRecord::with_detail(SCRIPT_FAILED, &stderr),
        },
    );
    let failure = task(&run, "metrics").failure().expect("failure");
    assert_eq!(failure.code, "script-failed");
    let detail = failure.detail.as_deref().expect("detail");
    assert!(detail.len() <= MAX_FAILURE_DETAIL_BYTES);
    assert!(detail.ends_with("TypeError: boom\n    at main (script.mjs:1:7)[0m"));
    assert!(!detail.contains('\u{1b}') && !detail.contains('\r'));
    assert!(
        detail.starts_with("noise line"),
        "starts at a line boundary"
    );
    assert_eq!(task(&run, "summary").status(), TaskStatus::Cancelled);
    assert_eq!(run.status(), RunStatus::Failed);

    let mut run = started(fixture());
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script");
    finish_script(
        &mut run,
        "metrics",
        "script",
        ScriptCompletion::Failed {
            failure: FailureRecord::with_detail(SCRIPT_TIMEOUT, "  \n "),
        },
    );
    assert_eq!(
        task(&run, "metrics").failure(),
        Some(&FailureRecord::new("script-timeout"))
    );
    assert_eq!(run.status(), RunStatus::Failed);
}

#[test]
fn failure_detail_and_bounded_text_keep_character_boundaries() {
    assert_eq!(failure_detail("  short \r\n"), "short");
    let long = "ж".repeat(MAX_FAILURE_DETAIL_BYTES);
    let detail = failure_detail(&long);
    assert!(detail.len() <= MAX_FAILURE_DETAIL_BYTES);
    assert!(detail.chars().all(|character| character == 'ж'));
    let (cut, truncated) = bounded_text("ab€".into(), 3);
    assert_eq!((cut.as_str(), truncated), ("ab", true));
    assert_eq!(bounded_text("ab".into(), 3), ("ab".into(), false));
}

#[test]
fn script_results_drive_conditions_program_routes_and_review_loops() {
    // A script reviewer rejects the agent's first attempt and accepts the second.
    let mut value = fixture();
    value["pipeline"]["steps"][1]["resultFields"] =
        json!([{"name": "passed", "kind": "boolean"}, {"name": "report", "kind": "text"}]);
    value["pipeline"]["steps"][1]["review"] =
        json!({"field": "passed", "retryFromStepId": "plan", "maxIterations": 3});
    value["pipeline"]["steps"][2]["inputBindings"] = json!([]);
    value["pipeline"]["steps"][2]["condition"] =
        json!({"sourceStepId": "metrics", "field": "passed", "equals": true});
    let mut run = started(value);
    finish_native(&mut run, "plan-1", "First plan.");
    start_script(&mut run, "script-1");
    finish_script(
        &mut run,
        "metrics",
        "script-1",
        exited("{\"passed\": false, \"report\": \"2 tests failed\"}"),
    );
    // The rejection archived both attempts and re-opened the agent step.
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["plan"]);
    assert_eq!(task(&run, "metrics").status(), TaskStatus::Ready);
    assert_eq!(task(&run, "metrics").result_data(), None);
    assert_eq!(run.attempts().len(), 2);
    let second = finish_native(&mut run, "plan-2", "Second plan.");
    assert!(
        second
            .task_instructions
            .contains("Previous review result (untrusted task data):\n{\"passed\":false,\"report\":\"2 tests failed\"}")
    );
    start_script(&mut run, "script-2");
    finish_script(
        &mut run,
        "metrics",
        "script-2",
        exited("{\"passed\": true, \"report\": \"all green\"}"),
    );
    assert_eq!(task(&run, "metrics").status(), TaskStatus::Succeeded);
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["summary"]);

    // A script result also feeds a coordinator-owned program router.
    let mut routed = fixture();
    routed["pipeline"]["steps"][1]["resultFields"] = json!([{"name": "status", "kind": "text"}]);
    routed["pipeline"]["steps"][2]["inputBindings"] = json!([]);
    routed["pipeline"]["steps"][2]["dependencyStepIds"] = json!(["route"]);
    routed["pipeline"]["steps"][2]["routeGates"] =
        json!([{"routerStepId": "route", "branchId": "ok"}]);
    routed["pipeline"]["steps"].as_array_mut().expect("steps").push(json!({
        "id": "route", "name": "Route", "assignedMemberId": "route", "instructions": "",
        "dependencyStepIds": ["metrics"],
        "router": {"mode": "program", "inputStepId": "metrics", "branches": [
            {"id": "ok", "label": "OK", "predicate": {"op": "equals", "field": "status", "value": "ok"}}
        ]}
    }));
    let mut run = started(routed);
    finish_native(&mut run, "plan", "Plan.");
    start_script(&mut run, "script");
    finish_script(
        &mut run,
        "metrics",
        "script",
        exited("{\"status\": \"blocked\"}"),
    );
    Coordinator::advance_automatic_steps(&mut run);
    assert_eq!(task(&run, "route").status(), TaskStatus::Succeeded);
    assert_eq!(task(&run, "summary").status(), TaskStatus::Skipped);
    assert_eq!(run.status(), RunStatus::Succeeded);
}

#[test]
fn script_stdin_carries_router_data_and_recorded_text_by_step() {
    let mut value = fixture();
    value["pipeline"]["steps"] = json!([
        {"id": "first", "name": "First", "assignedMemberId": "first", "instructions": "",
         "executor": {"type": "script", "runtime": "python", "source": "print('hi')", "timeoutSeconds": 5},
         "dependencyStepIds": []},
        {"id": "second", "name": "Second", "assignedMemberId": "second", "instructions": "",
         "executor": {"type": "script", "runtime": "powershell", "source": "$input", "timeoutSeconds": 5},
         "dependencyStepIds": ["first"]}
    ]);
    let mut run = started(value);
    let lease = start_script(&mut run, "first-run");
    assert!(lease.dependencies.is_empty());
    assert_eq!(lease.stdin_document()["dependencies"], json!({}));
    finish_script(&mut run, "first", "first-run", exited("hi\n"));
    let lease = start_script(&mut run, "second-run");
    assert_eq!(lease.runtime, ScriptRuntime::PowerShell);
    assert_eq!(
        lease.stdin_document()["dependencies"],
        json!({"first": {"text": "hi\n", "data": null}})
    );
    finish_script(&mut run, "second", "second-run", exited(""));
    assert_eq!(run.status(), RunStatus::Succeeded);
}

#[test]
fn restart_marks_started_scripts_uncertain_and_never_replays_them() {
    let mut run = started(fixture());
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script-1");
    let revision = run.revision();
    Coordinator::restore(&mut run, revision).expect("restores");
    assert_eq!(task(&run, "metrics").status(), TaskStatus::Uncertain);
    assert_eq!(run.status(), RunStatus::Uncertain);
    assert!(Coordinator::ready_task_ids(&run).is_empty());
    let revision = run.revision();
    let task_revision = task(&run, "metrics").revision();
    // A native history reference cannot stand in for a script's result.
    assert!(matches!(
        Coordinator::reconcile_uncertain_task(
            &mut run.clone(),
            revision,
            "metrics",
            task_revision,
            UncertainResolution::Succeeded {
                result_reference: Some(reference("invented"))
            }
        ),
        Err(CoordinatorError::ExecutorMismatch { .. })
    ));
    Coordinator::retry_uncertain_task(&mut run, revision, "metrics", task_revision)
        .expect("explicit retry");
    assert_eq!(task(&run, "metrics").status(), TaskStatus::Ready);
    assert_eq!(task(&run, "metrics").execution(), None);

    // A lease taken before the process started is uncertain as well.
    let mut leased = started(fixture());
    finish_native(&mut leased, "plan-session", "Plan.");
    let revision = leased.revision();
    Coordinator::lease_next_script(&mut leased, revision, "lease".into())
        .expect("leases")
        .expect("script");
    let revision = leased.revision();
    Coordinator::restore(&mut leased, revision).expect("restores");
    assert_eq!(task(&leased, "metrics").status(), TaskStatus::Uncertain);
}

#[test]
fn cancellation_reaches_running_scripts_and_spawn_never_targets_them() {
    let mut run = started(fixture());
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script-1");
    let revision = run.revision();
    let cancels = Coordinator::cancellation_requests(&run, revision).expect("plans");
    assert_eq!(cancels.len(), 1);
    assert_eq!(cancels[0].step_id, "metrics");
    assert_eq!(cancels[0].execution.id, "script-1");
    Coordinator::cancel_run(&mut run, revision).expect("cancels");
    assert_eq!(task(&run, "metrics").status(), TaskStatus::Cancelled);
    assert_eq!(run.status(), RunStatus::Cancelled);

    // Controlled spawn admits only agent steps, even for an allowed caller.
    let mut value = fixture();
    value["profiles"][0]["allowedSpawnProfileIds"] = json!(["worker"]);
    for step in ["metrics", "summary"] {
        let mut run = started(value.clone());
        let revision = run.revision();
        let result = Coordinator::lease_controlled_spawn(
            &mut run,
            revision,
            "planner",
            step,
            "spawn".into(),
        );
        assert!(
            matches!(
                result,
                Err(CoordinatorError::Authorization(AuthorizationError::StepNotSpawnable { ref step_id })) if step_id == step
            ),
            "{step}: {result:?}"
        );
    }
}

#[test]
fn stored_runs_refuse_output_on_native_tasks() {
    let mut run = started(fixture());
    finish_native(&mut run, "plan-session", "Plan.");
    let mut value = serde_json::to_value(&run).expect("encodes");
    value["tasks"][0]["output"] = json!({"text": "forged"});
    let bytes = serde_json::to_vec(&value).expect("bytes");
    assert!(matches!(
        deserialize_run(&bytes),
        Err(RunDataError::Invalid(CoordinatorError::InvalidRunData {
            reason: "only host-executed tasks record output"
        }))
    ));
}

#[test]
fn a_script_cannot_complete_through_another_execution() {
    let mut run = started(fixture());
    finish_native(&mut run, "plan-session", "Plan.");
    start_script(&mut run, "script-1");
    let revision = run.revision();
    let task_revision = task(&run, "metrics").revision();
    assert!(matches!(
        Coordinator::complete_script_task(
            &mut run,
            revision,
            "metrics",
            task_revision,
            "script-other",
            exited("{\"files\": 1}")
        ),
        Err(CoordinatorError::StaleExecution { .. })
    ));
    let plan_revision = task(&run, "plan").revision();
    assert!(matches!(
        Coordinator::complete_script_task(
            &mut run,
            revision,
            "plan",
            plan_revision,
            "plan-session",
            exited("{}")
        ),
        Err(CoordinatorError::ExecutorMismatch { .. })
    ));
}
