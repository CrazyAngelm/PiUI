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
    let object = value.as_object().ok_or("result-not-object")?;
    for field in fields {
        let value = object.get(&field.name).ok_or("result-missing-field")?;
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
        if !valid {
            return Err("result-field-type");
        }
    }
    Ok(())
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
}
