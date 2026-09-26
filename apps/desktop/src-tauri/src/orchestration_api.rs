//! Narrow Tauri orchestration API and host-private scheduler seam.
//!
//! Definition and run data are durable application data. The WebView can edit
//! definitions and request explicit run transitions, but cannot supply an
//! authenticated agent sender or report native completion. Those operations
//! are available only on `OrchestrationApiState` for trusted host integration.

use crate::api::verified_project_directory;
use crate::orchestration_schedule::{
    MissedRunPolicy, OverlapPolicy, ScheduleDefinition, ScheduleOccurrence,
    ScheduleOccurrenceOutcome, ScheduleSnapshot, StoredSchedule, occurrence_id,
};
use crate::orchestration_scheduler::OrchestrationScheduler;
use crate::orchestration_store::{
    OrchestrationStore, StoreError, StoreSnapshot, StoredDefinition, WorkspaceOrchestration,
};
use crate::state::HostState;
use chrono::{DateTime, Utc};
use piui_orchestration::{
    AgentProfile, AgentRequestKind, AuthenticatedSender, CompletionOutcome, ControlledSpawnLease,
    Coordinator, CoordinatorError, FailureRecord, Harness, LaunchCommandReference, LaunchRequest,
    MessageIntent, NativeBridgeCapabilities, NativeExecutionReference, NativeHistoryReference,
    PipelineDefinition, Run, RunDefinitionSnapshot, RunStatus, TaskStatus, TeamDefinition,
    UncertainResolution, UncertaintyIdentity, authorize_coordinator_tool, authorize_observe,
    authorize_send, validate_profile_capabilities,
};
use piui_orchestration::{RunInputError, resolve_run_inputs, validate_pipeline_declarations};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationApiError {
    pub(crate) code: &'static str,
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
pub const ORCHESTRATION_SCHEDULE_EVENT_V7: &str = "piui://orchestration-schedule-event";

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

pub fn emit_run_changed<R: tauri::Runtime>(app: &AppHandle<R>, workspace_id: &str, run: &Run) {
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationScheduleChangedEventV7 {
    pub protocol: u8,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub workspace_id: String,
    pub schedule_id: String,
    pub revision: u64,
}

pub fn emit_schedule_changed<R: tauri::Runtime>(
    app: &AppHandle<R>,
    workspace_id: &str,
    schedule_id: &str,
    revision: u64,
) {
    let _ = app.emit(
        ORCHESTRATION_SCHEDULE_EVENT_V7,
        OrchestrationScheduleChangedEventV7 {
            protocol: 7,
            event_type: "scheduleChanged",
            workspace_id: workspace_id.to_owned(),
            schedule_id: schedule_id.to_owned(),
            revision,
        },
    );
}

pub struct OrchestrationApiState {
    /// Writers serialize inside the store; readers take an immutable snapshot
    /// and never wait for a writer's serialization or fsync.
    store: OrchestrationStore,
}

impl OrchestrationApiState {
    fn control_flow(&self, request: FlowControlRequest) -> Result<Run, OrchestrationApiError> {
        self.store
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
        let store = OrchestrationStore::open(app_data_dir)?;
        store.recover_interrupted_runs()?;
        Ok(Self { store })
    }

    pub fn get_run(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<Option<Run>, OrchestrationApiError> {
        validate_workspace_id(workspace_id)?;
        let store = self.snapshot()?;
        Ok(store.workspace(workspace_id).and_then(|workspace| {
            workspace
                .runs
                .iter()
                .find(|run| run.id() == run_id)
                .cloned()
        }))
    }

    /// Persist coordinator-only transitions before the scheduler resolves a
    /// native profile. Program routers are evaluated here and never launched.
    pub fn advance_automatic_steps(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<Run, OrchestrationApiError> {
        validate_workspace_id(workspace_id)?;
        self.store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, workspace_id, run_id)?;
                Coordinator::advance_automatic_steps(run);
                Ok(run.clone())
            })
            .map_err(Into::into)
    }

    pub fn create_run(&self, request: StartRunRequest) -> Result<Run, OrchestrationApiError> {
        validate_workspace_id(&request.workspace_id)?;
        self.store
            .transact(|workspaces| create_run_in(workspaces, request))
            .map_err(Into::into)
    }

    pub(crate) fn next_schedule_due(&self) -> Result<Option<DateTime<Utc>>, OrchestrationApiError> {
        let store = self.snapshot()?;
        Ok(store
            .workspaces()
            .iter()
            .flat_map(|workspace| workspace.schedules.iter())
            .filter(|schedule| schedule.enabled)
            .filter_map(|schedule| schedule.next_due_at)
            .min())
    }

    pub(crate) fn due_schedule_keys(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<(String, String, u64)>, OrchestrationApiError> {
        let store = self.snapshot()?;
        let mut due = Vec::new();
        for workspace in store.workspaces() {
            for schedule in &workspace.schedules {
                if schedule.enabled && schedule.next_due_at.is_some_and(|value| value <= now) {
                    due.push((
                        workspace.workspace_id.clone(),
                        schedule.value.id.clone(),
                        schedule.revision,
                    ));
                }
            }
        }
        due.sort();
        Ok(due)
    }

    /// Committed runs, started manually or by a schedule, whose remaining
    /// work has not crossed the native boundary. The host resumes them after
    /// a restart exactly like a fresh start. Work that did cross the boundary
    /// was made uncertain by `recover_interrupted_runs` when the journal was
    /// opened; such a run is never resumed or replayed automatically.
    pub(crate) fn recoverable_runs(&self) -> Result<Vec<(String, String)>, OrchestrationApiError> {
        let store = self.snapshot()?;
        let mut result = store
            .workspaces()
            .iter()
            .flat_map(|workspace| {
                workspace
                    .runs
                    .iter()
                    .filter(|run| resumable_after_restart(run))
                    .map(|run| (workspace.workspace_id.clone(), run.id().to_owned()))
            })
            .collect::<Vec<_>>();
        result.sort();
        result.dedup();
        Ok(result)
    }

    pub(crate) fn claim_due_schedule(
        &self,
        workspace_id: &str,
        schedule_id: &str,
        expected_revision: u64,
        now: DateTime<Utc>,
        host_started_at: DateTime<Utc>,
        admission_failure: Option<&str>,
    ) -> Result<ScheduleClaim, OrchestrationApiError> {
        self.store
            .transact(|workspaces| {
                let workspace_index = workspaces
                    .iter()
                    .position(|workspace| workspace.workspace_id == workspace_id)
                    .ok_or(StoreError::NotFound)?;
                let schedule_index = workspaces[workspace_index]
                    .schedules
                    .iter()
                    .position(|schedule| schedule.value.id == schedule_id)
                    .ok_or(StoreError::NotFound)?;
                let current = workspaces[workspace_index].schedules[schedule_index].clone();
                if current.revision != expected_revision || !current.enabled {
                    return Err(StoreError::Conflict);
                }
                let next_due = current.next_due_at.ok_or(StoreError::Conflict)?;
                if next_due > now {
                    return Err(StoreError::Conflict);
                }
                let current_launch_command_revision = workspaces[workspace_index]
                    .launch_commands
                    .iter()
                    .find(|command| command.value.id == current.value.launch_command_id)
                    .map(|command| command.revision);
                let launch_command_changed =
                    current.enabled_launch_command_revision != current_launch_command_revision;

                let nominal_at = current
                    .value
                    .trigger
                    .latest_at_or_before(now)
                    .unwrap_or(next_due);
                let missed = next_due < host_started_at || nominal_at > next_due;
                let active_overlap = current.value.overlap_policy == OverlapPolicy::Skip
                    && current.occurrences.iter().any(|occurrence| {
                        occurrence.run_id.as_ref().is_some_and(|run_id| {
                            workspaces[workspace_index]
                                .runs
                                .iter()
                                .find(|run| run.id() == run_id)
                                .is_some_and(|run| {
                                    matches!(
                                        run.status(),
                                        RunStatus::Running | RunStatus::Uncertain
                                    )
                                })
                        })
                    });
                let occurrence_key =
                    occurrence_id(&current.value.id, current.trigger_revision, nominal_at);
                let mut occurrence = ScheduleOccurrence {
                    id: occurrence_key.clone(),
                    nominal_at,
                    recorded_at: now,
                    outcome: ScheduleOccurrenceOutcome::Failed,
                    run_id: None,
                    failure_code: None,
                };
                let mut run = None;

                if launch_command_changed {
                    occurrence.failure_code = Some("launch-command-changed".to_owned());
                } else if let Some(code) = admission_failure {
                    occurrence.failure_code = Some(code.to_owned());
                } else if active_overlap {
                    occurrence.outcome = ScheduleOccurrenceOutcome::SkippedOverlap;
                } else if missed && current.value.missed_run_policy == MissedRunPolicy::Skip {
                    occurrence.outcome = ScheduleOccurrenceOutcome::SkippedMissed;
                } else {
                    let request = schedule_run_request(
                        &workspaces[workspace_index],
                        workspace_id,
                        &current.value,
                        occurrence_key,
                    );
                    match request.and_then(|request| create_run_in(workspaces, request)) {
                        Ok(created) => {
                            occurrence.outcome = ScheduleOccurrenceOutcome::Started;
                            occurrence.run_id = Some(created.id().to_owned());
                            run = Some(created);
                        }
                        Err(error) => {
                            occurrence.failure_code = Some(store_error_code(&error).to_owned());
                        }
                    }
                }

                let next = current.value.trigger.first_after(nominal_at);
                let schedule = &mut workspaces[workspace_index].schedules[schedule_index];
                schedule.revision = schedule
                    .revision
                    .checked_add(1)
                    .ok_or(StoreError::Invalid)?;
                schedule.next_due_at = next;
                if next.is_none() || launch_command_changed {
                    schedule.enabled = false;
                    schedule.enabled_launch_command_revision = None;
                }
                schedule.occurrences.push(occurrence);
                Ok(ScheduleClaim {
                    schedule: schedule.snapshot(),
                    run,
                })
            })
            .map_err(Into::into)
    }

    pub fn retry_uncertain(
        &self,
        request: RetryUncertainTaskRequest,
    ) -> Result<Run, OrchestrationApiError> {
        self.store
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
        self.store
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
        self.store
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
        let store = self.snapshot()?;
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
        self.store
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
        self.store
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
        self.store
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
                self.store
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
                self.store
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
                self.store
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
                self.store
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
                self.store
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
                        if !first_admission && let Some(committed) = committed_spawn(run, &step_id)
                        {
                            return Ok(committed);
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
        self.store
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
        self.store
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
        self.store
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

    fn snapshot(&self) -> Result<StoreSnapshot, OrchestrationApiError> {
        self.store.snapshot().map_err(Into::into)
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
    /// Values for the pipeline's declared inputs (v6.1, additive).
    #[serde(default)]
    pub inputs: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveScheduleRequest {
    pub workspace_id: String,
    pub expected_revision: Option<u64>,
    pub value: ScheduleDefinition,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleMutationRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetScheduleEnabledRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: u64,
    pub enabled: bool,
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

pub(crate) struct ScheduleClaim {
    pub schedule: ScheduleSnapshot,
    pub run: Option<Run>,
}

trait DefinitionValue: Clone + Sized {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn values(workspace: &WorkspaceOrchestration) -> &Vec<StoredDefinition<Self>>;
    fn values_mut(workspace: &mut WorkspaceOrchestration) -> &mut Vec<StoredDefinition<Self>>;
    fn valid_for_workspace(&self, workspace: &WorkspaceOrchestration) -> bool;
    fn can_delete(workspace: &WorkspaceOrchestration, id: &str) -> bool;
    fn after_save(
        _workspace: &mut WorkspaceOrchestration,
        _previous: Option<&StoredDefinition<Self>>,
        _saved: &StoredDefinition<Self>,
    ) -> Result<(), StoreError> {
        Ok(())
    }
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
        !self.id.trim().is_empty()
            && !self.name.trim().is_empty()
            && validate_pipeline_declarations(self).is_ok()
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
    fn can_delete(workspace: &WorkspaceOrchestration, id: &str) -> bool {
        !workspace
            .schedules
            .iter()
            .any(|schedule| schedule.value.launch_command_id == id)
    }
    fn after_save(
        workspace: &mut WorkspaceOrchestration,
        previous: Option<&StoredDefinition<Self>>,
        saved: &StoredDefinition<Self>,
    ) -> Result<(), StoreError> {
        let Some(previous) = previous else {
            return Ok(());
        };
        let execution_changed = previous.value.team_id != saved.value.team_id
            || previous.value.pipeline_id != saved.value.pipeline_id;
        for schedule in workspace
            .schedules
            .iter_mut()
            .filter(|schedule| schedule.value.launch_command_id == saved.value.id)
        {
            if execution_changed && schedule.enabled {
                schedule.revision = schedule
                    .revision
                    .checked_add(1)
                    .ok_or(StoreError::Invalid)?;
                schedule.trigger_revision = schedule
                    .trigger_revision
                    .checked_add(1)
                    .ok_or(StoreError::Invalid)?;
                schedule.enabled = false;
                schedule.enabled_launch_command_revision = None;
                schedule.next_due_at = Some(schedule.value.trigger.initial_due());
            } else if schedule.enabled {
                schedule.enabled_launch_command_revision = Some(saved.revision);
            }
        }
        Ok(())
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

pub(crate) fn validate_live_workspace_scope(
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

fn validate_schedule_mutation_scope(
    host_state: &HostState,
    workspace_id: &str,
) -> Result<(), OrchestrationApiError> {
    if host_state.safe_mode || host_state.is_shutting_down() {
        return Err(OrchestrationApiError::runtime_unavailable());
    }
    validate_workspace_scope(host_state, workspace_id)
}

fn get_definition<T: DefinitionValue>(
    state: &OrchestrationApiState,
    request: GetDefinitionRequest,
) -> Result<Option<StoredDefinition<T>>, OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    if request.id.trim().is_empty() {
        return Err(OrchestrationApiError::invalid());
    }
    let store = state.snapshot()?;
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
    state
        .store
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
            let previous = existing.map(|index| T::values(workspace)[index].clone());
            let saved = match (existing, expected_revision) {
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
            }?;
            T::after_save(workspace, previous.as_ref(), &saved)?;
            Ok(saved)
        })
        .map_err(Into::into)
}

fn delete_definition<T: DefinitionValue>(
    state: &OrchestrationApiState,
    request: DeleteDefinitionRequest,
) -> Result<(), OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    state
        .store
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

fn save_schedule(
    state: &OrchestrationApiState,
    request: SaveScheduleRequest,
) -> Result<ScheduleSnapshot, OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    if !request.value.validate() {
        return Err(OrchestrationApiError::invalid());
    }
    state
        .store
        .transact(|workspaces| {
            let workspace = workspaces
                .iter_mut()
                .find(|workspace| workspace.workspace_id == request.workspace_id)
                .ok_or(StoreError::NotFound)?;
            if !workspace
                .launch_commands
                .iter()
                .any(|command| command.value.id == request.value.launch_command_id)
            {
                return Err(StoreError::Invalid);
            }
            schedule_run_inputs(workspace, &request.value)?;
            let existing = workspace
                .schedules
                .iter()
                .position(|schedule| schedule.value.id == request.value.id);
            match (existing, request.expected_revision) {
                (None, None) => {
                    let stored = StoredSchedule {
                        revision: 0,
                        trigger_revision: 0,
                        next_due_at: Some(request.value.trigger.initial_due()),
                        value: request.value,
                        enabled: false,
                        enabled_launch_command_revision: None,
                        occurrences: Vec::new(),
                    };
                    let snapshot = stored.snapshot();
                    workspace.schedules.push(stored);
                    Ok(snapshot)
                }
                (None, Some(_)) => Err(StoreError::NotFound),
                (Some(_), None) => Err(StoreError::AlreadyExists),
                (Some(index), Some(expected_revision)) => {
                    let current = &workspace.schedules[index];
                    if current.revision != expected_revision {
                        return Err(StoreError::Conflict);
                    }
                    let execution_changed = !current.value.execution_equals(&request.value);
                    let mut stored = current.clone();
                    stored.revision = stored.revision.checked_add(1).ok_or(StoreError::Invalid)?;
                    stored.value = request.value;
                    if execution_changed {
                        stored.trigger_revision = stored
                            .trigger_revision
                            .checked_add(1)
                            .ok_or(StoreError::Invalid)?;
                        stored.enabled = false;
                        stored.enabled_launch_command_revision = None;
                        stored.next_due_at = Some(stored.value.trigger.initial_due());
                    }
                    let snapshot = stored.snapshot();
                    workspace.schedules[index] = stored;
                    Ok(snapshot)
                }
            }
        })
        .map_err(Into::into)
}

fn set_schedule_enabled(
    state: &OrchestrationApiState,
    request: SetScheduleEnabledRequest,
) -> Result<ScheduleSnapshot, OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    state
        .store
        .transact(|workspaces| {
            let workspace = workspaces
                .iter_mut()
                .find(|workspace| workspace.workspace_id == request.workspace_id)
                .ok_or(StoreError::NotFound)?;
            let schedule_index = workspace
                .schedules
                .iter()
                .position(|schedule| schedule.value.id == request.id)
                .ok_or(StoreError::NotFound)?;
            let schedule = &workspace.schedules[schedule_index];
            if schedule.revision != request.expected_revision {
                return Err(StoreError::Conflict);
            }
            let launch_command_revision = workspace
                .launch_commands
                .iter()
                .find(|command| {
                    command.value.id == schedule.value.launch_command_id
                        && workspace
                            .teams
                            .iter()
                            .any(|team| team.value.id == command.value.team_id)
                        && workspace
                            .pipelines
                            .iter()
                            .any(|pipeline| pipeline.value.id == command.value.pipeline_id)
                })
                .map(|command| command.revision);
            if request.enabled
                && (schedule.next_due_at.is_none() || launch_command_revision.is_none())
            {
                return Err(StoreError::Invalid);
            }
            if request.enabled {
                // The pipeline may have gained declarations since the save.
                schedule_run_inputs(workspace, &schedule.value)?;
            }
            let schedule = &mut workspace.schedules[schedule_index];
            let enabled_launch_command_revision = if request.enabled {
                launch_command_revision
            } else {
                None
            };
            if schedule.enabled != request.enabled
                || schedule.enabled_launch_command_revision != enabled_launch_command_revision
            {
                schedule.revision = schedule
                    .revision
                    .checked_add(1)
                    .ok_or(StoreError::Invalid)?;
                schedule.enabled = request.enabled;
                schedule.enabled_launch_command_revision = enabled_launch_command_revision;
            }
            Ok(schedule.snapshot())
        })
        .map_err(Into::into)
}

/// Why a schedule's input values cannot start its launch target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ScheduleInputError {
    /// The launch command or its pipeline is not saved in this workspace.
    TargetUnavailable,
    /// The values do not satisfy the pipeline's current input declarations,
    /// for example a required input without a value or default.
    Invalid(RunInputError),
}

impl From<ScheduleInputError> for StoreError {
    fn from(_: ScheduleInputError) -> Self {
        StoreError::Invalid
    }
}

/// Resolves a schedule's input values against its launch target's current
/// pipeline exactly as a run start does, so a schedule is never saved or
/// enabled with values a due occurrence would have to refuse.
fn schedule_run_inputs(
    workspace: &WorkspaceOrchestration,
    schedule: &ScheduleDefinition,
) -> Result<BTreeMap<String, serde_json::Value>, ScheduleInputError> {
    let pipeline = workspace
        .launch_commands
        .iter()
        .find(|command| command.value.id == schedule.launch_command_id)
        .and_then(|command| {
            workspace
                .pipelines
                .iter()
                .find(|pipeline| pipeline.value.id == command.value.pipeline_id)
        })
        .ok_or(ScheduleInputError::TargetUnavailable)?;
    resolve_run_inputs(&pipeline.value.inputs, &schedule.inputs)
        .map_err(ScheduleInputError::Invalid)
}

fn delete_schedule(
    state: &OrchestrationApiState,
    request: &ScheduleMutationRequest,
) -> Result<(), OrchestrationApiError> {
    validate_workspace_id(&request.workspace_id)?;
    state
        .store
        .transact(|workspaces| {
            let workspace = workspaces
                .iter_mut()
                .find(|workspace| workspace.workspace_id == request.workspace_id)
                .ok_or(StoreError::NotFound)?;
            let index = workspace
                .schedules
                .iter()
                .position(|schedule| schedule.value.id == request.id)
                .ok_or(StoreError::NotFound)?;
            if workspace.schedules[index].revision != request.expected_revision {
                return Err(StoreError::Conflict);
            }
            workspace.schedules.remove(index);
            Ok(())
        })
        .map_err(Into::into)
}

/// Runs a read-only orchestration query on the blocking thread pool. Tauri
/// runs synchronous commands on the main thread, where waiting for index or
/// registry locks and project filesystem checks would stall the WebView.
async fn orchestration_query<T, Q>(app: AppHandle, query: Q) -> Result<T, OrchestrationApiError>
where
    T: Send + 'static,
    Q: FnOnce(&OrchestrationApiState, &HostState) -> Result<T, OrchestrationApiError>
        + Send
        + 'static,
{
    off_main_thread(move || {
        let state = app
            .try_state::<OrchestrationApiState>()
            .ok_or_else(OrchestrationApiError::io)?;
        let host_state = app
            .try_state::<HostState>()
            .ok_or_else(OrchestrationApiError::io)?;
        query(&state, &host_state)
    })
    .await
}

async fn off_main_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, OrchestrationApiError> + Send + 'static,
) -> Result<T, OrchestrationApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| OrchestrationApiError::io())?
}

#[tauri::command]
pub async fn orchestration_catalog_v6(
    app: AppHandle,
    request: WorkspaceRequest,
) -> Result<OrchestrationCatalogV4, OrchestrationApiError> {
    orchestration_query(app, move |state, host_state| {
        orchestration_catalog(state, host_state, &request)
    })
    .await
}

fn orchestration_catalog(
    state: &OrchestrationApiState,
    host_state: &HostState,
    request: &WorkspaceRequest,
) -> Result<OrchestrationCatalogV4, OrchestrationApiError> {
    validate_workspace_scope(host_state, &request.workspace_id)?;
    let store = state.snapshot()?;
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

type RunUsage = std::collections::BTreeMap<String, Vec<piui_runtime::workspace_usage::NativeUsage>>;

#[tauri::command]
pub async fn orchestration_run_usage_v6(
    app: AppHandle,
    request: RunRequest,
) -> Result<RunUsage, OrchestrationApiError> {
    orchestration_query(app, move |state, host_state| {
        orchestration_run_usage(state, host_state, &request)
    })
    .await
}

fn orchestration_run_usage(
    state: &OrchestrationApiState,
    host_state: &HostState,
    request: &RunRequest,
) -> Result<RunUsage, OrchestrationApiError> {
    validate_workspace_scope(host_state, &request.workspace_id)?;
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
        pub async fn $get(
            app: AppHandle,
            request: GetDefinitionRequest,
        ) -> Result<Option<StoredDefinition<$type>>, OrchestrationApiError> {
            orchestration_query(app, move |state, host_state| {
                validate_workspace_scope(host_state, &request.workspace_id)?;
                get_definition(state, request)
            })
            .await
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
pub async fn orchestration_list_schedules_v7(
    app: AppHandle,
    request: WorkspaceRequest,
) -> Result<Vec<ScheduleSnapshot>, OrchestrationApiError> {
    orchestration_query(app, move |state, host_state| {
        orchestration_list_schedules(state, host_state, &request)
    })
    .await
}

fn orchestration_list_schedules(
    state: &OrchestrationApiState,
    host_state: &HostState,
    request: &WorkspaceRequest,
) -> Result<Vec<ScheduleSnapshot>, OrchestrationApiError> {
    validate_workspace_scope(host_state, &request.workspace_id)?;
    let store = state.snapshot()?;
    let mut schedules: Vec<_> = store
        .workspace(&request.workspace_id)
        .map(|workspace| {
            workspace
                .schedules
                .iter()
                .map(StoredSchedule::snapshot)
                .collect()
        })
        .unwrap_or_default();
    schedules.sort_by(|left, right| {
        left.value
            .name
            .cmp(&right.value.name)
            .then(left.value.id.cmp(&right.value.id))
    });
    Ok(schedules)
}

#[tauri::command]
pub async fn orchestration_save_schedule_v7(
    state: State<'_, OrchestrationApiState>,
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: SaveScheduleRequest,
) -> Result<ScheduleSnapshot, OrchestrationApiError> {
    let _operation = host_state.live_runtime_operation_gate.lock().await;
    validate_schedule_mutation_scope(&host_state, &request.workspace_id)?;
    let workspace_id = request.workspace_id.clone();
    let schedule_id = request.value.id.clone();
    let saved = save_schedule(&state, request)?;
    emit_schedule_changed(&app, &workspace_id, &schedule_id, saved.revision);
    scheduler.wake_timed_schedules();
    Ok(saved)
}

#[tauri::command]
pub async fn orchestration_set_schedule_enabled_v7(
    state: State<'_, OrchestrationApiState>,
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: SetScheduleEnabledRequest,
) -> Result<ScheduleSnapshot, OrchestrationApiError> {
    let _operation = host_state.live_runtime_operation_gate.lock().await;
    if request.enabled {
        validate_live_workspace_scope(&host_state, &request.workspace_id)?;
    } else {
        validate_schedule_mutation_scope(&host_state, &request.workspace_id)?;
    }
    let workspace_id = request.workspace_id.clone();
    let schedule_id = request.id.clone();
    let saved = set_schedule_enabled(&state, request)?;
    emit_schedule_changed(&app, &workspace_id, &schedule_id, saved.revision);
    scheduler.wake_timed_schedules();
    Ok(saved)
}

#[tauri::command]
pub async fn orchestration_delete_schedule_v7(
    state: State<'_, OrchestrationApiState>,
    scheduler: State<'_, OrchestrationScheduler>,
    host_state: State<'_, HostState>,
    app: AppHandle,
    request: ScheduleMutationRequest,
) -> Result<(), OrchestrationApiError> {
    let _operation = host_state.live_runtime_operation_gate.lock().await;
    validate_schedule_mutation_scope(&host_state, &request.workspace_id)?;
    let next_revision = request.expected_revision.saturating_add(1);
    delete_schedule(&state, &request)?;
    emit_schedule_changed(&app, &request.workspace_id, &request.id, next_revision);
    scheduler.wake_timed_schedules();
    Ok(())
}

#[tauri::command]
pub async fn orchestration_list_runs_v6(
    app: AppHandle,
    request: WorkspaceRequest,
) -> Result<Vec<RunSummary>, OrchestrationApiError> {
    orchestration_query(app, move |state, host_state| {
        orchestration_list_runs(state, host_state, &request)
    })
    .await
}

fn orchestration_list_runs(
    state: &OrchestrationApiState,
    host_state: &HostState,
    request: &WorkspaceRequest,
) -> Result<Vec<RunSummary>, OrchestrationApiError> {
    validate_workspace_scope(host_state, &request.workspace_id)?;
    validate_workspace_id(&request.workspace_id)?;
    let store = state.snapshot()?;
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
pub async fn orchestration_get_run_v6(
    app: AppHandle,
    request: RunRequest,
) -> Result<Option<Run>, OrchestrationApiError> {
    orchestration_query(app, move |state, host_state| {
        orchestration_get_run(state, host_state, &request)
    })
    .await
}

fn orchestration_get_run(
    state: &OrchestrationApiState,
    host_state: &HostState,
    request: &RunRequest,
) -> Result<Option<Run>, OrchestrationApiError> {
    validate_workspace_scope(host_state, &request.workspace_id)?;
    validate_workspace_id(&request.workspace_id)?;
    let store = state.snapshot()?;
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
        state.store.transact(|workspaces| {
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
    let run = Coordinator::new_run_with_inputs(request.run_id, snapshot, request.inputs)
        .map_err(|_| StoreError::Invalid)?;
    workspace.runs.push(run.clone());
    Ok(run)
}

fn schedule_run_request(
    workspace: &WorkspaceOrchestration,
    workspace_id: &str,
    schedule: &ScheduleDefinition,
    run_id: String,
) -> Result<StartRunRequest, StoreError> {
    let command = workspace
        .launch_commands
        .iter()
        .find(|command| command.value.id == schedule.launch_command_id)
        .map(|command| &command.value)
        .ok_or(StoreError::NotFound)?;
    Ok(StartRunRequest {
        workspace_id: workspace_id.to_owned(),
        run_id,
        team_id: command.team_id.clone(),
        pipeline_id: command.pipeline_id.clone(),
        launch_command_id: Some(command.id.clone()),
        inputs: schedule.inputs.clone(),
    })
}

fn store_error_code(error: &StoreError) -> &'static str {
    match error {
        StoreError::Conflict => "conflict",
        StoreError::AlreadyExists => "already-exists",
        StoreError::NotFound => "not-found",
        StoreError::Invalid => "invalid",
        StoreError::Denied => "denied",
        StoreError::Io(_) => "io",
    }
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

/// A running run with unleased ready work and nothing that crossed the native
/// boundary (no running, uncertain or leased task).
fn resumable_after_restart(run: &Run) -> bool {
    let has_ready = run
        .tasks()
        .iter()
        .any(|task| task.status() == TaskStatus::Ready && task.lease_id().is_none());
    let crossed_native_boundary = run.tasks().iter().any(|task| {
        matches!(task.status(), TaskStatus::Running | TaskStatus::Uncertain)
            || task.lease_id().is_some()
    });
    run.status() == RunStatus::Running && has_ready && !crossed_native_boundary
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
            .store
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
    let existing = T::values(workspace)
        .iter()
        .position(|stored| stored.value.id() == request.value.id());
    let previous = existing.map(|index| T::values(workspace)[index].clone());
    let saved = match (existing, request.expected_revision) {
        (None, None) => StoredDefinition {
            revision: 0,
            value: request.value,
        },
        (Some(index), Some(expected)) if T::values(workspace)[index].revision == expected => {
            StoredDefinition {
                revision: expected.checked_add(1).ok_or(StoreError::Invalid)?,
                value: request.value,
            }
        }
        _ => return Err(StoreError::Conflict),
    };
    match existing {
        Some(index) => T::values_mut(workspace)[index] = saved.clone(),
        None => T::values_mut(workspace).push(saved.clone()),
    }
    T::after_save(workspace, previous.as_ref(), &saved)?;
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
        .store
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
        let store = state.snapshot().unwrap();
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

    #[test]
    fn due_schedule_atomically_creates_one_run_and_skips_overlap() {
        let root = std::env::temp_dir().join(format!("piui-schedule-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, request()).unwrap();
        let anchor: DateTime<Utc> = "2026-09-09T10:00:00Z".parse().unwrap();
        let saved = save_schedule(
            &state,
            SaveScheduleRequest {
                workspace_id: "workspace".into(),
                expected_revision: None,
                value: ScheduleDefinition {
                    id: "schedule".into(),
                    name: "Every hour".into(),
                    launch_command_id: "command".into(),
                    trigger: crate::orchestration_schedule::ScheduleTrigger::Interval {
                        every: 1,
                        unit: crate::orchestration_schedule::IntervalUnit::Hours,
                        anchor_at: anchor,
                        time_zone: "UTC".into(),
                    },
                    missed_run_policy: MissedRunPolicy::Coalesce,
                    overlap_policy: OverlapPolicy::Skip,
                    inputs: BTreeMap::new(),
                },
            },
        )
        .unwrap();
        assert!(!saved.enabled);
        let enabled = set_schedule_enabled(
            &state,
            SetScheduleEnabledRequest {
                workspace_id: "workspace".into(),
                id: "schedule".into(),
                expected_revision: saved.revision,
                enabled: true,
            },
        )
        .unwrap();
        let first = state
            .claim_due_schedule(
                "workspace",
                "schedule",
                enabled.revision,
                anchor,
                anchor,
                None,
            )
            .unwrap();
        let run_id = first.run.as_ref().unwrap().id().to_owned();
        assert_eq!(
            first
                .schedule
                .last_occurrence
                .as_ref()
                .unwrap()
                .run_id
                .as_deref(),
            Some(run_id.as_str())
        );
        assert!(
            state
                .claim_due_schedule(
                    "workspace",
                    "schedule",
                    enabled.revision,
                    anchor,
                    anchor,
                    None,
                )
                .is_err()
        );

        let next = first.schedule.next_due_at.unwrap();
        let overlap = state
            .claim_due_schedule(
                "workspace",
                "schedule",
                first.schedule.revision,
                next,
                anchor,
                None,
            )
            .unwrap();
        assert!(overlap.run.is_none());
        assert_eq!(
            overlap.schedule.last_occurrence.unwrap().outcome,
            ScheduleOccurrenceOutcome::SkippedOverlap
        );
        drop(state);

        let reopened = OrchestrationApiState::open(&root).unwrap();
        assert_eq!(
            reopened.recoverable_runs().unwrap(),
            vec![("workspace".into(), run_id.clone())]
        );
        let store = reopened.snapshot().unwrap();
        let workspace = store.workspace("workspace").unwrap();
        assert_eq!(workspace.runs.len(), 1);
        assert_eq!(workspace.runs[0].id(), run_id);
        assert_eq!(workspace.schedules[0].occurrences.len(), 2);
        drop(store);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn start_manual_run(state: &OrchestrationApiState, run_id: &str) {
        state
            .create_run(StartRunRequest {
                workspace_id: "workspace".into(),
                run_id: run_id.into(),
                team_id: "team".into(),
                pipeline_id: "pipeline".into(),
                launch_command_id: None,
                inputs: BTreeMap::new(),
            })
            .expect("starts a manual run");
    }

    fn advance_run(
        state: &OrchestrationApiState,
        run_id: &str,
        advance: impl FnOnce(&mut Run) -> Result<(), CoordinatorError>,
    ) {
        state
            .store
            .transact(|workspaces| {
                let run = mutable_run(workspaces, "workspace", run_id)?;
                advance(run).map_err(|_| StoreError::Invalid)
            })
            .expect("advances the run");
    }

    #[test]
    fn manual_runs_resume_after_restart_unless_work_crossed_the_native_boundary() {
        let root =
            std::env::temp_dir().join(format!("piui-manual-resume-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, request()).unwrap();
        // Committed before the first task was leased (for example, the host
        // closed before scheduling): no native side effect exists yet.
        start_manual_run(&state, "manual-ready");
        // Leased, then interrupted before or while crossing the boundary.
        start_manual_run(&state, "manual-leased");
        advance_run(&state, "manual-leased", |run| {
            let revision = run.revision();
            Coordinator::lease_next_task(run, revision, "lease".into()).map(|_| ())
        });
        // Dispatched to a native session that the restart interrupted.
        start_manual_run(&state, "manual-running");
        advance_run(&state, "manual-running", |run| {
            let revision = run.revision();
            Coordinator::dispatch_next(
                run,
                revision,
                NativeExecutionReference {
                    id: "native-session".into(),
                },
            )
            .map(|_| ())
        });
        assert_eq!(
            state.recoverable_runs().unwrap(),
            vec![("workspace".into(), "manual-ready".into())]
        );
        drop(state);

        let reopened = OrchestrationApiState::open(&root).unwrap();
        assert_eq!(
            reopened.recoverable_runs().unwrap(),
            vec![("workspace".into(), "manual-ready".into())],
            "only the manual run that never crossed the boundary resumes"
        );
        for crossed in ["manual-leased", "manual-running"] {
            let run = reopened.get_run("workspace", crossed).unwrap().unwrap();
            assert_eq!(run.status(), RunStatus::Uncertain);
            assert!(
                run.tasks()
                    .iter()
                    .all(|task| task.status() == TaskStatus::Uncertain)
            );
        }
        let ready = reopened
            .get_run("workspace", "manual-ready")
            .unwrap()
            .unwrap();
        assert_eq!(ready.status(), RunStatus::Running);
        assert_eq!(ready.revision(), 0, "recovery itself changed nothing");
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launch_target_change_disables_schedule_until_explicit_reenable() {
        let root = std::env::temp_dir().join(format!(
            "piui-schedule-target-change-{}",
            uuid::Uuid::new_v4()
        ));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, request()).unwrap();
        let at: DateTime<Utc> = "2026-09-09T10:00:00Z".parse().unwrap();
        let saved = save_schedule(
            &state,
            SaveScheduleRequest {
                workspace_id: "workspace".into(),
                expected_revision: None,
                value: ScheduleDefinition {
                    id: "schedule".into(),
                    name: "Schedule".into(),
                    launch_command_id: "command".into(),
                    trigger: crate::orchestration_schedule::ScheduleTrigger::Once {
                        at,
                        time_zone: "UTC".into(),
                    },
                    missed_run_policy: MissedRunPolicy::Coalesce,
                    overlap_policy: OverlapPolicy::Skip,
                    inputs: BTreeMap::new(),
                },
            },
        )
        .unwrap();
        let enabled = set_schedule_enabled(
            &state,
            SetScheduleEnabledRequest {
                workspace_id: "workspace".into(),
                id: "schedule".into(),
                expected_revision: saved.revision,
                enabled: true,
            },
        )
        .unwrap();
        assert!(enabled.enabled);

        let mut second_pipeline = request().pipeline.value;
        second_pipeline.id = "pipeline-2".into();
        second_pipeline.name = "Second pipeline".into();
        save_definition(
            &state,
            SaveDefinitionRequest {
                workspace_id: "workspace".into(),
                expected_revision: None,
                value: second_pipeline,
            },
        )
        .unwrap();
        let mut retargeted_command = request().command.value;
        retargeted_command.pipeline_id = "pipeline-2".into();
        save_definition(
            &state,
            SaveDefinitionRequest {
                workspace_id: "workspace".into(),
                expected_revision: Some(0),
                value: retargeted_command,
            },
        )
        .unwrap();

        let store = state.snapshot().unwrap();
        let schedule = &store.workspace("workspace").unwrap().schedules[0];
        assert!(!schedule.enabled);
        assert_eq!(schedule.trigger_revision, 1);
        assert_eq!(schedule.enabled_launch_command_revision, None);
        assert_eq!(schedule.next_due_at, Some(at));
        drop(store);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missed_skip_and_admission_failure_advance_without_creating_runs() {
        let root =
            std::env::temp_dir().join(format!("piui-schedule-failure-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, request()).unwrap();
        let anchor: DateTime<Utc> = "2026-09-09T10:00:00Z".parse().unwrap();
        let saved = save_schedule(
            &state,
            SaveScheduleRequest {
                workspace_id: "workspace".into(),
                expected_revision: None,
                value: ScheduleDefinition {
                    id: "missed".into(),
                    name: "Skip missed".into(),
                    launch_command_id: "command".into(),
                    trigger: crate::orchestration_schedule::ScheduleTrigger::Interval {
                        every: 1,
                        unit: crate::orchestration_schedule::IntervalUnit::Hours,
                        anchor_at: anchor,
                        time_zone: "UTC".into(),
                    },
                    missed_run_policy: MissedRunPolicy::Skip,
                    overlap_policy: OverlapPolicy::Allow,
                    inputs: BTreeMap::new(),
                },
            },
        )
        .unwrap();
        let enabled = set_schedule_enabled(
            &state,
            SetScheduleEnabledRequest {
                workspace_id: "workspace".into(),
                id: "missed".into(),
                expected_revision: saved.revision,
                enabled: true,
            },
        )
        .unwrap();
        let now: DateTime<Utc> = "2026-09-09T12:30:00Z".parse().unwrap();
        let host_start: DateTime<Utc> = "2026-09-09T12:00:00Z".parse().unwrap();
        let missed = state
            .claim_due_schedule(
                "workspace",
                "missed",
                enabled.revision,
                now,
                host_start,
                None,
            )
            .unwrap();
        assert!(missed.run.is_none());
        assert_eq!(
            missed.schedule.last_occurrence.unwrap().outcome,
            ScheduleOccurrenceOutcome::SkippedMissed
        );
        assert_eq!(
            missed.schedule.next_due_at,
            Some("2026-09-09T13:00:00Z".parse().unwrap())
        );

        let due = missed.schedule.next_due_at.unwrap();
        let denied = state
            .claim_due_schedule(
                "workspace",
                "missed",
                missed.schedule.revision,
                due,
                host_start,
                Some("runtime-unavailable"),
            )
            .unwrap();
        assert!(denied.run.is_none());
        assert_eq!(
            denied
                .schedule
                .last_occurrence
                .as_ref()
                .unwrap()
                .failure_code
                .as_deref(),
            Some("runtime-unavailable")
        );
        assert!(
            state
                .snapshot()
                .unwrap()
                .workspace("workspace")
                .unwrap()
                .runs
                .is_empty()
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_schedule_claim_failure_keeps_due_occurrence_unclaimed() {
        let root =
            std::env::temp_dir().join(format!("piui-schedule-claim-io-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, request()).unwrap();
        let at: DateTime<Utc> = "2026-09-09T10:00:00Z".parse().unwrap();
        let saved = save_schedule(
            &state,
            SaveScheduleRequest {
                workspace_id: "workspace".into(),
                expected_revision: None,
                value: ScheduleDefinition {
                    id: "io-failure".into(),
                    name: "IO failure".into(),
                    launch_command_id: "command".into(),
                    trigger: crate::orchestration_schedule::ScheduleTrigger::Once {
                        at,
                        time_zone: "UTC".into(),
                    },
                    missed_run_policy: MissedRunPolicy::Coalesce,
                    overlap_policy: OverlapPolicy::Skip,
                    inputs: BTreeMap::new(),
                },
            },
        )
        .unwrap();
        let enabled = set_schedule_enabled(
            &state,
            SetScheduleEnabledRequest {
                workspace_id: "workspace".into(),
                id: "io-failure".into(),
                expected_revision: saved.revision,
                enabled: true,
            },
        )
        .unwrap();

        let journal = root.join("orchestration-v1");
        std::fs::remove_dir_all(&journal).unwrap();
        std::fs::write(&journal, b"blocks generation creation").unwrap();
        let error = match state.claim_due_schedule(
            "workspace",
            "io-failure",
            enabled.revision,
            at,
            at,
            None,
        ) {
            Ok(_) => panic!("the blocked journal unexpectedly accepted a schedule claim"),
            Err(error) => error,
        };
        assert_eq!(error.code, "io");
        let store = state.snapshot().unwrap();
        let workspace = store.workspace("workspace").unwrap();
        assert!(workspace.runs.is_empty());
        assert!(workspace.schedules[0].occurrences.is_empty());
        assert_eq!(workspace.schedules[0].revision, enabled.revision);
        assert_eq!(workspace.schedules[0].next_due_at, Some(at));
        drop(store);
        drop(state);
        std::fs::remove_file(journal).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod query_tests {
    use super::*;

    #[tokio::test]
    async fn read_queries_run_off_the_invoking_thread_and_keep_their_errors() {
        let root = std::env::temp_dir().join(format!("piui-query-{}", uuid::Uuid::new_v4()));
        let app_data = root.join("app-data");
        let host = std::sync::Arc::new(HostState::open(&app_data, false).expect("host state"));
        let workspace_id = host.personal_workspace.project_id.clone();
        let api = std::sync::Arc::new(OrchestrationApiState::open(&app_data).expect("state"));
        let invoking_thread = std::thread::current().id();
        let (runs, query_thread) = off_main_thread({
            let (api, host) = (std::sync::Arc::clone(&api), std::sync::Arc::clone(&host));
            let request = WorkspaceRequest { workspace_id };
            move || {
                Ok((
                    orchestration_list_runs(&api, &host, &request)?,
                    std::thread::current().id(),
                ))
            }
        })
        .await
        .expect("lists runs");
        assert!(runs.is_empty());
        assert_ne!(
            query_thread, invoking_thread,
            "store and filesystem work runs on the blocking pool"
        );
        let error = off_main_thread({
            let (api, host) = (std::sync::Arc::clone(&api), std::sync::Arc::clone(&host));
            let missing = WorkspaceRequest {
                workspace_id: "missing-workspace".into(),
            };
            move || orchestration_catalog(&api, &host, &missing)
        })
        .await
        .expect_err("unknown workspace is rejected");
        assert_eq!(error.code, "not-found");
        drop((api, host));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn run_reads_are_served_while_a_writer_holds_the_journal() {
        let root = std::env::temp_dir().join(format!("piui-query-read-{}", uuid::Uuid::new_v4()));
        let state = std::sync::Arc::new(OrchestrationApiState::open(&root).expect("state"));
        state
            .store
            .transact(|workspaces| {
                workspaces.push(WorkspaceOrchestration::empty("workspace".into()));
                Ok(())
            })
            .expect("baseline");
        let (entered, writer_inside) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let writer = std::thread::spawn({
            let state = std::sync::Arc::clone(&state);
            move || {
                state.store.transact(|_| {
                    entered.send(()).expect("signals");
                    released.recv().expect("released");
                    Ok(())
                })
            }
        });
        writer_inside.recv().expect("writer inside the journal");
        assert!(
            state
                .get_run("workspace", "absent")
                .expect("read is not blocked")
                .is_none()
        );
        assert!(state.next_schedule_due().expect("read").is_none());
        release.send(()).expect("releases");
        writer.join().expect("writer").expect("commits");
        drop(state);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod run_input_tests {
    use super::*;
    use serde_json::json;

    /// A one-agent system whose pipeline asks for a required task and an
    /// optional choice with a default.
    fn system() -> SaveGraphRequest {
        serde_json::from_value(json!({
            "workspaceId": "workspace",
            "profiles": [{"workspaceId": "workspace", "value": {"id": "agent", "name": "Agent", "harness": "codex", "model": "model", "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}}],
            "team": {"workspaceId": "workspace", "value": {"id": "team", "name": "System", "members": [{"id": "node", "profileId": "agent"}], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "node"}},
            "pipeline": {"workspaceId": "workspace", "value": {"id": "pipeline", "name": "System",
                "steps": [{"id": "node", "name": "Task", "assignedMemberId": "node", "instructions": "Work on {{input.task}}.", "dependencyStepIds": []}],
                "inputs": [
                    {"name": "task", "label": "What should be reviewed?", "kind": "long-text", "required": true},
                    {"name": "depth", "label": "Depth", "kind": "choice", "options": ["quick", "deep"], "defaultValue": "quick"}
                ]}},
            "command": {"workspaceId": "workspace", "value": {"id": "command", "name": "System", "teamId": "team", "pipelineId": "pipeline"}}
        }))
        .expect("valid fixture")
    }

    fn values(value: serde_json::Value) -> BTreeMap<String, serde_json::Value> {
        serde_json::from_value(value).expect("input map")
    }

    fn start(
        state: &OrchestrationApiState,
        run_id: &str,
        inputs: serde_json::Value,
    ) -> Result<Run, OrchestrationApiError> {
        state.create_run(StartRunRequest {
            workspace_id: "workspace".into(),
            run_id: run_id.into(),
            team_id: "team".into(),
            pipeline_id: "pipeline".into(),
            launch_command_id: Some("command".into()),
            inputs: values(inputs),
        })
    }

    fn schedule(inputs: serde_json::Value) -> ScheduleDefinition {
        ScheduleDefinition {
            id: "schedule".into(),
            name: "Nightly".into(),
            launch_command_id: "command".into(),
            trigger: crate::orchestration_schedule::ScheduleTrigger::Once {
                at: "2026-09-09T10:00:00Z".parse().expect("instant"),
                time_zone: "UTC".into(),
            },
            missed_run_policy: MissedRunPolicy::Coalesce,
            overlap_policy: OverlapPolicy::Skip,
            inputs: values(inputs),
        }
    }

    fn save(
        state: &OrchestrationApiState,
        expected_revision: Option<u64>,
        value: ScheduleDefinition,
    ) -> Result<ScheduleSnapshot, OrchestrationApiError> {
        save_schedule(
            state,
            SaveScheduleRequest {
                workspace_id: "workspace".into(),
                expected_revision,
                value,
            },
        )
    }

    fn enable(
        state: &OrchestrationApiState,
        expected_revision: u64,
    ) -> Result<ScheduleSnapshot, OrchestrationApiError> {
        set_schedule_enabled(
            state,
            SetScheduleEnabledRequest {
                workspace_id: "workspace".into(),
                id: "schedule".into(),
                expected_revision,
                enabled: true,
            },
        )
    }

    fn resolved(
        state: &OrchestrationApiState,
        value: &ScheduleDefinition,
    ) -> Result<BTreeMap<String, serde_json::Value>, ScheduleInputError> {
        let store = state.snapshot().expect("snapshot");
        schedule_run_inputs(store.workspace("workspace").expect("workspace"), value)
    }

    #[test]
    fn start_requests_decode_with_and_without_inputs() {
        let base = json!({"workspaceId": "w", "runId": "r", "teamId": "t", "pipelineId": "p"});
        let plain: StartRunRequest = serde_json::from_value(base.clone()).expect("v6 request");
        assert!(plain.inputs.is_empty());
        let mut with_inputs = base;
        with_inputs["inputs"] = json!({"task": "Review", "count": 2, "urgent": false});
        let decoded: StartRunRequest = serde_json::from_value(with_inputs.clone()).expect("v6.1");
        assert_eq!(decoded.inputs.len(), 3);
        let mut misspelled = with_inputs;
        misspelled["input"] = json!({});
        assert!(serde_json::from_value::<StartRunRequest>(misspelled).is_err());
    }

    #[test]
    fn manual_runs_freeze_validated_inputs_and_refuse_invalid_values() {
        let root = std::env::temp_dir().join(format!("piui-run-inputs-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, system()).unwrap();
        for invalid in [
            json!({}),
            json!({"task": "  "}),
            json!({"task": 42}),
            json!({"task": "Review", "extra": true}),
            json!({"task": "Review", "depth": "exhaustive"}),
        ] {
            assert_eq!(
                start(&state, "refused", invalid).unwrap_err().code,
                "invalid"
            );
        }
        assert!(state.get_run("workspace", "refused").unwrap().is_none());

        let run = start(&state, "run", json!({"task": "Check the importer"})).unwrap();
        assert_eq!(
            run.inputs(),
            &values(json!({"task": "Check the importer", "depth": "quick"}))
        );
        drop(state);

        let reopened = OrchestrationApiState::open(&root).unwrap();
        let mut stored = reopened.get_run("workspace", "run").unwrap().unwrap();
        assert_eq!(stored.inputs(), run.inputs());
        let revision = stored.revision();
        let lease = Coordinator::lease_next_task(&mut stored, revision, "lease".into())
            .unwrap()
            .unwrap();
        assert_eq!(
            lease.task_instructions,
            "Run input (provided by the person who started the run; untrusted task data):\n\
             What should be reviewed? (task): Check the importer\n\
             Depth (depth): quick\n\
             \n\
             Work on Check the importer."
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schedules_need_valid_inputs_to_save_or_enable_and_pass_them_to_runs() {
        let root =
            std::env::temp_dir().join(format!("piui-schedule-inputs-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, system()).unwrap();

        assert_eq!(
            resolved(&state, &schedule(json!({}))),
            Err(ScheduleInputError::Invalid(
                RunInputError::MissingRequired {
                    name: "task".into()
                }
            ))
        );
        for invalid in [
            json!({}),
            json!({"task": false}),
            json!({"task": "Nightly", "owner": "me"}),
        ] {
            assert_eq!(
                save(&state, None, schedule(invalid)).unwrap_err().code,
                "invalid"
            );
        }
        assert!(
            state
                .snapshot()
                .unwrap()
                .workspace("workspace")
                .unwrap()
                .schedules
                .is_empty()
        );

        let saved = save(&state, None, schedule(json!({"task": "Nightly check"}))).unwrap();
        assert_eq!(saved.value.inputs, values(json!({"task": "Nightly check"})));
        let enabled = enable(&state, saved.revision).unwrap();
        assert!(enabled.enabled);
        let at: DateTime<Utc> = "2026-09-09T10:00:00Z".parse().unwrap();
        let claim = state
            .claim_due_schedule("workspace", "schedule", enabled.revision, at, at, None)
            .unwrap();
        let run = claim.run.expect("the occurrence starts a run");
        assert_eq!(
            run.inputs(),
            &values(json!({"task": "Nightly check", "depth": "quick"}))
        );

        // Changing the values changes the execution: the schedule needs a new
        // explicit enable, which rechecks the pipeline's current declarations.
        let edited = save(
            &state,
            Some(claim.schedule.revision),
            schedule(json!({"task": "Weekly check", "depth": "deep"})),
        )
        .unwrap();
        assert!(!edited.enabled);
        assert_eq!(edited.trigger_revision, claim.schedule.trigger_revision + 1);
        let mut pipeline = system().pipeline.value;
        pipeline.inputs.push(
            serde_json::from_value(
                json!({"name": "owner", "label": "Owner", "kind": "text", "required": true}),
            )
            .unwrap(),
        );
        save_definition(
            &state,
            SaveDefinitionRequest {
                workspace_id: "workspace".into(),
                expected_revision: Some(0),
                value: pipeline,
            },
        )
        .unwrap();
        assert_eq!(enable(&state, edited.revision).unwrap_err().code, "invalid");
        assert_eq!(
            resolved(&state, &edited.value),
            Err(ScheduleInputError::Invalid(
                RunInputError::MissingRequired {
                    name: "owner".into()
                }
            ))
        );
        let store = state.snapshot().unwrap();
        let stored = &store.workspace("workspace").unwrap().schedules[0];
        assert!(!stored.enabled);
        assert_eq!(stored.revision, edited.revision);
        drop(store);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pipeline_saves_reject_invalid_declarations_and_review_limits() {
        let root =
            std::env::temp_dir().join(format!("piui-pipeline-inputs-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).unwrap();
        save_graph(&state, system()).unwrap();
        let save_pipeline = |value: PipelineDefinition| {
            save_definition(
                &state,
                SaveDefinitionRequest {
                    workspace_id: "workspace".into(),
                    expected_revision: Some(0),
                    value,
                },
            )
        };
        let mut misnamed = system().pipeline.value;
        misnamed.inputs[0].name = "Task".into();
        assert_eq!(save_pipeline(misnamed).unwrap_err().code, "invalid");
        let mut unbounded = system().pipeline.value;
        unbounded.steps[0].result_fields = vec![piui_orchestration::ResultField {
            name: "ok".into(),
            kind: piui_orchestration::ResultFieldKind::Boolean,
        }];
        unbounded.steps[0].review = Some(piui_orchestration::ReviewRule {
            field: "ok".into(),
            retry_from_step_id: "node".into(),
            max_iterations: Some(0),
        });
        assert_eq!(save_pipeline(unbounded).unwrap_err().code, "invalid");
        let store = state.snapshot().unwrap();
        let stored = &store.workspace("workspace").unwrap().pipelines[0];
        assert_eq!(stored.revision, 0);
        assert_eq!(stored.value, system().pipeline.value);
        drop(store);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
