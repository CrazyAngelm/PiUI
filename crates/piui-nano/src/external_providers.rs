//! User-configured, host-owned OpenAI Chat Completions sources for Nano Pi.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use url::Url;

use crate::fsutil::atomic_write;
use crate::openai_subscription::{
    CHATGPT_CONNECTION_ID, ChatGptGrant, ChatGptSubscription, RESPONSES,
};
use crate::pkce::random_bytes;
use crate::secret::SecretString;
use crate::store::{CredentialStore, MemoryStore, external_provider_store};

/// An OpenAI-compatible endpoint with one explicitly configured model.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalProviderSpec {
    pub name: String,
    pub base_url: String,
    pub model_id: String,
    #[serde(default)]
    pub request_format: ExternalRequestFormat,
}

/// Chat Completions request fields expected by the external endpoint.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalRequestFormat {
    #[default]
    Compatible,
    OpenAi,
}

/// Settings metadata. Credentials are never part of this record.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProvider {
    pub id: String,
    pub spec: ExternalProviderSpec,
}

pub const EXTERNAL_PROVIDER_PREFIX: &str = "nano-external-";

impl ExternalProvider {
    pub fn provider_id(&self) -> String {
        format!("{EXTERNAL_PROVIDER_PREFIX}{}", self.id)
    }

    pub fn is_chatgpt(&self) -> bool {
        self.id == CHATGPT_CONNECTION_ID
    }
}

pub fn connection_id(provider_id: &str) -> Option<&str> {
    provider_id
        .strip_prefix(EXTERNAL_PROVIDER_PREFIX)
        .filter(|id| valid_id(id))
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ExternalProviderError {
    #[error("invalid provider connection")]
    Invalid,
    #[error("provider connection not found")]
    NotFound,
    #[error("the provider credential store is unavailable")]
    CredentialStore,
    #[error("provider settings could not be saved or read")]
    Storage,
}

impl ExternalProviderSpec {
    /// Resolves the exact endpoint without userinfo, a query, or a fragment.
    /// The relay never resolves a URL supplied by the harness.
    pub fn chat_url(&self) -> Result<Url, ExternalProviderError> {
        if self.name.trim().is_empty()
            || self.name.chars().any(char::is_control)
            || self.model_id.trim().is_empty()
            || self.model_id.chars().any(char::is_control)
        {
            return Err(ExternalProviderError::Invalid);
        }
        let mut url = Url::parse(&self.base_url).map_err(|_| ExternalProviderError::Invalid)?;
        if url.scheme() != "https"
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ExternalProviderError::Invalid);
        }
        url.path_segments_mut()
            .map_err(|()| ExternalProviderError::Invalid)?
            .pop_if_empty()
            .push("chat")
            .push("completions");
        Ok(url)
    }
}

/// Active source grant. Dropping the registry's matching sender revokes it.
pub struct ExternalProviderGrant {
    pub(crate) provider: ExternalProvider,
    pub(crate) url: Url,
    pub(crate) auth: ExternalProviderAuth,
    pub(crate) alive: watch::Receiver<()>,
}

pub(crate) enum ExternalProviderAuth {
    ApiKey(SecretString),
    ChatGpt(ChatGptGrant),
}

impl ExternalProviderGrant {
    pub fn metadata(&self) -> &ExternalProvider {
        &self.provider
    }
}

type StoreFactory = Box<dyn Fn(&str) -> Option<Arc<dyn CredentialStore>> + Send + Sync>;

/// Serializes connection changes and grants. The JSON file holds metadata only.
pub struct ExternalProviderRegistry {
    path: PathBuf,
    store: StoreFactory,
    live: Mutex<HashMap<String, watch::Sender<()>>>,
    pub chatgpt: Arc<ChatGptSubscription>,
}

impl ExternalProviderRegistry {
    pub fn new(path: PathBuf) -> Self {
        Self {
            chatgpt: Arc::new(ChatGptSubscription::new(
                path.with_file_name("nano-chatgpt-v1.json"),
                true,
            )),
            path,
            store: Box::new(external_provider_store),
            live: Mutex::new(HashMap::new()),
        }
    }

