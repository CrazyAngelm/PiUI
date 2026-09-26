//! Declarative form fields PiUI renders for a plugin: its settings and the
//! configuration of its node types. Values are flat strings, numbers and
//! booleans that PiUI stores and checks; plugins never render their own
//! settings forms.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Largest encoded settings document or node configuration.
pub const MAX_VALUES_BYTES: usize = 64 * 1024;
/// Longest value of a `text` field without its own `maxLength`.
pub const DEFAULT_TEXT_CHARS: u32 = 1000;
/// Longest value of a `long-text` field (and the `maxLength` ceiling).
pub const MAX_TEXT_CHARS: u32 = 4000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FieldKind {
    Text,
    LongText,
    Number,
    Boolean,
    Choice,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldOption {
    pub value: String,
    pub label: String,
}

/// One field. The JSON shape is `PluginFieldV1`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub kind: FieldKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<FieldOption>>,
}

/// Why a field declaration is invalid. Messages are English locale keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldRule {
    DuplicateKey,
    OptionsNotAllowed,
    OptionsRequired,
    DuplicateOption,
    RangeNotAllowed,
    Range,
    LengthNotAllowed,
    DefaultType,
    DefaultOutOfRange,
}

impl FieldRule {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::DuplicateKey => "Two fields use the key “{0}”.",
            Self::OptionsNotAllowed => "Field “{0}” has options, but only choice fields can.",
            Self::OptionsRequired => "Choice field “{0}” needs options.",
            Self::DuplicateOption => "Choice field “{0}” repeats an option value.",
            Self::RangeNotAllowed => {
                "Field “{0}” has a minimum or maximum, but only number fields can."
            }
            Self::Range => "Field “{0}” has a minimum above its maximum.",
            Self::LengthNotAllowed => "Field “{0}” has maxLength, but only text fields can.",
            Self::DefaultType => "The default of field “{0}” does not match its type.",
            Self::DefaultOutOfRange => "The default of field “{0}” is not an allowed value.",
        }
    }
}

/// Checks the declarations of one form: unique keys and type-specific
/// properties only on their types. Returns the first key that breaks a rule.
pub fn validate_fields(fields: &[Field]) -> Result<(), (FieldRule, String)> {
    for (index, field) in fields.iter().enumerate() {
        let fail = |rule| Err((rule, field.key.clone()));
        if fields[..index].iter().any(|other| other.key == field.key) {
            return fail(FieldRule::DuplicateKey);
        }
        match (field.kind, &field.options) {
            (FieldKind::Choice, None) => return fail(FieldRule::OptionsRequired),
            (FieldKind::Choice, Some(options)) => {
                for (position, option) in options.iter().enumerate() {
                    if options[..position]
                        .iter()
                        .any(|other| other.value == option.value)
                    {
                        return fail(FieldRule::DuplicateOption);
                    }
                }
            }
            (_, Some(_)) => return fail(FieldRule::OptionsNotAllowed),
            (_, None) => {}
        }
        if field.kind != FieldKind::Number && (field.minimum.is_some() || field.maximum.is_some()) {
            return fail(FieldRule::RangeNotAllowed);
        }
        if let (Some(minimum), Some(maximum)) = (field.minimum, field.maximum)
            && minimum > maximum
        {
            return fail(FieldRule::Range);
        }
        if !matches!(field.kind, FieldKind::Text | FieldKind::LongText)
            && field.max_length.is_some()
        {
            return fail(FieldRule::LengthNotAllowed);
        }
        if let Some(default) = &field.default {
            match check_value(field, default) {
                Ok(()) => {}
                Err(ValueIssue::Type) => return fail(FieldRule::DefaultType),
                Err(_) => return fail(FieldRule::DefaultOutOfRange),
            }
        }
    }
    Ok(())
}

/// Why a stored value is refused. Messages are English locale keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueIssue {
    Unknown,
    Type,
    Required,
    TooLong,
    Range,
    Choice,
    Characters,
    TooLarge,
}

