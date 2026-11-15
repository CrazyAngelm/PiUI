//! Speech-to-text sources besides the Nano account (ADR-061).
//!
//! The JSON file holds preferences only. A provider API key lives in its own
//! OS credential entry, named by a hash of the provider and the exact
//! transcription address it is sent to, so an edited file cannot redirect a
//! stored key. The WebView never supplies an address, a model or a key for a
//! request: [`DictationSources::plan`] reads them from the host's own state.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::config::is_loopback_host;
use crate::fsutil::atomic_write;
use crate::net::base_builder;
use crate::pkce::random_bytes;
use crate::secret::SecretString;
use crate::store::{CredentialStore, MemoryStore, dictation_store};

/// Version of `contracts/dictation-v1.ts`.
pub const DICTATION_PROTOCOL: u32 = 1;
/// Largest clip sent to a provider (20 MiB, the WebView's default limit).
pub const DICTATION_MAX_BYTES: u64 = 20 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ANSWER_BYTES: usize = 1024 * 1024;
const MAX_URL_CHARS: usize = 2048;
const MAX_MODEL_CHARS: usize = 128;
const MAX_KEY_BYTES: usize = 512;
const OPENAI_URL: &str = "https://api.openai.com/v1";
const GROQ_URL: &str = "https://api.groq.com/openai/v1";
const OPENAI_MODEL: &str = "gpt-4o-transcribe";
const GROQ_MODEL: &str = "whisper-large-v3-turbo";

/// What transcribes composer dictation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DictationSource {
    /// No dictation button.
    Off,
    /// The Nano account (`nano_dictation_v1`); not handled by this module.
    #[default]
    Nano,
    /// OpenAI's transcription endpoint.
    OpenAi,
    /// Groq's transcription endpoint.
    Groq,
    /// An OpenAI-compatible endpoint the person entered.
    Custom,
}

/// A speech provider this module can call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DictationProviderId {
    /// OpenAI.
    OpenAi,
    /// Groq.
    Groq,
    /// A custom OpenAI-compatible endpoint.
    Custom,
}

impl DictationProviderId {
    /// Every provider, in the order the contract lists them.
    pub const ALL: [Self; 3] = [Self::OpenAi, Self::Groq, Self::Custom];

    const fn id(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Groq => "groq",
            Self::Custom => "custom",
        }
    }

    const fn key_required(self) -> bool {
        !matches!(self, Self::Custom)
    }
}

impl DictationSource {
    const fn provider(self) -> Option<DictationProviderId> {
        match self {
            Self::Off | Self::Nano => None,
            Self::OpenAi => Some(DictationProviderId::OpenAi),
            Self::Groq => Some(DictationProviderId::Groq),
            Self::Custom => Some(DictationProviderId::Custom),
        }
    }
}

/// A failure the WebView may see. Serialized as the contract's code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "kebab-case")]
pub enum DictationError {
    /// The request was malformed.
    #[error("the dictation request is not valid")]
    Invalid,
    /// Safe mode refuses the action.
    #[error("safe mode is on")]
    SafeMode,
    /// The chosen source cannot transcribe yet.
    #[error("no dictation provider is ready")]
    NotConfigured,
    /// The endpoint address was refused.
    #[error("the endpoint address is not valid")]
    InvalidUrl,
    /// The model name was refused.
    #[error("the model name is not valid")]
    InvalidModel,
    /// The language code was refused.
    #[error("the language code is not valid")]
    InvalidLanguage,
    /// The OS credential store failed or does not exist.
    #[error("the credential store failed")]
    CredentialStore,
    /// The settings file could not be read or written.
    #[error("dictation settings could not be read or saved")]
    Storage,
    /// Key entry is not available on this platform.
    #[error("API key entry is unavailable on this platform")]
    Unsupported,
    /// The native key dialog could not be opened.
    #[error("the API key dialog could not be opened")]
    PromptFailed,
    /// The provider refused the API key (401, 403).
    #[error("the provider refused the API key")]
    InvalidKey,
    /// The provider limited the request (402, 429).
    #[error("the provider rate limit was reached")]
    RateLimited,
    /// The recording is over the limit (here or at the provider).
    #[error("the recording is too large")]
    TooLarge,
    /// The provider refused the request for another reason.
    #[error("the provider refused the request")]
    Rejected,
    /// The provider answered with a server error.
    #[error("the provider is unavailable")]
    ProviderUnavailable,
    /// The provider could not be reached.
    #[error("the provider could not be reached")]
    Offline,
    /// The provider's answer was not a transcription.
    #[error("the provider answer could not be read")]
    BadResponse,
}

