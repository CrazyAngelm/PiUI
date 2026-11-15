//! Tests of the remote link pieces: framing, pairing, grants and the link
//! itself against an in-process loopback server (synthetic evidence).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::{SinkExt as _, StreamExt as _};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair as _};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{
    Callback, ErrorResponse, Request, Response,
};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use url::Url;

use super::frames::{
    self, ByeReason, DeniedReason, DropReason, Grant, HostMessage, MAX_FRAME_BYTES,
    MAX_RESULT_BYTES, PART_BYTES, RefusalCode, SINGLE_RESULT_BYTES, SUBPROTOCOL, ServerFrame,
    ShellContracts, ViewerMessage, parse_server_frame, split_result, valid_viewer_id,
};
use super::grants::{RemoteStore, StoreError, StoredBrowser};
use super::link::{
    LinkEvent, LinkHandle, LinkSender, LinkState, Settings, accept_key, backoff_delay, spawn_with,
};
use super::pairing::{
    RawKey, decode_key, encode_key, fingerprint, new_nonce, pairing_code, proof_message,
    sanitize_label, verify_proof,
};
use crate::account::NanoAccount;
use crate::testing::FakeNano;

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/fixtures/nano-remote-v1.json"
));
const VIEWER: &str = "vw_synthetic0000000000001";
const WAIT: Duration = Duration::from_secs(10);

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("fixture parses")
}

fn fixture_key(fixture: &Value) -> RawKey {
    decode_key(fixture["pairingVector"]["key"].as_str().expect("key")).expect("fixture key decodes")
}

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

#[test]
fn viewer_ids_are_prefixed_and_bounded() {
    assert!(valid_viewer_id(VIEWER));
    assert!(valid_viewer_id("vw_a"));
    assert!(valid_viewer_id(&format!("vw_{}", "a".repeat(64))));
    assert!(!valid_viewer_id(&format!("vw_{}", "a".repeat(65))));
    assert!(!valid_viewer_id("vw_"));
    assert!(!valid_viewer_id("viewer"));
    assert!(!valid_viewer_id("vw_a b"));
    assert!(!valid_viewer_id("vw_a\"b"));
    assert!(!valid_viewer_id(""));
}

#[test]
fn refusal_codes_match_the_contract() {
    assert_eq!(RefusalCode::NotAllowed.as_str(), "remote-not-allowed");
    assert_eq!(RefusalCode::Busy.as_str(), "remote-busy");
    assert_eq!(RefusalCode::TooLarge.as_str(), "remote-too-large");
    assert_eq!(RefusalCode::Invalid.as_str(), "remote-invalid");
    assert_eq!(RefusalCode::NotConnected.as_str(), "remote-not-connected");
}

