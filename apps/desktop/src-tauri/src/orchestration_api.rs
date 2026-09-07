//! Narrow Tauri orchestration API and host-private scheduler seam.
//!
//! Definition and run data are durable application data. The WebView can edit
//! definitions and request explicit run transitions, but cannot supply an
//! authenticated agent sender or report native completion. Those operations
//! are available only on `OrchestrationApiState` for trusted host integration.

use crate::api::verified_project_directory;
use crate::orchestration_scheduler::OrchestrationScheduler;
use crate::orchestration_store::{
    OrchestrationStore, StoreError, StoredDefinition, WorkspaceOrchestration,
};
use crate::state::HostState;
use piui_orchestration::{
    AgentProfile, AgentRequestKind, AuthenticatedSender, CompletionOutcome, ControlledSpawnLease,
    Coordinator, CoordinatorError, FailureRecord, Harness, LaunchCommandReference, LaunchRequest,
    MessageIntent, NativeBridgeCapabilities, NativeExecutionReference, NativeHistoryReference,
    PipelineDefinition, Run, RunDefinitionSnapshot, TaskStatus, TeamDefinition,
    UncertainResolution, UncertaintyIdentity, authorize_coordinator_tool, authorize_observe,
    authorize_send, validate_profile_capabilities,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationApiError {
    code: &'static str,
}

impl OrchestrationApiError {
    fn invalid() -> Self {
        Self { code: "invalid" }
    }
    fn conflict() -> Self {
        Self { code: "conflict" }
    }
    fn not_found() -> Self {
        Self { code: "not-found" }
    }
    fn already_exists() -> Self {
        Self {
            code: "already-exists",
        }
    }
    fn io() -> Self {
        Self { code: "io" }
    }
    fn runtime_unavailable() -> Self {
        Self {
            code: "runtime-unavailable",
        }
    }
    fn denied() -> Self {
        Self { code: "denied" }
    }
}

impl std::fmt::Display for OrchestrationApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for OrchestrationApiError {}

impl From<StoreError> for OrchestrationApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Conflict => Self::conflict(),
            StoreError::AlreadyExists => Self::already_exists(),
            StoreError::NotFound => Self::not_found(),
            StoreError::Invalid => Self::invalid(),
            StoreError::Denied => Self::denied(),
            StoreError::Io(_) => Self::io(),
        }
    }
}

impl From<CoordinatorError> for OrchestrationApiError {
    fn from(error: CoordinatorError) -> Self {
        match error {
            CoordinatorError::RevisionConflict { .. } => Self::conflict(),
            CoordinatorError::UnknownTask { .. } | CoordinatorError::UnknownMessage { .. } => {
                Self::not_found()
            }
            CoordinatorError::Authorization(_) => Self::denied(),
            _ => Self::invalid(),
        }
    }
}

fn scheduler_error(
    error: crate::orchestration_scheduler::OrchestrationSchedulerError,
) -> OrchestrationApiError {
    OrchestrationApiError { code: error.code }
}

pub const ORCHESTRATION_EVENT_V4: &str = "piui://orchestration-event";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationRunChangedEventV4 {
    pub protocol: u8,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub workspace_id: String,
    pub run_id: String,
    pub revision: u64,
}

pub fn emit_run_changed(app: &AppHandle, workspace_id: &str, run: &Run) {
    let _ = app.emit(
        ORCHESTRATION_EVENT_V4,
        OrchestrationRunChangedEventV4 {
            protocol: 6,
            event_type: "runChanged",
            workspace_id: workspace_id.to_owned(),
            run_id: run.id().to_owned(),
            revision: run.revision(),
        },
    );
}

pub struct OrchestrationApiState {
    store: Mutex<OrchestrationStore>,
}

impl OrchestrationApiState {
    fn control_flow(&self, request: FlowControlRequest) -> Result<Run, OrchestrationApiError> {
        self.lock()?
            .transact(|workspaces| {
                let run = mutable_run(workspaces, &request.workspace_id, &request.run_id)?;
                Coordinator::control_flow(run, request.expected_run_revision, request.action)
                    .map_err(|error| match error {
                        CoordinatorError::RevisionConflict { .. } => StoreError::Conflict,
                        _ => StoreError::Invalid,
                    })?;
                Ok(run.clone())
            })
            .map_err(Into::into)
    }
    pub fn open(app_data_dir: &Path) -> Result<Self, OrchestrationApiError> {
        let mut store = OrchestrationStore::open(app_data_dir)?;
        store.recover_interrupted_runs()?;
        Ok(Self {
            store: Mutex::new(store),
        })
    }

