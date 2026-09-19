//! Durable user-message outbox. Native harnesses still own every model turn.
use super::*;
use piui_runtime::workspace_runtime::{
    BridgeFailureCode, ComposerCapabilities, NativeRuntimeError,
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
    fn enqueue(&mut self, id: String, text: String) {
        // IDs are retained after delivery, including across reload/restart.
        if !self.items.iter().any(|item| item.id == id) {
            self.items.push(QueuedMessage {
                id,
                text,
                status: Delivery::Queued,
                error: None,
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

#[derive(Serialize)]
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
        error if rejected(error) => {
            "The harness declined the message. Edit it or resume the queue to try again."
        }
        _ => {
            "Delivery could not be confirmed. Check native history before dismissing this message."
        }
    }
}
fn rejected(error: &NativeRuntimeError) -> bool {
    matches!(
        error,
        NativeRuntimeError::Bridge(
            BridgeFailureCode::TurnActive
                | BridgeFailureCode::NoActiveTurn
                | BridgeFailureCode::UnsupportedMethod
                | BridgeFailureCode::InvalidRequest
                | BridgeFailureCode::NativeCommandRejected
        )
    )
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
        if !registry
            .sessions()
            .iter()
            .any(|record| record.composer.pending())
        {
            return Ok(());
        }
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
        Ok(())
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
            let text = self.change_queue(id, |queue| {
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
                Ok(current.text.clone())
            })?;
            *lock(&state.composer_waiting)? = Some(generation);
            let result = runtime.prompt(text, PromptMode::Prompt).await;
            self.change_queue(id, |queue| {
                let current = queue
                    .items
                    .iter_mut()
                    .find(|current| current.id == item.id)
                    .ok_or_else(WorkspaceError::conflict)?;
                match &result {
                    Ok(()) => {
                        current.status = Delivery::Sent;
                        current.text.clear();
                    }
                    Err(error) => {
                        current.status = if rejected(error) {
                            Delivery::Queued
                        } else {
                            Delivery::Uncertain
                        };
                        current.error = Some(delivery_error(error).into());
                        queue.paused = true;
                    }
                }
                Ok(())
            })?;
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
    let host = state.inner();
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
    *lock(&live.composer_notify)? = Some(Arc::new(move || {
        let _ = app.emit("piui://composer-v19", &notify_id);
    }));
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
            ..
        } => {
            validate_session_id(&request_id)?;
            validate_text(&text)?;
            if mode == PromptMode::Steer {
                steer(
                    &host.workspace,
                    &id,
                    &runtime,
                    &live,
                    &capabilities,
                    request_id,
                    Some(text),
                )
                .await?;
            } else {
                host.workspace.change_queue(&id, |queue| {
                    queue.enqueue(request_id, text);
                    Ok(())
                })?;
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
            host.workspace.change_queue(&id, |queue| {
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
                Ok(())
            })?;
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
    text: Option<String>,
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
    let body = host.change_queue(id, |queue| {
        if let Some(text) = text {
            queue.enqueue(request_id.clone(), text);
        }
        let item = queue
            .items
            .iter_mut()
            .find(|item| item.id == request_id && item.status == Delivery::Queued)
            .ok_or_else(WorkspaceError::conflict)?;
        item.status = Delivery::Sending;
        item.error = None;
        Ok(item.text.clone())
    })?;
    let result = runtime.prompt(body, PromptMode::Steer).await;
    host.change_queue(id, |queue| {
        let item = queue
            .items
            .iter_mut()
            .find(|item| item.id == request_id)
            .ok_or_else(WorkspaceError::conflict)?;
        match &result {
            Ok(()) => {
                item.status = Delivery::Sent;
                item.text.clear();
            }
            Err(error) => {
                item.status = if rejected(error) {
                    Delivery::Queued
                } else {
                    Delivery::Uncertain
                };
                item.error = Some(delivery_error(error).into());
                queue.paused = true;
            }
        }
        Ok(())
    })?;
    // Once stored, failed delivery stays visible in the outbox. Returning it
    // avoids leaving a second editable copy in the composer after an ACK loss.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_edits_keep_identity_and_admitted_messages_cannot_be_edited() {
        let mut queue = QueueState::default();
        queue.enqueue("one".into(), "initial".into());
        queue.enqueue("two".into(), "next".into());
        queue.edit("one", "edited".into()).expect("queued edit");
        queue.enqueue("one".into(), "retry of original request".into());
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
        restored.enqueue("one".into(), "replayed".into());
        assert_eq!(restored.items.len(), 2);
        assert_eq!(restored.items[0].status, Delivery::Sent);
        assert_eq!(restored.items[1].id, "two");
    }

    #[test]
    fn recovery_preserves_unknown_delivery_without_replaying_it() {
        let mut queue = QueueState::default();
        queue.enqueue("admitted".into(), "unknown result".into());
        queue.items[0].status = Delivery::Sending;
        queue.enqueue("waiting".into(), "later".into());
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
}
