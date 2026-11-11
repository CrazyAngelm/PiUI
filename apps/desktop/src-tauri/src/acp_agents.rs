//! Host registry of ACP agents (ADR-034).
//!
//! It combines the descriptors shipped with PiUI, the descriptors the user
//! added, and the user's explicit decisions: trust of the exact command line a
//! user descriptor starts and confirmation of secret-like environment names.
//! Decisions bind to the descriptor fingerprint, so any change needs a new
//! decision. The document is written as complete create-only generations; a
//! failed write leaves the previous one untouched.
//!
//! A version is advisory (ADR-043): only a version older than a descriptor's
//! declared minimum refuses to start. A newer, unlisted or unreadable version
//! starts, and `versionStatus` tells the user; the ACP `initialize` handshake
//! is the compatibility gate. Approval concerns what PiUI executes and which
//! secrets it passes, never a release number. The legacy
//! `Decision::confirmed_version` of older documents stays readable and is
//! ignored.
//!
//! Discovery (PATH resolution and a contained `--version` probe) runs outside
//! the lock, in parallel, and never for an untrusted user descriptor: trust
//! comes before any execution. Values of environment variables are never read
//! or stored here; only names are.

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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

const DOCUMENT_VERSION: u32 = 1;
const DIRECTORY: &str = "acp-agents-v1";
const GENERATION_PREFIX: &str = "registry-";
const GENERATION_SUFFIX: &str = ".json";
/// Most user descriptors kept at once.
pub(crate) const MAX_USER_AGENTS: usize = 32;
const MAX_REMEMBERED_MODELS: usize = 500;
/// Most agents that are resolved and probed at the same time. Each probe is a
/// contained process, so the bound keeps a first start-up cheap.
const MAX_PARALLEL_CHECKS: usize = 4;

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
    /// Legacy (before ADR-043): a confirmed unverified version. Kept so that
    /// existing documents stay valid (`deny_unknown_fields`); it never grants
    /// anything and is not shown.
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
    /// An enabled plugin's `acpAgents` contribution (ADR-032). It is trusted
    /// like a user descriptor, by its exact command line, and removed with
    /// the plugin.
    Plugin,
}

/// An ACP descriptor an enabled plugin contributes.
#[derive(Clone, Debug)]
pub(crate) struct PluginAgent {
    pub plugin_id: String,
    pub plugin_name: String,
    pub descriptor: AcpAgentDescriptor,
}

/// The plugin an agent comes from (display only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginOrigin {
    pub id: String,
    pub name: String,
}

