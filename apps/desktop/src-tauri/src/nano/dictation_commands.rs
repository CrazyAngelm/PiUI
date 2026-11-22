//! Dictation sources (ADR-061, `contracts/dictation-v1.ts`): the settings and
//! the upload for speech-to-text providers other than the Nano account.
//!
//! The WebView sends a clip and nothing else: the address, model and API key
//! of a request come from the host's own settings and credential store. A key
//! is typed in the native dialog and never crosses IPC. Safe mode reads the
//! settings and refuses everything else; no audio leaves in safe mode.
//!
//! `dictation_save_recording_v1` (ADR-066) writes an unsent recording to a file
//! the person picks in the native save dialog. It sends nothing anywhere, so it
//! works in safe mode too: a recording must never be lost.

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

/// Largest recording the save command writes (32 MiB).
const SAVE_RECORDING_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// `dictation_save_recording_v1` request: one recording and its media type.
/// There is no field for a path or a name: the person picks them.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationSaveRecordingRequestV1 {
    pub audio_base64: String,
    pub mime_type: String,
}

impl std::fmt::Debug for DictationSaveRecordingRequestV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DictationSaveRecordingRequestV1")
            .field("audio_chars", &self.audio_base64.len())
            .finish_non_exhaustive()
    }
}

/// `dictation_save_recording_v1` answer: `saved` is false when the dialog was
/// closed without saving.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DictationSavedV1 {
    pub saved: bool,
}

/// The file extension of a container the recorder produces.
fn recording_extension(mime: &str) -> &'static str {
    match mime {
        "audio/ogg" => "ogg",
        "audio/mp4" => "m4a",
        "audio/wav" => "wav",
        _ => "webm",
    }
}

/// `nano-voice-YYYYMMDD-HHMM.<ext>`, the dialog's suggested name.
fn recording_file_name(now: chrono::NaiveDateTime, extension: &str) -> String {
    format!("nano-voice-{}.{extension}", now.format("%Y%m%d-%H%M"))
}

/// A checked recording: its bytes and the extension of its container.
struct RecordingToSave {
    audio: Vec<u8>,
    extension: &'static str,
}

