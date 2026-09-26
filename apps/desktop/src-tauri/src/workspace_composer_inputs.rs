//! Composer inputs v1 (`workspace_composer_inputs_v1`, see
//! `contracts/workspace-composer-inputs-v1.ts`): image attachments, path
//! references, `@` project file names and native `/` commands and `$` skills.
//!
//! The WebView never names a path to read. The host reads only files the
//! user picked in the native dialog or dropped on the window (the drop paths
//! stay here, the WebView receives an opaque single-use drop id), keeps image
//! bytes in PiUI's app data and never writes into a project. File listings
//! are names of a trusted project only. Native commands are never executed:
//! the harness runs them when the user sends their text.

use super::attachments::{
    AttachmentError, AttachmentStore, Classified, FileReference, ImageType, MAX_FILES_PER_BATCH,
    MAX_IMAGE_BYTES, Rejection, RejectionReason, StoredImage, classify_user_file, display_name,
    display_path,
};
use super::*;
use base64::Engine as _;
use piui_runtime::workspace_runtime::{ComposerCatalog, NativeCommandEntry, NativeSkillEntry};
use std::time::{Duration, Instant};
use tauri::Manager as _;

pub const COMPOSER_INPUTS_PROTOCOL: u8 = 1;
pub const COMPOSER_DROP_EVENT: &str = "piui://composer-drop-v1";
/// A drop id is redeemable once, for this long.
const DROP_LIFETIME: Duration = Duration::from_secs(60);
const MAX_PENDING_DROPS: usize = 16;
/// Longest base64 text of a pasted image within [`MAX_IMAGE_BYTES`].
const MAX_PASTE_BASE64: usize = (MAX_IMAGE_BYTES as usize).div_ceil(3) * 4;
const MAX_PASTE_NAME_BYTES: usize = 1_024;
const MAX_WORKSPACE_ID_BYTES: usize = 256;
/// Most ids one discard names (the pending store holds at most 64).
const MAX_DISCARD_IDS: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ComposerInputsCommand {
    Pick {
        workspace_id: String,
    },
    Paste {
        workspace_id: String,
        name: String,
        data: String,
    },
    Drop {
        workspace_id: String,
        drop_id: String,
    },
    Preview {
        attachment_id: String,
    },
    Discard {
        attachment_ids: Vec<String>,
    },
    Files {
        workspace_id: String,
        query: String,
    },
    Catalog {
        session_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ComposerInputsResult {
    Attachments {
        protocol: u8,
        images: Vec<StoredImage>,
        files: Vec<FileReference>,
        rejected: Vec<Rejection>,
    },
    Preview {
        protocol: u8,
        attachment_id: String,
        mime_type: ImageType,
        data: String,
    },
    Discarded {
        protocol: u8,
    },
    Files {
        protocol: u8,
        workspace_id: String,
        query: String,
        files: Vec<String>,
        truncated: bool,
    },
    Catalog {
        protocol: u8,
        session_id: String,
        commands: Vec<NativeCommandEntry>,
        skills: Vec<NativeSkillEntry>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DropEventKind {
    Enter,
    Leave,
    Drop,
}

/// An OS drag over or drop on the window. Paths never leave the host.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerDropEvent {
    pub protocol: u8,
    #[serde(rename = "type")]
    pub kind: DropEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

/// Paths of recent OS drops, each redeemable once by its opaque id.
#[derive(Default)]
pub struct ComposerDrops {
    pending: Mutex<HashMap<String, (Vec<PathBuf>, Instant)>>,
}

impl ComposerDrops {
    /// Keeps the paths of one drop and returns its id.
    pub(crate) fn register(&self, paths: Vec<PathBuf>) -> Option<String> {
        let mut pending = self.pending.lock().ok()?;
        pending.retain(|_, (_, created)| created.elapsed() <= DROP_LIFETIME);
        if pending.len() >= MAX_PENDING_DROPS {
            let oldest = pending
                .iter()
                .min_by_key(|(_, (_, created))| *created)
                .map(|(id, _)| id.clone())?;
            pending.remove(&oldest);
        }
        let id = Uuid::new_v4().to_string();
        pending.insert(id.clone(), (paths, Instant::now()));
        Some(id)
    }

    fn take(&self, id: &str) -> Option<Vec<PathBuf>> {
        let (paths, created) = self.pending.lock().ok()?.remove(id)?;
        (created.elapsed() <= DROP_LIFETIME).then_some(paths)
    }
}

fn attachment_unavailable() -> WorkspaceError {
    WorkspaceError {
        code: "ATTACHMENT_UNAVAILABLE",
        message: "An attached image is no longer available. Attach it again.",
        recoverable: true,
    }
}

fn files_unavailable() -> WorkspaceError {
    WorkspaceError {
        code: "FILES_UNAVAILABLE",
        message: "The project files could not be listed.",
        recoverable: true,
    }
}

fn drop_expired() -> WorkspaceError {
    WorkspaceError {
        code: "DROP_EXPIRED",
        message: "The dropped files are no longer available. Drop them again.",
        recoverable: true,
    }
}

fn validate_workspace_id(value: &str) -> Result<(), WorkspaceError> {
    if value.len() > MAX_WORKSPACE_ID_BYTES {
        return Err(WorkspaceError::invalid());
    }
    validate_token(value)
}

/// Stores or references each user-chosen path (at most ten per batch).
fn classify_batch(
    store: &AttachmentStore,
    paths: &[PathBuf],
    project_root: &Path,
) -> ComposerInputsResult {
    let mut images = Vec::new();
    let mut files = Vec::new();
    let mut rejected = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if index >= MAX_FILES_PER_BATCH {
            rejected.push(Rejection {
                name: display_name(
                    &path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    "File",
                ),
                reason: RejectionReason::Limit,
            });
            continue;
        }
        match classify_user_file(store, path, Some(project_root)) {
            Classified::Image(image) => images.push(image),
            Classified::File(file) => files.push(file),
            Classified::Rejected(rejection) => rejected.push(rejection),
        }
    }
    ComposerInputsResult::Attachments {
        protocol: COMPOSER_INPUTS_PROTOCOL,
        images,
        files,
        rejected,
    }
}

/// The trusted project folder of a composer, or a typed refusal.
fn project_root(host: &HostState, workspace_id: &str) -> Result<PathBuf, WorkspaceError> {
    validate_workspace_id(workspace_id)?;
    Ok(verified_project_directory(host, workspace_id, true)?
        .canonical_path()
        .to_path_buf())
}

/// The native dialog seam: production opens the OS file picker; tests
/// return fixed paths. `None` means the user cancelled.
pub(crate) type PickFiles = Box<dyn FnOnce(PathBuf) -> Option<Vec<PathBuf>> + Send>;

fn native_pick() -> PickFiles {
    // The shell dialog wants an ordinary path, not Windows' verbatim spelling.
    Box::new(|directory| {
        rfd::FileDialog::new()
            .set_directory(display_path(&directory))
            .pick_files()
    })
}

/// The command without the Tauri boundary.
pub(crate) async fn run_composer_inputs(
    host: &HostState,
    drops: &ComposerDrops,
    command: ComposerInputsCommand,
    pick: PickFiles,
) -> Result<ComposerInputsResult, WorkspaceError> {
    if host.safe_mode {
        return Err(WorkspaceError::safe_mode());
    }
    let store = &host.workspace.inner.attachments;
    match command {
        ComposerInputsCommand::Pick { workspace_id } => {
            let root = project_root(host, &workspace_id)?;
            // The dialog is modal to the user, not to other host operations.
            let chosen = tokio::task::spawn_blocking({
                let root = root.clone();
                move || pick(root)
            })
            .await
            .map_err(|_| WorkspaceError::runtime())?
            .unwrap_or_default();
            // Trust may have changed while the dialog was open.
            let root = project_root(host, &workspace_id)?;
            Ok(classify_batch(store, &chosen, &root))
        }
        ComposerInputsCommand::Drop {
            workspace_id,
            drop_id,
        } => {
            validate_session_id(&drop_id)?;
            let root = project_root(host, &workspace_id)?;
            let paths = drops.take(&drop_id).ok_or_else(drop_expired)?;
            Ok(classify_batch(store, &paths, &root))
        }
        ComposerInputsCommand::Paste {
            workspace_id,
            name,
            data,
        } => {
            project_root(host, &workspace_id)?;
            if name.len() > MAX_PASTE_NAME_BYTES {
                return Err(WorkspaceError::invalid());
            }
            let name = display_name(&name, "Pasted image");
            let rejected = |reason| ComposerInputsResult::Attachments {
                protocol: COMPOSER_INPUTS_PROTOCOL,
                images: Vec::new(),
                files: Vec::new(),
                rejected: vec![Rejection {
                    name: name.clone(),
                    reason,
                }],
            };
            if data.len() > MAX_PASTE_BASE64 {
                return Ok(rejected(RejectionReason::TooLarge));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .map_err(|_| WorkspaceError::invalid())?;
            match store.insert(&name, &bytes) {
                Ok(image) => Ok(ComposerInputsResult::Attachments {
                    protocol: COMPOSER_INPUTS_PROTOCOL,
                    images: vec![image],
                    files: Vec::new(),
                    rejected: Vec::new(),
                }),
                Err(AttachmentError::TooLarge) => Ok(rejected(RejectionReason::TooLarge)),
                Err(AttachmentError::NotAnImage) => Ok(rejected(RejectionReason::NotAnImage)),
                Err(AttachmentError::Limit) => Ok(rejected(RejectionReason::Limit)),
                Err(AttachmentError::NotFound | AttachmentError::Io) => Err(WorkspaceError::io()),
            }
        }
        ComposerInputsCommand::Preview { attachment_id } => {
            validate_session_id(&attachment_id)?;
            let (image, bytes) = store
                .preview(&attachment_id)
                .map_err(|_| attachment_unavailable())?;
            Ok(ComposerInputsResult::Preview {
                protocol: COMPOSER_INPUTS_PROTOCOL,
                attachment_id,
                mime_type: image.mime_type,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            })
        }
        ComposerInputsCommand::Discard { attachment_ids } => {
            if attachment_ids.len() > MAX_DISCARD_IDS {
                return Err(WorkspaceError::invalid());
            }
            for id in &attachment_ids {
                validate_session_id(id)?;
            }
            store
                .discard(&attachment_ids)
                .map_err(|_| WorkspaceError::io())?;
            Ok(ComposerInputsResult::Discarded {
                protocol: COMPOSER_INPUTS_PROTOCOL,
            })
        }
        ComposerInputsCommand::Files {
            workspace_id,
            query,
        } => {
            let root = project_root(host, &workspace_id)?;
            let listing = {
                let query = query.clone();
                tokio::task::spawn_blocking(move || {
                    piui_platform::list_project_files(&root, &query)
                })
                .await
                .map_err(|_| files_unavailable())?
            }
            .map_err(|error| match error {
                piui_platform::ProjectFilesError::InvalidQuery => WorkspaceError::invalid(),
                piui_platform::ProjectFilesError::Unreadable => files_unavailable(),
            })?;
            Ok(ComposerInputsResult::Files {
                protocol: COMPOSER_INPUTS_PROTOCOL,
                workspace_id,
                query,
                files: listing.files,
                truncated: listing.truncated,
            })
        }
        ComposerInputsCommand::Catalog { session_id } => {
            validate_session_id(&session_id)?;
            let _operation = authorize_live_session(host, &session_id).await?;
            if host.workspace.record(&session_id)?.run_id.is_some() {
                return Err(WorkspaceError::not_supported());
            }
            let (runtime, _) = host
                .workspace
                .live_runtime(&session_id)?
                .ok_or_else(WorkspaceError::closed)?;
            // A harness without a catalog has no native entries to offer.
            let catalog = match runtime.composer_catalog().await {
                Ok(catalog) => catalog,
                Err(NativeRuntimeError::Bridge(BridgeFailureCode::UnsupportedMethod)) => {
                    ComposerCatalog::default()
                }
                Err(_) => return Err(WorkspaceError::runtime()),
            };
            Ok(ComposerInputsResult::Catalog {
                protocol: COMPOSER_INPUTS_PROTOCOL,
                session_id,
                commands: catalog.commands,
                skills: catalog.skills,
            })
        }
    }
}

#[tauri::command]
pub async fn workspace_composer_inputs_v1(
    state: State<'_, HostState>,
    drops: State<'_, ComposerDrops>,
    command: ComposerInputsCommand,
) -> Result<ComposerInputsResult, WorkspaceError> {
    run_composer_inputs(state.inner(), drops.inner(), command, native_pick()).await
}

/// The WebView event for one window drag-and-drop event, registering the
/// paths of a drop. Safe mode never accepts drops.
pub(crate) fn drop_event(
    drops: &ComposerDrops,
    safe_mode: bool,
    event: &tauri::DragDropEvent,
) -> Option<ComposerDropEvent> {
    if safe_mode {
        return None;
    }
    // The WebView learns a count and an opaque id, never the paths.
    let (kind, drop_id, count) = match event {
        tauri::DragDropEvent::Enter { paths, .. } => {
            (DropEventKind::Enter, None, Some(paths.len()))
        }
        tauri::DragDropEvent::Drop { paths, .. } if paths.is_empty() => {
            (DropEventKind::Leave, None, None)
        }
        tauri::DragDropEvent::Drop { paths, .. } => (
            DropEventKind::Drop,
            Some(drops.register(paths.clone())?),
            Some(paths.len()),
        ),
        tauri::DragDropEvent::Leave => (DropEventKind::Leave, None, None),
        _ => return None,
    };
    Some(ComposerDropEvent {
        protocol: COMPOSER_INPUTS_PROTOCOL,
        kind,
        drop_id,
        count,
    })
}

/// Registers the drop registry and forwards OS file drags over the main
/// window to the composers as path-free events.
pub fn watch_file_drops(app: &AppHandle) {
    app.manage(ComposerDrops::default());
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        let tauri::WindowEvent::DragDrop(drag) = event else {
            return;
        };
        let safe_mode = handle
            .try_state::<HostState>()
            .is_none_or(|state| state.safe_mode);
        let Some(drops) = handle.try_state::<ComposerDrops>() else {
            return;
        };
        if let Some(payload) = drop_event(&drops, safe_mode, drag) {
            let _ = handle.emit(COMPOSER_DROP_EVENT, payload);
        }
    });
}

#[cfg(test)]
#[path = "workspace_composer_inputs_tests.rs"]
mod tests;
