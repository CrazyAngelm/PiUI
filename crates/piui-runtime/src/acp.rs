//! Agent Client Protocol agent descriptors (schema v1, ADR-034).
//!
//! A descriptor is data that lets PiUI start one ACP agent without code in
//! core: its identity, the exact command line, how to read its version and the
//! verified version range, which environment variables may pass through from
//! the user's environment (names only; PiUI never stores values), a sign-in
//! hint, a documentation link and capability restrictions. It never carries
//! credentials, shell strings or scripts.
//!
//! This module validates descriptors, resolves their program without a shell
//! (`PATH`, Windows `.exe`, and npm/pnpm `.cmd` shims that start a Node
//! script or one native executable), probes the version under process
//! containment and builds the agent environment. Trust, storage and secret
//! confirmations are host decisions. The version is advisory: only a version
//! below a declared minimum is refused; the ACP `initialize` handshake is the
//! compatibility gate.

use crate::native_version::{NativeVersion, VerifiedRange, VersionCheck};
use crate::script_runner::process_directory;
use crate::workspace_runtime::resolve_node;
pub use piui_contracts::harness_identity::AcpAgentId;
#[cfg(any(unix, windows))]
use piui_platform::ProcessContainment;
#[cfg(unix)]
use piui_platform::{ProcessGroupId, UnixProcessGroup};
#[cfg(windows)]
use piui_platform::{ProcessId, SuspendedProcess, WindowsJob};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use thiserror::Error;

/// Descriptor schema version (`contracts/acp-agent-descriptor-v1.schema.json`).
pub const ACP_DESCRIPTOR_SCHEMA_VERSION: u32 = 1;
/// Largest accepted descriptor document.
pub const MAX_DESCRIPTOR_BYTES: usize = 32 * 1024;
/// The profile model value that keeps the agent's own configured model.
pub const ACP_DEFAULT_MODEL: &str = "default";

const MAX_DISPLAY_NAME_CHARS: usize = 64;
const MAX_PROGRAM_CHARS: usize = 260;
const MAX_ARGS: usize = 32;
const MAX_VERSION_ARGS: usize = 8;
const MAX_ARG_CHARS: usize = 512;
const MAX_PATTERN_CHARS: usize = 200;
const MAX_ENVIRONMENT_NAMES: usize = 32;
const MAX_ENVIRONMENT_NAME_CHARS: usize = 128;
const MAX_AUTH_HINT_CHARS: usize = 400;
const MAX_DOCS_URL_CHARS: usize = 300;
/// Node-based agent CLIs load large bundles even for `--version`; the probe
/// runs off the UI path, so a generous bound only matters for a hung program.
const VERSION_TIMEOUT: Duration = Duration::from_secs(20);
/// A failed version probe is repeated after this delay; a success is kept
/// until the executable (or script) changes.
const VERSION_RETRY: Duration = Duration::from_secs(60);
const VERSION_OUTPUT_LIMIT: usize = 4 * 1024;
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const SHIM_LIMIT: u64 = 64 * 1024;
/// First `MAJOR.MINOR.PATCH[-pre]` in the version output.
const DEFAULT_VERSION_PATTERN: &str = r"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)";

/// Host environment every ACP agent (and its bridge) receives: locations,
/// locale and the executable search path. None of them is a credential.
/// Everything else, including API keys, tokens and PiUI operator variables,
/// is removed unless a descriptor names it (secret-like names only after an
/// explicit confirmation).
pub const ACP_BASE_ENVIRONMENT: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
];

/// Names a descriptor can never pass through: they would change how the
/// contained Node bridge or the dynamic loader runs, or they belong to PiUI.
const DENIED_ENVIRONMENT: &[&str] = &[
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
];

/// Parts of a variable name that mark a likely secret. Passing such a
/// variable needs an explicit per-descriptor confirmation.
const SECRET_MARKERS: &[&str] = &[
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "AUTH",
    "COOKIE",
    "SESSION",
    "PRIVATE",
];

/// One ACP agent, as a user adds it or PiUI ships it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpAgentDescriptor {
    pub schema_version: u32,
    pub id: AcpAgentId,
    pub display_name: String,
    pub command: AcpCommandSpec,
    pub version: AcpVersionSpec,
    /// Variable names passed through from the user's environment.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
    #[serde(default, skip_serializing_if = "AcpCapabilityOverrides::is_empty")]
    pub capabilities: AcpCapabilityOverrides,
}

/// The program and its fixed arguments. Never a shell string.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpCommandSpec {
    /// A file name searched on `PATH`, or an absolute path.
    pub program: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpVersionSpec {
    /// Arguments that print the version, for example `["--version"]`.
    pub args: Vec<String>,
    /// Regular expression whose first group (or whole match) is the version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// Versions tested with PiUI: `minimum <= version < ceiling`. The
    /// minimum is enforced (an older agent never starts); the ceiling is
    /// advisory (a newer agent starts and is reported as newer than tested).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<AcpVerifiedVersions>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpVerifiedVersions {
    pub minimum: String,
    pub ceiling: String,
}

/// Restrictions only: a descriptor can switch an advertised feature off
/// (for an agent that misreports it), never claim one. Each field is `false`
/// when present.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpCapabilityOverrides {
    /// Never reopen conversations with `session/load`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_session: Option<bool>,
    /// Ignore advertised models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<bool>,
    /// Ignore advertised session modes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<bool>,
    /// Never pass PiUI's workspace tool as an HTTP MCP server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_http: Option<bool>,
}

impl AcpCapabilityOverrides {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn values(&self) -> [Option<bool>; 4] {
        [self.load_session, self.models, self.modes, self.mcp_http]
    }
}

/// Validation failure of a descriptor. Messages are fixed locale keys.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum AcpDescriptorError {
    #[error("The descriptor is not valid JSON or contains unknown fields.")]
    Malformed,
    #[error("The descriptor is larger than 32 KiB.")]
    TooLarge,
    #[error("Only ACP descriptor schema version 1 is supported.")]
    UnsupportedSchema,
    #[error("The display name must be 1-64 characters without control characters.")]
    DisplayName,
    #[error("The program must be a file name found on PATH or an absolute path.")]
    Program,
    #[error("Use at most 32 arguments of 1-512 characters without control characters.")]
    Arguments,
    #[error("Use 1-8 version arguments of 1-512 characters without control characters.")]
    VersionArguments,
    #[error("The version pattern must be a valid regular expression of at most 200 characters.")]
    VersionPattern,
    #[error(
        "The verified range needs MAJOR.MINOR.PATCH versions with the minimum below the ceiling."
    )]
    VerifiedRange,
    #[error(
        "Environment variables must be at most 32 unique names of letters, digits and underscores."
    )]
    EnvironmentName,
    #[error("This environment variable cannot be passed to an agent.")]
    EnvironmentDenied,
    #[error("The sign-in hint must be at most 400 characters without control characters.")]
    AuthHint,
    #[error("The documentation link must be an https URL of at most 300 characters.")]
    DocsUrl,
    #[error("A descriptor can only switch agent features off.")]
    CapabilityOverride,
}

impl AcpDescriptorError {
    /// Stable machine code for host errors and tests.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::TooLarge => "too-large",
            Self::UnsupportedSchema => "unsupported-schema",
            Self::DisplayName => "display-name",
            Self::Program => "program",
            Self::Arguments => "arguments",
            Self::VersionArguments => "version-arguments",
            Self::VersionPattern => "version-pattern",
            Self::VerifiedRange => "verified-range",
            Self::EnvironmentName => "environment-name",
            Self::EnvironmentDenied => "environment-denied",
            Self::AuthHint => "auth-hint",
            Self::DocsUrl => "docs-url",
            Self::CapabilityOverride => "capability-override",
        }
    }
}

/// Parses and validates one descriptor document.
pub fn parse_acp_descriptor(text: &str) -> Result<AcpAgentDescriptor, AcpDescriptorError> {
    if text.len() > MAX_DESCRIPTOR_BYTES {
        return Err(AcpDescriptorError::TooLarge);
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| AcpDescriptorError::Malformed)?;
    if value.get("schemaVersion") != Some(&serde_json::json!(ACP_DESCRIPTOR_SCHEMA_VERSION)) {
        return Err(if value.get("schemaVersion").is_some() {
            AcpDescriptorError::UnsupportedSchema
        } else {
            AcpDescriptorError::Malformed
        });
    }
    let descriptor: AcpAgentDescriptor =
        serde_json::from_value(value).map_err(|_| AcpDescriptorError::Malformed)?;
    descriptor.validate()?;
    Ok(descriptor)
}

