//! Fusion (ADR-043, docs/FUSION.md): a lead chat that delegates coherent
//! tasks to one persistent sidekick agent in the same folder through the
//! `sidekick` host tool. Each harness keeps its own inference, tools,
//! approvals and history; PiUI only brokers the sidekick's turns and hands
//! each report to the lead exactly once.

pub(crate) mod broker;
pub(crate) mod logic;
pub(crate) mod model;
pub(crate) mod store;
#[cfg(test)]
mod tests;

use crate::api::verified_project_directory;
use crate::review_api::{self, ReviewArea, ReviewContentV1, ReviewFileV1};
use crate::state::HostState;
use crate::workspace_api::{
    FusionAnswerFuture, FusionSessionHooks, FusionSessionSetup, TurnState, WorkspaceError,
    WorkspaceLaunchRequest, event_publisher,
};
use broker::{FusionBroker, FusionHost, HostFailure, HostFuture, SessionActivity, SidekickLaunch};
use model::{
    FUSION_CHANGED_EVENT_V1, FUSION_PROTOCOL, FusionChangedEventV1, FusionCommandV1,
    FusionResultV1, FusionRoleName,
};
use piui_runtime::workspace_runtime::{
    BlockKind, HarnessKind, HostTool, PromptMode, SidekickCallIdentity,
};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

/// The Fusion broker of this process (managed Tauri state).
#[derive(Clone)]
pub(crate) struct FusionService {
    broker: FusionBroker,
}

impl FusionService {
    pub(crate) fn open(app: &AppHandle, app_data_dir: &Path) -> std::io::Result<Self> {
        let store = store::FileFusionStore::open(app_data_dir)?;
        let broker = FusionBroker::new(
            Arc::new(TauriFusionHost { app: app.clone() }),
            Arc::new(store),
            codex_sandbox_configured(),
        );
        let events = app.clone();
        broker.set_notifier(Arc::new(move |lead: &str, revision: u64| {
            let _ = events.emit(
                FUSION_CHANGED_EVENT_V1,
                FusionChangedEventV1 {
                    protocol: FUSION_PROTOCOL,
                    lead_session_id: lead.to_owned(),
                    revision,
                },
            );
        }));
        Ok(Self { broker })
    }

    /// The session hooks the workspace host consults at every start.
    pub(crate) fn hooks(&self) -> Arc<dyn FusionSessionHooks> {
        Arc::new(FusionSessions {
            broker: self.broker.clone(),
        })
    }

    /// Restarts deliveries queued by an earlier process.
    pub(crate) fn resume(&self) {
        let broker = self.broker.clone();
        tauri::async_runtime::spawn(async move { broker.resume_deliveries().await });
    }
}

/// Whether a Codex sidekick may write: on Windows only with the native
/// sandbox configured (`[windows] sandbox`, Fusion spike S6). Read-only;
/// PiUI never writes the person's Codex configuration.
fn codex_sandbox_configured() -> bool {
    if !cfg!(windows) {
        return true;
    }
    let home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|home| Path::new(&home).join(".codex")));
    home.and_then(|home| std::fs::read_to_string(home.join("config.toml")).ok())
        .is_some_and(|toml| logic::codex_windows_sandbox_configured(&toml))
}

struct FusionSessions {
    broker: FusionBroker,
}

const fn native_subagent_switch(harness: HarnessKind) -> bool {
    matches!(harness, HarnessKind::ClaudeCode | HarnessKind::Codex)
}

impl FusionSessionHooks for FusionSessions {
    fn setup(&self, session_id: &str) -> Option<FusionSessionSetup> {
        let (role, _, pair) = self.broker.membership(session_id)?;
        Some(match role {
            FusionRoleName::Lead => FusionSessionSetup {
                host_tools: pair
                    .lead
                    .harness
                    .supports_sidekick_tool()
                    .then_some(HostTool::Sidekick)
                    .into_iter()
                    .collect(),
                instructions: Some(logic::LEAD_INSTRUCTIONS.to_owned()),
                native_subagents: (!pair.options.lead_native_subagents
                    && native_subagent_switch(pair.lead.harness))
                .then_some(false),
                sidekick: false,
            },
            FusionRoleName::Sidekick => FusionSessionSetup {
                host_tools: Vec::new(),
                instructions: Some(logic::sidekick_instructions(pair.options.pushback)),
                native_subagents: native_subagent_switch(pair.sidekick.harness).then_some(false),
                sidekick: true,
            },
        })
    }

