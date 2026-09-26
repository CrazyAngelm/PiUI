//! Fixtures shared by the review, placement and adoption host tests: a
//! temporary data folder, git repositories created with plain git, trusted
//! projects and chats registered without starting a harness.

use crate::state::HostState;
use piui_index::TrustState;
use piui_platform::ProjectDirectory;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(crate) struct Fixture {
    pub root: PathBuf,
    pub state: HostState,
}

impl Fixture {
    pub(crate) fn new(label: &str, safe_mode: bool) -> Self {
        let root = std::env::temp_dir().join(format!("piui-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("creates fixture root");
        let state = HostState::open(&root.join("data"), safe_mode).expect("opens host state");
        Self { root, state }
    }

    /// Registers `path` (created if needed) as a project with `trust`.
    pub(crate) fn project(&self, path: &Path, trust: TrustState) -> String {
        std::fs::create_dir_all(path).expect("creates project folder");
        let directory = ProjectDirectory::resolve(path).expect("resolves project");
        self.state
            .index
            .lock()
            .expect("locks index")
            .register_project_directory(&directory, None, trust)
            .expect("registers project")
            .id
    }

    pub(crate) fn set_trust(&self, project_id: &str, trust: TrustState) {
        self.state
            .index
            .lock()
            .expect("locks index")
            .update_project_trust(project_id, trust)
            .expect("updates trust");
    }

    /// A closed chat of `project_id` that needs no harness (review tests).
    pub(crate) fn chat(&self, project_id: &str) -> String {
        let native = self.root.join(format!("native-{}.jsonl", Uuid::new_v4()));
        std::fs::write(&native, "{}\n").expect("writes native placeholder");
        self.state
            .workspace
            .register_adopted_pi_session(project_id, "native".into(), &native, "Review chat".into())
            .expect("registers chat")
            .0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Plain git for fixture setup (never through PiUI's runner options).
pub(crate) fn git(cwd: &Path, arguments: &[&str]) {
    let status = std::process::Command::new(if cfg!(windows) { "git.exe" } else { "git" })
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("runs fixture git");
    assert!(status.success(), "fixture git {arguments:?} failed");
}

/// Standard output of plain git, trimmed.
pub(crate) fn git_output(cwd: &Path, arguments: &[&str]) -> String {
    let output = std::process::Command::new(if cfg!(windows) { "git.exe" } else { "git" })
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("runs fixture git");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

pub(crate) fn lines(values: &[&str]) -> String {
    values.iter().map(|line| format!("{line}\n")).collect()
}

pub(crate) const ORIGINAL: [&str; 13] = [
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
];

/// A repository with `src/f.txt`, `gone.txt` and `image.bin` committed.
pub(crate) fn init_repository(repo: &Path) {
    std::fs::create_dir_all(repo.join("src")).expect("creates repository");
    git(repo, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.email", "piui@example.invalid"),
        ("user.name", "PiUI tests"),
        ("core.autocrlf", "false"),
        ("commit.gpgsign", "false"),
    ] {
        git(repo, &["config", key, value]);
    }
    std::fs::write(repo.join("src/f.txt"), lines(&ORIGINAL)).expect("writes text");
    std::fs::write(repo.join("gone.txt"), "delete me\n").expect("writes doomed file");
    std::fs::write(repo.join("image.bin"), b"bin\0ary").expect("writes binary");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "init"]);
}

pub(crate) fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

/// Whether `folder` sits outside every git work tree on this machine.
pub(crate) fn outside_any_repository(folder: &Path) -> bool {
    std::process::Command::new(if cfg!(windows) { "git.exe" } else { "git" })
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(folder)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| !status.success())
        .unwrap_or(false)
}
