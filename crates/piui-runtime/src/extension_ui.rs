//! Safe projection and response routing for Pi's RPC extension UI requests.
//!
//! Raw extension request identifiers and select values are retained only in the
//! host-side mailbox. The serialized action types in this module contain
//! bounded, path-redacted presentation text and opaque identifiers only.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const MAX_PENDING_DIALOGS: usize = 32;
const MAX_SOURCE_ID_CHARS: usize = 256;
const MAX_TITLE_CHARS: usize = 240;
const MAX_MESSAGE_CHARS: usize = 8 * 1024;
const MAX_OPTION_COUNT: usize = 100;
const MAX_OPTION_LABEL_CHARS: usize = 1024;
const MAX_INPUT_RESPONSE_CHARS: usize = 16 * 1024;
const MAX_EDITOR_TEXT_CHARS: usize = 128 * 1024;
const MAX_WIDGET_LINES: usize = 100;
const MAX_WIDGET_TOTAL_CHARS: usize = 32_768;
const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

const UNSUPPORTED_DIALOG_SUMMARY: &str = "This extension dialog could not be displayed safely.";
const UNSUPPORTED_REQUEST_SUMMARY: &str = "This extension UI request is not supported.";

/// A host-safe extension UI action that can cross to the WebView.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExtensionUiAction {
    Dialog {
        request: ExtensionDialogRequest,
    },
    Notify {
        id: String,
        message: String,
        level: String,
    },
    Status {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Widget {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<Vec<String>>,
        placement: String,
    },
    Title {
        title: String,
    },
    EditorText {
        text: String,
    },
    Unsupported {
        id: String,
        method: String,
        safe_summary: String,
    },
}

