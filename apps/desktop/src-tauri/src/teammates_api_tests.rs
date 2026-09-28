use super::*;
use crate::orchestration_api::save_graph;
use piui_orchestration::{BoardRunCause, Coordinator, RunDefinitionSnapshot};
use std::collections::BTreeMap;

const PROJECT: &str = "project";
const NOW: &str = "2026-09-28T10:00:00.000Z";

fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("piui-teammates-{}", Uuid::new_v4()))
}

fn simple_draft(handle: &str) -> TeammateDraftV1 {
    serde_json::from_value(json!({
        "handle": handle,
        "name": "Reviewer",
        "color": "#7c3aed",
        "avatar": "RV",
        "role": "Reviews diffs for correctness.",
        "body": {
            "type": "simple",
            "agent": {
                "harness": "codex",
                "model": "gpt-5.5",
                "permissionMode": "read-only",
                "reasoning": "high",
                "serviceTier": "fast",
                "instructions": "Review carefully."
            }
        },
        "cardInput": { "type": "auto" },
        "board": { "read": true, "comment": true, "create": false, "move": true, "claim": true, "assign": false },
        "maxConcurrentRuns": 1,
        "wake": { "onAssign": "ask", "onMention": true },
        "enabled": true
    }))
    .expect("draft decodes")
}

fn pipeline_draft(handle: &str, launch_command_id: &str) -> TeammateDraftV1 {
    let value = json!({
        "handle": handle,
        "name": "Release",
        "color": "chaos-red",
        "avatar": "R",
        "role": "",
        "body": { "type": "pipeline", "launchCommandId": launch_command_id },
        "cardInput": { "type": "auto" },
        "board": { "read": true, "comment": true, "create": false, "move": false, "claim": false, "assign": false },
        "maxConcurrentRuns": 2,
        "wake": { "onAssign": "never", "onMention": false },
        "enabled": true
    });
    serde_json::from_value(value).expect("draft decodes")
}

fn user_graph(state: &OrchestrationApiState) {
    save_graph(
        state,
        serde_json::from_value(json!({
            "workspaceId": PROJECT,
            "profiles":[{"workspaceId":PROJECT,"value":{"id":"writer","name":"Writer","harness":"codex","model":"model","permissionMode":"read-only","instructions":"","toolPolicy":{"rules":[]},"allowedSpawnProfileIds":[]}}],
            "team":{"workspaceId":PROJECT,"value":{"id":"team","name":"Team","members":[{"id":"node","profileId":"writer"}],"sendEdges":[],"observeEdges":[],"orchestratorMemberId":"node"}},
            "pipeline":{"workspaceId":PROJECT,"value":{"id":"pipeline","name":"Release","steps":[{"id":"node","name":"Task","assignedMemberId":"node","instructions":"Ship {{input.message}}","dependencyStepIds":[]}],"inputs":[{"name":"message","label":"Message","kind":"text","required":true}]}},
            "command":{"workspaceId":PROJECT,"value":{"id":"release","name":"Release","teamId":"team","pipelineId":"pipeline"}}
        }))
        .expect("graph decodes"),
    )
    .expect("saves user graph");
}

fn workspace_of(state: &OrchestrationApiState) -> WorkspaceOrchestration {
    state
        .snapshot()
        .expect("snapshot")
        .workspace(PROJECT)
        .cloned()
        .expect("workspace")
}

#[test]
fn fixtures_decode_and_round_trip() {
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/teammates-v1/teammates.json"
    ))
    .expect("fixture is JSON");
    for teammate in source["teammates"].as_array().expect("teammates") {
        let decoded: Teammate = serde_json::from_value(teammate.clone()).expect("TeammateV1");
        assert_eq!(&serde_json::to_value(&decoded).unwrap(), teammate);
    }
    for draft in source["drafts"].as_array().expect("drafts") {
        let decoded: TeammateDraftV1 =
            serde_json::from_value(draft.clone()).expect("TeammateDraftV1");
        assert!(validate_draft(&decoded).is_ok());
    }
    let mut forged = source["drafts"][0].clone();
    forged["launchCommandId"] = json!("injected");
    assert!(serde_json::from_value::<TeammateDraftV1>(forged).is_err());
}

