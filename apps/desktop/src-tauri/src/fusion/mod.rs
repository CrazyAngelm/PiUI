//! Fusion (ADR-043, docs/FUSION.md): a lead chat that delegates coherent
//! tasks to one persistent sidekick agent in the same folder through the
//! `sidekick` host tool. Each harness keeps its own inference, tools,
//! approvals and history; PiUI only brokers the sidekick's turns and hands
//! each report to the lead exactly once.

pub(crate) mod broker;
pub(crate) mod capability;
pub(crate) mod logic;
pub(crate) mod model;
pub(crate) mod store;
#[cfg(test)]
mod tests;

use crate::api::verified_project_directory;
use crate::review_api::{self, ReviewArea, ReviewContentV1, ReviewFileV1};
use crate::state::HostState;
use crate::workspace_api::{
    FusionAnswerFuture, FusionSessionHooks, FusionSessionSetup, SendFailure, TurnState,
    WorkspaceError, WorkspaceLaunchRequest, authorize_live_session, event_publisher,
    fusion_catalog_role,
};
use broker::{FusionBroker, FusionHost, HostFailure, HostFuture, SessionActivity, SidekickLaunch};
use model::{
    FUSION_CHANGED_EVENT_V1, FUSION_PROTOCOL, FactCommand, FusionChangedEventV1, FusionCommandV1,
    FusionResultV1, FusionRole, FusionRoleName,
};
use piui_runtime::workspace_runtime::{
    BlockKind, HarnessKind, HostTool, PromptMode, SidekickCallIdentity, WorkspaceModel,
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
        let (role, _, harness, options) = self.broker.membership(session_id)?;
        Some(match role {
            FusionRoleName::Lead => FusionSessionSetup {
                host_tools: harness
                    .supports_sidekick_tool()
                    .then_some(HostTool::Sidekick)
                    .into_iter()
                    .collect(),
                instructions: Some(logic::LEAD_INSTRUCTIONS.to_owned()),
                native_subagents: (!options.lead_native_subagents
                    && native_subagent_switch(harness))
                .then_some(false),
                sidekick: false,
            },
            FusionRoleName::Sidekick => FusionSessionSetup {
                host_tools: Vec::new(),
                instructions: Some(logic::sidekick_instructions(options.pushback)),
                native_subagents: native_subagent_switch(harness).then_some(false),
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

    fn delivery_uncertain(
        &self,
        lead_session_id: String,
        round_id: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let broker = self.broker.clone();
        Box::pin(async move {
            broker.delivery_uncertain(&lead_session_id, &round_id).await;
        })
    }

    fn stop_current_sidekick(
        &self,
        session_id: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let broker = self.broker.clone();
        Box::pin(async move {
            let Some((FusionRoleName::Sidekick, lead, ..)) = broker.membership(&session_id) else {
                return;
            };
            // The caller disposes the process whatever the barrier proves; a
            // refusal (an uncertain round) is the person's to reconcile.
            let _ = broker.stop_sidekick(&lead).await;
        })
    }

    fn person_message_epoch(&self, session_id: &str) -> Option<u64> {
        match self.broker.membership(session_id) {
            Some((FusionRoleName::Lead, ..)) => self.broker.person_message_epoch(session_id),
            _ => None,
        }
    }

    fn person_message_admitted(
        &self,
        session_id: String,
        epoch: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let broker = self.broker.clone();
        Box::pin(async move { broker.person_message_admitted(&session_id, epoch).await })
    }

    fn delivery_sent(
        &self,
        lead_session_id: String,
        round_id: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let broker = self.broker.clone();
        Box::pin(async move { broker.delivery_sent(&lead_session_id, &round_id).await })
    }

    fn is_current_sidekick(&self, session_id: &str) -> bool {
        self.broker.is_current_sidekick(session_id)
    }

    fn deletable(
        &self,
        session_id: String,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'static>> {
        let broker = self.broker.clone();
        Box::pin(async move { broker.deletable(&session_id).await })
    }

    fn session_deleted(
        &self,
        session_id: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let broker = self.broker.clone();
        Box::pin(async move { broker.session_deleted(&session_id).await })
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
                        service_tier: launch.role.service_tier.map(|_| "fast".to_owned()),
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

    fn sidekick_model(&self, session_id: &str) -> Option<WorkspaceModel> {
        self.app
            .state::<HostState>()
            .workspace
            .fusion_sidekick_model(session_id)
    }

    fn validate_sidekick_role(
        &self,
        workspace_id: String,
        role: FusionRole,
    ) -> HostFuture<Result<FusionRole, WorkspaceError>> {
        let app = self.app.clone();
        Box::pin(async move {
            fusion_catalog_role(app.state::<HostState>().inner(), workspace_id, role).await
        })
    }

    fn set_sidekick_model(
        &self,
        session_id: String,
        role: FusionRole,
    ) -> HostFuture<Result<FusionRole, WorkspaceError>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            let _operation = authorize_live_session(host.inner(), &session_id).await?;
            host.workspace
                .set_fusion_sidekick_model(&session_id, role)
                .await
        })
    }

    fn discard_sidekick_draft(&self, session_id: String) -> HostFuture<()> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            let _operation = host.live_runtime_operation_gate.lock().await;
            host.workspace
                .discard_fusion_sidekick_draft(&session_id)
                .await;
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
            // A refusal before the write fails the send; a failure after it
            // is `AcceptanceUnknown` (ADR-076), never a refusal.
            let outcome = gated(host.inner(), &session_id, async |host| {
                Ok(host.workspace.send_outcome(&session_id, text, mode).await)
            })
            .await?;
            outcome.map_err(|failed| match failed {
                SendFailure::AcceptanceUnknown => HostFailure::AcceptanceUnknown,
                SendFailure::Refused(error) => failure(&error),
            })
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

    fn answer(
        &self,
        session_id: String,
        block_id: String,
    ) -> HostFuture<Result<Option<String>, HostFailure>> {
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
                .find(|block| block.id == block_id && block.kind == BlockKind::Assistant)
                .and_then(|block| block.text))
        })
    }

    fn answer_with_hash(
        &self,
        session_id: String,
        hash: String,
    ) -> HostFuture<Result<Option<String>, HostFailure>> {
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
                .filter(|block| block.kind == BlockKind::Assistant)
                .filter_map(|block| block.text)
                .find(|text| piui_runtime::git::sha256_hex(text.as_bytes()) == hash))
        })
    }

    fn history_contains(
        &self,
        session_id: String,
        needle: String,
    ) -> HostFuture<Result<bool, HostFailure>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            // The persisted native history, live or closed, by the report's
            // stable id: only a message or tool result the lead's harness
            // wrote counts, never a displayed block or the lead quoting it.
            let blocks = crate::workspace_api::persisted_history_blocks(host.inner(), &session_id)
                .await
                .map_err(|error| failure(&error))?;
            Ok(blocks.iter().any(|block| {
                matches!(block.kind, BlockKind::User | BlockKind::Tool)
                    && block
                        .text
                        .as_deref()
                        .is_some_and(|text| text.contains(&needle))
            }))
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

    fn round_commands(
        &self,
        session_id: String,
        brief_id: String,
        round_id: String,
    ) -> HostFuture<Option<Vec<FactCommand>>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            let snapshot = host.workspace.snapshot(&session_id).await.ok()?;
            logic::round_command_facts(&snapshot.blocks, &brief_id, &round_id)
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

