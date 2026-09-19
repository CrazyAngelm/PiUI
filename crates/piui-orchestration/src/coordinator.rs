use std::collections::BTreeSet;

use serde_json::{Value, json};
use thiserror::Error;

use crate::flow::{advance_conditions, program_router_selection};
use crate::{
    AgentRequestKind, AgentRequestRecord, AuthenticatedSender, AuthorizationError, CancelRequest,
    CompletionOutcome, ControlledSpawnLease, DefinitionError, FailureRecord, LaunchRequest,
    MessageIntent, MessageRecord, MessageStatus, NativeExecutionReference,
    ORCHESTRATION_SCHEMA_VERSION, Revision, Run, RunDefinitionSnapshot, RunStatus, TaskRecord,
    TaskStatus, UncertainResolution, UncertaintyIdentity, authorize_send, authorize_spawn,
    validate_definition, validate_history_reference,
};

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum CoordinatorError {
    #[error(transparent)]
    InvalidDefinition(#[from] DefinitionError),
    #[error(transparent)]
    Authorization(#[from] AuthorizationError),
    #[error("{scope} revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict {
        scope: &'static str,
        expected: Revision,
        actual: Revision,
    },
    #[error("new task admissions are paused")]
    RunPaused,
    #[error("unknown task: {step_id}")]
    UnknownTask { step_id: String },
    #[error("unknown message: {message_id}")]
    UnknownMessage { message_id: String },
    #[error("duplicate message: {message_id}")]
    DuplicateMessage { message_id: String },
    #[error("agent request identifier was reused with different authority or input: {request_id}")]
    AgentRequestConflict { request_id: String },
    #[error("task {step_id} is {actual:?}, expected {expected:?}")]
    InvalidTaskStatus {
        step_id: String,
        expected: TaskStatus,
        actual: TaskStatus,
    },
    #[error("message {message_id} is {actual:?}, expected {expected:?}")]
    InvalidMessageStatus {
        message_id: String,
        expected: MessageStatus,
        actual: MessageStatus,
    },
    #[error("run is {status:?} and cannot accept this transition")]
    RunNotActive { status: RunStatus },
    #[error("stale native result for task {step_id}")]
    StaleExecution { step_id: String },
    #[error("task {step_id} has unresolved dependencies")]
    DependenciesNotReady { step_id: String },
    #[error("task {step_id} is reserved by another request")]
    LeaseConflict { step_id: String },
    #[error("{kind} identifier must not be empty")]
    EmptyId { kind: &'static str },
    #[error("run data is inconsistent: {reason}")]
    InvalidRunData { reason: &'static str },
}

#[derive(Debug, Error)]
pub enum RunDataError {
    #[error("could not serialize run data: {0}")]
    Serialize(serde_json::Error),
    #[error("could not deserialize run data: {0}")]
    Deserialize(serde_json::Error),
    #[error(transparent)]
    Invalid(#[from] CoordinatorError),
}

/// Pure domain coordinator. Native adapters consume `LaunchRequest` and
/// `CancelRequest`, then report completion with the captured revisions.
pub struct Coordinator;

impl Coordinator {
    /// Materializes coordinator-owned steps (currently program routers) before
    /// a host chooses a native profile. These steps never produce a launch.
    pub fn advance_automatic_steps(run: &mut Run) {
        advance_program_routers(run);
    }

    pub fn new_run(
        run_id: impl Into<String>,
        definition: RunDefinitionSnapshot,
    ) -> Result<Run, CoordinatorError> {
        validate_definition(&definition)?;
        let run_id = run_id.into();
        if run_id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "run" });
        }
        let tasks = definition
            .pipeline
            .steps
            .iter()
            .map(|step| TaskRecord {
                result_data: None,
                step_id: step.id.clone(),
                status: TaskStatus::Ready,
                revision: 0,
                lease_id: None,
                execution: None,
                result_reference: None,
                failure: None,
            })
            .collect();
        Ok(Run {
            paused: false,
            attempts: Vec::new(),
            schema_version: ORCHESTRATION_SCHEMA_VERSION,
            id: run_id,
            definition,
            initial_definition: None,
            status: RunStatus::Running,
            revision: 0,
            tasks,
            messages: Vec::new(),
            agent_requests: Vec::new(),
        })
    }

    /// Returns eligible tasks in lexical step-id order. Ordering does not
    /// depend on hash iteration or completion timing.
    pub fn ready_task_ids(run: &Run) -> Vec<&str> {
        if run.status != RunStatus::Running || run.paused {
            return Vec::new();
        }
        let mut ready: Vec<&str> = run
            .tasks
            .iter()
            .filter(|task| {
                task.status == TaskStatus::Ready
                    && task.lease_id.is_none()
                    && !callable_template(run, &task.step_id)
                    && dependencies_succeeded(run, &task.step_id)
                    && run
                        .definition
                        .pipeline
                        .steps
                        .iter()
                        .find(|step| step.id == task.step_id)
                        .is_some_and(|step| {
                            !step
                                .router
                                .as_ref()
                                .is_some_and(|router| router.mode == crate::RouterMode::Program)
                                && step.condition.as_ref().is_none_or(|condition| {
                                    run.tasks
                                        .iter()
                                        .find(|source| source.step_id == condition.source_step_id)
                                        .and_then(|source| source.result_data.as_ref())
                                        .and_then(|data| data.get(&condition.field))
                                        == Some(&condition.equals)
                                })
                                && route_gate_satisfied(run, step)
                        })
            })
            .map(|task| task.step_id.as_str())
            .collect();
        ready.sort_unstable();
        ready
    }

    /// Durably leases the next deterministic ready task before any native
    /// side effect. A restored lease becomes uncertain rather than replayable.
    pub fn lease_next_task(
        run: &mut Run,
        expected_run_revision: Revision,
        lease_id: String,
    ) -> Result<Option<ControlledSpawnLease>, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        if lease_id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "lease" });
        }
        advance_program_routers(run);
        let Some(step_id) = Self::ready_task_ids(run).first().map(|id| (*id).to_owned()) else {
            return Ok(None);
        };
        let Some(step) = run
            .definition
            .pipeline
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .cloned()
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "task has no pipeline step",
            });
        };
        let Some(member) = run
            .definition
            .team
            .members
            .iter()
            .find(|member| member.id == step.assigned_member_id)
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "step has no assigned member",
            });
        };
        let Some(profile) = run
            .definition
            .profiles
            .iter()
            .find(|profile| profile.id == member.profile_id)
            .cloned()
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "member has no profile",
            });
        };
        let task_instructions = task_instructions(run, &step);
        let dependency_result_references = dependency_result_references(run, &step);
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "pipeline step has no task",
            });
        };
        task.lease_id = Some(lease_id.clone());
        task.revision += 1;
        run.revision += 1;
        Ok(Some(ControlledSpawnLease {
            run_id: run.id.clone(),
            run_revision: run.revision,
            task_revision: task.revision,
            lease_id,
            step_id: step.id,
            member_id: member.id.clone(),
            profile,
            task_instructions,
            dependency_result_references,
        }))
    }

    /// Add one independent agent from an explicitly allowed snapshotted profile.
    /// The request id is its durable identity; profile policies are never authored
    /// by the model. Parent/child delivery is bidirectional; team-wide delivery
    /// requires the launch snapshot's explicit spawned_agents_join_team grant.
    pub fn add_spawned_agent(
        run: &mut Run,
        actor_member_id: &str,
        request_id: &str,
        profile_id: &str,
        name: &str,
        instructions: &str,
    ) -> Result<String, CoordinatorError> {
        ensure_active(run)?;
        if run.paused {
            return Err(CoordinatorError::RunPaused);
        }
        let actor = run
            .definition
            .team
            .members
            .iter()
            .find(|m| m.id == actor_member_id)
            .ok_or_else(|| AuthorizationError::UnknownMember {
                member_id: actor_member_id.into(),
            })?;
        authorize_spawn(&run.definition, &actor.profile_id, profile_id)?;
        if name.trim().is_empty() || instructions.trim().is_empty() || request_id.trim().is_empty()
        {
            return Err(CoordinatorError::EmptyId { kind: "agent task" });
        }
        let id = format!("agent-{request_id}");
        if run.definition.pipeline.steps.iter().any(|s| s.id == id) {
            return Err(CoordinatorError::AgentRequestConflict {
                request_id: request_id.into(),
            });
        }
        let mut definition = run.definition.clone();
        let recipients = if definition.team.spawned_agents_join_team {
            definition
                .team
                .members
                .iter()
                .map(|member| member.id.clone())
                .collect::<Vec<_>>()
        } else {
            vec![actor_member_id.to_owned()]
        };
        definition.team.members.push(crate::TeamMember {
            id: id.clone(),
            profile_id: profile_id.into(),
        });
        for recipient in recipients {
            for (from, to) in [
                (recipient.as_str(), id.as_str()),
                (id.as_str(), recipient.as_str()),
            ] {
                // Joining the team cannot create a route the parent did not
                // possess. Parent/child return communication is intrinsic.
                let inherited = recipient == actor_member_id
                    || if from == id {
                        crate::authorize_send(&run.definition.team, actor_member_id, &recipient)
                            .is_ok()
                    } else {
                        crate::authorize_send(&run.definition.team, &recipient, actor_member_id)
                            .is_ok()
                    };
                if inherited {
                    definition.team.send_edges.push(crate::DirectedEdge {
                        from_member_id: from.into(),
                        to_member_id: to.into(),
                    });
                }
            }
        }
        definition.team.observe_edges.push(crate::DirectedEdge {
            from_member_id: actor_member_id.into(),
            to_member_id: id.clone(),
        });
        let input_instructions = definition.pipeline.steps.iter().find_map(|step| {
            definition
                .team
                .members
                .iter()
                .find(|member| {
                    member.id == step.assigned_member_id && member.profile_id == profile_id
                })
                .and(step.input_instructions.clone())
        });
        let result_fields = definition
            .pipeline
            .steps
            .iter()
            .find(|step| {
                definition.team.members.iter().any(|member| {
                    member.id == step.assigned_member_id && member.profile_id == profile_id
                })
            })
            .map(|step| step.result_fields.clone())
            .unwrap_or_default();
        let require_approval = definition.pipeline.steps.iter().any(|step| {
            step.require_approval
                && definition.team.members.iter().any(|member| {
                    member.id == step.assigned_member_id && member.profile_id == profile_id
                })
        });
        definition.pipeline.steps.push(crate::PipelineStep {
            input_bindings: Vec::new(),
            condition: None,
            route_gates: Vec::new(),
            router: None,
            review: None,
            require_approval,
            result_fields,
            execution_mode: None,
            input_instructions,
            id: id.clone(),
            name: name.into(),
            assigned_member_id: id.clone(),
            instructions: instructions.into(),
            dependency_step_ids: Vec::new(),
        });
        validate_definition(&definition)?;
        if run.initial_definition.is_none() {
            run.initial_definition = Some(run.definition.clone());
        }
        run.definition = definition;
        run.tasks.push(TaskRecord {
            result_data: None,
            step_id: id.clone(),
            status: TaskStatus::Ready,
            revision: 0,
            lease_id: None,
            execution: None,
            result_reference: None,
            failure: None,
        });
        run.revision += 1;
        Ok(id)
    }

    /// Reserves one predefined ready DAG step for an authenticated controlled
    /// spawn. The caller profile must authorize the step's exact snapshotted
    /// profile; no profile/member/policy override is accepted.
    pub fn lease_controlled_spawn(
        run: &mut Run,
        expected_run_revision: Revision,
        actor_member_id: &str,
        step_id: &str,
        lease_id: String,
    ) -> Result<ControlledSpawnLease, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        if run.paused {
            return Err(CoordinatorError::RunPaused);
        }
        if lease_id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "lease" });
        }
        let Some(actor) = run
            .definition
            .team
            .members
            .iter()
            .find(|member| member.id == actor_member_id)
        else {
            return Err(AuthorizationError::UnknownMember {
                member_id: actor_member_id.to_owned(),
            }
            .into());
        };
        let Some(step) = run
            .definition
            .pipeline
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .cloned()
        else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        let Some(target_member) = run
            .definition
            .team
            .members
            .iter()
            .find(|member| member.id == step.assigned_member_id)
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "step has no assigned member",
            });
        };
        let profile = authorize_spawn(
            &run.definition,
            &actor.profile_id,
            &target_member.profile_id,
        )?
        .clone();
        let Some(index) = run.tasks.iter().position(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "pipeline step has no task",
            });
        };
        if run.tasks[index].status != TaskStatus::Ready {
            return Err(CoordinatorError::InvalidTaskStatus {
                step_id: step_id.to_owned(),
                expected: TaskStatus::Ready,
                actual: run.tasks[index].status,
            });
        }
        if let Some(existing_lease_id) = run.tasks[index].lease_id.as_deref() {
            if existing_lease_id == lease_id {
                let task_instructions = task_instructions(run, &step);
                let dependency_result_references = dependency_result_references(run, &step);
                return Ok(ControlledSpawnLease {
                    run_id: run.id.clone(),
                    run_revision: run.revision,
                    task_revision: run.tasks[index].revision,
                    lease_id,
                    step_id: step.id,
                    member_id: target_member.id.clone(),
                    profile,
                    task_instructions,
                    dependency_result_references,
                });
            }
            return Err(CoordinatorError::LeaseConflict {
                step_id: step_id.to_owned(),
            });
        }
        if !dependencies_succeeded(run, step_id) {
            return Err(CoordinatorError::DependenciesNotReady {
                step_id: step_id.to_owned(),
            });
        }
        let task_instructions = task_instructions(run, &step);
        let dependency_result_references = dependency_result_references(run, &step);
        run.tasks[index].lease_id = Some(lease_id.clone());
        run.tasks[index].revision += 1;
        run.revision += 1;
        Ok(ControlledSpawnLease {
            run_id: run.id.clone(),
            run_revision: run.revision,
            task_revision: run.tasks[index].revision,
            lease_id,
            step_id: step.id,
            member_id: target_member.id.clone(),
            profile,
            task_instructions,
            dependency_result_references,
        })
    }

    /// Commits an admitted controlled spawn after `WorkspaceHost` has assigned
    /// its safe workspace session id. The lease prevents normal dispatch.
    pub fn dispatch_leased_task(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        lease_id: &str,
        execution: NativeExecutionReference,
    ) -> Result<LaunchRequest, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        if execution.id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "execution" });
        }
        let Some(index) = run.tasks.iter().position(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        check_revision("task", expected_task_revision, run.tasks[index].revision)?;
        if run.tasks[index].status != TaskStatus::Ready {
            return Err(CoordinatorError::InvalidTaskStatus {
                step_id: step_id.to_owned(),
                expected: TaskStatus::Ready,
                actual: run.tasks[index].status,
            });
        }
        if run.tasks[index].lease_id.as_deref() != Some(lease_id) {
            return Err(CoordinatorError::LeaseConflict {
                step_id: step_id.to_owned(),
            });
        }
        let Some(step) = run
            .definition
            .pipeline
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .cloned()
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "task has no pipeline step",
            });
        };
        let Some(member) = run
            .definition
            .team
            .members
            .iter()
            .find(|member| member.id == step.assigned_member_id)
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "step has no assigned member",
            });
        };
        let Some(profile) = run
            .definition
            .profiles
            .iter()
            .find(|profile| profile.id == member.profile_id)
            .cloned()
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "member has no profile",
            });
        };
        let task_instructions = task_instructions(run, &step);
        let dependency_result_references = dependency_result_references(run, &step);
        run.tasks[index].status = TaskStatus::Running;
        run.tasks[index].lease_id = None;
        run.tasks[index].execution = Some(execution.clone());
        run.tasks[index].revision += 1;
        run.revision += 1;
        Ok(LaunchRequest {
            run_id: run.id.clone(),
            run_revision: run.revision,
            task_revision: run.tasks[index].revision,
            step_id: step.id,
            member_id: member.id.clone(),
            profile,
            task_instructions,
            dependency_result_references,
            execution,
        })
    }

    pub fn release_task_lease(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        lease_id: &str,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        check_revision("task", expected_task_revision, task.revision)?;
        if task.status != TaskStatus::Ready || task.lease_id.as_deref() != Some(lease_id) {
            return Err(CoordinatorError::LeaseConflict {
                step_id: step_id.to_owned(),
            });
        }
        task.lease_id = None;
        task.revision += 1;
        run.revision += 1;
        Ok(())
    }

    /// Atomically reserves the next deterministic task and binds the opaque
    /// native execution identity supplied by the trusted adapter.
    pub fn dispatch_next(
        run: &mut Run,
        expected_run_revision: Revision,
        execution: NativeExecutionReference,
    ) -> Result<Option<LaunchRequest>, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        if execution.id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "execution" });
        }
        advance_program_routers(run);
        let Some(step_id) = Self::ready_task_ids(run).first().map(|id| (*id).to_owned()) else {
            return Ok(None);
        };
        let Some(step) = run
            .definition
            .pipeline
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .cloned()
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "task has no pipeline step",
            });
        };
        let Some(member) = run
            .definition
            .team
            .members
            .iter()
            .find(|member| member.id == step.assigned_member_id)
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "step has no assigned member",
            });
        };
        let Some(profile) = run
            .definition
            .profiles
            .iter()
            .find(|profile| profile.id == member.profile_id)
            .cloned()
        else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "member has no profile",
            });
        };
        let task_instructions = task_instructions(run, &step);
        let dependency_result_references = dependency_result_references(run, &step);
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "pipeline step has no task",
            });
        };
        task.status = TaskStatus::Running;
        task.lease_id = None;
        task.execution = Some(execution.clone());
        task.revision += 1;
        run.revision += 1;
        Ok(Some(LaunchRequest {
            run_id: run.id.clone(),
            run_revision: run.revision,
            task_revision: task.revision,
            step_id,
            member_id: member.id.clone(),
            profile,
            task_instructions,
            dependency_result_references,
            execution,
        }))
    }

    pub fn complete_task(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        execution_id: &str,
        outcome: CompletionOutcome,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        let Some(index) = run.tasks.iter().position(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        check_revision("task", expected_task_revision, run.tasks[index].revision)?;
        if run.tasks[index].status != TaskStatus::Running {
            return Err(CoordinatorError::InvalidTaskStatus {
                step_id: step_id.to_owned(),
                expected: TaskStatus::Running,
                actual: run.tasks[index].status,
            });
        }
        if run.tasks[index]
            .execution
            .as_ref()
            .map(|value| value.id.as_str())
            != Some(execution_id)
        {
            return Err(CoordinatorError::StaleExecution {
                step_id: step_id.to_owned(),
            });
        }
        if let CompletionOutcome::Succeeded {
            result_reference: Some(reference),
        } = &outcome
        {
            validate_history_reference(reference)?;
        }
        let failed = matches!(outcome, CompletionOutcome::Failed { .. });
        match outcome {
            CompletionOutcome::Succeeded { result_reference } => {
                run.tasks[index].status = TaskStatus::Succeeded;
                run.tasks[index].result_reference = result_reference;
            }
            CompletionOutcome::Failed { failure } => {
                run.tasks[index].status = TaskStatus::Failed;
                run.tasks[index].failure = Some(failure);
            }
        }
        run.tasks[index].revision += 1;
        if failed {
            // Fail-fast for work that has not crossed the native boundary.
            for task in &mut run.tasks {
                if task.status == TaskStatus::Ready {
                    task.status = TaskStatus::Cancelled;
                    task.revision += 1;
                }
            }
        }
        run.revision += 1;
        refresh_status(run);
        Ok(())
    }

    /// Records a prelaunch policy/capability rejection. No native execution
    /// exists, so this transition is a certain failure rather than uncertain.
    pub fn reject_ready_task(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        failure: FailureRecord,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        let Some(index) = run.tasks.iter().position(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        check_revision("task", expected_task_revision, run.tasks[index].revision)?;
        if run.tasks[index].status != TaskStatus::Ready || run.tasks[index].lease_id.is_some() {
            return Err(CoordinatorError::InvalidTaskStatus {
                step_id: step_id.to_owned(),
                expected: TaskStatus::Ready,
                actual: run.tasks[index].status,
            });
        }
        run.tasks[index].status = TaskStatus::Failed;
        run.tasks[index].failure = Some(failure);
        run.tasks[index].revision += 1;
        for task in &mut run.tasks {
            if task.status == TaskStatus::Ready {
                task.status = TaskStatus::Cancelled;
                task.revision += 1;
            }
        }
        run.revision += 1;
        refresh_status(run);
        Ok(())
    }

    pub fn cancellation_requests(
        run: &Run,
        expected_run_revision: Revision,
    ) -> Result<Vec<CancelRequest>, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        let mut requests: Vec<_> = run
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Running)
            .filter_map(|task| {
                task.execution.clone().map(|execution| CancelRequest {
                    run_id: run.id.clone(),
                    step_id: task.step_id.clone(),
                    execution,
                })
            })
            .collect();
        requests.sort_by(|left, right| left.step_id.cmp(&right.step_id));
        Ok(requests)
    }

    pub fn mark_task_uncertain(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        identity: &UncertaintyIdentity,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        check_revision("task", expected_task_revision, task.revision)?;
        let matches_identity = match identity {
            UncertaintyIdentity::Execution(id) => {
                task.status == TaskStatus::Running
                    && task.execution.as_ref().is_some_and(|value| value.id == *id)
            }
            UncertaintyIdentity::Lease(id) => {
                task.status == TaskStatus::Ready && task.lease_id.as_deref() == Some(id)
            }
        };
        if !matches_identity {
            return Err(CoordinatorError::StaleExecution {
                step_id: step_id.to_owned(),
            });
        }
        task.status = TaskStatus::Uncertain;
        task.lease_id = None;
        task.revision += 1;
        run.revision += 1;
        run.status = RunStatus::Uncertain;
        Ok(())
    }

    /// Cancels all work that has not completed and returns native executions
    /// that the application layer must stop through its typed runtime adapter.
    pub fn cancel_run(
        run: &mut Run,
        expected_run_revision: Revision,
    ) -> Result<Vec<CancelRequest>, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        let mut requests = Vec::new();
        for task in &mut run.tasks {
            if task.status == TaskStatus::Running {
                if let Some(execution) = task.execution.clone() {
                    requests.push(CancelRequest {
                        run_id: run.id.clone(),
                        step_id: task.step_id.clone(),
                        execution,
                    });
                }
                task.status = TaskStatus::Cancelled;
                task.revision += 1;
            } else if matches!(
                task.status,
                TaskStatus::Ready | TaskStatus::AwaitingApproval
            ) {
                task.lease_id = None;
                task.status = TaskStatus::Cancelled;
                task.revision += 1;
            }
        }
        requests.sort_by(|left, right| left.step_id.cmp(&right.step_id));
        run.status = RunStatus::Cancelled;
        run.revision += 1;
        Ok(requests)
    }

    /// Recovery transition for durable state loaded after host interruption.
    /// Running executions become uncertain and are never made ready again.
    pub fn restore(run: &mut Run, expected_run_revision: Revision) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        let mut changed = false;
        for task in &mut run.tasks {
            if task.status == TaskStatus::Running
                || (task.status == TaskStatus::Ready && task.lease_id.is_some())
            {
                task.status = TaskStatus::Uncertain;
                task.lease_id = None;
                task.revision += 1;
                changed = true;
            }
        }
        if changed {
            run.status = RunStatus::Uncertain;
            run.revision += 1;
        }
        Ok(())
    }

    /// Resolves uncertain native side effects after a user or adapter has
    /// reconciled the native history. This never launches work.
    pub fn reconcile_uncertain_task(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        resolution: UncertainResolution,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        let Some(index) = run.tasks.iter().position(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        check_revision("task", expected_task_revision, run.tasks[index].revision)?;
        if run.tasks[index].status != TaskStatus::Uncertain {
            return Err(CoordinatorError::InvalidTaskStatus {
                step_id: step_id.to_owned(),
                expected: TaskStatus::Uncertain,
                actual: run.tasks[index].status,
            });
        }
        if let UncertainResolution::Succeeded {
            result_reference: Some(reference),
        } = &resolution
        {
            validate_history_reference(reference)?;
        }
        if matches!(resolution, UncertainResolution::Succeeded { .. })
            && run.definition.pipeline.steps.iter().any(|step| {
                step.id == step_id
                    && (!step.result_fields.is_empty()
                        || step.require_approval
                        || step.review.is_some())
            })
        {
            return Err(CoordinatorError::InvalidRunData {
                reason: "structured results require native validation; reconcile as failed or cancelled before an explicit repeat",
            });
        }
        let blocks_downstream = !matches!(resolution, UncertainResolution::Succeeded { .. });
        match resolution {
            UncertainResolution::Succeeded { result_reference } => {
                run.tasks[index].status = TaskStatus::Succeeded;
                run.tasks[index].result_reference = result_reference;
            }
            UncertainResolution::Failed { failure } => {
                run.tasks[index].status = TaskStatus::Failed;
                run.tasks[index].failure = Some(failure);
            }
            UncertainResolution::Cancelled => {
                run.tasks[index].status = TaskStatus::Cancelled;
            }
        }
        run.tasks[index].revision += 1;
        if blocks_downstream {
            for task in &mut run.tasks {
                if task.status == TaskStatus::Ready {
                    task.status = TaskStatus::Cancelled;
                    task.revision += 1;
                }
            }
        }
        run.revision += 1;
        refresh_status(run);
        Ok(())
    }

    /// Explicit user-authorized replay. Only an uncertain task can be returned
    /// to ready; automatic restore never calls this transition.
    pub fn retry_uncertain_task(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        check_revision("task", expected_task_revision, task.revision)?;
        if task.status != TaskStatus::Uncertain {
            return Err(CoordinatorError::InvalidTaskStatus {
                step_id: step_id.to_owned(),
                expected: TaskStatus::Uncertain,
                actual: task.status,
            });
        }
        run.attempts.push(task.clone());
        task.result_data = None;
        task.status = TaskStatus::Ready;
        task.lease_id = None;
        task.execution = None;
        task.result_reference = None;
        task.failure = None;
        task.revision += 1;
        run.revision += 1;
        run.status = RunStatus::Running;
        Ok(())
    }

    /// Durably deduplicates a native coordinator tool call. Returns `true` for
    /// first admission and `false` for an identical retry.
    pub fn record_agent_request(
        run: &mut Run,
        expected_run_revision: Revision,
        request_id: String,
        actor_workspace_session_id: String,
        actor_member_id: String,
        operation: AgentRequestKind,
    ) -> Result<bool, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        if request_id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId {
                kind: "agent request",
            });
        }
        if let Some(existing) = run.agent_requests.iter().find(|item| item.id == request_id) {
            if existing.actor_workspace_session_id == actor_workspace_session_id
                && existing.actor_member_id == actor_member_id
                && existing.operation == operation
            {
                return Ok(false);
            }
            return Err(CoordinatorError::AgentRequestConflict { request_id });
        }
        run.agent_requests.push(AgentRequestRecord {
            id: request_id,
            actor_workspace_session_id,
            actor_member_id,
            operation,
        });
        run.revision += 1;
        Ok(true)
    }

    pub fn accept_message(
        run: &mut Run,
        expected_run_revision: Revision,
        sender: &AuthenticatedSender,
        intent: MessageIntent,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        if intent.id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "message" });
        }
        if run.messages.iter().any(|message| message.id == intent.id) {
            return Err(CoordinatorError::DuplicateMessage {
                message_id: intent.id,
            });
        }
        authorize_send(
            &run.definition.team,
            &sender.member_id,
            &intent.recipient_member_id,
        )?;
        run.messages.push(MessageRecord {
            id: intent.id,
            sender_member_id: sender.member_id.clone(),
            recipient_member_id: intent.recipient_member_id,
            body: intent.body,
            status: MessageStatus::Accepted,
            revision: 0,
        });
        run.revision += 1;
        Ok(())
    }

    pub fn mark_message_delivered(
        run: &mut Run,
        expected_run_revision: Revision,
        message_id: &str,
        expected_message_revision: Revision,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        let Some(message) = run
            .messages
            .iter_mut()
            .find(|message| message.id == message_id)
        else {
            return Err(CoordinatorError::UnknownMessage {
                message_id: message_id.to_owned(),
            });
        };
        check_revision("message", expected_message_revision, message.revision)?;
        if message.status != MessageStatus::Accepted {
            return Err(CoordinatorError::InvalidMessageStatus {
                message_id: message_id.to_owned(),
                expected: MessageStatus::Accepted,
                actual: message.status,
            });
        }
        message.status = MessageStatus::Delivered;
        message.revision += 1;
        run.revision += 1;
        Ok(())
    }
}