/// A host-safe dialog request from an extension.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExtensionDialogRequest {
    Select {
        id: String,
        title: String,
        options: Vec<ExtensionDialogOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    Confirm {
        id: String,
        title: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    Input {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    Editor {
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefill: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
}

/// One visible select option. Its id is host-generated; the raw Pi option
/// value remains in [`ExtensionUiMailbox`].
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDialogOption {
    pub id: String,
    pub label: String,
}

/// A response submitted by the WebView for a pending extension dialog.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExtensionUiResponse {
    Selected { option_id: String },
    Confirmed { value: bool },
    Submitted { value: String },
    Cancelled,
}

/// Host-private mailbox for unresolved extension dialogs.
///
/// It retains only the source request id and raw select mappings required to
/// encode a future Pi response. It has no process or event-channel ownership.
pub(crate) struct ExtensionUiMailbox {
    pending: BTreeMap<String, PendingDialog>,
}

impl Default for ExtensionUiMailbox {
    fn default() -> Self {
        Self::new()
    }
}

impl ExtensionUiMailbox {
    pub(crate) fn new() -> Self {
        Self {
            pending: BTreeMap::new(),
        }
    }

    pub(crate) fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub(crate) fn contains(&self, public_id: &str) -> bool {
        self.pending.contains_key(public_id)
    }

    /// Validates and projects one raw `extension_ui_request` payload.
    pub(crate) fn project(&mut self, object: &Map<String, Value>) -> ExtensionUiDispatch {
        let source_id = object.get("id").and_then(Value::as_str);
        let source = source_id.unwrap_or("");
        let method = object.get("method").and_then(Value::as_str);

        match request_kind(method) {
            RequestKind::Dialog(kind) => self.project_dialog(
                object,
                source_id,
                opaque_id("extension-dialog", source),
                kind,
            ),
            RequestKind::FireAndForget(kind) => self.project_fire_and_forget(
                object,
                source_id,
                opaque_id("extension", source),
                kind,
            ),
            RequestKind::Unknown => {
                self.unsupported_dialog(opaque_id("extension", source), source_id, method)
            }
        }
    }

    pub(crate) fn respond(
        &mut self,
        public_id: &str,
        response: ExtensionUiResponse,
    ) -> Result<Value, ExtensionUiMailboxError> {
        let frame = {
            let pending = self
                .pending
                .get(public_id)
                .ok_or(ExtensionUiMailboxError::UnknownRequest)?;
            pending.encode_response(&response)?
        };
        // Remove only after validating both the dialog kind and response data.
        // This makes an invalid response retryable while a valid response is
        // consumed exactly once.
        self.pending.remove(public_id);
        Ok(frame)
    }

    pub(crate) fn cancel(&mut self, public_id: &str) -> Option<Value> {
        self.pending
            .remove(public_id)
            .map(PendingDialog::cancelled_frame)
    }

    /// Forgets a request after Pi's own documented timeout has elapsed. No
    /// response frame is sent because Pi has already resolved the dialog.
    pub(crate) fn forget(&mut self, public_id: &str) -> bool {
        self.pending.remove(public_id).is_some()
    }

    pub(crate) fn drain_cancellations(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending)
            .into_values()
            .map(PendingDialog::cancelled_frame)
            .collect()
    }

    fn project_dialog(
        &mut self,
        object: &Map<String, Value>,
        source_id: Option<&str>,
        public_id: String,
        kind: DialogKind,
    ) -> ExtensionUiDispatch {
        let Some(source_id) = valid_source_id(source_id) else {
            return self.unsupported_dialog(public_id, source_id, Some(kind.method()));
        };

        // A repeated source id cannot be safely correlated by Pi. Cancelling
        // its source id also resolves any previous request with that id, so
        // discard that stale mailbox slot before emitting the cancellation.
        if self.pending.contains_key(&public_id) {
            self.pending.remove(&public_id);
            return self.unsupported_dialog(public_id, Some(source_id), Some(kind.method()));
        }
        if self.pending.len() >= MAX_PENDING_DIALOGS {
            return self.unsupported_dialog(public_id, Some(source_id), Some(kind.method()));
        }

        let parsed = match kind {
            DialogKind::Select => parse_select(object, source_id, public_id.clone()),
            DialogKind::Confirm => parse_confirm(object, source_id, public_id.clone()),
            DialogKind::Input => parse_input(object, source_id, public_id.clone()),
            DialogKind::Editor => parse_editor(object, source_id, public_id.clone()),
        };
        match parsed {
            Ok((request, pending)) => {
                self.pending.insert(public_id.clone(), pending);
                ExtensionUiDispatch {
                    action: ExtensionUiAction::Dialog { request },
                    delivery: ExtensionUiDelivery::Dialog,
                    immediate_response: None,
                    pending_id: Some(public_id),
                }
            }
            Err(()) => self.unsupported_dialog(public_id, Some(source_id), Some(kind.method())),
        }
    }

    fn project_fire_and_forget(
        &mut self,
        object: &Map<String, Value>,
        source_id: Option<&str>,
        public_id: String,
        kind: FireAndForgetKind,
    ) -> ExtensionUiDispatch {
        let action = valid_source_id(source_id).ok_or(()).and_then(|source_id| {
            parse_fire_and_forget(object, source_id, public_id.clone(), kind)
        });
        match action {
            Ok(action) => ExtensionUiDispatch {
                action,
                delivery: ExtensionUiDelivery::FireAndForget,
                immediate_response: None,
                pending_id: None,
            },
            Err(()) => ExtensionUiDispatch {
                action: unsupported_action(
                    public_id,
                    Some(kind.method()),
                    UNSUPPORTED_REQUEST_SUMMARY,
                ),
                delivery: ExtensionUiDelivery::FireAndForget,
                immediate_response: None,
                pending_id: None,
            },
        }
    }

    fn unsupported_dialog(
        &mut self,
        public_id: String,
        source_id: Option<&str>,
        method: Option<&str>,
    ) -> ExtensionUiDispatch {
        ExtensionUiDispatch {
            action: unsupported_action(public_id, method, UNSUPPORTED_DIALOG_SUMMARY),
            delivery: ExtensionUiDelivery::Dialog,
            immediate_response: source_id.map(cancelled_frame),
            pending_id: None,
        }
    }
}

pub(crate) struct ExtensionUiDispatch {
    pub(crate) action: ExtensionUiAction,
    pub(crate) delivery: ExtensionUiDelivery,
    /// A raw Pi response retained strictly inside the runtime layer.
    pub(crate) immediate_response: Option<Value>,
    /// Present only for a valid inserted dialog, so a failed event delivery can
    /// remove exactly that slot and cancel it.
    pub(crate) pending_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExtensionUiDelivery {
    Dialog,
    FireAndForget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExtensionUiMailboxError {
    UnknownRequest,
    InvalidResponse,
}

enum PendingDialog {
    Select {
        source_id: String,
        options: BTreeMap<String, String>,
    },
    Confirm {
        source_id: String,
    },
    Input {
        source_id: String,
    },
    Editor {
        source_id: String,
    },
}

impl PendingDialog {
    fn encode_response(
        &self,
        response: &ExtensionUiResponse,
    ) -> Result<Value, ExtensionUiMailboxError> {
        match (self, response) {
            (Self::Select { source_id, options }, ExtensionUiResponse::Selected { option_id }) => {
                let raw_value = options
                    .get(option_id)
                    .ok_or(ExtensionUiMailboxError::InvalidResponse)?;
                Ok(value_frame(source_id, raw_value))
            }
            (Self::Confirm { source_id }, ExtensionUiResponse::Confirmed { value }) => {
                Ok(confirmed_frame(source_id, *value))
            }
            (Self::Input { source_id }, ExtensionUiResponse::Submitted { value })
                if within_char_limit(value, MAX_INPUT_RESPONSE_CHARS) =>
            {
                Ok(value_frame(source_id, value))
            }
            (Self::Editor { source_id }, ExtensionUiResponse::Submitted { value })
                if within_char_limit(value, MAX_EDITOR_TEXT_CHARS) =>
            {
                Ok(value_frame(source_id, value))
            }
            (Self::Select { source_id, .. }, ExtensionUiResponse::Cancelled)
            | (Self::Confirm { source_id }, ExtensionUiResponse::Cancelled)
            | (Self::Input { source_id }, ExtensionUiResponse::Cancelled)
            | (Self::Editor { source_id }, ExtensionUiResponse::Cancelled) => {
                Ok(cancelled_frame(source_id))
            }
            _ => Err(ExtensionUiMailboxError::InvalidResponse),
        }
    }

    fn cancelled_frame(self) -> Value {
        match self {
            Self::Select { source_id, .. }
            | Self::Confirm { source_id }
            | Self::Input { source_id }
            | Self::Editor { source_id } => cancelled_frame(&source_id),
        }
    }
}

#[derive(Clone, Copy)]
enum RequestKind {
    Dialog(DialogKind),
    FireAndForget(FireAndForgetKind),
    Unknown,
}

#[derive(Clone, Copy)]
enum DialogKind {
    Select,
    Confirm,
    Input,
    Editor,
}

impl DialogKind {
    fn method(self) -> &'static str {
        match self {
            Self::Select => "select",
            Self::Confirm => "confirm",
            Self::Input => "input",
            Self::Editor => "editor",
        }
    }
}

#[derive(Clone, Copy)]
enum FireAndForgetKind {
    Notify,
    Status,
    Widget,
    Title,
    EditorText,
}

impl FireAndForgetKind {
    fn method(self) -> &'static str {
        match self {
            Self::Notify => "notify",
            Self::Status => "setStatus",
            Self::Widget => "setWidget",
            Self::Title => "setTitle",
            Self::EditorText => "set_editor_text",
        }
    }
}

fn request_kind(method: Option<&str>) -> RequestKind {
    match method {
        Some("select") => RequestKind::Dialog(DialogKind::Select),
        Some("confirm") => RequestKind::Dialog(DialogKind::Confirm),
        Some("input") => RequestKind::Dialog(DialogKind::Input),
        Some("editor") => RequestKind::Dialog(DialogKind::Editor),
        Some("notify") => RequestKind::FireAndForget(FireAndForgetKind::Notify),
        Some("setStatus") => RequestKind::FireAndForget(FireAndForgetKind::Status),
        Some("setWidget") => RequestKind::FireAndForget(FireAndForgetKind::Widget),
        Some("setTitle") => RequestKind::FireAndForget(FireAndForgetKind::Title),
        Some("set_editor_text") => RequestKind::FireAndForget(FireAndForgetKind::EditorText),
        _ => RequestKind::Unknown,
    }
}

fn valid_source_id(source_id: Option<&str>) -> Option<&str> {
    source_id.filter(|value| !value.is_empty() && within_char_limit(value, MAX_SOURCE_ID_CHARS))
}

fn parse_select(
    object: &Map<String, Value>,
    source_id: &str,
    public_id: String,
) -> Result<(ExtensionDialogRequest, PendingDialog), ()> {
    let title = required_surface_text(object, "title", MAX_TITLE_CHARS, TextPolicy::SingleLine)?;
    let timeout_ms = parse_timeout(object)?;
    let raw_options = object.get("options").and_then(Value::as_array).ok_or(())?;
    if raw_options.is_empty() || raw_options.len() > MAX_OPTION_COUNT {
        return Err(());
    }

    let mut options = Vec::with_capacity(raw_options.len());
    let mut raw_mappings = BTreeMap::new();
    for (index, raw_option) in raw_options.iter().enumerate() {
        let raw_option = raw_option.as_str().ok_or(())?;
        let label =
            bounded_surface_text(raw_option, MAX_OPTION_LABEL_CHARS, TextPolicy::SingleLine)
                .ok_or(())?;
        let option_id = opaque_option_id(source_id, index, raw_option);
        if raw_mappings
            .insert(option_id.clone(), raw_option.to_owned())
            .is_some()
        {
            return Err(());
        }
        options.push(ExtensionDialogOption {
            id: option_id,
            label,
        });
    }

    Ok((
        ExtensionDialogRequest::Select {
            id: public_id,
            title,
            options,
            timeout_ms,
        },
        PendingDialog::Select {
            source_id: source_id.to_owned(),
            options: raw_mappings,
        },
    ))
}

fn parse_confirm(
    object: &Map<String, Value>,
    source_id: &str,
    public_id: String,
) -> Result<(ExtensionDialogRequest, PendingDialog), ()> {
    let title = required_surface_text(object, "title", MAX_TITLE_CHARS, TextPolicy::SingleLine)?;
    let message =
        required_surface_text(object, "message", MAX_MESSAGE_CHARS, TextPolicy::Multiline)?;
    let timeout_ms = parse_timeout(object)?;
    Ok((
        ExtensionDialogRequest::Confirm {
            id: public_id,
            title,
            message,
            timeout_ms,
        },
        PendingDialog::Confirm {
            source_id: source_id.to_owned(),
        },
    ))
}

fn parse_input(
    object: &Map<String, Value>,
    source_id: &str,
    public_id: String,
) -> Result<(ExtensionDialogRequest, PendingDialog), ()> {
    let title = required_surface_text(object, "title", MAX_TITLE_CHARS, TextPolicy::SingleLine)?;
    let placeholder = optional_surface_text(
        object,
        "placeholder",
        MAX_MESSAGE_CHARS,
        TextPolicy::SingleLine,
    )?;
    let timeout_ms = parse_timeout(object)?;
    Ok((
        ExtensionDialogRequest::Input {
            id: public_id,
            title,
            placeholder,
            timeout_ms,
        },
        PendingDialog::Input {
            source_id: source_id.to_owned(),
        },
    ))
}

fn parse_editor(
    object: &Map<String, Value>,
    source_id: &str,
    public_id: String,
) -> Result<(ExtensionDialogRequest, PendingDialog), ()> {
    let title = required_surface_text(object, "title", MAX_TITLE_CHARS, TextPolicy::SingleLine)?;
    let prefill = optional_surface_text(
        object,
        "prefill",
        MAX_EDITOR_TEXT_CHARS,
        TextPolicy::Multiline,
    )?;
    let timeout_ms = parse_timeout(object)?;
    Ok((
        ExtensionDialogRequest::Editor {
            id: public_id,
            title,
            prefill,
            timeout_ms,
        },
        PendingDialog::Editor {
            source_id: source_id.to_owned(),
        },
    ))
}

fn parse_fire_and_forget(
    object: &Map<String, Value>,
    _source_id: &str,
    public_id: String,
    kind: FireAndForgetKind,
) -> Result<ExtensionUiAction, ()> {
    match kind {
        FireAndForgetKind::Notify => {
            let message =
                required_surface_text(object, "message", MAX_MESSAGE_CHARS, TextPolicy::Multiline)?;
            let level = parse_notify_level(object)?;
            Ok(ExtensionUiAction::Notify {
                id: public_id,
                message,
                level,
            })
        }
        FireAndForgetKind::Status => {
            let key = required_opaque_key(object, "statusKey", "extension-status")?;
            let text = optional_surface_text(
                object,
                "statusText",
                MAX_MESSAGE_CHARS,
                TextPolicy::SingleLine,
            )?;
            Ok(ExtensionUiAction::Status { key, text })
        }
        FireAndForgetKind::Widget => {
            let key = required_opaque_key(object, "widgetKey", "extension-widget")?;
            let lines = parse_widget_lines(object)?;
            let placement = parse_widget_placement(object)?;
            Ok(ExtensionUiAction::Widget {
                key,
                lines,
                placement,
            })
        }
        FireAndForgetKind::Title => {
            let title =
                required_surface_text(object, "title", MAX_TITLE_CHARS, TextPolicy::SingleLine)?;
            Ok(ExtensionUiAction::Title { title })
        }
        FireAndForgetKind::EditorText => {
            let text = required_surface_text(
                object,
                "text",
                MAX_EDITOR_TEXT_CHARS,
                TextPolicy::Multiline,
            )?;
            Ok(ExtensionUiAction::EditorText { text })
        }
    }
}

fn required_opaque_key(object: &Map<String, Value>, field: &str, kind: &str) -> Result<String, ()> {
    let raw = object.get(field).and_then(Value::as_str).ok_or(())?;
    if raw.is_empty() || !within_char_limit(raw, MAX_SOURCE_ID_CHARS) {
        return Err(());
    }
    Ok(opaque_id(kind, raw))
}

fn parse_notify_level(object: &Map<String, Value>) -> Result<String, ()> {
    match object.get("notifyType") {
        None | Some(Value::Null) => Ok("info".into()),
        Some(Value::String(value)) if matches!(value.as_str(), "info" | "warning" | "error") => {
            Ok(value.clone())
        }
        _ => Err(()),
    }
}

fn parse_widget_placement(object: &Map<String, Value>) -> Result<String, ()> {
    match object.get("widgetPlacement") {
        None | Some(Value::Null) => Ok("aboveEditor".into()),
        Some(Value::String(value)) if matches!(value.as_str(), "aboveEditor" | "belowEditor") => {
            Ok(value.clone())
        }
        _ => Err(()),
    }
}

fn parse_widget_lines(object: &Map<String, Value>) -> Result<Option<Vec<String>>, ()> {
    let Some(value) = object.get("widgetLines") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let raw_lines = value.as_array().ok_or(())?;
    if raw_lines.len() > MAX_WIDGET_LINES {
        return Err(());
    }

    let mut total = 0usize;
    let mut lines = Vec::with_capacity(raw_lines.len());
    for raw_line in raw_lines {
        let raw_line = raw_line.as_str().ok_or(())?;
        if !within_char_limit(raw_line, MAX_WIDGET_TOTAL_CHARS) {
            return Err(());
        }
        let line = bounded_surface_text(raw_line, MAX_WIDGET_TOTAL_CHARS, TextPolicy::WidgetLine)
            .ok_or(())?;
        total = total.saturating_add(line.chars().count());
        if total > MAX_WIDGET_TOTAL_CHARS {
            return Err(());
        }
        lines.push(line);
    }
    Ok(Some(lines))
}

fn parse_timeout(object: &Map<String, Value>) -> Result<Option<u64>, ()> {
    match object.get("timeout") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_u64() {
            Some(0) => Ok(None),
            Some(value) if value <= MAX_TIMEOUT_MS => Ok(Some(value)),
            _ => Err(()),
        },
    }
}

