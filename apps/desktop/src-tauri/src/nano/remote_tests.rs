//! Tests of remote access: the allowlist against the shared fixture, the
//! admission of requests, and the state machine of browsers, pairing and the
//! link, driven without a Tauri runtime (synthetic evidence).

use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use piui_nano::remote::frames::{DropReason, ViewerMessage};
use piui_nano::remote::grants::RemoteStore;
use piui_nano::remote::link::{LinkEvent, LinkState};
use piui_nano::remote::pairing::{RawKey, decode_key, encode_key};
use piui_nano::status::NanoAccountStateV1;
use serde_json::{Value, json};

use super::remote_core::{
    AccountView, Command, Core, CoreConfig, Decision, DeviceView, Effect, Hooks, LinkStateV1,
    Moment, NanoRemoteStatusV1, RemoteError, UnavailableV1,
};
use super::remote_dispatch::{REMOTE_CHANNELS, REMOTE_COMMANDS, Refusal, SHELL_CONTRACTS, admit};
use super::tests::test_dir;

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../contracts/fixtures/nano-remote-v1.json"
));
const VIEWER: &str = "vw_synthetic0000000000001";
const ISSUER: &str = "https://nanoagents.ru";
const LABEL: &str = "Chrome \u{b7} Android";

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("fixture parses")
}

// ---------------------------------------------------------------------------
// The allowlist and the admission of requests
// ---------------------------------------------------------------------------

fn names(fixture: &Value, key: &str) -> Vec<String> {
    fixture[key]
        .as_array()
        .expect("array")
        .iter()
        .map(|value| value.as_str().expect("string").to_owned())
        .collect()
}

#[test]
fn the_allowlist_equals_the_fixture() {
    let fixture = fixture();
    assert_eq!(
        names(&fixture, "commands"),
        REMOTE_COMMANDS.map(str::to_owned).to_vec()
    );
    assert_eq!(
        names(&fixture, "channels"),
        REMOTE_CHANNELS.map(str::to_owned).to_vec()
    );
    assert_eq!(
        serde_json::to_value(SHELL_CONTRACTS).expect("shell contracts"),
        fixture["shellContracts"]
    );
}

#[test]
fn everything_else_is_refused() {
    let fixture = fixture();
    let mut refused = names(&fixture, "refusedExamples");
    refused.extend(
        [
            "nano_remote_status_v1",
            "nano_remote_set_enabled_v1",
            "nano_remote_decide_v1",
            "nano_remote_kick_v1",
            "nano_remote_forget_v1",
            "",
            "BOOTSTRAP_V10",
            "bootstrap_v10 ",
        ]
        .map(str::to_owned),
    );
    for name in refused {
        assert!(!REMOTE_COMMANDS.contains(&name.as_str()), "{name}");
        for arguments in [
            json!({}),
            json!(null),
            json!({ "command": { "type": "list" } }),
        ] {
            assert!(
                matches!(admit(&name, &arguments), Err(Refusal::NotAllowed)),
                "{name} {arguments}"
            );
        }
    }
}

fn valid_arguments() -> Vec<(&'static str, Value)> {
    vec![
        ("bootstrap_v10", json!({})),
        (
            "workspace_command_v15",
            json!({ "command": { "type": "catalog" } }),
        ),
        (
            "workspace_history_v1",
            json!({ "request": { "sessionId": "s1" } }),
        ),
        (
            "workspace_settings_v16",
            json!({ "command": { "type": "get", "sessionId": "s1" } }),
        ),
        (
            "workspace_session_mode_v1",
            json!({ "request": { "sessionId": "s1", "modeId": "m1" } }),
        ),
        (
            "workspace_composer_v19",
            json!({ "command": { "type": "snapshot", "sessionId": "s1" } }),
        ),
        (
            "harness_models_v19",
            json!({ "request": { "workspaceId": "w1", "harness": "pi" } }),
        ),
        (
            "harness_registry_v1",
            json!({ "command": { "type": "list" } }),
        ),
        ("get_session_catalog", json!({ "projectId": "p1" })),
        ("get_personal_session_catalog", json!({})),
        ("refresh_session_catalog", json!({ "projectId": "p1" })),
        ("refresh_personal_session_catalog", json!({})),
        (
            "get_timeline_page",
            json!({ "projectId": "p1", "sessionId": "s1", "cursor": null, "limit": 20 }),
        ),
        ("get_personal_timeline_page", json!({ "sessionId": "s1" })),
        ("search_sessions", json!({ "query": "needle" })),
        ("nano_account_status_v1", json!({})),
    ]
}

#[test]
fn every_allowlisted_command_admits_its_own_arguments() {
    let valid = valid_arguments();
    assert_eq!(valid.len(), REMOTE_COMMANDS.len());
    for (name, arguments) in valid {
        assert!(REMOTE_COMMANDS.contains(&name), "{name}");
        match admit(name, &arguments) {
            Ok(admitted) => assert_eq!(admitted.command(), name),
            Err(refusal) => panic!("{name}: {refusal:?}"),
        }
    }
    // No arguments at all reads as an empty object.
    assert!(admit("bootstrap_v10", &Value::Null).is_ok());
    assert!(
        admit(
            "get_timeline_page",
            &json!({ "projectId": "p", "sessionId": "s" })
        )
        .is_ok()
    );
}

#[test]
fn arguments_are_read_strictly() {
    for (name, arguments) in valid_arguments() {
        let mut extra = arguments.clone();
        extra
            .as_object_mut()
            .expect("object")
            .insert("extra".to_owned(), json!(1));
        assert!(
            matches!(admit(name, &extra), Err(Refusal::Invalid)),
            "{name} with an unknown field"
        );
        for wrong in [json!("text"), json!([]), json!(7)] {
            assert!(
                matches!(admit(name, &wrong), Err(Refusal::Invalid)),
                "{name} with {wrong}"
            );
        }
    }
    for (name, arguments) in [
        ("get_session_catalog", json!({})),
        ("get_session_catalog", json!({ "projectId": 1 })),
        ("search_sessions", json!({ "query": null })),
        (
            "workspace_command_v15",
            json!({ "command": { "type": "nope" } }),
        ),
        ("workspace_command_v15", json!({ "command": {} })),
        ("get_timeline_page", json!({ "projectId": "p" })),
    ] {
        assert!(
            matches!(admit(name, &arguments), Err(Refusal::Invalid)),
            "{name} {arguments}"
        );
    }
}