fn pair_check(admission: Result<capability::Admitted, capability::Refused>) -> FusionResultV1 {
    match admission {
        Ok(admitted) => FusionResultV1::PairCheck {
            ok: true,
            refusal: None,
            role: None,
            dimension: None,
            sidekick_mode: Some(admitted.sidekick_mode),
            capabilities: admitted.capabilities,
        },
        Err((refusal, role, dimension)) => FusionResultV1::PairCheck {
            ok: false,
            refusal: Some(refusal),
            role: Some(role),
            dimension,
            sidekick_mode: None,
            capabilities: None,
        },
    }
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
            Ok(pair_check(capability::admit(&pair, broker.codex_sandbox())))
        }
        FusionCommandV1::CreateChat {
            workspace_id,
            pair,
            title,
        } => {
            validate_id(&workspace_id)?;
            let mut pair = pair;
            match capability::admit(&pair, broker.codex_sandbox()) {
                // The narrowed preset is the one the sidekick launches with
                // and the frozen pair records.
                Ok(admitted) => pair.sidekick.permission_mode = admitted.sidekick_mode,
                refused @ Err(_) => return Ok(pair_check(refused)),
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
                        service_tier: pair.lead.service_tier.map(|_| "fast".to_owned()),
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
            Some((role, lead, ..)) => FusionResultV1::Membership {
                role: Some(role),
                lead_session_id: Some(lead),
            },
            None => FusionResultV1::Membership {
                role: None,
                lead_session_id: None,
            },
        }),
        FusionCommandV1::StopPair { lead_session_id } => {
            // The lead is interrupted first and whatever the sidekick's stop
            // barrier proves, so it cannot brief again meanwhile; each failure
            // is reported, never acknowledged as a stop.
            // Only a Fusion lead is stopped: any other session id is refused
            // before the first side effect (a sidekick is never interrupted
            // behind the broker's stop barrier).
            validate_id(&lead_session_id)?;
            if !matches!(
                broker.membership(&lead_session_id),
                Some((FusionRoleName::Lead, ..))
            ) {
                return Err(WorkspaceError::not_found());
            }
            // The pair is paused before anything is interrupted (ADR-076):
            // no follow-up can wake the lead and no brief is admitted while
            // the stop runs, and both stay off until the person resumes the
            // pair or a message the person wrote is admitted in the lead chat.
            // A failed journal write keeps the pause in this process; the stop
            // still runs and the failure is returned after it.
            let saved = broker.pause_pair(&lead_session_id).await.map_err(refused)?;
            // The lead's start and any prompt still being admitted finish
            // first (operation gate); queued input is paused and the composer
            // gate is held before the status decides whether to interrupt. The
            // gates are released before the broker's own stop, which takes the
            // operation gate again.
            let lead = async {
                let _operation = authorize_live_session(host, &lead_session_id).await?;
                host.workspace.interrupt_lead_turn(&lead_session_id).await
            }
            .await;
            let sidekick = broker.stop_sidekick(&lead_session_id).await;
            sidekick.map_err(refused)?;
            lead?;
            if !saved {
                return Err(WorkspaceError::io());
            }
            Ok(FusionResultV1::Accepted {})
        }
        FusionCommandV1::StopSidekick { lead_session_id } => {
            broker
                .person_stop_sidekick(&lead_session_id)
                .await
                .map_err(refused)?;
            Ok(FusionResultV1::Accepted {})
        }
        FusionCommandV1::ChangeSidekick {
            lead_session_id,
            change,
        } => {
            validate_id(&lead_session_id)?;
            let broker = broker.clone();
            let lead = lead_session_id.clone();
            // Complete the journal transaction and any cleanup even if the panel closes.
            tokio::spawn(async move { broker.change_sidekick(&lead, change, false).await })
                .await
                .map_err(|_| WorkspaceError::io())??;
            state_of(&lead_session_id).await
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
        FusionCommandV1::ResumePair { lead_session_id } => {
            validate_id(&lead_session_id)?;
            broker
                .resume_pair(&lead_session_id)
                .await
                .map_err(refused)?;
            state_of(&lead_session_id).await
        }
        FusionCommandV1::CheckDelivery {
            lead_session_id,
            round_id,
        } => {
            validate_id(&lead_session_id)?;
            broker
                .check_delivery(&lead_session_id, &round_id)
                .await
                .map_err(refused)?;
            state_of(&lead_session_id).await
        }
        FusionCommandV1::DeliverAgain {
            lead_session_id,
            round_id,
        } => {
            validate_id(&lead_session_id)?;
            broker
                .deliver_again(&lead_session_id, &round_id)
                .await
                .map_err(refused)?;
            state_of(&lead_session_id).await
        }
        FusionCommandV1::DismissReport {
            lead_session_id,
            round_id,
        } => {
            validate_id(&lead_session_id)?;
            broker
                .dismiss_report(&lead_session_id, &round_id)
                .await
                .map_err(refused)?;
            state_of(&lead_session_id).await
        }
        FusionCommandV1::SteerSidekick {
            lead_session_id,
            text,
        } => {
            validate_id(&lead_session_id)?;
            broker
                .person_steer(&lead_session_id, &text)
                .await
                .map_err(refused)?;
            Ok(FusionResultV1::Accepted {})
        }
    }
}
