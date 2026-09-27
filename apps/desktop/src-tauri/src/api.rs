use crate::contributions::{PiUiContributionCatalog, project_global_contributions};
use crate::dto::{
    ApiError, ApiExtensionSummaryV10, ApiPreferences, ApiProjectSummary, ApiSessionCatalogEvent,
    ApiSessionCatalogSnapshot, ApiSessionSummary, ApiSessionTree, ApiSnapshot, ApiTimelineBlock,
    ApiTimelinePage, api_tree,
};
use crate::state::{
    CatalogFreshness, CatalogRefreshContext, CatalogRefreshStart, CatalogRefreshStatus, HostState,
    SessionRevisionAdmission, TimelineCursorRecord, TimelineProjectionCache,
};
use piui_index::{
    AgentKind, ChatWidthPreference, DensityPreference, FontSizePreference, IndexError, Preferences,
    ProjectIndex, ReducedMotionPreference, ScanReport, SessionDiscoveryLimits, SessionSummary,
    ThemePreference, TrustState, discover_root_agent_sessions_for_project_incremental,
    discover_sessions_for_project_incremental, observe_project_file_bounded,
    verify_discovered_sessions_batch, verify_project_file_revision_bounded,
};
use piui_platform::ProjectDirectory;
use piui_runtime::{
    AgentExtensionOrigin, AgentExtensionResource, LifecycleState, list_global_extensions_for_agent,
    set_global_extension_enabled_for_agent,
};
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::MutexGuard;
use tauri::{Emitter, State};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_PROJECT_PATH_BYTES: usize = 32 * 1024;
const MAX_SESSION_RESCAN_BYTES: usize = 128 * 1024 * 1024;
const DEFAULT_TIMELINE_PAGE_SIZE: usize = 100;
const MAX_TIMELINE_CURSOR_BYTES: usize = 64;

/// A reconciliation can complete its host work without proving complete root
/// coverage. Such a pass updates safe rows but must not claim fresh catalog
/// authority or reset periodic full-integrity accounting.
struct ProjectRefreshOutcome {
    complete: bool,
}

/// Whether this caller actually acquired the catalog-refresh generation. A
/// runtime-exit hint retries only when it was coalesced behind an older scan.
struct CatalogRefreshAttempt {
    snapshot: ApiSessionCatalogSnapshot,
}
#[tauri::command]
pub fn bootstrap_v10(state: State<'_, HostState>) -> Result<ApiSnapshot, ApiError> {
    let index = lock_index(&state)?;
    let projects = index
        .list_projects()
        .map_err(|_| ApiError::io())?
        .into_iter()
        // The host-owned Chats workspace is intentionally a separate UI
        // scope, not an implicitly added user folder.
        .filter(|project| !state.is_personal_workspace(&project.id))
        .map(ApiProjectSummary::from)
        .collect();
    let preferences = index.preferences().map_err(|_| ApiError::io())?.into();
    Ok(ApiSnapshot {
        app_version: APP_VERSION,
        safe_mode: state.safe_mode,
        preferences,
        projects,
        selected_project_id: None,
        selected_session_id: None,
    })
}

/// Versioned v8 appearance command. Unlike the legacy route, both additional
/// display fields are required so a malformed partial v8 request fails closed.
#[tauri::command]
pub fn update_preferences_v8(
    state: State<'_, HostState>,
    theme: String,
    density: String,
    reduced_motion: String,
    font_size: String,
    chat_width: String,
) -> Result<ApiPreferences, ApiError> {
    update_preference_values(
        &state,
        theme,
        density,
        reduced_motion,
        Some(font_size),
        Some(chat_width),
    )
}

fn update_preference_values(
    state: &HostState,
    theme: String,
    density: String,
    reduced_motion: String,
    font_size: Option<String>,
    chat_width: Option<String>,
) -> Result<ApiPreferences, ApiError> {
    let theme = match theme.as_str() {
        "system" => ThemePreference::System,
        "dark" => ThemePreference::Dark,
        "light" => ThemePreference::Light,
        _ => return Err(ApiError::invalid()),
    };
    let density = match density.as_str() {
        "comfortable" => DensityPreference::Comfortable,
        "compact" => DensityPreference::Compact,
        _ => return Err(ApiError::invalid()),
    };
    let reduced_motion = match reduced_motion.as_str() {
        "system" => ReducedMotionPreference::System,
        "reduce" => ReducedMotionPreference::Reduce,
        _ => return Err(ApiError::invalid()),
    };
    let mut index = lock_index(state)?;
    let existing = index.preferences().map_err(|_| ApiError::io())?;
    let font_size = parse_font_size_preference(font_size.as_deref(), existing.font_size)?;
    let chat_width = parse_chat_width_preference(chat_width.as_deref(), existing.chat_width)?;
    index
        .update_preferences(Preferences {
            theme,
            density,
            reduced_motion,
            font_size,
            chat_width,
        })
        .map(ApiPreferences::from)
        .map_err(|_| ApiError::io())
}

fn parse_font_size_preference(
    value: Option<&str>,
    existing: FontSizePreference,
) -> Result<FontSizePreference, ApiError> {
    match value {
        Some("small") => Ok(FontSizePreference::Small),
        Some("medium") => Ok(FontSizePreference::Medium),
        Some("large") => Ok(FontSizePreference::Large),
        None => Ok(existing),
        _ => Err(ApiError::invalid()),
    }
}

fn parse_chat_width_preference(
    value: Option<&str>,
    existing: ChatWidthPreference,
) -> Result<ChatWidthPreference, ApiError> {
    match value {
        Some("wide") => Ok(ChatWidthPreference::Wide),
        Some("centered") => Ok(ChatWidthPreference::Centered),
        Some("focused") => Ok(ChatWidthPreference::Focused),
        None => Ok(existing),
        _ => Err(ApiError::invalid()),
    }
}

/// Versioned v10 route: lists the selected runtime's separate global inventory.
#[tauri::command]
pub async fn list_extensions_v10(
    state: State<'_, HostState>,
    agent_kind: String,
) -> Result<Vec<ApiExtensionSummaryV10>, ApiError> {
    list_extensions_for_agent(&state, parse_agent_kind(&agent_kind)?).await
}

async fn list_extensions_for_agent(
    state: &HostState,
    agent_kind: AgentKind,
) -> Result<Vec<ApiExtensionSummaryV10>, ApiError> {
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    let resources =
        list_global_extensions_for_agent(&state.personal_workspace.canonical_path, agent_kind)
            .await
            .map_err(|_| ApiError::runtime())?;
    Ok(api_extensions_v10(resources))
}

/// Projects optional declarative UI manifests for enabled global Pi packages.
/// Prime Agent resources never enter this Pi-only contribution surface. Invalid
/// or absent manifests degrade to an empty contribution; their Pi extension
/// backend remains enabled and usable through generic surfaces.
#[tauri::command]
pub async fn list_piui_contributions(
    state: State<'_, HostState>,
) -> Result<PiUiContributionCatalog, ApiError> {
    if state.safe_mode {
        return Ok(PiUiContributionCatalog::default());
    }
    let resources =
        list_global_extensions_for_agent(&state.personal_workspace.canonical_path, AgentKind::Pi)
            .await
            .map_err(|_| ApiError::runtime())?;
    Ok(project_global_contributions(&resources))
}

/// Versioned v10 route: changes only the named runtime's separate inventory.
#[tauri::command]
pub async fn set_extension_enabled_v10(
    state: State<'_, HostState>,
    agent_kind: String,
    extension_id: String,
    enabled: bool,
) -> Result<Vec<ApiExtensionSummaryV10>, ApiError> {
    set_extension_enabled_for_agent(
        &state,
        parse_agent_kind(&agent_kind)?,
        extension_id,
        enabled,
    )
    .await
}

async fn set_extension_enabled_for_agent(
    state: &HostState,
    agent_kind: AgentKind,
    extension_id: String,
    enabled: bool,
) -> Result<Vec<ApiExtensionSummaryV10>, ApiError> {
    if extension_id.len() != 36 || !extension_id.starts_with("ext-") {
        return Err(ApiError::invalid());
    }
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    let current =
        list_global_extensions_for_agent(&state.personal_workspace.canonical_path, agent_kind)
            .await
            .map_err(|_| ApiError::runtime())?;
    let target = current
        .iter()
        .find(|resource| extension_resource_id(resource) == extension_id)
        .ok_or_else(ApiError::not_found)?;
    let updated = set_global_extension_enabled_for_agent(
        &state.personal_workspace.canonical_path,
        agent_kind,
        &target.path,
        enabled,
    )
    .await
    .map_err(|_| ApiError::runtime())?;
    Ok(api_extensions_v10(updated))
}

fn api_extensions_v10(resources: Vec<AgentExtensionResource>) -> Vec<ApiExtensionSummaryV10> {
    resources
        .into_iter()
        .map(|resource| ApiExtensionSummaryV10 {
            id: extension_resource_id(&resource),
            agent_kind: match resource.agent_kind {
                AgentKind::Pi => "pi",
                AgentKind::PrimeAgent => "prime-agent",
            },
            name: resource.name,
            source: match resource.origin {
                AgentExtensionOrigin::TopLevel => "Global",
                AgentExtensionOrigin::Package => "Package",
            },
            enabled: resource.enabled,
        })
        .collect()
}

fn extension_resource_id(resource: &AgentExtensionResource) -> String {
    extension_resource_id_for(resource.agent_kind, &resource.path)
}

