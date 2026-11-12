//! External provider requests use the same contained listener, with their own
//! lease namespace and the lifetime of the user-configured connection.

use super::*;
use crate::external_providers::{ExternalProviderAuth, ExternalProviderGrant};
use crate::net::{MAX_ERROR_BODY, read_capped};
use crate::openai_subscription::ChatGptError;

pub(super) struct LiveExternalProvider {
    key: SecretString,
    grant: Arc<ExternalProviderGrant>,
    alive: watch::Sender<()>,
    client: reqwest::Client,
}

/// One Nano Pi session's loopback credential. Dropping it ends its requests.
pub struct ExternalProviderLease {
    shared: Arc<Shared>,
    id: u64,
    key: SecretString,
}

impl ExternalProviderLease {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/p/{}/v1", self.shared.port, self.id)
    }

    pub fn key(&self) -> &SecretString {
        &self.key
    }
}

impl Drop for ExternalProviderLease {
    fn drop(&mut self) {
        self.shared
            .keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .external_providers
            .remove(&self.id);
    }
}

impl Relay {
    /// Issues a key for this session and pinned external endpoint only.
    pub fn register_external_provider(
        &self,
        grant: ExternalProviderGrant,
    ) -> Result<ExternalProviderLease, NanoError> {
        if grant.alive.has_changed().is_err() {
            return Err(NanoError::FeatureUnavailable);
        }
        let client = crate::net::base_builder()?
            .https_only(true)
            .build()
            .map_err(|_| NanoError::Offline)?;
        let key = random_token()?;
        let id = self.shared.next_session.fetch_add(1, Ordering::Relaxed);
        let (alive, _) = watch::channel(());
        let mut keys = self
            .shared
            .keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if grant.alive.has_changed().is_err() {
            return Err(NanoError::FeatureUnavailable);
        }
        keys.external_providers.insert(
            id,
            LiveExternalProvider {
                key: key.clone(),
                grant: Arc::new(grant),
                alive,
                client,
            },
        );
        Ok(ExternalProviderLease {
            shared: self.shared.clone(),
            id,
            key,
        })
    }

    /// Drops credentials of disconnected provider sessions immediately.
    pub fn retire_disconnected_external_providers(&self) {
        self.shared
            .keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .external_providers
            .retain(|_, lease| lease.grant.alive.has_changed().is_ok());
    }
}

struct ExternalTicket {
    grant: Arc<ExternalProviderGrant>,
    alive: watch::Receiver<()>,
    client: reqwest::Client,
}

impl ExternalTicket {
    fn active(&self) -> bool {
        self.alive.has_changed().is_ok() && self.grant.alive.has_changed().is_ok()
    }

    fn ended(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut session = self.alive.clone();
        let mut provider = self.grant.alive.clone();
        async move {
            tokio::select! {
                _ = session.changed() => (),
                _ = provider.changed() => (),
            }
        }
    }
}

