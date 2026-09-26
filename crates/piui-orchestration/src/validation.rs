use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;

use crate::{
    AgentProfile, DirectedEdge, NativeBridgeCapabilities, NativeHistoryReference,
    PolicyEnforcement, ResultField, RouteGate, RouterMode, RouterPredicate, RunDefinitionSnapshot,
    TeamDefinition, ToolDecision,
};

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DefinitionError {
    #[error("invalid flow control: {reason}")]
    InvalidFlow { reason: &'static str },
    #[error("callable templates cannot participate in result dependencies")]
    CallableDependency,
    #[error("a pipeline needs a scheduled entry step")]
    NoScheduledStep,
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
    #[error("a pipeline declares at most {limit} run inputs")]
    TooManyInputs { limit: usize },
    #[error("run input {name} is invalid: {reason}")]
    InvalidInput { name: String, reason: &'static str },
    #[error("review on step {step_id} must bound its rounds between 1 and 20")]
    InvalidReviewLimit { step_id: String },
    #[error("step {step_id} cannot use its executor: {reason}")]
    InvalidExecutor {
        step_id: String,
        reason: &'static str,
    },
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
    #[error("step {step_id} is not an agent step and cannot be spawned")]
    StepNotSpawnable { step_id: String },
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
    if !pipeline
        .steps
        .iter()
        .any(|step| step.execution_mode != Some(crate::ExecutionMode::Callable))
    {
        return Err(DefinitionError::NoScheduledStep);
    }
    let callable: BTreeSet<&str> = pipeline
        .steps
        .iter()
        .filter(|step| step.execution_mode == Some(crate::ExecutionMode::Callable))
        .map(|step| step.id.as_str())
        .collect();
    if pipeline.steps.iter().any(|step| {
        (!step.dependency_step_ids.is_empty() && callable.contains(step.id.as_str()))
            || step
                .dependency_step_ids
                .iter()
                .any(|id| callable.contains(id.as_str()))
    }) {
        return Err(DefinitionError::CallableDependency);
    }
    require_nonempty("pipeline", &pipeline.id)?;
    require_nonempty("pipeline name", &pipeline.name)?;
    crate::validate_pipeline_declarations(pipeline)?;
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
        let mut input_names = BTreeSet::new();
        for binding in &step.input_bindings {
            require_nonempty("input name", &binding.name)?;
            if !input_names.insert(binding.name.as_str())
                || !step.dependency_step_ids.contains(&binding.source_step_id)
                || !pipeline.steps.iter().any(|source| {
                    source.id == binding.source_step_id
                        && source
                            .result_fields
                            .iter()
                            .any(|field| field.name == binding.field)
                })
            {
                return Err(DefinitionError::InvalidFlow {
                    reason: "input binding must select a declared dependency field with a unique input name",
                });
            }
        }
        if let Some(condition) = &step.condition {
            let source = pipeline
                .steps
                .iter()
                .find(|source| source.id == condition.source_step_id);
            if !step.dependency_step_ids.contains(&condition.source_step_id)
                || !source.is_some_and(|source| {
                    source
                        .result_fields
                        .iter()
                        .any(|field| field.name == condition.field)
                })
                || !(condition.equals.is_string()
                    || condition.equals.is_number()
                    || condition.equals.is_boolean())
            {
                return Err(DefinitionError::InvalidFlow {
                    reason: "condition must reference a declared field on a direct dependency",
                });
            }
        }
        if let Some(review) = &step.review {
            let mut ancestors = BTreeSet::new();
            let mut pending = step.dependency_step_ids.clone();
            while let Some(id) = pending.pop() {
                if ancestors.insert(id.clone())
                    && let Some(parent) = pipeline.steps.iter().find(|parent| parent.id == id)
                {
                    pending.extend(parent.dependency_step_ids.clone());
                }
            }
            if !ancestors.contains(&review.retry_from_step_id)
                || !step.result_fields.iter().any(|field| {
                    field.name == review.field && field.kind == crate::ResultFieldKind::Boolean
                })
            {
                return Err(DefinitionError::InvalidFlow {
                    reason: "review requires a boolean result field and an upstream correction step",
                });
            }
        }
        if let Some(router) = &step.router {
            require_nonempty("router input step", &router.input_step_id)?;
            if step.dependency_step_ids.len() != 1
                || !step.dependency_step_ids.contains(&router.input_step_id)
            {
                return Err(DefinitionError::InvalidFlow {
                    reason: "router must have exactly one direct input dependency",
                });
            }
            let source = pipeline
                .steps
                .iter()
                .find(|candidate| candidate.id == router.input_step_id)
                .ok_or_else(|| DefinitionError::MissingId {
                    kind: "router input step",
                    id: router.input_step_id.clone(),
                })?;
            let mut branch_ids = BTreeSet::new();
            for branch in &router.branches {
                require_nonempty("router branch", &branch.id)?;
                require_nonempty("router branch label", &branch.label)?;
                if !branch_ids.insert(branch.id.as_str()) {
                    return Err(DefinitionError::DuplicateId {
                        kind: "router branch",
                        id: branch.id.clone(),
                    });
                }
                match router.mode {
                    RouterMode::Program => {
                        let Some(predicate) = branch.predicate.as_ref() else {
                            return Err(DefinitionError::InvalidFlow {
                                reason: "program router branches need predicates",
                            });
                        };
                        if !valid_router_predicate(predicate, &source.result_fields) {
                            return Err(DefinitionError::InvalidFlow {
                                reason: "router predicate must use declared input fields",
                            });
                        }
                    }
                    RouterMode::Agent => {
                        if branch.predicate.is_some()
                            || branch
                                .description
                                .as_deref()
                                .is_none_or(|description| description.trim().is_empty())
                        {
                            return Err(DefinitionError::InvalidFlow {
                                reason: "agent router branches need descriptions and cannot contain program predicates",
                            });
                        }
                    }
                }
            }
            if router.mode == RouterMode::Agent {
                let field = router
                    .selection_field
                    .as_deref()
                    .filter(|field| !field.trim().is_empty())
                    .ok_or(DefinitionError::InvalidFlow {
                        reason: "agent router needs a selection field",
                    })?;
                if !step.result_fields.iter().any(|candidate| {
                    candidate.name == field && candidate.kind == crate::ResultFieldKind::TextList
                }) {
                    return Err(DefinitionError::InvalidFlow {
                        reason: "agent router selection field must be a text-list result field",
                    });
                }
            }
            if !step.route_gates.is_empty() {
                return Err(DefinitionError::InvalidFlow {
                    reason: "router steps cannot be gated by another router",
                });
            }
        }
        for gate in &step.route_gates {
            validate_route_gate(pipeline, step, gate)?;
        }
        let mut fields = BTreeSet::new();
        for field in &step.result_fields {
            require_nonempty("result field", &field.name)?;
            if !fields.insert(field.name.as_str()) {
                return Err(DefinitionError::DuplicateId {
                    kind: "result field",
                    id: field.name.clone(),
                });
            }
        }
        require_nonempty("step name", &step.name)?;
        // Program routers and scripts are coordinator and host work; every
        // other step runs as a team member's native session.
        if step
            .router
            .as_ref()
            .is_none_or(|router| router.mode == RouterMode::Agent)
            && !step.is_script()
            && !members.contains(step.assigned_member_id.as_str())
        {
            return Err(DefinitionError::MissingId {
                kind: "assigned member",
                id: step.assigned_member_id.clone(),
            });
        }
        crate::executors::validate_executor_authority(snapshot, step, &members)?;
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

fn validate_route_gate(
    pipeline: &crate::PipelineDefinition,
    step: &crate::PipelineStep,
    gate: &RouteGate,
) -> Result<(), DefinitionError> {
    let Some(router_step) = pipeline
        .steps
        .iter()
        .find(|candidate| candidate.id == gate.router_step_id)
    else {
        return Err(DefinitionError::MissingId {
            kind: "route router step",
            id: gate.router_step_id.clone(),
        });
    };
    let Some(router) = router_step.router.as_ref() else {
        return Err(DefinitionError::InvalidFlow {
            reason: "route gate must reference a router step",
        });
    };
    if !step.dependency_step_ids.contains(&gate.router_step_id) {
        return Err(DefinitionError::InvalidFlow {
            reason: "route gate must also be a step dependency",
        });
    }
    if !router
        .branches
        .iter()
        .any(|branch| branch.id == gate.branch_id)
    {
        return Err(DefinitionError::MissingId {
            kind: "route branch",
            id: gate.branch_id.clone(),
        });
    }
    Ok(())
}

fn valid_router_predicate(predicate: &RouterPredicate, fields: &[ResultField]) -> bool {
    let has_field = |name: &str| fields.iter().any(|field| field.name == name);
    match predicate {
        RouterPredicate::Equals { field, value } => {
            let Some(declared) = fields.iter().find(|candidate| candidate.name == *field) else {
                return false;
            };
            value.is_null()
                || (declared.kind == crate::ResultFieldKind::Text && value.is_string())
                || (declared.kind == crate::ResultFieldKind::Number && value.is_number())
                || (declared.kind == crate::ResultFieldKind::Boolean && value.is_boolean())
        }
        RouterPredicate::Exists { field } => has_field(field),
        RouterPredicate::All { predicates } | RouterPredicate::Any { predicates } => {
            !predicates.is_empty()
                && predicates
                    .iter()
                    .all(|item| valid_router_predicate(item, fields))
        }
        RouterPredicate::Not { predicate } => valid_router_predicate(predicate, fields),
    }
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
    if !spawn_permissions_subset(spawner, requested) {
        return Err(AuthorizationError::SpawnDenied {
            spawner_profile_id: spawner_profile_id.to_owned(),
            requested_profile_id: requested_profile_id.to_owned(),
        });
    }
    Ok(requested)
}

/// Compare declared authority conservatively. Native defaults are comparable
/// only inside the same adapter. Every generation is checked at admission.
pub fn spawn_permissions_subset(parent: &AgentProfile, child: &AgentProfile) -> bool {
    use crate::PermissionMode::*;
    let files = match (parent.permission_mode, child.permission_mode) {
        (Native, Native) => parent.harness == child.harness,
        (FullAccess, ReadOnly | WorkspaceWrite | FullAccess) => true,
        (WorkspaceWrite, ReadOnly | WorkspaceWrite) => true,
        (ReadOnly, ReadOnly) => true,
        _ => false,
    };
    if !files {
        return false;
    }
    if child.network_access && !parent.network_access {
        return false;
    }
    // Denials cannot disappear or become advisory on a child.
    if parent.tool_policy.rules.iter().any(|rule| {
        rule.decision == ToolDecision::Deny
            && !child.tool_policy.rules.iter().any(|candidate| {
                candidate.tool == rule.tool
                    && candidate.decision == ToolDecision::Deny
                    && candidate.enforcement == rule.enforcement
                    && (!rule.mandatory || candidate.mandatory)
            })
    }) {
        return false;
    }
    // Native rules form an allowlist in the runtime adapter. An absent child
    // allowlist would restore its default tools, so it cannot inherit that way.
    let native_rules = |profile: &AgentProfile| {
        profile
            .tool_policy
            .rules
            .iter()
            .filter(|rule| rule.enforcement == PolicyEnforcement::Native)
            .map(|rule| (rule.tool.clone(), rule.decision))
            .collect::<Vec<_>>()
    };
    let parent_rules = native_rules(parent);
    let child_rules = native_rules(child);
    if !parent_rules.is_empty()
        && (child_rules.is_empty()
            || child_rules.iter().any(|(tool, decision)| {
                *decision == ToolDecision::Allow
                    && !parent_rules.contains(&(tool.clone(), ToolDecision::Allow))
            }))
    {
        return false;
    }
    if parent.resource_rules.iter().any(|rule| {
        !rule.enabled
            && !child.resource_rules.iter().any(|candidate| {
                candidate.kind == rule.kind && candidate.id == rule.id && !candidate.enabled
            })
    }) {
        return false;
    }
    // Delegation is itself authority; a child cannot acquire new templates.
    child
        .allowed_spawn_profile_ids
        .iter()
        .all(|id| parent.allowed_spawn_profile_ids.contains(id))
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
