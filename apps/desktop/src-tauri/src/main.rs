#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod goose_nano_shell;

fn main() -> Result<(), tauri::Error> {
    #[cfg(windows)]
    goose_nano_shell::dispatch(
        piui_runtime::acp_nano::GOOSE_NANO_SHELL_ENV,
        piui_runtime::acp_nano::GOOSE_NANO_KEY_ENV,
    );
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref()
        == Some(std::ffi::OsStr::new(
            piui_desktop_lib::COMPUTER_USE_HELPER_FLAG,
        ))
    {
        let pid = args
            .next()
            .and_then(|pid| pid.to_str()?.parse::<u32>().ok());
        let status = match (pid, args.next(), args.next()) {
            (Some(pid), Some(lease), None) => {
                piui_desktop_lib::run_computer_use_helper(pid, std::path::Path::new(&lease))
            }
            _ => Err(std::io::Error::other("Invalid Computer Use invocation.")),
        };
        std::process::exit(i32::from(status.is_err()));
    }
    piui_desktop_lib::run()
}
