use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::mpsc;

use super::*;
use crate::status::NanoAccountStateV1;
use crate::store::{CredentialStore, MemoryStore};
use crate::testing::{FakeNano, Gateway, test_client};
use crate::wire::tests::server_fixture;

struct Setup {
    fake: FakeNano,
    account: NanoAccount,
    store: Arc<MemoryStore>,
    relay: Relay,
    session: RelaySession,
}

async fn setup(entitlements: Option<Value>) -> Setup {
    let fake = FakeNano::start().await;
    if let Some(entitlements) = entitlements {
        fake.state().entitlements = entitlements;
    }
    let (account, store) = fake.signed_in().await;
    let relay = Relay::start(account.clone()).await.expect("relay");
    let session = relay
        .register_session(account.generation())
        .expect("session");
    Setup {
        fake,
        account,
        store,
        relay,
        session,
    }
}

fn chat_body(model: &str) -> String {
    json!({ "model": model, "messages": [{ "role": "user", "content": "hi" }], "stream": true })
        .to_string()
}

async fn post(relay: &Relay, key: &str, body: String) -> reqwest::Response {
    test_client()
        .post(format!("{}/chat/completions", relay.base_url()))
        .bearer_auth(key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .expect("send")
}

async fn openai_error_of(response: reqwest::Response) -> (u16, Value) {
    let status = response.status().as_u16();
    let body: Value = response.json().await.expect("error json");
    assert_eq!(body["error"]["type"], "nano");
    (status, body["error"].clone())
}

async fn raw(port: u16, request: String) -> String {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut answer = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut answer)).await;
    answer
}

#[tokio::test]
async fn streams_the_upstream_answer_without_buffering() {
    let s = setup(None).await;
    let (tx, rx) = mpsc::unbounded_channel();
    s.fake.state().gateway = Gateway::Stream(rx);
    let body = chat_body("free");
    let mut response = post(&s.relay, s.session.key().expose(), body.clone()).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()[reqwest::header::CONTENT_TYPE],
        "text/event-stream"
    );

    tx.send(Bytes::from_static(b"data: one\n\n"))
        .expect("send one");
    let first = tokio::time::timeout(Duration::from_secs(5), response.chunk())
        .await
        .expect("first chunk arrives before the stream ends")
        .expect("chunk")
        .expect("some");
    assert_eq!(first, Bytes::from_static(b"data: one\n\n"));
    tx.send(Bytes::from_static(b"data: [DONE]\n\n"))
        .expect("send done");
    drop(tx);
    let mut rest = Vec::new();
    while let Some(chunk) = response.chunk().await.expect("chunk") {
        rest.extend_from_slice(&chunk);
    }
    assert_eq!(rest, b"data: [DONE]\n\n");

    let calls = s.fake.state().gateway_calls.clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        "/api/desktop/v1/workspaces/ws_synthetic01/gateway/v1/chat/completions"
    );
    assert_eq!(calls[0].body, Bytes::from(body));
    assert_eq!(calls[0].authorization, "Bearer access-1");
    assert!(!calls[0].authorization.contains(s.session.key().expose()));
    // Diagnostics headers: the device id and an opaque random session tag,
    // never a key or token.
    assert_eq!(calls[0].device, "dev_synthetic01");
    let tag = calls[0].session.as_str();
    assert!(
        tag.len() == 36
            && tag.starts_with("ses_")
            && tag[4..].bytes().all(|c| c.is_ascii_hexdigit()),
        "{tag}"
    );
    assert!(!tag.contains(s.session.key().expose()));
    assert_ne!(tag, s.session.id().to_string());
    let clients = s.fake.state().clients.clone();
    assert!(!clients.is_empty());
    assert!(
        clients.iter().all(|client| client == "nano-desktop/0.3.0"),
        "{clients:?}"
    );
}

#[tokio::test]
async fn an_upstream_401_refreshes_once_and_retries() {
    let s = setup(None).await;
    s.fake.state().reject_access = Some("access-1".to_owned());
    let response = post(&s.relay, s.session.key().expose(), chat_body("fast")).await;
    assert_eq!(response.status(), 200);
    let auths: Vec<String> = s
        .fake
        .state()
        .gateway_calls
        .iter()
        .map(|call| call.authorization.clone())
        .collect();
    assert_eq!(auths, ["Bearer access-1", "Bearer access-2"]);
    assert_eq!(
        s.store
            .load()
            .expect("load")
            .map(|token| token.expose().to_owned())
            .as_deref(),
        Some("refresh-2")
    );
}