    pub fn get_run(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<Option<Run>, OrchestrationApiError> {
        validate_workspace_id(workspace_id)?;
        let store = self.lock()?;
        Ok(store.workspace(workspace_id).and_then(|workspace| {
            workspace
                .runs
                .iter()
                .find(|run| run.id() == run_id)
                .cloned()
        }))
    }

    pub fn create_run(&self, request: StartRunRequest) -> Result<Run, OrchestrationApiError> {
        validate_workspace_id(&request.workspace_id)?;
        let mut store = self.lock()?;
        store
            .transact(|workspaces| create_run_in(workspaces, request))
            .map_err(Into::into)
    }

    pub fn retry_uncertain(
        &self,
        request: RetryUncertainTaskRequest,
    ) -> Result<Run, OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| retry_uncertain_in(workspaces, request))
            .map_err(Into::into)
    }

    pub fn lease_next_scheduled_task(
        &self,
        workspace_id: &str,
        run_id: &str,
        expected_run_revision: u64,
        lease_id: String,
        capabilities: &NativeBridgeCapabilities,
    ) -> Result<Option<ControlledSpawnLease>, OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, workspace_id, run_id)?;
                let lease = Coordinator::lease_next_task(run, expected_run_revision, lease_id)
                    .map_err(|error| StoreError::from_api(error.into()))?;
                if let Some(lease) = &lease {
                    validate_profile_capabilities(&lease.profile, capabilities)
                        .map_err(|_| StoreError::Invalid)?;
                }
                Ok(lease)
            })
            .map_err(Into::into)
    }

    pub fn reject_ready_task(
        &self,
        workspace_id: &str,
        run_id: &str,
        step_id: &str,
        expected_task_revision: u64,
        failure_code: String,
    ) -> Result<Run, OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, workspace_id, run_id)?;
                let current_run_revision = run.revision();
                Coordinator::reject_ready_task(
                    run,
                    current_run_revision,
                    step_id,
                    expected_task_revision,
                    FailureRecord { code: failure_code },
                )
                .map_err(|error| match error {
                    CoordinatorError::RevisionConflict { .. } => StoreError::Conflict,
                    CoordinatorError::UnknownTask { .. } => StoreError::NotFound,
                    _ => StoreError::Invalid,
                })?;
                Ok(run.clone())
            })
            .map_err(Into::into)
    }

    pub fn plan_cancel(
        &self,
        workspace_id: &str,
        run_id: &str,
        expected_run_revision: u64,
    ) -> Result<Vec<piui_orchestration::CancelRequest>, OrchestrationApiError> {
        let store = self.lock()?;
        let run = store
            .workspace(workspace_id)
            .and_then(|workspace| workspace.runs.iter().find(|run| run.id() == run_id))
            .ok_or_else(OrchestrationApiError::not_found)?;
        Coordinator::cancellation_requests(run, expected_run_revision).map_err(Into::into)
    }

    pub fn commit_cancel_after_native_stop(
        &self,
        workspace_id: &str,
        run_id: &str,
        expected_run_revision: u64,
        step_id: Option<&str>,
    ) -> Result<Run, OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, workspace_id, run_id)?;
                match step_id {
                    Some(id) => Coordinator::cancel_task(run, expected_run_revision, id),
                    None => Coordinator::cancel_run(run, expected_run_revision).map(|_| ()),
                }
                .map_err(|error| match error {
                    CoordinatorError::RevisionConflict { .. } => StoreError::Conflict,
                    _ => StoreError::Invalid,
                })?;
                Ok(run.clone())
            })
            .map_err(Into::into)
    }

    pub fn mark_task_uncertain(
        &self,
        workspace_id: &str,
        run_id: &str,
        _expected_run_revision: u64,
        step_id: &str,
        expected_task_revision: u64,
        identity: UncertaintyIdentity,
    ) -> Result<Run, OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, workspace_id, run_id)?;
                let current_run_revision = run.revision();
                Coordinator::mark_task_uncertain(
                    run,
                    current_run_revision,
                    step_id,
                    expected_task_revision,
                    &identity,
                )
                .map_err(|error| match error {
                    CoordinatorError::RevisionConflict { .. }
                    | CoordinatorError::StaleExecution { .. } => StoreError::Conflict,
                    CoordinatorError::UnknownTask { .. } => StoreError::NotFound,
                    _ => StoreError::Invalid,
                })?;
                Ok(run.clone())
            })
            .map_err(Into::into)
    }

    /// Trusted terminal event from `WorkspaceHost`. There is intentionally no
    /// Tauri command for this operation, so a model/WebView cannot self-report
    /// success or impersonate the native runtime.
    #[allow(clippy::too_many_arguments)]
    pub fn record_terminal_event(
        &self,
        workspace_id: &str,
        run_id: &str,
        _expected_run_revision: u64,
        step_id: &str,
        expected_task_revision: u64,
        workspace_session_id: &str,
        outcome: CompletionOutcome,
        native_result_text: Option<&str>,
    ) -> Result<Run, OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, workspace_id, run_id)?;
                let current_run_revision = run.revision();
                Coordinator::complete_checked_task(
                    run,
                    current_run_revision,
                    step_id,
                    expected_task_revision,
                    workspace_session_id,
                    outcome,
                    native_result_text,
                )
                .map_err(|_| StoreError::Conflict)?;
                Ok(run.clone())
            })
            .map_err(Into::into)
    }

    pub fn handle_agent_request(
        &self,
        context: ManagedAgentContext,
        request: AgentToolRequest,
        capabilities: &NativeBridgeCapabilities,
    ) -> Result<AgentRequestAdmission, OrchestrationApiError> {
        if request.request_id.trim().is_empty() {
            return Err(OrchestrationApiError::invalid());
        }
        match request.operation {
            AgentToolOperation::Roster => {
                if !capabilities.agent_operations.roster {
                    return Err(OrchestrationApiError::denied());
                }
                let mut store = self.lock()?;
                store
                    .transact(|workspaces| {
                        let run = mutable_run(workspaces, &context.workspace_id, &context.run_id)?;
                        let actor_member_id =
                            derive_actor_member_id(run, &context.workspace_session_id)
                                .map_err(|_| StoreError::Denied)?;
                        authorize_coordinator_tool(
                            run.definition(),
                            &actor_member_id,
                            "orchestration.roster",
                        )
                        .map_err(|_| StoreError::Denied)?;
                        record_agent_request(
                            run,
                            &request.request_id,
                            &context.workspace_session_id,
                            &actor_member_id,
                            AgentRequestKind::Roster,
                        )?;
                        Ok(AgentRequestAdmission::Roster {
                            members: reachable_members(run, &actor_member_id),
                            spawn_profiles: run
                                .definition()
                                .team
                                .members
                                .iter()
                                .find(|m| m.id == actor_member_id)
                                .and_then(|m| {
                                    run.definition()
                                        .profiles
                                        .iter()
                                        .find(|p| p.id == m.profile_id)
                                })
                                .map(|actor| {
                                    run.definition()
                                        .profiles
                                        .iter()
                                        .filter(|p| actor.allowed_spawn_profile_ids.contains(&p.id))
                                        .map(|profile| {
                                            let mut profile = profile.clone();
                                            if let Some(input) =
                                                run.definition().pipeline.steps.iter().find_map(
                                                    |step| {
                                                        run.definition()
                                                            .team
                                                            .members
                                                            .iter()
                                                            .find(|member| {
                                                                member.id == step.assigned_member_id
                                                                    && member.profile_id
                                                                        == profile.id
                                                            })
                                                            .and(step.input_instructions.clone())
                                                    },
                                                )
                                            {
                                                profile.input_instructions = Some(input);
                                            }
                                            profile
                                        })
                                        .collect()
                                })
                                .unwrap_or_default(),
                        })
                    })
                    .map_err(Into::into)
            }
            AgentToolOperation::Observe { target_member_id } => {
                if !capabilities.agent_operations.observe {
                    return Err(OrchestrationApiError::denied());
                }
                let mut store = self.lock()?;
                store
                    .transact(|workspaces| {
                        let run = mutable_run(workspaces, &context.workspace_id, &context.run_id)?;
                        let actor_member_id =
                            derive_actor_member_id(run, &context.workspace_session_id)
                                .map_err(|_| StoreError::Denied)?;
                        authorize_coordinator_tool(
                            run.definition(),
                            &actor_member_id,
                            "orchestration.observe",
                        )
                        .map_err(|_| StoreError::Denied)?;
                        authorize_observe(
                            &run.definition().team,
                            &actor_member_id,
                            &target_member_id,
                        )
                        .map_err(|_| StoreError::Denied)?;
                        record_agent_request(
                            run,
                            &request.request_id,
                            &context.workspace_session_id,
                            &actor_member_id,
                            AgentRequestKind::Observe {
                                target_member_id: target_member_id.clone(),
                            },
                        )?;
                        Ok(AgentRequestAdmission::Observe {
                            member_id: target_member_id.clone(),
                            history_references: history_references_for_member(
                                run,
                                &target_member_id,
                            ),
                        })
                    })
                    .map_err(Into::into)
            }
            AgentToolOperation::Send {
                recipient_member_id,
                body,
            } => {
                if !capabilities.agent_operations.send {
                    return Err(OrchestrationApiError::denied());
                }
                let mut store = self.lock()?;
                store
                    .transact(|workspaces| {
                        let run = mutable_run(workspaces, &context.workspace_id, &context.run_id)?;
                        let actor_member_id =
                            derive_actor_member_id(run, &context.workspace_session_id)
                                .map_err(|_| StoreError::Denied)?;
                        authorize_coordinator_tool(
                            run.definition(),
                            &actor_member_id,
                            "orchestration.send",
                        )
                        .map_err(|_| StoreError::Denied)?;
                        authorize_send(
                            &run.definition().team,
                            &actor_member_id,
                            &recipient_member_id,
                        )
                        .map_err(|_| StoreError::Denied)?;
                        record_agent_request(
                            run,
                            &request.request_id,
                            &context.workspace_session_id,
                            &actor_member_id,
                            AgentRequestKind::Send {
                                recipient_member_id: recipient_member_id.clone(),
                            },
                        )?;
                        if let Some(existing) = run
                            .messages()
                            .iter()
                            .find(|message| message.id() == request.request_id)
                        {
                            if existing.sender_member_id() == actor_member_id
                                && existing.recipient_member_id() == recipient_member_id
                                && existing.body() == body
                            {
                                return Ok(AgentRequestAdmission::Send {
                                    message_id: request.request_id,
                                    recipient_member_id,
                                    body,
                                    already_delivered: existing.status()
                                        == piui_orchestration::MessageStatus::Delivered,
                                });
                            }
                            return Err(StoreError::Conflict);
                        }
                        let revision = run.revision();
                        Coordinator::accept_message(
                            run,
                            revision,
                            &AuthenticatedSender {
                                member_id: actor_member_id,
                            },
                            MessageIntent {
                                id: request.request_id.clone(),
                                recipient_member_id: recipient_member_id.clone(),
                                body: body.clone(),
                            },
                        )
                        .map_err(|error| match error {
                            CoordinatorError::Authorization(_) => StoreError::Denied,
                            CoordinatorError::RevisionConflict { .. } => StoreError::Conflict,
                            _ => StoreError::Invalid,
                        })?;
                        Ok(AgentRequestAdmission::Send {
                            message_id: request.request_id,
                            recipient_member_id,
                            body,
                            already_delivered: false,
                        })
                    })
                    .map_err(Into::into)
            }
            AgentToolOperation::SpawnAgent {
                profile_id,
                name,
                instructions,
            } => {
                if !capabilities.agent_operations.spawn {
                    return Err(OrchestrationApiError::denied());
                }
                let mut store = self.lock()?;
                store
                    .transact(|workspaces| {
                        let run = mutable_run(workspaces, &context.workspace_id, &context.run_id)?;
                        let actor = derive_actor_member_id(run, &context.workspace_session_id)
                            .map_err(|_| StoreError::Denied)?;
                        authorize_coordinator_tool(run.definition(), &actor, "orchestration.spawn")
                            .map_err(|_| StoreError::Denied)?;
                        let first_admission = record_agent_request(
                            run,
                            &request.request_id,
                            &context.workspace_session_id,
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
                                &request.request_id,
                                &profile_id,
                                &name,
                                &instructions,
                            )
                            .map_err(|_| StoreError::Denied)?
                        } else {
                            format!("agent-{}", request.request_id)
                        };
                        if let Some(committed) = committed_spawn(run, &step_id) {
                            return Ok(committed);
                        }
                        let lease = Coordinator::lease_controlled_spawn(
                            run,
                            run.revision(),
                            &actor,
                            &step_id,
                            request.request_id,
                        )
                        .map_err(|_| StoreError::Conflict)?;
                        Ok(AgentRequestAdmission::Spawn { lease })
                    })
                    .map_err(Into::into)
            }
            AgentToolOperation::Spawn { step_id } => {
                if !capabilities.agent_operations.spawn {
                    return Err(OrchestrationApiError::denied());
                }
                let mut store = self.lock()?;
                store
                    .transact(|workspaces| {
                        let run = mutable_run(workspaces, &context.workspace_id, &context.run_id)?;
                        let actor_member_id =
                            derive_actor_member_id(run, &context.workspace_session_id)
                                .map_err(|_| StoreError::Denied)?;
                        authorize_coordinator_tool(
                            run.definition(),
                            &actor_member_id,
                            "orchestration.spawn",
                        )
                        .map_err(|_| StoreError::Denied)?;
                        let first_admission = record_agent_request(
                            run,
                            &request.request_id,
                            &context.workspace_session_id,
                            &actor_member_id,
                            AgentRequestKind::Spawn {
                                step_id: step_id.clone(),
                            },
                        )?;
                        if !first_admission {
                            if let Some(committed) = committed_spawn(run, &step_id) {
                                return Ok(committed);
                            }
                        }
                        let revision = run.revision();
                        let lease = Coordinator::lease_controlled_spawn(
                            run,
                            revision,
                            &actor_member_id,
                            &step_id,
                            request.request_id,
                        )
                        .map_err(|error| match error {
                            CoordinatorError::Authorization(_) => StoreError::Denied,
                            CoordinatorError::RevisionConflict { .. }
                            | CoordinatorError::LeaseConflict { .. } => StoreError::Conflict,
                            CoordinatorError::UnknownTask { .. } => StoreError::NotFound,
                            _ => StoreError::Invalid,
                        })?;
                        validate_profile_capabilities(&lease.profile, capabilities)
                            .map_err(|_| StoreError::Invalid)?;
                        Ok(AgentRequestAdmission::Spawn { lease })
                    })
                    .map_err(Into::into)
            }
        }
    }

    pub fn commit_launch_lease(
        &self,
        workspace_id: &str,
        run_id: &str,
        lease: &ControlledSpawnLease,
        workspace_session_id: String,
    ) -> Result<LaunchRequest, OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, workspace_id, run_id)?;
                let current_run_revision = run.revision();
                Coordinator::dispatch_leased_task(
                    run,
                    current_run_revision,
                    &lease.step_id,
                    lease.task_revision,
                    &lease.lease_id,
                    NativeExecutionReference {
                        id: workspace_session_id,
                    },
                )
                .map_err(|error| match error {
                    CoordinatorError::RevisionConflict { .. }
                    | CoordinatorError::LeaseConflict { .. } => StoreError::Conflict,
                    _ => StoreError::Invalid,
                })
            })
            .map_err(Into::into)
    }

    pub fn release_spawn_lease(
        &self,
        context: &ManagedAgentContext,
        lease: &ControlledSpawnLease,
    ) -> Result<(), OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, &context.workspace_id, &context.run_id)?;
                let current_run_revision = run.revision();
                Coordinator::release_task_lease(
                    run,
                    current_run_revision,
                    &lease.step_id,
                    lease.task_revision,
                    &lease.lease_id,
                )
                .map_err(|_| StoreError::Conflict)
            })
            .map_err(Into::into)
    }

    pub fn mark_managed_message_delivered(
        &self,
        context: &ManagedAgentContext,
        message_id: &str,
    ) -> Result<Run, OrchestrationApiError> {
        let mut store = self.lock()?;
        store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, &context.workspace_id, &context.run_id)?;
                let message = run
                    .messages()
                    .iter()
                    .find(|message| message.id() == message_id)
                    .ok_or(StoreError::NotFound)?;
                let run_revision = run.revision();
                let message_revision = message.revision();
                Coordinator::mark_message_delivered(
                    run,
                    run_revision,
                    message_id,
                    message_revision,
                )
                .map_err(|_| StoreError::Conflict)?;
                Ok(run.clone())
            })
            .map_err(Into::into)
    }

    fn lock(&self) -> Result<MutexGuard<'_, OrchestrationStore>, OrchestrationApiError> {
        self.store.lock().map_err(|_| OrchestrationApiError::io())
    }
}