    /// A provider vault for isolated application tests, with no OS writes.
    pub fn with_memory(path: PathBuf) -> Self {
        let vault: Mutex<HashMap<String, Arc<MemoryStore>>> = Mutex::new(HashMap::new());
        Self {
            chatgpt: Arc::new(ChatGptSubscription::new(
                path.with_file_name("nano-chatgpt-v1.json"),
                false,
            )),
            path,
            store: Box::new(move |id| {
                let mut stores = vault.lock().ok()?;
                Some(stores.entry(id.to_owned()).or_default().clone())
            }),
            live: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Result<Vec<ExternalProvider>, ExternalProviderError> {
        let _guard = self
            .live
            .lock()
            .map_err(|_| ExternalProviderError::Storage)?;
        self.read()
    }

    pub fn available(&self) -> Result<Vec<ExternalProvider>, ExternalProviderError> {
        let _guard = self
            .live
            .lock()
            .map_err(|_| ExternalProviderError::Storage)?;
        Ok(self
            .read()?
            .into_iter()
            .filter(|provider| {
                self.store(provider)
                    .is_ok_and(|store| store.load().is_ok_and(|key| key.is_some()))
            })
            .collect())
    }

    pub fn connect(
        &self,
        spec: ExternalProviderSpec,
        key: &SecretString,
    ) -> Result<ExternalProvider, ExternalProviderError> {
        spec.chat_url()?;
        if key.is_empty() || !key.expose().bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(ExternalProviderError::Invalid);
        }
        let _guard = self
            .live
            .lock()
            .map_err(|_| ExternalProviderError::Storage)?;
        let mut providers = self.read()?;
        let id = random_bytes::<16>()
            .map_err(|_| ExternalProviderError::Storage)?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let provider = ExternalProvider { id, spec };
        if provider.is_chatgpt() || providers.iter().any(|existing| existing.id == provider.id) {
            return Err(ExternalProviderError::Storage);
        }
        let store = self.store(&provider)?;
        store
            .save(key)
            .map_err(|_| ExternalProviderError::CredentialStore)?;
        providers.push(provider.clone());
        if let Err(error) = self.write(&providers) {
            let _ = store.delete();
            return Err(error);
        }
        Ok(provider)
    }

    pub fn disconnect(&self, id: &str) -> Result<(), ExternalProviderError> {
        let mut live = self
            .live
            .lock()
            .map_err(|_| ExternalProviderError::Storage)?;
        let mut providers = self.read()?;
        let index = providers
            .iter()
            .position(|provider| provider.id == id)
            .ok_or(ExternalProviderError::NotFound)?;
        self.store(&providers[index])?
            .delete()
            .map_err(|_| ExternalProviderError::CredentialStore)?;
        live.remove(id);
        providers.remove(index);
        self.write(&providers)
    }

    pub fn grant(&self, id: &str) -> Result<ExternalProviderGrant, ExternalProviderError> {
        let mut live = self
            .live
            .lock()
            .map_err(|_| ExternalProviderError::Storage)?;
        let provider = self
            .read()?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or(ExternalProviderError::NotFound)?;
        let url = provider.spec.chat_url()?;
        let key = self
            .store(&provider)?
            .load()
            .map_err(|_| ExternalProviderError::CredentialStore)?
            .ok_or(ExternalProviderError::CredentialStore)?;
        let alive = live
            .entry(id.to_owned())
            .or_insert_with(|| watch::channel(()).0)
            .subscribe();
        Ok(ExternalProviderGrant {
            provider,
            url,
            auth: ExternalProviderAuth::ApiKey(key),
            alive,
        })
    }

    pub async fn grant_chatgpt(
        &self,
        model_id: &str,
    ) -> Result<ExternalProviderGrant, ExternalProviderError> {
        let grant = self
            .chatgpt
            .grant(model_id)
            .await
            .map_err(|_| ExternalProviderError::Invalid)?;
        Ok(ExternalProviderGrant {
            provider: ExternalProvider {
                id: CHATGPT_CONNECTION_ID.to_owned(),
                spec: ExternalProviderSpec {
                    name: "ChatGPT".to_owned(),
                    base_url: "https://api.openai.com/v1".to_owned(),
                    model_id: model_id.to_owned(),
                    request_format: ExternalRequestFormat::OpenAi,
                },
            },
            url: Url::parse(RESPONSES).map_err(|_| ExternalProviderError::Invalid)?,
            alive: grant.alive.clone(),
            auth: ExternalProviderAuth::ChatGpt(grant),
        })
    }

    fn store(
        &self,
        provider: &ExternalProvider,
    ) -> Result<Arc<dyn CredentialStore>, ExternalProviderError> {
        // An altered metadata file cannot redirect an existing key. Custody
        // belongs to the exact endpoint and model confirmed at connection time.
        let mut scope = Sha256::new();
        scope.update(provider.spec.chat_url()?.as_str());
        scope.update([0]);
        scope.update(&provider.spec.model_id);
        let bound_id = format!("{}:{:x}", provider.id, scope.finalize());
        (self.store)(&bound_id).ok_or(ExternalProviderError::CredentialStore)
    }

    fn read(&self) -> Result<Vec<ExternalProvider>, ExternalProviderError> {
        match fs::read(&self.path) {
            Ok(bytes) => {
                let records: Vec<ExternalProvider> =
                    serde_json::from_slice(&bytes).map_err(|_| ExternalProviderError::Storage)?;
                if records.iter().any(|provider| {
                    provider.is_chatgpt()
                        || !valid_id(&provider.id)
                        || provider.spec.chat_url().is_err()
                }) {
                    return Err(ExternalProviderError::Storage);
                }
                Ok(records)
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
            Err(_) => Err(ExternalProviderError::Storage),
        }
    }

    fn write(&self, providers: &[ExternalProvider]) -> Result<(), ExternalProviderError> {
        let bytes =
            serde_json::to_vec_pretty(providers).map_err(|_| ExternalProviderError::Storage)?;
        atomic_write(&self.path, &bytes).map_err(|_| ExternalProviderError::Storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(base: &str) -> ExternalProviderSpec {
        ExternalProviderSpec {
            name: "Test provider".to_owned(),
            base_url: base.to_owned(),
            model_id: "vendor/model".to_owned(),
            request_format: ExternalRequestFormat::Compatible,
        }
    }

    #[test]
    fn an_older_source_defaults_to_compatible_requests() {
        let mut stored = serde_json::json!({
            "name": "Test provider", "baseUrl": "https://models.example.test/v1", "modelId": "vendor/model"
        });
        let default: ExternalProviderSpec =
            serde_json::from_value(stored.clone()).expect("old source");
        assert_eq!(default.request_format, ExternalRequestFormat::Compatible);
        stored["requestFormat"] = serde_json::json!("openai");
        let openai: ExternalProviderSpec =
            serde_json::from_value(stored.clone()).expect("OpenAI source");
        assert_eq!(openai.request_format, ExternalRequestFormat::OpenAi);
        assert_eq!(openai.chat_url(), default.chat_url());
        stored["requestFormat"] = serde_json::json!("unsupported");
        assert!(serde_json::from_value::<ExternalProviderSpec>(stored).is_err());
    }

    #[test]
    fn pins_a_chat_endpoint_and_rejects_urls_with_embedded_credentials() {
        assert_eq!(
            spec("https://models.example.test/api/v1/")
                .chat_url()
                .expect("url")
                .as_str(),
            "https://models.example.test/api/v1/chat/completions"
        );
        for invalid in [
            "http://localhost/v1",
            "https://user:key@example.test/v1",
            "https://example.test/?key=value",
            "https://example.test/#key",
        ] {
            assert_eq!(
                spec(invalid).chat_url(),
                Err(ExternalProviderError::Invalid)
            );
        }
    }

    #[test]
    fn persists_only_metadata_and_revokes_existing_grants_on_disconnect() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let path = temporary.path().join("providers.json");
        let registry = ExternalProviderRegistry::with_memory(path.clone());
        let key = SecretString::new("synthetic-external-key".to_owned());
        let provider = registry
            .connect(spec("https://models.example.test/v1"), &key)
            .expect("connect");
        assert_eq!(
            connection_id(&provider.provider_id()),
            Some(provider.id.as_str())
        );
        assert!(
            !fs::read_to_string(&path)
                .expect("read metadata")
                .contains(key.expose())
        );
        assert_eq!(
            registry.available().expect("available"),
            vec![provider.clone()]
        );
        let grant = registry.grant(&provider.id).expect("grant");
        assert!(matches!(grant.auth, ExternalProviderAuth::ApiKey(ref stored) if *stored == key));
        let mut altered = provider.clone();
        altered.spec.base_url = "https://changed.example.test/v1".to_owned();
        registry.write(&[altered]).expect("tamper with metadata");
        assert!(matches!(
            registry.grant(&provider.id),
            Err(ExternalProviderError::CredentialStore)
        ));
        registry
            .write(std::slice::from_ref(&provider))
            .expect("restore metadata");
        registry.disconnect(&provider.id).expect("disconnect");
        assert!(grant.alive.has_changed().is_err());
        assert!(registry.list().expect("list").is_empty());
        assert!(matches!(
            registry.grant(&provider.id),
            Err(ExternalProviderError::NotFound)
        ));
        assert!(
            registry
                .store(&provider)
                .expect("store")
                .load()
                .expect("load")
                .is_none()
        );
    }
}
