//! Pure admission shared by every host of the coordinator.
//!
//! Two boundaries live here. [`admit_agent_request`] decides one coordinator
//! tool call (roster, send, observe, spawn) of a running native agent from the
//! frozen run alone; it is the logic native Desktop used inline before.
//! [`definition_refusals`] compares a frozen definition with the adapter
//! capabilities and executors a trusted host bound to its execution location.
//!
//! Neither performs I/O, chooses an identifier or starts work. The host
//! authenticates the calling execution, proves the adapter capabilities,
//! persists the returned run atomically and only then acts on an admission: a
//! spawn admission is a durable lease the host still has to start, on an
//! adapter that it validates for the spawned profile.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    AgentProfile, AgentRequestKind, AuthenticatedSender, AuthorizationError, ControlledSpawnLease,
    Coordinator, CoordinatorError, ExecutionMode, ExecutorKind, Harness, MessageIntent,
    MessageStatus, NativeBridgeCapabilities, NativeHistoryReference, Run, RunDefinitionSnapshot,
    TaskStatus, ToolDecision, authorize_coordinator_tool, authorize_observe, authorize_send,
    authorize_spawn, validate_profile_capabilities,
};

/// One coordinator tool call of a running native agent. It has no actor
/// field: the trusted host authenticates the calling execution.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolRequest {
    pub request_id: String,
    pub operation: AgentToolOperation,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentToolOperation {
    Roster,
    Send {
        recipient_member_id: String,
        body: String,
    },
    Observe {
        target_member_id: String,
    },
    Spawn {
        step_id: String,
    },
    SpawnAgent {
        profile_id: String,
        name: String,
        instructions: String,
    },
}

impl AgentToolOperation {
    /// The coordinator tool a profile's tool policy names for this operation.
    pub const fn tool(&self) -> &'static str {
        match self {
            Self::Roster => "orchestration.roster",
            Self::Send { .. } => "orchestration.send",
            Self::Observe { .. } => "orchestration.observe",
            Self::Spawn { .. } | Self::SpawnAgent { .. } => "orchestration.spawn",
        }
    }

    /// Whether the calling agent's adapter offers this operation.
    pub fn offered_by(&self, capabilities: &NativeBridgeCapabilities) -> bool {
        operation_offered(capabilities, self.tool())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReachableMember {
    pub member_id: String,
    pub profile_id: String,
    pub harness: Harness,
    pub can_send: bool,
    pub can_observe: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)]
pub enum AgentRequestAdmission {
    Roster {
        members: Vec<ReachableMember>,
        spawn_profiles: Vec<AgentProfile>,
    },
    Send {
        message_id: String,
        recipient_member_id: String,
        body: String,
        already_delivered: bool,
    },
    Observe {
        member_id: String,
        history_references: Vec<NativeHistoryReference>,
    },
    Spawn {
        lease: ControlledSpawnLease,
    },
    SpawnCommitted {
        step_id: String,
        member_id: String,
        workspace_session_id: String,
    },
}

/// How a host reports a refused request. Native Desktop's command contract
/// maps these to its `invalid`, `denied`, `conflict` and `not-found` codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentRequestDisposition {
    Invalid,
    Denied,
    Conflict,
    NotFound,
}