fn required_surface_text(
    object: &Map<String, Value>,
    field: &str,
    max_chars: usize,
    policy: TextPolicy,
) -> Result<String, ()> {
    let value = object.get(field).and_then(Value::as_str).ok_or(())?;
    bounded_surface_text(value, max_chars, policy).ok_or(())
}

fn optional_surface_text(
    object: &Map<String, Value>,
    field: &str,
    max_chars: usize,
    policy: TextPolicy,
) -> Result<Option<String>, ()> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => bounded_surface_text(value, max_chars, policy)
            .map(Some)
            .ok_or(()),
        Some(_) => Err(()),
    }
}

#[derive(Clone, Copy)]
enum TextPolicy {
    SingleLine,
    Multiline,
    WidgetLine,
}

pub(crate) fn sanitize_single_line(value: &str, max_chars: usize) -> Option<String> {
    bounded_surface_text(value, max_chars, TextPolicy::SingleLine)
}

fn bounded_surface_text(value: &str, max_chars: usize, policy: TextPolicy) -> Option<String> {
    if !within_char_limit(value, max_chars) {
        return None;
    }
    let controls_stripped = strip_controls(value, policy);
    let redacted = redact_absolute_paths(&controls_stripped);
    within_char_limit(&redacted, max_chars).then_some(redacted)
}

