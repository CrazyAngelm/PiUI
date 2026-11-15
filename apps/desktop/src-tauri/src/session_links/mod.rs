//! Linked chats (ADR-069): host metadata and typed native sends, never another harness.
pub(crate) mod broker;
pub(crate) mod model;
pub(crate) mod store;
#[cfg(test)]
mod tests;

use crate::api::verified_project_directory;
use crate::session_placement::SessionPlacement;
use crate::state::HostState;
use crate::workspace_api::{
    SessionLinksHooks, WorkspaceError, WorkspaceLaunchRequest, event_publisher, linked_chat_history,
};
use broker::{ChildLaunch, HostFuture, LinksBroker, LinksHost, SessionInfo};
use model::{BranchOrigin, CHANGED_EVENT, Command, CommandResult, ErrorCode, LinksError};
use piui_runtime::workspace_runtime::{
    BlockKind, HarnessAvailability, HarnessKind, PromptMode, probe_native_harnesses,
};
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

#[derive(Clone)]
pub(crate) struct SessionLinksService {
    pub(crate) broker: LinksBroker,
}
impl SessionLinksService {
    pub(crate) fn open(app: &AppHandle, app_data_dir: &Path) -> std::io::Result<Self> {
        let store = store::FileLinksStore::open(app_data_dir)?;
        // HostState is installed later in setup; the caller applies its persisted preference.
        let broker = LinksBroker::new(
            Arc::new(TauriLinksHost { app: app.clone() }),
            Arc::new(store),
            false,
            codex_sandbox_configured(),
        );
        let events = app.clone();
        broker.set_notifier(Arc::new(move |session_id, revision| {
            let _ = events.emit(
                CHANGED_EVENT,
                serde_json::json!({"sessionId":session_id,"revision":revision}),
            );
        }));
        Ok(Self { broker })
    }
    pub(crate) fn set_enabled(&self, enabled: bool) {
        self.broker.set_enabled(enabled);
    }
    pub(crate) fn hooks(&self) -> Arc<dyn SessionLinksHooks> {
        Arc::new(self.clone())
    }
    pub(crate) fn resume(&self) {
        let broker = self.broker.clone();
        tauri::async_runtime::spawn(async move { broker.resume_deliveries().await });
    }
    #[allow(
        dead_code,
        reason = "host entry point reserved for the subsequent branch brief"
    )]
    pub(crate) async fn adopt_child(
        &self,
        parent: &str,
        child: &str,
        kind: model::LinkKind,
    ) -> Result<(), ErrorCode> {
        self.broker.adopt_child(parent, child, kind).await
    }
}
impl SessionLinksHooks for SessionLinksService {
    fn enabled(&self) -> bool {
        self.broker.enabled()
    }
    fn handle(
        &self,
        caller_session_id: String,
        operation: Map<String, Value>,
    ) -> HostFuture<Value> {
        let broker = self.broker.clone();
        Box::pin(async move { broker.handle(&caller_session_id, operation).await })
    }
    fn person_message(&self, session_id: String) -> HostFuture<()> {
        let broker = self.broker.clone();
        Box::pin(async move { broker.person_message(&session_id).await })
    }
    fn session_deleted(&self, session_id: String) -> HostFuture<()> {
        let broker = self.broker.clone();
        Box::pin(async move { broker.session_deleted(&session_id).await })
    }
    fn record_branch(&self, child: &str, origin: BranchOrigin) -> bool {
        self.broker.record_branch(child, origin).is_ok()
    }
    fn forget_branch(&self, child: &str) {
        self.broker.forget_branch(child);
    }
    fn branch_origin(&self, child: &str) -> Option<BranchOrigin> {
        self.broker.branch_origin(child)
    }
    fn adopt_branch(&self, parent: String, child: String) -> HostFuture<()> {
        let broker = self.broker.clone();
        Box::pin(async move {
            let _ = broker
                .adopt_child(&parent, &child, model::LinkKind::Branch)
                .await;
        })
    }
}

