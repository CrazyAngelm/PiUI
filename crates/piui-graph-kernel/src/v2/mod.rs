//! Protocol 2: the shared compiler and the deterministic coordinator behind a
//! binding that the trusted host chose and froze with the run.
//!
//! The binding names the run's owner (its execution location and host scope),
//! the executors the host runs there and the capabilities its adapters proved
//! for every frozen profile. A portable document cannot supply any of it.
//! Every command re-reads the binding and re-admits the frozen definition
//! before a transition, so a stored run never gains authority on reload.
//!
//! The kernel still performs no effect. It returns typed intents for the host
//! to persist atomically with the returned state and only then perform:
//! native turns, host steps, messages, child runs and cancellations. The host
//! owns identifiers, history reads, approvals, pipeline-name resolution, run
//! inputs and persistence; this module adds no scheduler, timeout or quota.

pub mod wire;

use std::collections::{BTreeMap, BTreeSet};

use piui_orchestration::{
    self as core, AgentRequestAdmission, AgentRequestError, CancelRequest, Coordinator,
    CoordinatorError, ExecutorKind, NativeBridgeCapabilities, NativeExecutionReference,
    ORCHESTRATION_SCHEMA_VERSION, PipelineDefinition, PipelineStepLease, Revision, Run,
    RunDefinitionSnapshot, RunStatus, RunTrigger, ScriptDependency, StepExecutor,
    SubpipelineInputSource, TaskStatus,
};
use serde_json::Value;
use wire::{
    AgentAdmission, AgentRequestRefusal, Binding, BindingFacts, ChildDefinition, ChildReference,
    ChildRun, Command, CompileResult, Effect, Error, ErrorCode, HostCompletion, HostDependency,
    Location, Owner, PersistedState, Request, Response, State,
};

use crate::wire::RunSummary;

/// Processes one complete JSON value. Errors never echo request bodies.
pub fn handle_frame(bytes: &[u8]) -> Response {
    match serde_json::from_slice::<Request>(bytes) {
        Ok(request) => handle(request),
        Err(_) => failure(None, ErrorCode::InvalidRequest.into()),
    }
}

pub fn handle(request: Request) -> Response {
    let Request {
        protocol,
        request_id,
        command,
    } = request;
    if protocol != wire::PROTOCOL {
        return failure(Some(request_id), ErrorCode::UnsupportedProtocol.into());
    }
    if request_id.trim().is_empty() {
        return failure(None, ErrorCode::InvalidRequest.into());
    }
    match transition(command).and_then(encode) {
        Ok(encoded) => Response::Ok {
            protocol: wire::PROTOCOL,
            request_id,
            state: encoded.state,
            run: encoded.run,
            child: encoded.child,
            effect: Box::new(encoded.effect),
        },
        Err(error) => failure(Some(request_id), error),
    }
}

fn failure(request_id: Option<String>, failure: Failure) -> Response {
    Response::Error {
        protocol: wire::PROTOCOL,
        request_id,
        error: Error {
            code: failure.code,
            message: failure.code.message(),
            refusals: failure.refusals,
            failure: failure.failure,
            agent_request: failure.agent_request,
        },
    }
}

/// A refusal before any state is returned.
struct Failure {
    code: ErrorCode,
    refusals: Vec<core::AdmissionRefusal>,
    failure: Option<core::FailureRecord>,
    agent_request: Option<AgentRequestRefusal>,
}

impl From<ErrorCode> for Failure {
    fn from(code: ErrorCode) -> Self {
        Self {
            code,
            refusals: Vec::new(),
            failure: None,
            agent_request: None,
        }
    }
}

impl Failure {
    fn admission(refusals: Vec<core::AdmissionRefusal>) -> Self {
        Self {
            refusals,
            ..ErrorCode::AdmissionRefused.into()
        }
    }

    /// A certain sub-pipeline refusal: nothing started, and the host records
    /// `code` on the leased step with `rejectLeased`.
    fn child(code: &str, refusals: Vec<core::AdmissionRefusal>) -> Self {
        Self {
            refusals,
            failure: Some(core::FailureRecord::new(code)),
            ..ErrorCode::ChildRefused.into()
        }
    }

    fn agent(error: &AgentRequestError) -> Self {
        Self {
            agent_request: Some(AgentRequestRefusal {
                disposition: error.disposition(),
                reason: error.code(),
            }),
            ..ErrorCode::AgentRequestRefused.into()
        }
    }
}

struct Stored {
    run: Run,
    binding: String,
}

struct Transition {
    state: Option<Stored>,
    child: Option<Stored>,
    effect: Effect,
}

impl Transition {
    fn run(run: Run, binding: String, effect: Effect) -> Self {
        Self {
            state: Some(Stored { run, binding }),
            child: None,
            effect,
        }
    }
}

struct Encoded {
    state: Option<PersistedState>,
    run: Option<RunSummary>,
    child: Option<ChildRun>,
    effect: Effect,
}

