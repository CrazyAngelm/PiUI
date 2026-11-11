//! The Nano account commands (`contracts/nano-account-v1.ts`) and
//! `nano_dictation_v1`.
//!
//! Every command answers [`NanoAccountStatusV1`] except `nano_cloud_open_v1`
//! (nothing) and `nano_dictation_v1` (`{ text }`). Failures reject with
//! `{"code": "<kebab>"}` ([`NanoCommandError`]), like `app_update.rs`. Safe
//! mode refuses everything but the status and the local sign-out.
//! Requests reject unknown fields. The WebView never supplies a URL: links
//! are an enum resolved by the host.

use std::sync::Arc;

use base64::Engine as _;
use piui_nano::status::{
    NanoAccountStateV1, NanoAccountStatusV1, NanoLinkV1, NanoOpenLinkRequestV1,
    NanoSelectWorkspaceRequestV1,
};
use piui_nano::{AccountGeneration, NanoAccount, NanoError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State, Url};

use super::cloud_window::{self, CloudPolicy};
use super::{NanoHost, browser};

/// Audio the host sends to the dictation endpoint, whatever the plan says.
const HARD_DICTATION_BYTES: u64 = 64 * 1024 * 1024;
/// Longest workspace id accepted from the WebView.
const MAX_WORKSPACE_ID_CHARS: usize = 200;
/// Longest media type accepted from the WebView.
const MAX_MIME_CHARS: usize = 128;
/// Media types of a `MediaRecorder` clip the host passes on.
const DICTATION_MIME_TYPES: [&str; 3] = ["audio/webm", "audio/ogg", "audio/mp4"];

/// A failed command. Serializes as `{"code": "<NanoAccountErrorCodeV1>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{code}")]
pub struct NanoCommandError {
    pub code: NanoError,
}

impl From<NanoError> for NanoCommandError {
    fn from(code: NanoError) -> Self {
        Self { code }
    }
}

/// `nano_dictation_v1` request: one recorded clip.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoDictationRequestV1 {
    pub audio_base64: String,
    pub mime_type: String,
}

impl std::fmt::Debug for NanoDictationRequestV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NanoDictationRequestV1")
            .field("audio_chars", &self.audio_base64.len())
            .finish_non_exhaustive()
    }
}

/// `nano_dictation_v1` answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoDictationAnswerV1 {
    pub text: String,
}

/// The accepted media type of a clip (parameters such as `;codecs=opus` are
/// dropped), or `None`.
fn dictation_mime(value: &str) -> Option<&'static str> {
    if value.len() > MAX_MIME_CHARS {
        return None;
    }
    let essence = value.split(';').next()?.trim().to_ascii_lowercase();
    DICTATION_MIME_TYPES
        .into_iter()
        .find(|allowed| *allowed == essence)
}

/// Whether the cloud window may open for `status`: signed in with the cloud
/// feature in the plan (the same condition the WebView shows the entry
/// for). Signed out, expired, offline or signing in answers
/// `sign-in-required`; a plan without the cloud (or still loading) answers
/// `feature-unavailable`.
fn cloud_gate(status: &NanoAccountStatusV1) -> Result<(), NanoError> {
    if status.state != NanoAccountStateV1::SignedIn {
        return Err(NanoError::SignInRequired);
    }
    if !status
        .entitlements
        .as_ref()
        .is_some_and(|entitlements| entitlements.features.cloud)
    {
        return Err(NanoError::FeatureUnavailable);
    }
    Ok(())
}

impl NanoHost {
    /// The account and its generation when the cloud window may open now
    /// ([`cloud_gate`]); refused in safe mode.
    pub(crate) fn cloud_account(&self) -> Result<(&NanoAccount, AccountGeneration), NanoError> {
        let account = self.live_account()?;
        let (generation, status) = account.status_with_generation();
        cloud_gate(&status)?;
        Ok((account, generation))
    }

