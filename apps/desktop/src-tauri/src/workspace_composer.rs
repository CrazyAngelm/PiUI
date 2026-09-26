//! Durable user-message outbox. Native harnesses still own every model turn.
use super::attachments::{AttachmentStore, MAX_ATTACHMENTS_PER_MESSAGE, StoredImage};
use super::*;
use base64::Engine as _;
use piui_runtime::workspace_runtime::{
    BridgeFailureCode, ComposerCapabilities, NativeRuntimeError, PromptImage,
};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueState {
    #[serde(default)]
    pub revision: u64,
    pub paused: bool,
    pub items: Vec<QueuedMessage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    pub status: Delivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Additive within v19: images whose bytes stay in PiUI's app data until
    /// this message is delivered or removed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) attachments: Vec<StoredImage>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    Queued,
    Sending,
    Uncertain,
    Sent,
    Cancelled,
}

impl QueueState {
    fn pending(&self) -> bool {
        self.items.iter().any(|item| {
            matches!(
                item.status,
                Delivery::Queued | Delivery::Sending | Delivery::Uncertain
            )
        })
    }
    fn recover(&mut self) {
        if self.pending() {
            self.paused = true;
        }
        for item in &mut self.items {
            if item.status == Delivery::Sending {
                item.status = Delivery::Uncertain;
            }
        }
    }
    /// Ids of the images that undelivered messages still need.
    pub(crate) fn referenced_images(&self) -> impl Iterator<Item = &str> {
        self.items
            .iter()
            .filter(|item| {
                matches!(
                    item.status,
                    Delivery::Queued | Delivery::Sending | Delivery::Uncertain
                )
            })
            .flat_map(|item| item.attachments.iter().map(|image| image.id.as_str()))
    }
    fn contains(&self, id: &str) -> bool {
        self.items.iter().any(|item| item.id == id)
    }
    fn enqueue(&mut self, id: String, text: String, attachments: Vec<StoredImage>) {
        // IDs are retained after delivery, including across reload/restart.
        if !self.contains(&id) {
            self.items.push(QueuedMessage {
                id,
                text,
                status: Delivery::Queued,
                error: None,
                attachments,
            });
        }
    }
    fn edit(&mut self, id: &str, text: String) -> Result<(), WorkspaceError> {
        let item = self
            .items
            .iter_mut()
            .find(|item| item.id == id && item.status == Delivery::Queued)
            .ok_or_else(WorkspaceError::conflict)?;
        item.text = text;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ComposerCommand {
    Snapshot {
        session_id: String,
    },
    Send {
        session_id: String,
        request_id: String,
        text: String,
        mode: PromptMode,
        /// Additive within v19: pending image ids (composer inputs v1).
        #[serde(default)]
        attachments: Vec<String>,
    },
    Edit {
        session_id: String,
        request_id: String,
        text: String,
    },
    Promote {
        session_id: String,
        request_id: String,
    },
    Remove {
        session_id: String,
        request_id: String,
    },
    Resume {
        session_id: String,
    },
    Compact {
        session_id: String,
    },
}
impl ComposerCommand {
    fn session_id(&self) -> &str {
        match self {
            Self::Snapshot { session_id }
            | Self::Send { session_id, .. }
            | Self::Edit { session_id, .. }
            | Self::Promote { session_id, .. }
            | Self::Remove { session_id, .. }
            | Self::Resume { session_id }
            | Self::Compact { session_id } => session_id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSnapshot {
    protocol: u8,
    session_id: String,
    capabilities: ComposerCapabilities,
    queue: QueueState,
}

fn operation_error(code: &'static str, message: &'static str) -> WorkspaceError {
    WorkspaceError {
        code,
        message,
        recoverable: true,
    }
}
fn images_unsupported() -> WorkspaceError {
    operation_error(
        "IMAGES_UNSUPPORTED",
        "This harness or its current model does not accept images.",
    )
}
fn attachment_unavailable() -> WorkspaceError {
    operation_error(
        "ATTACHMENT_UNAVAILABLE",
        "An attached image is no longer available. Attach it again.",
    )
}
fn native_error(error: NativeRuntimeError) -> WorkspaceError {
    match error {
        NativeRuntimeError::Bridge(BridgeFailureCode::TurnActive) => {
            operation_error("TURN_ACTIVE", "Wait for the current turn.")
        }
        NativeRuntimeError::Bridge(BridgeFailureCode::NoActiveTurn) => {
            operation_error("NO_ACTIVE_TURN", "There is no active turn to steer.")
        }
        NativeRuntimeError::Bridge(BridgeFailureCode::UnsupportedMethod) => {
            WorkspaceError::not_supported()
        }
        NativeRuntimeError::Bridge(BridgeFailureCode::UnsupportedInput) => images_unsupported(),
        _ => WorkspaceError::runtime(),
    }
}
fn delivery_error(error: &NativeRuntimeError) -> &'static str {
    match error {
        NativeRuntimeError::Bridge(BridgeFailureCode::NoActiveTurn) => {
            "The turn finished before Steer was accepted. Your message is still queued."
        }
        NativeRuntimeError::Bridge(BridgeFailureCode::TurnActive) => {
            "The harness is still busy. Your message is still queued."
        }
        NativeRuntimeError::Bridge(BridgeFailureCode::UnsupportedMethod) => {
            "This harness does not support the requested operation. Your message is still queued."
        }
        NativeRuntimeError::Bridge(BridgeFailureCode::UnsupportedInput) => IMAGES_REFUSED,
        error if rejected(error) => {
            "The harness declined the message. Edit it or resume the queue to try again."
        }
        _ => {
            "Delivery could not be confirmed. Check native history before dismissing this message."
        }
    }
}
/// Outbox text of a message whose images the session can no longer accept.
const IMAGES_REFUSED: &str = "The harness or its current model does not accept images. Your message is still queued; remove it or switch to a model that accepts images.";
/// Outbox text of a message whose stored image bytes are gone.
const IMAGE_MISSING: &str =
    "An attached image is no longer available. Remove this message and attach the image again.";
fn rejected(error: &NativeRuntimeError) -> bool {
    matches!(
        error,
        NativeRuntimeError::Bridge(
            BridgeFailureCode::TurnActive
                | BridgeFailureCode::NoActiveTurn
                | BridgeFailureCode::UnsupportedMethod
                | BridgeFailureCode::UnsupportedInput
                | BridgeFailureCode::InvalidRequest
                | BridgeFailureCode::NativeCommandRejected
        )
    )
}

/// Validates attachment ids before any state changes.
fn validate_attachment_ids(ids: &[String]) -> Result<(), WorkspaceError> {
    if ids.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(WorkspaceError::invalid());
    }
    for id in ids {
        validate_session_id(id)?;
    }
    Ok(())
}

impl WorkspaceHost {
    fn change_queue<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut QueueState) -> Result<T, WorkspaceError>,
    ) -> Result<T, WorkspaceError> {
        let mut registry = lock(&self.inner.registry)?;
        let mut record = registry.session(id).ok_or_else(WorkspaceError::not_found)?;
        let result = change(&mut record.composer)?;
        record.composer.revision = record
            .composer
            .revision
            .checked_add(1)
            .ok_or_else(WorkspaceError::conflict)?;
        registry
            .save_composer(id, record.composer)
            .map_err(|_| WorkspaceError::io())?;
        drop(registry);
        self.notify_composer(id);
        Ok(result)
    }

    pub(super) fn recover_queues(&self) -> Result<(), std::io::Error> {
        let mut registry = self
            .inner
            .registry
            .lock()
            .map_err(|_| std::io::Error::other("registry poisoned"))?;
        let records = registry.sessions().to_vec();
        for mut record in records {
            if !record.composer.pending() {
                continue;
            }
            record.composer.recover();
            record.composer.revision = record
                .composer
                .revision
                .checked_add(1)
                .ok_or_else(|| std::io::Error::other("outbox revision exhausted"))?;
            registry.save_composer(&record.id, record.composer)?;
        }
        // Pending images of unsent drafts do not survive a restart; images of
        // undelivered queued messages stay until those messages settle.
        let referenced = registry
            .sessions()
            .iter()
            .flat_map(|record| record.composer.referenced_images().map(str::to_owned))
            .collect();
        drop(registry);
        self.inner.attachments.retain_only(&referenced)
    }

    fn notify_composer(&self, id: &str) {
        if let Ok(Some((_, state))) = self.live_runtime(id)
            && let Ok(notify) = state.composer_notify.lock()
            && let Some(notify) = notify.as_ref()
        {
            notify();
        }
    }

    pub(super) fn pause_queue(&self, id: &str) {
        if let Ok(Some((_, state))) = self.live_runtime(id) {
            state.composer_paused.store(true, Ordering::Release);
        }
        if self
            .record(id)
            .is_ok_and(|record| record.composer.pending())
        {
            let _ = self.change_queue(id, |queue| {
                queue.paused = true;
                Ok(())
            });
        }
    }

    pub(super) fn drain_queue(&self, id: &str) {
        let host = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            if host.drain(&id).await.is_err() {
                host.pause_queue(&id);
            }
        });
    }

    /// Enqueues one message. Its images must be pending in the attachment
    /// store; they move to the message only if the queue change is saved. A
    /// retried request id is accepted once without claiming anything again.
    pub(super) fn enqueue_message(
        &self,
        id: &str,
        request_id: String,
        text: String,
        attachments: &[String],
    ) -> Result<(), WorkspaceError> {
        validate_attachment_ids(attachments)?;
        if self.record(id)?.composer.contains(&request_id) {
            return Ok(());
        }
        self.inner
            .attachments
            .claim_with(attachments, attachment_unavailable(), |images| {
                self.change_queue(id, |queue| {
                    queue.enqueue(request_id, text, images);
                    Ok(())
                })
            })
    }

    /// Native image input for a queued message, or the outbox text that
    /// explains why the message cannot be delivered as it is.
    async fn prompt_images(
        runtime: &NativeRuntime,
        store: &AttachmentStore,
        images: &[StoredImage],
    ) -> Result<Vec<PromptImage>, &'static str> {
        if images.is_empty() {
            return Ok(Vec::new());
        }
        // The model may have changed since the message was queued.
        let capabilities = runtime
            .composer_capabilities()
            .await
            .map_err(|_| IMAGES_REFUSED)?;
        if !capabilities.images {
            return Err(IMAGES_REFUSED);
        }
        images
            .iter()
            .map(|image| {
                store
                    .read(image)
                    .map(|bytes| PromptImage {
                        mime_type: image.mime_type.mime_type().to_owned(),
                        data: base64::engine::general_purpose::STANDARD.encode(bytes),
                    })
                    .map_err(|_| IMAGE_MISSING)
            })
            .collect()
    }

    /// Settles a message after its native prompt: delivered messages lose
    /// their text and image bytes; refused ones stay queued and pause.
    fn settle_message(
        &self,
        id: &str,
        request_id: &str,
        result: &Result<(), NativeRuntimeError>,
    ) -> Result<(), WorkspaceError> {
        let delivered = self.change_queue(id, |queue| {
            let current = queue
                .items
                .iter_mut()
                .find(|current| current.id == request_id)
                .ok_or_else(WorkspaceError::conflict)?;
            match result {
                Ok(()) => {
                    current.status = Delivery::Sent;
                    current.text.clear();
                    Ok(std::mem::take(&mut current.attachments))
                }
                Err(error) => {
                    current.status = if rejected(error) {
                        Delivery::Queued
                    } else {
                        Delivery::Uncertain
                    };
                    current.error = Some(delivery_error(error).into());
                    queue.paused = true;
                    Ok(Vec::new())
                }
            }
        })?;
        self.inner.attachments.remove(&delivered);
        Ok(())
    }

    /// Returns a message to the queue without sending it.
    fn hold_message(
        &self,
        id: &str,
        request_id: &str,
        reason: &'static str,
    ) -> Result<(), WorkspaceError> {
        self.change_queue(id, |queue| {
            let current = queue
                .items
                .iter_mut()
                .find(|current| current.id == request_id)
                .ok_or_else(WorkspaceError::conflict)?;
            current.status = Delivery::Queued;
            current.error = Some(reason.into());
            queue.paused = true;
            Ok(())
        })
    }

    async fn drain(&self, id: &str) -> Result<(), WorkspaceError> {
        let Some((runtime, state)) = self.live_runtime(id)? else {
            return Ok(());
        };
        let _admission = state.composer_gate.lock().await;
        loop {
            // A closed/replaced runtime never receives a delayed message.
            if !self
                .live_runtime(id)?
                .is_some_and(|(current, _)| Arc::ptr_eq(&current, &runtime))
            {
                return Ok(());
            }
            let queue = self.record(id)?.composer;
            if state.composer_paused.load(Ordering::Acquire)
                || queue.paused
                || queue
                    .items
                    .iter()
                    .any(|item| matches!(item.status, Delivery::Sending | Delivery::Uncertain))
            {
                return Ok(());
            }
            let Some(item) = queue
                .items
                .iter()
                .find(|item| item.status == Delivery::Queued)
                .cloned()
            else {
                return Ok(());
            };
            let native = runtime.snapshot().await.map_err(native_error)?;
            if native.status != SessionStatus::Idle {
                return Ok(());
            }
            let generation = state.turns.borrow().generation;
            if lock(&state.composer_waiting)?.is_some_and(|before| generation <= before) {
                return Ok(());
            }
            let (text, attachments) = self.change_queue(id, |queue| {
                if queue.paused {
                    return Err(WorkspaceError::conflict());
                }
                let current = queue
                    .items
                    .iter_mut()
                    .find(|current| current.id == item.id && current.status == Delivery::Queued)
                    .ok_or_else(WorkspaceError::conflict)?;
                current.status = Delivery::Sending;
                current.error = None;
                Ok((current.text.clone(), current.attachments.clone()))
            })?;
            let images =
                match Self::prompt_images(&runtime, &self.inner.attachments, &attachments).await {
                    Ok(images) => images,
                    Err(reason) => {
                        // Nothing was sent: the message waits for the user.
                        self.hold_message(id, &item.id, reason)?;
                        return Ok(());
                    }
                };
            *lock(&state.composer_waiting)? = Some(generation);
            let result = runtime
                .prompt_with_images(text, PromptMode::Prompt, images)
                .await;
            self.settle_message(id, &item.id, &result)?;
            if let Err(error) = result {
                *lock(&state.composer_waiting)? = None;
                return Err(native_error(error));
            }
            // Loop only after a verified terminal event. This also handles a
            // completion that arrived before the native acceptance response.
        }
    }
}

