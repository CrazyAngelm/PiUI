use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::*;

fn capabilities(roster: bool, send: bool, observe: bool, spawn: bool) -> NativeBridgeCapabilities {
    serde_json::from_value(json!({
        "permissionModes":["native"],"nativeEnforcedTools":[],"coordinatorEnforcedTools":[],
        "agentOperations":{"roster":roster,"send":send,"observe":observe,"spawn":spawn}
    }))
    .unwrap()
}

fn all_operations() -> NativeBridgeCapabilities {
    capabilities(true, true, true, true)
}

fn profile(id: &str, harness: &str, mode: &str, allowed: &[&str]) -> Value {
    json!({"id":id,"name":id,"harness":harness,"model":"native","permissionMode":mode,
        "instructions":"","toolPolicy":{"rules":[]},"allowedSpawnProfileIds":allowed})
}

/// A lead that sends to and observes a peer and may spawn a reviewer role.
fn team() -> Value {
    json!({
        "profiles":[profile("lead","codex","native",&["reviewer"]), profile("reviewer","codex","native",&[])],
        "team":{"id":"team","name":"Team",
            "members":[{"id":"lead","profileId":"lead"},{"id":"peer","profileId":"reviewer"},{"id":"reviewer","profileId":"reviewer"}],
            "sendEdges":[{"fromMemberId":"lead","toMemberId":"peer"}],
            "observeEdges":[{"fromMemberId":"lead","toMemberId":"peer"}],"orchestratorMemberId":"lead"},
        "pipeline":{"id":"pipeline","name":"Pipeline","steps":[
            {"id":"a-work","name":"Work","assignedMemberId":"lead","instructions":"Work","dependencyStepIds":[]},
            {"id":"b-peer","name":"Peer","assignedMemberId":"peer","instructions":"Peer work","dependencyStepIds":[]},
            {"id":"review","name":"Review","assignedMemberId":"reviewer","instructions":"Review",
             "inputInstructions":"Changed paths","executionMode":"callable","dependencyStepIds":[]}
        ]}
    })
}

fn definition(value: Value) -> RunDefinitionSnapshot {
    serde_json::from_value(value).unwrap()
}

/// The run with its first ready step running under `execution`.
fn running(value: Value, execution: &str) -> Run {
    let mut run = Coordinator::new_run("run", definition(value)).unwrap();
    Coordinator::dispatch_next(
        &mut run,
        0,
        NativeExecutionReference {
            id: execution.into(),
        },
    )
    .unwrap()
    .unwrap();
    run
}

fn request(id: &str, operation: AgentToolOperation) -> AgentToolRequest {
    AgentToolRequest {
        request_id: id.into(),
        operation,
    }
}

fn spawn_agent(id: &str, profile_id: &str) -> AgentToolRequest {
    request(
        id,
        AgentToolOperation::SpawnAgent {
            profile_id: profile_id.into(),
            name: "Child".into(),
            instructions: "Review".into(),
        },
    )
}

/// Refuses and proves that nothing, not even the request record, changed.
fn refused(
    run: &mut Run,
    execution: &str,
    request: AgentToolRequest,
    capabilities: &NativeBridgeCapabilities,
) -> AgentRequestError {
    let before = run.clone();
    let error = admit_agent_request(run, execution, request, capabilities).unwrap_err();
    assert_eq!(*run, before, "a refused request must not change the run");
    error
}