#[test]
fn the_registry_may_only_list() {
    assert!(
        admit(
            "harness_registry_v1",
            &json!({ "command": { "type": "list" } })
        )
        .is_ok()
    );
    for command in [
        json!({ "type": "check" }),
        json!({ "type": "check", "harness": "pi" }),
        json!({ "type": "add", "expectedRevision": 1, "descriptor": {} }),
        json!({ "type": "trust", "expectedRevision": 1 }),
        json!({ "type": "remove", "expectedRevision": 1, "id": "x" }),
        json!({ "type": "allowSecrets" }),
        json!({ "type": "anything" }),
    ] {
        assert!(
            matches!(
                admit("harness_registry_v1", &json!({ "command": command })),
                Err(Refusal::NotAllowed)
            ),
            "{command}"
        );
    }
}

#[test]
fn a_composer_send_may_not_carry_attachments() {
    let send = |attachments: Value| {
        let mut command = json!({
            "type": "send", "sessionId": "s1", "requestId": "r1", "text": "hi", "mode": "prompt"
        });
        if !attachments.is_null() {
            command["attachments"] = attachments;
        }
        json!({ "command": command })
    };
    assert!(admit("workspace_composer_v19", &send(Value::Null)).is_ok());
    assert!(admit("workspace_composer_v19", &send(json!([]))).is_ok());
    assert!(matches!(
        admit("workspace_composer_v19", &send(json!(["image-1"]))),
        Err(Refusal::NotAllowed)
    ));
}

#[test]
fn admitted_requests_never_print_their_arguments() {
    let admitted =
        admit("search_sessions", &json!({ "query": "SECRET-PROMPT" })).expect("admitted");
    let text = format!("{admitted:?}");
    assert!(text.contains("search_sessions"));
    assert!(!text.contains("SECRET"));
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

struct Clock {
    mono: Instant,
    wall: DateTime<Utc>,
}

impl Clock {
    fn new() -> Self {
        Self {
            mono: Instant::now(),
            wall: DateTime::parse_from_rfc3339("2026-11-15T09:00:00Z")
                .expect("time")
                .with_timezone(&Utc),
        }
    }

    fn at(&self, seconds: u64) -> Moment {
        Moment {
            mono: self.mono + Duration::from_secs(seconds),
            wall: self.wall + chrono::Duration::seconds(i64::try_from(seconds).expect("seconds")),
        }
    }
}

fn accept_good(_key: &RawKey, _message: &[u8], signature: &str) -> bool {
    signature == "good"
}

fn nonce() -> String {
    fixture()["pairingVector"]["nonce"]
        .as_str()
        .expect("nonce")
        .to_owned()
}

fn fixed_nonce() -> Option<String> {
    Some(nonce())
}

fn fixed_id(prefix: &str) -> String {
    format!("{prefix}_synthetic01")
}

fn hooks() -> Hooks {
    Hooks {
        verify: accept_good,
        nonce: fixed_nonce,
        id: fixed_id,
    }
}

fn device() -> DeviceView {
    DeviceView {
        id: "dev_synthetic01".to_owned(),
        name: "Nano Desktop on Windows".to_owned(),
    }
}

fn signed_in(epoch: u64) -> AccountView {
    AccountView {
        epoch,
        state: NanoAccountStateV1::SignedIn,
        remote_access: Some(true),
        device: Some(device()),
    }
}

fn signed_out(epoch: u64) -> AccountView {
    AccountView {
        epoch,
        state: NanoAccountStateV1::SignedOut,
        remote_access: None,
        device: None,
    }
}

fn config(safe_mode: bool) -> CoreConfig {
    CoreConfig {
        safe_mode,
        version: "0.3.1".to_owned(),
        issuer: ISSUER.to_owned(),
        store_path: None,
        hooks: hooks(),
    }
}

fn fixture_key() -> RawKey {
    let fixture = fixture();
    decode_key(fixture["pairingVector"]["key"].as_str().expect("key")).expect("key decodes")
}

fn other_key(seed: u8) -> RawKey {
    let mut key = [seed; 65];
    key[0] = 0x04;
    key
}

fn sent(effects: &[Effect]) -> Vec<(String, Value)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Send { viewer, message } => Some((
                viewer.clone(),
                serde_json::to_value(message).expect("message"),
            )),
            _ => None,
        })
        .collect()
}

fn dropped(effects: &[Effect]) -> Vec<(String, DropReason)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Drop { viewer, reason } => Some((viewer.clone(), *reason)),
            _ => None,
        })
        .collect()
}

fn dispatched(effects: &[Effect]) -> Vec<(String, u64, &'static str)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Dispatch {
                viewer,
                id,
                admitted,
            } => Some((viewer.clone(), *id, admitted.command())),
            _ => None,
        })
        .collect()
}

fn started(effects: &[Effect]) -> bool {
    effects.iter().any(|effect| matches!(effect, Effect::Start))
}

fn stopped(effects: &[Effect]) -> bool {
    effects.iter().any(|effect| matches!(effect, Effect::Stop))
}

fn shows_main(effects: &[Effect]) -> bool {
    effects
        .iter()
        .any(|effect| matches!(effect, Effect::ShowMain))
}

fn state(core: &Core) -> Value {
    serde_json::to_value(core.status()).expect("status")
}

/// An enabled core with an online link, no browsers yet.
fn online_core() -> (Core, Clock) {
    let clock = Clock::new();
    let mut core = Core::new(config(false), signed_in(0));
    let (result, effects) = core.command(Command::SetEnabled(true), clock.at(0));
    result.expect("enabled");
    assert!(started(&effects));
    core.link_event(LinkEvent::State(LinkState::Online), clock.at(0));
    (core, clock)
}

fn open(core: &mut Core, viewer: &str, moment: Moment) -> Vec<Effect> {
    core.link_event(LinkEvent::ViewerOpen(viewer.to_owned()), moment)
}

