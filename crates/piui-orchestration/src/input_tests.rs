//! Run inputs (v6.1) and bounded review loops.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::*;

fn definition(max_iterations: Option<u32>) -> RunDefinitionSnapshot {
    let mut review = json!({"field": "accepted", "retryFromStepId": "build"});
    if let Some(limit) = max_iterations {
        review["maxIterations"] = limit.into();
    }
    serde_json::from_value(json!({
        "profiles": [
            {"id": "writer-profile", "name": "Writer", "harness": "codex", "model": "model", "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": ["writer-profile"]},
            {"id": "reviewer-profile", "name": "Reviewer", "harness": "codex", "model": "model", "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}
        ],
        "team": {"id": "team", "name": "Team", "members": [
            {"id": "writer", "profileId": "writer-profile"},
            {"id": "reviewer", "profileId": "reviewer-profile"}
        ], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "writer"},
        "pipeline": {
            "id": "pipeline", "name": "Pipeline",
            "steps": [
                {"id": "build", "name": "Build", "assignedMemberId": "writer", "instructions": "Build {{input.task}} for {{ input.audience }}.", "dependencyStepIds": []},
                {"id": "review", "name": "Review", "assignedMemberId": "reviewer", "dependencyStepIds": ["build"],
                 "instructions": "Review it. Budget: {{input.attempts}}. Keep {{input.unknown}}, {{input.Task}} and {{input.task.x}}.",
                 "resultFields": [{"name": "accepted", "kind": "boolean"}, {"name": "feedback", "kind": "text"}],
                 "review": review},
                {"id": "publish", "name": "Publish", "assignedMemberId": "writer", "instructions": "Publish.", "dependencyStepIds": ["review"]}
            ],
            "inputs": [
                {"name": "task", "label": "What should be built?", "kind": "long-text", "required": true, "description": "One paragraph."},
                {"name": "audience", "label": "Audience", "kind": "choice", "options": ["team", "public"], "defaultValue": "team"},
                {"name": "attempts", "label": "Attempt budget", "kind": "number"},
                {"name": "urgent", "label": "Urgent", "kind": "boolean", "defaultValue": false},
                {"name": "notes", "label": "Notes", "kind": "text"}
            ]
        }
    }))
    .expect("valid fixture")
}

fn values(value: Value) -> BTreeMap<String, Value> {
    serde_json::from_value(value).expect("input map")
}

fn started(max_iterations: Option<u32>) -> Run {
    Coordinator::new_run_with_inputs(
        "run",
        definition(max_iterations),
        values(json!({"task": "Ship the importer"})),
    )
    .expect("starts")
}

/// Dispatches the next ready task and completes it with `text`.
fn finish(run: &mut Run, text: &str, execution: &str) -> LaunchRequest {
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        run,
        revision,
        NativeExecutionReference {
            id: execution.into(),
        },
    )
    .expect("dispatches")
    .expect("a ready task");
    Coordinator::complete_checked_task(
        run,
        launch.run_revision,
        &launch.step_id,
        launch.task_revision,
        execution,
        CompletionOutcome::Succeeded {
            result_reference: Some(NativeHistoryReference {
                fields: Vec::new(),
                session_id: execution.into(),
                block_id: None,
                content_hash: None,
            }),
        },
        Some(text),
    )
    .expect("completes");
    launch
}

fn task<'a>(run: &'a Run, step_id: &str) -> &'a TaskRecord {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .expect("task")
}

fn input(name: &str, kind: PipelineInputKind) -> PipelineInput {
    PipelineInput {
        name: name.into(),
        label: format!("{name} label"),
        kind,
        required: false,
        description: None,
        options: Vec::new(),
        default_value: None,
    }
}

fn invalid_input(error: Result<(), DefinitionError>) -> bool {
    matches!(error, Err(DefinitionError::InvalidInput { .. }))
}

