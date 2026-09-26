//! Pure policy tests. Tests that need a Tauri app (MockRuntime) live in
//! `tests/app_update.rs`, which receives the Windows common-controls manifest.

use super::*;
use base64::Engine as _;
use serde_json::json;

/// minisign's published test public key (minisign-verify's own tests).
const TEST_PUBLIC_KEY_FILE: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";

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

fn section(pubkey: &str, endpoints: Value) -> Value {
    json!({ "pubkey": pubkey, "endpoints": endpoints })
}

#[test]
fn builds_without_an_updater_section_stay_off() {
    assert_eq!(updater_gate(None), Ok(None));
}

#[test]
fn a_complete_https_section_turns_updates_on() {
    let gate = updater_gate(Some(&json!({
        "pubkey": test_public_key(),
        "endpoints": [
            "https://github.com/example/piui/releases/download/updater/latest.json",
            "https://mirror.example.test/{{target}}/{{arch}}/latest.json"
        ],
        "windows": { "installMode": "passive" },
        "dangerousInsecureTransportProtocol": false
    })));
    assert_eq!(
        gate,
        Ok(Some(UpdaterGate {
            feed_host: "github.com".into()
        }))
    );
}

#[test]
fn incomplete_or_unsafe_sections_keep_updates_off() {
    let https = json!(["https://updates.example.test/latest.json"]);
    let key = test_public_key();
    let refused = [
        (
            json!("https://updates.example.test"),
            GateRefusal::NotAnObject,
        ),
        (json!({ "endpoints": https }), GateRefusal::PublicKey),
        (section("", https.clone()), GateRefusal::PublicKey),
        (
            section(&format!(" {key}"), https.clone()),
            GateRefusal::PublicKey,
        ),
        (
            section("not base64!", https.clone()),
            GateRefusal::PublicKey,
        ),
        (
            section(
                &encoded("untrusted comment: a note\nnot a key"),
                https.clone(),
            ),
            GateRefusal::PublicKey,
        ),
        (json!({ "pubkey": key }), GateRefusal::Endpoints),
        (section(&key, json!([])), GateRefusal::Endpoints),
        (
            section(
                &key,
                json!(vec!["https://updates.example.test/latest.json"; 9]),
            ),
            GateRefusal::Endpoints,
        ),
        (
            section(&key, json!(["http://updates.example.test/latest.json"])),
            GateRefusal::Endpoints,
        ),
        (
            section(
                &key,
                json!(["https://user:secret@example.test/latest.json"]),
            ),
            GateRefusal::Endpoints,
        ),
        (
            section(&key, json!(["latest.json"])),
            GateRefusal::Endpoints,
        ),
        (section(&key, json!([42])), GateRefusal::Endpoints),
    ];
    for (value, refusal) in refused {
        assert_eq!(updater_gate(Some(&value)), Err(refusal), "{value}");
    }
    for switch in UNSAFE_SWITCHES {
        let mut value = section(&key, https.clone());
        value[switch] = json!(true);
        assert_eq!(
            updater_gate(Some(&value)),
            Err(GateRefusal::UnsafeSwitch),
            "{switch}"
        );
        value[switch] = json!("false");
        assert_eq!(
            updater_gate(Some(&value)),
            Err(GateRefusal::UnsafeSwitch),
            "{switch}"
        );
    }
}

#[test]
fn the_preference_is_durable_and_fails_closed() {
    let directory = temporary_directory("settings");
    let path = directory.join(SETTINGS_FILE);
    assert!(!load_auto_check(&path));
    save_auto_check(&path, true).expect("saves the preference");
    assert!(load_auto_check(&path));
    assert!(!path.with_extension("json.tmp").exists());
    save_auto_check(&path, false).expect("saves the preference again");
    assert!(!load_auto_check(&path));
    for stored in [
        "{",
        r#"{"version":2,"autoCheck":true}"#,
        r#"{"version":1,"autoCheck":true,"channel":"beta"}"#,
        r#"{"version":1,"autoCheck":"yes"}"#,
    ] {
        fs::write(&path, stored).expect("writes a stored preference");
        assert!(!load_auto_check(&path), "{stored}");
    }
    fs::remove_dir_all(directory).expect("removes the test directory");
}