fn encode(transition: Transition) -> Result<Encoded, Failure> {
    let (state, run) = match transition.state {
        Some(stored) => {
            let (state, run) = persisted(stored)?;
            (Some(state), Some(run))
        }
        None => (None, None),
    };
    let child = transition
        .child
        .map(persisted)
        .transpose()?
        .map(|(state, run)| ChildRun { state, run });
    Ok(Encoded {
        state,
        run,
        child,
        effect: transition.effect,
    })
}

fn persisted(mut stored: Stored) -> Result<(PersistedState, RunSummary), Failure> {
    // Every transition that cancels ready work (the fail-fast of a failed
    // task, a rejection, a reconciliation, a failed pinned step) also cancels
    // a task another executor still has leased, and only a ready task may hold
    // a lease in a stored run. The reservations it cancelled are released.
    Coordinator::release_cancelled_leases(&mut stored.run);
    let bytes = core::serialize_run(&stored.run).map_err(|_| ErrorCode::SerializationFailed)?;
    // A state the next command could not load is never returned: the host
    // persists nothing and its stored state stays current.
    core::deserialize_run(&bytes).map_err(|_| ErrorCode::InvalidTransition)?;
    let snapshot = String::from_utf8(bytes).map_err(|_| ErrorCode::SerializationFailed)?;
    let summary = RunSummary {
        id: stored.run.id().to_owned(),
        revision: stored.run.revision(),
        status: stored.run.status(),
        paused: stored.run.paused(),
        needs_restore: Coordinator::needs_restore(&stored.run),
        ready_task_ids: Coordinator::ready_task_ids(&stored.run)
            .into_iter()
            .map(str::to_owned)
            .collect(),
    };
    Ok((
        PersistedState {
            snapshot,
            binding: stored.binding,
        },
        summary,
    ))
}

/// A stored run with the binding frozen at its creation.
struct Loaded {
    run: Run,
    binding: Binding,
    /// The exact persisted binding, returned unchanged.
    binding_text: String,
}

fn load(state: State) -> Result<Loaded, Failure> {
    let State {
        snapshot,
        binding: binding_text,
        expected_run_revision,
        owner,
    } = state;
    let value: Value = serde_json::from_str(&snapshot).map_err(|_| ErrorCode::InvalidSnapshot)?;
    if value.get("schemaVersion").and_then(Value::as_u64)
        != Some(u64::from(ORCHESTRATION_SCHEMA_VERSION))
    {
        return Err(ErrorCode::UnsupportedSnapshotVersion.into());
    }
    // Decode the original bytes, not Value: duplicate/unknown fields must not
    // disappear through an intermediate map or a legacy schema migration.
    let run = core::deserialize_run(snapshot.as_bytes()).map_err(|_| ErrorCode::InvalidSnapshot)?;
    // A stored `roster` operation is the shared `AgentRequestKind::Roster`, a
    // unit variant that serde decodes while ignoring every other member. The
    // request records must round-trip exactly, or a member would silently
    // disappear from the next state this kernel returns.
    let requests =
        serde_json::to_value(run.agent_requests()).map_err(|_| ErrorCode::InvalidSnapshot)?;
    if value.get("agentRequests") != Some(&requests) {
        return Err(ErrorCode::InvalidSnapshot.into());
    }
    let binding = read_binding(&binding_text)?;
    if binding.run_id != run.id()
        || !owner_valid(&binding.owner)
        || foreign_capabilities(&binding.profile_capabilities, run.definition())
    {
        return Err(ErrorCode::InvalidBinding.into());
    }
    if binding.owner != owner {
        return Err(ErrorCode::OwnerMismatch.into());
    }
    // Every generation is admitted from frozen facts: the user's original
    // definition against the frozen binding, and every step (including
    // spawned agents) against the frozen executors.
    admitted(run.initial_definition(), &binding)?;
    if run
        .definition()
        .pipeline
        .steps
        .iter()
        .any(|step| !binding.executors.supports(step.executor_kind()))
    {
        return Err(ErrorCode::UnsupportedExecutor.into());
    }
    if run.revision() != expected_run_revision {
        return Err(ErrorCode::RevisionConflict.into());
    }
    Ok(Loaded {
        run,
        binding,
        binding_text,
    })
}

fn read_binding(text: &str) -> Result<Binding, Failure> {
    let value: Value = serde_json::from_str(text).map_err(|_| ErrorCode::InvalidBinding)?;
    if value.get("bindingVersion").and_then(Value::as_u64) != Some(u64::from(wire::BINDING_VERSION))
    {
        return Err(ErrorCode::UnsupportedBindingVersion.into());
    }
    Ok(serde_json::from_str(text).map_err(|_| ErrorCode::InvalidBinding)?)
}

fn owner_valid(owner: &Owner) -> bool {
    let text = |value: &str| !value.trim().is_empty();
    text(&owner.scope_id)
        && match &owner.location {
            Location::Local {} => true,
            Location::Cloud {
                account_id,
                workspace_id,
                profile_id,
            } => text(account_id) && text(workspace_id) && text(profile_id),
        }
}

