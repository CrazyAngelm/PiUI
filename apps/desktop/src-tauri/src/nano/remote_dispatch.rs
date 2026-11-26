//! What a paired browser may ask of this host, and how an admitted request
//! runs (ADR-062, `contracts/nano-remote-v1.ts`).
//!
//! [`admit`] is the only admission: a command name outside
//! [`REMOTE_COMMANDS`] is refused, every argument object is read into a
//! private struct that rejects unknown fields, and sensitive variants are narrowed. The
//! workbench routes use the typed requests and policies in `remote_workbench`. Nothing of settings, projects'
//! trust, plugins, files, accounts or the `nano_remote_*` commands themselves
//! is reachable.
//!
//! [`run`] calls the same functions the WebView's IPC calls, with the managed
//! state taken from the app handle. It deliberately bypasses
//! `guarded_commands` (a guard for the WebView's origin): this allowlist is
//! the admission of the remote path. This is not a sandbox: an admitted chat
//! command does what it does at the keyboard.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::{NanoHost, commands};
use crate::api;
use crate::harness_registry_api::{self, HarnessRegistryCommand};
use crate::state::HostState;
use crate::workspace_api::composer::{self, ComposerCommand};
use crate::workspace_api::{
    self, HarnessModelsRequestV19, RuntimeSettingsCommand, SessionModeRequestV1, WorkspaceCommand,
    WorkspaceHistoryRequestV1,
};
use piui_nano::remote::frames::ShellContracts;

/// `NANO_REMOTE_COMMANDS`: the host commands a welcomed viewer may call.
pub(crate) const REMOTE_COMMANDS: [&str; 34] = [
    "bootstrap_v10",
    "workspace_command_v15",
    "workspace_history_v1",
    "workspace_settings_v16",
    "workspace_session_mode_v1",
    "workspace_composer_v19",
    "harness_models_v19",
    "harness_registry_v1",
    "get_session_catalog",
    "get_personal_session_catalog",
    "refresh_session_catalog",
    "refresh_personal_session_catalog",
    "get_timeline_page",
    "get_personal_timeline_page",
    "search_sessions",
    "nano_account_status_v1",
    "orchestration_catalog_v6",
    "orchestration_get_profile_v6",
    "orchestration_get_team_v6",
    "orchestration_get_pipeline_v6",
    "orchestration_get_launch_command_v6",
    "orchestration_save_graph_v6",
    "orchestration_list_runs_v6",
    "orchestration_get_run_v6",
    "orchestration_run_usage_v6",
    "orchestration_start_run_v6",
    "orchestration_cancel_run_v6",
    "orchestration_cancel_task_v6",
    "orchestration_control_flow_v6",
    "orchestration_run_outputs_v1",
    "orchestration_list_schedules_v7",
    "orchestration_automations_v7",
    "board_command_v1",
    "teammates_command_v1",
];

/// `NANO_REMOTE_CHANNELS`: the host events forwarded to every welcomed viewer.
pub(crate) const REMOTE_CHANNELS: [&str; 10] = [
    "piui://workspace-event",
    "piui://composer-v19",
    "piui://session-catalog",
    "piui://harness-registry-v1",
    "piui://nano-account-v1",
    "piui://orchestration-event",
    "piui://orchestration-schedule-event",
    "piui://orchestration-automations-event",
    "piui://board-changed-v1",
    "piui://teammates-changed-v1",
];

/// `NANO_REMOTE_SHELL_CONTRACTS`: the protocol numbers the shell was built for.
pub(crate) const SHELL_CONTRACTS: ShellContracts = ShellContracts {
    workspace: 15,
    composer: 19,
    settings: 16,
    history: 1,
    models: 19,
};

#[cfg(test)]
#[test]
fn remote_workbench_cannot_open_the_local_site_browser() {
    let arguments = json!({ "request": { "url": "https://example.org/", "language": "en" } });
    assert!(matches!(
        admit("site_browser_open_link_v1", &arguments),
        Err(Refusal::NotAllowed)
    ));
}

