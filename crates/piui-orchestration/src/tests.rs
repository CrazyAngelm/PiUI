use serde_json::json;

use crate::*;

#[test]
fn selected_result_fields_keep_history_identity_and_aliases() {
    let text = r#"{"files":["app.rs"],"privateNotes":"not passed"}"#;
    let fields = vec![ResultSelection {
        field: "files".into(),
        name: "changedFiles".into(),
    }];
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&project_result(text, &fields).unwrap()).unwrap(),
        json!({"changedFiles":["app.rs"]})
    );
    assert!(project_result("{}", &fields).is_err());
}

#[test]
fn cancelling_one_task_preserves_independent_work() {
    let mut definition = snapshot();
    definition.pipeline.steps[1].dependency_step_ids.clear();
    let mut run = Coordinator::new_run("cancel-one", definition).unwrap();
    Coordinator::cancel_task(&mut run, 0, "build").unwrap();
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["review"]);
    assert_eq!(run.status(), RunStatus::Running);
}

fn finish_checked(run: &mut Run, text: &str, execution: &str) {
    let revision = run.revision();
    let launch = Coordinator::dispatch_next(
        run,
        revision,
        NativeExecutionReference {
            id: execution.into(),
        },
    )
    .unwrap()
    .unwrap();
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
    .unwrap();
}

#[test]
fn approval_blocks_dependencies_and_pause_blocks_new_admissions() {
    let mut definition = snapshot();
    definition.pipeline.steps[0].require_approval = true;
    let mut run = Coordinator::new_run("approval", definition).unwrap();
    finish_checked(&mut run, "Implementation", "build-native");
    assert_eq!(run.tasks[0].status, TaskStatus::AwaitingApproval);
    assert!(Coordinator::ready_task_ids(&run).is_empty());
    let revision = run.revision();
    let task_revision = run.tasks[0].revision;
    Coordinator::control_flow(
        &mut run,
        revision,
        FlowAction::Decide {
            step_id: "build".into(),
            task_revision,
            approved: true,
        },
    )
    .unwrap();
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["review"]);
    let revision = run.revision();
    Coordinator::control_flow(&mut run, revision, FlowAction::Pause).unwrap();
    assert!(Coordinator::ready_task_ids(&run).is_empty());
    assert!(
        Coordinator::add_spawned_agent(
            &mut run,
            "lead",
            "paused",
            "worker-profile",
            "Review",
            "Review"
        )
        .is_err()
    );
    assert!(
        deserialize_run(&serialize_run(&run).unwrap())
            .unwrap()
            .paused()
    );
}

