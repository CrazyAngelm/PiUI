use super::{
    ContainmentError, ContainmentKind, ContainmentState, ProcessContainment, ProcessGroupId,
};

/// Owns the dedicated process group created for one runtime.
///
/// The supervisor must set the child's process group before it can execute any
/// tools. Force termination sends `SIGKILL` to the negative group id, which is
/// the POSIX process-group form rather than a parent-only PID signal.
pub struct UnixProcessGroup {
    group_id: ProcessGroupId,
    state: ContainmentState,
}

impl UnixProcessGroup {
    /// Register a dedicated process group created by trusted supervisor code.
    #[must_use]
    pub const fn from_spawned_group(group_id: ProcessGroupId) -> Self {
        Self {
            group_id,
            state: ContainmentState::Running,
        }
    }

    /// The dedicated process group intended to own the runtime descendants.
    #[must_use]
    pub const fn group_id(&self) -> ProcessGroupId {
        self.group_id
    }

    /// Mark the group handle closed after the supervisor has reaped the tree.
    pub fn discard_after_supervisor_cleanup(&mut self) {
        self.state = ContainmentState::Closed;
    }
}

impl ProcessContainment for UnixProcessGroup {
    fn kind(&self) -> ContainmentKind {
        ContainmentKind::UnixProcessGroup
    }

    fn state(&self) -> ContainmentState {
        self.state
    }

    fn force_terminate_tree(&mut self) -> Result<(), ContainmentError> {
        if self.state != ContainmentState::Running {
            return Err(ContainmentError::InvalidState {
                operation: "force terminate Unix process group",
                state: self.state,
            });
        }
        let result = unsafe {
            // SAFETY: `group_id` is a validated positive i32. Negating it asks
            // POSIX kill(2) to signal that process group. No Rust pointer or
            // memory ownership crosses the FFI boundary.
            libc::kill(-self.group_id.get(), libc::SIGKILL)
        };
        if result == 0 {
            self.state = ContainmentState::TreeTerminated;
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            // The group already exited, which satisfies the cleanup invariant.
            self.state = ContainmentState::TreeTerminated;
            return Ok(());
        }
        let code = error
            .raw_os_error()
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0);
        Err(ContainmentError::Os {
            operation: "kill Unix process group",
            code,
        })
    }
}

