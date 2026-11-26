//! A single user-approved form write. Native-only, with no site IPC.

use std::sync::{Arc, Mutex};

use piui_runtime::workspace_runtime::{BrowserFormField, BrowserFormOperation};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Url, Webview};
use tokio::sync::{oneshot, watch};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR,
    DevToolsProtocolEventReceivedEventHandler,
};

use super::{LinkTarget, SiteBrowser, chat_site_url, open_browser, tab_label};
use crate::state::HostState;

const FORM_TITLE: &str = "Нано · Заполнение формы";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Navigation {
    Created,
    Loading,
    Loaded,
    Revoked,
}

pub(super) struct Document {
    url: Url,
    navigation: watch::Sender<Navigation>,
}

impl Document {
    fn new(url: Url) -> Self {
        Self {
            url,
            navigation: watch::channel(Navigation::Created).0,
        }
    }

    pub(super) fn on_navigation(&self, url: &Url) {
        self.navigation.send_modify(|state| {
            *state = if *state == Navigation::Created && url == &self.url {
                Navigation::Loading
            } else {
                Navigation::Revoked
            };
        });
    }

    pub(super) fn on_loaded(&self, url: &Url) {
        self.navigation.send_if_modified(|state| {
            if *state != Navigation::Loading {
                return false;
            }
            *state = if url == &self.url {
                Navigation::Loaded
            } else {
                Navigation::Revoked
            };
            true
        });
    }

    pub(super) fn revoke(&self) {
        self.navigation.send_replace(Navigation::Revoked);
    }

    async fn loaded(&self) -> Result<(), &'static str> {
        let mut navigation = self.navigation.subscribe();
        navigation
            .wait_for(|state| matches!(state, Navigation::Loaded | Navigation::Revoked))
            .await
            .map_err(|_| "document-closed")?;
        self.check()
    }

    fn check(&self) -> Result<(), &'static str> {
        if *self.navigation.borrow() == Navigation::Loaded {
            Ok(())
        } else {
            Err("document-changed")
        }
    }
}

struct Plan {
    open_request: String,
    tab: u32,
    document: Arc<Document>,
    context: String,
    field: BrowserFormField,
    value: Option<String>,
    ready_message: Option<String>,
    ready: bool,
}

pub(crate) struct Handoff {
    app: AppHandle,
    request: Mutex<Option<(String, watch::Sender<bool>)>>,
    plan: Mutex<Option<Plan>>,
}