#[test]
fn result_condition_skips_branch_without_running_a_harness() {
    let mut definition = snapshot();
    definition.pipeline.steps[0].result_fields = vec![ResultField {
        name: "enabled".into(),
        kind: ResultFieldKind::Boolean,
    }];
    definition.pipeline.steps[1].condition = Some(ResultCondition {
        source_step_id: "build".into(),
        field: "enabled".into(),
        equals: json!(true),
    });
    let mut run = Coordinator::new_run("condition", definition).unwrap();
    finish_checked(&mut run, r#"{"enabled":false}"#, "native");
    assert_eq!(run.tasks[1].status, TaskStatus::Skipped);
    assert_eq!(run.status(), RunStatus::Succeeded);
}

fn router_snapshot() -> RunDefinitionSnapshot {
    let mut definition = snapshot();
    definition.pipeline.steps[0].result_fields = vec![ResultField {
        name: "score".into(),
        kind: ResultFieldKind::Number,
    }];
    let router_id = "router";
    let first = "score-two";
    let second = "has-score";
    let router = PipelineStep {
        input_bindings: Vec::new(),
        condition: None,
        route_gates: Vec::new(),
        router: Some(RouterConfig {
            mode: RouterMode::Program,
            input_step_id: "build".into(),
            branches: vec![
                RouterBranch {
                    id: first.into(),
                    label: "Score is two".into(),
                    description: None,
                    predicate: Some(RouterPredicate::Equals {
                        field: "score".into(),
                        value: json!(2),
                    }),
                },
                RouterBranch {
                    id: second.into(),
                    label: "Score exists".into(),
                    description: None,
                    predicate: Some(RouterPredicate::Exists {
                        field: "score".into(),
                    }),
                },
            ],
            selection_field: None,
        }),
        review: None,
        require_approval: false,
        result_fields: Vec::new(),
        execution_mode: None,
        executor: None,
        input_instructions: None,
        id: router_id.into(),
        name: "Router".into(),
        assigned_member_id: router_id.into(),
        instructions: "Route the result".into(),
        dependency_step_ids: vec!["build".into()],
    };
    let mut target = definition.pipeline.steps[1].clone();
    target.dependency_step_ids = vec![router_id.into()];
    target.route_gates = vec![
        RouteGate {
            router_step_id: router_id.into(),
            branch_id: first.into(),
        },
        RouteGate {
            router_step_id: router_id.into(),
            branch_id: second.into(),
        },
    ];
    definition.pipeline.steps = vec![definition.pipeline.steps[0].clone(), router, target];
    definition
}

#[test]
fn program_router_selects_multiple_routes_and_skips_when_none_match() {
    let mut run = Coordinator::new_run("router-many", router_snapshot()).unwrap();
    finish_checked(&mut run, r#"{"score":2}"#, "build-native");
    assert!(Coordinator::ready_task_ids(&run).is_empty());
    Coordinator::advance_automatic_steps(&mut run);
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["review"]);
    let revision = run.revision();
    assert!(
        Coordinator::dispatch_next(
            &mut run,
            revision,
            NativeExecutionReference {
                id: "review-native".into()
            },
        )
        .unwrap()
        .is_some()
    );
    assert_eq!(
        run.tasks[1].result_data,
        Some(json!({"selectedBranchIds":["score-two","has-score"]}))
    );

    let mut none_definition = router_snapshot();
    none_definition.pipeline.steps[1]
        .router
        .as_mut()
        .unwrap()
        .branches[1]
        .predicate = Some(RouterPredicate::Equals {
        field: "score".into(),
        value: json!(3),
    });
    let mut run = Coordinator::new_run("router-none", none_definition).unwrap();
    finish_checked(&mut run, r#"{"score":0}"#, "build-native");
    let revision = run.revision();
    assert!(
        Coordinator::dispatch_next(
            &mut run,
            revision,
            NativeExecutionReference {
                id: "router-native".into()
            },
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        run.tasks[1].result_data,
        Some(json!({"selectedBranchIds":[]}))
    );
    assert_eq!(run.tasks[2].status, TaskStatus::Skipped);
}

#[test]
fn agent_router_rejects_unknown_or_duplicate_branch_ids() {
    let config = RouterConfig {
        mode: RouterMode::Agent,
        input_step_id: "build".into(),
        branches: vec![RouterBranch {
            id: "yes".into(),
            label: "Yes".into(),
            description: None,
            predicate: None,
        }],
        selection_field: Some("choice".into()),
    };
    assert_eq!(
        agent_router_selection(&config, &json!({"choice":[]})).unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(
        agent_router_selection(&config, &json!({"choice":["yes"]})).unwrap(),
        vec!["yes"]
    );
    assert_eq!(
        agent_router_selection(&config, &json!({"choice":["no"]})),
        Err("router-selection-invalid")
    );
    assert_eq!(
        agent_router_selection(&config, &json!({"choice":["yes","yes"]})),
        Err("router-selection-invalid")
    );
}

#[test]
fn revision_cycle_retains_attempts_and_pauses_identical_feedback() {
    let mut definition = snapshot();
    definition.pipeline.steps[1].result_fields = vec![ResultField {
        name: "accepted".into(),
        kind: ResultFieldKind::Boolean,
    }];
    definition.pipeline.steps[1].review = Some(ReviewRule {
        field: "accepted".into(),
        retry_from_step_id: "build".into(),
        max_iterations: None,
    });
    let mut run = Coordinator::new_run("review", definition).unwrap();
    finish_checked(&mut run, "First implementation", "native-1");
    finish_checked(
        &mut run,
        r#"{"accepted":false,"feedback":"Missing test"}"#,
        "review-1",
    );
    assert_eq!(run.attempts().len(), 2);
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["build"]);
    finish_checked(&mut run, "Second implementation", "native-2");
    finish_checked(
        &mut run,
        r#"{"accepted":false,"feedback":"Missing test"}"#,
        "review-2",
    );
    assert!(run.paused());
    assert_eq!(run.attempts().len(), 4);
    assert_eq!(deserialize_run(&serialize_run(&run).unwrap()).unwrap(), run);
}

#[test]
fn callable_templates_do_not_run_or_hold_completion_open() {
    let mut definition = snapshot();
    definition.pipeline.steps[1].execution_mode = Some(ExecutionMode::Callable);
    definition.pipeline.steps[1].dependency_step_ids.clear();
    let mut run = Coordinator::new_run("callable", definition).unwrap();
    assert_eq!(Coordinator::ready_task_ids(&run), vec!["build"]);
    let spawned = Coordinator::add_spawned_agent(
        &mut run,
        "lead",
        "request",
        "worker-profile",
        "Review",
        "Check output",
    )
    .unwrap();
    assert!(Coordinator::ready_task_ids(&run).contains(&spawned.as_str()));
    for task in &mut run.tasks {
        if task.step_id != "review" {
            task.status = TaskStatus::Succeeded;
        }
    }
    // A real completed turn recalculates run status; the untouched template is not work.
    run.tasks[0].status = TaskStatus::Running;
    run.tasks[0].execution = Some(NativeExecutionReference {
        id: "native".into(),
    });
    let revision = run.revision;
    Coordinator::complete_task(
        &mut run,
        revision,
        "build",
        0,
        "native",
        CompletionOutcome::Succeeded {
            result_reference: None,
        },
    )
    .unwrap();
    assert_eq!(run.status(), RunStatus::Succeeded);
    assert_eq!(deserialize_run(&serialize_run(&run).unwrap()).unwrap(), run);
}

#[test]
fn callable_result_dependencies_are_rejected_at_host_boundary() {
    let mut definition = snapshot();
    definition.pipeline.steps[1].execution_mode = Some(ExecutionMode::Callable);
    assert_eq!(
        validate_definition(&definition),
        Err(DefinitionError::CallableDependency)
    );
}

#[test]
fn v1_run_migrates_without_changing_native_prompt() {
    let run = Coordinator::new_run("old", snapshot()).unwrap();
    let mut json: serde_json::Value =
        serde_json::from_slice(&serialize_run(&run).unwrap()).unwrap();
    json["schemaVersion"] = 1.into();
    let migrated = deserialize_run(&serde_json::to_vec(&json).unwrap()).unwrap();
    assert_eq!(migrated.schema_version(), 6);
    assert!(
        migrated
            .definition()
            .profiles
            .iter()
            .all(|p| p.base_instructions.is_none())
    );
}

#[test]
fn input_requirements_reach_sender_and_survive_v3_migration() {
    let mut definition = snapshot();
    definition.pipeline.steps[0].input_instructions = Some("Approved specification".into());
    definition.pipeline.steps[1].input_instructions =
        Some("Changed paths and test evidence".into());
    definition.profiles[0].expected_result = Some("A verified implementation".into());
    let mut run = Coordinator::new_run("input-contract", definition).unwrap();
    let lease = Coordinator::lease_next_task(&mut run, 0, "input-lease".into())
        .unwrap()
        .unwrap();
    assert!(
        lease
            .task_instructions
            .contains("Expected input:\nApproved specification")
    );
    assert!(
        lease
            .task_instructions
            .contains("Expected result:\nA verified implementation")
    );
    assert!(
        lease
            .task_instructions
            .contains("Result handoff requirements for Review:\nChanged paths and test evidence")
    );
    let restored = deserialize_run(&serialize_run(&run).unwrap()).unwrap();
    assert_eq!(
        restored.definition().pipeline.steps[1]
            .input_instructions
            .as_deref(),
        Some("Changed paths and test evidence")
    );

    let old = Coordinator::new_run("v3", snapshot()).unwrap();
    let mut value: serde_json::Value =
        serde_json::from_slice(&serialize_run(&old).unwrap()).unwrap();
    value["schemaVersion"] = 3.into();
    let migrated = deserialize_run(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(migrated.schema_version(), 6);
    assert_eq!(migrated.definition(), old.definition());
}

#[test]
fn spawned_agent_uses_allowed_profile_and_keeps_original_definition() {
    let original = snapshot();
    let mut run = Coordinator::new_run("dynamic", original.clone()).unwrap();
    let step = Coordinator::add_spawned_agent(
        &mut run,
        "lead",
        "create-worker",
        "worker-profile",
        "Check results",
        "Review the result",
    )
    .unwrap();
    assert_eq!(run.initial_definition.as_ref(), Some(&original));
    assert_eq!(run.definition.profiles, original.profiles);
    assert!(authorize_send(&run.definition.team, "lead", &step).is_ok());
    assert!(authorize_send(&run.definition.team, &step, "lead").is_ok());
    assert!(authorize_send(&run.definition.team, &step, "worker").is_err());
    let before = run.clone();
    assert!(
        Coordinator::add_spawned_agent(
            &mut run,
            "lead",
            "create-worker",
            "worker-profile",
            "Different",
            "Different"
        )
        .is_err()
    );
    assert_eq!(before, run);
    assert!(
        Coordinator::add_spawned_agent(
            &mut run,
            &step,
            "escalate",
            "lead-profile",
            "Boss",
            "Escalate"
        )
        .is_err()
    );
    assert_eq!(before, run);
    let revision = run.revision();
    let lease = Coordinator::lease_controlled_spawn(
        &mut run,
        revision,
        "lead",
        &step,
        "lease-dynamic".into(),
    )
    .unwrap();
    assert_eq!(lease.profile.id, "worker-profile");
    assert_eq!(lease.task_instructions, "Review the result");
    assert_eq!(deserialize_run(&serialize_run(&run).unwrap()).unwrap(), run);
}

#[test]
fn dynamic_peer_messaging_requires_explicit_team_grant() {
    let mut definition = snapshot();
    definition.team.spawned_agents_join_team = true;
    let mut run = Coordinator::new_run("peer-team", definition).unwrap();
    let child = Coordinator::add_spawned_agent(
        &mut run,
        "lead",
        "child",
        "worker-profile",
        "Reviewer",
        "Review",
    )
    .unwrap();
    assert!(authorize_send(&run.definition.team, &child, "worker").is_ok());
    assert!(authorize_send(&run.definition.team, "worker", &child).is_err());
    assert!(authorize_observe(&run.definition.team, "worker", &child).is_err());
}

fn profile(id: &str, harness: Harness, allowed: &[&str]) -> AgentProfile {
    AgentProfile {
        when_to_call: None,
        input_instructions: None,
        expected_result: None,
        id: id.to_owned(),
        name: format!("{id} profile"),
        harness,
        model_provider: Some("example-provider".to_owned()),
        model: format!("{id}-model"),
        permission_mode: PermissionMode::ReadOnly,
        network_access: false,
        base_instructions: None,
        reasoning: None,
        service_tier: None,
        resource_rules: vec![],
        instructions: format!("instructions for {id}"),
        tool_policy: DeclaredToolPolicy {
            rules: vec![ToolRule {
                tool: "session.send".to_owned(),
                decision: ToolDecision::Allow,
                enforcement: PolicyEnforcement::Native,
                mandatory: true,
            }],
        },
        allowed_spawn_profile_ids: allowed.iter().map(|id| (*id).to_owned()).collect(),
    }
}

fn snapshot() -> RunDefinitionSnapshot {
    RunDefinitionSnapshot {
        profiles: vec![
            profile("lead-profile", Harness::Pi, &["worker-profile"]),
            profile("worker-profile", Harness::Codex, &[]),
        ],
        team: TeamDefinition {
            spawned_agents_join_team: false,
            id: "team-1".to_owned(),
            name: "Mixed team".to_owned(),
            members: vec![
                TeamMember {
                    id: "lead".to_owned(),
                    profile_id: "lead-profile".to_owned(),
                },
                TeamMember {
                    id: "worker".to_owned(),
                    profile_id: "worker-profile".to_owned(),
                },
            ],
            send_edges: vec![DirectedEdge {
                from_member_id: "lead".to_owned(),
                to_member_id: "worker".to_owned(),
            }],
            observe_edges: vec![DirectedEdge {
                from_member_id: "lead".to_owned(),
                to_member_id: "worker".to_owned(),
            }],
            orchestrator_member_id: "lead".to_owned(),
        },
        pipeline: PipelineDefinition {
            id: "pipeline-1".to_owned(),
            name: "Build then review".to_owned(),
            steps: vec![
                PipelineStep {
                    input_bindings: Vec::new(),
                    condition: None,
                    route_gates: Vec::new(),
                    router: None,
                    review: None,
                    require_approval: false,
                    result_fields: Vec::new(),
                    execution_mode: None,
                    executor: None,
                    input_instructions: None,
                    id: "build".to_owned(),
                    name: "Build".to_owned(),
                    assigned_member_id: "lead".to_owned(),
                    instructions: "Build the change".to_owned(),
                    dependency_step_ids: vec![],
                },
                PipelineStep {
                    input_bindings: Vec::new(),
                    condition: None,
                    route_gates: Vec::new(),
                    router: None,
                    review: None,
                    require_approval: false,
                    result_fields: Vec::new(),
                    execution_mode: None,
                    executor: None,
                    input_instructions: None,
                    id: "review".to_owned(),
                    name: "Review".to_owned(),
                    assigned_member_id: "worker".to_owned(),
                    instructions: "Review the result".to_owned(),
                    dependency_step_ids: vec!["build".to_owned()],
                },
            ],
            inputs: Vec::new(),
        },
        launch_command: Some(LaunchCommandReference {
            id: "launch-1".to_owned(),
            name: "Build and review".to_owned(),
            team_id: "team-1".to_owned(),
            pipeline_id: "pipeline-1".to_owned(),
        }),
    }
}

struct FakeNativeExecutor {
    launched: Vec<LaunchRequest>,
}

impl FakeNativeExecutor {
    fn execute(&mut self, request: LaunchRequest) -> CompletionOutcome {
        self.launched.push(request);
        CompletionOutcome::Succeeded {
            result_reference: Some(NativeHistoryReference {
                fields: Vec::new(),

                session_id: self
                    .launched
                    .last()
                    .map(|request| request.execution.id.clone())
                    .unwrap_or_default(),
                block_id: Some(format!("fake-result-{}", self.launched.len())),
                content_hash: None,
            }),
        }
    }
}

#[test]
fn fake_native_executor_completes_dependency_ordered_pipeline() {
    let mut run = Coordinator::new_run("run-1", snapshot()).unwrap();
    let mut executor = FakeNativeExecutor { launched: vec![] };

    assert_eq!(Coordinator::ready_task_ids(&run), vec!["build"]);
    let first = Coordinator::dispatch_next(
        &mut run,
        0,
        NativeExecutionReference {
            id: "native-build".to_owned(),
        },
    )
    .unwrap()
    .unwrap();
    let first_outcome = executor.execute(first.clone());
    Coordinator::complete_task(
        &mut run,
        first.run_revision,
        &first.step_id,
        first.task_revision,
        &first.execution.id,
        first_outcome,
    )
    .unwrap();

    assert_eq!(Coordinator::ready_task_ids(&run), vec!["review"]);
    let revision = run.revision();
    let second = Coordinator::dispatch_next(
        &mut run,
        revision,
        NativeExecutionReference {
            id: "native-review".to_owned(),
        },
    )
    .unwrap()
    .unwrap();
    let second_outcome = executor.execute(second.clone());
    Coordinator::complete_task(
        &mut run,
        second.run_revision,
        &second.step_id,
        second.task_revision,
        &second.execution.id,
        second_outcome,
    )
    .unwrap();

    assert_eq!(run.status(), RunStatus::Succeeded);
    assert_eq!(executor.launched.len(), 2);
    assert_eq!(executor.launched[1].profile.harness, Harness::Codex);
}

#[test]
fn denied_routes_and_spawn_do_not_broaden_snapshot_authority() {
    let definition = snapshot();
    let denied_send = authorize_send(&definition.team, "worker", "lead");
    assert!(matches!(
        denied_send,
        Err(AuthorizationError::SendDenied { .. })
    ));
    assert!(matches!(
        authorize_observe(&definition.team, "worker", "lead"),
        Err(AuthorizationError::ObserveDenied { .. })
    ));
    assert!(matches!(
        authorize_spawn(&definition, "worker-profile", "lead-profile"),
        Err(AuthorizationError::SpawnDenied { .. })
    ));

    let authorized = authorize_spawn(&definition, "lead-profile", "worker-profile").unwrap();
    assert_eq!(authorized, &definition.profiles[1]);
}

#[test]
fn caller_authenticated_sender_is_recorded_and_delivery_uses_cas() {
    let mut run = Coordinator::new_run("run-1", snapshot()).unwrap();
    Coordinator::accept_message(
        &mut run,
        0,
        &AuthenticatedSender {
            member_id: "lead".to_owned(),
        },
        MessageIntent {
            id: "message-1".to_owned(),
            recipient_member_id: "worker".to_owned(),
            body: "model text claiming sender=worker".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(run.messages()[0].sender_member_id(), "lead");
    assert_eq!(run.messages()[0].status(), MessageStatus::Accepted);

    let stale = Coordinator::mark_message_delivered(&mut run, 0, "message-1", 0);
    assert!(matches!(
        stale,
        Err(CoordinatorError::RevisionConflict { .. })
    ));
    Coordinator::mark_message_delivered(&mut run, 1, "message-1", 0).unwrap();
    assert_eq!(run.messages()[0].status(), MessageStatus::Delivered);
}

#[test]
fn stale_native_result_is_rejected() {
    let mut run = Coordinator::new_run("run-1", snapshot()).unwrap();
    let request = Coordinator::dispatch_next(
        &mut run,
        0,
        NativeExecutionReference {
            id: "current".to_owned(),
        },
    )
    .unwrap()
    .unwrap();
    let result = Coordinator::complete_task(
        &mut run,
        request.run_revision,
        &request.step_id,
        request.task_revision,
        "old-execution",
        CompletionOutcome::Succeeded {
            result_reference: None,
        },
    );
    assert!(matches!(
        result,
        Err(CoordinatorError::StaleExecution { .. })
    ));
    assert_eq!(run.tasks()[0].status(), TaskStatus::Running);
}

#[test]
fn cancellation_propagates_and_emits_typed_native_cancels() {
    let mut run = Coordinator::new_run("run-1", snapshot()).unwrap();
    Coordinator::dispatch_next(
        &mut run,
        0,
        NativeExecutionReference {
            id: "native-build".to_owned(),
        },
    )
    .unwrap();
    let revision = run.revision();
    let requests = Coordinator::cancel_run(&mut run, revision).unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].execution.id, "native-build");
    assert_eq!(run.status(), RunStatus::Cancelled);
    assert!(
        run.tasks()
            .iter()
            .all(|task| task.status() == TaskStatus::Cancelled)
    );
}

#[test]
fn restored_running_work_becomes_uncertain_and_is_not_replayed() {
    let mut run = Coordinator::new_run("run-1", snapshot()).unwrap();
    Coordinator::dispatch_next(
        &mut run,
        0,
        NativeExecutionReference {
            id: "native-build".to_owned(),
        },
    )
    .unwrap();
    let bytes = serialize_run(&run).unwrap();
    let mut restored = deserialize_run(&bytes).unwrap();
    let revision = restored.revision();
    Coordinator::restore(&mut restored, revision).unwrap();
    assert_eq!(restored.status(), RunStatus::Uncertain);
    assert_eq!(restored.tasks()[0].status(), TaskStatus::Uncertain);
    assert!(Coordinator::ready_task_ids(&restored).is_empty());
}

#[test]
fn validates_cycles_missing_ids_and_policy_enforcement_honesty() {
    let mut cyclic = snapshot();
    cyclic.pipeline.steps[0].dependency_step_ids = vec!["review".to_owned()];
    assert!(matches!(
        validate_definition(&cyclic),
        Err(DefinitionError::DependencyCycle { .. })
    ));

    let mut missing = snapshot();
    missing.pipeline.steps[1].dependency_step_ids = vec!["absent".to_owned()];
    assert!(matches!(
        validate_definition(&missing),
        Err(DefinitionError::MissingId {
            kind: "dependency step",
            ..
        })
    ));

    let mut dishonest = snapshot();
    dishonest.profiles[0].tool_policy.rules[0].enforcement = PolicyEnforcement::Advisory;
    assert!(matches!(
        validate_definition(&dishonest),
        Err(DefinitionError::MandatoryPolicyNotEnforced { .. })
    ));
}

#[test]
fn rust_json_matches_typescript_v1_golden_shape_and_rejects_unknown_fields() {
    let run = Coordinator::new_run("run-1", snapshot()).unwrap();
    let actual: serde_json::Value = serde_json::from_slice(&serialize_run(&run).unwrap()).unwrap();
    let golden = json!({
        "schemaVersion": 6,
        "id": "run-1",
        "definition": {
            "profiles": [
                {
                    "id": "lead-profile",
                    "name": "lead-profile profile",
                    "harness": "pi",
                    "modelProvider": "example-provider",
                    "model": "lead-profile-model",
                    "permissionMode": "read-only",
                    "instructions": "instructions for lead-profile",
                    "toolPolicy": {"rules": [{
                        "tool": "session.send", "decision": "allow", "enforcement": "native", "mandatory": true
                    }]},
                    "allowedSpawnProfileIds": ["worker-profile"]
                },
                {
                    "id": "worker-profile",
                    "name": "worker-profile profile",
                    "harness": "codex",
                    "modelProvider": "example-provider",
                    "model": "worker-profile-model",
                    "permissionMode": "read-only",
                    "instructions": "instructions for worker-profile",
                    "toolPolicy": {"rules": [{
                        "tool": "session.send", "decision": "allow", "enforcement": "native", "mandatory": true
                    }]},
                    "allowedSpawnProfileIds": []
                }
            ],
            "team": {
                "id": "team-1", "name": "Mixed team",
                "members": [
                    {"id": "lead", "profileId": "lead-profile"},
                    {"id": "worker", "profileId": "worker-profile"}
                ],
                "sendEdges": [{"fromMemberId": "lead", "toMemberId": "worker"}],
                "observeEdges": [{"fromMemberId": "lead", "toMemberId": "worker"}],
                "orchestratorMemberId": "lead"
            },
            "pipeline": {
                "id": "pipeline-1", "name": "Build then review",
                "steps": [
                    {"id": "build", "name": "Build", "assignedMemberId": "lead", "instructions": "Build the change", "dependencyStepIds": []},
                    {"id": "review", "name": "Review", "assignedMemberId": "worker", "instructions": "Review the result", "dependencyStepIds": ["build"]}
                ]
            },
            "launchCommand": {"id": "launch-1", "name": "Build and review", "teamId": "team-1", "pipelineId": "pipeline-1"}
        },
        "status": "running",
        "revision": 0,
        "tasks": [
            {"stepId": "build", "status": "ready", "revision": 0},
            {"stepId": "review", "status": "ready", "revision": 0}
        ],
        "messages": [],
        "agentRequests": []
    });
    assert_eq!(actual, golden);
    let round_trip = deserialize_run(&serde_json::to_vec(&golden).unwrap()).unwrap();
    assert_eq!(round_trip, run);

    let mut unknown_root = golden.clone();
    unknown_root["secret"] = json!("must reject");
    assert!(matches!(
        deserialize_run(&serde_json::to_vec(&unknown_root).unwrap()),
        Err(RunDataError::Deserialize(_))
    ));

    let mut unknown_nested = golden;
    unknown_nested["definition"]["profiles"][0]["unrecognized"] = json!(true);
    assert!(matches!(
        deserialize_run(&serde_json::to_vec(&unknown_nested).unwrap()),
        Err(RunDataError::Deserialize(_))
    ));
}

fn bridge_capabilities() -> NativeBridgeCapabilities {
    NativeBridgeCapabilities {
        permission_modes: vec![PermissionMode::ReadOnly],
        native_enforced_tools: vec!["session.send".to_owned()],
        coordinator_enforced_tools: vec![
            "orchestration.roster".to_owned(),
            "orchestration.send".to_owned(),
            "orchestration.observe".to_owned(),
            "orchestration.spawn".to_owned(),
        ],
        agent_operations: AgentOperationCapabilities {
            roster: true,
            send: true,
            observe: true,
            spawn: true,
        },
    }
}

#[test]
fn bridge_capabilities_reject_unsupported_mandatory_native_rule() {
    let profile = &snapshot().profiles[0];
    let mut unsupported = bridge_capabilities();
    unsupported.native_enforced_tools.clear();
    assert!(matches!(
        validate_profile_capabilities(profile, &unsupported),
        Err(DefinitionError::MandatoryToolUnsupported { .. })
    ));
    validate_profile_capabilities(profile, &bridge_capabilities()).unwrap();
}

#[test]
fn durable_launch_lease_blocks_dispatch_and_recovers_uncertain() {
    let mut run = Coordinator::new_run("run-lease", snapshot()).unwrap();
    let lease = Coordinator::lease_next_task(&mut run, 0, "lease-1".to_owned())
        .unwrap()
        .unwrap();
    assert_eq!(lease.step_id, "build");
    assert!(Coordinator::ready_task_ids(&run).is_empty());
    assert!(
        Coordinator::dispatch_next(
            &mut run,
            lease.run_revision,
            NativeExecutionReference {
                id: "other".to_owned()
            },
        )
        .unwrap()
        .is_none()
    );

    let bytes = serialize_run(&run).unwrap();
    let mut restored = deserialize_run(&bytes).unwrap();
    let revision = restored.revision();
    Coordinator::restore(&mut restored, revision).unwrap();
    assert_eq!(restored.tasks()[0].status(), TaskStatus::Uncertain);
    assert_eq!(restored.tasks()[0].lease_id(), None);
    assert!(Coordinator::ready_task_ids(&restored).is_empty());
}

#[test]
fn controlled_spawn_resolves_exact_snapshot_and_commits_lease_once() {
    let mut run = Coordinator::new_run("run-spawn", snapshot()).unwrap();
    let request = Coordinator::dispatch_next(
        &mut run,
        0,
        NativeExecutionReference {
            id: "lead-session".to_owned(),
        },
    )
    .unwrap()
    .unwrap();
    Coordinator::complete_task(
        &mut run,
        request.run_revision,
        &request.step_id,
        request.task_revision,
        &request.execution.id,
        CompletionOutcome::Succeeded {
            result_reference: Some(NativeHistoryReference {
                fields: Vec::new(),

                session_id: "lead-session".to_owned(),
                block_id: Some("final".to_owned()),
                content_hash: Some("ab".repeat(32)),
            }),
        },
    )
    .unwrap();
    let revision = run.revision();
    let lease = Coordinator::lease_controlled_spawn(
        &mut run,
        revision,
        "lead",
        "review",
        "tool-call-1".to_owned(),
    )
    .unwrap();
    assert_eq!(lease.profile.id, "worker-profile");
    assert_eq!(lease.dependency_result_references.len(), 1);
    assert!(Coordinator::ready_task_ids(&run).is_empty());
    let launch = Coordinator::dispatch_leased_task(
        &mut run,
        lease.run_revision,
        &lease.step_id,
        lease.task_revision,
        &lease.lease_id,
        NativeExecutionReference {
            id: "worker-session".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(launch.profile, snapshot().profiles[1]);
    assert!(matches!(
        Coordinator::dispatch_leased_task(
            &mut run,
            launch.run_revision,
            &launch.step_id,
            launch.task_revision,
            "tool-call-1",
            NativeExecutionReference {
                id: "duplicate".to_owned()
            },
        ),
        Err(CoordinatorError::InvalidTaskStatus { .. })
    ));
}

#[test]
fn native_agent_request_ids_are_durable_and_cannot_change_authority() {
    let mut run = Coordinator::new_run("run-request", snapshot()).unwrap();
    assert!(
        Coordinator::record_agent_request(
            &mut run,
            0,
            "call-1".to_owned(),
            "session-1".to_owned(),
            "lead".to_owned(),
            AgentRequestKind::Observe {
                target_member_id: "worker".to_owned()
            },
        )
        .unwrap()
    );
    let revision = run.revision();
    assert!(
        !Coordinator::record_agent_request(
            &mut run,
            revision,
            "call-1".to_owned(),
            "session-1".to_owned(),
            "lead".to_owned(),
            AgentRequestKind::Observe {
                target_member_id: "worker".to_owned()
            },
        )
        .unwrap()
    );
    assert!(matches!(
        Coordinator::record_agent_request(
            &mut run,
            revision,
            "call-1".to_owned(),
            "session-2".to_owned(),
            "worker".to_owned(),
            AgentRequestKind::Roster,
        ),
        Err(CoordinatorError::AgentRequestConflict { .. })
    ));
}

#[test]
fn history_reference_requires_sha256_hex_when_hash_is_present() {
    let invalid = NativeHistoryReference {
        fields: Vec::new(),

        session_id: "session".to_owned(),
        block_id: None,
        content_hash: Some("not-a-hash".to_owned()),
    };
    assert!(matches!(
        validate_history_reference(&invalid),
        Err(DefinitionError::InvalidHistoryReference)
    ));
    let valid = NativeHistoryReference {
        fields: Vec::new(),

        session_id: "session".to_owned(),
        block_id: None,
        content_hash: Some("0f".repeat(32)),
    };
    validate_history_reference(&valid).unwrap();
}

#[test]
fn uncertain_work_requires_explicit_reconcile_or_retry() {
    let mut retry_run = Coordinator::new_run("retry-run", snapshot()).unwrap();
    let launch = Coordinator::dispatch_next(
        &mut retry_run,
        0,
        NativeExecutionReference {
            id: "unknown-session".to_owned(),
        },
    )
    .unwrap()
    .unwrap();
    Coordinator::restore(&mut retry_run, launch.run_revision).unwrap();
    let run_revision = retry_run.revision();
    let task_revision = retry_run.tasks()[0].revision();
    Coordinator::retry_uncertain_task(&mut retry_run, run_revision, "build", task_revision)
        .unwrap();
    assert_eq!(Coordinator::ready_task_ids(&retry_run), vec!["build"]);

    let mut reconcile_run = Coordinator::new_run("reconcile-run", snapshot()).unwrap();
    let launch = Coordinator::dispatch_next(
        &mut reconcile_run,
        0,
        NativeExecutionReference {
            id: "found-session".to_owned(),
        },
    )
    .unwrap()
    .unwrap();
    Coordinator::restore(&mut reconcile_run, launch.run_revision).unwrap();
    let run_revision = reconcile_run.revision();
    let task_revision = reconcile_run.tasks()[0].revision();
    Coordinator::reconcile_uncertain_task(
        &mut reconcile_run,
        run_revision,
        "build",
        task_revision,
        UncertainResolution::Succeeded {
            result_reference: Some(NativeHistoryReference {
                fields: Vec::new(),

                session_id: "found-session".to_owned(),
                block_id: None,
                content_hash: Some("10".repeat(32)),
            }),
        },
    )
    .unwrap();
    assert_eq!(Coordinator::ready_task_ids(&reconcile_run), vec!["review"]);
}

#[test]
fn agent_request_journal_uses_final_bridge_field_names() {
    let value = serde_json::to_value(AgentRequestKind::Observe {
        target_member_id: "worker".to_owned(),
    })
    .unwrap();
    assert_eq!(
        value,
        json!({"type": "observe", "targetMemberId": "worker"})
    );
    let decoded: AgentRequestKind = serde_json::from_value(value).unwrap();
    assert_eq!(
        decoded,
        AgentRequestKind::Observe {
            target_member_id: "worker".to_owned()
        }
    );
}

#[test]
fn coordinator_deny_rule_blocks_reverse_operation_even_when_acl_allows_it() {
    let mut definition = snapshot();
    definition.profiles[0].tool_policy.rules.push(ToolRule {
        tool: "orchestration.spawn".to_owned(),
        decision: ToolDecision::Deny,
        enforcement: PolicyEnforcement::Coordinator,
        mandatory: true,
    });
    validate_definition(&definition).unwrap();
    assert!(matches!(
        authorize_coordinator_tool(&definition, "lead", "orchestration.spawn"),
        Err(AuthorizationError::CoordinatorToolDenied { .. })
    ));
    authorize_coordinator_tool(&definition, "lead", "orchestration.send").unwrap();
}

#[test]
fn child_authority_cannot_widen_files_tools_resources_or_delegation() {
    let mut definition = snapshot();
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_ok());
    definition.profiles[1].permission_mode = PermissionMode::FullAccess;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_err());
    definition.profiles[1].permission_mode = PermissionMode::ReadOnly;
    definition.profiles[1].tool_policy.rules.clear();
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_err());
    definition.profiles[1].tool_policy = definition.profiles[0].tool_policy.clone();
    definition.profiles[0].resource_rules.push(ResourceRule {
        kind: ResourceKind::Mcp,
        id: "private".into(),
        enabled: false,
    });
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_err());
    definition.profiles[1].resource_rules = definition.profiles[0].resource_rules.clone();
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_ok());
    definition.profiles[1].network_access = true;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_err());
    definition.profiles[0].network_access = true;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_ok());
    definition.profiles[1]
        .allowed_spawn_profile_ids
        .push("lead-profile".into());
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_err());
}

