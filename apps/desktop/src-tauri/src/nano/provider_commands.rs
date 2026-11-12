//! Metadata-only settings commands for external model sources in Nano Pi.

use std::sync::Arc;

use piui_nano::SecretString;
use piui_nano::external_providers::{
    ExternalProvider, ExternalProviderError, ExternalProviderSpec,
};
use piui_nano::openai_subscription::{CHATGPT_PROVIDER_ID, ChatGptError, ChatGptStatus};
use serde::{Deserialize, Serialize};
use tauri::{Runtime, State, WebviewWindow};

use super::NanoHost;
use super::provider_prompt::{PromptLanguage, prompt_api_key};
use crate::state::HostState;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    Ru,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum NanoProvidersRequestV1 {
    List {},
    Connect {
        spec: ExternalProviderSpec,
        language: Language,
    },
    Disconnect {
        id: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoProvidersResultV1 {
    protocol: u32,
    supported: bool,
    providers: Vec<ExternalProvider>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ErrorCode {
    InvalidProvider,
    NotFound,
    CredentialStore,
    Storage,
    SafeMode,
    Unsupported,
    PromptFailed,
    ChatGptSignIn,
    ChatGptCancelled,
    ChatGptTimeout,
    ChatGptBrowser,
    ChatGptOffline,
    ChatGptNoPlanPermission,
    ChatGptReauthenticate,
}

impl From<ChatGptError> for NanoProvidersErrorV1 {
    fn from(error: ChatGptError) -> Self {
        match error {
            ChatGptError::SignIn => ErrorCode::ChatGptSignIn,
            ChatGptError::Cancelled => ErrorCode::ChatGptCancelled,
            ChatGptError::Timeout => ErrorCode::ChatGptTimeout,
            ChatGptError::Browser => ErrorCode::ChatGptBrowser,
            ChatGptError::Offline => ErrorCode::ChatGptOffline,
            ChatGptError::NoPlanPermission => ErrorCode::ChatGptNoPlanPermission,
            ChatGptError::Reauthenticate => ErrorCode::ChatGptReauthenticate,
            ChatGptError::Storage => ErrorCode::Storage,
            ChatGptError::CredentialStore => ErrorCode::CredentialStore,
        }
        .into()
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum NanoChatGptRequestV1 {
    Status {},
    Connect {},
    Cancel {},
    Disconnect {},
    ManageUsage {},
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoChatGptResultV1 {
    protocol: u32,
    supported: bool,
    status: ChatGptStatus,
    remote_revocation_confirmed: Option<bool>,
}

#[tauri::command]
pub async fn nano_chatgpt_v1(
    host: State<'_, Arc<NanoHost>>,
    state: State<'_, HostState>,
    request: NanoChatGptRequestV1,
) -> Result<NanoChatGptResultV1, NanoProvidersErrorV1> {
    let supported = cfg!(windows) && !host.safe_mode;
    let mut result = NanoChatGptResultV1 {
        protocol: 1,
        supported,
        status: ChatGptStatus::default(),
        remote_revocation_confirmed: None,
    };
    if !supported {
        return match request {
            NanoChatGptRequestV1::Status {} => Ok(result),
            _ if host.safe_mode => Err(ErrorCode::SafeMode.into()),
            _ => Err(ErrorCode::Unsupported.into()),
        };
    }
    let subscription = &host.external_providers.chatgpt;
    match request {
        NanoChatGptRequestV1::Status {} => (),
        NanoChatGptRequestV1::Connect {} => {
            subscription
                .connect(Box::new(|url| super::browser::open_external(url, false)))
                .await?;
        }
        NanoChatGptRequestV1::Cancel {} => subscription.cancel(),
        NanoChatGptRequestV1::Disconnect {} => {
            let revoked = subscription.disconnect().await;
            if let Some(relay) = host.relay.get() {
                relay.retire_disconnected_external_providers();
            }
            state
                .workspace
                .shutdown_external_provider(CHATGPT_PROVIDER_ID)
                .await;
            result.remote_revocation_confirmed = Some(revoked?);
        }
        NanoChatGptRequestV1::ManageUsage {} => {
            let url = tauri::Url::parse("https://chatgpt.com/settings/usage")
                .map_err(|_| ErrorCode::ChatGptBrowser)?;
            tokio::task::spawn_blocking(move || super::browser::open_external(&url, false))
                .await
                .map_err(|_| ErrorCode::ChatGptBrowser)?
                .map_err(|()| ErrorCode::ChatGptBrowser)?;
        }
    }
    result.status = subscription.status().await?;
    Ok(result)
}

#[derive(Serialize)]
pub struct NanoProvidersErrorV1 {
    code: ErrorCode,
}

impl From<ErrorCode> for NanoProvidersErrorV1 {
    fn from(code: ErrorCode) -> Self {
        Self { code }
    }
}

impl From<ExternalProviderError> for NanoProvidersErrorV1 {
    fn from(error: ExternalProviderError) -> Self {
        match error {
            ExternalProviderError::Invalid => ErrorCode::InvalidProvider,
            ExternalProviderError::NotFound => ErrorCode::NotFound,
            ExternalProviderError::CredentialStore => ErrorCode::CredentialStore,
            ExternalProviderError::Storage => ErrorCode::Storage,
        }
        .into()
    }
}

#[tauri::command]
pub async fn nano_providers_v1<R: Runtime>(
    host: State<'_, Arc<NanoHost>>,
    state: State<'_, HostState>,
    window: WebviewWindow<R>,
    request: NanoProvidersRequestV1,
) -> Result<NanoProvidersResultV1, NanoProvidersErrorV1> {
    let supported = cfg!(windows) && !host.safe_mode;
    if !supported {
        return match request {
            NanoProvidersRequestV1::List {} => Ok(NanoProvidersResultV1 {
                protocol: 1,
                supported,
                providers: Vec::new(),
            }),
            _ if host.safe_mode => Err(ErrorCode::SafeMode.into()),
            _ => Err(ErrorCode::Unsupported.into()),
        };
    }
    let providers = host.external_providers.clone();
    match request {
        NanoProvidersRequestV1::List {} => (),
        NanoProvidersRequestV1::Connect { spec, language } => {
            let url = spec.chat_url()?;
            let _prompt = host
                .external_provider_prompt
                .try_lock()
                .map_err(|_| ErrorCode::PromptFailed)?;
            let language = match language {
                Language::En => PromptLanguage::English,
                Language::Ru => PromptLanguage::Russian,
            };
            let key = prompt_api_key(&window, url.as_str(), &spec.model_id, language)
                .await
                .map_err(|_| ErrorCode::PromptFailed)?;
            if let Some(key) = key {
                let registry = providers.clone();
                tokio::task::spawn_blocking(move || {
                    registry.connect(spec, &SecretString::new(key.to_string()))
                })
                .await
                .map_err(|_| ErrorCode::Storage)??;
            }
        }
        NanoProvidersRequestV1::Disconnect { id } => {
            let provider = format!("nano-external-{id}");
            let registry = providers.clone();
            let result = tokio::task::spawn_blocking(move || registry.disconnect(&id)).await;
            if let Some(relay) = host.relay.get() {
                relay.retire_disconnected_external_providers();
            }
            result.map_err(|_| ErrorCode::Storage)??;
            state.workspace.shutdown_external_provider(&provider).await;
        }
    }
    let providers = tokio::task::spawn_blocking(move || providers.list())
        .await
        .map_err(|_| ErrorCode::Storage)??;
    Ok(NanoProvidersResultV1 {
        protocol: 1,
        supported,
        providers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_connect_command_has_no_key_or_custom_prompt_field() {
        let request = json!({ "type": "connect", "language": "ru", "spec": {
            "name": "Example", "baseUrl": "https://example.test/v1", "modelId": "vendor/model"
        }});
        assert!(serde_json::from_value::<NanoProvidersRequestV1>(request.clone()).is_ok());
        for field in ["apiKey", "prompt"] {
            let mut modified = request.clone();
            modified[field] = json!("synthetic");
            assert!(serde_json::from_value::<NanoProvidersRequestV1>(modified).is_err());
        }
        let mut modified = request;
        modified["spec"]["apiKey"] = json!("synthetic");
        assert!(serde_json::from_value::<NanoProvidersRequestV1>(modified).is_err());
    }

    #[test]
    fn chatgpt_commands_accept_only_fixed_actions() {
        assert!(serde_json::from_value::<NanoChatGptRequestV1>(json!({"type": "connect"})).is_ok());
        for field in ["token", "code", "url", "clientId", "redirectUri"] {
            let request = json!({"type": "connect", (field): "synthetic"});
            assert!(serde_json::from_value::<NanoChatGptRequestV1>(request).is_err());
        }
        assert!(
            serde_json::from_value::<NanoChatGptRequestV1>(json!({"type": "manage-usage"})).is_ok()
        );
    }
}