    /// Refuses unless the account still passes the cloud gate within
    /// `generation` (nothing signed out or in since the gate was checked).
    fn cloud_still_allowed(&self, generation: AccountGeneration) -> Result<(), NanoError> {
        let (_, current) = self.cloud_account()?;
        if current == generation {
            Ok(())
        } else {
            Err(NanoError::SignInRequired)
        }
    }

    /// Starts the browser sign-in; answers `signing-in` at once.
    pub(crate) async fn sign_in(&self) -> Result<NanoAccountStatusV1, NanoError> {
        let account = self.live_account()?;
        let allow_loopback = self.allow_loopback_http();
        account
            .begin_sign_in(Box::new(move |url: &Url| {
                browser::open_external(url, allow_loopback)
            }))
            .await
    }

    pub(crate) fn cancel_sign_in(&self) -> Result<NanoAccountStatusV1, NanoError> {
        Ok(self.live_account()?.cancel_sign_in())
    }

    /// Signs out. Allowed in safe mode, where it forgets the credential
    /// without a network call. Every relay session is cut at once.
    pub(crate) async fn sign_out(&self) -> Result<NanoAccountStatusV1, NanoError> {
        let result = self.account()?.sign_out(!self.safe_mode).await;
        if let Some(relay) = self.relay.get() {
            relay.close_all_sessions();
        }
        result
    }

    pub(crate) async fn select_workspace(
        &self,
        request: NanoSelectWorkspaceRequestV1,
    ) -> Result<NanoAccountStatusV1, NanoError> {
        let account = self.live_account()?;
        let id = request.workspace_id.trim();
        if id.is_empty() || id.chars().count() > MAX_WORKSPACE_ID_CHARS {
            return Err(NanoError::Invalid);
        }
        account.select_workspace(id).await
    }

    pub(crate) async fn refresh(&self) -> Result<NanoAccountStatusV1, NanoError> {
        self.live_account()?.refresh().await
    }

    /// Opens a Nano page in the system browser. Signed out, only the sign-up
    /// page is offered (nothing else contacts the server before sign-in).
    pub(crate) async fn open_link(
        &self,
        request: NanoOpenLinkRequestV1,
    ) -> Result<NanoAccountStatusV1, NanoError> {
        let account = self.live_account()?;
        if request.link != NanoLinkV1::Signup
            && account.status().state != NanoAccountStateV1::SignedIn
        {
            return Err(NanoError::SignInRequired);
        }
        let url = account.link(request.link).await?;
        let allow_loopback = self.allow_loopback_http();
        tokio::task::spawn_blocking(move || browser::open_external(&url, allow_loopback))
            .await
            .map_err(|_| NanoError::BrowserFailed)?
            .map_err(|()| NanoError::BrowserFailed)?;
        Ok(account.status())
    }

    /// Where the cloud window starts and what it may navigate to, for an
    /// account that passes the cloud gate; re-checked after the server call,
    /// so a sign-out (or another sign-in) meanwhile refuses the open.
    pub(crate) async fn cloud_target(
        &self,
    ) -> Result<(Url, CloudPolicy, AccountGeneration), NanoError> {
        let (account, generation) = self.cloud_account()?;
        let config = account.config();
        let policy = CloudPolicy {
            development_origin: config.development.then(|| config.origin()),
            allow_loopback_http: self.allow_loopback_http(),
        };
        let fallback = cloud_window::default_cloud_url(config);
        let candidate = account
            .cloud_url()
            .await
            .unwrap_or_else(|_| fallback.clone());
        self.cloud_still_allowed(generation)?;
        let allowed =
            cloud_window::navigation_allowed(&candidate, policy.development_origin.as_deref());
        Ok((
            if allowed { candidate } else { fallback },
            policy,
            generation,
        ))
    }

