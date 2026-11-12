#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod goose_nano_shell;

fn main() -> Result<(), tauri::Error> {
    #[cfg(windows)]
    goose_nano_shell::dispatch(
        piui_runtime::acp_nano::GOOSE_NANO_SHELL_ENV,
        piui_runtime::acp_nano::GOOSE_NANO_KEY_ENV,
    );
    piui_desktop_lib::run()
}
