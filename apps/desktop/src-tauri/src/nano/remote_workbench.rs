//! The workbench routes offered by a desktop after local approval (ADR-062).
//! Parse only existing typed requests. A browser has no IPC dispatcher.
use super::remote_dispatch::{CommandArgument, Refusal, RequestArgument, not_ready, read, to_json};
use crate::board::BoardCommandV1;
use crate::orchestration_api::{
    self as orchestration, AutomationsStateRequest, CancelTaskRequest, FlowControlRequest,
    GetDefinitionRequest, RunMutationRequest, RunRequest, SaveGraphRequest, StartRunCommand,
    WorkspaceRequest,
};
use crate::orchestration_run_debugging::RunOutputsRequestV1;
use crate::teammates_api::TeammatesCommandV1;
use serde_json::Value;
use tauri::{AppHandle, Manager};

// The negotiated browser marker belongs only to the wire projection. Native
// v6 journals retain their strict, backwards-readable shape.
fn run_json<T: serde::Serialize>(
    result: Result<T, orchestration::OrchestrationApiError>,
) -> Result<Value, Value> {
    let mut value = to_json(result)?;
    if value
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(orchestration::paired_browser_run)
    {
        value["pairedBrowser"] = true.into();
    }
    Ok(value)
}

pub(crate) enum WorkbenchRequest {
    Catalog(WorkspaceRequest),
    Profile(GetDefinitionRequest),
    Team(GetDefinitionRequest),
    Pipeline(GetDefinitionRequest),
    Launch(GetDefinitionRequest),
    SaveGraph(SaveGraphRequest),
    ListRuns(WorkspaceRequest),
    Run(RunRequest),
    RunUsage(RunRequest),
    Start(StartRunCommand),
    Cancel(RunMutationRequest),
    CancelTask(CancelTaskRequest),
    ControlFlow(FlowControlRequest),
    Outputs(RunOutputsRequestV1),
    Schedules(WorkspaceRequest),
    Automations(AutomationsStateRequest),
    Board(BoardCommandV1),
    Teammates(TeammatesCommandV1),
}

impl WorkbenchRequest {
    pub(super) fn parse(name: &str, args: &Value) -> Result<Self, Refusal> {
        match name {
            "orchestration_catalog_v6" => Ok(Self::Catalog(
                read::<RequestArgument<WorkspaceRequest>>(args)?.request,
            )),
            "orchestration_get_profile_v6" => Ok(Self::Profile(
                read::<RequestArgument<GetDefinitionRequest>>(args)?.request,
            )),
            "orchestration_get_team_v6" => Ok(Self::Team(
                read::<RequestArgument<GetDefinitionRequest>>(args)?.request,
            )),
            "orchestration_get_pipeline_v6" => Ok(Self::Pipeline(
                read::<RequestArgument<GetDefinitionRequest>>(args)?.request,
            )),
            "orchestration_get_launch_command_v6" => Ok(Self::Launch(
                read::<RequestArgument<GetDefinitionRequest>>(args)?.request,
            )),
            "orchestration_save_graph_v6" => Ok(Self::SaveGraph(
                read::<RequestArgument<SaveGraphRequest>>(args)?.request,
            )),
            "orchestration_list_runs_v6" => Ok(Self::ListRuns(
                read::<RequestArgument<WorkspaceRequest>>(args)?.request,
            )),
            "orchestration_get_run_v6" => Ok(Self::Run(
                read::<RequestArgument<RunRequest>>(args)?.request,
            )),
            "orchestration_run_usage_v6" => Ok(Self::RunUsage(
                read::<RequestArgument<RunRequest>>(args)?.request,
            )),
            "orchestration_start_run_v6" => Ok(Self::Start(
                read::<RequestArgument<StartRunCommand>>(args)?.request,
            )),
            "orchestration_cancel_run_v6" => Ok(Self::Cancel(
                read::<RequestArgument<RunMutationRequest>>(args)?.request,
            )),
            "orchestration_cancel_task_v6" => Ok(Self::CancelTask(
                read::<RequestArgument<CancelTaskRequest>>(args)?.request,
            )),
            "orchestration_control_flow_v6" => Ok(Self::ControlFlow(
                read::<RequestArgument<FlowControlRequest>>(args)?.request,
            )),
            "orchestration_run_outputs_v1" => Ok(Self::Outputs(
                read::<RequestArgument<RunOutputsRequestV1>>(args)?.request,
            )),
            "orchestration_list_schedules_v7" => Ok(Self::Schedules(
                read::<RequestArgument<WorkspaceRequest>>(args)?.request,
            )),
            "orchestration_automations_v7" => Ok(Self::Automations(
                read::<RequestArgument<AutomationsStateRequest>>(args)?.request,
            )),
            "board_command_v1" => {
                let command = read::<CommandArgument<BoardCommandV1>>(args)?.command;
                if matches!(
                    command,
                    BoardCommandV1::Get { .. } | BoardCommandV1::SessionCards { .. }
                ) {
                    Ok(Self::Board(command))
                } else {
                    Err(Refusal::NotAllowed)
                }
            }
            "teammates_command_v1" => {
                let command = read::<CommandArgument<TeammatesCommandV1>>(args)?.command;
                if matches!(command, TeammatesCommandV1::List { .. }) {
                    Ok(Self::Teammates(command))
                } else {
                    Err(Refusal::NotAllowed)
                }
            }
            _ => Err(Refusal::NotAllowed),
        }
    }

