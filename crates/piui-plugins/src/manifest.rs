//! `piui-plugin.json` v1 and v2: parsing and every rule the host applies
//! before a package can be reviewed. The JSON Schema of the declared version
//! (`contracts/piui-plugin-v1.schema.json`, `piui-plugin-v2.schema.json`)
//! checks the shape; the semantic pass checks what a schema cannot:
//! permissions each contribution needs, unique ids, the commands status items
//! and keybindings name, field declarations, theme colors and contrast, ACP
//! descriptors and the PiUI engine range. Every failing rule is reported, and
//! unknown fields are refused, never dropped. Version 2 only adds
//! contributions (status items, keybindings, renderers) and the permissions
//! they need; a v1 manifest keeps its exact v1 meaning.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use piui_runtime::acp::{AcpAgentDescriptor, AcpDescriptorError, parse_acp_descriptor};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fields::{Field, validate_fields};
use crate::semver::{Version, VersionRange};
use crate::theme::{CONTRAST_PAIRS, contrast_ratio, parse_color};

pub const MANIFEST_FILE: &str = "piui-plugin.json";
/// The newest manifest schema version; every earlier version stays valid.
pub const SCHEMA_VERSION: u64 = 2;
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Default and bounds of a node type's timeout, in seconds.
pub const DEFAULT_NODE_TIMEOUT_SECONDS: u32 = 60;
pub const MIN_NODE_TIMEOUT_SECONDS: u32 = 1;
pub const MAX_NODE_TIMEOUT_SECONDS: u32 = 3600;
/// Most schema errors reported for one manifest.
const MAX_SHAPE_PROBLEMS: usize = 20;

/// A permission a plugin asks for. The trust review lists them in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Permission {
    #[serde(rename = "commands")]
    Commands,
    #[serde(rename = "ui.panel")]
    UiPanel,
    #[serde(rename = "ui.settings")]
    UiSettings,
    /// v2: status-bar items.
    #[serde(rename = "ui.status")]
    UiStatus,
    /// v2: chat renderers (they see the output of the tools they render).
    #[serde(rename = "ui.renderer")]
    UiRenderer,
    #[serde(rename = "node.run")]
    NodeRun,
    #[serde(rename = "acp.agents")]
    AcpAgents,
    #[serde(rename = "chat.read")]
    ChatRead,
    #[serde(rename = "notifications")]
    Notifications,
    #[serde(rename = "project.read")]
    ProjectRead,
    #[serde(rename = "project.write")]
    ProjectWrite,
    #[serde(rename = "network")]
    Network,
}