fn say(core: &mut Core, viewer: &str, body: ViewerMessage, moment: Moment) -> Vec<Effect> {
    core.link_event(
        LinkEvent::Message {
            viewer: viewer.to_owned(),
            body,
        },
        moment,
    )
}

fn hello_for(key: &RawKey) -> ViewerMessage {
    ViewerMessage::Hello {
        proto: 1,
        key: encode_key(key),
        label: LABEL.to_owned(),
    }
}

fn proof(signature: &str) -> ViewerMessage {
    ViewerMessage::Proof {
        sig: signature.to_owned(),
    }
}

fn request(id: u64, command: &str, args: Value) -> ViewerMessage {
    ViewerMessage::Req {
        id,
        cmd: command.to_owned(),
        args,
    }
}

/// Opens `viewer`, sends its hello and a good proof; returns the effects of
/// the proof.
fn pair_up(core: &mut Core, viewer: &str, key: &RawKey, moment: Moment) -> Vec<Effect> {
    open(core, viewer, moment);
    say(core, viewer, hello_for(key), moment);
    say(core, viewer, proof("good"), moment)
}

fn decide(
    core: &mut Core,
    decision: Decision,
    moment: Moment,
) -> (Result<(), RemoteError>, Vec<Effect>) {
    core.command(
        Command::Decide {
            request_id: "req_synthetic01".to_owned(),
            decision,
        },
        moment,
    )
}

/// A core with `VIEWER` welcomed for this connection only.
fn welcomed_core() -> (Core, Clock) {
    let (mut core, clock) = online_core();
    pair_up(&mut core, VIEWER, &fixture_key(), clock.at(0));
    let (result, _) = decide(&mut core, Decision::Once, clock.at(1));
    result.expect("allowed once");
    assert_eq!(core.welcomed(), 1);
    (core, clock)
}

// -- status ---------------------------------------------------------------

#[test]
fn the_status_fixtures_round_trip() {
    let fixture = fixture();
    for key in [
        "statusOff",
        "statusSafeMode",
        "statusPending",
        "statusViewer",
    ] {
        let status: NanoRemoteStatusV1 = serde_json::from_value(fixture[key].clone()).expect(key);
        assert_eq!(
            serde_json::to_value(&status).expect("value"),
            fixture[key],
            "{key}"
        );
    }
    assert!(
        serde_json::from_value::<NanoRemoteStatusV1>(json!({
            "protocol": 1, "revision": 1, "unavailable": null, "enabled": false,
            "link": "off", "viewers": [], "pending": null, "browsers": [], "token": "x"
        }))
        .is_err()
    );
}

#[test]
fn a_fresh_signed_in_core_matches_the_off_fixture() {
    let core = Core::new(config(false), signed_in(0));
    assert_eq!(state(&core), fixture()["statusOff"]);
}

#[test]
fn safe_mode_matches_its_fixture_and_never_connects() {
    let clock = Clock::new();
    for account in [signed_out(0), signed_in(0)] {
        let mut core = Core::new(config(true), account);
        assert_eq!(state(&core)["unavailable"], "safe-mode");
        let (result, effects) = core.command(Command::SetEnabled(true), clock.at(0));
        assert_eq!(result, Err(RemoteError::SafeMode));
        assert!(effects.is_empty());
        assert!(!started(&core.start(clock.at(1))));
        assert!(!started(&core.tick(clock.at(100))));
        assert!(!started(&core.account_changed(signed_in(1), clock.at(101))));
        // Switching off is always allowed.
        let (result, _) = core.command(Command::SetEnabled(false), clock.at(102));
        assert_eq!(result, Ok(()));
    }
    let core = Core::new(config(true), signed_out(0));
    assert_eq!(state(&core), fixture()["statusSafeMode"]);
}

#[test]
fn a_signed_out_core_refuses_and_never_connects() {
    let clock = Clock::new();
    let mut core = Core::new(config(false), signed_out(0));
    assert_eq!(core.status().unavailable, Some(UnavailableV1::SignedOut));
    let (result, effects) = core.command(Command::SetEnabled(true), clock.at(0));
    assert_eq!(result, Err(RemoteError::SignInRequired));
    assert!(effects.is_empty());
    assert!(!started(&core.start(clock.at(1))));
    assert!(!core.status().enabled);
    assert_eq!(core.status().link, LinkStateV1::Off);

    for state in [
        NanoAccountStateV1::SigningIn,
        NanoAccountStateV1::Expired,
        NanoAccountStateV1::SignedOut,
    ] {
        let view = AccountView {
            state,
            ..signed_out(0)
        };
        let mut core = Core::new(config(false), view);
        let (result, _) = core.command(Command::SetEnabled(true), clock.at(0));
        assert_eq!(result, Err(RemoteError::SignInRequired), "{state:?}");
    }
    let view = AccountView {
        state: NanoAccountStateV1::Unsupported,
        ..signed_out(0)
    };
    let mut core = Core::new(config(false), view);
    let (result, _) = core.command(Command::SetEnabled(true), clock.at(0));
    assert_eq!(result, Err(RemoteError::UnsupportedServer));
}

#[test]
fn a_server_without_the_capability_is_unsupported() {
    let clock = Clock::new();
    let view = AccountView {
        remote_access: Some(false),
        ..signed_in(0)
    };
    let mut core = Core::new(config(false), view);
    assert_eq!(
        core.status().unavailable,
        Some(UnavailableV1::UnsupportedServer)
    );
    let (result, effects) = core.command(Command::SetEnabled(true), clock.at(0));
    assert_eq!(result, Err(RemoteError::UnsupportedServer));
    assert!(!started(&effects));
}

// -- link supervision -------------------------------------------------------