#[test]
fn declarations_reject_bad_names_labels_options_defaults_and_counts() {
    for name in ["Task", "1task", "task-name", "", "_task", "tâche"] {
        assert!(
            invalid_input(validate_pipeline_inputs(&[input(
                name,
                PipelineInputKind::Text
            )])),
            "{name:?} must be rejected"
        );
    }
    let longest = format!("a{}", "B_9".repeat(21));
    assert_eq!(longest.len(), 64);
    validate_pipeline_inputs(&[input(&longest, PipelineInputKind::Text)]).unwrap();
    assert!(invalid_input(validate_pipeline_inputs(&[input(
        &format!("{longest}x"),
        PipelineInputKind::Text
    )])));
    assert_eq!(
        validate_pipeline_inputs(&[
            input("task", PipelineInputKind::Text),
            input("task", PipelineInputKind::Number)
        ]),
        Err(DefinitionError::DuplicateId {
            kind: "pipeline input",
            id: "task".into()
        })
    );
    let many = (0..=MAX_PIPELINE_INPUTS)
        .map(|index| input(&format!("input{index}"), PipelineInputKind::Boolean))
        .collect::<Vec<_>>();
    validate_pipeline_inputs(&many[..MAX_PIPELINE_INPUTS]).unwrap();
    assert_eq!(
        validate_pipeline_inputs(&many),
        Err(DefinitionError::TooManyInputs { limit: 20 })
    );

    let mut labelled = input("task", PipelineInputKind::Text);
    labelled.label = "  ".into();
    assert!(invalid_input(validate_pipeline_inputs(&[labelled.clone()])));
    labelled.label = "é".repeat(MAX_INPUT_LABEL_CHARS);
    validate_pipeline_inputs(&[labelled.clone()]).unwrap();
    labelled.label.push('é');
    assert!(invalid_input(validate_pipeline_inputs(&[labelled])));

    let mut choice = input("mode", PipelineInputKind::Choice);
    assert!(invalid_input(validate_pipeline_inputs(&[choice.clone()])));
    choice.options = (0..MAX_CHOICE_OPTIONS)
        .map(|index| format!("option {index}"))
        .collect();
    validate_pipeline_inputs(&[choice.clone()]).unwrap();
    choice.options.push("one too many".into());
    assert!(invalid_input(validate_pipeline_inputs(&[choice.clone()])));
    for options in [vec!["a", "a"], vec!["a", " "]] {
        choice.options = options.into_iter().map(Into::into).collect();
        assert!(invalid_input(validate_pipeline_inputs(&[choice.clone()])));
    }
    let mut text_with_options = input("task", PipelineInputKind::Text);
    text_with_options.options = vec!["a".into()];
    assert!(invalid_input(validate_pipeline_inputs(&[
        text_with_options
    ])));

    choice.options = vec!["fast".into(), "careful".into()];
    for (kind, default) in [
        (PipelineInputKind::Number, json!("3")),
        (PipelineInputKind::Boolean, json!(1)),
        (PipelineInputKind::Text, json!(true)),
        (PipelineInputKind::Choice, json!("reckless")),
    ] {
        let mut declared = if kind == PipelineInputKind::Choice {
            choice.clone()
        } else {
            input("value", kind)
        };
        declared.default_value = Some(default);
        assert!(invalid_input(validate_pipeline_inputs(&[declared])));
    }
    let mut required_blank = input("task", PipelineInputKind::LongText);
    required_blank.required = true;
    required_blank.default_value = Some(json!(" "));
    assert!(invalid_input(validate_pipeline_inputs(&[required_blank])));

    let mut valid = vec![
        input("task", PipelineInputKind::LongText),
        input("count", PipelineInputKind::Number),
        input("urgent", PipelineInputKind::Boolean),
        choice.clone(),
    ];
    valid[0].required = true;
    valid[0].default_value = Some(json!("Review the change"));
    valid[1].default_value = Some(json!(2.5));
    valid[2].default_value = Some(json!(false));
    valid[3].default_value = Some(json!("careful"));
    validate_pipeline_inputs(&valid).unwrap();

    // The whole-definition check applies the same rules before a run starts.
    let mut snapshot = definition(None);
    snapshot.pipeline.inputs[0].name = "Task".into();
    assert!(matches!(
        Coordinator::new_run("run", snapshot),
        Err(CoordinatorError::InvalidDefinition(
            DefinitionError::InvalidInput { .. }
        ))
    ));
}