#[tauri::command]
pub async fn workspace_composer_v19(
    app: AppHandle,
    state: State<'_, HostState>,
    command: ComposerCommand,
) -> Result<ComposerSnapshot, WorkspaceError> {
    run_composer(state.inner(), command, move |id| {
        let _ = app.emit("piui://composer-v19", id);
    })
    .await
}

/// The composer command without the Tauri boundary; `notify` receives the
/// opaque session id of every outbox change.
pub(crate) async fn run_composer(
    host: &HostState,
    command: ComposerCommand,
    notify: impl Fn(&str) + Send + Sync + 'static,
) -> Result<ComposerSnapshot, WorkspaceError> {
    if host.safe_mode {
        return Err(WorkspaceError::safe_mode());
    }
    let id = command.session_id().to_owned();
    validate_session_id(&id)?;
    let _operation = authorize_live_session(host, &id).await?;
    if host.workspace.record(&id)?.run_id.is_some() {
        return Err(WorkspaceError::not_supported());
    }
    let (runtime, live) = host
        .workspace
        .live_runtime(&id)?
        .ok_or_else(WorkspaceError::closed)?;
    let notify_id = id.clone();
    *lock(&live.composer_notify)? = Some(Arc::new(move || notify(&notify_id)));
    let capabilities = runtime
        .composer_capabilities()
        .await
        .map_err(native_error)?;
    match command {
        ComposerCommand::Snapshot { .. } => {}
        ComposerCommand::Send {
            request_id,
            text,
            mode,
            attachments,
            ..
        } => {
            validate_session_id(&request_id)?;
            validate_text(&text)?;
            validate_attachment_ids(&attachments)?;
            // Images the session cannot take are refused before anything is
            // queued; they are never dropped from the message.
            if !attachments.is_empty() && !capabilities.images {
                return Err(images_unsupported());
            }
            if mode == PromptMode::Steer {
                steer(
                    &host.workspace,
                    &id,
                    &runtime,
                    &live,
                    &capabilities,
                    request_id,
                    Some((text, attachments)),
                )
                .await?;
            } else {
                host.workspace
                    .enqueue_message(&id, request_id, text, &attachments)?;
                if !host.workspace.record(&id)?.composer.paused {
                    live.composer_paused.store(false, Ordering::Release);
                }
                host.workspace.drain_queue(&id);
            }
        }
        ComposerCommand::Edit {
            request_id, text, ..
        } => {
            validate_text(&text)?;
            host.workspace
                .change_queue(&id, |queue| queue.edit(&request_id, text))?;
        }
        ComposerCommand::Promote { request_id, .. } => {
            steer(
                &host.workspace,
                &id,
                &runtime,
                &live,
                &capabilities,
                request_id,
                None,
            )
            .await?;
        }
        ComposerCommand::Remove { request_id, .. } => {
            let removed = host.workspace.change_queue(&id, |queue| {
                let item = queue
                    .items
                    .iter_mut()
                    .find(|item| {
                        item.id == request_id
                            && matches!(item.status, Delivery::Queued | Delivery::Uncertain)
                    })
                    .ok_or_else(WorkspaceError::conflict)?;
                item.status = Delivery::Cancelled;
                item.text.clear();
                Ok(std::mem::take(&mut item.attachments))
            })?;
            host.workspace.inner.attachments.remove(&removed);
        }
        ComposerCommand::Resume { .. } => {
            host.workspace.change_queue(&id, |queue| {
                if queue
                    .items
                    .iter()
                    .any(|item| matches!(item.status, Delivery::Sending | Delivery::Uncertain))
                {
                    return Err(operation_error(
                        "DELIVERY_UNCERTAIN",
                        "Check native history before dismissing the uncertain message.",
                    ));
                }
                queue.paused = false;
                Ok(())
            })?;
            live.composer_paused.store(false, Ordering::Release);
            host.workspace.drain_queue(&id);
        }
        ComposerCommand::Compact { .. } => {
            if !capabilities.compact {
                return Err(WorkspaceError::not_supported());
            }
            let _admission = live.composer_gate.lock().await;
            if host.workspace.record(&id)?.composer.pending() {
                return Err(operation_error(
                    "QUEUE_PENDING",
                    "Resolve queued messages before compacting.",
                ));
            }
            runtime.compact().await.map_err(native_error)?;
        }
    }
    let mut queue = host.workspace.record(&id)?.composer;
    queue
        .items
        .retain(|item| !matches!(item.status, Delivery::Sent | Delivery::Cancelled));
    Ok(ComposerSnapshot {
        protocol: 19,
        session_id: id,
        capabilities,
        queue,
    })
}

