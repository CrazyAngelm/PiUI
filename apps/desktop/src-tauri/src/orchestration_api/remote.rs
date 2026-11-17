//! Authority for workbench mutations from a paired browser (ADR-062).
use super::*;
use sha2::{Digest, Sha256};

// Keep the v6 disk format readable by older hosts with deny_unknown_fields.
// The native host assigns IDs in this namespace. Hashing the caller's id
// preserves duplicate-start detection after a lost response or reconnect.
const REMOTE_RUN_PREFIX: &str = "nano-remote-v1-";

pub(crate) fn paired_browser_run(id: &str) -> bool {
    id.strip_prefix(REMOTE_RUN_PREFIX).is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

pub(super) fn assign_run_id(id: String, caller: WorkbenchCaller) -> Result<String, StoreError> {
    if id.trim().is_empty() || id.starts_with(REMOTE_RUN_PREFIX) {
        return Err(StoreError::Invalid);
    }
    match caller {
        WorkbenchCaller::Desktop => Ok(id),
        WorkbenchCaller::PairedBrowser => Ok(format!(
            "{REMOTE_RUN_PREFIX}{:x}",
            Sha256::digest(id.as_bytes())
        )),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkbenchCaller {
    Desktop,
    PairedBrowser,
}

fn agent_steps(pipeline: &PipelineDefinition) -> bool {
    pipeline.steps.iter().all(|step| {
        matches!(
            step.executor_kind(),
            piui_orchestration::ExecutorKind::Agent | piui_orchestration::ExecutorKind::Llm
        )
    })
}

fn read_only_profile(profile: &AgentProfile) -> bool {
    profile.permission_mode == piui_orchestration::PermissionMode::ReadOnly
        && !profile.network_access
        && profile.resource_rules.iter().all(|rule| !rule.enabled)
        && profile
            .tool_policy
            .rules
            .iter()
            .all(|rule| rule.decision == piui_orchestration::ToolDecision::Deny)
        && profile.allowed_spawn_profile_ids.is_empty()
}

fn eligible_team<'a>(
    team: &TeamDefinition,
    mut profile: impl FnMut(&str) -> Option<&'a AgentProfile>,
) -> bool {
    team.members
        .iter()
        .all(|member| profile(&member.profile_id).is_some_and(read_only_profile))
}

/// The pinned command, team and pipeline must be the same saved system. Only
/// read-only agents are admitted. Do not start a desktop completion automation
/// transitively, even if the selected graph itself contains only agent steps.
pub(super) fn check_remote_run(
    workspace: &WorkspaceOrchestration,
    run: &Run,
) -> Result<(), StoreError> {
    let definition = run.definition();
    let Some(command) = &definition.launch_command else {
        return Err(StoreError::Denied);
    };
    let follows_run = workspace.schedules.iter().any(|schedule| {
        schedule.enabled
            && schedule
                .value
                .trigger
                .event()
                .and_then(EventTrigger::source_launch_command_id)
                == Some(command.id.as_str())
    });
    let eligible = command.team_id == definition.team.id
        && command.pipeline_id == definition.pipeline.id
        && agent_steps(&definition.pipeline)
        && eligible_team(&definition.team, |id| {
            definition.profiles.iter().find(|profile| profile.id == id)
        })
        && !follows_run;
    if eligible {
        Ok(())
    } else {
        Err(StoreError::Denied)
    }
}

pub(crate) fn check_existing_run(
    state: &OrchestrationApiState,
    workspace_id: &str,
    run_id: &str,
) -> Result<(), OrchestrationApiError> {
    let store = state.snapshot()?;
    let workspace = store
        .workspace(workspace_id)
        .ok_or_else(OrchestrationApiError::not_found)?;
    let run = workspace
        .runs
        .iter()
        .find(|run| run.id() == run_id)
        .ok_or_else(OrchestrationApiError::not_found)?;
    if !paired_browser_run(run.id()) {
        return Err(OrchestrationApiError::denied());
    }
    // The immutable admitted definition and the completion engine's origin
    // guard remain in force if the owner has since added a schedule.
    Ok(())
}

/// Verify both the submitted definitions and any definitions they overwrite.
/// Creating an agent-only graph cannot be used to replace a privileged
/// profile, retarget an unrelated launch, or rewrite an executable pipeline.
pub(super) fn check_remote_save(
    workspaces: &[WorkspaceOrchestration],
    request: &SaveGraphRequest,
) -> Result<(), StoreError> {
    if request.profiles.iter().any(|p| {
        !request
            .team
            .value
            .members
            .iter()
            .any(|m| m.profile_id == p.value.id)
    }) || !agent_steps(&request.pipeline.value)
        || !request.profiles.iter().all(|p| read_only_profile(&p.value))
        || request.command.value.managed_by_teammate_id.is_some()
    {
        return Err(StoreError::Denied);
    }
    let Some(workspace) = workspaces
        .iter()
        .find(|workspace| workspace.workspace_id == request.workspace_id)
    else {
        return Ok(());
    };
    let team = &request.team.value;
    let pipeline = &request.pipeline.value;
    let command = &request.command.value;
    // Saving an existing launch increments its revision and re-pins enabled
    // schedules. Only the local owner may change a system behind a timer,
    // file/event rule, completion chain or another pipeline's child step.
    if workspace
        .teammates
        .iter()
        .any(|t| t.launch_command_id == command.id)
        || workspace.schedules.iter().any(|schedule| {
            schedule.enabled
                && (schedule.value.launch_command_id == command.id
                    || schedule
                        .value
                        .trigger
                        .event()
                        .and_then(EventTrigger::source_launch_command_id)
                        == Some(command.id.as_str()))
        })
        || crate::subpipelines::launch_command_referenced(workspace, &command.id)
    {
        return Err(StoreError::Denied);
    }
    let other_launches = || {
        workspace
            .launch_commands
            .iter()
            .map(|entry| &entry.value)
            .filter(|entry| entry.id != command.id)
    };
    if let Some(old) = workspace
        .launch_commands
        .iter()
        .map(|entry| &entry.value)
        .find(|old| old.id == command.id)
        && (old.team_id != team.id
            || old.pipeline_id != pipeline.id
            || old.managed_by_teammate_id.is_some())
    {
        return Err(StoreError::Denied);
    }
    if let Some(old) = workspace
        .pipelines
        .iter()
        .map(|entry| &entry.value)
        .find(|old| old.id == pipeline.id)
        && (!agent_steps(old)
            || (old != pipeline
                && other_launches().any(|launch| launch.pipeline_id == pipeline.id)))
    {
        return Err(StoreError::Denied);
    }
    let original_profile = |id: &str| {
        workspace
            .profiles
            .iter()
            .map(|entry| &entry.value)
            .find(|p| p.id == id)
    };
    let shared_team = other_launches().any(|launch| launch.team_id == team.id);
    if let Some(old) = workspace
        .teams
        .iter()
        .map(|entry| &entry.value)
        .find(|old| old.id == team.id)
        && (!eligible_team(old, original_profile) || (shared_team && old != team))
    {
        return Err(StoreError::Denied);
    }
    for profile in request.profiles.iter().map(|entry| &entry.value) {
        if let Some(old) = original_profile(&profile.id) {
            let shared_profile = || {
                workspace
                    .profiles
                    .iter()
                    .any(|p| p.value.allowed_spawn_profile_ids.contains(&profile.id))
                    || workspace.teams.iter().any(|t| {
                        (t.value.id != team.id || shared_team)
                            && t.value.members.iter().any(|m| m.profile_id == profile.id)
                    })
            };
            if !read_only_profile(old) || (old != profile && shared_profile()) {
                return Err(StoreError::Denied);
            }
        }
    }
    Ok(())
}

pub(crate) async fn save_remote_graph(
    state: State<'_, OrchestrationApiState>,
    host_state: State<'_, HostState>,
    request: SaveGraphRequest,
) -> Result<(), OrchestrationApiError> {
    let _operation = host_state.live_runtime_operation_gate.lock().await;
    validate_live_workspace_scope(&host_state, &request.workspace_id)?;
    save_browser_graph(&state, request)
}

pub(super) fn save_browser_graph(
    state: &OrchestrationApiState,
    request: SaveGraphRequest,
) -> Result<(), OrchestrationApiError> {
    validate_graph_request(&request)?;
    state
        .store
        .transact(|workspaces| {
            check_remote_save(workspaces, &request)?;
            apply_graph_in(workspaces, request).map(|_| ())
        })
        .map_err(Into::into)
}