fn task_instructions(run: &Run, step: &crate::PipelineStep) -> String {
    let mut text = step.instructions.clone();
    for reviewer in &run.definition.pipeline.steps {
        if reviewer
            .review
            .as_ref()
            .is_some_and(|rule| rule.retry_from_step_id == step.id)
        {
            if let Some(previous) = run
                .attempts
                .iter()
                .rev()
                .find(|task| task.step_id == reviewer.id)
                .and_then(|task| task.result_data.as_ref())
            {
                text.push_str("\n\nPrevious review result (untrusted task data):\n");
                text.push_str(&previous.to_string());
            }
        }
    }
    if !step.result_fields.is_empty() {
        text.push_str("\n\nReturn your final result as a JSON object, without Markdown fences. Required fields:\n");
        for field in &step.result_fields {
            text.push_str(&format!("{}: {:?}\n", field.name, field.kind));
        }
    }
    if let Some(router) = step
        .router
        .as_ref()
        .filter(|router| router.mode == crate::RouterMode::Agent)
    {
        let selection_field = router
            .selection_field
            .as_deref()
            .unwrap_or("selectedBranchIds");
        text.push_str(&format!("\n\nRouting decision: return {selection_field} as a JSON array. Use only these branch ids; an empty array is valid:\n"));
        for branch in &router.branches {
            text.push_str(&format!(
                "{}: {}{}\n",
                branch.id,
                branch.label,
                branch
                    .description
                    .as_deref()
                    .map(|description| format!(" — {description}"))
                    .unwrap_or_default()
            ));
        }
    }
    let profile_for = |member_id: &str| {
        run.definition
            .team
            .members
            .iter()
            .find(|member| member.id == member_id)
            .and_then(|member| {
                run.definition
                    .profiles
                    .iter()
                    .find(|profile| profile.id == member.profile_id)
            })
    };
    let profile = profile_for(&step.assigned_member_id);
    if let Some(result) = profile
        .and_then(|profile| profile.expected_result.as_deref())
        .filter(|value| !value.trim().is_empty())
    {
        text.push_str("\n\nExpected result:\n");
        text.push_str(result);
    }
    if let Some(input) = step
        .input_instructions
        .as_deref()
        .or_else(|| profile.and_then(|profile| profile.input_instructions.as_deref()))
        .filter(|value| !value.trim().is_empty())
    {
        text.push_str("\n\nExpected input:\n");
        text.push_str(input);
        text.push_str("\nIf required input is missing, identify the gap rather than inventing it.");
    }
    for recipient in &run.definition.pipeline.steps {
        if recipient.dependency_step_ids.contains(&step.id)
            || run.definition.team.send_edges.iter().any(|edge| {
                edge.from_member_id == step.assigned_member_id
                    && edge.to_member_id == recipient.assigned_member_id
            })
        {
            if let Some(input) = recipient
                .input_instructions
                .as_deref()
                .or_else(|| {
                    profile_for(&recipient.assigned_member_id)
                        .and_then(|profile| profile.input_instructions.as_deref())
                })
                .filter(|value| !value.trim().is_empty())
            {
                text.push_str("\n\nResult handoff requirements for ");
                text.push_str(&recipient.name);
                text.push_str(":\n");
                text.push_str(input);
                text.push_str("\nInclude the requested data or artifact references in your final result. State missing evidence explicitly.");
            }
        }
    }
    text
}