#[test]
fn native_defaults_do_not_prove_cross_harness_authority() {
    let mut definition = snapshot();
    definition.profiles[0].permission_mode = PermissionMode::Native;
    definition.profiles[1].permission_mode = PermissionMode::Native;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_err());
    definition.profiles[1].harness = definition.profiles[0].harness;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_ok());
}

#[test]
fn claude_code_harness_is_an_additive_v6_identity() {
    assert_eq!(
        serde_json::to_value(Harness::ClaudeCode).unwrap(),
        json!("claude-code")
    );
    let mut profile = profile("claude-profile", Harness::ClaudeCode, &[]);
    profile.reasoning = Some("xhigh".into());
    let stored = serde_json::to_value(&profile).unwrap();
    assert_eq!(stored["harness"], json!("claude-code"));
    assert_eq!(
        serde_json::from_value::<AgentProfile>(stored).unwrap(),
        profile
    );
    // Definitions recorded before this harness existed read back unchanged.
    for (name, harness) in [
        ("pi", Harness::Pi),
        ("prime-agent", Harness::PrimeAgent),
        ("codex", Harness::Codex),
        ("hermes", Harness::Hermes),
    ] {
        assert_eq!(
            serde_json::from_value::<Harness>(json!(name)).unwrap(),
            harness
        );
    }
    assert!(serde_json::from_value::<Harness>(json!("claude")).is_err());
}