/// One provider as the WebView sees it. Never holds a key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationProvider {
    /// Which provider.
    pub id: DictationProviderId,
    /// Fixed for a preset; the person's address for a custom endpoint.
    pub base_url: String,
    /// The model name sent with every clip.
    pub model: String,
    /// The provider cannot be used without a key.
    pub key_required: bool,
    /// A key for exactly this address is in the credential store.
    pub key_set: bool,
    /// Address, model and (when required) key are all present.
    pub ready: bool,
}

/// The settings view the host returns (the host adds its own flags).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSettings {
    /// Version of the contract.
    pub protocol: u32,
    /// The chosen source.
    pub source: DictationSource,
    /// Language hint for a provider, or none to let it detect.
    pub language: Option<String>,
    /// Always openai, groq, custom, in this order.
    pub providers: Vec<DictationProvider>,
    /// Largest clip a provider source accepts, in bytes.
    pub max_bytes: u64,
}

/// The editable part of the settings. A key is never part of it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationSettingsUpdate {
    /// The chosen source.
    pub source: DictationSource,
    /// Language hint, or none.
    pub language: Option<String>,
    /// OpenAI model; empty means the default.
    pub openai_model: String,
    /// Groq model; empty means the default.
    pub groq_model: String,
    /// Base address of the custom endpoint; empty until set.
    pub custom_base_url: String,
    /// Model of the custom endpoint; empty until set.
    pub custom_model: String,
}

/// The preferences file. `keys` maps a provider id to the binding its key was
/// stored under; a key counts only while that binding matches the address.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    source: DictationSource,
    language: Option<String>,
    openai_model: String,
    groq_model: String,
    custom_base_url: String,
    custom_model: String,
    keys: BTreeMap<String, String>,
}

/// Everything one upload needs. `Debug` never prints the key.
pub struct TranscriptionPlan {
    url: Url,
    model: String,
    language: Option<String>,
    key: Option<SecretString>,
}

impl fmt::Debug for TranscriptionPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TranscriptionPlan")
            .field("host", &self.url.host_str())
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

fn clean_model(raw: &str, fallback: &str) -> Result<String, DictationError> {
    let model = raw.trim();
    if model.is_empty() {
        return Ok(fallback.to_owned());
    }
    if model.chars().count() > MAX_MODEL_CHARS || model.chars().any(char::is_control) {
        return Err(DictationError::InvalidModel);
    }
    Ok(model.to_owned())
}

fn clean_language(raw: Option<&str>) -> Result<Option<String>, DictationError> {
    let Some(code) = raw.map(str::trim).filter(|code| !code.is_empty()) else {
        return Ok(None);
    };
    let code = code.to_ascii_lowercase();
    if !(2..=3).contains(&code.len()) || !code.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return Err(DictationError::InvalidLanguage);
    }
    Ok(Some(code))
}

/// https anywhere, http only to this computer; no userinfo, query or fragment.
fn base_url(raw: &str) -> Result<Url, DictationError> {
    if raw.len() > MAX_URL_CHARS || raw.chars().any(char::is_control) {
        return Err(DictationError::InvalidUrl);
    }
    let url = Url::parse(raw).map_err(|_| DictationError::InvalidUrl)?;
    let host = url.host().ok_or(DictationError::InvalidUrl)?;
    let scheme_ok = match url.scheme() {
        "https" => true,
        "http" => is_loopback_host(&host),
        _ => false,
    };
    if !scheme_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DictationError::InvalidUrl);
    }
    Ok(url)
}

/// The custom address as kept in the file: empty, or the trimmed text of a
/// valid address.
fn clean_base_url(raw: &str) -> Result<String, DictationError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    base_url(raw).map(|_| raw.to_owned())
}

fn transcription_url(base: &str) -> Result<Url, DictationError> {
    let mut url = base_url(base)?;
    url.path_segments_mut()
        .map_err(|()| DictationError::InvalidUrl)?
        .pop_if_empty()
        .push("audio")
        .push("transcriptions");
    Ok(url)
}

/// Custody scope of a key: the provider and the exact address it is sent to.
fn binding(provider: DictationProviderId, url: &Url) -> String {
    let mut scope = Sha256::new();
    scope.update(provider.id());
    scope.update([0]);
    scope.update(url.as_str());
    format!("{:x}", scope.finalize())
}

impl Stored {
    /// Never trusts the file: a field that does not validate falls back to its
    /// default.
    fn checked(mut self) -> Self {
        self.openai_model = clean_model(&self.openai_model, OPENAI_MODEL)
            .unwrap_or_else(|_| OPENAI_MODEL.to_owned());
        self.groq_model =
            clean_model(&self.groq_model, GROQ_MODEL).unwrap_or_else(|_| GROQ_MODEL.to_owned());
        self.custom_model = clean_model(&self.custom_model, "").unwrap_or_default();
        self.custom_base_url = clean_base_url(&self.custom_base_url).unwrap_or_default();
        self.language = clean_language(self.language.as_deref()).unwrap_or_default();
        self
    }

