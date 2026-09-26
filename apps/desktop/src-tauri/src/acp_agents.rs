//! Host registry of ACP agents (ADR-034).
//!
//! It combines the descriptors shipped with PiUI, the descriptors the user
//! added, and the user's explicit decisions: trust of the exact command line a
//! user descriptor starts, confirmation of a version PiUI has not verified,
//! and confirmation of secret-like environment names. Decisions bind to the
//! descriptor fingerprint, so any change needs a new decision. The document is
//! written as complete create-only generations; a failed write leaves the
//! previous one untouched.
//!
//! Discovery (PATH resolution and a contained `--version` probe) runs outside
//! the lock and never for an untrusted user descriptor: trust comes before any
//! execution. Values of environment variables are never read or stored here;
//! only names are.

use piui_runtime::acp::{
    AcpAgentDescriptor, AcpDescriptorError, AcpLaunch, AcpResolveError, AcpResolvedCommand,
    AcpVersionReport, AcpVersionStatus, builtin_acp_descriptors, parse_acp_descriptor,
    probe_acp_version, resolve_acp_command, secret_like_environment,
};
use piui_runtime::workspace_runtime::{
    AcpAgentId, HarnessAvailability, HarnessCapabilities, NativeCatalogModel, NativeRuntimeError,
    WorkspaceModel, acp_harness_capabilities,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

const DOCUMENT_VERSION: u32 = 1;
const DIRECTORY: &str = "acp-agents-v1";
const GENERATION_PREFIX: &str = "registry-";
const GENERATION_SUFFIX: &str = ".json";
/// Most user descriptors kept at once.
pub(crate) const MAX_USER_AGENTS: usize = 32;
const MAX_REMEMBERED_MODELS: usize = 500;

/// The exact program and arguments a trust decision covers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommandLine {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandLine {
    fn of(command: &AcpResolvedCommand) -> Self {
        Self {
            program: command.program.to_string_lossy().into_owned(),
            args: command.args.clone(),
        }
    }
}

/// The user's decisions about one agent, bound to its descriptor fingerprint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Decision {
    id: AcpAgentId,
    fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trusted_command: Option<CommandLine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    confirmed_version: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    allowed_secrets: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u32,
    generation: u64,
    agents: Vec<AcpAgentDescriptor>,
    decisions: Vec<Decision>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            version: DOCUMENT_VERSION,
            generation: 0,
            agents: Vec::new(),
            decisions: Vec::new(),
        }
    }
}

/// Where an agent comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AgentSource {
    BuiltIn,
    User,
}

/// Readiness of one harness, as Settings → Harnesses shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HarnessState {
    Ready,
    Checking,
    NotInstalled,
    UnsupportedVersion,
    UnverifiedVersion,
    SignInRequired,
    Untrusted,
    Unavailable,
}

/// Why an ACP agent cannot start now. Messages are fixed locale keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AcpRefusal {
    Unknown,
    NotInstalled(AcpResolveError),
    Untrusted,
    UnsupportedVersion,
    VersionUnknown,
    VersionUnconfirmed,
}

impl AcpRefusal {
    pub(crate) const fn reason(self) -> &'static str {
        match self {
            Self::Unknown => "This agent is no longer registered in Settings → Harnesses.",
            Self::NotInstalled(AcpResolveError::NotFound) => {
                "The agent's program was not found on PATH."
            }
            Self::NotInstalled(AcpResolveError::Missing) => {
                "The agent's program path does not exist."
            }
            Self::NotInstalled(AcpResolveError::UnsupportedLauncher) => {
                "This launcher needs a shell, which PiUI never uses. Point the descriptor at the executable or the Node script."
            }
            Self::NotInstalled(AcpResolveError::NodeUnavailable) => {
                "Node.js is needed to start this agent but was not found."
            }
            Self::Untrusted => {
                "Review and trust this agent's command line in Settings → Harnesses."
            }
            Self::UnsupportedVersion => {
                "The installed version is older than the versions tested with PiUI."
            }
            Self::VersionUnknown => "The agent did not report a version PiUI can recognize.",
            Self::VersionUnconfirmed => {
                "PiUI has not verified this version. Confirm it in Settings → Harnesses to use it."
            }
        }
    }
}

struct Discovery {
    checked_at: String,
    command: Result<AcpResolvedCommand, AcpResolveError>,
    /// `None` until the agent may be executed (trusted or shipped).
    version: Option<AcpVersionReport>,
}

struct State {
    directory: PathBuf,
    document: Document,
    next_generation: u64,
    discovery: HashMap<AcpAgentId, Discovery>,
    /// Sign-in method names from the last start that the agent refused.
    sign_in: HashMap<AcpAgentId, Vec<String>>,
    /// Models the agent advertised in its last session in this host process.
    models: HashMap<AcpAgentId, Vec<WorkspaceModel>>,
}

