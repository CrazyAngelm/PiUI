//! An in-process fake Nano server (tests only). It speaks the discovery,
//! OAuth, account and gateway parts of `nano-server-v1` on a loopback port
//! with synthetic tokens `access-<n>` / `refresh-<n>`.

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bytes::Bytes;
use http::{Method, Request, Response, StatusCode};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt as _, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Notify, mpsc, oneshot};

use crate::account::NanoAccount;
use crate::config::NanoConfig;
use crate::secret::SecretString;
use crate::status::{NanoAccountStateV1, NanoAccountStatusV1};
use crate::store::{CredentialStore, MemoryStore};
use crate::wire::tests::server_fixture;

type Body = UnsyncBoxBody<Bytes, Infallible>;

/// How the fake gateway answers chat completions.
pub(crate) enum Gateway {
    /// A small JSON completion.
    Json,
    /// An SSE body fed by the test through this receiver.
    Stream(mpsc::UnboundedReceiver<Bytes>),
    /// A refusal with this status and server error code.
    Refuse(u16, &'static str),
    /// Never answers (an upstream that is still working).
    Hang,
}

/// One recorded gateway request.
#[derive(Debug, Clone)]
pub(crate) struct GatewayCall {
    pub(crate) path: String,
    pub(crate) authorization: String,
    pub(crate) body: Bytes,
    pub(crate) device: String,
    pub(crate) session: String,
}

pub(crate) struct FakeState {
    pub(crate) counter: u32,
    pub(crate) valid_refresh: String,
    pub(crate) current_access: String,
    pub(crate) entitlements: Value,
    pub(crate) gateway_dialects: Value,
    pub(crate) gateway: Gateway,
    /// The gateway answers 401 `token_expired` for this access token.
    pub(crate) reject_access: Option<String>,
    pub(crate) grants: Vec<String>,
    pub(crate) device_names: Vec<String>,
    pub(crate) revoked: Vec<String>,
    pub(crate) gateway_calls: Vec<GatewayCall>,
    /// `POST /connect/token` waits for this before answering.
    pub(crate) token_gate: Option<Arc<Notify>>,
    /// Token requests received (counted before the gate).
    pub(crate) token_requests: u32,
    /// The `X-Nano-Client` value of every request (empty when missing).
    pub(crate) clients: Vec<String>,
}

pub(crate) struct FakeNano {
    pub(crate) origin: String,
    state: Arc<Mutex<FakeState>>,
    _shutdown: oneshot::Sender<()>,
}

impl FakeNano {
    pub(crate) async fn start() -> Self {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("bind fake");
        let port = listener.local_addr().expect("addr").port();
        let origin = format!("http://127.0.0.1:{port}");
        let state = Arc::new(Mutex::new(FakeState {
            counter: 0,
            valid_refresh: "refresh-0".to_owned(),
            current_access: String::new(),
            entitlements: server_fixture("entitlementsPaid"),
            gateway_dialects: json!({}),
            gateway: Gateway::Json,
            reject_access: None,
            grants: Vec::new(),
            device_names: Vec::new(),
            revoked: Vec::new(),
            gateway_calls: Vec::new(),
            token_gate: None,
            token_requests: 0,
            clients: Vec::new(),
        }));
        let (tx, mut rx) = oneshot::channel::<()>();
        let served = state.clone();
        let base = origin.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let state = served.clone();
                        let origin = base.clone();
                        tokio::spawn(async move {
                            let service = service_fn(move |request| {
                                let state = state.clone();
                                let origin = origin.clone();
                                async move { Ok::<_, Infallible>(route(&state, &origin, request).await) }
                            });
                            let _ = http1::Builder::new()
                                .serve_connection(TokioIo::new(stream), service)
                                .await;
                        });
                    }
                }
            }
        });
        Self {
            origin,
            state,
            _shutdown: tx,
        }
    }

    pub(crate) fn state(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn config(&self) -> NanoConfig {
        NanoConfig::from_parts(Some(&self.origin), "0.3.0").expect("fake config")
    }

    /// A signed-out account whose store holds `refresh-0`.
    pub(crate) fn account_with_stored_token(&self) -> (NanoAccount, Arc<MemoryStore>) {
        let store = Arc::new(MemoryStore::with_token(SecretString::new(
            "refresh-0".to_owned(),
        )));
        let dyn_store: Arc<dyn CredentialStore> = store.clone();
        let account =
            NanoAccount::with_store(self.config(), None, Some(dyn_store)).expect("account");
        (account, store)
    }

    /// A restored, signed-in account (one refresh: `access-1`, `refresh-1`).
    pub(crate) async fn signed_in(&self) -> (NanoAccount, Arc<MemoryStore>) {
        let (account, store) = self.account_with_stored_token();
        account.restore().await;
        assert_eq!(
            account.status().state,
            NanoAccountStateV1::SignedIn,
            "{:?}",
            account.status()
        );
        (account, store)
    }
}