#[test]
fn review_limits_must_be_between_one_and_twenty() {
    for limit in [0, 21, u32::MAX] {
        assert_eq!(
            validate_definition(&definition(Some(limit))),
            Err(DefinitionError::InvalidReviewLimit {
                step_id: "review".into()
            })
        );
        assert!(validate_pipeline_declarations(&definition(Some(limit)).pipeline).is_err());
    }
    for limit in [None, Some(1), Some(20)] {
        validate_definition(&definition(limit)).unwrap();
        validate_pipeline_declarations(&definition(limit).pipeline).unwrap();
    }
}

#[test]
fn run_inputs_fill_defaults_and_reject_unknown_missing_and_mistyped_values() {
    let declared = definition(None).pipeline.inputs;
    let resolve = |supplied: Value| resolve_run_inputs(&declared, &values(supplied));
    assert_eq!(
        resolve(json!({"task": "Ship"})).unwrap(),
        values(json!({"task": "Ship", "audience": "team", "urgent": false}))
    );
    assert_eq!(
        resolve(json!({"task": "Ship", "audience": "public", "attempts": 2.5, "urgent": true, "notes": ""}))
            .unwrap(),
        values(json!({"task": "Ship", "audience": "public", "attempts": 2.5, "urgent": true, "notes": ""}))
    );
    assert_eq!(
        resolve(json!({"task": "Ship", "other": "x"})),
        Err(RunInputError::Undeclared {
            name: "other".into()
        })
    );
    for missing in [json!({}), json!({"task": " \n "})] {
        assert_eq!(
            resolve(missing),
            Err(RunInputError::MissingRequired {
                name: "task".into()
            })
        );
    }
    for (supplied, name, kind) in [
        (json!({"task": 3}), "task", PipelineInputKind::LongText),
        (json!({"task": null}), "task", PipelineInputKind::LongText),
        (
            json!({"task": "Ship", "attempts": "3"}),
            "attempts",
            PipelineInputKind::Number,
        ),
        (
            json!({"task": "Ship", "urgent": "true"}),
            "urgent",
            PipelineInputKind::Boolean,
        ),
        (
            json!({"task": "Ship", "audience": 1}),
            "audience",
            PipelineInputKind::Choice,
        ),
        (
            json!({"task": "Ship", "notes": ["a"]}),
            "notes",
            PipelineInputKind::Text,
        ),
    ] {
        assert_eq!(
            resolve(supplied),
            Err(RunInputError::WrongKind {
                name: name.into(),
                kind
            })
        );
    }
    assert_eq!(
        resolve(json!({"task": "Ship", "audience": "everyone"})),
        Err(RunInputError::NotAnOption {
            name: "audience".into()
        })
    );

    // `new_run` supplies nothing: a required input without a default refuses
    // the run, while defaults are frozen exactly like supplied values.
    assert_eq!(
        Coordinator::new_run("run", definition(None)),
        Err(CoordinatorError::InvalidRunInput(
            RunInputError::MissingRequired {
                name: "task".into()
            }
        ))
    );
    let mut optional = definition(None);
    optional.pipeline.inputs[0].required = false;
    optional.pipeline.inputs[0].default_value = Some(json!("The default task"));
    let run = Coordinator::new_run("run", optional).unwrap();
    assert_eq!(
        run.inputs(),
        &values(json!({"task": "The default task", "audience": "team", "urgent": false}))
    );
}

