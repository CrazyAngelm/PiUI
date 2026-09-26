//! `harness_registry_v1`: Settings → Harnesses (ADR-034).
//!
//! Lists every harness with its readiness, detected location, version and
//! verified range, and manages ACP agents: add a user descriptor, trust its
//! exact command line, confirm an unverified version or secret-like
//! environment names, remove it, and check again. Listing never probes;
//! checks run off the async executor and are refused in safe mode, like every
//! change. Credentials are never read: sign-in happens in each harness's own
//! flow and PiUI only shows hints.

use crate::acp_agents::{AcpAgentView, AgentSource, CommandLine, HarnessState, RegistryError};
use crate::state::HostState;
use piui_runtime::acp::AcpDescriptorError;
use piui_runtime::workspace_runtime::{
    AcpAgentId, CLAUDE_SIGN_IN_MESSAGE, HarnessAvailability, HarnessKind,
    builtin_verified_versions, probe_native_harnesses,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

pub(crate) const HARNESS_REGISTRY_PROTOCOL: u8 = 1;
pub(crate) const HARNESS_REGISTRY_EVENT: &str = "piui://harness-registry-v1";

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HarnessRegistryCommand {
    List {},
    Check {
        #[serde(default)]
        harness: Option<HarnessKind>,
    },
    Add {
        expected_revision: u64,
        descriptor: serde_json::Value,
    },
    Trust {
        expected_revision: u64,
        id: AcpAgentId,
        fingerprint: String,
        command_line: CommandLine,
    },
    ConfirmVersion {
        expected_revision: u64,
        id: AcpAgentId,
        version: String,
    },
    AllowSecrets {
        expected_revision: u64,
        id: AcpAgentId,
        fingerprint: String,
        names: Vec<String>,
    },
    Remove {
        expected_revision: u64,
        id: AcpAgentId,
    },
}

/// One harness row of Settings → Harnesses.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatusV1 {
    pub harness: HarnessKind,
    pub name: String,
    pub source: &'static str,
    pub state: HarnessState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_versions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sign_in_hint: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub auth_methods: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRegistryV1 {
    pub protocol: u8,
    pub revision: u64,
    pub safe_mode: bool,
    /// Discovery has run for every ACP agent in this host process.
    pub checked: bool,
    pub harnesses: Vec<HarnessStatusV1>,
    pub agents: Vec<AcpAgentView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRegistryError {
    pub code: &'static str,
    pub message: &'static str,
    pub recoverable: bool,
}

impl HarnessRegistryError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            recoverable: true,
        }
    }
}

fn descriptor_message(error: AcpDescriptorError) -> &'static str {
    match error {
        AcpDescriptorError::Malformed => {
            "The descriptor is not valid JSON or contains unknown fields."
        }
        AcpDescriptorError::TooLarge => "The descriptor is larger than 32 KiB.",
        AcpDescriptorError::UnsupportedSchema => {
            "Only ACP descriptor schema version 1 is supported."
        }
        AcpDescriptorError::DisplayName => {
            "The display name must be 1-64 characters without control characters."
        }
        AcpDescriptorError::Program => {
            "The program must be a file name found on PATH or an absolute path."
        }
        AcpDescriptorError::Arguments => {
            "Use at most 32 arguments of 1-512 characters without control characters."
        }
        AcpDescriptorError::VersionArguments => {
            "Use 1-8 version arguments of 1-512 characters without control characters."
        }
        AcpDescriptorError::VersionPattern => {
            "The version pattern must be a valid regular expression of at most 200 characters."
        }
        AcpDescriptorError::VerifiedRange => {
            "The verified range needs MAJOR.MINOR.PATCH versions with the minimum below the ceiling."
        }
        AcpDescriptorError::EnvironmentName => {
            "Environment variables must be at most 32 unique names of letters, digits and underscores."
        }
        AcpDescriptorError::EnvironmentDenied => {
            "This environment variable cannot be passed to an agent."
        }
        AcpDescriptorError::AuthHint => {
            "The sign-in hint must be at most 400 characters without control characters."
        }
        AcpDescriptorError::DocsUrl => {
            "The documentation link must be an https URL of at most 300 characters."
        }
        AcpDescriptorError::CapabilityOverride => {
            "A descriptor can only switch agent features off."
        }
    }
}

