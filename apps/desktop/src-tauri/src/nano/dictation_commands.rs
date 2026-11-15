//! Dictation sources (ADR-061, `contracts/dictation-v1.ts`): the settings and
//! the upload for speech-to-text providers other than the Nano account.
//!
//! The WebView sends a clip and nothing else: the address, model and API key
//! of a request come from the host's own settings and credential store. A key
//! is typed in the native dialog and never crosses IPC. Safe mode reads the
//! settings and refuses everything else; no audio leaves in safe mode.

use std::sync::Arc;

use base64::Engine as _;
use piui_nano::SecretString;
use piui_nano::dictation_sources::{
    DICTATION_MAX_BYTES, DictationError, DictationProviderId, DictationSettings,
    DictationSettingsUpdate, transcribe,
};
use serde::{Deserialize, Serialize};
use tauri::{Runtime, State, WebviewWindow};

use super::NanoHost;
use super::commands::dictation_mime;
use super::provider_commands::Language;
use super::provider_prompt::{PromptLanguage, prompt_api_key};

/// `dictation_settings_v1` request. There is no field for a key, an address or
/// a prompt: a key is typed in the host's native dialog.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum DictationSettingsRequestV1 {
    Get {},
    Save {
        settings: DictationSettingsUpdate,
    },
    SetKey {
        provider: DictationProviderId,
        language: Language,
    },
    ClearKey {
        provider: DictationProviderId,
    },
}

/// `dictation_settings_v1` answer: the settings view, never a key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSettingsV1 {
    #[serde(flatten)]
    settings: DictationSettings,
    key_entry: bool,
    safe_mode: bool,
}

/// A failed command. Serializes as `{"code": "<DictationErrorCodeV1>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DictationErrorV1 {
    code: DictationError,
}

impl From<DictationError> for DictationErrorV1 {
    fn from(code: DictationError) -> Self {
        Self { code }
    }
}

/// `dictation_transcribe_v1` request: one recorded clip and nothing else.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationTranscribeRequestV1 {
    pub audio_base64: String,
    pub mime_type: String,
}

impl std::fmt::Debug for DictationTranscribeRequestV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DictationTranscribeRequestV1")
            .field("audio_chars", &self.audio_base64.len())
            .finish_non_exhaustive()
    }
}

/// `dictation_transcribe_v1` answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationAnswerV1 {
    pub text: String,
}

impl NanoHost {
    fn dictation_view(&self, settings: DictationSettings) -> DictationSettingsV1 {
        DictationSettingsV1 {
            settings,
            key_entry: cfg!(windows) && !self.safe_mode,
            safe_mode: self.safe_mode,
        }
    }

    /// Every settings request except key entry, which needs the window.
    pub(crate) async fn dictation_settings(
        &self,
        request: DictationSettingsRequestV1,
    ) -> Result<DictationSettingsV1, DictationError> {
        let sources = self.dictation.clone();
        let safe_mode = self.safe_mode;
        let settings = tokio::task::spawn_blocking(move || match request {
            DictationSettingsRequestV1::Get {} => Ok(sources.settings()),
            _ if safe_mode => Err(DictationError::SafeMode),
            DictationSettingsRequestV1::Save { settings } => sources.save(settings),
            DictationSettingsRequestV1::ClearKey { provider } => sources.clear_key(provider),
            DictationSettingsRequestV1::SetKey { .. } => Err(DictationError::Invalid),
        })
        .await
        .map_err(|_| DictationError::Storage)??;
        Ok(self.dictation_view(settings))
    }

    /// Stores a key the native dialog returned.
    pub(crate) async fn dictation_store_key(
        &self,
        provider: DictationProviderId,
        key: SecretString,
    ) -> Result<DictationSettingsV1, DictationError> {
        if self.safe_mode {
            return Err(DictationError::SafeMode);
        }
        let sources = self.dictation.clone();
        let settings = tokio::task::spawn_blocking(move || sources.set_key(provider, &key))
            .await
            .map_err(|_| DictationError::Storage)??;
        Ok(self.dictation_view(settings))
    }