fn within_char_limit(value: &str, limit: usize) -> bool {
    value.chars().count() <= limit
}

fn strip_controls(value: &str, policy: TextPolicy) -> String {
    let allow_tab = matches!(policy, TextPolicy::Multiline | TextPolicy::WidgetLine);
    let allow_newline = matches!(policy, TextPolicy::Multiline);
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{001b}' {
            match characters.next() {
                Some('[') => consume_csi(&mut characters),
                Some(']') => consume_osc(&mut characters),
                Some(_) | None => {}
            }
            continue;
        }
        if character == '\u{009b}' {
            consume_csi(&mut characters);
            continue;
        }
        if !character.is_control()
            || (character == '\t' && allow_tab)
            || (character == '\n' && allow_newline)
        {
            output.push(character);
        }
    }
    output
}

fn consume_csi(characters: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    for character in characters.by_ref() {
        if character.is_ascii() && ('@'..='~').contains(&character) {
            break;
        }
    }
}

fn consume_osc(characters: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(character) = characters.next() {
        if character == '\u{0007}' {
            break;
        }
        if character == '\u{001b}' && characters.peek() == Some(&'\\') {
            let _ = characters.next();
            break;
        }
    }
}

/// Redacts lexical absolute path spans without consulting the filesystem.
fn redact_absolute_paths(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some((start, end)) = next_absolute_path_span(value, cursor) {
        output.push_str(&value[cursor..start]);
        output.push_str(&safe_external_path_label(&value[start..end]));
        cursor = end;
    }
    output.push_str(&value[cursor..]);
    output
}

