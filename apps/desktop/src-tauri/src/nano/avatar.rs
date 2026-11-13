//! Avatar IPC v1. Only the main app command allowlist can reach these commands.
use std::sync::Arc;

use piui_nano::account::avatar::{NanoAvatarAnswerV1, NanoAvatarScopeV1};
use serde::Deserialize;
use tauri::State;

use super::{NanoHost, commands::NanoCommandError};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NanoAvatarRequestV1 {
    /// Opaque, non-secret custody identity previously returned by the host.
    context: String,
}

impl NanoHost {
    pub(crate) fn avatar_scope(&self) -> NanoAvatarScopeV1 {
        match self.live_account() {
            Ok(account) => account.avatar_scope(),
            Err(_) => NanoAvatarScopeV1 {
                protocol: 1,
                revision: self.status().revision,
                context: None,
                workspace_id: None,
            },
        }
    }
}

#[tauri::command]
pub fn nano_avatar_scope_v1(host: State<'_, Arc<NanoHost>>) -> NanoAvatarScopeV1 {
    host.avatar_scope()
}

#[tauri::command]
pub async fn nano_avatar_load_v1(
    host: State<'_, Arc<NanoHost>>,
    request: NanoAvatarRequestV1,
) -> Result<NanoAvatarAnswerV1, NanoCommandError> {
    Ok(host.live_account()?.load_avatar(&request.context).await?)
}
