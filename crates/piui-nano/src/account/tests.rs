use std::io::{Read as _, Write as _};
use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdListener};

use super::*;
use crate::store::MemoryStore;
use crate::testing::{FakeNano, wait_for};

/// A loopback origin where nothing listens.
fn dead_config() -> NanoConfig {
    let listener = StdListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    NanoConfig::from_parts(Some(&format!("http://127.0.0.1:{port}")), "0.3.0").expect("config")
}

fn stored(store: &MemoryStore) -> Option<String> {
    store
        .load()
        .expect("load")
        .map(|token| token.expose().to_owned())
}

/// A browser stand-in: answers the authorization URL with `code-ok` from a
/// separate thread, as the system browser would.
fn browser_returning(code: &'static str, seen: Arc<Mutex<Option<Url>>>) -> OpenBrowser {
    Box::new(move |url: &Url| -> Result<(), ()> {
        *seen.lock().expect("seen") = Some(url.clone());
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        let redirect = Url::parse(&get("redirect_uri")).expect("redirect");
        let port = redirect.port().expect("port");
        let state = get("state");
        // RFC 9207: the authorization server names itself in the redirect.
        let iss: String =
            url::form_urlencoded::byte_serialize(url.origin().ascii_serialization().as_bytes())
                .collect();
        std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
            write!(
                stream,
                "GET /callback?code={code}&state={state}&iss={iss} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
            )
            .expect("write");
            let mut answer = String::new();
            let _ = stream.read_to_string(&mut answer);
        });
        Ok(())
    })
}

#[tokio::test]
async fn restore_without_a_token_stays_signed_out_and_offline_free() {
    let account = NanoAccount::with_store(dead_config(), None, Some(Arc::new(MemoryStore::new())))
        .expect("account");
    account.restore().await;
    let status = account.status();
    assert_eq!(status.state, NanoAccountStateV1::SignedOut);
    assert_eq!(status.last_error, None);
    assert!(status.capabilities.is_none());
    assert!(!status.busy);
}

#[tokio::test]
async fn restore_signs_in_rotates_and_loads_the_workspace() {
    let fake = FakeNano::start().await;
    let (account, store) = fake.signed_in().await;
    let status = account.status();
    assert_eq!(
        status.selected_workspace_id.as_deref(),
        Some("ws_synthetic01")
    );
    assert_eq!(status.workspaces.len(), 2);
    assert_eq!(
        status.user.as_ref().map(|u| u.display_name.as_str()),
        Some("Synthetic Person")
    );
    assert_eq!(
        status.device.as_ref().map(|d| d.id.as_str()),
        Some("dev_synthetic01")
    );
    assert!(status.entitlements.is_some());
    assert!(status.usage.is_some());
    assert!(status.capabilities.is_some());
    assert_eq!(status.credential_store, Some(NanoCredentialStoreV1::Memory));
    assert_eq!(status.last_error, None);
    assert!(!status.busy);
    assert_eq!(stored(&store).as_deref(), Some("refresh-1"));
    assert_eq!(fake.state().grants, ["refresh_token"]);

    let json = serde_json::to_string(&status).expect("json");
    assert!(!json.contains("access-") && !json.contains("refresh-"));
    assert!(!format!("{account:?}").contains("refresh-"));
}

#[tokio::test]
async fn a_refused_refresh_token_expires_and_is_deleted() {
    let fake = FakeNano::start().await;
    fake.state().valid_refresh = "something-else".to_owned();
    let (account, store) = fake.account_with_stored_token();
    account.restore().await;
    let status = account.status();
    assert_eq!(status.state, NanoAccountStateV1::Expired);
    assert_eq!(status.last_error, Some(NanoError::SignInRequired));
    assert_eq!(status.credential_store, None);
    assert_eq!(stored(&store), None);
}