impl From<RegistryError> for HarnessRegistryError {
    fn from(error: RegistryError) -> Self {
        match error {
            RegistryError::Conflict => Self::new(
                "CONFLICT",
                "The harness list changed. Review it and try again.",
            ),
            RegistryError::Descriptor(error) => {
                Self::new("INVALID_DESCRIPTOR", descriptor_message(error))
            }
            RegistryError::Duplicate => {
                Self::new("DUPLICATE", "An agent with this ID already exists.")
            }
            RegistryError::NotFound => {
                Self::new("NOT_FOUND", "This agent is no longer registered.")
            }
            RegistryError::BuiltIn => Self::new(
                "BUILT_IN",
                "Agents that ship with PiUI cannot be removed or re-trusted.",
            ),
            RegistryError::TrustChanged => Self::new(
                "TRUST_CHANGED",
                "The agent or its command line changed since you reviewed it. Review it again.",
            ),
            RegistryError::NotInstalled => Self::new(
                "NOT_INSTALLED",
                "The program was not found, so there is nothing to trust yet.",
            ),
            RegistryError::NothingToConfirm => Self::new(
                "NOTHING_TO_CONFIRM",
                "There is nothing to confirm for this agent right now. Check it again.",
            ),
            RegistryError::Limit => Self::new(
                "LIMIT",
                "Remove an agent before adding another (32 at most).",
            ),
            RegistryError::PluginOwned => Self::new(
                "PLUGIN_OWNED",
                "This agent comes from a plugin. Disable or remove the plugin in Settings → Plugins.",
            ),
            RegistryError::Io => Self::new("IO_ERROR", "PiUI could not save the harness list."),
        }
    }
}

fn safe_mode_error() -> HarnessRegistryError {
    HarnessRegistryError::new(
        "SAFE_MODE",
        "Harness checks and changes are disabled in safe mode.",
    )
}

/// Fixed sign-in guidance of the built-in harnesses. PiUI never signs in.
fn builtin_sign_in_hint(kind: HarnessKind) -> Option<&'static str> {
    match kind {
        HarnessKind::ClaudeCode => Some(
            "Claude Code runs only on your Claude subscription: run `claude` in a terminal and use /login.",
        ),
        HarnessKind::Codex => {
            Some("Sign in with Codex's own flow: run `codex login` in a terminal.")
        }
        _ => None,
    }
}

fn builtin_state(
    kind: HarnessKind,
    status: HarnessAvailability,
    reason: Option<&str>,
) -> HarnessState {
    match status {
        HarnessAvailability::Available
            if kind == HarnessKind::ClaudeCode && reason == Some(CLAUDE_SIGN_IN_MESSAGE) =>
        {
            HarnessState::SignInRequired
        }
        HarnessAvailability::Available => HarnessState::Ready,
        HarnessAvailability::Unverified => HarnessState::UnsupportedVersion,
        HarnessAvailability::Unavailable => HarnessState::NotInstalled,
    }
}

fn acp_status(view: &AcpAgentView) -> HarnessStatusV1 {
    HarnessStatusV1 {
        harness: HarnessKind::Acp(view.descriptor.id),
        name: view.descriptor.display_name.clone(),
        source: match view.source {
            AgentSource::BuiltIn => "acp-built-in",
            AgentSource::User => "acp-user",
            AgentSource::Plugin => "acp-plugin",
        },
        state: view.state,
        location: view.command_line.as_ref().map(|line| {
            line.args
                .first()
                .filter(|arg| std::path::Path::new(arg).is_absolute())
                .cloned()
                .unwrap_or_else(|| line.program.clone())
        }),
        version: view.version.clone(),
        verified_versions: view
            .descriptor
            .version
            .verified
            .as_ref()
            .map(|range| format!("{} – <{}", range.minimum, range.ceiling)),
        reason: view.reason.map(str::to_owned),
        sign_in_hint: view.descriptor.auth_hint.clone(),
        auth_methods: view.auth_methods.clone(),
        docs_url: view.descriptor.docs_url.clone(),
    }
}