fn next_absolute_path_span(value: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = value.as_bytes();
    for (relative, character) in value[from..].char_indices() {
        let start = from + relative;
        if !valid_path_boundary(value, start) {
            continue;
        }
        let windows_drive = character.is_ascii_alphabetic()
            && bytes.get(start + 1) == Some(&b':')
            && matches!(bytes.get(start + 2), Some(b'/' | b'\\'));
        let unc = bytes.get(start) == Some(&b'\\') && bytes.get(start + 1) == Some(&b'\\');
        let posix = character == '/' && bytes.get(start + 1) != Some(&b'/');
        if !(windows_drive || unc || posix) {
            continue;
        }

        let quote = value[..start]
            .chars()
            .next_back()
            .filter(|character| matches!(character, '"' | '\''));
        let end = path_span_end(value, start, quote);
        let candidate = &value[start..end];
        let valid = if windows_drive {
            candidate.len() > 3
        } else if unc {
            candidate.len() > 2
        } else {
            candidate.len() > 1
        };
        if valid {
            let redaction_start = value[..start]
                .strip_suffix("<external-path>")
                .map_or(start, str::len);
            return Some((redaction_start, end));
        }
    }
    None
}

fn valid_path_boundary(value: &str, start: usize) -> bool {
    !value[..start].chars().next_back().is_some_and(|character| {
        character.is_ascii_alphanumeric() || character == '_' || character == '-'
    })
}

fn path_span_end(value: &str, start: usize, quote: Option<char>) -> usize {
    let mut end = start;
    for (relative, character) in value[start..].char_indices() {
        let quoted_end = quote == Some(character);
        let unquoted_end = quote.is_none()
            && (character.is_whitespace()
                || matches!(
                    character,
                    '"' | '\'' | '<' | '>' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';'
                ));
        if quoted_end || unquoted_end || matches!(character, '\n' | '\r') {
            break;
        }
        end = start + relative + character.len_utf8();
    }
    end
}

