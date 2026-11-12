//! One app-owned ChatGPT account and its renewable session.

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, watch};

use super::*;
use crate::fsutil::atomic_write;
use crate::status::NanoCredentialStoreV1;
use crate::store::{TokenVault, external_provider_store};

// Reserve one connection ID so the existing external-source identity and
// native history format also cover the subscription.
pub const CHATGPT_CONNECTION_ID: &str = "434841544750542d4f415554482d3031";
pub const CHATGPT_PROVIDER_ID: &str = "nano-external-434841544750542d4f415554482d3031";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptStatus {
    connected: bool,
    registered: bool,
    email: Option<String>,
    credential_store: Option<NanoCredentialStoreV1>,
    pub models: Vec<ChatGptModel>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Preferences {
    host_id: String,
    registration: Option<Registration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retry_client: Option<String>,
    connected: bool,
    #[serde(default)]
    models: Vec<ChatGptModel>,
}

struct Session {
    registration: Registration,
    vault: Arc<TokenVault>,
    access: Option<(SecretString, Instant)>,
    credential_store: NanoCredentialStoreV1,
    models: Vec<ChatGptModel>,
    alive: watch::Receiver<()>,
}

pub(crate) struct ChatGptGrant {
    pub(crate) source: Arc<ChatGptSubscription>,
    pub(crate) alive: watch::Receiver<()>,
}

pub struct ChatGptSubscription {
    path: PathBuf,
    persist: bool,
    session: AsyncMutex<Option<Session>>,
    pending: Mutex<Option<watch::Sender<()>>>,
    revoker: Mutex<Option<watch::Sender<()>>>,
}

impl ChatGptSubscription {
    pub fn new(path: PathBuf, persist: bool) -> Self {
        Self {
            path,
            persist,
            session: AsyncMutex::new(None),
            pending: Mutex::new(None),
            revoker: Mutex::new(None),
        }
    }

    pub async fn status(&self) -> Result<ChatGptStatus, ChatGptError> {
        let mut session = self.session.lock().await;
        if let Some(session) = session.as_ref() {
            return Ok(session.status());
        }
        let Some(prefs) = self.read().await? else {
            return Ok(ChatGptStatus::default());
        };
        if let Some(restored) = self.restore(&prefs).await? {
            let status = restored.status();
            *session = Some(restored);
            return Ok(status);
        }
        Ok(ChatGptStatus {
            registered: prefs.registration.is_some(),
            ..ChatGptStatus::default()
        })
    }

    pub async fn connect(&self, open: OpenBrowser) -> Result<(), ChatGptError> {
        let mut cancel = {
            let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            if pending.is_some() {
                return Err(ChatGptError::SignIn);
            }
            let (sender, receiver) = watch::channel(());
            *pending = Some(sender);
            receiver
        };
        let _pending = PendingGuard(&self.pending);
        self.connect_inner(open, &mut cancel).await
    }

    pub fn cancel(&self) {
        if let Some(pending) = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            pending.send_replace(());
        }
    }

    async fn connect_inner(
        &self,
        open: OpenBrowser,
        cancel: &mut watch::Receiver<()>,
    ) -> Result<(), ChatGptError> {
        if self.status().await?.connected {
            return Ok(());
        }
        let mut prefs = match self.read().await? {
            Some(prefs) => prefs,
            None => {
                let prefs = Preferences {
                    host_id: new_host_id()?,
                    registration: None,
                    retry_client: None,
                    connected: false,
                    models: Vec::new(),
                };
                self.write(&prefs).await?;
                prefs
            }
        };
        let http = client()?;
        let retry_prefs = prefs.clone();
        let (registration, tokens) = authorize(
            &http,
            &prefs.host_id,
            prefs.registration.as_ref(),
            prefs.retry_client.as_deref(),
            open,
            async {
                let _ = cancel.clone().changed().await;
            },
            |client_id| async move {
                let mut prefs = retry_prefs;
                prefs.retry_client = Some(client_id);
                self.write(&prefs).await
            },
        )
        .await?;
        let catalog = tokio::select! {
            biased;
            _ = cancel.changed() => Err(ChatGptError::Cancelled),
            result = models(&http, &tokens.access) => result,
        };
        let models = match catalog {
            Ok(models) => models,
            Err(error) => {
                let _ = revoke(&http, &registration.client_id, &tokens.refresh).await;
                return Err(error);
            }
        };
        let mut session = self.session.lock().await;
        if cancel.has_changed().unwrap_or(true) {
            drop(session);
            let _ = revoke(&http, &registration.client_id, &tokens.refresh).await;
            return Err(ChatGptError::Cancelled);
        }
        let vault = Arc::new(self.vault(&prefs.host_id, &registration));
        prefs.registration = Some(registration.clone());
        prefs.retry_client = None;
        prefs.connected = true;
        prefs.models = models.clone();
        let saved = async {
            let access = access_with_expiry(tokens.access, tokens.expires_in)?;
            let credential_store = save_refresh(&vault, tokens.refresh.clone()).await?;
            self.write(&prefs).await?;
            Ok((access, credential_store))
        }
        .await;
        let error = match saved {
            Ok((access, credential_store)) => {
                // Cancel and publication share this lock. Storage awaits above
                // leave cancellation available until the session is published.
                let _publication = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
                if !cancel.has_changed().unwrap_or(true) {
                    *session = Some(Session {
                        registration,
                        vault,
                        access: Some(access),
                        credential_store,
                        models,
                        alive: self.new_grant_channel(),
                    });
                    return Ok(());
                }
                ChatGptError::Cancelled
            }
            Err(error) => error,
        };
        prefs.connected = false;
        prefs.models.clear();
        let _ = self.write(&prefs).await;
        let _ = delete_refresh(&vault).await;
        drop(session);
        let _ = revoke(&http, &registration.client_id, &tokens.refresh).await;
        Err(error)
    }

    /// Ends local grants first. `false` means remote revocation could not be confirmed.
    pub async fn disconnect(&self) -> Result<bool, ChatGptError> {
        self.cancel();
        self.revoke_grants();
        let mut current = self.session.lock().await;
        self.revoke_grants();
        let mut prefs = self.read().await;
        let old = match (current.take(), &prefs) {
            (Some(old), _) => Some(old),
            (None, Ok(Some(prefs))) => self.restore(prefs).await?,
            (None, _) => return prefs.map(|_| true),
        };
        self.revoke_grants();
        let Some(old) = old else {
            return Ok(true);
        };
        let Session {
            registration,
            vault,
            ..
        } = old;
        let saved = match &mut prefs {
            Ok(Some(prefs)) => {
                prefs.connected = false;
                prefs.models.clear();
                self.write(prefs).await
            }
            Ok(None) => Ok(()),
            Err(error) => Err(*error),
        };
        let refresh = load_refresh(&vault).await;
        let deleted = delete_refresh(&vault).await;
        drop(current);
        let revoked = match refresh? {
            Some((token, _)) => Ok(match client() {
                Ok(http) => revoke(&http, &registration.client_id, &token).await,
                Err(_) => false,
            }),
            None => Ok(true),
        };
        saved?;
        deleted?;
        revoked
    }

    pub(crate) async fn grant(self: &Arc<Self>, model: &str) -> Result<ChatGptGrant, ChatGptError> {
        let mut current = self.session.lock().await;
        if current.is_none() {
            let prefs = self.read().await?.ok_or(ChatGptError::Reauthenticate)?;
            *current = self.restore(&prefs).await?;
        }
        let active = current.as_ref().ok_or(ChatGptError::Reauthenticate)?;
        if !active.models.iter().any(|entry| entry.id == model) {
            return Err(ChatGptError::NoPlanPermission);
        }
        Ok(ChatGptGrant {
            source: self.clone(),
            alive: active.alive.clone(),
        })
    }

    pub(crate) async fn access(
        &self,
        grant: &watch::Receiver<()>,
        model: &str,
    ) -> Result<SecretString, ChatGptError> {
        let mut current = self.session.lock().await;
        let active = current
            .as_mut()
            .filter(|active| active.alive.same_channel(grant) && grant.has_changed().is_ok())
            .ok_or(ChatGptError::Reauthenticate)?;
        if let Some((token, expires)) = &active.access
            && *expires > Instant::now()
        {
            return active
                .models
                .iter()
                .any(|entry| entry.id == model)
                .then(|| token.clone())
                .ok_or(ChatGptError::NoPlanPermission);
        }
        let (prior, _) = load_refresh(&active.vault)
            .await?
            .ok_or(ChatGptError::Reauthenticate)?;
        if grant.has_changed().is_err() {
            return Err(ChatGptError::Reauthenticate);
        }
        let http = client()?;
        let tokens = match refresh(&http, &active.registration, &prior).await {
            Ok(tokens) => tokens,
            Err(error @ (ChatGptError::Reauthenticate | ChatGptError::NoPlanPermission)) => {
                let vault = active.vault.clone();
                self.revoke_grants();
                *current = None;
                let _ = delete_refresh(&vault).await;
                if let Ok(Some(mut prefs)) = self.read().await {
                    prefs.connected = false;
                    prefs.models.clear();
                    let _ = self.write(&prefs).await;
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        // A refresh rotates its credential even if catalog retrieval later fails.
        active.credential_store = save_refresh(&active.vault, tokens.refresh.clone()).await?;
        let mut connected = grant.clone();
        let models = tokio::select! {
            biased;
            _ = connected.changed() => return Err(ChatGptError::Reauthenticate),
            models = models(&http, &tokens.access) => models?,
        };
        let entitled = models.iter().any(|entry| entry.id == model);
        active.models = models;
        if let Some(mut prefs) = self.read().await? {
            prefs.models = active.models.clone();
            self.write(&prefs).await?;
        }
        let access = tokens.access.clone();
        active.access = Some(access_with_expiry(tokens.access, tokens.expires_in)?);
        entitled
            .then_some(access)
            .ok_or(ChatGptError::NoPlanPermission)
    }

    async fn restore(&self, prefs: &Preferences) -> Result<Option<Session>, ChatGptError> {
        let Some(registration) = prefs.registration.as_ref().filter(|_| prefs.connected) else {
            return Ok(None);
        };
        let vault = Arc::new(self.vault(&prefs.host_id, registration));
        let Some((_, credential_store)) = load_refresh(&vault).await? else {
            return Ok(None);
        };
        Ok(Some(Session {
            registration: registration.clone(),
            vault,
            access: None,
            models: prefs.models.clone(),
            credential_store,
            alive: self.new_grant_channel(),
        }))
    }

    fn vault(&self, host: &str, registration: &Registration) -> TokenVault {
        let mut scope = Sha256::new();
        scope.update(host);
        scope.update([0]);
        scope.update(&registration.client_id);
        scope.update([0]);
        scope.update(&registration.subject);
        let id = format!("chatgpt:{:x}", scope.finalize());
        TokenVault::new(self.persist.then(|| external_provider_store(&id)).flatten())
    }

    async fn read(&self) -> Result<Option<Preferences>, ChatGptError> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || match fs::read(path) {
            Ok(bytes) => {
                let prefs: Preferences =
                    serde_json::from_slice(&bytes).map_err(|_| ChatGptError::Storage)?;
                if !prefs.host_id.starts_with("urn:uuid:")
                    || prefs
                        .retry_client
                        .as_deref()
                        .is_some_and(|id| !valid_client_id(id))
                    || prefs
                        .registration
                        .as_ref()
                        .is_some_and(|r| !valid_client_id(&r.client_id) || r.subject.is_empty())
                {
                    return Err(ChatGptError::Storage);
                }
                Ok(Some(prefs))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(_) => Err(ChatGptError::Storage),
        })
        .await
        .map_err(|_| ChatGptError::Storage)?
    }

    async fn write(&self, prefs: &Preferences) -> Result<(), ChatGptError> {
        let path = self.path.clone();
        let bytes = serde_json::to_vec_pretty(prefs).map_err(|_| ChatGptError::Storage)?;
        tokio::task::spawn_blocking(move || atomic_write(&path, &bytes))
            .await
            .map_err(|_| ChatGptError::Storage)?
            .map_err(|_| ChatGptError::Storage)
    }

    fn new_grant_channel(&self) -> watch::Receiver<()> {
        let (sender, receiver) = watch::channel(());
        *self.revoker.lock().unwrap_or_else(PoisonError::into_inner) = Some(sender);
        receiver
    }

    fn revoke_grants(&self) {
        self.revoker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

impl ChatGptGrant {
    pub(crate) async fn access(&self, model: &str) -> Result<SecretString, ChatGptError> {
        // A Pi session can end during refresh. Once started, finish rotating
        // the credential for the connected account independently of that lease.
        let source = self.source.clone();
        let alive = self.alive.clone();
        let model = model.to_owned();
        tokio::spawn(async move { source.access(&alive, &model).await })
            .await
            .map_err(|_| ChatGptError::Offline)?
    }

    pub(crate) fn reject_access(&self, key: &SecretString) {
        if let Ok(mut current) = self.source.session.try_lock()
            && let Some(active) = current.as_mut()
            && active.alive.same_channel(&self.alive)
            && active.access.as_ref().is_some_and(|(used, _)| used == key)
        {
            // Refresh on the next user request, without replaying this turn.
            active.access = None;
        }
    }
}

impl Session {
    fn status(&self) -> ChatGptStatus {
        ChatGptStatus {
            connected: true,
            registered: true,
            email: self.registration.email.clone(),
            credential_store: Some(self.credential_store),
            models: self.models.clone(),
        }
    }
}

#[cfg(test)]
impl ChatGptSubscription {
    pub(crate) async fn set_test_session(&self, model: &str, token: SecretString) {
        *self.session.lock().await = Some(Session {
            registration: Registration {
                client_id: "oaiapp_fixture".to_owned(),
                subject: "synthetic-account".to_owned(),
                email: None,
            },
            vault: Arc::new(TokenVault::new(None)),
            access: Some((token, Instant::now() + API_TIMEOUT)),
            credential_store: NanoCredentialStoreV1::Memory,
            models: vec![ChatGptModel {
                id: model.to_owned(),
                name: model.to_owned(),
            }],
            alive: self.new_grant_channel(),
        });
    }
}

struct PendingGuard<'a>(&'a Mutex<Option<watch::Sender<()>>>);

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take();
    }
}

async fn save_refresh(
    vault: &Arc<TokenVault>,
    token: SecretString,
) -> Result<NanoCredentialStoreV1, ChatGptError> {
    let vault = vault.clone();
    tokio::task::spawn_blocking(move || vault.save(&token))
        .await
        .map_err(|_| ChatGptError::CredentialStore)
}

async fn load_refresh(
    vault: &Arc<TokenVault>,
) -> Result<Option<(SecretString, NanoCredentialStoreV1)>, ChatGptError> {
    let vault = vault.clone();
    tokio::task::spawn_blocking(move || vault.load())
        .await
        .map_err(|_| ChatGptError::CredentialStore)?
        .map_err(|_| ChatGptError::CredentialStore)
}

async fn delete_refresh(vault: &Arc<TokenVault>) -> Result<(), ChatGptError> {
    let vault = vault.clone();
    tokio::task::spawn_blocking(move || vault.delete())
        .await
        .map_err(|_| ChatGptError::CredentialStore)?
        .map_err(|_| ChatGptError::CredentialStore)
}

fn access_with_expiry(
    token: SecretString,
    expires_in: Duration,
) -> Result<(SecretString, Instant), ChatGptError> {
    let usable = expires_in.saturating_sub(API_TIMEOUT.min(expires_in / 2));
    let expiry = Instant::now()
        .checked_add(usable)
        .ok_or(ChatGptError::SignIn)?;
    Ok((token, expiry))
}
