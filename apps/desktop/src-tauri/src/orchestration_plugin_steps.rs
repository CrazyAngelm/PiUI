//! Plugin node steps in the scheduler (orchestration v6.5, ADR-032).
//!
//! Admission, leasing, dispatch, cancellation and uncertainty follow script
//! steps exactly: the plugin (active, verified, `node.run`, the node type)
//! and the node configuration are checked before the lease, native
//! dependency results are resolved (hash-verified) before dispatch, and the
//! task becomes running only immediately before `node/run` is sent. A
//! cancellation, a lost trust decision or shutdown stops the plugin's
//! backend; a backend that stops mid-run leaves the step uncertain and it is
//! never replayed. Only metadata is logged.

use super::*;
use crate::plugins::{CallError, NodeSpec, PluginsState};
use piui_orchestration::{
    PLUGIN_CONFIG_INVALID, PLUGIN_INPUT_UNAVAILABLE, PLUGIN_NODE_FAILED, PLUGIN_NODE_TIMEOUT,
    PLUGIN_START_FAILED, PLUGIN_UNAVAILABLE, PluginStepLease,
};
use piui_plugins::fields::resolve_values;

/// Most node output kept, like a script's stdout.
const MAX_NODE_OUTPUT_BYTES: usize = piui_orchestration::MAX_SCRIPT_STDOUT_BYTES;

type Config = serde_json::Map<String, serde_json::Value>;

/// A plugin step admission decided under the operation gate.
pub(super) enum PluginAdmission {
    Leased {
        lease: Box<PluginStepLease>,
        spec: Box<NodeSpec>,
        config: Config,
        run: Box<Run>,
    },
    /// A certain failure before anything ran; `run` is the recorded state.
    Rejected {
        run: Option<Box<Run>>,
        error: OrchestrationSchedulerError,
    },
    Idle,
}

/// A dispatched plugin step, ready for `node/run`.
pub(super) struct PluginLaunch {
    pub(super) workspace_id: String,
    pub(super) execution_id: String,
    pub(super) run_id: String,
    pub(super) step_id: String,
    plugin_id: String,
    node_type: String,
    spec: NodeSpec,
    pub(super) params: serde_json::Value,
    project_dir: std::path::PathBuf,
    result_fields: Vec<piui_orchestration::ResultField>,
}

/// Checks the plugin and the node configuration of the next ready plugin
/// step, then leases it. Every refusal is certain: nothing ran.
pub(super) fn admit_plugin_step(
    plugins: Option<&PluginsState>,
    api: &OrchestrationApiState,
    workspace_id: &str,
    run: &Run,
    step: &PipelineStep,
    task_revision: u64,
    lease_id: String,
) -> PluginAdmission {
    let conflict = || PluginAdmission::Rejected {
        run: None,
        error: OrchestrationSchedulerError::conflict(),
    };
    let reject = |code: &'static str| PluginAdmission::Rejected {
        run: api
            .reject_ready_task(
                workspace_id,
                run.id(),
                &step.id,
                task_revision,
                code.to_owned(),
            )
            .ok()
            .map(Box::new),
        error: OrchestrationSchedulerError::new(code),
    };
    let Some(StepExecutor::Plugin {
        plugin_id,
        node_type,
        config,
    }) = &step.executor
    else {
        return conflict();
    };
    let Some(spec) = plugins.and_then(|plugins| plugins.node_spec(plugin_id, node_type)) else {
        return reject(PLUGIN_UNAVAILABLE);
    };
    let Ok(config) = resolve_values(&spec.fields, config) else {
        return reject(PLUGIN_CONFIG_INVALID);
    };
    let lease = match api.lease_next_plugin_step(workspace_id, run.id(), run.revision(), lease_id) {
        Ok(Some(lease)) => lease,
        Ok(None) => return PluginAdmission::Idle,
        Err(_) => return conflict(),
    };
    if lease.step_id != step.id {
        return conflict();
    }
    match api.get_run(workspace_id, run.id()) {
        Ok(Some(run)) => PluginAdmission::Leased {
            lease: Box::new(lease),
            spec: Box::new(spec),
            config,
            run: Box::new(run),
        },
        _ => conflict(),
    }
}