/// Validates a save request before any dialog opens: the media type is one a
/// dictation clip may have, the clip fits the cap (by encoded length first, so
/// an oversized one is never decoded) and holds audio.
fn prepare_recording(
    request: &DictationSaveRecordingRequestV1,
) -> Result<RecordingToSave, DictationError> {
    let mime = dictation_mime(&request.mime_type).ok_or(DictationError::Invalid)?;
    if request.audio_base64.len() as u64 > SAVE_RECORDING_MAX_BYTES.div_ceil(3).saturating_mul(4) {
        return Err(DictationError::TooLarge);
    }
    let audio = base64::engine::general_purpose::STANDARD
        .decode(request.audio_base64.as_bytes())
        .map_err(|_| DictationError::Invalid)?;
    if audio.is_empty() {
        return Err(DictationError::Invalid);
    }
    if audio.len() as u64 > SAVE_RECORDING_MAX_BYTES {
        return Err(DictationError::TooLarge);
    }
    Ok(RecordingToSave {
        audio,
        extension: recording_extension(mime),
    })
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

    /// Stores a key the native dialog returned, for `endpoint`, the address
    /// the dialog showed. The host refuses it when the provider's address is
    /// no longer that one, so a key never goes to an address the person did
    /// not see.
    pub(crate) async fn dictation_store_key(
        &self,
        provider: DictationProviderId,
        key: SecretString,
        endpoint: String,
    ) -> Result<DictationSettingsV1, DictationError> {
        if self.safe_mode {
            return Err(DictationError::SafeMode);
        }
        let sources = self.dictation.clone();
        let settings =
            tokio::task::spawn_blocking(move || sources.set_key(provider, &key, &endpoint))
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
                    host.dictation_store_key(provider, SecretString::new(key.to_string()), endpoint)
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

/// Writes a recording to a file chosen in the native save dialog. Nothing
/// leaves the computer and the audio is never logged.
#[tauri::command]
pub async fn dictation_save_recording_v1(
    request: DictationSaveRecordingRequestV1,
) -> Result<DictationSavedV1, DictationErrorV1> {
    let recording = prepare_recording(&request)?;
    drop(request);
    let name = recording_file_name(chrono::Local::now().naive_local(), recording.extension);
    let chosen = rfd::AsyncFileDialog::new()
        .set_file_name(name)
        .add_filter("Audio", &[recording.extension])
        .save_file()
        .await;
    let Some(file) = chosen else {
        return Ok(DictationSavedV1 { saved: false });
    };
    let path = file.path().to_path_buf();
    let audio = recording.audio;
    tokio::task::spawn_blocking(move || std::fs::write(path, audio))
        .await
        .map_err(|_| DictationError::Storage)?
        .map_err(|_| DictationError::Storage)?;
    Ok(DictationSavedV1 { saved: true })
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

    /// The address the key dialog would show for the custom endpoint.
    fn shown_address(host: &NanoHost) -> String {
        host.dictation
            .key_target(DictationProviderId::Custom)
            .expect("key target")
            .0
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
            host.dictation_store_key(
                DictationProviderId::OpenAi,
                SecretString::new(KEY.into()),
                String::new()
            )
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
            .dictation_store_key(
                DictationProviderId::Custom,
                SecretString::new(KEY.into()),
                shown_address(&host),
            )
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

    #[tokio::test]
    async fn a_key_typed_for_one_address_is_refused_for_another() {
        let (host, directory) = fresh("dictation-race", false);
        host.dictation_settings(save_request("custom", "http://127.0.0.1:9/v1", "m"))
            .await
            .expect("save custom");
        // The dialog showed this address ...
        let shown = shown_address(&host);
        // ... and the address changed before the key was stored.
        host.dictation_settings(save_request("custom", "http://127.0.0.1:10/v1", "m"))
            .await
            .expect("move");
        assert_eq!(
            host.dictation_store_key(
                DictationProviderId::Custom,
                SecretString::new(KEY.into()),
                shown,
            )
            .await
            .err(),
            Some(DictationError::SettingsChanged)
        );
        let view = host
            .dictation_settings(DictationSettingsRequestV1::Get {})
            .await
            .expect("settings");
        let view = serde_json::to_value(view).expect("json");
        assert_eq!(view["providers"][2]["keySet"], json!(false));
        assert_eq!(
            view["providers"][2]["baseUrl"],
            json!("http://127.0.0.1:10/v1")
        );
        let file = std::fs::read_to_string(directory.join("dictation-v1.json")).expect("file");
        assert!(!file.contains(KEY));
        let _ = std::fs::remove_dir_all(directory);
    }

    fn save_clip(audio_base64: &str, mime_type: &str) -> DictationSaveRecordingRequestV1 {
        DictationSaveRecordingRequestV1 {
            audio_base64: audio_base64.to_owned(),
            mime_type: mime_type.to_owned(),
        }
    }

    #[test]
    fn a_save_request_carries_audio_and_a_type_only() {
        let ok = json!({ "audioBase64": "AAAA", "mimeType": "audio/webm" });
        let parsed: DictationSaveRecordingRequestV1 =
            serde_json::from_value(ok.clone()).expect("save request");
        assert!(!format!("{parsed:?}").contains("AAAA"));
        for field in ["path", "fileName", "url", "provider"] {
            let mut bad = ok.clone();
            bad[field] = json!("synthetic");
            assert!(
                serde_json::from_value::<DictationSaveRecordingRequestV1>(bad).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn a_recording_is_checked_before_the_save_dialog_opens() {
        // The media type uses the same allowlist as the dictation commands.
        assert_eq!(
            prepare_recording(&save_clip("AAAA", "text/plain")).err(),
            Some(DictationError::Invalid)
        );
        assert_eq!(
            prepare_recording(&save_clip("AAAA", "video/webm")).err(),
            Some(DictationError::Invalid)
        );
        assert_eq!(
            prepare_recording(&save_clip("!!!", "audio/webm")).err(),
            Some(DictationError::Invalid)
        );
        assert_eq!(
            prepare_recording(&save_clip("", "audio/webm")).err(),
            Some(DictationError::Invalid)
        );
        // The cap is checked on the encoded length, so the clip is never decoded.
        let limit = SAVE_RECORDING_MAX_BYTES.div_ceil(3) * 4;
        let oversized = "A".repeat(limit as usize + 4);
        assert_eq!(
            prepare_recording(&save_clip(&oversized, "audio/webm")).err(),
            Some(DictationError::TooLarge)
        );
        // The longest encoded length that fits still decodes to one byte over the cap.
        let over_when_decoded = "A".repeat(limit as usize);
        assert_eq!(
            prepare_recording(&save_clip(&over_when_decoded, "audio/webm")).err(),
            Some(DictationError::TooLarge)
        );
        let fits = "A".repeat(4096);
        assert!(prepare_recording(&save_clip(&fits, "audio/webm;codecs=opus")).is_ok());
    }

    #[test]
    fn a_recording_is_named_after_its_container() {
        for (mime, extension) in [
            ("audio/webm;codecs=opus", "webm"),
            ("audio/webm", "webm"),
            ("audio/ogg;codecs=opus", "ogg"),
            ("audio/mp4", "m4a"),
            ("audio/wav", "wav"),
        ] {
            let checked = prepare_recording(&save_clip("AAAA", mime)).expect("recording");
            assert_eq!(checked.extension, extension, "{mime}");
            assert_eq!(checked.audio, vec![0, 0, 0]);
        }
        let when = chrono::NaiveDate::from_ymd_opt(2026, 11, 16)
            .and_then(|date| date.and_hms_opt(9, 5, 30))
            .expect("date");
        assert_eq!(
            recording_file_name(when, "webm"),
            "nano-voice-20261116-0905.webm"
        );
        assert_eq!(
            recording_file_name(when, "m4a"),
            "nano-voice-20261116-0905.m4a"
        );
    }

    #[test]
    fn errors_reject_as_a_json_code() {
        for (error, code) in [
            (DictationError::InvalidKey, "invalid-key"),
            (DictationError::NotConfigured, "not-configured"),
            (DictationError::SafeMode, "safe-mode"),
            (DictationError::SettingsChanged, "settings-changed"),
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