impl ValueIssue {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Unknown => "“{0}” is not a declared field.",
            Self::Type => "“{0}” has a value of the wrong type.",
            Self::Required => "“{0}” is required.",
            Self::TooLong => "“{0}” is too long.",
            Self::Range => "“{0}” is outside its allowed range.",
            Self::Choice => "“{0}” is not one of its options.",
            Self::Characters => "“{0}” contains control characters.",
            Self::TooLarge => "The values are larger than 64 KiB.",
        }
    }
}

fn text_limit(field: &Field) -> usize {
    let limit = field.max_length.unwrap_or(match field.kind {
        FieldKind::LongText => MAX_TEXT_CHARS,
        _ => DEFAULT_TEXT_CHARS,
    });
    usize::try_from(limit.min(MAX_TEXT_CHARS)).unwrap_or(usize::MAX)
}

fn check_value(field: &Field, value: &Value) -> Result<(), ValueIssue> {
    match field.kind {
        FieldKind::Text | FieldKind::LongText => {
            let text = value.as_str().ok_or(ValueIssue::Type)?;
            let multiline = field.kind == FieldKind::LongText;
            if text.chars().any(|character| {
                character.is_control() && !(multiline && (character == '\n' || character == '\t'))
            }) {
                return Err(ValueIssue::Characters);
            }
            if text.chars().count() > text_limit(field) {
                return Err(ValueIssue::TooLong);
            }
            Ok(())
        }
        FieldKind::Number => {
            let number = value.as_f64().ok_or(ValueIssue::Type)?;
            if !number.is_finite()
                || field.minimum.is_some_and(|minimum| number < minimum)
                || field.maximum.is_some_and(|maximum| number > maximum)
            {
                return Err(ValueIssue::Range);
            }
            Ok(())
        }
        FieldKind::Boolean => value.as_bool().map(|_| ()).ok_or(ValueIssue::Type),
        FieldKind::Choice => {
            let text = value.as_str().ok_or(ValueIssue::Type)?;
            field
                .options
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|option| option.value == text)
                .then_some(())
                .ok_or(ValueIssue::Choice)
        }
    }
}

fn blank(value: &Value) -> bool {
    value.as_str().is_some_and(|text| text.trim().is_empty())
}

/// Checks `values` against `fields` and returns them with declared defaults
/// for absent keys. Unknown keys are refused, never dropped.
pub fn resolve_values(
    fields: &[Field],
    values: &Map<String, Value>,
) -> Result<Map<String, Value>, (ValueIssue, String)> {
    for key in values.keys() {
        if !fields.iter().any(|field| field.key == *key) {
            return Err((ValueIssue::Unknown, key.clone()));
        }
    }
    let mut resolved = Map::new();
    for field in fields {
        let value = values.get(&field.key).or(field.default.as_ref());
        match value {
            Some(value) => {
                check_value(field, value).map_err(|issue| (issue, field.key.clone()))?;
                if field.required == Some(true) && blank(value) {
                    return Err((ValueIssue::Required, field.key.clone()));
                }
                resolved.insert(field.key.clone(), value.clone());
            }
            None if field.required == Some(true) => {
                return Err((ValueIssue::Required, field.key.clone()));
            }
            None => {}
        }
    }
    let encoded =
        serde_json::to_vec(&resolved).map_err(|_| (ValueIssue::TooLarge, String::new()))?;
    if encoded.len() > MAX_VALUES_BYTES {
        return Err((ValueIssue::TooLarge, String::new()));
    }
    Ok(resolved)
}