    /// Transcribes one clip with the configured provider. The audio exists
    /// only in this call.
    pub(crate) async fn dictation_transcribe(
        &self,
        request: DictationTranscribeRequestV1,
    ) -> Result<DictationAnswerV1, DictationError> {
        if self.safe_mode {
            return Err(DictationError::SafeMode);
        }
        let mime = dictation_mime(&request.mime_type).ok_or(DictationError::Invalid)?;
        // Refuse by the encoded length first: a too large clip is never decoded.
        if request.audio_base64.len() as u64 > DICTATION_MAX_BYTES.div_ceil(3).saturating_mul(4) {
            return Err(DictationError::TooLarge);
        }
        // The source is resolved before the clip is decoded; off and nano stop
        // here.
        let sources = self.dictation.clone();
        let plan = tokio::task::spawn_blocking(move || sources.plan())
            .await
            .map_err(|_| DictationError::Storage)??;
        let audio = base64::engine::general_purpose::STANDARD
            .decode(request.audio_base64.as_bytes())
            .map_err(|_| DictationError::Invalid)?;
        drop(request);
        let text = transcribe(plan, audio, mime).await?;
        Ok(DictationAnswerV1 { text })
    }
}

#[tauri::command]
pub async fn dictation_settings_v1<R: Runtime>(
    host: State<'_, Arc<NanoHost>>,
    window: WebviewWindow<R>,
    request: DictationSettingsRequestV1,
) -> Result<DictationSettingsV1, DictationErrorV1> {
    match request {
        DictationSettingsRequestV1::SetKey { provider, language } => {
            if host.safe_mode {
                return Err(DictationError::SafeMode.into());
            }
            if !cfg!(windows) {
                return Err(DictationError::Unsupported.into());
            }
            let sources = host.dictation.clone();
            let (endpoint, model) =
                tokio::task::spawn_blocking(move || sources.key_target(provider))
                    .await
                    .map_err(|_| DictationError::Storage)??;
            // One native key dialog at a time, shared with external model
            // providers.
            let _prompt = host
                .external_provider_prompt
                .try_lock()
                .map_err(|_| DictationError::PromptFailed)?;
            let language = match language {
                Language::En => PromptLanguage::English,
                Language::Ru => PromptLanguage::Russian,
            };
            let key = prompt_api_key(&window, &endpoint, &model, language)
                .await
                .map_err(|_| DictationError::PromptFailed)?;
            Ok(match key {
                Some(key) => {
                    host.dictation_store_key(provider, SecretString::new(key.to_string()))
                        .await?
                }
                // The dialog was cancelled: nothing changes.
                None => {
                    host.dictation_settings(DictationSettingsRequestV1::Get {})
                        .await?
                }
            })
        }
        other => Ok(host.dictation_settings(other).await?),
    }
}