fn safe_external_path_label(path: &str) -> String {
    let trimmed = path.trim_end_matches(['.', ':', ';', '!', '?']);
    let leaf = trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("path");
    format!("<external-path>/{leaf}")
}

fn opaque_id(kind: &str, source: &str) -> String {
    format!("piui-{kind}-{:x}", Sha256::digest(source.as_bytes()))
}

fn opaque_option_id(source_id: &str, index: usize, raw_option: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_id.as_bytes());
    hasher.update([0]);
    hasher.update(index.to_string().as_bytes());
    hasher.update([0]);
    hasher.update(raw_option.as_bytes());
    format!("piui-extension-option-{:x}", hasher.finalize())
}

fn unsupported_action(id: String, method: Option<&str>, safe_summary: &str) -> ExtensionUiAction {
    let method = match method {
        Some("select") => "select",
        Some("confirm") => "confirm",
        Some("input") => "input",
        Some("editor") => "editor",
        Some("notify") => "notify",
        Some("setStatus") => "setStatus",
        Some("setWidget") => "setWidget",
        Some("setTitle") => "setTitle",
        Some("set_editor_text") => "set_editor_text",
        _ => "unsupported",
    };
    ExtensionUiAction::Unsupported {
        id,
        method: method.into(),
        safe_summary: safe_summary.into(),
    }
}

fn value_frame(source_id: &str, value: &str) -> Value {
    json!({ "type": "extension_ui_response", "id": source_id, "value": value })
}

fn confirmed_frame(source_id: &str, value: bool) -> Value {
    json!({ "type": "extension_ui_response", "id": source_id, "confirmed": value })
}

fn cancelled_frame(source_id: &str) -> Value {
    json!({ "type": "extension_ui_response", "id": source_id, "cancelled": true })
}

#[cfg(test)]
mod tests {
    use super::{
        ExtensionDialogRequest, ExtensionUiAction, ExtensionUiDelivery, ExtensionUiMailbox,
        ExtensionUiResponse, MAX_EDITOR_TEXT_CHARS, MAX_TITLE_CHARS, MAX_WIDGET_LINES,
    };
    use serde_json::{Map, Value, json};

    fn object(value: Value) -> Map<String, Value> {
        value
            .as_object()
            .cloned()
            .expect("request must be an object")
    }

    fn dialog_id(action: &ExtensionUiAction) -> String {
        match action {
            ExtensionUiAction::Dialog { request } => match request {
                ExtensionDialogRequest::Select { id, .. }
                | ExtensionDialogRequest::Confirm { id, .. }
                | ExtensionDialogRequest::Input { id, .. }
                | ExtensionDialogRequest::Editor { id, .. } => id.clone(),
            },
            _ => panic!("expected dialog action"),
        }
    }

    #[test]
    fn select_maps_opaque_options_back_to_raw_values() {
        let mut mailbox = ExtensionUiMailbox::new();
        let request = object(json!({
            "id": "source-private-id",
            "method": "select",
            "title": "Choose",
            "options": ["one", "C:\\Users\\Ada\\two.txt"],
        }));

        let dispatch = mailbox.project(&request);
        let (id, option_id) = match &dispatch.action {
            ExtensionUiAction::Dialog {
                request:
                    ExtensionDialogRequest::Select {
                        id,
                        options,
                        timeout_ms,
                        ..
                    },
            } => {
                assert_eq!(*timeout_ms, None);
                assert_eq!(options.len(), 2);
                assert!(id.starts_with("piui-extension-dialog-"));
                assert!(!id.contains("source-private-id"));
                assert_eq!(options[1].label, "<external-path>/two.txt");
                assert!(!options[1].id.contains("Users"));
                (id.clone(), options[1].id.clone())
            }
            _ => panic!("expected select dialog"),
        };
        assert_eq!(mailbox.pending_len(), 1);

        let frame = mailbox
            .respond(&id, ExtensionUiResponse::Selected { option_id })
            .expect("maps selected opaque id");
        assert_eq!(
            frame,
            json!({
                "type": "extension_ui_response",
                "id": "source-private-id",
                "value": "C:\\Users\\Ada\\two.txt",
            })
        );
    }

