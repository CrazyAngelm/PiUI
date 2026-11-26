//! A single user-approved form write. Native-only, with no site IPC.

mod consent;

use std::future::Future;
use std::pin::Pin;
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
    state: Arc<Mutex<HandoffState>>,
    operation: Box<NativeOperation>,
}

type NativeOperation = dyn for<'a> Fn(
        &'a Handoff,
        &'a str,
        BrowserFormOperation,
    ) -> Pin<Box<dyn Future<Output = Result<(), &'static str>> + Send + 'a>>
    + Send
    + Sync;

pub(crate) type Factory = Arc<dyn Fn() -> Arc<Handoff> + Send + Sync>;

// Only real application setup binds Wry to a session. Workspace unit tests
// handle the same requests and lifetime state without linking the Wry consumer.
pub(crate) fn factory(app: AppHandle) -> Factory {
    Arc::new(move || {
        let app = app.clone();
        Arc::new(Handoff {
            state: Arc::default(),
            operation: Box::new(move |handoff, id, operation| {
                let app = app.clone();
                Box::pin(async move {
                    match operation {
                        BrowserFormOperation::Open { url, field, value } => {
                            handoff.open(&app, id, &url, field, value).await
                        }
                        BrowserFormOperation::Fill => handoff.fill(&app, id).await,
                    }
                })
            }),
        })
    })
}

#[derive(Default)]
struct HandoffState {
    request: Option<ActiveRequest>,
    plan: Option<Plan>,
}

struct ActiveRequest {
    id: String,
    cancelled: watch::Sender<bool>,
}

impl HandoffState {
    fn check_active(&self, id: &str) -> Result<(), &'static str> {
        if self
            .request
            .as_ref()
            .is_some_and(|request| request.id == id && !*request.cancelled.borrow())
        {
            Ok(())
        } else {
            Err("cancelled")
        }
    }

    fn clear_plan(&mut self) {
        if let Some(plan) = self.plan.take() {
            plan.document.revoke();
        }
    }

    fn install(&mut self, plan: Plan) -> Result<(), &'static str> {
        self.check_active(&plan.open_request)?;
        plan.document.check()?;
        self.plan = Some(plan);
        Ok(())
    }

    fn revoke(&mut self) {
        if let Some(request) = &self.request {
            request.cancelled.send_replace(true);
        }
        self.clear_plan();
    }
}

pub(crate) struct Request {
    state: Arc<Mutex<HandoffState>>,
    id: String,
    cancelled: watch::Receiver<bool>,
    response_sent: bool,
}

impl Request {
    pub(crate) fn response_sent(&mut self, sent: bool) {
        self.response_sent = sent;
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock()
            && state
                .request
                .as_ref()
                .is_some_and(|request| request.id == self.id)
        {
            if !self.response_sent {
                state.revoke();
            }
            state.request = None;
        }
    }
}

impl Handoff {
    pub(crate) fn stage_ready(&self, message_id: String) {
        if let Ok(mut state) = self.state.lock()
            && let Some(plan) = state.plan.as_mut()
            && plan.document.check().is_ok()
        {
            plan.ready_message = Some(message_id);
        }
    }

    pub(crate) fn admit_ready(&self, message_id: &str, text: &str) {
        if let Ok(mut state) = self.state.lock()
            && let Some(plan) = state.plan.as_mut()
            && plan.ready_message.as_deref() == Some(message_id)
        {
            plan.ready_message = None;
            plan.ready = is_ready_message(text);
        }
    }

    pub(crate) fn revoke(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.revoke();
        }
    }

    pub(crate) fn cancel(&self, id: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state
                .request
                .as_ref()
                .is_some_and(|request| request.id == id)
            {
                state.revoke();
            } else if state
                .plan
                .as_ref()
                .is_some_and(|plan| plan.open_request == id)
            {
                state.clear_plan();
            }
        }
    }

    pub(crate) fn begin(&self, id: String) -> Option<Request> {
        let mut state = self.state.lock().ok()?;
        if state.request.is_some() {
            return None;
        }
        let (sender, cancelled) = watch::channel(false);
        state.request = Some(ActiveRequest {
            id: id.clone(),
            cancelled: sender,
        });
        Some(Request {
            state: self.state.clone(),
            id,
            cancelled,
            response_sent: false,
        })
    }

    pub(crate) async fn handle(
        &self,
        request: &mut Request,
        operation: BrowserFormOperation,
    ) -> Value {
        let id = request.id.as_str();
        let result = tokio::select! {
            biased;
            _ = request.cancelled.wait_for(|cancelled| *cancelled) => Err("cancelled"),
            result = (self.operation)(self, id, operation) => result,
        };
        match result {
            Ok(()) => json!({"ok": true}),
            Err(code) => json!({"ok": false, "code": code}),
        }
    }

    async fn open(
        &self,
        app: &AppHandle,
        request_id: &str,
        address: &str,
        field: BrowserFormField,
        value: String,
    ) -> Result<(), &'static str> {
        {
            let mut state = self.state.lock().map_err(|_| "unavailable")?;
            state.check_active(request_id)?;
            state.clear_plan();
        }
        if !visible_value(&value) {
            return Err("invalid-value");
        }
        let host = app.state::<HostState>();
        if host.safe_mode || host.is_shutting_down() {
            return Err("unavailable");
        }
        let url = consent_url(address, app.config().build.dev_url.as_ref())?;
        let Some(main) = app.get_window("main") else {
            return Err("unavailable");
        };
        let (_, title) = field_labels(field);
        if !consent::confirm(&main, url.as_str(), title, &value).await? || host.is_shutting_down() {
            return Err("not-approved");
        }
        self.state
            .lock()
            .map_err(|_| "unavailable")?
            .check_active(request_id)?;
        let document = Arc::new(Document::new(url.clone()));
        let browser = app.state::<SiteBrowser>();
        let tab = open_browser(
            app,
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
        let view = app.get_webview(&tab_label(tab)).ok_or("document-closed")?;
        let context = isolated_context(&view, &document).await?;
        evaluate(&view, &document, &context, field, None).await?;
        let mut state = self.state.lock().map_err(|_| "unavailable")?;
        state.install(Plan {
            open_request: request_id.to_owned(),
            tab,
            document,
            context,
            field,
            value: Some(value),
            ready_message: None,
            ready: false,
        })
    }

    async fn fill(&self, app: &AppHandle, request_id: &str) -> Result<(), &'static str> {
        let (tab, document, context, field, value) = {
            let mut state = self.state.lock().map_err(|_| "unavailable")?;
            state.check_active(request_id)?;
            let plan = state.plan.as_mut().ok_or("no-proposal")?;
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
        let view = app.get_webview(&tab_label(tab)).ok_or("document-closed")?;
        evaluate(&view, &document, &context, field, Some(&value)).await
    }
}

