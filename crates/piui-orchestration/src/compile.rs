//! Portable system document (system file v5) to run definition (ADR-059).
//!
//! The mapping is the one the editor performs with `parseSystemFile`,
//! `systemFileToGraph` and `compileGraph`
//! (`apps/desktop/src/features/orchestration/systemFile.ts` and
//! `agentGraph.ts`), with the editor's random identifiers replaced by the
//! caller's [`CompileIdentity`]: the profile of an agent is the agent's id,
//! as on the server. Equality vectors in
//! `contracts/fixtures/unified-shell/graph/` hold the TypeScript output for
//! the same documents.
//!
//! [`compile_system_document`] is pure. It reads no file, clock, environment
//! or random source; the host supplies every identifier and the pipelines a
//! sub-pipeline step's name resolves against. It starts nothing and grants
//! nothing: a compiled definition is a draft until a host freezes it in a run.
//!
//! Only version 5 is compiled. Versions 1 to 4 keep their single import
//! parser (the editor), which upgrades them to version 5.
//!
//! Strictness follows `contracts/system-file-v5.schema.json`: unknown fields,
//! explicit `null` for optional members, wrong types, enum values, patterns
//! (with JavaScript's `\S` whitespace set), ranges and sizes are refused, and
//! so is a member name repeated in one object, which `JSON.parse` would
//! resolve silently to the last value. Numbers are read the way JavaScript
//! reads them: an integral value such as `30.0` is an integer and every
//! carried number is its IEEE double. Nesting deeper than `serde_json`'s
//! recursion limit is refused as unreadable, as in graph kernel v1.
//!
//! Adapter-specific static checks (`src/harness-adapters/validation.ts`) are
//! not repeated here: they are host capability checks, and the native host
//! remains authoritative for them. The result passes the crate's own
//! [`validate_definition`] and [`authorize_spawn`], the checks the Desktop
//! host runs before it saves a graph, and the editor's graph rules that
//! `validate_definition` states differently (`check_editor_rules`).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Number, Value};
use thiserror::Error;

use crate::{
    AgentProfile, AuthorizationError, DeclaredToolPolicy, DefinitionError, DirectedEdge,
    ExecutionMode, Harness, InputBinding, LaunchCommandReference, PermissionMode,
    PipelineDefinition, PipelineInput, PipelineInputKind, PipelineOutput, PipelineStep,
    ResourceRule, ResultCondition, ResultField, ResultFieldKind, ReviewRule, RouteGate,
    RouterBranch, RouterConfig, RouterMode, RouterPredicate, RunDefinitionSnapshot, ScriptRuntime,
    StepExecutor, SubpipelineInputSource, TeamDefinition, TeamMember, authorize_spawn,
    validate_definition,
};

/// The `format` of every portable system document.
pub const SYSTEM_FILE_FORMAT: &str = "piui-system";
/// The only document version this compiler reads.
pub const COMPILED_SYSTEM_FILE_VERSION: u32 = 5;

/// Document members that never reach the run definition. Every other member
/// is mapped, or refused with a [`CompileError`]. The document envelope
/// (`format`, `version`) is checked, not mapped.
pub const PRESENTATION_ONLY_FIELDS: &[&str] = &[
    // Canvas coordinates of a node.
    "agents[].position",
    // A program router, script, plugin node or sub-pipeline has no team
    // member: its profile only names the step (systemFile.ts, agentGraph.ts
    // `placeholderProfile`). Its other profile members are not used.
    "agents[].profile (except name) of a step without a team member",
];

/// Identifiers chosen by the host, never by the document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileIdentity {
    pub team_id: String,
    pub pipeline_id: String,
    /// With an id the definition carries the launch command
    /// `{id, name: document name, teamId, pipelineId}` (the Desktop save
    /// path). Without one it carries none (the server's drafts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_command_id: Option<String>,
}

/// A saved launch command that a sub-pipeline step's pipeline name resolves
/// against (`PipelineName` in `host-api/subpipelines.ts`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineName {
    pub id: String,
    pub name: String,
}

/// Stable refusal codes of [`compile_system_document`] (ADR-059).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompileRefusal {
    /// Not one JSON value this parser reads.
    InvalidJson,
    /// Not an object with `format: "piui-system"` and a numeric `version`.
    NotSystemFile,
    /// A version other than 5. The editor upgrades versions 1 to 4.
    UnsupportedVersion,
    /// The document does not match the system file v5 schema, or repeats a
    /// member name.
    InvalidDocument,
    /// Agents and connections that do not form a graph this mapping can
    /// represent without dropping or replacing a member.
    InvalidStructure,
    /// A sub-pipeline names a pipeline that is missing or ambiguous among the
    /// supplied pipelines.
    UnresolvedPipeline,
    /// A sub-pipeline names the launch command being compiled.
    SelfReferencingPipeline,
    /// The mapped definition fails `validate_definition` or an editor rule.
    InvalidDefinition,
    /// A delegation grant fails `authorize_spawn` (same-or-less authority).
    DelegationDenied,
}