/// Why a coordinator tool call was refused. Nothing was recorded.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AgentRequestError {
    #[error("agent request identifier must not be empty")]
    EmptyRequestId,
    #[error("the calling agent's adapter does not offer {tool}")]
    OperationUnavailable { tool: &'static str },
    #[error("the request does not come from a running task of this run")]
    UnknownActor,
    #[error("the calling member's tool policy denies this operation")]
    ToolDenied(#[source] AuthorizationError),
    #[error("the team has no route for this operation")]
    RouteDenied(#[source] AuthorizationError),
    #[error("the agent request could not be recorded")]
    Record(#[source] CoordinatorError),
    #[error("the message identifier was used with another sender, recipient or body")]
    MessageConflict,
    #[error("the message was refused")]
    Message(#[source] CoordinatorError),
    #[error("the agent could not be added")]
    SpawnAgent(#[source] CoordinatorError),
    #[error("the added agent could not be leased")]
    SpawnAgentLease(#[source] CoordinatorError),
    #[error("the step could not be leased for a spawn")]
    SpawnLease(#[source] CoordinatorError),
}

impl AgentRequestError {
    /// The classification native Desktop has always returned for this case.
    pub fn disposition(&self) -> AgentRequestDisposition {
        use AgentRequestDisposition::{Conflict, Denied, Invalid, NotFound};
        match self {
            Self::EmptyRequestId => Invalid,
            Self::OperationUnavailable { .. }
            | Self::UnknownActor
            | Self::ToolDenied(_)
            | Self::RouteDenied(_)
            | Self::SpawnAgent(_) => Denied,
            Self::MessageConflict | Self::SpawnAgentLease(_) => Conflict,
            Self::Record(error) => match error {
                CoordinatorError::AgentRequestConflict { .. }
                | CoordinatorError::RevisionConflict { .. } => Conflict,
                _ => Invalid,
            },
            Self::Message(error) => match error {
                CoordinatorError::Authorization(_) => Denied,
                CoordinatorError::RevisionConflict { .. } => Conflict,
                _ => Invalid,
            },
            Self::SpawnLease(error) => match error {
                CoordinatorError::Authorization(_) => Denied,
                CoordinatorError::RevisionConflict { .. }
                | CoordinatorError::LeaseConflict { .. } => Conflict,
                CoordinatorError::UnknownTask { .. } => NotFound,
                _ => Invalid,
            },
        }
    }

    /// A stable camelCase reason for typed host responses and logs.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::EmptyRequestId => "emptyRequestId",
            Self::OperationUnavailable { .. } => "operationUnavailable",
            Self::UnknownActor => "unknownActor",
            Self::ToolDenied(_) => "toolDenied",
            Self::RouteDenied(_) => "routeDenied",
            Self::Record(_) => "recordRefused",
            Self::MessageConflict => "messageConflict",
            Self::Message(_) => "messageRefused",
            Self::SpawnAgent(_) => "spawnAgentRefused",
            Self::SpawnAgentLease(_) => "spawnAgentLeaseRefused",
            Self::SpawnLease(_) => "spawnLeaseRefused",
        }
    }
}

/// Checks that need no run: an identifier and an operation the calling
/// agent's adapter offers. Hosts run this before opening a transaction.
pub fn check_agent_request(
    request: &AgentToolRequest,
    capabilities: &NativeBridgeCapabilities,
) -> Result<(), AgentRequestError> {
    if request.request_id.trim().is_empty() {
        return Err(AgentRequestError::EmptyRequestId);
    }
    if !request.operation.offered_by(capabilities) {
        return Err(AgentRequestError::OperationUnavailable {
            tool: request.operation.tool(),
        });
    }
    Ok(())
}

/// The member whose running task holds native execution `execution_id`: the
/// only identity a coordinator request can act as. Message text, tool
/// arguments and request fields never name the actor.
pub fn agent_request_actor<'a>(run: &'a Run, execution_id: &str) -> Option<&'a str> {
    let task = run.tasks().iter().find(|task| {
        task.status() == TaskStatus::Running
            && task
                .execution()
                .is_some_and(|execution| execution.id == execution_id)
    })?;
    run.definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == task.step_id())
        .map(|step| step.assigned_member_id.as_str())
}

/// Admits one coordinator tool call of the running execution
/// `actor_execution_id`, whose adapter proved `capabilities`.
///
/// Every check reads the frozen run: the actor's coordinator tool rules, the
/// team's send and observe routes, the snapshotted spawn grants (same-or-less
/// authority for every generation, see [`crate::spawn_permissions_subset`])
/// and the durable request record that makes an identical retry return the
/// same result. The run changes only when the request is admitted.
///
/// `capabilities` decide only whether the caller's adapter offers the
/// operation. A spawn admission does not decide where its profile launches:
/// the host validates the lease against the adapter that will run it. Native
/// Desktop checks a controlled spawn against the calling agent's adapter (and
/// the spawned profile's own adapter at launch); kernel protocol 2 checks the
/// spawned profile's own frozen capabilities.
pub fn admit_agent_request(
    run: &mut Run,
    actor_execution_id: &str,
    request: AgentToolRequest,
    capabilities: &NativeBridgeCapabilities,
) -> Result<AgentRequestAdmission, AgentRequestError> {
    check_agent_request(&request, capabilities)?;
    let mut next = run.clone();
    let admission = admit(&mut next, actor_execution_id, request)?;
    *run = next;
    Ok(admission)
}

fn admit(
    run: &mut Run,
    actor_execution_id: &str,
    request: AgentToolRequest,
) -> Result<AgentRequestAdmission, AgentRequestError> {
    let AgentToolRequest {
        request_id,
        operation,
    } = request;
    let actor = agent_request_actor(run, actor_execution_id)
        .ok_or(AgentRequestError::UnknownActor)?
        .to_owned();
    authorize_coordinator_tool(run.definition(), &actor, operation.tool())
        .map_err(AgentRequestError::ToolDenied)?;
    match operation {
        AgentToolOperation::Roster => {
            record(
                run,
                &request_id,
                actor_execution_id,
                &actor,
                AgentRequestKind::Roster,
            )?;
            Ok(AgentRequestAdmission::Roster {
                members: reachable_members(run, &actor),
                spawn_profiles: spawn_profiles(run, &actor),
            })
        }
        AgentToolOperation::Observe { target_member_id } => {
            authorize_observe(&run.definition().team, &actor, &target_member_id)
                .map_err(AgentRequestError::RouteDenied)?;
            record(
                run,
                &request_id,
                actor_execution_id,
                &actor,
                AgentRequestKind::Observe {
                    target_member_id: target_member_id.clone(),
                },
            )?;
            Ok(AgentRequestAdmission::Observe {
                history_references: history_references_for_member(run, &target_member_id),
                member_id: target_member_id,
            })
        }
        AgentToolOperation::Send {
            recipient_member_id,
            body,
        } => {
            authorize_send(&run.definition().team, &actor, &recipient_member_id)
                .map_err(AgentRequestError::RouteDenied)?;
            record(
                run,
                &request_id,
                actor_execution_id,
                &actor,
                AgentRequestKind::Send {
                    recipient_member_id: recipient_member_id.clone(),
                },
            )?;
            if let Some(existing) = run
                .messages()
                .iter()
                .find(|message| message.id() == request_id)
            {
                if existing.sender_member_id() == actor
                    && existing.recipient_member_id() == recipient_member_id
                    && existing.body() == body
                {
                    return Ok(AgentRequestAdmission::Send {
                        already_delivered: existing.status() == MessageStatus::Delivered,
                        message_id: request_id,
                        recipient_member_id,
                        body,
                    });
                }
                return Err(AgentRequestError::MessageConflict);
            }
            let revision = run.revision();
            Coordinator::accept_message(
                run,
                revision,
                &AuthenticatedSender { member_id: actor },
                MessageIntent {
                    id: request_id.clone(),
                    recipient_member_id: recipient_member_id.clone(),
                    body: body.clone(),
                },
            )
            .map_err(AgentRequestError::Message)?;
            Ok(AgentRequestAdmission::Send {
                message_id: request_id,
                recipient_member_id,
                body,
                already_delivered: false,
            })
        }
        AgentToolOperation::SpawnAgent {
            profile_id,
            name,
            instructions,
        } => {
            let first_admission = record(
                run,
                &request_id,
                actor_execution_id,
                &actor,
                AgentRequestKind::SpawnAgent {
                    profile_id: profile_id.clone(),
                    name: name.clone(),
                    instructions: instructions.clone(),
                },
            )?;
            let step_id = if first_admission {
                Coordinator::add_spawned_agent(
                    run,
                    &actor,
                    &request_id,
                    &profile_id,
                    &name,
                    &instructions,
                )
                .map_err(AgentRequestError::SpawnAgent)?
            } else {
                format!("agent-{request_id}")
            };
            if let Some(committed) = committed_spawn(run, &step_id) {
                return Ok(committed);
            }
            let revision = run.revision();
            let lease =
                Coordinator::lease_controlled_spawn(run, revision, &actor, &step_id, request_id)
                    .map_err(AgentRequestError::SpawnAgentLease)?;
            Ok(AgentRequestAdmission::Spawn { lease })
        }
        AgentToolOperation::Spawn { step_id } => {
            let first_admission = record(
                run,
                &request_id,
                actor_execution_id,
                &actor,
                AgentRequestKind::Spawn {
                    step_id: step_id.clone(),
                },
            )?;
            if !first_admission && let Some(committed) = committed_spawn(run, &step_id) {
                return Ok(committed);
            }
            let revision = run.revision();
            let lease =
                Coordinator::lease_controlled_spawn(run, revision, &actor, &step_id, request_id)
                    .map_err(AgentRequestError::SpawnLease)?;
            Ok(AgentRequestAdmission::Spawn { lease })
        }
    }
}

fn record(
    run: &mut Run,
    request_id: &str,
    actor_execution_id: &str,
    actor_member_id: &str,
    operation: AgentRequestKind,
) -> Result<bool, AgentRequestError> {
    let revision = run.revision();
    Coordinator::record_agent_request(
        run,
        revision,
        request_id.to_owned(),
        actor_execution_id.to_owned(),
        actor_member_id.to_owned(),
        operation,
    )
    .map_err(AgentRequestError::Record)
}

fn committed_spawn(run: &Run, step_id: &str) -> Option<AgentRequestAdmission> {
    let step = run
        .definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == step_id)?;
    let task = run.tasks().iter().find(|task| task.step_id() == step_id)?;
    let execution = task.execution()?;
    Some(AgentRequestAdmission::SpawnCommitted {
        step_id: step_id.to_owned(),
        member_id: step.assigned_member_id.clone(),
        workspace_session_id: execution.id.clone(),
    })
}

/// Profiles the actor's snapshotted grants allow it to spawn, in definition
/// order, each with the input instructions of the first step its profile runs.
fn spawn_profiles(run: &Run, actor_member_id: &str) -> Vec<AgentProfile> {
    let definition = run.definition();
    definition
        .team
        .members
        .iter()
        .find(|member| member.id == actor_member_id)
        .and_then(|member| {
            definition
                .profiles
                .iter()
                .find(|profile| profile.id == member.profile_id)
        })
        .map(|actor| {
            definition
                .profiles
                .iter()
                .filter(|profile| actor.allowed_spawn_profile_ids.contains(&profile.id))
                .map(|profile| {
                    let mut profile = profile.clone();
                    if let Some(input) = definition.pipeline.steps.iter().find_map(|step| {
                        definition
                            .team
                            .members
                            .iter()
                            .find(|member| {
                                member.id == step.assigned_member_id
                                    && member.profile_id == profile.id
                            })
                            .and(step.input_instructions.clone())
                    }) {
                        profile.input_instructions = Some(input);
                    }
                    profile
                })
                .collect()
        })
        .unwrap_or_default()
}

fn reachable_members(run: &Run, actor_member_id: &str) -> Vec<ReachableMember> {
    let mut members: Vec<_> = run
        .definition()
        .team
        .members
        .iter()
        .filter_map(|member| {
            let can_send =
                authorize_send(&run.definition().team, actor_member_id, &member.id).is_ok();
            let can_observe =
                authorize_observe(&run.definition().team, actor_member_id, &member.id).is_ok();
            if !can_send && !can_observe {
                return None;
            }
            let profile = run
                .definition()
                .profiles
                .iter()
                .find(|profile| profile.id == member.profile_id)?;
            Some(ReachableMember {
                member_id: member.id.clone(),
                profile_id: profile.id.clone(),
                harness: profile.harness,
                can_send,
                can_observe,
            })
        })
        .collect();
    members.sort_by(|left, right| left.member_id.cmp(&right.member_id));
    members
}

fn history_references_for_member(run: &Run, member_id: &str) -> Vec<NativeHistoryReference> {
    let step_ids: Vec<&str> = run
        .definition()
        .pipeline
        .steps
        .iter()
        .filter(|step| step.assigned_member_id == member_id)
        .map(|step| step.id.as_str())
        .collect();
    let mut references = Vec::new();
    for task in run
        .tasks()
        .iter()
        .filter(|task| step_ids.contains(&task.step_id()))
    {
        if let Some(reference) = task.result_reference() {
            references.push(reference.clone());
        } else if let Some(execution) = task.execution() {
            references.push(NativeHistoryReference {
                fields: Vec::new(),
                session_id: execution.id.clone(),
                block_id: None,
                content_hash: None,
            });
        }
    }
    references.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then(left.block_id.cmp(&right.block_id))
    });
    references.dedup();
    references
}