impl Permission {
    pub const ALL: [Self; 12] = [
        Self::Commands,
        Self::UiPanel,
        Self::UiSettings,
        Self::UiStatus,
        Self::UiRenderer,
        Self::NodeRun,
        Self::AcpAgents,
        Self::ChatRead,
        Self::Notifications,
        Self::ProjectRead,
        Self::ProjectWrite,
        Self::Network,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Commands => "commands",
            Self::UiPanel => "ui.panel",
            Self::UiSettings => "ui.settings",
            Self::UiStatus => "ui.status",
            Self::UiRenderer => "ui.renderer",
            Self::NodeRun => "node.run",
            Self::AcpAgents => "acp.agents",
            Self::ChatRead => "chat.read",
            Self::Notifications => "notifications",
            Self::ProjectRead => "project.read",
            Self::ProjectWrite => "project.write",
            Self::Network => "network",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Engines {
    pub piui: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryPoint {
    pub entry: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandSurface {
    Palette,
    Composer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surfaces: Option<Vec<CommandSurface>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_text: Option<String>,
}

impl CommandContribution {
    /// Where the command appears; the palette when not declared.
    #[must_use]
    pub fn surfaces(&self) -> Vec<CommandSurface> {
        self.surfaces
            .clone()
            .unwrap_or_else(|| vec![CommandSurface::Palette])
    }

    /// Runs in the backend (`command/execute`) rather than preparing text.
    #[must_use]
    pub const fn uses_backend(&self) -> bool {
        self.insert_text.is_none()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PanelLocation {
    ChatDetails,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelContribution {
    pub id: String,
    pub title: String,
    pub location: PanelLocation,
}

/// Where a status item sits in the status bar (v2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusAlignment {
    Start,
    #[default]
    End,
}

/// A short, static item in the status bar; clicking it runs `command` (v2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusItemContribution {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alignment: Option<StatusAlignment>,
}

/// A keyboard shortcut for one of the plugin's own commands (v2). PiUI's
/// shortcuts always win; conflicts are shown, never resolved silently.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeybindingContribution {
    pub command: String,
    pub key: String,
}

/// A custom view of the chat tool activity named in `tool_names` (v2),
/// rendered by the plugin's `ui.entry` in a sandboxed frame; the generic view
/// stays available and is used whenever the plugin is off or fails.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererContribution {
    pub id: String,
    pub title: String,
    pub tool_names: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Appearance {
    Dark,
    Light,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeContribution {
    pub id: String,
    pub label: String,
    pub appearance: Appearance,
    pub tokens: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub file: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResultKind {
    Text,
    Number,
    Boolean,
    TextList,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeResultField {
    pub name: String,
    pub kind: ResultKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeTypeContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Vec<Field>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_fields: Option<Vec<NodeResultField>>,
}

impl NodeTypeContribution {
    #[must_use]
    pub fn config(&self) -> &[Field] {
        self.config.as_deref().unwrap_or_default()
    }

    #[must_use]
    pub fn timeout_seconds(&self) -> u32 {
        self.timeout_seconds
            .unwrap_or(DEFAULT_NODE_TIMEOUT_SECONDS)
            .clamp(MIN_NODE_TIMEOUT_SECONDS, MAX_NODE_TIMEOUT_SECONDS)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contributions {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<CommandContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<Field>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub panels: Vec<PanelContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub themes: Vec<ThemeContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub templates: Vec<TemplateContribution>,
    /// Raw descriptors; validated into [`ValidatedManifest::acp_agents`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acp_agents: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_types: Vec<NodeTypeContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub status_items: Vec<StatusItemContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keybindings: Vec<KeybindingContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub renderers: Vec<RendererContribution>,
}

/// The typed manifest. Decoding refuses unknown fields at every level.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_version: u64,
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub engines: Engines,
    pub permissions: Vec<Permission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<EntryPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<EntryPoint>,
    pub contributes: Contributions,
}

impl PluginManifest {
    #[must_use]
    pub fn has(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }

    #[must_use]
    pub fn node_type(&self, id: &str) -> Option<&NodeTypeContribution> {
        self.contributes
            .node_types
            .iter()
            .find(|node| node.id == id)
    }

    #[must_use]
    pub fn command(&self, id: &str) -> Option<&CommandContribution> {
        self.contributes
            .commands
            .iter()
            .find(|command| command.id == id)
    }

    /// Permissions in the order the trust review lists them.
    #[must_use]
    pub fn sorted_permissions(&self) -> Vec<Permission> {
        self.permissions
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

/// Stable problem codes shared with `PluginProblemCode` (TypeScript).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProblemCode {
    Malformed,
    TooLarge,
    SchemaVersion,
    Shape,
    EngineRange,
    EngineMismatch,
    PermissionMissing,
    BackendMissing,
    UiMissing,
    DuplicateContribution,
    Field,
    ThemeColor,
    ThemeContrast,
    AcpDescriptor,
    Text,
    NotAPackage,
    FileMissing,
    Path,
    PackageTooLarge,
    Archive,
    Template,
    Integrity,
    /// v2: a status item or keybinding names a command the plugin lacks.
    UnknownCommand,
}

impl ProblemCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::TooLarge => "too-large",
            Self::SchemaVersion => "schema-version",
            Self::Shape => "shape",
            Self::EngineRange => "engine-range",
            Self::EngineMismatch => "engine-mismatch",
            Self::PermissionMissing => "permission-missing",
            Self::BackendMissing => "backend-missing",
            Self::UiMissing => "ui-missing",
            Self::DuplicateContribution => "duplicate-contribution",
            Self::Field => "field",
            Self::ThemeColor => "theme-color",
            Self::ThemeContrast => "theme-contrast",
            Self::AcpDescriptor => "acp-descriptor",
            Self::Text => "text",
            Self::NotAPackage => "not-a-package",
            Self::FileMissing => "file-missing",
            Self::Path => "path",
            Self::PackageTooLarge => "package-too-large",
            Self::Archive => "archive",
            Self::Template => "template",
            Self::Integrity => "integrity",
            Self::UnknownCommand => "unknown-command",
        }
    }
}

impl Serialize for ProblemCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// One failed rule. `message` (and `detail`) are fixed English locale keys;
/// `{0}` in `message` stands for `subject` (an id, key, path or range).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub code: ProblemCode,
    pub message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<&'static str>,
}

impl Problem {
    #[must_use]
    pub const fn new(code: ProblemCode, message: &'static str) -> Self {
        Self {
            code,
            message,
            subject: None,
            detail: None,
        }
    }

    #[must_use]
    pub fn about(code: ProblemCode, message: &'static str, subject: impl Into<String>) -> Self {
        Self {
            code,
            message,
            subject: Some(subject.into()),
            detail: None,
        }
    }

    #[must_use]
    pub const fn with_detail(mut self, detail: &'static str) -> Self {
        self.detail = Some(detail);
        self
    }
}

/// A manifest that passed every rule.
#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedManifest {
    pub manifest: PluginManifest,
    pub version: Version,
    /// Parsed and validated ACP descriptors, in declared order.
    pub acp_agents: Vec<AcpAgentDescriptor>,
    /// `engines.piui` matches the running PiUI version.
    pub compatible: bool,
}

fn schema_validator(version: u64) -> Option<&'static jsonschema::Validator> {
    static V1: OnceLock<Option<jsonschema::Validator>> = OnceLock::new();
    static V2: OnceLock<Option<jsonschema::Validator>> = OnceLock::new();
    let (cell, text) = match version {
        1 => (
            &V1,
            include_str!("../../../contracts/piui-plugin-v1.schema.json"),
        ),
        2 => (
            &V2,
            include_str!("../../../contracts/piui-plugin-v2.schema.json"),
        ),
        _ => return None,
    };
    cell.get_or_init(|| {
        let schema: Value = serde_json::from_str(text).ok()?;
        jsonschema::validator_for(&schema).ok()
    })
    .as_ref()
}

/// The message of an ACP descriptor rule, the same English locale key the
/// Settings → Harnesses screen shows.
#[must_use]
pub const fn acp_descriptor_message(error: AcpDescriptorError) -> &'static str {
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

/// Parses and validates `bytes` as a v1 manifest for PiUI `piui_version`.
/// Returns every problem when any rule fails. An incompatible engine range
/// is not a problem here: it is reported by [`ValidatedManifest::compatible`]
/// so an installed plugin stays listed after a PiUI update.
pub fn parse_manifest(bytes: &[u8], piui_version: &str) -> Result<ValidatedManifest, Vec<Problem>> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(vec![Problem::new(
            ProblemCode::TooLarge,
            "The manifest is larger than 64 KiB.",
        )]);
    }
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return Err(vec![Problem::new(
            ProblemCode::Malformed,
            "piui-plugin.json is not valid JSON.",
        )]);
    };
    let schema_version = match value.get("schemaVersion") {
        Some(Value::Number(number))
            if number
                .as_u64()
                .is_some_and(|version| (1..=SCHEMA_VERSION).contains(&version)) =>
        {
            number.as_u64().unwrap_or(SCHEMA_VERSION)
        }
        Some(_) => {
            return Err(vec![Problem::new(
                ProblemCode::SchemaVersion,
                "Only plugin manifest schema versions 1 and 2 are supported.",
            )]);
        }
        None => {
            return Err(vec![Problem::about(
                ProblemCode::Shape,
                "The manifest does not match the plugin schema at {0}.",
                "/schemaVersion",
            )]);
        }
    };
    let Some(validator) = schema_validator(schema_version) else {
        return Err(vec![Problem::new(
            ProblemCode::Malformed,
            "The plugin schema is unavailable in this build.",
        )]);
    };
    let shape = validator
        .iter_errors(&value)
        .map(|error| {
            let path = error.instance_path.to_string();
            Problem::about(
                ProblemCode::Shape,
                "The manifest does not match the plugin schema at {0}.",
                if path.is_empty() {
                    "/".to_owned()
                } else {
                    path
                },
            )
        })
        .take(MAX_SHAPE_PROBLEMS)
        .collect::<Vec<_>>();
    if !shape.is_empty() {
        return Err(dedupe(shape));
    }
    let manifest = serde_json::from_value::<PluginManifest>(value).map_err(|_| {
        vec![Problem::about(
            ProblemCode::Shape,
            "The manifest does not match the plugin schema at {0}.",
            "/",
        )]
    })?;
    let mut problems = Vec::new();
    let version = Version::parse(&manifest.version);
    if version.is_none() {
        problems.push(Problem::about(
            ProblemCode::Shape,
            "The manifest does not match the plugin schema at {0}.",
            "/version",
        ));
    }
    let range = VersionRange::parse(&manifest.engines.piui);
    if range.is_none() {
        problems.push(Problem::about(
            ProblemCode::EngineRange,
            "The PiUI version range “{0}” is not valid.",
            manifest.engines.piui.clone(),
        ));
    }
    check_permissions(&manifest, &mut problems);
    check_unique_ids(&manifest, &mut problems);
    check_command_references(&manifest, &mut problems);
    check_texts(&manifest, &mut problems);
    check_fields(&manifest, &mut problems);
    check_themes(&manifest, &mut problems);
    let acp_agents = check_acp_agents(&manifest, &mut problems);
    if !problems.is_empty() {
        return Err(dedupe(problems));
    }
    let (Some(version), Some(range)) = (version, range) else {
        return Err(problems);
    };
    let compatible = Version::parse(piui_version).is_some_and(|current| range.matches(&current));
    Ok(ValidatedManifest {
        manifest,
        version,
        acp_agents,
        compatible,
    })
}