// Helper used only to preserve typed domain errors through the atomic closure.
impl StoreError {
    fn from_api(error: OrchestrationApiError) -> Self {
        match error.code {
            "conflict" => Self::Conflict,
            "not-found" => Self::NotFound,
            "denied" => Self::Denied,
            _ => Self::Invalid,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ManagedAgentContext {
    pub workspace_id: String,
    pub run_id: String,
    pub workspace_session_id: String,
}

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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetDefinitionRequest {
    pub workspace_id: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDefinitionRequest<T> {
    pub workspace_id: String,
    pub expected_revision: Option<u64>,
    pub value: T,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteDefinitionRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRunRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub team_id: String,
    pub pipeline_id: String,
    pub launch_command_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub workspace_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunMutationRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub expected_run_revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconcileUncertainTaskRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub expected_run_revision: u64,
    pub step_id: String,
    pub expected_task_revision: u64,
    pub resolution: ReconcileResolution,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReconcileResolution {
    Succeeded {
        result_reference: Option<piui_orchestration::NativeHistoryReference>,
    },
    Failed {
        failure_code: String,
    },
    Cancelled,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryUncertainTaskRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub expected_run_revision: u64,
    pub step_id: String,
    pub expected_task_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionSummary {
    pub id: String,
    pub name: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationCatalogV4 {
    pub profiles: Vec<DefinitionSummary>,
    pub teams: Vec<DefinitionSummary>,
    pub pipelines: Vec<DefinitionSummary>,
    pub launch_commands: Vec<DefinitionSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSummary {
    pub id: String,
    pub status: piui_orchestration::RunStatus,
    pub revision: u64,
    pub team_name: String,
    pub pipeline_name: String,
}

trait DefinitionValue: Clone + Sized {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn values(workspace: &WorkspaceOrchestration) -> &Vec<StoredDefinition<Self>>;
    fn values_mut(workspace: &mut WorkspaceOrchestration) -> &mut Vec<StoredDefinition<Self>>;
    fn valid_for_workspace(&self, workspace: &WorkspaceOrchestration) -> bool;
    fn can_delete(workspace: &WorkspaceOrchestration, id: &str) -> bool;
}

impl DefinitionValue for AgentProfile {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn values(workspace: &WorkspaceOrchestration) -> &Vec<StoredDefinition<Self>> {
        &workspace.profiles
    }
    fn values_mut(workspace: &mut WorkspaceOrchestration) -> &mut Vec<StoredDefinition<Self>> {
        &mut workspace.profiles
    }
    fn valid_for_workspace(&self, workspace: &WorkspaceOrchestration) -> bool {
        !self.id.trim().is_empty()
            && !self.name.trim().is_empty()
            && !self.model.trim().is_empty()
            && self.service_tier.as_deref().is_none_or(|tier| {
                matches!(
                    self.harness,
                    piui_orchestration::Harness::Codex | piui_orchestration::Harness::PrimeAgent
                ) && matches!(tier, "standard" | "fast")
            })
            && self.reasoning.as_deref().is_none_or(|level| {
                matches!(
                    level,
                    "off"
                        | "none"
                        | "minimal"
                        | "low"
                        | "medium"
                        | "high"
                        | "xhigh"
                        | "max"
                        | "ultra"
                )
            })
            && self.allowed_spawn_profile_ids.iter().all(|id| {
                id == &self.id || workspace.profiles.iter().any(|value| value.value.id == *id)
            })
            && self.tool_policy.rules.iter().all(|rule| {
                !rule.tool.trim().is_empty()
                    && (!rule.mandatory
                        || !matches!(
                            rule.enforcement,
                            piui_orchestration::PolicyEnforcement::Advisory
                                | piui_orchestration::PolicyEnforcement::Unsupported
                        ))
            })
    }
    fn can_delete(workspace: &WorkspaceOrchestration, id: &str) -> bool {
        !workspace.teams.iter().any(|team| {
            team.value
                .members
                .iter()
                .any(|member| member.profile_id == id)
        }) && !workspace.profiles.iter().any(|profile| {
            profile
                .value
                .allowed_spawn_profile_ids
                .iter()
                .any(|child| child == id)
        })
    }
}

impl DefinitionValue for TeamDefinition {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn values(workspace: &WorkspaceOrchestration) -> &Vec<StoredDefinition<Self>> {
        &workspace.teams
    }
    fn values_mut(workspace: &mut WorkspaceOrchestration) -> &mut Vec<StoredDefinition<Self>> {
        &mut workspace.teams
    }
    fn valid_for_workspace(&self, workspace: &WorkspaceOrchestration) -> bool {
        !self.id.trim().is_empty()
            && !self.name.trim().is_empty()
            && self.members.iter().all(|member| {
                workspace
                    .profiles
                    .iter()
                    .any(|profile| profile.value.id == member.profile_id)
            })
    }
    fn can_delete(workspace: &WorkspaceOrchestration, id: &str) -> bool {
        !workspace
            .launch_commands
            .iter()
            .any(|command| command.value.team_id == id)
    }
}

impl DefinitionValue for PipelineDefinition {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn values(workspace: &WorkspaceOrchestration) -> &Vec<StoredDefinition<Self>> {
        &workspace.pipelines
    }
    fn values_mut(workspace: &mut WorkspaceOrchestration) -> &mut Vec<StoredDefinition<Self>> {
        &mut workspace.pipelines
    }
    fn valid_for_workspace(&self, _workspace: &WorkspaceOrchestration) -> bool {
        !self.id.trim().is_empty() && !self.name.trim().is_empty()
    }
    fn can_delete(workspace: &WorkspaceOrchestration, id: &str) -> bool {
        !workspace
            .launch_commands
            .iter()
            .any(|command| command.value.pipeline_id == id)
    }
}

impl DefinitionValue for LaunchCommandReference {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn values(workspace: &WorkspaceOrchestration) -> &Vec<StoredDefinition<Self>> {
        &workspace.launch_commands
    }
    fn values_mut(workspace: &mut WorkspaceOrchestration) -> &mut Vec<StoredDefinition<Self>> {
        &mut workspace.launch_commands
    }
    fn valid_for_workspace(&self, workspace: &WorkspaceOrchestration) -> bool {
        !self.id.trim().is_empty()
            && !self.name.trim().is_empty()
            && workspace
                .teams
                .iter()
                .any(|team| team.value.id == self.team_id)
            && workspace
                .pipelines
                .iter()
                .any(|pipeline| pipeline.value.id == self.pipeline_id)
    }
    fn can_delete(_workspace: &WorkspaceOrchestration, _id: &str) -> bool {
        true
    }
}

fn validate_workspace_id(workspace_id: &str) -> Result<(), OrchestrationApiError> {
    if workspace_id.trim().is_empty() {
        Err(OrchestrationApiError::invalid())
    } else {
        Ok(())
    }
}

fn validate_workspace_scope(
    host_state: &HostState,
    workspace_id: &str,
) -> Result<(), OrchestrationApiError> {
    validate_workspace_id(workspace_id)?;
    verified_project_directory(host_state, workspace_id, false)
        .map(|_| ())
        .map_err(|_| OrchestrationApiError::not_found())
}

fn validate_live_workspace_scope(
    host_state: &HostState,
    workspace_id: &str,
) -> Result<(), OrchestrationApiError> {
    validate_workspace_id(workspace_id)?;
    if host_state.safe_mode || host_state.is_shutting_down() {
        return Err(OrchestrationApiError::runtime_unavailable());
    }
    verified_project_directory(host_state, workspace_id, true)
        .map(|_| ())
        .map_err(|_| OrchestrationApiError::runtime_unavailable())
}

fn get_definition<T: DefinitionValue>(
    state: &OrchestrationApiState,
    request: GetDefinitionRequest,
) -> Result<Option<StoredDefinition<T>>, OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    if request.id.trim().is_empty() {
        return Err(OrchestrationApiError::invalid());
    }
    let store = state.lock()?;
    Ok(store
        .workspace(&request.workspace_id)
        .and_then(|workspace| {
            T::values(workspace)
                .iter()
                .find(|value| value.value.id() == request.id)
        })
        .cloned())
}

fn save_definition<T: DefinitionValue>(
    state: &OrchestrationApiState,
    request: SaveDefinitionRequest<T>,
) -> Result<StoredDefinition<T>, OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    let workspace_id = request.workspace_id;
    let expected_revision = request.expected_revision;
    let value = request.value;
    let mut store = state.lock()?;
    store
        .transact(|workspaces| {
            let index = workspaces
                .iter()
                .position(|workspace| workspace.workspace_id == workspace_id);
            let workspace = if let Some(index) = index {
                &mut workspaces[index]
            } else {
                workspaces.push(WorkspaceOrchestration::empty(workspace_id.clone()));
                workspaces.last_mut().ok_or(StoreError::Invalid)?
            };
            if !value.valid_for_workspace(workspace) {
                return Err(StoreError::Invalid);
            }
            let existing = T::values(workspace)
                .iter()
                .position(|stored| stored.value.id() == value.id());
            match (existing, expected_revision) {
                (None, None) => {
                    let stored = StoredDefinition { revision: 0, value };
                    T::values_mut(workspace).push(stored.clone());
                    Ok(stored)
                }
                (None, Some(_)) => Err(StoreError::NotFound),
                (Some(_), None) => Err(StoreError::AlreadyExists),
                (Some(index), Some(expected)) => {
                    let values = T::values_mut(workspace);
                    if values[index].revision != expected {
                        return Err(StoreError::Conflict);
                    }
                    let revision = expected.checked_add(1).ok_or(StoreError::Invalid)?;
                    let stored = StoredDefinition { revision, value };
                    values[index] = stored.clone();
                    Ok(stored)
                }
            }
        })
        .map_err(Into::into)
}

fn delete_definition<T: DefinitionValue>(
    state: &OrchestrationApiState,
    request: DeleteDefinitionRequest,
) -> Result<(), OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    let mut store = state.lock()?;
    store
        .transact(|workspaces| {
            let workspace = workspaces
                .iter_mut()
                .find(|workspace| workspace.workspace_id == request.workspace_id)
                .ok_or(StoreError::NotFound)?;
            if !T::can_delete(workspace, &request.id) {
                return Err(StoreError::Conflict);
            }
            let values = T::values_mut(workspace);
            let index = values
                .iter()
                .position(|stored| stored.value.id() == request.id)
                .ok_or(StoreError::NotFound)?;
            if values[index].revision != request.expected_revision {
                return Err(StoreError::Conflict);
            }
            values.remove(index);
            Ok(())
        })
        .map_err(Into::into)
}

#[tauri::command]
pub fn orchestration_catalog_v6(
    state: State<'_, OrchestrationApiState>,
    host_state: State<'_, HostState>,
    request: WorkspaceRequest,
) -> Result<OrchestrationCatalogV4, OrchestrationApiError> {
    validate_workspace_scope(&host_state, &request.workspace_id)?;
    let store = state.lock()?;
    let Some(workspace) = store.workspace(&request.workspace_id) else {
        return Ok(OrchestrationCatalogV4 {
            profiles: vec![],
            teams: vec![],
            pipelines: vec![],
            launch_commands: vec![],
        });
    };
    fn summaries<T: DefinitionValue>(values: &[StoredDefinition<T>]) -> Vec<DefinitionSummary> {
        let mut result: Vec<_> = values
            .iter()
            .map(|stored| DefinitionSummary {
                id: stored.value.id().to_owned(),
                name: stored.value.name().to_owned(),
                revision: stored.revision,
            })
            .collect();
        result.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
        result
    }
    Ok(OrchestrationCatalogV4 {
        profiles: summaries(&workspace.profiles),
        teams: summaries(&workspace.teams),
        pipelines: summaries(&workspace.pipelines),
        launch_commands: summaries(&workspace.launch_commands),
    })
}

#[tauri::command]
pub fn orchestration_run_usage_v6(
    state: State<'_, OrchestrationApiState>,
    host_state: State<'_, HostState>,
    request: RunRequest,
) -> Result<
    std::collections::BTreeMap<String, Vec<piui_runtime::workspace_usage::NativeUsage>>,
    OrchestrationApiError,
> {
    validate_workspace_scope(&host_state, &request.workspace_id)?;
    let run = state
        .get_run(&request.workspace_id, &request.run_id)?
        .ok_or_else(OrchestrationApiError::not_found)?;
    let mut usage = std::collections::BTreeMap::new();
    for task in run.tasks().iter().chain(run.attempts()) {
        if let Some(execution) = task.execution() {
            let receipts = host_state
                .workspace
                .usage(&execution.id, &request.workspace_id)
                .map_err(|_| OrchestrationApiError::not_found())?;
            usage.insert(execution.id.clone(), receipts);
        }
    }
    Ok(usage)
}

macro_rules! definition_commands {
    ($get:ident, $save:ident, $delete:ident, $type:ty) => {
        #[tauri::command]
        pub fn $get(
            state: State<'_, OrchestrationApiState>,
            host_state: State<'_, HostState>,
            request: GetDefinitionRequest,
        ) -> Result<Option<StoredDefinition<$type>>, OrchestrationApiError> {
            validate_workspace_scope(&host_state, &request.workspace_id)?;
            get_definition(&state, request)
        }
        #[tauri::command]
        pub async fn $save(
            state: State<'_, OrchestrationApiState>,
            host_state: State<'_, HostState>,
            request: SaveDefinitionRequest<$type>,
        ) -> Result<StoredDefinition<$type>, OrchestrationApiError> {
            let _operation = host_state.live_runtime_operation_gate.lock().await;
            validate_workspace_scope(&host_state, &request.workspace_id)?;
            save_definition(&state, request)
        }
        #[tauri::command]
        pub async fn $delete(
            state: State<'_, OrchestrationApiState>,
            host_state: State<'_, HostState>,
            request: DeleteDefinitionRequest,
        ) -> Result<(), OrchestrationApiError> {
            let _operation = host_state.live_runtime_operation_gate.lock().await;
            validate_workspace_scope(&host_state, &request.workspace_id)?;
            delete_definition::<$type>(&state, request)
        }
    };
}

definition_commands!(
    orchestration_get_profile_v6,
    orchestration_save_profile_v6,
    orchestration_delete_profile_v6,
    AgentProfile
);
definition_commands!(
    orchestration_get_team_v6,
    orchestration_save_team_v6,
    orchestration_delete_team_v6,
    TeamDefinition
);
definition_commands!(
    orchestration_get_pipeline_v6,
    orchestration_save_pipeline_v6,
    orchestration_delete_pipeline_v6,
    PipelineDefinition
);
definition_commands!(
    orchestration_get_launch_command_v6,
    orchestration_save_launch_command_v6,
    orchestration_delete_launch_command_v6,
    LaunchCommandReference
);

#[tauri::command]
pub fn orchestration_list_runs_v6(
    state: State<'_, OrchestrationApiState>,
    host_state: State<'_, HostState>,
    request: WorkspaceRequest,
) -> Result<Vec<RunSummary>, OrchestrationApiError> {
    validate_workspace_scope(&host_state, &request.workspace_id)?;
    validate_workspace_id(&request.workspace_id)?;
    let store = state.lock()?;
    let Some(workspace) = store.workspace(&request.workspace_id) else {
        return Ok(vec![]);
    };
    let mut runs: Vec<_> = workspace
        .runs
        .iter()
        .map(|run| RunSummary {
            id: run.id().to_owned(),
            status: run.status(),
            revision: run.revision(),
            team_name: run.definition().team.name.clone(),
            pipeline_name: run.definition().pipeline.name.clone(),
        })
        .collect();
    runs.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(runs)
}

#[tauri::command]
pub fn orchestration_get_run_v6(
    state: State<'_, OrchestrationApiState>,
    host_state: State<'_, HostState>,
    request: RunRequest,
) -> Result<Option<Run>, OrchestrationApiError> {
    validate_workspace_scope(&host_state, &request.workspace_id)?;
    validate_workspace_id(&request.workspace_id)?;
    let store = state.lock()?;
    Ok(store
        .workspace(&request.workspace_id)
        .and_then(|workspace| {
            workspace
                .runs
                .iter()
                .find(|run| run.id() == request.run_id)
                .cloned()
        }))
}

#[tauri::command]
pub async fn orchestration_start_run_v6(
    state: State<'_, OrchestrationApiState>,
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: StartRunRequest,
) -> Result<Run, OrchestrationApiError> {
    let operation = host_state.live_runtime_operation_gate.lock().await;
    validate_live_workspace_scope(&host_state, &request.workspace_id)?;
    let workspace_id = request.workspace_id.clone();
    let run_id = request.run_id.clone();
    let created = state.create_run(request)?;
    emit_run_changed(&app, &workspace_id, &created);
    drop(operation);
    scheduler
        .schedule_run(&app, &workspace_id, &run_id)
        .await
        .map_err(scheduler_error)?;
    let run = state
        .get_run(&workspace_id, &run_id)?
        .ok_or_else(OrchestrationApiError::not_found)?;
    emit_run_changed(&app, &workspace_id, &run);
    Ok(run)
}

#[tauri::command]
pub async fn orchestration_cancel_run_v6(
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: RunMutationRequest,
) -> Result<Run, OrchestrationApiError> {
    validate_workspace_scope(&host_state, &request.workspace_id)?;
    let run = scheduler
        .cancel_run(
            &app,
            &request.workspace_id,
            &request.run_id,
            request.expected_run_revision,
        )
        .await
        .map_err(scheduler_error)?;
    emit_run_changed(&app, &request.workspace_id, &run);
    Ok(run)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRequest {
    workspace_id: String,
    run_id: String,
    expected_run_revision: u64,
    action: piui_orchestration::FlowAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelTaskRequest {
    workspace_id: String,
    run_id: String,
    expected_run_revision: u64,
    step_id: String,
}

#[tauri::command]
pub async fn orchestration_cancel_task_v6(
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: CancelTaskRequest,
) -> Result<Run, OrchestrationApiError> {
    validate_workspace_scope(&host_state, &request.workspace_id)?;
    let run = scheduler
        .cancel_task(
            &app,
            &request.workspace_id,
            &request.run_id,
            request.expected_run_revision,
            &request.step_id,
        )
        .await
        .map_err(scheduler_error)?;
    emit_run_changed(&app, &request.workspace_id, &run);
    if run.status() == piui_orchestration::RunStatus::Running && !run.paused() {
        scheduler
            .schedule_run(&app, &request.workspace_id, &request.run_id)
            .await
            .map_err(scheduler_error)?;
    }
    Ok(run)
}

#[tauri::command]
pub async fn orchestration_control_flow_v6(
    state: State<'_, OrchestrationApiState>,
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: FlowControlRequest,
) -> Result<Run, OrchestrationApiError> {
    let operation = host_state.live_runtime_operation_gate.lock().await;
    validate_live_workspace_scope(&host_state, &request.workspace_id)?;
    let workspace_id = request.workspace_id.clone();
    let run_id = request.run_id.clone();
    let run = state.control_flow(request)?;
    emit_run_changed(&app, &workspace_id, &run);
    drop(operation);
    if !run.paused() && run.status() == piui_orchestration::RunStatus::Running {
        scheduler
            .schedule_run(&app, &workspace_id, &run_id)
            .await
            .map_err(scheduler_error)?;
    }
    state
        .get_run(&workspace_id, &run_id)?
        .ok_or_else(OrchestrationApiError::not_found)
}

#[tauri::command]
pub async fn orchestration_reconcile_uncertain_task_v6(
    state: State<'_, OrchestrationApiState>,
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: ReconcileUncertainTaskRequest,
) -> Result<Run, OrchestrationApiError> {
    let operation = host_state.live_runtime_operation_gate.lock().await;
    validate_workspace_scope(&host_state, &request.workspace_id)?;
    let should_schedule = matches!(request.resolution, ReconcileResolution::Succeeded { .. });
    if should_schedule {
        validate_live_workspace_scope(&host_state, &request.workspace_id)?;
    }
    let workspace_id = request.workspace_id.clone();
    let run_id = request.run_id.clone();
    let resolution = match request.resolution {
        ReconcileResolution::Succeeded { result_reference } => {
            UncertainResolution::Succeeded { result_reference }
        }
        ReconcileResolution::Failed { failure_code } => UncertainResolution::Failed {
            failure: FailureRecord { code: failure_code },
        },
        ReconcileResolution::Cancelled => UncertainResolution::Cancelled,
    };
    let reconciled = {
        let mut store = state.lock()?;
        store.transact(|workspaces| {
            let run = mutable_run(workspaces, &workspace_id, &run_id)?;
            Coordinator::reconcile_uncertain_task(
                run,
                request.expected_run_revision,
                &request.step_id,
                request.expected_task_revision,
                resolution,
            )
            .map_err(|error| match error {
                CoordinatorError::RevisionConflict { .. } => StoreError::Conflict,
                CoordinatorError::UnknownTask { .. } => StoreError::NotFound,
                _ => StoreError::Invalid,
            })?;
            Ok(run.clone())
        })?
    };
    emit_run_changed(&app, &workspace_id, &reconciled);
    drop(operation);
    if !should_schedule {
        return Ok(reconciled);
    }
    scheduler
        .schedule_run(&app, &workspace_id, &run_id)
        .await
        .map_err(scheduler_error)?;
    let run = state
        .get_run(&workspace_id, &run_id)?
        .ok_or_else(OrchestrationApiError::not_found)?;
    emit_run_changed(&app, &workspace_id, &run);
    Ok(run)
}

#[tauri::command]
pub async fn orchestration_retry_uncertain_task_v6(
    state: State<'_, OrchestrationApiState>,
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: RetryUncertainTaskRequest,
) -> Result<Run, OrchestrationApiError> {
    let operation = host_state.live_runtime_operation_gate.lock().await;
    validate_live_workspace_scope(&host_state, &request.workspace_id)?;
    let workspace_id = request.workspace_id.clone();
    let run_id = request.run_id.clone();
    let retried = state.retry_uncertain(request)?;
    emit_run_changed(&app, &workspace_id, &retried);
    drop(operation);
    scheduler
        .schedule_run(&app, &workspace_id, &run_id)
        .await
        .map_err(scheduler_error)?;
    let run = state
        .get_run(&workspace_id, &run_id)?
        .ok_or_else(OrchestrationApiError::not_found)?;
    emit_run_changed(&app, &workspace_id, &run);
    Ok(run)
}

fn record_agent_request(
    run: &mut Run,
    request_id: &str,
    actor_workspace_session_id: &str,
    actor_member_id: &str,
    operation: AgentRequestKind,
) -> Result<bool, StoreError> {
    let revision = run.revision();
    Coordinator::record_agent_request(
        run,
        revision,
        request_id.to_owned(),
        actor_workspace_session_id.to_owned(),
        actor_member_id.to_owned(),
        operation,
    )
    .map_err(|error| match error {
        CoordinatorError::AgentRequestConflict { .. }
        | CoordinatorError::RevisionConflict { .. } => StoreError::Conflict,
        _ => StoreError::Invalid,
    })
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

fn create_run_in(
    workspaces: &mut [WorkspaceOrchestration],
    request: StartRunRequest,
) -> Result<Run, StoreError> {
    let workspace = workspaces
        .iter_mut()
        .find(|workspace| workspace.workspace_id == request.workspace_id)
        .ok_or(StoreError::NotFound)?;
    if workspace.runs.iter().any(|run| run.id() == request.run_id) {
        return Err(StoreError::AlreadyExists);
    }
    let team = workspace
        .teams
        .iter()
        .find(|value| value.value.id == request.team_id)
        .map(|value| value.value.clone())
        .ok_or(StoreError::NotFound)?;
    let pipeline = workspace
        .pipelines
        .iter()
        .find(|value| value.value.id == request.pipeline_id)
        .map(|value| value.value.clone())
        .ok_or(StoreError::NotFound)?;
    let launch_command = match request.launch_command_id.as_deref() {
        Some(id) => Some(
            workspace
                .launch_commands
                .iter()
                .find(|value| value.value.id == id)
                .map(|value| value.value.clone())
                .ok_or(StoreError::NotFound)?,
        ),
        None => None,
    };
    let snapshot = RunDefinitionSnapshot {
        profiles: workspace
            .profiles
            .iter()
            .map(|value| value.value.clone())
            .collect(),
        team,
        pipeline,
        launch_command,
    };
    let run = Coordinator::new_run(request.run_id, snapshot).map_err(|_| StoreError::Invalid)?;
    workspace.runs.push(run.clone());
    Ok(run)
}

fn retry_uncertain_in(
    workspaces: &mut [WorkspaceOrchestration],
    request: RetryUncertainTaskRequest,
) -> Result<Run, StoreError> {
    let run = mutable_run(workspaces, &request.workspace_id, &request.run_id)?;
    Coordinator::retry_uncertain_task(
        run,
        request.expected_run_revision,
        &request.step_id,
        request.expected_task_revision,
    )
    .map_err(|error| match error {
        CoordinatorError::RevisionConflict { .. } => StoreError::Conflict,
        CoordinatorError::UnknownTask { .. } => StoreError::NotFound,
        _ => StoreError::Invalid,
    })?;
    Ok(run.clone())
}

fn derive_actor_member_id(
    run: &Run,
    workspace_session_id: &str,
) -> Result<String, OrchestrationApiError> {
    let task = run
        .tasks()
        .iter()
        .find(|task| {
            task.status() == TaskStatus::Running
                && task
                    .execution()
                    .is_some_and(|execution| execution.id == workspace_session_id)
        })
        .ok_or_else(OrchestrationApiError::denied)?;
    let step = run
        .definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == task.step_id())
        .ok_or_else(OrchestrationApiError::denied)?;
    Ok(step.assigned_member_id.clone())
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

fn mutable_run<'a>(
    workspaces: &'a mut [WorkspaceOrchestration],
    workspace_id: &str,
    run_id: &str,
) -> Result<&'a mut Run, StoreError> {
    workspaces
        .iter_mut()
        .find(|workspace| workspace.workspace_id == workspace_id)
        .and_then(|workspace| workspace.runs.iter_mut().find(|run| run.id() == run_id))
        .ok_or(StoreError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::{AgentToolOperation, AgentToolRequest};

    #[test]
    fn dynamic_spawn_request_replays_committed_identity_without_duplicate_agent() {
        use super::*;
        let root = std::env::temp_dir().join(format!("piui-spawn-api-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        let definition: RunDefinitionSnapshot = serde_json::from_value(serde_json::json!({
            "profiles":[{"id":"profile","name":"Worker","harness":"codex","model":"native","permissionMode":"native","instructions":"","whenToCall":"When review is needed","inputInstructions":"Profile default","expectedResult":"Findings with evidence","toolPolicy":{"rules":[]},"allowedSpawnProfileIds":["profile"]}],
            "team":{"id":"team","name":"Team","members":[{"id":"parent","profileId":"profile"}],"sendEdges":[],"observeEdges":[],"orchestratorMemberId":"parent"},
            "pipeline":{"id":"pipeline","name":"Pipeline","steps":[{"id":"task","name":"Task","assignedMemberId":"parent","instructions":"Work","inputInstructions":"Changed paths and tests","dependencyStepIds":[]}]}
        })).unwrap();
        let mut run = Coordinator::new_run("run", definition).unwrap();
        Coordinator::dispatch_next(
            &mut run,
            0,
            NativeExecutionReference {
                id: "parent-session".into(),
            },
        )
        .unwrap();
        state
            .lock()
            .unwrap()
            .transact(|workspaces| {
                let mut workspace = WorkspaceOrchestration::empty("project".into());
                workspace.runs.push(run);
                workspaces.push(workspace);
                Ok(())
            })
            .unwrap();
        let capabilities: NativeBridgeCapabilities = serde_json::from_value(serde_json::json!({
            "permissionModes":["native"],"nativeEnforcedTools":[],"coordinatorEnforcedTools":[],
            "agentOperations":{"roster":true,"send":true,"observe":true,"spawn":true}
        }))
        .unwrap();
        let context = ManagedAgentContext {
            workspace_id: "project".into(),
            run_id: "run".into(),
            workspace_session_id: "parent-session".into(),
        };
        let AgentRequestAdmission::Roster { spawn_profiles, .. } = state
            .handle_agent_request(
                context.clone(),
                AgentToolRequest {
                    request_id: "roster-one".into(),
                    operation: AgentToolOperation::Roster,
                },
                &capabilities,
            )
            .unwrap()
        else {
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
        let request = AgentToolRequest {
            request_id: "spawn-one".into(),
            operation: AgentToolOperation::SpawnAgent {
                profile_id: "profile".into(),
                name: "Child".into(),
                instructions: "Review".into(),
            },
        };
        let AgentRequestAdmission::Spawn { lease } = state
            .handle_agent_request(context.clone(), request.clone(), &capabilities)
            .unwrap()
        else {
            panic!("expected lease")
        };
        state
            .commit_launch_lease("project", "run", &lease, "child-session".into())
            .unwrap();
        assert!(
            matches!(state.handle_agent_request(context.clone(), request, &capabilities).unwrap(), AgentRequestAdmission::SpawnCommitted {workspace_session_id, ..} if workspace_session_id == "child-session")
        );
        let forged = AgentToolRequest {
            request_id: "spawn-one".into(),
            operation: AgentToolOperation::SpawnAgent {
                profile_id: "profile".into(),
                name: "Other".into(),
                instructions: "Different".into(),
            },
        };
        assert!(
            state
                .handle_agent_request(context, forged, &capabilities)
                .is_err()
        );
        assert_eq!(
            state
                .get_run("project", "run")
                .unwrap()
                .unwrap()
                .tasks()
                .len(),
            2
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reverse_agent_request_has_no_actor_field_and_uses_final_observe_name() {
        let request: AgentToolRequest = serde_json::from_value(serde_json::json!({
            "requestId": "tool-call-1",
            "operation": {"type": "observe", "targetMemberId": "worker"}
        }))
        .expect("parses final reverse contract");
        assert!(matches!(
            request.operation,
            AgentToolOperation::Observe { target_member_id } if target_member_id == "worker"
        ));

        for forged in [
            serde_json::json!({
                "requestId": "tool-call-1",
                "actorMemberId": "attacker",
                "operation": {"type": "roster"}
            }),
            serde_json::json!({
                "requestId": "tool-call-1",
                "operation": {"type": "observe", "memberId": "worker"}
            }),
        ] {
            assert!(serde_json::from_value::<AgentToolRequest>(forged).is_err());
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveGraphRequest {
    pub workspace_id: String,
    pub profiles: Vec<SaveDefinitionRequest<AgentProfile>>,
    pub team: SaveDefinitionRequest<TeamDefinition>,
    pub pipeline: SaveDefinitionRequest<PipelineDefinition>,
    pub command: SaveDefinitionRequest<LaunchCommandReference>,
}

fn put_graph_definition<T: DefinitionValue>(
    workspace: &mut WorkspaceOrchestration,
    request: SaveDefinitionRequest<T>,
) -> Result<(), StoreError> {
    if request.workspace_id != workspace.workspace_id {
        return Err(StoreError::Invalid);
    }
    let values = T::values_mut(workspace);
    match (
        values
            .iter()
            .position(|stored| stored.value.id() == request.value.id()),
        request.expected_revision,
    ) {
        (None, None) => values.push(StoredDefinition {
            revision: 0,
            value: request.value,
        }),
        (Some(index), Some(expected)) if values[index].revision == expected => {
            values[index] = StoredDefinition {
                revision: expected.checked_add(1).ok_or(StoreError::Invalid)?,
                value: request.value,
            };
        }
        _ => return Err(StoreError::Conflict),
    }
    Ok(())
}

fn save_graph(
    state: &OrchestrationApiState,
    request: SaveGraphRequest,
) -> Result<(), OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    let snapshot = RunDefinitionSnapshot {
        profiles: request
            .profiles
            .iter()
            .map(|entry| entry.value.clone())
            .collect(),
        team: request.team.value.clone(),
        pipeline: request.pipeline.value.clone(),
        launch_command: Some(request.command.value.clone()),
    };
    piui_orchestration::validate_definition(&snapshot)
        .map_err(|_| OrchestrationApiError::invalid())?;
    for parent in &snapshot.profiles {
        for child in &parent.allowed_spawn_profile_ids {
            piui_orchestration::authorize_spawn(&snapshot, &parent.id, child)
                .map_err(|_| OrchestrationApiError::denied())?;
        }
    }
    state
        .lock()?
        .transact(|workspaces| {
            let index = match workspaces
                .iter()
                .position(|value| value.workspace_id == request.workspace_id)
            {
                Some(index) => index,
                None => {
                    workspaces.push(WorkspaceOrchestration::empty(request.workspace_id.clone()));
                    workspaces.len() - 1
                }
            };
            let workspace = &mut workspaces[index];
            for profile in request.profiles {
                put_graph_definition(workspace, profile)?;
            }
            put_graph_definition(workspace, request.team)?;
            put_graph_definition(workspace, request.pipeline)?;
            put_graph_definition(workspace, request.command)?;
            if snapshot
                .profiles
                .iter()
                .any(|value| !value.valid_for_workspace(workspace))
            {
                return Err(StoreError::Invalid);
            }
            Ok(())
        })
        .map_err(Into::into)
}

#[tauri::command]
pub async fn orchestration_save_graph_v6(
    state: State<'_, OrchestrationApiState>,
    host_state: State<'_, HostState>,
    request: SaveGraphRequest,
) -> Result<(), OrchestrationApiError> {
    let _operation = host_state.live_runtime_operation_gate.lock().await;
    validate_workspace_scope(&host_state, &request.workspace_id)?;
    save_graph(&state, request)
}

#[cfg(test)]
mod graph_tests {
    use super::*;
    fn request() -> SaveGraphRequest {
        serde_json::from_value(serde_json::json!({
            "workspaceId":"workspace",
            "profiles":[{"workspaceId":"workspace","value":{"id":"agent","name":"Agent","harness":"codex","model":"model","permissionMode":"read-only","instructions":"","reasoning":"high","serviceTier":"fast","resourceRules":[{"kind":"mcp","id":"example","enabled":false}],"toolPolicy":{"rules":[]},"allowedSpawnProfileIds":[]}}],
            "team":{"workspaceId":"workspace","value":{"id":"team","name":"System","members":[{"id":"node","profileId":"agent"}],"sendEdges":[],"observeEdges":[],"orchestratorMemberId":"node"}},
            "pipeline":{"workspaceId":"workspace","value":{"id":"pipeline","name":"System","steps":[{"id":"node","name":"Task","assignedMemberId":"node","instructions":"Work","dependencyStepIds":[]}]}},
            "command":{"workspaceId":"workspace","value":{"id":"command","name":"System","teamId":"team","pipelineId":"pipeline"}}
        })).unwrap()
    }
    #[test]
    fn graph_save_is_atomic_and_preserves_settings_across_reopen() {
        let root = std::env::temp_dir().join(format!("piui-graph-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, request()).unwrap();
        let mut conflict = request();
        conflict.profiles[0].expected_revision = Some(0);
        conflict.profiles[0].value.name = "Must roll back".into();
        assert!(save_graph(&state, conflict).is_err());
        drop(state);
        let state = OrchestrationApiState::open(&root).unwrap();
        let store = state.lock().unwrap();
        let workspace = store.workspace("workspace").unwrap();
        assert_eq!(workspace.profiles[0].value.name, "Agent");
        assert_eq!(workspace.profiles[0].revision, 0);
        assert_eq!(
            workspace.profiles[0].value.reasoning.as_deref(),
            Some("high")
        );
        assert_eq!(
            workspace.profiles[0].value.service_tier.as_deref(),
            Some("fast")
        );
        assert!(!workspace.profiles[0].value.resource_rules[0].enabled);
        assert_eq!(workspace.launch_commands.len(), 1);
    }
}