impl Handoff {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self {
            app,
            request: Mutex::new(None),
            plan: Mutex::new(None),
        }
    }

    pub(crate) fn stage_ready(&self, message_id: String) {
        if let Ok(mut slot) = self.plan.lock()
            && let Some(plan) = slot.as_mut()
            && plan.document.check().is_ok()
        {
            plan.ready_message = Some(message_id);
        }
    }

    pub(crate) fn admit_ready(&self, message_id: &str, text: &str) {
        if let Ok(mut slot) = self.plan.lock()
            && let Some(plan) = slot.as_mut()
            && plan.ready_message.as_deref() == Some(message_id)
        {
            plan.ready_message = None;
            plan.ready = is_ready_message(text);
        }
    }

    fn clear_plan(&self) {
        if let Ok(mut slot) = self.plan.lock()
            && let Some(plan) = slot.take()
        {
            plan.document.revoke();
        }
    }

    pub(crate) fn revoke(&self) {
        if let Ok(request) = self.request.lock()
            && let Some((_, cancellation)) = request.as_ref()
        {
            cancellation.send_replace(true);
        }
        self.clear_plan();
    }

    pub(crate) fn cancel(&self, id: &str) {
        let active = self.request.lock().ok().and_then(|request| {
            let (active, cancellation) = request.as_ref()?;
            (active == id).then(|| cancellation.clone())
        });
        if let Some(cancellation) = active {
            cancellation.send_replace(true);
            self.clear_plan();
        } else if let Ok(mut slot) = self.plan.lock()
            && slot.as_ref().is_some_and(|plan| plan.open_request == id)
            && let Some(plan) = slot.take()
        {
            plan.document.revoke();
        }
    }

    pub(crate) fn begin(&self, id: String) -> Option<watch::Receiver<bool>> {
        let mut request = self.request.lock().ok()?;
        if request.is_some() {
            return None;
        }
        let (sender, receiver) = watch::channel(false);
        *request = Some((id, sender));
        Some(receiver)
    }

    pub(crate) async fn handle(
        &self,
        request_id: &str,
        operation: BrowserFormOperation,
        mut cancellation: watch::Receiver<bool>,
    ) -> Value {
        let result = tokio::select! {
            biased;
            _ = cancellation.wait_for(|cancelled| *cancelled) => Err("cancelled"),
            result = async {
                match operation {
                    BrowserFormOperation::Open { url, field, value } => self.open(request_id, &url, field, value).await,
                    BrowserFormOperation::Fill => self.fill().await,
                }
            } => result,
        };
        if let Ok(mut request) = self.request.lock() {
            *request = None;
        }
        match result {
            Ok(()) => json!({"ok": true}),
            Err(code) => json!({"ok": false, "code": code}),
        }
    }

    async fn open(
        &self,
        request_id: &str,
        address: &str,
        field: BrowserFormField,
        value: String,
    ) -> Result<(), &'static str> {
        self.clear_plan();
        if value.trim().is_empty() || value.chars().any(char::is_control) {
            return Err("invalid-value");
        }
        let host = self.app.state::<HostState>();
        if host.safe_mode || host.is_shutting_down() {
            return Err("unavailable");
        }
        let url = chat_site_url(address, self.app.config().build.dev_url.as_ref())
            .map_err(|_| "invalid-address")?;
        let Some(main) = self.app.get_window("main") else {
            return Err("unavailable");
        };
        let (_, title) = field_labels(field);
        let approved = rfd::AsyncMessageDialog::new()
            .set_parent(&main)
            .set_title(FORM_TITLE)
            .set_description(format!(
                "Открыть {} и после вашего сообщения «Готово» в этом чате заполнить поле «{}» значением:\n\n{}",
                url.origin().ascii_serialization(), title, value
            ))
            .set_buttons(rfd::MessageButtons::YesNo)
            .show()
            .await;
        if approved != rfd::MessageDialogResult::Yes || host.is_shutting_down() {
            return Err("not-approved");
        }
        let document = Arc::new(Document::new(url.clone()));
        let browser = self.app.state::<SiteBrowser>();
        let tab = open_browser(
            &self.app,
            &browser,
            "ru",
            Some(LinkTarget {
                url,
                document: Some(document.clone()),
            }),
        )
        .await
        .map_err(|_| "open-failed")?
        .ok_or("open-failed")?;
        document.loaded().await?;
        let view = self
            .app
            .get_webview(&tab_label(tab))
            .ok_or("document-closed")?;
        let context = isolated_context(&view, &document).await?;
        evaluate(&view, &document, &context, field, None).await?;
        let mut slot = self.plan.lock().map_err(|_| "unavailable")?;
        document.check()?;
        *slot = Some(Plan {
            open_request: request_id.to_owned(),
            tab,
            document,
            context,
            field,
            value: Some(value),
            ready_message: None,
            ready: false,
        });
        Ok(())
    }

    async fn fill(&self) -> Result<(), &'static str> {
        let (tab, document, context, field, value) = {
            let mut slot = self.plan.lock().map_err(|_| "unavailable")?;
            let plan = slot.as_mut().ok_or("no-proposal")?;
            plan.document.check()?;
            if !plan.ready {
                return Err("awaiting-person");
            }
            let value = plan.value.take().ok_or("already-used")?;
            (
                plan.tab,
                plan.document.clone(),
                plan.context.clone(),
                plan.field,
                value,
            )
        };
        let view = self
            .app
            .get_webview(&tab_label(tab))
            .ok_or("document-closed")?;
        evaluate(&view, &document, &context, field, Some(&value)).await
    }
}