    fn base_url(&self, provider: DictationProviderId) -> &str {
        match provider {
            DictationProviderId::OpenAi => OPENAI_URL,
            DictationProviderId::Groq => GROQ_URL,
            DictationProviderId::Custom => &self.custom_base_url,
        }
    }

    fn model(&self, provider: DictationProviderId) -> &str {
        match provider {
            DictationProviderId::OpenAi => &self.openai_model,
            DictationProviderId::Groq => &self.groq_model,
            DictationProviderId::Custom => &self.custom_model,
        }
    }

    fn endpoint(&self, provider: DictationProviderId) -> Option<Url> {
        let base = self.base_url(provider);
        if base.is_empty() {
            return None;
        }
        transcription_url(base).ok()
    }

    fn key_set(&self, provider: DictationProviderId) -> bool {
        self.endpoint(provider)
            .is_some_and(|url| self.keys.get(provider.id()) == Some(&binding(provider, &url)))
    }
}

type StoreFactory = Box<dyn Fn(&str) -> Option<Arc<dyn CredentialStore>> + Send + Sync>;

/// Serializes changes. The JSON file holds preferences only.
pub struct DictationSources {
    path: PathBuf,
    store: StoreFactory,
    lock: Mutex<()>,
}

impl DictationSources {
    /// Sources kept in `path`, with keys in the OS credential store.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            store: Box::new(dictation_store),
            lock: Mutex::new(()),
        }
    }

    /// A key vault for isolated application tests, with no OS writes.
    pub fn with_memory(path: PathBuf) -> Self {
        let vault: Mutex<HashMap<String, Arc<MemoryStore>>> = Mutex::new(HashMap::new());
        Self {
            path,
            store: Box::new(move |id| {
                let mut stores = vault.lock().ok()?;
                Some(stores.entry(id.to_owned()).or_default().clone())
            }),
            lock: Mutex::new(()),
        }
    }

    /// The current settings. Reads the file only: no credential-store read and
    /// no network.
    pub fn settings(&self) -> DictationSettings {
        Self::view(&self.read())
    }

    /// Replaces the preferences. Every field is validated before anything
    /// changes; a new custom address drops the key of the old one.
    ///
    /// # Errors
    /// [`DictationError::InvalidLanguage`], [`DictationError::InvalidModel`],
    /// [`DictationError::InvalidUrl`] or [`DictationError::Storage`].
    pub fn save(
        &self,
        update: DictationSettingsUpdate,
    ) -> Result<DictationSettings, DictationError> {
        let language = clean_language(update.language.as_deref())?;
        let openai_model = clean_model(&update.openai_model, OPENAI_MODEL)?;
        let groq_model = clean_model(&update.groq_model, GROQ_MODEL)?;
        let custom_model = clean_model(&update.custom_model, "")?;
        let custom_base_url = clean_base_url(&update.custom_base_url)?;
        let _guard = self.lock.lock().map_err(|_| DictationError::Storage)?;
        let mut stored = self.read();
        let previous = stored.endpoint(DictationProviderId::Custom);
        stored.source = update.source;
        stored.language = language;
        stored.openai_model = openai_model;
        stored.groq_model = groq_model;
        stored.custom_model = custom_model;
        stored.custom_base_url = custom_base_url;
        // A key belongs to the address it was entered for.
        let dropped = if previous == stored.endpoint(DictationProviderId::Custom) {
            None
        } else {
            stored.keys.remove(DictationProviderId::Custom.id())
        };
        self.write(&stored)?;
        if let Some(old) = dropped {
            let _ = self
                .vault(DictationProviderId::Custom, &old)
                .map(|store| store.delete());
        }
        Ok(Self::view(&stored))
    }

    /// The transcription address and model the native key dialog shows.
    ///
    /// # Errors
    /// [`DictationError::InvalidUrl`] without an address,
    /// [`DictationError::InvalidModel`] without a model.
    pub fn key_target(
        &self,
        provider: DictationProviderId,
    ) -> Result<(String, String), DictationError> {
        let stored = self.read();
        let url = stored
            .endpoint(provider)
            .ok_or(DictationError::InvalidUrl)?;
        let model = stored.model(provider);
        if model.is_empty() {
            return Err(DictationError::InvalidModel);
        }
        Ok((url.to_string(), model.to_owned()))
    }

    /// Stores a key for the provider's current address.
    ///
    /// # Errors
    /// [`DictationError::Invalid`] for an empty, long or non-ASCII key,
    /// [`DictationError::InvalidUrl`] without an address,
    /// [`DictationError::CredentialStore`] or [`DictationError::Storage`].
    pub fn set_key(
        &self,
        provider: DictationProviderId,
        key: &SecretString,
    ) -> Result<DictationSettings, DictationError> {
        if key.is_empty()
            || key.expose().len() > MAX_KEY_BYTES
            || !key.expose().bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(DictationError::Invalid);
        }
        let _guard = self.lock.lock().map_err(|_| DictationError::Storage)?;
        let mut stored = self.read();
        let url = stored
            .endpoint(provider)
            .ok_or(DictationError::InvalidUrl)?;
        let bound = binding(provider, &url);
        let store = self.vault(provider, &bound)?;
        store
            .save(key)
            .map_err(|_| DictationError::CredentialStore)?;
        let replaced = stored.keys.insert(provider.id().to_owned(), bound.clone());
        if let Err(error) = self.write(&stored) {
            let _ = store.delete();
            return Err(error);
        }
        if let Some(old) = replaced.filter(|old| *old != bound) {
            let _ = self.vault(provider, &old).map(|store| store.delete());
        }
        Ok(Self::view(&stored))
    }

    /// Forgets the provider's key.
    ///
    /// # Errors
    /// [`DictationError::CredentialStore`] when the current key cannot be
    /// deleted, [`DictationError::Storage`].
    pub fn clear_key(
        &self,
        provider: DictationProviderId,
    ) -> Result<DictationSettings, DictationError> {
        let _guard = self.lock.lock().map_err(|_| DictationError::Storage)?;
        let mut stored = self.read();
        if let Some(old) = stored.keys.remove(provider.id()) {
            let _ = self.vault(provider, &old).map(|store| store.delete());
        }
        if let Some(url) = stored.endpoint(provider) {
            self.vault(provider, &binding(provider, &url))?
                .delete()
                .map_err(|_| DictationError::CredentialStore)?;
        }
        self.write(&stored)?;
        Ok(Self::view(&stored))
    }

    /// Resolves the chosen source into one upload. Blocking (file and
    /// credential store).
    ///
    /// # Errors
    /// [`DictationError::NotConfigured`] for off, nano or an unfinished
    /// provider; [`DictationError::CredentialStore`] when a required key
    /// cannot be read.
    pub fn plan(&self) -> Result<TranscriptionPlan, DictationError> {
        let stored = self.read();
        let provider = stored
            .source
            .provider()
            .ok_or(DictationError::NotConfigured)?;
        let url = stored
            .endpoint(provider)
            .ok_or(DictationError::NotConfigured)?;
        let model = stored.model(provider);
        if model.is_empty() {
            return Err(DictationError::NotConfigured);
        }
        // The key is looked up under the binding computed from the address in
        // use, never under the one the file claims.
        let key = match self
            .vault(provider, &binding(provider, &url))
            .and_then(|store| store.load().map_err(|_| DictationError::CredentialStore))
        {
            Ok(key) => key,
            Err(error) if provider.key_required() => return Err(error),
            Err(_) => None,
        };
        if key.is_none() && provider.key_required() {
            return Err(DictationError::NotConfigured);
        }
        Ok(TranscriptionPlan {
            url,
            model: model.to_owned(),
            language: stored.language.clone(),
            key,
        })
    }

    fn read(&self) -> Stored {
        fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
            .unwrap_or_default()
            .checked()
    }

    fn write(&self, stored: &Stored) -> Result<(), DictationError> {
        let bytes = serde_json::to_vec_pretty(stored).map_err(|_| DictationError::Storage)?;
        atomic_write(&self.path, &bytes).map_err(|_| DictationError::Storage)
    }

    fn vault(
        &self,
        provider: DictationProviderId,
        binding: &str,
    ) -> Result<Arc<dyn CredentialStore>, DictationError> {
        (self.store)(&format!("{}:{binding}", provider.id())).ok_or(DictationError::CredentialStore)
    }

    fn view(stored: &Stored) -> DictationSettings {
        let providers = DictationProviderId::ALL
            .iter()
            .map(|&id| {
                let key_set = stored.key_set(id);
                let model = stored.model(id);
                DictationProvider {
                    id,
                    base_url: stored.base_url(id).to_owned(),
                    model: model.to_owned(),
                    key_required: id.key_required(),
                    key_set,
                    ready: stored.endpoint(id).is_some()
                        && !model.is_empty()
                        && (key_set || !id.key_required()),
                }
            })
            .collect();
        DictationSettings {
            protocol: DICTATION_PROTOCOL,
            source: stored.source,
            language: stored.language.clone(),
            providers,
            max_bytes: DICTATION_MAX_BYTES,
        }
    }
}

