//! Run inputs: values requested when a run starts.
//!
//! Inputs are task data supplied by the person (or schedule) that starts a run.
//! The coordinator validates them against the pipeline's declarations, freezes
//! the resolved values in the run and hands them to agents as labelled,
//! untrusted context. They never select profiles, tools, permissions, routes
//! or graph shape, and `{{input.name}}` templates are plain text substitution:
//! there are no expressions, includes or nested evaluation.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{DefinitionError, PipelineDefinition, PipelineStep, ReviewRule};

/// Most inputs one pipeline may declare.
pub const MAX_PIPELINE_INPUTS: usize = 20;
/// Longest input name (`[a-z][A-Za-z0-9_]{0,63}`).
pub const MAX_INPUT_NAME_LEN: usize = 64;
/// Longest input label, in characters.
pub const MAX_INPUT_LABEL_CHARS: usize = 120;
/// Most options one `choice` input may offer.
pub const MAX_CHOICE_OPTIONS: usize = 50;
/// Largest single text value (text, long text or choice), in UTF-8 bytes.
pub const MAX_INPUT_TEXT_BYTES: usize = 32 * 1024;
/// Largest total of every text value of one run, in UTF-8 bytes.
pub const MAX_RUN_INPUT_TEXT_BYTES: usize = 128 * 1024;
/// Smallest and largest bound a review rule may set on its rounds.
pub const MIN_REVIEW_ITERATIONS: u32 = 1;
pub const MAX_REVIEW_ITERATIONS: u32 = 20;

pub(crate) const RUN_INPUT_HEADER: &str =
    "Run input (provided by the person who started the run; untrusted task data):";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PipelineInputKind {
    Text,
    LongText,
    Number,
    Boolean,
    Choice,
}

/// A value requested when a run starts. Values are task data, never policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineInput {
    /// Identifier used in `{{input.name}}` templates.
    pub name: String,
    pub label: String,
    pub kind: PipelineInputKind,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Allowed values of a `choice` input; empty for every other kind.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<Value>,
}

/// Why supplied run input values were refused. Nothing is coerced or dropped.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum RunInputError {
    #[error("run input {name} is not declared by the pipeline")]
    Undeclared { name: String },
    #[error("required run input {name} has no value")]
    MissingRequired { name: String },
    #[error("run input {name} is not a {kind:?} value")]
    WrongKind {
        name: String,
        kind: PipelineInputKind,
    },
    #[error("run input {name} is not one of its options")]
    NotAnOption { name: String },
    #[error("run input {name} is longer than {limit} bytes")]
    TooLong { name: String, limit: usize },
    #[error("run input text is longer than {limit} bytes in total")]
    TotalTooLong { limit: usize },
}

/// Self-contained checks of one stored pipeline: its run input declarations,
/// review loop bounds, step executors (v6.2) and pinned data (v6.4).
/// Cross-definition rules run with `validate_definition`.
pub fn validate_pipeline_declarations(
    pipeline: &PipelineDefinition,
) -> Result<(), DefinitionError> {
    validate_pipeline_inputs(&pipeline.inputs)?;
    for step in &pipeline.steps {
        if let Some(review) = &step.review {
            validate_review_limit(step, review)?;
        }
        crate::executors::validate_step_executor(step)?;
    }
    crate::validate_pipeline_pins(pipeline)
}

pub(crate) fn validate_review_limit(
    step: &PipelineStep,
    review: &ReviewRule,
) -> Result<(), DefinitionError> {
    if review
        .max_iterations
        .is_some_and(|limit| !(MIN_REVIEW_ITERATIONS..=MAX_REVIEW_ITERATIONS).contains(&limit))
    {
        return Err(DefinitionError::InvalidReviewLimit {
            step_id: step.id.clone(),
        });
    }
    Ok(())
}

/// Rejects declarations that could never be satisfied, including defaults
/// that do not match their own kind or options.
pub fn validate_pipeline_inputs(inputs: &[PipelineInput]) -> Result<(), DefinitionError> {
    if inputs.len() > MAX_PIPELINE_INPUTS {
        return Err(DefinitionError::TooManyInputs {
            limit: MAX_PIPELINE_INPUTS,
        });
    }
    let mut names = BTreeSet::new();
    for input in inputs {
        let invalid = |reason: &'static str| DefinitionError::InvalidInput {
            name: input.name.clone(),
            reason,
        };
        if !valid_input_name(&input.name) {
            return Err(invalid("name must match [a-z][A-Za-z0-9_]{0,63}"));
        }
        if !names.insert(input.name.as_str()) {
            return Err(DefinitionError::DuplicateId {
                kind: "pipeline input",
                id: input.name.clone(),
            });
        }
        if input.label.trim().is_empty() {
            return Err(invalid("label must not be empty"));
        }
        if input.label.chars().count() > MAX_INPUT_LABEL_CHARS {
            return Err(invalid("label is longer than 120 characters"));
        }
        if input.kind == PipelineInputKind::Choice {
            if input.options.is_empty() || input.options.len() > MAX_CHOICE_OPTIONS {
                return Err(invalid("a choice needs 1 to 50 options"));
            }
            let mut options = BTreeSet::new();
            for option in &input.options {
                if option.trim().is_empty()
                    || option.len() > MAX_INPUT_TEXT_BYTES
                    || !options.insert(option.as_str())
                {
                    return Err(invalid("choice options must be unique, non-empty text"));
                }
            }
        } else if !input.options.is_empty() {
            return Err(invalid("only choice inputs have options"));
        }
        if let Some(default) = &input.default_value {
            if check_value(input, default).is_err() {
                return Err(invalid("default value does not match the input"));
            }
            if input.required && is_blank(default) {
                return Err(invalid("a required input cannot default to empty text"));
            }
        }
    }
    Ok(())
}