/// Waits until `predicate` holds for a published status.
pub(crate) async fn wait_for(
    account: &NanoAccount,
    predicate: impl Fn(&NanoAccountStatusV1) -> bool,
) -> NanoAccountStatusV1 {
    let mut updates = account.subscribe();
    let waited = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = updates.borrow_and_update().clone();
            if predicate(&status) {
                return status;
            }
            if updates.changed().await.is_err() {
                return status;
            }
        }
    })
    .await;
    waited.unwrap_or_else(|_| panic!("status never matched: {:?}", account.status()))
}

/// A test HTTP client with the crate's TLS setup and no proxy.
pub(crate) fn test_client() -> reqwest::Client {
    crate::net::base_builder()
        .expect("builder")
        .no_proxy()
        .build()
        .expect("client")
}

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).boxed_unsync()
}

fn json_response(status: u16, value: &Value) -> Response<Body> {
    let mut response = Response::new(full(value.to_string()));
    *response.status_mut() = StatusCode::from_u16(status).expect("status");
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/json"),
    );
    response
}

fn error(status: u16, code: &str) -> Response<Body> {
    json_response(
        status,
        &json!({ "error": { "code": code, "message": "synthetic", "retryable": false } }),
    )
}

fn header(request: &Request<Incoming>, name: &str) -> String {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

/// What the gateway route decided while holding the state lock.
enum GatewayAnswer {
    Ready(Response<Body>),
    Hang,
}

fn gateway_answer(s: &mut FakeState) -> GatewayAnswer {
    GatewayAnswer::Ready(match std::mem::replace(&mut s.gateway, Gateway::Json) {
        Gateway::Json => json_response(
            200,
            &json!({ "id": "cmpl", "object": "chat.completion", "choices": [] }),
        ),
        Gateway::Refuse(status, code) => {
            s.gateway = Gateway::Refuse(status, code);
            error(status, code)
        }
        Gateway::Hang => {
            s.gateway = Gateway::Hang;
            return GatewayAnswer::Hang;
        }
        Gateway::Stream(receiver) => {
            let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
                receiver
                    .recv()
                    .await
                    .map(|chunk| (Ok::<_, Infallible>(Frame::data(chunk)), receiver))
            });
            let mut response = Response::new(StreamBody::new(stream).boxed_unsync());
            response.headers_mut().insert(
                http::header::CONTENT_TYPE,
                http::HeaderValue::from_static("text/event-stream"),
            );
            response
        }
    })
}