    /// Transcribes one clip. The audio exists only in this call: nothing is
    /// written to disk and nothing is kept afterwards.
    pub(crate) async fn dictate(
        &self,
        request: NanoDictationRequestV1,
    ) -> Result<NanoDictationAnswerV1, NanoError> {
        let account = self.live_account()?;
        let status = account.status();
        if status.state != NanoAccountStateV1::SignedIn {
            return Err(NanoError::SignInRequired);
        }
        let entitlements = status
            .entitlements
            .as_ref()
            .ok_or(NanoError::FeatureUnavailable)?;
        let offered = status
            .capabilities
            .is_some_and(|capabilities| capabilities.dictation);
        if !offered || !entitlements.features.dictation {
            return Err(NanoError::FeatureUnavailable);
        }
        let mime = dictation_mime(&request.mime_type).ok_or(NanoError::Invalid)?;
        let limit = entitlements
            .limits
            .dictation_max_bytes
            .min(HARD_DICTATION_BYTES);
        // Refuse by the encoded length first: a too large clip is never decoded.
        if request.audio_base64.len() as u64 > limit.div_ceil(3).saturating_mul(4) {
            return Err(NanoError::Invalid);
        }
        let audio = base64::engine::general_purpose::STANDARD
            .decode(request.audio_base64.as_bytes())
            .map_err(|_| NanoError::Invalid)?;
        drop(request);
        if audio.is_empty() || audio.len() as u64 > limit {
            return Err(NanoError::Invalid);
        }
        let result = account.dictate(audio, mime).await?;
        Ok(NanoDictationAnswerV1 { text: result.text })
    }
}

#[tauri::command]
pub fn nano_account_status_v1(host: State<'_, Arc<NanoHost>>) -> NanoAccountStatusV1 {
    host.status()
}

#[tauri::command]
pub async fn nano_account_sign_in_v1(
    host: State<'_, Arc<NanoHost>>,
) -> Result<NanoAccountStatusV1, NanoCommandError> {
    Ok(host.sign_in().await?)
}

#[tauri::command]
pub fn nano_account_cancel_sign_in_v1(
    host: State<'_, Arc<NanoHost>>,
) -> Result<NanoAccountStatusV1, NanoCommandError> {
    Ok(host.cancel_sign_in()?)
}

#[tauri::command]
pub async fn nano_account_sign_out_v1<R: Runtime>(
    app: AppHandle<R>,
    host: State<'_, Arc<NanoHost>>,
) -> Result<NanoAccountStatusV1, NanoCommandError> {
    let result = host.sign_out().await;
    // The cloud window's browsing data goes with the account, whatever the
    // credential store said.
    cloud_window::clear(&app, &host.cloud_profile_dir);
    Ok(result?)
}

#[tauri::command]
pub async fn nano_account_select_workspace_v1(
    host: State<'_, Arc<NanoHost>>,
    request: NanoSelectWorkspaceRequestV1,
) -> Result<NanoAccountStatusV1, NanoCommandError> {
    Ok(host.select_workspace(request).await?)
}

#[tauri::command]
pub async fn nano_account_refresh_v1(
    host: State<'_, Arc<NanoHost>>,
) -> Result<NanoAccountStatusV1, NanoCommandError> {
    Ok(host.refresh().await?)
}

#[tauri::command]
pub async fn nano_account_open_link_v1(
    host: State<'_, Arc<NanoHost>>,
    request: NanoOpenLinkRequestV1,
) -> Result<NanoAccountStatusV1, NanoCommandError> {
    Ok(host.open_link(request).await?)
}