#[tauri::command]
pub async fn dictation_transcribe_v1(
    host: State<'_, Arc<NanoHost>>,
    request: DictationTranscribeRequestV1,
) -> Result<DictationAnswerV1, DictationErrorV1> {
    Ok(host.dictation_transcribe(request).await?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::*;
    use crate::nano::tests::test_dir;

    const KEY: &str = "synthetic-dictation-key";

    fn fresh(purpose: &str, safe_mode: bool) -> (NanoHost, std::path::PathBuf) {
        let directory = test_dir(purpose);
        (NanoHost::for_tests(&directory, safe_mode), directory)
    }

    fn save_request(source: &str, base_url: &str, model: &str) -> DictationSettingsRequestV1 {
        serde_json::from_value(json!({
            "type": "save",
            "settings": {
                "source": source,
                "language": null,
                "openaiModel": "",
                "groqModel": "",
                "customBaseUrl": base_url,
                "customModel": model,
            }
        }))
        .expect("save request")
    }

    fn clip(audio_base64: &str, mime_type: &str) -> DictationTranscribeRequestV1 {
        DictationTranscribeRequestV1 {
            audio_base64: audio_base64.to_owned(),
            mime_type: mime_type.to_owned(),
        }
    }

    /// Answers one HTTP request with 200 and `body`; resolves to the raw
    /// request it received.
    async fn serve_once(body: &'static str) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
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
                "HTTP/1.1 200 Synthetic\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(answer.as_bytes()).await.expect("write");
            let _ = stream.shutdown().await;
            request
        });
        (format!("http://127.0.0.1:{port}/v1"), served)
    }

    #[test]
    fn requests_carry_no_key_address_or_provider() {
        for good in [
            json!({ "type": "get" }),
            json!({ "type": "save", "settings": {
                "source": "openai", "language": null, "openaiModel": "", "groqModel": "",
                "customBaseUrl": "", "customModel": ""
            }}),
            json!({ "type": "set-key", "provider": "groq", "language": "ru" }),
            json!({ "type": "clear-key", "provider": "custom" }),
        ] {
            assert!(
                serde_json::from_value::<DictationSettingsRequestV1>(good.clone()).is_ok(),
                "{good}"
            );
        }
        let set_key = json!({ "type": "set-key", "provider": "groq", "language": "en" });
        for field in ["apiKey", "key", "url"] {
            let mut bad = set_key.clone();
            bad[field] = json!("synthetic");
            assert!(
                serde_json::from_value::<DictationSettingsRequestV1>(bad).is_err(),
                "{field}"
            );
        }
        let save = json!({ "type": "save", "settings": {
            "source": "custom", "language": null, "openaiModel": "", "groqModel": "",
            "customBaseUrl": "https://example.test/v1", "customModel": "m"
        }});
        let mut bad = save.clone();
        bad["settings"]["apiKey"] = json!("synthetic");
        assert!(serde_json::from_value::<DictationSettingsRequestV1>(bad).is_err());
        let mut bad = save;
        bad["settings"]["source"] = json!("deepgram");
        assert!(serde_json::from_value::<DictationSettingsRequestV1>(bad).is_err());

        let ok = json!({ "audioBase64": "AAAA", "mimeType": "audio/webm" });
        let parsed: DictationTranscribeRequestV1 =
            serde_json::from_value(ok.clone()).expect("transcribe request");
        assert!(!format!("{parsed:?}").contains("AAAA"));
        for field in ["baseUrl", "provider", "model", "apiKey", "url"] {
            let mut bad = ok.clone();
            bad[field] = json!("synthetic");
            assert!(
                serde_json::from_value::<DictationTranscribeRequestV1>(bad).is_err(),
                "{field}"
            );
        }
    }

    #[tokio::test]
    async fn safe_mode_reads_settings_and_refuses_the_rest() {
        let (host, directory) = fresh("dictation-safe", true);
        let view = host
            .dictation_settings(DictationSettingsRequestV1::Get {})
            .await
            .expect("settings stay readable");
        let view = serde_json::to_value(view).expect("json");
        assert_eq!(view["safeMode"], json!(true));
        assert_eq!(view["keyEntry"], json!(false));
        assert_eq!(view["source"], json!("nano"));

        assert_eq!(
            host.dictation_settings(save_request("openai", "", ""))
                .await
                .err(),
            Some(DictationError::SafeMode)
        );
        assert_eq!(
            host.dictation_settings(DictationSettingsRequestV1::ClearKey {
                provider: DictationProviderId::OpenAi
            })
            .await
            .err(),
            Some(DictationError::SafeMode)
        );
        assert_eq!(
            host.dictation_store_key(DictationProviderId::OpenAi, SecretString::new(KEY.into()))
                .await
                .err(),
            Some(DictationError::SafeMode)
        );
        assert_eq!(
            host.dictation_transcribe(clip("AAAA", "audio/webm"))
                .await
                .err(),
            Some(DictationError::SafeMode)
        );
        assert!(!directory.join("dictation-v1.json").exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn off_and_nano_never_reach_a_provider_or_the_account() {
        let (host, directory) = fresh("dictation-off", false);
        assert_eq!(
            host.dictation_transcribe(clip("AAAA", "audio/webm"))
                .await
                .err(),
            Some(DictationError::NotConfigured)
        );
        host.dictation_settings(save_request("off", "", ""))
            .await
            .expect("save off");
        assert_eq!(
            host.dictation_transcribe(clip("AAAA", "audio/webm"))
                .await
                .err(),
            Some(DictationError::NotConfigured)
        );
        assert!(host.relay.get().is_none());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_clip_is_checked_before_it_is_decoded() {
        let (host, directory) = fresh("dictation-clip", false);
        assert_eq!(
            host.dictation_transcribe(clip("AAAA", "text/plain"))
                .await
                .err(),
            Some(DictationError::Invalid)
        );
        let limit = DICTATION_MAX_BYTES.div_ceil(3) * 4;
        let oversized = "A".repeat(limit as usize + 4);
        assert_eq!(
            host.dictation_transcribe(clip(&oversized, "audio/webm"))
                .await
                .err(),
            Some(DictationError::TooLarge)
        );
        host.dictation_settings(save_request("custom", "http://127.0.0.1:9/v1", "m"))
            .await
            .expect("save custom");
        assert_eq!(
            host.dictation_transcribe(clip("!!!", "audio/webm"))
                .await
                .err(),
            Some(DictationError::Invalid)
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn the_settings_view_and_the_file_never_hold_a_key() {
        let (host, directory) = fresh("dictation-key", false);
        host.dictation_settings(save_request("custom", "http://127.0.0.1:9/v1", "m"))
            .await
            .expect("save custom");
        let view = host
            .dictation_store_key(DictationProviderId::Custom, SecretString::new(KEY.into()))
            .await
            .expect("store key");
        let text = serde_json::to_string(&view).expect("json");
        assert!(!text.contains(KEY));
        let view = serde_json::to_value(&view).expect("json");
        assert_eq!(view["protocol"], json!(1));
        assert_eq!(view["maxBytes"], json!(20_971_520));
        assert_eq!(view["providers"][2]["keySet"], json!(true));
        assert_eq!(view["providers"][2]["ready"], json!(true));
        let file = std::fs::read_to_string(directory.join("dictation-v1.json")).expect("file");
        assert!(!file.contains(KEY));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn errors_reject_as_a_json_code() {
        for (error, code) in [
            (DictationError::InvalidKey, "invalid-key"),
            (DictationError::NotConfigured, "not-configured"),
            (DictationError::SafeMode, "safe-mode"),
        ] {
            assert_eq!(
                serde_json::to_value(DictationErrorV1::from(error)).expect("json"),
                json!({ "code": code })
            );
        }
    }

    #[tokio::test]
    async fn a_ready_custom_source_transcribes_through_the_host() {
        let (base, served) = serve_once(r#"{"text":"synthetic words"}"#).await;
        let (host, directory) = fresh("dictation-send", false);
        host.dictation_settings(save_request("custom", &base, "synthetic-model"))
            .await
            .expect("save custom");
        let answer = host
            .dictation_transcribe(clip("AAAA", "audio/webm;codecs=opus"))
            .await
            .expect("transcription");
        assert_eq!(answer.text, "synthetic words");
        let request = String::from_utf8_lossy(&served.await.expect("server")).into_owned();
        assert!(
            request.starts_with("POST /v1/audio/transcriptions"),
            "{request}"
        );
        let head = request
            .split("\r\n\r\n")
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(!head.contains("authorization"));
        let _ = std::fs::remove_dir_all(directory);
    }
}