/// Stored values that still match an updated declaration; the rest fall
/// back to their defaults. Used when a plugin update changes its settings.
#[must_use]
pub fn carry_values(fields: &[Field], stored: &Map<String, Value>) -> Map<String, Value> {
    stored
        .iter()
        .filter(|(key, value)| {
            fields
                .iter()
                .find(|field| field.key == **key)
                .is_some_and(|field| check_value(field, value).is_ok())
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(value: Value) -> Vec<Field> {
        serde_json::from_value(value).expect("fields")
    }

    #[test]
    fn declarations_keep_type_specific_properties_on_their_types() {
        let valid = fields(json!([
            { "key": "greeting", "label": "Greeting", "type": "text", "default": "Hello", "maxLength": 40 },
            { "key": "count", "label": "Count", "type": "number", "minimum": 1, "maximum": 10, "default": 3 },
            { "key": "loud", "label": "Loud", "type": "boolean", "default": false },
            { "key": "tone", "label": "Tone", "type": "choice", "options": [{ "value": "warm", "label": "Warm" }], "default": "warm" }
        ]));
        assert_eq!(validate_fields(&valid), Ok(()));
        let cases = [
            (
                json!([{ "key": "a", "label": "A", "type": "text" }, { "key": "a", "label": "B", "type": "boolean" }]),
                FieldRule::DuplicateKey,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "text", "options": [{ "value": "x", "label": "X" }] }]),
                FieldRule::OptionsNotAllowed,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "choice" }]),
                FieldRule::OptionsRequired,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "choice", "options": [{ "value": "x", "label": "X" }, { "value": "x", "label": "Y" }] }]),
                FieldRule::DuplicateOption,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "text", "minimum": 1 }]),
                FieldRule::RangeNotAllowed,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "number", "minimum": 5, "maximum": 1 }]),
                FieldRule::Range,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "boolean", "maxLength": 3 }]),
                FieldRule::LengthNotAllowed,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "boolean", "default": "yes" }]),
                FieldRule::DefaultType,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "number", "maximum": 3, "default": 4 }]),
                FieldRule::DefaultOutOfRange,
            ),
            (
                json!([{ "key": "a", "label": "A", "type": "choice", "options": [{ "value": "x", "label": "X" }], "default": "y" }]),
                FieldRule::DefaultOutOfRange,
            ),
        ];
        for (value, rule) in cases {
            assert_eq!(
                validate_fields(&fields(value.clone())).map_err(|(rule, _)| rule),
                Err(rule),
                "{value}"
            );
        }
        assert!(
            serde_json::from_value::<Vec<Field>>(
                json!([{ "key": "a", "label": "A", "type": "text", "secret": true }])
            )
            .is_err()
        );
    }

    #[test]
    fn values_are_checked_resolved_with_defaults_and_never_dropped() {
        let declared = fields(json!([
            { "key": "greeting", "label": "Greeting", "type": "text", "default": "Hello", "maxLength": 10 },
            { "key": "count", "label": "Count", "type": "number", "minimum": 1, "maximum": 10 },
            { "key": "note", "label": "Note", "type": "long-text" },
            { "key": "name", "label": "Name", "type": "text", "required": true }
        ]));
        let values = |value: Value| value.as_object().cloned().expect("object");
        let resolved = resolve_values(&declared, &values(json!({ "name": "Ada", "count": 2 })))
            .expect("valid");
        assert_eq!(resolved.get("greeting"), Some(&json!("Hello")));
        assert_eq!(resolved.get("note"), None);
        let issue = |value: Value| resolve_values(&declared, &values(value)).map(|_| ());
        assert_eq!(
            issue(json!({ "name": "Ada", "extra": 1 })),
            Err((ValueIssue::Unknown, "extra".into()))
        );
        assert_eq!(issue(json!({})), Err((ValueIssue::Required, "name".into())));
        assert_eq!(
            issue(json!({ "name": "  " })),
            Err((ValueIssue::Required, "name".into()))
        );
        assert_eq!(
            issue(json!({ "name": "Ada", "count": 11 })),
            Err((ValueIssue::Range, "count".into()))
        );
        assert_eq!(
            issue(json!({ "name": "Ada", "count": "2" })),
            Err((ValueIssue::Type, "count".into()))
        );
        assert_eq!(
            issue(json!({ "name": "Ada", "greeting": "Hello there!" })),
            Err((ValueIssue::TooLong, "greeting".into()))
        );
        assert_eq!(
            issue(json!({ "name": "A\nda" })),
            Err((ValueIssue::Characters, "name".into()))
        );
        assert!(issue(json!({ "name": "Ada", "note": "two\nlines" })).is_ok());
        let carried = carry_values(
            &declared,
            &values(json!({ "greeting": "Hi", "count": 50, "gone": true })),
        );
        assert_eq!(carried, values(json!({ "greeting": "Hi" })));
    }
}