fn consent_url(address: &str, dev_url: Option<&Url>) -> Result<Url, &'static str> {
    let url = chat_site_url(address, dev_url).map_err(|_| "invalid-address")?;
    // The HTTP(S) parser also accepts aliases such as https:/host. Check its
    // raw authority for even an empty userinfo marker, which serialization drops.
    let authority = address.split_once(':').and_then(|(_, rest)| {
        rest.trim_start_matches(['/', '\\'])
            .split(['/', '\\', '?', '#'])
            .next()
    });
    if authority.is_none_or(|authority| authority.contains('@')) || !url.as_str().is_ascii() {
        return Err("invalid-address");
    }
    Ok(url)
}

fn visible_value(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.chars().all(|ch| {
            // Unicode 17 Default_Ignorable_Code_Point and the blank Braille cell.
            // Never remove controls silently before displaying or writing a value.
            !ch.is_control()
                && (!ch.is_whitespace() || ch == ' ')
                && !matches!(ch as u32,
                0x00ad | 0x034f | 0x061c | 0x115f..=0x1160 | 0x17b4..=0x17b5 | 0x180b..=0x180f
                | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x206f | 0x2800 | 0x3164 | 0xfe00..=0xfe0f
                | 0xfeff | 0xffa0 | 0xfff0..=0xfff8 | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a
                | 0xe0000..=0xe0fff)
        })
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

    fn active_plan() -> (Request, Plan) {
        let url = Url::parse("https://example.test/form").expect("test address");
        let document = Arc::new(Document::new(url.clone()));
        document.on_navigation(&url);
        document.on_loaded(&url);
        let id = "open".to_owned();
        let (cancel, cancelled) = watch::channel(false);
        let request = Request {
            state: Arc::new(Mutex::new(HandoffState {
                request: Some(ActiveRequest {
                    id: id.clone(),
                    cancelled: cancel,
                }),
                plan: None,
            })),
            id: id.clone(),
            cancelled,
            response_sent: false,
        };
        (
            request,
            Plan {
                open_request: id,
                tab: 1,
                document,
                context: "example".into(),
                field: BrowserFormField::GivenName,
                value: Some("Élodie".into()),
                ready_message: None,
                ready: false,
            },
        )
    }

    #[test]
    fn cancelled_open_cannot_publish_a_late_plan() {
        let (request, plan) = active_plan();
        let mut state = request.state.lock().expect("active request");
        state.revoke();
        assert_eq!(state.install(plan), Err("cancelled"));
        assert!(state.plan.is_none());
    }

    #[test]
    fn abandoning_the_request_releases_its_slot_and_revokes_the_plan() {
        let (request, plan) = active_plan();
        let document = plan.document.clone();
        let shared = request.state.clone();
        shared
            .lock()
            .expect("active request")
            .install(plan)
            .expect("valid plan");
        drop(request);
        let state = shared.lock().expect("released request");
        assert!(state.request.is_none());
        assert!(state.plan.is_none());
        assert_eq!(document.check(), Err("document-changed"));
    }

    #[test]
    fn approval_url_is_canonical_and_disallows_even_empty_userinfo() {
        let url =
            consent_url("https://example.test/café?q=чай#form", None).expect("canonical address");
        assert_eq!(
            url.as_str(),
            "https://example.test/caf%C3%A9?q=%D1%87%D0%B0%D0%B9#form"
        );
        for address in [
            "https://name@example.test/",
            "https://@example.test/",
            "https:/@example.test/",
        ] {
            assert_eq!(consent_url(address, None), Err("invalid-address"));
        }
        assert!(consent_url("https://example.test/form?value=name@example.test", None).is_ok());
    }

    #[test]
    fn values_keep_visible_unicode_names_and_refuse_hidden_characters() {
        for value in ["Élodie O’Neill", "Север Се́вер", "محمد علي", "李 小龍"]
        {
            assert!(visible_value(value));
        }
        for value in [
            "",
            " leading",
            "trailing ",
            "line\nwrap",
            "a\u{202e}b",
            "A\u{200d}B",
            "A\u{00ad}B",
            "A\u{034f}B",
        ] {
            assert!(!visible_value(value));
        }
    }

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
