//! Stateless access to the existing graph coordinator over a private host pipe.
//!
//! This crate cannot authenticate a tenant, prove a native history reference,
//! persist a transaction, dispatch a model turn, or stop a process. The trusted
//! host owns those operations. In particular, an emitted effect is a proposal
//! to persist atomically with the returned snapshot before any native action.

#![forbid(unsafe_code)]

pub mod wire;

use std::io::{self, BufRead, Write};

use piui_orchestration::{
    self as core, Coordinator, CoordinatorError, ExecutionMode, ORCHESTRATION_SCHEMA_VERSION, Run,
    RunDefinitionSnapshot, ToolDecision,
};
use wire::{Command, Effect, ErrorCode, Request, Response, State};

/// Processes one complete JSON value. Errors never echo request bodies.
pub fn handle_frame(bytes: &[u8]) -> Response {
    match serde_json::from_slice::<Request>(bytes) {
        Ok(request) => handle(request),
        Err(_) => failure(None, ErrorCode::InvalidRequest),
    }
}

pub fn handle(request: Request) -> Response {
    let Request {
        protocol,
        request_id,
        command,
    } = request;
    if protocol != wire::PROTOCOL {
        return failure(Some(request_id), ErrorCode::UnsupportedProtocol);
    }
    if request_id.trim().is_empty() {
        return failure(None, ErrorCode::InvalidRequest);
    }
    match transition(command) {
        Ok((run, effect)) => match core::serialize_run(&run) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(snapshot) => Response::Ok {
                    protocol: wire::PROTOCOL,
                    request_id,
                    snapshot,
                    run: wire::RunSummary {
                        id: run.id().to_owned(),
                        revision: run.revision(),
                        status: run.status(),
                        paused: run.paused(),
                        needs_restore: Coordinator::needs_restore(&run),
                        ready_task_ids: Coordinator::ready_task_ids(&run)
                            .into_iter()
                            .map(str::to_owned)
                            .collect(),
                    },
                    effect: Box::new(effect),
                },
                Err(_) => failure(Some(request_id), ErrorCode::SerializationFailed),
            },
            Err(_) => failure(Some(request_id), ErrorCode::SerializationFailed),
        },
        Err(code) => failure(Some(request_id), code),
    }
}

fn failure(request_id: Option<String>, code: ErrorCode) -> Response {
    Response::Error {
        protocol: wire::PROTOCOL,
        request_id,
        error: code.error(),
    }
}

