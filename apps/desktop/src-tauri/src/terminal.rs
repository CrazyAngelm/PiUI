//! Opens a terminal window that runs one host-resolved program (ADR-054).
//!
//! Used only for a harness's own sign-in. The program and every argument come
//! from the host (`resolve_native_sign_in`), never from the WebView. No shell
//! is involved: Windows calls `CreateProcessW` on the program itself with
//! `CREATE_NEW_CONSOLE` (a console program gets its own console window), and
//! Linux starts a fixed list of terminal emulators with an argument vector.
//! Both start from the sanitized environment the caller passes, never from the
//! inherited host environment. Other platforms are refused.

use std::ffi::OsString;
use std::path::Path;

/// Why a terminal could not be opened.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code, reason = "each platform constructs only some variants")]
pub(crate) enum TerminalError {
    /// This platform has no supported way to open a terminal.
    Unsupported,
    /// Linux only: none of the known terminal emulators is installed.
    NoTerminal,
    /// The system refused to start the program.
    Launch,
}

/// Whether [`open`] can work on this machine right now.
pub(crate) fn is_available() -> bool {
    platform::is_available()
}

/// Opens a terminal that runs `program` with `args`, starting in `cwd` with
/// exactly `environment` (nothing is inherited from the host).
pub(crate) fn open(
    program: &Path,
    args: &[String],
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Result<(), TerminalError> {
    platform::open(program, args, cwd, environment)
}

/// The UTF-16 environment block for `CreateProcessW`: `NAME=VALUE\0` entries
/// sorted by name case-insensitively (as Windows expects), then one more NUL.
/// `None` when a name is empty or any name or value contains a NUL.
#[cfg(any(windows, test))]
pub(crate) fn windows_environment_block(vars: &[(Vec<u16>, Vec<u16>)]) -> Option<Vec<u16>> {
    fn fold(unit: u16) -> u16 {
        match char::from_u32(u32::from(unit)) {
            Some(character) => {
                let mut upper = character.to_uppercase();
                match (upper.next(), upper.next()) {
                    (Some(single), None) => u16::try_from(u32::from(single)).unwrap_or(unit),
                    _ => unit,
                }
            }
            None => unit,
        }
    }
    let key = |name: &[u16]| name.iter().map(|unit| fold(*unit)).collect::<Vec<_>>();

    if vars
        .iter()
        .any(|(name, value)| name.is_empty() || name.contains(&0) || value.contains(&0))
    {
        return None;
    }
    let mut sorted: Vec<&(Vec<u16>, Vec<u16>)> = vars.iter().collect();
    sorted.sort_by_cached_key(|(name, _)| key(name));
    let mut block = Vec::new();
    for (name, value) in sorted {
        block.extend_from_slice(name);
        block.push(u16::from(b'='));
        block.extend_from_slice(value);
        block.push(0);
    }
    // An empty block still needs two NULs; otherwise the last entry's NUL plus
    // this one terminate the list.
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Some(block)
}

/// Quotes one argument by the `CommandLineToArgvW` rules, so the program
/// receives exactly `arg`: backslashes are literal unless they precede a
/// double quote, and an argument with whitespace or a quote gets wrapped.
#[cfg(any(windows, test))]
pub(crate) fn quote_windows_arg(arg: &str) -> String {
    use std::iter::repeat_n;

    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return arg.to_owned();
    }
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    let mut backslashes = 0_usize;
    for character in arg.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            other => {
                quoted.extend(repeat_n('\\', backslashes));
                quoted.push(other);
                backslashes = 0;
            }
        }
    }
    quoted.extend(repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

/// The command-line text for `args` (without the program).
#[cfg(any(windows, test))]
pub(crate) fn windows_parameters(args: &[String]) -> String {
    args.iter()
        .map(|arg| quote_windows_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A Linux terminal emulator and the arguments that make it run the rest of
/// its command line as a program.
#[cfg(any(target_os = "linux", test))]
struct Emulator {
    name: &'static str,
    prefix: &'static [&'static str],
}

/// Tried in this order; the first one found in an absolute `PATH` directory wins.
#[cfg(any(target_os = "linux", test))]
const EMULATORS: [Emulator; 8] = [
    Emulator {
        name: "x-terminal-emulator",
        prefix: &["-e"],
    },
    Emulator {
        name: "gnome-terminal",
        prefix: &["--"],
    },
    Emulator {
        name: "konsole",
        prefix: &["-e"],
    },
    Emulator {
        name: "xfce4-terminal",
        prefix: &["-x"],
    },
    Emulator {
        name: "kitty",
        prefix: &[],
    },
    Emulator {
        name: "alacritty",
        prefix: &["-e"],
    },
    Emulator {
        name: "foot",
        prefix: &[],
    },
    Emulator {
        name: "xterm",
        prefix: &["-e"],
    },
];

/// The arguments for the emulator `name`, after its own program: its prefix,
/// then `program` and `args`. `None` for a name outside the fixed list.
#[cfg(any(target_os = "linux", test))]
fn linux_terminal_argv(name: &str, program: &Path, args: &[String]) -> Option<Vec<String>> {
    let emulator = EMULATORS.iter().find(|emulator| emulator.name == name)?;
    let mut argv: Vec<String> = emulator
        .prefix
        .iter()
        .map(|part| (*part).to_owned())
        .collect();
    argv.push(program.to_string_lossy().into_owned());
    argv.extend(args.iter().cloned());
    Some(argv)
}

#[cfg(any(target_os = "linux", test))]
fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        std::fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Finds `name` in the absolute directories of `path_variable`. A relative
/// entry would resolve against an arbitrary working directory, so it is skipped.
#[cfg(any(target_os = "linux", test))]
fn find_in_path(name: &str, path_variable: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    std::env::split_paths(path_variable)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(name))
        .find(|candidate| is_executable_file(candidate))
}

/// The first emulator of [`EMULATORS`] that is installed.
#[cfg(any(target_os = "linux", test))]
fn find_emulator(path_variable: &std::ffi::OsStr) -> Option<(&'static str, std::path::PathBuf)> {
    EMULATORS.iter().find_map(|emulator| {
        find_in_path(emulator.name, path_variable).map(|found| (emulator.name, found))
    })
}

#[cfg(windows)]
mod platform {
    use super::{TerminalError, quote_windows_arg, windows_environment_block, windows_parameters};
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::OsStrExt as _;
    use std::path::Path;

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, PROCESS_INFORMATION,
        STARTUPINFOW,
    };

    /// The documented `CreateProcessW` command-line limit, in UTF-16 units
    /// including the terminating NUL.
    const COMMAND_LINE_LIMIT: usize = 32_767;

    pub(super) fn is_available() -> bool {
        true
    }

    fn wide(text: &OsStr) -> Option<Vec<u16>> {
        let buffer: Vec<u16> = text.encode_wide().chain(Some(0)).collect();
        (!buffer[..buffer.len() - 1].contains(&0)).then_some(buffer)
    }

    pub(super) fn open(
        program: &Path,
        args: &[String],
        cwd: &Path,
        environment: &[(OsString, OsString)],
    ) -> Result<(), TerminalError> {
        let application = wide(program.as_os_str()).ok_or(TerminalError::Launch)?;
        let command_line = format!(
            "{} {}",
            quote_windows_arg(&program.to_string_lossy()),
            windows_parameters(args)
        );
        let mut command_line =
            wide(OsStr::new(command_line.trim_end())).ok_or(TerminalError::Launch)?;
        if command_line.len() > COMMAND_LINE_LIMIT {
            return Err(TerminalError::Launch);
        }
        let directory = wide(cwd.as_os_str()).ok_or(TerminalError::Launch)?;
        let pairs = environment
            .iter()
            .map(|(name, value)| {
                (
                    name.encode_wide().collect::<Vec<u16>>(),
                    value.encode_wide().collect::<Vec<u16>>(),
                )
            })
            .collect::<Vec<_>>();
        let block = windows_environment_block(&pairs).ok_or(TerminalError::Launch)?;

        // No `STARTF_USESTDHANDLES` (`dwFlags` stays 0): the console program
        // uses the console that `CREATE_NEW_CONSOLE` gives it, in dev and
        // packaged runs alike.
        // SAFETY: `STARTUPINFOW` is plain C data for which all-zero is a valid
        // initial state; `cb` is set right after.
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = u32::try_from(std::mem::size_of::<STARTUPINFOW>())
            .map_err(|_| TerminalError::Launch)?;
        // SAFETY: `PROCESS_INFORMATION` is plain C data; all-zero is valid and
        // `CreateProcessW` fills it in.
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `application` and `directory` are NUL-terminated UTF-16
        // buffers, `command_line` is a mutable NUL-terminated buffer that
        // `CreateProcessW` may modify, and `block` is a double-NUL-terminated
        // Unicode environment block (`CREATE_UNICODE_ENVIRONMENT`); all outlive
        // the call. `startup` and `process` are valid for the call, the
        // security attributes are null and no handle is inherited.
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
                block.as_ptr().cast(),
                directory.as_ptr(),
                &startup,
                &mut process,
            )
        };
        if created == 0 {
            return Err(TerminalError::Launch);
        }
        // SAFETY: on success both handles are open and owned by this call; the
        // child keeps running without them.
        unsafe {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{TerminalError, find_emulator, linux_terminal_argv};
    use std::ffi::OsString;
    use std::path::Path;
    use std::process::{Command, Stdio};

    pub(super) fn is_available() -> bool {
        std::env::var_os("PATH").is_some_and(|path| find_emulator(&path).is_some())
    }

    pub(super) fn open(
        program: &Path,
        args: &[String],
        cwd: &Path,
        environment: &[(OsString, OsString)],
    ) -> Result<(), TerminalError> {
        // The emulator is found through the host PATH, but starts with only the
        // sanitized environment.
        let path = std::env::var_os("PATH").ok_or(TerminalError::NoTerminal)?;
        let (name, emulator) = find_emulator(&path).ok_or(TerminalError::NoTerminal)?;
        let argv = linux_terminal_argv(name, program, args).ok_or(TerminalError::Launch)?;
        let mut child = Command::new(emulator)
            .args(argv)
            .env_clear()
            .envs(environment.iter().map(|(name, value)| (name, value)))
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| TerminalError::Launch)?;
        // Reap the emulator without blocking the caller.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::TerminalError;
    use std::ffi::OsString;
    use std::path::Path;

    pub(super) fn is_available() -> bool {
        false
    }

    pub(super) fn open(
        _program: &Path,
        _args: &[String],
        _cwd: &Path,
        _environment: &[(OsString, OsString)],
    ) -> Result<(), TerminalError> {
        Err(TerminalError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn windows_arguments_are_quoted_by_the_command_line_rules() {
        let table: [(&str, &str); 9] = [
            ("login", "login"),
            ("", r#""""#),
            ("a b", r#""a b""#),
            ("tab\there", "\"tab\there\""),
            (r"C:\x\y.js", r"C:\x\y.js"),
            (r"C:\Program Files\x\", r#""C:\Program Files\x\\""#),
            (r#"say "hi""#, r#""say \"hi\"""#),
            (r#"a\"b"#, r#""a\\\"b""#),
            (r#"a\\"b c"#, r#""a\\\\\"b c""#),
        ];
        for (argument, expected) in table {
            assert_eq!(quote_windows_arg(argument), expected, "{argument:?}");
        }
    }

    #[test]
    fn windows_parameters_join_quoted_arguments_and_stay_empty_without_any() {
        assert_eq!(windows_parameters(&[]), "");
        assert_eq!(
            windows_parameters(&[r"C:\Program Files\pi\cli.js".to_owned(), "login".to_owned()]),
            r#""C:\Program Files\pi\cli.js" login"#
        );
    }

    fn utf16(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn pair(name: &str, value: &str) -> (Vec<u16>, Vec<u16>) {
        (utf16(name), utf16(value))
    }

    fn decode_block(block: &[u16]) -> Vec<String> {
        assert!(block.ends_with(&[0, 0]), "double-NUL terminated");
        block[..block.len() - 2]
            .split(|unit| *unit == 0)
            .map(|entry| String::from_utf16(entry).expect("utf16"))
            .collect()
    }

    #[test]
    fn environment_block_is_sorted_case_insensitively_and_double_nul_terminated() {
        let vars = [
            pair("zeta", "1"),
            pair("Path", r"C:\bin;C:\tools"),
            pair("alpha", "2"),
            pair("=C:", r"C:\work"),
            pair("EMPTY", ""),
            pair("Beta", "a=b"),
        ];
        let block = windows_environment_block(&vars).expect("block");
        assert_eq!(
            decode_block(&block),
            [
                r"=C:=C:\work",
                "alpha=2",
                "Beta=a=b",
                "EMPTY=",
                r"Path=C:\bin;C:\tools",
                "zeta=1",
            ]
        );
        assert_eq!(block[block.len() - 3], u16::from(b'1'));
        assert_eq!(block[block.len() - 2..], [0, 0]);
    }

    #[test]
    fn environment_block_for_nothing_is_two_nuls_and_invalid_entries_are_refused() {
        assert_eq!(windows_environment_block(&[]), Some(vec![0, 0]));
        assert_eq!(windows_environment_block(&[pair("", "x")]), None);
        assert_eq!(windows_environment_block(&[pair("A\0B", "x")]), None);
        assert_eq!(windows_environment_block(&[pair("A", "x\0y")]), None);
    }

    #[test]
    fn environment_block_holds_exactly_the_names_it_was_given() {
        // The sanitized list decides; the builder never adds or reads anything.
        let sanitized = piui_runtime::workspace_runtime::native_sign_in_environment(
            piui_runtime::workspace_runtime::HarnessKind::ClaudeCode,
            [
                ("Path", "p"),
                // Windows names match case-insensitively; on Unix only the
                // exact `CLAUDECODE` is that variable.
                (
                    if cfg!(windows) {
                        "ClaudeCode"
                    } else {
                        "CLAUDECODE"
                    },
                    "1",
                ),
                ("ANTHROPIC_API_KEY", "k"),
                ("HOME", "h"),
            ]
            .map(|(name, value)| {
                (
                    std::ffi::OsString::from(name),
                    std::ffi::OsString::from(value),
                )
            }),
        );
        let pairs: Vec<_> = sanitized
            .iter()
            .map(|(name, value)| {
                (
                    utf16(&name.to_string_lossy()),
                    utf16(&value.to_string_lossy()),
                )
            })
            .collect();
        let block = windows_environment_block(&pairs).expect("block");
        let text = decode_block(&block).join("\n").to_uppercase();
        assert!(text.contains("PATH=P") && text.contains("HOME=H"));
        assert!(!text.contains("CLAUDECODE") && !text.contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn linux_emulators_take_the_program_after_their_own_prefix() {
        let program = Path::new("/usr/bin/node");
        let args = vec!["/opt/pi/cli.js".to_owned(), "login".to_owned()];
        let expected_prefix: [(&str, &[&str]); 8] = [
            ("x-terminal-emulator", &["-e"]),
            ("gnome-terminal", &["--"]),
            ("konsole", &["-e"]),
            ("xfce4-terminal", &["-x"]),
            ("kitty", &[]),
            ("alacritty", &["-e"]),
            ("foot", &[]),
            ("xterm", &["-e"]),
        ];
        for (name, prefix) in expected_prefix {
            let mut expected: Vec<String> = prefix.iter().map(|part| (*part).to_owned()).collect();
            expected.push("/usr/bin/node".to_owned());
            expected.extend(args.clone());
            assert_eq!(
                linux_terminal_argv(name, program, &args),
                Some(expected),
                "{name}"
            );
        }
        assert_eq!(linux_terminal_argv("sh", program, &args), None);
        assert_eq!(
            EMULATORS
                .iter()
                .map(|emulator| emulator.name)
                .collect::<Vec<_>>(),
            expected_prefix
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>(),
            "the emulator order is fixed"
        );
    }

    #[test]
    fn emulators_are_found_only_in_absolute_path_directories() {
        let root = std::env::temp_dir().join(format!("piui-terminal-{}", uuid::Uuid::new_v4()));
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).expect("first");
        std::fs::create_dir_all(&second).expect("second");
        for (directory, name) in [(&first, "xterm"), (&second, "konsole")] {
            let file = directory.join(name);
            std::fs::write(&file, b"#!/bin/sh\n").expect("file");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
                    .expect("mode");
            }
        }
        let path =
            std::env::join_paths([PathBuf::from("relative-bin"), first.clone(), second.clone()])
                .expect("path");
        assert_eq!(find_in_path("xterm", &path), Some(first.join("xterm")));
        assert_eq!(find_in_path("konsole", &path), Some(second.join("konsole")));
        assert_eq!(find_in_path("kitty", &path), None);
        // The list order decides, not the directory order: konsole precedes xterm.
        assert_eq!(
            find_emulator(&path),
            Some(("konsole", second.join("konsole")))
        );
        assert_eq!(find_emulator(std::ffi::OsStr::new("")), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
