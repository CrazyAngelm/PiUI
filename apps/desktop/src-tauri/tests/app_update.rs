//! Signed updates with a Tauri app (MockRuntime) and the real updater plugin.
//!
//! Integration tests receive the Windows common-controls manifest that
//! MockRuntime needs to load (see `build.rs`); lib unit tests do not. The feed
//! and artifacts come from a loopback HTTP server; nothing leaves 127.0.0.1.
#![cfg(debug_assertions)]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use piui_desktop_lib::app_update::{
    AppUpdateAvailableV1, AppUpdateCheckOutcome, AppUpdateErrorCode, AppUpdatePhase,
    AppUpdateState, SETTINGS_FILE, app_update_restart_v1, check, download_verified, install,
    install_version, load_auto_check, save_auto_check, set_auto_check,
};
use serde_json::{Value, json};
use tauri::Manager;
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// minisign's published test vector (minisign-verify's own tests): a public
/// key and its signature of the four bytes `test`. No signing key is involved.
const TEST_PUBLIC_KEY_FILE: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
const TEST_SIGNATURE_FILE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n";

fn encoded(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn test_public_key() -> String {
    encoded(TEST_PUBLIC_KEY_FILE)
}

fn temporary_directory(purpose: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "piui-app-update-{purpose}-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&directory).expect("creates a test directory");
    directory
}

fn mock_app(updater: Option<Value>) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    if let Some(updater) = updater {
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), updater);
    }
    mock_builder().build(context).expect("builds a mock app")
}

#[tokio::test]
async fn an_unconfigured_build_never_registers_the_updater() {
    let directory = temporary_directory("unconfigured");
    // A preference left by another build does not turn checks on here.
    save_auto_check(&directory.join(SETTINGS_FILE), true).expect("saves a preference");
    let app = mock_app(None);
    install(&app, &directory, false);
    let handle = app.handle().clone();
    let updates = handle.state::<AppUpdateState>();
    let status = updates.status(&handle);
    assert!(!status.configured);
    assert!(!status.auto_check);
    assert_eq!(status.feed_host, None);
    assert_eq!(status.phase, AppUpdatePhase::Idle);
    assert_eq!(status.current_version, "0.1.0");
    assert_eq!(
        check(&handle, &updates, false).await,
        Err(AppUpdateErrorCode::NotConfigured.into())
    );
    assert_eq!(
        install_version(&handle, &updates, "9.9.9").await,
        Err(AppUpdateErrorCode::NotConfigured.into())
    );
    assert_eq!(
        set_auto_check(&handle, &updates, false),
        Err(AppUpdateErrorCode::NotConfigured.into())
    );
    assert_eq!(
        app_update_restart_v1(handle.clone(), handle.state::<AppUpdateState>()),
        Err(AppUpdateErrorCode::Invalid.into())
    );
    assert!(
        !handle.remove_plugin("updater"),
        "the plugin is never registered"
    );
    fs::remove_dir_all(directory).expect("removes the test directory");
}

#[tokio::test]
async fn unsafe_sections_leave_the_plugin_unregistered() {
    let directory = temporary_directory("unsafe");
    let app = mock_app(Some(json!({
        "pubkey": test_public_key(),
        "endpoints": ["https://updates.example.test/latest.json"],
        "allowDowngrades": true
    })));
    install(&app, &directory, false);
    assert!(
        !app.state::<AppUpdateState>()
            .status(app.handle())
            .configured
    );
    assert!(!app.handle().remove_plugin("updater"));
    fs::remove_dir_all(directory).expect("removes the test directory");
}

