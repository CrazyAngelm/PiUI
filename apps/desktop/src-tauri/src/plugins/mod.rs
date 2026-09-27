//! Plugins v1 host (ADR-032).
//!
//! A plugin is installed from a folder or a `.zip` the user picks, or loaded
//! unpacked for development. The host validates the package
//! (`piui_plugins`), shows a trust review, and only after the user confirms
//! it copies the package into application data (never into a project) and
//! records the trusted code hash, permissions and backend entry. At start-up
//! every package is verified again off the first-paint path: a changed
//! installed package, a development plugin whose permissions changed, or an
//! incompatible engine range leaves the plugin listed but inactive. Safe mode
//! lists plugins read-only and activates none.
//!
//! Active plugins contribute commands, settings, sandboxed panels (served by
//! [`protocol`]), themes, templates, node types (run by the scheduler through
//! [`supervisor`]) and ACP agents (trusted in Settings → Harnesses).

pub(crate) mod api;
mod protocol;
mod registry;
mod supervisor;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use piui_plugins::csp::content_type;
use piui_plugins::fields::{carry_values, resolve_values};
use piui_plugins::manifest::ProblemCode;
use piui_plugins::package::{read_archive, read_folder, resolve_inside, write_package};
use piui_plugins::{Field, Permission, PluginManifest, Problem, ValidatedManifest, validate_files};
use piui_runtime::acp::AcpAgentId;
use serde_json::{Map, Value};

use crate::acp_agents::{AcpAgents, PluginAgent};
pub(crate) use api::{emit_changed, start_verification};
pub(crate) use protocol::handle_request as handle_protocol_request;
use registry::{Registry, StoredPlugin, StoredSource, ThemeRef, TransactError};
pub(crate) use supervisor::{BackendSpec, CallError, StartFailure};
use supervisor::{LogEvent, Supervisor};