/// LF-only framing. Unicode line separators inside JSON strings are data.
/// No private-pipe budget is invented here: the host enforces its own admission
/// and transport bounds. EOF without a final LF is an invalid complete frame.
pub fn serve(input: &mut impl BufRead, output: &mut impl Write) -> io::Result<()> {
    let mut frame = Vec::new();
    loop {
        frame.clear();
        if input.read_until(b'\n', &mut frame)? == 0 {
            return Ok(());
        }
        let response = if frame.last() == Some(&b'\n') {
            handle_frame(&frame)
        } else {
            failure(None, ErrorCode::InvalidRequest)
        };
        serde_json::to_writer(&mut *output, &response).map_err(io::Error::other)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
}

fn read_state(state: State) -> Result<Run, ErrorCode> {
    let value: serde_json::Value =
        serde_json::from_str(&state.snapshot).map_err(|_| ErrorCode::InvalidSnapshot)?;
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(u64::from(ORCHESTRATION_SCHEMA_VERSION))
    {
        return Err(ErrorCode::UnsupportedSnapshotVersion);
    }
    // Decode the original bytes, not Value: duplicate/unknown fields must not
    // disappear through an intermediate map or a legacy schema migration.
    let run =
        core::deserialize_run(state.snapshot.as_bytes()).map_err(|_| ErrorCode::InvalidSnapshot)?;
    supported_definition(run.definition())?;
    if run.revision() != state.expected_run_revision {
        return Err(ErrorCode::RevisionConflict);
    }
    Ok(run)
}

fn supported_definition(definition: &RunDefinitionSnapshot) -> Result<(), ErrorCode> {
    if definition
        .pipeline
        .steps
        .iter()
        .any(core::PipelineStep::is_host_executed)
    {
        return Err(ErrorCode::UnsupportedExecutor);
    }
    // v1 has no native coordinator admission/message commands. Refuse the
    // entire graph before a scheduled native task can have a side effect.
    if definition.team.spawned_agents_join_team
        || !definition.team.send_edges.is_empty()
        || !definition.team.observe_edges.is_empty()
        || definition
            .pipeline
            .steps
            .iter()
            .any(|step| step.execution_mode == Some(ExecutionMode::Callable))
        || definition.profiles.iter().any(|profile| {
            !profile.allowed_spawn_profile_ids.is_empty()
                || profile.tool_policy.rules.iter().any(|rule| {
                    rule.decision == ToolDecision::Allow && rule.tool.starts_with("orchestration.")
                })
        })
    {
        return Err(ErrorCode::UnsupportedCapability);
    }
    Ok(())
}

fn transition(command: Command) -> Result<(Run, Effect), ErrorCode> {
    let changed = Effect::Changed {};
    match command {
        Command::Create {
            run_id,
            definition,
            profile_capabilities,
            inputs,
            trigger,
            use_pinned_data,
        } => {
            supported_definition(&definition)?;
            if profile_capabilities.len() != definition.profiles.len() {
                return Err(ErrorCode::MissingCapabilities);
            }
            for profile in &definition.profiles {
                let capabilities = profile_capabilities
                    .get(&profile.id)
                    .ok_or(ErrorCode::MissingCapabilities)?;
                core::validate_profile_capabilities(profile, capabilities)
                    .map_err(|_| ErrorCode::UnsupportedCapability)?;
            }
            let run = Coordinator::new_started_run(
                run_id,
                *definition,
                inputs,
                trigger,
                core::RunOptions { use_pinned_data },
            )
            .map_err(domain_error)?;
            Ok((run, Effect::Created {}))
        }
        Command::Inspect { state } => Ok((read_state(state)?, Effect::Observed {})),
        Command::ProjectResult {
            state,
            text,
            fields,
        } => {
            let run = read_state(state)?;
            let text =
                core::project_result(&text, &fields).map_err(|_| ErrorCode::InvalidRequest)?;
            Ok((run, Effect::Projected { text }))
        }
        Command::Advance { state } => {
            let mut run = read_state(state)?;
            Coordinator::advance_automatic_steps(&mut run);
            Ok((run, changed))
        }
        Command::Lease { state, lease_id } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            let lease =
                Coordinator::lease_next_task(&mut run, revision, lease_id).map_err(domain_error)?;
            let effect = lease.map_or(Effect::Idle {}, |lease| Effect::Leased {
                lease: lease.into(),
            });
            Ok((run, effect))
        }
        Command::Dispatch {
            state,
            step_id,
            expected_task_revision,
            lease_id,
            execution,
        } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            let launch = Coordinator::dispatch_leased_task(
                &mut run,
                revision,
                &step_id,
                expected_task_revision,
                &lease_id,
                execution,
            )
            .map_err(domain_error)?;
            Ok((
                run,
                Effect::Dispatched {
                    launch: launch.into(),
                },
            ))
        }
        Command::ReleaseLease {
            state,
            step_id,
            expected_task_revision,
            lease_id,
        } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            Coordinator::release_task_lease(
                &mut run,
                revision,
                &step_id,
                expected_task_revision,
                &lease_id,
            )
            .map_err(domain_error)?;
            Ok((run, changed))
        }
        Command::RejectReady {
            state,
            step_id,
            expected_task_revision,
            failure,
        } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            Coordinator::reject_ready_task(
                &mut run,
                revision,
                &step_id,
                expected_task_revision,
                failure,
            )
            .map_err(domain_error)?;
            Ok((run, changed))
        }
        Command::CompleteChecked {
            state,
            step_id,
            expected_task_revision,
            execution_id,
            outcome,
            text,
        } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            Coordinator::complete_checked_task(
                &mut run,
                revision,
                &step_id,
                expected_task_revision,
                &execution_id,
                outcome.into(),
                text.as_deref(),
            )
            .map_err(domain_error)?;
            Ok((run, changed))
        }
        Command::CancellationRequests { state } => {
            let run = read_state(state)?;
            let requests =
                Coordinator::cancellation_requests(&run, run.revision()).map_err(domain_error)?;
            Ok((
                run,
                Effect::Cancellations {
                    requests: requests.into_iter().map(Into::into).collect(),
                },
            ))
        }
        Command::Cancel { state } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            let requests = Coordinator::cancel_run(&mut run, revision).map_err(domain_error)?;
            Ok((
                run,
                Effect::Cancellations {
                    requests: requests.into_iter().map(Into::into).collect(),
                },
            ))
        }
        Command::MarkUncertain {
            state,
            step_id,
            expected_task_revision,
            identity,
        } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            Coordinator::mark_task_uncertain(
                &mut run,
                revision,
                &step_id,
                expected_task_revision,
                &identity.into(),
            )
            .map_err(domain_error)?;
            Ok((run, changed))
        }
        Command::Restore { state } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            Coordinator::restore(&mut run, revision).map_err(domain_error)?;
            Ok((run, changed))
        }
        Command::Reconcile {
            state,
            step_id,
            expected_task_revision,
            resolution,
        } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            Coordinator::reconcile_uncertain_task(
                &mut run,
                revision,
                &step_id,
                expected_task_revision,
                resolution.into(),
            )
            .map_err(domain_error)?;
            Ok((run, changed))
        }
        Command::RetryUncertain {
            state,
            step_id,
            expected_task_revision,
        } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            Coordinator::retry_uncertain_task(&mut run, revision, &step_id, expected_task_revision)
                .map_err(domain_error)?;
            Ok((run, changed))
        }
        Command::ControlFlow { state, action } => {
            let mut run = read_state(state)?;
            let revision = run.revision();
            Coordinator::control_flow(&mut run, revision, action.into()).map_err(domain_error)?;
            Ok((run, changed))
        }
    }
}

