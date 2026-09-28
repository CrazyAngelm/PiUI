//! Project board v1 (`board_command_v1`, ADR-041, docs/BOARD.md).
//!
//! Each project has one durable, person-owned board of cards. The person
//! acts through `board_command_v1` (actor `person`); agents act only through
//! the host `board` tool ([`agent`]), whose actor comes from the session
//! binding. `get` and `sessionCards` work in safe mode; every change is
//! refused there (`SAFE_MODE`). The board never writes into the project
//! folder and never evaluates card text.

pub(crate) mod agent;
pub(crate) mod model;
pub(crate) mod ops;
pub(crate) mod similarity;
pub(crate) mod store;

#[cfg(test)]
mod tests;

pub(crate) use model::{BOARD_CHANGED_EVENT_V1, BoardCommandV1, BoardResultV1};
pub(crate) use ops::{Availability, BoardService, TeammateRef};

use crate::api::verified_project_directory;
use crate::orchestration_api::OrchestrationApiState;
use crate::state::HostState;
use crate::workspace_api::WorkspaceError;
use model::{BOARD_PROTOCOL, BoardActor, BoardError};
use ops::SessionRef;
use tauri::State;

/// Harness recorded on a chat link when the host no longer knows the chat's
/// harness (the board command does not carry it).
const UNKNOWN_HARNESS: &str = "unknown";

/// The harness id a card link records (`claude-code`, `codex`, `acp:<id>`…).
pub(crate) fn harness_label(harness: piui_runtime::workspace_runtime::HarnessKind) -> String {
    serde_json::to_value(harness)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| UNKNOWN_HARNESS.to_owned())
}

/// Body of `board_command_v1`, independent of the Tauri state wrappers.
/// `teammates` are the project's teammates (for assign, mentions, starts);
/// `harness_of` names the harness of a chat the person links a card to.
pub(crate) fn dispatch(
    service: &BoardService,
    teammates: &[TeammateRef],
    command: BoardCommandV1,
    harness_of: &dyn Fn(&str) -> Option<String>,
) -> Result<BoardResultV1, BoardError> {
    let person_session = |session_id: String| SessionRef {
        harness: harness_of(&session_id).unwrap_or_else(|| UNKNOWN_HARNESS.to_owned()),
        session_id,
    };
    let protocol = BOARD_PROTOCOL;
    let person = BoardActor::Person;
    let card_result = |(card, board_revision): (model::Card, u64)| BoardResultV1::Card {
        protocol,
        card,
        board_revision,
    };
    Ok(match command {
        BoardCommandV1::Get { workspace_id } => BoardResultV1::Board {
            protocol,
            board: service.get(&workspace_id)?,
        },
        BoardCommandV1::SetEnabled {
            workspace_id,
            enabled,
        } => BoardResultV1::Board {
            protocol,
            board: service.set_enabled(&workspace_id, enabled)?,
        },
        BoardCommandV1::UpdateSettings {
            workspace_id,
            expected_revision,
            settings,
        } => BoardResultV1::Board {
            protocol,
            board: service.update_settings(&workspace_id, expected_revision, settings)?,
        },
        BoardCommandV1::CreateCard {
            workspace_id,
            card,
            status,
            session_id,
        } => {
            let session = session_id.map(person_session);
            card_result(service.create_card(
                &workspace_id,
                &person,
                card,
                status,
                session.as_ref(),
            )?)
        }
        BoardCommandV1::UpdateCard {
            workspace_id,
            card_id,
            expected_revision,
            patch,
        } => card_result(service.update_card(
            &workspace_id,
            &person,
            &card_id,
            Some(expected_revision),
            patch,
            false,
        )?),
        BoardCommandV1::MoveCard {
            workspace_id,
            card_id,
            to,
            order,
        } => card_result(service.move_card(
            &workspace_id,
            &person,
            &card_id,
            to,
            order,
            None,
            true,
            teammates,
        )?),
        BoardCommandV1::DeleteCard {
            workspace_id,
            card_id,
            expected_revision,
        } => {
            let board_revision = service.delete_card(&workspace_id, &card_id, expected_revision)?;
            BoardResultV1::Deleted {
                protocol,
                card_id,
                board_revision,
            }
        }
        BoardCommandV1::Comment {
            workspace_id,
            card_id,
            body,
            mentions,
        } => card_result(service.comment(
            &workspace_id,
            &person,
            &card_id,
            body,
            mentions.unwrap_or_default(),
            None,
            teammates,
        )?),
        BoardCommandV1::Assign {
            workspace_id,
            card_id,
            teammate_id,
            start,
        } => {
            let (card, board_revision, _) = service.assign(
                &workspace_id,
                &person,
                &card_id,
                teammate_id.as_deref(),
                start,
                0,
                true,
                teammates,
            )?;
            card_result((card, board_revision))
        }
        BoardCommandV1::StartRun {
            workspace_id,
            card_id,
        } => card_result(service.start_run(&workspace_id, &card_id, teammates)?),
        BoardCommandV1::ResolvePendingStart {
            workspace_id,
            pending_start_id,
            accept,
        } => BoardResultV1::Board {
            protocol,
            board: service.resolve_pending_start(
                &workspace_id,
                &pending_start_id,
                accept,
                teammates,
            )?,
        },
        BoardCommandV1::ReleaseClaim {
            workspace_id,
            card_id,
        } => card_result(service.release_claim(&workspace_id, &person, &card_id)?),
        BoardCommandV1::LinkSession {
            workspace_id,
            card_id,
            session_id,
        } => card_result(service.link_session(
            &workspace_id,
            &person,
            &card_id,
            &person_session(session_id),
        )?),
        BoardCommandV1::UnlinkSession {
            workspace_id,
            card_id,
            session_id,
        } => card_result(service.unlink_session(&workspace_id, &person, &card_id, &session_id)?),
        BoardCommandV1::SessionCards {
            workspace_id,
            session_id,
        } => BoardResultV1::SessionCards {
            protocol,
            cards: service.session_cards(&workspace_id, &session_id)?,
        },
        BoardCommandV1::Undo {
            workspace_id,
            card_id,
            activity_id,
        } => card_result(service.undo(&workspace_id, &card_id, &activity_id)?),
        BoardCommandV1::ResolveProposal {
            workspace_id,
            proposal_id,
            accept,
        } => BoardResultV1::Board {
            protocol,
            board: service.resolve_proposal(&workspace_id, &proposal_id, accept, teammates)?,
        },
    })
}

