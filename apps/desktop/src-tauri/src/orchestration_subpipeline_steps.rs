//! Sub-pipeline steps in the scheduler (orchestration v6.7, ADR-042).
//!
//! Admission leases the step under the operation gate like a script or a
//! plugin node. The start then resolves the native dependency texts the
//! child inputs read (hash-verified), and in one durable transaction checks
//! the launch command, depth, cycles and child inputs against the current
//! definitions, creates the ordinary child run and dispatches the parent
//! task under the child run id. Every refusal before the child exists is
//! certain. The parent's scheduling pass does not wait for the child: the
//! child is scheduled on its own task and `SubpipelineEngine` completes the
//! parent step when the child ends. A cancellation cancels the child first
//! (`cancel_scope`). Only metadata is logged.

use super::*;
use crate::subpipelines::ChildStartError;
use piui_orchestration::{
    PipelineStepLease, SUBPIPELINE_INPUT_UNAVAILABLE, SubpipelineInputSource,
};
use std::collections::BTreeSet;

/// A sub-pipeline admission decided under the operation gate.
pub(super) enum PipelineAdmission {
    Leased {
        lease: Box<PipelineStepLease>,
        run: Box<Run>,
    },
    /// Nothing was leased; `error` is the scheduling pass's result.
    Rejected {
        error: OrchestrationSchedulerError,
    },
    Idle,
}

/// Leases the next ready sub-pipeline step. Its reference, depth, cycles
/// and inputs are checked when the child is created, in the same
/// transaction.
pub(super) fn admit_pipeline_step(
    api: &OrchestrationApiState,
    workspace_id: &str,
    run: &Run,
    step: &PipelineStep,
    lease_id: String,
) -> PipelineAdmission {
    let conflict = || PipelineAdmission::Rejected {
        error: OrchestrationSchedulerError::conflict(),
    };
    let lease = match api.lease_next_pipeline_step(workspace_id, run.id(), run.revision(), lease_id)
    {
        Ok(Some(lease)) => lease,
        Ok(None) => return PipelineAdmission::Idle,
        Err(_) => return conflict(),
    };
    // Defense in depth: the revision check should make this exact.
    if lease.step_id != step.id {
        return conflict();
    }
    match api.get_run(workspace_id, run.id()) {
        Ok(Some(run)) => PipelineAdmission::Leased {
            lease: Box::new(lease),
            run: Box::new(run),
        },
        _ => conflict(),
    }
}

/// Direct dependencies whose whole result text a child input reads.
fn whole_text_dependencies(lease: &PipelineStepLease) -> BTreeSet<String> {
    lease
        .sources
        .values()
        .filter_map(|source| match source {
            SubpipelineInputSource::Step {
                step_id,
                field: None,
            } => Some(step_id.clone()),
            _ => None,
        })
        .collect()
}

impl OrchestrationScheduler {
    /// Starts one leased sub-pipeline step: its child run is created and the
    /// parent task dispatched under the child run id atomically, then the
    /// child is scheduled on its own task.
    pub(super) async fn launch_pipeline_step<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        mut lease: PipelineStepLease,
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
                // Nothing started: the step returns to ready.
                if let Ok(run) = api.release_script_lease(workspace_id, &lease) {
                    self.emit_run_invalidation(app, workspace_id, &run);
                }
                return Err(other
                    .err()
                    .unwrap_or_else(OrchestrationSchedulerError::conflict));
            }
        };
        let needed = whole_text_dependencies(&lease);
        for index in 0..lease.dependencies.len() {
            let dependency = &lease.dependencies[index];
            if dependency.text.is_some() || !needed.contains(&dependency.step_id) {
                continue;
            }
            let Some(mut reference) = dependency.reference.clone() else {
                continue;
            };
            reference.fields.clear();
            match host
                .workspace
                .dependency_text(&reference, workspace_id, directory.canonical_path())
                .await
            {
                Ok(text) => lease.dependencies[index].text = Some(text),
                Err(_) => {
                    if let Ok(run) = api.reject_leased_script(
                        workspace_id,
                        &lease,
                        SUBPIPELINE_INPUT_UNAVAILABLE,
                    ) {
                        self.emit_run_invalidation(app, workspace_id, &run);
                    }
                    log_refusal(&lease, SUBPIPELINE_INPUT_UNAVAILABLE);
                    return Err(OrchestrationSchedulerError::new(
                        SUBPIPELINE_INPUT_UNAVAILABLE,
                    ));
                }
            }
        }
        let child_run_id = host.workspace.allocate_orchestration_session_id();
        let child = match api.start_pipeline_child(workspace_id, &lease, child_run_id) {
            Ok((parent, child)) => {
                self.emit_run_invalidation(app, workspace_id, &parent);
                self.emit_run_invalidation(app, workspace_id, &child);
                child
            }
            Err(ChildStartError::Refused(code)) => {
                if let Ok(run) = api.reject_leased_script(workspace_id, &lease, code) {
                    self.emit_run_invalidation(app, workspace_id, &run);
                }
                log_refusal(&lease, code);
                return Err(OrchestrationSchedulerError::new(code));
            }
            Err(ChildStartError::Conflict) => {
                if let Ok(run) = api.release_script_lease(workspace_id, &lease) {
                    self.emit_run_invalidation(app, workspace_id, &run);
                }
                return Err(OrchestrationSchedulerError::conflict());
            }
        };
        eprintln!(
            "event=subpipeline_child_started run_id={:?} step_id={:?} child_run_id={:?} depth={}",
            lease.run_id,
            lease.step_id,
            child.id(),
            child.subpipeline_depth()
        );
        drop(operation);
        // The child is an ordinary run with its own gate and scheduling.
        self.spawn_reschedule(app.clone(), workspace_id.to_owned(), child.id().to_owned());
        Ok(())
    }
}

fn log_refusal(lease: &PipelineStepLease, code: &str) {
    eprintln!(
        "event=subpipeline_child_refused run_id={:?} step_id={:?} code={code}",
        lease.run_id, lease.step_id
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_whole_text_sources_need_native_text() {
        let mut sources = std::collections::BTreeMap::new();
        sources.insert(
            "notes".to_owned(),
            SubpipelineInputSource::Step {
                step_id: "collect".into(),
                field: None,
            },
        );
        sources.insert(
            "count".to_owned(),
            SubpipelineInputSource::Step {
                step_id: "count".into(),
                field: Some("count".into()),
            },
        );
        sources.insert(
            "strict".to_owned(),
            SubpipelineInputSource::Value {
                value: serde_json::json!(true),
            },
        );
        let lease = PipelineStepLease {
            run_id: "run".into(),
            run_revision: 1,
            task_revision: 1,
            lease_id: "lease".into(),
            step_id: "test".into(),
            step_name: "Test".into(),
            launch_command_id: "testing".into(),
            sources,
            run_inputs: std::collections::BTreeMap::new(),
            dependencies: Vec::new(),
            parent_trigger: None,
        };
        assert_eq!(
            whole_text_dependencies(&lease),
            BTreeSet::from(["collect".to_owned()])
        );
    }
}