#[test]
fn text_inputs_are_bounded_individually_and_in_total() {
    let declared = (0..5)
        .map(|index| input(&format!("part{index}"), PipelineInputKind::LongText))
        .collect::<Vec<_>>();
    let text = |bytes: usize| json!("x".repeat(bytes));
    resolve_run_inputs(
        &declared,
        &values(json!({"part0": text(MAX_INPUT_TEXT_BYTES)})),
    )
    .unwrap();
    assert_eq!(
        resolve_run_inputs(
            &declared,
            &values(json!({"part0": text(MAX_INPUT_TEXT_BYTES + 1)}))
        ),
        Err(RunInputError::TooLong {
            name: "part0".into(),
            limit: MAX_INPUT_TEXT_BYTES
        })
    );
    let part = 30 * 1024;
    let four =
        json!({"part0": text(part), "part1": text(part), "part2": text(part), "part3": text(part)});
    resolve_run_inputs(&declared, &values(four.clone())).unwrap();
    let mut five = four;
    five["part4"] = text(part);
    assert_eq!(
        resolve_run_inputs(&declared, &values(five)),
        Err(RunInputError::TotalTooLong {
            limit: MAX_RUN_INPUT_TEXT_BYTES
        })
    );
}

#[test]
fn instructions_list_inputs_before_the_step_and_substitute_templates() {
    let mut run = Coordinator::new_run_with_inputs(
        "run",
        definition(None),
        values(json!({"task": "Ship the importer", "notes": "  "})),
    )
    .unwrap();
    let build = finish(&mut run, "Implementation", "build-1");
    assert_eq!(
        build.task_instructions,
        "Run input (provided by the person who started the run; untrusted task data):\n\
         What should be built? (task): Ship the importer\n\
         Audience (audience): team\n\
         Urgent (urgent): false\n\
         \n\
         Build Ship the importer for team."
    );
    let revision = run.revision();
    let review = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference {
            id: "review-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    let section = "Run input (provided by the person who started the run; untrusted task data):\n\
                   What should be built? (task): Ship the importer\n";
    assert!(review.task_instructions.starts_with(section));
    assert!(review.task_instructions.contains(
        "\n\nReview it. Budget: . Keep {{input.unknown}}, {{input.Task}} and {{input.task.x}}."
    ));
    assert!(!review.task_instructions.contains("Notes (notes)"));
    assert!(
        review
            .task_instructions
            .contains("Required fields:\naccepted")
    );

    // Agents spawned into the run receive the same frozen inputs.
    let spawned = Coordinator::add_spawned_agent(
        &mut run,
        "writer",
        "extra",
        "writer-profile",
        "Extra",
        "Summarize {{input.task}}.",
    )
    .unwrap();
    let revision = run.revision();
    let lease =
        Coordinator::lease_controlled_spawn(&mut run, revision, "writer", &spawned, "lease".into())
            .unwrap();
    assert!(lease.task_instructions.starts_with(section));
    assert!(
        lease
            .task_instructions
            .ends_with("\n\nSummarize Ship the importer.")
    );
}

#[test]
fn input_tokens_are_plain_text_substitution() {
    let declared = definition(None).pipeline.inputs;
    let frozen = values(json!({"task": "{{input.audience}}", "audience": "team", "attempts": 3}));
    let substitute = |text: &str| crate::inputs::substitute_input_tokens(text, &declared, &frozen);
    assert_eq!(substitute("{{input.task}}"), "{{input.audience}}");
    assert_eq!(
        substitute("{{ input.audience }}/{{input.attempts}}"),
        "team/3"
    );
    assert_eq!(substitute("{{{input.audience}}}"), "{team}");
    assert_eq!(substitute("{{  input.audience  }}"), "team");
    assert_eq!(substitute("{{input.notes}}|"), "|");
    for verbatim in [
        "{{input.other}}",
        "{{input.}}",
        "{{ input . audience }}",
        "{{input.audience}",
        "{{\tinput.audience}}",
        "{{",
        "é{{input.x",
    ] {
        assert_eq!(substitute(verbatim), verbatim);
    }
    assert_eq!(
        crate::inputs::run_input_section(&declared, &BTreeMap::new()),
        ""
    );
}

#[test]
fn runs_without_inputs_keep_their_prompt_and_stored_shape() {
    let mut plain = definition(Some(3));
    plain.pipeline.inputs.clear();
    plain.pipeline.steps[0].instructions = "Build it.".into();
    plain.pipeline.steps[1]
        .review
        .as_mut()
        .unwrap()
        .max_iterations = None;
    let mut run = Coordinator::new_run("plain", plain).unwrap();
    let build = finish(&mut run, "Implementation", "build-1");
    assert_eq!(build.task_instructions, "Build it.");
    let bytes = serialize_run(&run).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert!(!text.contains("\"inputs\""));
    assert!(!text.contains("maxIterations"));
    let restored = deserialize_run(&bytes).unwrap();
    assert!(restored.inputs().is_empty());
    assert_eq!(serialize_run(&restored).unwrap(), bytes);
}

#[test]
fn stored_runs_and_definitions_without_v6_1_fields_still_decode() {
    let old = json!({
        "schemaVersion": 5, "id": "old", "status": "running", "revision": 0,
        "messages": [], "agentRequests": [],
        "tasks": [{"stepId": "build", "status": "ready", "revision": 0}, {"stepId": "review", "status": "ready", "revision": 0}],
        "definition": {
            "profiles": [{"id": "p", "name": "P", "harness": "codex", "model": "m", "permissionMode": "native", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}],
            "team": {"id": "t", "name": "T", "members": [{"id": "m", "profileId": "p"}], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "m"},
            "pipeline": {"id": "pl", "name": "PL", "steps": [
                {"id": "build", "name": "Build", "assignedMemberId": "m", "instructions": "Build", "dependencyStepIds": []},
                {"id": "review", "name": "Review", "assignedMemberId": "m", "instructions": "Review", "dependencyStepIds": ["build"],
                 "resultFields": [{"name": "ok", "kind": "boolean"}], "review": {"field": "ok", "retryFromStepId": "build"}}
            ]}
        }
    });
    let run = deserialize_run(&serde_json::to_vec(&old).unwrap()).unwrap();
    assert!(run.inputs().is_empty());
    assert!(run.definition().pipeline.inputs.is_empty());
    assert_eq!(
        run.definition().pipeline.steps[1]
            .review
            .as_ref()
            .unwrap()
            .max_iterations,
        None
    );
    let mut expected = old;
    expected["schemaVersion"] = 6.into();
    assert_eq!(
        serde_json::from_slice::<Value>(&serialize_run(&run).unwrap()).unwrap(),
        expected
    );

    // New fields round-trip exactly and remain subject to unknown-field checks.
    let mut current = started(Some(2));
    finish(&mut current, "Implementation", "build-1");
    let bytes = serialize_run(&current).unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        value["inputs"],
        json!({"audience": "team", "task": "Ship the importer", "urgent": false})
    );
    assert_eq!(
        value["definition"]["pipeline"]["steps"][1]["review"]["maxIterations"],
        2
    );
    let restored = deserialize_run(&bytes).unwrap();
    assert_eq!(restored, current);
    assert_eq!(serialize_run(&restored).unwrap(), bytes);
    let mut unknown = value;
    unknown["definition"]["pipeline"]["inputs"][0]["placeholder"] = json!("not allowed");
    assert!(matches!(
        deserialize_run(&serde_json::to_vec(&unknown).unwrap()),
        Err(RunDataError::Deserialize(_))
    ));
}