#[test]
fn claude_code_native_defaults_are_incomparable_with_other_harnesses() {
    for other in [
        Harness::Pi,
        Harness::PrimeAgent,
        Harness::Codex,
        Harness::Hermes,
    ] {
        for (lead, worker) in [(Harness::ClaudeCode, other), (other, Harness::ClaudeCode)] {
            let mut definition = snapshot();
            definition.profiles[0].harness = lead;
            definition.profiles[1].harness = worker;
            definition.profiles[0].permission_mode = PermissionMode::Native;
            definition.profiles[1].permission_mode = PermissionMode::Native;
            assert!(
                authorize_spawn(&definition, "lead-profile", "worker-profile").is_err(),
                "native {lead:?} -> native {worker:?} must be rejected"
            );
        }
    }
    let mut definition = snapshot();
    definition.profiles[0].harness = Harness::ClaudeCode;
    definition.profiles[1].harness = Harness::ClaudeCode;
    definition.profiles[0].permission_mode = PermissionMode::Native;
    definition.profiles[1].permission_mode = PermissionMode::Native;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_ok());
    // A native parent proves nothing about a declared preset of its child.
    definition.profiles[1].permission_mode = PermissionMode::ReadOnly;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_err());
    // Declared presets stay comparable across adapters and cannot escalate.
    definition.profiles[0].permission_mode = PermissionMode::ReadOnly;
    definition.profiles[1].harness = Harness::Codex;
    definition.profiles[1].permission_mode = PermissionMode::WorkspaceWrite;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_err());
    definition.profiles[1].permission_mode = PermissionMode::ReadOnly;
    assert!(authorize_spawn(&definition, "lead-profile", "worker-profile").is_ok());
}