/// The `{"text": ...}` answer of an OpenAI-style transcription endpoint.
#[derive(Deserialize)]
struct Answer {
    text: String,
}

/// Sends one clip. `mime` is one of `audio/webm`, `audio/ogg`, `audio/mp4`.
///
/// One multipart request; a redirect is never followed; the answer and the
/// time are capped. Nothing from the provider's answer is returned except the
/// transcription text.
///
/// # Errors
/// A [`DictationError`] from the clip checks or the provider's answer.
pub async fn transcribe(
    plan: TranscriptionPlan,
    audio: Vec<u8>,
    mime: &str,
) -> Result<String, DictationError> {
    if audio.is_empty() {
        return Err(DictationError::Invalid);
    }
    if audio.len() as u64 > DICTATION_MAX_BYTES {
        return Err(DictationError::TooLarge);
    }
    let file_name = audio_file_name(mime).ok_or(DictationError::Invalid)?;
    let boundary = boundary()?;
    let TranscriptionPlan {
        url,
        model,
        language,
        key,
    } = plan;
    let body = multipart_body(
        &boundary,
        &model,
        language.as_deref(),
        file_name,
        mime,
        &audio,
    );
    drop(audio);
    let loopback_http = url.scheme() == "http";
    let mut builder = base_builder()
        .map_err(|_| DictationError::Offline)?
        .https_only(!loopback_http)
        .timeout(REQUEST_TIMEOUT);
    if loopback_http {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|_| DictationError::Offline)?;
    let mut request = client
        .post(url)
        .header(ACCEPT, "application/json")
        .header(
            CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body);
    if let Some(key) = &key {
        request = request.bearer_auth(key.expose());
    }
    let mut response = request.send().await.map_err(|_| DictationError::Offline)?;
    let status = response.status().as_u16();
    // A 3xx is never followed: it is refused like any other unexpected status.
    if !(200..300).contains(&status) {
        return Err(status_error(status));
    }
    let mut answer = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| DictationError::Offline)?
    {
        if answer.len() + chunk.len() > MAX_ANSWER_BYTES {
            return Err(DictationError::BadResponse);
        }
        answer.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<Answer>(&answer)
        .map(|answer| answer.text)
        .map_err(|_| DictationError::BadResponse)
}