#[test]
fn review_limit_waits_for_a_person_and_approval_continues_downstream() {
    let mut run = started(Some(2));
    finish(&mut run, "Implementation 1", "build-1");
    finish(
        &mut run,
        r#"{"accepted":false,"feedback":"Missing test"}"#,
        "review-1",
    );
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["build"]);
    finish(&mut run, "Implementation 2", "build-2");
    finish(
        &mut run,
        r#"{"accepted":false,"feedback":"Still no test"}"#,
        "review-2",
    );

    let reviewer = task(&run, "review");
    assert_eq!(reviewer.status(), TaskStatus::AwaitingApproval);
    assert_eq!(
        reviewer.failure().map(|failure| failure.code.as_str()),
        Some("review-limit-reached")
    );
    assert_eq!(
        reviewer.result_data,
        Some(json!({"accepted": false, "feedback": "Still no test"}))
    );
    assert_eq!(task(&run, "build").status(), TaskStatus::Succeeded);
    assert_eq!(run.attempts().len(), 2, "no further round was archived");
    assert!(Coordinator::ready_task_ids(&run).is_empty());
    assert_eq!(run.status(), RunStatus::Running);
    assert!(!run.paused());
    assert_eq!(deserialize_run(&serialize_run(&run).unwrap()).unwrap(), run);

    let revision = run.revision();
    let task_revision = task(&run, "review").revision();
    Coordinator::control_flow(
        &mut run,
        revision,
        FlowAction::Decide {
            step_id: "review".into(),
            task_revision,
            approved: true,
        },
    )
    .unwrap();
    let reviewer = task(&run, "review");
    assert_eq!(reviewer.status(), TaskStatus::Succeeded);
    assert_eq!(reviewer.failure(), None);
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["publish"]);
    finish(&mut run, "Published", "publish-1");
    assert_eq!(run.status(), RunStatus::Succeeded);
}