/// Resolves native dependency results (hash-verified, never copied into the
/// run) and marks the task running under `execution_id`. Every failure here
/// is certain: the task is rejected or its lease released.
#[allow(clippy::too_many_arguments)]
pub(super) async fn prepare_plugin_step(
    host: &HostState,
    api: &OrchestrationApiState,
    workspace_id: &str,
    directory: &piui_platform::ProjectDirectory,
    mut lease: PluginStepLease,
    spec: NodeSpec,
    config: Config,
    execution_id: String,
) -> Result<(PluginLaunch, Run), (Option<Run>, OrchestrationSchedulerError)> {
    for index in 0..lease.dependencies.len() {
        let Some(reference) = lease.dependencies[index].reference.clone() else {
            continue;
        };
        match host
            .workspace
            .dependency_text(&reference, workspace_id, directory.canonical_path())
            .await
        {
            Ok(text) => lease.dependencies[index].text = Some(text),
            Err(_) => {
                let run = api
                    .reject_leased_script(workspace_id, &lease, PLUGIN_INPUT_UNAVAILABLE)
                    .ok();
                return Err((
                    run,
                    OrchestrationSchedulerError::new(PLUGIN_INPUT_UNAVAILABLE),
                ));
            }
        }
    }
    let run = match api.commit_script_lease(workspace_id, &lease, execution_id.clone()) {
        Ok(run) => run,
        Err(_) => {
            let run = api.release_script_lease(workspace_id, &lease).ok();
            return Err((run, OrchestrationSchedulerError::conflict()));
        }
    };
    let result_fields = run
        .definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == lease.step_id)
        .map(|step| step.result_fields.clone())
        .unwrap_or_default();
    let mut params = lease.node_run_params();
    params["config"] = serde_json::Value::Object(config);
    if spec.project_access {
        params["project"] = json!({
            "path": piui_runtime::script_runner::process_directory(directory.canonical_path()).to_string_lossy()
        });
    }
    Ok((
        PluginLaunch {
            workspace_id: workspace_id.to_owned(),
            execution_id,
            run_id: lease.run_id.clone(),
            step_id: lease.step_id.clone(),
            plugin_id: lease.plugin_id.clone(),
            node_type: lease.node_type.clone(),
            spec,
            params,
            project_dir: directory.canonical_path().to_path_buf(),
            result_fields,
        },
        run,
    ))
}

/// Sends `node/run` and maps what the supervisor observed to what the run
/// records.
pub(super) async fn execute_plugin_step(
    plugins: Option<&PluginsState>,
    launch: &PluginLaunch,
    cancel: watch::Receiver<bool>,
) -> ScriptResolution {
    let started = std::time::Instant::now();
    let result = match plugins {
        Some(plugins) => {
            plugins
                .supervisor()
                .call(
                    &launch.spec.backend,
                    "node/run",
                    launch.params.clone(),
                    launch.spec.timeout,
                    Some(cancel),
                )
                .await
        }
        None => Err(CallError::NotStarted(crate::plugins::StartFailure::Failed)),
    };
    eprintln!(
        "event=orchestration_plugin_node_ended step_id={:?} plugin_id={:?} node_type={:?} outcome={} duration_ms={}",
        launch.step_id,
        launch.plugin_id,
        launch.node_type,
        match &result {
            Ok(_) => "answered",
            Err(CallError::Remote(_)) => "error",
            Err(CallError::Timeout) => "timed-out",
            Err(CallError::Cancelled) => "cancelled",
            Err(CallError::NotStarted(_)) => "not-started",
            Err(CallError::Lost) => "lost",
        },
        started.elapsed().as_millis()
    );
    plugin_resolution(&launch.project_dir, &launch.result_fields, result).await
}