#[test]
fn switching_on_opens_the_link_and_switching_off_closes_it() {
    let clock = Clock::new();
    let mut core = Core::new(config(false), signed_in(0));
    let (result, effects) = core.command(Command::SetEnabled(true), clock.at(0));
    assert_eq!(result, Ok(()));
    assert!(started(&effects));
    assert!(core.status().enabled);
    assert_eq!(core.status().link, LinkStateV1::Connecting);
    assert_eq!(core.status().revision, 2);

    core.link_event(LinkEvent::State(LinkState::Online), clock.at(1));
    assert_eq!(core.status().link, LinkStateV1::Online);
    core.link_event(LinkEvent::State(LinkState::Retrying), clock.at(2));
    assert_eq!(core.status().link, LinkStateV1::Retrying);

    let (result, effects) = core.command(Command::SetEnabled(false), clock.at(3));
    assert_eq!(result, Ok(()));
    assert!(stopped(&effects));
    assert!(!core.status().enabled);
    assert_eq!(core.status().link, LinkStateV1::Off);
    assert!(!started(&core.tick(clock.at(10))));
}

#[test]
fn the_link_waits_for_the_capability_to_be_known() {
    let clock = Clock::new();
    let unknown = AccountView {
        remote_access: None,
        ..signed_in(0)
    };
    let mut core = Core::new(config(false), unknown.clone());
    let (result, effects) = core.command(Command::SetEnabled(true), clock.at(0));
    assert_eq!(result, Ok(()));
    assert!(
        !started(&effects),
        "no link before the server said it offers one"
    );
    assert_eq!(core.status().link, LinkStateV1::Off);

    let effects = core.account_changed(signed_in(0), clock.at(1));
    assert!(started(&effects));
    assert_eq!(core.status().link, LinkStateV1::Connecting);

    // The capability becoming unknown again closes the link.
    let effects = core.account_changed(unknown, clock.at(2));
    assert!(stopped(&effects));
    assert_eq!(core.status().link, LinkStateV1::Off);

    // The server withdrawing it makes remote access unavailable.
    let withdrawn = AccountView {
        remote_access: Some(false),
        ..signed_in(0)
    };
    let effects = core.account_changed(withdrawn, clock.at(3));
    assert!(!started(&effects));
    assert_eq!(
        core.status().unavailable,
        Some(UnavailableV1::UnsupportedServer)
    );
}

#[test]
fn an_offline_account_keeps_a_running_link_but_does_not_start_one() {
    let clock = Clock::new();
    let offline = AccountView {
        state: NanoAccountStateV1::Offline,
        ..signed_in(0)
    };
    let (mut core, running) = online_core();
    let effects = core.account_changed(offline.clone(), running.at(5));
    assert!(!stopped(&effects));
    assert_eq!(core.status().unavailable, None);
    assert_eq!(core.status().link, LinkStateV1::Online);

    let mut fresh = Core::new(config(false), offline);
    let (result, effects) = fresh.command(Command::SetEnabled(true), clock.at(0));
    assert_eq!(result, Ok(()));
    assert!(!started(&effects));
    assert!(!started(&fresh.tick(clock.at(60))));
}

#[test]
fn signing_out_closes_the_link_and_a_new_sign_in_starts_disabled() {
    let (mut core, clock) = welcomed_core();
    let effects = core.account_changed(signed_out(1), clock.at(10));
    assert!(stopped(&effects));
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            json!({ "k": "bye", "reason": "signed-out" })
        )]
    );
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Disabled)]
    );
    assert_eq!(core.status().unavailable, Some(UnavailableV1::SignedOut));
    assert!(core.status().viewers.is_empty());

    // Another sign-in is another device and another store: off, no browsers.
    let again = AccountView {
        device: Some(DeviceView {
            id: "dev_other".to_owned(),
            name: "Nano Desktop".to_owned(),
        }),
        ..signed_in(2)
    };
    let effects = core.account_changed(again, clock.at(20));
    assert!(!started(&effects));
    assert!(!core.status().enabled);
    assert!(core.status().browsers.is_empty());
}

#[test]
fn a_refusal_by_the_server_ends_the_link_until_the_person_toggles() {
    let clock = Clock::new();
    let mut core = Core::new(config(false), signed_in(0));
    core.command(Command::SetEnabled(true), clock.at(0))
        .0
        .expect("on");
    let effects = core.link_event(LinkEvent::State(LinkState::Refused), clock.at(1));
    assert!(stopped(&effects));
    assert_eq!(core.status().link, LinkStateV1::Refused);
    assert!(core.status().enabled);
    assert!(!started(&core.tick(clock.at(600))));
    assert!(!started(&core.account_changed(signed_in(0), clock.at(601))));

    let (result, effects) = core.command(Command::SetEnabled(true), clock.at(602));
    assert_eq!(result, Ok(()));
    assert!(started(&effects));
    assert_eq!(core.status().link, LinkStateV1::Connecting);
}

#[test]
fn a_link_that_ended_alone_is_restarted_after_a_pause() {
    let (mut core, clock) = online_core();
    let effects = core.link_ended(clock.at(10));
    assert!(stopped(&effects));
    assert_eq!(core.status().link, LinkStateV1::Off);
    assert!(!started(&core.tick(clock.at(11))));
    assert!(!started(&core.tick(clock.at(14))));
    assert!(started(&core.tick(clock.at(15))));
    assert_eq!(core.status().link, LinkStateV1::Connecting);
}

