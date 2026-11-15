//! The executable search path of the host.
//!
//! Windows: the process `PATH`, unchanged. Unix: the process `PATH`, the `PATH`
//! of the user's login shell and well-known install folders. An application
//! started from a desktop launcher does not inherit what `~/.bashrc` or
//! `~/.zshrc` add (nvm, fnm, volta, bun, pnpm). Nothing here changes the
//! process environment, and no value is logged.

use std::ffi::{OsStr, OsString};

/// Starts the one login-shell capture in the background. Idempotent. Safe mode
/// runs no shell: it would execute the user's startup files.
pub fn start(safe_mode: bool) {
    imp::start(safe_mode);
}

/// Runs the capture again on the calling thread (bounded). "Check again".
/// Does nothing before [`start`] and in safe mode.
pub fn refresh() {
    imp::refresh();
}

/// Waits until no capture is pending (bounded). Call on a blocking thread.
pub fn settle() {
    imp::settle();
}

/// The effective search path now. Never waits for a pending capture.
#[must_use]
pub fn current() -> Option<OsString> {
    imp::current()
}

/// The process environment with `PATH` replaced by [`current`] (Unix).
/// Windows returns the process environment unchanged.
#[must_use]
pub fn host_environment() -> Vec<(OsString, OsString)> {
    with_search_path(std::env::vars_os().collect(), current())
}

fn with_search_path(
    mut vars: Vec<(OsString, OsString)>,
    path: Option<OsString>,
) -> Vec<(OsString, OsString)> {
    if cfg!(windows) {
        return vars;
    }
    let Some(path) = path else {
        return vars;
    };
    match vars
        .iter_mut()
        .find(|(name, _)| name.as_os_str() == OsStr::new("PATH"))
    {
        Some(entry) => entry.1 = path,
        None => vars.push((OsString::from("PATH"), path)),
    }
    vars
}

#[cfg(not(unix))]
mod imp {
    use std::ffi::OsString;

    pub(super) fn start(safe_mode: bool) {
        let _ = safe_mode;
    }

    pub(super) fn refresh() {}

    pub(super) fn settle() {}

    pub(super) fn current() -> Option<OsString> {
        std::env::var_os("PATH")
    }
}