/// Builds the registry view. Built-in discovery is filesystem-only (plus the
/// cached `claude --version`), so it runs on a blocking thread.
async fn registry_view(host: &HostState) -> Result<HarnessRegistryV1, HarnessRegistryError> {
    let acp = host.workspace.acp_agents().clone();
    let builtin = tauri::async_runtime::spawn_blocking(probe_native_harnesses)
        .await
        .map_err(|_| RegistryError::Io)?;
    let agents = acp.views();
    let harnesses = builtin
        .into_iter()
        .map(|summary| HarnessStatusV1 {
            state: builtin_state(summary.kind, summary.status, summary.reason.as_deref()),
            harness: summary.kind,
            name: summary.name,
            source: "built-in",
            location: summary
                .location
                .map(|path| path.to_string_lossy().into_owned()),
            version: summary.version,
            verified_versions: builtin_verified_versions(summary.kind).map(str::to_owned),
            reason: summary.reason,
            sign_in_hint: builtin_sign_in_hint(summary.kind).map(str::to_owned),
            auth_methods: Vec::new(),
            docs_url: None,
        })
        .chain(agents.iter().map(acp_status))
        .collect();
    Ok(HarnessRegistryV1 {
        protocol: HARNESS_REGISTRY_PROTOCOL,
        revision: acp.revision(),
        safe_mode: host.safe_mode,
        checked: acp.checked(),
        harnesses,
        agents,
    })
}

/// Runs discovery off the async executor and tells every window.
async fn check_agents<R: Runtime>(
    app: &AppHandle<R>,
    only: Option<AcpAgentId>,
    force: bool,
) -> Result<(), HarnessRegistryError> {
    let acp = app.state::<HostState>().workspace.acp_agents().clone();
    tauri::async_runtime::spawn_blocking(move || acp.check(only, force))
        .await
        .map_err(|_| HarnessRegistryError::from(RegistryError::Io))?;
    emit_changed(app);
    Ok(())
}

fn emit_changed<R: Runtime>(app: &AppHandle<R>) {
    let revision = app.state::<HostState>().workspace.acp_agents().revision();
    let _ = app.emit(
        HARNESS_REGISTRY_EVENT,
        serde_json::json!({ "protocol": HARNESS_REGISTRY_PROTOCOL, "revision": revision }),
    );
}

/// First discovery after start-up, off the first-paint path. Never in safe
/// mode, where no agent program runs.
pub(crate) fn start_background_discovery<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let _ = check_agents(&app, None, false).await;
    });
}

