//! `harness_connect_v1`: Settings → Harnesses → Connect (ADR-054).
//!
//! `describe` lists the harnesses that sign in through their own CLI (Pi,
//! Codex, Claude Code) and whether the host can open a terminal for each right
//! now. `openTerminal` opens a terminal that runs that harness's own sign-in
//! command. The WebView sends only a harness name: the program path comes from
//! the same resolution that launches the harness and the arguments are fixed
//! in `piui_runtime::native_sign_in_entry`. No shell is used, no credential is
//! read, and opening a terminal is refused in safe mode. The terminal gets the
//! host environment minus operator, lease and (for Claude Code) non-subscription
//! variables (`native_sign_in_environment`).

use crate::state::HostState;
use crate::terminal::{self, TerminalError};
use piui_runtime::workspace_runtime::{
    HarnessKind, NativeRuntimeError, NativeSignInLaunch, native_sign_in_entry,
    native_sign_in_environment, probe_native_harnesses, resolve_native_sign_in,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

pub(crate) const HARNESS_CONNECT_PROTOCOL: u8 = 1;

/// The harnesses `describe` reports, in presentation order.
const SIGN_IN_HARNESSES: [HarnessKind; 3] =
    [HarnessKind::Pi, HarnessKind::Codex, HarnessKind::ClaudeCode];

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HarnessConnectCommand {
    Describe {},
    OpenTerminal { harness: HarnessKind },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConnectInfo {
    pub harness: HarnessKind,
    pub command: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub then: Option<&'static str>,
    pub terminal: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HarnessConnectResult {
    Described {
        protocol: u8,
        harnesses: Vec<HarnessConnectInfo>,
    },
    Opened {
        protocol: u8,
        harness: HarnessKind,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HarnessConnectErrorCode {
    SafeMode,
    NotSupported,
    NotInstalled,
    NoTerminal,
    LaunchFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConnectError {
    pub code: HarnessConnectErrorCode,
    pub message: &'static str,
    pub recoverable: bool,
}

impl HarnessConnectError {
    const fn new(code: HarnessConnectErrorCode) -> Self {
        let message = match code {
            HarnessConnectErrorCode::SafeMode => {
                "Safe mode is on: Nano Desktop starts no agent program."
            }
            HarnessConnectErrorCode::NotSupported => {
                "This harness has no sign-in command Nano Desktop can open."
            }
            HarnessConnectErrorCode::NotInstalled => {
                "The harness is not installed, so there is nothing to sign in to."
            }
            HarnessConnectErrorCode::NoTerminal => {
                "A terminal app was not found. Run the command yourself."
            }
            HarnessConnectErrorCode::LaunchFailed => {
                "Could not open a terminal. Run the command yourself."
            }
        };
        Self {
            code,
            message,
            recoverable: true,
        }
    }
}

impl From<TerminalError> for HarnessConnectError {
    fn from(error: TerminalError) -> Self {
        Self::new(match error {
            TerminalError::Unsupported => HarnessConnectErrorCode::NotSupported,
            TerminalError::NoTerminal => HarnessConnectErrorCode::NoTerminal,
            TerminalError::Launch => HarnessConnectErrorCode::LaunchFailed,
        })
    }
}

/// The `describe` answer. A terminal is offered only outside safe mode, on a
/// platform that can open one, for an installed harness.
fn describe_with(
    safe_mode: bool,
    terminal_available: bool,
    installed: impl Fn(HarnessKind) -> bool,
) -> HarnessConnectResult {
    let harnesses = SIGN_IN_HARNESSES
        .into_iter()
        .filter_map(|harness| {
            let entry = native_sign_in_entry(harness)?;
            Some(HarnessConnectInfo {
                harness,
                command: entry.display,
                then: entry.then,
                terminal: !safe_mode && terminal_available && installed(harness),
            })
        })
        .collect();
    HarnessConnectResult::Described {
        protocol: HARNESS_CONNECT_PROTOCOL,
        harnesses,
    }
}

/// Opens the terminal for `harness`. The safe-mode refusal comes first, before
/// anything is resolved, and nothing in the request reaches a command line.
/// The terminal starts with `host_environment` minus what a managed harness
/// process never inherits (`native_sign_in_environment`), not the full host
/// environment.
fn open_terminal_with(
    harness: HarnessKind,
    safe_mode: bool,
    home: Option<PathBuf>,
    host_environment: Vec<(OsString, OsString)>,
    resolve: impl FnOnce(HarnessKind) -> Result<NativeSignInLaunch, NativeRuntimeError>,
    open: impl FnOnce(&Path, &[String], &Path, &[(OsString, OsString)]) -> Result<(), TerminalError>,
) -> Result<HarnessConnectResult, HarnessConnectError> {
    if safe_mode {
        return Err(HarnessConnectError::new(HarnessConnectErrorCode::SafeMode));
    }
    if native_sign_in_entry(harness).is_none() {
        return Err(HarnessConnectError::new(
            HarnessConnectErrorCode::NotSupported,
        ));
    }
    let launch = resolve(harness)
        .map_err(|_| HarnessConnectError::new(HarnessConnectErrorCode::NotInstalled))?;
    let cwd = home
        .filter(|path| path.is_dir())
        .or_else(|| launch.program.parent().map(Path::to_path_buf))
        .ok_or_else(|| HarnessConnectError::new(HarnessConnectErrorCode::LaunchFailed))?;
    let environment = native_sign_in_environment(harness, host_environment);
    open(&launch.program, &launch.args, &cwd, &environment)?;
    Ok(HarnessConnectResult::Opened {
        protocol: HARNESS_CONNECT_PROTOCOL,
        harness,
    })
}

#[tauri::command]
pub async fn harness_connect_v1(
    app: AppHandle,
    state: State<'_, HostState>,
    command: HarnessConnectCommand,
) -> Result<HarnessConnectResult, HarnessConnectError> {
    let safe_mode = state.inner().safe_mode;
    match command {
        HarnessConnectCommand::Describe {} => {
            // Discovery reads the filesystem (and a cached `claude --version`).
            tauri::async_runtime::spawn_blocking(move || {
                let installed = if safe_mode {
                    Vec::new()
                } else {
                    probe_native_harnesses()
                        .into_iter()
                        .filter(|summary| summary.installed)
                        .map(|summary| summary.kind)
                        .collect()
                };
                describe_with(safe_mode, terminal::is_available(), |harness| {
                    installed.contains(&harness)
                })
            })
            .await
            .map_err(|_| HarnessConnectError::new(HarnessConnectErrorCode::LaunchFailed))
        }
        HarnessConnectCommand::OpenTerminal { harness } => {
            let home = app.path().home_dir().ok();
            tauri::async_runtime::spawn_blocking(move || {
                open_terminal_with(
                    harness,
                    safe_mode,
                    home,
                    std::env::vars_os().collect(),
                    resolve_native_sign_in,
                    terminal::open,
                )
            })
            .await
            .map_err(|_| HarnessConnectError::new(HarnessConnectErrorCode::LaunchFailed))?
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn launch() -> NativeSignInLaunch {
        NativeSignInLaunch {
            program: std::env::temp_dir().join("node"),
            args: vec!["cli.js".to_owned(), "login".to_owned()],
        }
    }

    #[test]
    fn commands_are_strict_tagged_unions() {
        let describe: HarnessConnectCommand =
            serde_json::from_value(serde_json::json!({ "type": "describe" })).expect("describe");
        assert!(matches!(describe, HarnessConnectCommand::Describe {}));
        let open: HarnessConnectCommand = serde_json::from_value(
            serde_json::json!({ "type": "openTerminal", "harness": "claude-code" }),
        )
        .expect("open");
        assert!(matches!(
            open,
            HarnessConnectCommand::OpenTerminal {
                harness: HarnessKind::ClaudeCode
            }
        ));
        for invalid in [
            serde_json::json!({ "type": "describe", "extra": true }),
            serde_json::json!({ "type": "openTerminal" }),
            serde_json::json!({ "type": "openTerminal", "harness": "codex", "program": "x" }),
            serde_json::json!({ "type": "openTerminal", "harness": "not-a-harness" }),
            serde_json::json!({ "type": "run", "command": "codex login" }),
        ] {
            assert!(
                serde_json::from_value::<HarnessConnectCommand>(invalid.clone()).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn results_serialize_to_the_contract_shape() {
        let described = describe_with(false, true, |harness| harness != HarnessKind::Pi);
        assert_eq!(
            serde_json::to_value(&described).expect("json"),
            serde_json::json!({
                "type": "described",
                "protocol": 1,
                "harnesses": [
                    { "harness": "pi", "command": "pi", "then": "/login", "terminal": false },
                    { "harness": "codex", "command": "codex login", "terminal": true },
                    { "harness": "claude-code", "command": "claude", "then": "/login", "terminal": true },
                ]
            })
        );
        let opened = HarnessConnectResult::Opened {
            protocol: HARNESS_CONNECT_PROTOCOL,
            harness: HarnessKind::Codex,
        };
        assert_eq!(
            serde_json::to_value(&opened).expect("json"),
            serde_json::json!({ "type": "opened", "protocol": 1, "harness": "codex" })
        );
        let error = HarnessConnectError::new(HarnessConnectErrorCode::NoTerminal);
        assert_eq!(
            serde_json::to_value(&error).expect("json"),
            serde_json::json!({
                "code": "NO_TERMINAL",
                "message": "A terminal app was not found. Run the command yourself.",
                "recoverable": true
            })
        );
        for (code, expected) in [
            (HarnessConnectErrorCode::SafeMode, "SAFE_MODE"),
            (HarnessConnectErrorCode::NotSupported, "NOT_SUPPORTED"),
            (HarnessConnectErrorCode::NotInstalled, "NOT_INSTALLED"),
            (HarnessConnectErrorCode::LaunchFailed, "LAUNCH_FAILED"),
        ] {
            assert_eq!(serde_json::to_value(code).expect("json"), expected);
        }
    }

    #[test]
    fn describe_offers_a_terminal_only_when_it_can_open_one() {
        let all = |_: HarnessKind| true;
        let terminals = |result: HarnessConnectResult| match result {
            HarnessConnectResult::Described { harnesses, .. } => harnesses
                .iter()
                .map(|info| info.terminal)
                .collect::<Vec<_>>(),
            HarnessConnectResult::Opened { .. } => Vec::new(),
        };
        assert_eq!(terminals(describe_with(false, true, all)), [true; 3]);
        // Safe mode, a platform without a terminal and a missing harness each
        // turn it off; the harness stays listed so the UI can show the command.
        assert_eq!(terminals(describe_with(true, true, all)), [false; 3]);
        assert_eq!(terminals(describe_with(false, false, all)), [false; 3]);
        assert_eq!(
            terminals(describe_with(false, true, |harness| harness == HarnessKind::Codex)),
            [false, true, false]
        );
    }

    #[test]
    fn only_pi_codex_and_claude_code_have_a_sign_in_entry() {
        let pi = native_sign_in_entry(HarnessKind::Pi).expect("pi");
        assert_eq!(
            (pi.display, pi.then, pi.args),
            ("pi", Some("/login"), &[][..])
        );
        let codex = native_sign_in_entry(HarnessKind::Codex).expect("codex");
        assert_eq!(
            (codex.display, codex.then, codex.args),
            ("codex login", None, &["login"][..])
        );
        let claude = native_sign_in_entry(HarnessKind::ClaudeCode).expect("claude");
        assert_eq!(
            (claude.display, claude.then, claude.args),
            ("claude", Some("/login"), &[][..])
        );
        for other in [
            HarnessKind::Nano,
            HarnessKind::PrimeAgent,
            HarnessKind::Hermes,
        ] {
            assert_eq!(native_sign_in_entry(other), None, "{other}");
            assert!(resolve_native_sign_in(other).is_err(), "{other}");
        }
        let acp = HarnessKind::parse("acp:gemini-cli").expect("acp identity");
        assert_eq!(native_sign_in_entry(acp), None);
        assert!(resolve_native_sign_in(acp).is_err());
    }

    #[test]
    fn safe_mode_refuses_before_anything_is_resolved_or_opened() {
        let resolved = Cell::new(false);
        let opened = Cell::new(false);
        let error = open_terminal_with(
            HarnessKind::Pi,
            true,
            Some(std::env::temp_dir()),
            Vec::new(),
            |_| {
                resolved.set(true);
                Ok(launch())
            },
            |_, _, _, _| {
                opened.set(true);
                Ok(())
            },
        )
        .expect_err("safe mode");
        assert_eq!(error.code, HarnessConnectErrorCode::SafeMode);
        assert!(!resolved.get() && !opened.get());
    }

    #[test]
    fn unsupported_and_missing_harnesses_never_open_a_terminal() {
        let opened = Cell::new(false);
        let open = |_: &Path, _: &[String], _: &Path, _: &[(OsString, OsString)]| {
            opened.set(true);
            Ok(())
        };
        let error = open_terminal_with(
            HarnessKind::Nano,
            false,
            None,
            Vec::new(),
            |_| Ok(launch()),
            open,
        )
        .expect_err("nano has no entry");
        assert_eq!(error.code, HarnessConnectErrorCode::NotSupported);
        let error = open_terminal_with(
            HarnessKind::Codex,
            false,
            None,
            Vec::new(),
            |_| Err(NativeRuntimeError::HarnessUnavailable),
            open,
        )
        .expect_err("not installed");
        assert_eq!(error.code, HarnessConnectErrorCode::NotInstalled);
        assert!(!opened.get());
    }

    #[test]
    fn the_resolved_program_arguments_and_home_reach_the_terminal_unchanged() {
        let home = std::env::temp_dir();
        let seen = std::cell::RefCell::new(None);
        let result = open_terminal_with(
            HarnessKind::Codex,
            false,
            Some(home.clone()),
            Vec::new(),
            |_| Ok(launch()),
            |program, args, cwd, _| {
                *seen.borrow_mut() =
                    Some((program.to_path_buf(), args.to_vec(), cwd.to_path_buf()));
                Ok(())
            },
        )
        .expect("opened");
        assert_eq!(
            result,
            HarnessConnectResult::Opened {
                protocol: 1,
                harness: HarnessKind::Codex
            }
        );
        let expected = launch();
        assert_eq!(
            seen.into_inner(),
            Some((expected.program, expected.args, home))
        );
    }

    #[test]
    fn terminal_failures_map_to_typed_codes() {
        for (failure, code) in [
            (
                TerminalError::Unsupported,
                HarnessConnectErrorCode::NotSupported,
            ),
            (
                TerminalError::NoTerminal,
                HarnessConnectErrorCode::NoTerminal,
            ),
            (TerminalError::Launch, HarnessConnectErrorCode::LaunchFailed),
        ] {
            let error = open_terminal_with(
                HarnessKind::ClaudeCode,
                false,
                None,
                Vec::new(),
                |_| Ok(launch()),
                |_, _, _, _| Err(failure),
            )
            .expect_err("failure");
            assert_eq!(error.code, code);
            assert!(error.recoverable);
        }
    }

    #[test]
    fn the_terminal_gets_a_sanitized_environment_not_the_host_one() {
        let host: Vec<(OsString, OsString)> = [
            ("PATH", "/bin"),
            ("ANTHROPIC_API_KEY", "key"),
            ("CLAUDECODE", "1"),
            ("PIUI_AGENT_API_TOKEN", "token"),
            ("PIUI_PRIME_NANO_SOURCE", "lease"),
            ("PIUI_NANO_CODEX_SOURCE", "lease"),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect();
        let names_for = |harness: HarnessKind| {
            let seen = std::cell::RefCell::new(Vec::new());
            open_terminal_with(
                harness,
                false,
                None,
                host.clone(),
                |_| Ok(launch()),
                |_, _, _, environment| {
                    *seen.borrow_mut() = environment
                        .iter()
                        .map(|(name, _)| name.to_string_lossy().into_owned())
                        .collect::<Vec<_>>();
                    Ok(())
                },
            )
            .expect("opened");
            seen.into_inner()
        };
        assert_eq!(names_for(HarnessKind::ClaudeCode), ["PATH"]);
        // Other harnesses lose only the host-only capabilities.
        assert_eq!(
            names_for(HarnessKind::Codex),
            ["PATH", "ANTHROPIC_API_KEY", "CLAUDECODE"]
        );
    }
}