#[test]
fn a_stored_toggle_starts_the_link_for_its_own_device_only() {
    let directory = test_dir("remote-store");
    let path = directory.join("nano-remote-v1.json");
    let clock = Clock::new();
    let mut store = RemoteStore::load(&path, ISSUER, "dev_synthetic01");
    store.set_enabled(true).expect("stored");

    let with_path = || CoreConfig {
        store_path: Some(path.clone()),
        ..config(false)
    };
    let mut core = Core::new(with_path(), signed_in(0));
    assert!(core.status().enabled);
    assert!(started(&core.start(clock.at(0))));

    let other = AccountView {
        device: Some(DeviceView {
            id: "dev_other".to_owned(),
            name: "Other".to_owned(),
        }),
        ..signed_in(0)
    };
    let mut core = Core::new(with_path(), other);
    assert!(!core.status().enabled);
    assert!(!started(&core.start(clock.at(0))));
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn a_switch_off_that_cannot_be_saved_still_closes_the_link() {
    let directory = test_dir("remote-force-off");
    let path = directory.join("nano-remote-v1.json");
    let clock = Clock::new();
    let mut core = Core::new(
        CoreConfig {
            store_path: Some(path.clone()),
            ..config(false)
        },
        signed_in(0),
    );
    let (result, effects) = core.command(Command::SetEnabled(true), clock.at(0));
    assert_eq!(result, Ok(()));
    assert!(started(&effects));
    // The file becomes a folder: replacing it fails from now on.
    std::fs::remove_file(&path).expect("remove");
    std::fs::create_dir(&path).expect("directory");

    let (result, effects) = core.command(Command::SetEnabled(false), clock.at(1));
    assert_eq!(result, Err(RemoteError::Io));
    assert!(stopped(&effects), "the person asked for off");
    assert_eq!(core.status().link, LinkStateV1::Off);
    assert!(!started(&core.tick(clock.at(100))));
    assert!(!started(&core.account_changed(signed_in(0), clock.at(101))));
    let _ = std::fs::remove_dir_all(directory);
}

// -- handshake and pairing ----------------------------------------------------

#[test]
fn an_unknown_browser_waits_for_the_person() {
    let (mut core, clock) = online_core();
    let key = fixture_key();
    assert!(open(&mut core, VIEWER, clock.at(0)).is_empty());
    let effects = say(&mut core, VIEWER, hello_for(&key), clock.at(0));
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            json!({ "k": "challenge", "nonce": nonce() })
        )]
    );
    let effects = say(&mut core, VIEWER, proof("good"), clock.at(0));
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            json!({ "k": "approval", "code": "908621", "expiresIn": 120 })
        )]
    );
    assert!(shows_main(&effects));
    assert_eq!(
        serde_json::to_value(&core.status().pending).expect("pending"),
        fixture()["statusPending"]["pending"]
    );
    assert_eq!(core.welcomed(), 0);
}

#[test]
fn denying_tells_the_browser_and_drops_it() {
    let (mut core, clock) = online_core();
    pair_up(&mut core, VIEWER, &fixture_key(), clock.at(0));
    let (result, effects) = decide(&mut core, Decision::Deny, clock.at(5));
    assert_eq!(result, Ok(()));
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            json!({ "k": "denied", "reason": "denied" })
        )]
    );
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Denied)]
    );
    assert!(core.status().pending.is_none());
    assert!(core.status().browsers.is_empty());
}

#[test]
fn allowing_once_welcomes_without_remembering() {
    let (mut core, clock) = online_core();
    pair_up(&mut core, VIEWER, &fixture_key(), clock.at(0));
    let (result, effects) = decide(&mut core, Decision::Once, clock.at(5));
    assert_eq!(result, Ok(()));
    let frames = sent(&effects);
    assert_eq!(frames.len(), 1);
    let welcome = &frames[0].1;
    let fixture = fixture();
    assert_eq!(welcome["k"], "welcome");
    assert_eq!(welcome["proto"], 1);
    assert_eq!(welcome["grant"], "once");
    assert_eq!(
        welcome["device"],
        json!({ "id": "dev_synthetic01", "name": "Nano Desktop on Windows" })
    );
    assert_eq!(welcome["app"], json!({ "version": "0.3.1" }));
    assert_eq!(welcome["shell"], fixture["shellContracts"]);
    assert_eq!(welcome["commands"], fixture["commands"]);
    assert_eq!(welcome["channels"], fixture["channels"]);
    assert_eq!(core.welcomed(), 1);
    assert!(core.status().browsers.is_empty());
    assert!(core.status().pending.is_none());
    assert_eq!(
        core.status().viewers[0].grant,
        piui_nano::remote::frames::Grant::Once
    );
}

#[test]
fn allowing_always_remembers_and_the_next_visit_needs_no_prompt() {
    let (mut core, clock) = online_core();
    let key = fixture_key();
    pair_up(&mut core, VIEWER, &key, clock.at(0));
    let (result, effects) = decide(&mut core, Decision::Always, clock.at(30));
    assert_eq!(result, Ok(()));
    assert_eq!(sent(&effects)[0].1["grant"], "always");
    let fixture = fixture();
    assert_eq!(
        serde_json::to_value(&core.status().viewers).expect("viewers"),
        fixture["statusViewer"]["viewers"]
    );
    assert_eq!(
        serde_json::to_value(&core.status().browsers).expect("browsers"),
        fixture["statusViewer"]["browsers"]
    );

    core.link_event(LinkEvent::ViewerClose(VIEWER.to_owned()), clock.at(40));
    assert_eq!(core.welcomed(), 0);
    let effects = pair_up(&mut core, "vw_two", &key, clock.at(60));
    assert!(!shows_main(&effects));
    let frames = sent(&effects);
    assert_eq!(frames[0].1["k"], "welcome");
    assert_eq!(frames[0].1["grant"], "always");
    assert!(core.status().pending.is_none());
    assert_eq!(
        core.status().browsers[0].last_used_at.as_deref(),
        Some("2026-11-15T09:01:00Z")
    );
}

#[test]
fn a_second_unknown_browser_is_told_the_computer_is_busy() {
    let (mut core, clock) = online_core();
    pair_up(&mut core, VIEWER, &fixture_key(), clock.at(0));
    let effects = pair_up(&mut core, "vw_two", &other_key(7), clock.at(1));
    assert_eq!(
        sent(&effects),
        vec![(
            "vw_two".to_owned(),
            json!({ "k": "denied", "reason": "busy" })
        )]
    );
    assert_eq!(
        dropped(&effects),
        vec![("vw_two".to_owned(), DropReason::Denied)]
    );
    assert!(!shows_main(&effects));
    // The first request is untouched.
    assert!(core.status().pending.is_some());
    let (result, _) = decide(&mut core, Decision::Once, clock.at(2));
    assert_eq!(result, Ok(()));
}

#[test]
fn three_denials_lock_unknown_browsers_for_ten_minutes() {
    let (mut core, clock) = online_core();
    let key = fixture_key();
    for attempt in 0..3_u64 {
        let viewer = format!("vw_{attempt}");
        let effects = pair_up(&mut core, &viewer, &key, clock.at(attempt * 10));
        assert!(shows_main(&effects), "attempt {attempt}");
        let (result, _) = decide(&mut core, Decision::Deny, clock.at(attempt * 10 + 1));
        assert_eq!(result, Ok(()));
    }
    let effects = pair_up(&mut core, "vw_locked", &key, clock.at(60));
    assert_eq!(
        sent(&effects),
        vec![(
            "vw_locked".to_owned(),
            json!({ "k": "denied", "reason": "busy" })
        )]
    );
    assert!(core.status().pending.is_none());
    let effects = pair_up(&mut core, "vw_later", &key, clock.at(60 + 601));
    assert!(shows_main(&effects), "the lockout ended");
}

