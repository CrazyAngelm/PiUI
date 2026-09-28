//! Pipeline library v1 (`pipeline_library_v1`, ADR-040): pipeline templates
//! and chat pipelines.
//!
//! A template is a portable `piui-system` document stored as data: the host
//! checks only its size and `format`, never evaluates it and never turns it
//! into saved definitions. A chat pipeline binds an ordinary workspace chat
//! to one launch command of its project and remembers the runs started from
//! it; it is UI metadata and never changes native chat history.
//!
//! The library is one document written as complete create-only generations
//! (the pattern of the ACP agent registry): a failed write leaves the previous
//! generation untouched, and a damaged generation is skipped on open, never
//! partially applied. `list` and `chat` work in safe mode; every change is
//! refused there.

use crate::session_placement::{safe_mode_error, tool_error};
use crate::state::HostState;
use crate::workspace_api::WorkspaceError;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::State;
use uuid::Uuid;

pub(crate) const PIPELINE_LIBRARY_PROTOCOL: u8 = 1;
const DOCUMENT_VERSION: u32 = 1;
const DIRECTORY: &str = "pipeline-library-v1";
const GENERATION_PREFIX: &str = "library-";
const GENERATION_SUFFIX: &str = ".json";

/// Largest serialized template document, in UTF-8 bytes.
pub(crate) const MAX_TEMPLATE_BYTES: usize = 256 * 1024;
/// Most templates in the library (global and every project together).
pub(crate) const MAX_TEMPLATES: usize = 200;
/// Most runs remembered per chat; the oldest are forgotten first.
pub(crate) const MAX_CHAT_RUNS: usize = 200;
const MAX_ID_BYTES: usize = 128;
const MAX_NAME_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 500;
/// Most run ids one `consumeChatRuns` may name.
const MAX_CONSUMED_IDS: usize = 1000;
const SYSTEM_FORMAT: &str = "piui-system";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PipelineTemplateScopeV1 {
    Global,
    Workspace { workspace_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineTemplateV1 {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub scope: PipelineTemplateScopeV1,
    pub created_at: String,
    pub updated_at: String,
    pub system: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatPipelineRunV1 {
    pub run_id: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub consumed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatPipelineV1 {
    pub session_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_command_id: Option<String>,
    pub runs: Vec<ChatPipelineRunV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateDraftV1 {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub scope: PipelineTemplateScopeV1,
    /// Checked by the host: a JSON object whose `format` is `piui-system`.
    pub system: Value,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PipelineLibraryCommandV1 {
    List {
        workspace_id: String,
    },
    SaveTemplate {
        template: TemplateDraftV1,
    },
    DeleteTemplate {
        id: String,
    },
    SetChatDefault {
        workspace_id: String,
        #[serde(default)]
        launch_command_id: Option<String>,
    },
    Chat {
        session_id: String,
    },
    SetChatPipeline {
        session_id: String,
        workspace_id: String,
        #[serde(default)]
        launch_command_id: Option<String>,
    },
    RecordChatRun {
        session_id: String,
        workspace_id: String,
        run_id: String,
    },
    ConsumeChatRuns {
        session_id: String,
        run_ids: Vec<String>,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PipelineLibraryResultV1 {
    Library {
        protocol: u8,
        templates: Vec<PipelineTemplateV1>,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_default: Option<String>,
    },
    Template {
        protocol: u8,
        template: PipelineTemplateV1,
    },
    Deleted {
        protocol: u8,
        id: String,
    },
    Chat {
        protocol: u8,
        chat: Option<ChatPipelineV1>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u32,
    generation: u64,
    templates: Vec<PipelineTemplateV1>,
    /// Workspace id -> launch command id new chats start with.
    chat_defaults: BTreeMap<String, String>,
    /// Session id -> chat pipeline.
    chats: BTreeMap<String, ChatPipelineV1>,
}

impl Document {
    fn empty() -> Self {
        Self {
            version: DOCUMENT_VERSION,
            ..Self::default()
        }
    }

    fn valid(&self) -> bool {
        self.version == DOCUMENT_VERSION
            && self.templates.len() <= MAX_TEMPLATES
            && self.templates.iter().all(|template| {
                valid_id(&template.id)
                    && valid_name(&template.name).is_some()
                    && template
                        .description
                        .as_deref()
                        .is_none_or(|description| valid_description(description).is_some())
                    && valid_scope(&template.scope)
                    && valid_system(&template.system)
            })
            && self
                .chat_defaults
                .iter()
                .all(|(workspace, command)| valid_id(workspace) && valid_id(command))
            && self.chats.iter().all(|(session, chat)| {
                *session == chat.session_id
                    && valid_id(session)
                    && valid_id(&chat.workspace_id)
                    && chat.launch_command_id.as_deref().is_none_or(valid_id)
                    && chat.runs.len() <= MAX_CHAT_RUNS
                    && chat.runs.iter().all(|run| valid_id(&run.run_id))
            })
    }
}

/// A store refusal, mapped to the contract's error codes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LibraryError {
    Invalid,
    NotFound,
    Limit,
    Io,
}

impl From<LibraryError> for WorkspaceError {
    fn from(error: LibraryError) -> Self {
        match error {
            LibraryError::Invalid => invalid_argument(),
            LibraryError::NotFound => tool_error(
                "NOT_FOUND",
                "That pipeline template or chat is no longer available.",
            ),
            LibraryError::Limit => tool_error(
                "LIMIT",
                "The pipeline library is full. Delete a template, then try again.",
            ),
            LibraryError::Io => tool_error("IO_ERROR", "PiUI could not save the pipeline library."),
        }
    }
}

fn invalid_argument() -> WorkspaceError {
    tool_error(
        "INVALID_ARGUMENT",
        "Check the required fields and try again.",
    )
}

fn chat_not_found() -> WorkspaceError {
    tool_error("NOT_FOUND", "That chat is no longer available.")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_BYTES && !id.chars().any(char::is_control)
}

fn check_id(id: &str) -> Result<(), LibraryError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(LibraryError::Invalid)
    }
}

fn valid_name(name: &str) -> Option<String> {
    let name = name.trim();
    let count = name.chars().count();
    ((1..=MAX_NAME_CHARS).contains(&count) && !name.chars().any(char::is_control))
        .then(|| name.to_owned())
}

fn valid_description(description: &str) -> Option<String> {
    (description.chars().count() <= MAX_DESCRIPTION_CHARS).then(|| description.to_owned())
}

fn valid_scope(scope: &PipelineTemplateScopeV1) -> bool {
    match scope {
        PipelineTemplateScopeV1::Global => true,
        PipelineTemplateScopeV1::Workspace { workspace_id } => valid_id(workspace_id),
    }
}

fn valid_system(system: &Map<String, Value>) -> bool {
    system.get("format").and_then(Value::as_str) == Some(SYSTEM_FORMAT)
        && serde_json::to_vec(system).is_ok_and(|bytes| bytes.len() <= MAX_TEMPLATE_BYTES)
}

/// Host time as ISO 8601 UTC with milliseconds (`2026-09-28T10:00:00.000Z`).
fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct LibraryState {
    directory: PathBuf,
    document: Document,
    next_generation: u64,
}

/// The pipeline library of one host process.
#[derive(Clone)]
pub(crate) struct PipelineLibrary {
    state: Arc<Mutex<LibraryState>>,
}

impl PipelineLibrary {
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
            // A damaged generation is skipped, never partially applied.
            if document.generation != generation || !document.valid() {
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
            state: Arc::new(Mutex::new(LibraryState {
                directory,
                document: newest.unwrap_or_else(Document::empty),
                next_generation,
            })),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, LibraryState>, LibraryError> {
        self.state.lock().map_err(|_| LibraryError::Io)
    }

    /// Applies `change` to a copy of the document and writes it as a new
    /// generation; nothing is written when the document did not change.
    fn transact<T>(
        &self,
        change: impl FnOnce(&mut Document) -> Result<T, LibraryError>,
    ) -> Result<T, LibraryError> {
        let mut state = self.lock()?;
        let mut staged = state.document.clone();
        let value = change(&mut staged)?;
        if staged == state.document {
            return Ok(value);
        }
        staged.generation = state
            .next_generation
            .checked_add(1)
            .ok_or(LibraryError::Io)?;
        let bytes = serde_json::to_vec_pretty(&staged).map_err(|_| LibraryError::Io)?;
        let path = generation_path(&state.directory, staged.generation);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| LibraryError::Io)?;
        if write_complete(&mut file, &bytes).is_err() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(LibraryError::Io);
        }
        state.next_generation = staged.generation;
        state.document = staged;
        remove_older_generations(&state.directory, state.document.generation);
        Ok(value)
    }

    /// Global templates and `workspace_id`'s, sorted by name, plus its chat
    /// default.
    pub(crate) fn list(
        &self,
        workspace_id: &str,
    ) -> Result<(Vec<PipelineTemplateV1>, Option<String>), LibraryError> {
        check_id(workspace_id)?;
        let state = self.lock()?;
        let mut templates: Vec<PipelineTemplateV1> = state
            .document
            .templates
            .iter()
            .filter(|template| match &template.scope {
                PipelineTemplateScopeV1::Global => true,
                PipelineTemplateScopeV1::Workspace {
                    workspace_id: owner,
                } => owner == workspace_id,
            })
            .cloned()
            .collect();
        templates
            .sort_by_cached_key(|template| (template.name.to_lowercase(), template.id.clone()));
        let chat_default = state.document.chat_defaults.get(workspace_id).cloned();
        Ok((templates, chat_default))
    }

    pub(crate) fn save_template(
        &self,
        draft: TemplateDraftV1,
        now: &str,
    ) -> Result<PipelineTemplateV1, LibraryError> {
        let name = valid_name(&draft.name).ok_or(LibraryError::Invalid)?;
        let description = draft
            .description
            .as_deref()
            .map(|description| valid_description(description).ok_or(LibraryError::Invalid))
            .transpose()?;
        if !valid_scope(&draft.scope) {
            return Err(LibraryError::Invalid);
        }
        let Value::Object(system) = draft.system else {
            return Err(LibraryError::Invalid);
        };
        if !valid_system(&system) {
            return Err(LibraryError::Invalid);
        }
        if let Some(id) = &draft.id {
            check_id(id)?;
        }
        self.transact(|document| match draft.id {
            Some(id) => {
                let template = document
                    .templates
                    .iter_mut()
                    .find(|template| template.id == id)
                    .ok_or(LibraryError::NotFound)?;
                template.name = name;
                template.description = description;
                template.scope = draft.scope;
                template.system = system;
                template.updated_at = now.to_owned();
                Ok(template.clone())
            }
            None => {
                if document.templates.len() >= MAX_TEMPLATES {
                    return Err(LibraryError::Limit);
                }
                let template = PipelineTemplateV1 {
                    id: Uuid::new_v4().to_string(),
                    name,
                    description,
                    scope: draft.scope,
                    created_at: now.to_owned(),
                    updated_at: now.to_owned(),
                    system,
                };
                document.templates.push(template.clone());
                Ok(template)
            }
        })
    }

    pub(crate) fn delete_template(&self, id: &str) -> Result<(), LibraryError> {
        check_id(id)?;
        self.transact(|document| {
            let index = document
                .templates
                .iter()
                .position(|template| template.id == id)
                .ok_or(LibraryError::NotFound)?;
            document.templates.remove(index);
            Ok(())
        })
    }

    pub(crate) fn set_chat_default(
        &self,
        workspace_id: &str,
        launch_command_id: Option<&str>,
    ) -> Result<Option<String>, LibraryError> {
        check_id(workspace_id)?;
        if let Some(command) = launch_command_id {
            check_id(command)?;
        }
        self.transact(|document| {
            match launch_command_id {
                Some(command) => {
                    document
                        .chat_defaults
                        .insert(workspace_id.to_owned(), command.to_owned());
                }
                None => {
                    document.chat_defaults.remove(workspace_id);
                }
            }
            Ok(launch_command_id.map(str::to_owned))
        })
    }

    /// Forgets `workspace_id`'s chat default when it names `launch_command_id`
    /// (a deleted teammate's launch command, ADR-041). Returns whether it did.
    pub(crate) fn clear_chat_default_for(
        &self,
        workspace_id: &str,
        launch_command_id: &str,
    ) -> Result<bool, LibraryError> {
        check_id(workspace_id)?;
        check_id(launch_command_id)?;
        self.transact(|document| {
            let names_it = document
                .chat_defaults
                .get(workspace_id)
                .is_some_and(|command| command == launch_command_id);
            if names_it {
                document.chat_defaults.remove(workspace_id);
            }
            Ok(names_it)
        })
    }

    pub(crate) fn chat(&self, session_id: &str) -> Result<Option<ChatPipelineV1>, LibraryError> {
        check_id(session_id)?;
        Ok(self.lock()?.document.chats.get(session_id).cloned())
    }

    /// Binds (or, without a launch command, unbinds) a chat; its runs stay.
    /// A chat left without a binding and without runs is forgotten.
    pub(crate) fn set_chat_pipeline(
        &self,
        session_id: &str,
        workspace_id: &str,
        launch_command_id: Option<&str>,
    ) -> Result<Option<ChatPipelineV1>, LibraryError> {
        check_id(session_id)?;
        check_id(workspace_id)?;
        if let Some(command) = launch_command_id {
            check_id(command)?;
        }
        self.transact(|document| {
            let chat = document
                .chats
                .entry(session_id.to_owned())
                .or_insert_with(|| ChatPipelineV1 {
                    session_id: session_id.to_owned(),
                    workspace_id: workspace_id.to_owned(),
                    launch_command_id: None,
                    runs: Vec::new(),
                });
            if chat.workspace_id != workspace_id {
                return Err(LibraryError::NotFound);
            }
            chat.launch_command_id = launch_command_id.map(str::to_owned);
            if chat.launch_command_id.is_none() && chat.runs.is_empty() {
                document.chats.remove(session_id);
                return Ok(None);
            }
            Ok(Some(chat.clone()))
        })
    }

    /// Records a run started from a chat; a recorded run id changes nothing.
    pub(crate) fn record_chat_run(
        &self,
        session_id: &str,
        workspace_id: &str,
        run_id: &str,
        now: &str,
    ) -> Result<ChatPipelineV1, LibraryError> {
        check_id(session_id)?;
        check_id(workspace_id)?;
        check_id(run_id)?;
        self.transact(|document| {
            let chat = document
                .chats
                .entry(session_id.to_owned())
                .or_insert_with(|| ChatPipelineV1 {
                    session_id: session_id.to_owned(),
                    workspace_id: workspace_id.to_owned(),
                    launch_command_id: None,
                    runs: Vec::new(),
                });
            if chat.workspace_id != workspace_id {
                return Err(LibraryError::NotFound);
            }
            if !chat.runs.iter().any(|run| run.run_id == run_id) {
                chat.runs.push(ChatPipelineRunV1 {
                    run_id: run_id.to_owned(),
                    started_at: now.to_owned(),
                    consumed: false,
                });
                let excess = chat.runs.len().saturating_sub(MAX_CHAT_RUNS);
                chat.runs.drain(..excess);
            }
            Ok(chat.clone())
        })
    }

    /// Marks runs whose result the chat handed on; unknown ids are ignored.
    pub(crate) fn consume_chat_runs(
        &self,
        session_id: &str,
        run_ids: &[String],
    ) -> Result<Option<ChatPipelineV1>, LibraryError> {
        check_id(session_id)?;
        if run_ids.len() > MAX_CONSUMED_IDS || run_ids.iter().any(|id| !valid_id(id)) {
            return Err(LibraryError::Invalid);
        }
        self.transact(|document| {
            let Some(chat) = document.chats.get_mut(session_id) else {
                return Ok(None);
            };
            for run in &mut chat.runs {
                if run_ids.contains(&run.run_id) {
                    run.consumed = true;
                }
            }
            Ok(Some(chat.clone()))
        })
    }
}

/// The chat must exist, belong to `workspace_id` and not be a run's chat.
fn check_chat(
    host: &HostState,
    session_id: &str,
    workspace_id: &str,
) -> Result<(), WorkspaceError> {
    if !valid_id(session_id) || !valid_id(workspace_id) {
        return Err(invalid_argument());
    }
    let owner = host
        .workspace
        .session_workspace_id(session_id)
        .map_err(|_| chat_not_found())?;
    if owner != workspace_id || host.workspace.session_is_run(session_id)? {
        return Err(chat_not_found());
    }
    Ok(())
}

/// Body of `pipeline_library_v1`, independent of the Tauri state wrappers.
pub(crate) fn dispatch(
    host: &HostState,
    library: &PipelineLibrary,
    command: PipelineLibraryCommandV1,
) -> Result<PipelineLibraryResultV1, WorkspaceError> {
    let protocol = PIPELINE_LIBRARY_PROTOCOL;
    let read_only = matches!(
        command,
        PipelineLibraryCommandV1::List { .. } | PipelineLibraryCommandV1::Chat { .. }
    );
    if host.safe_mode && !read_only {
        return Err(safe_mode_error());
    }
    match command {
        PipelineLibraryCommandV1::List { workspace_id } => {
            let (templates, chat_default) = library.list(&workspace_id)?;
            Ok(PipelineLibraryResultV1::Library {
                protocol,
                templates,
                chat_default,
            })
        }
        PipelineLibraryCommandV1::SaveTemplate { template } => {
            let template = library.save_template(template, &now_string())?;
            Ok(PipelineLibraryResultV1::Template { protocol, template })
        }
        PipelineLibraryCommandV1::DeleteTemplate { id } => {
            library.delete_template(&id)?;
            Ok(PipelineLibraryResultV1::Deleted { protocol, id })
        }
        PipelineLibraryCommandV1::SetChatDefault {
            workspace_id,
            launch_command_id,
        } => {
            let chat_default =
                library.set_chat_default(&workspace_id, launch_command_id.as_deref())?;
            let (templates, _) = library.list(&workspace_id)?;
            Ok(PipelineLibraryResultV1::Library {
                protocol,
                templates,
                chat_default,
            })
        }
        PipelineLibraryCommandV1::Chat { session_id } => Ok(PipelineLibraryResultV1::Chat {
            protocol,
            chat: library.chat(&session_id)?,
        }),
        PipelineLibraryCommandV1::SetChatPipeline {
            session_id,
            workspace_id,
            launch_command_id,
        } => {
            check_chat(host, &session_id, &workspace_id)?;
            let chat = library.set_chat_pipeline(
                &session_id,
                &workspace_id,
                launch_command_id.as_deref(),
            )?;
            Ok(PipelineLibraryResultV1::Chat { protocol, chat })
        }
        PipelineLibraryCommandV1::RecordChatRun {
            session_id,
            workspace_id,
            run_id,
        } => {
            check_chat(host, &session_id, &workspace_id)?;
            let chat =
                library.record_chat_run(&session_id, &workspace_id, &run_id, &now_string())?;
            Ok(PipelineLibraryResultV1::Chat {
                protocol,
                chat: Some(chat),
            })
        }
        PipelineLibraryCommandV1::ConsumeChatRuns {
            session_id,
            run_ids,
        } => Ok(PipelineLibraryResultV1::Chat {
            protocol,
            chat: library.consume_chat_runs(&session_id, &run_ids)?,
        }),
    }
}

#[tauri::command]
pub async fn pipeline_library_v1(
    host: State<'_, HostState>,
    library: State<'_, PipelineLibrary>,
    command: PipelineLibraryCommandV1,
) -> Result<PipelineLibraryResultV1, WorkspaceError> {
    dispatch(host.inner(), library.inner(), command)
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

#[cfg(test)]
#[path = "pipeline_library_tests.rs"]
mod tests;
