use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;

use crate::{
    AgentProfile, DirectedEdge, NativeBridgeCapabilities, NativeHistoryReference,
    PolicyEnforcement, RunDefinitionSnapshot, TeamDefinition, ToolDecision,
};

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DefinitionError {
    #[error("{kind} identifier must not be empty")]
    EmptyId { kind: &'static str },
    #[error("duplicate {kind} identifier: {id}")]
    DuplicateId { kind: &'static str, id: String },
    #[error("missing {kind} identifier: {id}")]
    MissingId { kind: &'static str, id: String },
    #[error("pipeline dependency cycle includes step: {step_id}")]
    DependencyCycle { step_id: String },
    #[error("mandatory tool rule for {tool} is only {enforcement:?}")]
    MandatoryPolicyNotEnforced {
        tool: String,
        enforcement: PolicyEnforcement,
    },
    #[error("launch command {field} does not match its snapshot definition")]
    LaunchReferenceMismatch { field: &'static str },
    #[error("native bridge does not support permission mode {mode:?}")]
    UnsupportedPermissionMode { mode: crate::PermissionMode },
    #[error("mandatory tool rule is not enforceable by this bridge: {tool}")]
    MandatoryToolUnsupported { tool: String },
    #[error("native history reference is invalid")]
    InvalidHistoryReference,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AuthorizationError {
    #[error("unknown member: {member_id}")]
    UnknownMember { member_id: String },
    #[error("unknown profile: {profile_id}")]
    UnknownProfile { profile_id: String },
    #[error("profile {spawner_profile_id} may not spawn profile {requested_profile_id}")]
    SpawnDenied {
        spawner_profile_id: String,
        requested_profile_id: String,
    },
    #[error("member {from_member_id} may not send to member {to_member_id}")]
    SendDenied {
        from_member_id: String,
        to_member_id: String,
    },
    #[error("member {from_member_id} may not observe member {to_member_id}")]
    ObserveDenied {
        from_member_id: String,
        to_member_id: String,
    },
    #[error("member {member_id} is denied coordinator operation {tool}")]
    CoordinatorToolDenied { member_id: String, tool: String },
}

pub fn validate_definition(snapshot: &RunDefinitionSnapshot) -> Result<(), DefinitionError> {
    let profiles = unique_ids(
        "profile",
        snapshot.profiles.iter().map(|profile| profile.id.as_str()),
    )?;
    for profile in &snapshot.profiles {
        require_nonempty("profile name", &profile.name)?;
        require_nonempty("model", &profile.model)?;
        let mut tools = BTreeSet::new();
        for rule in &profile.tool_policy.rules {
            require_nonempty("tool", &rule.tool)?;
            if !tools.insert(rule.tool.as_str()) {
                return Err(DefinitionError::DuplicateId {
                    kind: "tool rule",
                    id: rule.tool.clone(),
                });
            }
            if rule.mandatory
                && matches!(
                    rule.enforcement,
                    PolicyEnforcement::Advisory | PolicyEnforcement::Unsupported
                )
            {
                return Err(DefinitionError::MandatoryPolicyNotEnforced {
                    tool: rule.tool.clone(),
                    enforcement: rule.enforcement,
                });
            }
        }
        let mut spawn_ids = BTreeSet::new();
        for child in &profile.allowed_spawn_profile_ids {
            if !profiles.contains(child.as_str()) {
                return Err(DefinitionError::MissingId {
                    kind: "spawn profile",
                    id: child.clone(),
                });
            }
            if !spawn_ids.insert(child.as_str()) {
                return Err(DefinitionError::DuplicateId {
                    kind: "spawn profile",
                    id: child.clone(),
                });
            }
        }
    }

    validate_team(&snapshot.team, &profiles)?;
    validate_pipeline(snapshot)?;

    if let Some(command) = &snapshot.launch_command {
        require_nonempty("launch command", &command.id)?;
        require_nonempty("launch command name", &command.name)?;
        if command.team_id != snapshot.team.id {
            return Err(DefinitionError::LaunchReferenceMismatch { field: "teamId" });
        }
        if command.pipeline_id != snapshot.pipeline.id {
            return Err(DefinitionError::LaunchReferenceMismatch {
                field: "pipelineId",
            });
        }
    }
    Ok(())
}

fn validate_team(team: &TeamDefinition, profiles: &BTreeSet<&str>) -> Result<(), DefinitionError> {
    require_nonempty("team", &team.id)?;
    require_nonempty("team name", &team.name)?;
    let members = unique_ids(
        "member",
        team.members.iter().map(|member| member.id.as_str()),
    )?;
    for member in &team.members {
        if !profiles.contains(member.profile_id.as_str()) {
            return Err(DefinitionError::MissingId {
                kind: "member profile",
                id: member.profile_id.clone(),
            });
        }
    }
    if !members.contains(team.orchestrator_member_id.as_str()) {
        return Err(DefinitionError::MissingId {
            kind: "orchestrator member",
            id: team.orchestrator_member_id.clone(),
        });
    }
    validate_edges("send edge", &team.send_edges, &members)?;
    validate_edges("observe edge", &team.observe_edges, &members)?;
    Ok(())
}

fn validate_edges(
    kind: &'static str,
    edges: &[DirectedEdge],
    members: &BTreeSet<&str>,
) -> Result<(), DefinitionError> {
    let mut seen = BTreeSet::new();
    for edge in edges {
        for id in [&edge.from_member_id, &edge.to_member_id] {
            if !members.contains(id.as_str()) {
                return Err(DefinitionError::MissingId {
                    kind: "edge member",
                    id: id.clone(),
                });
            }
        }
        if !seen.insert((edge.from_member_id.as_str(), edge.to_member_id.as_str())) {
            return Err(DefinitionError::DuplicateId {
                kind,
                id: format!("{}->{}", edge.from_member_id, edge.to_member_id),
            });
        }
    }
    Ok(())
}

fn validate_pipeline(snapshot: &RunDefinitionSnapshot) -> Result<(), DefinitionError> {
    let pipeline = &snapshot.pipeline;
    require_nonempty("pipeline", &pipeline.id)?;
    require_nonempty("pipeline name", &pipeline.name)?;
    let steps = unique_ids("step", pipeline.steps.iter().map(|step| step.id.as_str()))?;
    let members: BTreeSet<&str> = snapshot
        .team
        .members
        .iter()
        .map(|member| member.id.as_str())
        .collect();
    let mut indegree: BTreeMap<&str, usize> = steps.iter().copied().map(|step| (step, 0)).collect();
    let mut outgoing: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for step in &pipeline.steps {
        require_nonempty("step name", &step.name)?;
        if !members.contains(step.assigned_member_id.as_str()) {
            return Err(DefinitionError::MissingId {
                kind: "assigned member",
                id: step.assigned_member_id.clone(),
            });
        }
        let mut dependencies = BTreeSet::new();
        for dependency in &step.dependency_step_ids {
            if !steps.contains(dependency.as_str()) {
                return Err(DefinitionError::MissingId {
                    kind: "dependency step",
                    id: dependency.clone(),
                });
            }
            if !dependencies.insert(dependency.as_str()) {
                return Err(DefinitionError::DuplicateId {
                    kind: "dependency step",
                    id: dependency.clone(),
                });
            }
            *indegree.entry(step.id.as_str()).or_insert(0) += 1;
            outgoing
                .entry(dependency.as_str())
                .or_default()
                .push(step.id.as_str());
        }
    }

    let mut ready: BTreeSet<&str> = indegree
        .iter()
        .filter_map(|(id, degree)| (*degree == 0).then_some(*id))
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop_first() {
        visited += 1;
        if let Some(children) = outgoing.get(id) {
            for child in children {
                let Some(degree) = indegree.get_mut(child) else {
                    return Err(DefinitionError::MissingId {
                        kind: "dependency step",
                        id: (*child).to_owned(),
                    });
                };
                *degree -= 1;
                if *degree == 0 {
                    ready.insert(child);
                }
            }
        }
    }
    if visited != steps.len() {
        let step_id = indegree
            .into_iter()
            .find_map(|(id, degree)| (degree > 0).then_some(id.to_owned()))
            .unwrap_or_default();
        return Err(DefinitionError::DependencyCycle { step_id });
    }
    Ok(())
}

fn unique_ids<'a>(
    kind: &'static str,
    ids: impl Iterator<Item = &'a str>,
) -> Result<BTreeSet<&'a str>, DefinitionError> {
    let mut result = BTreeSet::new();
    for id in ids {
        require_nonempty(kind, id)?;
        if !result.insert(id) {
            return Err(DefinitionError::DuplicateId {
                kind,
                id: id.to_owned(),
            });
        }
    }
    Ok(result)
}

fn require_nonempty(kind: &'static str, value: &str) -> Result<(), DefinitionError> {
    if value.trim().is_empty() {
        Err(DefinitionError::EmptyId { kind })
    } else {
        Ok(())
    }
}

pub fn validate_history_reference(
    reference: &NativeHistoryReference,
) -> Result<(), DefinitionError> {
    if reference.session_id.trim().is_empty()
        || reference
            .block_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        || reference.content_hash.as_deref().is_some_and(|hash| {
            hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        Err(DefinitionError::InvalidHistoryReference)
    } else {
        Ok(())
    }
}

pub fn validate_profile_capabilities(
    profile: &AgentProfile,
    capabilities: &NativeBridgeCapabilities,
) -> Result<(), DefinitionError> {
    if !capabilities
        .permission_modes
        .contains(&profile.permission_mode)
    {
        return Err(DefinitionError::UnsupportedPermissionMode {
            mode: profile.permission_mode,
        });
    }
    for rule in &profile.tool_policy.rules {
        if !rule.mandatory {
            continue;
        }
        let supported = match rule.enforcement {
            PolicyEnforcement::Native => capabilities
                .native_enforced_tools
                .iter()
                .any(|tool| tool == &rule.tool),
            PolicyEnforcement::Coordinator => capabilities
                .coordinator_enforced_tools
                .iter()
                .any(|tool| tool == &rule.tool),
            PolicyEnforcement::Advisory | PolicyEnforcement::Unsupported => false,
        };
        let operation_supported = match rule.tool.as_str() {
            "orchestration.roster" => capabilities.agent_operations.roster,
            "orchestration.send" => capabilities.agent_operations.send,
            "orchestration.observe" => capabilities.agent_operations.observe,
            "orchestration.spawn" => capabilities.agent_operations.spawn,
            _ => true,
        };
        if !supported || !operation_supported {
            return Err(DefinitionError::MandatoryToolUnsupported {
                tool: rule.tool.clone(),
            });
        }
    }
    Ok(())
}

pub fn authorize_spawn<'a>(
    snapshot: &'a RunDefinitionSnapshot,
    spawner_profile_id: &str,
    requested_profile_id: &str,
) -> Result<&'a AgentProfile, AuthorizationError> {
    let spawner = snapshot
        .profiles
        .iter()
        .find(|profile| profile.id == spawner_profile_id)
        .ok_or_else(|| AuthorizationError::UnknownProfile {
            profile_id: spawner_profile_id.to_owned(),
        })?;
    let requested = snapshot
        .profiles
        .iter()
        .find(|profile| profile.id == requested_profile_id)
        .ok_or_else(|| AuthorizationError::UnknownProfile {
            profile_id: requested_profile_id.to_owned(),
        })?;
    if !spawner
        .allowed_spawn_profile_ids
        .iter()
        .any(|id| id == requested_profile_id)
    {
        return Err(AuthorizationError::SpawnDenied {
            spawner_profile_id: spawner_profile_id.to_owned(),
            requested_profile_id: requested_profile_id.to_owned(),
        });
    }
    Ok(requested)
}

pub fn authorize_coordinator_tool(
    snapshot: &RunDefinitionSnapshot,
    actor_member_id: &str,
    tool: &str,
) -> Result<(), AuthorizationError> {
    let member = snapshot
        .team
        .members
        .iter()
        .find(|member| member.id == actor_member_id)
        .ok_or_else(|| AuthorizationError::UnknownMember {
            member_id: actor_member_id.to_owned(),
        })?;
    let profile = snapshot
        .profiles
        .iter()
        .find(|profile| profile.id == member.profile_id)
        .ok_or_else(|| AuthorizationError::UnknownProfile {
            profile_id: member.profile_id.clone(),
        })?;
    if profile.tool_policy.rules.iter().any(|rule| {
        rule.tool == tool
            && rule.enforcement == PolicyEnforcement::Coordinator
            && rule.decision == ToolDecision::Deny
    }) {
        Err(AuthorizationError::CoordinatorToolDenied {
            member_id: actor_member_id.to_owned(),
            tool: tool.to_owned(),
        })
    } else {
        Ok(())
    }
}

pub fn authorize_send(
    team: &TeamDefinition,
    from_member_id: &str,
    to_member_id: &str,
) -> Result<(), AuthorizationError> {
    authorize_edge(team, &team.send_edges, from_member_id, to_member_id, true)
}

pub fn authorize_observe(
    team: &TeamDefinition,
    from_member_id: &str,
    to_member_id: &str,
) -> Result<(), AuthorizationError> {
    authorize_edge(
        team,
        &team.observe_edges,
        from_member_id,
        to_member_id,
        false,
    )
}

fn authorize_edge(
    team: &TeamDefinition,
    edges: &[DirectedEdge],
    from_member_id: &str,
    to_member_id: &str,
    send: bool,
) -> Result<(), AuthorizationError> {
    for id in [from_member_id, to_member_id] {
        if !team.members.iter().any(|member| member.id == id) {
            return Err(AuthorizationError::UnknownMember {
                member_id: id.to_owned(),
            });
        }
    }
    if edges
        .iter()
        .any(|edge| edge.from_member_id == from_member_id && edge.to_member_id == to_member_id)
    {
        return Ok(());
    }
    if send {
        Err(AuthorizationError::SendDenied {
            from_member_id: from_member_id.to_owned(),
            to_member_id: to_member_id.to_owned(),
        })
    } else {
        Err(AuthorizationError::ObserveDenied {
            from_member_id: from_member_id.to_owned(),
            to_member_id: to_member_id.to_owned(),
        })
    }
}
