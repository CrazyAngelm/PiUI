use std::ffi::OsStr;
use std::os::windows::process::CommandExt as _;
use std::path::PathBuf;
use std::process::{Command, exit};

// Win32 CreateProcessW flag. The helper and its PowerShell child use the
// pipes Goose supplied, with no console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn dispatch(flag_env: &str, key_env: &str) {
    if std::env::var_os(flag_env).as_deref() != Some(OsStr::new("1")) {
        return;
    }
    let mut args = std::env::args_os().skip(1);
    let (Some(flag), Some(command), None) = (args.next(), args.next(), args.next()) else {
        exit(1);
    };
    if flag != "-c" {
        exit(1);
    }
    let Some(system_root) = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    else {
        exit(1);
    };
    let status = Command::new(system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(command)
        .env_remove(key_env)
        .env_remove(flag_env)
        .env_remove("OPENAI_BASE_URL")
        .env_remove("GOOSE_SHELL")
        .env_remove("GOOSE_PATH_ROOT")
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    exit(status.ok().and_then(|status| status.code()).unwrap_or(1));
}