    fn is_sidekick(&self, session_id: &str) -> bool {
        self.broker
            .membership(session_id)
            .is_some_and(|(role, ..)| role == FusionRoleName::Sidekick)
    }

    fn handle(
        &self,
        lead_session_id: String,
        identity: SidekickCallIdentity,
        operation: serde_json::Map<String, serde_json::Value>,
    ) -> FusionAnswerFuture {
        let broker = self.broker.clone();
        Box::pin(async move { broker.handle(&lead_session_id, &identity, operation).await })
    }

    fn delivery_failed(
        &self,
        lead_session_id: String,
        round_id: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let broker = self.broker.clone();
        Box::pin(async move { broker.delivery_failed(&lead_session_id, &round_id).await })
    }
}

/// The workspace host behind the broker. Every action goes through the
/// ordinary operation gate and trust check of the session's project.
struct TauriFusionHost {
    app: AppHandle,
}

fn failure(error: &WorkspaceError) -> HostFailure {
    if error.is_sign_in_required() || error.code == "ACP_SIGN_IN_REQUIRED" {
        HostFailure::SignInRequired
    } else {
        HostFailure::Unavailable
    }
}

/// Runs `action` under the operation gate after the trust check of the
/// session's project.
async fn gated<T>(
    host: &HostState,
    session_id: &str,
    action: impl AsyncFnOnce(&HostState) -> Result<T, WorkspaceError>,
) -> Result<T, HostFailure> {
    host.workspace.wait_for_pending_start(session_id).await;
    let _operation = host.live_runtime_operation_gate.lock().await;
    let (_, workspace_id) = host
        .workspace
        .session_title(session_id)
        .ok_or(HostFailure::Unavailable)?;
    verified_project_directory(host, &workspace_id, true).map_err(|_| HostFailure::Unavailable)?;
    action(host).await.map_err(|e| failure(&e))
}