fn plain_text(value: &str, maximum: usize) -> bool {
    let length = value.chars().count();
    length > 0 && length <= maximum && !value.chars().any(char::is_control)
}

fn plain_args(values: &[String], maximum: usize) -> bool {
    values.len() <= maximum && values.iter().all(|value| plain_text(value, MAX_ARG_CHARS))
}

fn parse_core(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.split('.');
    let mut next = || {
        parts
            .next()
            .filter(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|part| part.parse().ok())
    };
    let core = (next()?, next()?, next()?);
    parts.next().is_none().then_some(core)
}

fn valid_program(program: &str) -> bool {
    if !plain_text(program, MAX_PROGRAM_CHARS) || program.contains(['"', '\'', '`']) {
        return false;
    }
    let path = Path::new(program);
    if path.is_absolute() {
        return true;
    }
    // A bare file name only: a relative path would resolve against an
    // arbitrary working directory.
    !program.contains(['/', '\\', ':'])
        && program != "."
        && program != ".."
        && program
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._+-".contains(character))
}

fn valid_environment_name(name: &str) -> bool {
    let mut characters = name.chars();
    name.len() <= MAX_ENVIRONMENT_NAME_CHARS
        && characters
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn denied_environment(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("PIUI_") || DENIED_ENVIRONMENT.contains(&upper.as_str())
}

/// Whether a variable name looks like a credential (`GEMINI_API_KEY`).
#[must_use]
pub fn secret_like_environment(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    SECRET_MARKERS.iter().any(|marker| upper.contains(marker))
}

impl AcpAgentDescriptor {
    /// Semantic rules beyond the JSON shape (`deny_unknown_fields`).
    pub fn validate(&self) -> Result<(), AcpDescriptorError> {
        if self.schema_version != ACP_DESCRIPTOR_SCHEMA_VERSION {
            return Err(AcpDescriptorError::UnsupportedSchema);
        }
        if !plain_text(&self.display_name, MAX_DISPLAY_NAME_CHARS)
            || self.display_name.trim() != self.display_name
        {
            return Err(AcpDescriptorError::DisplayName);
        }
        if !valid_program(&self.command.program) {
            return Err(AcpDescriptorError::Program);
        }
        if !plain_args(&self.command.args, MAX_ARGS) {
            return Err(AcpDescriptorError::Arguments);
        }
        if self.version.args.is_empty() || !plain_args(&self.version.args, MAX_VERSION_ARGS) {
            return Err(AcpDescriptorError::VersionArguments);
        }
        if let Some(pattern) = &self.version.pattern
            && (!plain_text(pattern, MAX_PATTERN_CHARS) || version_regex(Some(pattern)).is_none())
        {
            return Err(AcpDescriptorError::VersionPattern);
        }
        if let Some(verified) = &self.version.verified {
            let (Some(minimum), Some(ceiling)) =
                (parse_core(&verified.minimum), parse_core(&verified.ceiling))
            else {
                return Err(AcpDescriptorError::VerifiedRange);
            };
            if minimum >= ceiling {
                return Err(AcpDescriptorError::VerifiedRange);
            }
        }
        if self.environment.len() > MAX_ENVIRONMENT_NAMES
            || !self
                .environment
                .iter()
                .all(|name| valid_environment_name(name))
        {
            return Err(AcpDescriptorError::EnvironmentName);
        }
        for (index, name) in self.environment.iter().enumerate() {
            if self.environment[..index]
                .iter()
                .any(|other| other.eq_ignore_ascii_case(name))
            {
                return Err(AcpDescriptorError::EnvironmentName);
            }
            if denied_environment(name) {
                return Err(AcpDescriptorError::EnvironmentDenied);
            }
        }
        if self
            .auth_hint
            .as_deref()
            .is_some_and(|hint| !plain_text(hint, MAX_AUTH_HINT_CHARS))
        {
            return Err(AcpDescriptorError::AuthHint);
        }
        if self.docs_url.as_deref().is_some_and(|url| {
            !plain_text(url, MAX_DOCS_URL_CHARS)
                || !url.starts_with("https://")
                || url.len() <= "https://".len()
                || url.contains(char::is_whitespace)
        }) {
            return Err(AcpDescriptorError::DocsUrl);
        }
        if self.capabilities.values().contains(&Some(true)) {
            return Err(AcpDescriptorError::CapabilityOverride);
        }
        Ok(())
    }

    /// SHA-256 of the canonical serialization. Trust and confirmations bind
    /// to it, so any change to a descriptor needs a new decision.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        format!("{:x}", Sha256::digest(bytes))
    }

    /// Environment names that need an explicit confirmation before they pass.
    #[must_use]
    pub fn secret_environment(&self) -> Vec<String> {
        self.environment
            .iter()
            .filter(|name| secret_like_environment(name))
            .cloned()
            .collect()
    }

    /// The verified range, when the descriptor declares one.
    fn verified_range(&self) -> Option<VerifiedRange> {
        let verified = self.version.verified.as_ref()?;
        Some(VerifiedRange {
            minimum: parse_core(&verified.minimum)?,
            ceiling: parse_core(&verified.ceiling)?,
        })
    }
}

/// Descriptors shipped with PiUI, one JSON document each in
/// `contracts/fixtures/acp-descriptors/valid-builtin-<id>.json`: the same
/// bytes the contract tests of the UI lab check, so the shipped catalog has a
/// single source of truth. They are reviewed launch recipes for agents that
/// speak ACP natively (never wrappers around Codex or Claude Code, which have
/// their own adapters). No descriptor declares a verified range: a version
/// needs no confirmation, the ACP `initialize` handshake is the gate, and a
/// range would only add an enforced minimum.
const BUILTIN_DESCRIPTORS: [&str; 7] = [
    include_str!("../../../contracts/fixtures/acp-descriptors/valid-builtin-gemini-cli.json"),
    include_str!("../../../contracts/fixtures/acp-descriptors/valid-builtin-opencode.json"),
    include_str!("../../../contracts/fixtures/acp-descriptors/valid-builtin-qwen-code.json"),
    include_str!("../../../contracts/fixtures/acp-descriptors/valid-builtin-github-copilot.json"),
    include_str!("../../../contracts/fixtures/acp-descriptors/valid-builtin-goose.json"),
    include_str!("../../../contracts/fixtures/acp-descriptors/valid-builtin-kimi.json"),
    include_str!("../../../contracts/fixtures/acp-descriptors/valid-builtin-cursor.json"),
];

/// The descriptors shipped with PiUI, in display order. A document that fails
/// validation is skipped; a unit test proves every shipped one loads.
#[must_use]
pub fn builtin_acp_descriptors() -> Vec<AcpAgentDescriptor> {
    BUILTIN_DESCRIPTORS
        .iter()
        .filter_map(|text| parse_acp_descriptor(text).ok())
        .collect()
}

/// The exact program and arguments PiUI starts, without a shell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpResolvedCommand {
    pub program: PathBuf,
    /// Arguments after the program: a Node script for shims, then the
    /// descriptor's own arguments.
    pub args: Vec<String>,
    /// How many leading entries of `args` belong to the launcher (the Node
    /// script behind a shim) rather than to the descriptor. A version probe
    /// keeps them (see [`Self::version_args`] for the descriptor's own).
    #[serde(skip)]
    launcher_args: usize,
    /// The file whose identity the version cache binds to (the executable,
    /// or the Node script behind a shim).
    #[serde(skip)]
    identity: PathBuf,
}

impl AcpResolvedCommand {
    /// The arguments of a version probe: the launcher's own, the descriptor's
    /// arguments up to and including the last one that names a script or file
    /// entrypoint, then `version`. Arguments after the entrypoint (a
    /// subcommand such as `acp`, a flag such as `--acp`) never reach the
    /// probe, so `opencode acp` is probed as `opencode --version` while
    /// `node agent.mjs --acp` is probed as `node agent.mjs --version`, the
    /// agent itself and not Node.
    fn version_args(&self, version: &[String]) -> Vec<String> {
        let (launcher, own) = self.args.split_at(self.launcher_args.min(self.args.len()));
        let kept = entrypoint_index(own).map_or(0, |index| index + 1);
        launcher
            .iter()
            .chain(&own[..kept])
            .chain(version)
            .cloned()
            .collect()
    }