/// Readiness of one harness, as Settings → Harnesses shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HarnessState {
    Ready,
    Checking,
    NotInstalled,
    /// Older than the descriptor's declared minimum.
    UnsupportedVersion,
    /// Deprecated (ADR-043): never produced, since a version needs no
    /// confirmation. Kept in the contract for older consumers.
    #[allow(dead_code, reason = "kept in the registry contract, never produced")]
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
    /// Older than the descriptor's declared minimum: the only version refusal.
    UnsupportedVersion,
    /// Never produced since ADR-043: an unreadable version still starts.
    #[allow(dead_code, reason = "matched by older consumers, never produced")]
    VersionUnknown,
    /// Never produced since ADR-043: no version needs a confirmation.
    #[allow(dead_code, reason = "matched by older consumers, never produced")]
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
    /// Descriptors of enabled plugins; never persisted here.
    plugin_agents: Vec<PluginAgent>,
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
    /// Advisory: `newer` is above the tested range, `no-verified-range` and
    /// the unreadable states carry no claim. None of them stops a start;
    /// only `older` does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_status: Option<AcpVersionStatus>,
    /// Secret-like environment names that pass only after a confirmation.
    pub secret_environment: Vec<String>,
    pub allowed_secrets: Vec<String>,
    /// Sign-in method names the agent reported when it refused to start.
    pub auth_methods: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    /// The plugin that contributes this agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<PluginOrigin>,
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
    /// A plugin's agent is removed by removing or disabling the plugin.
    PluginOwned,
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
                plugin_agents: Vec::new(),
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

    /// Every agent, one per id. A stored user descriptor wins over a shipped
    /// agent with the same id (a later release can ship an agent a user had
    /// added by hand): the user's command, capability restrictions and trust
    /// decisions stay what they approved, and existing chats and graphs that
    /// name the id keep starting that same agent. The shipped agent is hidden
    /// until the user removes the stored descriptor. An enabled plugin never
    /// takes the id of a shipped or stored agent.
    fn descriptors(&self, state: &State) -> Vec<(AcpAgentDescriptor, AgentSource)> {
        let stored = |id: AcpAgentId| state.document.agents.iter().any(|user| user.id == id);
        self.builtins
            .iter()
            .filter(|builtin| !stored(builtin.id))
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
            .chain(
                state
                    .plugin_agents
                    .iter()
                    .filter(|agent| {
                        !self
                            .builtins
                            .iter()
                            .any(|builtin| builtin.id == agent.descriptor.id)
                            && !state
                                .document
                                .agents
                                .iter()
                                .any(|user| user.id == agent.descriptor.id)
                    })
                    .map(|agent| (agent.descriptor.clone(), AgentSource::Plugin)),
            )
            .collect()
    }

    /// Replaces the agents enabled plugins contribute (never persisted here).
    /// An id another agent already uses is not added. Returns the plugin id,
    /// agent id and whether it was added, for Settings → Plugins. Blocking:
    /// new agents are resolved on the filesystem (nothing runs before trust).
    pub(crate) fn set_plugin_agents(
        &self,
        agents: Vec<PluginAgent>,
    ) -> Vec<(String, AcpAgentId, bool)> {
        let (report, added) = {
            let Ok(mut state) = self.lock() else {
                return Vec::new();
            };
            let before = state
                .plugin_agents
                .iter()
                .map(|agent| agent.descriptor.id)
                .collect::<Vec<_>>();
            let mut seen = Vec::new();
            let accepted = agents
                .into_iter()
                .filter(|agent| {
                    let id = agent.descriptor.id;
                    let fresh = !seen.contains(&id);
                    seen.push(id);
                    fresh
                })
                .collect::<Vec<_>>();
            let report = accepted
                .iter()
                .map(|agent| {
                    let id = agent.descriptor.id;
                    let taken = self.builtins.iter().any(|builtin| builtin.id == id)
                        || state.document.agents.iter().any(|user| user.id == id);
                    (agent.plugin_id.clone(), id, !taken)
                })
                .collect::<Vec<_>>();
            let now = accepted
                .iter()
                .map(|agent| agent.descriptor.id)
                .collect::<Vec<_>>();
            state.plugin_agents = accepted;
            for id in before.iter().filter(|id| !now.contains(id)) {
                let owned_elsewhere = state.document.agents.iter().any(|user| user.id == *id)
                    || self.builtins.iter().any(|builtin| builtin.id == *id);
                if !owned_elsewhere {
                    state.discovery.remove(id);
                    state.sign_in.remove(id);
                }
            }
            let added = report
                .iter()
                .filter(|(_, id, registered)| *registered && !before.contains(id))
                .map(|(_, id, _)| *id)
                .collect::<Vec<_>>();
            (report, added)
        };
        for id in added {
            self.check(Some(id), false);
        }
        report
    }

    /// The plugin that contributes `id`, when a plugin does.
    fn plugin_origin(state: &State, id: AcpAgentId) -> Option<PluginOrigin> {
        state
            .plugin_agents
            .iter()
            .find(|agent| agent.descriptor.id == id)
            .map(|agent| PluginOrigin {
                id: agent.plugin_id.clone(),
                name: agent.plugin_name.clone(),
            })
    }

    fn find(&self, state: &State, id: AcpAgentId) -> Option<(AcpAgentDescriptor, AgentSource)> {
        self.descriptors(state)
            .into_iter()
            .find(|(descriptor, _)| descriptor.id == id)
    }

    /// Resolves every agent (filesystem only) and probes the version of each
    /// agent that may run: shipped or trusted. The agents are checked in
    /// parallel (at most [`MAX_PARALLEL_CHECKS`] at a time), since each probe
    /// is a separate contained process. Blocking; call it off the async
    /// executor. `force` repeats cached version probes.
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
        let results = discover_all(&targets, force);
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
            .map(|(descriptor, source)| {
                let plugin = (source == AgentSource::Plugin)
                    .then(|| Self::plugin_origin(&state, descriptor.id))
                    .flatten();
                AcpAgentView {
                    plugin,
                    ..view(&state, descriptor, source)
                }
            })
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

    /// Retired (ADR-043): a version needs no confirmation, so there is never
    /// anything to confirm. The command stays in the registry protocol so
    /// that an older window gets a typed answer instead of an unknown
    /// command, and it records nothing.
    #[allow(clippy::unused_self, reason = "kept for the registry protocol")]
    pub(crate) fn confirm_version(
        &self,
        _expected_revision: u64,
        _id: AcpAgentId,
        _version: &str,
    ) -> Result<(), RegistryError> {
        Err(RegistryError::NothingToConfirm)
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
    /// their history binding; they cannot start until it is added again. A
    /// shipped agent cannot be removed, but a stored user descriptor that
    /// hides a shipped agent of the same id can: that removes only the stored
    /// copy and its decisions, the shipped agent reappears with its own
    /// decisions, and it is checked again in the background (the cached
    /// discovery described the removed command).
    pub(crate) fn remove(
        &self,
        expected_revision: u64,
        id: AcpAgentId,
    ) -> Result<(), RegistryError> {
        let shipped = self.builtins.iter().find(|builtin| builtin.id == id);
        {
            let state = self.lock()?;
            let stored = state.document.agents.iter().any(|agent| agent.id == id);
            if shipped.is_some() && !stored {
                return Err(RegistryError::BuiltIn);
            }
            if !stored
                && state
                    .plugin_agents
                    .iter()
                    .any(|agent| agent.descriptor.id == id)
            {
                return Err(RegistryError::PluginOwned);
            }
        }
        let shipped_fingerprint = shipped.map(AcpAgentDescriptor::fingerprint);
        self.transact(expected_revision, |_, document| {
            let before = document.agents.len();
            document.agents.retain(|agent| agent.id != id);
            if document.agents.len() == before {
                return Err(RegistryError::NotFound);
            }
            // The shipped agent shares the id; its decisions bind to its own
            // fingerprint and stay.
            document.decisions.retain(|decision| {
                decision.id != id || shipped_fingerprint.as_ref() == Some(&decision.fingerprint)
            });
            Ok(())
        })?;
        // What was cached described the removed descriptor, never the agent
        // that may now own the id.
        let revealed = self.lock().is_ok_and(|mut state| {
            state.discovery.remove(&id);
            state.sign_in.remove(&id);
            state.models.remove(&id);
            self.find(&state, id).is_some()
        });
        if revealed {
            let registry = self.clone();
            std::thread::spawn(move || registry.check(Some(id), false));
        }
        Ok(())
    }

    /// Builds a start of `id` from its descriptor and decisions, or refuses
    /// it. Blocking (resolution and a cached version probe). Only an untrusted
    /// user descriptor, a missing program and a version older than the
    /// declared minimum refuse; any other version, newer or unreadable
    /// included, starts and is reported as advisory.
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
        version_gate(&report)?;
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
                // Only a startable agent has a catalog status.
                let startable = status == HarnessAvailability::Available;
                AcpSummary {
                    id: view.descriptor.id,
                    name: view.descriptor.display_name.clone(),
                    installed: view.command_line.is_some(),
                    version: view.version.clone(),
                    status,
                    reason,
                    version_status: view.version_status.filter(|status| {
                        startable
                            && matches!(
                                status,
                                AcpVersionStatus::Verified | AcpVersionStatus::Newer
                            )
                    }),
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
    /// Advisory tested-range badge of a startable agent: `Verified` (inside
    /// the declared range) or `Newer` (above its ceiling), nothing otherwise.
    /// The catalog maps it to `HarnessSummary.versionStatus`.
    pub version_status: Option<AcpVersionStatus>,
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

/// One agent to check: its descriptor, source and decisions.
type CheckTarget = (AcpAgentDescriptor, AgentSource, Option<Decision>);

/// Resolves one agent and, when it may run, probes its version.
fn discover(target: &CheckTarget, force: bool) -> (AcpAgentId, Discovery) {
    let (descriptor, source, decision) = target;
    let command = resolve_acp_command(&descriptor.command);
    let version = command.as_ref().ok().and_then(|command| {
        may_execute(*source, decision.as_ref(), command)
            .then(|| probe_acp_version(descriptor, command, force))
    });
    (
        descriptor.id,
        Discovery {
            checked_at: now_string(),
            command,
            version,
        },
    )
}

/// Checks `targets` with at most [`MAX_PARALLEL_CHECKS`] workers. Each probe
/// is bounded by its own timeout, so the slowest agent, not the sum, decides
/// how long the first discovery takes. The order of the result is not defined;
/// every entry carries its agent id.
fn discover_all(targets: &[CheckTarget], force: bool) -> Vec<(AcpAgentId, Discovery)> {
    let workers = targets.len().min(MAX_PARALLEL_CHECKS);
    if workers <= 1 {
        return targets
            .iter()
            .map(|target| discover(target, force))
            .collect();
    }
    let next = AtomicUsize::new(0);
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let sender = sender.clone();
            let next = &next;
            scope.spawn(move || {
                while let Some(target) = targets.get(next.fetch_add(1, Ordering::Relaxed)) {
                    if sender.send(discover(target, force)).is_err() {
                        break;
                    }
                }
            });
        }
    });
    drop(sender);
    receiver.into_iter().collect()
}