fn extension_resource_id_for(agent_kind: AgentKind, path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(match agent_kind {
        AgentKind::Pi => b"pi".as_slice(),
        AgentKind::PrimeAgent => b"prime-agent".as_slice(),
    });
    hasher.update([0]);
    hasher.update(path.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let suffix = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("ext-{suffix}")
}

/// v10 registration requires an explicit runtime kind.
#[tauri::command]
pub async fn add_project_v10(
    state: State<'_, HostState>,
    path: String,
    agent_kind: String,
) -> Result<ApiProjectSummary, ApiError> {
    register_project(&state, path, parse_agent_kind(&agent_kind)?).await
}

#[tauri::command]
pub async fn pick_and_add_project_v10(
    state: State<'_, HostState>,
    agent_kind: String,
) -> Result<Option<ApiProjectSummary>, ApiError> {
    pick_and_register_project(&state, parse_agent_kind(&agent_kind)?).await
}

async fn pick_and_register_project(
    state: &HostState,
    agent_kind: AgentKind,
) -> Result<Option<ApiProjectSummary>, ApiError> {
    let Some(path) = rfd::FileDialog::new().pick_folder() else {
        return Ok(None);
    };
    register_project(state, path.to_string_lossy().into_owned(), agent_kind)
        .await
        .map(Some)
}

fn parse_agent_kind(value: &str) -> Result<AgentKind, ApiError> {
    match value {
        "pi" => Ok(AgentKind::Pi),
        "prime-agent" => Ok(AgentKind::PrimeAgent),
        _ => Err(ApiError::invalid()),
    }
}

async fn register_project(
    state: &HostState,
    path: String,
    agent_kind: AgentKind,
) -> Result<ApiProjectSummary, ApiError> {
    if path.trim().is_empty() || path.len() > MAX_PROJECT_PATH_BYTES {
        return Err(ApiError::invalid());
    }
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    let directory = ProjectDirectory::resolve(Path::new(&path)).map_err(|_| ApiError::invalid())?;
    if state.is_personal_workspace_path(&directory) {
        return Err(ApiError::invalid());
    }
    let summary = lock_index(state)?
        .register_project_directory_with_kind(&directory, None, TrustState::Restricted, agent_kind)
        .map_err(|error| match error {
            IndexError::ProjectAgentKindConflict => ApiError::project_kind_conflict(),
            _ => ApiError::io(),
        })?;
    if summary.trust_state != TrustState::Trusted {
        // A canonical-path collision with a different native identity resets
        // trust in the index. Advance the catalog watermark before any later
        // cached snapshot can be accepted for this registered object.
        invalidate_catalog_freshness(state, &summary.id);
        // Retire any previously trusted live writer before returning that
        // restricted summary to the WebView.
        retire_live_runtime_for_project(state, &summary.id).await;
    }
    Ok(summary.into())
}

#[tauri::command]
pub async fn set_project_trust(
    state: State<'_, HostState>,
    project_id: String,
    trust_state: String,
) -> Result<ApiProjectSummary, ApiError> {
    let trust_state = match trust_state.as_str() {
        "trusted" => TrustState::Trusted,
        "restricted" => TrustState::Restricted,
        "unknown" => TrustState::Unknown,
        _ => return Err(ApiError::invalid()),
    };
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    require_user_project(&state, &project_id)?;
    if trust_state == TrustState::Trusted
        && let Err(error) = verified_project_directory(&state, &project_id, false)
    {
        retire_project_runtime_after_verification_failure(&state, &project_id, &error).await;
        return Err(error);
    }
    let summary = lock_index(&state)?
        .update_project_trust(&project_id, trust_state)
        .map_err(|_| ApiError::io())?
        .ok_or_else(ApiError::not_found)?;
    if trust_state != TrustState::Trusted {
        // Trust revocation must stop the matching live writer, not merely hide
        // its controls in the WebView. A shutdown failure never rolls trust
        // back; later commands still fail closed on revalidation.
        retire_live_runtime_for_project(&state, &project_id).await;
    }
    Ok(summary.into())
}

/// Renames only PiUI's local project label. It never opens or changes the
/// project directory itself.
#[tauri::command]
pub fn rename_project(
    state: State<'_, HostState>,
    project_id: String,
    name: String,
) -> Result<ApiProjectSummary, ApiError> {
    require_user_project(&state, &project_id)?;
    lock_index(&state)?
        .rename_project(&project_id, &name)
        .map_err(|_| ApiError::invalid())?
        .map(ApiProjectSummary::from)
        .ok_or_else(ApiError::not_found)
}

/// Pins or unpins a registry record without touching project/session files.
#[tauri::command]
pub fn set_project_pinned(
    state: State<'_, HostState>,
    project_id: String,
    pinned: bool,
) -> Result<ApiProjectSummary, ApiError> {
    require_user_project(&state, &project_id)?;
    lock_index(&state)?
        .set_project_pinned(&project_id, pinned)
        .map_err(|_| ApiError::io())?
        .map(ApiProjectSummary::from)
        .ok_or_else(ApiError::not_found)
}

/// Removes only PiUI's local registry/cache record. It never deletes a folder
/// or a Pi JSONL file.
#[tauri::command]
pub async fn remove_project(
    state: State<'_, HostState>,
    project_id: String,
) -> Result<(), ApiError> {
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    require_user_project(&state, &project_id)?;
    // Detach the writer before deleting PiUI's only route for later lifecycle
    // control. This affects no user folder or JSONL file.
    retire_live_runtime_for_project(&state, &project_id).await;
    let removed = lock_index(&state)?
        .remove_project_registry_entry(&project_id)
        .map_err(|_| ApiError::io())?;
    if removed {
        state.remove_refresh_gate(&project_id);
    }
    removed.then_some(()).ok_or_else(ApiError::not_found)
}

/// Searches only already-indexed, bounded session metadata. This operation
/// never opens session files or exposes filesystem locations.
#[tauri::command]
pub async fn search_sessions(
    state: State<'_, HostState>,
    query: String,
) -> Result<Vec<ApiSessionSummary>, ApiError> {
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    let normalized = query.trim();
    if normalized.is_empty() || normalized.chars().count() > 120 {
        return Err(ApiError::invalid());
    }
    // Verify each project object before its cached preview metadata can cross
    // IPC. The fixed project budget bounds filesystem work under rapid search.
    let project_ids = lock_index(&state)?
        .active_project_ids_for_search(64)
        .map_err(|_| ApiError::io())?;
    let mut verified_project_ids = Vec::with_capacity(project_ids.len());
    for project_id in project_ids {
        if state.is_personal_workspace(&project_id) {
            continue;
        }
        match verified_project_directory(&state, &project_id, false) {
            Ok(_) => verified_project_ids.push(project_id),
            Err(error) => {
                retire_project_runtime_after_verification_failure(&state, &project_id, &error)
                    .await;
            }
        }
    }
    if verified_project_ids.is_empty() {
        return Ok(Vec::new());
    }
    lock_index(&state)?
        .search_sessions_for_projects(&verified_project_ids, normalized, 50)
        .map_err(|_| ApiError::io())
        .map(|matches| matches.into_iter().map(ApiSessionSummary::from).collect())
}

/// Returns the last indexed sidebar catalog immediately. A snapshot watermark
/// lets the WebView discard delayed event delivery safely after reloads.
#[tauri::command]
pub fn get_session_catalog(
    state: State<'_, HostState>,
    project_id: String,
) -> Result<ApiSessionCatalogSnapshot, ApiError> {
    require_user_project(&state, &project_id)?;
    verify_catalog_project_visibility(&state, &project_id)?;
    catalog_snapshot(&state, &project_id, false)
}

/// Returns the last indexed projectless Chats catalog without exposing its
/// host-owned workspace identity.
#[tauri::command]
pub fn get_personal_session_catalog(
    state: State<'_, HostState>,
) -> Result<ApiSessionCatalogSnapshot, ApiError> {
    verify_catalog_project_visibility(&state, &state.personal_workspace.project_id)?;
    catalog_snapshot(&state, &state.personal_workspace.project_id, true)
}

/// Reconciles one project after emitting a non-blocking refresh-start event.
/// The WebView may keep rendering its cached snapshot while this bounded,
/// read-only filesystem operation runs. No live-runtime operation lock is held
/// across the scan.
#[tauri::command]
pub async fn refresh_session_catalog(
    state: State<'_, HostState>,
    app: tauri::AppHandle,
    project_id: String,
) -> Result<ApiSessionCatalogSnapshot, ApiError> {
    require_user_project(&state, &project_id)?;
    refresh_catalog_and_emit(&state, &app, &project_id, false).await
}

/// Reconciles the host-owned projectless Chats catalog. Its backing project id
/// stays private in both the response and emitted events.
#[tauri::command]
pub async fn refresh_personal_session_catalog(
    state: State<'_, HostState>,
    app: tauri::AppHandle,
) -> Result<ApiSessionCatalogSnapshot, ApiError> {
    refresh_catalog_and_emit(&state, &app, &state.personal_workspace.project_id, true).await
}

const SESSION_CATALOG_PROTOCOL: u8 = 7;
const SESSION_CATALOG_EVENT: &str = "piui://session-catalog";

fn cached_session_summaries(
    state: &HostState,
    project_id: &str,
    hide_project_id: bool,
) -> Result<Vec<ApiSessionSummary>, ApiError> {
    lock_index(state)?
        .list_sessions(Some(project_id))
        .map_err(|_| ApiError::io())
        .map(|sessions| api_session_summaries(sessions, hide_project_id))
}

fn api_session_summaries(
    sessions: impl IntoIterator<Item = SessionSummary>,
    hide_project_id: bool,
) -> Vec<ApiSessionSummary> {
    sessions
        .into_iter()
        .map(ApiSessionSummary::from)
        .map(|mut summary| {
            if hide_project_id {
                summary.project_id = None;
            }
            summary
        })
        .collect()
}

fn catalog_freshness_name(freshness: CatalogFreshness) -> &'static str {
    match freshness {
        CatalogFreshness::Cached => "cached",
        CatalogFreshness::Refreshing => "refreshing",
        CatalogFreshness::Current => "current",
        CatalogFreshness::Degraded => "degraded",
    }
}

fn catalog_status(state: &HostState, project_id: &str) -> Result<CatalogRefreshStatus, ApiError> {
    state
        .catalog_refreshes
        .lock()
        .map(|store| store.status(project_id))
        .map_err(|_| ApiError::internal())
}