    /// The file whose identity the version cache binds to: the script a
    /// descriptor starts through an interpreter when it exists, otherwise the
    /// executable (or the Node script behind a shim).
    fn probe_identity(&self) -> PathBuf {
        let own = &self.args[self.launcher_args.min(self.args.len())..];
        entrypoint_index(own)
            .map(|index| Path::new(&own[index]))
            .filter(|entrypoint| entrypoint.is_file())
            .map_or_else(|| self.identity.clone(), Path::to_path_buf)
    }
}

/// The last descriptor argument that names the script or file its program
/// runs (`agent.mjs`, `bin/agent`, `C:\agents\agent.py`) rather than a
/// subcommand, a flag or an option value (`acp`, `--acp`,
/// `--config cfg/agent.json`). A script extension always names an entrypoint
/// (`node --no-warnings agent.mjs`); an extensionless path does only when it
/// does not follow a flag, where it would be that flag's value.
fn entrypoint_index(args: &[String]) -> Option<usize> {
    args.iter().enumerate().rev().find_map(|(index, arg)| {
        if arg.starts_with('-') {
            return None;
        }
        let lower = arg.to_ascii_lowercase();
        let script = [".js", ".mjs", ".cjs", ".ts", ".py"]
            .iter()
            .any(|extension| lower.ends_with(extension));
        let after_flag = index > 0 && args[index - 1].starts_with('-');
        let path = arg.contains(['/', '\\']) && !lower.contains('.');
        (script || (path && !after_flag)).then_some(index)
    })
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum AcpResolveError {
    #[error("The program was not found on PATH.")]
    NotFound,
    #[error("The program path does not name an existing file.")]
    Missing,
    #[error(
        "This launcher needs a shell, which PiUI never uses. Point the descriptor at the executable or the Node script."
    )]
    UnsupportedLauncher,
    #[error("Node.js is needed to start this agent but was not found.")]
    NodeUnavailable,
}

/// Resolves `spec` against the current `PATH`.
pub fn resolve_acp_command(spec: &AcpCommandSpec) -> Result<AcpResolvedCommand, AcpResolveError> {
    resolve_acp_command_in(spec, std::env::var_os("PATH").as_deref())
}

/// Resolves `spec` against `path` (a `PATH` value). Only absolute `PATH`
/// entries are searched: a relative entry would resolve against the project
/// folder, which may contain untrusted files. Every hit is tried in order, so
/// a launcher PiUI cannot run without a shell (a user's own wrapper script)
/// does not hide a supported installation further along `PATH`; when none
/// resolves, the first hit's failure is reported.
pub fn resolve_acp_command_in(
    spec: &AcpCommandSpec,
    path: Option<&OsStr>,
) -> Result<AcpResolvedCommand, AcpResolveError> {
    let program = Path::new(&spec.program);
    if program.is_absolute() {
        if !program.is_file() {
            return Err(AcpResolveError::Missing);
        }
        return resolve_file(program.to_path_buf(), &spec.args);
    }
    let mut first_failure = None;
    for file in find_programs(&spec.program, path) {
        match resolve_file(file, &spec.args) {
            Ok(command) => return Ok(command),
            Err(error) => {
                first_failure.get_or_insert(error);
            }
        }
    }
    Err(first_failure.unwrap_or(AcpResolveError::NotFound))
}

fn resolve_file(file: PathBuf, args: &[String]) -> Result<AcpResolvedCommand, AcpResolveError> {
    let file = process_directory(&file);
    let extension = file
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("js" | "mjs" | "cjs") => Ok(node_command(
            resolve_node().map_err(|_| AcpResolveError::NodeUnavailable)?,
            file,
            args,
        )),
        Some("cmd" | "bat") if cfg!(windows) => resolve_shim(&file, args),
        Some("exe" | "com") if cfg!(windows) => Ok(executable_command(file, args)),
        _ if cfg!(windows) => Err(AcpResolveError::UnsupportedLauncher),
        _ => Ok(executable_command(file, args)),
    }
}

/// A Windows `.cmd` shim becomes the Node script (npm, pnpm) or the one native
/// executable (`opencode.cmd` from the npm package `opencode-ai`) it starts.
/// Any other batch file needs a shell and is refused.
fn resolve_shim(shim: &Path, args: &[String]) -> Result<AcpResolvedCommand, AcpResolveError> {
    match shim_target(shim).ok_or(AcpResolveError::UnsupportedLauncher)? {
        ShimTarget::Script(script) => {
            // The shim prefers a Node installed beside it, like npm's own.
            let beside = shim
                .parent()
                .map(|directory| directory.join("node.exe"))
                .filter(|node| node.is_file());
            let node = match beside {
                Some(node) => node,
                None => resolve_node().map_err(|_| AcpResolveError::NodeUnavailable)?,
            };
            Ok(node_command(node, script, args))
        }
        ShimTarget::Executable(program) => Ok(executable_command(program, args)),
    }
}

fn executable_command(file: PathBuf, args: &[String]) -> AcpResolvedCommand {
    AcpResolvedCommand {
        identity: file.clone(),
        program: file,
        args: args.to_vec(),
        launcher_args: 0,
    }
}

fn node_command(node: PathBuf, script: PathBuf, args: &[String]) -> AcpResolvedCommand {
    let mut all = vec![script.to_string_lossy().into_owned()];
    all.extend(args.iter().cloned());
    AcpResolvedCommand {
        program: node,
        args: all,
        identity: script,
        launcher_args: 1,
    }
}

impl AcpResolvedCommand {
    /// Test support only: a launch that bypasses resolution, for fixtures.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn test_command(program: PathBuf, args: Vec<String>) -> Self {
        Self {
            identity: program.clone(),
            program,
            args,
            launcher_args: 0,
        }
    }
}

/// Every executable file named `name` on the absolute `path` entries, in
/// `PATH` order (Windows tries `.exe`, `.cmd`, `.bat` in each directory).
fn find_programs(name: &str, path: Option<&OsStr>) -> Vec<PathBuf> {
    let Some(path) = path else {
        return Vec::new();
    };
    let candidates: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        [".exe", ".cmd", ".bat"]
            .iter()
            .map(|extension| format!("{name}{extension}"))
            .collect()
    } else {
        vec![name.to_owned()]
    };
    std::env::split_paths(path)
        .filter(|directory| directory.is_absolute())
        .flat_map(|directory| {
            candidates
                .iter()
                .map(|candidate| directory.join(candidate))
                .collect::<Vec<_>>()
        })
        .filter(|file| file.is_file() && executable(file))
        .collect()
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    path.metadata()
        .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(_path: &Path) -> bool {
    true
}

/// What a `.cmd` shim starts.
#[derive(Debug, PartialEq, Eq)]
enum ShimTarget {
    /// A Node script, run with the Node installed beside the shim or on `PATH`.
    Script(PathBuf),
    /// One native executable, started directly.
    Executable(PathBuf),
}