/// One registered agent with its decisions and its latest discovery.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpAgentView {
    pub descriptor: AcpAgentDescriptor,
    pub source: AgentSource,
    pub fingerprint: String,
    pub state: HarnessState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// The exact command line PiUI starts, when the program resolves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_line: Option<CommandLine>,
    pub trusted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_status: Option<AcpVersionStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_version: Option<String>,
    /// Secret-like environment names that pass only after a confirmation.
    pub secret_environment: Vec<String>,
    pub allowed_secrets: Vec<String>,
    /// Sign-in method names the agent reported when it refused to start.
    pub auth_methods: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

#[derive(Debug)]
pub(crate) enum RegistryError {
    Conflict,
    Descriptor(AcpDescriptorError),
    Duplicate,
    NotFound,
    BuiltIn,
    TrustChanged,
    NotInstalled,
    NothingToConfirm,
    Limit,
    Io,
}

/// The ACP agent registry of one host process.
#[derive(Clone)]
pub(crate) struct AcpAgents {
    state: Arc<Mutex<State>>,
    builtins: Arc<Vec<AcpAgentDescriptor>>,
}

impl AcpAgents {
    pub(crate) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let directory = app_data_dir.join(DIRECTORY);
        fs::create_dir_all(&directory)?;
        let mut newest: Option<Document> = None;
        let mut next_generation = 0_u64;
        for entry in fs::read_dir(&directory)?.flatten() {
            let Some(generation) = generation_from_path(&entry.path()) else {
                continue;
            };
            next_generation = next_generation.max(generation);
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(document) = serde_json::from_slice::<Document>(&bytes) else {
                continue;
            };
            // A generation whose descriptors no longer validate is skipped,
            // never partially applied.
            if document.version != DOCUMENT_VERSION
                || document.generation != generation
                || document
                    .agents
                    .iter()
                    .any(|agent| agent.validate().is_err())
            {
                continue;
            }
            if newest
                .as_ref()
                .is_none_or(|current| document.generation > current.generation)
            {
                newest = Some(document);
            }
        }
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                directory,
                document: newest.unwrap_or_default(),
                next_generation,
                discovery: HashMap::new(),
                sign_in: HashMap::new(),
                models: HashMap::new(),
            })),
            builtins: Arc::new(builtin_acp_descriptors()),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, State>, RegistryError> {
        self.state.lock().map_err(|_| RegistryError::Io)
    }

    /// Current document generation, the revision mutations must name.
    pub(crate) fn revision(&self) -> u64 {
        self.lock().map_or(0, |state| state.document.generation)
    }

    fn descriptors(&self, state: &State) -> Vec<(AcpAgentDescriptor, AgentSource)> {
        self.builtins
            .iter()
            .cloned()
            .map(|descriptor| (descriptor, AgentSource::BuiltIn))
            .chain(
                state
                    .document
                    .agents
                    .iter()
                    .cloned()
                    .map(|descriptor| (descriptor, AgentSource::User)),
            )
            .collect()
    }

    fn find(&self, state: &State, id: AcpAgentId) -> Option<(AcpAgentDescriptor, AgentSource)> {
        self.descriptors(state)
            .into_iter()
            .find(|(descriptor, _)| descriptor.id == id)
    }

    /// Resolves every agent (filesystem only) and probes the version of each
    /// agent that may run: shipped or trusted. Blocking; call it off the
    /// async executor. `force` repeats cached version probes.
    pub(crate) fn check(&self, only: Option<AcpAgentId>, force: bool) {
        let Ok(state) = self.lock() else {
            return;
        };
        let targets = self
            .descriptors(&state)
            .into_iter()
            .filter(|(descriptor, _)| only.is_none_or(|id| id == descriptor.id))
            .map(|(descriptor, source)| {
                let decision = decision(&state, &descriptor).cloned();
                (descriptor, source, decision)
            })
            .collect::<Vec<_>>();
        drop(state);
        let results = targets
            .into_iter()
            .map(|(descriptor, source, decision)| {
                let command = resolve_acp_command(&descriptor.command);
                let version = command.as_ref().ok().and_then(|command| {
                    may_execute(source, decision.as_ref(), command)
                        .then(|| probe_acp_version(&descriptor, command, force))
                });
                (
                    descriptor.id,
                    Discovery {
                        checked_at: now_string(),
                        command,
                        version,
                    },
                )
            })
            .collect::<Vec<_>>();
        if let Ok(mut state) = self.lock() {
            for (id, discovery) in results {
                // "Check again" lets the next start ask the agent to sign in
                // again; only a start can tell whether the user did.
                if force {
                    state.sign_in.remove(&id);
                }
                state.discovery.insert(id, discovery);
            }
        }
    }

    /// Whether discovery has run for every registered agent.
    pub(crate) fn checked(&self) -> bool {
        self.lock().is_ok_and(|state| {
            self.descriptors(&state)
                .iter()
                .all(|(descriptor, _)| state.discovery.contains_key(&descriptor.id))
        })
    }

    pub(crate) fn views(&self) -> Vec<AcpAgentView> {
        let Ok(state) = self.lock() else {
            return Vec::new();
        };
        self.descriptors(&state)
            .into_iter()
            .map(|(descriptor, source)| view(&state, descriptor, source))
            .collect()
    }

    pub(crate) fn view(&self, id: AcpAgentId) -> Option<AcpAgentView> {
        self.views()
            .into_iter()
            .find(|view| view.descriptor.id == id)
    }

    /// Adds a validated user descriptor. It is untrusted: nothing runs until
    /// the user trusts its exact command line.
    pub(crate) fn add(
        &self,
        expected_revision: u64,
        descriptor: &serde_json::Value,
    ) -> Result<AcpAgentId, RegistryError> {
        let text = serde_json::to_string(descriptor)
            .map_err(|_| RegistryError::Descriptor(AcpDescriptorError::Malformed))?;
        let descriptor = parse_acp_descriptor(&text).map_err(RegistryError::Descriptor)?;
        let id = descriptor.id;
        self.transact(expected_revision, |registry, document| {
            if registry.builtins.iter().any(|builtin| builtin.id == id)
                || document.agents.iter().any(|agent| agent.id == id)
            {
                return Err(RegistryError::Duplicate);
            }
            if document.agents.len() >= MAX_USER_AGENTS {
                return Err(RegistryError::Limit);
            }
            document.decisions.retain(|decision| decision.id != id);
            document.agents.push(descriptor);
            Ok(())
        })?;
        // Resolution is filesystem only; nothing executes before trust.
        self.check(Some(id), false);
        Ok(id)
    }

    /// Trusts the exact command line the user reviewed. The host resolves it
    /// again; a different command line needs a new review.
    pub(crate) fn trust(
        &self,
        expected_revision: u64,
        id: AcpAgentId,
        fingerprint: &str,
        reviewed: &CommandLine,
    ) -> Result<(), RegistryError> {
        let descriptor = {
            let state = self.lock()?;
            let (descriptor, source) = self.find(&state, id).ok_or(RegistryError::NotFound)?;
            if source == AgentSource::BuiltIn {
                return Err(RegistryError::BuiltIn);
            }
            descriptor
        };
        if descriptor.fingerprint() != fingerprint {
            return Err(RegistryError::TrustChanged);
        }
        let command =
            resolve_acp_command(&descriptor.command).map_err(|_| RegistryError::NotInstalled)?;
        let command_line = CommandLine::of(&command);
        if &command_line != reviewed {
            return Err(RegistryError::TrustChanged);
        }
        self.transact(expected_revision, |_, document| {
            let entry = decision_entry(document, &descriptor);
            entry.trusted_command = Some(command_line);
            Ok(())
        })?;
        self.check(Some(id), false);
        Ok(())
    }

    /// Confirms using a version PiUI has not verified. It binds to the exact
    /// reported version; an update needs a new confirmation.
    pub(crate) fn confirm_version(
        &self,
        expected_revision: u64,
        id: AcpAgentId,
        version: &str,
    ) -> Result<(), RegistryError> {
        let descriptor = {
            let state = self.lock()?;
            let (descriptor, _) = self.find(&state, id).ok_or(RegistryError::NotFound)?;
            let reported = state
                .discovery
                .get(&id)
                .and_then(|discovery| discovery.version.as_ref());
            let confirmable = reported.is_some_and(|report| {
                matches!(
                    report.status,
                    AcpVersionStatus::Newer | AcpVersionStatus::NoVerifiedRange
                ) && report.version.as_deref() == Some(version)
            });
            if !confirmable {
                return Err(RegistryError::NothingToConfirm);
            }
            descriptor
        };
        self.transact(expected_revision, |_, document| {
            decision_entry(document, &descriptor).confirmed_version = Some(version.to_owned());
            Ok(())
        })
    }

    /// Allows exactly `names` of the descriptor's secret-like environment
    /// names to pass through. An empty list withdraws the permission.
    pub(crate) fn allow_secrets(
        &self,
        expected_revision: u64,
        id: AcpAgentId,
        fingerprint: &str,
        names: &[String],
    ) -> Result<(), RegistryError> {
        let descriptor = {
            let state = self.lock()?;
            self.find(&state, id).ok_or(RegistryError::NotFound)?.0
        };
        if descriptor.fingerprint() != fingerprint {
            return Err(RegistryError::TrustChanged);
        }
        let secrets = descriptor.secret_environment();
        if names.iter().any(|name| !secrets.contains(name)) {
            return Err(RegistryError::NothingToConfirm);
        }
        let mut allowed = names.to_vec();
        allowed.sort();
        allowed.dedup();
        self.transact(expected_revision, |_, document| {
            decision_entry(document, &descriptor).allowed_secrets = allowed;
            Ok(())
        })
    }

    /// Removes a user descriptor and its decisions. Chats that used it keep
    /// their history binding; they cannot start until it is added again.
    pub(crate) fn remove(
        &self,
        expected_revision: u64,
        id: AcpAgentId,
    ) -> Result<(), RegistryError> {
        if self.builtins.iter().any(|builtin| builtin.id == id) {
            return Err(RegistryError::BuiltIn);
        }
        self.transact(expected_revision, |_, document| {
            let before = document.agents.len();
            document.agents.retain(|agent| agent.id != id);
            if document.agents.len() == before {
                return Err(RegistryError::NotFound);
            }
            document.decisions.retain(|decision| decision.id != id);
            Ok(())
        })?;
        if let Ok(mut state) = self.lock() {
            state.discovery.remove(&id);
            state.sign_in.remove(&id);
            state.models.remove(&id);
        }
        Ok(())
    }

    /// Builds a start of `id` from its descriptor and decisions, or refuses
    /// it. Blocking (resolution and a cached version probe).
    pub(crate) fn launch(&self, id: AcpAgentId) -> Result<AcpLaunch, AcpRefusal> {
        let (descriptor, source, decision) = {
            let state = self.lock().map_err(|_| AcpRefusal::Unknown)?;
            let (descriptor, source) = self.find(&state, id).ok_or(AcpRefusal::Unknown)?;
            let decision = decision(&state, &descriptor).cloned();
            (descriptor, source, decision)
        };
        let command = resolve_acp_command(&descriptor.command);
        let executable = command
            .as_ref()
            .is_ok_and(|command| may_execute(source, decision.as_ref(), command));
        let report = match (&command, executable) {
            (Ok(command), true) => Some(probe_acp_version(&descriptor, command, false)),
            _ => None,
        };
        if let Ok(mut state) = self.lock() {
            state.discovery.insert(
                id,
                Discovery {
                    checked_at: now_string(),
                    command: command.clone(),
                    version: report.clone(),
                },
            );
        }
        let command = command.map_err(AcpRefusal::NotInstalled)?;
        let report = report.ok_or(AcpRefusal::Untrusted)?;
        version_gate(&report, decision.as_ref())?;
        let allowed = decision
            .as_ref()
            .map(|decision| decision.allowed_secrets.clone())
            .unwrap_or_default();
        let environment = descriptor
            .environment
            .iter()
            .filter(|name| !secret_like_environment(name) || allowed.contains(name))
            .cloned()
            .collect();
        Ok(AcpLaunch {
            agent: id,
            display_name: descriptor.display_name,
            command,
            environment,
            capabilities: descriptor.capabilities,
        })
    }

    /// Records the outcome of a start: a sign-in refusal keeps the agent's
    /// method names for Settings; any successful start clears them.
    pub(crate) fn record_start(&self, id: AcpAgentId, outcome: Result<(), &NativeRuntimeError>) {
        let Ok(mut state) = self.lock() else {
            return;
        };
        match outcome {
            Ok(()) => {
                state.sign_in.remove(&id);
            }
            Err(NativeRuntimeError::AgentSignInRequired { methods }) => {
                state.sign_in.insert(id, methods.clone());
            }
            Err(_) => {}
        }
    }

    /// Remembers the models a live session advertised, so pickers can offer
    /// them before the next session starts. Host memory only.
    pub(crate) fn remember_models(&self, id: AcpAgentId, models: &[WorkspaceModel]) {
        if models.is_empty() {
            return;
        }
        if let Ok(mut state) = self.lock() {
            state.models.insert(
                id,
                models.iter().take(MAX_REMEMBERED_MODELS).cloned().collect(),
            );
        }
    }

    /// The model catalog pickers show: "Agent default" first, then the models
    /// the agent advertised in this host process. No process starts for it.
    pub(crate) fn catalog_models(&self, id: AcpAgentId) -> Vec<NativeCatalogModel> {
        let remembered = self
            .lock()
            .ok()
            .and_then(|state| state.models.get(&id).cloned())
            .unwrap_or_default();
        std::iter::once(NativeCatalogModel {
            id: piui_runtime::acp::ACP_DEFAULT_MODEL.into(),
            provider: None,
            name: "Agent default".into(),
            thinking_levels: None,
            supports_fast: false,
        })
        .chain(remembered.into_iter().map(|model| NativeCatalogModel {
            id: model.id,
            provider: model.provider,
            name: model.name,
            thinking_levels: model.thinking_levels,
            supports_fast: false,
        }))
        .collect()
    }

    pub(crate) fn display_name(&self, id: AcpAgentId) -> Option<String> {
        let state = self.lock().ok()?;
        self.find(&state, id)
            .map(|(descriptor, _)| descriptor.display_name)
    }

    /// Scheduler admission: the generic ACP capabilities while the agent may
    /// start from its cached discovery, otherwise everything unsupported. A
    /// known sign-in refusal blocks managed starts until a start succeeds or
    /// the user checks the agent again.
    pub(crate) fn offline_capabilities(&self, id: AcpAgentId) -> HarnessCapabilities {
        if self
            .view(id)
            .is_some_and(|view| view.state == HarnessState::Ready)
        {
            acp_harness_capabilities()
        } else {
            piui_runtime::workspace_runtime::offline_harness_capabilities(
                piui_runtime::workspace_runtime::HarnessKind::Acp(id),
            )
        }
    }

    /// Workspace catalog rows (`HarnessSummary`) from the cached discovery.
    pub(crate) fn summaries(&self) -> Vec<AcpSummary> {
        self.views()
            .into_iter()
            .map(|view| {
                let (status, reason) = match view.state {
                    HarnessState::Ready => (HarnessAvailability::Available, None),
                    // Still startable: the next start asks the agent again.
                    HarnessState::SignInRequired => (HarnessAvailability::Available, view.reason),
                    HarnessState::UnverifiedVersion
                    | HarnessState::Untrusted
                    | HarnessState::UnsupportedVersion => {
                        (HarnessAvailability::Unverified, view.reason)
                    }
                    HarnessState::Checking
                    | HarnessState::NotInstalled
                    | HarnessState::Unavailable => (HarnessAvailability::Unavailable, view.reason),
                };
                AcpSummary {
                    id: view.descriptor.id,
                    name: view.descriptor.display_name.clone(),
                    installed: view.command_line.is_some(),
                    version: view.version.clone(),
                    status,
                    reason,
                }
            })
            .collect()
    }

    /// Default title of a new chat with `id`.
    pub(crate) fn default_title(&self, id: AcpAgentId) -> String {
        self.display_name(id).map_or_else(
            || "New agent session".into(),
            |name| format!("New {name} session"),
        )
    }

    fn transact(
        &self,
        expected_revision: u64,
        change: impl FnOnce(&Self, &mut Document) -> Result<(), RegistryError>,
    ) -> Result<(), RegistryError> {
        let mut state = self.lock()?;
        if state.document.generation != expected_revision {
            return Err(RegistryError::Conflict);
        }
        let mut staged = state.document.clone();
        change(self, &mut staged)?;
        staged.generation = state
            .next_generation
            .checked_add(1)
            .ok_or(RegistryError::Io)?;
        let bytes = serde_json::to_vec_pretty(&staged).map_err(|_| RegistryError::Io)?;
        let path = generation_path(&state.directory, staged.generation);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| RegistryError::Io)?;
        if write_complete(&mut file, &bytes).is_err() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(RegistryError::Io);
        }
        state.next_generation = staged.generation;
        state.document = staged;
        remove_older_generations(&state.directory, state.document.generation);
        Ok(())
    }
}