/// Opens or focuses the Nano Cloud window: only for a signed-in account whose
/// plan includes the cloud, checked before focusing, after the server call
/// and once more after the window exists (a sign-out racing the open closes
/// it again and forgets its data).
#[tauri::command]
pub async fn nano_cloud_open_v1<R: Runtime>(
    app: AppHandle<R>,
    host: State<'_, Arc<NanoHost>>,
) -> Result<(), NanoCommandError> {
    host.cloud_account()?;
    if cloud_window::focus_existing(&app) {
        return Ok(());
    }
    let (url, policy, generation) = host.cloud_target().await?;
    cloud_window::open_or_focus(&app, url, host.cloud_profile_dir.clone(), policy)?;
    if let Err(error) = host.cloud_still_allowed(generation) {
        cloud_window::clear(&app, &host.cloud_profile_dir);
        return Err(error.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn nano_dictation_v1(
    host: State<'_, Arc<NanoHost>>,
    request: NanoDictationRequestV1,
) -> Result<NanoDictationAnswerV1, NanoCommandError> {
    Ok(host.dictate(request).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nano::tests::test_dir;
    use serde_json::json;

    fn fresh(purpose: &str, safe_mode: bool) -> (NanoHost, std::path::PathBuf) {
        let directory = test_dir(purpose);
        (NanoHost::for_tests(&directory, safe_mode), directory)
    }

    #[test]
    fn errors_reject_as_a_json_code() {
        for error in NanoError::ALL {
            assert_eq!(
                serde_json::to_value(NanoCommandError::from(error)).expect("json"),
                json!({ "code": error.code() })
            );
        }
        assert_eq!(
            NanoCommandError::from(NanoError::SafeMode).to_string(),
            "safe mode is on"
        );
    }

    #[test]
    fn requests_reject_unknown_fields_and_bad_shapes() {
        let ok: NanoDictationRequestV1 = serde_json::from_value(json!({
            "audioBase64": "AAAA",
            "mimeType": "audio/webm;codecs=opus",
        }))
        .expect("dictation request");
        assert_eq!(ok.mime_type, "audio/webm;codecs=opus");
        assert!(!format!("{ok:?}").contains("AAAA"));
        for bad in [
            json!({ "audioBase64": "AAAA", "mimeType": "audio/webm", "language": "ru" }),
            json!({ "audioBase64": "AAAA" }),
            json!({ "mimeType": "audio/webm" }),
            json!({ "audio_base64": "AAAA", "mime_type": "audio/webm" }),
            json!({ "audioBase64": 1, "mimeType": "audio/webm" }),
        ] {
            assert!(
                serde_json::from_value::<NanoDictationRequestV1>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        assert!(
            serde_json::from_value::<NanoSelectWorkspaceRequestV1>(
                json!({ "workspaceId": "w", "x": 1 })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<NanoOpenLinkRequestV1>(json!({ "link": "https://x" }))
                .is_err()
        );
        assert!(
            serde_json::from_value::<NanoOpenLinkRequestV1>(json!({ "link": "cloud" })).is_err()
        );
        assert_eq!(
            serde_json::to_value(NanoDictationAnswerV1 { text: "hi".into() }).expect("json"),
            json!({ "text": "hi" })
        );
    }

    #[test]
    fn only_webm_ogg_and_mp4_audio_is_passed_on() {
        for (given, kept) in [
            ("audio/webm", "audio/webm"),
            ("audio/webm;codecs=opus", "audio/webm"),
            ("Audio/WebM ; codecs=opus", "audio/webm"),
            ("audio/ogg;codecs=opus", "audio/ogg"),
            ("audio/mp4", "audio/mp4"),
        ] {
            assert_eq!(dictation_mime(given), Some(kept), "{given}");
        }
        for refused in [
            "",
            "audio/wav",
            "audio/mpeg",
            "video/webm",
            "text/html",
            "application/octet-stream",
            "audio/webmx",
            "audio",
        ] {
            assert_eq!(dictation_mime(refused), None, "{refused}");
        }
        assert_eq!(
            dictation_mime(&format!("audio/webm;{}", "x".repeat(200))),
            None
        );
    }

    #[tokio::test]
    async fn safe_mode_refuses_everything_but_status_and_local_sign_out() {
        let (host, directory) = fresh("safe", true);
        assert_eq!(host.sign_in().await.err(), Some(NanoError::SafeMode));
        assert_eq!(host.cancel_sign_in().err(), Some(NanoError::SafeMode));
        assert_eq!(
            host.select_workspace(
                serde_json::from_value(json!({ "workspaceId": "ws" })).expect("request")
            )
            .await
            .err(),
            Some(NanoError::SafeMode)
        );
        assert_eq!(host.refresh().await.err(), Some(NanoError::SafeMode));
        for link in [NanoLinkV1::Billing, NanoLinkV1::Devices, NanoLinkV1::Signup] {
            assert_eq!(
                host.open_link(NanoOpenLinkRequestV1 { link }).await.err(),
                Some(NanoError::SafeMode),
                "{link:?}"
            );
        }
        assert_eq!(host.cloud_target().await.err(), Some(NanoError::SafeMode));
        let dictation = NanoDictationRequestV1 {
            audio_base64: "AAAA".into(),
            mime_type: "audio/webm".into(),
        };
        assert_eq!(
            host.dictate(dictation).await.err(),
            Some(NanoError::SafeMode)
        );

        // Status and the local sign-out work, with no network call.
        assert_eq!(host.status().state, NanoAccountStateV1::SignedOut);
        let signed_out = host.sign_out().await.expect("local sign-out");
        assert_eq!(signed_out.state, NanoAccountStateV1::SignedOut);
        assert!(
            host.relay.get().is_none(),
            "safe mode never starts the relay"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_signed_out_account_offers_only_sign_up_and_no_workspace_or_dictation() {
        let (host, directory) = fresh("signed-out", false);
        for link in [NanoLinkV1::Billing, NanoLinkV1::Devices] {
            assert_eq!(
                host.open_link(NanoOpenLinkRequestV1 { link }).await.err(),
                Some(NanoError::SignInRequired),
                "{link:?}"
            );
        }
        assert_eq!(
            host.select_workspace(
                serde_json::from_value(json!({ "workspaceId": "ws" })).expect("request")
            )
            .await
            .err(),
            Some(NanoError::SignInRequired)
        );
        assert_eq!(host.refresh().await.err(), Some(NanoError::SignInRequired));
        let dictation = NanoDictationRequestV1 {
            audio_base64: "AAAA".into(),
            mime_type: "audio/webm".into(),
        };
        assert_eq!(
            host.dictate(dictation).await.err(),
            Some(NanoError::SignInRequired)
        );
        for bad in ["", "   "] {
            let request = NanoSelectWorkspaceRequestV1 {
                workspace_id: bad.into(),
            };
            assert_eq!(
                host.select_workspace(request).await.err(),
                Some(NanoError::Invalid)
            );
        }
        let too_long = NanoSelectWorkspaceRequestV1 {
            workspace_id: "w".repeat(MAX_WORKSPACE_ID_CHARS + 1),
        };
        assert_eq!(
            host.select_workspace(too_long).await.err(),
            Some(NanoError::Invalid)
        );
        // No command above contacted a server or started the relay.
        assert!(host.relay.get().is_none());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_signed_out_account_cannot_open_the_cloud_window() {
        let (host, directory) = fresh("cloud", false);
        assert_eq!(
            host.cloud_target().await.err(),
            Some(NanoError::SignInRequired)
        );
        assert_eq!(host.cloud_account().err(), Some(NanoError::SignInRequired));
        // No server was contacted and nothing was started.
        assert!(host.relay.get().is_none());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn the_cloud_gate_needs_a_signed_in_account_with_the_cloud_feature() {
        use crate::nano::tests::fixture_status;
        let signed_in = fixture_status("signedIn");
        assert_eq!(cloud_gate(&signed_in), Ok(()));
        for key in ["signedOut", "signingIn", "expired"] {
            assert_eq!(
                cloud_gate(&fixture_status(key)),
                Err(NanoError::SignInRequired),
                "{key}"
            );
        }
        let mut offline = signed_in.clone();
        offline.state = NanoAccountStateV1::Offline;
        assert_eq!(cloud_gate(&offline), Err(NanoError::SignInRequired));

        let mut no_cloud = signed_in.clone();
        if let Some(entitlements) = no_cloud.entitlements.as_mut() {
            entitlements.features.cloud = false;
        }
        assert_eq!(cloud_gate(&no_cloud), Err(NanoError::FeatureUnavailable));
        let mut loading = signed_in;
        loading.entitlements = None;
        assert_eq!(cloud_gate(&loading), Err(NanoError::FeatureUnavailable));
    }
}
