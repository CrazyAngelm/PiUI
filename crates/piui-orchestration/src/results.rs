//! Result documents are task outputs, never replacement native transcripts.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultField {
    pub name: String,
    pub kind: ResultFieldKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResultFieldKind {
    Text,
    Number,
    Boolean,
    TextList,
    Artifact,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputBinding {
    pub source_step_id: String,
    pub field: String,
    pub name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultSelection {
    pub field: String,
    pub name: String,
}

pub fn project_result(text: &str, fields: &[ResultSelection]) -> Result<String, &'static str> {
    if fields.is_empty() {
        return Ok(text.into());
    }
    let value: Value = serde_json::from_str(text).map_err(|_| "result-invalid-json")?;
    let mut selected = serde_json::Map::new();
    for field in fields {
        if selected.contains_key(&field.name) {
            return Err("duplicate-input-name");
        }
        selected.insert(
            field.name.clone(),
            value
                .get(&field.field)
                .ok_or("result-missing-field")?
                .clone(),
        );
    }
    Ok(Value::Object(selected).to_string())
}

pub fn validate_result(fields: &[ResultField], text: &str) -> Result<(), &'static str> {
    if fields.is_empty() {
        return Ok(());
    }
    let value: Value = serde_json::from_str(text.trim()).map_err(|_| "result-invalid-json")?;
    validate_result_value(fields, &value)
}

/// `validate_result` for an already parsed result, such as a script's JSON
/// stdout. The same codes apply; nothing is coerced.
pub fn validate_result_value(fields: &[ResultField], value: &Value) -> Result<(), &'static str> {
    if fields.is_empty() {
        return Ok(());
    }
    let object = value.as_object().ok_or("result-not-object")?;
    fields
        .iter()
        .find_map(|field| field_issue(field, object))
        .map_or(Ok(()), Err)
}

/// One declared result field that a result object does not satisfy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultFieldIssue {
    pub field: String,
    /// `result-missing-field` or `result-field-type`, the code
    /// [`validate_result_value`] reports for this field.
    pub code: &'static str,
}

/// Every declared field of `value` that fails the check of
/// [`validate_result_value`], in declared order. Empty when `value` is not an
/// object: that is a whole-result failure (`result-not-object`).
pub fn result_field_issues(fields: &[ResultField], value: &Value) -> Vec<ResultFieldIssue> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    fields
        .iter()
        .filter_map(|field| {
            field_issue(field, object).map(|code| ResultFieldIssue {
                field: field.name.clone(),
                code,
            })
        })
        .collect()
}

fn field_issue(
    field: &ResultField,
    object: &serde_json::Map<String, Value>,
) -> Option<&'static str> {
    let Some(value) = object.get(&field.name) else {
        return Some("result-missing-field");
    };
    let valid = match field.kind {
        ResultFieldKind::Text | ResultFieldKind::Artifact => {
            value.as_str().is_some_and(|v| !v.trim().is_empty())
        }
        ResultFieldKind::Number => value.is_number(),
        ResultFieldKind::Boolean => value.is_boolean(),
        ResultFieldKind::TextList => value.as_array().is_some_and(|items| {
            items
                .iter()
                .all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
        }),
    };
    (!valid).then_some("result-field-type")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_native_result_without_coercion_or_markdown_extraction() {
        let fields = vec![ResultField {
            name: "passed".into(),
            kind: ResultFieldKind::Boolean,
        }];
        assert!(validate_result(&fields, r#"{"passed":false}"#).is_ok());
        assert_eq!(
            validate_result(&fields, r#"{"passed":"true"}"#),
            Err("result-field-type")
        );
        assert_eq!(validate_result(&fields, "{}"), Err("result-missing-field"));
        assert_eq!(
            validate_result(&fields, "Everything passed"),
            Err("result-invalid-json")
        );
        assert!(validate_result(&[], "Ordinary free-form response").is_ok());
    }

    #[test]
    fn field_issues_list_every_failing_field_with_the_run_codes() {
        let fields = vec![
            ResultField {
                name: "files".into(),
                kind: ResultFieldKind::Number,
            },
            ResultField {
                name: "summary".into(),
                kind: ResultFieldKind::Text,
            },
            ResultField {
                name: "passed".into(),
                kind: ResultFieldKind::Boolean,
            },
        ];
        let value = serde_json::json!({"files": "3", "passed": true});
        assert_eq!(
            result_field_issues(&fields, &value),
            vec![
                ResultFieldIssue {
                    field: "files".into(),
                    code: "result-field-type",
                },
                ResultFieldIssue {
                    field: "summary".into(),
                    code: "result-missing-field",
                },
            ]
        );
        // The first issue is exactly what a run records.
        assert_eq!(
            validate_result_value(&fields, &value),
            Err("result-field-type")
        );
        let valid = serde_json::json!({"files": 3, "summary": "ok", "passed": false});
        assert!(result_field_issues(&fields, &valid).is_empty());
        assert!(validate_result_value(&fields, &valid).is_ok());
        // A non-object is a whole-result failure, not a field issue.
        assert!(result_field_issues(&fields, &serde_json::json!([1])).is_empty());
        assert_eq!(
            validate_result_value(&fields, &serde_json::json!([1])),
            Err("result-not-object")
        );
    }
}