#[cfg(unix)]
mod imp {
    use piui_platform::{ProcessContainment, ProcessGroupId, UnixProcessGroup};
    use std::ffi::{OsStr, OsString};
    use std::io::Read as _;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdout, Command, Stdio};
    use std::sync::{Condvar, Mutex, MutexGuard, PoisonError, mpsc};
    use std::time::{Duration, Instant};

    /// How long one login-shell run may take before it is abandoned.
    const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
    /// How long a caller that needs the final path waits for a pending run.
    const SETTLE_TIMEOUT: Duration = Duration::from_secs(7);
    const OUTPUT_LIMIT: usize = 64 * 1024;
    const VALUE_LIMIT: usize = 32 * 1024;
    const BEGIN: &str = "__PIUI_PATH_BEGIN__";
    const END: &str = "__PIUI_PATH_END__";
    const SCRIPT: &str = r#"printf '\n__PIUI_PATH_BEGIN__%s__PIUI_PATH_END__\n' "$PATH""#;

    struct State {
        started: bool,
        pending: bool,
        safe_mode: bool,
        /// The last `PATH` a login shell printed. Kept when a later run fails.
        captured: Option<OsString>,
        /// (process `PATH` it was built from, merged result).
        merged: Option<(Option<OsString>, Option<OsString>)>,
    }

    impl State {
        const fn new() -> Self {
            Self {
                started: false,
                pending: false,
                safe_mode: false,
                captured: None,
                merged: None,
            }
        }
    }

    static STATE: Mutex<State> = Mutex::new(State::new());
    static SETTLED: Condvar = Condvar::new();

    fn lock() -> MutexGuard<'static, State> {
        STATE.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Decides whether `start` runs a capture; marks it pending if so.
    fn begin_start(state: &mut State, safe_mode: bool) -> bool {
        if state.started {
            return false;
        }
        state.started = true;
        state.safe_mode = safe_mode;
        state.merged = None;
        if safe_mode {
            return false;
        }
        state.pending = true;
        true
    }

    #[derive(Debug, PartialEq, Eq)]
    enum RefreshPlan {
        Skip,
        Wait,
        Run,
    }

    /// Decides what `refresh` does; marks a run pending if it runs one.
    fn begin_refresh(state: &mut State) -> RefreshPlan {
        if !state.started || state.safe_mode {
            RefreshPlan::Skip
        } else if state.pending {
            RefreshPlan::Wait
        } else {
            state.pending = true;
            RefreshPlan::Run
        }
    }

    pub(super) fn start(safe_mode: bool) {
        let run = begin_start(&mut lock(), safe_mode);
        if !run {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("search-path-capture".into())
            .spawn(|| store(capture_now()));
        if spawned.is_err() {
            store(None);
        }
    }

    pub(super) fn refresh() {
        let plan = begin_refresh(&mut lock());
        match plan {
            RefreshPlan::Skip => {}
            RefreshPlan::Wait => settle(),
            RefreshPlan::Run => store(capture_now()),
        }
    }

    fn store(result: Option<OsString>) {
        let mut state = lock();
        state.pending = false;
        if result.is_some() {
            state.captured = result;
        }
        state.merged = None;
        drop(state);
        SETTLED.notify_all();
    }

    pub(super) fn settle() {
        let deadline = Instant::now() + SETTLE_TIMEOUT;
        let mut state = lock();
        while state.pending {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            state = SETTLED
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    pub(super) fn current() -> Option<OsString> {
        let process = std::env::var_os("PATH");
        let mut state = lock();
        if let Some((input, value)) = &state.merged
            && *input == process
        {
            return value.clone();
        }
        let home = home_directory();
        let value = merge(
            state.captured.as_deref(),
            process.as_deref(),
            &well_known_directories(home.as_deref()),
        );
        state.merged = Some((process, value.clone()));
        value
    }

    fn home_directory() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
    }

    /// Absolute, distinct entries of a `PATH` value, in order.
    fn absolute_entries(value: Option<&OsStr>) -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> = Vec::new();
        if let Some(value) = value {
            for entry in std::env::split_paths(value) {
                if entry.is_absolute() && !entries.contains(&entry) {
                    entries.push(entry);
                }
            }
        }
        entries
    }

    /// Combines the process `PATH`, the login shell's `PATH` and the extra
    /// folders. The process `PATH` keeps its order and wins a conflict (an
    /// application started from a terminal, or a system that already lists
    /// its own Node.js); the shell's entries it lacks follow, then the extra
    /// folders. Relative and repeated entries are dropped.
    pub(super) fn merge(
        captured: Option<&OsStr>,
        process: Option<&OsStr>,
        extra: &[PathBuf],
    ) -> Option<OsString> {
        let captured = absolute_entries(captured);
        let process = absolute_entries(process);
        let mut result: Vec<PathBuf> = Vec::new();
        for entry in process.iter().chain(captured.iter()).chain(extra.iter()) {
            if entry.is_absolute() && !result.contains(entry) {
                result.push(entry.clone());
            }
        }
        if result.is_empty() {
            return None;
        }
        std::env::join_paths(result).ok()
    }

    /// The value between the last marker pair of a login shell's output, or
    /// `None` when it is missing, not a plausible `PATH` or too long.
    pub(super) fn parse_capture(output: &[u8]) -> Option<String> {
        let text = String::from_utf8_lossy(output);
        let after = &text[text.rfind(BEGIN)? + BEGIN.len()..];
        let value = &after[..after.find(END)?];
        let plausible = !value.is_empty()
            && value.len() <= VALUE_LIMIT
            && value.starts_with('/')
            && !value.contains(['\0', '\n', '\r']);
        plausible.then(|| value.to_owned())
    }

    /// The flags that make a shell read the files that set up its `PATH`, or
    /// `None` for a shell this capture does not support.
    pub(super) fn shell_flags(shell: &Path) -> Option<&'static str> {
        match shell.file_name()?.to_str()? {
            "bash" | "zsh" | "fish" => Some("-ilc"),
            "sh" | "dash" | "ksh" | "ash" => Some("-lc"),
            _ => None,
        }
    }

    /// `$SHELL` when it is an existing absolute path, else bash, else sh.
    pub(super) fn login_shell(shell_variable: Option<OsString>) -> Option<PathBuf> {
        shell_variable
            .map(PathBuf::from)
            .filter(|shell| shell.is_absolute() && shell.is_file())
            .or_else(|| {
                ["/bin/bash", "/bin/sh"]
                    .into_iter()
                    .map(PathBuf::from)
                    .find(|shell| shell.is_file())
            })
    }

    fn parse_node_version(name: &str) -> Option<(u64, u64, u64)> {
        let mut parts = name.strip_prefix('v')?.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some((major, minor, patch))
    }

    /// Node versions installed by nvm, newest first; unparsable names dropped.
    fn newest_first(names: Vec<String>) -> Vec<String> {
        let mut versions: Vec<((u64, u64, u64), String)> = names
            .into_iter()
            .filter_map(|name| parse_node_version(&name).map(|version| (version, name)))
            .collect();
        versions.sort_by(|left, right| right.0.cmp(&left.0));
        versions.into_iter().map(|(_, name)| name).collect()
    }

    /// The usual install folders, in order of preference, whether they exist
    /// or not.
    pub(super) fn well_known_candidates(
        home: Option<&Path>,
        nvm_versions: Vec<String>,
    ) -> Vec<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(home) = home {
            candidates.push(home.join(".local/bin"));
            candidates.push(home.join("bin"));
            candidates.push(home.join(".npm-global/bin"));
            for version in newest_first(nvm_versions) {
                candidates.push(home.join(".nvm/versions/node").join(version).join("bin"));
            }
            candidates.push(home.join(".local/share/fnm/aliases/default/bin"));
            candidates.push(home.join(".volta/bin"));
            candidates.push(home.join(".bun/bin"));
            candidates.push(home.join(".local/share/pnpm"));
            candidates.push(home.join(".opencode/bin"));
            candidates.push(home.join(".cargo/bin"));
            candidates.push(home.join(".asdf/shims"));
            candidates.push(home.join(".local/share/mise/shims"));
        }
        for fixed in [
            "/usr/local/bin",
            "/snap/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            "/opt/homebrew/bin",
        ] {
            candidates.push(PathBuf::from(fixed));
        }
        candidates
    }

    fn well_known_directories(home: Option<&Path>) -> Vec<PathBuf> {
        let nvm_versions: Vec<String> = home
            .and_then(|home| std::fs::read_dir(home.join(".nvm/versions/node")).ok())
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        well_known_candidates(home, nvm_versions)
            .into_iter()
            .filter(|candidate| candidate.is_dir())
            .collect()
    }

    /// One bounded login-shell run. Logs the outcome and a count, never a value.
    fn capture_now() -> Option<OsString> {
        let started = Instant::now();
        let result = login_shell(std::env::var_os("SHELL"))
            .and_then(|shell| shell_flags(&shell).map(|flags| (shell, flags)))
            .and_then(|(shell, flags)| run_capture(&shell, flags, SCRIPT, CAPTURE_TIMEOUT));
        let entries = result
            .as_deref()
            .map_or(0, |path| std::env::split_paths(path).count());
        eprintln!(
            "event=search_path_capture outcome={} entries={entries} elapsed_ms={}",
            if result.is_some() {
                "captured"
            } else {
                "unavailable"
            },
            started.elapsed().as_millis()
        );
        result
    }

    /// Runs `shell flags script` in its own process group, from the home
    /// folder (never a project), and returns the `PATH` it printed. The whole
    /// group is killed afterwards, and a pipe a startup file keeps open is
    /// abandoned rather than waited for.
    pub(super) fn run_capture(
        shell: &Path,
        flags: &str,
        script: &str,
        timeout: Duration,
    ) -> Option<OsString> {
        use std::os::unix::process::CommandExt as _;
        let directory = home_directory()
            .filter(|home| home.is_dir())
            .unwrap_or_else(|| PathBuf::from("/"));
        let mut command = Command::new(shell);
        command
            .arg(flags)
            .arg(script)
            .current_dir(directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("PIUI_RESOLVING_ENVIRONMENT", "1")
            .env_remove("PIUI_AGENT_API_TOKEN")
            .env_remove("PIUI_AGENT_API_PORT")
            .env_remove("PIUI_AGENT_API_CONNECTION")
            .process_group(0);
        let mut child = command.spawn().ok()?;
        let (sender, receiver) = mpsc::channel();
        match child.stdout.take() {
            Some(stdout) => read_value(stdout, sender),
            None => drop(sender),
        }
        let value = receiver.recv_timeout(timeout).ok();
        retire(child);
        value.map(OsString::from)
    }

    /// Reads the shell's output on its own thread and sends the first valid
    /// value. The thread ends at EOF, on an error or at the size limit; it is
    /// never joined.
    fn read_value(mut stdout: ChildStdout, sender: mpsc::Sender<String>) {
        let _ = std::thread::Builder::new()
            .name("search-path-reader".into())
            .spawn(move || {
                let mut collected: Vec<u8> = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let count = match stdout.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => count,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    };
                    let room = OUTPUT_LIMIT - collected.len();
                    collected.extend_from_slice(&buffer[..count.min(room)]);
                    if let Some(value) = parse_capture(&collected) {
                        let _ = sender.send(value);
                        break;
                    }
                    if collected.len() >= OUTPUT_LIMIT {
                        break;
                    }
                }
            });
    }

    /// Retires the shell's whole process group, then reaps the shell.
    fn retire(mut child: Child) {
        let group = i32::try_from(child.id())
            .ok()
            .and_then(|pid| ProcessGroupId::new(pid).ok())
            .map(UnixProcessGroup::from_spawned_group);
        if let Some(mut group) = group {
            let _ = group.force_terminate_tree();
            group.discard_after_supervisor_cleanup();
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(test)]
    mod state_tests {
        use super::{RefreshPlan, State, begin_refresh, begin_start};

        #[test]
        fn safe_mode_never_starts_a_capture() {
            let mut state = State::new();
            assert!(!begin_start(&mut state, true));
            assert!(state.started && state.safe_mode && !state.pending);
            assert_eq!(begin_refresh(&mut state), RefreshPlan::Skip);
        }

        #[test]
        fn start_runs_once_and_refresh_follows_its_state() {
            let mut state = State::new();
            assert_eq!(begin_refresh(&mut state), RefreshPlan::Skip);
            assert!(begin_start(&mut state, false));
            assert!(state.pending);
            assert!(!begin_start(&mut state, false));
            assert_eq!(begin_refresh(&mut state), RefreshPlan::Wait);
            state.pending = false;
            assert_eq!(begin_refresh(&mut state), RefreshPlan::Run);
            assert!(state.pending);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::with_search_path;
    use std::ffi::OsString;

    fn pair(name: &str, value: &str) -> (OsString, OsString) {
        (OsString::from(name), OsString::from(value))
    }

    #[cfg(unix)]
    #[test]
    fn with_search_path_replaces_or_adds_path() {
        let replaced = with_search_path(
            vec![pair("A", "1"), pair("PATH", "/old"), pair("B", "2")],
            Some("/new".into()),
        );
        assert_eq!(
            replaced,
            vec![pair("A", "1"), pair("PATH", "/new"), pair("B", "2")]
        );
        let added = with_search_path(vec![pair("A", "1")], Some("/new".into()));
        assert_eq!(added, vec![pair("A", "1"), pair("PATH", "/new")]);
        let untouched = with_search_path(vec![pair("A", "1"), pair("PATH", "/old")], None);
        assert_eq!(untouched, vec![pair("A", "1"), pair("PATH", "/old")]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_keeps_the_process_environment() {
        assert_eq!(super::current(), std::env::var_os("PATH"));
        assert_eq!(
            with_search_path(vec![pair("PATH", "C:\\old")], Some("C:\\new".into())),
            vec![pair("PATH", "C:\\old")]
        );
        assert_eq!(
            super::host_environment(),
            std::env::vars_os().collect::<Vec<_>>()
        );
    }

    #[cfg(unix)]
    mod unix {
        use super::super::imp::{
            login_shell, merge, parse_capture, run_capture, shell_flags, well_known_candidates,
        };
        use std::ffi::{OsStr, OsString};
        use std::path::{Path, PathBuf};
        use std::time::{Duration, Instant};

        fn merged(captured: Option<&str>, process: Option<&str>, extra: &[&str]) -> Option<String> {
            let extra: Vec<PathBuf> = extra.iter().map(PathBuf::from).collect();
            merge(captured.map(OsStr::new), process.map(OsStr::new), &extra)
                .map(|value| value.to_string_lossy().into_owned())
        }

        #[test]
        fn merge_appends_the_login_shell_entries_the_process_path_lacks() {
            assert_eq!(
                merged(Some("/a:/b"), Some("/b:/c"), &["/x"]).as_deref(),
                Some("/b:/c:/a:/x")
            );
            // An extra folder that is already present is not added twice.
            assert_eq!(
                merged(Some("/a:/b"), Some("/b:/c"), &["/c", "/x"]).as_deref(),
                Some("/b:/c:/a:/x")
            );
            // A desktop launch: the nvm folder follows the system folders.
            assert_eq!(
                merged(
                    Some("/home/u/.nvm/versions/node/v22.3.0/bin:/usr/bin"),
                    Some("/usr/local/bin:/usr/bin:/bin"),
                    &[]
                )
                .as_deref(),
                Some("/usr/local/bin:/usr/bin:/bin:/home/u/.nvm/versions/node/v22.3.0/bin")
            );
        }

        #[test]
        fn merge_lets_the_process_path_win_conflicting_installs() {
            // Node 22 on the process PATH is not shadowed by a profile's Node 18,
            // even though the profile lists an entry the process lacks.
            assert_eq!(
                merged(
                    Some("/opt/node18/bin:/usr/bin"),
                    Some("/opt/node22/bin:/usr/bin"),
                    &["/usr/local/bin"]
                )
                .as_deref(),
                Some("/opt/node22/bin:/usr/bin:/opt/node18/bin:/usr/local/bin")
            );
        }

        #[test]
        fn merge_keeps_a_terminal_started_process_order() {
            assert_eq!(
                merged(Some("/b:/a"), Some("/c:/a:/b"), &[]).as_deref(),
                Some("/c:/a:/b")
            );
            assert_eq!(
                merged(None, Some("/c:/a"), &["/x"]).as_deref(),
                Some("/c:/a:/x")
            );
        }

        #[test]
        fn merge_drops_relative_and_duplicate_entries() {
            assert_eq!(
                merged(Some("/a:rel/bin:/a"), Some("bin:/b:/b:."), &[]).as_deref(),
                Some("/b:/a")
            );
        }

        #[test]
        fn merge_of_nothing_is_none() {
            assert_eq!(merged(None, None, &[]), None);
            assert_eq!(merged(Some("rel"), Some("also/rel"), &[]), None);
        }

        #[test]
        fn parse_capture_takes_the_last_marker_pair_after_shell_noise() {
            let output = b"banner\n__PIUI_PATH_BEGIN__/old__PIUI_PATH_END__\nmotd\n\
                           \n__PIUI_PATH_BEGIN__/opt/tools/bin:/usr/bin__PIUI_PATH_END__\nbye\n";
            assert_eq!(
                parse_capture(output).as_deref(),
                Some("/opt/tools/bin:/usr/bin")
            );
        }

        #[test]
        fn parse_capture_rejects_what_is_not_a_path() {
            assert_eq!(parse_capture(b"no markers at all"), None);
            assert_eq!(parse_capture(b"__PIUI_PATH_BEGIN____PIUI_PATH_END__"), None);
            assert_eq!(
                parse_capture(b"__PIUI_PATH_BEGIN__/a\n/b__PIUI_PATH_END__"),
                None
            );
            assert_eq!(
                parse_capture(b"__PIUI_PATH_BEGIN__relative/bin__PIUI_PATH_END__"),
                None
            );
            // The echoed command line, not its output.
            assert_eq!(
                parse_capture(b"printf '__PIUI_PATH_BEGIN__%s__PIUI_PATH_END__'"),
                None
            );
            // The end marker never arrived.
            assert_eq!(parse_capture(b"__PIUI_PATH_BEGIN__/a:/b"), None);
            let mut long = b"__PIUI_PATH_BEGIN__/".to_vec();
            long.extend(std::iter::repeat_n(b'a', 40 * 1024));
            long.extend_from_slice(b"__PIUI_PATH_END__");
            assert_eq!(parse_capture(&long), None);
        }

        #[test]
        fn shell_flags_cover_known_shells_only() {
            for shell in ["/bin/bash", "/usr/bin/zsh", "/usr/bin/fish"] {
                assert_eq!(shell_flags(Path::new(shell)), Some("-ilc"));
            }
            for shell in ["/bin/sh", "/bin/dash"] {
                assert_eq!(shell_flags(Path::new(shell)), Some("-lc"));
            }
            for shell in ["/usr/bin/nu", "/usr/bin/tmux", "/"] {
                assert_eq!(shell_flags(Path::new(shell)), None);
            }
        }

        #[test]
        fn login_shell_ignores_a_relative_or_missing_shell() {
            assert_ne!(
                login_shell(Some(OsString::from("bash"))),
                Some(PathBuf::from("bash"))
            );
            assert_ne!(
                login_shell(Some(OsString::from("/nonexistent/shell"))),
                Some(PathBuf::from("/nonexistent/shell"))
            );
            assert_eq!(
                login_shell(Some(OsString::from("/bin/sh"))),
                Some(PathBuf::from("/bin/sh"))
            );
        }

        #[test]
        fn well_known_candidates_order_nvm_versions_newest_first() {
            let candidates = well_known_candidates(
                Some(Path::new("/home/u")),
                vec![
                    "v9.11.2".into(),
                    "v22.3.0".into(),
                    "v20.10.1".into(),
                    "system".into(),
                    "v20.x".into(),
                ],
            );
            let nvm: Vec<PathBuf> = candidates
                .iter()
                .filter(|candidate| candidate.starts_with("/home/u/.nvm"))
                .cloned()
                .collect();
            assert_eq!(
                nvm,
                vec![
                    PathBuf::from("/home/u/.nvm/versions/node/v22.3.0/bin"),
                    PathBuf::from("/home/u/.nvm/versions/node/v20.10.1/bin"),
                    PathBuf::from("/home/u/.nvm/versions/node/v9.11.2/bin"),
                ]
            );
            assert_eq!(
                candidates.first(),
                Some(&PathBuf::from("/home/u/.local/bin"))
            );
            assert_eq!(candidates.last(), Some(&PathBuf::from("/opt/homebrew/bin")));
            assert!(candidates.contains(&PathBuf::from("/usr/local/bin")));
            // Without a home folder only the fixed system folders remain.
            let system = well_known_candidates(None, vec!["v1.0.0".into()]);
            assert!(
                system
                    .iter()
                    .all(|candidate| !candidate.starts_with("/home/u"))
            );
            assert!(system.contains(&PathBuf::from("/usr/local/bin")));
        }

        // The shell is `/bin/sh -c <script>` so the tests need no executable
        // file of their own; the capture treats it like `$SHELL -ilc`.
        #[test]
        fn run_capture_reads_the_path_from_a_shell() {
            let script = "echo banner; \
                printf '\\n__PIUI_PATH_BEGIN__/opt/tools/bin:/usr/bin__PIUI_PATH_END__\\n'";
            assert_eq!(
                run_capture(Path::new("/bin/sh"), "-c", script, Duration::from_secs(5)),
                Some(OsString::from("/opt/tools/bin:/usr/bin"))
            );
        }

        #[test]
        fn run_capture_marks_its_environment_and_scrubs_the_operator_capability() {
            let script = "printf '\\n__PIUI_PATH_BEGIN__/%s/%s__PIUI_PATH_END__\\n' \
                \"$PIUI_RESOLVING_ENVIRONMENT\" \"${PIUI_AGENT_API_TOKEN:-none}\"";
            assert_eq!(
                run_capture(Path::new("/bin/sh"), "-c", script, Duration::from_secs(5)),
                Some(OsString::from("/1/none"))
            );
        }

        #[test]
        fn run_capture_gives_up_on_a_shell_that_never_answers() {
            let started = Instant::now();
            assert_eq!(
                run_capture(
                    Path::new("/bin/sh"),
                    "-c",
                    "sleep 30",
                    Duration::from_millis(300)
                ),
                None
            );
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        #[test]
        fn run_capture_gives_up_on_a_shell_that_prints_nothing_usable() {
            assert_eq!(
                run_capture(
                    Path::new("/bin/sh"),
                    "-c",
                    "echo no markers here",
                    Duration::from_secs(5)
                ),
                None
            );
            assert_eq!(
                run_capture(
                    Path::new("/nonexistent/shell"),
                    "-c",
                    "true",
                    Duration::from_secs(1)
                ),
                None
            );
        }
    }
}