pub fn serialize_run(run: &Run) -> Result<Vec<u8>, RunDataError> {
    serde_json::to_vec_pretty(run).map_err(RunDataError::Serialize)
}

pub fn deserialize_run(bytes: &[u8]) -> Result<Run, RunDataError> {
    let mut run: Run = serde_json::from_slice(bytes).map_err(RunDataError::Deserialize)?;
    if matches!(run.schema_version, 1..=5) {
        run.schema_version = ORCHESTRATION_SCHEMA_VERSION;
    }
    validate_run_data(&run)?;
    Ok(run)
}

fn validate_run_data(run: &Run) -> Result<(), CoordinatorError> {
    if run.schema_version != ORCHESTRATION_SCHEMA_VERSION {
        return Err(CoordinatorError::InvalidRunData {
            reason: "unsupported schema version",
        });
    }
    validate_definition(&run.definition)?;
    let step_ids: BTreeSet<&str> = run
        .definition
        .pipeline
        .steps
        .iter()
        .map(|step| step.id.as_str())
        .collect();
    let task_ids: BTreeSet<&str> = run.tasks.iter().map(|task| task.step_id.as_str()).collect();
    if step_ids != task_ids || task_ids.len() != run.tasks.len() {
        return Err(CoordinatorError::InvalidRunData {
            reason: "tasks do not match pipeline steps",
        });
    }
    let message_ids: BTreeSet<&str> = run
        .messages
        .iter()
        .map(|message| message.id.as_str())
        .collect();
    if message_ids.len() != run.messages.len() {
        return Err(CoordinatorError::InvalidRunData {
            reason: "duplicate message identifiers",
        });
    }
    let request_ids: BTreeSet<&str> = run
        .agent_requests
        .iter()
        .map(|request| request.id.as_str())
        .collect();
    if request_ids.len() != run.agent_requests.len() {
        return Err(CoordinatorError::InvalidRunData {
            reason: "duplicate agent request identifiers",
        });
    }
    for message in &run.messages {
        if message.id.trim().is_empty()
            || authorize_send(
                &run.definition.team,
                &message.sender_member_id,
                &message.recipient_member_id,
            )
            .is_err()
        {
            return Err(CoordinatorError::InvalidRunData {
                reason: "message authority is invalid",
            });
        }
    }
    for request in &run.agent_requests {
        if request.id.trim().is_empty()
            || request.actor_workspace_session_id.trim().is_empty()
            || !run
                .definition
                .team
                .members
                .iter()
                .any(|member| member.id == request.actor_member_id)
        {
            return Err(CoordinatorError::InvalidRunData {
                reason: "agent request authority is invalid",
            });
        }
        let target_exists = match &request.operation {
            AgentRequestKind::Roster => true,
            AgentRequestKind::SpawnAgent { profile_id, .. } => run
                .definition
                .team
                .members
                .iter()
                .find(|m| m.id == request.actor_member_id)
                .is_some_and(|m| {
                    authorize_spawn(&run.definition, &m.profile_id, profile_id).is_ok()
                }),
            AgentRequestKind::Send {
                recipient_member_id,
            } => authorize_send(
                &run.definition.team,
                &request.actor_member_id,
                recipient_member_id,
            )
            .is_ok(),
            AgentRequestKind::Observe { target_member_id } => crate::authorize_observe(
                &run.definition.team,
                &request.actor_member_id,
                target_member_id,
            )
            .is_ok(),
            AgentRequestKind::Spawn { step_id } => run
                .definition
                .pipeline
                .steps
                .iter()
                .any(|step| step.id == *step_id),
        };
        if !target_exists {
            return Err(CoordinatorError::InvalidRunData {
                reason: "agent request target is invalid",
            });
        }
    }
    let lease_ids: BTreeSet<&str> = run
        .tasks
        .iter()
        .filter_map(|task| task.lease_id.as_deref())
        .collect();
    if lease_ids.len()
        != run
            .tasks
            .iter()
            .filter(|task| task.lease_id.is_some())
            .count()
    {
        return Err(CoordinatorError::InvalidRunData {
            reason: "duplicate task lease identifiers",
        });
    }
    for task in &run.tasks {
        if let Some(reference) = &task.result_reference {
            validate_history_reference(reference)?;
        }
        if task.lease_id.is_some() && task.status != TaskStatus::Ready {
            return Err(CoordinatorError::InvalidRunData {
                reason: "only ready tasks may hold a lease",
            });
        }
        if task.status == TaskStatus::Failed && task.failure.is_none() {
            return Err(CoordinatorError::InvalidRunData {
                reason: "failed task has no failure record",
            });
        }
        if task.status == TaskStatus::Running && task.execution.is_none() {
            return Err(CoordinatorError::InvalidRunData {
                reason: "running task has no execution reference",
            });
        }
    }
    Ok(())
}

