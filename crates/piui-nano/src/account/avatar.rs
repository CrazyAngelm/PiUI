//! Ephemeral avatar media. Uses account custody and its existing HTTP client only.
use std::collections::BTreeMap;
use std::future::Future;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{AccountGeneration, NanoAccount, NanoAccountStateV1, NanoError, State};
use crate::net::{API_TIMEOUT, ServerFailure, read_capped};

pub const NANO_AVATAR_EVENT_V1: &str = "piui://nano-avatar-v1";
/// Existing server generator bound: HermesAvatarBuilderClient.MaxResultBytes.
pub const MAX_AVATAR_BYTES: usize = 16 * 1024 * 1024;
const CLIPS: [&str; 10] = [
    "idle", "think", "work", "wait", "done", "error", "wave", "sleep", "talk", "still",
];

pub(super) fn custody_key(s: &State) -> (u64, bool, Option<String>, bool, bool) {
    (
        s.generation,
        s.phase == NanoAccountStateV1::SignedIn,
        s.selected.clone(),
        s.capabilities.is_some_and(|c| c.avatars),
        s.entitlements.as_ref().is_some_and(|e| e.features.avatars),
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoAvatarScopeV1 {
    pub protocol: u8,
    pub revision: u64,
    pub context: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AvatarManifest {
    pub schema_version: u8,
    pub avatar_id: String,
    pub name: String,
    pub renderer: String,
    pub renderer_version: u8,
    pub media: AvatarMedia,
    pub atlas: AvatarAtlas,
    pub clips: BTreeMap<String, AvatarClip>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AvatarMedia {
    pub variant: String,
    pub sha256: String,
    pub mime_type: String,
    pub byte_count: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AvatarAtlas {
    pub cell_width: u32,
    pub cell_height: u32,
    pub columns: u32,
    pub rows: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AvatarClip {
    pub row: u32,
    pub frames: u32,
    pub ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desync: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub still: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<AvatarHold>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AvatarHold {
    pub frames: Vec<u32>,
    pub ms: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AvatarList {
    workspace_id: String,
    selected_avatar_id: Option<String>,
    avatars: Vec<AvatarSummary>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AvatarSummary {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NanoAvatarContentV1 {
    pub manifest: AvatarManifest,
    pub media_base64: String,
}
#[derive(Serialize)]
pub struct NanoAvatarAnswerV1 {
    pub scope: NanoAvatarScopeV1,
    pub avatar: Option<NanoAvatarContentV1>,
}

fn valid_id(id: &str) -> bool {
    matches!(
        id,
        "nano" | "analyst" | "lawyer" | "marketer" | "editor" | "blair" | "pixel"
    ) || id.strip_prefix("u-").is_some_and(|s| {
        s.len() == 12
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

impl AvatarManifest {
    fn validate(&self, id: &str) -> Result<(), NanoError> {
        let a = &self.atlas;
        let m = &self.media;
        if self.schema_version != 1
            || self.renderer_version != 1
            || self.renderer != "nano-atlas"
            || self.avatar_id != id
            || !valid_id(id)
            || self.name.is_empty()
            || (a.cell_width, a.cell_height, a.columns, a.rows) != (192, 208, 8, 9)
            || m.variant != "atlas"
            || m.mime_type != "image/webp"
            || m.byte_count == 0
            || m.byte_count > MAX_AVATAR_BYTES
            || m.sha256.len() != 64
            || !m
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.clips.len() != CLIPS.len()
            || !CLIPS.iter().all(|key| self.clips.contains_key(*key))
        {
            return Err(NanoError::UnsupportedServer);
        }
        for (key, c) in &self.clips {
            if c.row >= a.rows
                || c.frames == 0
                || c.frames > a.columns
                || (if key == "still" {
                    c.ms.is_some() || c.frames != 1
                } else {
                    c.ms.is_none_or(|ms| ms == 0)
                })
                || c.repeat == Some(0)
                || c.still.is_some_and(|frame| frame >= c.frames)
                || c.hold
                    .as_ref()
                    .is_some_and(|h| h.ms == 0 || h.frames.iter().any(|frame| *frame >= c.frames))
            {
                return Err(NanoError::UnsupportedServer);
            }
        }
        Ok(())
    }
}

impl NanoAccount {
    /// Local custody snapshot. Revision orders events; context ignores credit-only updates.
    pub fn avatar_scope(&self) -> NanoAvatarScopeV1 {
        let s = self.inner.lock();
        let (_, signed_in, workspace, capability, entitled) = custody_key(&s);
        let allowed = signed_in && workspace.is_some() && capability && entitled;
        NanoAvatarScopeV1 {
            protocol: 1,
            revision: s.revision,
            context: allowed.then(|| format!("{}.{}", s.generation, s.avatar_epoch)),
            workspace_id: if allowed { workspace } else { None },
        }
    }

    fn ensure_avatar_scope(
        &self,
        scope: &NanoAvatarScopeV1,
        generation: AccountGeneration,
    ) -> Result<(), NanoError> {
        let current = self.avatar_scope();
        if scope.context.is_none()
            || current.context != scope.context
            || current.workspace_id != scope.workspace_id
            || self.generation() != generation
        {
            Err(NanoError::FeatureUnavailable)
        } else {
            Ok(())
        }
    }

    /// Cancels requests and body reads as soon as custody changes, even if changes coalesce.
    async fn within_avatar_scope<T>(
        &self,
        scope: &NanoAvatarScopeV1,
        generation: AccountGeneration,
        work: impl Future<Output = Result<T, NanoError>>,
    ) -> Result<T, NanoError> {
        let mut changes = self.subscribe();
        self.ensure_avatar_scope(scope, generation)?;
        tokio::pin!(work);
        loop {
            tokio::select! {
                biased;
                changed = changes.changed() => {
                    if changed.is_err() { return Err(NanoError::FeatureUnavailable); }
                    self.ensure_avatar_scope(scope, generation)?;
                }
                result = &mut work => {
                    self.ensure_avatar_scope(scope, generation)?;
                    return result;
                }
            }
        }
    }

    pub async fn load_avatar(&self, context: &str) -> Result<NanoAvatarAnswerV1, NanoError> {
        let scope = self.avatar_scope();
        let generation = self.generation();
        if scope.context.as_deref() != Some(context) {
            return Err(NanoError::FeatureUnavailable);
        }
        let result = self
            .within_avatar_scope(&scope, generation, async {
                let workspace = scope
                    .workspace_id
                    .as_deref()
                    .ok_or(NanoError::FeatureUnavailable)?;
                let list: AvatarList = self
                    .get_json(
                        generation.0,
                        self.inner
                            .config
                            .api_url(&["workspaces", workspace, "avatars"]),
                    )
                    .await?;
                self.ensure_avatar_scope(&scope, generation)?;
                if list.workspace_id != workspace
                    || list
                        .avatars
                        .iter()
                        .any(|a| !valid_id(&a.id) || a.name.is_empty())
                {
                    return Err(NanoError::UnsupportedServer);
                }
                let Some(id) = list.selected_avatar_id else {
                    return Ok(NanoAvatarAnswerV1 {
                        scope: scope.clone(),
                        avatar: None,
                    });
                };
                if !valid_id(&id) || !list.avatars.iter().any(|a| a.id == id) {
                    return Err(NanoError::UnsupportedServer);
                }
                let manifest: AvatarManifest = self
                    .get_json(
                        generation.0,
                        self.inner.config.api_url(&[
                            "workspaces",
                            workspace,
                            "avatars",
                            &id,
                            "manifest",
                        ]),
                    )
                    .await?;
                self.ensure_avatar_scope(&scope, generation)?;
                manifest.validate(&id)?;
                let mut url = self.inner.config.api_url(&[
                    "workspaces",
                    workspace,
                    "avatars",
                    &id,
                    "media",
                    "atlas",
                ]);
                url.query_pairs_mut()
                    .append_pair("sha256", &manifest.media.sha256);
                let mut response = self
                    .send_authorized(generation.0, |http, token| {
                        http.get(url.clone())
                            .bearer_auth(token)
                            .header(reqwest::header::ACCEPT, "image/webp")
                            .timeout(API_TIMEOUT)
                    })
                    .await?;
                self.ensure_avatar_scope(&scope, generation)?;
                if !response.status().is_success() {
                    return Err(ServerFailure::read(response).await.account_error());
                }
                if response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|h| h.to_str().ok())
                    != Some("image/webp")
                {
                    return Err(NanoError::UnsupportedServer);
                }
                let bytes = read_capped(&mut response, manifest.media.byte_count).await?;
                self.ensure_avatar_scope(&scope, generation)?;
                validate_media(&manifest, &bytes)?;
                let media_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                self.ensure_avatar_scope(&scope, generation)?;
                Ok(NanoAvatarAnswerV1 {
                    scope: scope.clone(),
                    avatar: Some(NanoAvatarContentV1 {
                        manifest,
                        media_base64,
                    }),
                })
            })
            .await;
        if matches!(
            result,
            Err(NanoError::FeatureUnavailable | NanoError::WorkspaceNotFound)
        ) {
            self.invalidate_avatar_entitlement(&scope, generation);
        }
        result
    }

    /// An authoritative refusal retires only the custody that made the request.
    /// Explicit account refresh can restore the right when the server grants it again.
    fn invalidate_avatar_entitlement(
        &self,
        scope: &NanoAvatarScopeV1,
        generation: AccountGeneration,
    ) {
        self.inner.mutate(|s| {
            if s.generation == generation.0
                && scope.context.as_deref()
                    == Some(format!("{}.{}", s.generation, s.avatar_epoch).as_str())
                && s.selected == scope.workspace_id
                && let Some(entitlements) = s.entitlements.as_mut()
            {
                entitlements.features.avatars = false;
            }
        });
    }
}

fn validate_media(manifest: &AvatarManifest, bytes: &[u8]) -> Result<(), NanoError> {
    if bytes.len() != manifest.media.byte_count
        || format!("{:x}", Sha256::digest(bytes)) != manifest.media.sha256
        || webp_dimensions(bytes) != Some((1536, 1872))
    {
        Err(NanoError::UnsupportedServer)
    } else {
        Ok(())
    }
}

/// RIFF/WebP container geometry; the UI additionally decodes the actual bitstream.
fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    let declared = u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
    if declared.checked_add(8)? != bytes.len() {
        return None;
    }
    let le24 = |slice: &[u8]| {
        u32::from(slice[0]) | (u32::from(slice[1]) << 8) | (u32::from(slice[2]) << 16)
    };
    match bytes.get(12..16)? {
        b"VP8X" => {
            let payload = bytes.get(20..30)?;
            // Animated WebP is not an atlas and is never accepted.
            if payload[0] & 2 != 0 {
                return None;
            }
            Some((le24(&payload[4..7]) + 1, le24(&payload[7..10]) + 1))
        }
        b"VP8 " => {
            let payload = bytes.get(20..30)?;
            if payload.get(3..6)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            Some((
                u16::from_le_bytes([payload[6], payload[7]]) as u32 & 0x3fff,
                u16::from_le_bytes([payload[8], payload[9]]) as u32 & 0x3fff,
            ))
        }
        b"VP8L" => {
            let payload = bytes.get(20..25)?;
            if payload[0] != 0x2f {
                return None;
            }
            let bits = u32::from_le_bytes(payload[1..5].try_into().ok()?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{FakeAvatar, FakeNano};
    use bytes::Bytes;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::{Notify, mpsc};

    fn manifest() -> AvatarManifest {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/fixtures/nano-avatars-v1.json"
        )))
        .expect("fixture")
    }

    async fn http_fixture() -> (FakeNano, NanoAccount, Arc<Notify>) {
        let server = FakeNano::start().await;
        let (account, _) = server.signed_in().await;
        account.inner.mutate(|s| {
            s.capabilities.as_mut().expect("capabilities").avatars = true;
            s.entitlements
                .as_mut()
                .expect("entitlements")
                .features
                .avatars = true;
        });
        let bytes = Bytes::from_static(
            b"RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00\xff\x05\x00\x4f\x07\x00",
        );
        let mut descriptor = manifest();
        descriptor.media.byte_count = bytes.len();
        descriptor.media.sha256 = format!("{:x}", Sha256::digest(&bytes));
        let requested = Arc::new(Notify::new());
        server.state().avatar = Some(FakeAvatar {
            list: json!({"workspaceId": account.avatar_scope().workspace_id, "selectedAvatarId": "nano", "avatars": [{"id": "nano", "name": "Synthetic avatar"}]}),
            manifest: serde_json::to_value(descriptor).expect("manifest"),
            media: bytes,
            mime: "image/webp",
            refusal: None,
            stream: None,
            requested: requested.clone(),
        });
        (server, account, requested)
    }

    #[tokio::test]
    async fn http_load_authenticates_every_step_and_binds_media_to_the_manifest_hash() {
        let (server, account, _) = http_fixture().await;
        let scope = account.avatar_scope();
        let answer = account
            .load_avatar(scope.context.as_deref().expect("context"))
            .await
            .expect("load");
        assert_eq!(answer.scope, scope);
        let content = answer.avatar.expect("avatar");
        let state = server.state();
        assert_eq!(state.avatar_calls.len(), 3);
        assert!(
            state
                .avatar_calls
                .iter()
                .all(|(_, auth)| *auth == format!("Bearer {}", state.current_access))
        );
        assert!(state.avatar_calls[0].0.ends_with("/avatars"));
        assert!(state.avatar_calls[1].0.ends_with("/avatars/nano/manifest"));
        assert!(state.avatar_calls[2].0.ends_with(&format!(
            "/avatars/nano/media/atlas?sha256={}",
            content.manifest.media.sha256
        )));
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(content.media_base64)
                .expect("base64"),
            state.avatar.as_ref().expect("fixture").media
        );
        // Only structural media is served here. Actual WebP decoding belongs to WebView proof.
    }

    #[tokio::test]
    async fn http_refuses_wrong_owner_missing_selection_and_corrupt_media_without_fallback() {
        let (server, account, _) = http_fixture().await;
        let context = account.avatar_scope().context.expect("context");
        server.state().avatar.as_mut().expect("fixture").list["workspaceId"] =
            json!("wrong-workspace");
        assert!(matches!(
            account.load_avatar(&context).await,
            Err(NanoError::UnsupportedServer)
        ));
        assert_eq!(server.state().avatar_calls.len(), 1);
        {
            let mut state = server.state();
            let fixture = state.avatar.as_mut().expect("fixture");
            fixture.list["workspaceId"] = json!(account.avatar_scope().workspace_id);
            fixture.list["selectedAvatarId"] = serde_json::Value::Null;
        }
        assert!(
            account
                .load_avatar(&context)
                .await
                .expect("no selection")
                .avatar
                .is_none()
        );
        assert_eq!(server.state().avatar_calls.len(), 2);
        server.state().avatar.as_mut().expect("fixture").list["selectedAvatarId"] = json!("nano");
        server.state().avatar.as_mut().expect("fixture").mime = "text/html";
        assert!(matches!(
            account.load_avatar(&context).await,
            Err(NanoError::UnsupportedServer)
        ));
        server.state().avatar.as_mut().expect("fixture").mime = "image/webp";
        server.state().avatar.as_mut().expect("fixture").media = Bytes::from_static(b"tampered");
        assert!(matches!(
            account.load_avatar(&context).await,
            Err(NanoError::UnsupportedServer)
        ));
        assert_eq!(
            account.avatar_scope().context.as_deref(),
            Some(context.as_str())
        );
        server.state().avatar.as_mut().expect("fixture").refusal = Some((404, "invalid_request"));
        assert!(matches!(
            account.load_avatar(&context).await,
            Err(NanoError::Invalid)
        ));
        assert_eq!(
            account.avatar_scope().context.as_deref(),
            Some(context.as_str())
        );
        server.state().avatar.as_mut().expect("fixture").refusal =
            Some((403, "feature_not_in_plan"));
        assert!(account.load_avatar(&context).await.is_err());
        assert!(account.avatar_scope().context.is_none());
        assert!(
            !account
                .inner
                .lock()
                .entitlements
                .as_ref()
                .expect("plan")
                .features
                .avatars
        );
        let calls = server.state().avatar_calls.len();
        assert!(account.load_avatar(&context).await.is_err());
        assert_eq!(server.state().avatar_calls.len(), calls);
    }

    #[tokio::test]
    async fn http_workspace_authority_refusal_retires_avatar_eligibility() {
        let (server, account, _) = http_fixture().await;
        let context = account.avatar_scope().context.expect("context");
        server.state().avatar.as_mut().expect("fixture").refusal =
            Some((404, "workspace_not_found"));
        assert!(matches!(
            account.load_avatar(&context).await,
            Err(NanoError::WorkspaceNotFound)
        ));
        assert!(account.avatar_scope().context.is_none());
    }

    #[tokio::test]
    async fn old_avatar_refusal_cannot_revoke_a_new_workspace_or_account_custody() {
        let (_server, account, _) = http_fixture().await;
        let original = account.avatar_scope();
        let generation = account.generation();
        account
            .inner
            .mutate(|s| s.selected = Some("another-workspace".into()));
        account.invalidate_avatar_entitlement(&original, generation);
        assert!(
            account
                .inner
                .lock()
                .entitlements
                .as_ref()
                .expect("plan")
                .features
                .avatars
        );
        account
            .inner
            .mutate(|s| s.selected.clone_from(&original.workspace_id));
        account.invalidate_avatar_entitlement(&original, generation);
        assert!(
            account.avatar_scope().context.is_some(),
            "returning to the same workspace is new custody"
        );
        let latest = account.avatar_scope();
        account.inner.mutate(|s| s.generation += 1);
        account.invalidate_avatar_entitlement(&latest, generation);
        assert!(
            account.avatar_scope().context.is_some(),
            "a new account generation owns its rights"
        );
    }

    #[tokio::test]
    async fn custody_loss_aborts_an_actual_http_body_and_cannot_publish_old_media() {
        let (server, account, requested) = http_fixture().await;
        let (sender, receiver) = mpsc::unbounded_channel();
        server.state().avatar.as_mut().expect("fixture").stream = Some(receiver);
        let context = account.avatar_scope().context.expect("context");
        let loading = account.clone();
        let task = tokio::spawn(async move { loading.load_avatar(&context).await });
        // API_TIMEOUT is the existing account-request bound, not a new resource policy.
        tokio::time::timeout(API_TIMEOUT, async {
            while server.state().avatar_calls.len() < 3 {
                requested.notified().await;
            }
        })
        .await
        .expect("media request reached server");
        sender
            .send(Bytes::from_static(b"RIFF"))
            .expect("stream chunk");
        account
            .inner
            .mutate(|s| s.entitlements.as_mut().expect("plan").features.avatars = false);
        let result = tokio::time::timeout(API_TIMEOUT, task)
            .await
            .expect("cancelled before HTTP request deadline")
            .expect("join");
        assert!(matches!(result, Err(NanoError::FeatureUnavailable)));
        tokio::time::timeout(API_TIMEOUT, sender.closed())
            .await
            .expect("HTTP body reader disconnected");
        assert!(account.avatar_scope().context.is_none());
    }

    #[test]
    fn descriptor_requires_the_version_renderer_dimensions_and_complete_valid_clips() {
        let valid = manifest();
        valid.validate("nano").expect("valid descriptor");
        let mut bad = valid.clone();
        bad.atlas.cell_width = 96;
        assert!(bad.validate("nano").is_err());
        let mut bad = valid.clone();
        bad.clips.remove("still");
        assert!(bad.validate("nano").is_err());
        let mut bad = valid.clone();
        bad.clips.get_mut("idle").expect("idle").ms = None;
        assert!(bad.validate("nano").is_err());
        let mut bad = valid.clone();
        bad.clips
            .get_mut("wait")
            .expect("wait")
            .hold
            .as_mut()
            .expect("hold")
            .frames
            .push(8);
        assert!(bad.validate("nano").is_err());
        assert!(valid.validate("../nano").is_err());
        assert!(!valid_id("https://example.test/atlas.webp"));
    }

    #[test]
    fn media_checks_hash_count_container_and_geometry_before_ipc() {
        // Container header only: actual bitstream decoding is separately required in WebView.
        let mut bytes =
            b"RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00\xff\x05\x00\x4f\x07\x00"
                .to_vec();
        let mut descriptor = manifest();
        descriptor.media.byte_count = bytes.len();
        descriptor.media.sha256 = format!("{:x}", Sha256::digest(&bytes));
        validate_media(&descriptor, &bytes).expect("structural checks");
        bytes[20] = 2;
        assert!(validate_media(&descriptor, &bytes).is_err());
        descriptor.media.sha256 = format!("{:x}", Sha256::digest(&bytes));
        assert!(
            validate_media(&descriptor, &bytes).is_err(),
            "animated WebP is refused even with correct hash"
        );
        assert_eq!(webp_dimensions(b"bad"), None);
    }

    #[tokio::test]
    async fn signed_out_and_missing_rights_make_no_avatar_request() {
        let server = FakeNano::start().await;
        let (signed_out, _) = server.account_with_stored_token();
        assert!(signed_out.avatar_scope().context.is_none());
        let count = server.state().clients.len();
        assert!(signed_out.load_avatar("old").await.is_err());
        assert_eq!(server.state().clients.len(), count);
        let (account, _) = server.signed_in().await;
        account
            .inner
            .mutate(|s| s.entitlements.as_mut().expect("plan").features.avatars = false);
        let count = server.state().clients.len();
        assert!(account.load_avatar("old").await.is_err());
        assert_eq!(server.state().clients.len(), count);
    }

    #[tokio::test]
    async fn coalesced_workspace_changes_cancel_work_but_credit_revisions_keep_context() {
        let server = FakeNano::start().await;
        let (account, _) = server.signed_in().await;
        account.inner.mutate(|s| {
            s.capabilities.as_mut().expect("caps").avatars = true;
            s.entitlements.as_mut().expect("plan").features.avatars = true;
        });
        let scope = account.avatar_scope();
        let generation = account.generation();
        account.inner.mutate(|s| s.busy += 1);
        assert_eq!(scope.context, account.avatar_scope().context);
        let (entered, started) = tokio::sync::oneshot::channel();
        let task_account = account.clone();
        let task_scope = scope.clone();
        let task = tokio::spawn(async move {
            task_account
                .within_avatar_scope(&task_scope, generation, async {
                    let _ = entered.send(());
                    std::future::pending::<Result<(), NanoError>>().await
                })
                .await
        });
        started.await.expect("work started");
        account
            .inner
            .mutate(|s| s.selected = Some("another-workspace".into()));
        account
            .inner
            .mutate(|s| s.selected.clone_from(&scope.workspace_id));
        assert!(task.await.expect("cancelled task").is_err());
        assert_ne!(scope.context, account.avatar_scope().context);
        account.inner.mutate(|s| s.generation += 1);
        assert!(account.ensure_avatar_scope(&scope, generation).is_err());
    }
}