fn dedupe(problems: Vec<Problem>) -> Vec<Problem> {
    let mut unique: Vec<Problem> = Vec::with_capacity(problems.len());
    for problem in problems {
        if !unique.contains(&problem) {
            unique.push(problem);
        }
    }
    unique
}

fn require(
    manifest: &PluginManifest,
    permission: Permission,
    contribution: &'static str,
    problems: &mut Vec<Problem>,
) {
    if !manifest.has(permission) {
        problems.push(
            Problem::about(
                ProblemCode::PermissionMissing,
                "The plugin contributes {0} but does not ask for the matching permission.",
                contribution,
            )
            .with_detail(match permission {
                Permission::Commands => "Add the permission “commands”.",
                Permission::UiPanel => "Add the permission “ui.panel”.",
                Permission::UiSettings => "Add the permission “ui.settings”.",
                Permission::UiStatus => "Add the permission “ui.status”.",
                Permission::UiRenderer => "Add the permission “ui.renderer”.",
                Permission::NodeRun => "Add the permission “node.run”.",
                Permission::AcpAgents => "Add the permission “acp.agents”.",
                Permission::ChatRead
                | Permission::Notifications
                | Permission::ProjectRead
                | Permission::ProjectWrite
                | Permission::Network => "Add the matching permission.",
            }),
        );
    }
}