fn domain_error(error: CoordinatorError) -> ErrorCode {
    match error {
        CoordinatorError::InvalidDefinition(_) | CoordinatorError::InvalidRunInput(_) => {
            ErrorCode::InvalidDefinition
        }
        CoordinatorError::RevisionConflict { .. } => ErrorCode::RevisionConflict,
        CoordinatorError::StaleExecution { .. } => ErrorCode::StaleExecution,
        CoordinatorError::LeaseConflict { .. } => ErrorCode::LeaseConflict,
        CoordinatorError::ExecutorMismatch { .. } => ErrorCode::UnsupportedExecutor,
        _ => ErrorCode::InvalidTransition,
    }
}

impl From<core::DependencyOutput> for wire::DependencyOutput {
    fn from(value: core::DependencyOutput) -> Self {
        Self {
            step_id: value.step_id,
            fields: value.fields,
            text: value.text,
            data: value.data,
        }
    }
}

impl From<core::ControlledSpawnLease> for wire::Lease {
    fn from(value: core::ControlledSpawnLease) -> Self {
        Self {
            run_id: value.run_id,
            run_revision: value.run_revision,
            task_revision: value.task_revision,
            lease_id: value.lease_id,
            step_id: value.step_id,
            member_id: value.member_id,
            profile: value.profile,
            task_instructions: value.task_instructions,
            dependency_result_references: value.dependency_result_references,
            dependency_outputs: value
                .dependency_outputs
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

impl From<core::LaunchRequest> for wire::Launch {
    fn from(value: core::LaunchRequest) -> Self {
        Self {
            run_id: value.run_id,
            run_revision: value.run_revision,
            task_revision: value.task_revision,
            step_id: value.step_id,
            member_id: value.member_id,
            profile: value.profile,
            task_instructions: value.task_instructions,
            dependency_result_references: value.dependency_result_references,
            dependency_outputs: value
                .dependency_outputs
                .into_iter()
                .map(Into::into)
                .collect(),
            execution: value.execution,
        }
    }
}

impl From<core::CancelRequest> for wire::Cancel {
    fn from(value: core::CancelRequest) -> Self {
        Self {
            run_id: value.run_id,
            step_id: value.step_id,
            execution: value.execution,
        }
    }
}

impl From<wire::Outcome> for core::CompletionOutcome {
    fn from(value: wire::Outcome) -> Self {
        match value {
            wire::Outcome::Succeeded { result_reference } => Self::Succeeded { result_reference },
            wire::Outcome::Failed { failure } => Self::Failed { failure },
        }
    }
}

impl From<wire::Resolution> for core::UncertainResolution {
    fn from(value: wire::Resolution) -> Self {
        match value {
            wire::Resolution::Succeeded { result_reference } => {
                Self::Succeeded { result_reference }
            }
            wire::Resolution::Failed { failure } => Self::Failed { failure },
            wire::Resolution::Cancelled {} => Self::Cancelled,
        }
    }
}

impl From<wire::UncertainIdentity> for core::UncertaintyIdentity {
    fn from(value: wire::UncertainIdentity) -> Self {
        match value {
            wire::UncertainIdentity::Execution { id } => Self::Execution(id),
            wire::UncertainIdentity::Lease { id } => Self::Lease(id),
        }
    }
}

impl From<wire::FlowAction> for core::FlowAction {
    fn from(value: wire::FlowAction) -> Self {
        match value {
            wire::FlowAction::Pause {} => Self::Pause,
            wire::FlowAction::Resume {} => Self::Resume,
            wire::FlowAction::Decide {
                step_id,
                task_revision,
                approved,
            } => Self::Decide {
                step_id,
                task_revision,
                approved,
            },
            wire::FlowAction::Repeat {
                step_id,
                task_revision,
            } => Self::Repeat {
                step_id,
                task_revision,
            },
        }
    }
}

#[cfg(test)]
mod tests;