/// Whether `capabilities` offer coordinator operation `tool`. A tool outside
/// the four operations a coordinator implements is never offered.
fn operation_offered(capabilities: &NativeBridgeCapabilities, tool: &str) -> bool {
    let operations = &capabilities.agent_operations;
    match tool {
        "orchestration.roster" => operations.roster,
        "orchestration.send" => operations.send,
        "orchestration.observe" => operations.observe,
        "orchestration.spawn" => operations.spawn,
        _ => false,
    }
}

/// Executors the trusted host runs at the location it bound to a run. Every
/// entry is explicit: a missing one is a malformed binding, never a default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutorSupport {
    pub agent: bool,
    pub llm: bool,
    pub script: bool,
    pub plugin: bool,
    pub pipeline: bool,
}

impl ExecutorSupport {
    pub const fn supports(self, kind: ExecutorKind) -> bool {
        match kind {
            ExecutorKind::Agent => self.agent,
            ExecutorKind::Llm => self.llm,
            ExecutorKind::Script => self.script,
            ExecutorKind::Plugin => self.plugin,
            ExecutorKind::Pipeline => self.pipeline,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AdmissionRefusalCode {
    /// The binding has no adapter capabilities for a frozen profile.
    MissingCapabilities,
    /// The graph needs an adapter capability or coordinator operation the
    /// bound adapter does not offer.
    UnsupportedCapability,
    /// The bound location does not run this step's executor.
    UnsupportedExecutor,
    /// A snapshotted spawn grant is not same-or-less authority.
    DelegationDenied,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AdmissionSubject {
    Profile {
        id: String,
    },
    Step {
        id: String,
    },
    SendEdge {
        from_member_id: String,
        to_member_id: String,
    },
    ObserveEdge {
        from_member_id: String,
        to_member_id: String,
    },
    Team {
        id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionRefusal {
    pub code: AdmissionRefusalCode,
    pub subject: AdmissionSubject,
}

/// Everything in `definition` the bound adapters and executors cannot run,
/// in a deterministic order: profiles, steps, send routes, observe routes,
/// then the team. Empty means the definition is admitted.
///
/// The rules are the capability rules of the coordinator, never a new
/// policy: launch validation of every profile
/// ([`validate_profile_capabilities`]), same-or-less spawn grants
/// ([`authorize_spawn`]), an explicitly bound executor per step, and a
/// coordinator operation for every route, grant, `orchestration.*` allow
/// rule, callable role or team-joining spawn the user drew. A graph whose
/// drawn collaboration cannot happen is refused before anything runs rather
/// than silently running without it.
pub fn definition_refusals(
    definition: &RunDefinitionSnapshot,
    capabilities: &BTreeMap<String, NativeBridgeCapabilities>,
    executors: ExecutorSupport,
) -> Vec<AdmissionRefusal> {
    let mut refusals = Vec::new();
    let mut push = |code, subject| refusals.push(AdmissionRefusal { code, subject });
    for profile in &definition.profiles {
        let subject = || AdmissionSubject::Profile {
            id: profile.id.clone(),
        };
        match capabilities.get(&profile.id) {
            None => push(AdmissionRefusalCode::MissingCapabilities, subject()),
            Some(bound) => {
                let ungranted_operation = profile.tool_policy.rules.iter().any(|rule| {
                    rule.decision == ToolDecision::Allow
                        && rule.tool.starts_with("orchestration.")
                        && !operation_offered(bound, &rule.tool)
                });
                if validate_profile_capabilities(profile, bound).is_err()
                    || (!profile.allowed_spawn_profile_ids.is_empty()
                        && !bound.agent_operations.spawn)
                    || ungranted_operation
                {
                    push(AdmissionRefusalCode::UnsupportedCapability, subject());
                }
            }
        }
        if profile
            .allowed_spawn_profile_ids
            .iter()
            .any(|child| authorize_spawn(definition, &profile.id, child).is_err())
        {
            push(AdmissionRefusalCode::DelegationDenied, subject());
        }
    }
    let member_profile = |member_id: &str| {
        definition
            .team
            .members
            .iter()
            .find(|member| member.id == member_id)
            .map(|member| member.profile_id.as_str())
    };
    let offers = |member_id: &str, tool: &str| {
        member_profile(member_id)
            .and_then(|profile_id| capabilities.get(profile_id))
            .is_some_and(|bound| operation_offered(bound, tool))
    };
    for step in &definition.pipeline.steps {
        let subject = || AdmissionSubject::Step {
            id: step.id.clone(),
        };
        if !executors.supports(step.executor_kind()) {
            push(AdmissionRefusalCode::UnsupportedExecutor, subject());
        }
        // A callable role runs only when a member whose snapshotted grant
        // authorizes its profile spawns it through an offering adapter.
        if step.execution_mode == Some(ExecutionMode::Callable) {
            let authorized: Vec<&str> = member_profile(&step.assigned_member_id)
                .map(|target| {
                    definition
                        .team
                        .members
                        .iter()
                        .filter(|member| {
                            authorize_spawn(definition, &member.profile_id, target).is_ok()
                        })
                        .map(|member| member.id.as_str())
                        .collect()
                })
                .unwrap_or_default();
            if authorized.is_empty() {
                push(AdmissionRefusalCode::DelegationDenied, subject());
            } else if !authorized
                .iter()
                .any(|member| offers(member, "orchestration.spawn"))
            {
                push(AdmissionRefusalCode::UnsupportedCapability, subject());
            }
        }
    }
    for edge in &definition.team.send_edges {
        if !offers(&edge.from_member_id, "orchestration.send") {
            push(
                AdmissionRefusalCode::UnsupportedCapability,
                AdmissionSubject::SendEdge {
                    from_member_id: edge.from_member_id.clone(),
                    to_member_id: edge.to_member_id.clone(),
                },
            );
        }
    }
    for edge in &definition.team.observe_edges {
        if !offers(&edge.from_member_id, "orchestration.observe") {
            push(
                AdmissionRefusalCode::UnsupportedCapability,
                AdmissionSubject::ObserveEdge {
                    from_member_id: edge.from_member_id.clone(),
                    to_member_id: edge.to_member_id.clone(),
                },
            );
        }
    }
    if definition.team.spawned_agents_join_team
        && !definition
            .team
            .members
            .iter()
            .any(|member| offers(&member.id, "orchestration.spawn"))
    {
        push(
            AdmissionRefusalCode::UnsupportedCapability,
            AdmissionSubject::Team {
                id: definition.team.id.clone(),
            },
        );
    }
    refusals
}