impl Drop for UnixProcessGroup {
    fn drop(&mut self) {
        if self.state == ContainmentState::Running {
            let _ = self.force_terminate_tree();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::UnixProcessGroup;
    use crate::{ContainmentKind, ContainmentState, ProcessContainment, ProcessGroupId};

    #[test]
    fn nonexistent_group_is_already_clean_and_closes_explicitly() {
        let group = ProcessGroupId::new(i32::MAX).expect("positive group ID");
        let mut containment = UnixProcessGroup::from_spawned_group(group);

        assert_eq!(containment.kind(), ContainmentKind::UnixProcessGroup);
        assert_eq!(containment.state(), ContainmentState::Running);
        containment
            .force_terminate_tree()
            .expect("a nonexistent group is already clean");
        assert_eq!(containment.state(), ContainmentState::TreeTerminated);
        containment.discard_after_supervisor_cleanup();
        assert_eq!(containment.state(), ContainmentState::Closed);
    }

    #[cfg(target_os = "linux")]
    mod linux_synthetic {
        use super::UnixProcessGroup;
        use crate::{ProcessContainment, ProcessGroupId};
        use std::fs;
        use std::os::unix::process::CommandExt as _;
        use std::path::{Path, PathBuf};
        use std::process::{Child, Command, Stdio};
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::thread;
        use std::time::{Duration, Instant};

        const FIXTURE_TEST: &str =
            "containment::unix_process_group::tests::linux_synthetic::synthetic_fixture_entrypoint";
        const ROLE_ENV: &str = "PIUI_UNIX_CONTAINMENT_ROLE";
        const ROOT_ENV: &str = "PIUI_UNIX_CONTAINMENT_ROOT";
        const ROOT_ROLE: &str = "root";
        const DESCENDANT_ROLE: &str = "descendant";
        const READY_TIMEOUT: Duration = Duration::from_secs(10);
        const TERMINATION_TIMEOUT: Duration = Duration::from_secs(10);
        const FIXTURE_MAX_LIFETIME: Duration = Duration::from_secs(30);
        const POLL_INTERVAL: Duration = Duration::from_millis(20);
        static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

        struct SyntheticTree {
            root: PathBuf,
            child: Option<Child>,
            containment: Option<UnixProcessGroup>,
        }

        impl Drop for SyntheticTree {
            fn drop(&mut self) {
                if let Some(mut containment) = self.containment.take() {
                    let _ = containment.force_terminate_tree();
                    containment.discard_after_supervisor_cleanup();
                }
                if let Some(mut child) = self.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let _ = fs::remove_dir_all(&self.root);
            }
        }

        #[test]
        #[ignore = "only the fixed-argv synthetic child process may run this fixture entrypoint"]
        fn synthetic_fixture_entrypoint() {
            let Some(role) = std::env::var_os(ROLE_ENV) else {
                return;
            };
            let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("fixture root"));
            let descendant = if role == ROOT_ROLE {
                let executable = std::env::current_exe().expect("test executable");
                let descendant = Command::new(executable)
                    .args(["--ignored", "--exact", FIXTURE_TEST, "--nocapture"])
                    .env(ROLE_ENV, DESCENDANT_ROLE)
                    .env(ROOT_ENV, &root)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawns inherited-group descendant");
                fs::write(root.join("root.ready"), std::process::id().to_string())
                    .expect("records root readiness");
                Some(descendant)
            } else if role == DESCENDANT_ROLE {
                fs::write(
                    root.join("descendant.ready"),
                    std::process::id().to_string(),
                )
                .expect("records descendant readiness");
                None
            } else {
                panic!("unexpected fixture role");
            };
            let deadline = Instant::now() + FIXTURE_MAX_LIFETIME;
            while Instant::now() < deadline {
                thread::sleep(POLL_INTERVAL);
            }
            if let Some(mut descendant) = descendant {
                let _ = descendant.wait();
            }
        }

        #[test]
        fn process_group_termination_kills_a_synthetic_descendant() {
            let serial = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "piui-unix-containment-{}-{serial}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("creates fixture root");
            let executable = std::env::current_exe().expect("test executable");
            let mut command = Command::new(executable);
            command
                .args(["--ignored", "--exact", FIXTURE_TEST, "--nocapture"])
                .env(ROLE_ENV, ROOT_ROLE)
                .env(ROOT_ENV, &root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0);
            let child = command.spawn().expect("spawns dedicated-group root");
            let group_id = i32::try_from(child.id())
                .ok()
                .and_then(|pid| ProcessGroupId::new(pid).ok())
                .expect("root PID is a process-group ID");
            let mut tree = SyntheticTree {
                root: root.clone(),
                child: Some(child),
                containment: Some(UnixProcessGroup::from_spawned_group(group_id)),
            };

            wait_for_path(&root.join("root.ready"), READY_TIMEOUT);
            let descendant_path = root.join("descendant.ready");
            wait_for_path(&descendant_path, READY_TIMEOUT);
            let descendant_pid = fs::read_to_string(&descendant_path)
                .expect("reads descendant PID")
                .trim()
                .parse::<u32>()
                .expect("descendant PID is numeric");

            let mut containment = tree.containment.take().expect("owns containment");
            containment
                .force_terminate_tree()
                .expect("terminates the whole process group");
            containment.discard_after_supervisor_cleanup();
            let mut child = tree.child.take().expect("owns fixture root");
            wait_for_child(&mut child, TERMINATION_TIMEOUT);
            wait_for_process_exit(descendant_pid, TERMINATION_TIMEOUT);
        }

        fn wait_for_path(path: &Path, bound: Duration) {
            let deadline = Instant::now() + bound;
            while !path.exists() {
                assert!(Instant::now() < deadline, "fixture did not become ready");
                thread::sleep(POLL_INTERVAL);
            }
        }

        fn wait_for_child(child: &mut Child, bound: Duration) {
            let deadline = Instant::now() + bound;
            loop {
                if child.try_wait().expect("queries fixture root").is_some() {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "fixture root survived containment"
                );
                thread::sleep(POLL_INTERVAL);
            }
        }

        fn wait_for_process_exit(pid: u32, bound: Duration) {
            let process = PathBuf::from(format!("/proc/{pid}"));
            let deadline = Instant::now() + bound;
            while process.exists() {
                assert!(
                    Instant::now() < deadline,
                    "synthetic descendant survived containment"
                );
                thread::sleep(POLL_INTERVAL);
            }
        }
    }
}