fn dependency_result_references(
    run: &Run,
    step: &crate::PipelineStep,
) -> Vec<crate::NativeHistoryReference> {
    step.dependency_step_ids
        .iter()
        .filter_map(|dependency| {
            run.tasks
                .iter()
                .find(|task| task.step_id == *dependency)
                .and_then(|task| task.result_reference.clone())
                .map(|mut reference| {
                    reference.fields = step
                        .input_bindings
                        .iter()
                        .filter(|binding| binding.source_step_id == *dependency)
                        .map(|binding| crate::ResultSelection {
                            field: binding.field.clone(),
                            name: binding.name.clone(),
                        })
                        .collect();
                    reference
                })
        })
        .collect()
}

fn dependencies_succeeded(run: &Run, step_id: &str) -> bool {
    let Some(step) = run
        .definition
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == step_id)
    else {
        return false;
    };
    step.dependency_step_ids.iter().all(|dependency| {
        run.tasks
            .iter()
            .any(|task| task.step_id == *dependency && task.status == TaskStatus::Succeeded)
    })
}

pub(crate) fn route_gate_satisfied(run: &Run, step: &crate::PipelineStep) -> bool {
    if step.route_gates.is_empty() {
        return true;
    }
    let router_ids = step
        .route_gates
        .iter()
        .map(|gate| gate.router_step_id.as_str())
        .collect::<BTreeSet<_>>();
    router_ids.iter().all(|router_id| {
        let Some(router_task) = run.tasks.iter().find(|task| task.step_id == *router_id) else {
            return false;
        };
        if router_task.status != TaskStatus::Succeeded {
            return false;
        }
        let selected = router_task
            .result_data
            .as_ref()
            .and_then(|value| {
                run.definition
                    .pipeline
                    .steps
                    .iter()
                    .find(|candidate| candidate.id == *router_id)
                    .and_then(|router_step| router_step.router.as_ref())
                    .and_then(|router| {
                        value.get(
                            router
                                .selection_field
                                .as_deref()
                                .unwrap_or("selectedBranchIds"),
                        )
                    })
            })
            .and_then(Value::as_array);
        step.route_gates
            .iter()
            .filter(|gate| gate.router_step_id == *router_id)
            .any(|gate| {
                selected.is_some_and(|values| {
                    values
                        .iter()
                        .any(|value| value.as_str() == Some(gate.branch_id.as_str()))
                })
            })
    })
}