fn catalog_snapshot(
    state: &HostState,
    project_id: &str,
    personal: bool,
) -> Result<ApiSessionCatalogSnapshot, ApiError> {
    let status = catalog_status(state, project_id)?;
    Ok(ApiSessionCatalogSnapshot {
        protocol: SESSION_CATALOG_PROTOCOL,
        scope: if personal { "personal" } else { "project" },
        project_id: (!personal).then(|| project_id.to_owned()),
        sequence: status.sequence,
        freshness: catalog_freshness_name(status.freshness),
        sessions: cached_session_summaries(state, project_id, personal)?,
    })
}

fn emit_catalog_event(app: &tauri::AppHandle, event: ApiSessionCatalogEvent) {
    // Event delivery is best-effort: every event carries a watermark and the
    // snapshot command is the recovery path for a missed/reordered event.
    let _ = app.emit(SESSION_CATALOG_EVENT, event);
}

fn begin_catalog_refresh(
    state: &HostState,
    project_id: &str,
) -> Result<Option<CatalogRefreshStart>, ApiError> {
    state
        .catalog_refreshes
        .lock()
        .map(|mut store| store.begin(project_id))
        .map_err(|_| ApiError::internal())
}

fn finish_catalog_refresh(
    state: &HostState,
    project_id: &str,
    succeeded: bool,
    full_integrity: bool,
) -> Result<CatalogRefreshStatus, ApiError> {
    state
        .catalog_refreshes
        .lock()
        .map(|mut store| {
            if succeeded {
                store.complete(project_id, full_integrity)
            } else {
                store.fail(project_id)
            }
        })
        .map_err(|_| ApiError::internal())
}

async fn refresh_catalog_and_emit(
    state: &HostState,
    app: &tauri::AppHandle,
    project_id: &str,
    personal: bool,
) -> Result<ApiSessionCatalogSnapshot, ApiError> {
    refresh_catalog_and_emit_attempt(state, app, project_id, personal)
        .await
        .map(|attempt| attempt.snapshot)
}

async fn refresh_catalog_and_emit_attempt(
    state: &HostState,
    app: &tauri::AppHandle,
    project_id: &str,
    personal: bool,
) -> Result<CatalogRefreshAttempt, ApiError> {
    let scope = if personal { "personal" } else { "project" };
    let public_project_id = (!personal).then(|| project_id.to_owned());
    let Some(started) = begin_catalog_refresh(state, project_id)? else {
        // Coalesce concurrent UI/watch/poll requests. Returning a snapshot is
        // deterministic and avoids a second full root traversal.
        return Ok(CatalogRefreshAttempt {
            snapshot: catalog_snapshot(state, project_id, personal)?,
        });
    };
    emit_catalog_event(
        app,
        ApiSessionCatalogEvent::RefreshStarted {
            protocol: SESSION_CATALOG_PROTOCOL,
            scope,
            project_id: public_project_id.clone(),
            sequence: started.status.sequence,
        },
    );

    let refresh_context = state.catalog_refresh_context();
    let refresh_project_id = project_id.to_owned();
    let refresh = tauri::async_runtime::spawn_blocking(move || {
        refresh_project_sessions_with_context(
            &refresh_context,
            &refresh_project_id,
            started.full_integrity,
        )
    });

    let outcome = match refresh.await {
        Ok(outcome) => outcome,
        Err(_) => Err(ApiError::internal()),
    };

    match outcome {
        Ok(outcome) if outcome.complete => {
            let _ = finish_catalog_refresh(state, project_id, true, started.full_integrity)?;
            let snapshot = catalog_snapshot(state, project_id, personal)?;
            emit_catalog_event(
                app,
                ApiSessionCatalogEvent::Snapshot {
                    protocol: SESSION_CATALOG_PROTOCOL,
                    snapshot: snapshot.clone(),
                },
            );
            Ok(CatalogRefreshAttempt { snapshot })
        }
        Ok(_) => {
            let degraded =
                finish_catalog_refresh(state, project_id, false, started.full_integrity)?;
            let snapshot = catalog_snapshot(state, project_id, personal)?;
            emit_catalog_event(
                app,
                ApiSessionCatalogEvent::RefreshFailed {
                    protocol: SESSION_CATALOG_PROTOCOL,
                    scope,
                    project_id: public_project_id,
                    sequence: degraded.sequence,
                    safe_summary: "Some local sessions could not be verified. Showing the last indexed catalog.",
                },
            );
            Ok(CatalogRefreshAttempt { snapshot })
        }
        Err(error) => {
            let failed = finish_catalog_refresh(state, project_id, false, started.full_integrity)?;
            emit_catalog_event(
                app,
                ApiSessionCatalogEvent::RefreshFailed {
                    protocol: SESSION_CATALOG_PROTOCOL,
                    scope,
                    project_id: public_project_id,
                    sequence: failed.sequence,
                    safe_summary: "Local sessions could not be refreshed. Showing the last indexed catalog.",
                },
            );
            Err(error)
        }
    }
}