impl OrchestrationScheduler {
    /// Starts one leased plugin step. The task becomes running only
    /// immediately before `node/run` is sent, so a restart can never replay
    /// a node that may have run: it becomes uncertain.
    pub(super) async fn launch_plugin_step<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        lease: PluginStepLease,
        spec: NodeSpec,
        config: Config,
    ) -> Result<(), OrchestrationSchedulerError> {
        let host = app.state::<HostState>();
        let operation = host.live_runtime_operation_gate.lock().await;
        let api = app.state::<OrchestrationApiState>();
        let directory = match authorize_live_workspace(&host, workspace_id) {
            Ok(directory)
                if self.admits_work() && !self.is_run_cancelling(workspace_id, &lease.run_id) =>
            {
                directory
            }
            other => {
                if let Ok(run) = api.release_script_lease(workspace_id, &lease) {
                    self.emit_run_invalidation(app, workspace_id, &run);
                }
                return Err(other
                    .err()
                    .unwrap_or_else(OrchestrationSchedulerError::conflict));
            }
        };
        let execution_id = host.workspace.allocate_orchestration_session_id();
        let launch = match prepare_plugin_step(
            &host,
            &api,
            workspace_id,
            &directory,
            lease,
            spec,
            config,
            execution_id,
        )
        .await
        {
            Ok((launch, run)) => {
                self.emit_run_invalidation(app, workspace_id, &run);
                launch
            }
            Err((run, error)) => {
                if let Some(run) = run {
                    self.emit_run_invalidation(app, workspace_id, &run);
                }
                return Err(error);
            }
        };
        let (cancel, cancel_receiver) = watch::channel(false);
        let (ended, ended_receiver) = watch::channel(None);
        let active = ActiveScript {
            cancel: Arc::new(cancel),
            ended: ended_receiver,
        };
        if self
            .insert_script(launch.execution_id.clone(), active.clone())
            .is_err()
        {
            // Nothing was sent under this id: a certain start failure.
            if let Ok(run) = api.record_script_outcome(
                workspace_id,
                &launch.run_id,
                &launch.step_id,
                &launch.execution_id,
                ScriptCompletion::Failed {
                    failure: FailureRecord::new(PLUGIN_START_FAILED),
                },
            ) {
                self.emit_run_invalidation(app, workspace_id, &run);
            }
            return Err(OrchestrationSchedulerError::conflict());
        }
        drop(operation);
        let scheduler = self.clone();
        let app = app.clone();
        tokio::spawn(async move {
            scheduler
                .watch_plugin_step(app, launch, active.cancel, cancel_receiver, ended)
                .await;
        });
        Ok(())
    }

    /// Runs a started plugin step to its end and records what the host
    /// observed. Cancellation (a person, shutdown or lost trust) stops the
    /// backend; the cancelling path owns that transition.
    async fn watch_plugin_step<R: Runtime>(
        &self,
        app: AppHandle<R>,
        launch: PluginLaunch,
        cancel: Arc<watch::Sender<bool>>,
        cancel_receiver: watch::Receiver<bool>,
        ended: watch::Sender<Option<ScriptEnd>>,
    ) {
        let guard = {
            let scheduler = self.clone();
            let app = app.clone();
            let workspace_id = launch.workspace_id.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(SCRIPT_TRUST_POLL).await;
                    if !scheduler.admits_work()
                        || authorize_live_workspace(&app.state::<HostState>(), &workspace_id)
                            .is_err()
                    {
                        cancel.send_replace(true);
                        return;
                    }
                }
            })
        };
        let plugins = app.try_state::<PluginsState>();
        let resolution = execute_plugin_step(plugins.as_deref(), &launch, cancel_receiver).await;
        guard.abort();
        let completion = match resolution {
            ScriptResolution::Stopped => {
                ended.send_replace(Some(ScriptEnd::Stopped));
                self.remove_script(&launch.execution_id);
                return;
            }
            ScriptResolution::Unobserved => {
                ended.send_replace(Some(ScriptEnd::Unobserved));
                self.mark_plugin_uncertain(&app, &launch).await;
                self.remove_script(&launch.execution_id);
                return;
            }
            ScriptResolution::Record(completion) => completion,
        };
        ended.send_replace(Some(ScriptEnd::Completed {
            succeeded: matches!(completion, ScriptCompletion::Exited { .. }),
        }));
        let recorded = {
            let host = app.state::<HostState>();
            let _operation = host.live_runtime_operation_gate.lock().await;
            if authorize_live_workspace(&host, &launch.workspace_id).is_err() {
                self.remove_script(&launch.execution_id);
                return;
            }
            app.state::<OrchestrationApiState>().record_script_outcome(
                &launch.workspace_id,
                &launch.run_id,
                &launch.step_id,
                &launch.execution_id,
                completion,
            )
        };
        self.remove_script(&launch.execution_id);
        if let Ok(run) = recorded {
            self.emit_run_invalidation(&app, &launch.workspace_id, &run);
            self.spawn_reschedule(app, launch.workspace_id, launch.run_id);
        }
    }

    async fn mark_plugin_uncertain<R: Runtime>(&self, app: &AppHandle<R>, launch: &PluginLaunch) {
        let host = app.state::<HostState>();
        let _operation = host.live_runtime_operation_gate.lock().await;
        if authorize_live_workspace(&host, &launch.workspace_id).is_err() {
            return;
        }
        let api = app.state::<OrchestrationApiState>();
        let Ok(Some(current)) = api.get_run(&launch.workspace_id, &launch.run_id) else {
            return;
        };
        let Some(task) = current.tasks().iter().find(|task| {
            task.step_id() == launch.step_id
                && task
                    .execution()
                    .is_some_and(|execution| execution.id == launch.execution_id)
        }) else {
            return;
        };
        if let Ok(run) = api.mark_task_uncertain(
            &launch.workspace_id,
            &launch.run_id,
            current.revision(),
            &launch.step_id,
            task.revision(),
            UncertaintyIdentity::Execution(launch.execution_id.clone()),
        ) {
            self.emit_run_invalidation(app, &launch.workspace_id, &run);
        }
    }
}