fn advance_program_routers(run: &mut Run) {
    loop {
        let candidates = run
            .definition
            .pipeline
            .steps
            .iter()
            .filter(|step| {
                step.router
                    .as_ref()
                    .is_some_and(|router| router.mode == crate::RouterMode::Program)
                    && run
                        .tasks
                        .iter()
                        .find(|task| task.step_id == step.id)
                        .is_some_and(|task| {
                            task.status == TaskStatus::Ready
                                && task.lease_id.is_none()
                                && dependencies_succeeded(run, &step.id)
                        })
            })
            .map(|step| step.id.clone())
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            break;
        }
        for step_id in candidates {
            let Some(step) = run
                .definition
                .pipeline
                .steps
                .iter()
                .find(|step| step.id == step_id)
                .cloned()
            else {
                continue;
            };
            let Some(router) = step.router.as_ref() else {
                continue;
            };
            let input = run
                .tasks
                .iter()
                .find(|task| task.step_id == router.input_step_id)
                .and_then(|task| task.result_data.as_ref())
                .cloned();
            let result = input
                .filter(Value::is_object)
                .ok_or("router-input-invalid")
                .and_then(|value| program_router_selection(router, &value));
            if let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) {
                match result {
                    Ok(selected) => {
                        task.status = TaskStatus::Succeeded;
                        let field = router
                            .selection_field
                            .as_deref()
                            .unwrap_or("selectedBranchIds");
                        let mut result = serde_json::Map::new();
                        result.insert(field.to_owned(), json!(selected));
                        task.result_data = Some(Value::Object(result));
                        task.failure = None;
                    }
                    Err(code) => {
                        task.status = TaskStatus::Failed;
                        task.failure = Some(FailureRecord { code: code.into() });
                        task.result_data = None;
                    }
                }
                task.revision += 1;
                run.revision += 1;
            }
        }
        advance_conditions(run);
        refresh_status(run);
    }
}