/// Capabilities belong to frozen profiles only: a key naming another profile
/// is a host error. A profile without them is an admission refusal
/// (`missingCapabilities`).
fn foreign_capabilities(
    capabilities: &BTreeMap<String, NativeBridgeCapabilities>,
    definition: &RunDefinitionSnapshot,
) -> bool {
    capabilities
        .keys()
        .any(|id| !definition.profiles.iter().any(|profile| profile.id == *id))
}

/// The facts a host chose for a new run, checked identically by `create` and
/// `validate`: a valid owner and capabilities for frozen profiles only.
fn checked_facts(facts: &BindingFacts, definition: &RunDefinitionSnapshot) -> Result<(), Failure> {
    if owner_valid(&facts.owner) && !foreign_capabilities(&facts.profile_capabilities, definition) {
        Ok(())
    } else {
        Err(ErrorCode::InvalidRequest.into())
    }
}

fn admitted(definition: &RunDefinitionSnapshot, binding: &Binding) -> Result<(), Failure> {
    let refusals =
        core::definition_refusals(definition, &binding.profile_capabilities, binding.executors);
    if refusals.is_empty() {
        Ok(())
    } else {
        Err(Failure::admission(refusals))
    }
}

fn bound_capabilities<'a>(
    binding: &'a Binding,
    profile_id: &str,
) -> Result<&'a NativeBridgeCapabilities, Failure> {
    binding
        .profile_capabilities
        .get(profile_id)
        .ok_or_else(|| ErrorCode::InvalidBinding.into())
}

/// The frozen adapter capabilities of the member running `execution_id`.
fn actor_capabilities<'a>(
    run: &Run,
    binding: &'a Binding,
    execution_id: &str,
) -> Option<&'a NativeBridgeCapabilities> {
    let member_id = core::agent_request_actor(run, execution_id)?;
    let member = run
        .definition()
        .team
        .members
        .iter()
        .find(|member| member.id == member_id)?;
    binding.profile_capabilities.get(&member.profile_id)
}

fn step_kind(run: &Run, step_id: &str) -> Option<ExecutorKind> {
    run.definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == step_id)
        .map(core::PipelineStep::executor_kind)
}

/// The executor of the step the next lease would take, read from a probe
/// copy: the coordinator's own lease transition still decides everything.
fn next_executor(run: &Run) -> Option<ExecutorKind> {
    let mut probe = run.clone();
    Coordinator::advance_automatic_steps(&mut probe);
    let step_id = Coordinator::ready_task_ids(&probe)
        .first()
        .map(|id| (*id).to_owned())?;
    step_kind(&probe, &step_id)
}

fn task_revision(run: &Run, step_id: &str) -> Option<Revision> {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .map(core::TaskRecord::revision)
}

fn task_execution<'a>(run: &'a Run, step_id: &str) -> Option<&'a str> {
    run.tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .and_then(core::TaskRecord::execution)
        .map(|execution| execution.id.as_str())
}

/// The steps whose task holds lease `lease_id`. Lease identifiers of every
/// executor share one namespace: a stored run cannot hold one twice.
fn lease_holders<'a>(run: &'a Run, lease_id: &'a str) -> impl Iterator<Item = &'a str> {
    run.tasks()
        .iter()
        .filter(move |task| task.lease_id() == Some(lease_id))
        .map(core::TaskRecord::step_id)
}