pub(super) async fn handle(
    shared: &Shared,
    request: Request<Incoming>,
    id: u64,
    route: Route,
) -> Response<RelayBody> {
    let Some(bearer) = bearer(request.headers()) else {
        return plain(StatusCode::UNAUTHORIZED);
    };
    let ticket = {
        let keys = shared.keys.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(lease) = keys.external_providers.get(&id) else {
            return plain(StatusCode::UNAUTHORIZED);
        };
        if !lease.key.ct_eq_bytes(bearer) {
            return plain(StatusCode::UNAUTHORIZED);
        }
        ExternalTicket {
            grant: lease.grant.clone(),
            alive: lease.alive.subscribe(),
            client: lease.client.clone(),
        }
    };
    if !ticket.active() {
        return plain(StatusCode::UNAUTHORIZED);
    }
    let model_id = &ticket.grant.provider.spec.model_id;
    if route == Route::Models {
        return json_response(
            StatusCode::OK,
            &serde_json::json!({
                "object": "list",
                "data": [{ "object": "model", "id": model_id }],
            }),
        );
    }
    let expected_route = match &ticket.grant.auth {
        ExternalProviderAuth::ApiKey(_) => Route::Chat,
        ExternalProviderAuth::ChatGpt(_) => Route::Responses,
    };
    if route != expected_route {
        return plain(StatusCode::NOT_FOUND);
    }

    let Some(permit) = shared.try_acquire(DEFAULT_MAX_CONCURRENT) else {
        return plain(StatusCode::TOO_MANY_REQUESTS);
    };
    let accept = request.headers().get(ACCEPT).cloned();
    let limit = usize::try_from(DEFAULT_MAX_REQUEST_BYTES).unwrap_or(usize::MAX);
    let upload = tokio::time::timeout(
        shared.upload_deadline,
        Limited::new(request.into_body(), limit).collect(),
    );
    let body = tokio::select! {
        biased;
        () = ticket.ended() => return plain(StatusCode::UNAUTHORIZED),
        read = upload => match read {
            Err(_) => return plain(StatusCode::REQUEST_TIMEOUT),
            Ok(Ok(collected)) => collected.to_bytes(),
            Ok(Err(error)) if error.downcast_ref::<LengthLimitError>().is_some() => {
                return plain(StatusCode::PAYLOAD_TOO_LARGE);
            }
            Ok(Err(_)) => return plain(StatusCode::BAD_REQUEST),
        },
    };
    let valid_body = match route {
        Route::Responses => valid_chatgpt_response(&body, model_id),
        _ => {
            serde_json::from_slice::<ModelField>(&body).is_ok_and(|field| field.model == *model_id)
        }
    };
    if !valid_body {
        return plain(StatusCode::BAD_REQUEST);
    }
    if !ticket.active() {
        return plain(StatusCode::UNAUTHORIZED);
    }
    let upstream_key = match &ticket.grant.auth {
        ExternalProviderAuth::ApiKey(key) => key.clone(),
        ExternalProviderAuth::ChatGpt(grant) => {
            let result = tokio::select! {
                biased;
                () = ticket.ended() => return plain(StatusCode::UNAUTHORIZED),
                result = grant.access(model_id) => result,
            };
            match result {
                Ok(key) => key,
                Err(ChatGptError::Reauthenticate) => return plain(StatusCode::UNAUTHORIZED),
                Err(ChatGptError::NoPlanPermission) => return plain(StatusCode::FORBIDDEN),
                Err(_) => return plain(StatusCode::BAD_GATEWAY),
            }
        }
    };
    let mut upstream = ticket
        .client
        .post(ticket.grant.url.clone())
        .bearer_auth(upstream_key.expose())
        .header(CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(accept) = accept {
        upstream = upstream.header(ACCEPT, accept);
    }
    let response = tokio::select! {
        biased;
        () = ticket.ended() => return plain(StatusCode::UNAUTHORIZED),
        response = upstream.send() => response,
    };
    match response {
        Ok(response) if response.status().is_success() => {
            stream_back(response, permit, Box::pin(ticket.ended()))
        }
        Ok(mut response) if response.status().is_client_error() => {
            let status = response.status();
            if let ExternalProviderAuth::ChatGpt(grant) = &ticket.grant.auth {
                if status == StatusCode::UNAUTHORIZED {
                    grant.reject_access(&upstream_key);
                }
                if status == StatusCode::TOO_MANY_REQUESTS {
                    let body = tokio::select! {
                        biased;
                        () = ticket.ended() => return plain(StatusCode::UNAUTHORIZED),
                        body = read_capped(&mut response, MAX_ERROR_BODY) => body,
                    };
                    if let Some(limit) = body.ok().and_then(|body| chatgpt_usage_limit(&body)) {
                        let mut response = json_response(status, &limit);
                        response
                            .headers_mut()
                            .insert("x-should-retry", HeaderValue::from_static("false"));
                        return response;
                    }
                }
            }
            plain(status)
        }
        _ => plain(StatusCode::BAD_GATEWAY),
    }
}

fn chatgpt_usage_limit(body: &[u8]) -> Option<serde_json::Value> {
    let body: serde_json::Value = serde_json::from_slice(body).ok()?;
    let code = body["error"]["code"].as_str()?;
    let message = match code {
        "subscription_sharing_usage_limit_exceeded" => "ChatGPT plan usage limit reached.",
        "subscription_sharing_workplace_individual_usage_limit_exceeded" => {
            "ChatGPT workspace usage limit reached."
        }
        _ => return None,
    };
    Some(serde_json::json!({"error": {"code": code, "message": message}}))
}

fn valid_chatgpt_response(body: &[u8], model: &str) -> bool {
    use serde_json::Value;
    #[derive(serde::Deserialize)]
    struct ResponsesRequest<'a> {
        model: &'a str,
        store: bool,
        stream: bool,
        input: Vec<Value>,
        #[serde(flatten)]
        other: serde_json::Map<String, Value>,
    }
    // OpenAI's Sign in with ChatGPT public Responses preview requires
    // stateless, streamed requests and does not accept these API fields.
    const UNSUPPORTED_FIELDS: &[&str] = &[
        "background",
        "conversation",
        "max_output_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "multi_agent",
        "previous_response_id",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "tools",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
    ];
    let Ok(body) = serde_json::from_slice::<ResponsesRequest<'_>>(body) else {
        return false;
    };
    body.model == model
        && body.stream
        && !body.store
        && !UNSUPPORTED_FIELDS
            .iter()
            .any(|field| body.other.contains_key(*field))
        && body.input.iter().all(|item| {
            let role = item.get("role").and_then(Value::as_str);
            match item.get("type").and_then(Value::as_str) {
                Some("additional_tools") => {
                    role == Some("developer")
                        && item
                            .get("tools")
                            .and_then(Value::as_array)
                            .is_some_and(|tools| {
                                tools.iter().all(|tool| {
                                    tool.get("type").and_then(Value::as_str) == Some("function")
                                })
                            })
                }
                Some("configuration_update" | "tool_search_call" | "tool_search_output") => false,
                _ => role != Some("system"),
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_providers::{ExternalProvider, ExternalProviderSpec};
    use crate::testing::{FakeNano, test_client};
    use futures_util::StreamExt as _;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;

    #[test]
    fn chatgpt_usage_errors_keep_only_the_safe_nonretryable_code_and_copy() {
        let codes = [
            "subscription_sharing_usage_limit_exceeded",
            "subscription_sharing_workplace_individual_usage_limit_exceeded",
        ];
        for code in codes {
            let error = serde_json::json!({"error": {"code": code, "message": "opaque synthetic text", "extra": "private"}});
            let safe = chatgpt_usage_limit(error.to_string().as_bytes()).expect("allowlisted code");
            assert_eq!(safe["error"]["code"], code);
            assert!(!safe.to_string().contains("synthetic"));
            assert!(safe["error"]["extra"].is_null());
        }
        assert!(chatgpt_usage_limit(br#"{"error":{"code":"temporarily_unavailable"}}"#).is_none());
    }

    #[test]
    fn chatgpt_requires_stateless_streaming_and_native_function_tools() {
        let request = serde_json::json!({ "model": "authorized-model", "store": false, "stream": true,
            "input": [{"role": "developer", "content": "instructions"},
                {"role": "developer", "type": "additional_tools", "tools": [{"type": "function", "name": "read"}]}],
        });
        let valid = |body: &serde_json::Value| {
            valid_chatgpt_response(body.to_string().as_bytes(), "authorized-model")
        };
        assert!(valid(&request));
        assert!(!valid_chatgpt_response(br#"{"model":"other","model":"authorized-model","store":false,"stream":true,"input":[]}"#, "authorized-model"));
        for (field, replacement) in [
            ("model", serde_json::json!("other")),
            ("store", serde_json::json!(true)),
            ("stream", serde_json::json!(false)),
            ("max_output_tokens", serde_json::json!(64)),
            ("previous_response_id", serde_json::json!("other-thread")),
            ("input", serde_json::json!([{"role": "system"}])),
            ("tools", serde_json::json!([{"type": "web_search"}])),
        ] {
            let mut body = request.clone();
            body[field] = replacement;
            assert!(!valid(&body), "{field}");
        }
    }

    #[tokio::test]
    async fn forwards_only_the_configured_model_and_cuts_the_stream_on_disconnect() {
        forwards_only_the_configured_model(Route::Chat).await;
    }

    #[tokio::test]
    async fn chatgpt_subscription_bearer_is_host_owned_and_stream_ends_on_disconnect() {
        forwards_only_the_configured_model(Route::Responses).await;
    }

    async fn forwards_only_the_configured_model(route: Route) {
        use crate::external_providers::ExternalProviderRegistry;

        let leaf = match route {
            Route::Chat => "chat/completions",
            Route::Responses => "responses",
            Route::Models => unreachable!("inference test"),
        };
        let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("listener");
        let address = upstream.local_addr().expect("address");
        let provider_url = url::Url::parse(&format!("http://{address}/v1/{leaf}")).expect("url");
        let (observed_tx, mut observed_rx) = tokio::sync::mpsc::unbounded_channel();
        let upstream_server = tokio::spawn(async move {
            let (stream, _) = upstream.accept().await.expect("upstream connection");
            let service = service_fn(move |request: Request<Incoming>| {
                let observed = observed_tx.clone();
                async move {
                    let expected_key = request
                        .headers()
                        .get(http::header::AUTHORIZATION)
                        .is_some_and(|header| header == "Bearer synthetic-vendor-key");
                    let path = request.uri().path().to_owned();
                    let body = request
                        .into_body()
                        .collect()
                        .await
                        .expect("upstream body")
                        .to_bytes();
                    observed
                        .send((expected_key, path, body))
                        .expect("observe request");
                    let events = futures_util::stream::once(async {
                        Ok::<_, std::io::Error>(Frame::data(Bytes::from_static(b"data: first\n\n")))
                    })
                    .chain(futures_util::stream::pending());
                    Ok::<_, std::io::Error>(
                        Response::builder()
                            .header(CONTENT_TYPE, "text/event-stream")
                            .body(StreamBody::new(events))
                            .expect("SSE response"),
                    )
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
        let fake = FakeNano::start().await;
        let (account, _) = fake.signed_in().await;
        account.sign_out(false).await.expect("signed out");
        let relay = Relay::start(account).await.expect("relay");
        let (source, alive) = watch::channel(());
        let temp = tempfile::tempdir().expect("profile");
        let registry = ExternalProviderRegistry::with_memory(temp.path().join("providers.json"));
        let key = SecretString::new("synthetic-vendor-key".to_owned());
        let mut grant = if route == Route::Responses {
            registry.chatgpt.set_test_session("vendor/model", key).await;
            assert!(registry.grant_chatgpt("other").await.is_err());
            registry
                .grant_chatgpt("vendor/model")
                .await
                .expect("ChatGPT grant")
        } else {
            ExternalProviderGrant {
                provider: ExternalProvider {
                    id: "synthetic".to_owned(),
                    spec: ExternalProviderSpec {
                        name: "Synthetic provider".to_owned(),
                        base_url: String::new(),
                        model_id: "vendor/model".to_owned(),
                        request_format: Default::default(),
                    },
                },
                url: provider_url.clone(),
                auth: ExternalProviderAuth::ApiKey(key),
                alive,
            }
        };
        grant.url = provider_url;
        let lease = relay.register_external_provider(grant).expect("lease");
        // Use loopback HTTP in this transport test. Production endpoints and the
        // production client both require HTTPS.
        relay
            .shared
            .keys
            .lock()
            .expect("keys")
            .external_providers
            .get_mut(&lease.id)
            .expect("registered")
            .client = test_client();
        let client = test_client();
        let base = lease.base_url();
        let request = |model: &'static str| {
            client
                .post(format!("{base}/{leaf}"))
                .bearer_auth(lease.key().expose())
                .json(&serde_json::json!({ "model": model, "stream": true, "store": false, "input": [] }))
        };
        assert_eq!(
            request("other")
                .send()
                .await
                .expect("refused request")
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .get(format!("{base}/models"))
                .bearer_auth("wrong")
                .send()
                .await
                .expect("wrong key")
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut response = request("vendor/model")
            .send()
            .await
            .expect("stream response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.chunk().await.expect("chunk"),
            Some(Bytes::from_static(b"data: first\n\n"))
        );
        let (expected_key, path, body) = observed_rx.recv().await.expect("upstream request");
        assert!(expected_key);
        assert_eq!(path, format!("/v1/{leaf}"));
        assert!(!String::from_utf8_lossy(&body).contains(lease.key().expose()));
        assert!(observed_rx.try_recv().is_err());
        drop(source);
        registry
            .chatgpt
            .disconnect()
            .await
            .expect("disconnect ChatGPT");
        relay.retire_disconnected_external_providers();
        assert!(
            !relay
                .shared
                .keys
                .lock()
                .expect("keys")
                .external_providers
                .contains_key(&lease.id)
        );
        let ended = tokio::time::timeout(Duration::from_secs(5), response.chunk())
            .await
            .expect("revoked stream finishes");
        assert!(ended.is_err() || ended.expect("end of stream").is_none());
        assert_eq!(
            request("vendor/model")
                .send()
                .await
                .expect("revoked request")
                .status(),
            StatusCode::UNAUTHORIZED
        );
        upstream_server.abort();
    }
}