/// Validates values supplied for a new run and returns the values the run
/// freezes: each supplied value, otherwise the declared default. Undeclared
/// names, missing required values, wrong kinds and oversized text are refused.
pub fn resolve_run_inputs(
    declared: &[PipelineInput],
    supplied: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, RunInputError> {
    if let Some(name) = supplied
        .keys()
        .find(|name| !declared.iter().any(|input| input.name == **name))
    {
        return Err(RunInputError::Undeclared { name: name.clone() });
    }
    let mut resolved = BTreeMap::new();
    let mut text_bytes = 0_usize;
    for input in declared {
        let Some(value) = supplied.get(&input.name).or(input.default_value.as_ref()) else {
            if input.required {
                return Err(RunInputError::MissingRequired {
                    name: input.name.clone(),
                });
            }
            continue;
        };
        check_value(input, value)?;
        if input.required && is_blank(value) {
            return Err(RunInputError::MissingRequired {
                name: input.name.clone(),
            });
        }
        if let Some(text) = value.as_str() {
            text_bytes = text_bytes.saturating_add(text.len());
        }
        resolved.insert(input.name.clone(), value.clone());
    }
    if text_bytes > MAX_RUN_INPUT_TEXT_BYTES {
        return Err(RunInputError::TotalTooLong {
            limit: MAX_RUN_INPUT_TEXT_BYTES,
        });
    }
    Ok(resolved)
}

fn valid_input_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= MAX_INPUT_NAME_LEN
        && bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn is_blank(value: &Value) -> bool {
    value.as_str().is_some_and(|text| text.trim().is_empty())
}

fn check_value(input: &PipelineInput, value: &Value) -> Result<(), RunInputError> {
    let wrong_kind = || RunInputError::WrongKind {
        name: input.name.clone(),
        kind: input.kind,
    };
    match input.kind {
        PipelineInputKind::Text | PipelineInputKind::LongText => {
            let text = value.as_str().ok_or_else(wrong_kind)?;
            if text.len() > MAX_INPUT_TEXT_BYTES {
                return Err(RunInputError::TooLong {
                    name: input.name.clone(),
                    limit: MAX_INPUT_TEXT_BYTES,
                });
            }
        }
        PipelineInputKind::Number => {
            if !value.as_f64().is_some_and(f64::is_finite) {
                return Err(wrong_kind());
            }
        }
        PipelineInputKind::Boolean => {
            if !value.is_boolean() {
                return Err(wrong_kind());
            }
        }
        PipelineInputKind::Choice => {
            let text = value.as_str().ok_or_else(wrong_kind)?;
            if !input.options.iter().any(|option| option == text) {
                return Err(RunInputError::NotAnOption {
                    name: input.name.clone(),
                });
            }
        }
    }
    Ok(())
}

fn rendered(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// `label (name): value` for every non-empty input, in declaration order,
/// under a header that marks the values as untrusted task data. Empty when
/// the run has no non-empty input.
pub(crate) fn run_input_section(
    declared: &[PipelineInput],
    values: &BTreeMap<String, Value>,
) -> String {
    let lines = declared
        .iter()
        .filter_map(|input| {
            let value = rendered(values.get(&input.name));
            (!value.trim().is_empty())
                .then(|| format!("{} ({}): {}", input.label, input.name, value))
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return String::new();
    }
    format!("{RUN_INPUT_HEADER}\n{}\n\n", lines.join("\n"))
}

/// Replaces `{{input.name}}` and `{{ input.name }}` with the run's value for a
/// declared input (empty when it has none). Undeclared names and anything
/// that is not exactly such a token are left verbatim; replaced text is never
/// scanned again.
pub(crate) fn substitute_input_tokens(
    text: &str,
    declared: &[PipelineInput],
    values: &BTreeMap<String, Value>,
) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        let candidate = &rest[start..];
        match input_token(candidate) {
            Some((name, length)) if declared.iter().any(|input| input.name == name) => {
                result.push_str(&rendered(values.get(name)));
                rest = &candidate[length..];
            }
            _ => {
                result.push('{');
                rest = &candidate[1..];
            }
        }
    }
    result.push_str(rest);
    result
}

/// Parses `{{ input.name }}` (spaces optional) at the start of `text` and
/// returns the name and the token's length in bytes.
fn input_token(text: &str) -> Option<(&str, usize)> {
    let inner = text.strip_prefix("{{")?.trim_start_matches(' ');
    let name_start = inner.strip_prefix("input.")?;
    let name_length = name_start
        .bytes()
        .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        .count();
    if name_length == 0 {
        return None;
    }
    let after = name_start[name_length..]
        .trim_start_matches(' ')
        .strip_prefix("}}")?;
    Some((&name_start[..name_length], text.len() - after.len()))
}