impl FusionHost for TauriFusionHost {
    fn launch_sidekick(&self, launch: SidekickLaunch) -> HostFuture<Result<(), HostFailure>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            let host = host.inner();
            if host.safe_mode {
                return Err(HostFailure::Unavailable);
            }
            let lead_title = host
                .workspace
                .session_title(&launch.lead_session_id)
                .map(|(title, _)| title);
            let title = lead_title.map_or_else(
                || "Sidekick".to_owned(),
                |title| {
                    let short: String = title.chars().take(80).collect();
                    format!("Sidekick · {short}")
                },
            );
            let authorize = |workspace_id: &str| {
                verified_project_directory(host, workspace_id, true).map_err(WorkspaceError::from)
            };
            host.workspace
                .create_session(
                    &host.live_runtime_operation_gate,
                    &authorize,
                    WorkspaceLaunchRequest {
                        session_id: Some(launch.session_id),
                        workspace_id: launch.workspace_id,
                        harness: launch.role.harness,
                        title: Some(title),
                        profile_id: None,
                        run_id: None,
                        member_id: None,
                        task_id: None,
                        model: launch.role.model,
                        thinking_level: launch.role.thinking_level,
                        instructions: None,
                        base_instructions: None,
                        service_tier: None,
                        resource_rules: None,
                        permission_mode: launch.role.permission_mode,
                        network_access: false,
                        allowed_tools: None,
                        native_subagents: None,
                        dependency_history_references: Vec::new(),
                        dependency_outputs: Vec::new(),
                        coordinator: None,
                    },
                    event_publisher(app.clone()),
                )
                .await
                .map(|_| ())
                .map_err(|error| failure(&error))
        })
    }

    fn ensure_live(&self, session_id: String) -> HostFuture<Result<(), HostFailure>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            let host = host.inner();
            if host.safe_mode {
                return Err(HostFailure::Unavailable);
            }
            if host
                .workspace
                .subscribe_turns(&session_id)
                .is_ok_and(|turns| turns.is_some())
            {
                return Ok(());
            }
            host.workspace
                .session_title(&session_id)
                .ok_or(HostFailure::Unavailable)?;
            let authorize = |workspace_id: &str| {
                verified_project_directory(host, workspace_id, true).map_err(WorkspaceError::from)
            };
            host.workspace
                .open_session(
                    &host.live_runtime_operation_gate,
                    &authorize,
                    &session_id,
                    event_publisher(app.clone()),
                )
                .await
                .map(|_| ())
                .map_err(|error| failure(&error))
        })
    }

    fn turns(&self, session_id: &str) -> Result<watch::Receiver<TurnState>, HostFailure> {
        self.app
            .state::<HostState>()
            .workspace
            .subscribe_turns(session_id)
            .ok()
            .flatten()
            .ok_or(HostFailure::Unavailable)
    }

    fn send(
        &self,
        session_id: String,
        text: String,
        mode: PromptMode,
    ) -> HostFuture<Result<(), HostFailure>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            gated(host.inner(), &session_id, async |host| {
                host.workspace.send(&session_id, text, mode).await
            })
            .await
        })
    }

    fn interrupt(&self, session_id: String) -> HostFuture<Result<(), HostFailure>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            gated(host.inner(), &session_id, async |host| {
                host.workspace.interrupt(&session_id).await
            })
            .await
        })
    }

    fn close(&self, session_id: String) -> HostFuture<()> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            let _ = host.workspace.close_session(&session_id).await;
        })
    }

    fn last_answer(
        &self,
        session_id: String,
    ) -> HostFuture<Result<Option<(String, String)>, HostFailure>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            let snapshot = host
                .workspace
                .snapshot(&session_id)
                .await
                .map_err(|error| failure(&error))?;
            Ok(snapshot
                .blocks
                .into_iter()
                .rev()
                .find(|block| block.kind == BlockKind::Assistant && block.text.is_some())
                .and_then(|block| block.text.map(|text| (block.id, text))))
        })
    }

    fn activity(&self, session_id: String) -> HostFuture<SessionActivity> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            SessionActivity {
                approval_ids: host.workspace.pending_approval_ids(&session_id),
                latest: None,
            }
        })
    }

    fn changes(&self, lead_session_id: String) -> HostFuture<Option<(Vec<ReviewFileV1>, bool)>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            review_api::changed_files(host.inner(), &lead_session_id)
                .await
                .ok()
                .flatten()
        })
    }

    fn file_view(
        &self,
        lead_session_id: String,
        path: String,
        area: ReviewArea,
    ) -> HostFuture<Result<(ReviewContentV1, String), HostFailure>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            review_api::file_view(host.inner(), &lead_session_id, &path, area)
                .await
                .map_err(|error| failure(&error))
        })
    }
}

#[tauri::command]
pub(crate) async fn fusion_command_v1(
    app: AppHandle,
    state: State<'_, HostState>,
    fusion: State<'_, FusionService>,
    command: FusionCommandV1,
) -> Result<FusionResultV1, WorkspaceError> {
    dispatch(state.inner(), fusion.inner(), command, &app).await
}