const fn status_error(status: u16) -> DictationError {
    match status {
        401 | 403 => DictationError::InvalidKey,
        402 | 429 => DictationError::RateLimited,
        413 => DictationError::TooLarge,
        500..=599 => DictationError::ProviderUnavailable,
        _ => DictationError::Rejected,
    }
}

fn audio_file_name(mime: &str) -> Option<&'static str> {
    match mime {
        "audio/webm" => Some("dictation.webm"),
        "audio/ogg" => Some("dictation.ogg"),
        "audio/mp4" => Some("dictation.mp4"),
        _ => None,
    }
}

fn boundary() -> Result<String, DictationError> {
    let bytes = random_bytes::<16>().map_err(|_| DictationError::Invalid)?;
    Ok(format!(
        "nano-dictation-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn push_field(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .as_bytes(),
    );
}

/// OpenAI's transcription form: model, `response_format=json`, an optional
/// language, then the file. A model cannot break the form (control characters
/// are refused) and a language is two or three lower-case letters.
fn multipart_body(
    boundary: &str,
    model: &str,
    language: Option<&str>,
    file_name: &str,
    mime: &str,
    audio: &[u8],
) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);
    push_field(&mut body, boundary, "model", model);
    push_field(&mut body, boundary, "response_format", "json");
    if let Some(language) = language {
        push_field(&mut body, boundary, "language", language);
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::*;

    const KEY: &str = "synthetic-dictation-key";

    fn update(source: DictationSource, base: &str, model: &str) -> DictationSettingsUpdate {
        DictationSettingsUpdate {
            source,
            language: None,
            openai_model: String::new(),
            groq_model: String::new(),
            custom_base_url: base.to_owned(),
            custom_model: model.to_owned(),
        }
    }

    fn secret(value: &str) -> SecretString {
        SecretString::new(value.to_owned())
    }

    /// A custom source at `base`, with an optional key and language, resolved
    /// into a plan on an isolated, memory-only host.
    fn custom_plan(base: &str, key: Option<&str>, language: Option<&str>) -> TranscriptionPlan {
        let dir = tempfile::tempdir().expect("tempdir");
        let sources = DictationSources::with_memory(dir.path().join("dictation-v1.json"));
        let mut settings = update(DictationSource::Custom, base, "synthetic-model");
        settings.language = language.map(str::to_owned);
        sources.save(settings).expect("save");
        if let Some(key) = key {
            sources
                .set_key(DictationProviderId::Custom, &secret(key))
                .expect("key");
        }
        sources.plan().expect("plan")
    }

    /// Answers one HTTP request with `status` and `body`; resolves to the raw
    /// request it received.
    async fn serve_once(
        status: u16,
        extra_headers: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let served = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let read = stream.read(&mut buffer).await.expect("read");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let answer = format!(
                "HTTP/1.1 {status} Synthetic\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra_headers}\r\n{body}",
                body.len()
            );
            stream.write_all(answer.as_bytes()).await.expect("write");
            let _ = stream.shutdown().await;
            request
        });
        (format!("http://127.0.0.1:{port}/v1"), served)
    }

    #[test]
    fn accepts_https_and_loopback_http_addresses_only() {
        for good in [
            "https://api.example.test/v1",
            "https://api.example.test/v1/",
            "http://127.0.0.1:8000/v1",
            "http://localhost:9000",
            "http://[::1]:8000/v1",
        ] {
            assert!(base_url(good).is_ok(), "{good}");
        }
        assert_eq!(
            transcription_url("https://api.example.test/v1/")
                .expect("url")
                .as_str(),
            "https://api.example.test/v1/audio/transcriptions"
        );
        assert_eq!(
            transcription_url("http://localhost:9000")
                .expect("url")
                .as_str(),
            "http://localhost:9000/audio/transcriptions"
        );
        let long = format!("https://example.test/{}", "a".repeat(3000));
        for bad in [
            "http://example.test/v1",
            "http://192.168.1.5/v1",
            "ftp://example.test",
            "https://user:key@example.test/v1",
            "https://example.test/v1?key=1",
            "https://example.test/v1#x",
            "not a url",
            long.as_str(),
        ] {
            assert_eq!(
                base_url(bad).err(),
                Some(DictationError::InvalidUrl),
                "{bad}"
            );
        }
    }

    #[test]
    fn cleans_models_and_language_codes() {
        assert_eq!(clean_model("  ", OPENAI_MODEL).as_deref(), Ok(OPENAI_MODEL));
        assert_eq!(clean_model(" whisper-1 ", "x").as_deref(), Ok("whisper-1"));
        assert_eq!(
            clean_model("bad\nname", "x"),
            Err(DictationError::InvalidModel)
        );
        assert_eq!(
            clean_model(&"m".repeat(129), "x"),
            Err(DictationError::InvalidModel)
        );
        assert_eq!(clean_model(&"m".repeat(128), "x").map(|m| m.len()), Ok(128));
        assert_eq!(clean_language(Some(" RU ")), Ok(Some("ru".to_owned())));
        for bad in ["english", "e", "r1"] {
            assert_eq!(
                clean_language(Some(bad)),
                Err(DictationError::InvalidLanguage),
                "{bad}"
            );
        }
        assert_eq!(clean_language(None), Ok(None));
        assert_eq!(clean_language(Some("")), Ok(None));
    }

    #[test]
    fn builds_the_transcription_form() {
        let body = multipart_body(
            "b",
            "whisper-1",
            Some("ru"),
            "dictation.webm",
            "audio/webm",
            b"AUDIO",
        );
        let text = String::from_utf8(body).expect("text body");
        let order = [
            "name=\"model\"\r\n\r\nwhisper-1",
            "name=\"response_format\"\r\n\r\njson",
            "name=\"language\"\r\n\r\nru",
            "filename=\"dictation.webm\"",
            "Content-Type: audio/webm",
            "AUDIO",
        ];
        let mut from = 0;
        for part in order {
            let at = text[from..].find(part).unwrap_or_else(|| panic!("{part}"));
            from += at + part.len();
        }
        assert!(text.ends_with("\r\n--b--\r\n"));

        let plain = multipart_body("b", "m", None, "dictation.ogg", "audio/ogg", b"A");
        assert!(!String::from_utf8_lossy(&plain).contains("name=\"language\""));

        assert_eq!(audio_file_name("audio/webm"), Some("dictation.webm"));
        assert_eq!(audio_file_name("audio/ogg"), Some("dictation.ogg"));
        assert_eq!(audio_file_name("audio/mp4"), Some("dictation.mp4"));
        assert_eq!(audio_file_name("audio/wav"), None);
    }

    #[test]
    fn a_fresh_install_uses_nano_and_lists_the_three_providers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("dictation-v1.json");
        let sources = DictationSources::with_memory(path.clone());
        let settings = sources.settings();
        assert_eq!(settings.protocol, 1);
        assert_eq!(settings.source, DictationSource::Nano);
        assert_eq!(settings.language, None);
        assert_eq!(settings.max_bytes, DICTATION_MAX_BYTES);
        let ids: Vec<_> = settings
            .providers
            .iter()
            .map(|provider| provider.id)
            .collect();
        assert_eq!(ids, DictationProviderId::ALL);
        assert_eq!(settings.providers[0].base_url, OPENAI_URL);
        assert_eq!(settings.providers[0].model, OPENAI_MODEL);
        assert_eq!(settings.providers[1].base_url, GROQ_URL);
        assert_eq!(settings.providers[1].model, GROQ_MODEL);
        assert_eq!(settings.providers[2].base_url, "");
        assert_eq!(settings.providers[2].model, "");
        assert!(settings.providers.iter().all(|p| !p.key_set && !p.ready));
        assert_eq!(sources.plan().err(), Some(DictationError::NotConfigured));

        fs::write(&path, b"{broken").expect("corrupt file");
        assert_eq!(sources.settings(), settings);
        assert_eq!(sources.plan().err(), Some(DictationError::NotConfigured));
    }

    #[test]
    fn stores_preferences_only_and_binds_a_key_to_its_address() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("dictation-v1.json");
        let sources = DictationSources::with_memory(path.clone());
        let home = "https://stt.example.test/v1";
        sources
            .save(update(DictationSource::Custom, home, "synthetic-model"))
            .expect("save");
        // A custom endpoint needs no key to be ready.
        let before = sources.settings();
        assert!(before.providers[2].ready && !before.providers[2].key_set);
        let settings = sources
            .set_key(DictationProviderId::Custom, &secret(KEY))
            .expect("key");
        assert!(settings.providers[2].key_set && settings.providers[2].ready);
        assert!(!fs::read_to_string(&path).expect("file").contains(KEY));
        assert!(
            !serde_json::to_string(&settings)
                .expect("json")
                .contains(KEY)
        );
        let plan = sources.plan().expect("plan");
        assert_eq!(
            plan.url.as_str(),
            "https://stt.example.test/v1/audio/transcriptions"
        );
        assert_eq!(plan.key.as_ref().map(SecretString::expose), Some(KEY));

        // An edited file cannot redirect a stored key.
        let original = fs::read_to_string(&path).expect("file");
        let mut value: serde_json::Value = serde_json::from_str(&original).expect("json");
        value["customBaseUrl"] = "https://other.example.test/v1".into();
        fs::write(&path, serde_json::to_vec(&value).expect("bytes")).expect("tamper");
        assert!(!sources.settings().providers[2].key_set);
        let tampered = sources.plan().expect("plan for the new address");
        assert_eq!(
            tampered.url.as_str(),
            "https://other.example.test/v1/audio/transcriptions"
        );
        assert!(tampered.key.is_none());
        fs::write(&path, original).expect("restore");
        assert!(sources.settings().providers[2].key_set);
        assert!(sources.plan().expect("plan").key.is_some());

        // Changing the address through the API drops the key for good.
        let moved = sources
            .save(update(
                DictationSource::Custom,
                "https://moved.example.test/v1",
                "synthetic-model",
            ))
            .expect("move");
        assert!(!moved.providers[2].key_set);
        let back = sources
            .save(update(DictationSource::Custom, home, "synthetic-model"))
            .expect("back");
        assert!(!back.providers[2].key_set);
        assert!(sources.plan().expect("plan").key.is_none());
    }

    #[test]
    fn a_preset_needs_its_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sources = DictationSources::with_memory(dir.path().join("dictation-v1.json"));
        let view = sources
            .save(update(DictationSource::OpenAi, "", ""))
            .expect("save");
        assert!(!view.providers[0].ready);
        assert_eq!(sources.plan().err(), Some(DictationError::NotConfigured));

        let long_key = "k".repeat(600);
        for bad in ["", "a b", long_key.as_str()] {
            assert_eq!(
                sources
                    .set_key(DictationProviderId::OpenAi, &secret(bad))
                    .err(),
                Some(DictationError::Invalid)
            );
        }
        let view = sources
            .set_key(DictationProviderId::OpenAi, &secret(KEY))
            .expect("key");
        assert!(view.providers[0].ready && view.providers[0].key_set);
        let plan = sources.plan().expect("plan");
        assert_eq!(
            plan.url.as_str(),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(plan.model, "gpt-4o-transcribe");
        assert_eq!(plan.key.as_ref().map(SecretString::expose), Some(KEY));

        let view = sources
            .clear_key(DictationProviderId::OpenAi)
            .expect("clear");
        assert!(!view.providers[0].ready && !view.providers[0].key_set);
        assert_eq!(sources.plan().err(), Some(DictationError::NotConfigured));
    }

    #[tokio::test]
    async fn uploads_one_form_with_the_key_and_returns_the_text() {
        let (base, served) =
            serve_once(200, "", r#"{"text":"synthetic words","language":"en"}"#).await;
        let plan = custom_plan(&base, Some(KEY), Some("ru"));
        let text = transcribe(plan, b"AUDIO".to_vec(), "audio/webm")
            .await
            .expect("text");
        assert_eq!(text, "synthetic words");
        let request = String::from_utf8_lossy(&served.await.expect("server")).into_owned();
        let head = request
            .split("\r\n\r\n")
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(head.starts_with("post /v1/audio/transcriptions"), "{head}");
        assert!(head.contains(&format!("authorization: bearer {KEY}")));
        assert!(head.contains("multipart/form-data; boundary=nano-dictation-"));
        assert!(request.contains("name=\"model\"\r\n\r\nsynthetic-model"));
        assert!(request.contains("name=\"language\"\r\n\r\nru"));
        assert!(request.contains("filename=\"dictation.webm\""));
        assert!(request.contains("AUDIO"));

        let (base, served) = serve_once(200, "", r#"{"text":"again"}"#).await;
        let plan = custom_plan(&base, None, None);
        assert_eq!(
            transcribe(plan, b"AUDIO".to_vec(), "audio/ogg").await,
            Ok("again".to_owned())
        );
        let request = String::from_utf8_lossy(&served.await.expect("server")).to_ascii_lowercase();
        let head = request.split("\r\n\r\n").next().unwrap_or_default();
        assert!(!head.contains("authorization"), "{head}");
        assert!(!request.contains("name=\"language\""));
    }

    #[tokio::test]
    async fn maps_provider_refusals() {
        for (status, expected) in [
            (401, DictationError::InvalidKey),
            (403, DictationError::InvalidKey),
            (402, DictationError::RateLimited),
            (429, DictationError::RateLimited),
            (413, DictationError::TooLarge),
            (400, DictationError::Rejected),
            (404, DictationError::Rejected),
            (422, DictationError::Rejected),
            (500, DictationError::ProviderUnavailable),
            (503, DictationError::ProviderUnavailable),
        ] {
            let (base, served) =
                serve_once(status, "", r#"{"error":{"message":"synthetic"}}"#).await;
            let plan = custom_plan(&base, None, None);
            assert_eq!(
                transcribe(plan, b"AUDIO".to_vec(), "audio/webm").await,
                Err(expected),
                "{status}"
            );
            served.await.expect("server");
        }
    }

    #[tokio::test]
    async fn never_follows_a_redirect() {
        let (base, served) =
            serve_once(302, "location: http://127.0.0.1:9/elsewhere\r\n", "").await;
        let plan = custom_plan(&base, None, None);
        assert_eq!(
            transcribe(plan, b"AUDIO".to_vec(), "audio/webm").await,
            Err(DictationError::Rejected)
        );
        let request = served.await.expect("one request was read");
        assert!(request.starts_with(b"POST /v1/audio/transcriptions"));
    }

    #[tokio::test]
    async fn reports_an_unreachable_or_unreadable_provider() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let plan = custom_plan(&format!("http://127.0.0.1:{port}/v1"), None, None);
        assert_eq!(
            transcribe(plan, b"AUDIO".to_vec(), "audio/webm").await,
            Err(DictationError::Offline)
        );

        for body in ["not json", r#"{"words":"x"}"#] {
            let (base, served) = serve_once(200, "", body).await;
            let plan = custom_plan(&base, None, None);
            assert_eq!(
                transcribe(plan, b"AUDIO".to_vec(), "audio/webm").await,
                Err(DictationError::BadResponse),
                "{body}"
            );
            served.await.expect("server");
        }
    }

    #[tokio::test]
    async fn refuses_an_empty_or_oversized_clip_before_any_request() {
        let closed = "http://127.0.0.1:9/v1";
        assert_eq!(
            transcribe(custom_plan(closed, None, None), Vec::new(), "audio/webm").await,
            Err(DictationError::Invalid)
        );
        assert_eq!(
            transcribe(
                custom_plan(closed, None, None),
                vec![0_u8; DICTATION_MAX_BYTES as usize + 1],
                "audio/webm"
            )
            .await,
            Err(DictationError::TooLarge)
        );
        assert_eq!(
            transcribe(
                custom_plan(closed, None, None),
                b"AUDIO".to_vec(),
                "audio/wav"
            )
            .await,
            Err(DictationError::Invalid)
        );
    }

    #[test]
    fn errors_serialize_as_contract_codes_and_debug_hides_the_key() {
        for (error, code) in [
            (DictationError::InvalidUrl, "invalid-url"),
            (DictationError::BadResponse, "bad-response"),
            (DictationError::ProviderUnavailable, "provider-unavailable"),
            (DictationError::CredentialStore, "credential-store"),
            (DictationError::NotConfigured, "not-configured"),
            (DictationError::SafeMode, "safe-mode"),
        ] {
            assert_eq!(serde_json::to_value(error).expect("json"), code);
        }
        let plan = custom_plan("https://stt.example.test/v1", Some(KEY), Some("en"));
        let debug = format!("{plan:?}");
        assert!(!debug.contains(KEY), "{debug}");
        assert!(debug.contains("stt.example.test"));
    }
}
