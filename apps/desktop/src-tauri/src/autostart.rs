//! "Start PiUI when I sign in" on Windows (background-v1): one value in
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` whose command is the
//! executable path in double quotes, then `--autostart`.
//!
//! `tauri-plugin-autostart` writes the path unquoted. For a path with spaces
//! (`C:\Users\example\My Apps\...`) Windows then tries `C:\Users\example\My.exe` first,
//! a known hijack risk, so PiUI writes the value itself on Windows. Every
//! decision here is pure and tested against a fake store; only
//! `WindowsRunKey` touches the registry, and tests never use it.

// The command logic is compiled and tested on every platform but used only
// on Windows; Linux and macOS keep the plugin's registration.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::background::{AutostartBackend, BackgroundError};

/// The per-user programs Windows starts at sign-in.
pub(crate) const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Task Manager's per-entry enable switch for the values in `RUN_KEY`.
pub(crate) const APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// What Task Manager stores for an enabled entry.
pub(crate) const APPROVED_ENABLED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/// Why a sign-in command cannot be written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunCommandError {
    /// Not a drive (`C:\`) or UNC (`\\server\share`) path.
    NotAbsolute,
    /// Empty, or a quote or control character that cannot be quoted.
    Unrepresentable,
}

fn has_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// The executable path Windows should run: `\\?\C:\...` becomes `C:\...`.
fn plain_path(executable: &str) -> &str {
    executable
        .strip_prefix(r"\\?\")
        .filter(|rest| has_drive(rest))
        .unwrap_or(executable)
}

fn representable(value: &str) -> bool {
    !value.is_empty() && !value.contains('"') && !value.chars().any(char::is_control)
}

/// `"<executable>" <arguments>`: the quoted absolute executable path, then
/// arguments that need no quoting.
pub(crate) fn run_command(executable: &str, args: &[&str]) -> Result<String, RunCommandError> {
    let executable = plain_path(executable);
    if !representable(executable) {
        return Err(RunCommandError::Unrepresentable);
    }
    if !has_drive(executable) && !executable.starts_with(r"\\") {
        return Err(RunCommandError::NotAbsolute);
    }
    let mut command = format!("\"{executable}\"");
    for argument in args {
        if !representable(argument) || argument.contains(char::is_whitespace) {
            return Err(RunCommandError::Unrepresentable);
        }
        command.push(' ');
        command.push_str(argument);
    }
    Ok(command)
}

/// Whether `value` is the unquoted form earlier builds wrote for
/// `executable`: the bare path, alone or followed by arguments.
pub(crate) fn is_unquoted_entry_for(value: &str, executable: &str) -> bool {
    let executable = plain_path(executable);
    let value = value.trim();
    if value.starts_with('"') || executable.is_empty() || value.len() < executable.len() {
        return false;
    }
    let (head, rest) = value
        .split_at_checked(executable.len())
        .unwrap_or(("", value));
    head.eq_ignore_ascii_case(executable) && (rest.is_empty() || rest.starts_with(' '))
}

/// Task Manager's switch: no record means enabled; a record is enabled while
/// its last eight bytes (the time it was turned off) are zero.
pub(crate) fn approval_enabled(record: Option<&[u8]>) -> bool {
    match record {
        Some(bytes) if bytes.len() >= 8 => bytes[bytes.len() - 8..].iter().all(|byte| *byte == 0),
        _ => true,
    }
}

/// The registry values this feature reads and writes, as a seam for tests.
pub(crate) trait RunKeyStore {
    /// The command stored under `name` in `RUN_KEY`.
    fn read(&self, name: &str) -> Result<Option<String>, BackgroundError>;
    fn write(&self, name: &str, command: &str) -> Result<(), BackgroundError>;
    /// Removes the value; a missing value is not an error.
    fn delete(&self, name: &str) -> Result<(), BackgroundError>;
    /// Task Manager's record for `name`, if any.
    fn approval(&self, name: &str) -> Result<Option<Vec<u8>>, BackgroundError>;
    /// Marks `name` enabled where Task Manager keeps such records.
    fn approve(&self, name: &str) -> Result<(), BackgroundError>;
}

/// Sign-in registration as one quoted Run value named after the app, the
/// same name earlier builds used, so turning it off also removes theirs.
pub(crate) struct RunKeyAutostart<S> {
    store: S,
    name: String,
    executable: String,
    command: String,
}

impl<S: RunKeyStore> RunKeyAutostart<S> {
    pub(crate) fn new(
        store: S,
        name: &str,
        executable: &str,
        args: &[&str],
    ) -> Result<Self, BackgroundError> {
        if !representable(name) || name.contains('\\') {
            return Err(BackgroundError::unavailable());
        }
        let command = run_command(executable, args).map_err(|_| BackgroundError::unavailable())?;
        Ok(Self {
            store,
            name: name.to_owned(),
            executable: plain_path(executable).to_owned(),
            command,
        })
    }

    #[cfg(test)]
    pub(crate) fn command(&self) -> &str {
        &self.command
    }

    /// Rewrites an unquoted value an earlier build wrote for this executable
    /// in the quoted form. Values for another executable stay untouched.
    /// Returns whether it rewrote the value.
    pub(crate) fn repair(&self) -> Result<bool, BackgroundError> {
        match self.store.read(&self.name)? {
            Some(value) if is_unquoted_entry_for(&value, &self.executable) => {
                self.store.write(&self.name, &self.command)?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

impl<S: RunKeyStore> AutostartBackend for RunKeyAutostart<S> {
    fn is_enabled(&self) -> Result<bool, BackgroundError> {
        if self.store.read(&self.name)?.is_none() {
            return Ok(false);
        }
        Ok(approval_enabled(
            self.store.approval(&self.name)?.as_deref(),
        ))
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), BackgroundError> {
        if enabled {
            self.store.write(&self.name, &self.command)?;
            self.store.approve(&self.name)
        } else {
            self.store.delete(&self.name)
        }
    }
}

/// The real per-user registry. Never used by tests.
#[cfg(windows)]
pub(crate) struct WindowsRunKey;

#[cfg(windows)]
impl WindowsRunKey {
    fn open(path: &str, access: u32) -> Result<Option<winreg::RegKey>, BackgroundError> {
        let user = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        match user.open_subkey_with_flags(path, access) {
            Ok(key) => Ok(Some(key)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(BackgroundError::unavailable()),
        }
    }

    fn missing_is_none<T>(result: std::io::Result<T>) -> Result<Option<T>, BackgroundError> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(BackgroundError::unavailable()),
        }
    }
}

#[cfg(windows)]
impl RunKeyStore for WindowsRunKey {
    fn read(&self, name: &str) -> Result<Option<String>, BackgroundError> {
        let Some(key) = Self::open(RUN_KEY, winreg::enums::KEY_QUERY_VALUE)? else {
            return Ok(None);
        };
        Self::missing_is_none(key.get_value::<String, _>(name))
    }

    fn write(&self, name: &str, command: &str) -> Result<(), BackgroundError> {
        let user = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let (key, _) = user
            .create_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE)
            .map_err(|_| BackgroundError::unavailable())?;
        key.set_value(name, &command.to_owned())
            .map_err(|_| BackgroundError::unavailable())
    }

    fn delete(&self, name: &str) -> Result<(), BackgroundError> {
        let Some(key) = Self::open(RUN_KEY, winreg::enums::KEY_SET_VALUE)? else {
            return Ok(());
        };
        Self::missing_is_none(key.delete_value(name)).map(|_| ())
    }

    fn approval(&self, name: &str) -> Result<Option<Vec<u8>>, BackgroundError> {
        let Some(key) = Self::open(APPROVED_KEY, winreg::enums::KEY_QUERY_VALUE)? else {
            return Ok(None);
        };
        Ok(Self::missing_is_none(key.get_raw_value(name))?.map(|value| value.bytes))
    }

    fn approve(&self, name: &str) -> Result<(), BackgroundError> {
        // Task Manager creates this key the first time it lists startup apps.
        let Some(key) = Self::open(APPROVED_KEY, winreg::enums::KEY_SET_VALUE)? else {
            return Ok(());
        };
        key.set_raw_value(
            name,
            &winreg::RegValue {
                bytes: APPROVED_ENABLED.to_vec(),
                vtype: winreg::enums::RegType::REG_BINARY,
            },
        )
        .map_err(|_| BackgroundError::unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    const EXE: &str = r"C:\Users\example\My Apps\PiUI\PiUI.exe";
    const ARGS: &[&str] = &["--autostart"];

    /// An in-memory Run key and StartupApproved key.
    #[derive(Default)]
    struct FakeRunKey {
        run: RefCell<BTreeMap<String, String>>,
        approved: RefCell<Option<BTreeMap<String, Vec<u8>>>>,
        writes: RefCell<u32>,
    }

    impl FakeRunKey {
        fn with_task_manager() -> Self {
            let store = Self::default();
            *store.approved.borrow_mut() = Some(BTreeMap::new());
            store
        }
    }

    impl RunKeyStore for &FakeRunKey {
        fn read(&self, name: &str) -> Result<Option<String>, BackgroundError> {
            Ok(self.run.borrow().get(name).cloned())
        }
        fn write(&self, name: &str, command: &str) -> Result<(), BackgroundError> {
            *self.writes.borrow_mut() += 1;
            self.run.borrow_mut().insert(name.into(), command.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), BackgroundError> {
            self.run.borrow_mut().remove(name);
            Ok(())
        }
        fn approval(&self, name: &str) -> Result<Option<Vec<u8>>, BackgroundError> {
            Ok(self
                .approved
                .borrow()
                .as_ref()
                .and_then(|records| records.get(name).cloned()))
        }
        fn approve(&self, name: &str) -> Result<(), BackgroundError> {
            if let Some(records) = self.approved.borrow_mut().as_mut() {
                records.insert(name.into(), APPROVED_ENABLED.to_vec());
            }
            Ok(())
        }
    }

    #[test]
    fn the_run_value_quotes_the_executable_path() {
        assert_eq!(
            run_command(EXE, ARGS).as_deref(),
            Ok(r#""C:\Users\example\My Apps\PiUI\PiUI.exe" --autostart"#)
        );
        assert_eq!(
            run_command(r"C:\PiUI\piui-desktop.exe", &[]).as_deref(),
            Ok(r#""C:\PiUI\piui-desktop.exe""#)
        );
        // A verbatim path runs as its plain form; UNC paths stay as they are.
        assert_eq!(
            run_command(r"\\?\D:\Apps\Pi UI\piui.exe", ARGS).as_deref(),
            Ok(r#""D:\Apps\Pi UI\piui.exe" --autostart"#)
        );
        assert_eq!(
            run_command(r"\\server\share\PiUI.exe", ARGS).as_deref(),
            Ok(r#""\\server\share\PiUI.exe" --autostart"#)
        );
    }

    #[test]
    fn commands_that_cannot_be_quoted_safely_are_refused() {
        for (executable, error) in [
            ("", RunCommandError::Unrepresentable),
            (r#"C:\Pi"UI\PiUI.exe"#, RunCommandError::Unrepresentable),
            ("C:\\PiUI\\Pi\nUI.exe", RunCommandError::Unrepresentable),
            (r"PiUI.exe", RunCommandError::NotAbsolute),
            (r"relative\PiUI.exe", RunCommandError::NotAbsolute),
            ("/usr/bin/piui", RunCommandError::NotAbsolute),
        ] {
            assert_eq!(run_command(executable, ARGS), Err(error), "{executable:?}");
        }
        for argument in ["--auto start", "", "--x\"y"] {
            assert_eq!(
                run_command(EXE, &[argument]),
                Err(RunCommandError::Unrepresentable),
                "{argument:?}"
            );
        }
    }

    #[test]
    fn turning_it_on_writes_exactly_the_quoted_value_and_approves_it() {
        let store = FakeRunKey::with_task_manager();
        let autostart = RunKeyAutostart::new(&store, "PiUI", EXE, ARGS).expect("valid");
        assert!(!autostart.is_enabled().expect("reads"));
        autostart.set_enabled(true).expect("turns on");
        assert_eq!(
            store.run.borrow().get("PiUI").map(String::as_str),
            Some(r#""C:\Users\example\My Apps\PiUI\PiUI.exe" --autostart"#)
        );
        assert_eq!(
            store
                .approved
                .borrow()
                .as_ref()
                .and_then(|records| records.get("PiUI").cloned()),
            Some(APPROVED_ENABLED.to_vec())
        );
        assert!(autostart.is_enabled().expect("reads"));
        autostart.set_enabled(false).expect("turns off");
        assert!(store.run.borrow().is_empty());
        assert!(!autostart.is_enabled().expect("reads"));
        // Without Task Manager's key nothing else is created.
        let bare = FakeRunKey::default();
        let autostart = RunKeyAutostart::new(&bare, "PiUI", EXE, ARGS).expect("valid");
        autostart.set_enabled(true).expect("turns on");
        assert!(bare.approved.borrow().is_none());
        assert!(autostart.is_enabled().expect("reads"));
    }

    #[test]
    fn task_manager_can_turn_the_entry_off() {
        let store = FakeRunKey::with_task_manager();
        let autostart = RunKeyAutostart::new(&store, "PiUI", EXE, ARGS).expect("valid");
        autostart.set_enabled(true).expect("turns on");
        // Task Manager: 3, then the time it was turned off.
        let disabled = vec![3, 0, 0, 0, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x01];
        if let Some(records) = store.approved.borrow_mut().as_mut() {
            records.insert("PiUI".into(), disabled);
        }
        assert!(!autostart.is_enabled().expect("reads"));
        // Turning it on in PiUI is an explicit choice and re-approves it.
        autostart.set_enabled(true).expect("turns on again");
        assert!(autostart.is_enabled().expect("reads"));
        assert!(approval_enabled(None));
        assert!(approval_enabled(Some(&[2, 0])));
        assert!(!approval_enabled(Some(&[
            3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0
        ])));
    }

    #[test]
    fn an_unquoted_value_from_an_earlier_build_is_rewritten_quoted() {
        let store = FakeRunKey::default();
        store
            .run
            .borrow_mut()
            .insert("PiUI".into(), format!("{EXE} --autostart"));
        let autostart = RunKeyAutostart::new(&store, "PiUI", EXE, ARGS).expect("valid");
        assert!(autostart.repair().expect("repairs"));
        assert_eq!(
            store.run.borrow().get("PiUI").map(String::as_str),
            Some(autostart.command())
        );
        // Already quoted: nothing to do, nothing written.
        let writes = *store.writes.borrow();
        assert!(!autostart.repair().expect("repairs"));
        assert_eq!(*store.writes.borrow(), writes);
        // Another installation's entry stays untouched.
        store
            .run
            .borrow_mut()
            .insert("PiUI".into(), r"D:\Other PiUI\PiUI.exe --autostart".into());
        assert!(!autostart.repair().expect("repairs"));
        assert_eq!(
            store.run.borrow().get("PiUI").map(String::as_str),
            Some(r"D:\Other PiUI\PiUI.exe --autostart")
        );
        // Nothing registered: nothing written.
        store.run.borrow_mut().clear();
        assert!(!autostart.repair().expect("repairs"));
        assert!(store.run.borrow().is_empty());
    }

    #[test]
    fn unquoted_entries_are_recognized_only_for_this_executable() {
        assert!(is_unquoted_entry_for(EXE, EXE));
        assert!(is_unquoted_entry_for(&format!("{EXE} --autostart"), EXE));
        assert!(is_unquoted_entry_for(
            &format!("{} --autostart", EXE.to_ascii_lowercase()),
            EXE
        ));
        assert!(!is_unquoted_entry_for(
            &format!("\"{EXE}\" --autostart"),
            EXE
        ));
        assert!(!is_unquoted_entry_for(&format!("{EXE}x --autostart"), EXE));
        assert!(!is_unquoted_entry_for(r"C:\Users\example\My", EXE));
        assert!(!is_unquoted_entry_for("", EXE));
    }

    #[test]
    fn a_name_or_path_that_cannot_be_registered_is_unavailable() {
        let store = FakeRunKey::default();
        for (name, executable) in [
            ("PiUI", "PiUI.exe"),
            ("", EXE),
            ("Pi\\UI", EXE),
            ("Pi\"UI", EXE),
        ] {
            assert_eq!(
                RunKeyAutostart::new(&store, name, executable, ARGS).err(),
                Some(BackgroundError::unavailable()),
                "{name:?} {executable:?}"
            );
        }
    }
}