fn check_permissions(manifest: &PluginManifest, problems: &mut Vec<Problem>) {
    let contributes = &manifest.contributes;
    if !contributes.commands.is_empty() {
        require(manifest, Permission::Commands, "commands", problems);
    }
    for command in contributes
        .commands
        .iter()
        .filter(|command| command.uses_backend())
    {
        if manifest.backend.is_none() {
            problems.push(Problem::about(
                ProblemCode::BackendMissing,
                "The command “{0}” runs in the plugin's backend, but the plugin has no backend.",
                command.id.clone(),
            ));
        }
    }
    if !contributes.settings.is_empty() {
        require(manifest, Permission::UiSettings, "settings", problems);
    }
    if !contributes.panels.is_empty() {
        require(manifest, Permission::UiPanel, "panels", problems);
        if manifest.ui.is_none() {
            problems.push(Problem::new(
                ProblemCode::UiMissing,
                "The plugin contributes panels but has no ui.entry page.",
            ));
        }
    }
    if !contributes.node_types.is_empty() {
        require(manifest, Permission::NodeRun, "node types", problems);
        if manifest.backend.is_none() {
            problems.push(Problem::new(
                ProblemCode::BackendMissing,
                "Node types run in the plugin's backend, but the plugin has no backend.",
            ));
        }
    }
    if !contributes.acp_agents.is_empty() {
        require(manifest, Permission::AcpAgents, "ACP agents", problems);
    }
    if !contributes.status_items.is_empty() {
        require(manifest, Permission::UiStatus, "status items", problems);
    }
    if !contributes.keybindings.is_empty() {
        require(manifest, Permission::Commands, "keybindings", problems);
    }
    if !contributes.renderers.is_empty() {
        require(manifest, Permission::UiRenderer, "renderers", problems);
        if manifest.ui.is_none() {
            problems.push(Problem::new(
                ProblemCode::UiMissing,
                "The plugin contributes renderers but has no ui.entry page.",
            ));
        }
    }
}