async fn route(
    state: &Mutex<FakeState>,
    origin: &str,
    request: Request<Incoming>,
) -> Response<Body> {
    let lock = || state.lock().unwrap_or_else(PoisonError::into_inner);
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let authorization = header(&request, "authorization");
    let device = header(&request, "x-nano-device");
    let session = header(&request, "x-nano-session");
    lock().clients.push(header(&request, "x-nano-client"));
    let body = request
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let authorized = || authorization == format!("Bearer {}", lock().current_access);

    match (method, path.as_str()) {
        (Method::GET, "/.well-known/oauth-authorization-server") => {
            let mut metadata = server_fixture("oauthMetadata");
            for key in [
                "authorization_endpoint",
                "token_endpoint",
                "revocation_endpoint",
                "device_authorization_endpoint",
            ] {
                let value = metadata[key]
                    .as_str()
                    .expect("endpoint")
                    .replace("https://nanoagents.ru", origin);
                metadata[key] = Value::from(value);
            }
            metadata["issuer"] = Value::from(origin);
            json_response(200, &metadata)
        }
        (Method::GET, "/api/desktop/v1/meta") => {
            let mut meta = server_fixture("meta");
            for key in ["billing", "devices", "signup", "cloud"] {
                meta["links"][key] = Value::from(format!("{origin}/{key}"));
            }
            json_response(200, &meta)
        }
        (Method::POST, "/connect/token") => {
            let gate = {
                let mut s = lock();
                s.token_requests += 1;
                s.token_gate.clone()
            };
            if let Some(gate) = gate {
                gate.notified().await;
            }
            let form: Vec<(String, String)> =
                url::form_urlencoded::parse(&body).into_owned().collect();
            let field = |name: &str| form.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
            let mut s = lock();
            let grant = field("grant_type").unwrap_or_default();
            s.grants.push(grant.clone());
            let accepted = match grant.as_str() {
                "refresh_token" => {
                    field("refresh_token").as_deref() == Some(s.valid_refresh.as_str())
                }
                "authorization_code" => {
                    if let Some(name) = field("device_name") {
                        s.device_names.push(name);
                    }
                    field("code").as_deref() == Some("code-ok") && field("code_verifier").is_some()
                }
                _ => false,
            };
            if !accepted {
                return json_response(400, &json!({ "error": "invalid_grant" }));
            }
            s.counter += 1;
            s.current_access = format!("access-{}", s.counter);
            s.valid_refresh = format!("refresh-{}", s.counter);
            json_response(
                200,
                &json!({
                    "access_token": s.current_access,
                    "token_type": "Bearer",
                    "expires_in": 600,
                    "refresh_token": s.valid_refresh,
                    "scope": "openid profile offline_access nano.desktop",
                }),
            )
        }
        (Method::POST, "/connect/revoke") => {
            let form: Vec<(String, String)> =
                url::form_urlencoded::parse(&body).into_owned().collect();
            if let Some((_, token)) = form.iter().find(|(k, _)| k == "token") {
                lock().revoked.push(token.clone());
            }
            json_response(200, &json!({}))
        }
        (Method::GET, "/api/desktop/v1/me") if authorized() => {
            json_response(200, &server_fixture("me"))
        }
        (Method::GET, path) if path.ends_with("/entitlements") && authorized() => {
            let mut entitlements = lock().entitlements.clone();
            let workspace = path.split('/').nth(5).unwrap_or_default().to_owned();
            entitlements["workspaceId"] = Value::from(workspace);
            json_response(200, &entitlements)
        }
        (Method::GET, path) if path.ends_with("/usage") && authorized() => {
            let mut usage = server_fixture("usage");
            usage["workspaceId"] = Value::from(path.split('/').nth(5).unwrap_or_default());
            json_response(200, &usage)
        }
        (Method::GET, path) if path.ends_with("/gateway/v1/capabilities") && authorized() => {
            json_response(200, &json!({ "dialects": lock().gateway_dialects }))
        }
        (Method::POST, path)
            if path.ends_with("/gateway/v1/chat/completions")
                || path.ends_with("/gateway/v1/responses") =>
        {
            let answer = {
                let mut s = lock();
                s.gateway_calls.push(GatewayCall {
                    path: path.to_owned(),
                    authorization: authorization.clone(),
                    body,
                    device,
                    session,
                });
                if s.reject_access
                    .as_deref()
                    .is_some_and(|token| authorization == format!("Bearer {token}"))
                    || authorization != format!("Bearer {}", s.current_access)
                {
                    GatewayAnswer::Ready(error(401, "token_expired"))
                } else {
                    gateway_answer(&mut s)
                }
            };
            match answer {
                GatewayAnswer::Ready(response) => response,
                GatewayAnswer::Hang => std::future::pending::<Response<Body>>().await,
            }
        }
        _ => error(401, "unauthorized"),
    }
}
