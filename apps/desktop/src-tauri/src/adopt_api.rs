//! Workspace adoption v1 (`workspace_adopt_v1`): continue a Pi session that
//! was started in the Pi terminal app as an ordinary PiUI chat.
//!
//! In a trusted Pi folder, outside safe mode, the host resolves the indexed
//! session to its session file with the classic live-start admission checks
//! (project ownership, header project binding, a stable revision, separate
//! Pi and Prime roots), refuses Prime Agent folders and a session that the
//! classic live runtime or another process is still writing, returns the
//! chat already bound to that file, or registers a closed Pi chat bound to
//! it. The ordinary `openSession` then resumes it with `pi --session`. PiUI
//! never writes the session file and never passes a title Pi would write
//! into it. Concurrent terminal and PiUI writers remain risk R-06.

use crate::api::admit_adoption;
use crate::session_placement::{safe_mode_error, tool_error};
use crate::state::HostState;
use crate::workspace_api::WorkspaceError;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime};
use tauri::State;

pub const WORKSPACE_ADOPT_PROTOCOL: u8 = 1;
/// A session file written this recently may still be open in the terminal.
const QUIET_PERIOD: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAdoptRequestV1 {
    /// Absent for personal chats.
    #[serde(default)]
    pub project_id: Option<String>,
    /// The index session id from the session history view.
    pub session_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAdoptResultV1 {
    pub protocol: u8,
    /// The workspace chat to open.
    pub session_id: String,
    /// False when a chat was already bound to this session file.
    pub created: bool,
}

fn recently_written(modified: Option<SystemTime>, now: SystemTime) -> bool {
    modified.is_some_and(|modified| {
        now.duration_since(modified)
            .map_or(true, |elapsed| elapsed < QUIET_PERIOD)
    })
}

fn still_active() -> WorkspaceError {
    tool_error(
        "SESSION_ALREADY_ACTIVE",
        "This session was written moments ago and may still be open in the Pi terminal app. Close it there, then try again.",
    )
}

/// Body of `workspace_adopt_v1`, independent of the Tauri state wrapper.
pub(crate) async fn adopt(
    host: &HostState,
    request: WorkspaceAdoptRequestV1,
) -> Result<WorkspaceAdoptResultV1, WorkspaceError> {
    adopt_at(host, request, SystemTime::now()).await
}

pub(crate) async fn adopt_at(
    host: &HostState,
    request: WorkspaceAdoptRequestV1,
    now: SystemTime,
) -> Result<WorkspaceAdoptResultV1, WorkspaceError> {
    if host.safe_mode {
        return Err(safe_mode_error());
    }
    let project_id = match request.project_id {
        Some(project_id) if host.is_personal_workspace(&project_id) => {
            return Err(tool_error(
                "INVALID_ARGUMENT",
                "Check the required fields and try again.",
            ));
        }
        Some(project_id) => project_id,
        None => host.personal_workspace.project_id.clone(),
    };
    if request.session_id.trim().is_empty() || request.session_id.chars().any(char::is_control) {
        return Err(tool_error(
            "INVALID_ARGUMENT",
            "Check the required fields and try again.",
        ));
    }
    // Serialized with starts, trust changes and other workspace commands.
    let _operation = host.live_runtime_operation_gate.lock().await;
    let admission = admit_adoption(host, &project_id, &request.session_id)?;
    if let Some(session_id) = host
        .workspace
        .bound_pi_session(&project_id, &admission.session_file)?
    {
        return Ok(WorkspaceAdoptResultV1 {
            protocol: WORKSPACE_ADOPT_PROTOCOL,
            session_id,
            created: false,
        });
    }
    let modified = std::fs::metadata(&admission.session_file)
        .and_then(|metadata| metadata.modified())
        .ok();
    if recently_written(modified, now) {
        return Err(still_active());
    }
    let (session_id, created) = host.workspace.register_adopted_pi_session(
        &project_id,
        admission.pi_session_id,
        &admission.session_file,
        admission.title,
    )?;
    Ok(WorkspaceAdoptResultV1 {
        protocol: WORKSPACE_ADOPT_PROTOCOL,
        session_id,
        created,
    })
}

#[tauri::command]
pub async fn workspace_adopt_v1(
    state: State<'_, HostState>,
    request: WorkspaceAdoptRequestV1,
) -> Result<WorkspaceAdoptResultV1, WorkspaceError> {
    adopt(state.inner(), request).await
}

#[cfg(test)]
#[path = "adopt_api_tests.rs"]
mod tests;