#[tokio::test]
async fn a_402_maps_to_credits_exhausted() {
    let s = setup(None).await;
    s.fake.state().gateway = Gateway::Refuse(402, "credits_exhausted");
    let response = post(&s.relay, s.session.key().expose(), chat_body("smart")).await;
    let (status, error) = openai_error_of(response).await;
    assert_eq!(status, 402);
    assert_eq!(error["code"], "nano_credits_exhausted");
    assert_ne!(error["message"], "synthetic");
    assert_eq!(
        s.account.status().last_error,
        Some(NanoError::CreditsExhausted)
    );
}

#[tokio::test]
async fn locked_and_unknown_modes_never_reach_upstream() {
    let s = setup(Some(server_fixture("entitlementsFree"))).await;
    for model in ["smart", "gpt-5"] {
        let response = post(&s.relay, s.session.key().expose(), chat_body(model)).await;
        let (status, error) = openai_error_of(response).await;
        assert_eq!(
            (status, error["code"].as_str()),
            (403, Some("nano_mode_locked")),
            "{model}"
        );
    }
    assert!(s.fake.state().gateway_calls.is_empty());
    let response = post(&s.relay, s.session.key().expose(), chat_body("free")).await;
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn an_oversize_body_is_refused() {
    let mut entitlements = server_fixture("entitlementsPaid");
    entitlements["limits"]["maxRequestBytes"] = json!(64);
    let s = setup(Some(entitlements)).await;
    let response = post(
        &s.relay,
        s.session.key().expose(),
        chat_body(&"x".repeat(200)),
    )
    .await;
    let (status, error) = openai_error_of(response).await;
    assert_eq!(status, 413);
    assert_eq!(error["code"], "nano_request_too_large");
    assert!(s.fake.state().gateway_calls.is_empty());
}

#[tokio::test]
async fn keys_methods_and_paths_are_enforced() {
    let s = setup(None).await;
    let client = test_client();
    let base = s.relay.base_url();

    let wrong = post(&s.relay, "wrong-key", chat_body("free")).await;
    assert_eq!(wrong.status(), 401);
    let missing = client
        .post(format!("{base}/chat/completions"))
        .body(chat_body("free"))
        .send()
        .await
        .expect("send");
    assert_eq!(missing.status(), 401);

    let key = s.session.key().expose().to_owned();
    let get_chat = client
        .get(format!("{base}/chat/completions"))
        .bearer_auth(&key)
        .send()
        .await
        .expect("send");
    assert_eq!(get_chat.status(), 405);
    let other = client
        .get(format!("{base}/embeddings"))
        .bearer_auth(&key)
        .send()
        .await
        .expect("send");
    assert_eq!(other.status(), 404);

    let second = s
        .relay
        .register_session(s.account.generation())
        .expect("second");
    let second_key = second.key().expose().to_owned();
    assert_eq!(
        post(&s.relay, &second_key, chat_body("free"))
            .await
            .status(),
        200
    );
    drop(second);
    assert_eq!(
        post(&s.relay, &second_key, chat_body("free"))
            .await
            .status(),
        401
    );
    assert!(s.fake.state().gateway_calls.len() == 1);
}

#[tokio::test]
async fn browser_requests_and_foreign_hosts_are_refused() {
    let s = setup(None).await;
    let client = test_client();
    let models = format!("{}/models", s.relay.base_url());
    let key = s.session.key().expose().to_owned();

    for (name, value) in [
        ("origin", "http://evil.example"),
        ("referer", "http://evil.example/"),
        ("sec-fetch-site", "cross-site"),
        ("sec-fetch-dest", "empty"),
    ] {
        let response = client
            .get(&models)
            .bearer_auth(&key)
            .header(name, value)
            .send()
            .await
            .expect("send");
        assert_eq!(response.status(), 403, "{name}");
    }
    // Node's fetch (Pi) always sends this one.
    let node = client
        .get(&models)
        .bearer_auth(&key)
        .header("sec-fetch-mode", "cors")
        .send()
        .await
        .expect("send");
    assert_eq!(node.status(), 200);

    let port = s.relay.port();
    let rebound = raw(
        port,
        format!(
            "GET /v1/models HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert!(rebound.starts_with("HTTP/1.1 403"), "{rebound}");
    let direct = raw(
        port,
        format!(
            "GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert!(direct.starts_with("HTTP/1.1 200"), "{direct}");
}

#[tokio::test]
async fn models_lists_only_entitled_modes_locally() {
    let s = setup(Some(server_fixture("entitlementsFree"))).await;
    let response = test_client()
        .get(format!("{}/models", s.relay.base_url()))
        .bearer_auth(s.session.key().expose())
        .send()
        .await
        .expect("send");
    let body: Value = response.json().await.expect("json");
    let ids: Vec<&str> = body["data"]
        .as_array()
        .expect("data")
        .iter()
        .map(|m| m["id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, ["free"]);
    assert!(s.fake.state().gateway_calls.is_empty());
}

#[tokio::test]
async fn a_signed_out_account_answers_sign_in_required() {
    let fake = FakeNano::start().await;
    let store: Arc<dyn CredentialStore> = Arc::new(MemoryStore::new());
    let account = NanoAccount::with_store(fake.config(), None, Some(store)).expect("account");
    let relay = Relay::start(account.clone()).await.expect("relay");
    let session = relay
        .register_session(account.generation())
        .expect("session");
    let response = post(&relay, session.key().expose(), chat_body("free")).await;
    let (status, error) = openai_error_of(response).await;
    assert_eq!(status, 401);
    assert_eq!(error["code"], "nano_sign_in_required");
}

#[tokio::test]
async fn the_concurrency_cap_is_enforced_and_released() {
    let mut entitlements = server_fixture("entitlementsPaid");
    entitlements["limits"]["maxConcurrentRequests"] = json!(1);
    let s = setup(Some(entitlements)).await;
    let key = s.session.key().expose().to_owned();
    let (tx, rx) = mpsc::unbounded_channel();
    s.fake.state().gateway = Gateway::Stream(rx);
    let held = post(&s.relay, &key, chat_body("free")).await;
    assert_eq!(held.status(), 200);

    let (status, error) = openai_error_of(post(&s.relay, &key, chat_body("free")).await).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (429, Some("nano_rate_limited"))
    );

    drop(tx);
    let _ = held.bytes().await;
    let mut released = false;
    for _ in 0..40 {
        if post(&s.relay, &key, chat_body("free")).await.status() == 200 {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(released);
}

#[test]
fn relay_session_debug_is_redacted() {
    let session = RelaySession {
        id: 7,
        port: 4000,
        key: SecretString::new("synthetic-relay-key".to_owned()),
        shared: Weak::new(),
    };
    assert!(!format!("{session:?}").contains("synthetic"));
    assert_eq!(session.base_url(), "http://127.0.0.1:4000/s/7/v1");
}

#[tokio::test]
async fn a_session_scoped_path_accepts_only_its_own_key() {
    let s = setup(None).await;
    let other = s
        .relay
        .register_session(s.account.generation())
        .expect("other");
    let client = test_client();
    let own = format!("{}/models", s.session.base_url());

    let ok = client
        .get(&own)
        .bearer_auth(s.session.key().expose())
        .send()
        .await
        .expect("send");
    assert_eq!(ok.status(), 200);
    let foreign = client
        .get(&own)
        .bearer_auth(other.key().expose())
        .send()
        .await
        .expect("send");
    assert_eq!(foreign.status(), 401);

    let chat = client
        .post(format!("{}/chat/completions", s.session.base_url()))
        .bearer_auth(s.session.key().expose())
        .body(chat_body("free"))
        .send()
        .await
        .expect("send");
    assert_eq!(chat.status(), 200);

    let port = s.relay.port();
    let key = s.session.key().expose().to_owned();
    for (path, status) in [
        ("/s/abc/v1/models", 404),
        ("/s//v1/models", 404),
        ("/s/1/2/v1/models", 404),
        ("/s/999999/v1/models", 401),
    ] {
        let response = client
            .get(format!("http://127.0.0.1:{port}{path}"))
            .bearer_auth(&key)
            .send()
            .await
            .expect("send");
        assert_eq!(response.status(), status, "{path}");
    }
    assert_eq!(s.fake.state().gateway_calls.len(), 1);
}

async fn wait_until_closed(relay: &Relay) {
    for _ in 0..200 {
        if relay
            .shared
            .keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .live
            .is_empty()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the relay never closed its sessions");
}

#[tokio::test]
async fn sign_out_closes_every_session_and_cuts_open_streams() {
    let s = setup(None).await;
    let (tx, rx) = mpsc::unbounded_channel();
    s.fake.state().gateway = Gateway::Stream(rx);
    let key = s.session.key().expose().to_owned();
    let mut response = post(&s.relay, &key, chat_body("free")).await;
    assert_eq!(response.status(), 200);
    tx.send(Bytes::from_static(
        b"data: one

",
    ))
    .expect("send one");
    let first = tokio::time::timeout(Duration::from_secs(5), response.chunk())
        .await
        .expect("first chunk")
        .expect("chunk");
    assert!(first.is_some());

    s.account.sign_out(false).await.expect("sign out");
    wait_until_closed(&s.relay).await;

    let ended = tokio::time::timeout(Duration::from_secs(5), response.chunk())
        .await
        .expect("the stream ends after sign-out");
    assert!(!matches!(ended, Ok(Some(_))), "no data after sign-out");
    let _ = tx.send(Bytes::from_static(
        b"data: late

",
    ));

    let (status, error) = openai_error_of(post(&s.relay, &key, chat_body("free")).await).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (401, Some("nano_sign_in_required"))
    );
    assert!(matches!(
        s.relay.shared.check_key(&bearer_headers(&key), None),
        KeyCheck::Retired
    ));
}

#[tokio::test]
async fn close_all_sessions_retires_keys_explicitly() {
    let s = setup(None).await;
    let key = s.session.key().expose().to_owned();
    s.relay.close_all_sessions();
    let (status, error) = openai_error_of(post(&s.relay, &key, chat_body("free")).await).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (401, Some("nano_sign_in_required"))
    );
    assert!(s.fake.state().gateway_calls.is_empty());
    let fresh = s
        .relay
        .register_session(s.account.generation())
        .expect("fresh");
    assert_eq!(
        post(&s.relay, fresh.key().expose(), chat_body("free"))
            .await
            .status(),
        200
    );
}

fn bearer_headers(key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {key}")).expect("header"),
    );
    headers
}

/// Sends the head and the first bytes of a chat request whose body is never
/// completed, as a caller holding a key could.
async fn partial_upload(port: u16, key: &str, declared: usize) -> tokio::net::TcpStream {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let head = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {key}\r\nContent-Type: application/json\r\nContent-Length: {declared}\r\n\r\n{{\"model\":"
    );
    stream.write_all(head.as_bytes()).await.expect("write");
    stream
}

/// Reads until `needle` arrives or five seconds pass.
async fn read_until(stream: &mut tokio::net::TcpStream, needle: &str) -> String {
    let mut answer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    answer.extend_from_slice(&chunk[..read]);
                    if String::from_utf8_lossy(&answer).contains(needle) {
                        return;
                    }
                }
            }
        }
    })
    .await;
    String::from_utf8_lossy(&answer).into_owned()
}

async fn wait_for_inflight(relay: &Relay, count: usize) {
    for _ in 0..200 {
        if relay.shared.inflight.load(Ordering::SeqCst) == count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the relay never reached {count} requests in flight");
}

async fn wait_for_gateway_calls(fake: &FakeNano, count: usize) {
    for _ in 0..200 {
        if fake.state().gateway_calls.len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the gateway never saw {count} calls");
}

#[tokio::test]
async fn a_launch_of_an_ended_generation_registers_nothing() {
    let s = setup(None).await;
    let before = s.account.generation();
    s.account.sign_out(false).await.expect("sign out");
    assert_eq!(
        s.relay.register_session(before).err(),
        Some(NanoError::SignInRequired)
    );
    wait_until_closed(&s.relay).await;
    assert!(
        s.relay
            .shared
            .keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .live
            .is_empty()
    );
}

#[tokio::test]
async fn a_sign_out_during_the_upload_refuses_the_request_and_never_forwards_it() {
    let s = setup(None).await;
    let mut upload = partial_upload(s.relay.port(), s.session.key().expose(), 4096).await;
    wait_for_inflight(&s.relay, 1).await;

    s.account.sign_out(false).await.expect("sign out");
    let answer = read_until(&mut upload, "nano_sign_in_required").await;
    assert!(answer.starts_with("HTTP/1.1 401"), "{answer}");
    assert!(answer.contains("nano_sign_in_required"), "{answer}");
    assert!(s.fake.state().gateway_calls.is_empty());
    wait_for_inflight(&s.relay, 0).await;
}

#[tokio::test]
async fn dropping_a_session_ends_its_pending_upstream_request() {
    let s = setup(None).await;
    s.fake.state().gateway = Gateway::Hang;
    let relay_url = s.relay.base_url();
    let key = s.session.key().expose().to_owned();
    let pending = tokio::spawn(async move {
        test_client()
            .post(format!("{relay_url}/chat/completions"))
            .bearer_auth(key)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(chat_body("free"))
            .send()
            .await
            .expect("send")
    });
    wait_for_gateway_calls(&s.fake, 1).await;

    drop(s.session);
    let response = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .expect("the request ends when its session is dropped")
        .expect("task");
    let (status, error) = openai_error_of(response).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (401, Some("nano_sign_in_required"))
    );
    wait_for_inflight(&s.relay, 0).await;
}

#[tokio::test]
async fn dropping_a_session_cuts_its_open_stream_only() {
    let s = setup(None).await;
    let other = s
        .relay
        .register_session(s.account.generation())
        .expect("other");
    let (tx, rx) = mpsc::unbounded_channel();
    s.fake.state().gateway = Gateway::Stream(rx);
    let mut response = post(&s.relay, s.session.key().expose(), chat_body("free")).await;
    assert_eq!(response.status(), 200);
    tx.send(Bytes::from_static(b"data: one\n\n")).expect("send");
    let first = tokio::time::timeout(Duration::from_secs(5), response.chunk())
        .await
        .expect("first chunk")
        .expect("chunk");
    assert!(first.is_some());

    drop(s.session);
    let ended = tokio::time::timeout(Duration::from_secs(5), response.chunk())
        .await
        .expect("the stream ends with its session");
    assert!(!matches!(ended, Ok(Some(_))), "no data after the drop");
    // Another session of the same account is untouched.
    assert_eq!(
        post(&s.relay, other.key().expose(), chat_body("free"))
            .await
            .status(),
        200
    );
}

#[tokio::test]
async fn the_concurrency_slot_is_taken_before_the_body_is_read() {
    let mut entitlements = server_fixture("entitlementsPaid");
    entitlements["limits"]["maxConcurrentRequests"] = json!(1);
    let s = setup(Some(entitlements)).await;
    let key = s.session.key().expose().to_owned();
    let parked = partial_upload(s.relay.port(), &key, 4096).await;
    wait_for_inflight(&s.relay, 1).await;

    let (status, error) = openai_error_of(post(&s.relay, &key, chat_body("free")).await).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (429, Some("nano_rate_limited"))
    );
    drop(parked);
    wait_for_inflight(&s.relay, 0).await;
    assert_eq!(post(&s.relay, &key, chat_body("free")).await.status(), 200);
}

#[tokio::test]
async fn an_upload_past_its_deadline_is_refused_and_frees_its_slot() {
    let fake = FakeNano::start().await;
    let (account, _store) = fake.signed_in().await;
    let relay = Relay::start_with(account.clone(), Duration::from_millis(200))
        .await
        .expect("relay");
    let session = relay
        .register_session(account.generation())
        .expect("session");
    let mut upload = partial_upload(relay.port(), session.key().expose(), 4096).await;
    let answer = read_until(&mut upload, "\r\n\r\n").await;
    assert!(answer.starts_with("HTTP/1.1 408"), "{answer}");
    wait_for_inflight(&relay, 0).await;
    assert!(fake.state().gateway_calls.is_empty());
    assert_eq!(
        post(&relay, session.key().expose(), chat_body("free"))
            .await
            .status(),
        200
    );
}

#[tokio::test]
async fn a_new_generation_retires_only_the_sessions_of_earlier_ones() {
    let s = setup(None).await;
    let old_key = s.session.key().expose().to_owned();
    s.account.sign_out(false).await.expect("sign out");
    wait_until_closed(&s.relay).await;

    // The same person signs in again (a stored credential, as on restart).
    s.store
        .save(&SecretString::new("refresh-1".to_owned()))
        .expect("store");
    s.account.restore().await;
    assert_eq!(s.account.status().state, NanoAccountStateV1::SignedIn);
    let fresh = s
        .relay
        .register_session(s.account.generation())
        .expect("fresh");
    // Let the relay observe every published change first.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        post(&s.relay, fresh.key().expose(), chat_body("free"))
            .await
            .status(),
        200
    );
    let (status, error) = openai_error_of(post(&s.relay, &old_key, chat_body("free")).await).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (401, Some("nano_sign_in_required"))
    );
}

#[tokio::test]
async fn a_request_of_an_ended_generation_is_never_sent_upstream() {
    let s = setup(None).await;
    let before = s.account.generation();
    s.account.sign_out(false).await.expect("sign out");
    let sent = s
        .account
        .send_gateway(
            before,
            "ses_test",
            &["chat", "completions"],
            reqwest::Method::POST,
            Some(Bytes::from(chat_body("free"))),
            None,
        )
        .await;
    assert_eq!(sent.err(), Some(NanoError::SignInRequired));
    assert!(s.fake.state().gateway_calls.is_empty());
    // The failure of an ended generation is not recorded on the account.
    s.account
        .report_server_error(before, NanoError::CreditsExhausted);
    assert_eq!(s.account.status().last_error, None);
}