/// Returns a bounded read-only timeline page. Cursors are random host-held
/// capabilities tied to project/session/revision and never encode a path.
#[tauri::command]
pub async fn get_timeline_page(
    state: State<'_, HostState>,
    project_id: String,
    session_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Result<ApiTimelinePage, ApiError> {
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    require_user_project(&state, &project_id)?;
    match timeline_page(&state, &project_id, &session_id, cursor.as_deref(), limit) {
        Ok(page) => Ok(page),
        Err(error) => {
            retire_project_runtime_after_verification_failure(&state, &project_id, &error).await;
            Err(error)
        }
    }
}

/// Reads one bounded timeline page from the host-owned Chats workspace.
#[tauri::command]
pub async fn get_personal_timeline_page(
    state: State<'_, HostState>,
    session_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Result<ApiTimelinePage, ApiError> {
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    let project_id = state.personal_workspace.project_id.clone();
    match timeline_page(&state, &project_id, &session_id, cursor.as_deref(), limit) {
        Ok(page) => Ok(page),
        Err(error) => {
            retire_project_runtime_after_verification_failure(&state, &project_id, &error).await;
            Err(error)
        }
    }
}

fn timeline_page(
    state: &HostState,
    project_id: &str,
    session_id: &str,
    cursor: Option<&str>,
    limit: Option<usize>,
) -> Result<ApiTimelinePage, ApiError> {
    let limit = limit.unwrap_or(DEFAULT_TIMELINE_PAGE_SIZE);
    if limit == 0 {
        return Err(ApiError::invalid());
    }
    let cursor = match cursor {
        Some(cursor) if cursor.is_empty() || cursor.len() > MAX_TIMELINE_CURSOR_BYTES => {
            return Err(ApiError::invalid());
        }
        value => value,
    };
    let cursor_record = if let Some(token) = cursor {
        let record = lock_timeline_cursors(state)?
            .get(token)
            .ok_or_else(ApiError::invalid)?;
        if record.project_id != project_id || record.session_id != session_id {
            return Err(ApiError::invalid());
        }
        Some(record)
    } else {
        None
    };

    let report = if let Some(record) = cursor_record.as_ref() {
        let cached = state
            .timeline_projection_cache
            .lock()
            .map_err(|_| ApiError::internal())?
            .as_ref()
            .filter(|cached| {
                cached.project_id == project_id
                    && cached.session_id == session_id
                    && cached.file_revision == record.file_revision
            })
            .map(|cached| {
                (
                    Arc::clone(&cached.report),
                    cached.source_len,
                    cached.source_modified,
                    cached.file_revision.clone(),
                )
            });
        let cached = cached.and_then(|(report, source_len, source_modified, file_revision)| {
            projection_source_matches(
                state,
                project_id,
                session_id,
                source_len,
                source_modified,
                &file_revision,
            )
            .then_some(report)
        });
        match cached {
            Some(report) => report,
            None => cache_timeline_report(
                state,
                project_id,
                session_id,
                observe_owned_session(state, project_id, session_id)?,
            )?,
        }
    } else {
        cache_timeline_report(
            state,
            project_id,
            session_id,
            observe_owned_session(state, project_id, session_id)?,
        )?
    };
    if let Some(record) = cursor_record {
        if record.file_revision != report.file_revision {
            return Ok(ApiTimelinePage {
                projection_version: 2,
                session_id: session_id.to_owned(),
                blocks: Vec::new(),
                tree: tree_from_report(&report),
                file_revision: report.file_revision.clone(),
                range_start: 0,
                total_blocks: report.timeline_blocks.len(),
                older_cursor: None,
                stale_cursor: true,
            });
        }
        let slice = report.timeline_slice_older(record.older_before, limit);
        let older_cursor = issue_older_timeline_cursor(
            state,
            project_id,
            session_id,
            &report.file_revision,
            slice.start,
        )?;
        return Ok(ApiTimelinePage {
            projection_version: 2,
            session_id: session_id.to_owned(),
            blocks: slice.blocks.iter().map(ApiTimelineBlock::from).collect(),
            tree: tree_from_report(&report),
            file_revision: report.file_revision.clone(),
            range_start: slice.start,
            total_blocks: slice.total,
            older_cursor,
            stale_cursor: false,
        });
    }

    let slice = report.timeline_slice_latest(limit);
    let older_cursor = issue_older_timeline_cursor(
        state,
        project_id,
        session_id,
        &report.file_revision,
        slice.start,
    )?;
    Ok(ApiTimelinePage {
        projection_version: 2,
        session_id: session_id.to_owned(),
        blocks: slice.blocks.iter().map(ApiTimelineBlock::from).collect(),
        tree: tree_from_report(&report),
        file_revision: report.file_revision.clone(),
        range_start: slice.start,
        total_blocks: slice.total,
        older_cursor,
        stale_cursor: false,
    })
}

fn tree_from_report(report: &piui_index::ScanReport) -> ApiSessionTree {
    api_tree(
        &report.tree,
        &report.roots,
        report.current_leaf_id.as_deref(),
        report.diagnostics.len(),
        &report.orphan_ids,
        &report.cycle_ids,
    )
}

/// Explicit application-exit cleanup. Navigation never calls this function.
pub(crate) async fn shutdown_application_runtimes(state: &HostState) {
    let _operation_guard = state.live_runtime_operation_gate.lock().await;
    state.workspace.shutdown_all().await;
}

async fn retire_live_runtime_for_project(state: &HostState, project_id: &str) {
    state.workspace.shutdown_workspace(project_id).await;
}

/// A history operation may be the first code to discover that a project
/// directory was replaced or disappeared. It already holds the operation gate;
/// retire that project's live writer before returning the revoked projection.
async fn retire_project_runtime_after_verification_failure(
    state: &HostState,
    project_id: &str,
    error: &ApiError,
) {
    if matches!(
        error.code,
        "CONFLICT" | "PROJECT_UNAVAILABLE" | "NOT_TRUSTED"
    ) {
        retire_live_runtime_for_project(state, project_id).await;
    }
}

/// Captures a host-private current revision after checking project trust,
/// directory identity, indexed ownership, source-file identity, and the Pi
/// header's project binding. It never locks or writes the JSONL source.
fn admit_session_revision(
    state: &HostState,
    project_id: &str,
    session_id: &str,
) -> Result<SessionRevisionAdmission, ApiError> {
    let (session_file, report) =
        observe_owned_session_with_path(state, project_id, session_id, true)?;
    if !safe_file_revision(&report.file_revision) {
        return Err(ApiError::io());
    }
    Ok(SessionRevisionAdmission {
        project_id: project_id.to_owned(),
        session_id: session_id.to_owned(),
        session_file,
        pi_session_id: report.pi_session_id,
        file_revision: report.file_revision.clone(),
    })
}

/// Re-observes a session just before a future mutation-capable runtime action.
/// A change is a conflict, never an opportunity for PiUI to merge or repair
/// JSONL. The caller must decide whether to reload, abort, or let the user
/// deliberately retry against a new baseline.
fn revalidate_session_admission(
    state: &HostState,
    admission: &SessionRevisionAdmission,
) -> Result<(), ApiError> {
    // Trust is revocable. A baseline captured while trusted cannot authorize a
    // later runtime action after the project was restricted or replaced.
    let _ = verified_project_directory(state, &admission.project_id, true)?;
    let (session_file, report) =
        observe_owned_session_with_path(state, &admission.project_id, &admission.session_id, false)
            .map_err(|_| ApiError::session_conflict())?;
    if session_file != admission.session_file
        || report.file_revision != admission.file_revision
        || report.pi_session_id != admission.pi_session_id
    {
        return Err(ApiError::session_conflict());
    }
    // Recheck trust after filesystem observation as well: a baseline cannot
    // authorize the handoff if the project was revoked during that scan.
    let _ = verified_project_directory(state, &admission.project_id, true)?;
    Ok(())
}

/// An indexed Pi session admitted for continuing in the workspace
/// (`workspace_adopt_v1`). The path stays host-private.
pub(crate) struct AdoptionAdmission {
    pub session_file: PathBuf,
    pub pi_session_id: String,
    pub title: String,
}

/// The admission checks for continuing an indexed Pi session in the
/// workspace: a trusted Pi folder, separate Pi and Prime roots, and an indexed
/// file owned by the project whose header names it, stable across two
/// observations. Never writes JSONL.
pub(crate) fn admit_adoption(
    state: &HostState,
    project_id: &str,
    session_id: &str,
) -> Result<AdoptionAdmission, ApiError> {
    let agent_kind = lock_index(state)?
        .project_agent_kind(project_id)
        .map_err(|_| ApiError::io())?
        .ok_or_else(ApiError::not_found)?;
    require_live_runtime_kind(agent_kind)?;
    let directory = verified_project_directory(state, project_id, true)?;
    let pi_roots = discovery_roots_for_project(&state.session_roots, &directory);
    let prime_roots = configured_roots_for_project(&state.prime_session_roots, &directory);
    if session_root_sets_overlap(&pi_roots, &prime_roots) {
        return Err(ApiError::agent_session_root_conflict());
    }
    let admission = admit_session_revision(state, project_id, session_id)?;
    revalidate_session_admission(state, &admission)?;
    let pi_session_id = admission
        .pi_session_id
        .clone()
        .ok_or_else(ApiError::session_conflict)?;
    let title = lock_index(state)?
        .list_sessions(Some(project_id))
        .map_err(|_| ApiError::io())?
        .into_iter()
        .find(|session| session.id == session_id)
        .map(|session| session.title)
        .ok_or_else(ApiError::not_found)?;
    Ok(AdoptionAdmission {
        session_file: admission.session_file,
        pi_session_id,
        title,
    })
}

#[cfg(test)]
pub(crate) fn refresh_project_sessions_for_tests(
    state: &HostState,
    project_id: &str,
) -> Result<(), ApiError> {
    refresh_project_sessions(state, project_id)
}

fn safe_file_revision(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Cached metadata remains readable when a registered directory is merely
/// unavailable, but never when the same spelling resolves to a replacement
/// directory. This preserves offline history without letting a new project
/// inherit previews from a prior native object.
fn verify_catalog_project_visibility(state: &HostState, project_id: &str) -> Result<(), ApiError> {
    match verified_project_directory(state, project_id, false) {
        Ok(_) => Ok(()),
        Err(error) if error.code == "PROJECT_UNAVAILABLE" => Ok(()),
        Err(error) => Err(error),
    }
}

pub(crate) fn verified_project_directory(
    state: &HostState,
    project_id: &str,
    require_trusted: bool,
) -> Result<ProjectDirectory, ApiError> {
    if require_trusted && state.is_shutting_down() {
        return Err(ApiError::runtime_gone());
    }
    let result =
        verified_project_directory_with_index(state.index.as_ref(), project_id, require_trusted);
    if matches!(result.as_ref(), Err(error) if error.code == "CONFLICT") {
        // The index has already purged this project's disposable rows. Advance
        // the independent host watermark so a delayed pre-conflict snapshot
        // cannot be accepted after a re-registration at the same path.
        invalidate_catalog_freshness(state, project_id);
    }
    result
}

fn invalidate_catalog_freshness(state: &HostState, project_id: &str) {
    if let Ok(mut refreshes) = state.catalog_refreshes.lock() {
        refreshes.fail(project_id);
    }
}

fn verified_project_directory_with_index(
    index: &std::sync::Mutex<ProjectIndex>,
    project_id: &str,
    require_trusted: bool,
) -> Result<ProjectDirectory, ApiError> {
    let (trust_state, stored_path) = {
        let index = lock_project_index(index)?;
        let project = index
            .list_projects()
            .map_err(|_| ApiError::io())?
            .into_iter()
            .find(|project| project.id == project_id)
            .ok_or_else(ApiError::not_found)?;
        let path = index
            .canonical_project_path(project_id)
            .map_err(|_| ApiError::io())?
            .ok_or_else(ApiError::not_found)?;
        (project.trust_state, path)
    };
    if require_trusted && trust_state != TrustState::Trusted {
        return Err(ApiError::not_trusted());
    }
    let directory = match ProjectDirectory::resolve(&stored_path) {
        Ok(directory) => directory,
        Err(_) if fs::symlink_metadata(&stored_path).is_err() => {
            lock_project_index(index)?
                .mark_project_missing(project_id, true)
                .map_err(|_| ApiError::io())?;
            return Err(ApiError::project_unavailable());
        }
        Err(_) => return invalidate_project_identity_with_index(index, project_id),
    };
    let mut index_guard = lock_project_index(index)?;
    let matches_identity = index_guard
        .verify_project_identity(project_id, directory.identity())
        .map_err(|_| ApiError::io())?;
    if matches_identity {
        index_guard
            .mark_project_missing(project_id, false)
            .map_err(|_| ApiError::io())?;
        return Ok(directory);
    }
    drop(index_guard);
    invalidate_project_identity_with_index(index, project_id)
}

/// Fails closed when a canonical project path no longer resolves to its
/// registered native object. Cached metadata is disposable and must never be
/// rendered as history for a replacement directory.
fn invalidate_project_identity_with_index(
    index: &std::sync::Mutex<ProjectIndex>,
    project_id: &str,
) -> Result<ProjectDirectory, ApiError> {
    let mut index = lock_project_index(index)?;
    index
        .purge_project_sessions(project_id)
        .map_err(|_| ApiError::io())?;
    index
        .update_project_trust(project_id, TrustState::Restricted)
        .map_err(|_| ApiError::io())?;
    Err(ApiError::conflict())
}

/// Returns the established project-local Pi session directory only when each
/// known path component is a real directory. This mapping intentionally does
/// not inspect Pi settings and avoids accepting a symlinked `.pi` tree.
fn existing_project_session_root(directory: &ProjectDirectory) -> Option<PathBuf> {
    let pi_directory = directory.canonical_path().join(".pi");
    let pi_metadata = fs::symlink_metadata(&pi_directory).ok()?;
    if pi_metadata.file_type().is_symlink() || !pi_metadata.is_dir() {
        return None;
    }

    let session_root = pi_directory.join("agent-sessions");
    let root_metadata = fs::symlink_metadata(&session_root).ok()?;
    (!root_metadata.file_type().is_symlink() && root_metadata.is_dir()).then_some(session_root)
}

/// Builds host-only roots after project identity verification. The known local
/// Pi location is searched first; the index scanner preserves its existing
/// no-symlink and bounded-walk guarantees for every root.
fn configured_roots_for_project(
    session_roots: &[PathBuf],
    directory: &ProjectDirectory,
) -> Vec<PathBuf> {
    session_roots
        .iter()
        .map(|root| {
            if root.is_absolute() {
                root.clone()
            } else {
                directory.canonical_path().join(root)
            }
        })
        .collect()
}

fn discovery_roots_for_project(
    session_roots: &[PathBuf],
    directory: &ProjectDirectory,
) -> Vec<PathBuf> {
    let local_root = existing_project_session_root(directory);
    let configured = configured_roots_for_project(session_roots, directory);
    let mut roots = Vec::with_capacity(configured.len() + usize::from(local_root.is_some()));
    if let Some(local_root) = local_root {
        roots.push(local_root);
    }
    for root in configured {
        if !roots.iter().any(|known_root| known_root == &root) {
            roots.push(root);
        }
    }
    roots
}

fn append_normalized_tail(mut base: PathBuf, tail: &[OsString]) -> PathBuf {
    for component in tail.iter().rev() {
        if component == OsStr::new(".") {
            continue;
        }
        if component == OsStr::new("..") {
            base.pop();
        } else {
            base.push(component);
        }
    }
    comparable_root_case(base)
}

fn lexically_normalized_root(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(value) => normalized.push(value),
        }
    }
    comparable_root_case(normalized)
}

fn normalized_root_for_overlap(root: &Path) -> PathBuf {
    let mut cursor = root.to_path_buf();
    let mut missing_tail = Vec::new();
    loop {
        if let Ok(existing) = fs::canonicalize(&cursor) {
            return append_normalized_tail(existing, &missing_tail);
        }
        let Some(name) = cursor.file_name().map(OsStr::to_os_string) else {
            return lexically_normalized_root(root);
        };
        missing_tail.push(name);
        if !cursor.pop() {
            return lexically_normalized_root(root);
        }
    }
}

#[cfg(windows)]
fn comparable_root_case(path: PathBuf) -> PathBuf {
    PathBuf::from(path.to_string_lossy().to_lowercase())
}

#[cfg(not(windows))]
fn comparable_root_case(path: PathBuf) -> PathBuf {
    path
}

fn session_root_sets_overlap(left: &[PathBuf], right: &[PathBuf]) -> bool {
    left.iter().any(|left_root| {
        let left = normalized_root_for_overlap(left_root);
        right.iter().any(|right_root| {
            let right = normalized_root_for_overlap(right_root);
            left == right || left.starts_with(&right) || right.starts_with(&left)
        })
    })
}

#[cfg(test)]
fn refresh_project_sessions(state: &HostState, project_id: &str) -> Result<(), ApiError> {
    refresh_project_sessions_with_integrity(state, project_id, false).map(|_| ())
}

#[cfg(test)]
fn refresh_project_sessions_with_integrity(
    state: &HostState,
    project_id: &str,
    force_full_integrity: bool,
) -> Result<ProjectRefreshOutcome, ApiError> {
    let context = state.catalog_refresh_context();
    refresh_project_sessions_with_context(&context, project_id, force_full_integrity)
}

fn refresh_project_sessions_with_context(
    context: &CatalogRefreshContext,
    project_id: &str,
    force_full_integrity: bool,
) -> Result<ProjectRefreshOutcome, ApiError> {
    let refresh_gate = context
        .refresh_gate_for(project_id)
        .ok_or_else(ApiError::internal)?;
    let _refresh_guard = refresh_gate.lock().map_err(|_| ApiError::internal())?;
    refresh_project_sessions_with_context_while_gated(context, project_id, force_full_integrity)
}

/// Performs one project reconciliation while the caller holds this project's
/// catalog gate. Keeping the gate through any post-scan index lookup prevents a
/// watcher from swapping the just-reconciled catalog before an exact binding is
/// resolved.
fn refresh_project_sessions_with_context_while_gated(
    context: &CatalogRefreshContext,
    project_id: &str,
    force_full_integrity: bool,
) -> Result<ProjectRefreshOutcome, ApiError> {
    let directory =
        verified_project_directory_with_index(context.index.as_ref(), project_id, false)?;
    let agent_kind = lock_project_index(context.index.as_ref())?
        .project_agent_kind(project_id)
        .map_err(|_| ApiError::io())?
        .ok_or_else(ApiError::not_found)?;
    let pi_roots = discovery_roots_for_project(&context.session_roots, &directory);
    let prime_roots = configured_roots_for_project(&context.prime_session_roots, &directory);
    if session_root_sets_overlap(&pi_roots, &prime_roots) {
        return Err(ApiError::agent_session_root_conflict());
    }
    let roots = match agent_kind {
        AgentKind::Pi => pi_roots,
        AgentKind::PrimeAgent => prime_roots,
    };
    context.watch_session_roots(&roots);
    // No roots means no authoritative coverage, so preserve every cached
    // projection rather than treating an empty walk as a complete pass.
    if roots.is_empty() {
        return Ok(ProjectRefreshOutcome { complete: false });
    }
    // Allocate a generation and copy weak catalog evidence under SQLite's
    // short lock, then release it for all filesystem reads/hashing/parsing.
    let (known_sources, generation) = {
        let mut index = lock_project_index(context.index.as_ref())?;
        let known_sources = if force_full_integrity {
            Vec::new()
        } else {
            index
                .known_project_catalog_fingerprints(project_id)
                .map_err(|_| ApiError::io())?
        };
        let generation = index
            .allocate_project_discovery_generation(project_id)
            .map_err(|_| ApiError::io())?;
        (known_sources, generation)
    };
    let project_path = directory.canonical_path().to_path_buf();
    let discovery = match agent_kind {
        AgentKind::Pi => discover_sessions_for_project_incremental(
            &roots,
            &project_path,
            SessionDiscoveryLimits::default(),
            &known_sources,
        ),
        AgentKind::PrimeAgent => discover_root_agent_sessions_for_project_incremental(
            &roots,
            &project_path,
            SessionDiscoveryLimits::default(),
            &known_sources,
        ),
    }
    .map_err(|_| ApiError::project_unavailable())?;
    // Full content/evidence verification remains outside the index mutex. The
    // opaque batch capability cannot be forged by the host/UI and is checked
    // one final time before its single transactional commit.
    let verified_batch =
        verify_discovered_sessions_batch(discovery.sessions).map_err(|_| ApiError::io())?;
    revalidate_project_directory_with_index(context.index.as_ref(), project_id, &directory)?;
    let mut index = lock_project_index(context.index.as_ref())?;
    let commit = index
        .commit_verified_project_discovery_batch(
            verified_batch,
            project_id,
            generation,
            &discovery.unchanged_sources,
            &discovery.stats,
        )
        .map_err(|_| ApiError::io())?;
    drop(index);
    revalidate_project_directory_with_index(context.index.as_ref(), project_id, &directory)?;
    Ok(ProjectRefreshOutcome {
        complete: commit.complete,
    })
}

/// Ensure the project directory resolved before filesystem work remains the
/// same native object before the resulting projection can be used.
fn revalidate_project_directory(
    state: &HostState,
    project_id: &str,
    expected: &ProjectDirectory,
) -> Result<(), ApiError> {
    revalidate_project_directory_with_index(state.index.as_ref(), project_id, expected)
}

fn revalidate_project_directory_with_index(
    index: &std::sync::Mutex<ProjectIndex>,
    project_id: &str,
    expected: &ProjectDirectory,
) -> Result<(), ApiError> {
    let current = verified_project_directory_with_index(index, project_id, false)?;
    if expected.same_directory(&current) {
        Ok(())
    } else {
        Err(ApiError::conflict())
    }
}

/// Reads an owned session without requiring the SQLite revision to match. The
/// native file identity and project header are still rechecked before return,
/// letting the page layer report a stale cursor rather than mixing revisions.
fn observe_owned_session(
    state: &HostState,
    project_id: &str,
    session_id: &str,
) -> Result<piui_index::ScanReport, ApiError> {
    observe_owned_session_with_path(state, project_id, session_id, false).map(|(_, report)| report)
}

/// Captures the exact indexed source spelling together with a bounded,
/// project-bound observation. Admission paths stay host-private and are never
/// copied into session DTOs or runtime events.
fn observe_owned_session_with_path(
    state: &HostState,
    project_id: &str,
    session_id: &str,
    require_trusted: bool,
) -> Result<(PathBuf, piui_index::ScanReport), ApiError> {
    let directory = verified_project_directory(state, project_id, require_trusted)?;
    let project_path = directory.canonical_path().to_path_buf();
    let file = indexed_owned_session_file(state, project_id, session_id)?;
    let report = observe_project_file_bounded(&file, &project_path, MAX_SESSION_RESCAN_BYTES)
        .map_err(|_| ApiError::io())?;
    revalidate_project_directory(state, project_id, &directory)?;
    Ok((file.as_path().to_path_buf(), report))
}

fn indexed_owned_session_file(
    state: &HostState,
    project_id: &str,
    session_id: &str,
) -> Result<piui_index::HostSessionFile, ApiError> {
    let index = lock_index(state)?;
    let belongs_to_project = index
        .list_sessions(Some(project_id))
        .map_err(|_| ApiError::io())?
        .iter()
        .any(|session| session.id == session_id);
    if !belongs_to_project {
        return Err(ApiError::not_found());
    }
    index
        .indexed_session_file_path(session_id)
        .map_err(|_| ApiError::io())?
        .ok_or_else(ApiError::not_found)
}

fn cache_timeline_report(
    state: &HostState,
    project_id: &str,
    session_id: &str,
    report: ScanReport,
) -> Result<Arc<ScanReport>, ApiError> {
    let source_len = u64::try_from(
        report
            .complete_bytes
            .saturating_add(report.partial_tail_bytes),
    )
    .map_err(|_| ApiError::internal())?;
    let source_modified = report.source_modified;
    let report = Arc::new(report);
    *state
        .timeline_projection_cache
        .lock()
        .map_err(|_| ApiError::internal())? = Some(TimelineProjectionCache {
        project_id: project_id.to_owned(),
        session_id: session_id.to_owned(),
        file_revision: report.file_revision.clone(),
        source_len,
        source_modified,
        report: Arc::clone(&report),
    });
    Ok(report)
}

fn projection_source_matches(
    state: &HostState,
    project_id: &str,
    session_id: &str,
    source_len: u64,
    source_modified: Option<std::time::SystemTime>,
    expected_revision: &str,
) -> bool {
    let Ok(directory) = verified_project_directory(state, project_id, false) else {
        return false;
    };
    let Ok(source) = indexed_owned_session_file(state, project_id, session_id) else {
        return false;
    };
    // Metadata is a cheap rejection path only. The following identity-bound,
    // streamed hash verifies the exact revision before cached blocks can be
    // reused, covering same-size/mtime rewrites and path replacement.
    let Ok(metadata) = fs::metadata(source.as_path()) else {
        return false;
    };
    if metadata.len() != source_len
        || source_modified.is_some_and(|modified| metadata.modified().ok() != Some(modified))
    {
        return false;
    }
    verify_project_file_revision_bounded(
        &source,
        directory.canonical_path(),
        MAX_SESSION_RESCAN_BYTES,
        expected_revision,
    )
    .is_ok()
}

fn issue_older_timeline_cursor(
    state: &HostState,
    project_id: &str,
    session_id: &str,
    file_revision: &str,
    older_before: usize,
) -> Result<Option<String>, ApiError> {
    if older_before == 0 {
        return Ok(None);
    }
    Ok(Some(lock_timeline_cursors(state)?.insert(
        TimelineCursorRecord {
            project_id: project_id.to_owned(),
            session_id: session_id.to_owned(),
            file_revision: file_revision.to_owned(),
            older_before,
        },
    )))
}

fn lock_index(state: &HostState) -> Result<MutexGuard<'_, ProjectIndex>, ApiError> {
    lock_project_index(state.index.as_ref())
}