#[tokio::test]
async fn a_configured_build_registers_the_updater_and_saves_the_preference() {
    let directory = temporary_directory("configured");
    let app = mock_app(Some(json!({
        "pubkey": test_public_key(),
        "endpoints": ["https://updates.example.test/piui/latest.json"],
        "windows": { "installMode": "passive" }
    })));
    // Safe mode starts no automatic loop; nothing here contacts the endpoint.
    install(&app, &directory, true);
    let handle = app.handle().clone();
    let updates = handle.state::<AppUpdateState>();
    let status = updates.status(&handle);
    assert!(status.configured);
    assert_eq!(status.feed_host.as_deref(), Some("updates.example.test"));
    assert!(!status.auto_check, "automatic checks are off by default");
    let status = set_auto_check(&handle, &updates, true).expect("turns checks on");
    assert!(status.auto_check);
    assert!(load_auto_check(&directory.join(SETTINGS_FILE)));
    assert!(
        !set_auto_check(&handle, &updates, false)
            .expect("turns checks off")
            .auto_check
    );
    assert!(!load_auto_check(&directory.join(SETTINGS_FILE)));
    assert_eq!(
        install_version(&handle, &updates, "9.9.9").await,
        Err(AppUpdateErrorCode::NotAvailable.into()),
        "nothing installs before a check found this version"
    );
    assert!(handle.remove_plugin("updater"));
    fs::remove_dir_all(directory).expect("removes the test directory");
}

type Routes = Arc<Mutex<HashMap<String, (u16, Vec<u8>)>>>;

/// A loopback HTTP/1.1 server with replaceable routes, for the update feed
/// and the artifact.
async fn serve(routes: Routes) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binds a loopback port");
    let port = listener.local_addr().expect("reads the port").port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let routes = routes.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => request.extend_from_slice(&buffer[..read]),
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let path = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let (status, body) = routes
                    .lock()
                    .expect("reads routes")
                    .get(&path)
                    .cloned()
                    .unwrap_or((404, Vec::new()));
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&body).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    port
}

/// Every key the updater may look up for this machine.
fn feed_platforms(url: &str, signature: &str) -> Value {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    let arch = match std::env::consts::ARCH {
        "x86" => "i686",
        "arm" => "armv7",
        other => other,
    };
    let entry = json!({ "url": url, "signature": signature });
    let mut platforms = serde_json::Map::new();
    platforms.insert(format!("{os}-{arch}"), entry.clone());
    for installer in ["nsis", "msi", "appimage", "deb", "rpm", "app"] {
        platforms.insert(format!("{os}-{arch}-{installer}"), entry.clone());
    }
    Value::Object(platforms)
}

fn feed(port: u16, artifact: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "version": "9.9.9",
        "notes": "Faster runs.\r\n\u{1b}Fixed the sidebar.",
        "pub_date": "2026-09-27T12:00:00+02:00",
        "platforms": feed_platforms(
            &format!("http://127.0.0.1:{port}/{artifact}"),
            &encoded(TEST_SIGNATURE_FILE),
        ),
    }))
    .expect("encodes the feed")
}

/// The plugin with a plain-HTTP loopback feed. The host gate refuses such a
/// section, so the configured state is built with the debug-only test helper.
fn loopback_app(port: u16, directory: &std::path::Path) -> tauri::App<MockRuntime> {
    let app = mock_app(Some(json!({
        "pubkey": test_public_key(),
        "endpoints": [format!("http://127.0.0.1:{port}/latest.json")],
        "dangerousInsecureTransportProtocol": true
    })));
    app.handle()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .expect("registers the updater");
    app.manage(AppUpdateState::configured_for_tests("127.0.0.1", directory));
    app
}

