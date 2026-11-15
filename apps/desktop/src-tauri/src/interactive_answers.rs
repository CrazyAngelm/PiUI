//! Host-owned interactive-answer instructions and their preference (ADR-067).

use crate::state::HostState;
use piui_runtime::workspace_runtime::HarnessKind;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub(crate) const INSTRUCTION: &str = include_str!("interactive_answers_instruction.md");

/// Hermes repeats the chat's instructions on every turn, so this fixed block
/// is supplied only to the other harnesses.
pub(crate) fn applies(harness: HarnessKind) -> bool {
    !matches!(harness, HarnessKind::Hermes)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractiveAnswersSettingsV1 {
    pub protocol: u8,
    pub enabled: bool,
    pub read_only: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractiveAnswersSettingsRequest {}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractiveAnswersUpdateRequest {
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum InteractiveAnswersError {
    ReadOnly,
    Io,
}

fn settings(enabled: bool, safe_mode: bool) -> InteractiveAnswersSettingsV1 {
    InteractiveAnswersSettingsV1 {
        protocol: 1,
        enabled: enabled && !safe_mode,
        read_only: safe_mode,
    }
}

fn ensure_writable(safe_mode: bool) -> Result<(), InteractiveAnswersError> {
    if safe_mode {
        Err(InteractiveAnswersError::ReadOnly)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn interactive_answers_settings_v1(
    app: AppHandle,
    request: InteractiveAnswersSettingsRequest,
) -> Result<InteractiveAnswersSettingsV1, InteractiveAnswersError> {
    let InteractiveAnswersSettingsRequest {} = request;
    let host = app
        .try_state::<HostState>()
        .ok_or(InteractiveAnswersError::Io)?;
    if host.safe_mode {
        return Ok(settings(false, true));
    }
    let enabled = host
        .index
        .lock()
        .map_err(|_| InteractiveAnswersError::Io)?
        .interactive_answers()
        .map_err(|_| InteractiveAnswersError::Io)?;
    Ok(settings(enabled, false))
}

#[tauri::command]
pub async fn interactive_answers_update_v1(
    app: AppHandle,
    request: InteractiveAnswersUpdateRequest,
) -> Result<InteractiveAnswersSettingsV1, InteractiveAnswersError> {
    let host = app
        .try_state::<HostState>()
        .ok_or(InteractiveAnswersError::Io)?;
    ensure_writable(host.safe_mode)?;
    // Keep the store lock until the matching live flag is applied, so two
    // concurrent updates cannot leave the older flag behind the newer record.
    let mut index = host.index.lock().map_err(|_| InteractiveAnswersError::Io)?;
    let enabled = index
        .set_interactive_answers(request.enabled)
        .map_err(|_| InteractiveAnswersError::Io)?;
    host.workspace.set_interactive_answers(enabled);
    Ok(settings(enabled, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interactive_answers_safe_mode_is_off_and_read_only() {
        assert_eq!(
            settings(true, true),
            InteractiveAnswersSettingsV1 {
                protocol: 1,
                enabled: false,
                read_only: true,
            }
        );
        assert_eq!(
            ensure_writable(true),
            Err(InteractiveAnswersError::ReadOnly)
        );
        assert_eq!(ensure_writable(false), Ok(()));
        assert!(!settings(false, false).enabled);
        assert!(settings(true, false).enabled);
    }

    #[test]
    fn interactive_answers_contract_rejects_unknown_fields_and_serializes_fixed_codes() {
        assert!(serde_json::from_str::<InteractiveAnswersSettingsRequest>("{}").is_ok());
        assert!(
            serde_json::from_str::<InteractiveAnswersSettingsRequest>(r#"{"enabled":true}"#)
                .is_err()
        );
        assert!(
            serde_json::from_str::<InteractiveAnswersUpdateRequest>(r#"{"enabled":true}"#).is_ok()
        );
        assert!(serde_json::from_str::<InteractiveAnswersUpdateRequest>("{}").is_err());
        assert!(
            serde_json::from_str::<InteractiveAnswersUpdateRequest>(
                r#"{"enabled":false,"extra":true}"#
            )
            .is_err()
        );
        assert_eq!(
            serde_json::to_value(settings(true, false)).expect("settings serialize"),
            serde_json::json!({ "protocol": 1, "enabled": true, "readOnly": false })
        );
        assert_eq!(
            serde_json::to_value(InteractiveAnswersError::ReadOnly).expect("error serializes"),
            serde_json::json!({ "code": "read-only" })
        );
        assert_eq!(
            serde_json::to_value(InteractiveAnswersError::Io).expect("error serializes"),
            serde_json::json!({ "code": "io" })
        );
    }

    #[test]
    fn interactive_answers_excludes_hermes() {
        assert!(!applies(HarnessKind::Hermes));
        for harness in [
            HarnessKind::Pi,
            HarnessKind::Nano,
            HarnessKind::Codex,
            HarnessKind::PrimeAgent,
            HarnessKind::ClaudeCode,
        ] {
            assert!(applies(harness));
        }
    }
}