fn lock_project_index(
    index: &std::sync::Mutex<ProjectIndex>,
) -> Result<MutexGuard<'_, ProjectIndex>, ApiError> {
    index.lock().map_err(|_| ApiError::internal())
}

/// The host-owned neutral workspace is reachable only through the dedicated
/// personal-chat commands. Treating its opaque index id as a user project
/// would expose an implementation detail and permit trust/registry mutation.
fn require_user_project(state: &HostState, project_id: &str) -> Result<(), ApiError> {
    if state.is_personal_workspace(project_id) {
        return Err(ApiError::invalid());
    }
    Ok(())
}

fn require_live_runtime_kind(agent_kind: AgentKind) -> Result<(), ApiError> {
    match agent_kind {
        AgentKind::Pi => Ok(()),
        AgentKind::PrimeAgent => Err(ApiError::prime_live_runtime_unavailable()),
    }
}

fn lock_timeline_cursors(
    state: &HostState,
) -> Result<MutexGuard<'_, crate::state::TimelineCursorStore>, ApiError> {
    state
        .timeline_cursors
        .lock()
        .map_err(|_| ApiError::internal())
}

impl ApiError {
    const fn invalid() -> Self {
        Self {
            code: "INVALID_ARGUMENT",
            message: "The request is not valid.",
            recoverable: true,
        }
    }
    const fn not_found() -> Self {
        Self {
            code: "NOT_FOUND",
            message: "The requested local record is unavailable.",
            recoverable: true,
        }
    }
    const fn not_trusted() -> Self {
        Self {
            code: "NOT_TRUSTED",
            message: "Trust this project before starting a runtime.",
            recoverable: true,
        }
    }
    const fn conflict() -> Self {
        Self {
            code: "CONFLICT",
            message: "This project directory changed. Re-add it and confirm trust again before loading local extension resources.",
            recoverable: true,
        }
    }
    const fn project_kind_conflict() -> Self {
        Self {
            code: "PROJECT_KIND_CONFLICT",
            message: "This folder is registered for a different agent runtime. Remove it before adding it with another runtime.",
            recoverable: true,
        }
    }
    const fn agent_session_root_conflict() -> Self {
        Self {
            code: "CONFLICT",
            message: "Pi and Prime Agent session roots overlap. Configure separate roots before refreshing or starting this workspace.",
            recoverable: true,
        }
    }
    const fn session_conflict() -> Self {
        Self {
            code: "CONFLICT",
            message: "This Pi session changed outside PiUI. Reload it before continuing; PiUI will not merge session JSONL.",
            recoverable: true,
        }
    }
    const fn project_unavailable() -> Self {
        Self {
            code: "PROJECT_UNAVAILABLE",
            message: "This project folder is currently unavailable. Its cached read-only history remains local.",
            recoverable: true,
        }
    }
    const fn prime_live_runtime_unavailable() -> Self {
        Self {
            code: "NOT_SUPPORTED",
            message: "Prime Agent 0.8.1 live control is disabled because its shared daemon cannot be contained without risking other active sessions. Read-only history remains available.",
            recoverable: true,
        }
    }
    const fn runtime() -> Self {
        Self {
            code: "RUNTIME_FAILED",
            message: "The deterministic runtime could not transition safely.",
            recoverable: true,
        }
    }
    const fn runtime_gone() -> Self {
        Self {
            code: "RUNTIME_FAILED",
            message: "The Pi runtime is no longer active. Restart it to continue.",
            recoverable: true,
        }
    }
    const fn io() -> Self {
        Self {
            code: "IO_ERROR",
            message: "The local read-only operation could not complete.",
            recoverable: true,
        }
    }
    const fn internal() -> Self {
        Self {
            code: "INTERNAL_ERROR",
            message: "The local host is temporarily unavailable.",
            recoverable: true,
        }
    }
}