/// The behaviour native Desktop has always had (its
/// `dynamic_spawn_request_replays_committed_identity_without_duplicate_agent`).
#[test]
fn spawn_request_replays_committed_identity_without_duplicate_agent() {
    let mut run = running(
        json!({
            "profiles":[{"id":"profile","name":"Worker","harness":"codex","model":"native","permissionMode":"native","instructions":"","whenToCall":"When review is needed","inputInstructions":"Profile default","expectedResult":"Findings with evidence","toolPolicy":{"rules":[]},"allowedSpawnProfileIds":["profile"]}],
            "team":{"id":"team","name":"Team","members":[{"id":"parent","profileId":"profile"}],"sendEdges":[],"observeEdges":[],"orchestratorMemberId":"parent"},
            "pipeline":{"id":"pipeline","name":"Pipeline","steps":[{"id":"task","name":"Task","assignedMemberId":"parent","instructions":"Work","inputInstructions":"Changed paths and tests","dependencyStepIds":[]}]}
        }),
        "parent-session",
    );
    let capabilities = all_operations();
    let AgentRequestAdmission::Roster { spawn_profiles, .. } = admit_agent_request(
        &mut run,
        "parent-session",
        request("roster-one", AgentToolOperation::Roster),
        &capabilities,
    )
    .unwrap() else {
        panic!("expected roster");
    };
    assert_eq!(spawn_profiles.len(), 1);
    assert_eq!(
        spawn_profiles[0].when_to_call.as_deref(),
        Some("When review is needed")
    );
    assert_eq!(
        spawn_profiles[0].input_instructions.as_deref(),
        Some("Changed paths and tests")
    );
    assert_eq!(
        spawn_profiles[0].expected_result.as_deref(),
        Some("Findings with evidence")
    );
    let spawn = spawn_agent("spawn-one", "profile");
    let AgentRequestAdmission::Spawn { lease } =
        admit_agent_request(&mut run, "parent-session", spawn.clone(), &capabilities).unwrap()
    else {
        panic!("expected lease");
    };
    let revision = run.revision();
    Coordinator::dispatch_leased_task(
        &mut run,
        revision,
        &lease.step_id,
        lease.task_revision,
        &lease.lease_id,
        NativeExecutionReference {
            id: "child-session".into(),
        },
    )
    .unwrap();
    assert!(matches!(
        admit_agent_request(&mut run, "parent-session", spawn, &capabilities).unwrap(),
        AgentRequestAdmission::SpawnCommitted { workspace_session_id, .. } if workspace_session_id == "child-session"
    ));
    let forged = request(
        "spawn-one",
        AgentToolOperation::SpawnAgent {
            profile_id: "profile".into(),
            name: "Other".into(),
            instructions: "Different".into(),
        },
    );
    let error = refused(&mut run, "parent-session", forged, &capabilities);
    assert_eq!(error.disposition(), AgentRequestDisposition::Conflict);
    assert_eq!(run.tasks().len(), 2);
}

#[test]
fn roster_send_and_observe_follow_frozen_routes_and_identical_retries() {
    let mut run = running(team(), "lead-session");
    let capabilities = all_operations();
    let AgentRequestAdmission::Roster {
        members,
        spawn_profiles,
    } = admit_agent_request(
        &mut run,
        "lead-session",
        request("roster", AgentToolOperation::Roster),
        &capabilities,
    )
    .unwrap()
    else {
        panic!("expected roster");
    };
    assert_eq!(
        members,
        vec![ReachableMember {
            member_id: "peer".into(),
            profile_id: "reviewer".into(),
            harness: Harness::Codex,
            can_send: true,
            can_observe: true,
        }]
    );
    assert_eq!(
        spawn_profiles[0].input_instructions.as_deref(),
        Some("Changed paths")
    );
    let send = request(
        "message-1",
        AgentToolOperation::Send {
            recipient_member_id: "peer".into(),
            body: "Please check".into(),
        },
    );
    let first = admit_agent_request(&mut run, "lead-session", send.clone(), &capabilities).unwrap();
    let revision = run.revision();
    assert_eq!(
        admit_agent_request(&mut run, "lead-session", send.clone(), &capabilities).unwrap(),
        first
    );
    assert_eq!(
        run.revision(),
        revision,
        "an identical retry records nothing"
    );
    Coordinator::mark_message_delivered(&mut run, revision, "message-1", 0).unwrap();
    assert!(matches!(
        admit_agent_request(&mut run, "lead-session", send, &capabilities).unwrap(),
        AgentRequestAdmission::Send {
            already_delivered: true,
            ..
        }
    ));
    let changed_body = request(
        "message-1",
        AgentToolOperation::Send {
            recipient_member_id: "peer".into(),
            body: "Something else".into(),
        },
    );
    let error = refused(&mut run, "lead-session", changed_body, &capabilities);
    assert_eq!(error, AgentRequestError::MessageConflict);
    assert_eq!(error.disposition(), AgentRequestDisposition::Conflict);
    let AgentRequestAdmission::Observe {
        member_id,
        history_references,
    } = admit_agent_request(
        &mut run,
        "lead-session",
        request(
            "observe",
            AgentToolOperation::Observe {
                target_member_id: "peer".into(),
            },
        ),
        &capabilities,
    )
    .unwrap()
    else {
        panic!("expected observe");
    };
    assert_eq!(member_id, "peer");
    assert!(history_references.is_empty(), "the peer has not run yet");
    // No route was drawn from the peer back to the lead.
    let mut peer_run = run.clone();
    let revision = peer_run.revision();
    Coordinator::dispatch_next(
        &mut peer_run,
        revision,
        NativeExecutionReference {
            id: "peer-session".into(),
        },
    )
    .unwrap()
    .unwrap();
    let back = request(
        "back",
        AgentToolOperation::Send {
            recipient_member_id: "lead".into(),
            body: "Reply".into(),
        },
    );
    let error = refused(&mut peer_run, "peer-session", back, &capabilities);
    assert!(matches!(error, AgentRequestError::RouteDenied(_)));
    assert_eq!(error.disposition(), AgentRequestDisposition::Denied);
}