/// A workspace catalog row of one ACP agent.
pub(crate) struct AcpSummary {
    pub id: AcpAgentId,
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub status: HarnessAvailability,
    pub reason: Option<&'static str>,
}

fn decision<'a>(state: &'a State, descriptor: &AcpAgentDescriptor) -> Option<&'a Decision> {
    let fingerprint = descriptor.fingerprint();
    state
        .document
        .decisions
        .iter()
        .find(|decision| decision.id == descriptor.id && decision.fingerprint == fingerprint)
}

/// The decisions entry of `descriptor`, reset when its fingerprint changed.
fn decision_entry<'a>(
    document: &'a mut Document,
    descriptor: &AcpAgentDescriptor,
) -> &'a mut Decision {
    let fingerprint = descriptor.fingerprint();
    document
        .decisions
        .retain(|decision| decision.id != descriptor.id || decision.fingerprint == fingerprint);
    let index = match document
        .decisions
        .iter()
        .position(|decision| decision.id == descriptor.id)
    {
        Some(index) => index,
        None => {
            document.decisions.push(Decision {
                id: descriptor.id,
                fingerprint,
                trusted_command: None,
                confirmed_version: None,
                allowed_secrets: Vec::new(),
            });
            document.decisions.len() - 1
        }
    };
    &mut document.decisions[index]
}