pub(crate) fn is_ready_message(text: &str) -> bool {
    matches!(text.trim().to_lowercase().as_str(), "готово" | "ready")
}

fn field_labels(field: BrowserFormField) -> (&'static str, &'static str) {
    match field {
        BrowserFormField::GivenName => ("given-name", "Имя"),
        BrowserFormField::FamilyName => ("family-name", "Фамилия"),
        BrowserFormField::Organization => ("organization", "Организация"),
    }
}

// Only the methods below can use this transport. No port, renderer bridge,
// exposed helper, method name, JS source, or selector comes from the agent.
async fn protocol(
    view: &Webview,
    document: &Arc<Document>,
    method: &'static str,
    args: Value,
) -> Result<Value, &'static str> {
    let document = document.clone();
    let (send, receive) = oneshot::channel();
    view.with_webview(move |platform| {
        if send.is_closed() || document.check().is_err() {
            return;
        }
        // COM controller, command and completion all run on the WebView thread.
        unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            let method = CoTaskMemPWSTR::from(method);
            let args = args.to_string();
            let args = CoTaskMemPWSTR::from(args.as_str());
            let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, json| {
                    let result = status.map_err(|_| "protocol-unavailable").and_then(|()| {
                        serde_json::from_str(&json).map_err(|_| "protocol-unavailable")
                    });
                    let _ = send.send(result);
                    Ok(())
                },
            ));
            let _ = core.CallDevToolsProtocolMethod(
                *method.as_ref().as_pcwstr(),
                *args.as_ref().as_pcwstr(),
                &done,
            );
        }
    })
    .map_err(|_| "document-closed")?;
    receive.await.map_err(|_| "protocol-unavailable")?
}

struct ContextListener {
    view: Webview,
    token: i64,
}

impl Drop for ContextListener {
    fn drop(&mut self) {
        let token = self.token;
        let _ = self.view.with_webview(move |platform| unsafe {
            let event = CoTaskMemPWSTR::from("Runtime.executionContextCreated");
            if let Ok(core) = platform.controller().CoreWebView2()
                && let Ok(receiver) =
                    core.GetDevToolsProtocolEventReceiver(*event.as_ref().as_pcwstr())
            {
                let _ = receiver.remove_DevToolsProtocolEventReceived(token);
            }
        });
    }
}