/// Why a document was not compiled. Messages name positions and
/// identifiers, never document text.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum CompileError {
    #[error("the document is not JSON this parser reads (line {line}, column {column})")]
    InvalidJson { line: usize, column: usize },
    #[error("the document is not a portable system file")]
    NotSystemFile,
    #[error(
        "system file version {version:?} is not compiled; only version 5 is, and the editor upgrades versions 1 to 4"
    )]
    UnsupportedVersion { version: Option<u64> },
    #[error("the document does not match system file v5 at {at}: {reason}")]
    InvalidDocument { at: String, reason: &'static str },
    #[error("invalid graph structure at {id}: {reason}")]
    InvalidStructure { id: String, reason: &'static str },
    #[error("sub-pipeline step {step_id} names a pipeline that is missing or ambiguous")]
    UnresolvedPipeline { step_id: String },
    #[error("sub-pipeline step {step_id} runs the launch command it belongs to")]
    SelfReferencingPipeline { step_id: String },
    #[error(transparent)]
    InvalidDefinition(#[from] DefinitionError),
    #[error(transparent)]
    DelegationDenied(#[from] AuthorizationError),
}

impl CompileError {
    pub const fn refusal(&self) -> CompileRefusal {
        match self {
            Self::InvalidJson { .. } => CompileRefusal::InvalidJson,
            Self::NotSystemFile => CompileRefusal::NotSystemFile,
            Self::UnsupportedVersion { .. } => CompileRefusal::UnsupportedVersion,
            Self::InvalidDocument { .. } => CompileRefusal::InvalidDocument,
            Self::InvalidStructure { .. } => CompileRefusal::InvalidStructure,
            Self::UnresolvedPipeline { .. } => CompileRefusal::UnresolvedPipeline,
            Self::SelfReferencingPipeline { .. } => CompileRefusal::SelfReferencingPipeline,
            Self::InvalidDefinition(_) => CompileRefusal::InvalidDefinition,
            Self::DelegationDenied(_) => CompileRefusal::DelegationDenied,
        }
    }
}

/// Compiles the exact text of a version 5 portable system document.
///
/// Agents become pipeline steps in document order. Agents with a team member
/// (native agents, agent routers and model calls) become members and profiles
/// with the agent's id. Result connections become dependencies, route
/// connections route gates and dependencies, send and observe connections
/// team edges, and spawn connections delegation grants.
pub fn compile_system_document(
    text: &str,
    identity: &CompileIdentity,
    pipelines: &[PipelineName],
) -> Result<RunDefinitionSnapshot, CompileError> {
    check_envelope(text)?;
    let document: SystemDocument = serde_json::from_str(text).map_err(|error| {
        if error.is_data() {
            CompileError::InvalidDocument {
                at: format!("line {}, column {}", error.line(), error.column()),
                reason: "a member is unknown, missing, null or of the wrong type",
            }
        } else {
            CompileError::InvalidJson {
                line: error.line(),
                column: error.column(),
            }
        }
    })?;
    check_schema(&document)?;
    check_structure(&document)?;
    let launch_commands = resolve_pipelines(&document, identity, pipelines)?;
    let definition = map_document(&document, identity, &launch_commands);
    validate_definition(&definition)?;
    check_editor_rules(&document, &definition)?;
    for parent in &definition.profiles {
        for child in &parent.allowed_spawn_profile_ids {
            authorize_spawn(&definition, &parent.id, child)?;
        }
    }
    Ok(definition)
}

/// Format and version are read before the strict decode, so that a document
/// of another version is refused as such rather than as a schema mismatch.
/// The strict decode then reads the original text, not this value.
fn check_envelope(text: &str) -> Result<(), CompileError> {
    let probe: Value = serde_json::from_str(text).map_err(|error| CompileError::InvalidJson {
        line: error.line(),
        column: error.column(),
    })?;
    let object = probe.as_object().ok_or(CompileError::NotSystemFile)?;
    if object.get("format").and_then(Value::as_str) != Some(SYSTEM_FILE_FORMAT) {
        return Err(CompileError::NotSystemFile);
    }
    let version = object
        .get("version")
        .and_then(Value::as_f64)
        .ok_or(CompileError::NotSystemFile)?;
    if version != f64::from(COMPILED_SYSTEM_FILE_VERSION) {
        return Err(CompileError::UnsupportedVersion {
            version: integral(version)
                .filter(|value| *value >= 0.0)
                .map(|value| value as u64),
        });
    }
    // `Value` keeps the last of repeated names, like `JSON.parse`; the strict
    // decode refuses them only in fixed records, not in maps such as a
    // plugin node's configuration. Refuse them everywhere.
    serde_json::from_str::<UniqueMembers>(text).map_err(|error| {
        if error.is_data() {
            CompileError::InvalidDocument {
                at: format!("line {}, column {}", error.line(), error.column()),
                reason: "a member name is repeated",
            }
        } else {
            CompileError::InvalidJson {
                line: error.line(),
                column: error.column(),
            }
        }
    })?;
    Ok(())
}

/// Any JSON value whose objects never repeat a member name.
struct UniqueMembers;

impl<'de> Deserialize<'de> for UniqueMembers {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(UniqueMembers)
    }
}

impl<'de> Visitor<'de> for UniqueMembers {
    type Value = Self;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<Self, A::Error> {
        while items.next_element::<Self>()?.is_some() {}
        Ok(self)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut members: A) -> Result<Self, A::Error> {
        let mut names = BTreeSet::new();
        while let Some(name) = members.next_key::<String>()? {
            if !names.insert(name) {
                return Err(de::Error::custom("a member name is repeated"));
            }
            members.next_value::<Self>()?;
        }
        Ok(self)
    }
}

// ---------------------------------------------------------------------------
// Document model: `contracts/system-file-v5.schema.json`.
// ---------------------------------------------------------------------------

/// An optional member that, when present, must hold a value: the schema has
/// no `null` for any optional member.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SystemDocument {
    #[allow(dead_code, reason = "checked by check_envelope")]
    format: String,
    #[allow(dead_code, reason = "checked by check_envelope")]
    version: Number,
    name: String,
    #[serde(default, deserialize_with = "present")]
    orchestrator: Option<String>,
    #[serde(default, deserialize_with = "present")]
    inherit_team_connections: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    inputs: Option<Vec<DocumentInput>>,
    #[serde(default, deserialize_with = "present")]
    outputs: Option<Vec<DocumentOutput>>,
    agents: Vec<DocumentAgent>,
    connections: Vec<DocumentConnection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentInput {
    name: String,
    label: String,
    kind: PipelineInputKind,
    #[serde(default, deserialize_with = "present")]
    required: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    description: Option<String>,
    #[serde(default, deserialize_with = "present")]
    options: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    default_value: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentOutput {
    name: String,
    kind: ResultFieldKind,
    agent: String,
    #[serde(default, deserialize_with = "present")]
    field: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AgentKind {
    Agent,
    Router,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentAgent {
    id: String,
    #[serde(default, deserialize_with = "present")]
    kind: Option<AgentKind>,
    #[serde(default, deserialize_with = "present")]
    executor: Option<DocumentExecutor>,
    profile: DocumentProfile,
    #[serde(default, deserialize_with = "present")]
    router: Option<DocumentRouter>,
    task: String,
    #[serde(default, deserialize_with = "present")]
    position: Option<DocumentPosition>,
    #[serde(default, deserialize_with = "present")]
    input: Option<String>,
    #[serde(default, deserialize_with = "present")]
    execution_mode: Option<ExecutionMode>,
    #[serde(default, deserialize_with = "present")]
    result_fields: Option<Vec<ResultField>>,
    #[serde(default, deserialize_with = "present")]
    require_approval: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    condition: Option<ResultCondition>,
    #[serde(default, deserialize_with = "present")]
    review: Option<DocumentReview>,
    #[serde(default, deserialize_with = "present")]
    input_bindings: Option<Vec<InputBinding>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentPosition {
    x: Number,
    y: Number,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum DocumentExecutor {
    Agent {},
    Llm {},
    Script {
        runtime: ScriptRuntime,
        source: String,
        timeout_seconds: Number,
    },
    Plugin {
        plugin_id: String,
        node_type: String,
        config: Map<String, Value>,
    },
    Pipeline {
        pipeline: String,
        #[serde(default, deserialize_with = "present")]
        inputs: Option<BTreeMap<String, DocumentSubpipelineInput>>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum DocumentSubpipelineInput {
    Value {
        value: Value,
    },
    Input {
        name: String,
    },
    Step {
        agent: String,
        #[serde(default, deserialize_with = "present")]
        field: Option<String>,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Reasoning {
    Off,
    #[serde(rename = "none")]
    NoEffort,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl Reasoning {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::NoEffort => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ServiceTier {
    Standard,
    Fast,
}

impl ServiceTier {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Fast => "fast",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentProfile {
    name: String,
    harness: Harness,
    model: String,
    #[serde(default, deserialize_with = "present")]
    model_provider: Option<String>,
    permission_mode: PermissionMode,
    #[serde(default, deserialize_with = "present")]
    network_access: Option<bool>,
    instructions: String,
    #[serde(default, deserialize_with = "present")]
    base_instructions: Option<String>,
    #[serde(default, deserialize_with = "present")]
    reasoning: Option<Reasoning>,
    #[serde(default, deserialize_with = "present")]
    service_tier: Option<ServiceTier>,
    tool_policy: DeclaredToolPolicy,
    #[serde(default, deserialize_with = "present")]
    resource_rules: Option<Vec<ResourceRule>>,
    #[serde(default, deserialize_with = "present")]
    when_to_call: Option<String>,
    #[serde(default, deserialize_with = "present")]
    input_instructions: Option<String>,
    #[serde(default, deserialize_with = "present")]
    expected_result: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentRouter {
    mode: RouterMode,
    input_step_id: String,
    #[serde(default, deserialize_with = "present")]
    selection_field: Option<String>,
    branches: Vec<DocumentBranch>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentBranch {
    id: String,
    label: String,
    #[serde(default, deserialize_with = "present")]
    description: Option<String>,
    #[serde(default, deserialize_with = "present")]
    predicate: Option<RouterPredicate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentReview {
    field: String,
    retry_from_step_id: String,
    #[serde(default, deserialize_with = "present")]
    max_iterations: Option<Number>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ConnectionKind {
    Result,
    Send,
    Observe,
    Spawn,
    Route,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentConnection {
    from: String,
    to: String,
    kind: ConnectionKind,
    #[serde(default, deserialize_with = "present")]
    branch_id: Option<String>,
}

impl DocumentAgent {
    fn is_router(&self) -> bool {
        self.kind == Some(AgentKind::Router)
    }

    fn is_program_router(&self) -> bool {
        self.is_router()
            && self
                .router
                .as_ref()
                .is_some_and(|router| router.mode == RouterMode::Program)
    }

    /// Scripts, plugin nodes and sub-pipelines: host work (`hostWork`).
    fn is_host_work(&self) -> bool {
        matches!(
            self.executor,
            Some(
                DocumentExecutor::Script { .. }
                    | DocumentExecutor::Plugin { .. }
                    | DocumentExecutor::Pipeline { .. }
            )
        )
    }

    /// `nodeHasNoMember`: program routers and host work.
    fn has_member(&self) -> bool {
        !self.is_program_router() && !self.is_host_work()
    }

    /// An executor other than a native agent turn (`llm` or host work).
    fn has_special_executor(&self) -> bool {
        !matches!(self.executor, None | Some(DocumentExecutor::Agent {}))
    }

    /// The result fields the document declares for this agent.
    fn declared_fields(&self) -> &[ResultField] {
        self.result_fields.as_deref().unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Schema checks the types above cannot express.
// ---------------------------------------------------------------------------

/// JavaScript's `\s` (ECMAScript WhiteSpace and LineTerminator). It differs
/// from Rust's `char::is_whitespace`: U+FEFF is whitespace, U+0085 is not.
const fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// The schema pattern `\S`: at least one character that is not whitespace.
fn nonblank(value: &str) -> bool {
    value.chars().any(|c| !js_whitespace(c))
}

/// `^[a-z][A-Za-z0-9_]{0,63}$`.
fn identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() <= 64
        && bytes.first().is_some_and(u8::is_ascii_lowercase)
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

/// `[a-z0-9](?:[a-z0-9-]{0,max-2}[a-z0-9])?`: 1 to `max` characters.
fn slug(value: &str, max: usize) -> bool {
    let bytes = value.as_bytes();
    let edge = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= max
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|byte| edge(byte) || *byte == b'-')
}

/// The plugin id pattern: one to eight dot-separated slugs of 64 characters.
fn plugin_id(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    labels.len() <= 8 && labels.iter().all(|label| slug(label, 64))
}

fn integral(value: f64) -> Option<f64> {
    (value.is_finite() && value.trunc() == value).then_some(value)
}

/// A schema `integer` within `[min, max]`. JSON Schema counts `30.0` as an
/// integer, like JavaScript.
fn integer_in(number: &Number, min: u32, max: u32) -> Option<u32> {
    let value = integral(number.as_f64()?)?;
    (f64::from(min)..=f64::from(max))
        .contains(&value)
        .then_some(value as u32)
}

fn scalar(value: &Value) -> bool {
    value.is_string() || value.is_number() || value.is_boolean()
}

struct Schema {
    at: String,
}

impl Schema {
    fn fail(&self, member: &str, reason: &'static str) -> CompileError {
        CompileError::InvalidDocument {
            at: format!("{}/{member}", self.at),
            reason,
        }
    }

    fn nested(&self, member: impl fmt::Display) -> Self {
        Self {
            at: format!("{}/{member}", self.at),
        }
    }

    fn nonblank(&self, member: &str, value: &str) -> Result<(), CompileError> {
        if nonblank(value) {
            Ok(())
        } else {
            Err(self.fail(member, "must contain a non-whitespace character"))
        }
    }

    fn identifier(&self, member: &str, value: &str) -> Result<(), CompileError> {
        if identifier(value) {
            Ok(())
        } else {
            Err(self.fail(member, "must match [a-z][A-Za-z0-9_]{0,63}"))
        }
    }
}

fn check_schema(document: &SystemDocument) -> Result<(), CompileError> {
    let root = Schema { at: String::new() };
    root.nonblank("name", &document.name)?;
    if let Some(orchestrator) = &document.orchestrator {
        root.nonblank("orchestrator", orchestrator)?;
    }
    if let Some(inputs) = &document.inputs {
        if inputs.len() > 20 {
            return Err(root.fail("inputs", "has at most 20 items"));
        }
        for (index, input) in inputs.iter().enumerate() {
            check_input(&root.nested(format_args!("inputs/{index}")), input)?;
        }
    }
    if let Some(outputs) = &document.outputs {
        if outputs.len() > 32 {
            return Err(root.fail("outputs", "has at most 32 items"));
        }
        for (index, output) in outputs.iter().enumerate() {
            let at = root.nested(format_args!("outputs/{index}"));
            at.identifier("name", &output.name)?;
            at.nonblank("agent", &output.agent)?;
            if let Some(field) = &output.field {
                at.nonblank("field", field)?;
            }
        }
    }
    if document.agents.is_empty() {
        return Err(root.fail("agents", "has at least one item"));
    }
    for (index, agent) in document.agents.iter().enumerate() {
        check_agent(&root.nested(format_args!("agents/{index}")), agent)?;
    }
    for (index, connection) in document.connections.iter().enumerate() {
        let at = root.nested(format_args!("connections/{index}"));
        at.nonblank("from", &connection.from)?;
        at.nonblank("to", &connection.to)?;
        if let Some(branch) = &connection.branch_id {
            at.nonblank("branchId", branch)?;
        }
    }
    Ok(())
}

fn check_input(at: &Schema, input: &DocumentInput) -> Result<(), CompileError> {
    at.identifier("name", &input.name)?;
    at.nonblank("label", &input.label)?;
    if let Some(options) = &input.options {
        if options.len() > 50 {
            return Err(at.fail("options", "has at most 50 items"));
        }
        let mut seen = BTreeSet::new();
        for option in options {
            if !seen.insert(option.as_str()) {
                return Err(at.fail("options", "has unique items"));
            }
            at.nonblank("options", option)?;
        }
    }
    if input
        .default_value
        .as_ref()
        .is_some_and(|value| !scalar(value))
    {
        return Err(at.fail("defaultValue", "is a string, a number or a boolean"));
    }
    Ok(())
}

fn check_agent(at: &Schema, agent: &DocumentAgent) -> Result<(), CompileError> {
    at.nonblank("id", &agent.id)?;
    if let Some(executor) = &agent.executor {
        check_executor(&at.nested("executor"), executor)?;
    }
    check_profile(&at.nested("profile"), &agent.profile)?;
    if let Some(router) = &agent.router {
        let at = at.nested("router");
        at.nonblank("inputStepId", &router.input_step_id)?;
        if let Some(field) = &router.selection_field {
            at.nonblank("selectionField", field)?;
        }
        if router.branches.is_empty() {
            return Err(at.fail("branches", "has at least one item"));
        }
        for (index, branch) in router.branches.iter().enumerate() {
            let at = at.nested(format_args!("branches/{index}"));
            at.nonblank("id", &branch.id)?;
            at.nonblank("label", &branch.label)?;
            if let Some(predicate) = &branch.predicate {
                check_predicate(&at.nested("predicate"), predicate)?;
            }
        }
    }
    if let Some(position) = &agent.position {
        let at = at.nested("position");
        for (member, value) in [("x", &position.x), ("y", &position.y)] {
            if value.as_f64().is_none_or(|value| value < 0.0) {
                return Err(at.fail(member, "is a number of at least 0"));
            }
        }
    }
    for (index, field) in agent.declared_fields().iter().enumerate() {
        at.nested(format_args!("resultFields/{index}"))
            .nonblank("name", &field.name)?;
    }
    if let Some(condition) = &agent.condition {
        let at = at.nested("condition");
        at.nonblank("sourceStepId", &condition.source_step_id)?;
        at.nonblank("field", &condition.field)?;
        if !scalar(&condition.equals) {
            return Err(at.fail("equals", "is a string, a number or a boolean"));
        }
    }
    if let Some(review) = &agent.review {
        let at = at.nested("review");
        at.nonblank("field", &review.field)?;
        at.nonblank("retryFromStepId", &review.retry_from_step_id)?;
        if review
            .max_iterations
            .as_ref()
            .is_some_and(|limit| integer_in(limit, 1, 20).is_none())
        {
            return Err(at.fail("maxIterations", "is an integer from 1 to 20"));
        }
    }
    for (index, binding) in agent.input_bindings.iter().flatten().enumerate() {
        let at = at.nested(format_args!("inputBindings/{index}"));
        at.nonblank("sourceStepId", &binding.source_step_id)?;
        at.nonblank("field", &binding.field)?;
        at.nonblank("name", &binding.name)?;
    }
    Ok(())
}

fn check_executor(at: &Schema, executor: &DocumentExecutor) -> Result<(), CompileError> {
    match executor {
        DocumentExecutor::Agent {} | DocumentExecutor::Llm {} => Ok(()),
        DocumentExecutor::Script {
            source,
            timeout_seconds,
            ..
        } => {
            at.nonblank("source", source)?;
            if integer_in(timeout_seconds, 1, 3600).is_none() {
                return Err(at.fail("timeoutSeconds", "is an integer from 1 to 3600"));
            }
            Ok(())
        }
        DocumentExecutor::Plugin {
            plugin_id: id,
            node_type,
            config,
        } => {
            if !plugin_id(id) {
                return Err(at.fail("pluginId", "is one to eight dot-separated lowercase slugs"));
            }
            if !slug(node_type, 48) {
                return Err(at.fail("nodeType", "is a lowercase slug of at most 48 characters"));
            }
            if config.len() > 30 {
                return Err(at.fail("config", "has at most 30 properties"));
            }
            for (key, value) in config {
                at.nested("config").identifier("(key)", key)?;
                if !scalar(value) {
                    return Err(at.fail("config", "values are strings, numbers or booleans"));
                }
            }
            Ok(())
        }
        DocumentExecutor::Pipeline { pipeline, inputs } => {
            at.nonblank("pipeline", pipeline)?;
            let Some(inputs) = inputs else {
                return Ok(());
            };
            if inputs.len() > 64 {
                return Err(at.fail("inputs", "has at most 64 properties"));
            }
            for (key, source) in inputs {
                let at = at.nested("inputs");
                at.identifier("(key)", key)?;
                match source {
                    DocumentSubpipelineInput::Value { value } => {
                        if !scalar(value) {
                            return Err(at.fail(key, "is a string, a number or a boolean"));
                        }
                    }
                    DocumentSubpipelineInput::Input { name } => {
                        at.nested(key).identifier("name", name)?;
                    }
                    DocumentSubpipelineInput::Step { agent, field } => {
                        let at = at.nested(key);
                        at.nonblank("agent", agent)?;
                        if let Some(field) = field {
                            at.nonblank("field", field)?;
                        }
                    }
                }
            }
            Ok(())
        }
    }
}

fn check_profile(at: &Schema, profile: &DocumentProfile) -> Result<(), CompileError> {
    at.nonblank("name", &profile.name)?;
    at.nonblank("model", &profile.model)?;
    if let Some(provider) = &profile.model_provider {
        at.nonblank("modelProvider", provider)?;
    }
    for (index, rule) in profile.tool_policy.rules.iter().enumerate() {
        at.nested(format_args!("toolPolicy/rules/{index}"))
            .nonblank("tool", &rule.tool)?;
    }
    for (index, rule) in profile.resource_rules.iter().flatten().enumerate() {
        at.nested(format_args!("resourceRules/{index}"))
            .nonblank("id", &rule.id)?;
    }
    Ok(())
}

fn check_predicate(at: &Schema, predicate: &RouterPredicate) -> Result<(), CompileError> {
    match predicate {
        RouterPredicate::Equals { field, value } => {
            at.nonblank("field", field)?;
            if !(value.is_null() || scalar(value)) {
                return Err(at.fail("value", "is a string, a number, a boolean or null"));
            }
            Ok(())
        }
        RouterPredicate::Exists { field } => at.nonblank("field", field),
        RouterPredicate::All { predicates } | RouterPredicate::Any { predicates } => {
            if predicates.is_empty() {
                return Err(at.fail("predicates", "has at least one item"));
            }
            for (index, item) in predicates.iter().enumerate() {
                check_predicate(&at.nested(format_args!("predicates/{index}")), item)?;
            }
            Ok(())
        }
        RouterPredicate::Not { predicate } => check_predicate(&at.nested("predicate"), predicate),
    }
}

// ---------------------------------------------------------------------------
// Graph structure (`parseSystemFile`, without adapter checks), plus members
// the editor's mapping would otherwise drop or replace.
// ---------------------------------------------------------------------------

fn structure(id: &str, reason: &'static str) -> CompileError {
    CompileError::InvalidStructure {
        id: id.to_owned(),
        reason,
    }
}

fn check_structure(document: &SystemDocument) -> Result<(), CompileError> {
    let mut agents = BTreeMap::new();
    for agent in &document.agents {
        if agents.insert(agent.id.as_str(), agent).is_some() {
            return Err(structure(&agent.id, "agent ids must be unique"));
        }
    }
    if let Some(id) = &document.orchestrator {
        let Some(agent) = agents.get(id.as_str()) else {
            return Err(structure(
                id,
                "the orchestrator is not an agent of this file",
            ));
        };
        if agent.is_host_work() {
            return Err(structure(
                id,
                "a step that runs on the host cannot be the orchestrator",
            ));
        }
        // The editor would replace it silently with the first team member.
        if agent.is_program_router() {
            return Err(structure(
                id,
                "a program router has no team member and cannot be the orchestrator",
            ));
        }
    }
    let mut seen = BTreeSet::new();
    for connection in &document.connections {
        let (Some(from), Some(to)) = (
            agents.get(connection.from.as_str()),
            agents.get(connection.to.as_str()),
        ) else {
            return Err(structure(
                &connection.from,
                "a connection references an unknown agent",
            ));
        };
        if connection.from == connection.to && connection.kind != ConnectionKind::Spawn {
            return Err(structure(
                &connection.from,
                "only delegation may reference the same agent",
            ));
        }
        match (connection.kind, &connection.branch_id) {
            (ConnectionKind::Route, None) => {
                return Err(structure(
                    &connection.from,
                    "route connections need a branch id",
                ));
            }
            (ConnectionKind::Route, Some(_)) | (_, None) => {}
            (_, Some(_)) => {
                return Err(structure(
                    &connection.from,
                    "only route connections may contain a branch id",
                ));
            }
        }
        if !seen.insert((
            connection.from.as_str(),
            connection.to.as_str(),
            connection.kind,
            connection.branch_id.as_deref(),
        )) {
            return Err(structure(&connection.from, "duplicate connection"));
        }
        if matches!(
            connection.kind,
            ConnectionKind::Send | ConnectionKind::Observe | ConnectionKind::Spawn
        ) {
            for agent in [from, to] {
                // The editor reports these (`EXECUTOR_ISSUES.noCollaboration`).
                if agent.has_special_executor() {
                    return Err(structure(
                        &agent.id,
                        "a step that is not an agent step does not collaborate",
                    ));
                }
                // The editor would drop these connections silently.
                if agent.is_program_router() {
                    return Err(structure(
                        &agent.id,
                        "a program router has no team member and does not collaborate",
                    ));
                }
            }
        }
    }
    for agent in &document.agents {
        if agent.router.is_some() && !agent.is_router() {
            return Err(structure(
                &agent.id,
                "router configuration requires kind=router",
            ));
        }
        if agent.is_router() && agent.router.is_none() {
            return Err(structure(
                &agent.id,
                "kind=router requires router configuration",
            ));
        }
    }
    Ok(())
}

/// `resolvePipelineName`: the exact name, else a unique case-insensitive
/// match. Missing and ambiguous names do not resolve.
fn resolve_pipeline<'a>(name: &str, pipelines: &'a [PipelineName]) -> Option<&'a str> {
    let exact: Vec<&PipelineName> = pipelines
        .iter()
        .filter(|candidate| candidate.name == name)
        .collect();
    if !exact.is_empty() {
        return (exact.len() == 1).then(|| exact[0].id.as_str());
    }
    let folded = name.to_lowercase();
    let mut matches = pipelines
        .iter()
        .filter(|candidate| candidate.name.to_lowercase() == folded);
    match (matches.next(), matches.next()) {
        (Some(only), None) => Some(only.id.as_str()),
        _ => None,
    }
}

/// The launch command id of every sub-pipeline step, by step id.
fn resolve_pipelines(
    document: &SystemDocument,
    identity: &CompileIdentity,
    pipelines: &[PipelineName],
) -> Result<BTreeMap<String, String>, CompileError> {
    let mut resolved = BTreeMap::new();
    for agent in &document.agents {
        let Some(DocumentExecutor::Pipeline { pipeline, .. }) = &agent.executor else {
            continue;
        };
        let Some(id) = resolve_pipeline(pipeline, pipelines) else {
            return Err(CompileError::UnresolvedPipeline {
                step_id: agent.id.clone(),
            });
        };
        if identity.launch_command_id.as_deref() == Some(id) {
            return Err(CompileError::SelfReferencingPipeline {
                step_id: agent.id.clone(),
            });
        }
        resolved.insert(agent.id.clone(), id.to_owned());
    }
    Ok(resolved)
}

// ---------------------------------------------------------------------------
// Mapping (`systemFileToGraph` then `compileGraph`).
// ---------------------------------------------------------------------------

/// The number JavaScript holds after `JSON.parse`: the nearest IEEE double,
/// written back the way `JSON.stringify` writes it and read as JSON again.
/// `1.0` is the integer `1`, so equality with recorded result data holds.
fn js_number(number: &Number) -> Number {
    let Some(value) = number.as_f64() else {
        return number.clone();
    };
    // An integral double's exact integer can differ from ECMAScript's
    // shortest decimal (1000000000000000128 becomes 1000000000000000100).
    // JSON numbers are finite, so the formatter's output is a JSON number.
    serde_json::from_str(ryu_js::Buffer::new().format(value)).unwrap_or_else(|_| number.clone())
}

fn js_value(value: &Value) -> Value {
    match value {
        Value::Number(number) => Value::Number(js_number(number)),
        Value::Array(items) => Value::Array(items.iter().map(js_value).collect()),
        Value::Object(members) => Value::Object(
            members
                .iter()
                .map(|(key, value)| (key.clone(), js_value(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn js_predicate(predicate: &RouterPredicate) -> RouterPredicate {
    match predicate {
        RouterPredicate::Equals { field, value } => RouterPredicate::Equals {
            field: field.clone(),
            value: js_value(value),
        },
        RouterPredicate::Exists { field } => RouterPredicate::Exists {
            field: field.clone(),
        },
        RouterPredicate::All { predicates } => RouterPredicate::All {
            predicates: predicates.iter().map(js_predicate).collect(),
        },
        RouterPredicate::Any { predicates } => RouterPredicate::Any {
            predicates: predicates.iter().map(js_predicate).collect(),
        },
        RouterPredicate::Not { predicate } => RouterPredicate::Not {
            predicate: Box::new(js_predicate(predicate)),
        },
    }
}

fn map_router(router: &DocumentRouter) -> RouterConfig {
    RouterConfig {
        mode: router.mode,
        input_step_id: router.input_step_id.clone(),
        branches: router
            .branches
            .iter()
            .map(|branch| RouterBranch {
                id: branch.id.clone(),
                label: branch.label.clone(),
                description: branch.description.clone(),
                predicate: branch.predicate.as_ref().map(js_predicate),
            })
            .collect(),
        selection_field: router.selection_field.clone(),
    }
}

fn map_executor(
    agent: &DocumentAgent,
    launch_commands: &BTreeMap<String, String>,
) -> Option<StepExecutor> {
    Some(match agent.executor.as_ref()? {
        DocumentExecutor::Agent {} => StepExecutor::Agent {},
        DocumentExecutor::Llm {} => StepExecutor::Llm {},
        DocumentExecutor::Script {
            runtime,
            source,
            timeout_seconds,
        } => StepExecutor::Script {
            runtime: *runtime,
            source: source.clone(),
            // Range-checked by `check_executor`.
            timeout_seconds: integer_in(timeout_seconds, 1, 3600).unwrap_or_default(),
        },
        DocumentExecutor::Plugin {
            plugin_id,
            node_type,
            config,
        } => StepExecutor::Plugin {
            plugin_id: plugin_id.clone(),
            node_type: node_type.clone(),
            config: config
                .iter()
                .map(|(key, value)| (key.clone(), js_value(value)))
                .collect(),
        },
        DocumentExecutor::Pipeline { inputs, .. } => StepExecutor::Pipeline {
            // Resolved by `resolve_pipelines` before mapping.
            launch_command_id: launch_commands.get(&agent.id).cloned().unwrap_or_default(),
            inputs: inputs
                .iter()
                .flatten()
                .map(|(name, source)| {
                    let source = match source {
                        DocumentSubpipelineInput::Value { value } => {
                            SubpipelineInputSource::Value {
                                value: js_value(value),
                            }
                        }
                        DocumentSubpipelineInput::Input { name } => {
                            SubpipelineInputSource::Input { name: name.clone() }
                        }
                        DocumentSubpipelineInput::Step { agent, field } => {
                            SubpipelineInputSource::Step {
                                step_id: agent.clone(),
                                field: field.clone(),
                            }
                        }
                    };
                    (name.clone(), source)
                })
                .collect(),
        },
    })
}

fn map_profile(agent: &DocumentAgent, allowed_spawn_profile_ids: Vec<String>) -> AgentProfile {
    let profile = &agent.profile;
    AgentProfile {
        when_to_call: profile.when_to_call.clone(),
        input_instructions: profile.input_instructions.clone(),
        expected_result: profile.expected_result.clone(),
        id: agent.id.clone(),
        name: profile.name.clone(),
        harness: profile.harness,
        model_provider: profile.model_provider.clone(),
        model: profile.model.clone(),
        permission_mode: profile.permission_mode,
        network_access: profile.network_access.unwrap_or(false),
        instructions: profile.instructions.clone(),
        base_instructions: profile.base_instructions.clone(),
        reasoning: profile.reasoning.map(|value| value.as_str().to_owned()),
        resource_rules: profile.resource_rules.clone().unwrap_or_default(),
        service_tier: profile.service_tier.map(|value| value.as_str().to_owned()),
        tool_policy: profile.tool_policy.clone(),
        allowed_spawn_profile_ids,
    }
}

/// `compileGraph`'s result fields: an agent router always returns its
/// selection field as a text list, after the other declared fields.
fn result_fields(agent: &DocumentAgent) -> Vec<ResultField> {
    let declared = agent.declared_fields().to_vec();
    let Some(router) = agent.router.as_ref().filter(|_| agent.is_router()) else {
        return declared;
    };
    if router.mode != RouterMode::Agent {
        return declared;
    }
    let selection = router
        .selection_field
        .clone()
        .unwrap_or_else(|| "selectedBranchIds".to_owned());
    let mut fields: Vec<ResultField> = declared
        .into_iter()
        .filter(|field| field.name != selection)
        .collect();
    fields.push(ResultField {
        name: selection,
        kind: ResultFieldKind::TextList,
    });
    fields
}

fn map_document(
    document: &SystemDocument,
    identity: &CompileIdentity,
    launch_commands: &BTreeMap<String, String>,
) -> RunDefinitionSnapshot {
    let members: Vec<&DocumentAgent> = document
        .agents
        .iter()
        .filter(|agent| agent.has_member())
        .collect();
    let member_ids: BTreeSet<&str> = members.iter().map(|agent| agent.id.as_str()).collect();
    let between_members = |connection: &&DocumentConnection| {
        member_ids.contains(connection.from.as_str()) && member_ids.contains(connection.to.as_str())
    };
    let edges = |kind: ConnectionKind| -> Vec<DirectedEdge> {
        document
            .connections
            .iter()
            .filter(|connection| connection.kind == kind)
            .filter(between_members)
            .map(|connection| DirectedEdge {
                from_member_id: connection.from.clone(),
                to_member_id: connection.to.clone(),
            })
            .collect()
    };
    let profiles = members
        .iter()
        .map(|agent| {
            let spawn = document
                .connections
                .iter()
                .filter(|connection| {
                    connection.kind == ConnectionKind::Spawn && connection.from == agent.id
                })
                .filter(|connection| member_ids.contains(connection.to.as_str()))
                .map(|connection| connection.to.clone())
                .collect();
            map_profile(agent, spawn)
        })
        .collect();
    let steps = document
        .agents
        .iter()
        .map(|agent| {
            let incoming = |kind: ConnectionKind| {
                document
                    .connections
                    .iter()
                    .filter(move |connection| connection.kind == kind && connection.to == agent.id)
            };
            let mut dependency_step_ids: Vec<String> = Vec::new();
            for connection in
                incoming(ConnectionKind::Result).chain(incoming(ConnectionKind::Route))
            {
                if !dependency_step_ids.contains(&connection.from) {
                    dependency_step_ids.push(connection.from.clone());
                }
            }
            PipelineStep {
                input_bindings: agent.input_bindings.clone().unwrap_or_default(),
                condition: agent.condition.as_ref().map(|condition| ResultCondition {
                    source_step_id: condition.source_step_id.clone(),
                    field: condition.field.clone(),
                    equals: js_value(&condition.equals),
                }),
                route_gates: incoming(ConnectionKind::Route)
                    .map(|connection| RouteGate {
                        router_step_id: connection.from.clone(),
                        branch_id: connection.branch_id.clone().unwrap_or_default(),
                    })
                    .collect(),
                router: agent
                    .router
                    .as_ref()
                    .filter(|_| agent.is_router())
                    .map(map_router),
                review: agent.review.as_ref().map(|review| ReviewRule {
                    field: review.field.clone(),
                    retry_from_step_id: review.retry_from_step_id.clone(),
                    // Range-checked by `check_agent`.
                    max_iterations: review
                        .max_iterations
                        .as_ref()
                        .and_then(|limit| integer_in(limit, 1, 20)),
                }),
                require_approval: agent.require_approval.unwrap_or(false),
                result_fields: result_fields(agent),
                execution_mode: agent.execution_mode,
                executor: map_executor(agent, launch_commands),
                pinned_output: None,
                input_instructions: agent.input.clone(),
                id: agent.id.clone(),
                name: agent.profile.name.clone(),
                assigned_member_id: agent.id.clone(),
                instructions: agent.task.clone(),
                dependency_step_ids,
            }
        })
        .collect();
    let orchestrator = document.orchestrator.as_deref().or_else(|| {
        document
            .agents
            .iter()
            .find(|agent| !agent.is_router() && !agent.is_host_work())
            .map(|agent| agent.id.as_str())
    });
    let orchestrator_member_id = orchestrator
        .filter(|id| member_ids.contains(id))
        .or_else(|| members.first().map(|agent| agent.id.as_str()))
        .unwrap_or_default()
        .to_owned();
    let team = TeamDefinition {
        spawned_agents_join_team: document.inherit_team_connections.unwrap_or(false),
        id: identity.team_id.clone(),
        name: document.name.clone(),
        members: members
            .iter()
            .map(|agent| TeamMember {
                id: agent.id.clone(),
                profile_id: agent.id.clone(),
            })
            .collect(),
        send_edges: edges(ConnectionKind::Send),
        observe_edges: edges(ConnectionKind::Observe),
        orchestrator_member_id,
    };
    let pipeline = PipelineDefinition {
        id: identity.pipeline_id.clone(),
        name: document.name.clone(),
        steps,
        inputs: document
            .inputs
            .iter()
            .flatten()
            .map(|input| PipelineInput {
                name: input.name.clone(),
                label: input.label.clone(),
                kind: input.kind,
                required: input.required.unwrap_or(false),
                description: input.description.clone(),
                options: input.options.clone().unwrap_or_default(),
                default_value: input.default_value.as_ref().map(js_value),
            })
            .collect(),
        outputs: document
            .outputs
            .iter()
            .flatten()
            .map(|output| PipelineOutput {
                name: output.name.clone(),
                kind: output.kind,
                source_step_id: output.agent.clone(),
                field: output.field.clone(),
            })
            .collect(),
    };
    let launch_command = identity
        .launch_command_id
        .as_ref()
        .map(|id| LaunchCommandReference {
            id: id.clone(),
            name: document.name.clone(),
            team_id: identity.team_id.clone(),
            pipeline_id: identity.pipeline_id.clone(),
            managed_by_teammate_id: None,
        });
    RunDefinitionSnapshot {
        profiles,
        team,
        pipeline,
        launch_command,
    }
}

// ---------------------------------------------------------------------------
// Editor rules that `validate_definition` states differently (`graphIssues`
// and the sub-pipeline mapping check of `parseSystemFile`). The editor reads
// the result fields an agent declares, not the selection field the mapping
// adds to an agent router, and reaches a condition's, an input binding's and
// an upstream correction step's sources through result connections.
// ---------------------------------------------------------------------------

fn flow(reason: &'static str) -> CompileError {
    CompileError::InvalidDefinition(DefinitionError::InvalidFlow { reason })
}

/// `predicateValid` of `graphIssues` over declared fields.
fn declared_predicate(predicate: &RouterPredicate, fields: &[ResultField]) -> bool {
    match predicate {
        RouterPredicate::Equals { field, value } => fields
            .iter()
            .find(|candidate| candidate.name == *field)
            .is_some_and(|declared| {
                value.is_null()
                    || (declared.kind == ResultFieldKind::Text && value.is_string())
                    || (declared.kind == ResultFieldKind::Number && value.is_number())
                    || (declared.kind == ResultFieldKind::Boolean && value.is_boolean())
            }),
        RouterPredicate::Exists { field } => {
            fields.iter().any(|candidate| candidate.name == *field)
        }
        RouterPredicate::All { predicates } | RouterPredicate::Any { predicates } => {
            !predicates.is_empty()
                && predicates
                    .iter()
                    .all(|item| declared_predicate(item, fields))
        }
        RouterPredicate::Not { predicate } => declared_predicate(predicate, fields),
    }
}

fn check_editor_rules(
    document: &SystemDocument,
    definition: &RunDefinitionSnapshot,
) -> Result<(), CompileError> {
    let agents: BTreeMap<&str, &DocumentAgent> = document
        .agents
        .iter()
        .map(|agent| (agent.id.as_str(), agent))
        .collect();
    let fields_of = |id: &str| {
        agents
            .get(id)
            .map_or(&[][..], |agent| agent.declared_fields())
    };
    let declares = |id: &str, name: &str| fields_of(id).iter().any(|field| field.name == name);
    let sources = |kinds: &[ConnectionKind], to: &str| -> Vec<&str> {
        document
            .connections
            .iter()
            .filter(|connection| kinds.contains(&connection.kind) && connection.to == to)
            .map(|connection| connection.from.as_str())
            .collect()
    };
    for agent in &document.agents {
        let results = sources(&[ConnectionKind::Result], &agent.id);
        if let Some(condition) = &agent.condition
            && (!results.contains(&condition.source_step_id.as_str())
                || !declares(&condition.source_step_id, &condition.field))
        {
            return Err(flow(
                "a condition selects a declared field of a result dependency",
            ));
        }
        let mut names = BTreeSet::new();
        for binding in agent.input_bindings.iter().flatten() {
            if !names.insert(binding.name.as_str())
                || !results.contains(&binding.source_step_id.as_str())
                || !declares(&binding.source_step_id, &binding.field)
            {
                return Err(flow(
                    "input bindings have unique names and select declared fields of result dependencies",
                ));
            }
        }
        let mut declared = BTreeSet::new();
        for field in agent.declared_fields() {
            if !declared.insert(field.name.as_str()) {
                return Err(CompileError::InvalidDefinition(
                    DefinitionError::DuplicateId {
                        kind: "result field",
                        id: field.name.clone(),
                    },
                ));
            }
        }
        if let Some(router) = agent.router.as_ref().filter(|_| agent.is_program_router()) {
            let input = fields_of(&router.input_step_id);
            if router.branches.iter().any(|branch| {
                branch
                    .predicate
                    .as_ref()
                    .is_some_and(|predicate| !declared_predicate(predicate, input))
            }) {
                return Err(flow(
                    "program router predicates use fields its input declares",
                ));
            }
        }
        if let Some(review) = &agent.review {
            // Direct dependencies, then their result dependencies upstream.
            let mut pending = sources(&[ConnectionKind::Result, ConnectionKind::Route], &agent.id);
            let mut upstream = BTreeSet::new();
            while let Some(id) = pending.pop() {
                if upstream.insert(id) {
                    pending.extend(sources(&[ConnectionKind::Result], id));
                }
            }
            let verdict = agent
                .declared_fields()
                .iter()
                .any(|field| field.name == review.field && field.kind == ResultFieldKind::Boolean);
            if !upstream.contains(review.retry_from_step_id.as_str()) || !verdict {
                return Err(flow(
                    "a review needs a declared boolean result field and an upstream correction step",
                ));
            }
        }
        if let Some(DocumentExecutor::Pipeline {
            inputs: Some(inputs),
            ..
        }) = &agent.executor
        {
            for source in inputs.values() {
                if let DocumentSubpipelineInput::Step {
                    agent: source_agent,
                    field: Some(field),
                } = source
                    && !declares(source_agent, field)
                {
                    return Err(CompileError::InvalidDefinition(
                        DefinitionError::InvalidExecutor {
                            step_id: agent.id.clone(),
                            reason: "a sub-pipeline input reads a field its source agent declares",
                        },
                    ));
                }
            }
        }
    }
    // `pipelineOutputIssues`: a field is declared on its step, with the
    // output's kind, even when the step declares no result field at all.
    for output in document.outputs.iter().flatten() {
        let Some(field) = &output.field else {
            continue;
        };
        let declared = definition
            .pipeline
            .steps
            .iter()
            .find(|step| step.id == output.agent)
            .is_some_and(|step| {
                step.result_fields
                    .iter()
                    .any(|candidate| candidate.name == *field && candidate.kind == output.kind)
            });
        if !declared {
            return Err(CompileError::InvalidDefinition(
                DefinitionError::InvalidOutput {
                    name: output.name.clone(),
                    reason: "an output reads a field its step declares, of the same kind",
                },
            ));
        }
    }
    Ok(())
}