#[test]
fn server_frames_of_the_fixture_parse() {
    let fixture = fixture();
    let frames = &fixture["frames"];
    let text = |frame: &Value| serde_json::to_string(frame).expect("text");
    assert_eq!(
        parse_server_frame(&text(&frames["serverHello"])),
        Some(ServerFrame::Hello {
            device: "dev_synthetic01".to_owned()
        })
    );
    assert_eq!(
        parse_server_frame(&text(&frames["viewerOpen"])),
        Some(ServerFrame::ViewerOpen {
            viewer: VIEWER.to_owned()
        })
    );
    let request = json!({ "t": "msg", "viewer": VIEWER, "d": frames["request"]["d"] });
    match parse_server_frame(&request.to_string()) {
        Some(ServerFrame::Message {
            viewer,
            body: ViewerMessage::Req { id, cmd, args },
        }) => {
            assert_eq!(viewer, VIEWER);
            assert_eq!(id, 1);
            assert_eq!(cmd, "workspace_command_v15");
            assert_eq!(args, json!({ "command": { "type": "catalog" } }));
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn server_frames_with_bad_shapes_are_rejected_or_marked_malformed() {
    let close = json!({ "t": "viewer-close", "viewer": VIEWER });
    assert_eq!(
        parse_server_frame(&close.to_string()),
        Some(ServerFrame::ViewerClose {
            viewer: VIEWER.to_owned()
        })
    );
    for text in [
        "not json",
        "[]",
        "{}",
        r#"{"t":"future"}"#,
        r#"{"t":"viewer-open"}"#,
        r#"{"t":"viewer-open","viewer":"nope"}"#,
        r#"{"t":"msg","viewer":"vw_a"}"#,
        r#"{"t":"hello"}"#,
    ] {
        assert_eq!(parse_server_frame(text), None, "{text}");
    }
    for body in [
        json!({ "k": "req" }),
        json!({ "k": "req", "id": "one", "cmd": "x" }),
        json!({ "k": "req", "id": -1, "cmd": "x" }),
        json!({ "k": "hello", "key": "k" }),
        json!({ "id": 1 }),
    ] {
        let frame = json!({ "t": "msg", "viewer": "vw_a", "d": body }).to_string();
        assert_eq!(
            parse_server_frame(&frame),
            Some(ServerFrame::Malformed {
                viewer: "vw_a".to_owned()
            }),
            "{frame}"
        );
    }
    let unknown = json!({ "t": "msg", "viewer": "vw_a", "d": { "k": "future", "x": 1 } });
    assert_eq!(
        parse_server_frame(&unknown.to_string()),
        Some(ServerFrame::Message {
            viewer: "vw_a".to_owned(),
            body: ViewerMessage::Unknown
        })
    );
}

#[test]
fn viewer_messages_tolerate_additive_fields_and_default_the_label() {
    let frame = json!({
        "t": "msg", "viewer": "vw_a",
        "d": { "k": "hello", "proto": 1, "key": "abc", "extra": true }
    });
    match parse_server_frame(&frame.to_string()) {
        Some(ServerFrame::Message {
            body: ViewerMessage::Hello { proto, key, label },
            ..
        }) => {
            assert_eq!((proto, key.as_str(), label.as_str()), (1, "abc", ""));
        }
        other => panic!("unexpected {other:?}"),
    }
    let frame = json!({ "t": "msg", "viewer": "vw_a", "d": { "k": "req", "id": 3, "cmd": "x" } });
    match parse_server_frame(&frame.to_string()) {
        Some(ServerFrame::Message {
            body: ViewerMessage::Req { args, .. },
            ..
        }) => assert_eq!(args, Value::Null),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn debug_output_never_prints_payloads() {
    let hello = ViewerMessage::Hello {
        proto: 1,
        key: "SECRET-KEY".to_owned(),
        label: "SECRET-LABEL".to_owned(),
    };
    let req = ViewerMessage::Req {
        id: 1,
        cmd: "workspace_command_v15".to_owned(),
        args: json!({ "prompt": "SECRET-PROMPT" }),
    };
    let challenge = HostMessage::Challenge {
        nonce: "SECRET-NONCE".to_owned(),
    };
    let event =
        HostMessage::event("piui://x", r#"{"text":"SECRET-TEXT"}"#.to_owned()).expect("event");
    for text in [
        format!("{hello:?}"),
        format!("{req:?}"),
        format!("{challenge:?}"),
        format!("{event:?}"),
    ] {
        assert!(!text.contains("SECRET"), "{text}");
    }
}

#[test]
fn host_messages_serialize_to_the_contract() {
    let fixture = fixture();
    let refusal = HostMessage::refusal(2, RefusalCode::NotAllowed);
    let expected = &fixture["frames"]["refusal"]["d"];
    assert_eq!(
        serde_json::to_value(&refusal).expect("value"),
        *expected,
        "refusal"
    );
    let shell: ShellContracts =
        serde_json::from_value(fixture["shellContracts"].clone()).expect("shell contracts");
    let welcome = HostMessage::Welcome(frames::Welcome {
        proto: 1,
        device: frames::DeviceInfo {
            id: "dev_synthetic01".to_owned(),
            name: "Nano Desktop on Windows".to_owned(),
        },
        app: frames::AppInfo {
            version: "0.3.0".to_owned(),
        },
        grant: Grant::Always,
        shell,
        commands: vec!["bootstrap_v10".to_owned()],
        channels: vec!["piui://composer-v19".to_owned()],
    });
    assert_eq!(
        serde_json::to_value(&welcome).expect("welcome"),
        json!({
            "k": "welcome", "proto": 1,
            "device": { "id": "dev_synthetic01", "name": "Nano Desktop on Windows" },
            "app": { "version": "0.3.0" },
            "grant": "always",
            "shell": fixture["shellContracts"],
            "commands": ["bootstrap_v10"],
            "channels": ["piui://composer-v19"],
        })
    );
    let samples = [
        (
            HostMessage::Challenge {
                nonce: "n".to_owned(),
            },
            json!({ "k": "challenge", "nonce": "n" }),
        ),
        (
            HostMessage::Approval {
                code: "908621".to_owned(),
                expires_in: 120,
            },
            json!({ "k": "approval", "code": "908621", "expiresIn": 120 }),
        ),
        (
            HostMessage::Denied {
                reason: DeniedReason::Timeout,
            },
            json!({ "k": "denied", "reason": "timeout" }),
        ),
        (
            HostMessage::Bye {
                reason: ByeReason::SignedOut,
            },
            json!({ "k": "bye", "reason": "signed-out" }),
        ),
        (
            HostMessage::Part {
                id: 9,
                seq: 1,
                last: true,
                ok: false,
                data: "x".to_owned(),
            },
            json!({ "k": "part", "id": 9, "seq": 1, "last": true, "ok": false, "data": "x" }),
        ),
        (
            HostMessage::event("piui://x", r#"{"a":1}"#.to_owned()).expect("event"),
            json!({ "k": "ev", "ch": "piui://x", "p": { "a": 1 } }),
        ),
        (
            HostMessage::Gap {
                ch: "piui://x".to_owned(),
                sid: Some("s1".to_owned()),
            },
            json!({ "k": "gap", "ch": "piui://x", "sid": "s1" }),
        ),
        (
            HostMessage::Gap {
                ch: "piui://x".to_owned(),
                sid: None,
            },
            json!({ "k": "gap", "ch": "piui://x" }),
        ),
    ];
    for (message, expected) in samples {
        assert_eq!(serde_json::to_value(&message).expect("value"), expected);
    }
    assert!(HostMessage::event("piui://x", "not json".to_owned()).is_none());
}

#[test]
fn a_small_result_is_one_res_frame() {
    let ok = split_result(7, true, r#"{"a":1}"#);
    assert_eq!(ok.len(), 1);
    assert_eq!(
        serde_json::to_string(&ok[0]).expect("text"),
        r#"{"k":"res","id":7,"ok":true,"value":{"a":1}}"#
    );
    let failed = split_result(8, false, r#"{"code":"x"}"#);
    assert_eq!(
        serde_json::to_string(&failed[0]).expect("text"),
        r#"{"k":"res","id":8,"ok":false,"error":{"code":"x"}}"#
    );
    let invalid = split_result(9, true, "not json");
    assert_eq!(
        serde_json::to_value(&invalid[0]).expect("value"),
        serde_json::to_value(HostMessage::refusal(9, RefusalCode::Invalid)).expect("value")
    );
}

#[test]
fn the_single_frame_limit_is_exact() {
    let overhead = serde_json::to_string(&split_result(1, true, "0")[0])
        .expect("text")
        .len()
        - 1;
    let fits = format!("\"{}\"", "a".repeat(SINGLE_RESULT_BYTES - overhead - 2));
    let frames = split_result(1, true, &fits);
    assert_eq!(frames.len(), 1);
    assert_eq!(
        serde_json::to_string(&frames[0]).expect("text").len(),
        SINGLE_RESULT_BYTES
    );
    let over = format!("\"{}\"", "a".repeat(SINGLE_RESULT_BYTES - overhead - 1));
    let frames = split_result(1, true, &over);
    assert!(frames.len() > 1);
    assert!(
        frames
            .iter()
            .all(|frame| matches!(frame, HostMessage::Part { .. }))
    );
}

fn collect_parts(frames: &[HostMessage]) -> (String, Vec<(u32, bool, bool)>) {
    let mut data = String::new();
    let mut meta = Vec::new();
    for frame in frames {
        match frame {
            HostMessage::Part {
                seq,
                last,
                ok,
                data: chunk,
                ..
            } => {
                assert!(chunk.len() <= PART_BYTES);
                data.push_str(chunk);
                meta.push((*seq, *last, *ok));
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    (data, meta)
}

#[test]
fn a_large_result_is_split_in_order_and_reassembles() {
    let json = format!("\"{}\"", "a".repeat(249_998));
    assert_eq!(json.len(), 250_000);
    let frames = split_result(5, false, &json);
    let (data, meta) = collect_parts(&frames);
    assert_eq!(data, json);
    assert_eq!(
        meta,
        vec![(0, false, false), (1, false, false), (2, true, false)]
    );
    for frame in &frames {
        let text = frames::encode_message("vw_a", frame).expect("part fits one frame");
        assert!(text.len() <= MAX_FRAME_BYTES);
    }
}

#[test]
fn parts_are_cut_on_character_boundaries() {
    let json = format!("\"{}\"", "\u{e9}".repeat(150_000));
    assert_eq!(json.len(), 300_002);
    let frames = split_result(5, true, &json);
    let (data, meta) = collect_parts(&frames);
    assert_eq!(data, json);
    assert_eq!(meta.first(), Some(&(0, false, true)));
    assert_eq!(meta.last().map(|part| part.1), Some(true));
    match &frames[0] {
        HostMessage::Part { data, .. } => assert_eq!(data.len(), PART_BYTES - 1),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn a_result_over_the_ceiling_is_refused() {
    let json = "a".repeat(MAX_RESULT_BYTES + 1);
    let frames = split_result(4, true, &json);
    assert_eq!(frames.len(), 1);
    assert_eq!(
        serde_json::to_value(&frames[0]).expect("value"),
        serde_json::to_value(HostMessage::refusal(4, RefusalCode::TooLarge)).expect("value")
    );
}

#[test]
fn envelopes_have_the_server_shape() {
    let bye = HostMessage::Bye {
        reason: ByeReason::Quit,
    };
    assert_eq!(
        frames::encode_message(VIEWER, &bye).as_deref(),
        Some(r#"{"t":"msg","viewer":"vw_synthetic0000000000001","d":{"k":"bye","reason":"quit"}}"#)
    );
    assert_eq!(
        frames::encode_drop(VIEWER, DropReason::Kicked).as_deref(),
        Some(r#"{"t":"drop","viewer":"vw_synthetic0000000000001","reason":"kicked"}"#)
    );
    let fixture = fixture();
    let drop = frames::encode_drop(VIEWER, DropReason::Kicked).expect("drop");
    let drop: Value = serde_json::from_str(&drop).expect("json");
    assert_eq!(drop, fixture["frames"]["drop"]);
}

#[test]
fn a_frame_over_the_limit_is_not_encoded() {
    let big = HostMessage::event("piui://x", format!("\"{}\"", "a".repeat(MAX_FRAME_BYTES)))
        .expect("event");
    assert!(frames::encode_message("vw_a", &big).is_none());
}

// ---------------------------------------------------------------------------
// pairing
// ---------------------------------------------------------------------------

fn key_pair() -> (EcdsaKeyPair, RawKey) {
    let rng = SystemRandom::new();
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("pkcs8");
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
        .expect("key pair");
    let key: RawKey = pair.public_key().as_ref().try_into().expect("65 bytes");
    (pair, key)
}

fn sign(pair: &EcdsaKeyPair, message: &str) -> String {
    let rng = SystemRandom::new();
    let signature = pair.sign(&rng, message.as_bytes()).expect("sign");
    URL_SAFE_NO_PAD.encode(signature.as_ref())
}

#[test]
fn the_pairing_vector_of_the_fixture_matches() {
    let fixture = fixture();
    let vector = &fixture["pairingVector"];
    let key = fixture_key(&fixture);
    assert_eq!(encode_key(&key), vector["key"].as_str().expect("key"));
    assert_eq!(
        pairing_code(&key, vector["nonce"].as_str().expect("nonce")).as_deref(),
        vector["code"].as_str()
    );
    assert_eq!(
        fingerprint(&key),
        vector["fingerprint"].as_str().expect("fingerprint")
    );
    assert_eq!(
        pairing_code(&key, "not base64 !"),
        None,
        "a malformed nonce has no code"
    );
}

#[test]
fn the_proof_message_matches_the_fixture() {
    let fixture = fixture();
    let proof = &fixture["proofMessage"];
    assert_eq!(
        proof_message(
            proof["deviceId"].as_str().expect("device"),
            proof["viewerId"].as_str().expect("viewer"),
            proof["nonce"].as_str().expect("nonce"),
        ),
        proof["message"].as_str().expect("message")
    );
}

#[test]
fn keys_decode_only_as_uncompressed_points() {
    let fixture = fixture();
    let text = fixture["pairingVector"]["key"].as_str().expect("key");
    let key = decode_key(text).expect("decodes");
    assert_eq!(encode_key(&key), text);
    assert!(decode_key("").is_none());
    assert!(decode_key("AAAA").is_none());
    assert!(decode_key(&"A".repeat(200)).is_none());
    let mut compressed = key;
    compressed[0] = 0x02;
    assert!(decode_key(&encode_key(&compressed)).is_none());
    assert!(decode_key("not base64 !").is_none());
}

#[test]
fn nonces_are_fresh_32_byte_values() {
    let first = new_nonce().expect("nonce");
    let second = new_nonce().expect("nonce");
    assert_ne!(first, second);
    assert_eq!(URL_SAFE_NO_PAD.decode(&first).expect("base64").len(), 32);
}

#[test]
fn a_proof_binds_the_device_viewer_and_nonce() {
    let (pair, key) = key_pair();
    let nonce = new_nonce().expect("nonce");
    let message = proof_message("dev_a", "vw_a", &nonce);
    let signature = sign(&pair, &message);
    assert!(verify_proof(&key, message.as_bytes(), &signature));

    for other in [
        proof_message("dev_b", "vw_a", &nonce),
        proof_message("dev_a", "vw_b", &nonce),
        proof_message("dev_a", "vw_a", &new_nonce().expect("nonce")),
    ] {
        assert!(!verify_proof(&key, other.as_bytes(), &signature), "{other}");
    }
    let (_, other_key) = key_pair();
    assert!(!verify_proof(&other_key, message.as_bytes(), &signature));
}

#[test]
fn malformed_signatures_never_verify() {
    let (pair, key) = key_pair();
    let message = proof_message("dev_a", "vw_a", "nonce");
    let signature = sign(&pair, &message);
    let bytes = URL_SAFE_NO_PAD.decode(&signature).expect("bytes");
    assert_eq!(bytes.len(), 64);
    let truncated = URL_SAFE_NO_PAD.encode(&bytes[..63]);
    let mut longer = bytes.clone();
    longer.push(0);
    let mut flipped = bytes;
    flipped[10] ^= 1;
    for bad in [
        String::new(),
        "not base64 !".to_owned(),
        truncated,
        URL_SAFE_NO_PAD.encode(longer),
        URL_SAFE_NO_PAD.encode(flipped),
        "A".repeat(300),
    ] {
        assert!(!verify_proof(&key, message.as_bytes(), &bad));
    }
}

#[test]
fn labels_are_clean_bounded_and_never_empty() {
    assert_eq!(
        sanitize_label("  Chrome \u{b7} Android  "),
        "Chrome \u{b7} Android"
    );
    assert_eq!(sanitize_label("a\u{202e}b\u{200b}c\nd\te"), "abcde");
    assert_eq!(sanitize_label(""), "Browser");
    assert_eq!(sanitize_label(" \u{202e}\u{2066} \n"), "Browser");
    assert_eq!(sanitize_label(&"x".repeat(200)).chars().count(), 60);
    assert_eq!(sanitize_label(&"\u{e9}".repeat(200)).chars().count(), 60);
}

// ---------------------------------------------------------------------------
// grants
// ---------------------------------------------------------------------------

fn browser(seed: u8) -> StoredBrowser {
    let mut key = [seed; 65];
    key[0] = 0x04;
    StoredBrowser {
        id: format!("br_{seed}"),
        label: format!("Browser {seed}"),
        fingerprint: fingerprint(&key),
        key: encode_key(&key),
        created_at: "2026-11-15T09:00:00Z".to_owned(),
        last_used_at: None,
    }
}

#[test]
fn a_store_remembers_at_most_eight_browsers() {
    let mut store = RemoteStore::in_memory("https://nanoagents.ru", "dev_a");
    for seed in 1..=8 {
        store.remember(browser(seed)).expect("room");
    }
    assert_eq!(store.remember(browser(9)), Err(StoreError::Full));
    assert_eq!(store.browsers().len(), 8);
    // The same key replaces its entry and does not count twice.
    let mut renamed = browser(3);
    renamed.label = "Renamed".to_owned();
    store.remember(renamed).expect("replaced");
    assert_eq!(store.browsers().len(), 8);
    assert_eq!(
        store.find_by_key(&browser(3).key).map(|b| b.label.as_str()),
        Some("Renamed")
    );
    store.forget("br_4").expect("forgotten");
    store.remember(browser(9)).expect("room again");
    assert_eq!(store.forget("br_404"), Err(StoreError::NotFound));
    store.clear().expect("cleared");
    assert!(store.browsers().is_empty());
}

#[test]
fn a_store_persists_and_binds_to_issuer_and_device() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("nano-remote-v1.json");
    let issuer = "https://nanoagents.ru";
    let mut store = RemoteStore::load(&path, issuer, "dev_a");
    assert!(!store.enabled());
    assert!(store.browsers().is_empty());
    store.set_enabled(true).expect("enabled");
    store.remember(browser(1)).expect("remembered");
    store
        .touch("br_1", "2026-11-15T10:00:00Z")
        .expect("touched");
    assert_eq!(store.touch("br_9", "x"), Err(StoreError::NotFound));

    let text = std::fs::read_to_string(&path).expect("file");
    assert!(!text.contains("token"), "no credential in the file");

    let again = RemoteStore::load(&path, issuer, "dev_a");
    assert!(again.enabled());
    assert_eq!(again.browsers().len(), 1);
    assert_eq!(
        again.browsers()[0].last_used_at.as_deref(),
        Some("2026-11-15T10:00:00Z")
    );

    for (other_issuer, other_device) in [(issuer, "dev_b"), ("http://127.0.0.1:1", "dev_a")] {
        let other = RemoteStore::load(&path, other_issuer, other_device);
        assert!(!other.enabled(), "{other_issuer} {other_device}");
        assert!(other.browsers().is_empty());
        assert_eq!(other.device_id(), other_device);
    }
}

#[test]
fn loading_repairs_what_the_file_cannot_vouch_for() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("nano-remote-v1.json");
    let good = browser(1);
    let mut stale = browser(2);
    stale.fingerprint = "0000000000000000".to_owned();
    stale.label = "a\u{202e}b".to_owned();
    let mut broken = browser(3);
    broken.key = "short".to_owned();
    let mut browsers: Vec<Value> = [good, stale, broken]
        .iter()
        .map(|b| serde_json::to_value(b).expect("value"))
        .collect();
    for seed in 10..20 {
        browsers.push(serde_json::to_value(browser(seed)).expect("value"));
    }
    let file = json!({
        "issuer": "https://nanoagents.ru", "deviceId": "dev_a",
        "enabled": true, "browsers": browsers,
    });
    std::fs::write(&path, file.to_string()).expect("write");
    let store = RemoteStore::load(&path, "https://nanoagents.ru", "dev_a");
    assert!(store.enabled());
    assert_eq!(store.browsers().len(), 8, "capped, invalid key dropped");
    let repaired = &store.browsers()[1];
    assert_eq!(repaired.label, "ab");
    assert_eq!(repaired.fingerprint, browser(2).fingerprint);
    assert!(store.find_by_key(&browser(3).key).is_none());

    std::fs::write(&path, "not json").expect("write");
    let reset = RemoteStore::load(&path, "https://nanoagents.ru", "dev_a");
    assert!(!reset.enabled());
}

#[test]
fn a_failed_write_changes_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    // A directory where the file belongs: the replacing rename must fail.
    let path = dir.path().join("nano-remote-v1.json");
    std::fs::create_dir(&path).expect("dir");
    let mut store = RemoteStore::load(&path, "https://nanoagents.ru", "dev_a");
    assert_eq!(store.set_enabled(true), Err(StoreError::Io));
    assert!(!store.enabled());
    assert_eq!(store.remember(browser(1)), Err(StoreError::Io));
    assert!(store.browsers().is_empty());
}

// ---------------------------------------------------------------------------
// link helpers
// ---------------------------------------------------------------------------

#[test]
fn the_accept_key_matches_rfc_6455() {
    assert_eq!(
        accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
}

fn near(actual: Duration, millis: u64) {
    let expected = Duration::from_millis(millis);
    let slack = Duration::from_millis(2);
    assert!(
        actual + slack >= expected && actual <= expected + slack,
        "{actual:?} is not about {expected:?}"
    );
}

#[test]
fn backoff_doubles_to_the_cap_with_bounded_jitter() {
    let start = Duration::from_secs(1);
    let max = Duration::from_secs(60);
    near(backoff_delay(start, max, 0, 0.5), 1_000);
    near(backoff_delay(start, max, 0, 0.0), 800);
    near(backoff_delay(start, max, 0, 1.0), 1_200);
    near(backoff_delay(start, max, 1, 0.5), 2_000);
    near(backoff_delay(start, max, 3, 0.5), 8_000);
    near(backoff_delay(start, max, 6, 0.5), 60_000);
    near(backoff_delay(start, max, 40, 1.0), 72_000);
    near(backoff_delay(start, max, u32::MAX, 0.0), 48_000);
    near(backoff_delay(start, max, 0, f64::NAN), 1_000);
    near(backoff_delay(start, max, 0, 9.0), 1_200);
    near(backoff_delay(start, max, 0, -3.0), 800);
}

// ---------------------------------------------------------------------------
// the link against a loopback server
// ---------------------------------------------------------------------------

type Socket = WebSocketStream<TcpStream>;

struct Env {
    fake: FakeNano,
    account: NanoAccount,
    device: String,
}

async fn env() -> Env {
    let fake = FakeNano::start().await;
    let (account, _store) = fake.signed_in().await;
    let device = account.status().device.expect("device").id;
    Env {
        fake,
        account,
        device,
    }
}

async fn bind() -> (Arc<TcpListener>, Url) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let url = Url::parse(&format!(
        "http://127.0.0.1:{port}/api/desktop/v1/remote/link"
    ))
    .expect("url");
    (Arc::new(listener), url)
}

fn settings(url: Url) -> Settings {
    Settings {
        backoff_start: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        handshake_timeout: Duration::from_secs(5),
        write_timeout: Duration::from_secs(5),
        ping_every: Duration::from_secs(60),
        silence: Duration::from_secs(120),
        stable_after: Duration::from_secs(60),
        ..Settings::new(url)
    }
}

fn start(env: &Env, settings: Settings) -> (LinkHandle, LinkSender, mpsc::Receiver<LinkEvent>) {
    let (events, receiver) = mpsc::channel(64);
    let (handle, sender) = spawn_with(
        env.account.clone(),
        env.account.generation(),
        events,
        settings,
    );
    (handle, sender, receiver)
}

async fn next_event(events: &mut mpsc::Receiver<LinkEvent>) -> LinkEvent {
    tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an event in time")
        .expect("the link is open")
}

async fn expect_state(events: &mut mpsc::Receiver<LinkEvent>, state: LinkState) {
    match next_event(events).await {
        LinkEvent::State(got) if got == state => {}
        other => panic!("expected {state:?}, got {other:?}"),
    }
}

async fn expect_closed(events: &mut mpsc::Receiver<LinkEvent>) {
    let closed = tokio::time::timeout(WAIT, async { while events.recv().await.is_some() {} }).await;
    assert!(closed.is_ok(), "the link task should have ended");
}

#[derive(Debug, Default)]
struct SeenRequest {
    uri: String,
    authorization: Option<String>,
    client: Option<String>,
    protocol: Option<String>,
}

type Seen = Arc<Mutex<Vec<SeenRequest>>>;

/// Records the handshake request and answers with the link's subprotocol.
struct Recorder(Seen);

impl Callback for Recorder {
    // The error type is fixed by tungstenite's `Callback` trait.
    #[allow(
        clippy::result_large_err,
        reason = "the signature is dictated by tokio-tungstenite"
    )]
    fn on_request(
        self,
        request: &Request,
        mut response: Response,
    ) -> Result<Response, ErrorResponse> {
        let header = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        self.0.lock().expect("seen").push(SeenRequest {
            uri: request.uri().to_string(),
            authorization: header("authorization"),
            client: header("x-nano-client"),
            protocol: header("sec-websocket-protocol"),
        });
        response.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(SUBPROTOCOL),
        );
        Ok(response)
    }
}

async fn upgrade(stream: TcpStream, seen: &Seen) -> Socket {
    tokio_tungstenite::accept_hdr_async(stream, Recorder(Arc::clone(seen)))
        .await
        .expect("websocket handshake")
}

async fn accept(listener: &TcpListener, seen: &Seen) -> Socket {
    let (stream, _) = tokio::time::timeout(WAIT, listener.accept())
        .await
        .expect("a connection in time")
        .expect("accept");
    upgrade(stream, seen).await
}

fn hello(device: &str) -> Message {
    Message::text(
        json!({ "t": "hello", "device": device, "maxFrame": 262_144, "maxViewers": 2 }).to_string(),
    )
}

async fn read_text(socket: &mut Socket) -> String {
    loop {
        match tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("a frame in time")
        {
            Some(Ok(Message::Text(text))) => return text.as_str().to_owned(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// Reads until the peer closes; true when it did within the wait.
async fn closes(socket: &mut Socket) -> bool {
    tokio::time::timeout(WAIT, async {
        loop {
            match socket.next().await {
                None | Some(Err(_) | Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn the_link_authenticates_and_relays_in_both_directions() {
    let env = env().await;
    let (listener, url) = bind().await;
    let (_handle, sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;

    let seen = Seen::default();
    let mut server = accept(&listener, &seen).await;
    server.send(hello(&env.device)).await.expect("hello");
    expect_state(&mut events, LinkState::Online).await;

    {
        let seen = seen.lock().expect("seen");
        assert_eq!(seen.len(), 1);
        let request = &seen[0];
        assert_eq!(request.uri, "/api/desktop/v1/remote/link");
        let token = env.fake.state().current_access.clone();
        assert_eq!(
            request.authorization.as_deref(),
            Some(format!("Bearer {token}").as_str())
        );
        assert!(!request.uri.contains(&token), "no token in the URL");
        assert!(request.client.is_some(), "X-Nano-Client is sent");
        assert_eq!(request.protocol.as_deref(), Some(SUBPROTOCOL));
    }

    // Unknown, malformed and well-formed frames: the first two carry nothing.
    let request = json!({
        "k": "req", "id": 1, "cmd": "workspace_command_v15",
        "args": { "command": { "type": "catalog" } }
    });
    for text in [
        r#"{"t":"future"}"#.to_owned(),
        "nonsense".to_owned(),
        json!({ "t": "viewer-open", "viewer": VIEWER }).to_string(),
        json!({ "t": "msg", "viewer": VIEWER, "d": request }).to_string(),
        json!({ "t": "msg", "viewer": VIEWER, "d": { "k": "req" } }).to_string(),
        json!({ "t": "viewer-close", "viewer": VIEWER }).to_string(),
    ] {
        server.send(Message::text(text)).await.expect("send");
    }
    match next_event(&mut events).await {
        LinkEvent::ViewerOpen(viewer) => assert_eq!(viewer, VIEWER),
        other => panic!("unexpected {other:?}"),
    }
    match next_event(&mut events).await {
        LinkEvent::Message {
            viewer,
            body: ViewerMessage::Req { id, cmd, args },
        } => {
            assert_eq!(viewer, VIEWER);
            assert_eq!(id, 1);
            assert_eq!(cmd, "workspace_command_v15");
            assert_eq!(args, json!({ "command": { "type": "catalog" } }));
        }
        other => panic!("unexpected {other:?}"),
    }
    match next_event(&mut events).await {
        LinkEvent::Malformed { viewer } => assert_eq!(viewer, VIEWER),
        other => panic!("unexpected {other:?}"),
    }
    match next_event(&mut events).await {
        LinkEvent::ViewerClose(viewer) => assert_eq!(viewer, VIEWER),
        other => panic!("unexpected {other:?}"),
    }

    let bye = HostMessage::Bye {
        reason: ByeReason::Quit,
    };
    assert!(sender.send(VIEWER, &bye));
    assert!(sender.send_wait(VIEWER, &bye).await);
    sender.drop_viewer(VIEWER, DropReason::Kicked);
    let expected =
        r#"{"t":"msg","viewer":"vw_synthetic0000000000001","d":{"k":"bye","reason":"quit"}}"#;
    assert_eq!(read_text(&mut server).await, expected);
    assert_eq!(read_text(&mut server).await, expected);
    assert_eq!(
        read_text(&mut server).await,
        r#"{"t":"drop","viewer":"vw_synthetic0000000000001","reason":"kicked"}"#
    );

    let too_big = HostMessage::event("piui://x", format!("\"{}\"", "a".repeat(MAX_FRAME_BYTES)))
        .expect("event");
    assert!(
        !sender.send(VIEWER, &too_big),
        "an oversize frame is refused"
    );
}

#[tokio::test]
async fn a_hello_for_another_device_is_not_trusted() {
    let env = env().await;
    let (listener, url) = bind().await;
    let (_handle, _sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;
    let seen = Seen::default();
    let mut server = accept(&listener, &seen).await;
    server.send(hello("dev_someone_else")).await.expect("hello");
    expect_state(&mut events, LinkState::Retrying).await;
    assert!(closes(&mut server).await);
}

#[tokio::test]
async fn a_second_hello_and_unknown_frames_are_ignored() {
    let env = env().await;
    let (listener, url) = bind().await;
    let (_handle, _sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;
    let seen = Seen::default();
    let mut server = accept(&listener, &seen).await;
    server.send(hello(&env.device)).await.expect("hello");
    expect_state(&mut events, LinkState::Online).await;
    server.send(hello("dev_other")).await.expect("second hello");
    server
        .send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .expect("binary");
    server
        .send(Message::text(
            json!({ "t": "viewer-open", "viewer": VIEWER }).to_string(),
        ))
        .await
        .expect("open");
    match next_event(&mut events).await {
        LinkEvent::ViewerOpen(viewer) => assert_eq!(viewer, VIEWER),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn an_oversize_inbound_frame_ends_the_connection() {
    let env = env().await;
    let (listener, url) = bind().await;
    let (_handle, _sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;
    let seen = Seen::default();
    let mut server = accept(&listener, &seen).await;
    server.send(hello(&env.device)).await.expect("hello");
    expect_state(&mut events, LinkState::Online).await;
    server
        .send(Message::text("a".repeat(MAX_FRAME_BYTES + 1)))
        .await
        .expect("oversize");
    expect_state(&mut events, LinkState::Retrying).await;
}

#[tokio::test]
async fn a_silent_connection_is_declared_dead() {
    let env = env().await;
    let (listener, url) = bind().await;
    let quick = Settings {
        ping_every: Duration::from_millis(20),
        silence: Duration::from_millis(150),
        ..settings(url)
    };
    let (_handle, _sender, mut events) = start(&env, quick);
    expect_state(&mut events, LinkState::Connecting).await;
    let seen = Seen::default();
    let mut server = accept(&listener, &seen).await;
    server.send(hello(&env.device)).await.expect("hello");
    expect_state(&mut events, LinkState::Online).await;
    // The server never reads, so it never answers a ping.
    expect_state(&mut events, LinkState::Retrying).await;
    drop(server);
}

#[tokio::test]
async fn dropping_the_handle_closes_the_socket() {
    let env = env().await;
    let (listener, url) = bind().await;
    let (handle, _sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;
    let seen = Seen::default();
    let mut server = accept(&listener, &seen).await;
    server.send(hello(&env.device)).await.expect("hello");
    expect_state(&mut events, LinkState::Online).await;
    drop(handle);
    assert!(closes(&mut server).await);
    expect_closed(&mut events).await;
}

#[tokio::test]
async fn signing_out_closes_the_socket_and_ends_the_link() {
    let env = env().await;
    let (listener, url) = bind().await;
    let (_handle, _sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;
    let seen = Seen::default();
    let mut server = accept(&listener, &seen).await;
    server.send(hello(&env.device)).await.expect("hello");
    expect_state(&mut events, LinkState::Online).await;
    env.account.sign_out(false).await.expect("sign out");
    assert!(closes(&mut server).await);
    expect_closed(&mut events).await;
    assert_eq!(seen.lock().expect("seen").len(), 1, "no reconnect");
}

/// Answers every connection with `status` and counts them.
async fn refusing_server(status: &'static str) -> (Url, Arc<AtomicUsize>) {
    let (listener, url) = bind().await;
    let count = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&count);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            counted.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                refuse(&mut stream, status).await;
            });
        }
    });
    (url, count)
}

async fn refuse(stream: &mut TcpStream, status: &str) {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => request.extend_from_slice(&chunk[..read]),
        }
    }
    let answer = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = stream.write_all(answer.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[tokio::test]
async fn forbidden_and_upgrade_required_end_the_link_without_retrying() {
    for status in ["403 Forbidden", "426 Upgrade Required", "404 Not Found"] {
        let env = env().await;
        let (url, count) = refusing_server(status).await;
        let (_handle, _sender, mut events) = start(&env, settings(url));
        expect_state(&mut events, LinkState::Connecting).await;
        expect_state(&mut events, LinkState::Refused).await;
        expect_closed(&mut events).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(count.load(Ordering::SeqCst), 1, "{status}");
    }
}

#[tokio::test]
async fn a_server_error_is_retried_until_the_link_comes_up() {
    let env = env().await;
    let (listener, url) = bind().await;
    let attempts = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&attempts);
    let device = env.device.clone();
    let seen = Seen::default();
    let served = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            if counted.fetch_add(1, Ordering::SeqCst) < 2 {
                refuse(&mut stream, "503 Service Unavailable").await;
                continue;
            }
            let mut socket = upgrade(stream, &served).await;
            let _ = socket.send(hello(&device)).await;
            while let Some(Ok(_)) = socket.next().await {}
            return;
        }
    });
    let (_handle, _sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;
    expect_state(&mut events, LinkState::Retrying).await;
    expect_state(&mut events, LinkState::Retrying).await;
    expect_state(&mut events, LinkState::Online).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn an_unreachable_server_is_retried() {
    let env = env().await;
    let (listener, url) = bind().await;
    drop(listener);
    let (_handle, _sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;
    expect_state(&mut events, LinkState::Retrying).await;
    expect_state(&mut events, LinkState::Retrying).await;
}

#[tokio::test]
async fn a_dead_link_refuses_every_frame() {
    let env = env().await;
    let (_listener, url) = bind().await;
    let (handle, sender, mut events) = start(&env, settings(url));
    expect_state(&mut events, LinkState::Connecting).await;
    drop(handle);
    expect_closed(&mut events).await;
    let bye = HostMessage::Bye {
        reason: ByeReason::Quit,
    };
    assert!(!sender.send(VIEWER, &bye));
    assert!(!sender.send_wait(VIEWER, &bye).await);
}