async fn isolated_context(
    view: &Webview,
    document: &Arc<Document>,
) -> Result<String, &'static str> {
    let frame = protocol(view, document, "Page.getFrameTree", json!({})).await?;
    let frame = frame
        .pointer("/frameTree/frame/id")
        .and_then(Value::as_str)
        .ok_or("document-changed")?;
    protocol(view, document, "Runtime.enable", json!({})).await?;
    let world = format!("piui-form-{}", uuid::Uuid::new_v4());
    let name = world.clone();
    let frame_id = frame.to_owned();
    let (registered, registration) = oneshot::channel();
    let (found, context) = oneshot::channel();
    let event_view = view.clone();
    view.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let event = CoTaskMemPWSTR::from("Runtime.executionContextCreated");
        let Ok(receiver) = core.GetDevToolsProtocolEventReceiver(*event.as_ref().as_pcwstr())
        else {
            return;
        };
        let mut found = Some(found);
        let handler =
            DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                let (Some(sender), Some(args)) = (found.as_ref(), args) else {
                    return Ok(());
                };
                if sender.is_closed() {
                    return Ok(());
                }
                let mut payload = Default::default();
                args.ParameterObjectAsJson(&mut payload)?;
                let payload = webview2_com::take_pwstr(payload);
                if let Ok(value) = serde_json::from_str::<Value>(&payload)
                    && value.pointer("/context/name").and_then(Value::as_str) == Some(&name)
                    && value
                        .pointer("/context/auxData/frameId")
                        .and_then(Value::as_str)
                        == Some(&frame_id)
                    && value
                        .pointer("/context/auxData/type")
                        .and_then(Value::as_str)
                        == Some("isolated")
                    && let Some(found) = found.take()
                {
                    let _ = found.send(value["context"].clone());
                }
                Ok(())
            }));
        let mut token = 0;
        if receiver
            .add_DevToolsProtocolEventReceived(&handler, &mut token)
            .is_ok()
        {
            let _ = registered.send(ContextListener {
                view: event_view,
                token,
            });
        }
    })
    .map_err(|_| "document-closed")?;
    let _listener = registration.await.map_err(|_| "protocol-unavailable")?;
    let created = protocol(
        view,
        document,
        "Page.createIsolatedWorld",
        json!({
            "frameId": frame,
            "worldName": world,
        }),
    )
    .await?;
    let id = created
        .get("executionContextId")
        .and_then(Value::as_i64)
        .ok_or("protocol-unavailable")?;
    let mut navigation = document.navigation.subscribe();
    let context = tokio::select! {
        result = context => result.map_err(|_| "protocol-unavailable")?,
        _ = navigation.wait_for(|state| *state == Navigation::Revoked) => return Err("document-changed"),
    };
    if context.get("id").and_then(Value::as_i64) != Some(id) {
        return Err("document-changed");
    }
    context
        .get("uniqueId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or("protocol-unavailable")
}

const FORM_ACTION: &str = r#"function ({ selector, origin, text }) {
  if (location.origin !== origin) return false;
  const matches = document.querySelectorAll(selector);
  if (matches.length !== 1) return false;
  const input = matches[0];
  if (!input.form || input.type !== "text" || input.matches(":disabled") || input.readOnly ||
      input.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]') ||
      !input.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  const { width, height } = input.getBoundingClientRect();
  if (width <= 0 || height <= 0) return false;
  if (input.value !== "") return false;
  if (text === null) {
    globalThis.piuiFormTarget = { input: new WeakRef(input), form: new WeakRef(input.form) };
    return true;
  }
  if (globalThis.piuiFormTarget?.input.deref() !== input ||
      globalThis.piuiFormTarget?.form.deref() !== input.form) return false;
  delete globalThis.piuiFormTarget;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}"#;

async fn evaluate(
    view: &Webview,
    document: &Arc<Document>,
    context: &str,
    field: BrowserFormField,
    text: Option<&str>,
) -> Result<(), &'static str> {
    let (autocomplete, _) = field_labels(field);
    let args = json!({
        "selector": format!("input[autocomplete='{autocomplete}']"),
        "origin": document.url.origin().ascii_serialization(),
        "text": text,
    });
    let result = protocol(
        view,
        document,
        "Runtime.callFunctionOn",
        json!({
            "functionDeclaration": FORM_ACTION,
            "arguments": [{"value": args}],
            "uniqueContextId": context,
            "returnByValue": true,
            "silent": true,
        }),
    )
    .await?;
    document.check()?;
    if result.pointer("/result/value").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err("field-unavailable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_document_is_revoked_by_same_url_reload() {
        let url = Url::parse("https://example.test/form").expect("test address");
        let document = Document::new(url.clone());
        document.on_navigation(&url);
        document.on_loaded(&url);
        assert_eq!(document.check(), Ok(()));
        document.on_navigation(&url);
        document.on_loaded(&url);
        assert_eq!(document.check(), Err("document-changed"));
    }

    #[test]
    fn ready_requires_only_the_exact_message() {
        assert!(is_ready_message(" ГОТОВО "));
        assert!(is_ready_message("Ready"));
        assert!(!is_ready_message("Not ready"));
        assert!(!is_ready_message("Готово?"));
    }
}