#[tokio::test]
async fn an_unreachable_server_is_offline_and_keeps_the_token() {
    let store = Arc::new(MemoryStore::with_token(SecretString::new(
        "refresh-0".to_owned(),
    )));
    let dyn_store: Arc<dyn CredentialStore> = store.clone();
    let account = NanoAccount::with_store(dead_config(), None, Some(dyn_store)).expect("account");
    account.restore().await;
    let status = account.status();
    assert_eq!(status.state, NanoAccountStateV1::Offline);
    assert_eq!(status.last_error, Some(NanoError::Offline));
    assert_eq!(stored(&store).as_deref(), Some("refresh-0"));
    assert_eq!(
        account.refresh().await.map(|s| s.state),
        Err(NanoError::Offline)
    );
}

#[tokio::test]
async fn sign_in_completes_through_the_loopback_redirect() {
    let fake = FakeNano::start().await;
    let store = Arc::new(MemoryStore::new());
    let dyn_store: Arc<dyn CredentialStore> = store.clone();
    let account = NanoAccount::with_store(fake.config(), None, Some(dyn_store)).expect("account");
    let seen = Arc::new(Mutex::new(None));
    let first = account
        .begin_sign_in(browser_returning("code-ok", seen.clone()))
        .await
        .expect("begin");
    assert_eq!(first.state, NanoAccountStateV1::SigningIn);
    assert!(first.busy);
    assert_eq!(
        account
            .begin_sign_in(Box::new(|_: &Url| -> Result<(), ()> { Ok(()) }))
            .await
            .err(),
        Some(NanoError::Busy)
    );

    let status = wait_for(&account, |s| {
        s.state == NanoAccountStateV1::SignedIn && !s.busy
    })
    .await;
    assert_eq!(
        status.selected_workspace_id.as_deref(),
        Some("ws_synthetic01")
    );
    assert_eq!(stored(&store).as_deref(), Some("refresh-1"));
    assert_eq!(fake.state().grants, ["authorization_code"]);
    assert_eq!(fake.state().device_names, [oauth::device_name()]);

    let url = seen.lock().expect("seen").clone().expect("browser opened");
    assert!(
        url.as_str()
            .starts_with(&format!("{}/connect/authorize?", fake.origin))
    );
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    assert!(pairs.contains(&("code_challenge_method".to_owned(), "S256".to_owned())));
    assert!(pairs.contains(&("client_id".to_owned(), "nano-desktop".to_owned())));
    assert!(!url.as_str().contains("code_verifier"));

    assert_eq!(
        account
            .begin_sign_in(Box::new(|_: &Url| -> Result<(), ()> { Ok(()) }))
            .await
            .err(),
        Some(NanoError::Invalid)
    );
}

#[tokio::test]
async fn a_refused_code_fails_sign_in_back_to_signed_out() {
    let fake = FakeNano::start().await;
    let account = NanoAccount::with_store(fake.config(), None, None).expect("account");
    let seen = Arc::new(Mutex::new(None));
    account
        .begin_sign_in(browser_returning("code-bad", seen))
        .await
        .expect("begin");
    let status = wait_for(&account, |s| {
        s.state == NanoAccountStateV1::SignedOut && s.last_error.is_some()
    })
    .await;
    assert_eq!(status.last_error, Some(NanoError::SignInFailed));
}

#[tokio::test]
async fn a_browser_failure_is_reported() {
    let fake = FakeNano::start().await;
    let account = NanoAccount::with_store(fake.config(), None, None).expect("account");
    account
        .begin_sign_in(Box::new(|_: &Url| -> Result<(), ()> { Err(()) }))
        .await
        .expect("begin");
    let status = wait_for(&account, |s| s.state == NanoAccountStateV1::SignedOut).await;
    assert_eq!(status.last_error, Some(NanoError::BrowserFailed));
}

#[tokio::test]
async fn cancel_restores_the_previous_state() {
    let fake = FakeNano::start().await;
    let account = NanoAccount::with_store(fake.config(), None, None).expect("account");
    account
        .begin_sign_in(Box::new(|_: &Url| -> Result<(), ()> { Ok(()) }))
        .await
        .expect("begin");
    let status = account.cancel_sign_in();
    assert_eq!(status.state, NanoAccountStateV1::SignedOut);
    assert_eq!(status.last_error, None);
    assert!(!status.busy);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(account.status().state, NanoAccountStateV1::SignedOut);
    // Cancelling again is a no-op.
    assert_eq!(
        account.cancel_sign_in().state,
        NanoAccountStateV1::SignedOut
    );
}