#[test]
fn identity_adapter_offer_and_tool_policy_are_checked_before_any_record() {
    let mut run = running(team(), "lead-session");
    let roster = || request("roster", AgentToolOperation::Roster);
    let error = refused(
        &mut run,
        "lead-session",
        request(" ", AgentToolOperation::Roster),
        &all_operations(),
    );
    assert_eq!(error.disposition(), AgentRequestDisposition::Invalid);
    let without_roster = capabilities(false, true, true, true);
    let error = refused(&mut run, "lead-session", roster(), &without_roster);
    assert_eq!(
        error,
        AgentRequestError::OperationUnavailable {
            tool: "orchestration.roster"
        }
    );
    assert_eq!(error.disposition(), AgentRequestDisposition::Denied);
    for execution in ["unknown-session", ""] {
        let error = refused(&mut run, execution, roster(), &all_operations());
        assert_eq!(error, AgentRequestError::UnknownActor);
        assert_eq!(error.disposition(), AgentRequestDisposition::Denied);
    }
    let mut value = team();
    value["profiles"][0]["toolPolicy"]["rules"] = json!([{"tool":"orchestration.roster",
        "decision":"deny","enforcement":"coordinator","mandatory":false}]);
    let mut denied = running(value, "lead-session");
    let error = refused(&mut denied, "lead-session", roster(), &all_operations());
    assert!(matches!(error, AgentRequestError::ToolDenied(_)));
    assert_eq!(error.disposition(), AgentRequestDisposition::Denied);
}

#[test]
fn spawns_never_escalate_and_unlike_native_defaults_are_incomparable() {
    // Native defaults of different harnesses cannot be compared, so the
    // grant cannot be proven same-or-less and is denied, never guessed.
    let mut value = team();
    value["profiles"] = json!([
        profile("lead", "hermes", "native", &["reviewer"]),
        profile("reviewer", "codex", "native", &[])
    ]);
    let mut run = running(value.clone(), "lead-session");
    let error = refused(
        &mut run,
        "lead-session",
        spawn_agent("spawn", "reviewer"),
        &all_operations(),
    );
    assert!(matches!(
        error,
        AgentRequestError::SpawnAgent(CoordinatorError::Authorization(
            AuthorizationError::SpawnDenied { .. }
        ))
    ));
    assert_eq!(error.disposition(), AgentRequestDisposition::Denied);
    let spawn_role = request(
        "role",
        AgentToolOperation::Spawn {
            step_id: "review".into(),
        },
    );
    let error = refused(&mut run, "lead-session", spawn_role, &all_operations());
    assert_eq!(error.disposition(), AgentRequestDisposition::Denied);
    let refusals = definition_refusals(
        &definition(value),
        &bound(&["lead", "reviewer"]),
        agent_only(),
    );
    assert_eq!(
        refusals,
        vec![
            AdmissionRefusal {
                code: AdmissionRefusalCode::DelegationDenied,
                subject: AdmissionSubject::Profile { id: "lead".into() },
            },
            AdmissionRefusal {
                code: AdmissionRefusalCode::DelegationDenied,
                subject: AdmissionSubject::Step {
                    id: "review".into()
                },
            },
        ]
    );
    // More file authority, network access or a dropped denial is escalation.
    let mut wider = team();
    wider["profiles"] = json!([
        profile("lead", "codex", "workspace-write", &["reviewer"]),
        profile("reviewer", "codex", "full-access", &[])
    ]);
    let mut run = running(wider, "lead-session");
    let error = refused(
        &mut run,
        "lead-session",
        spawn_agent("wider", "reviewer"),
        &all_operations(),
    );
    assert_eq!(error.disposition(), AgentRequestDisposition::Denied);
}