#[test]
fn an_unanswered_prompt_times_out() {
    let (mut core, clock) = online_core();
    pair_up(&mut core, VIEWER, &fixture_key(), clock.at(0));
    let effects = core.tick(clock.at(119));
    assert!(sent(&effects).is_empty());
    assert!(core.status().pending.is_some());
    let effects = core.tick(clock.at(120));
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            json!({ "k": "denied", "reason": "timeout" })
        )]
    );
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Denied)]
    );
    assert!(core.status().pending.is_none());
    let (result, _) = decide(&mut core, Decision::Once, clock.at(121));
    assert_eq!(result, Err(RemoteError::NotFound));
}

#[test]
fn a_closed_browser_takes_its_prompt_with_it() {
    let (mut core, clock) = online_core();
    pair_up(&mut core, VIEWER, &fixture_key(), clock.at(0));
    core.link_event(LinkEvent::ViewerClose(VIEWER.to_owned()), clock.at(1));
    assert!(core.status().pending.is_none());
    let (result, _) = decide(&mut core, Decision::Always, clock.at(2));
    assert_eq!(result, Err(RemoteError::NotFound));
}

#[test]
fn deciding_needs_the_pending_request() {
    let (mut core, clock) = online_core();
    pair_up(&mut core, VIEWER, &fixture_key(), clock.at(0));
    let (result, effects) = core.command(
        Command::Decide {
            request_id: "req_other".to_owned(),
            decision: Decision::Always,
        },
        clock.at(1),
    );
    assert_eq!(result, Err(RemoteError::NotFound));
    assert!(effects.is_empty());
    assert!(core.status().pending.is_some());
}

#[test]
fn the_ninth_remembered_browser_is_refused_and_the_prompt_stays() {
    let (mut core, clock) = online_core();
    for seed in 1..=8_u8 {
        let viewer = format!("vw_{seed}");
        pair_up(
            &mut core,
            &viewer,
            &other_key(seed),
            clock.at(u64::from(seed)),
        );
        let (result, _) = decide(&mut core, Decision::Always, clock.at(u64::from(seed)));
        assert_eq!(result, Ok(()), "browser {seed}");
        core.link_event(LinkEvent::ViewerClose(viewer), clock.at(u64::from(seed)));
    }
    assert_eq!(core.status().browsers.len(), 8);
    pair_up(&mut core, "vw_ninth", &other_key(9), clock.at(20));
    let (result, effects) = decide(&mut core, Decision::Always, clock.at(21));
    assert_eq!(result, Err(RemoteError::Limit));
    assert!(sent(&effects).is_empty());
    assert!(core.status().pending.is_some());
    assert_eq!(core.status().browsers.len(), 8);
    let (result, _) = decide(&mut core, Decision::Once, clock.at(22));
    assert_eq!(result, Ok(()));
}

#[test]
fn a_bad_proof_is_a_protocol_error() {
    let (mut core, clock) = online_core();
    open(&mut core, VIEWER, clock.at(0));
    say(&mut core, VIEWER, hello_for(&fixture_key()), clock.at(0));
    let effects = say(&mut core, VIEWER, proof("bad"), clock.at(0));
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Protocol)]
    );
    assert!(sent(&effects).is_empty());
    assert!(!shows_main(&effects));
    assert!(core.status().pending.is_none());
}

#[test]
fn messages_out_of_order_drop_the_browser() {
    let key = fixture_key();
    let cases: Vec<(&str, Vec<ViewerMessage>)> = vec![
        (
            "request before hello",
            vec![request(1, "bootstrap_v10", json!({}))],
        ),
        ("proof before hello", vec![proof("good")]),
        (
            "unknown kind before the welcome",
            vec![ViewerMessage::Unknown],
        ),
        (
            "other protocol",
            vec![ViewerMessage::Hello {
                proto: 2,
                key: encode_key(&key),
                label: String::new(),
            }],
        ),
        (
            "broken key",
            vec![ViewerMessage::Hello {
                proto: 1,
                key: "not-a-key".to_owned(),
                label: String::new(),
            }],
        ),
        ("second hello", vec![hello_for(&key), hello_for(&key)]),
        (
            "request before the proof",
            vec![hello_for(&key), request(1, "bootstrap_v10", json!({}))],
        ),
    ];
    for (name, messages) in cases {
        let (mut core, clock) = online_core();
        open(&mut core, VIEWER, clock.at(0));
        let mut last = Vec::new();
        for message in messages {
            last = say(&mut core, VIEWER, message, clock.at(0));
        }
        assert_eq!(
            dropped(&last),
            vec![(VIEWER.to_owned(), DropReason::Protocol)],
            "{name}"
        );
        // The browser is gone: a later message is dropped again.
        let again = say(&mut core, VIEWER, hello_for(&key), clock.at(1));
        assert_eq!(
            dropped(&again),
            vec![(VIEWER.to_owned(), DropReason::Protocol)],
            "{name}"
        );
    }
}

#[test]
fn a_waiting_browser_that_talks_is_dropped_and_its_prompt_withdrawn() {
    let (mut core, clock) = online_core();
    pair_up(&mut core, VIEWER, &fixture_key(), clock.at(0));
    let effects = say(
        &mut core,
        VIEWER,
        request(1, "bootstrap_v10", json!({})),
        clock.at(1),
    );
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Protocol)]
    );
    assert!(core.status().pending.is_none());
}

#[test]
fn a_malformed_message_drops_the_browser() {
    let (mut core, clock) = welcomed_core();
    let effects = core.link_event(
        LinkEvent::Malformed {
            viewer: VIEWER.to_owned(),
        },
        clock.at(2),
    );
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Protocol)]
    );
    assert_eq!(core.welcomed(), 0);
}