/// A shipped descriptor may run its resolved program; a user descriptor only
/// the exact command line the user trusted.
fn may_execute(
    source: AgentSource,
    decision: Option<&Decision>,
    command: &AcpResolvedCommand,
) -> bool {
    source == AgentSource::BuiltIn
        || decision
            .and_then(|decision| decision.trusted_command.as_ref())
            .is_some_and(|trusted| *trusted == CommandLine::of(command))
}

fn version_gate(report: &AcpVersionReport, decision: Option<&Decision>) -> Result<(), AcpRefusal> {
    match report.status {
        AcpVersionStatus::Verified => Ok(()),
        AcpVersionStatus::Older => Err(AcpRefusal::UnsupportedVersion),
        AcpVersionStatus::ProbeFailed | AcpVersionStatus::Unrecognized => {
            Err(AcpRefusal::VersionUnknown)
        }
        AcpVersionStatus::Newer | AcpVersionStatus::NoVerifiedRange => {
            let confirmed = decision.and_then(|decision| decision.confirmed_version.as_deref());
            if confirmed.is_some() && confirmed == report.version.as_deref() {
                Ok(())
            } else {
                Err(AcpRefusal::VersionUnconfirmed)
            }
        }
    }
}

fn view(state: &State, descriptor: AcpAgentDescriptor, source: AgentSource) -> AcpAgentView {
    let decision = decision(state, &descriptor).cloned();
    let discovery = state.discovery.get(&descriptor.id);
    let command_line = discovery
        .and_then(|discovery| discovery.command.as_ref().ok())
        .map(CommandLine::of);
    let trusted = source == AgentSource::BuiltIn
        || command_line.as_ref().is_some_and(|line| {
            decision
                .as_ref()
                .and_then(|decision| decision.trusted_command.as_ref())
                == Some(line)
        });
    let report = discovery.and_then(|discovery| discovery.version.clone());
    let auth_methods = state
        .sign_in
        .get(&descriptor.id)
        .cloned()
        .unwrap_or_default();
    let (state_value, reason) = match discovery {
        None => (HarnessState::Checking, Some("Checking this agent…")),
        Some(Discovery {
            command: Err(error),
            ..
        }) => (
            HarnessState::NotInstalled,
            Some(AcpRefusal::NotInstalled(*error).reason()),
        ),
        Some(_) if !trusted => (
            HarnessState::Untrusted,
            Some(AcpRefusal::Untrusted.reason()),
        ),
        Some(_) => match report
            .as_ref()
            .map(|report| version_gate(report, decision.as_ref()))
        {
            None => (HarnessState::Checking, Some("Checking this agent…")),
            Some(Err(AcpRefusal::UnsupportedVersion)) => (
                HarnessState::UnsupportedVersion,
                Some(AcpRefusal::UnsupportedVersion.reason()),
            ),
            Some(Err(AcpRefusal::VersionUnconfirmed)) => (
                HarnessState::UnverifiedVersion,
                Some(AcpRefusal::VersionUnconfirmed.reason()),
            ),
            Some(Err(refusal)) => (HarnessState::Unavailable, Some(refusal.reason())),
            Some(Ok(())) if state.sign_in.contains_key(&descriptor.id) => (
                HarnessState::SignInRequired,
                Some(
                    "Sign in with the agent's own app, then try again. Settings → Harnesses shows how.",
                ),
            ),
            // A confirmed unverified version is ready; `versionStatus` still
            // tells the user that PiUI has not verified it.
            Some(Ok(())) => (HarnessState::Ready, None),
        },
    };
    AcpAgentView {
        fingerprint: descriptor.fingerprint(),
        secret_environment: descriptor.secret_environment(),
        allowed_secrets: decision
            .as_ref()
            .map(|decision| decision.allowed_secrets.clone())
            .unwrap_or_default(),
        confirmed_version: decision.and_then(|decision| decision.confirmed_version),
        version: report.as_ref().and_then(|report| report.version.clone()),
        version_status: report.map(|report| report.status),
        checked_at: discovery.map(|discovery| discovery.checked_at.clone()),
        descriptor,
        source,
        state: state_value,
        reason,
        command_line,
        trusted,
        auth_methods,
    }
}