#[tokio::test]
async fn checks_offer_an_update_and_every_download_is_signature_verified() {
    let routes: Routes = Arc::default();
    let port = serve(routes.clone()).await;
    routes.lock().expect("routes").extend([
        ("/artifact-good".to_owned(), (200, b"test".to_vec())),
        ("/artifact-tampered".to_owned(), (200, b"Test".to_vec())),
        (
            "/latest.json".to_owned(),
            (200, feed(port, "artifact-good")),
        ),
    ]);
    let directory = temporary_directory("feed");
    let app = loopback_app(port, &directory);
    let handle = app.handle().clone();
    let updates = handle.state::<AppUpdateState>();

    let status = check(&handle, &updates, false)
        .await
        .expect("checks the feed");
    assert_eq!(status.phase, AppUpdatePhase::Idle);
    assert_eq!(
        status.available,
        Some(AppUpdateAvailableV1 {
            version: "9.9.9".into(),
            date: Some("2026-09-27T10:00:00Z".into()),
            notes: Some("Faster runs.\nFixed the sidebar.".into()),
        })
    );
    let last_check = status.last_check.expect("records the check");
    assert_eq!(last_check.outcome, AppUpdateCheckOutcome::Available);
    assert!(!last_check.automatic);
    assert_eq!(last_check.error, None);

    // The signed artifact verifies against the configured public key.
    let update = updates.pending_update().expect("keeps the offered update");
    assert_eq!(
        download_verified(&handle, &update).await,
        Ok(b"test".to_vec())
    );

    // Only the version the check found can be installed.
    assert_eq!(
        install_version(&handle, &updates, "9.9.8").await,
        Err(AppUpdateErrorCode::NotAvailable.into())
    );
    assert_eq!(
        install_version(&handle, &updates, "9.9.9; echo").await,
        Err(AppUpdateErrorCode::Invalid.into())
    );

    // A tampered artifact is refused before anything is installed, and the
    // offer stays so the person can retry after the feed is fixed.
    routes.lock().expect("routes").insert(
        "/latest.json".into(),
        (200, feed(port, "artifact-tampered")),
    );
    check(&handle, &updates, true).await.expect("checks again");
    assert_eq!(
        install_version(&handle, &updates, "9.9.9").await,
        Err(AppUpdateErrorCode::SignatureInvalid.into())
    );
    let status = updates.status(&handle);
    assert_eq!(status.phase, AppUpdatePhase::Idle);
    assert_eq!(
        status.available.map(|update| update.version).as_deref(),
        Some("9.9.9")
    );
    assert!(status.last_check.expect("records the check").automatic);

    // A broken feed keeps the earlier offer and reports why.
    routes
        .lock()
        .expect("routes")
        .insert("/latest.json".into(), (200, b"{\"version\":".to_vec()));
    assert_eq!(
        check(&handle, &updates, false).await,
        Err(AppUpdateErrorCode::FeedInvalid.into())
    );
    let status = updates.status(&handle);
    assert!(status.available.is_some());
    let last_check = status.last_check.expect("records the failure");
    assert_eq!(last_check.outcome, AppUpdateCheckOutcome::Failed);
    assert_eq!(last_check.error, Some(AppUpdateErrorCode::FeedInvalid));

    // A feed without this platform is named as such.
    routes.lock().expect("routes").insert(
        "/latest.json".into(),
        (
            200,
            serde_json::to_vec(&json!({
                "version": "9.9.9",
                "platforms": { "plan9-mips": { "url": "http://127.0.0.1/x", "signature": "x" } }
            }))
            .expect("encodes the feed"),
        ),
    );
    assert_eq!(
        check(&handle, &updates, false).await,
        Err(AppUpdateErrorCode::PlatformMissing.into())
    );

    // "No update" clears the offer.
    routes
        .lock()
        .expect("routes")
        .insert("/latest.json".into(), (204, Vec::new()));
    let status = check(&handle, &updates, false).await.expect("checks again");
    assert_eq!(status.available, None);
    assert_eq!(
        status.last_check.map(|check| check.outcome),
        Some(AppUpdateCheckOutcome::UpToDate)
    );
    fs::remove_dir_all(directory).expect("removes the test directory");
}

#[tokio::test]
async fn an_unreachable_feed_is_a_network_failure() {
    // Bind and release a port so nothing listens on it.
    let port = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binds a port")
        .local_addr()
        .expect("reads the port")
        .port();
    let directory = temporary_directory("offline");
    let app = loopback_app(port, &directory);
    let handle = app.handle().clone();
    let updates = handle.state::<AppUpdateState>();
    assert_eq!(
        check(&handle, &updates, false).await,
        Err(AppUpdateErrorCode::Network.into())
    );
    assert_eq!(updates.status(&handle).phase, AppUpdatePhase::Idle);
    fs::remove_dir_all(directory).expect("removes the test directory");
}