#[test]
fn a_stalled_handshake_is_dropped_after_ten_seconds() {
    let (mut core, clock) = online_core();
    open(&mut core, "vw_a", clock.at(0));
    open(&mut core, "vw_b", clock.at(0));
    say(&mut core, "vw_b", hello_for(&fixture_key()), clock.at(5));
    assert!(dropped(&core.tick(clock.at(9))).is_empty());
    let dropped_at_ten = dropped(&core.tick(clock.at(10)));
    assert_eq!(
        dropped_at_ten,
        vec![("vw_a".to_owned(), DropReason::Protocol)]
    );
    // The proof deadline counts from the hello.
    assert!(dropped(&core.tick(clock.at(14))).is_empty());
    assert_eq!(
        dropped(&core.tick(clock.at(15))),
        vec![("vw_b".to_owned(), DropReason::Protocol)]
    );
}

#[test]
fn at_most_two_browsers_are_open_and_unknown_ones_are_ignored() {
    let (mut core, clock) = online_core();
    open(&mut core, "vw_a", clock.at(0));
    open(&mut core, "vw_b", clock.at(0));
    let effects = open(&mut core, "vw_c", clock.at(0));
    assert_eq!(
        dropped(&effects),
        vec![("vw_c".to_owned(), DropReason::Protocol)]
    );
    let effects = say(
        &mut core,
        "vw_ghost",
        hello_for(&fixture_key()),
        clock.at(0),
    );
    assert_eq!(
        dropped(&effects),
        vec![("vw_ghost".to_owned(), DropReason::Protocol)]
    );
    // A reused id starts over.
    let effects = open(&mut core, "vw_a", clock.at(1));
    assert_eq!(
        dropped(&effects),
        vec![("vw_a".to_owned(), DropReason::Protocol)]
    );
}

#[test]
fn a_new_connection_forgets_every_browser_without_sending() {
    let (mut core, clock) = welcomed_core();
    pair_up(&mut core, "vw_two", &other_key(3), clock.at(2));
    assert!(core.status().pending.is_some());
    let effects = core.link_event(LinkEvent::State(LinkState::Retrying), clock.at(3));
    assert!(sent(&effects).is_empty());
    assert!(dropped(&effects).is_empty());
    assert_eq!(core.welcomed(), 0);
    assert!(core.status().viewers.is_empty());
    assert!(core.status().pending.is_none());
    assert_eq!(core.status().link, LinkStateV1::Retrying);
}

#[test]
fn link_events_are_ignored_while_no_link_runs() {
    let mut core = Core::new(config(false), signed_in(0));
    let clock = Clock::new();
    let effects = open(&mut core, VIEWER, clock.at(0));
    assert!(effects.is_empty());
    assert_eq!(core.welcomed(), 0);
}

// -- requests ---------------------------------------------------------------

#[test]
fn admitted_requests_are_dispatched_and_refused_ones_answered() {
    let (mut core, clock) = welcomed_core();
    let effects = say(
        &mut core,
        VIEWER,
        request(
            1,
            "workspace_command_v15",
            json!({ "command": { "type": "catalog" } }),
        ),
        clock.at(2),
    );
    assert_eq!(
        dispatched(&effects),
        vec![(VIEWER.to_owned(), 1, "workspace_command_v15")]
    );
    assert!(sent(&effects).is_empty());

    let effects = say(
        &mut core,
        VIEWER,
        request(
            2,
            "nano_remote_set_enabled_v1",
            json!({ "request": { "enabled": false } }),
        ),
        clock.at(2),
    );
    assert!(dispatched(&effects).is_empty());
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            fixture()["frames"]["refusal"]["d"].clone()
        )]
    );

    let effects = say(
        &mut core,
        VIEWER,
        request(3, "get_session_catalog", json!({ "projectId": 1 })),
        clock.at(2),
    );
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            json!({ "k": "res", "id": 3, "ok": false, "error": { "code": "remote-invalid" } })
        )]
    );
}

#[test]
fn at_most_eight_requests_run_at_once() {
    let (mut core, clock) = welcomed_core();
    for id in 1..=8 {
        let effects = say(
            &mut core,
            VIEWER,
            request(id, "bootstrap_v10", json!({})),
            clock.at(2),
        );
        assert_eq!(dispatched(&effects).len(), 1, "request {id}");
    }
    let effects = say(
        &mut core,
        VIEWER,
        request(9, "bootstrap_v10", json!({})),
        clock.at(2),
    );
    assert!(dispatched(&effects).is_empty());
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            json!({ "k": "res", "id": 9, "ok": false, "error": { "code": "remote-busy" } })
        )]
    );
    // A request that is refused never counts against the limit.
    let effects = say(
        &mut core,
        VIEWER,
        request(10, "plugin_command_v1", json!({})),
        clock.at(2),
    );
    assert_eq!(sent(&effects)[0].1["error"]["code"], "remote-not-allowed");

    assert!(core.dispatched(VIEWER, 1, true).is_empty());
    let effects = say(
        &mut core,
        VIEWER,
        request(11, "bootstrap_v10", json!({})),
        clock.at(3),
    );
    assert_eq!(dispatched(&effects).len(), 1);
}

#[test]
fn a_request_id_is_unique_while_it_runs() {
    let (mut core, clock) = welcomed_core();
    say(
        &mut core,
        VIEWER,
        request(5, "bootstrap_v10", json!({})),
        clock.at(2),
    );
    let effects = say(
        &mut core,
        VIEWER,
        request(5, "bootstrap_v10", json!({})),
        clock.at(2),
    );
    assert_eq!(sent(&effects)[0].1["error"]["code"], "remote-invalid");
    core.dispatched(VIEWER, 5, true);
    let effects = say(
        &mut core,
        VIEWER,
        request(5, "bootstrap_v10", json!({})),
        clock.at(3),
    );
    assert_eq!(dispatched(&effects).len(), 1);
}