/// The shared boundary leaves the adapter a spawned profile launches on to the
/// host. Native Desktop checks a controlled spawn against the calling agent's
/// adapter (its `controlled_spawn_target_must_be_launchable_by_the_calling_adapter`);
/// kernel protocol 2 checks the spawned profile's own frozen capabilities.
#[test]
fn a_spawn_admission_leaves_the_launch_adapter_to_the_host() {
    let mut value = team();
    value["profiles"][1]["toolPolicy"]["rules"] = json!([{"tool":"shell","decision":"deny",
        "enforcement":"native","mandatory":true}]);
    // The lead's own copy of the denial keeps the grant same-or-less.
    value["profiles"][0]["toolPolicy"]["rules"] =
        value["profiles"][1]["toolPolicy"]["rules"].clone();
    let mut run = running(value, "lead-session");
    let spawn_role = request(
        "role",
        AgentToolOperation::Spawn {
            step_id: "review".into(),
        },
    );
    // The caller's adapter offers spawn but could not enforce the reviewer's
    // mandatory native denial itself.
    let caller = all_operations();
    assert!(validate_profile_capabilities(&run.definition().profiles[1], &caller).is_err());
    let AgentRequestAdmission::Spawn { lease } =
        admit_agent_request(&mut run, "lead-session", spawn_role.clone(), &caller).unwrap()
    else {
        panic!("expected lease");
    };
    assert_eq!(lease.step_id, "review");
    assert_eq!(lease.member_id, "reviewer");
    assert_eq!(lease.profile.id, "reviewer");
    // The same request identity replays the same durable lease.
    assert_eq!(
        admit_agent_request(&mut run, "lead-session", spawn_role, &caller).unwrap(),
        AgentRequestAdmission::Spawn { lease }
    );
}

#[test]
fn desktop_dispositions_are_preserved_for_every_refusal() {
    use AgentRequestDisposition::{Conflict, Denied, Invalid, NotFound};
    let revision = CoordinatorError::RevisionConflict {
        scope: "run",
        expected: 0,
        actual: 1,
    };
    let authorization = CoordinatorError::Authorization(AuthorizationError::UnknownMember {
        member_id: "x".into(),
    });
    let lease = CoordinatorError::LeaseConflict {
        step_id: "x".into(),
    };
    let unknown = CoordinatorError::UnknownTask {
        step_id: "x".into(),
    };
    let paused = CoordinatorError::RunPaused;
    let request_conflict = CoordinatorError::AgentRequestConflict {
        request_id: "x".into(),
    };
    let cases = [
        (AgentRequestError::Record(request_conflict), Conflict),
        (AgentRequestError::Record(revision.clone()), Conflict),
        (AgentRequestError::Record(paused.clone()), Invalid),
        (AgentRequestError::Message(authorization.clone()), Denied),
        (AgentRequestError::Message(revision.clone()), Conflict),
        (AgentRequestError::Message(paused.clone()), Invalid),
        (AgentRequestError::SpawnAgent(paused.clone()), Denied),
        (AgentRequestError::SpawnAgentLease(paused.clone()), Conflict),
        (AgentRequestError::SpawnLease(authorization), Denied),
        (AgentRequestError::SpawnLease(revision), Conflict),
        (AgentRequestError::SpawnLease(lease), Conflict),
        (AgentRequestError::SpawnLease(unknown), NotFound),
        (AgentRequestError::SpawnLease(paused), Invalid),
    ];
    for (error, disposition) in cases {
        assert_eq!(error.disposition(), disposition, "{error:?}");
    }
}

fn agent_only() -> ExecutorSupport {
    ExecutorSupport {
        agent: true,
        llm: true,
        script: false,
        plugin: false,
        pipeline: false,
    }
}

fn bound(profiles: &[&str]) -> BTreeMap<String, NativeBridgeCapabilities> {
    profiles
        .iter()
        .map(|id| ((*id).to_owned(), all_operations()))
        .collect()
}