fn validate_id(id: &str) -> Result<(), WorkspaceError> {
    (!id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'))
    .then_some(())
    .ok_or_else(WorkspaceError::invalid)
}

async fn dispatch(
    host: &HostState,
    fusion: &FusionService,
    command: FusionCommandV1,
    app: &AppHandle,
) -> Result<FusionResultV1, WorkspaceError> {
    let broker = &fusion.broker;
    let state_of = async |lead: &str| {
        broker
            .state(lead)
            .await
            .map(|state| FusionResultV1::State {
                state: Box::new(state),
            })
            .ok_or_else(WorkspaceError::not_found)
    };
    let refused = |code| -> WorkspaceError {
        match code {
            model::SidekickErrorCode::UnknownRound | model::SidekickErrorCode::UnknownBrief => {
                WorkspaceError::not_found()
            }
            model::SidekickErrorCode::Uncertain | model::SidekickErrorCode::RoundFinished => {
                WorkspaceError::conflict()
            }
            _ => WorkspaceError::not_supported(),
        }
    };
    // Reads work in safe mode; every change is refused there.
    let changes = !matches!(
        command,
        FusionCommandV1::CheckPair { .. }
            | FusionCommandV1::State { .. }
            | FusionCommandV1::Find { .. }
    );
    if changes && host.safe_mode {
        return Err(WorkspaceError::safe_mode());
    }
    match command {
        FusionCommandV1::CheckPair { workspace_id, pair } => {
            validate_id(&workspace_id)?;
            Ok(match logic::check_pair(&pair, broker.codex_sandbox()) {
                Ok(()) => FusionResultV1::PairCheck {
                    ok: true,
                    refusal: None,
                    role: None,
                },
                Err((refusal, role)) => FusionResultV1::PairCheck {
                    ok: false,
                    refusal: Some(refusal),
                    role: Some(role),
                },
            })
        }
        FusionCommandV1::CreateChat {
            workspace_id,
            pair,
            title,
        } => {
            validate_id(&workspace_id)?;
            if let Err((refusal, role)) = logic::check_pair(&pair, broker.codex_sandbox()) {
                return Ok(FusionResultV1::PairCheck {
                    ok: false,
                    refusal: Some(refusal),
                    role: Some(role),
                });
            }
            let lead = host.workspace.allocate_orchestration_session_id();
            broker
                .register_lead(&lead, &workspace_id, pair.clone())
                .map_err(|()| WorkspaceError::io())?;
            let authorize = |workspace_id: &str| {
                verified_project_directory(host, workspace_id, true).map_err(WorkspaceError::from)
            };
            let created = host
                .workspace
                .create_session(
                    &host.live_runtime_operation_gate,
                    &authorize,
                    WorkspaceLaunchRequest {
                        session_id: Some(lead.clone()),
                        workspace_id,
                        harness: pair.lead.harness,
                        title,
                        profile_id: None,
                        run_id: None,
                        member_id: None,
                        task_id: None,
                        model: pair.lead.model,
                        thinking_level: pair.lead.thinking_level,
                        instructions: None,
                        base_instructions: None,
                        service_tier: None,
                        resource_rules: None,
                        permission_mode: pair.lead.permission_mode,
                        network_access: false,
                        allowed_tools: None,
                        native_subagents: None,
                        dependency_history_references: Vec::new(),
                        dependency_outputs: Vec::new(),
                        coordinator: None,
                    },
                    event_publisher(app.clone()),
                )
                .await;
            if let Err(error) = created {
                broker.forget_lead(&lead);
                return Err(error);
            }
            let state = broker.state(&lead).await.ok_or_else(WorkspaceError::io)?;
            Ok(FusionResultV1::Created {
                lead_session_id: lead,
                state: Box::new(state),
            })
        }
        FusionCommandV1::State { lead_session_id } => state_of(&lead_session_id).await,
        FusionCommandV1::Find { session_id } => Ok(match broker.membership(&session_id) {
            Some((role, lead, _)) => FusionResultV1::Membership {
                role: Some(role),
                lead_session_id: Some(lead),
            },
            None => FusionResultV1::Membership {
                role: None,
                lead_session_id: None,
            },
        }),
        FusionCommandV1::StopPair { lead_session_id } => {
            broker
                .stop_sidekick(&lead_session_id)
                .await
                .map_err(refused)?;
            if host
                .workspace
                .subscribe_turns(&lead_session_id)
                .is_ok_and(|turns| turns.is_some())
            {
                let _ = host.workspace.interrupt(&lead_session_id).await;
            }
            Ok(FusionResultV1::Accepted {})
        }
        FusionCommandV1::StopSidekick { lead_session_id } => {
            broker
                .stop_sidekick(&lead_session_id)
                .await
                .map_err(refused)?;
            Ok(FusionResultV1::Accepted {})
        }
        FusionCommandV1::ResetSidekick { lead_session_id } => {
            broker
                .reset_sidekick(&lead_session_id)
                .await
                .map_err(refused)?;
            Ok(FusionResultV1::Accepted {})
        }
        FusionCommandV1::ReconcileRound {
            lead_session_id,
            round_id,
        } => {
            broker
                .reconcile(&lead_session_id, &round_id)
                .await
                .map_err(refused)?;
            state_of(&lead_session_id).await
        }
        FusionCommandV1::AbandonRound {
            lead_session_id,
            round_id,
        } => {
            broker
                .abandon(&lead_session_id, &round_id)
                .await
                .map_err(refused)?;
            state_of(&lead_session_id).await
        }
    }
}