/// The only target of an npm or pnpm `.cmd` shim: exactly one Node script
/// (`"%dp0%\node_modules\pkg\cli.js"` for npm, `"%~dp0\..\pkg\cli.js"` for
/// pnpm), or, when the shim names no script, exactly one native executable
/// (`"%dp0%\node_modules\opencode-ai\bin\opencode.exe" %*`). A native
/// executable is accepted only in that passthrough form: its line ends with
/// the closing quote, optional blanks and `%*`. Fixed arguments (`--config
/// locked.json %*`) would be lost when PiUI starts the executable directly, so
/// such a shim needs a shell. A shim that names a script is a Node shim
/// whatever else it mentions; one that names two different scripts or two
/// different executables is ambiguous. Names with `%` or `!`, and targets that
/// do not exist, are refused. Any other batch file needs a shell and yields
/// `None`.
fn shim_target(shim: &Path) -> Option<ShimTarget> {
    use std::io::Read as _;
    let directory = shim.parent()?;
    let mut bytes = Vec::new();
    std::fs::File::open(shim)
        .ok()?
        .take(SHIM_LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > SHIM_LIMIT {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut scripts = shim_files(directory, &text, &[".js", ".cjs", ".mjs"], false)?;
    if !scripts.is_empty() {
        return match (scripts.pop(), scripts.is_empty()) {
            (Some(script), true) => Some(ShimTarget::Script(script)),
            _ => None,
        };
    }
    let mut executables = shim_files(directory, &text, &[".exe"], true)?;
    match (executables.pop(), executables.is_empty()) {
        (Some(program), true) => Some(ShimTarget::Executable(program)),
        _ => None,
    }
}

/// The distinct existing files a shim names as `"%dp0%\relative"` (or
/// `%~dp0`) with one of `extensions`, canonical and without the verbatim
/// prefix. `None` when a name is unsafe or its file is missing, or, with
/// `passthrough_only`, when a name is not the last quoted item of its line
/// followed by nothing but blanks and `%*`. The interpreter probe
/// `IF EXIST "%dp0%\node.exe"` is not a target.
fn shim_files(
    directory: &Path,
    text: &str,
    extensions: &[&str],
    passthrough_only: bool,
) -> Option<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = Vec::new();
    for line in text.lines() {
        let parts = line.split('"').collect::<Vec<_>>();
        for (index, quoted) in parts.iter().enumerate().skip(1).step_by(2) {
            let Some(relative) = quoted
                .strip_prefix("%dp0%\\")
                .or_else(|| quoted.strip_prefix("%~dp0\\"))
            else {
                continue;
            };
            let lower = relative.to_ascii_lowercase();
            if !extensions
                .iter()
                .any(|extension| lower.ends_with(extension))
            {
                continue;
            }
            if lower.rsplit('\\').next() == Some("node.exe") {
                continue;
            }
            if relative.contains(['%', '!']) {
                return None;
            }
            // `parts[index + 1]` follows the closing quote; a further part
            // means another quote, so the line does not end with `%*`.
            if passthrough_only
                && (index + 2 != parts.len() || parts[index + 1].trim_matches([' ', '\t']) != "%*")
            {
                return None;
            }
            let candidate = directory.join(relative.replace('\\', std::path::MAIN_SEPARATOR_STR));
            let resolved = process_directory(&std::fs::canonicalize(candidate).ok()?);
            if !resolved.is_file() {
                return None;
            }
            if !files.contains(&resolved) {
                files.push(resolved);
            }
        }
    }
    Some(files)
}

/// Outcome of a version probe against the descriptor's verified range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcpVersionStatus {
    /// Inside the verified range.
    Verified,
    /// The descriptor declares no verified range.
    NoVerifiedRange,
    /// Newer than the verified range (the advisory ceiling): still started.
    Newer,
    /// Older than the verified range (the enforced minimum): never started.
    Older,
    /// The output held no version the pattern recognizes.
    Unrecognized,
    /// The version command failed or timed out.
    ProbeFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcpVersionReport {
    pub version: Option<String>,
    pub status: AcpVersionStatus,
}

struct VersionProbe {
    length: u64,
    modified: Option<SystemTime>,
    probed_at: Instant,
    output: Option<String>,
}

type VersionCache = Mutex<HashMap<(PathBuf, Vec<String>), VersionProbe>>;

/// Runs the descriptor's version command at most once per executable
/// revision (inside a Job or process group, bounded, with only the base
/// environment) and checks the result against the verified range. The probe
/// is the program, the Node script behind a shim, the descriptor's own script
/// entrypoint (`node agent.mjs`) and the version arguments: the launch
/// arguments after the entrypoint are not passed, so `agent acp` is probed as
/// `agent --version`. `force` ("Check again") bypasses the cache.
pub fn probe_acp_version(
    descriptor: &AcpAgentDescriptor,
    command: &AcpResolvedCommand,
    force: bool,
) -> AcpVersionReport {
    static CACHE: OnceLock<VersionCache> = OnceLock::new();
    let args = command.version_args(&descriptor.version.args);
    let metadata = std::fs::metadata(command.probe_identity()).ok();
    let length = metadata.as_ref().map_or(0, std::fs::Metadata::len);
    let modified = metadata.and_then(|metadata| metadata.modified().ok());
    let key = (command.program.clone(), args.clone());
    let cached = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| {
            cache
                .get(&key)
                .filter(|probe| {
                    !force
                        && probe.length == length
                        && probe.modified == modified
                        && (probe.output.is_some() || probe.probed_at.elapsed() < VERSION_RETRY)
                })
                .map(|probe| probe.output.clone())
        });
    let output = match cached {
        Some(output) => output,
        None => {
            let environment = acp_environment(&std::env::vars_os().collect::<Vec<_>>(), &[]);
            let output = run_version_command(&command.program, &args, &environment);
            if let Some(mut cache) = CACHE.get().and_then(|cache| cache.lock().ok()) {
                cache.insert(
                    key,
                    VersionProbe {
                        length,
                        modified,
                        probed_at: Instant::now(),
                        output: output.clone(),
                    },
                );
            }
            output
        }
    };
    version_report(descriptor, output.as_deref())
}

fn version_regex(pattern: Option<&str>) -> Option<regex::Regex> {
    regex::RegexBuilder::new(pattern.unwrap_or(DEFAULT_VERSION_PATTERN))
        .size_limit(1 << 20)
        .build()
        .ok()
}

/// Extracts and checks a version from the bounded command output.
fn version_report(descriptor: &AcpAgentDescriptor, output: Option<&str>) -> AcpVersionReport {
    let Some(output) = output else {
        return AcpVersionReport {
            version: None,
            status: AcpVersionStatus::ProbeFailed,
        };
    };
    let version = version_regex(descriptor.version.pattern.as_deref()).and_then(|pattern| {
        let captures = pattern.captures(output)?;
        let matched = captures.get(1).or_else(|| captures.get(0))?;
        let text = matched.as_str().trim();
        (!text.is_empty() && text.len() <= 64).then(|| text.to_owned())
    });
    let Some(version) = version else {
        return AcpVersionReport {
            version: None,
            status: AcpVersionStatus::Unrecognized,
        };
    };
    let status = match (
        NativeVersion::parse(&version).is_some(),
        descriptor.verified_range(),
    ) {
        (false, _) => AcpVersionStatus::Unrecognized,
        (true, None) => AcpVersionStatus::NoVerifiedRange,
        (true, Some(range)) => match range.check(Some(&version)) {
            VersionCheck::Verified => AcpVersionStatus::Verified,
            VersionCheck::Newer => AcpVersionStatus::Newer,
            VersionCheck::Older => AcpVersionStatus::Older,
            VersionCheck::Unrecognized => AcpVersionStatus::Unrecognized,
        },
    };
    AcpVersionReport {
        version: Some(version),
        status,
    }
}

/// Reads at most [`VERSION_OUTPUT_LIMIT`] bytes and drains the rest, so the
/// child never blocks on a full pipe.
fn read_bounded(mut stream: impl std::io::Read) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = VERSION_OUTPUT_LIMIT.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
        }
    }
    kept
}

/// Runs one version command inside the same containment as a runtime: a
/// Windows Job assigned before resume or an owned Unix process group. The
/// whole tree is retired afterwards; only bounded output survives.
fn run_version_command(
    program: &Path,
    args: &[String],
    environment: &[(OsString, OsString)],
) -> Option<String> {
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    #[cfg(windows)]
    let mut job = WindowsJob::new().ok()?;
    let mut child = command.spawn().ok()?;
    #[cfg(windows)]
    {
        let resumed = ProcessId::new(child.id())
            .ok()
            .and_then(|pid| {
                job.assign_before_resume(SuspendedProcess::from_created_suspended(pid))
                    .ok()
            })
            .and_then(|assignment| job.resume_assigned(assignment).ok());
        if resumed.is_none() {
            let _ = job.force_terminate_tree();
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    }
    #[cfg(unix)]
    let mut group = {
        let Some(id) = i32::try_from(child.id())
            .ok()
            .and_then(|pid| ProcessGroupId::new(pid).ok())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        };
        UnixProcessGroup::from_spawned_group(id)
    };
    let readers = [child.stdout.take(), None]
        .into_iter()
        .flatten()
        .map(|stream| {
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = sender.send(read_bounded(stream));
            });
            receiver
        })
        .chain(child.stderr.take().map(|stream| {
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = sender.send(read_bounded(stream));
            });
            receiver
        }))
        .collect::<Vec<_>>();
    let deadline = Instant::now() + VERSION_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => break None,
        }
    };
    #[cfg(windows)]
    {
        let _ = job.force_terminate_tree();
        let _ = job.close();
    }
    #[cfg(unix)]
    {
        let _ = group.force_terminate_tree();
        group.discard_after_supervisor_cleanup();
    }
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let output = readers
        .into_iter()
        .filter_map(|receiver| receiver.recv_timeout(PIPE_DRAIN_TIMEOUT).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    status.filter(|status| status.success()).map(|_| output)
}