/// Why a request was not admitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The command is not on the allowlist, or this variant of it is not.
    NotAllowed,
    /// The arguments do not read as that command's request.
    Invalid,
}

/// An admitted request with its typed arguments. `Debug` prints the command
/// only: arguments carry chat content.
pub(crate) enum Admitted {
    Workbench(Box<super::remote_workbench::WorkbenchRequest>),
    Bootstrap,
    WorkspaceCommand(WorkspaceCommand),
    WorkspaceHistory(WorkspaceHistoryRequestV1),
    WorkspaceSettings(RuntimeSettingsCommand),
    SessionMode(SessionModeRequestV1),
    Composer(ComposerCommand),
    HarnessModels(HarnessModelsRequestV19),
    /// `harness_registry_v1` with `{ type: 'list' }`, the only variant allowed.
    HarnessRegistryList,
    SessionCatalog {
        project_id: String,
    },
    PersonalSessionCatalog,
    RefreshSessionCatalog {
        project_id: String,
    },
    RefreshPersonalSessionCatalog,
    TimelinePage {
        project_id: String,
        session_id: String,
        cursor: Option<String>,
        limit: Option<usize>,
    },
    PersonalTimelinePage {
        session_id: String,
        cursor: Option<String>,
        limit: Option<usize>,
    },
    SearchSessions {
        query: String,
    },
    NanoAccountStatus,
}

impl Admitted {
    /// The wire name of the command.
    pub(crate) const fn command(&self) -> &'static str {
        match self {
            Self::Workbench(request) => request.name(),
            Self::Bootstrap => "bootstrap_v10",
            Self::WorkspaceCommand(_) => "workspace_command_v15",
            Self::WorkspaceHistory(_) => "workspace_history_v1",
            Self::WorkspaceSettings(_) => "workspace_settings_v16",
            Self::SessionMode(_) => "workspace_session_mode_v1",
            Self::Composer(_) => "workspace_composer_v19",
            Self::HarnessModels(_) => "harness_models_v19",
            Self::HarnessRegistryList => "harness_registry_v1",
            Self::SessionCatalog { .. } => "get_session_catalog",
            Self::PersonalSessionCatalog => "get_personal_session_catalog",
            Self::RefreshSessionCatalog { .. } => "refresh_session_catalog",
            Self::RefreshPersonalSessionCatalog => "refresh_personal_session_catalog",
            Self::TimelinePage { .. } => "get_timeline_page",
            Self::PersonalTimelinePage { .. } => "get_personal_timeline_page",
            Self::SearchSessions { .. } => "search_sessions",
            Self::NanoAccountStatus => "nano_account_status_v1",
        }
    }
}

impl std::fmt::Debug for Admitted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("Admitted")
            .field(&self.command())
            .finish()
    }
}