/// Maps what the supervisor observed to what a run records. An answer is
/// checked like a script's stdout (declared artifact fields included).
pub(super) async fn plugin_resolution(
    project_dir: &std::path::Path,
    result_fields: &[piui_orchestration::ResultField],
    result: Result<serde_json::Value, CallError>,
) -> ScriptResolution {
    let failed = |failure| ScriptResolution::Record(ScriptCompletion::Failed { failure });
    match result {
        Ok(answer) => {
            let output = match answer.get("output") {
                Some(serde_json::Value::String(text)) => text.clone(),
                Some(object @ serde_json::Value::Object(_)) => object.to_string(),
                _ => {
                    return failed(FailureRecord::with_detail(
                        PLUGIN_NODE_FAILED,
                        "The node's answer has no output text or object.",
                    ));
                }
            };
            let (stdout, truncated) =
                piui_orchestration::bounded_text(output, MAX_NODE_OUTPUT_BYTES);
            if validate_artifact_files(project_dir, result_fields, &stdout)
                .await
                .is_err()
            {
                failed(FailureRecord::new("result-artifact-unavailable"))
            } else {
                ScriptResolution::Record(ScriptCompletion::Exited { stdout, truncated })
            }
        }
        Err(CallError::Remote(message)) => {
            failed(FailureRecord::with_detail(PLUGIN_NODE_FAILED, &message))
        }
        Err(CallError::Timeout) => failed(FailureRecord::new(PLUGIN_NODE_TIMEOUT)),
        Err(CallError::Cancelled) => ScriptResolution::Stopped,
        Err(CallError::NotStarted(_)) => failed(FailureRecord::new(PLUGIN_START_FAILED)),
        Err(CallError::Lost) => ScriptResolution::Unobserved,
    }
}

#[cfg(test)]
#[path = "orchestration_plugin_step_tests.rs"]
mod tests;