pub(crate) const PLUGINS_EVENT: &str = "piui://plugins-v1";
const DIRECTORY: &str = "plugins-v1";
const STAGING_TTL: Duration = Duration::from_secs(30 * 60);
/// Most plugins installed or loaded at once.
pub(crate) const MAX_PLUGINS: usize = 64;
/// How long `command/execute` may take.
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a plugin operation is refused. The API maps it to a typed error.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PluginsError {
    SafeMode,
    Conflict,
    Invalid(Vec<Problem>),
    Incompatible(String),
    Duplicate,
    NotFound,
    ReviewExpired,
    TrustChanged,
    Inactive,
    PermissionDenied,
    InvalidSettings(&'static str, String),
    Limit,
    Io,
}

impl<E> From<TransactError<E>> for PluginsError
where
    PluginsError: From<E>,
{
    fn from(error: TransactError<E>) -> Self {
        match error {
            TransactError::Conflict => Self::Conflict,
            TransactError::Io => Self::Io,
            TransactError::Rejected(error) => error.into(),
        }
    }
}

/// A package that was read; `problems` keep it inactive.
#[derive(Clone, Debug)]
pub(crate) struct Package {
    pub manifest: ValidatedManifest,
    pub code_hash: String,
    pub problems: Vec<Problem>,
}

#[derive(Clone, Debug)]
struct Loaded {
    root: PathBuf,
    outcome: Result<Package, Vec<Problem>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReviewSource {
    Folder,
    Zip,
    Development,
}

/// A validated package waiting for the user's decision.
#[derive(Clone, Debug)]
pub(crate) struct Staged {
    pub source: ReviewSource,
    pub location: PathBuf,
    /// The staging copy (installs); a development plugin stays in place.
    directory: Option<PathBuf>,
    pub package: Package,
    pub files: usize,
    pub bytes: u64,
    /// The data folder a new plugin gets, named before the review so the
    /// review shows the exact backend command line.
    data_directory: String,
    created: Instant,
}

struct State {
    registry: Registry,
    loaded: HashMap<String, Loaded>,
    checked: bool,
    staged: HashMap<String, Staged>,
    /// Plugin id → its ACP agents and whether each was registered.
    acp: HashMap<String, Vec<(AcpAgentId, bool)>>,
}

struct Inner {
    root: PathBuf,
    safe_mode: bool,
    piui_version: String,
    state: Mutex<State>,
    supervisor: Supervisor,
}

/// Managed Tauri state of the plugin host.
#[derive(Clone)]
pub(crate) struct PluginsState {
    inner: Arc<Inner>,
}

fn now_string() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn sorted(permissions: &[Permission]) -> Vec<Permission> {
    let mut permissions = permissions.to_vec();
    permissions.sort();
    permissions.dedup();
    permissions
}

/// The permissions and backend a stored decision must still match.
fn trusted_shape(manifest: &PluginManifest) -> (Vec<Permission>, Option<String>) {
    (
        sorted(&manifest.permissions),
        manifest.backend.as_ref().map(|entry| entry.entry.clone()),
    )
}

impl PluginsState {
    /// Opens the registry. Packages are verified later by [`Self::verify`].
    pub(crate) fn open(
        app_data_dir: &Path,
        safe_mode: bool,
        piui_version: &str,
    ) -> std::io::Result<Self> {
        let root = app_data_dir.join(DIRECTORY);
        fs::create_dir_all(&root)?;
        let registry = Registry::open(&root)?;
        // Reviews never survive a restart.
        let staging = root.join("staging");
        let _ = fs::remove_dir_all(&staging);
        Ok(Self {
            inner: Arc::new(Inner {
                root,
                safe_mode,
                piui_version: piui_version.to_owned(),
                state: Mutex::new(State {
                    registry,
                    loaded: HashMap::new(),
                    checked: false,
                    staged: HashMap::new(),
                    acp: HashMap::new(),
                }),
                supervisor: Supervisor::new(),
            }),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, State>, PluginsError> {
        self.inner.state.lock().map_err(|_| PluginsError::Io)
    }

    pub(crate) fn safe_mode(&self) -> bool {
        self.inner.safe_mode
    }

    pub(crate) fn piui_version(&self) -> &str {
        &self.inner.piui_version
    }

    pub(crate) fn supervisor(&self) -> &Supervisor {
        &self.inner.supervisor
    }

    pub(crate) fn revision(&self) -> u64 {
        self.lock().map_or(0, |state| state.registry.revision())
    }

    fn package_root(&self, stored: &StoredPlugin) -> PathBuf {
        match &stored.source {
            StoredSource::Installed { directory } => {
                self.inner.root.join("packages").join(directory)
            }
            StoredSource::Development { folder } => folder.clone(),
        }
    }

    fn data_dir(&self, stored: &StoredPlugin) -> PathBuf {
        self.data_folder(&stored.data_directory)
    }

    fn data_folder(&self, directory: &str) -> PathBuf {
        self.inner.root.join("data").join(directory)
    }

    /// The data folder a staged package will use: the installed plugin's,
    /// or the one named for this review.
    pub(crate) fn staged_data_dir(&self, staged: &Staged) -> PathBuf {
        let manifest = &staged.package.manifest.manifest;
        self.stored(&manifest.id).map_or_else(
            || self.data_folder(&staged.data_directory),
            |stored| self.data_dir(&stored),
        )
    }

    /// The data folder of an installed or loaded plugin (display).
    pub(crate) fn plugin_data_dir(&self, stored: &StoredPlugin) -> PathBuf {
        self.data_dir(stored)
    }

    /// Reads and checks one stored plugin's package. Blocking.
    fn load(&self, stored: &StoredPlugin) -> Loaded {
        let root = self.package_root(stored);
        let outcome = read_folder(&root)
            .and_then(|files| validate_files(files, &self.inner.piui_version))
            .map(|package| {
                let mut problems = Vec::new();
                let manifest = &package.manifest.manifest;
                if manifest.id != stored.id {
                    problems.push(Problem::new(
                        ProblemCode::Integrity,
                        "The plugin's files no longer match what you trusted. Install it again.",
                    ));
                } else if matches!(stored.source, StoredSource::Installed { .. })
                    && package.code_hash != stored.code_hash
                {
                    problems.push(Problem::new(
                        ProblemCode::Integrity,
                        "The installed files changed since you trusted them. Install the plugin again.",
                    ));
                } else if trusted_shape(manifest)
                    != (sorted(&stored.permissions), stored.backend_entry.clone())
                {
                    problems.push(Problem::new(
                        ProblemCode::Integrity,
                        "The plugin's permissions or backend changed since you trusted it. Reload it to review the change.",
                    ));
                }
                if !package.manifest.compatible {
                    problems.push(Problem::about(
                        ProblemCode::EngineMismatch,
                        "This plugin needs PiUI {0}.",
                        manifest.engines.piui.clone(),
                    ));
                }
                Package {
                    code_hash: package.code_hash,
                    manifest: package.manifest,
                    problems,
                }
            });
        Loaded { root, outcome }
    }

    /// Verifies every stored package (blocking; off the first-paint path),
    /// then registers the ACP agents of active plugins.
    pub(crate) fn verify(&self, acp: &AcpAgents) {
        let stored = match self.lock() {
            Ok(state) => state.registry.document.plugins.clone(),
            Err(_) => return,
        };
        let loaded = stored
            .iter()
            .map(|plugin| (plugin.id.clone(), self.load(plugin)))
            .collect::<Vec<_>>();
        if let Ok(mut state) = self.lock() {
            for (id, loaded) in loaded {
                let failed = match &loaded.outcome {
                    Ok(package) => !package.problems.is_empty(),
                    Err(_) => true,
                };
                if failed {
                    self.inner
                        .supervisor
                        .record(&id, LogEvent::VerificationFailed);
                }
                state.loaded.insert(id, loaded);
            }
            state.checked = true;
        }
        self.sync_acp(acp);
    }

    /// Pushes the ACP agents of active plugins to the harness registry.
    pub(crate) fn sync_acp(&self, acp: &AcpAgents) {
        let agents = if self.inner.safe_mode {
            Vec::new()
        } else {
            self.active_packages()
                .into_iter()
                .filter(|(_, package, _)| package.manifest.manifest.has(Permission::AcpAgents))
                .flat_map(|(stored, package, _)| {
                    package
                        .manifest
                        .acp_agents
                        .iter()
                        .map(|descriptor| PluginAgent {
                            plugin_id: stored.id.clone(),
                            plugin_name: stored.name.clone(),
                            descriptor: descriptor.clone(),
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        };
        let report = acp.set_plugin_agents(agents);
        if let Ok(mut state) = self.lock() {
            state.acp.clear();
            for (plugin, agent, registered) in report {
                state
                    .acp
                    .entry(plugin)
                    .or_default()
                    .push((agent, registered));
            }
        }
    }

    /// Active plugins: enabled, verified without problems, outside safe mode.
    fn active_packages(&self) -> Vec<(StoredPlugin, Package, PathBuf)> {
        if self.inner.safe_mode {
            return Vec::new();
        }
        let Ok(state) = self.lock() else {
            return Vec::new();
        };
        state
            .registry
            .document
            .plugins
            .iter()
            .filter(|stored| stored.enabled)
            .filter_map(|stored| {
                let loaded = state.loaded.get(&stored.id)?;
                let package = loaded.outcome.as_ref().ok()?;
                package
                    .problems
                    .is_empty()
                    .then(|| (stored.clone(), package.clone(), loaded.root.clone()))
            })
            .collect()
    }

    /// One active plugin with its package and folder.
    pub(crate) fn active(
        &self,
        id: &str,
    ) -> Result<(StoredPlugin, Package, PathBuf), PluginsError> {
        if self.inner.safe_mode {
            return Err(PluginsError::SafeMode);
        }
        self.active_packages()
            .into_iter()
            .find(|(stored, _, _)| stored.id == id)
            .ok_or(PluginsError::Inactive)
    }

    /// The backend of an active plugin, with resolved settings.
    pub(crate) fn backend_spec(
        &self,
        stored: &StoredPlugin,
        package: &Package,
        root: &Path,
    ) -> Option<BackendSpec> {
        let manifest = &package.manifest.manifest;
        let entry = resolve_inside(root, &manifest.backend.as_ref()?.entry)?;
        let settings = resolve_values(&manifest.contributes.settings, &stored.settings)
            .unwrap_or_else(|_| {
                resolve_values(&manifest.contributes.settings, &Map::new()).unwrap_or_default()
            });
        Some(BackendSpec {
            plugin_id: stored.id.clone(),
            version: stored.version.clone(),
            root: root.to_path_buf(),
            entry,
            permissions: sorted(&manifest.permissions),
            settings,
            data_dir: self.data_dir(stored),
            piui_version: self.inner.piui_version.clone(),
        })
    }

    /// A node type ready to run: the plugin is active, asks for `node.run`,
    /// declares the node type and has a backend.
    pub(crate) fn node_spec(&self, plugin_id: &str, node_type: &str) -> Option<NodeSpec> {
        let (stored, package, root) = self.active(plugin_id).ok()?;
        let manifest = &package.manifest.manifest;
        if !manifest.has(Permission::NodeRun) {
            return None;
        }
        let node = manifest.node_type(node_type)?;
        Some(NodeSpec {
            fields: node.config().to_vec(),
            timeout: Duration::from_secs(u64::from(node.timeout_seconds())),
            project_access: manifest.has(Permission::ProjectRead)
                || manifest.has(Permission::ProjectWrite),
            backend: self.backend_spec(&stored, &package, &root)?,
        })
    }

    /// Reads a file a panel or chat renderer may load. `path` is relative to
    /// the package and must be inside the folder of `ui.entry`. Blocking.
    pub(crate) fn panel_file(&self, id: &str, path: &str) -> Option<PanelFile> {
        let (_, package, root) = self.active(id).ok()?;
        let manifest = &package.manifest.manifest;
        if !manifest.has(Permission::UiPanel) && !manifest.has(Permission::UiRenderer) {
            return None;
        }
        let entry = &manifest.ui.as_ref()?.entry;
        let folder = entry.rsplit_once('/').map(|(folder, _)| folder);
        if let Some(folder) = folder
            && !path
                .strip_prefix(folder)
                .is_some_and(|rest| rest.starts_with('/'))
        {
            return None;
        }
        let kind = content_type(path)?;
        let file = resolve_inside(&root, path)?;
        let metadata = fs::symlink_metadata(&file).ok()?;
        if !metadata.is_file() || metadata.len() > piui_plugins::package::MAX_FILE_BYTES {
            return None;
        }
        let bytes = fs::read(&file).ok()?;
        Some(PanelFile {
            bytes,
            content_type: kind,
            html: path.to_ascii_lowercase().ends_with(".html"),
            base: piui_plugins::csp::ui_base(id, entry),
        })
    }

    /// Marks the host as exiting and ends every backend tree.
    pub(crate) fn begin_shutdown(&self) {
        self.inner.supervisor.shutdown_all();
    }

    fn stage_directory(&self) -> PathBuf {
        self.inner
            .root
            .join("staging")
            .join(uuid::Uuid::new_v4().to_string())
    }

    /// Validates a picked package and keeps it for review. Blocking.
    pub(crate) fn stage(
        &self,
        source: ReviewSource,
        location: &Path,
    ) -> Result<(String, Staged), PluginsError> {
        let files = match source {
            ReviewSource::Zip => read_archive(location),
            ReviewSource::Folder | ReviewSource::Development => read_folder(location),
        }
        .map_err(PluginsError::Invalid)?;
        let validated =
            validate_files(files, &self.inner.piui_version).map_err(PluginsError::Invalid)?;
        let manifest = &validated.manifest.manifest;
        if !validated.manifest.compatible {
            return Err(PluginsError::Incompatible(manifest.engines.piui.clone()));
        }
        {
            let state = self.lock()?;
            let existing = state.registry.document.plugin(&manifest.id);
            let development = source == ReviewSource::Development;
            match existing {
                Some(stored)
                    if matches!(stored.source, StoredSource::Development { .. }) != development =>
                {
                    return Err(PluginsError::Duplicate);
                }
                None if state.registry.document.plugins.len() >= MAX_PLUGINS => {
                    return Err(PluginsError::Limit);
                }
                _ => {}
            }
        }
        let directory = match source {
            ReviewSource::Development => None,
            ReviewSource::Folder | ReviewSource::Zip => {
                let directory = self.stage_directory();
                write_package(&directory, &validated.files).map_err(|_| {
                    let _ = fs::remove_dir_all(&directory);
                    PluginsError::Io
                })?;
                Some(directory)
            }
        };
        let staged = Staged {
            source,
            location: location.to_path_buf(),
            directory,
            files: validated.files.len(),
            bytes: validated.bytes,
            data_directory: uuid::Uuid::new_v4().to_string(),
            package: Package {
                code_hash: validated.code_hash,
                manifest: validated.manifest,
                problems: Vec::new(),
            },
            created: Instant::now(),
        };
        let id = uuid::Uuid::new_v4().to_string();
        let mut state = self.lock()?;
        let expired = state
            .staged
            .iter()
            .filter(|(_, staged)| staged.created.elapsed() > STAGING_TTL)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(directory) = state.staged.remove(&id).and_then(|staged| staged.directory) {
                let _ = fs::remove_dir_all(directory);
            }
        }
        state.staged.insert(id.clone(), staged.clone());
        Ok((id, staged))
    }

    /// The plugin id a review is for.
    pub(crate) fn staged_plugin_id(&self, staging_id: &str) -> Option<String> {
        self.lock()
            .ok()?
            .staged
            .get(staging_id)
            .map(|staged| staged.package.manifest.manifest.id.clone())
    }

    /// Drops a review and its staging copy.
    pub(crate) fn discard(&self, staging_id: &str) {
        let staged = self
            .lock()
            .ok()
            .and_then(|mut state| state.staged.remove(staging_id));
        if let Some(directory) = staged.and_then(|staged| staged.directory) {
            let _ = fs::remove_dir_all(directory);
        }
    }

    /// The stored plugin a review would update, if any.
    pub(crate) fn stored(&self, id: &str) -> Option<StoredPlugin> {
        self.lock().ok()?.registry.document.plugin(id).cloned()
    }

    /// The exact backend command line of a package in `root` with its data
    /// folder, and what Node's permission model enforces with the Node.js
    /// PiUI found (display). Project folders are added per request and are
    /// not part of it. `probe` asks Node.js when it was not asked yet
    /// (blocking); otherwise only a cached answer is used.
    pub(crate) fn backend_display(
        manifest: &PluginManifest,
        root: &Path,
        data_dir: &Path,
        probe: bool,
    ) -> Option<BackendDisplay> {
        use piui_runtime::plugin_backend::{
            NodePermissionSupport, cached_node_permissions, permission_arguments,
            probe_node_permissions, resolve_plugin_node,
        };
        let entry = resolve_inside(root, &manifest.backend.as_ref()?.entry)?;
        let node = resolve_plugin_node().ok();
        let support = node.as_deref().and_then(|node| {
            if probe {
                probe_node_permissions(node).ok()
            } else {
                cached_node_permissions(node)
            }
        });
        let spec = BackendSpec {
            plugin_id: manifest.id.clone(),
            version: manifest.version.clone(),
            root: root.to_path_buf(),
            entry: entry.clone(),
            permissions: sorted(&manifest.permissions),
            settings: Map::new(),
            data_dir: data_dir.to_path_buf(),
            piui_version: String::new(),
        };
        // Until Node.js answered, show the flags a current Node.js gets.
        let planned = support.clone().unwrap_or(NodePermissionSupport {
            version: String::new(),
            permission: true,
            network: false,
        });
        let mut args = permission_arguments(
            &NodePermissionSupport {
                permission: true,
                ..planned
            },
            &spec.grants(&[]),
        )
        .map(|flags| {
            flags
                .as_slice()
                .iter()
                .map(|flag| flag.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
        args.push(
            piui_runtime::script_runner::process_directory(&entry)
                .to_string_lossy()
                .into_owned(),
        );
        Some(BackendDisplay {
            command_line: crate::acp_agents::CommandLine {
                program: node.as_ref().map_or_else(
                    || "node".to_owned(),
                    |node| node.to_string_lossy().into_owned(),
                ),
                args,
            },
            node_found: node.is_some(),
            limits: support.map(|support| BackendLimits {
                node_version: support.version,
                enforced: support.permission,
                network: support.permission && support.network,
            }),
        })
    }

    /// Where a staged package will run from once installed.
    pub(crate) fn install_root(&self, staged: &Staged) -> PathBuf {
        match staged.source {
            ReviewSource::Development => staged.location.clone(),
            ReviewSource::Folder | ReviewSource::Zip => staged
                .directory
                .as_ref()
                .and_then(|directory| directory.file_name())
                .map_or_else(
                    || self.inner.root.join("packages"),
                    |name| self.inner.root.join("packages").join(name),
                ),
        }
    }

    /// Installs (or updates, or loads for development) a reviewed package.
    /// Blocking; the caller stops a running backend of the same id first.
    pub(crate) fn install(
        &self,
        expected_revision: u64,
        staging_id: &str,
        code_hash: &str,
    ) -> Result<(String, bool), PluginsError> {
        let staged = {
            let mut state = self.lock()?;
            let staged = state
                .staged
                .remove(staging_id)
                .ok_or(PluginsError::ReviewExpired)?;
            if staged.created.elapsed() > STAGING_TTL {
                if let Some(directory) = &staged.directory {
                    let _ = fs::remove_dir_all(directory);
                }
                return Err(PluginsError::ReviewExpired);
            }
            staged
        };
        let discard = |staged: &Staged| {
            if let Some(directory) = &staged.directory {
                let _ = fs::remove_dir_all(directory);
            }
        };
        if staged.package.code_hash != code_hash {
            discard(&staged);
            return Err(PluginsError::TrustChanged);
        }
        // Read the files again: what installs is exactly what was reviewed.
        let source_root = staged
            .directory
            .clone()
            .unwrap_or_else(|| staged.location.clone());
        let again = read_folder(&source_root)
            .and_then(|files| validate_files(files, &self.inner.piui_version));
        let manifest = staged.package.manifest.manifest.clone();
        let unchanged = again.as_ref().is_ok_and(|package| match staged.source {
            ReviewSource::Development => {
                package.manifest.manifest.id == manifest.id
                    && trusted_shape(&package.manifest.manifest) == trusted_shape(&manifest)
            }
            ReviewSource::Folder | ReviewSource::Zip => {
                package.code_hash == staged.package.code_hash
            }
        });
        if !unchanged {
            discard(&staged);
            return Err(PluginsError::TrustChanged);
        }
        let installed_root = self.install_root(&staged);
        let source = match staged.source {
            ReviewSource::Development => StoredSource::Development {
                folder: staged.location.clone(),
            },
            ReviewSource::Folder | ReviewSource::Zip => {
                let directory = installed_root
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
                    .ok_or(PluginsError::Io)?;
                fs::create_dir_all(self.inner.root.join("packages"))
                    .map_err(|_| PluginsError::Io)?;
                fs::rename(&source_root, &installed_root).map_err(|_| {
                    discard(&staged);
                    PluginsError::Io
                })?;
                StoredSource::Installed { directory }
            }
        };
        let previous = self.stored(&manifest.id);
        let updated = previous.is_some();
        let (permissions, backend_entry) = trusted_shape(&manifest);
        let record = StoredPlugin {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            publisher: manifest.publisher.clone(),
            version: manifest.version.clone(),
            source,
            code_hash: staged.package.code_hash.clone(),
            permissions,
            backend_entry,
            enabled: true,
            installed_at: now_string(),
            data_directory: previous.as_ref().map_or_else(
                || staged.data_directory.clone(),
                |stored| stored.data_directory.clone(),
            ),
            settings: previous
                .as_ref()
                .map(|stored| carry_values(&manifest.contributes.settings, &stored.settings))
                .unwrap_or_default(),
        };
        let committed = {
            let mut state = self.lock()?;
            let plugin_count = state.registry.document.plugins.len();
            state
                .registry
                .transact(Some(expected_revision), |document| {
                    match document.plugin_mut(&record.id) {
                        Some(existing) => *existing = record.clone(),
                        None if plugin_count >= MAX_PLUGINS => return Err(PluginsError::Limit),
                        None => document.plugins.push(record.clone()),
                    }
                    Ok::<(), PluginsError>(())
                })
        };
        if let Err(error) = committed {
            if matches!(record.source, StoredSource::Installed { .. }) {
                let _ = fs::remove_dir_all(&installed_root);
            }
            return Err(error.into());
        }
        // The previous installed copy is no longer referenced.
        if let Some(StoredPlugin {
            source: StoredSource::Installed { directory },
            ..
        }) = &previous
            && !matches!(&record.source, StoredSource::Installed { directory: current } if current == directory)
        {
            let _ = fs::remove_dir_all(self.inner.root.join("packages").join(directory));
        }
        let loaded = self.load(&record);
        if let Ok(mut state) = self.lock() {
            state.loaded.insert(record.id.clone(), loaded);
        }
        self.inner.supervisor.record(
            &record.id,
            if updated {
                LogEvent::Updated
            } else {
                LogEvent::Installed
            },
        );
        Ok((record.id, updated))
    }

    pub(crate) fn set_enabled(
        &self,
        expected_revision: u64,
        id: &str,
        enabled: bool,
    ) -> Result<(), PluginsError> {
        let mut state = self.lock()?;
        state
            .registry
            .transact(Some(expected_revision), |document| {
                let plugin = document.plugin_mut(id).ok_or(PluginsError::NotFound)?;
                plugin.enabled = enabled;
                Ok::<(), PluginsError>(())
            })?;
        drop(state);
        self.inner.supervisor.record(
            id,
            if enabled {
                LogEvent::Enabled
            } else {
                LogEvent::Disabled
            },
        );
        Ok(())
    }

    /// Forgets a plugin and deletes the copy PiUI owns and its data folder.
    /// A development folder is never touched. Blocking.
    pub(crate) fn remove(&self, expected_revision: u64, id: &str) -> Result<(), PluginsError> {
        let removed = {
            let mut state = self.lock()?;
            let stored = state
                .registry
                .document
                .plugin(id)
                .cloned()
                .ok_or(PluginsError::NotFound)?;
            state
                .registry
                .transact(Some(expected_revision), |document| {
                    document.plugins.retain(|plugin| plugin.id != id);
                    if document
                        .active_theme
                        .as_ref()
                        .is_some_and(|theme| theme.plugin_id == id)
                    {
                        document.active_theme = None;
                    }
                    Ok::<(), PluginsError>(())
                })?;
            state.loaded.remove(id);
            stored
        };
        if let StoredSource::Installed { directory } = &removed.source {
            let _ = fs::remove_dir_all(self.inner.root.join("packages").join(directory));
        }
        let _ = fs::remove_dir_all(self.data_dir(&removed));
        Ok(())
    }

    /// Reads a development plugin's folder again. When its permissions or
    /// backend changed, it stays inactive and a review is returned. Blocking.
    pub(crate) fn reload(&self, id: &str) -> Result<Option<(String, Staged)>, PluginsError> {
        let stored = self.stored(id).ok_or(PluginsError::NotFound)?;
        let StoredSource::Development { folder } = &stored.source else {
            return Err(PluginsError::NotFound);
        };
        let loaded = self.load(&stored);
        let needs_review = loaded.outcome.as_ref().is_ok_and(|package| {
            package
                .problems
                .iter()
                .any(|problem| problem.code == ProblemCode::Integrity)
        });
        if let Ok(mut state) = self.lock() {
            state.loaded.insert(id.to_owned(), loaded);
        }
        self.inner.supervisor.record(id, LogEvent::Reloaded);
        if needs_review {
            return self.stage(ReviewSource::Development, folder).map(Some);
        }
        Ok(None)
    }

    /// Replaces the values `values` names, checked against the declared
    /// settings. Returns the resolved settings. Blocking.
    pub(crate) fn set_settings(
        &self,
        expected_revision: u64,
        id: &str,
        values: &Map<String, Value>,
        from_panel: bool,
    ) -> Result<Map<String, Value>, PluginsError> {
        let (stored, package, _) = self.active(id)?;
        let manifest = &package.manifest.manifest;
        if from_panel && !manifest.has(Permission::UiSettings) {
            return Err(PluginsError::PermissionDenied);
        }
        let mut merged = stored.settings.clone();
        for (key, value) in values {
            merged.insert(key.clone(), value.clone());
        }
        let resolved = resolve_values(&manifest.contributes.settings, &merged)
            .map_err(|(issue, key)| PluginsError::InvalidSettings(issue.message(), key))?;
        let mut state = self.lock()?;
        state
            .registry
            .transact(Some(expected_revision), |document| {
                let plugin = document.plugin_mut(id).ok_or(PluginsError::NotFound)?;
                plugin.settings = merged.clone();
                Ok::<(), PluginsError>(())
            })?;
        Ok(resolved)
    }

    pub(crate) fn set_theme(
        &self,
        expected_revision: u64,
        theme: Option<(String, String)>,
    ) -> Result<(), PluginsError> {
        if let Some((plugin_id, theme_id)) = &theme {
            let (_, package, _) = self.active(plugin_id)?;
            if !package
                .manifest
                .manifest
                .contributes
                .themes
                .iter()
                .any(|candidate| candidate.id == *theme_id)
            {
                return Err(PluginsError::NotFound);
            }
        } else if self.inner.safe_mode {
            return Err(PluginsError::SafeMode);
        }
        let mut state = self.lock()?;
        state
            .registry
            .transact(Some(expected_revision), |document| {
                document.active_theme = theme.map(|(plugin_id, theme_id)| ThemeRef {
                    plugin_id,
                    theme_id,
                });
                Ok::<(), PluginsError>(())
            })?;
        Ok(())
    }

    /// The text of a template of an active plugin. Blocking.
    pub(crate) fn template(&self, id: &str, template_id: &str) -> Result<String, PluginsError> {
        let (_, package, root) = self.active(id)?;
        let template = package
            .manifest
            .manifest
            .contributes
            .templates
            .iter()
            .find(|template| template.id == template_id)
            .ok_or(PluginsError::NotFound)?;
        let path = resolve_inside(&root, &template.file).ok_or(PluginsError::NotFound)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| PluginsError::NotFound)?;
        if !metadata.is_file()
            || metadata.len()
                > u64::try_from(piui_plugins::package::MAX_TEMPLATE_BYTES).unwrap_or(u64::MAX)
        {
            return Err(PluginsError::NotFound);
        }
        let bytes = fs::read(&path).map_err(|_| PluginsError::Io)?;
        String::from_utf8(bytes).map_err(|_| PluginsError::NotFound)
    }

    /// A snapshot for building the registry view.
    pub(crate) fn snapshot(&self) -> Result<RegistrySnapshot, PluginsError> {
        let state = self.lock()?;
        Ok(RegistrySnapshot {
            revision: state.registry.revision(),
            checked: state.checked,
            active_theme: state.registry.document.active_theme.clone(),
            plugins: state
                .registry
                .document
                .plugins
                .iter()
                .map(|stored| SnapshotPlugin {
                    stored: stored.clone(),
                    loaded: state
                        .loaded
                        .get(&stored.id)
                        .map(|loaded| (loaded.root.clone(), loaded.outcome.clone())),
                    acp: state.acp.get(&stored.id).cloned().unwrap_or_default(),
                })
                .collect(),
        })
    }
}

/// What Node's permission model enforces for a backend (display).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendLimits {
    /// `node --version` of the Node.js PiUI found.
    pub node_version: String,
    /// Files, other programs, worker threads and add-ons are limited. False:
    /// this Node.js has no permission model and PiUI does not start the
    /// backend.
    pub enforced: bool,
    /// Network access is blocked unless the plugin asks for `network`.
    pub network: bool,
}

/// The backend command line and its limits (display).
pub(crate) struct BackendDisplay {
    pub command_line: crate::acp_agents::CommandLine,
    pub node_found: bool,
    /// Absent until Node.js was asked (off the first-paint path).
    pub limits: Option<BackendLimits>,
}

/// A runnable node type of an active plugin.
#[derive(Clone, Debug)]
pub(crate) struct NodeSpec {
    pub fields: Vec<Field>,
    pub timeout: Duration,
    /// The plugin asks for `project.read` or `project.write`.
    pub project_access: bool,
    pub backend: BackendSpec,
}

/// A file a panel loads.
pub(crate) struct PanelFile {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    pub html: bool,
    /// The URL path of the plugin's UI folder (`<id>/<folder>/`).
    pub base: String,
}

pub(crate) struct SnapshotPlugin {
    pub stored: StoredPlugin,
    pub loaded: Option<(PathBuf, Result<Package, Vec<Problem>>)>,
    pub acp: Vec<(AcpAgentId, bool)>,
}

pub(crate) struct RegistrySnapshot {
    pub revision: u64,
    pub checked: bool,
    pub active_theme: Option<ThemeRef>,
    pub plugins: Vec<SnapshotPlugin>,
}