/// Status items and keybindings run the plugin's own commands only.
fn check_command_references(manifest: &PluginManifest, problems: &mut Vec<Problem>) {
    let contributes = &manifest.contributes;
    let named = contributes
        .status_items
        .iter()
        .filter_map(|item| item.command.as_deref())
        .chain(
            contributes
                .keybindings
                .iter()
                .map(|binding| binding.command.as_str()),
        );
    for command in named {
        if manifest.command(command).is_none() {
            problems.push(Problem::about(
                ProblemCode::UnknownCommand,
                "“{0}” names a command the plugin does not contribute.",
                command,
            ));
        }
    }
    let keys = contributes
        .keybindings
        .iter()
        .map(|binding| binding.key.as_str());
    for key in duplicates(keys) {
        problems.push(Problem::about(
            ProblemCode::DuplicateContribution,
            "Two keybindings use “{0}”.",
            key,
        ));
    }
}

fn duplicates<'a>(ids: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = BTreeSet::new();
    let mut repeated = Vec::new();
    for id in ids {
        if !seen.insert(id) && !repeated.contains(&id) {
            repeated.push(id);
        }
    }
    repeated
}

fn check_unique_ids(manifest: &PluginManifest, problems: &mut Vec<Problem>) {
    let contributes = &manifest.contributes;
    let lists: [Vec<&str>; 7] = [
        contributes
            .commands
            .iter()
            .map(|item| item.id.as_str())
            .collect(),
        contributes
            .panels
            .iter()
            .map(|item| item.id.as_str())
            .collect(),
        contributes
            .themes
            .iter()
            .map(|item| item.id.as_str())
            .collect(),
        contributes
            .templates
            .iter()
            .map(|item| item.id.as_str())
            .collect(),
        contributes
            .node_types
            .iter()
            .map(|item| item.id.as_str())
            .collect(),
        contributes
            .status_items
            .iter()
            .map(|item| item.id.as_str())
            .collect(),
        contributes
            .renderers
            .iter()
            .map(|item| item.id.as_str())
            .collect(),
    ];
    for list in lists {
        for id in duplicates(list) {
            problems.push(Problem::about(
                ProblemCode::DuplicateContribution,
                "Two contributions of the same kind use the id “{0}”.",
                id,
            ));
        }
    }
    for node in &contributes.node_types {
        let names = node
            .result_fields
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|field| field.name.as_str());
        for name in duplicates(names) {
            problems.push(Problem::about(
                ProblemCode::DuplicateContribution,
                "A node type repeats the result field “{0}”.",
                name,
            ));
        }
    }
}

