use std::collections::BTreeSet;

use thiserror::Error;

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
            schema_version: ORCHESTRATION_SCHEMA_VERSION,
            id: run_id,
            definition,
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
        if run.status != RunStatus::Running {
            return Vec::new();
        }
        let mut ready: Vec<&str> = run
            .tasks
            .iter()
            .filter(|task| {
                task.status == TaskStatus::Ready
                    && task.lease_id.is_none()
                    && dependencies_succeeded(run, &task.step_id)
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
            task_instructions: step.instructions,
            dependency_result_references,
        }))
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
                let dependency_result_references = dependency_result_references(run, &step);
                return Ok(ControlledSpawnLease {
                    run_id: run.id.clone(),
                    run_revision: run.revision,
                    task_revision: run.tasks[index].revision,
                    lease_id,
                    step_id: step.id,
                    member_id: target_member.id.clone(),
                    profile,
                    task_instructions: step.instructions,
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
            task_instructions: step.instructions,
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
            task_instructions: step.instructions,
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
            task_instructions: step.instructions,
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
            } else if task.status == TaskStatus::Ready {
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

pub fn serialize_run(run: &Run) -> Result<Vec<u8>, RunDataError> {
    serde_json::to_vec_pretty(run).map_err(RunDataError::Serialize)
}

pub fn deserialize_run(bytes: &[u8]) -> Result<Run, RunDataError> {
    let run: Run = serde_json::from_slice(bytes).map_err(RunDataError::Deserialize)?;
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

fn check_run_revision(run: &Run, expected: Revision) -> Result<(), CoordinatorError> {
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

fn refresh_status(run: &mut Run) {
    if run
        .tasks
        .iter()
        .any(|task| task.status == TaskStatus::Uncertain)
    {
        run.status = RunStatus::Uncertain;
    } else if run
        .tasks
        .iter()
        .any(|task| task.status == TaskStatus::Running)
    {
        run.status = RunStatus::Running;
    } else if run
        .tasks
        .iter()
        .any(|task| task.status == TaskStatus::Failed)
    {
        run.status = RunStatus::Failed;
    } else if run
        .tasks
        .iter()
        .all(|task| task.status == TaskStatus::Succeeded)
    {
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