    #[test]
    fn confirm_input_and_editor_encode_their_matching_responses() {
        let mut mailbox = ExtensionUiMailbox::new();

        let confirm = mailbox.project(&object(json!({
            "id": "confirm-source",
            "method": "confirm",
            "title": "Confirm",
            "message": "Continue?",
            "timeout": 700_000,
        })));
        let confirm_id = dialog_id(&confirm.action);
        match &confirm.action {
            ExtensionUiAction::Dialog {
                request: ExtensionDialogRequest::Confirm { timeout_ms, .. },
            } => assert_eq!(*timeout_ms, Some(700_000)),
            _ => panic!("expected confirm dialog"),
        }
        assert_eq!(
            mailbox
                .respond(&confirm_id, ExtensionUiResponse::Confirmed { value: true })
                .expect("encodes confirmation"),
            json!({ "type": "extension_ui_response", "id": "confirm-source", "confirmed": true })
        );

        let input = mailbox.project(&object(json!({
            "id": "input-source",
            "method": "input",
            "title": "Input",
            "placeholder": "name",
        })));
        let input_id = dialog_id(&input.action);
        assert_eq!(
            mailbox
                .respond(
                    &input_id,
                    ExtensionUiResponse::Submitted {
                        value: "Ada".into(),
                    },
                )
                .expect("encodes input"),
            json!({ "type": "extension_ui_response", "id": "input-source", "value": "Ada" })
        );

        let editor = mailbox.project(&object(json!({
            "id": "editor-source",
            "method": "editor",
            "title": "Editor",
            "prefill": "draft",
        })));
        let editor_id = dialog_id(&editor.action);
        assert_eq!(
            mailbox
                .respond(
                    &editor_id,
                    ExtensionUiResponse::Submitted {
                        value: "line one\nline two".into(),
                    },
                )
                .expect("encodes editor"),
            json!({
                "type": "extension_ui_response",
                "id": "editor-source",
                "value": "line one\nline two",
            })
        );
    }

    #[test]
    fn malformed_requests_emit_unsupported_and_only_dialogs_are_cancelled() {
        let mut mailbox = ExtensionUiMailbox::new();
        let malformed_dialog = mailbox.project(&object(json!({
            "id": "bad-select",
            "method": "select",
            "title": "Choose",
        })));
        assert_eq!(malformed_dialog.delivery, ExtensionUiDelivery::Dialog);
        assert!(matches!(
            malformed_dialog.action,
            ExtensionUiAction::Unsupported { ref method, .. } if method == "select"
        ));
        assert_eq!(
            malformed_dialog.immediate_response,
            Some(json!({
                "type": "extension_ui_response",
                "id": "bad-select",
                "cancelled": true,
            }))
        );

        let unknown = mailbox.project(&object(json!({
            "id": "unknown-source",
            "method": "custom",
        })));
        assert!(matches!(
            unknown.action,
            ExtensionUiAction::Unsupported { ref method, .. } if method == "unsupported"
        ));
        assert_eq!(
            unknown.immediate_response,
            Some(json!({
                "type": "extension_ui_response",
                "id": "unknown-source",
                "cancelled": true,
            }))
        );

        let malformed_notification = mailbox.project(&object(json!({
            "id": "bad-notify",
            "method": "notify",
            "message": 42,
        })));
        assert_eq!(
            malformed_notification.delivery,
            ExtensionUiDelivery::FireAndForget
        );
        assert!(matches!(
            malformed_notification.action,
            ExtensionUiAction::Unsupported { ref method, .. } if method == "notify"
        ));
        assert!(malformed_notification.immediate_response.is_none());
    }

    #[test]
    fn bounds_controls_and_absolute_paths_are_enforced_at_the_surface() {
        let mut mailbox = ExtensionUiMailbox::new();
        let confirm = mailbox.project(&object(json!({
            "id": "safe-source",
            "method": "confirm",
            "title": "Open \u{0007}C:\\Users\\Ada\\secret.txt",
            "message": "Read /home/ada/private.txt\n\tthen continue\u{0000}",
        })));
        match &confirm.action {
            ExtensionUiAction::Dialog {
                request: ExtensionDialogRequest::Confirm { title, message, .. },
            } => {
                assert_eq!(title, "Open <external-path>/secret.txt");
                assert_eq!(message, "Read <external-path>/private.txt\n\tthen continue");
                assert!(!title.contains("Ada"));
                assert!(!message.contains("/home/ada"));
            }
            _ => panic!("expected sanitized confirm dialog"),
        }

        let quoted = mailbox.project(&object(json!({
            "id": "quoted-path",
            "method": "notify",
            "message": "Open \"C:\\Users\\Ada Lovelace\\secret file.txt\" and <external-path>/home/ada/private.txt",
        })));
        assert!(matches!(
            quoted.action,
            ExtensionUiAction::Notify { ref message, .. }
                if message == "Open \"<external-path>/secret file.txt\" and <external-path>/private.txt"
        ));

        let status = mailbox.project(&object(json!({
            "id": "ansi-status",
            "method": "setStatus",
            "statusKey": "lsp",
            "statusText": "\u{001b}[32mLSP\u{001b}[0m \u{001b}[2m•\u{001b}[0m",
        })));
        assert!(matches!(
            status.action,
            ExtensionUiAction::Status { ref text, .. } if text.as_deref() == Some("LSP •")
        ));

        let zero_timeout = mailbox.project(&object(json!({
            "id": "zero-timeout",
            "method": "confirm",
            "title": "Continue?",
            "message": "Untimed",
            "timeout": 0,
        })));
        assert!(matches!(
            zero_timeout.action,
            ExtensionUiAction::Dialog {
                request: ExtensionDialogRequest::Confirm {
                    timeout_ms: None,
                    ..
                }
            }
        ));

        let excessive_timeout = mailbox.project(&object(json!({
            "id": "excessive-timeout",
            "method": "confirm",
            "title": "Continue?",
            "message": "Wait",
            "timeout": 86_400_001_u64,
        })));
        assert!(matches!(
            excessive_timeout.action,
            ExtensionUiAction::Unsupported { .. }
        ));
        assert!(excessive_timeout.immediate_response.is_some());

        let overflow = mailbox.project(&object(json!({
            "id": "too-long-title",
            "method": "input",
            "title": "x".repeat(MAX_TITLE_CHARS + 1),
        })));
        assert!(matches!(
            overflow.action,
            ExtensionUiAction::Unsupported { .. }
        ));
        assert!(overflow.immediate_response.is_some());

        let widget = mailbox.project(&object(json!({
            "id": "too-many-widget-lines",
            "method": "setWidget",
            "widgetKey": "widget",
            "widgetLines": vec!["line"; MAX_WIDGET_LINES + 1],
        })));
        assert!(matches!(
            widget.action,
            ExtensionUiAction::Unsupported { .. }
        ));
        assert!(widget.immediate_response.is_none());

        let editor_text = mailbox.project(&object(json!({
            "id": "editor-text",
            "method": "set_editor_text",
            "text": "x".repeat(MAX_EDITOR_TEXT_CHARS + 1),
        })));
        assert!(matches!(
            editor_text.action,
            ExtensionUiAction::Unsupported { .. }
        ));
    }