async fn steer(
    host: &WorkspaceHost,
    id: &str,
    runtime: &Arc<NativeRuntime>,
    live: &Arc<LiveState>,
    capabilities: &ComposerCapabilities,
    request_id: String,
    message: Option<(String, Vec<String>)>,
) -> Result<(), WorkspaceError> {
    if !capabilities.steer {
        return Err(WorkspaceError::not_supported());
    }
    let _admission = live.composer_gate.lock().await;
    let queue = host.record(id)?.composer;
    if queue.items.iter().any(|item| {
        item.id == request_id
            && matches!(
                item.status,
                Delivery::Sent | Delivery::Cancelled | Delivery::Uncertain
            )
    }) {
        return Ok(());
    }
    if runtime.snapshot().await.map_err(native_error)?.status != SessionStatus::Running {
        return Err(operation_error(
            "NO_ACTIVE_TURN",
            "There is no active turn to steer.",
        ));
    }
    if let Some((text, attachments)) = message {
        host.enqueue_message(id, request_id.clone(), text, &attachments)?;
    }
    let (body, attachments) = host.change_queue(id, |queue| {
        let item = queue
            .items
            .iter_mut()
            .find(|item| item.id == request_id && item.status == Delivery::Queued)
            .ok_or_else(WorkspaceError::conflict)?;
        item.status = Delivery::Sending;
        item.error = None;
        Ok((item.text.clone(), item.attachments.clone()))
    })?;
    let images =
        match WorkspaceHost::prompt_images(runtime, &host.inner.attachments, &attachments).await {
            Ok(images) => images,
            Err(reason) => {
                host.hold_message(id, &request_id, reason)?;
                return Ok(());
            }
        };
    let result = runtime
        .prompt_with_images(body, PromptMode::Steer, images)
        .await;
    host.settle_message(id, &request_id, &result)?;
    // Once stored, failed delivery stays visible in the outbox. Returning it
    // avoids leaving a second editable copy in the composer after an ACK loss.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(id: &str) -> StoredImage {
        StoredImage {
            id: id.into(),
            name: "shot.png".into(),
            mime_type: crate::workspace_api::attachments::ImageType::Png,
            size: 8,
        }
    }

    #[test]
    fn queued_edits_keep_identity_and_admitted_messages_cannot_be_edited() {
        let mut queue = QueueState::default();
        queue.enqueue("one".into(), "initial".into(), Vec::new());
        queue.enqueue("two".into(), "next".into(), Vec::new());
        queue.edit("one", "edited".into()).expect("queued edit");
        queue.enqueue("one".into(), "retry of original request".into(), Vec::new());
        assert_eq!(queue.items.len(), 2);
        assert_eq!(queue.items[0].text, "edited");
        queue.items[0].status = Delivery::Sending;
        assert_eq!(
            queue
                .edit("one", "too late".into())
                .expect_err("admitted")
                .code,
            "CONFLICT"
        );
        assert_eq!(queue.items[0].text, "edited");
        queue.items[0].status = Delivery::Sent;
        queue.items[0].text.clear();
        let bytes = serde_json::to_vec(&queue).expect("serialize");
        let mut restored: QueueState = serde_json::from_slice(&bytes).expect("reload");
        restored.enqueue("one".into(), "replayed".into(), Vec::new());
        assert_eq!(restored.items.len(), 2);
        assert_eq!(restored.items[0].status, Delivery::Sent);
        assert_eq!(restored.items[1].id, "two");
    }

    #[test]
    fn recovery_preserves_unknown_delivery_without_replaying_it() {
        let mut queue = QueueState::default();
        queue.enqueue("admitted".into(), "unknown result".into(), Vec::new());
        queue.items[0].status = Delivery::Sending;
        queue.enqueue("waiting".into(), "later".into(), Vec::new());
        queue.recover();
        assert!(queue.paused);
        assert_eq!(queue.items[0].status, Delivery::Uncertain);
        assert_eq!(queue.items[0].text, "unknown result");
        assert_eq!(queue.items[1].status, Delivery::Queued);
    }

    #[test]
    fn composer_contract_is_strict_and_does_not_accept_native_paths() {
        let value = serde_json::json!({"type":"send","sessionId":"s","requestId":"r","text":"hello","mode":"follow-up"});
        assert!(serde_json::from_value::<ComposerCommand>(value.clone()).is_ok());
        let mut forged = value;
        forged["nativePath"] = "private".into();
        assert!(serde_json::from_value::<ComposerCommand>(forged).is_err());
        assert!(
            serde_json::from_value::<ComposerCommand>(
                serde_json::json!({"type":"compact","sessionId":"s","text":"/compact"})
            )
            .is_err()
        );
    }

    #[test]
    fn attachments_are_additive_and_carry_ids_only() {
        let with = serde_json::json!({"type":"send","sessionId":"s","requestId":"r","text":"look","mode":"prompt","attachments":["a"]});
        let Ok(ComposerCommand::Send { attachments, .. }) =
            serde_json::from_value::<ComposerCommand>(with)
        else {
            panic!("a send with attachments parses");
        };
        assert_eq!(attachments, ["a"]);
        let Ok(ComposerCommand::Send { attachments, .. }) = serde_json::from_value::<ComposerCommand>(
            serde_json::json!({"type":"send","sessionId":"s","requestId":"r","text":"look","mode":"prompt"}),
        ) else {
            panic!("a v19 send without attachments still parses");
        };
        assert!(attachments.is_empty());
        assert!(
            serde_json::from_value::<ComposerCommand>(serde_json::json!({
                "type":"send","sessionId":"s","requestId":"r","text":"look","mode":"prompt",
                "attachments":[{"path":"C:/secret.png"}]
            }))
            .is_err(),
            "a path is never an attachment"
        );
        assert!(
            validate_attachment_ids(&vec![uuid::Uuid::new_v4().to_string(); 7]).is_err(),
            "at most six images per message"
        );
        assert!(validate_attachment_ids(&["../escape".into()]).is_err());
    }

    #[test]
    fn queue_files_without_attachments_keep_their_exact_shape() {
        let mut queue = QueueState::default();
        queue.enqueue("plain".into(), "hello".into(), Vec::new());
        queue.enqueue("picture".into(), "look".into(), vec![image("image-1")]);
        let value = serde_json::to_value(&queue).expect("serialize");
        assert_eq!(
            value["items"][0],
            serde_json::json!({"id":"plain","text":"hello","status":"queued"})
        );
        assert_eq!(
            value["items"][1]["attachments"],
            serde_json::json!([{"id":"image-1","name":"shot.png","mimeType":"image/png","size":8}])
        );
        let restored: QueueState = serde_json::from_value(value).expect("reload");
        assert_eq!(
            restored.referenced_images().collect::<Vec<_>>(),
            ["image-1"]
        );
        let older: QueueState = serde_json::from_value(serde_json::json!({
            "revision": 3, "paused": false, "items": [{"id":"old","text":"hi","status":"queued"}]
        }))
        .expect("a v19 queue file from before attachments");
        assert!(older.items[0].attachments.is_empty());
    }

    #[test]
    fn delivered_or_cancelled_messages_release_their_images() {
        let mut queue = QueueState::default();
        queue.enqueue("sent".into(), "a".into(), vec![image("image-1")]);
        queue.enqueue("waiting".into(), "b".into(), vec![image("image-2")]);
        queue.enqueue("unknown".into(), "c".into(), vec![image("image-3")]);
        queue.items[0].status = Delivery::Sent;
        queue.items[2].status = Delivery::Uncertain;
        assert_eq!(
            queue.referenced_images().collect::<Vec<_>>(),
            ["image-2", "image-3"]
        );
    }

    #[test]
    fn the_golden_composer_snapshot_keeps_its_shape() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/fixtures/workspace-composer-inputs-v1.json"
        ))
        .expect("fixture");
        let expected = fixture["composer"]["snapshot"].clone();
        let snapshot = ComposerSnapshot {
            protocol: 19,
            session_id: expected["sessionId"].as_str().expect("session id").into(),
            capabilities: serde_json::from_value(expected["capabilities"].clone())
                .expect("capabilities"),
            queue: serde_json::from_value(expected["queue"].clone()).expect("queue"),
        };
        assert_eq!(serde_json::to_value(&snapshot).expect("json"), expected);
    }

    #[test]
    fn refused_images_keep_the_message_queued() {
        let refused = NativeRuntimeError::Bridge(BridgeFailureCode::UnsupportedInput);
        assert!(rejected(&refused));
        assert_eq!(delivery_error(&refused), IMAGES_REFUSED);
        assert_eq!(native_error(refused).code, "IMAGES_UNSUPPORTED");
    }
}