#[test]
fn offered_collaboration_is_admitted_and_each_missing_offer_is_named() {
    let team = definition(team());
    assert_eq!(
        definition_refusals(&team, &bound(&["lead", "reviewer"]), agent_only()),
        vec![]
    );
    let mut quiet = bound(&["lead", "reviewer"]);
    quiet.insert("lead".into(), capabilities(true, false, true, true));
    assert_eq!(
        definition_refusals(&team, &quiet, agent_only()),
        vec![AdmissionRefusal {
            code: AdmissionRefusalCode::UnsupportedCapability,
            subject: AdmissionSubject::SendEdge {
                from_member_id: "lead".into(),
                to_member_id: "peer".into(),
            },
        }]
    );
    quiet.insert("lead".into(), capabilities(true, true, true, false));
    let codes: Vec<_> = definition_refusals(&team, &quiet, agent_only())
        .into_iter()
        .map(|refusal| (refusal.code, refusal.subject))
        .collect();
    assert_eq!(
        codes,
        vec![
            (
                AdmissionRefusalCode::UnsupportedCapability,
                AdmissionSubject::Profile { id: "lead".into() }
            ),
            (
                AdmissionRefusalCode::UnsupportedCapability,
                AdmissionSubject::Step {
                    id: "review".into()
                }
            ),
        ]
    );
    let missing = bound(&["lead"]);
    assert_eq!(
        definition_refusals(&team, &missing, agent_only())[0],
        AdmissionRefusal {
            code: AdmissionRefusalCode::MissingCapabilities,
            subject: AdmissionSubject::Profile {
                id: "reviewer".into()
            },
        }
    );
    let mut nothing = agent_only();
    nothing.agent = false;
    assert_eq!(
        definition_refusals(&team, &bound(&["lead", "reviewer"]), nothing).len(),
        3,
        "every agent step names its unsupported executor"
    );
}

/// With no coordinator operation and only native executors, the admission
/// refuses every graph protocol 1 refuses as unsupported.
/// A named edit of the protocol 1 fixture definition.
type Variant = (&'static str, fn(&mut Value));

#[test]
fn without_operations_the_refusals_cover_every_protocol_one_refusal() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../contracts/fixtures/nano-graph-kernel-v1.json"
    ))
    .unwrap();
    let base = fixture["command"]["definition"].clone();
    let none: BTreeMap<String, NativeBridgeCapabilities> =
        serde_json::from_value(fixture["command"]["profileCapabilities"].clone()).unwrap();
    assert_eq!(
        definition_refusals(&definition(base.clone()), &none, agent_only()),
        vec![]
    );
    let variants: [Variant; 8] = [
        ("script", |d| {
            d["pipeline"]["steps"][0]["executor"] =
                json!({"type":"script","runtime":"node","source":"1","timeoutSeconds":1});
        }),
        ("grant", |d| {
            d["profiles"][0]["allowedSpawnProfileIds"] = json!(["worker"]);
        }),
        ("callable", |d| {
            d["pipeline"]["steps"][1]["executionMode"] = "callable".into();
            d["pipeline"]["steps"][1]["dependencyStepIds"] = json!([]);
            d["pipeline"]["steps"][1]["inputBindings"] = json!([]);
        }),
        ("send", |d| {
            d["team"]["sendEdges"] = json!([{"fromMemberId":"member","toMemberId":"member"}]);
        }),
        ("observe", |d| {
            d["team"]["observeEdges"] = json!([{"fromMemberId":"member","toMemberId":"member"}]);
        }),
        ("join", |d| {
            d["team"]["spawnedAgentsJoinTeam"] = true.into();
        }),
        ("allow", |d| {
            d["profiles"][0]["toolPolicy"]["rules"] = json!([{"tool":"orchestration.roster",
                "decision":"allow","enforcement":"coordinator","mandatory":false}]);
        }),
        ("unknown operation", |d| {
            d["profiles"][0]["toolPolicy"]["rules"] = json!([{"tool":"orchestration.broadcast",
                "decision":"allow","enforcement":"coordinator","mandatory":false}]);
        }),
    ];
    for (name, change) in variants {
        let mut value = base.clone();
        change(&mut value);
        assert!(
            !definition_refusals(&definition(value), &none, agent_only()).is_empty(),
            "{name}"
        );
    }
    let mut unsupported_mode = none.clone();
    unsupported_mode
        .get_mut("worker")
        .unwrap()
        .permission_modes
        .clear();
    assert!(
        !definition_refusals(&definition(base.clone()), &unsupported_mode, agent_only()).is_empty()
    );
    assert!(!definition_refusals(&definition(base), &BTreeMap::new(), agent_only()).is_empty());
}