#[test]
fn release_notes_are_bounded_plain_text() {
    assert_eq!(
        plain_notes("Fixes\r\n\u{1b}[31m- faster\u{7}\n\tindented  \n\n"),
        "Fixes\n[31m- faster\n\tindented"
    );
    assert_eq!(
        plain_notes(&"é".repeat(MAX_NOTES_CHARS + 10))
            .chars()
            .count(),
        MAX_NOTES_CHARS
    );
    assert!(valid_version_text("0.2.1"));
    assert!(valid_version_text("1.0.0-beta.2+build.7"));
    for version in ["", "0.2.1 ", "../0.2.1", "0.2.1;rm", &"1".repeat(65)] {
        assert!(!valid_version_text(version), "{version}");
    }
}

#[test]
fn contract_shapes_match_the_public_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/app-update-v1.json"
    ))
    .expect("fixture");
    let not_configured = AppUpdateStatusV1 {
        protocol: APP_UPDATE_PROTOCOL,
        configured: false,
        current_version: "0.2.0".into(),
        feed_host: None,
        auto_check: false,
        phase: AppUpdatePhase::Idle,
        last_check: None,
        available: None,
    };
    assert_eq!(
        serde_json::to_value(&not_configured).expect("status"),
        fixture["notConfigured"]
    );
    let available = AppUpdateStatusV1 {
        configured: true,
        feed_host: Some("github.com".into()),
        auto_check: true,
        last_check: Some(AppUpdateLastCheckV1 {
            at: "2026-09-27T09:30:00Z".into(),
            automatic: true,
            outcome: AppUpdateCheckOutcome::Available,
            error: None,
        }),
        available: Some(AppUpdateAvailableV1 {
            version: "0.2.1".into(),
            date: Some("2026-09-26T18:00:00Z".into()),
            notes: Some("Fixes the sidebar.\n\n- Faster runs view.".into()),
        }),
        ..not_configured.clone()
    };
    assert_eq!(
        serde_json::to_value(&available).expect("status"),
        fixture["available"]
    );
    let failed = AppUpdateStatusV1 {
        configured: true,
        feed_host: Some("github.com".into()),
        last_check: Some(AppUpdateLastCheckV1 {
            at: "2026-09-27T09:31:00Z".into(),
            automatic: false,
            outcome: AppUpdateCheckOutcome::Failed,
            error: Some(AppUpdateErrorCode::Network),
        }),
        ..not_configured.clone()
    };
    assert_eq!(
        serde_json::to_value(&failed).expect("status"),
        fixture["failedCheck"]
    );
    let downloading = AppUpdateStatusV1 {
        configured: true,
        feed_host: Some("github.com".into()),
        phase: AppUpdatePhase::Downloading,
        last_check: Some(AppUpdateLastCheckV1 {
            at: "2026-09-27T09:32:00Z".into(),
            automatic: false,
            outcome: AppUpdateCheckOutcome::Available,
            error: None,
        }),
        available: Some(AppUpdateAvailableV1 {
            version: "0.2.1".into(),
            date: None,
            notes: None,
        }),
        ..not_configured.clone()
    };
    assert_eq!(
        serde_json::to_value(&downloading).expect("status"),
        fixture["downloading"]
    );
    assert_eq!(
        serde_json::to_value(AppUpdateEventV1::Status {
            status: not_configured
        })
        .expect("event"),
        fixture["statusEvent"]
    );
    assert_eq!(
        serde_json::to_value(AppUpdateEventV1::Progress {
            downloaded_bytes: 1_048_576,
            total_bytes: Some(8_388_608),
        })
        .expect("event"),
        fixture["progressEvent"]
    );
    assert_eq!(
        serde_json::to_value(AppUpdateError::from(AppUpdateErrorCode::SignatureInvalid))
            .expect("error"),
        fixture["error"]
    );
    let install: AppUpdateInstallRequestV1 =
        serde_json::from_value(fixture["installRequest"].clone()).expect("install request");
    assert_eq!(install.version, "0.2.1");
    let auto_check: AppUpdateAutoCheckRequestV1 =
        serde_json::from_value(fixture["autoCheckRequest"].clone()).expect("auto-check request");
    assert!(auto_check.enabled);
    assert!(
        serde_json::from_value::<AppUpdateInstallRequestV1>(
            json!({ "version": "0.2.1", "force": true })
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<AppUpdateAutoCheckRequestV1>(json!({ "enabled": "yes" })).is_err()
    );
}