fn codex_sandbox_configured() -> bool {
    if !cfg!(windows) {
        return true;
    }
    let home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|home| Path::new(&home).join(".codex")));
    home.and_then(|home| std::fs::read_to_string(home.join("config.toml")).ok())
        .is_some_and(|toml| crate::fusion::logic::codex_windows_sandbox_configured(&toml))
}
fn failure(error: WorkspaceError) -> ErrorCode {
    match error.code {
        "CONFLICT" | "TURN_ACTIVE" | "QUEUE_PENDING" => ErrorCode::Busy,
        "UNAVAILABLE"
        | "ACP_TRUST_REQUIRED"
        | "ACP_SIGN_IN_REQUIRED"
        | "SIGN_IN_REQUIRED"
        | "NANO_SIGN_IN_REQUIRED" => ErrorCode::HarnessUnavailable,
        "NOT_FOUND" => ErrorCode::UnknownSession,
        "SAFE_MODE" | "NOT_TRUSTED" => ErrorCode::NotAllowed,
        _ => ErrorCode::Unavailable,
    }
}
async fn gated<T>(
    host: &HostState,
    session_id: &str,
    action: impl AsyncFnOnce(&HostState) -> Result<T, WorkspaceError>,
) -> Result<T, ErrorCode> {
    if host.safe_mode {
        return Err(ErrorCode::NotAllowed);
    }
    host.workspace.wait_for_pending_start(session_id).await;
    let _operation = host.live_runtime_operation_gate.lock().await;
    let (_, workspace_id) = host
        .workspace
        .session_title(session_id)
        .ok_or(ErrorCode::UnknownSession)?;
    verified_project_directory(host, &workspace_id, true).map_err(|_| ErrorCode::NotAllowed)?;
    action(host).await.map_err(failure)
}
struct TauriLinksHost {
    app: AppHandle,
}
impl LinksHost for TauriLinksHost {
    fn session(&self, session_id: &str) -> Result<SessionInfo, ErrorCode> {
        let host = self
            .app
            .try_state::<HostState>()
            .ok_or(ErrorCode::Unavailable)?;
        let mut info = host
            .workspace
            .linked_chat_info(session_id)
            .map_err(failure)?;
        info.allowed &= !host.safe_mode;
        Ok(info)
    }
    fn available(&self, harness: HarnessKind) -> bool {
        let Some(host) = self.app.try_state::<HostState>() else {
            return false;
        };
        match harness {
            HarnessKind::Acp(agent) => host
                .workspace
                .acp_agents()
                .view(agent)
                .is_some_and(|view| view.state == crate::acp_agents::HarnessState::Ready),
            harness => probe_native_harnesses()
                .iter()
                .any(|item| item.kind == harness && item.status == HarnessAvailability::Available),
        }
    }
    fn launch(&self, launch: ChildLaunch) -> HostFuture<Result<(), ErrorCode>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            if host.safe_mode {
                return Err(ErrorCode::NotAllowed);
            }
            let authorize = |workspace_id: &str| {
                verified_project_directory(host.inner(), workspace_id, true)
                    .map_err(WorkspaceError::from)
            };
            let request = WorkspaceLaunchRequest {
                session_id: Some(launch.session_id.clone()),
                workspace_id: launch.workspace_id.clone(),
                harness: launch.harness,
                title: Some(launch.title),
                profile_id: None,
                run_id: None,
                member_id: None,
                task_id: None,
                model: launch.model,
                thinking_level: launch.thinking_level,
                instructions: None,
                base_instructions: None,
                service_tier: None,
                resource_rules: None,
                permission_mode: launch.permission_mode,
                network_access: launch.network_access,
                allowed_tools: None,
                native_subagents: None,
                dependency_history_references: Vec::new(),
                dependency_outputs: Vec::new(),
                coordinator: None,
            };
            let parent_placement = host
                .workspace
                .tools()
                .placement(&launch.parent_session_id)
                .map_err(failure)?;
            if let Some(parent_placement) = parent_placement
                && parent_placement.worktree.is_some()
            {
                let mut placement = SessionPlacement::new(&launch.session_id, &launch.workspace_id);
                placement.worktree = parent_placement.worktree;
                host.workspace
                    .create_placed_session(
                        &host.live_runtime_operation_gate,
                        &authorize,
                        request,
                        placement,
                        event_publisher(app.clone()),
                    )
                    .await
                    .map(|_| ())
                    .map_err(failure)
            } else {
                host.workspace
                    .create_session(
                        &host.live_runtime_operation_gate,
                        &authorize,
                        request,
                        event_publisher(app.clone()),
                    )
                    .await
                    .map(|_| ())
                    .map_err(failure)
            }
        })
    }
    fn ensure_live(&self, session_id: String) -> HostFuture<Result<(), ErrorCode>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            if host.safe_mode {
                return Err(ErrorCode::NotAllowed);
            }
            if host
                .workspace
                .subscribe_turns(&session_id)
                .is_ok_and(|turns| turns.is_some())
            {
                return Ok(());
            }
            let authorize = |workspace_id: &str| {
                verified_project_directory(host.inner(), workspace_id, true)
                    .map_err(WorkspaceError::from)
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
                .map_err(failure)
        })
    }
    fn turns(
        &self,
        session_id: &str,
    ) -> Result<watch::Receiver<crate::workspace_api::TurnState>, ErrorCode> {
        self.app
            .state::<HostState>()
            .workspace
            .subscribe_turns(session_id)
            .map_err(failure)?
            .ok_or(ErrorCode::Unavailable)
    }
    fn send(
        &self,
        session_id: String,
        text: String,
        mode: PromptMode,
    ) -> HostFuture<Result<(), ErrorCode>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            gated(host.inner(), &session_id, async |host| {
                host.workspace.send(&session_id, text, mode).await
            })
            .await
        })
    }
    fn interrupt(&self, session_id: String) -> HostFuture<Result<(), ErrorCode>> {
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
    ) -> HostFuture<Result<Option<(String, String)>, ErrorCode>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            Ok(linked_chat_history(host.inner(), &session_id)
                .await
                .map_err(failure)?
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
    ) -> HostFuture<Result<Option<String>, ErrorCode>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = app.state::<HostState>();
            Ok(linked_chat_history(host.inner(), &session_id)
                .await
                .map_err(failure)?
                .into_iter()
                .find(|block| block.kind == BlockKind::Assistant && block.id == block_id)
                .and_then(|block| block.text))
        })
    }
}