#[tokio::test]
async fn sign_out_revokes_and_forgets() {
    let fake = FakeNano::start().await;
    let (account, store) = fake.signed_in().await;
    let status = account.sign_out(true).await.expect("sign out");
    assert_eq!(status.state, NanoAccountStateV1::SignedOut);
    assert!(status.user.is_none() && status.entitlements.is_none() && status.workspaces.is_empty());
    assert_eq!(status.credential_store, None);
    assert_eq!(stored(&store), None);
    assert_eq!(fake.state().revoked, ["refresh-1"]);
    assert_eq!(
        account.access_token().await.err(),
        Some(NanoError::SignInRequired)
    );
}

#[tokio::test]
async fn safe_mode_sign_out_makes_no_network_call() {
    let fake = FakeNano::start().await;
    let (account, store) = fake.signed_in().await;
    account.sign_out(false).await.expect("sign out");
    assert!(fake.state().revoked.is_empty());
    assert_eq!(stored(&store), None);
}

#[tokio::test]
async fn select_workspace_loads_its_entitlements_and_is_remembered() {
    let fake = FakeNano::start().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let prefs = dir.path().join("nano-account.json");
    let store = Arc::new(MemoryStore::with_token(SecretString::new(
        "refresh-0".to_owned(),
    )));
    let dyn_store: Arc<dyn CredentialStore> = store.clone();
    let account = NanoAccount::with_store(fake.config(), Some(prefs.clone()), Some(dyn_store))
        .expect("account");
    account.restore().await;
    assert_eq!(
        account.select_workspace("ws_missing").await.err(),
        Some(NanoError::WorkspaceNotFound)
    );
    let status = account
        .select_workspace("ws_synthetic02")
        .await
        .expect("select");
    assert_eq!(
        status.selected_workspace_id.as_deref(),
        Some("ws_synthetic02")
    );
    assert!(status.entitlements.is_none());
    let loaded = wait_for(&account, |s| {
        s.entitlements
            .as_ref()
            .is_some_and(|e| e.workspace_id == "ws_synthetic02")
    })
    .await;
    assert_eq!(
        loaded.selected_workspace_id.as_deref(),
        Some("ws_synthetic02")
    );

    let again: Arc<dyn CredentialStore> = store.clone();
    let second = NanoAccount::with_store(fake.config(), Some(prefs), Some(again)).expect("second");
    second.restore().await;
    assert_eq!(
        second.status().selected_workspace_id.as_deref(),
        Some("ws_synthetic02")
    );
}

#[tokio::test]
async fn a_revoked_session_expires_on_refresh() {
    let fake = FakeNano::start().await;
    let (account, store) = fake.signed_in().await;
    {
        let mut state = fake.state();
        state.current_access = "server-forgot".to_owned();
        state.valid_refresh = "server-forgot".to_owned();
    }
    assert_eq!(
        account.refresh().await.err(),
        Some(NanoError::SignInRequired)
    );
    let status = account.status();
    assert_eq!(status.state, NanoAccountStateV1::Expired);
    assert!(status.user.is_some());
    assert_eq!(stored(&store), None);
}

#[tokio::test]
async fn links_come_from_discovery() {
    let fake = FakeNano::start().await;
    let account = NanoAccount::with_store(fake.config(), None, None).expect("account");
    let billing = account.link(NanoLinkV1::Billing).await.expect("billing");
    assert_eq!(billing.as_str(), format!("{}/billing", fake.origin));
    // The cloud window belongs to a signed-in account only.
    assert_eq!(
        account.cloud_url().await.err(),
        Some(NanoError::SignInRequired)
    );
    let (signed_in, _store) = fake.signed_in().await;
    let cloud = signed_in.cloud_url().await.expect("cloud");
    assert_eq!(cloud.as_str(), format!("{}/cloud", fake.origin));
}