fn write_complete(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}

fn generation_path(directory: &Path, generation: u64) -> PathBuf {
    directory.join(format!(
        "{GENERATION_PREFIX}{generation:020}{GENERATION_SUFFIX}"
    ))
}

fn generation_from_path(path: &Path) -> Option<u64> {
    let name = path.file_name()?.to_str()?;
    let number = name
        .strip_prefix(GENERATION_PREFIX)?
        .strip_suffix(GENERATION_SUFFIX)?;
    (number.len() == 20).then(|| number.parse().ok()).flatten()
}

fn remove_older_generations(directory: &Path, current: u64) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if generation_from_path(&path).is_some_and(|generation| generation < current) {
            let _ = fs::remove_file(path);
        }
    }
}

fn now_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "piui-acp-registry-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("test root");
        root
    }

    /// A fake agent program (a Node script run through `node`) that records
    /// every execution next to itself, so a test can prove nothing ran.
    fn agent_script(root: &Path) -> PathBuf {
        let script = root.join("lab-agent.mjs");
        fs::write(
            &script,
            "import fs from 'node:fs'; fs.appendFileSync(new URL('./ran.marker', import.meta.url), 'x'); if (process.argv.includes('--version')) console.log('lab-agent 1.4.0');",
        )
        .expect("agent script");
        script
    }

    fn descriptor(program: &Path) -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "id": "lab-agent",
            "displayName": "Lab Agent",
            "command": { "program": program.to_string_lossy(), "args": ["--acp"] },
            "version": { "args": ["--version"] },
            "environment": ["LAB_API_KEY", "LAB_REGION"],
            "authHint": "Run lab-agent login."
        })
    }

    fn id() -> AcpAgentId {
        AcpAgentId::new("lab-agent").expect("id")
    }

    #[test]
    fn user_agents_run_only_after_trust_and_confirmations() {
        let root = root("trust");
        let script = agent_script(&root);
        let registry = AcpAgents::open(&root).expect("registry");
        let base = registry.revision();
        registry.add(base, &descriptor(&script)).expect("add");
        let Some(view) = registry.view(id()) else {
            panic!("added agent is listed");
        };
        if view.command_line.is_none() {
            // No Node on this machine: nothing can resolve or run.
            let _ = fs::remove_dir_all(root);
            return;
        }
        assert_eq!(view.state, HarnessState::Untrusted);
        assert_eq!(view.source, AgentSource::User);
        assert!(!view.trusted);
        assert_eq!(view.secret_environment, ["LAB_API_KEY"]);
        assert_eq!(registry.launch(id()).err(), Some(AcpRefusal::Untrusted));
        registry.check(None, true);
        assert!(
            !root.join("ran.marker").exists(),
            "an untrusted descriptor never executes, not even --version"
        );

        // Trust binds to the exact command line and the fingerprint.
        let command_line = view.command_line.clone().expect("command line");
        let mut other = command_line.clone();
        other.args.push("--extra".into());
        assert!(matches!(
            registry.trust(registry.revision(), id(), &view.fingerprint, &other),
            Err(RegistryError::TrustChanged)
        ));
        assert!(matches!(
            registry.trust(registry.revision(), id(), "stale", &command_line),
            Err(RegistryError::TrustChanged)
        ));
        assert!(matches!(
            registry.trust(base, id(), &view.fingerprint, &command_line),
            Err(RegistryError::Conflict)
        ));
        registry
            .trust(registry.revision(), id(), &view.fingerprint, &command_line)
            .expect("trust");
        assert!(
            root.join("ran.marker").exists(),
            "trusted: the version probe ran"
        );
        let view = registry.view(id()).expect("view");
        assert!(view.trusted);
        assert_eq!(view.version.as_deref(), Some("1.4.0"));
        assert_eq!(view.version_status, Some(AcpVersionStatus::NoVerifiedRange));
        assert_eq!(view.state, HarnessState::UnverifiedVersion);
        assert_eq!(
            registry.launch(id()).err(),
            Some(AcpRefusal::VersionUnconfirmed)
        );
        assert!(matches!(
            registry.confirm_version(registry.revision(), id(), "9.9.9"),
            Err(RegistryError::NothingToConfirm)
        ));
        registry
            .confirm_version(registry.revision(), id(), "1.4.0")
            .expect("confirm");
        assert_eq!(
            registry.view(id()).expect("view").state,
            HarnessState::Ready
        );
        let launch = registry.launch(id()).expect("launch");
        assert_eq!(
            launch.environment,
            ["LAB_REGION"],
            "secrets wait for a confirmation"
        );
        assert_eq!(launch.display_name, "Lab Agent");
        registry
            .allow_secrets(
                registry.revision(),
                id(),
                &view.fingerprint,
                &["LAB_API_KEY".into()],
            )
            .expect("allow");
        assert_eq!(
            registry.launch(id()).expect("launch").environment,
            ["LAB_API_KEY", "LAB_REGION"]
        );
        assert!(matches!(
            registry.allow_secrets(
                registry.revision(),
                id(),
                &view.fingerprint,
                &["LAB_REGION".into()]
            ),
            Err(RegistryError::NothingToConfirm)
        ));

        // Decisions survive a restart; removal forgets them.
        let reopened = AcpAgents::open(&root).expect("reopen");
        reopened.check(None, false);
        assert_eq!(
            reopened.view(id()).expect("view").state,
            HarnessState::Ready
        );
        reopened.remove(reopened.revision(), id()).expect("remove");
        assert!(reopened.view(id()).is_none());
        assert_eq!(reopened.launch(id()).err(), Some(AcpRefusal::Unknown));
        let again = AcpAgents::open(&root).expect("reopen");
        assert!(again.view(id()).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn descriptors_are_validated_unique_and_never_partially_stored() {
        let root = root("validate");
        let registry = AcpAgents::open(&root).expect("registry");
        let program = root.join("agent.exe");
        let mut bad = descriptor(&program);
        bad["shell"] = json!("cmd.exe");
        assert!(matches!(
            registry.add(0, &bad),
            Err(RegistryError::Descriptor(AcpDescriptorError::Malformed))
        ));
        let mut claim = descriptor(&program);
        claim["capabilities"] = json!({ "loadSession": true });
        assert!(matches!(
            registry.add(0, &claim),
            Err(RegistryError::Descriptor(_))
        ));
        let mut builtin = descriptor(&program);
        builtin["id"] = json!("gemini-cli");
        assert!(matches!(
            registry.add(0, &builtin),
            Err(RegistryError::Duplicate)
        ));
        assert_eq!(registry.revision(), 0, "failed adds write nothing");
        registry.add(0, &descriptor(&program)).expect("add");
        assert!(matches!(
            registry.add(1, &descriptor(&program)),
            Err(RegistryError::Duplicate)
        ));
        assert!(matches!(
            registry.add(0, &descriptor(&program)),
            Err(RegistryError::Conflict)
        ));
        assert!(matches!(
            registry.remove(1, AcpAgentId::new("gemini-cli").expect("id")),
            Err(RegistryError::BuiltIn)
        ));
        // A corrupt newer generation is skipped, never partially applied.
        fs::write(generation_path(&root.join(DIRECTORY), 9), b"{").expect("corrupt");
        let reopened = AcpAgents::open(&root).expect("reopen");
        assert!(reopened.view(id()).is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn built_in_gemini_is_listed_trusted_and_offers_the_agent_default_model() {
        let root = root("builtin");
        let registry = AcpAgents::open(&root).expect("registry");
        let gemini = AcpAgentId::new("gemini-cli").expect("id");
        let view = registry.view(gemini).expect("built-in Gemini CLI");
        assert_eq!(view.source, AgentSource::BuiltIn);
        assert!(view.trusted);
        assert_eq!(view.state, HarnessState::Checking);
        assert!(!registry.checked());
        let summary = registry
            .summaries()
            .into_iter()
            .find(|summary| summary.id == gemini)
            .expect("summary");
        assert_eq!(summary.status, HarnessAvailability::Unavailable);
        assert_eq!(summary.reason, Some("Checking this agent…"));
        assert_eq!(registry.default_title(gemini), "New Gemini CLI session");
        let models = registry.catalog_models(gemini);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "default");
        registry.remember_models(
            gemini,
            &[WorkspaceModel {
                id: "gemini-lab".into(),
                provider: None,
                name: "Gemini Lab".into(),
                thinking_levels: None,
            }],
        );
        assert_eq!(
            registry
                .catalog_models(gemini)
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "gemini-lab"]
        );
        assert!(!registry.offline_capabilities(gemini).prompt.supported);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_sign_in_refusal_is_remembered_until_a_start_or_a_check() {
        let root = root("sign-in");
        let registry = AcpAgents::open(&root).expect("registry");
        let gemini = AcpAgentId::new("gemini-cli").expect("id");
        registry.record_start(
            gemini,
            Err(&NativeRuntimeError::AgentSignInRequired {
                methods: vec!["Log in with Google".into()],
            }),
        );
        let view = registry.view(gemini).expect("view");
        assert_eq!(view.auth_methods, ["Log in with Google"]);
        registry.record_start(gemini, Ok(()));
        assert!(registry.view(gemini).expect("view").auth_methods.is_empty());
        registry.record_start(
            gemini,
            Err(&NativeRuntimeError::AgentSignInRequired {
                methods: Vec::new(),
            }),
        );
        registry.check(Some(gemini), true);
        assert!(
            registry.lock().expect("state").sign_in.is_empty(),
            "check again lets the next start ask the agent"
        );
        let _ = fs::remove_dir_all(root);
    }
}
