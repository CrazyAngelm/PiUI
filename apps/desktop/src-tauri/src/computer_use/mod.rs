//! Desktop control is an opt-in MCP capability of a single local chat.
#[cfg(any(windows, target_os = "linux"))]
mod protocol;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "linux")]
use linux as native;
#[cfg(windows)]
use windows as native;

use piui_runtime::{script_runner::process_directory, workspace_runtime::SessionMcpServer};
#[cfg(any(windows, target_os = "linux"))]
use serde::Serialize;
use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const HELPER_FLAG: &str = "--computer-use-mcp-v1";

#[cfg(any(windows, target_os = "linux"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Target {
    id: u64,
    #[serde(skip)]
    pid: u32,
    app: String,
    title: String,
    #[serde(skip)]
    x: i32,
    #[serde(skip)]
    y: i32,
    width: u32,
    height: u32,
}

#[cfg(any(windows, target_os = "linux"))]
impl Target {
    fn suitable(&self) -> bool {
        let app = self.app.to_lowercase();
        let app = app.strip_suffix(".exe").unwrap_or(&app);
        self.pid > 0
            && self.pid != std::process::id()
            && self.width > 0
            && self.height > 0
            && !app.is_empty()
            && !matches!(
                app,
                "piui-desktop"
                    | "nanodesktop"
                    | "nano desktop"
                    | "cmd"
                    | "powershell"
                    | "pwsh"
                    | "windowsterminal"
                    | "gnome-terminal"
                    | "gnome-terminal-server"
                    | "konsole"
                    | "xterm"
                    | "wezterm"
                    | "kitty"
                    | "alacritty"
                    | "keepassxc"
                    | "1password"
                    | "bitwarden"
                    | "credentialuibroker"
                    | "consent"
                    | "logonui"
                    | "lockapp"
            )
    }
}

#[derive(Default)]
pub(crate) struct Grants {
    slots: Mutex<HashMap<String, Lease>>,
}

struct Lease(PathBuf);
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl Grants {
    pub(crate) fn enable(&self, chat: &str, title: &str, directory: &Path) -> io::Result<()> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| io::Error::other("Computer Use is unavailable."))?;
        if !slots.contains_key(chat) {
            let path = directory.join(format!("computer-use-{}.lease", uuid::Uuid::new_v4()));
            let lease = Lease(path);
            use std::io::Write;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lease.0)?
                .write_all(title.as_bytes())?;
            slots.insert(chat.to_owned(), lease);
        }
        Ok(())
    }

    pub(crate) fn revoke(&self, chat: &str) -> io::Result<()> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| io::Error::other("Computer Use is unavailable."))?;
        if let Some(lease) = slots.get(chat) {
            match fs::remove_file(&lease.0) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        slots.remove(chat);
        Ok(())
    }

    pub(crate) fn server(&self, chat: &str) -> Option<SessionMcpServer> {
        let slots = self.slots.lock().ok()?;
        let lease = slots.get(chat)?;
        Some(SessionMcpServer {
            name: "nano-computer-use".into(),
            command: process_directory(&std::env::current_exe().ok()?),
            args: vec![
                HELPER_FLAG.into(),
                process_directory(&lease.0).to_str()?.to_owned(),
            ],
        })
    }
}

pub(crate) fn available() -> bool {
    #[cfg(any(windows, target_os = "linux"))]
    {
        native::available()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        false
    }
}

#[doc(hidden)]
pub fn run_helper(lease: &Path) -> io::Result<()> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        use std::io::{stdin, stdout};
        #[cfg(windows)]
        native::initialize();
        if !native::available() || !lease.is_absolute() || !lease.is_file() {
            return Err(io::Error::other("Computer Use is unavailable."));
        }
        protocol::serve(stdin().lock(), stdout().lock(), lease, protocol::Desktop)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = lease;
        Err(io::Error::other("Computer Use is unavailable."))
    }
}