#[allow(dead_code)]
fn lifecycle_name(state: LifecycleState) -> &'static str {
    match state {
        LifecycleState::Dormant => "dormant",
        LifecycleState::Starting => "starting",
        LifecycleState::Ready => "ready",
        LifecycleState::Running => "running",
        LifecycleState::Recovering => "recovering",
        LifecycleState::Stopping => "stopping",
        LifecycleState::Failed => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        SESSION_CATALOG_PROTOCOL, admit_session_revision, api_session_summaries, catalog_snapshot,
        catalog_status, configured_roots_for_project, extension_resource_id_for, parse_agent_kind,
        parse_chat_width_preference, parse_font_size_preference, refresh_project_sessions,
        refresh_project_sessions_with_integrity, require_live_runtime_kind, require_user_project,
        revalidate_session_admission, session_root_sets_overlap, timeline_page,
        verified_project_directory,
    };
    use crate::state::HostState;
    use piui_index::{
        AgentKind, ChatWidthPreference, FontSizePreference, ParseState, SessionSummary,
        TitleSource, TrustState,
    };
    use piui_platform::ProjectDirectory;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn extension_ids_are_scoped_to_the_selected_runtime() {
        let path = PathBuf::from("shared-extension.ts");
        let pi_id = extension_resource_id_for(AgentKind::Pi, &path);
        let prime_id = extension_resource_id_for(AgentKind::PrimeAgent, &path);
        assert_ne!(pi_id, prime_id);
        assert_eq!(pi_id.len(), 36);
        assert_eq!(prime_id.len(), 36);
        assert!(pi_id.starts_with("ext-"));
        assert!(prime_id.starts_with("ext-"));
    }

    #[test]
    fn prime_live_runtime_fails_closed_before_shared_daemon_launch() {
        assert!(require_live_runtime_kind(AgentKind::Pi).is_ok());
        let error = require_live_runtime_kind(AgentKind::PrimeAgent)
            .expect_err("Prime 0.8.1 live control stays gated");
        assert_eq!(error.code, "NOT_SUPPORTED");
        assert!(error.recoverable);
        assert!(error.message.contains("shared daemon"));
        assert!(!error.message.contains('\\'));
        assert!(!error.message.contains('/'));
    }

    #[test]
    fn agent_kind_arguments_are_typed() {
        assert_eq!(parse_agent_kind("pi").expect("accepts Pi"), AgentKind::Pi);
        assert_eq!(
            parse_agent_kind("prime-agent").expect("accepts Prime Agent"),
            AgentKind::PrimeAgent
        );
        assert_eq!(
            parse_agent_kind("prime")
                .expect_err("rejects ambiguous runtime kind")
                .code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn v8_appearance_values_are_validated_and_v2_callers_keep_existing_choices() {
        assert_eq!(
            parse_font_size_preference(None, FontSizePreference::Large)
                .expect("v2 caller preserves font size"),
            FontSizePreference::Large
        );
        assert_eq!(
            parse_chat_width_preference(None, ChatWidthPreference::Focused)
                .expect("v2 caller preserves width"),
            ChatWidthPreference::Focused
        );
        assert_eq!(
            parse_font_size_preference(Some("small"), FontSizePreference::Large)
                .expect("accepts known font size"),
            FontSizePreference::Small
        );
        assert_eq!(
            parse_chat_width_preference(Some("centered"), ChatWidthPreference::Wide)
                .expect("accepts known width"),
            ChatWidthPreference::Centered
        );
        assert!(parse_font_size_preference(Some("gigantic"), FontSizePreference::Medium).is_err());
        assert!(
            parse_chat_width_preference(Some("edge-to-edge"), ChatWidthPreference::Wide).is_err()
        );
    }

    #[test]
    fn personal_catalog_summaries_hide_the_host_workspace_id() {
        let summaries = api_session_summaries(
            [SessionSummary {
                id: "session".to_owned(),
                project_id: Some("host-personal-workspace".to_owned()),
                title: "Personal chat".to_owned(),
                title_source: TitleSource::PiName,
                created_at: None,
                updated_at: None,
                preview: None,
                entry_count: 1,
                branch_count: None,
                parse_state: ParseState::Healthy,
                model_ref: None,
            }],
            true,
        );

        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].project_id.is_none());
    }

    #[test]
    fn personal_workspace_cannot_be_addressed_as_a_user_project() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-personal-project-guard-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let state = HostState::open(&root, false).expect("opens isolated host state");

        let error = require_user_project(&state, &state.personal_workspace.project_id)
            .expect_err("personal workspace must stay outside user-project commands");
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(require_user_project(&state, "unrelated-user-project").is_ok());

        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_revision_admission_detects_external_append_without_merging() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-session-admission-{}-{nonce}",
            std::process::id()
        ));
        let data = root.join("data");
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        let session_file = sessions.join("history.jsonl");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project_path).expect("creates project");
        fs::create_dir_all(&sessions).expect("creates session root");
        let source = format!(
            "{{\"type\":\"session\",\"id\":\"s\",\"cwd\":{}}}\n{{\"type\":\"message\",\"id\":\"entry\",\"message\":{{\"role\":\"user\",\"content\":\"before admission\"}}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes project path")
        );
        fs::write(&session_file, &source).expect("writes session fixture");

        let mut state = HostState::open(&data, false).expect("opens isolated host state");
        state.session_roots = vec![sessions];
        let directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
        let project = state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&directory, None, TrustState::Trusted)
            .expect("registers trusted project");
        refresh_project_sessions(&state, &project.id).expect("indexes session");
        let session_id = state
            .index
            .lock()
            .expect("locks index")
            .list_sessions(Some(&project.id))
            .expect("lists sessions")
            .into_iter()
            .next()
            .expect("finds session")
            .id;
        let admission = admit_session_revision(&state, &project.id, &session_id)
            .expect("captures current external revision");
        assert_eq!(admission.session_file, session_file);
        assert_eq!(admission.pi_session_id.as_deref(), Some("s"));

        let appended = format!(
            "{source}{{\"type\":\"message\",\"id\":\"external\",\"message\":{{\"role\":\"user\",\"content\":\"external append\"}}}}\n"
        );
        fs::write(&session_file, &appended).expect("simulates CLI append");
        let error = revalidate_session_admission(&state, &admission)
            .expect_err("changed source must not be merged or admitted");
        assert_eq!(error.code, "CONFLICT");
        assert!(!error.message.contains("external append"));
        assert_eq!(
            fs::read(&session_file).expect("reads source"),
            appended.as_bytes()
        );

        state
            .index
            .lock()
            .expect("locks index")
            .update_project_trust(&project.id, TrustState::Restricted)
            .expect("revokes trust");
        let revoked = revalidate_session_admission(&state, &admission)
            .expect_err("a captured baseline must not survive trust revocation");
        assert_eq!(revoked.code, "NOT_TRUSTED");

        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn replaced_trusted_directory_is_restricted_before_runtime_use() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-project-identity-{}-{nonce}",
            std::process::id()
        ));
        let data = root.join("data");
        let project_path = root.join("project");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project_path).expect("creates initial project");

        let state = HostState::open(&data, false).expect("opens isolated host state");
        let initial_directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
        let project = state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&initial_directory, None, TrustState::Restricted)
            .expect("registers project");
        state
            .index
            .lock()
            .expect("locks index")
            .update_project_trust(&project.id, TrustState::Trusted)
            .expect("sets trust");
        assert!(verified_project_directory(&state, &project.id, true).is_ok());

        fs::remove_dir_all(&project_path).expect("removes original directory");
        fs::create_dir_all(&project_path).expect("recreates replacement directory");

        let error = verified_project_directory(&state, &project.id, true)
            .expect_err("replacement must not inherit trust");
        assert_eq!(error.code, "CONFLICT");
        let freshness = catalog_status(&state, &project.id).expect("reads invalidation watermark");
        assert_eq!(
            freshness.freshness,
            crate::state::CatalogFreshness::Degraded
        );
        assert!(freshness.sequence > 0);
        let trust = state
            .index
            .lock()
            .expect("locks index")
            .list_projects()
            .expect("lists projects")
            .into_iter()
            .find(|summary| summary.id == project.id)
            .expect("finds project")
            .trust_state;
        assert_eq!(trust, TrustState::Restricted);

        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refresh_discovers_existing_project_local_session_without_global_roots() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-project-local-session-{}-{nonce}",
            std::process::id()
        ));
        let data = root.join("data");
        let project_path = root.join("project");
        let session_file = project_path.join(".pi/agent-sessions/session.jsonl");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(session_file.parent().expect("session parent"))
            .expect("creates project-local sessions");
        let source = format!(
            "{{\"type\":\"session\",\"id\":\"local\",\"cwd\":{}}}\n{{\"type\":\"message\",\"id\":\"entry\",\"message\":{{\"role\":\"user\",\"content\":\"project-local fixture\"}}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes project path")
        );
        fs::write(&session_file, source).expect("writes project-local session");

        let mut state = HostState::open(&data, false).expect("opens isolated host state");
        state.session_roots.clear();
        let directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
        let project = state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&directory, None, TrustState::Restricted)
            .expect("registers restricted project");

        refresh_project_sessions(&state, &project.id).expect("indexes project-local session");
        assert_eq!(
            state
                .index
                .lock()
                .expect("locks index")
                .list_sessions(Some(&project.id))
                .expect("lists sessions")
                .len(),
            1
        );

        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn agent_session_roots_resolve_per_project_and_aliases_overlap() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-agent-root-alias-{}-{nonce}",
            std::process::id()
        ));
        let project_path = root.join("project");
        let shared = root.join("shared-sessions");
        let alias_parent = root.join("alias-parent");
        for directory in [&project_path, &shared, &alias_parent] {
            fs::create_dir_all(directory).expect("creates root alias fixture");
        }
        let project = ProjectDirectory::resolve(&project_path).expect("resolves project");
        assert_eq!(
            configured_roots_for_project(&[PathBuf::from("relative-sessions")], &project),
            vec![project.canonical_path().join("relative-sessions")]
        );
        let lexical_alias = alias_parent.join("..").join("shared-sessions");
        assert!(session_root_sets_overlap(
            std::slice::from_ref(&shared),
            &[lexical_alias]
        ));
        assert!(!session_root_sets_overlap(
            std::slice::from_ref(&shared),
            &[root.join("prime-sessions")]
        ));
        assert!(session_root_sets_overlap(
            &[root
                .join("missing-parent")
                .join("..")
                .join("future-sessions")],
            &[root.join("future-sessions")]
        ));
        #[cfg(windows)]
        assert!(session_root_sets_overlap(
            &[root.join("Future-Case-Sessions")],
            &[root.join("future-case-sessions")]
        ));
        fs::remove_dir_all(root).expect("removes root alias fixture");
    }

    #[test]
    fn project_refresh_keeps_pi_and_prime_session_roots_isolated() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-agent-root-isolation-{}-{nonce}",
            std::process::id()
        ));
        let data = root.join("data");
        let pi_project_path = root.join("pi-project");
        let prime_project_path = root.join("prime-project");
        let pi_sessions = root.join("pi-sessions");
        let prime_sessions = root.join("prime-sessions");
        let _ = fs::remove_dir_all(&root);
        for directory in [
            &pi_project_path,
            &prime_project_path,
            &pi_sessions,
            &prime_sessions,
        ] {
            fs::create_dir_all(directory).expect("creates isolation fixture directory");
        }
        let pi_directory =
            ProjectDirectory::resolve(&pi_project_path).expect("resolves Pi project");
        let prime_directory =
            ProjectDirectory::resolve(&prime_project_path).expect("resolves Prime project");
        let write_session = |root: &std::path::Path,
                             file: &str,
                             session_id: &str,
                             name: &str,
                             cwd: &std::path::Path| {
            let source = format!(
                "{{\"type\":\"session\",\"id\":{},\"name\":{},\"cwd\":{}}}\n",
                serde_json::to_string(session_id).expect("encodes session id"),
                serde_json::to_string(name).expect("encodes session name"),
                serde_json::to_string(&cwd.to_string_lossy()).expect("encodes project cwd"),
            );
            fs::write(root.join(file), source).expect("writes isolation session");
        };
        write_session(
            &pi_sessions,
            "pi-right.jsonl",
            "pi-right",
            "Pi lane",
            pi_directory.canonical_path(),
        );
        write_session(
            &pi_sessions,
            "prime-wrong.jsonl",
            "prime-wrong",
            "Wrong Pi root",
            prime_directory.canonical_path(),
        );
        write_session(
            &prime_sessions,
            "prime-right.jsonl",
            "prime-right",
            "Prime lane",
            prime_directory.canonical_path(),
        );
        let prime_child = format!(
            "{{\"type\":\"session\",\"id\":\"prime-child\",\"name\":\"RLM child\",\"cwd\":{},\"parentSession\":\"prime-right\",\"rlmDepth\":1}}\n",
            serde_json::to_string(&prime_directory.canonical_path().to_string_lossy())
                .expect("encodes Prime child cwd"),
        );
        fs::write(prime_sessions.join("prime-child.jsonl"), prime_child)
            .expect("writes Prime child session");
        let prime_fork = format!(
            "{{\"type\":\"session\",\"id\":\"prime-fork\",\"name\":\"Prime fork\",\"cwd\":{},\"parentSession\":\"prime-right\",\"rlmDepth\":0}}\n",
            serde_json::to_string(&prime_directory.canonical_path().to_string_lossy())
                .expect("encodes Prime fork cwd"),
        );
        fs::write(prime_sessions.join("prime-fork.jsonl"), prime_fork)
            .expect("writes ordinary Prime fork");
        let nested_prime_sessions = prime_sessions.join("legacy-nested");
        fs::create_dir_all(&nested_prime_sessions).expect("creates nested Prime fixture");
        write_session(
            &nested_prime_sessions,
            "nested-ghost.jsonl",
            "nested-ghost",
            "Nested ghost",
            prime_directory.canonical_path(),
        );
        write_session(
            &prime_sessions,
            "pi-wrong.jsonl",
            "pi-wrong",
            "Wrong Prime root",
            pi_directory.canonical_path(),
        );

        let mut state = HostState::open(&data, false).expect("opens isolated host state");
        state.session_roots = vec![pi_sessions];
        state.prime_session_roots = vec![prime_sessions];
        let (pi_project, prime_project) = {
            let mut index = state.index.lock().expect("locks index");
            let pi_project = index
                .register_project_directory(&pi_directory, None, TrustState::Restricted)
                .expect("registers Pi project");
            let prime_project = index
                .register_project_directory_with_kind(
                    &prime_directory,
                    None,
                    TrustState::Restricted,
                    AgentKind::PrimeAgent,
                )
                .expect("registers Prime project");
            (pi_project, prime_project)
        };

        refresh_project_sessions(&state, &pi_project.id).expect("refreshes Pi catalog");
        let prime_refresh =
            refresh_project_sessions_with_integrity(&state, &prime_project.id, false)
                .expect("refreshes Prime catalog");
        assert!(prime_refresh.complete);
        let index = state.index.lock().expect("locks refreshed index");
        let pi_titles = index
            .list_sessions(Some(&pi_project.id))
            .expect("lists Pi sessions")
            .into_iter()
            .map(|session| session.title)
            .collect::<Vec<_>>();
        let mut prime_titles = index
            .list_sessions(Some(&prime_project.id))
            .expect("lists Prime sessions")
            .into_iter()
            .map(|session| session.title)
            .collect::<Vec<_>>();
        prime_titles.sort();
        assert_eq!(pi_titles, vec!["Pi lane"]);
        assert_eq!(prime_titles, vec!["Prime fork", "Prime lane"]);
        drop(index);

        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incomplete_catalog_coverage_never_reports_a_current_refresh() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-incomplete-refresh-{}-{nonce}",
            std::process::id()
        ));
        let data = root.join("data");
        let project_path = root.join("project");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project_path).expect("creates project");

        let mut state = HostState::open(&data, false).expect("opens isolated host state");
        // No global root and no project-local .pi/agent-sessions directory:
        // absence of candidates is not proof that an older cache is complete.
        state.session_roots.clear();
        let directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
        let project = state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&directory, None, TrustState::Restricted)
            .expect("registers project");

        let outcome = refresh_project_sessions_with_integrity(&state, &project.id, false)
            .expect("incomplete coverage remains a successful safe pass");
        assert!(!outcome.complete);

        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cached_catalog_is_available_before_a_missing_source_is_reconciled() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-cache-first-{nonce}-{}",
            std::process::id()
        ));
        let data = root.join("data");
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        let session_file = sessions.join("history.jsonl");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project_path).expect("creates project");
        fs::create_dir_all(&sessions).expect("creates sessions");
        let source = format!(
            "{{\"type\":\"session\",\"id\":\"cached\",\"cwd\":{}}}\n{{\"type\":\"message\",\"id\":\"entry\",\"message\":{{\"role\":\"user\",\"content\":\"cached sidebar fixture\"}}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes project path")
        );
        fs::write(&session_file, source).expect("writes session");

        let mut state = HostState::open(&data, false).expect("opens isolated host state");
        state.session_roots = vec![sessions];
        let directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
        let project = state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&directory, None, TrustState::Restricted)
            .expect("registers project");
        refresh_project_sessions(&state, &project.id).expect("indexes initial catalog");
        fs::remove_file(&session_file).expect("removes source after index");

        // Cache-first catalog reads SQLite only; source absence cannot block or
        // erase the last verified sidebar projection before reconciliation.
        let cached = catalog_snapshot(&state, &project.id, false).expect("reads cached catalog");
        assert_eq!(cached.protocol, SESSION_CATALOG_PROTOCOL);
        assert_eq!(cached.freshness, "cached");
        assert_eq!(cached.sessions.len(), 1);
        assert!(!cached.sessions[0].title.contains("history.jsonl"));

        refresh_project_sessions(&state, &project.id).expect("reconciles deletion");
        assert!(
            catalog_snapshot(&state, &project.id, false)
                .expect("reads reconciled catalog")
                .sessions
                .is_empty()
        );
        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn complete_refresh_reconciles_deleted_sessions_without_writing_jsonl() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("piui-api-refresh-{}-{nonce}", std::process::id()));
        let data = root.join("data");
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        let session_file = sessions.join("history.jsonl");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project_path).expect("creates project");
        fs::create_dir_all(&sessions).expect("creates session root");
        let source = format!(
            "{{\"type\":\"session\",\"id\":\"s\",\"cwd\":{}}}\n{{\"type\":\"message\",\"id\":\"entry\",\"message\":{{\"role\":\"user\",\"content\":\"refresh fixture\"}}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes project path")
        );
        fs::write(&session_file, &source).expect("writes session fixture");

        let mut state = HostState::open(&data, false).expect("opens isolated host state");
        state.session_roots = vec![sessions.clone()];
        let directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
        let project = state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&directory, None, TrustState::Restricted)
            .expect("registers project");
        refresh_project_sessions(&state, &project.id).expect("indexes initial session");
        assert_eq!(
            state
                .index
                .lock()
                .expect("locks index")
                .list_sessions(Some(&project.id))
                .expect("lists session")
                .len(),
            1
        );
        assert_eq!(
            fs::read(&session_file).expect("reads source"),
            source.as_bytes()
        );

        fs::remove_file(&session_file).expect("externally removes session");
        refresh_project_sessions(&state, &project.id).expect("reconciles complete empty pass");
        assert!(
            state
                .index
                .lock()
                .expect("locks index")
                .list_sessions(Some(&project.id))
                .expect("lists sessions")
                .is_empty()
        );

        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unavailable_project_stays_registered_with_cached_history() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-missing-project-{}-{nonce}",
            std::process::id()
        ));
        let data = root.join("data");
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        let session_file = sessions.join("history.jsonl");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project_path).expect("creates project");
        fs::create_dir_all(&sessions).expect("creates session root");
        let source = format!(
            "{{\"type\":\"session\",\"id\":\"s\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes project path")
        );
        fs::write(&session_file, source).expect("writes session fixture");

        let mut state = HostState::open(&data, false).expect("opens isolated host state");
        state.session_roots = vec![sessions];
        let directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
        let project = state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&directory, None, TrustState::Restricted)
            .expect("registers project");
        refresh_project_sessions(&state, &project.id).expect("indexes session");
        fs::remove_dir_all(&project_path).expect("externally removes project folder");

        let error = refresh_project_sessions(&state, &project.id)
            .expect_err("missing project must be surfaced without cache deletion");
        assert_eq!(error.code, "PROJECT_UNAVAILABLE");
        assert!(
            state
                .index
                .lock()
                .expect("locks index")
                .list_projects()
                .expect("lists projects")
                .into_iter()
                .find(|item| item.id == project.id)
                .expect("finds project")
                .missing
        );
        assert_eq!(
            state
                .index
                .lock()
                .expect("locks index")
                .list_sessions(Some(&project.id))
                .expect("keeps cached history")
                .len(),
            1
        );

        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn timeline_pages_are_bounded_and_external_append_stales_old_cursor() {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-api-timeline-page-{}-{nonce}",
            std::process::id()
        ));
        let data = root.join("data");
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        let session_file = sessions.join("history.jsonl");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project_path).expect("creates project");
        fs::create_dir_all(&sessions).expect("creates session root");
        let mut source = format!(
            "{{\"type\":\"session\",\"id\":\"s\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes project path")
        );
        for index in 0..250 {
            source.push_str(&format!(
                "{{\"type\":\"message\",\"id\":\"entry-{index}\",\"message\":{{\"role\":\"user\",\"content\":\"page {index}\"}}}}\n"
            ));
        }
        fs::write(&session_file, &source).expect("writes page fixture");

        let mut state = HostState::open(&data, false).expect("opens isolated host state");
        state.session_roots = vec![sessions];
        let directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
        let project = state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&directory, None, TrustState::Restricted)
            .expect("registers project");
        refresh_project_sessions(&state, &project.id).expect("indexes session");
        let session_id = state
            .index
            .lock()
            .expect("locks index")
            .list_sessions(Some(&project.id))
            .expect("lists session")
            .into_iter()
            .next()
            .expect("finds session")
            .id;

        assert_eq!(
            timeline_page(&state, &project.id, &session_id, None, Some(0))
                .expect_err("rejects a non-progressing zero-sized page")
                .code,
            "INVALID_ARGUMENT"
        );
        let latest = timeline_page(&state, &project.id, &session_id, None, Some(100))
            .expect("loads latest page");
        assert_eq!(latest.blocks.len(), 100);
        assert_eq!(latest.total_blocks, 250);
        assert_eq!(latest.range_start, 150);
        let cursor = latest.older_cursor.clone().expect("issues older cursor");
        let older = timeline_page(&state, &project.id, &session_id, Some(&cursor), Some(100))
            .expect("loads older page");
        assert_eq!(older.blocks.len(), 100);
        assert_eq!(older.range_start, 50);
        assert!(!older.stale_cursor);

        source.push_str("{\"type\":\"message\",\"id\":\"external\",\"message\":{\"role\":\"user\",\"content\":\"external append\"}}\n");
        fs::write(&session_file, &source).expect("externally appends session");
        let stale = timeline_page(&state, &project.id, &session_id, Some(&cursor), Some(100))
            .expect("observes stale cursor safely");
        assert!(stale.stale_cursor);
        assert!(stale.blocks.is_empty());
        assert_eq!(stale.total_blocks, 251);

        let refreshed = timeline_page(&state, &project.id, &session_id, None, Some(100))
            .expect("refreshes the cached revision");
        let refreshed_cursor = refreshed.older_cursor.expect("issues refreshed cursor");
        let revised = source.replace("external append", "external revise");
        assert_eq!(revised.len(), source.len());
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&session_file, revised).expect("rewrites the same-length session");
        let stale = timeline_page(
            &state,
            &project.id,
            &session_id,
            Some(&refreshed_cursor),
            Some(100),
        )
        .expect("detects same-length stale cursor");
        assert!(stale.stale_cursor);
        assert!(stale.blocks.is_empty());

        drop(state);
        let _ = fs::remove_dir_all(root);
    }
}