#[test]
fn a_request_id_must_be_a_positive_safe_integer() {
    for id in [0_u64, 9_007_199_254_740_992, u64::MAX] {
        let (mut core, clock) = welcomed_core();
        let effects = say(
            &mut core,
            VIEWER,
            request(id, "bootstrap_v10", json!({})),
            clock.at(2),
        );
        assert_eq!(
            dropped(&effects),
            vec![(VIEWER.to_owned(), DropReason::Protocol)],
            "{id}"
        );
    }
    let (mut core, clock) = welcomed_core();
    let effects = say(
        &mut core,
        VIEWER,
        request(9_007_199_254_740_991, "bootstrap_v10", json!({})),
        clock.at(2),
    );
    assert_eq!(dispatched(&effects).len(), 1);
}

#[test]
fn unknown_kinds_after_the_welcome_are_ignored() {
    let (mut core, clock) = welcomed_core();
    let effects = say(&mut core, VIEWER, ViewerMessage::Unknown, clock.at(2));
    assert!(effects.is_empty());
    assert_eq!(core.welcomed(), 1);
}

#[test]
fn a_frame_that_cannot_be_sent_drops_the_browser() {
    let (mut core, _) = welcomed_core();
    assert!(core.dispatched(VIEWER, 1, true).is_empty());
    let effects = core.dispatched(VIEWER, 2, false);
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Protocol)]
    );
    assert_eq!(core.welcomed(), 0);

    let (mut core, _) = welcomed_core();
    let effects = core.send_failed(VIEWER);
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Protocol)]
    );
    assert!(core.send_failed(VIEWER).is_empty());
}

// -- events -------------------------------------------------------------------

#[test]
fn host_events_reach_welcomed_browsers_only() {
    let (mut core, clock) = welcomed_core();
    open(&mut core, "vw_two", clock.at(2));
    let effects = core.host_event("piui://composer-v19", r#"{"sessionId":"s1"}"#);
    assert_eq!(
        sent(&effects),
        vec![(
            VIEWER.to_owned(),
            json!({ "k": "ev", "ch": "piui://composer-v19", "p": { "sessionId": "s1" } })
        )]
    );
    assert!(
        core.host_event("piui://composer-v19", "not json")
            .is_empty()
    );
    let huge = format!("\"{}\"", "a".repeat(300_000));
    assert!(core.host_event("piui://workspace-event", &huge).is_empty());
}

#[test]
fn host_events_wait_for_a_welcome() {
    let (mut core, clock) = online_core();
    open(&mut core, VIEWER, clock.at(0));
    assert!(core.host_event("piui://composer-v19", "{}").is_empty());
}

#[test]
fn a_lost_event_drops_every_welcomed_browser() {
    let (mut core, clock) = welcomed_core();
    open(&mut core, "vw_two", clock.at(2));
    let effects = core.overflowed();
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Protocol)]
    );
    assert_eq!(core.welcomed(), 0);
}

// -- kicking, forgetting, switching off ---------------------------------------

#[test]
fn kicking_says_bye_and_drops() {
    let (mut core, clock) = welcomed_core();
    let (result, effects) = core.command(
        Command::Kick {
            viewer_id: VIEWER.to_owned(),
        },
        clock.at(3),
    );
    assert_eq!(result, Ok(()));
    assert_eq!(
        sent(&effects),
        vec![(VIEWER.to_owned(), json!({ "k": "bye", "reason": "kicked" }))]
    );
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Kicked)]
    );
    assert!(core.status().viewers.is_empty());
    let (result, effects) = core.command(
        Command::Kick {
            viewer_id: VIEWER.to_owned(),
        },
        clock.at(4),
    );
    assert_eq!(result, Err(RemoteError::NotFound));
    assert!(effects.is_empty());
}

#[test]
fn forgetting_a_browser_kicks_the_viewers_using_its_key() {
    let (mut core, clock) = online_core();
    let key = fixture_key();
    pair_up(&mut core, VIEWER, &key, clock.at(0));
    decide(&mut core, Decision::Always, clock.at(1))
        .0
        .expect("remembered");
    let (result, effects) = core.command(
        Command::Forget {
            browser_id: "br_unknown".to_owned(),
        },
        clock.at(2),
    );
    assert_eq!(result, Err(RemoteError::NotFound));
    assert!(effects.is_empty());
    assert_eq!(core.welcomed(), 1);

    let (result, effects) = core.command(
        Command::Forget {
            browser_id: "br_synthetic01".to_owned(),
        },
        clock.at(3),
    );
    assert_eq!(result, Ok(()));
    assert_eq!(
        sent(&effects),
        vec![(VIEWER.to_owned(), json!({ "k": "bye", "reason": "kicked" }))]
    );
    assert_eq!(
        dropped(&effects),
        vec![(VIEWER.to_owned(), DropReason::Kicked)]
    );
    assert!(core.status().browsers.is_empty());
    assert_eq!(core.welcomed(), 0);

    // The forgotten key is unknown again.
    let effects = pair_up(&mut core, "vw_two", &key, clock.at(4));
    assert!(shows_main(&effects));
}

#[test]
fn switching_off_says_bye_to_everyone_then_closes_the_link() {
    let (mut core, clock) = welcomed_core();
    pair_up(&mut core, "vw_two", &other_key(5), clock.at(2));
    assert!(core.status().pending.is_some());
    let (result, effects) = core.command(Command::SetEnabled(false), clock.at(3));
    assert_eq!(result, Ok(()));
    assert_eq!(
        sent(&effects),
        vec![
            (
                VIEWER.to_owned(),
                json!({ "k": "bye", "reason": "disabled" })
            ),
            (
                "vw_two".to_owned(),
                json!({ "k": "denied", "reason": "denied" })
            ),
        ]
    );
    assert_eq!(
        dropped(&effects),
        vec![
            (VIEWER.to_owned(), DropReason::Disabled),
            ("vw_two".to_owned(), DropReason::Disabled),
        ]
    );
    let stop = effects
        .iter()
        .position(|effect| matches!(effect, Effect::Stop))
        .expect("the link is closed");
    let last_frame = effects
        .iter()
        .rposition(|effect| matches!(effect, Effect::Send { .. } | Effect::Drop { .. }))
        .expect("frames");
    assert!(
        stop > last_frame,
        "the link closes after the frames are queued"
    );
    assert!(core.status().viewers.is_empty());
    assert!(core.status().pending.is_none());
}