/// The version policy (ADR-043): the descriptor's declared minimum is
/// enforced, everything else is advisory. A newer version, a descriptor
/// without a range, an unrecognized version text and a failed probe all start;
/// the ACP `initialize` handshake (protocol version 1) is the compatibility
/// gate, and `versionStatus` still tells the user what was found.
fn version_gate(report: &AcpVersionReport) -> Result<(), AcpRefusal> {
    match report.status {
        AcpVersionStatus::Older => Err(AcpRefusal::UnsupportedVersion),
        AcpVersionStatus::Verified
        | AcpVersionStatus::Newer
        | AcpVersionStatus::NoVerifiedRange
        | AcpVersionStatus::Unrecognized
        | AcpVersionStatus::ProbeFailed => Ok(()),
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
        Some(_) => match report.as_ref().map(version_gate) {
            None => (HarnessState::Checking, Some("Checking this agent…")),
            Some(Err(AcpRefusal::UnsupportedVersion)) => (
                HarnessState::UnsupportedVersion,
                Some(AcpRefusal::UnsupportedVersion.reason()),
            ),
            Some(Err(refusal)) => (HarnessState::Unavailable, Some(refusal.reason())),
            Some(Ok(())) if state.sign_in.contains_key(&descriptor.id) => (
                HarnessState::SignInRequired,
                Some(
                    "Sign in with the agent's own app, then try again. Settings → Harnesses shows how.",
                ),
            ),
            // A newer or unlisted version is ready; `versionStatus` still
            // tells the user that PiUI has not tested it.
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
        plugin: None,
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
            "import fs from 'node:fs'; fs.appendFileSync(new URL('./ran.marker', import.meta.url), 'x'); if (process.argv.includes('--fail')) process.exit(3); if (process.argv.includes('--version')) console.log('lab-agent 1.4.0');",
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
    fn user_agents_run_only_after_trust_and_secret_consent() {
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
        assert_eq!(
            view.state,
            HarnessState::Ready,
            "trust is the only approval: a version needs no confirmation"
        );
        // The retired confirmation command answers without recording anything.
        let revision = registry.revision();
        for version in ["9.9.9", "1.4.0"] {
            assert!(matches!(
                registry.confirm_version(revision, id(), version),
                Err(RegistryError::NothingToConfirm)
            ));
        }
        assert_eq!(registry.revision(), revision);
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

    /// A registry whose shipped agents are `descriptors` (they point at the
    /// lab script), so a test can drive the policy without a real CLI.
    fn shipped_registry(root: &Path, descriptors: &[serde_json::Value]) -> AcpAgents {
        let mut registry = AcpAgents::open(root).expect("registry");
        registry.builtins = Arc::new(
            descriptors
                .iter()
                .map(|value| parse_acp_descriptor(&value.to_string()).expect("descriptor"))
                .collect(),
        );
        registry
    }

    fn lab_descriptor(program: &Path, name: &str, version: serde_json::Value) -> serde_json::Value {
        let mut value = descriptor(program);
        value["id"] = json!(name);
        value["version"] = version;
        value
    }

    fn node_available(script: &Path) -> bool {
        resolve_acp_command(&piui_runtime::acp::AcpCommandSpec {
            program: script.to_string_lossy().into_owned(),
            args: Vec::new(),
        })
        .is_ok()
    }

    #[test]
    fn only_a_version_older_than_the_declared_minimum_refuses_to_start() {
        let root = root("version-policy");
        let script = agent_script(&root);
        if !node_available(&script) {
            let _ = fs::remove_dir_all(root);
            return;
        }
        // (version command, declared range, expected status, may start)
        let cases = [
            (
                json!({ "args": ["--version"] }),
                AcpVersionStatus::NoVerifiedRange,
                true,
            ),
            (
                json!({ "args": ["--version"], "verified": { "minimum": "1.0.0", "ceiling": "2.0.0" } }),
                AcpVersionStatus::Verified,
                true,
            ),
            (
                json!({ "args": ["--version"], "verified": { "minimum": "0.1.0", "ceiling": "1.0.0" } }),
                AcpVersionStatus::Newer,
                true,
            ),
            (
                json!({ "args": ["--version"], "verified": { "minimum": "2.0.0", "ceiling": "3.0.0" } }),
                AcpVersionStatus::Older,
                false,
            ),
            (
                // The version command prints nothing a pattern can read.
                json!({ "args": ["--other"] }),
                AcpVersionStatus::Unrecognized,
                true,
            ),
            (
                // The version command fails.
                json!({ "args": ["--fail"] }),
                AcpVersionStatus::ProbeFailed,
                true,
            ),
        ];
        for (index, (version, status, starts)) in cases.into_iter().enumerate() {
            let name = format!("lab-policy-{index}");
            let registry = shipped_registry(&root, &[lab_descriptor(&script, &name, version)]);
            let agent = AcpAgentId::new(&name).expect("id");
            registry.check(None, true);
            let view = registry.view(agent).expect("view");
            assert_eq!(view.version_status, Some(status), "{name}");
            let launch = registry.launch(agent);
            if starts {
                assert_eq!(view.state, HarnessState::Ready, "{name}");
                assert!(view.reason.is_none(), "{name}");
                assert!(launch.is_ok(), "{name}: {:?}", launch.err());
                let summary = registry
                    .summaries()
                    .into_iter()
                    .find(|summary| summary.id == agent)
                    .expect("summary");
                assert_eq!(summary.status, HarnessAvailability::Available, "{name}");
                // Only the tested-range badges reach the catalog.
                let advisory =
                    matches!(status, AcpVersionStatus::Verified | AcpVersionStatus::Newer)
                        .then_some(status);
                assert_eq!(summary.version_status, advisory, "{name}");
            } else {
                assert_eq!(view.state, HarnessState::UnsupportedVersion, "{name}");
                assert_eq!(launch.err(), Some(AcpRefusal::UnsupportedVersion), "{name}");
                let summary = registry
                    .summaries()
                    .into_iter()
                    .find(|summary| summary.id == agent)
                    .expect("summary");
                assert_eq!(summary.status, HarnessAvailability::Unverified, "{name}");
                assert_eq!(summary.version_status, None, "{name}");
            }
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_user_agent_with_a_newer_version_starts_after_trust_alone() {
        let root = root("newer-user");
        let script = agent_script(&root);
        let registry = AcpAgents::open(&root).expect("registry");
        let mut user = descriptor(&script);
        user["version"] = json!({
            "args": ["--version"],
            "verified": { "minimum": "0.5.0", "ceiling": "1.0.0" }
        });
        registry.add(registry.revision(), &user).expect("add");
        let view = registry.view(id()).expect("view");
        let Some(command_line) = view.command_line.clone() else {
            let _ = fs::remove_dir_all(root);
            return;
        };
        assert_eq!(registry.launch(id()).err(), Some(AcpRefusal::Untrusted));
        registry
            .trust(registry.revision(), id(), &view.fingerprint, &command_line)
            .expect("trust");
        let view = registry.view(id()).expect("view");
        assert_eq!(view.version_status, Some(AcpVersionStatus::Newer));
        assert_eq!(view.state, HarnessState::Ready);
        assert!(registry.launch(id()).is_ok());
        // An update of the installed program keeps the trust: the command
        // line is the same, and the version string is not part of it.
        fs::write(
            &script,
            "if (process.argv.includes('--version')) console.log('lab-agent 9.9.9 (updated build)');",
        )
        .expect("updated agent");
        let reopened = AcpAgents::open(&root).expect("reopen");
        reopened.check(None, true);
        let view = reopened.view(id()).expect("view");
        assert_eq!(view.version.as_deref(), Some("9.9.9"));
        assert_eq!(view.version_status, Some(AcpVersionStatus::Newer));
        assert!(view.trusted);
        assert_eq!(view.state, HarnessState::Ready);
        assert!(reopened.launch(id()).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_legacy_version_confirmation_in_a_stored_document_is_ignored() {
        let root = root("legacy-confirmation");
        let script = agent_script(&root);
        let registry = AcpAgents::open(&root).expect("registry");
        registry
            .add(registry.revision(), &descriptor(&script))
            .expect("add");
        let view = registry.view(id()).expect("view");
        let Some(command_line) = view.command_line.clone() else {
            let _ = fs::remove_dir_all(root);
            return;
        };
        registry
            .trust(registry.revision(), id(), &view.fingerprint, &command_line)
            .expect("trust");
        // Write the confirmation an older PiUI recorded into the document.
        let directory = root.join(DIRECTORY);
        let newest = fs::read_dir(&directory)
            .expect("registry directory")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| generation_from_path(path).is_some())
            .max()
            .expect("a generation");
        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(&newest).expect("document")).expect("json");
        document["decisions"][0]["confirmedVersion"] = json!("0.0.1");
        fs::write(&newest, serde_json::to_vec(&document).expect("json")).expect("rewrite");

        let reopened = AcpAgents::open(&root).expect("a stored confirmation still loads");
        reopened.check(None, true);
        let view = reopened.view(id()).expect("view");
        assert!(view.trusted, "the command trust survives the migration");
        assert_eq!(view.state, HarnessState::Ready);
        assert_eq!(view.version.as_deref(), Some("1.4.0"));
        assert!(reopened.launch(id()).is_ok());
        let value = serde_json::to_value(&view).expect("view json");
        assert!(
            value.get("confirmedVersion").is_none(),
            "a confirmation is no longer reported"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shipped_agents_start_without_any_approval() {
        let root = root("shipped-ready");
        let script = agent_script(&root);
        if !node_available(&script) {
            let _ = fs::remove_dir_all(root);
            return;
        }
        let shipped = lab_descriptor(&script, "lab-shipped", json!({ "args": ["--version"] }));
        let registry = shipped_registry(&root, &[shipped]);
        let agent = AcpAgentId::new("lab-shipped").expect("id");
        assert!(!registry.checked());
        registry.check(None, false);
        assert!(registry.checked());
        let view = registry.view(agent).expect("view");
        assert_eq!(view.source, AgentSource::BuiltIn);
        assert_eq!(view.state, HarnessState::Ready);
        assert_eq!(view.version.as_deref(), Some("1.4.0"));
        assert_eq!(view.version_status, Some(AcpVersionStatus::NoVerifiedRange));
        let launch = registry.launch(agent).expect("launch");
        assert_eq!(
            launch.environment,
            ["LAB_REGION"],
            "a shipped descriptor still waits for consent to pass a secret"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn every_agent_is_discovered_when_checks_run_in_parallel() {
        let root = root("parallel");
        let script = agent_script(&root);
        if !node_available(&script) {
            let _ = fs::remove_dir_all(root);
            return;
        }
        let names = (0..9)
            .map(|index| format!("lab-parallel-{index}"))
            .collect::<Vec<_>>();
        let registry = shipped_registry(
            &root,
            &names
                .iter()
                .map(|name| lab_descriptor(&script, name, json!({ "args": ["--version"] })))
                .collect::<Vec<_>>(),
        );
        registry.check(None, true);
        assert!(registry.checked());
        for name in &names {
            let view = registry
                .view(AcpAgentId::new(name).expect("id"))
                .expect("view");
            assert_eq!(view.version.as_deref(), Some("1.4.0"), "{name}");
            assert_eq!(view.state, HarnessState::Ready, "{name}");
        }
        // The same worker pool serves a single agent and an empty list.
        registry.check(Some(AcpAgentId::new(&names[0]).expect("id")), true);
        assert!(discover_all(&[], false).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    /// The agent a newer release ships under the id of a user's own descriptor.
    /// It points at a program that is not installed, so nothing ever runs.
    fn shipped_opencode() -> serde_json::Value {
        let mut value = descriptor(Path::new("lab-shipped-opencode"));
        value["id"] = json!("opencode");
        value["displayName"] = json!("Shipped OpenCode");
        value["command"] = json!({ "program": "lab-shipped-opencode", "args": ["acp"] });
        value["environment"] = json!(["OPENAI_API_KEY"]);
        value
    }

    #[test]
    fn a_stored_user_descriptor_survives_an_upgrade_that_ships_its_id() {
        let root = root("shadow");
        let script = agent_script(&root);
        let opencode = AcpAgentId::new("opencode").expect("id");

        // Before the upgrade: the user's own `opencode`, pinned to an approved
        // executable and restricted (never the PiUI coordination tool).
        let before = shipped_registry(&root, &[]);
        let mut value = descriptor(&script);
        value["id"] = json!("opencode");
        value["capabilities"] = json!({ "mcpHttp": false });
        before.add(before.revision(), &value).expect("add");
        let view = before.view(opencode).expect("view");
        let Some(approved) = view.command_line.clone() else {
            // No Node on this machine: nothing can resolve or run.
            let _ = fs::remove_dir_all(root);
            return;
        };
        before
            .trust(before.revision(), opencode, &view.fingerprint, &approved)
            .expect("trust");
        let stored_fingerprint = view.fingerprint;

        // The upgrade ships an agent with the same id.
        let upgraded = shipped_registry(&root, &[shipped_opencode()]);
        let shipped = parse_acp_descriptor(&shipped_opencode().to_string()).expect("descriptor");
        assert_ne!(shipped.fingerprint(), stored_fingerprint);
        // The shipped agent's own earlier decision (a secret it may pass).
        let revision = upgraded.revision();
        upgraded
            .transact(revision, |_, document| {
                document.decisions.push(Decision {
                    id: opencode,
                    fingerprint: shipped.fingerprint(),
                    trusted_command: None,
                    confirmed_version: None,
                    allowed_secrets: vec!["OPENAI_API_KEY".into()],
                });
                Ok(())
            })
            .expect("shipped decision");
        upgraded.check(None, false);

        let views = upgraded
            .views()
            .into_iter()
            .filter(|view| view.descriptor.id == opencode)
            .collect::<Vec<_>>();
        assert_eq!(views.len(), 1, "one row per id");
        let view = &views[0];
        assert_eq!(view.source, AgentSource::User, "the stored descriptor wins");
        assert_eq!(view.fingerprint, stored_fingerprint);
        assert_eq!(view.descriptor.display_name, "Lab Agent");
        assert_eq!(view.descriptor.command.program, script.to_string_lossy());
        assert_eq!(view.descriptor.command.args, ["--acp"]);
        assert_eq!(view.descriptor.capabilities.mcp_http, Some(false));
        assert!(view.trusted, "its trust decision is kept");
        assert_eq!(view.command_line.as_ref(), Some(&approved));
        assert_eq!(view.state, HarnessState::Ready);
        assert!(
            view.allowed_secrets.is_empty(),
            "the shipped agent's decision never applies to it"
        );
        let launch = upgraded
            .launch(opencode)
            .expect("the approved command starts");
        assert_eq!(CommandLine::of(&launch.command), approved);
        assert_eq!(launch.capabilities.mcp_http, Some(false));
        assert_eq!(launch.display_name, "Lab Agent");
        // Another restart changes nothing.
        let again = shipped_registry(&root, &[shipped_opencode()]);
        assert_eq!(
            again.view(opencode).map(|view| view.source),
            Some(AgentSource::User)
        );

        // The stored descriptor is removable, and the shipped agent reappears
        // with its own descriptor and decisions, not the removed one's.
        upgraded
            .remove(upgraded.revision(), opencode)
            .expect("the stored descriptor is removable");
        assert!(upgraded.lock().expect("state").document.agents.is_empty());
        let view = upgraded.view(opencode).expect("shipped agent reappears");
        assert_eq!(view.source, AgentSource::BuiltIn);
        assert_eq!(view.fingerprint, shipped.fingerprint());
        assert_eq!(view.descriptor.display_name, "Shipped OpenCode");
        assert_eq!(view.descriptor.command.program, "lab-shipped-opencode");
        assert_eq!(view.descriptor.capabilities.mcp_http, None);
        assert_eq!(view.allowed_secrets, ["OPENAI_API_KEY"]);
        assert_ne!(
            view.command_line.as_ref(),
            Some(&approved),
            "the removed descriptor's discovery is not shown for the shipped agent"
        );
        assert!(matches!(
            upgraded.remove(upgraded.revision(), opencode),
            Err(RegistryError::BuiltIn)
        ));
        let reopened = shipped_registry(&root, &[shipped_opencode()]);
        assert_eq!(
            reopened.view(opencode).map(|view| view.source),
            Some(AgentSource::BuiltIn)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn version_gate_refuses_only_older() {
        let report = |status| AcpVersionReport {
            version: Some("1.0.0".into()),
            status,
        };
        for status in [
            AcpVersionStatus::Verified,
            AcpVersionStatus::NoVerifiedRange,
            AcpVersionStatus::Newer,
            AcpVersionStatus::Unrecognized,
            AcpVersionStatus::ProbeFailed,
        ] {
            assert_eq!(version_gate(&report(status)), Ok(()), "{status:?}");
        }
        assert_eq!(
            version_gate(&report(AcpVersionStatus::Older)),
            Err(AcpRefusal::UnsupportedVersion)
        );
        assert_eq!(
            version_gate(&AcpVersionReport {
                version: None,
                status: AcpVersionStatus::ProbeFailed
            }),
            Ok(())
        );
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
    fn the_shipped_catalog_is_listed_in_order_trusted_and_unchecked() {
        let root = root("catalog");
        let registry = AcpAgents::open(&root).expect("registry");
        let views = registry.views();
        assert_eq!(
            views
                .iter()
                .map(|view| view.descriptor.id.as_str())
                .collect::<Vec<_>>(),
            [
                "gemini-cli",
                "opencode",
                "qwen-code",
                "github-copilot",
                "goose",
                "kimi",
                "cursor"
            ]
        );
        for view in &views {
            assert_eq!(view.source, AgentSource::BuiltIn);
            assert!(view.trusted);
            assert_eq!(view.state, HarnessState::Checking);
            assert!(view.descriptor.version.verified.is_none());
        }
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