#[tauri::command]
pub async fn harness_registry_v1(
    app: AppHandle,
    state: State<'_, HostState>,
    command: HarnessRegistryCommand,
) -> Result<HarnessRegistryV1, HarnessRegistryError> {
    let host = state.inner();
    if !matches!(command, HarnessRegistryCommand::List {}) && host.safe_mode {
        return Err(safe_mode_error());
    }
    let acp = host.workspace.acp_agents().clone();
    let changed = match command {
        HarnessRegistryCommand::List {} => false,
        HarnessRegistryCommand::Check { harness } => {
            let only = harness.and_then(HarnessKind::acp_agent);
            if harness.is_some_and(|kind| kind.acp_agent().is_none()) {
                // Built-in discovery is recomputed by every list.
                false
            } else {
                check_agents(&app, only, true).await?;
                false
            }
        }
        HarnessRegistryCommand::Add {
            expected_revision,
            descriptor,
        } => {
            tauri::async_runtime::spawn_blocking(move || acp.add(expected_revision, &descriptor))
                .await
                .map_err(|_| HarnessRegistryError::from(RegistryError::Io))??;
            true
        }
        HarnessRegistryCommand::Trust {
            expected_revision,
            id,
            fingerprint,
            command_line,
        } => {
            tauri::async_runtime::spawn_blocking(move || {
                acp.trust(expected_revision, id, &fingerprint, &command_line)
            })
            .await
            .map_err(|_| HarnessRegistryError::from(RegistryError::Io))??;
            true
        }
        HarnessRegistryCommand::ConfirmVersion {
            expected_revision,
            id,
            version,
        } => {
            acp.confirm_version(expected_revision, id, &version)?;
            true
        }
        HarnessRegistryCommand::AllowSecrets {
            expected_revision,
            id,
            fingerprint,
            names,
        } => {
            acp.allow_secrets(expected_revision, id, &fingerprint, &names)?;
            true
        }
        HarnessRegistryCommand::Remove {
            expected_revision,
            id,
        } => {
            acp.remove(expected_revision, id)?;
            true
        }
    };
    if changed {
        emit_changed(&app);
    }
    registry_view(host).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_strict_tagged_unions() {
        let add: HarnessRegistryCommand = serde_json::from_value(serde_json::json!({
            "type": "add", "expectedRevision": 0,
            "descriptor": { "schemaVersion": 1 }
        }))
        .expect("add");
        assert!(matches!(
            add,
            HarnessRegistryCommand::Add {
                expected_revision: 0,
                ..
            }
        ));
        let trust: HarnessRegistryCommand = serde_json::from_value(serde_json::json!({
            "type": "trust", "expectedRevision": 2, "id": "lab-agent", "fingerprint": "f",
            "commandLine": { "program": "C:/lab/agent.exe", "args": ["--acp"] }
        }))
        .expect("trust");
        assert!(matches!(trust, HarnessRegistryCommand::Trust { .. }));
        for invalid in [
            serde_json::json!({ "type": "list", "extra": true }),
            serde_json::json!({ "type": "remove", "expectedRevision": 1, "id": "Bad_Id" }),
            serde_json::json!({ "type": "check", "harness": "acp:" }),
            serde_json::json!({ "type": "evaluate", "code": "1" }),
        ] {
            assert!(
                serde_json::from_value::<HarnessRegistryCommand>(invalid.clone()).is_err(),
                "{invalid}"
            );
        }
        let check: HarnessRegistryCommand = serde_json::from_value(
            serde_json::json!({ "type": "check", "harness": "acp:gemini-cli" }),
        )
        .expect("check");
        assert!(matches!(
            check,
            HarnessRegistryCommand::Check {
                harness: Some(HarnessKind::Acp(_))
            }
        ));
    }

    /// The registry contract is golden JSON shared with the TS fixture
    /// (`contracts/fixtures/harness-registry-v1.{json,ts}`).
    #[test]
    fn registry_view_matches_the_shared_contract_fixture() {
        let root =
            std::env::temp_dir().join(format!("piui-registry-fixture-{}", uuid::Uuid::new_v4()));
        let registry = crate::acp_agents::AcpAgents::open(&root).expect("registry");
        let agents = registry.views();
        let view = HarnessRegistryV1 {
            protocol: HARNESS_REGISTRY_PROTOCOL,
            revision: registry.revision(),
            safe_mode: false,
            checked: registry.checked(),
            harnesses: std::iter::once(HarnessStatusV1 {
                harness: HarnessKind::Codex,
                name: "Codex".into(),
                source: "built-in",
                state: HarnessState::Ready,
                location: Some(
                    "C:/Users/example/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js"
                        .into(),
                ),
                version: Some("0.157.1".into()),
                verified_versions: builtin_verified_versions(HarnessKind::Codex).map(str::to_owned),
                reason: None,
                sign_in_hint: builtin_sign_in_hint(HarnessKind::Codex).map(str::to_owned),
                auth_methods: Vec::new(),
                docs_url: None,
            })
            .chain(agents.iter().map(acp_status))
            .collect(),
            agents,
        };
        let actual = serde_json::to_value(&view).expect("json");
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/fixtures/harness-registry-v1.json"
        ))
        .expect("fixture json");
        assert_eq!(
            actual,
            fixture,
            "update the fixture with:\n{}",
            serde_json::to_string_pretty(&actual).unwrap_or_default()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn built_in_states_map_availability_and_claude_sign_in() {
        assert_eq!(
            builtin_state(HarnessKind::Codex, HarnessAvailability::Available, None),
            HarnessState::Ready
        );
        assert_eq!(
            builtin_state(
                HarnessKind::ClaudeCode,
                HarnessAvailability::Available,
                Some(CLAUDE_SIGN_IN_MESSAGE)
            ),
            HarnessState::SignInRequired
        );
        assert_eq!(
            builtin_state(
                HarnessKind::Hermes,
                HarnessAvailability::Unverified,
                Some("x")
            ),
            HarnessState::UnsupportedVersion
        );
        assert_eq!(
            builtin_state(HarnessKind::Pi, HarnessAvailability::Unavailable, None),
            HarnessState::NotInstalled
        );
        assert!(
            builtin_sign_in_hint(HarnessKind::ClaudeCode)
                .is_some_and(|hint| hint.contains("/login"))
        );
    }
}
