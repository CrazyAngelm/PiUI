//! `plugins_v1`, `plugin_command_v1` and `plugin_template_v1`
//! (`contracts/plugins-v1.ts`). Commands reject unknown fields; every change
//! names the registry revision; safe mode lists read-only. The WebView never
//! sends a path: the host opens the native picker.

use std::collections::BTreeMap;

use piui_plugins::csp::plugin_origin;
use piui_plugins::fields::resolve_values;
use piui_plugins::manifest::{
    Appearance, CommandSurface, NodeResultField, PanelLocation, Problem, ProblemCode,
    StatusAlignment,
};
use piui_plugins::{Field, Permission};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::supervisor::{BackendState, LogEntry};
use super::{
    BackendLimits, COMMAND_TIMEOUT, CallError, Package, PluginsError, PluginsState, ReviewSource,
    Staged, StartFailure,
};
use crate::acp_agents::CommandLine;
use crate::state::HostState;

const PROTOCOL: u8 = 1;
const MAX_COMMAND_TEXT_BYTES: usize = 16 * 1024;
const MAX_NOTICE_CHARS: usize = 500;
const MAX_DETAIL_BYTES: usize = 2 * 1024;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PickSource {
    Folder,
    Zip,
    Development,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SettingsOrigin {
    Settings,
    Panel,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeRefDto {
    pub plugin_id: String,
    pub theme_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PluginsCommand {
    List {},
    Pick {
        source: PickSource,
    },
    Install {
        expected_revision: u64,
        staging_id: String,
        code_hash: String,
    },
    Discard {
        staging_id: String,
    },
    SetEnabled {
        expected_revision: u64,
        id: String,
        enabled: bool,
    },
    Remove {
        expected_revision: u64,
        id: String,
    },
    Reload {
        expected_revision: u64,
        id: String,
    },
    RestartBackend {
        id: String,
    },
    SetSettings {
        expected_revision: u64,
        id: String,
        values: Map<String, Value>,
        #[serde(default)]
        origin: Option<SettingsOrigin>,
    },
    SetTheme {
        expected_revision: u64,
        theme: Option<ThemeRefDto>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDto {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub surfaces: Vec<CommandSurface>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insert_text: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelDto {
    pub id: String,
    pub title: String,
    pub location: PanelLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDto {
    pub id: String,
    pub label: String,
    pub appearance: Appearance,
    pub tokens: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDto {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeTypeDto {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub config: Vec<Field>,
    pub timeout_seconds: u32,
    pub result_fields: Vec<NodeResultField>,
}

/// A status-bar item (v1.1).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusItemDto {
    pub id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub alignment: StatusAlignment,
}

/// A keybinding for one of the plugin's commands (v1.1).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingDto {
    pub command: String,
    pub key: String,
}

/// A chat renderer (v1.1); `url` only while the plugin is active.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererDto {
    pub id: String,
    pub title: String,
    pub tool_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentDto {
    pub id: String,
    pub display_name: String,
    pub registered: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributesDto {
    pub commands: Vec<CommandDto>,
    pub settings: Vec<Field>,
    pub panels: Vec<PanelDto>,
    pub themes: Vec<ThemeDto>,
    pub templates: Vec<TemplateDto>,
    pub node_types: Vec<NodeTypeDto>,
    pub acp_agents: Vec<AcpAgentDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub status_items: Vec<StatusItemDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keybindings: Vec<KeybindingDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub renderers: Vec<RendererDto>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendDto {
    pub state: BackendState,
    pub restarts: u32,
    pub command_line: CommandLine,
    pub node_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<BackendLimits>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntryDto {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub enabled: bool,
    pub active: bool,
    pub permissions: Vec<Permission>,
    pub code_hash: String,
    pub installed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendDto>,
    pub problems: Vec<Problem>,
    pub log: Vec<LogEntry>,
    pub contributes: ContributesDto,
    pub settings: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsRegistryDto {
    pub protocol: u8,
    pub revision: u64,
    pub safe_mode: bool,
    pub checked: bool,
    pub piui_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_theme: Option<ThemeRefDto>,
    pub plugins: Vec<PluginEntryDto>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBackendDto {
    pub command_line: CommandLine,
    pub node_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<BackendLimits>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAcpAgentDto {
    pub id: String,
    pub display_name: String,
    pub command_line: CommandLine,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewContributesDto {
    pub commands: Vec<String>,
    pub settings: usize,
    pub panels: Vec<String>,
    pub themes: Vec<String>,
    pub templates: Vec<String>,
    pub node_types: Vec<String>,
    pub acp_agents: Vec<ReviewAcpAgentDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub status_items: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keybindings: Vec<KeybindingDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub renderers: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDto {
    pub from_version: String,
    pub permissions_added: Vec<Permission>,
    pub permissions_removed: Vec<Permission>,
    pub code_changed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDto {
    pub staging_id: String,
    pub source: &'static str,
    pub location: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub permissions: Vec<Permission>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<ReviewBackendDto>,
    pub code_hash: String,
    pub files: usize,
    pub bytes: u64,
    pub contributes: ReviewContributesDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateDto>,
    pub already_installed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsResponse {
    pub registry: PluginsRegistryDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<Option<ReviewDto>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsErrorDto {
    pub code: &'static str,
    pub message: &'static str,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub problems: Vec<Problem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl PluginsErrorDto {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            recoverable: true,
            problems: Vec::new(),
            detail: None,
        }
    }
}

impl From<PluginsError> for PluginsErrorDto {
    fn from(error: PluginsError) -> Self {
        match error {
            PluginsError::SafeMode => Self::new(
                "SAFE_MODE",
                "Plugins cannot be changed or run in safe mode.",
            ),
            PluginsError::Conflict => Self::new(
                "CONFLICT",
                "The plugin list changed. Review it and try again.",
            ),
            PluginsError::Invalid(problems) => Self {
                problems,
                ..Self::new(
                    "INVALID_PACKAGE",
                    "This is not a valid PiUI plugin package.",
                )
            },
            PluginsError::Incompatible(range) => Self {
                problems: vec![Problem::about(
                    ProblemCode::EngineMismatch,
                    "This plugin needs PiUI {0}.",
                    range,
                )],
                ..Self::new(
                    "INCOMPATIBLE",
                    "This plugin does not support this PiUI version.",
                )
            },
            PluginsError::Duplicate => Self::new(
                "DUPLICATE",
                "A plugin with this ID is already installed another way. Remove it first.",
            ),
            PluginsError::NotFound => Self::new(
                "NOT_FOUND",
                "This plugin or its contribution no longer exists.",
            ),
            PluginsError::ReviewExpired => Self::new(
                "REVIEW_EXPIRED",
                "This review expired. Choose the package again.",
            ),
            PluginsError::TrustChanged => Self::new(
                "TRUST_CHANGED",
                "The package changed after you reviewed it. Review it again.",
            ),
            PluginsError::Inactive => Self::new(
                "INACTIVE",
                "This plugin is not active. Check it in Settings → Plugins.",
            ),
            PluginsError::PermissionDenied => Self::new(
                "PERMISSION_DENIED",
                "The plugin does not have permission for this.",
            ),
            PluginsError::InvalidSettings(message, key) => Self {
                problems: vec![Problem::about(ProblemCode::Field, message, key)],
                ..Self::new("INVALID_SETTINGS", "These settings are not valid.")
            },
            PluginsError::Limit => Self::new(
                "LIMIT",
                "Remove a plugin before adding another (64 at most).",
            ),
            PluginsError::Io => Self::new("IO_ERROR", "PiUI could not save the plugin list."),
        }
    }
}

fn call_error(error: CallError) -> PluginsErrorDto {
    match error {
        CallError::NotStarted(StartFailure::NodeMissing) => PluginsErrorDto::new(
            "BACKEND_UNAVAILABLE",
            "Node.js is needed to run this plugin's backend but was not found.",
        ),
        CallError::NotStarted(StartFailure::Backoff) => PluginsErrorDto::new(
            "BACKEND_UNAVAILABLE",
            "The plugin's backend stopped unexpectedly and restarts in a moment. Try again.",
        ),
        CallError::NotStarted(StartFailure::CrashLoop) => PluginsErrorDto::new(
            "BACKEND_UNAVAILABLE",
            "The plugin's backend keeps stopping. Restart it in Settings → Plugins.",
        ),
        CallError::NotStarted(StartFailure::Failed) => PluginsErrorDto::new(
            "BACKEND_UNAVAILABLE",
            "The plugin's backend could not start.",
        ),
        CallError::NotStarted(StartFailure::ShuttingDown) => {
            PluginsErrorDto::new("BACKEND_UNAVAILABLE", "PiUI is closing.")
        }
        CallError::NotStarted(StartFailure::NodeUnsupported) => PluginsErrorDto::new(
            "BACKEND_UNAVAILABLE",
            "This Node.js cannot limit plugin backends. Install Node.js 22.13 or later to run this plugin's backend.",
        ),
        CallError::NotStarted(StartFailure::Busy) => PluginsErrorDto::new(
            "BACKEND_UNAVAILABLE",
            "The plugin's backend is busy in another project. Try again when it finishes.",
        ),
        CallError::Remote(message) => PluginsErrorDto {
            detail: Some(plain_detail(&message)),
            ..PluginsErrorDto::new("BACKEND_FAILED", "The plugin reported an error.")
        },
        CallError::Lost => PluginsErrorDto::new(
            "BACKEND_FAILED",
            "The plugin's backend stopped before it answered.",
        ),
        CallError::Timeout | CallError::Cancelled => PluginsErrorDto::new(
            "BACKEND_TIMEOUT",
            "The plugin did not answer in time. Its backend was stopped.",
        ),
    }
}

/// A plugin's error text for display: no control characters, 2 KiB at most.
fn plain_detail(message: &str) -> String {
    let cleaned = message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let mut end = cleaned.len().min(MAX_DETAIL_BYTES);
    while !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    cleaned[..end].trim().to_owned()
}

fn contributes(
    id: &str,
    package: &Package,
    active: bool,
    acp: &[(piui_runtime::acp::AcpAgentId, bool)],
) -> ContributesDto {
    let manifest = &package.manifest.manifest;
    let contributes = &manifest.contributes;
    ContributesDto {
        commands: contributes
            .commands
            .iter()
            .map(|command| CommandDto {
                id: command.id.clone(),
                title: command.title.clone(),
                description: command.description.clone(),
                surfaces: command.surfaces(),
                insert_text: command.insert_text.clone(),
            })
            .collect(),
        settings: contributes.settings.clone(),
        panels: contributes
            .panels
            .iter()
            .map(|panel| PanelDto {
                id: panel.id.clone(),
                title: panel.title.clone(),
                location: panel.location,
                url: manifest
                    .ui
                    .as_ref()
                    .filter(|_| active && manifest.has(Permission::UiPanel))
                    .map(|ui| format!("{}/{id}/{}?panel={}", plugin_origin(), ui.entry, panel.id)),
            })
            .collect(),
        themes: contributes
            .themes
            .iter()
            .map(|theme| ThemeDto {
                id: theme.id.clone(),
                label: theme.label.clone(),
                appearance: theme.appearance,
                tokens: theme.tokens.clone(),
            })
            .collect(),
        templates: contributes
            .templates
            .iter()
            .map(|template| TemplateDto {
                id: template.id.clone(),
                title: template.title.clone(),
                description: template.description.clone(),
            })
            .collect(),
        node_types: contributes
            .node_types
            .iter()
            .map(|node| NodeTypeDto {
                id: node.id.clone(),
                title: node.title.clone(),
                description: node.description.clone(),
                config: node.config().to_vec(),
                timeout_seconds: node.timeout_seconds(),
                result_fields: node.result_fields.clone().unwrap_or_default(),
            })
            .collect(),
        acp_agents: package
            .manifest
            .acp_agents
            .iter()
            .map(|descriptor| AcpAgentDto {
                id: descriptor.id.to_string(),
                display_name: descriptor.display_name.clone(),
                registered: acp
                    .iter()
                    .any(|(agent, registered)| *agent == descriptor.id && *registered),
            })
            .collect(),
        status_items: contributes
            .status_items
            .iter()
            .map(|item| StatusItemDto {
                id: item.id.clone(),
                text: item.text.clone(),
                tooltip: item.tooltip.clone(),
                command: item.command.clone(),
                alignment: item.alignment.unwrap_or_default(),
            })
            .collect(),
        keybindings: contributes
            .keybindings
            .iter()
            .map(|binding| KeybindingDto {
                command: binding.command.clone(),
                key: binding.key.clone(),
            })
            .collect(),
        renderers: contributes
            .renderers
            .iter()
            .map(|renderer| RendererDto {
                id: renderer.id.clone(),
                title: renderer.title.clone(),
                tool_names: renderer.tool_names.clone(),
                url: manifest
                    .ui
                    .as_ref()
                    .filter(|_| active && manifest.has(Permission::UiRenderer))
                    .map(|ui| {
                        format!(
                            "{}/{id}/{}?renderer={}",
                            plugin_origin(),
                            ui.entry,
                            renderer.id
                        )
                    }),
            })
            .collect(),
    }
}

/// The registry view (`PluginsRegistryV1`).
pub(crate) fn registry_view(plugins: &PluginsState) -> Result<PluginsRegistryDto, PluginsErrorDto> {
    let snapshot = plugins.snapshot()?;
    let safe_mode = plugins.safe_mode();
    let entries = snapshot
        .plugins
        .into_iter()
        .map(|plugin| {
            let stored = plugin.stored;
            let (root, outcome) = match plugin.loaded {
                Some((root, outcome)) => (Some(root), Some(outcome)),
                None => (None, None),
            };
            let package = outcome.as_ref().and_then(|outcome| outcome.as_ref().ok());
            let problems = match &outcome {
                Some(Ok(package)) => package.problems.clone(),
                Some(Err(problems)) => problems.clone(),
                None => Vec::new(),
            };
            let active = !safe_mode && stored.enabled && package.is_some() && problems.is_empty();
            let (state, restarts, log) = plugins.supervisor().status(&stored.id);
            let backend = package.and_then(|package| {
                let root = root.as_ref()?;
                let display = PluginsState::backend_display(
                    &package.manifest.manifest,
                    root,
                    &plugins.plugin_data_dir(&stored),
                    false,
                )?;
                Some(BackendDto {
                    state,
                    restarts,
                    command_line: display.command_line,
                    node_found: display.node_found,
                    limits: display.limits,
                })
            });
            let settings = package
                .map(|package| {
                    let fields = &package.manifest.manifest.contributes.settings;
                    resolve_values(fields, &stored.settings)
                        .or_else(|_| resolve_values(fields, &Map::new()))
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            PluginEntryDto {
                name: package.map_or_else(
                    || stored.name.clone(),
                    |package| package.manifest.manifest.name.clone(),
                ),
                version: package.map_or_else(
                    || stored.version.clone(),
                    |package| package.manifest.manifest.version.clone(),
                ),
                publisher: package.map_or_else(
                    || stored.publisher.clone(),
                    |package| package.manifest.manifest.publisher.clone(),
                ),
                description: package
                    .and_then(|package| package.manifest.manifest.description.clone()),
                source: match stored.source {
                    super::registry::StoredSource::Installed { .. } => "installed",
                    super::registry::StoredSource::Development { .. } => "development",
                },
                folder: match &stored.source {
                    super::registry::StoredSource::Development { folder } => Some(
                        piui_runtime::script_runner::process_directory(folder)
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    super::registry::StoredSource::Installed { .. } => None,
                },
                enabled: stored.enabled,
                active,
                permissions: stored.permissions.clone(),
                code_hash: package.map_or_else(
                    || stored.code_hash.clone(),
                    |package| package.code_hash.clone(),
                ),
                installed_at: stored.installed_at.clone(),
                backend,
                problems,
                log,
                contributes: package
                    .map(|package| contributes(&stored.id, package, active, &plugin.acp))
                    .unwrap_or_default(),
                settings,
                id: stored.id,
            }
        })
        .collect();
    Ok(PluginsRegistryDto {
        protocol: PROTOCOL,
        revision: snapshot.revision,
        safe_mode,
        checked: snapshot.checked,
        piui_version: plugins.piui_version().to_owned(),
        active_theme: snapshot.active_theme.map(|theme| ThemeRefDto {
            plugin_id: theme.plugin_id,
            theme_id: theme.theme_id,
        }),
        plugins: entries,
    })
}

fn permission_changes(
    from: &[Permission],
    to: &[Permission],
) -> (Vec<Permission>, Vec<Permission>) {
    (
        to.iter()
            .filter(|permission| !from.contains(permission))
            .copied()
            .collect(),
        from.iter()
            .filter(|permission| !to.contains(permission))
            .copied()
            .collect(),
    )
}

/// The trust review of a staged package (`PluginReviewV1`).
pub(crate) fn review_view(plugins: &PluginsState, staging_id: &str, staged: &Staged) -> ReviewDto {
    let validated = &staged.package.manifest;
    let manifest = &validated.manifest;
    let root = plugins.install_root(staged);
    let previous = plugins.stored(&manifest.id);
    let permissions = manifest.sorted_permissions();
    let update = previous.as_ref().map(|stored| {
        let (added, removed) = permission_changes(&stored.permissions, &permissions);
        UpdateDto {
            from_version: stored.version.clone(),
            permissions_added: added,
            permissions_removed: removed,
            code_changed: stored.code_hash != staged.package.code_hash,
        }
    });
    let already_installed = staged.source != ReviewSource::Development
        && previous.as_ref().is_some_and(|stored| {
            stored.version == manifest.version
                && stored.code_hash == staged.package.code_hash
                && matches!(
                    stored.source,
                    super::registry::StoredSource::Installed { .. }
                )
        });
    ReviewDto {
        staging_id: staging_id.to_owned(),
        source: match staged.source {
            ReviewSource::Folder => "folder",
            ReviewSource::Zip => "zip",
            ReviewSource::Development => "development",
        },
        location: piui_runtime::script_runner::process_directory(&staged.location)
            .to_string_lossy()
            .into_owned(),
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        publisher: manifest.publisher.clone(),
        description: manifest.description.clone(),
        permissions,
        backend: PluginsState::backend_display(
            manifest,
            &root,
            &plugins.staged_data_dir(staged),
            false,
        )
        .map(|display| ReviewBackendDto {
            command_line: display.command_line,
            node_found: display.node_found,
            limits: display.limits,
        }),
        code_hash: staged.package.code_hash.clone(),
        files: staged.files,
        bytes: staged.bytes,
        contributes: ReviewContributesDto {
            commands: manifest
                .contributes
                .commands
                .iter()
                .map(|command| command.title.clone())
                .collect(),
            settings: manifest.contributes.settings.len(),
            panels: manifest
                .contributes
                .panels
                .iter()
                .map(|panel| panel.title.clone())
                .collect(),
            themes: manifest
                .contributes
                .themes
                .iter()
                .map(|theme| theme.label.clone())
                .collect(),
            templates: manifest
                .contributes
                .templates
                .iter()
                .map(|template| template.title.clone())
                .collect(),
            node_types: manifest
                .contributes
                .node_types
                .iter()
                .map(|node| node.title.clone())
                .collect(),
            acp_agents: validated
                .acp_agents
                .iter()
                .map(|descriptor| ReviewAcpAgentDto {
                    id: descriptor.id.to_string(),
                    display_name: descriptor.display_name.clone(),
                    command_line: CommandLine {
                        program: descriptor.command.program.clone(),
                        args: descriptor.command.args.clone(),
                    },
                })
                .collect(),
            status_items: manifest
                .contributes
                .status_items
                .iter()
                .map(|item| item.text.clone())
                .collect(),
            keybindings: manifest
                .contributes
                .keybindings
                .iter()
                .map(|binding| KeybindingDto {
                    command: manifest
                        .command(&binding.command)
                        .map_or_else(|| binding.command.clone(), |command| command.title.clone()),
                    key: binding.key.clone(),
                })
                .collect(),
            renderers: manifest
                .contributes
                .renderers
                .iter()
                .map(|renderer| renderer.title.clone())
                .collect(),
        },
        update,
        already_installed,
    }
}

pub(crate) fn emit_changed<R: Runtime>(app: &AppHandle<R>) {
    let revision = app
        .try_state::<PluginsState>()
        .map_or(0, |plugins| plugins.revision());
    let _ = app.emit(
        super::PLUGINS_EVENT,
        json!({ "protocol": PROTOCOL, "revision": revision }),
    );
}

/// Re-registers plugin ACP agents and tells Settings → Harnesses.
async fn sync_acp<R: Runtime>(app: &AppHandle<R>) {
    let (Some(plugins), Some(host)) = (
        app.try_state::<PluginsState>()
            .map(|state| state.inner().clone()),
        app.try_state::<HostState>(),
    ) else {
        return;
    };
    let acp = host.workspace.acp_agents().clone();
    let _ = tauri::async_runtime::spawn_blocking(move || plugins.sync_acp(&acp)).await;
    let revision = app.state::<HostState>().workspace.acp_agents().revision();
    let _ = app.emit(
        crate::harness_registry_api::HARNESS_REGISTRY_EVENT,
        json!({ "protocol": 1, "revision": revision }),
    );
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, PluginsError> + Send + 'static,
) -> Result<T, PluginsErrorDto> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| PluginsErrorDto::from(PluginsError::Io))?
        .map_err(PluginsErrorDto::from)
}

/// Asks Node.js which permission flags it has, so reviews and Settings can
/// say what is enforced without blocking. Blocking; errors leave it unknown.
fn warm_node_probe() {
    if let Ok(node) = piui_runtime::plugin_backend::resolve_plugin_node() {
        let _ = piui_runtime::plugin_backend::probe_node_permissions(&node);
    }
}

fn pick_path(source: PickSource) -> Option<std::path::PathBuf> {
    match source {
        PickSource::Folder => rfd::FileDialog::new()
            .set_title("Choose a PiUI plugin folder")
            .pick_folder(),
        PickSource::Development => rfd::FileDialog::new()
            .set_title("Load an unpacked PiUI plugin for development")
            .pick_folder(),
        PickSource::Zip => rfd::FileDialog::new()
            .set_title("Choose a PiUI plugin package")
            .add_filter("PiUI plugin (.zip)", &["zip"])
            .pick_file(),
    }
}

/// Starts package verification off the first-paint path and registers the
/// ACP agents of active plugins when it is done.
pub(crate) fn start_verification<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let (Some(plugins), Some(host)) = (
            app.try_state::<PluginsState>()
                .map(|state| state.inner().clone()),
            app.try_state::<HostState>(),
        ) else {
            return;
        };
        let acp = host.workspace.acp_agents().clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            plugins.verify(&acp);
            warm_node_probe();
        })
        .await;
        emit_changed(&app);
        let revision = app.state::<HostState>().workspace.acp_agents().revision();
        let _ = app.emit(
            crate::harness_registry_api::HARNESS_REGISTRY_EVENT,
            json!({ "protocol": 1, "revision": revision }),
        );
    });
}

#[tauri::command]
pub async fn plugins_v1(
    app: AppHandle,
    plugins: State<'_, PluginsState>,
    command: PluginsCommand,
) -> Result<PluginsResponse, PluginsErrorDto> {
    let plugins = plugins.inner().clone();
    if !matches!(command, PluginsCommand::List {}) && plugins.safe_mode() {
        return Err(PluginsError::SafeMode.into());
    }
    let mut review = None;
    let mut acp_changed = false;
    let changed = match command {
        PluginsCommand::List {} => false,
        PluginsCommand::Pick { source } => {
            let host = plugins.clone();
            let staged = blocking(move || {
                let Some(path) = pick_path(source) else {
                    return Ok(None);
                };
                let source = match source {
                    PickSource::Folder => ReviewSource::Folder,
                    PickSource::Zip => ReviewSource::Zip,
                    PickSource::Development => ReviewSource::Development,
                };
                warm_node_probe();
                host.stage(source, &path).map(Some)
            })
            .await?;
            review = Some(staged.map(|(id, staged)| review_view(&plugins, &id, &staged)));
            false
        }
        PluginsCommand::Install {
            expected_revision,
            staging_id,
            code_hash,
        } => {
            // A running backend of the same plugin stops before its files change.
            let target = plugins
                .snapshot()
                .ok()
                .and_then(|_| plugins.staged_plugin_id(&staging_id));
            if let Some(id) = &target {
                plugins.supervisor().stop(id).await;
            }
            let host = plugins.clone();
            blocking(move || host.install(expected_revision, &staging_id, &code_hash)).await?;
            acp_changed = true;
            true
        }
        PluginsCommand::Discard { staging_id } => {
            let host = plugins.clone();
            blocking(move || {
                host.discard(&staging_id);
                Ok(())
            })
            .await?;
            false
        }
        PluginsCommand::SetEnabled {
            expected_revision,
            id,
            enabled,
        } => {
            plugins.set_enabled(expected_revision, &id, enabled)?;
            if !enabled {
                plugins.supervisor().stop(&id).await;
            }
            acp_changed = true;
            true
        }
        PluginsCommand::Remove {
            expected_revision,
            id,
        } => {
            plugins.supervisor().stop(&id).await;
            let host = plugins.clone();
            blocking(move || host.remove(expected_revision, &id)).await?;
            acp_changed = true;
            true
        }
        PluginsCommand::Reload {
            expected_revision,
            id,
        } => {
            if plugins.revision() != expected_revision {
                return Err(PluginsError::Conflict.into());
            }
            plugins.supervisor().stop(&id).await;
            let host = plugins.clone();
            let staged = blocking(move || {
                warm_node_probe();
                host.reload(&id)
            })
            .await?;
            if let Some((staging_id, staged)) = staged {
                review = Some(Some(review_view(&plugins, &staging_id, &staged)));
            }
            acp_changed = true;
            true
        }
        PluginsCommand::RestartBackend { id } => {
            plugins.active(&id)?;
            plugins.supervisor().restart(&id).await;
            true
        }
        PluginsCommand::SetSettings {
            expected_revision,
            id,
            values,
            origin,
        } => {
            let host = plugins.clone();
            let from_panel = origin == Some(SettingsOrigin::Panel);
            let key = id.clone();
            let resolved =
                blocking(move || host.set_settings(expected_revision, &key, &values, from_panel))
                    .await?;
            plugins.supervisor().settings_changed(&id, &resolved).await;
            true
        }
        PluginsCommand::SetTheme {
            expected_revision,
            theme,
        } => {
            plugins.set_theme(
                expected_revision,
                theme.map(|theme| (theme.plugin_id, theme.theme_id)),
            )?;
            true
        }
    };
    if acp_changed {
        sync_acp(&app).await;
    }
    if changed {
        emit_changed(&app);
    }
    Ok(PluginsResponse {
        registry: registry_view(&plugins)?,
        review,
    })
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommandOrigin {
    Palette,
    Composer,
    Panel,
    /// v1.1: a status item that names the command.
    Status,
    /// v1.1: a keybinding of the command.
    Keybinding,
}

/// A command runs only where it is contributed: its surfaces, a status item
/// (with `ui.status`) or a keybinding that names it; a panel may run any of
/// its own plugin's commands.
pub(crate) fn command_allowed(
    manifest: &piui_plugins::PluginManifest,
    command: &piui_plugins::CommandContribution,
    origin: CommandOrigin,
) -> bool {
    let contributes = &manifest.contributes;
    match origin {
        CommandOrigin::Palette => command.surfaces().contains(&CommandSurface::Palette),
        CommandOrigin::Composer => command.surfaces().contains(&CommandSurface::Composer),
        CommandOrigin::Panel => true,
        CommandOrigin::Status => {
            manifest.has(Permission::UiStatus)
                && contributes
                    .status_items
                    .iter()
                    .any(|item| item.command.as_deref() == Some(command.id.as_str()))
        }
        CommandOrigin::Keybinding => contributes
            .keybindings
            .iter()
            .any(|binding| binding.command == command.id),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCommandRequest {
    pub plugin_id: String,
    pub command_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub origin: CommandOrigin,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandResult {
    pub protocol: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// Checks a `command/execute` answer: an object with an optional `text`
/// (at most 16 KiB) and an optional `notice` (at most 500 characters).
pub(crate) fn command_result(value: &Value) -> Result<PluginCommandResult, PluginsErrorDto> {
    let refuse = || {
        PluginsErrorDto::new(
            "BACKEND_FAILED",
            "The plugin returned an answer PiUI cannot use.",
        )
    };
    let object = value.as_object().ok_or_else(refuse)?;
    if object.keys().any(|key| key != "text" && key != "notice") {
        return Err(refuse());
    }
    let text = match object.get("text") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.len() <= MAX_COMMAND_TEXT_BYTES => Some(text.clone()),
        Some(_) => return Err(refuse()),
    };
    let notice = match object.get("notice") {
        None | Some(Value::Null) => None,
        Some(Value::String(notice)) if notice.chars().count() <= MAX_NOTICE_CHARS => {
            Some(plain_detail(notice))
        }
        Some(_) => return Err(refuse()),
    };
    Ok(PluginCommandResult {
        protocol: PROTOCOL,
        text,
        notice,
    })
}

#[tauri::command]
pub async fn plugin_command_v1(
    host: State<'_, HostState>,
    plugins: State<'_, PluginsState>,
    request: PluginCommandRequest,
) -> Result<PluginCommandResult, PluginsErrorDto> {
    let plugins = plugins.inner().clone();
    if plugins.safe_mode() || host.safe_mode {
        return Err(PluginsError::SafeMode.into());
    }
    let (stored, package, root) = plugins.active(&request.plugin_id)?;
    let manifest = &package.manifest.manifest;
    let command = manifest
        .command(&request.command_id)
        .ok_or(PluginsError::NotFound)?
        .clone();
    if !manifest.has(Permission::Commands) || !command_allowed(manifest, &command, request.origin) {
        return Err(PluginsError::PermissionDenied.into());
    }
    if let Some(text) = command.insert_text {
        return Ok(PluginCommandResult {
            protocol: PROTOCOL,
            text: Some(text),
            notice: None,
        });
    }
    let mut context = Map::new();
    let mut project = None;
    if let Some((title, workspace_id)) = request
        .session_id
        .as_deref()
        .and_then(|session| host.workspace.session_title(session))
    {
        if manifest.has(Permission::ChatRead)
            && let Some(session) = &request.session_id
        {
            context.insert("chat".into(), json!({ "id": session, "title": title }));
        }
        if (manifest.has(Permission::ProjectRead) || manifest.has(Permission::ProjectWrite))
            && !host.is_personal_workspace(&workspace_id)
            && let Ok(directory) =
                crate::api::verified_project_directory(&host, &workspace_id, true)
        {
            let path = piui_runtime::script_runner::process_directory(directory.canonical_path());
            context.insert("project".into(), json!({ "path": path.to_string_lossy() }));
            project = Some(path);
        }
    }
    let spec = plugins
        .backend_spec(&stored, &package, &root)
        .ok_or(PluginsError::Inactive)?;
    let answer = plugins
        .supervisor()
        .call(
            &spec,
            project.as_deref(),
            "command/execute",
            json!({ "commandId": command.id, "context": context }),
            COMMAND_TIMEOUT,
            None,
        )
        .await
        .map_err(call_error)?;
    command_result(&answer)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginTemplateRequest {
    pub plugin_id: String,
    pub template_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTemplateResult {
    pub protocol: u8,
    pub text: String,
}

#[tauri::command]
pub async fn plugin_template_v1(
    plugins: State<'_, PluginsState>,
    request: PluginTemplateRequest,
) -> Result<PluginTemplateResult, PluginsErrorDto> {
    let plugins = plugins.inner().clone();
    if plugins.safe_mode() {
        return Err(PluginsError::SafeMode.into());
    }
    let text = blocking(move || plugins.template(&request.plugin_id, &request.template_id)).await?;
    Ok(PluginTemplateResult {
        protocol: PROTOCOL,
        text,
    })
}