    #[test]
    fn valid_responses_are_consumed_exactly_once_and_mismatches_remain_retryable() {
        let mut mailbox = ExtensionUiMailbox::new();
        let select = mailbox.project(&object(json!({
            "id": "select-source",
            "method": "select",
            "title": "Select",
            "options": ["one"],
        })));
        let (id, option_id) = match &select.action {
            ExtensionUiAction::Dialog {
                request: ExtensionDialogRequest::Select { id, options, .. },
            } => (id.clone(), options[0].id.clone()),
            _ => panic!("expected select dialog"),
        };

        assert!(
            mailbox
                .respond(&id, ExtensionUiResponse::Confirmed { value: true })
                .is_err()
        );
        assert_eq!(mailbox.pending_len(), 1);
        assert!(
            mailbox
                .respond(&id, ExtensionUiResponse::Selected { option_id })
                .is_ok()
        );
        assert_eq!(mailbox.pending_len(), 0);
        assert!(
            mailbox
                .respond(&id, ExtensionUiResponse::Cancelled)
                .is_err()
        );
    }

    #[test]
    fn draining_pending_dialogs_encodes_cancellations() {
        let mut mailbox = ExtensionUiMailbox::new();
        let _ = mailbox.project(&object(json!({
            "id": "first-source",
            "method": "confirm",
            "title": "First",
            "message": "Continue?",
        })));
        let _ = mailbox.project(&object(json!({
            "id": "second-source",
            "method": "input",
            "title": "Second",
        })));

        let frames = mailbox.drain_cancellations();
        assert_eq!(mailbox.pending_len(), 0);
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().any(|frame| {
            frame
                == &json!({
                    "type": "extension_ui_response",
                    "id": "first-source",
                    "cancelled": true,
                })
        }));
        assert!(frames.iter().any(|frame| {
            frame
                == &json!({
                    "type": "extension_ui_response",
                    "id": "second-source",
                    "cancelled": true,
                })
        }));
        assert!(mailbox.drain_cancellations().is_empty());
    }

    #[test]
    fn serialized_actions_and_deserialized_responses_use_the_public_shape() {
        let action = ExtensionUiAction::Dialog {
            request: ExtensionDialogRequest::Select {
                id: "opaque-dialog".into(),
                title: "Choose".into(),
                options: vec![super::ExtensionDialogOption {
                    id: "opaque-option".into(),
                    label: "Option".into(),
                }],
                timeout_ms: Some(600_000),
            },
        };
        let serialized = serde_json::to_value(&action).expect("serializes action");
        assert_eq!(serialized["action"], "dialog");
        assert_eq!(serialized["request"]["kind"], "select");
        assert_eq!(serialized["request"]["timeoutMs"], 600_000);
        assert_eq!(serialized["request"]["options"][0]["id"], "opaque-option");

        let status = serde_json::to_value(ExtensionUiAction::Status {
            key: "opaque-status".into(),
            text: None,
        })
        .expect("serializes status action");
        assert_eq!(status["action"], "status");
        assert!(status.get("text").is_none());

        let response: ExtensionUiResponse = serde_json::from_value(json!({
            "kind": "selected",
            "optionId": "opaque-option",
        }))
        .expect("deserializes selected response");
        assert!(matches!(
            response,
            ExtensionUiResponse::Selected { option_id } if option_id == "opaque-option"
        ));
    }
}