fn cancellations(run: &Run, requests: Vec<CancelRequest>) -> Result<Effect, Failure> {
    let requests = requests
        .into_iter()
        .map(|request| {
            let executor = step_kind(run, &request.step_id).ok_or(ErrorCode::InvalidTransition)?;
            Ok(wire::Cancel {
                run_id: request.run_id,
                step_id: request.step_id,
                executor: executor.into(),
                execution: request.execution,
            })
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    Ok(Effect::Cancellations { requests })
}

fn transition(command: Command) -> Result<Transition, Failure> {
    let changed = || Effect::Changed {};
    match command {
        Command::Compile {
            document,
            identity,
            pipelines,
        } => {
            let result = match core::compile_system_document(&document, &identity, &pipelines) {
                Ok(definition) => CompileResult::Compiled {
                    definition: Box::new(definition),
                },
                Err(error) => CompileResult::Refused {
                    refusal: error.refusal(),
                },
            };
            Ok(Transition {
                state: None,
                child: None,
                effect: Effect::Compiled { result },
            })
        }
        Command::Create {
            run_id,
            definition,
            binding,
            inputs,
            trigger,
            use_pinned_data,
        } => {
            // A sub-pipeline child exists only with its parent's dispatch.
            if trigger
                .as_ref()
                .is_some_and(|trigger| trigger.pipeline_parent().is_some())
            {
                return Err(ErrorCode::InvalidRequest.into());
            }
            checked_facts(&binding, &definition)?;
            let BindingFacts {
                owner,
                executors,
                profile_capabilities,
            } = binding;
            let binding = Binding {
                binding_version: wire::BINDING_VERSION,
                run_id: run_id.clone(),
                owner,
                executors,
                profile_capabilities,
                ancestry: Vec::new(),
            };
            admitted(&definition, &binding)?;
            let run = Coordinator::new_started_run(
                run_id,
                *definition,
                inputs,
                trigger,
                core::RunOptions { use_pinned_data },
            )
            .map_err(domain_error)?;
            let binding =
                serde_json::to_string(&binding).map_err(|_| ErrorCode::SerializationFailed)?;
            Ok(Transition::run(run, binding, Effect::Created {}))
        }
        Command::Validate {
            definition,
            binding,
        } => {
            checked_facts(&binding, &definition)?;
            let refusals = core::definition_refusals(
                &definition,
                &binding.profile_capabilities,
                binding.executors,
            );
            Ok(Transition {
                state: None,
                child: None,
                effect: Effect::Validated { refusals },
            })
        }
        Command::Inspect { state } => {
            let loaded = load(state)?;
            Ok(Transition::run(
                loaded.run,
                loaded.binding_text,
                Effect::Observed {},
            ))
        }
        Command::ProjectResult {
            state,
            text,
            fields,
        } => {
            let loaded = load(state)?;
            let text =
                core::project_result(&text, &fields).map_err(|_| ErrorCode::InvalidRequest)?;
            Ok(Transition::run(
                loaded.run,
                loaded.binding_text,
                Effect::Projected { text },
            ))
        }
        Command::Advance { state } => {
            let mut loaded = load(state)?;
            Coordinator::advance_automatic_steps(&mut loaded.run);
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::Lease { state, lease_id } => {
            let Loaded {
                mut run,
                binding,
                binding_text,
            } = load(state)?;
            // A lease always goes to a task without one, so an identifier a
            // task already holds names another reservation: a stored run
            // cannot hold two (`validate_run_data`).
            if lease_holders(&run, &lease_id).next().is_some() {
                return Err(ErrorCode::LeaseConflict.into());
            }
            let kind = next_executor(&run);
            if kind.is_some_and(|kind| !binding.executors.supports(kind)) {
                return Err(ErrorCode::UnsupportedExecutor.into());
            }
            let revision = run.revision();
            let effect = match kind {
                Some(ExecutorKind::Script) => {
                    match Coordinator::lease_next_script(&mut run, revision, lease_id)
                        .map_err(domain_error)?
                    {
                        Some(lease) => Effect::ScriptLeased {
                            lease: lease.into(),
                        },
                        None => Effect::Idle {},
                    }
                }
                Some(ExecutorKind::Plugin) => {
                    match Coordinator::lease_next_plugin_step(&mut run, revision, lease_id)
                        .map_err(domain_error)?
                    {
                        Some(lease) => Effect::PluginLeased {
                            lease: lease.into(),
                        },
                        None => Effect::Idle {},
                    }
                }
                Some(ExecutorKind::Pipeline) => {
                    match Coordinator::lease_next_pipeline_step(&mut run, revision, lease_id)
                        .map_err(domain_error)?
                    {
                        Some(lease) => Effect::PipelineLeased {
                            lease: pipeline_lease(lease),
                        },
                        None => Effect::Idle {},
                    }
                }
                None | Some(ExecutorKind::Agent | ExecutorKind::Llm) => {
                    match Coordinator::lease_next_task(&mut run, revision, lease_id)
                        .map_err(domain_error)?
                    {
                        Some(lease) => {
                            let executor = step_kind(&run, &lease.step_id)
                                .ok_or(ErrorCode::InvalidTransition)?;
                            let capabilities = bound_capabilities(&binding, &lease.profile.id)?;
                            core::validate_profile_capabilities(&lease.profile, capabilities)
                                .map_err(|_| ErrorCode::UnsupportedCapability)?;
                            Effect::Leased {
                                executor: executor.into(),
                                lease: lease.into(),
                            }
                        }
                        None => Effect::Idle {},
                    }
                }
            };
            Ok(Transition::run(run, binding_text, effect))
        }
        Command::Dispatch {
            state,
            step_id,
            expected_task_revision,
            lease_id,
            execution,
        } => {
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            let launch = Coordinator::dispatch_leased_task(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                &lease_id,
                execution,
            )
            .map_err(domain_error)?;
            Ok(Transition::run(
                loaded.run,
                loaded.binding_text,
                Effect::Dispatched {
                    launch: launch.into(),
                },
            ))
        }
        Command::DispatchHostStep {
            state,
            step_id,
            expected_task_revision,
            lease_id,
            execution,
        } => {
            let mut loaded = load(state)?;
            // A sub-pipeline step is dispatched only with its child run.
            let executor = match step_kind(&loaded.run, &step_id) {
                Some(kind @ (ExecutorKind::Script | ExecutorKind::Plugin)) => kind,
                Some(_) => return Err(ErrorCode::ExecutorMismatch.into()),
                None => return Err(ErrorCode::InvalidTransition.into()),
            };
            let revision = loaded.run.revision();
            Coordinator::dispatch_leased_script(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                &lease_id,
                execution.clone(),
            )
            .map_err(domain_error)?;
            Ok(Transition::run(
                loaded.run,
                loaded.binding_text,
                Effect::HostDispatched {
                    step_id,
                    executor: executor.into(),
                    execution,
                },
            ))
        }
        Command::CompleteHostStep {
            state,
            step_id,
            expected_task_revision,
            execution_id,
            completion,
        } => {
            let mut loaded = load(state)?;
            let completion = match completion {
                HostCompletion::Exited { stdout, truncated } => {
                    core::ScriptCompletion::Exited { stdout, truncated }
                }
                HostCompletion::Failed { failure } => core::ScriptCompletion::Failed { failure },
            };
            let revision = loaded.run.revision();
            Coordinator::complete_script_task(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                &execution_id,
                completion,
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::ReleaseLease {
            state,
            step_id,
            expected_task_revision,
            lease_id,
        } => {
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            Coordinator::release_task_lease(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                &lease_id,
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::RejectLeased {
            state,
            step_id,
            expected_task_revision,
            lease_id,
            failure,
        } => {
            // A certain refusal before anything started (Desktop's
            // `reject_leased_script`/`reject_leased_task`).
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            Coordinator::release_task_lease(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                &lease_id,
            )
            .map_err(domain_error)?;
            let revision = loaded.run.revision();
            let task_revision =
                task_revision(&loaded.run, &step_id).ok_or(ErrorCode::InvalidTransition)?;
            Coordinator::reject_ready_task(
                &mut loaded.run,
                revision,
                &step_id,
                task_revision,
                failure,
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::RejectReady {
            state,
            step_id,
            expected_task_revision,
            failure,
        } => {
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            Coordinator::reject_ready_task(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                failure,
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::CompleteChecked {
            state,
            step_id,
            expected_task_revision,
            execution_id,
            outcome,
            text,
        } => {
            let mut loaded = load(state)?;
            // A native result is verified in the history of this execution
            // only; a reference into another session is never accepted.
            if let crate::wire::Outcome::Succeeded {
                result_reference: Some(reference),
            } = &outcome
                && reference.session_id != execution_id
            {
                return Err(ErrorCode::ForeignHistoryReference.into());
            }
            let revision = loaded.run.revision();
            Coordinator::complete_checked_task(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                &execution_id,
                outcome.into(),
                text.as_deref(),
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::MarkUncertain {
            state,
            step_id,
            expected_task_revision,
            identity,
        } => {
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            Coordinator::mark_task_uncertain(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                &identity.into(),
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::CancellationRequests { state } => {
            let loaded = load(state)?;
            let requests = Coordinator::cancellation_requests(&loaded.run, loaded.run.revision())
                .map_err(domain_error)?;
            let effect = cancellations(&loaded.run, requests)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, effect))
        }
        Command::Cancel { state } => {
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            let requests =
                Coordinator::cancel_run(&mut loaded.run, revision).map_err(domain_error)?;
            let effect = cancellations(&loaded.run, requests)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, effect))
        }
        Command::Restore { state } => {
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            Coordinator::restore(&mut loaded.run, revision).map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::Reconcile {
            state,
            step_id,
            expected_task_revision,
            resolution,
        } => {
            let mut loaded = load(state)?;
            if let crate::wire::Resolution::Succeeded {
                result_reference: Some(reference),
            } = &resolution
                && task_revision(&loaded.run, &step_id).is_some()
                && task_execution(&loaded.run, &step_id) != Some(reference.session_id.as_str())
            {
                return Err(ErrorCode::ForeignHistoryReference.into());
            }
            let revision = loaded.run.revision();
            Coordinator::reconcile_uncertain_task(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
                resolution.into(),
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::RetryUncertain {
            state,
            step_id,
            expected_task_revision,
        } => {
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            Coordinator::retry_uncertain_task(
                &mut loaded.run,
                revision,
                &step_id,
                expected_task_revision,
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::ControlFlow { state, action } => {
            let mut loaded = load(state)?;
            let revision = loaded.run.revision();
            Coordinator::control_flow(&mut loaded.run, revision, action.into())
                .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::AgentRequest {
            state,
            actor_execution_id,
            request,
        } => {
            let Loaded {
                mut run,
                binding,
                binding_text,
            } = load(state)?;
            let request = core::AgentToolRequest::from(request);
            if request.request_id.trim().is_empty() {
                return Err(Failure::agent(&AgentRequestError::EmptyRequestId));
            }
            let capabilities = actor_capabilities(&run, &binding, &actor_execution_id)
                .ok_or_else(|| Failure::agent(&AgentRequestError::UnknownActor))?;
            let spawn_agent = matches!(
                request.operation,
                core::AgentToolOperation::SpawnAgent { .. }
            );
            let admission =
                core::admit_agent_request(&mut run, &actor_execution_id, request, capabilities)
                    .map_err(|error| Failure::agent(&error))?;
            if let AgentRequestAdmission::Spawn { lease } = &admission {
                // The request identifier is the spawn's lease identifier. An
                // identical retry returns the same lease of the same step;
                // another step's reservation under it would leave two.
                if lease_holders(&run, &lease.lease_id).any(|step| step != lease.step_id) {
                    let conflict = CoordinatorError::LeaseConflict {
                        step_id: lease.step_id.clone(),
                    };
                    return Err(Failure::agent(&if spawn_agent {
                        AgentRequestError::SpawnAgentLease(conflict)
                    } else {
                        AgentRequestError::SpawnLease(conflict)
                    }));
                }
                // The spawned step is an agent turn on its own profile's
                // adapter, admitted from the frozen binding like any lease.
                if !binding.executors.agent {
                    return Err(ErrorCode::UnsupportedExecutor.into());
                }
                let spawned = bound_capabilities(&binding, &lease.profile.id)?;
                core::validate_profile_capabilities(&lease.profile, spawned)
                    .map_err(|_| ErrorCode::UnsupportedCapability)?;
            }
            Ok(Transition::run(
                run,
                binding_text,
                Effect::AgentAdmission {
                    admission: admission.into(),
                },
            ))
        }
        Command::MarkMessageDelivered { state, message_id } => {
            let mut loaded = load(state)?;
            let message_revision = loaded
                .run
                .messages()
                .iter()
                .find(|message| message.id() == message_id)
                .map(core::MessageRecord::revision)
                .ok_or(ErrorCode::InvalidTransition)?;
            let revision = loaded.run.revision();
            Coordinator::mark_message_delivered(
                &mut loaded.run,
                revision,
                &message_id,
                message_revision,
            )
            .map_err(domain_error)?;
            Ok(Transition::run(loaded.run, loaded.binding_text, changed()))
        }
        Command::StartPipelineChild {
            state,
            step_id,
            expected_task_revision,
            lease_id,
            child_run_id,
            child,
            resolved_texts,
        } => start_pipeline_child(
            load(state)?,
            &step_id,
            expected_task_revision,
            &lease_id,
            child_run_id,
            child,
            &resolved_texts,
        ),
        Command::ChildOutputReferences { child } => {
            let loaded = load(child)?;
            let references = core::child_output_references(&loaded.run)
                .into_iter()
                .map(|(step_id, reference)| ChildReference { step_id, reference })
                .collect();
            Ok(Transition::run(
                loaded.run,
                loaded.binding_text,
                Effect::ChildOutputReferences { references },
            ))
        }
        Command::CompletePipelineChild {
            state,
            step_id,
            expected_task_revision,
            child,
            native_texts,
        } => {
            let mut parent = load(state)?;
            let child = load(child)?;
            if child.binding.owner != parent.binding.owner {
                return Err(ErrorCode::OwnerMismatch.into());
            }
            if child.run.trigger().and_then(RunTrigger::pipeline_parent)
                != Some((parent.run.id(), step_id.as_str()))
                || task_execution(&parent.run, &step_id) != Some(child.run.id())
            {
                return Err(ErrorCode::ForeignExecution.into());
            }
            let readable: BTreeSet<String> = core::child_output_references(&child.run)
                .into_iter()
                .map(|(step_id, _)| step_id)
                .collect();
            if native_texts.keys().any(|step| !readable.contains(step)) {
                return Err(ErrorCode::InvalidRequest.into());
            }
            let completion = core::child_completion(&child.run, &native_texts)
                .ok_or(ErrorCode::ChildNotEnded)?;
            let revision = parent.run.revision();
            Coordinator::complete_pipeline_task(
                &mut parent.run,
                revision,
                &step_id,
                expected_task_revision,
                child.run.id(),
                completion,
            )
            .map_err(domain_error)?;
            Ok(Transition::run(parent.run, parent.binding_text, changed()))
        }
    }
}

/// The lease of a sub-pipeline step as `lease_next_pipeline_step` returned
/// it, rebuilt from the frozen run with the same dependency hand-off.
fn leased_pipeline_step(
    run: &Run,
    step_id: &str,
    expected_task_revision: Revision,
    lease_id: &str,
) -> Result<PipelineStepLease, Failure> {
    if run.status() != RunStatus::Running {
        return Err(ErrorCode::InvalidTransition.into());
    }
    let step = run
        .definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == step_id)
        .ok_or(ErrorCode::InvalidTransition)?;
    let Some(StepExecutor::Pipeline {
        launch_command_id,
        inputs,
    }) = &step.executor
    else {
        return Err(ErrorCode::ExecutorMismatch.into());
    };
    let task = run
        .tasks()
        .iter()
        .find(|task| task.step_id() == step_id)
        .ok_or(ErrorCode::InvalidTransition)?;
    if task.revision() != expected_task_revision {
        return Err(ErrorCode::RevisionConflict.into());
    }
    if task.status() != TaskStatus::Ready {
        return Err(ErrorCode::InvalidTransition.into());
    }
    if task.lease_id() != Some(lease_id) {
        return Err(ErrorCode::LeaseConflict.into());
    }
    let dependencies = step
        .dependency_step_ids
        .iter()
        .map(|dependency| {
            let task = run.tasks().iter().find(|task| task.step_id() == dependency);
            ScriptDependency {
                step_id: dependency.clone(),
                reference: task.and_then(|task| task.result_reference().cloned()),
                text: task.and_then(|task| task.output().map(|output| output.text.clone())),
                data: task.and_then(|task| task.result_data().cloned()),
            }
        })
        .collect();
    Ok(PipelineStepLease {
        run_id: run.id().to_owned(),
        run_revision: run.revision(),
        task_revision: task.revision(),
        lease_id: lease_id.to_owned(),
        step_id: step.id.clone(),
        step_name: step.name.clone(),
        launch_command_id: launch_command_id.clone(),
        sources: inputs.clone(),
        run_inputs: run.inputs().clone(),
        dependencies,
        parent_trigger: run.trigger().cloned(),
    })
}

/// Native dependency texts a child input reads whole: the host resolves them
/// hash-verified (Desktop's `whole_text_dependencies`). Field selections are
/// cleared because the whole text is read.
fn required_texts(lease: &PipelineStepLease) -> Vec<ChildReference> {
    let whole: BTreeSet<&str> = lease
        .sources
        .values()
        .filter_map(|source| match source {
            SubpipelineInputSource::Step {
                step_id,
                field: None,
            } => Some(step_id.as_str()),
            _ => None,
        })
        .collect();
    lease
        .dependencies
        .iter()
        .filter(|dependency| {
            dependency.text.is_none() && whole.contains(dependency.step_id.as_str())
        })
        .filter_map(|dependency| {
            let mut reference = dependency.reference.clone()?;
            reference.fields.clear();
            Some(ChildReference {
                step_id: dependency.step_id.clone(),
                reference,
            })
        })
        .collect()
}

fn pipeline_lease(lease: PipelineStepLease) -> wire::PipelineLease {
    let required_texts = required_texts(&lease);
    wire::PipelineLease {
        run_id: lease.run_id,
        run_revision: lease.run_revision,
        task_revision: lease.task_revision,
        lease_id: lease.lease_id,
        step_id: lease.step_id,
        step_name: lease.step_name,
        launch_command_id: lease.launch_command_id,
        required_texts,
    }
}

/// Native Desktop's checks in its order (`plan_child_start`): resolved
/// dependency texts, nesting depth, launch-command cycles, child inputs, then
/// the child's admission. A refusal is certain because nothing started.
fn start_pipeline_child(
    parent: Loaded,
    step_id: &str,
    expected_task_revision: Revision,
    lease_id: &str,
    child_run_id: String,
    child: ChildDefinition,
    resolved_texts: &BTreeMap<String, String>,
) -> Result<Transition, Failure> {
    let Loaded {
        mut run,
        binding,
        binding_text,
    } = parent;
    if !binding.executors.pipeline {
        return Err(ErrorCode::UnsupportedExecutor.into());
    }
    if child_run_id.trim().is_empty() {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut lease = leased_pipeline_step(&run, step_id, expected_task_revision, lease_id)?;
    let required: BTreeSet<String> = required_texts(&lease)
        .into_iter()
        .map(|reference| reference.step_id)
        .collect();
    if resolved_texts.keys().any(|step| !required.contains(step)) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    if required
        .iter()
        .any(|step| !resolved_texts.contains_key(step))
    {
        return Err(Failure::child(
            core::SUBPIPELINE_INPUT_UNAVAILABLE,
            Vec::new(),
        ));
    }
    for dependency in &mut lease.dependencies {
        if let Some(text) = resolved_texts.get(&dependency.step_id) {
            dependency.text = Some(text.clone());
        }
    }
    let ChildDefinition {
        definition,
        profile_capabilities,
        pipelines,
    } = child;
    if definition
        .launch_command
        .as_ref()
        .map(|command| command.id.as_str())
        != Some(lease.launch_command_id.as_str())
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let trigger = lease
        .child_trigger()
        .map_err(|code| Failure::child(code, Vec::new()))?;
    // `ancestor_launch_commands` without other runs gives this run's own
    // commands; the frozen ancestry carries the runs above it.
    let mut ancestors = core::ancestor_launch_commands(&run, |_| None);
    ancestors.extend(binding.ancestry.iter().cloned());
    ancestors.dedup();
    let start = lease.launch_command_id.as_str();
    let child_pipeline = &definition.pipeline;
    let reachable = &pipelines;
    let pipeline_of = move |id: &str| -> Option<&PipelineDefinition> {
        if id == start {
            Some(child_pipeline)
        } else {
            reachable
                .iter()
                .find(|candidate| candidate.launch_command_id == id)
                .map(|candidate| &candidate.pipeline)
        }
    };
    if ancestors.iter().any(|ancestor| ancestor == start)
        || core::subpipeline_cycle(start, pipeline_of)
    {
        return Err(Failure::child(core::SUBPIPELINE_CYCLE, Vec::new()));
    }
    let inputs = core::resolve_child_inputs(&lease.sources, &lease.run_inputs, &lease.dependencies)
        .map_err(|code| Failure::child(code, Vec::new()))?;
    core::resolve_run_inputs(&definition.pipeline.inputs, &inputs)
        .map_err(|_| Failure::child(core::SUBPIPELINE_INPUT_INVALID, Vec::new()))?;
    if foreign_capabilities(&profile_capabilities, &definition) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let child_binding = Binding {
        binding_version: wire::BINDING_VERSION,
        run_id: child_run_id.clone(),
        owner: binding.owner.clone(),
        executors: binding.executors,
        profile_capabilities,
        ancestry: ancestors,
    };
    let refusals = core::definition_refusals(
        &definition,
        &child_binding.profile_capabilities,
        child_binding.executors,
    );
    if !refusals.is_empty() {
        return Err(Failure::child(core::SUBPIPELINE_UNAVAILABLE, refusals));
    }
    // A child never uses pinned data (ADR-042).
    let child_run = Coordinator::new_started_run(
        child_run_id.clone(),
        *definition,
        inputs,
        Some(trigger),
        core::RunOptions::default(),
    )
    .map_err(|_| Failure::child(core::SUBPIPELINE_UNAVAILABLE, Vec::new()))?;
    let revision = run.revision();
    Coordinator::dispatch_leased_script(
        &mut run,
        revision,
        step_id,
        expected_task_revision,
        lease_id,
        NativeExecutionReference {
            id: child_run_id.clone(),
        },
    )
    .map_err(domain_error)?;
    let child_binding =
        serde_json::to_string(&child_binding).map_err(|_| ErrorCode::SerializationFailed)?;
    Ok(Transition {
        state: Some(Stored {
            run,
            binding: binding_text,
        }),
        child: Some(Stored {
            run: child_run,
            binding: child_binding,
        }),
        effect: Effect::ChildStarted {
            step_id: step_id.to_owned(),
            child_run_id,
        },
    })
}

fn domain_error(error: CoordinatorError) -> Failure {
    match error {
        CoordinatorError::InvalidDefinition(_) | CoordinatorError::InvalidRunInput(_) => {
            ErrorCode::InvalidDefinition
        }
        CoordinatorError::RevisionConflict { .. } => ErrorCode::RevisionConflict,
        CoordinatorError::StaleExecution { .. } => ErrorCode::StaleExecution,
        CoordinatorError::LeaseConflict { .. } => ErrorCode::LeaseConflict,
        CoordinatorError::ExecutorMismatch { .. } => ErrorCode::ExecutorMismatch,
        _ => ErrorCode::InvalidTransition,
    }
    .into()
}

impl From<ScriptDependency> for HostDependency {
    fn from(value: ScriptDependency) -> Self {
        Self {
            step_id: value.step_id,
            reference: value.reference,
            text: value.text,
            data: value.data,
        }
    }
}

impl From<core::ScriptLease> for wire::ScriptLease {
    fn from(value: core::ScriptLease) -> Self {
        Self {
            run_id: value.run_id,
            run_revision: value.run_revision,
            task_revision: value.task_revision,
            lease_id: value.lease_id,
            step_id: value.step_id,
            step_name: value.step_name,
            runtime: value.runtime,
            source: value.source,
            timeout_seconds: value.timeout_seconds,
            inputs: value.inputs,
            dependencies: value.dependencies.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<core::PluginStepLease> for wire::PluginLease {
    fn from(value: core::PluginStepLease) -> Self {
        Self {
            run_id: value.run_id,
            run_revision: value.run_revision,
            task_revision: value.task_revision,
            lease_id: value.lease_id,
            step_id: value.step_id,
            step_name: value.step_name,
            plugin_id: value.plugin_id,
            node_type: value.node_type,
            config: value.config,
            inputs: value.inputs,
            dependencies: value.dependencies.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<AgentRequestAdmission> for AgentAdmission {
    fn from(value: AgentRequestAdmission) -> Self {
        match value {
            AgentRequestAdmission::Roster {
                members,
                spawn_profiles,
            } => Self::Roster {
                members: members
                    .into_iter()
                    .map(|member| wire::ReachableMember {
                        member_id: member.member_id,
                        profile_id: member.profile_id,
                        harness: member.harness,
                        can_send: member.can_send,
                        can_observe: member.can_observe,
                    })
                    .collect(),
                spawn_profiles,
            },
            AgentRequestAdmission::Send {
                message_id,
                recipient_member_id,
                body,
                already_delivered,
            } => Self::Send {
                message_id,
                recipient_member_id,
                body,
                already_delivered,
            },
            AgentRequestAdmission::Observe {
                member_id,
                history_references,
            } => Self::Observe {
                member_id,
                history_references,
            },
            AgentRequestAdmission::Spawn { lease } => Self::Spawn {
                lease: Box::new(lease.into()),
            },
            AgentRequestAdmission::SpawnCommitted {
                step_id,
                member_id,
                workspace_session_id,
            } => Self::SpawnCommitted {
                step_id,
                member_id,
                execution: NativeExecutionReference {
                    id: workspace_session_id,
                },
            },
        }
    }
}

#[cfg(test)]
mod tests;
