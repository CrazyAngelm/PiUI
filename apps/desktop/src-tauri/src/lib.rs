//! Thin Tauri composition root for PiUI.
//!
//! Commands expose project registration, trust decisions, read-only session
//! projections, the deterministic fake runtime, and an explicit local Pi RPC
//! preview for trusted projects. The preview starts Pi only through the typed
//! host adapter; the WebView receives neither a general shell/filesystem API
//! nor credentials, raw process handles, or raw Pi RPC frames.

mod api;
mod catalog_watch;
mod contributions;
mod dto;
mod state;

use state::HostState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), tauri::Error> {
    let safe_mode = std::env::args().any(|argument| argument == "--safe-mode");
    tauri::Builder::default()
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir()?;
            let state = HostState::open(&app_data_dir, safe_mode)
                .map_err(Box::<dyn std::error::Error>::from)?;
            let watcher = catalog_watch::start_catalog_watcher(
                app.handle().clone(),
                state.session_roots.clone(),
            );
            state.set_catalog_watcher(watcher);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api::bootstrap,
            api::update_preferences,
            api::update_preferences_v8,
            api::list_extensions,
            api::list_piui_contributions,
            api::set_extension_enabled,
            api::add_project,
            api::pick_and_add_project,
            api::set_project_trust,
            api::rename_project,
            api::set_project_pinned,
            api::remove_project,
            api::search_sessions,
            api::list_sessions,
            api::list_personal_sessions,
            api::get_session_catalog,
            api::get_personal_session_catalog,
            api::refresh_session_catalog,
            api::refresh_personal_session_catalog,
            api::get_timeline,
            api::get_timeline_page,
            api::get_personal_timeline_page,
            api::get_tree,
            api::get_personal_tree,
            api::probe_system_runtime,
            api::run_fake_scenario,
            api::start_fake_runtime,
            api::stop_runtime,
            api::start_runtime,
            api::start_personal_chat,
            api::send_prompt,
            api::send_steer,
            api::send_follow_up,
            api::abort_runtime,
            api::stop_live_runtime,
            api::get_runtime_state,
            api::get_runtime_models,
            api::get_runtime_thinking_levels,
            api::get_runtime_commands,
            api::respond_extension_ui,
            api::set_runtime_model,
            api::set_runtime_thinking,
            api::set_runtime_session_name,
        ])
        .run(tauri::generate_context!())
}