// Argument objects. Names follow each command's Tauri parameters exactly.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArguments {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CommandArgument<T> {
    pub(super) command: T,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RequestArgument<T> {
    pub(super) request: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectArgument {
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimelineArguments {
    project_id: String,
    session_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersonalTimelineArguments {
    session_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryArgument {
    query: String,
}

pub(super) fn read<T: DeserializeOwned>(arguments: &Value) -> Result<T, Refusal> {
    T::deserialize(arguments).map_err(|_| Refusal::Invalid)
}

/// Decides whether `command` with `arguments` (the object `hostInvoke` passes;
/// `null` counts as no arguments) may run for a remote viewer.
pub(crate) fn admit(command: &str, arguments: &Value) -> Result<Admitted, Refusal> {
    if !REMOTE_COMMANDS.contains(&command) {
        return Err(Refusal::NotAllowed);
    }
    let none = Value::Object(serde_json::Map::new());
    let arguments = match arguments {
        Value::Null => &none,
        Value::Object(_) => arguments,
        _ => return Err(Refusal::Invalid),
    };
    match command {
        "bootstrap_v10" => read::<NoArguments>(arguments).map(|_| Admitted::Bootstrap),
        "workspace_command_v15" => read::<CommandArgument<WorkspaceCommand>>(arguments)
            .map(|found| Admitted::WorkspaceCommand(found.command)),
        "workspace_history_v1" => read::<RequestArgument<WorkspaceHistoryRequestV1>>(arguments)
            .map(|found| Admitted::WorkspaceHistory(found.request)),
        "workspace_settings_v16" => read::<CommandArgument<RuntimeSettingsCommand>>(arguments)
            .map(|found| Admitted::WorkspaceSettings(found.command)),
        "workspace_session_mode_v1" => read::<RequestArgument<SessionModeRequestV1>>(arguments)
            .map(|found| Admitted::SessionMode(found.request)),
        "workspace_composer_v19" => {
            let found = read::<CommandArgument<ComposerCommand>>(arguments)?;
            if let ComposerCommand::Send { attachments, .. } = &found.command
                && !attachments.is_empty()
            {
                return Err(Refusal::NotAllowed);
            }
            Ok(Admitted::Composer(found.command))
        }
        "harness_models_v19" => read::<RequestArgument<HarnessModelsRequestV19>>(arguments)
            .map(|found| Admitted::HarnessModels(found.request)),
        "harness_registry_v1" => {
            // Any variant but `list` is refused whatever its other fields say.
            let kind = arguments
                .get("command")
                .and_then(|command| command.get("type"))
                .and_then(Value::as_str);
            if kind.is_some_and(|kind| kind != "list") {
                return Err(Refusal::NotAllowed);
            }
            let found = read::<CommandArgument<HarnessRegistryCommand>>(arguments)?;
            if matches!(found.command, HarnessRegistryCommand::List {}) {
                Ok(Admitted::HarnessRegistryList)
            } else {
                Err(Refusal::NotAllowed)
            }
        }
        "get_session_catalog" => {
            read::<ProjectArgument>(arguments).map(|found| Admitted::SessionCatalog {
                project_id: found.project_id,
            })
        }
        "get_personal_session_catalog" => {
            read::<NoArguments>(arguments).map(|_| Admitted::PersonalSessionCatalog)
        }
        "refresh_session_catalog" => {
            read::<ProjectArgument>(arguments).map(|found| Admitted::RefreshSessionCatalog {
                project_id: found.project_id,
            })
        }
        "refresh_personal_session_catalog" => {
            read::<NoArguments>(arguments).map(|_| Admitted::RefreshPersonalSessionCatalog)
        }
        "get_timeline_page" => {
            read::<TimelineArguments>(arguments).map(|found| Admitted::TimelinePage {
                project_id: found.project_id,
                session_id: found.session_id,
                cursor: found.cursor,
                limit: found.limit,
            })
        }
        "get_personal_timeline_page" => read::<PersonalTimelineArguments>(arguments).map(|found| {
            Admitted::PersonalTimelinePage {
                session_id: found.session_id,
                cursor: found.cursor,
                limit: found.limit,
            }
        }),
        "search_sessions" => read::<QueryArgument>(arguments)
            .map(|found| Admitted::SearchSessions { query: found.query }),
        "nano_account_status_v1" => {
            read::<NoArguments>(arguments).map(|_| Admitted::NanoAccountStatus)
        }
        _ => super::remote_workbench::WorkbenchRequest::parse(command, arguments)
            .map(|request| Admitted::Workbench(Box::new(request))),
    }
}

/// What a command that cannot run because the host is not ready answers.
pub(super) fn not_ready() -> Value {
    json!({ "code": "io", "message": "Nano Desktop is not ready.", "recoverable": true })
}

/// The answer or the rejection of a command as the JSON the IPC would have
/// carried.
pub(super) fn to_json<T: Serialize, E: Serialize>(result: Result<T, E>) -> Result<Value, Value> {
    match result {
        Ok(value) => serde_json::to_value(value).map_err(|_| not_ready()),
        Err(error) => Err(serde_json::to_value(error).unwrap_or_else(|_| not_ready())),
    }
}

/// Runs a synchronous command off the async workers, like Tauri's own
/// `#[tauri::command(async)]` does.
async fn blocking<F>(app: &AppHandle, call: F) -> Result<Value, Value>
where
    F: FnOnce(&AppHandle) -> Result<Value, Value> + Send + 'static,
{
    let app = app.clone();
    tokio::task::spawn_blocking(move || call(&app))
        .await
        .unwrap_or_else(|_| Err(not_ready()))
}

/// Runs an admitted request through the existing command function and
/// returns its answer or its rejection as JSON.
pub(crate) async fn run(app: &AppHandle, admitted: Admitted) -> Result<Value, Value> {
    macro_rules! state {
        () => {
            match app.try_state::<HostState>() {
                Some(state) => state,
                None => return Err(not_ready()),
            }
        };
    }
    match admitted {
        Admitted::Workbench(request) => request.run(app).await,
        Admitted::Bootstrap => {
            blocking(app, |app| {
                let state = app.try_state::<HostState>().ok_or_else(not_ready)?;
                to_json(api::bootstrap_v10(state))
            })
            .await
        }
        Admitted::WorkspaceCommand(command) => {
            let state = state!();
            to_json(workspace_api::workspace_command_v15(app.clone(), state, command).await)
        }
        Admitted::WorkspaceHistory(request) => {
            let state = state!();
            to_json(workspace_api::workspace_history_v1(state, request).await)
        }
        Admitted::WorkspaceSettings(command) => {
            let state = state!();
            to_json(workspace_api::workspace_settings_v16(state, command).await)
        }
        Admitted::SessionMode(request) => {
            let state = state!();
            to_json(workspace_api::workspace_session_mode_v1(state, request).await)
        }
        Admitted::Composer(command) => {
            let state = state!();
            to_json(composer::workspace_composer_v19(app.clone(), state, command).await)
        }
        Admitted::HarnessModels(request) => {
            let state = state!();
            to_json(workspace_api::harness_models_v19(state, request).await)
        }
        Admitted::HarnessRegistryList => {
            let state = state!();
            to_json(
                harness_registry_api::harness_registry_v1(
                    app.clone(),
                    state,
                    HarnessRegistryCommand::List {},
                )
                .await,
            )
        }
        Admitted::SessionCatalog { project_id } => {
            blocking(app, move |app| {
                let state = app.try_state::<HostState>().ok_or_else(not_ready)?;
                to_json(api::get_session_catalog(state, project_id))
            })
            .await
        }
        Admitted::PersonalSessionCatalog => {
            blocking(app, |app| {
                let state = app.try_state::<HostState>().ok_or_else(not_ready)?;
                to_json(api::get_personal_session_catalog(state))
            })
            .await
        }
        Admitted::RefreshSessionCatalog { project_id } => {
            let state = state!();
            to_json(api::refresh_session_catalog(state, app.clone(), project_id).await)
        }
        Admitted::RefreshPersonalSessionCatalog => {
            let state = state!();
            to_json(api::refresh_personal_session_catalog(state, app.clone()).await)
        }
        Admitted::TimelinePage {
            project_id,
            session_id,
            cursor,
            limit,
        } => {
            let state = state!();
            to_json(api::get_timeline_page(state, project_id, session_id, cursor, limit).await)
        }
        Admitted::PersonalTimelinePage {
            session_id,
            cursor,
            limit,
        } => {
            let state = state!();
            to_json(api::get_personal_timeline_page(state, session_id, cursor, limit).await)
        }
        Admitted::SearchSessions { query } => {
            let state = state!();
            to_json(api::search_sessions(state, query).await)
        }
        Admitted::NanoAccountStatus => {
            let Some(host) = app.try_state::<Arc<NanoHost>>() else {
                return Err(not_ready());
            };
            to_json(Ok::<_, Value>(commands::nano_account_status_v1(host)))
        }
    }
}