/// The chat a command links a card to, which must belong to its project.
fn linked_session(command: &BoardCommandV1) -> Option<&str> {
    match command {
        BoardCommandV1::CreateCard { session_id, .. } => session_id.as_deref(),
        BoardCommandV1::LinkSession { session_id, .. } => Some(session_id),
        _ => None,
    }
}

#[tauri::command]
pub async fn board_command_v1(
    host: State<'_, HostState>,
    orchestration: State<'_, OrchestrationApiState>,
    board: State<'_, BoardService>,
    command: BoardCommandV1,
) -> Result<BoardResultV1, WorkspaceError> {
    let workspace_id = command.workspace_id().to_owned();
    if host.safe_mode && !command.read_only() {
        return Err(BoardError::SafeMode.into());
    }
    verified_project_directory(&host, &workspace_id, false)
        .map_err(|_| BoardError::NotFound("That project is no longer available."))?;
    if let Some(session_id) = linked_session(&command) {
        let owner = host
            .workspace
            .session_workspace_id(session_id)
            .map_err(|_| BoardError::NotFound("That chat is no longer available."))?;
        if owner != workspace_id {
            return Err(BoardError::NotFound("That chat is no longer available.").into());
        }
    }
    let teammates = crate::teammates_api::teammate_refs_for(
        orchestration.inner(),
        board.inner(),
        &workspace_id,
    );
    // Board changes write generation files and may create runs: off the
    // async runtime threads.
    let service = board.inner().clone();
    let workspace = host.workspace.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let harness_of = |session_id: &str| {
            workspace
                .session_harness(session_id)
                .ok()
                .map(harness_label)
        };
        dispatch(&service, &teammates, command, &harness_of)
    })
    .await
    .map_err(|_| WorkspaceError::from(BoardError::Io))?
    .map_err(Into::into)
}