fn check_texts(manifest: &PluginManifest, problems: &mut Vec<Problem>) {
    for command in &manifest.contributes.commands {
        if let Some(text) = &command.insert_text
            && (text.trim().is_empty()
                || text.chars().any(|character| {
                    character.is_control() && character != '\n' && character != '\t'
                }))
        {
            problems.push(Problem::about(
                ProblemCode::Text,
                "The text of command “{0}” is empty or contains control characters.",
                command.id.clone(),
            ));
        }
    }
}

fn check_fields(manifest: &PluginManifest, problems: &mut Vec<Problem>) {
    if let Err((rule, key)) = validate_fields(&manifest.contributes.settings) {
        problems.push(Problem::about(ProblemCode::Field, rule.message(), key));
    }
    for node in &manifest.contributes.node_types {
        if let Err((rule, key)) = validate_fields(node.config()) {
            problems.push(Problem::about(ProblemCode::Field, rule.message(), key));
        }
    }
}

fn check_themes(manifest: &PluginManifest, problems: &mut Vec<Problem>) {
    for theme in &manifest.contributes.themes {
        let mut colors = std::collections::BTreeMap::new();
        for (token, value) in &theme.tokens {
            match parse_color(value) {
                Some(color) => {
                    colors.insert(token.as_str(), color);
                }
                None => problems.push(Problem::about(
                    ProblemCode::ThemeColor,
                    "Theme “{0}” has a color PiUI cannot use.",
                    theme.id.clone(),
                )),
            }
        }
        for (text, background, minimum) in CONTRAST_PAIRS {
            if let (Some(text_color), Some(background_color)) =
                (colors.get(text), colors.get(background))
                && contrast_ratio(*text_color, *background_color) < *minimum
            {
                problems.push(Problem::about(
                    ProblemCode::ThemeContrast,
                    "Theme text is hard to read: {0} needs a contrast of at least 4.5:1.",
                    format!("{} {text}/{background}", theme.id),
                ));
            }
        }
    }
}

fn check_acp_agents(
    manifest: &PluginManifest,
    problems: &mut Vec<Problem>,
) -> Vec<AcpAgentDescriptor> {
    let mut agents = Vec::new();
    for (index, value) in manifest.contributes.acp_agents.iter().enumerate() {
        let label = value
            .get("id")
            .and_then(Value::as_str)
            .map_or_else(|| format!("#{}", index + 1), str::to_owned);
        let parsed = serde_json::to_string(value)
            .map_err(|_| AcpDescriptorError::Malformed)
            .and_then(|text| parse_acp_descriptor(&text));
        match parsed {
            Ok(descriptor) => agents.push(descriptor),
            Err(error) => problems.push(
                Problem::about(
                    ProblemCode::AcpDescriptor,
                    "ACP agent “{0}” is not a valid descriptor.",
                    label,
                )
                .with_detail(acp_descriptor_message(error)),
            ),
        }
    }
    let ids = agents
        .iter()
        .map(|agent| agent.id.as_str())
        .collect::<Vec<_>>();
    for id in duplicates(ids) {
        problems.push(Problem::about(
            ProblemCode::DuplicateContribution,
            "Two contributions of the same kind use the id “{0}”.",
            id,
        ));
    }
    agents
}