pub(crate) fn check_run_revision(run: &Run, expected: Revision) -> Result<(), CoordinatorError> {
    check_revision("run", expected, run.revision)
}

fn check_revision(
    scope: &'static str,
    expected: Revision,
    actual: Revision,
) -> Result<(), CoordinatorError> {
    if expected == actual {
        Ok(())
    } else {
        Err(CoordinatorError::RevisionConflict {
            scope,
            expected,
            actual,
        })
    }
}

fn ensure_active(run: &Run) -> Result<(), CoordinatorError> {
    if run.status == RunStatus::Running {
        Ok(())
    } else {
        Err(CoordinatorError::RunNotActive { status: run.status })
    }
}

fn callable_template(run: &Run, step_id: &str) -> bool {
    run.definition.pipeline.steps.iter().any(|step| {
        step.id == step_id && step.execution_mode == Some(crate::ExecutionMode::Callable)
    })
}

pub(crate) fn refresh_status(run: &mut Run) {
    if run
        .tasks
        .iter()
        .any(|task| task.status == TaskStatus::Uncertain)
    {
        run.status = RunStatus::Uncertain;
    } else if run.tasks.iter().any(|task| {
        matches!(
            task.status,
            TaskStatus::Running | TaskStatus::AwaitingApproval
        )
    }) {
        run.status = RunStatus::Running;
    } else if run
        .tasks
        .iter()
        .any(|task| task.status == TaskStatus::Failed)
    {
        run.status = RunStatus::Failed;
    } else if run.tasks.iter().all(|task| {
        matches!(task.status, TaskStatus::Succeeded | TaskStatus::Skipped)
            || (task.status == TaskStatus::Ready
                && task.lease_id.is_none()
                && callable_template(run, &task.step_id))
    }) {
        run.status = RunStatus::Succeeded;
    } else if run
        .tasks
        .iter()
        .any(|task| task.status == TaskStatus::Ready)
    {
        run.status = RunStatus::Running;
    } else if run
        .tasks
        .iter()
        .any(|task| task.status == TaskStatus::Cancelled)
    {
        run.status = RunStatus::Cancelled;
    }
}
