use crate::coordinator::{check_run_revision, refresh_status};
use crate::{
    CompletionOutcome, Coordinator, CoordinatorError, FailureRecord, PipelineStep, Revision, Run,
    RunStatus, TaskStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultCondition {
    pub source_step_id: String,
    pub field: String,
    pub equals: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum RouterPredicate {
    Equals { field: String, value: Value },
    Exists { field: String },
    All { predicates: Vec<RouterPredicate> },
    Any { predicates: Vec<RouterPredicate> },
    Not { predicate: Box<RouterPredicate> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouterBranch {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predicate: Option<RouterPredicate>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouterMode {
    Program,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouterConfig {
    pub mode: RouterMode,
    pub input_step_id: String,
    pub branches: Vec<RouterBranch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_field: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteGate {
    pub router_step_id: String,
    pub branch_id: String,
}

pub(crate) fn evaluate_router_predicate(predicate: &RouterPredicate, input: &Value) -> bool {
    match predicate {
        RouterPredicate::Equals { field, value } => input.get(field) == Some(value),
        RouterPredicate::Exists { field } => input.get(field).is_some(),
        RouterPredicate::All { predicates } => predicates
            .iter()
            .all(|predicate| evaluate_router_predicate(predicate, input)),
        RouterPredicate::Any { predicates } => predicates
            .iter()
            .any(|predicate| evaluate_router_predicate(predicate, input)),
        RouterPredicate::Not { predicate } => !evaluate_router_predicate(predicate, input),
    }
}

pub(crate) fn program_router_selection(
    config: &RouterConfig,
    input: &Value,
) -> Result<Vec<String>, &'static str> {
    let mut selected = Vec::new();
    for branch in &config.branches {
        let predicate = branch
            .predicate
            .as_ref()
            .ok_or("router-predicate-missing")?;
        if evaluate_router_predicate(predicate, input) {
            selected.push(branch.id.clone());
        }
    }
    Ok(selected)
}

pub(crate) fn agent_router_selection(
    config: &RouterConfig,
    data: &Value,
) -> Result<Vec<String>, &'static str> {
    let field = config
        .selection_field
        .as_deref()
        .unwrap_or("selectedBranchIds");
    let values = data
        .get(field)
        .and_then(Value::as_array)
        .ok_or("router-selection-invalid")?;
    let known = config
        .branches
        .iter()
        .map(|branch| branch.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut selected = Vec::new();
    for value in values {
        let id = value.as_str().ok_or("router-selection-invalid")?;
        if !known.contains(id) || selected.iter().any(|item| item == id) {
            return Err("router-selection-invalid");
        }
        selected.push(id.to_owned());
    }
    Ok(selected)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewRule {
    pub field: String,
    pub retry_from_step_id: String,
    /// Upper bound on review rounds (1-20, v6.1). A rejection that would start
    /// another round beyond it waits for a person instead. `None` is unbounded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FlowAction {
    Pause,
    Resume,
    Decide {
        step_id: String,
        task_revision: Revision,
        approved: bool,
    },
    Repeat {
        step_id: String,
        task_revision: Revision,
    },
}

impl Coordinator {
    /// Host calls only after native interruption is proven (or before launch).
    pub fn cancel_task(
        run: &mut Run,
        revision: Revision,
        step_id: &str,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, revision)?;
        let task = run
            .tasks
            .iter_mut()
            .find(|task| task.step_id == step_id)
            .ok_or(CoordinatorError::UnknownTask {
                step_id: step_id.into(),
            })?;
        if !matches!(
            task.status,
            TaskStatus::Ready | TaskStatus::Running | TaskStatus::AwaitingApproval
        ) {
            return Err(CoordinatorError::InvalidRunData {
                reason: "task is already terminal",
            });
        }
        task.status = TaskStatus::Cancelled;
        task.lease_id = None;
        task.revision += 1;
        loop {
            let blocked = run
                .definition
                .pipeline
                .steps
                .iter()
                .filter(|step| {
                    step.dependency_step_ids.iter().any(|id| {
                        run.tasks
                            .iter()
                            .any(|task| task.step_id == *id && task.status == TaskStatus::Cancelled)
                    })
                })
                .map(|step| step.id.clone())
                .collect::<BTreeSet<_>>();
            let mut changed = false;
            for task in &mut run.tasks {
                if task.status == TaskStatus::Ready && blocked.contains(&task.step_id) {
                    task.status = TaskStatus::Cancelled;
                    task.revision += 1;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        run.revision += 1;
        refresh_status(run);
        Ok(())
    }
    pub fn control_flow(
        run: &mut Run,
        revision: Revision,
        action: FlowAction,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, revision)?;
        match action {
            FlowAction::Pause | FlowAction::Resume => {
                if run.status != RunStatus::Running {
                    return Err(CoordinatorError::RunNotActive { status: run.status });
                }
                run.paused = matches!(action, FlowAction::Pause);
            }
            FlowAction::Decide {
                step_id,
                task_revision,
                approved,
            } => {
                let task = run
                    .tasks
                    .iter_mut()
                    .find(|task| task.step_id == step_id)
                    .ok_or(CoordinatorError::UnknownTask {
                        step_id: step_id.clone(),
                    })?;
                if task.revision != task_revision || task.status != TaskStatus::AwaitingApproval {
                    return Err(CoordinatorError::InvalidRunData {
                        reason: "decision is stale",
                    });
                }
                task.status = if approved {
                    TaskStatus::Succeeded
                } else {
                    TaskStatus::Failed
                };
                // Approval accepts the recorded result, including one held back
                // by a review loop limit.
                task.failure = (!approved).then(|| FailureRecord::new("result-rejected"));
                task.revision += 1;
            }
            FlowAction::Repeat {
                step_id,
                task_revision,
            } => {
                let task = run
                    .tasks
                    .iter()
                    .find(|task| task.step_id == step_id)
                    .ok_or(CoordinatorError::UnknownTask {
                        step_id: step_id.clone(),
                    })?;
                if task.revision != task_revision
                    || !matches!(
                        task.status,
                        TaskStatus::Succeeded
                            | TaskStatus::Failed
                            | TaskStatus::Cancelled
                            | TaskStatus::AwaitingApproval
                    )
                {
                    return Err(CoordinatorError::InvalidRunData {
                        reason: "repeat requires a reconciled terminal attempt",
                    });
                }
                repeat_from(run, &step_id)?;
            }
        }
        advance_conditions(run);
        run.revision += 1;
        refresh_status(run);
        Ok(())
    }

    /// Only the host may supply text read from the native execution. JSON results
    /// are task data; they do not establish tool permissions or prove test success.
    #[allow(clippy::too_many_arguments)]
    pub fn complete_checked_task(
        run: &mut Run,
        revision: Revision,
        step_id: &str,
        task_revision: Revision,
        execution_id: &str,
        outcome: CompletionOutcome,
        text: Option<&str>,
    ) -> Result<(), CoordinatorError> {
        let step = run
            .definition
            .pipeline
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .cloned()
            .ok_or(CoordinatorError::UnknownTask {
                step_id: step_id.into(),
            })?;
        if step.is_host_executed() {
            return Err(CoordinatorError::ExecutorMismatch {
                step_id: step_id.into(),
            });
        }
        let mut data = None;
        let outcome = if matches!(outcome, CompletionOutcome::Succeeded { .. }) {
            match crate::validate_result(&step.result_fields, text.unwrap_or("")) {
                Ok(()) => {
                    data = text
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .filter(Value::is_object);
                    if let Some(router) = step
                        .router
                        .as_ref()
                        .filter(|router| router.mode == RouterMode::Agent)
                    {
                        match data.as_ref() {
                            Some(value) => match crate::agent_router_selection(router, value) {
                                Ok(selected) => {
                                    if let Some(object) =
                                        data.as_mut().and_then(Value::as_object_mut)
                                    {
                                        let field = router
                                            .selection_field
                                            .as_deref()
                                            .unwrap_or("selectedBranchIds");
                                        object.insert(
                                            field.into(),
                                            Value::Array(
                                                selected.into_iter().map(Value::String).collect(),
                                            ),
                                        );
                                    }
                                    outcome
                                }
                                Err(code) => CompletionOutcome::Failed {
                                    failure: FailureRecord::new(code),
                                },
                            },
                            None => CompletionOutcome::Failed {
                                failure: FailureRecord::new("router-selection-invalid"),
                            },
                        }
                    } else {
                        outcome
                    }
                }
                Err(code) => CompletionOutcome::Failed {
                    failure: FailureRecord::new(code),
                },
            }
        } else {
            outcome
        };
        Self::complete_task(run, revision, step_id, task_revision, execution_id, outcome)?;
        let index = run
            .tasks
            .iter()
            .position(|task| task.step_id == step_id)
            .ok_or(CoordinatorError::UnknownTask {
                step_id: step_id.into(),
            })?;
        run.tasks[index].result_data = data;
        settle_result(run, index, &step);
        Ok(())
    }
}

/// Applies a completed task's review rule or human acceptance, then advances
/// conditions. Shared by native and host-executed (script) completions.
pub(crate) fn settle_result(run: &mut Run, index: usize, step: &PipelineStep) {
    let step_id = step.id.as_str();
    if run.tasks[index].status == TaskStatus::Succeeded {
        if let Some(review) = &step.review {
            match run.tasks[index]
                .result_data
                .as_ref()
                .and_then(|value| value.get(&review.field))
                .and_then(Value::as_bool)
            {
                Some(false) if review_limit_reached(run, step_id, review) => {
                    // Another round would exceed the bound: keep the last
                    // result and let a person approve, reject or repeat.
                    run.tasks[index].status = TaskStatus::AwaitingApproval;
                    run.tasks[index].failure = Some(FailureRecord::new("review-limit-reached"));
                }
                Some(false) => {
                    let repeated = run
                        .attempts
                        .iter()
                        .rev()
                        .find(|task| task.step_id == step_id)
                        .is_some_and(|task| task.result_data == run.tasks[index].result_data);
                    if repeat_from(run, &review.retry_from_step_id).is_err() {
                        run.tasks[index].status = TaskStatus::Failed;
                        run.tasks[index].failure =
                            Some(FailureRecord::new("review-retry-conflict"));
                    }
                    if repeated {
                        run.paused = true;
                    }
                }
                Some(true) => {
                    if step.require_approval {
                        run.tasks[index].status = TaskStatus::AwaitingApproval;
                    }
                }
                None => {
                    run.tasks[index].status = TaskStatus::Failed;
                    run.tasks[index].failure = Some(FailureRecord::new("review-verdict-missing"));
                }
            }
        } else if step.require_approval {
            run.tasks[index].status = TaskStatus::AwaitingApproval;
        }
    }
    advance_conditions(run);
    refresh_status(run);
}

/// Whether a rejection completing a review round has used up the rule's bound.
/// Rounds are this reviewer's archived attempts that returned a result, plus
/// the one completing now; interrupted or uncertain attempts are not rounds.
fn review_limit_reached(run: &Run, step_id: &str, review: &ReviewRule) -> bool {
    let rounds = run
        .attempts
        .iter()
        .filter(|task| {
            task.step_id == step_id
                && matches!(
                    task.status,
                    TaskStatus::Succeeded | TaskStatus::AwaitingApproval
                )
        })
        .count()
        .saturating_add(1);
    review
        .max_iterations
        .and_then(|limit| usize::try_from(limit).ok())
        .is_some_and(|limit| rounds >= limit)
}

fn repeat_from(run: &mut Run, step_id: &str) -> Result<(), CoordinatorError> {
    let mut affected = BTreeSet::from([step_id.to_owned()]);
    loop {
        let before = affected.len();
        for step in &run.definition.pipeline.steps {
            if step
                .dependency_step_ids
                .iter()
                .any(|id| affected.contains(id))
            {
                affected.insert(step.id.clone());
            }
        }
        if affected.len() == before {
            break;
        }
    }
    if run.tasks.iter().any(|task| {
        affected.contains(&task.step_id)
            && (matches!(task.status, TaskStatus::Running | TaskStatus::Uncertain)
                || task.lease_id.is_some())
    }) {
        return Err(CoordinatorError::InvalidRunData {
            reason: "repeat would overwrite active or uncertain work",
        });
    }
    for task in &mut run.tasks {
        if affected.contains(&task.step_id) {
            if task.execution.is_some() {
                run.attempts.push(task.clone());
            }
            task.status = TaskStatus::Ready;
            task.execution = None;
            task.result_reference = None;
            task.result_data = None;
            task.failure = None;
            task.output = None;
            task.revision += 1;
        }
    }
    run.status = RunStatus::Running;
    Ok(())
}

pub(crate) fn advance_conditions(run: &mut Run) {
    loop {
        let skipped = run
            .definition
            .pipeline
            .steps
            .iter()
            .filter_map(|step| {
                let task = run.tasks.iter().find(|task| task.step_id == step.id)?;
                if task.status != TaskStatus::Ready || task.lease_id.is_some() {
                    return None;
                }
                let inherited_skip = step.dependency_step_ids.iter().any(|id| {
                    run.tasks
                        .iter()
                        .any(|task| task.step_id == *id && task.status == TaskStatus::Skipped)
                });
                let false_condition = step.condition.as_ref().is_some_and(|condition| {
                    run.tasks
                        .iter()
                        .find(|task| task.step_id == condition.source_step_id)
                        .is_some_and(|source| {
                            source.status == TaskStatus::Succeeded
                                && source
                                    .result_data
                                    .as_ref()
                                    .and_then(|value| value.get(&condition.field))
                                    != Some(&condition.equals)
                        })
                });
                let route_not_selected = !step.route_gates.is_empty()
                    && step
                        .route_gates
                        .iter()
                        .map(|gate| gate.router_step_id.as_str())
                        .collect::<BTreeSet<_>>()
                        .iter()
                        .all(|router_id| {
                            run.tasks
                                .iter()
                                .find(|candidate| candidate.step_id == *router_id)
                                .is_some_and(|router| router.status == TaskStatus::Succeeded)
                        })
                    && !crate::coordinator::route_gate_satisfied(run, step);
                (inherited_skip || false_condition || route_not_selected).then_some(step.id.clone())
            })
            .collect::<Vec<_>>();
        if skipped.is_empty() {
            break;
        }
        for task in &mut run.tasks {
            if skipped.contains(&task.step_id) {
                task.status = TaskStatus::Skipped;
                task.revision += 1;
            }
        }
    }
}