#[test]
fn saving_a_simple_teammate_writes_its_graph_in_one_generation() {
    let root = root();
    let state = OrchestrationApiState::open(&root).expect("opens");
    let mut commits = state.subscribe_commits();
    let before = *commits.borrow_and_update();
    let saved = save_teammate(&state, PROJECT, simple_draft("reviewer"), NOW).expect("saves");
    assert_eq!(*commits.borrow_and_update(), before + 1, "one generation");
    assert_eq!(saved.revision, 0);
    assert!(matches!(saved.kind, TeammateKind::Simple { .. }));

    let workspace = workspace_of(&state);
    assert_eq!(workspace.teammates.len(), 1);
    assert_eq!(workspace.profiles.len(), 1);
    assert_eq!(workspace.teams.len(), 1);
    assert_eq!(workspace.pipelines.len(), 1);
    assert_eq!(workspace.launch_commands.len(), 1);
    let command = &workspace.launch_commands[0].value;
    assert_eq!(command.id, saved.launch_command_id);
    assert_eq!(
        command.managed_by_teammate_id.as_deref(),
        Some(saved.id.as_str())
    );
    assert_eq!(command.name, "@reviewer");
    let profile = &workspace.profiles[0].value;
    assert_eq!(
        profile.when_to_call.as_deref(),
        Some("Reviews diffs for correctness.")
    );
    assert_eq!(profile.reasoning.as_deref(), Some("high"));
    assert!(profile.allowed_spawn_profile_ids.is_empty());
    assert!(profile.tool_policy.rules.is_empty());
    let team = &workspace.teams[0].value;
    assert_eq!(team.members.len(), 1);
    assert_eq!(team.orchestrator_member_id, team.members[0].id);
    let pipeline = &workspace.pipelines[0].value;
    assert_eq!(pipeline.inputs.len(), 1);
    assert_eq!(pipeline.inputs[0].name, "card");
    assert_eq!(pipeline.inputs[0].kind, PipelineInputKind::LongText);
    assert!(pipeline.inputs[0].required);
    assert!(pipeline.steps[0].instructions.contains("{{input.card}}"));
    assert_eq!(
        resolve_card_input(pipeline, &saved.card_input).as_deref(),
        Ok("card")
    );
    let status = teammate_status(Some(&workspace), &saved, 0);
    assert_eq!(status.availability, Availability::Idle);
    assert!(status.not_assignable_reason.is_none());

    // Reopening returns the same document (additive field round-trips).
    drop(state);
    let reopened = OrchestrationApiState::open(&root).expect("reopens");
    assert_eq!(workspace_of(&reopened).teammates, vec![saved]);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn updating_a_simple_teammate_updates_its_definitions_in_place() {
    let root = root();
    let state = OrchestrationApiState::open(&root).expect("opens");
    let saved = save_teammate(&state, PROJECT, simple_draft("reviewer"), NOW).expect("saves");
    let mut update = simple_draft("reviewer");
    update.id = Some(saved.id.clone());
    update.expected_revision = Some(saved.revision);
    update.name = "Senior reviewer".into();
    let updated = save_teammate(&state, PROJECT, update.clone(), NOW).expect("updates");
    assert_eq!(updated.revision, 1);
    assert_eq!(updated.launch_command_id, saved.launch_command_id);
    assert_eq!(updated.created_at, saved.created_at);
    let workspace = workspace_of(&state);
    assert_eq!(workspace.profiles.len(), 1);
    assert_eq!(workspace.launch_commands.len(), 1);
    assert_eq!(workspace.profiles[0].revision, 1);
    assert_eq!(workspace.profiles[0].value.name, "Senior reviewer");
    assert_eq!(
        save_teammate(&state, PROJECT, update, NOW).unwrap_err(),
        TeammatesError::Conflict,
        "a stale revision is refused"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn handles_are_validated_and_unique_per_project() {
    let root = root();
    let state = OrchestrationApiState::open(&root).expect("opens");
    save_teammate(&state, PROJECT, simple_draft("reviewer"), NOW).expect("saves");
    assert_eq!(
        save_teammate(&state, PROJECT, simple_draft("reviewer"), NOW).unwrap_err(),
        TeammatesError::HandleTaken
    );
    for bad in ["Bad", "a", "-lead", "has space", "x".repeat(33).as_str()] {
        assert!(
            matches!(
                save_teammate(&state, PROJECT, simple_draft(bad), NOW),
                Err(TeammatesError::Invalid(_))
            ),
            "{bad}"
        );
    }
    let normalized = save_teammate(&state, PROJECT, simple_draft("@qa-2"), NOW).expect("saves");
    assert_eq!(normalized.handle, "qa-2");
    save_teammate(&state, "other-project", simple_draft("reviewer"), NOW)
        .expect("handles are per project");
    let workspace = workspace_of(&state);
    assert_eq!(workspace.teammates.len(), 2);
    assert_eq!(workspace.profiles.len(), 2, "a refused save wrote nothing");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn invalid_agent_settings_leave_the_store_unchanged() {
    let root = root();
    let state = OrchestrationApiState::open(&root).expect("opens");
    let mut draft = simple_draft("reviewer");
    if let TeammateBodyV1::Simple { agent } = &mut draft.body {
        agent.harness = Harness::Pi;
    }
    assert!(matches!(
        save_teammate(&state, PROJECT, draft, NOW),
        Err(TeammatesError::Invalid(_))
    ));
    let mut draft = simple_draft("reviewer");
    if let TeammateBodyV1::Simple { agent } = &mut draft.body {
        agent.reasoning = Some("extreme".into());
    }
    assert!(save_teammate(&state, PROJECT, draft, NOW).is_err());
    let snapshot = state.snapshot().expect("snapshot");
    assert!(
        snapshot
            .workspace(PROJECT)
            .is_none_or(|workspace| workspace.teammates.is_empty() && workspace.profiles.is_empty())
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn deleting_a_teammate_removes_what_it_manages_and_the_chat_default() {
    let root = root();
    let state = OrchestrationApiState::open(&root).expect("opens");
    let library = PipelineLibrary::open(&root).expect("library");
    user_graph(&state);
    let saved = save_teammate(&state, PROJECT, simple_draft("reviewer"), NOW).expect("saves");
    library
        .set_chat_default(PROJECT, Some(saved.launch_command_id.as_str()))
        .expect("sets default");
    assert_eq!(
        delete_teammate(&state, PROJECT, &saved.id, saved.revision + 1).unwrap_err(),
        TeammatesError::Conflict
    );
    assert_eq!(workspace_of(&state).teammates.len(), 1);
    let result = dispatch(
        false,
        &state,
        None,
        Some(&library),
        TeammatesCommandV1::Delete {
            workspace_id: PROJECT.into(),
            teammate_id: saved.id.clone(),
            expected_revision: saved.revision,
        },
    )
    .expect("deletes");
    assert_eq!(
        result,
        TeammatesResultV1::Deleted {
            protocol: TEAMMATES_PROTOCOL,
            teammate_id: saved.id.clone(),
        }
    );
    let workspace = workspace_of(&state);
    assert!(workspace.teammates.is_empty());
    // Only the user's own graph is left.
    assert_eq!(workspace.profiles.len(), 1);
    assert_eq!(workspace.profiles[0].value.id, "writer");
    assert_eq!(workspace.launch_commands.len(), 1);
    assert_eq!(workspace.launch_commands[0].value.id, "release");
    assert_eq!(library.list(PROJECT).expect("lists").1, None);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn pipeline_teammates_wrap_user_commands_only() {
    let root = root();
    let state = OrchestrationApiState::open(&root).expect("opens");
    user_graph(&state);
    let wrapped = save_teammate(&state, PROJECT, pipeline_draft("release", "release"), NOW)
        .expect("wraps a user command");
    let workspace = workspace_of(&state);
    assert_eq!(not_assignable_reason(Some(&workspace), &wrapped), None);
    assert_eq!(workspace.profiles.len(), 1, "nothing is generated");
    assert_eq!(
        save_teammate(&state, PROJECT, pipeline_draft("ghost", "missing"), NOW).unwrap_err(),
        TeammatesError::NotFound
    );
    let simple = save_teammate(&state, PROJECT, simple_draft("reviewer"), NOW).expect("saves");
    assert!(matches!(
        save_teammate(
            &state,
            PROJECT,
            pipeline_draft("thief", &simple.launch_command_id),
            NOW
        ),
        Err(TeammatesError::Invalid(_))
    ));

    // A simple teammate turned into a pipeline teammate drops its graph.
    let mut switch = pipeline_draft("reviewer", "release");
    switch.id = Some(simple.id.clone());
    switch.expected_revision = Some(simple.revision);
    let switched = save_teammate(&state, PROJECT, switch, NOW).expect("switches");
    assert!(matches!(switched.kind, TeammateKind::Pipeline));
    let workspace = workspace_of(&state);
    assert_eq!(workspace.launch_commands.len(), 1);
    assert_eq!(workspace.profiles.len(), 1);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn card_input_resolution_follows_the_contract() {
    let pipeline = |inputs: serde_json::Value| -> PipelineDefinition {
        serde_json::from_value(json!({
            "id": "p", "name": "P",
            "steps": [{"id":"s","name":"S","assignedMemberId":"m","instructions":"","dependencyStepIds":[]}],
            "inputs": inputs
        }))
        .expect("pipeline")
    };
    let auto = TeammateCardInput::Auto;
    let both = pipeline(json!([
        {"name":"message","label":"Message","kind":"text"},
        {"name":"card","label":"Card","kind":"long-text"}
    ]));
    assert_eq!(resolve_card_input(&both, &auto).as_deref(), Ok("card"));
    let message = pipeline(json!([{"name":"message","label":"Message","kind":"text"}]));
    assert_eq!(
        resolve_card_input(&message, &auto).as_deref(),
        Ok("message")
    );
    let single = pipeline(json!([
        {"name":"brief","label":"Brief","kind":"long-text"},
        {"name":"count","label":"Count","kind":"number"}
    ]));
    assert_eq!(resolve_card_input(&single, &auto).as_deref(), Ok("brief"));
    let several = pipeline(json!([
        {"name":"brief","label":"Brief","kind":"long-text"},
        {"name":"notes","label":"Notes","kind":"text"}
    ]));
    assert!(resolve_card_input(&several, &auto).is_err());
    assert_eq!(
        resolve_card_input(
            &several,
            &TeammateCardInput::Named {
                input_name: "notes".into()
            }
        )
        .as_deref(),
        Ok("notes")
    );
    assert!(resolve_card_input(&pipeline(json!([])), &auto).is_err());
    let required_other = pipeline(json!([
        {"name":"card","label":"Card","kind":"long-text"},
        {"name":"target","label":"Target","kind":"text","required":true}
    ]));
    assert!(resolve_card_input(&required_other, &auto).is_err());
    let number = pipeline(json!([{"name":"card","label":"Card","kind":"number"}]));
    assert!(
        resolve_card_input(
            &number,
            &TeammateCardInput::Named {
                input_name: "card".into()
            }
        )
        .is_err()
    );
}

#[test]
fn live_board_runs_make_a_teammate_working() {
    let root = root();
    let state = OrchestrationApiState::open(&root).expect("opens");
    let saved = save_teammate(&state, PROJECT, simple_draft("reviewer"), NOW).expect("saves");
    let workspace = workspace_of(&state);
    let command = workspace.launch_commands[0].value.clone();
    let definition = RunDefinitionSnapshot {
        profiles: vec![workspace.profiles[0].value.clone()],
        team: workspace.teams[0].value.clone(),
        pipeline: workspace.pipelines[0].value.clone(),
        launch_command: Some(command),
    };
    let run = Coordinator::new_triggered_run(
        "board-run",
        definition,
        BTreeMap::from([("card".to_owned(), json!("#1 Fix login"))]),
        Some(RunTrigger::Board {
            card_id: "card-1".into(),
            teammate_id: saved.id.clone(),
            cause: BoardRunCause::Assigned,
            chain_depth: 0,
        }),
    )
    .expect("creates run");
    state
        .store()
        .transact(|workspaces| {
            let workspace = workspaces
                .iter_mut()
                .find(|workspace| workspace.workspace_id == PROJECT)
                .ok_or(StoreError::NotFound)?;
            workspace.runs.push(run);
            Ok(())
        })
        .expect("stores run");
    let workspace = workspace_of(&state);
    let status = teammate_status(Some(&workspace), &saved, 0);
    assert_eq!(status.availability, Availability::Working);
    assert_eq!(status.live_run_ids, vec!["board-run".to_owned()]);
    let refs = teammate_refs(Some(&workspace), &|_| 0);
    assert_eq!(refs[0].availability, Availability::Working);
    assert!(refs[0].assignable());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn safe_mode_lists_but_refuses_changes() {
    let root = root();
    let state = OrchestrationApiState::open(&root).expect("opens");
    let listed = dispatch(
        true,
        &state,
        None,
        None,
        TeammatesCommandV1::List {
            workspace_id: PROJECT.into(),
        },
    )
    .expect("lists in safe mode");
    assert!(
        matches!(listed, TeammatesResultV1::Teammates { ref teammates, .. } if teammates.is_empty())
    );
    assert_eq!(
        dispatch(
            true,
            &state,
            None,
            None,
            TeammatesCommandV1::Save {
                workspace_id: PROJECT.into(),
                teammate: simple_draft("reviewer"),
            },
        )
        .unwrap_err(),
        TeammatesError::SafeMode
    );
    let _ = std::fs::remove_dir_all(root);
}
