//! Desktop control is an opt-in MCP capability of a single local chat.
#[cfg(any(windows, target_os = "linux"))]
mod protocol;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_pointer;
#[cfg(target_os = "linux")]
use linux as native;
#[cfg(windows)]
use windows as native;

use piui_runtime::{script_runner::process_directory, workspace_runtime::SessionMcpServer};
use serde::{Deserialize, Serialize};
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
    fn suitable(&self, host_pid: u32) -> bool {
        let app = self.app.to_lowercase();
        let app = app.strip_suffix(".exe").unwrap_or(&app);
        self.pid > 0
            && self.pid != std::process::id()
            && self.pid != host_pid
            && self.width > 0
            && self.height > 0
            && !app.is_empty()
            && !matches!(
                app,
                "piui-desktop"
                    | "nanodesktop"
                    | "nano-desktop"
                    | "nano desktop"
                    | "dev.piui.desktop"
                    | "cmd"
                    | "conhost"
                    | "openconsole"
                    | "powershell"
                    | "pwsh"
                    | "windowsterminal"
                    | "gnome-terminal"
                    | "gnome-terminal-server"
                    | "org.gnome.terminal"
                    | "org.gnome.console"
                    | "org.kde.konsole"
                    | "konsole"
                    | "xterm"
                    | "wezterm"
                    | "kitty"
                    | "ptyxis"
                    | "tilix"
                    | "xfce4-terminal"
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

#[derive(Deserialize, Serialize)]
struct LeaseData {
    host_pid: u32,
    #[cfg(target_os = "linux")]
    display: Option<String>,
    #[cfg(target_os = "linux")]
    xauthority: Option<String>,
}

impl LeaseData {
    fn capture() -> Self {
        Self {
            host_pid: std::process::id(),
            #[cfg(target_os = "linux")]
            display: std::env::var("DISPLAY").ok(),
            #[cfg(target_os = "linux")]
            xauthority: std::env::var("XAUTHORITY").ok(),
        }
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn load(path: &Path) -> io::Result<Self> {
        serde_json::from_reader(fs::File::open(path)?).map_err(io::Error::other)
    }

    #[cfg(target_os = "linux")]
    fn setup_x11(&self) {
        // Main's helper dispatch invokes this once, before connecting X11
        // or creating any worker. Restore only the originating local display.
        unsafe {
            if let Some(value) = &self.display {
                std::env::set_var("DISPLAY", value);
            }
            if let Some(value) = &self.xauthority {
                std::env::set_var("XAUTHORITY", value);
            }
        }
    }
}

struct Lease(PathBuf);
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl Grants {
    pub(crate) fn enable(&self, chat: &str, directory: &Path) -> io::Result<()> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| io::Error::other("Computer Use is unavailable."))?;
        if !slots.contains_key(chat) {
            let path = directory.join(format!("computer-use-{}.lease", uuid::Uuid::new_v4()));
            let file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            let lease = Lease(path);
            serde_json::to_writer(file, &LeaseData::capture()).map_err(io::Error::other)?;
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
                std::process::id().to_string(),
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

#[cfg(any(windows, target_os = "linux"))]
fn is_our_process(pid: u32) -> bool {
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    #[cfg(windows)]
    let image = native::process_image(pid);
    #[cfg(target_os = "linux")]
    let image = fs::read_link(format!("/proc/{pid}/exe")).ok();
    let our_image = std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok());
    image
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|image| Some(image) == our_image)
}

#[doc(hidden)]
pub fn run_helper(host_pid: u32, lease: &Path) -> io::Result<()> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        use std::io::{stdin, stdout};
        #[cfg(windows)]
        native::initialize();
        let lease_name = lease
            .file_stem()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("computer-use-"))
            .and_then(|name| uuid::Uuid::parse_str(name).ok());
        if !is_our_process(host_pid)
            || !lease.is_absolute()
            || lease
                .parent()
                .and_then(Path::file_name)
                .is_none_or(|name| name != crate::workspace_api::NATIVE_SESSION_DIRECTORY)
            || lease
                .extension()
                .is_none_or(|extension| extension != "lease")
            || lease_name.is_none()
            || !lease.is_file()
        {
            return Err(io::Error::other("Computer Use is unavailable."));
        }
        let grant = LeaseData::load(lease)?;
        if grant.host_pid != host_pid {
            return Err(io::Error::other("Computer Use is unavailable."));
        }
        #[cfg(target_os = "linux")]
        grant.setup_x11();
        if !native::available() {
            return Err(io::Error::other("Computer Use is unavailable."));
        }
        protocol::serve(
            stdin().lock(),
            stdout().lock(),
            host_pid,
            lease,
            protocol::Desktop,
        )
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (host_pid, lease);
        Err(io::Error::other("Computer Use is unavailable."))
    }
}