fn same_environment_name(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

/// The environment of an ACP agent: [`ACP_BASE_ENVIRONMENT`] plus the
/// `allowed` names, filtered from `host`. Names are compared
/// case-insensitively on Windows, where the environment block is.
pub fn acp_environment(
    host: &[(OsString, OsString)],
    allowed: &[String],
) -> Vec<(OsString, OsString)> {
    host.iter()
        .filter(|(name, _)| {
            name.to_str().is_some_and(|name| {
                !denied_environment(name)
                    && (ACP_BASE_ENVIRONMENT
                        .iter()
                        .any(|base| same_environment_name(name, base))
                        || allowed
                            .iter()
                            .any(|allowed| same_environment_name(name, allowed)))
            })
        })
        .cloned()
        .collect()
}

/// A host-resolved start of one ACP agent. Built only by the host from a
/// validated, trusted (or built-in) descriptor and its confirmations.
#[derive(Clone, Debug)]
pub struct AcpLaunch {
    pub agent: AcpAgentId,
    pub display_name: String,
    pub command: AcpResolvedCommand,
    /// Variable names that pass through in addition to the base environment:
    /// the descriptor's non-secret names and its confirmed secret-like names.
    pub environment: Vec<String>,
    pub capabilities: AcpCapabilityOverrides,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor() -> AcpAgentDescriptor {
        builtin_acp_descriptors()
            .into_iter()
            .next()
            .expect("built-in Gemini descriptor")
    }

    fn fresh_directory(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "piui-acp-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&root).expect("test directory");
        root
    }

    /// `(id, program, launch arguments, names that need a secret confirmation)`.
    /// One generic adapter starts every entry; the table is the review record.
    const BUILTIN_CATALOG: [(&str, &str, &[&str], &[&str]); 7] = [
        (
            "gemini-cli",
            "gemini",
            &["--acp"],
            &[
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "GOOGLE_APPLICATION_CREDENTIALS",
            ],
        ),
        (
            "opencode",
            "opencode",
            &["acp"],
            &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
        ),
        (
            "qwen-code",
            "qwen",
            &["--acp"],
            &["DASHSCOPE_API_KEY", "OPENAI_API_KEY"],
        ),
        (
            "github-copilot",
            "copilot",
            &["--acp"],
            &["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
        ),
        ("goose", "goose", &["acp"], &[]),
        ("kimi", "kimi", &["acp"], &[]),
        (
            "cursor",
            "cursor-agent",
            &["acp"],
            &["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
        ),
    ];

    #[test]
    fn builtin_descriptors_load_validate_and_ask_before_secrets() {
        let shipped = builtin_acp_descriptors();
        assert_eq!(
            shipped.len(),
            BUILTIN_DESCRIPTORS.len(),
            "every shipped document must parse and validate"
        );
        assert_eq!(shipped.len(), BUILTIN_CATALOG.len());
        let mut fingerprints = Vec::new();
        for (descriptor, (id, program, args, secrets)) in shipped.iter().zip(BUILTIN_CATALOG) {
            assert_eq!(descriptor.id.as_str(), id);
            assert_eq!(descriptor.validate(), Ok(()), "{id}");
            assert_eq!(descriptor.command.program, program, "{id}");
            assert_eq!(descriptor.command.args, args, "{id}");
            assert_eq!(descriptor.secret_environment(), secrets, "{id}");
            assert_eq!(descriptor.version.args, ["--version"], "{id}");
            assert!(
                descriptor.version.verified.is_none(),
                "{id}: no range, so an unlisted version is never refused"
            );
            for proxy in ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] {
                assert!(
                    descriptor.environment.iter().any(|name| name == proxy),
                    "{id}: {proxy}"
                );
            }
            assert!(
                descriptor.auth_hint.is_some() && descriptor.docs_url.is_some(),
                "{id}: a sign-in hint and a documentation link"
            );
            // Never the whole environment, and nothing that changes how the
            // bridge or the loader runs.
            assert!(
                !descriptor
                    .environment
                    .iter()
                    .any(|name| denied_environment(name)),
                "{id}"
            );
            // The fingerprint is stable, and the document round trips.
            assert_eq!(descriptor.fingerprint().len(), 64);
            assert!(!fingerprints.contains(&descriptor.fingerprint()), "{id}");
            fingerprints.push(descriptor.fingerprint());
            let text = serde_json::to_string(descriptor).expect("json");
            assert_eq!(parse_acp_descriptor(&text).as_ref(), Ok(descriptor), "{id}");
        }
        // Codex and Claude Code have their own adapters; a second wrapper
        // (Claude's would bypass the subscription-only rule) is not shipped.
        assert!(!shipped.iter().any(|descriptor| {
            ["codex", "codex-acp", "claude", "claude-acp", "claude-code"]
                .contains(&descriptor.id.as_str())
        }));
        // Any change to a descriptor is a new fingerprint (a new decision).
        let gemini = descriptor();
        assert_eq!(gemini.fingerprint(), descriptor().fingerprint());
        let mut changed = gemini.clone();
        changed.command.args.push("--other".into());
        assert_ne!(changed.fingerprint(), gemini.fingerprint());
        // The shipped Gemini descriptor starts the current flag, not the
        // deprecated `--experimental-acp`.
        assert_eq!(gemini.command.args, ["--acp"]);
    }

    /// The shipped documents are the shared golden fixtures of the UI lab and
    /// the contract tests; none of them may drift from the typed shape.
    #[test]
    fn builtin_fixtures_are_exactly_the_shipped_descriptors() {
        for descriptor in builtin_acp_descriptors() {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../contracts/fixtures/acp-descriptors/valid-builtin-{}.json",
                descriptor.id
            ));
            let golden = std::fs::read_to_string(&path).expect("golden fixture");
            assert_eq!(
                serde_json::to_value(&descriptor).expect("json"),
                serde_json::from_str::<serde_json::Value>(&golden).expect("golden json"),
                "{}",
                descriptor.id
            );
        }
    }

    #[test]
    fn descriptor_rules_reject_unsafe_or_malformed_values() {
        let check = |change: &dyn Fn(&mut AcpAgentDescriptor)| {
            let mut value = descriptor();
            change(&mut value);
            value.validate()
        };
        use AcpDescriptorError::*;
        type Change = Box<dyn Fn(&mut AcpAgentDescriptor)>;
        let cases: Vec<(AcpDescriptorError, Change)> = vec![
            (UnsupportedSchema, Box::new(|d| d.schema_version = 2)),
            (DisplayName, Box::new(|d| d.display_name = String::new())),
            (DisplayName, Box::new(|d| d.display_name = " Gemini".into())),
            (DisplayName, Box::new(|d| d.display_name = "x".repeat(65))),
            (
                Program,
                Box::new(|d| d.command.program = "bin/gemini".into()),
            ),
            (Program, Box::new(|d| d.command.program = "..".into())),
            (
                Program,
                Box::new(|d| d.command.program = "gemini --acp".into()),
            ),
            (
                Program,
                Box::new(|d| d.command.program = "\"gemini\"".into()),
            ),
            (
                Arguments,
                Box::new(|d| d.command.args = vec!["a\nb".into()]),
            ),
            (
                Arguments,
                Box::new(|d| d.command.args = vec![String::new()]),
            ),
            (
                Arguments,
                Box::new(|d| d.command.args = vec!["x".into(); 33]),
            ),
            (VersionArguments, Box::new(|d| d.version.args.clear())),
            (
                VersionPattern,
                Box::new(|d| d.version.pattern = Some("(".into())),
            ),
            (
                VerifiedRange,
                Box::new(|d| {
                    d.version.verified = Some(AcpVerifiedVersions {
                        minimum: "1.0.0".into(),
                        ceiling: "1.0.0".into(),
                    });
                }),
            ),
            (
                VerifiedRange,
                Box::new(|d| {
                    d.version.verified = Some(AcpVerifiedVersions {
                        minimum: "1.0".into(),
                        ceiling: "2.0.0".into(),
                    });
                }),
            ),
            (
                EnvironmentName,
                Box::new(|d| d.environment = vec!["1ABC".into()]),
            ),
            (
                EnvironmentName,
                Box::new(|d| d.environment = vec!["A-B".into()]),
            ),
            (
                EnvironmentName,
                Box::new(|d| {
                    d.environment = vec!["Api_Key".into(), "API_KEY".into()];
                }),
            ),
            (
                EnvironmentDenied,
                Box::new(|d| d.environment = vec!["NODE_OPTIONS".into()]),
            ),
            (
                EnvironmentDenied,
                Box::new(|d| d.environment = vec!["piui_agent_api_token".into()]),
            ),
            (AuthHint, Box::new(|d| d.auth_hint = Some("x".repeat(401)))),
            (
                DocsUrl,
                Box::new(|d| d.docs_url = Some("http://example.com".into())),
            ),
            (DocsUrl, Box::new(|d| d.docs_url = Some("https://".into()))),
            (
                CapabilityOverride,
                Box::new(|d| d.capabilities.load_session = Some(true)),
            ),
        ];
        for (expected, change) in cases {
            assert_eq!(check(change.as_ref()), Err(expected), "{expected:?}");
        }
        assert_eq!(
            check(&|d| d.capabilities = AcpCapabilityOverrides {
                load_session: Some(false),
                models: Some(false),
                modes: Some(false),
                mcp_http: Some(false),
            }),
            Ok(())
        );
        assert_eq!(
            check(&|d| d.command.program = "/opt/agent/bin/agent".into()).is_ok(),
            cfg!(unix)
        );
        assert!(
            check(&|d| d.command.program = "C:\\agents\\agent.exe".into()).is_ok() || cfg!(unix)
        );
    }

    #[test]
    fn parsing_is_strict_about_shape_size_and_version() {
        let text = serde_json::to_string(&descriptor()).expect("json");
        assert_eq!(
            parse_acp_descriptor("{"),
            Err(AcpDescriptorError::Malformed)
        );
        assert_eq!(
            parse_acp_descriptor(&text.replacen("\"schemaVersion\":1", "\"schemaVersion\":2", 1)),
            Err(AcpDescriptorError::UnsupportedSchema)
        );
        assert_eq!(
            parse_acp_descriptor(&text.replacen('{', "{\"shell\":\"cmd\",", 1)),
            Err(AcpDescriptorError::Malformed),
            "unknown fields are refused, never dropped"
        );
        assert_eq!(
            parse_acp_descriptor(&text.replacen("\"id\":\"gemini-cli\"", "\"id\":\"Gemini\"", 1)),
            Err(AcpDescriptorError::Malformed)
        );
        assert_eq!(
            parse_acp_descriptor(&format!("{text}{}", " ".repeat(MAX_DESCRIPTOR_BYTES))),
            Err(AcpDescriptorError::TooLarge)
        );
    }

    #[test]
    fn descriptor_fixtures_match_the_schema_rules() {
        let directory =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/fixtures/acp-descriptors");
        let mut seen = 0;
        for entry in std::fs::read_dir(directory).expect("fixture directory") {
            let path = entry.expect("fixture").path();
            let name = path
                .file_name()
                .and_then(OsStr::to_str)
                .expect("fixture name")
                .to_owned();
            let text = std::fs::read_to_string(&path).expect("fixture text");
            let parsed = parse_acp_descriptor(&text);
            if name.starts_with("valid-") {
                assert!(parsed.is_ok(), "{name}: {parsed:?}");
            } else {
                assert!(parsed.is_err(), "{name} must be rejected");
            }
            seen += 1;
        }
        assert!(seen >= 6, "fixtures cover valid and invalid descriptors");
    }

    #[test]
    fn secret_like_names_need_confirmation() {
        for name in [
            "GEMINI_API_KEY",
            "OPENAI_API_KEY",
            "GITHUB_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
            "DB_PASSWORD",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "x_auth_header",
        ] {
            assert!(secret_like_environment(name), "{name}");
        }
        for name in ["HTTPS_PROXY", "GOOGLE_CLOUD_PROJECT", "LANG", "NO_PROXY"] {
            assert!(!secret_like_environment(name), "{name}");
        }
    }

    #[test]
    fn environment_keeps_only_base_and_allowed_names() {
        let host: Vec<(OsString, OsString)> = [
            ("PATH", "/bin"),
            ("HOME", "/home/user"),
            ("GEMINI_API_KEY", "secret-value"),
            ("OPENAI_API_KEY", "other-secret"),
            ("PIUI_AGENT_API_TOKEN", "operator"),
            ("NODE_OPTIONS", "--require evil.js"),
            ("GOOGLE_CLOUD_PROJECT", "project"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect();
        let names = |environment: Vec<(OsString, OsString)>| {
            environment
                .into_iter()
                .map(|(name, _)| name.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(acp_environment(&host, &[])), ["PATH", "HOME"]);
        assert_eq!(
            names(acp_environment(
                &host,
                &["GOOGLE_CLOUD_PROJECT".into(), "GEMINI_API_KEY".into()]
            )),
            ["PATH", "HOME", "GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"]
        );
        // Denied names never pass, even when a descriptor lists them.
        assert_eq!(
            names(acp_environment(&host, &["NODE_OPTIONS".into()])),
            ["PATH", "HOME"]
        );
        if cfg!(windows) {
            let lower = vec![(OsString::from("path"), OsString::from("C:\\bin"))];
            assert_eq!(names(acp_environment(&lower, &[])), ["path"]);
        }
    }

    #[test]
    fn version_reports_follow_the_verified_range() {
        let mut gemini = descriptor();
        let report = |d: &AcpAgentDescriptor, output: Option<&str>| version_report(d, output);
        assert_eq!(
            report(&gemini, Some("0.39.1\n")),
            AcpVersionReport {
                version: Some("0.39.1".into()),
                status: AcpVersionStatus::NoVerifiedRange
            }
        );
        assert_eq!(report(&gemini, None).status, AcpVersionStatus::ProbeFailed);
        assert_eq!(
            report(&gemini, Some("no version here")).status,
            AcpVersionStatus::Unrecognized
        );
        gemini.version.verified = Some(AcpVerifiedVersions {
            minimum: "0.30.0".into(),
            ceiling: "0.40.0".into(),
        });
        for (output, status) in [
            ("gemini 0.39.1", AcpVersionStatus::Verified),
            ("0.40.0", AcpVersionStatus::Newer),
            ("0.40.0-nightly.1", AcpVersionStatus::Newer),
            ("0.29.9", AcpVersionStatus::Older),
            ("0.30.0-preview.2", AcpVersionStatus::Older),
        ] {
            assert_eq!(report(&gemini, Some(output)).status, status, "{output}");
        }
        gemini.version.pattern = Some(r"agent v(\S+)".into());
        assert_eq!(
            report(&gemini, Some("agent v0.35.2 (build 7)"))
                .version
                .as_deref(),
            Some("0.35.2")
        );
        assert_eq!(
            report(&gemini, Some("agent vX")).status,
            AcpVersionStatus::Unrecognized
        );
    }

    #[test]
    fn programs_resolve_on_absolute_path_entries_only() {
        let root = fresh_directory("resolve");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        let name = if cfg!(windows) { "agent.exe" } else { "agent" };
        let file = bin.join(name);
        std::fs::write(&file, b"binary").expect("fake executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
                .expect("executable bit");
        }
        let spec = AcpCommandSpec {
            program: "agent".into(),
            args: vec!["--acp".into()],
        };
        let path =
            std::env::join_paths([PathBuf::from("relative-bin"), bin.clone()]).expect("path value");
        let resolved = resolve_acp_command_in(&spec, Some(&path)).expect("resolved");
        assert_eq!(resolved.program, process_directory(&file));
        assert_eq!(resolved.args, ["--acp"]);
        assert_eq!(
            resolve_acp_command_in(&spec, Some(OsStr::new("relative-bin"))),
            Err(AcpResolveError::NotFound)
        );
        assert_eq!(
            resolve_acp_command_in(&spec, None),
            Err(AcpResolveError::NotFound)
        );
        let absolute = AcpCommandSpec {
            program: root.join("missing").to_string_lossy().into_owned(),
            args: Vec::new(),
        };
        assert_eq!(
            resolve_acp_command_in(&absolute, None),
            Err(AcpResolveError::Missing)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn npm_and_pnpm_cmd_shims_start_their_node_script_without_a_shell() {
        let root = fresh_directory("shim");
        let npm = root.join("npm");
        let script = npm.join("node_modules/@lab/agent/dist/index.js");
        std::fs::create_dir_all(script.parent().expect("parent")).expect("package");
        std::fs::write(&script, b"console.log('0.1.0')").expect("script");
        std::fs::write(
            npm.join("agent.cmd"),
            "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@lab\\agent\\dist\\index.js\" %*\r\n",
        )
        .expect("npm shim");
        let spec = AcpCommandSpec {
            program: "agent".into(),
            args: vec!["--experimental-acp".into()],
        };
        let path = std::env::join_paths([npm.clone()]).expect("path");
        match resolve_acp_command_in(&spec, Some(&path)) {
            Ok(resolved) => {
                assert!(
                    resolved
                        .program
                        .to_string_lossy()
                        .to_ascii_lowercase()
                        .ends_with("node.exe")
                );
                assert_eq!(resolved.args[1..], ["--experimental-acp".to_owned()]);
                assert_eq!(
                    PathBuf::from(&resolved.args[0]),
                    process_directory(&std::fs::canonicalize(&script).expect("script path"))
                );
            }
            // No Node on this machine: the shim is still recognised.
            Err(error) => assert_eq!(error, AcpResolveError::NodeUnavailable),
        }

        let pnpm = root.join("pnpm");
        let package = root.join("store/agent/cli.mjs");
        std::fs::create_dir_all(package.parent().expect("parent")).expect("store");
        std::fs::create_dir_all(&pnpm).expect("pnpm bin");
        std::fs::write(&package, b"export {}").expect("script");
        std::fs::write(pnpm.join("node.exe"), b"fake node").expect("node beside shim");
        std::fs::write(
            pnpm.join("agent.cmd"),
            "@SETLOCAL\r\n@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\..\\store\\agent\\cli.mjs\" %*\r\n) ELSE (\r\n  node  \"%~dp0\\..\\store\\agent\\cli.mjs\" %*\r\n)\r\n",
        )
        .expect("pnpm shim");
        let path = std::env::join_paths([pnpm.clone()]).expect("path");
        let resolved = resolve_acp_command_in(&spec, Some(&path)).expect("pnpm shim");
        assert_eq!(resolved.program, process_directory(&pnpm.join("node.exe")));
        assert_eq!(
            PathBuf::from(&resolved.args[0]),
            process_directory(&std::fs::canonicalize(&package).expect("package path"))
        );

        let other = root.join("other");
        std::fs::create_dir_all(&other).expect("other");
        std::fs::write(
            other.join("agent.cmd"),
            "@echo off\r\npowershell -File run.ps1 %*\r\n",
        )
        .expect("batch file");
        let path = std::env::join_paths([other]).expect("path");
        assert_eq!(
            resolve_acp_command_in(&spec, Some(&path)),
            Err(AcpResolveError::UnsupportedLauncher)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn version_probe_runs_contained_with_the_base_environment() {
        let Ok(node) = resolve_node() else {
            return;
        };
        let root = fresh_directory("probe");
        let script = root.join("agent.mjs");
        // The launch argument `--acp` must not reach the probe: an agent
        // such as `opencode acp` has no `acp --version`.
        std::fs::write(
            &script,
            "if (process.argv.includes('--acp')) { process.exit(5); } if (process.argv.includes('--version')) { console.log(process.env.GEMINI_API_KEY ? 'leaked' : 'lab-agent 1.2.3'); } else { process.exit(3); }",
        )
        .expect("script");
        let command = node_command(node, script.clone(), &["--acp".into()]);
        let mut agent = descriptor();
        agent.version.verified = Some(AcpVerifiedVersions {
            minimum: "1.0.0".into(),
            ceiling: "2.0.0".into(),
        });
        let report = probe_acp_version(&agent, &command, true);
        assert_eq!(
            report,
            AcpVersionReport {
                version: Some("1.2.3".into()),
                status: AcpVersionStatus::Verified
            }
        );
        // A descriptor that runs its script through `node` itself probes the
        // script, not Node, so the declared minimum is still enforced.
        let direct = executable_command(
            command.program.clone(),
            &[script.to_string_lossy().into_owned(), "--acp".into()],
        );
        assert_eq!(direct.program, command.program);
        assert_eq!(
            probe_acp_version(&agent, &direct, true),
            AcpVersionReport {
                version: Some("1.2.3".into()),
                status: AcpVersionStatus::Verified
            }
        );
        // A failing version command is reported, never guessed.
        agent.version.args = vec!["--other".into()];
        assert_eq!(
            probe_acp_version(&agent, &command, true).status,
            AcpVersionStatus::ProbeFailed
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn version_probes_use_the_launcher_and_never_the_launch_arguments() {
        let node = PathBuf::from("node");
        let script = PathBuf::from("agent.mjs");
        let shimmed = node_command(node, script, &["acp".into()]);
        assert_eq!(shimmed.args, ["agent.mjs", "acp"]);
        assert_eq!(
            shimmed.version_args(&["--version".into()]),
            ["agent.mjs", "--version"],
            "the Node script stays, the launch arguments go"
        );
        let direct = executable_command(PathBuf::from("opencode"), &["acp".into()]);
        assert_eq!(direct.args, ["acp"]);
        assert_eq!(direct.version_args(&["--version".into()]), ["--version"]);
        assert_eq!(
            AcpResolvedCommand::test_command(PathBuf::from("x"), vec!["--acp".into()])
                .version_args(&["-v".into()]),
            ["-v"]
        );
    }

    #[test]
    fn a_probe_keeps_the_script_entrypoint_a_descriptor_starts() {
        let version = ["--version".to_owned()];
        let probe = |program: &str, args: &[&str]| {
            let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
            executable_command(PathBuf::from(program), &args).version_args(&version)
        };
        // `node agent.mjs` probes the agent, not Node itself.
        assert_eq!(
            probe("node.exe", &["agent.mjs"]),
            ["agent.mjs", "--version"]
        );
        // Whatever follows the entrypoint (a subcommand, a flag) is dropped;
        // what precedes it (Node options) stays.
        assert_eq!(
            probe("node", &["--no-warnings", "agent.mjs", "acp", "--acp"]),
            ["--no-warnings", "agent.mjs", "--version"]
        );
        assert_eq!(
            probe("node", &["agent.mjs", "--acp"]),
            ["agent.mjs", "--version"],
            "a script followed by a flag keeps the script only"
        );
        // A path separator or a known script extension names an entrypoint.
        assert_eq!(
            probe("python", &["tools\\agent", "serve"]),
            ["tools\\agent", "--version"]
        );
        assert_eq!(probe("python", &["a/b", "serve"]), ["a/b", "--version"]);
        assert_eq!(
            probe("python", &["run.PY", "serve"]),
            ["run.PY", "--version"]
        );
        assert_eq!(
            probe("deno", &["main.ts", "--acp"]),
            ["main.ts", "--version"]
        );
        // An option's path value is not an entrypoint.
        assert_eq!(
            probe("node", &["agent.mjs", "acp", "--config", "cfg/agent.json"]),
            ["agent.mjs", "--version"]
        );
        assert_eq!(
            probe("agent", &["serve", "--config", "cfg/agent"]),
            ["--version"]
        );
        // Subcommands and flags are not entrypoints, even with a path value.
        assert_eq!(probe("opencode", &["acp"]), ["--version"]);
        assert_eq!(probe("gemini", &["--acp"]), ["--version"]);
        assert_eq!(
            probe("agent", &["--config=/etc/agent.json", "acp"]),
            ["--version"]
        );
        // The Node script behind a shim stays first, then the descriptor's own.
        let shimmed = node_command(
            PathBuf::from("node"),
            PathBuf::from("cli.mjs"),
            &["--cfg".into(), "wrapper.js".into(), "--acp".into()],
        );
        assert_eq!(
            shimmed.version_args(&version),
            ["cli.mjs", "--cfg", "wrapper.js", "--version"]
        );
        // Every shipped agent keeps probing `program --version`.
        for agent in builtin_acp_descriptors() {
            let command =
                executable_command(PathBuf::from(&agent.command.program), &agent.command.args);
            assert_eq!(
                command.version_args(&agent.version.args),
                agent.version.args,
                "{}",
                agent.id.as_str()
            );
        }
    }

    fn write_shim(directory: &Path, name: &str, target: &str) -> PathBuf {
        let shim = directory.join(name);
        std::fs::write(
            &shim,
            format!(
                "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n{target}\r\n"
            ),
        )
        .expect("shim");
        shim
    }

    fn write_file(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("directory");
        std::fs::write(path, b"x").expect("file");
    }

    fn canonical(path: &Path) -> PathBuf {
        process_directory(&std::fs::canonicalize(path).expect("canonical path"))
    }

    #[test]
    fn a_shim_that_names_one_native_executable_resolves_to_it() {
        let root = fresh_directory("shim-exe");
        let npm = root.join("npm");
        let exe = npm.join("node_modules/opencode-ai/bin/opencode.exe");
        write_file(&exe);
        // The real `opencode.cmd` of the npm package `opencode-ai`.
        let shim = write_shim(
            &npm,
            "opencode.cmd",
            "\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\"   %*",
        );
        assert_eq!(
            shim_target(&shim),
            Some(ShimTarget::Executable(canonical(&exe)))
        );
        // pnpm spells the directory `%~dp0` and may climb out of it.
        let pnpm = root.join("pnpm");
        let store = root.join("store/opencode.exe");
        write_file(&store);
        std::fs::create_dir_all(&pnpm).expect("pnpm bin");
        let shim = write_shim(
            &pnpm,
            "opencode.cmd",
            "\"%~dp0\\..\\store\\opencode.exe\" %*",
        );
        assert_eq!(
            shim_target(&shim),
            Some(ShimTarget::Executable(canonical(&store)))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_native_shim_is_followed_only_when_it_passes_its_arguments_through() {
        let root = fresh_directory("shim-passthrough");
        let bin = root.join("bin");
        let exe = bin.join("node_modules/pkg/agent.exe");
        write_file(&exe);
        let target = |name: &str, line: &str| shim_target(&write_shim(&bin, name, line));
        let named = "\"%dp0%\\node_modules\\pkg\\agent.exe\"";
        // The npm passthrough form, with any blanks before `%*`.
        for (name, spacing) in [("one.cmd", " "), ("many.cmd", "   "), ("tab.cmd", "\t")] {
            assert_eq!(
                target(name, &format!("{named}{spacing}%*")),
                Some(ShimTarget::Executable(canonical(&exe))),
                "{name}"
            );
        }
        // Fixed arguments would be dropped by a direct start.
        for (name, line) in [
            ("fixed.cmd", format!("{named} --config locked.json %*")),
            ("quoted.cmd", format!("{named} \"locked.json\" %*")),
            ("after.cmd", format!("{named} %* --extra")),
            ("none.cmd", named.to_owned()),
            ("other.cmd", format!("{named} %1")),
            (
                "second.cmd",
                format!("{named} %* \"%dp0%\\node_modules\\pkg\\agent.exe\""),
            ),
        ] {
            assert_eq!(target(name, &line), None, "{name}: {line}");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn shim_targets_refuse_ambiguous_missing_and_unsafe_names() {
        let root = fresh_directory("shim-refuse");
        let bin = root.join("bin");
        write_file(&bin.join("node_modules/pkg/one.exe"));
        write_file(&bin.join("node_modules/pkg/two.exe"));
        write_file(&bin.join("node_modules/pkg/a.js"));
        write_file(&bin.join("node_modules/pkg/b.js"));
        write_file(&bin.join("node_modules/pkg/%EVIL%.exe"));
        let target = |name: &str, line: &str| shim_target(&write_shim(&bin, name, line));
        assert_eq!(
            target(
                "ambiguous.cmd",
                "\"%dp0%\\node_modules\\pkg\\one.exe\" %*\r\n\"%dp0%\\node_modules\\pkg\\two.exe\" %*"
            ),
            None,
            "two different executables"
        );
        assert_eq!(
            target(
                "scripts.cmd",
                "\"%dp0%\\node_modules\\pkg\\a.js\" %*\r\n\"%dp0%\\node_modules\\pkg\\b.js\" %*"
            ),
            None,
            "two different scripts"
        );
        assert_eq!(
            target("missing.cmd", "\"%dp0%\\node_modules\\pkg\\gone.exe\" %*"),
            None,
            "a missing target"
        );
        assert_eq!(
            target("percent.cmd", "\"%dp0%\\node_modules\\pkg\\%EVIL%.exe\" %*"),
            None,
            "a variable in the path"
        );
        assert_eq!(
            target("bang.cmd", "\"%dp0%\\node_modules\\pkg\\one!x.exe\" %*"),
            None,
            "delayed expansion in the path"
        );
        assert_eq!(
            target(
                "interpreter.cmd",
                "IF EXIST \"%dp0%\\node.exe\" (\"%dp0%\\node.exe\" %*)"
            ),
            None,
            "the interpreter probe is never a target"
        );
        assert_eq!(
            target("wrapper.cmd", "powershell -File run.ps1 %*"),
            None,
            "any other batch file needs a shell"
        );
        assert_eq!(
            target("absolute.cmd", "\"C:\\tools\\agent.exe\" %*"),
            None,
            "only targets relative to the shim are followed"
        );
        // A shim that names a script is a Node shim, whatever else it names.
        let node_shim = target(
            "node.cmd",
            "IF EXIST \"%dp0%\\node.exe\" (SET \"_prog=%dp0%\\node.exe\")\r\n\"%_prog%\" \"%dp0%\\node_modules\\pkg\\a.js\" \"%dp0%\\node_modules\\pkg\\one.exe\" %*",
        );
        assert_eq!(
            node_shim,
            Some(ShimTarget::Script(canonical(
                &bin.join("node_modules/pkg/a.js")
            )))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn shim_targets_allow_spaces_in_every_part_of_the_path() {
        let root = fresh_directory("shim-spaces");
        let bin = root.join("global npm");
        let exe = bin.join("node_modules/lab agent pkg/bin/lab agent.exe");
        write_file(&exe);
        let shim = write_shim(
            &bin,
            "lab-agent.cmd",
            "\"%dp0%\\node_modules\\lab agent pkg\\bin\\lab agent.exe\" %*",
        );
        assert_eq!(
            shim_target(&shim),
            Some(ShimTarget::Executable(canonical(&exe)))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn a_native_shim_resolves_without_node_and_later_path_entries_are_searched() {
        let root = fresh_directory("native-shim");
        let npm = root.join("npm");
        let exe = npm.join("node_modules/opencode-ai/bin/opencode.exe");
        write_file(&exe);
        write_shim(
            &npm,
            "opencode.cmd",
            "\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\"   %*",
        );
        let spec = AcpCommandSpec {
            program: "opencode".into(),
            args: vec!["acp".into()],
        };
        let path = std::env::join_paths([npm.clone()]).expect("path");
        let resolved = resolve_acp_command_in(&spec, Some(&path)).expect("native shim");
        assert_eq!(
            resolved.program,
            canonical(&exe),
            "not node.exe, not cmd.exe"
        );
        assert_eq!(resolved.args, ["acp"]);
        assert_eq!(resolved.version_args(&["--version".into()]), ["--version"]);

        // A user's wrapper in an earlier PATH entry does not hide the install.
        let wrapper = root.join("wrapper");
        std::fs::create_dir_all(&wrapper).expect("wrapper");
        std::fs::write(
            wrapper.join("opencode.cmd"),
            "@echo off\r\npowershell -File run.ps1 %*\r\n",
        )
        .expect("wrapper script");
        let path = std::env::join_paths([wrapper.clone(), npm.clone()]).expect("path");
        let resolved = resolve_acp_command_in(&spec, Some(&path)).expect("later entry");
        assert_eq!(resolved.program, canonical(&exe));
        // Without a supported installation the first failure is reported.
        let path = std::env::join_paths([wrapper]).expect("path");
        assert_eq!(
            resolve_acp_command_in(&spec, Some(&path)),
            Err(AcpResolveError::UnsupportedLauncher)
        );

        // A shim that fixes arguments of its own (`--config locked.json`) is
        // not the passthrough form: starting the executable directly would
        // lose them, so it is refused and a later PATH entry is searched.
        let locked = root.join("locked");
        write_file(&locked.join("node_modules/opencode-ai/bin/opencode.exe"));
        write_shim(
            &locked,
            "opencode.cmd",
            "\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\" --config locked.json %*",
        );
        let path = std::env::join_paths([locked.clone()]).expect("path");
        assert_eq!(
            resolve_acp_command_in(&spec, Some(&path)),
            Err(AcpResolveError::UnsupportedLauncher)
        );
        let path = std::env::join_paths([locked, npm.clone()]).expect("path");
        let resolved = resolve_acp_command_in(&spec, Some(&path)).expect("later entry");
        assert_eq!(resolved.program, canonical(&exe));
        let _ = std::fs::remove_dir_all(root);
    }
}