async fn wait_for_token_requests(fake: &FakeNano, count: u32) {
    for _ in 0..500 {
        if fake.state().token_requests >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the token endpoint never saw {count} requests");
}

async fn wait_for_revoked(fake: &FakeNano, token: &str) {
    for _ in 0..500 {
        if fake.state().revoked.iter().any(|revoked| revoked == token) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{token} was never revoked: {:?}", fake.state().revoked);
}

#[tokio::test]
async fn a_cancel_during_the_code_exchange_revokes_the_issued_tokens() {
    let fake = FakeNano::start().await;
    let gate = Arc::new(tokio::sync::Notify::new());
    fake.state().token_gate = Some(gate.clone());
    let store = Arc::new(MemoryStore::new());
    let dyn_store: Arc<dyn CredentialStore> = store.clone();
    let account = NanoAccount::with_store(fake.config(), None, Some(dyn_store)).expect("account");
    account
        .begin_sign_in(browser_returning("code-ok", Arc::new(Mutex::new(None))))
        .await
        .expect("begin");
    wait_for_token_requests(&fake, 1).await;

    let status = account.cancel_sign_in();
    assert_eq!(status.state, NanoAccountStateV1::SignedOut);
    gate.notify_one();
    wait_for_revoked(&fake, "refresh-1").await;

    tokio::time::sleep(Duration::from_millis(100)).await;
    let status = account.status();
    assert_eq!(status.state, NanoAccountStateV1::SignedOut);
    assert!(status.user.is_none());
    assert_eq!(stored(&store), None);
    assert_eq!(fake.state().grants, ["authorization_code"]);
}

#[tokio::test]
async fn a_sign_out_during_a_retry_refresh_never_replays_the_request() {
    let fake = FakeNano::start().await;
    let (account, store) = fake.signed_in().await;
    let gate = Arc::new(tokio::sync::Notify::new());
    {
        let mut state = fake.state();
        state.reject_access = Some("access-1".to_owned());
        state.token_gate = Some(gate.clone());
    }
    let generation = account.generation();
    let sender = account.clone();
    let sent = tokio::spawn(async move {
        sender
            .send_gateway(
                generation,
                "ses_test",
                &["chat", "completions"],
                reqwest::Method::POST,
                Some(Bytes::from_static(b"{}")),
                None,
            )
            .await
            .map(|response| response.status())
    });
    // The first attempt was refused; the retry waits for its refresh.
    wait_for_token_requests(&fake, 2).await;

    let signer = account.clone();
    let signed_out = tokio::spawn(async move { signer.sign_out(false).await });
    wait_for(&account, |s| s.state == NanoAccountStateV1::SignedOut).await;
    gate.notify_one();

    let sent = tokio::time::timeout(Duration::from_secs(5), sent)
        .await
        .expect("the retry ends")
        .expect("task");
    assert_eq!(sent.err(), Some(NanoError::SignInRequired));
    signed_out.await.expect("task").expect("sign out");
    let calls = fake.state().gateway_calls.clone();
    assert_eq!(calls.len(), 1, "no replay after sign-out");
    assert_eq!(calls[0].authorization, "Bearer access-1");
    // The rotated token of the ended generation is not kept.
    wait_for_revoked(&fake, "refresh-2").await;
    assert_eq!(stored(&store), None);
    assert_eq!(
        account.access_token().await.err(),
        Some(NanoError::SignInRequired)
    );
}

#[test]
fn audio_mime_accepts_audio_only() {
    assert_eq!(audio_mime("audio/webm;codecs=opus"), Some("audio/webm"));
    assert_eq!(audio_mime("audio/x-wav"), Some("audio/x-wav"));
    assert_eq!(audio_mime("video/webm"), None);
    assert_eq!(audio_mime("audio/"), None);
    assert_eq!(audio_mime("audio/we\r\nbm"), None);
}