#[test]
fn run_trigger_is_additive_frozen_and_bounded() {
    // A run without a trigger keeps the v6.2 shape exactly.
    let manual = Coordinator::new_run("manual", snapshot()).unwrap();
    assert!(manual.trigger().is_none());
    assert_eq!(manual.chain_depth(), 0);
    let bytes = serialize_run(&manual).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("trigger"));
    assert_eq!(deserialize_run(&bytes).unwrap(), manual);

    let trigger = RunTrigger::Event {
        schedule_id: "after-build".into(),
        schedule_name: "After build".into(),
        occurrence_id: "event-1".into(),
        event: RunTriggerEvent::RunFinished,
        source_run_id: Some("build-run".into()),
        chain_depth: 2,
    };
    let run = Coordinator::new_triggered_run(
        "chained",
        snapshot(),
        Default::default(),
        Some(trigger.clone()),
    )
    .unwrap();
    assert_eq!(run.trigger(), Some(&trigger));
    assert_eq!(run.chain_depth(), 2);
    let value = serde_json::to_value(&run).unwrap();
    assert_eq!(
        value["trigger"],
        json!({"kind":"event","scheduleId":"after-build","scheduleName":"After build","occurrenceId":"event-1","event":"run-finished","sourceRunId":"build-run","chainDepth":2})
    );
    assert_eq!(
        deserialize_run(&serde_json::to_vec(&value).unwrap()).unwrap(),
        run
    );
    assert_eq!(
        serde_json::to_value(RunTrigger::Chat { session_id: None }).unwrap(),
        json!({"kind":"chat"})
    );
    assert_eq!(
        RunTrigger::Schedule {
            schedule_id: "nightly".into(),
            schedule_name: "Nightly".into(),
            occurrence_id: "schedule-1".into(),
        }
        .chain_depth(),
        0
    );

    // Out-of-range depths, blank or control-character identifiers and
    // unknown fields are refused both at creation and on read.
    for invalid in [
        RunTrigger::Event {
            schedule_id: "loop".into(),
            schedule_name: "Loop".into(),
            occurrence_id: "event-2".into(),
            event: RunTriggerEvent::FilesChanged,
            source_run_id: None,
            chain_depth: MAX_TRIGGER_CHAIN_DEPTH + 1,
        },
        RunTrigger::Chat {
            session_id: Some(" ".into()),
        },
        RunTrigger::Chat {
            session_id: Some("chat\nsession".into()),
        },
    ] {
        assert!(
            Coordinator::new_triggered_run("bad", snapshot(), Default::default(), Some(invalid))
                .is_err()
        );
    }
    let mut tampered = value.clone();
    tampered["trigger"]["chainDepth"] = json!(0);
    assert!(deserialize_run(&serde_json::to_vec(&tampered).unwrap()).is_err());
    let mut unknown = value;
    unknown["trigger"]["sessionId"] = json!("chat");
    assert!(deserialize_run(&serde_json::to_vec(&unknown).unwrap()).is_err());
}