#[tauri::command]
pub(crate) async fn session_links_command_v1(
    state: State<'_, HostState>,
    service: State<'_, SessionLinksService>,
    command: Command,
) -> Result<CommandResult, LinksError> {
    let changes = !matches!(command, Command::Find { .. } | Command::Settings {});
    if changes && state.safe_mode {
        return Err(ErrorCode::ReadOnly.into());
    }
    let broker = &service.broker;
    match command {
        Command::Find { session_id } => {
            let (chats, revision) = broker.list(&session_id)?;
            Ok(CommandResult::Links {
                session_id,
                chats,
                revision,
            })
        }
        Command::Link {
            session_id,
            other_session_id,
        } => {
            broker.link(&session_id, &other_session_id)?;
            Ok(CommandResult::Done)
        }
        Command::Unlink {
            session_id,
            other_session_id,
        } => {
            broker.unlink(&session_id, &other_session_id)?;
            Ok(CommandResult::Done)
        }
        Command::Send {
            from_session_id,
            to_session_id,
            text,
        } => {
            broker
                .send_person(&from_session_id, &to_session_id, &text)
                .await?;
            Ok(CommandResult::Done)
        }
        Command::Deliver {
            session_id,
            from_session_id,
        } => {
            broker.deliver(&session_id, &from_session_id).await?;
            Ok(CommandResult::Done)
        }
        Command::Settings {} => {
            let enabled = if state.safe_mode {
                false
            } else {
                state
                    .index
                    .lock()
                    .map_err(|_| ErrorCode::Io)?
                    .linked_chats()
                    .map_err(|_| ErrorCode::Io)?
            };
            Ok(CommandResult::Settings {
                enabled,
                read_only: state.safe_mode,
            })
        }
        Command::Update { enabled } => {
            let mut index = state.index.lock().map_err(|_| ErrorCode::Io)?;
            index.set_linked_chats(enabled).map_err(|_| ErrorCode::Io)?;
            broker.set_enabled(enabled);
            Ok(CommandResult::Settings {
                enabled,
                read_only: false,
            })
        }
    }
}