#[test]
fn review_limit_rejection_fails_and_repeat_grants_one_more_round() {
    let reach_limit = || {
        let mut run = started(Some(1));
        finish(&mut run, "Implementation 1", "build-1");
        finish(
            &mut run,
            r#"{"accepted":false,"feedback":"Missing test"}"#,
            "review-1",
        );
        assert_eq!(task(&run, "review").status(), TaskStatus::AwaitingApproval);
        run
    };

    let mut rejected = reach_limit();
    let revision = rejected.revision();
    let task_revision = task(&rejected, "review").revision();
    Coordinator::control_flow(
        &mut rejected,
        revision,
        FlowAction::Decide {
            step_id: "review".into(),
            task_revision,
            approved: false,
        },
    )
    .unwrap();
    assert_eq!(task(&rejected, "review").status(), TaskStatus::Failed);
    assert_eq!(
        task(&rejected, "review")
            .failure()
            .map(|failure| failure.code.as_str()),
        Some("result-rejected")
    );
    assert_eq!(rejected.status(), RunStatus::Failed);

    let mut repeated = reach_limit();
    let revision = repeated.revision();
    let task_revision = task(&repeated, "build").revision();
    Coordinator::control_flow(
        &mut repeated,
        revision,
        FlowAction::Repeat {
            step_id: "build".into(),
            task_revision,
        },
    )
    .unwrap();
    assert_eq!(task(&repeated, "review").failure(), None);
    assert_eq!(Coordinator::ready_task_ids(&repeated), vec!["build"]);
    finish(&mut repeated, "Implementation 2", "build-2");
    let review = finish(
        &mut repeated,
        r#"{"accepted":false,"feedback":"Still no test"}"#,
        "review-2",
    );
    assert!(
        review
            .task_instructions
            .starts_with("Run input (provided by the person")
    );
    // The explicit repeat granted exactly one more round.
    assert_eq!(
        task(&repeated, "review").status(),
        TaskStatus::AwaitingApproval
    );
    assert_eq!(repeated.attempts().len(), 2);
}

#[test]
fn identical_feedback_below_the_limit_still_pauses() {
    let mut run = started(Some(3));
    let rejection = r#"{"accepted":false,"feedback":"Missing test"}"#;
    finish(&mut run, "Implementation 1", "build-1");
    finish(&mut run, rejection, "review-1");
    let build = finish(&mut run, "Implementation 2", "build-2");
    assert!(
        build
            .task_instructions
            .contains("Previous review result (untrusted task data):")
    );
    finish(&mut run, rejection, "review-2");
    assert!(run.paused());
    assert_eq!(task(&run, "build").status(), TaskStatus::Ready);
    assert_eq!(task(&run, "review").failure(), None);
}