    pub(super) const fn name(&self) -> &'static str {
        match self {
            Self::Catalog(_) => "orchestration_catalog_v6",
            Self::Profile(_) => "orchestration_get_profile_v6",
            Self::Team(_) => "orchestration_get_team_v6",
            Self::Pipeline(_) => "orchestration_get_pipeline_v6",
            Self::Launch(_) => "orchestration_get_launch_command_v6",
            Self::SaveGraph(_) => "orchestration_save_graph_v6",
            Self::ListRuns(_) => "orchestration_list_runs_v6",
            Self::Run(_) => "orchestration_get_run_v6",
            Self::RunUsage(_) => "orchestration_run_usage_v6",
            Self::Start(_) => "orchestration_start_run_v6",
            Self::Cancel(_) => "orchestration_cancel_run_v6",
            Self::CancelTask(_) => "orchestration_cancel_task_v6",
            Self::ControlFlow(_) => "orchestration_control_flow_v6",
            Self::Outputs(_) => "orchestration_run_outputs_v1",
            Self::Schedules(_) => "orchestration_list_schedules_v7",
            Self::Automations(_) => "orchestration_automations_v7",
            Self::Board(_) => "board_command_v1",
            Self::Teammates(_) => "teammates_command_v1",
        }
    }

    pub(super) async fn run(self, app: &AppHandle) -> Result<Value, Value> {
        macro_rules! state {
            () => {
                app.try_state().ok_or_else(not_ready)?
            };
        }
        match self {
            Self::Catalog(request) => {
                to_json(orchestration::orchestration_catalog_v6(app.clone(), request).await)
            }
            Self::Profile(request) => {
                to_json(orchestration::orchestration_get_profile_v6(app.clone(), request).await)
            }
            Self::Team(request) => {
                to_json(orchestration::orchestration_get_team_v6(app.clone(), request).await)
            }
            Self::Pipeline(request) => {
                to_json(orchestration::orchestration_get_pipeline_v6(app.clone(), request).await)
            }
            Self::Launch(request) => to_json(
                orchestration::orchestration_get_launch_command_v6(app.clone(), request).await,
            ),
            Self::SaveGraph(request) => {
                to_json(orchestration::save_remote_graph(state!(), state!(), request).await)
            }
            Self::ListRuns(request) => {
                to_json(orchestration::orchestration_list_runs_v6(app.clone(), request).await)
            }
            Self::Run(request) => {
                run_json(orchestration::orchestration_get_run_v6(app.clone(), request).await)
            }
            Self::RunUsage(request) => {
                to_json(orchestration::orchestration_run_usage_v6(app.clone(), request).await)
            }
            Self::Start(request) => run_json(
                orchestration::start_scoped_run(
                    state!(),
                    state!(),
                    state!(),
                    app.clone(),
                    request,
                    orchestration::WorkbenchCaller::PairedBrowser,
                )
                .await,
            ),
            Self::Cancel(request) => run_json(
                orchestration::cancel_remote_run(state!(), state!(), app.clone(), request).await,
            ),
            Self::CancelTask(request) => run_json(
                orchestration::cancel_scoped_task(
                    state!(),
                    state!(),
                    app.clone(),
                    request,
                    orchestration::WorkbenchCaller::PairedBrowser,
                )
                .await,
            ),
            Self::ControlFlow(request) => run_json(
                orchestration::control_scoped_flow(
                    state!(),
                    state!(),
                    state!(),
                    app.clone(),
                    request,
                    orchestration::WorkbenchCaller::PairedBrowser,
                )
                .await,
            ),
            Self::Outputs(request) => to_json(
                crate::orchestration_run_debugging::orchestration_run_outputs_v1(
                    state!(),
                    state!(),
                    request,
                )
                .await,
            ),
            Self::Schedules(request) => {
                to_json(orchestration::orchestration_list_schedules_v7(app.clone(), request).await)
            }
            Self::Automations(request) => {
                to_json(orchestration::orchestration_automations_v7(app.clone(), request).await)
            }
            Self::Board(request) => {
                to_json(crate::board::board_command_v1(state!(), state!(), state!(), request).await)
            }
            Self::Teammates(request) => to_json(
                crate::teammates_api::teammates_command_v1(
                    app.clone(),
                    state!(),
                    state!(),
                    state!(),
                    state!(),
                    request,
                )
                .await,
            ),
        }
    }
}
