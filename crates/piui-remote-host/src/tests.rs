//! Two-endpoint tests: real TLS 1.3 handshakes between two in-process
//! endpoints, pairing between the two state machines, relays that forward or
//! terminate, and authorization over the resulting channels. Nothing here is
//! mocked: every key, signature, agreement, SAS and MAC is computed.

mod vectors;

use std::num::NonZeroU32;
use std::sync::Arc;

use rustls::client::{AlwaysResolvesClientRawPublicKeys, ResolvesClientCert, Resumption};
use rustls::server::AlwaysResolvesServerRawPublicKeys;
use rustls::sign::CertifiedKey;
use rustls::{AlertDescription, PeerIncompatible, SignatureScheme};
use vodozemac::sas::Sas;

use crate::b64;
use crate::framing::{FramingError, MessageLimit};
use crate::identity::IdentityKey;
use crate::ids::{AccountId, DeviceId, GrantId, HostId};
use crate::pairing::transcript::commitment;
use crate::pairing::{
    CancelCode, ControllerPairing, ControllerStep, PairingError, PairingIdentity, PairingMessage,
    Party, SasCode, TargetPairing, TargetStep,
};
use crate::policy::{
    GrantRecord, GrantState, HarnessId, HostPolicy, LocalBinding, PermissionMode, Permissions,
    PolicyRefusal, ProjectId, ProjectTrust, authorize,
};
use crate::relay::{Inbound, Outbound, RelayFrameV1};
use crate::tls::testing::{
    certified, controller_config_for, controller_with, server_verifier, target_config_for,
    target_with, tls13_client,
};
use crate::tls::{
    ALPN, ChannelEndpoints, ChannelError, ChannelRole, PeerKeyPolicy, PeerKeyStatus, SecureChannel,
};

/// The message limit of nano-host-v1.ts: the Desktop API document cap
/// (`MAX_API_BODY` of piui-nano). The vectors test checks the fixture.
pub(crate) const MAX_MESSAGE: u32 = 2 * 1024 * 1024;

fn limit() -> MessageLimit {
    MessageLimit::new(NonZeroU32::new(MAX_MESSAGE).expect("non-zero"))
}

fn key() -> IdentityKey {
    IdentityKey::generate().expect("identity key")
}

fn pinned_to(key: &IdentityKey) -> PeerKeyPolicy {
    PeerKeyPolicy::Pinned(key.spki().clone())
}

/// Moves bytes both ways until neither side has anything to send. Failures
/// stay in each channel's `failure()`.
fn pump(controller: &mut SecureChannel, target: &mut SecureChannel) {
    loop {
        let to_target = controller.transmit();
        let to_controller = target.transmit();
        if to_target.is_empty() && to_controller.is_empty() {
            return;
        }
        if !to_target.is_empty() {
            let _ = target.receive(&to_target);
        }
        if !to_controller.is_empty() {
            let _ = controller.receive(&to_controller);
        }
    }
}

fn connect(
    controller_key: &IdentityKey,
    controller_policy: PeerKeyPolicy,
    target_key: &IdentityKey,
    target_policy: PeerKeyPolicy,
) -> (SecureChannel, SecureChannel) {
    let mut controller =
        SecureChannel::controller(controller_key, controller_policy, limit()).expect("controller");
    let mut target = SecureChannel::target(target_key, target_policy, limit()).expect("target");
    pump(&mut controller, &mut target);
    (controller, target)
}

fn pinned(
    controller_key: &IdentityKey,
    target_key: &IdentityKey,
) -> (SecureChannel, SecureChannel) {
    connect(
        controller_key,
        pinned_to(target_key),
        target_key,
        pinned_to(controller_key),
    )
}

fn observing(
    controller_key: &IdentityKey,
    target_key: &IdentityKey,
) -> (SecureChannel, SecureChannel) {
    connect(
        controller_key,
        PeerKeyPolicy::ObserveForPairing,
        target_key,
        PeerKeyPolicy::ObserveForPairing,
    )
}

fn endpoints(channel: &SecureChannel) -> ChannelEndpoints {
    channel.endpoints().cloned().expect("established")
}

/// Sends one message from `from` and returns what `to` received.
fn deliver(from: &mut SecureChannel, to: &mut SecureChannel, payload: &[u8]) -> Vec<u8> {
    from.send(payload).expect("send");
    let bytes = from.transmit();
    to.receive(&bytes).expect("receive");
    to.recv().expect("one message")
}

fn identity() -> PairingIdentity {
    PairingIdentity {
        account_id: AccountId::parse("usr_synthetic01").expect("account"),
        host_id: HostId::parse("hst_AAECAwQFBgcICQoLDA0ODw").expect("host"),
        controller_device_id: DeviceId::parse("dev_EBESExQVFhcYGRobHB0eHw").expect("device"),
    }
}

fn alert(description: AlertDescription) -> ChannelError {
    ChannelError::PeerAlert(description)
}

// ---------------------------------------------------------------- channel

#[test]
fn pinned_channels_authenticate_both_keys_and_carry_messages() {
    let (controller_key, target_key) = (key(), key());
    let (mut controller, mut target) = pinned(&controller_key, &target_key);
    let at_controller = endpoints(&controller);
    let at_target = endpoints(&target);
    assert_eq!(
        (at_controller.role, at_target.role),
        (ChannelRole::Controller, ChannelRole::Target)
    );
    assert_eq!(at_controller.peer_key, PeerKeyStatus::Pinned);
    assert_eq!(at_target.peer_key, PeerKeyStatus::Pinned);
    assert_eq!(at_controller.target_spki(), target_key.spki());
    assert_eq!(at_controller.controller_spki(), controller_key.spki());
    assert_eq!(at_target.target_spki(), target_key.spki());
    assert_eq!(at_target.controller_spki(), controller_key.spki());
    assert_eq!(at_controller.channel_binding, at_target.channel_binding);
    assert!(!format!("{at_controller:?}").contains(&b64::encode(&at_controller.channel_binding)));

    assert_eq!(
        deliver(&mut controller, &mut target, br#"{"a":1}"#),
        br#"{"a":1}"#
    );
    let large = vec![b'x'; 300 * 1024];
    assert_eq!(deliver(&mut target, &mut controller, &large), large);
    let largest = vec![b'y'; MAX_MESSAGE as usize];
    assert_eq!(deliver(&mut controller, &mut target, &largest), largest);
    assert_eq!(
        controller.send(&vec![b'z'; MAX_MESSAGE as usize + 1]),
        Err(ChannelError::Framing(FramingError::TooLarge {
            declared: MAX_MESSAGE as usize + 1,
            limit: MAX_MESSAGE as usize,
        }))
    );
    assert_eq!(
        deliver(&mut controller, &mut target, b"{}"),
        b"{}",
        "a refused send writes nothing"
    );

    controller.close();
    let bytes = controller.transmit();
    target.receive(&bytes).expect("close_notify");
    assert!(target.is_closed());
    assert_eq!(target.send(b"{}"), Err(ChannelError::Closed));
}

#[test]
fn two_handshakes_of_the_same_keys_have_different_channel_bindings() {
    let (controller_key, target_key) = (key(), key());
    let (first, _) = pinned(&controller_key, &target_key);
    let (second, _) = pinned(&controller_key, &target_key);
    assert_ne!(
        endpoints(&first).channel_binding,
        endpoints(&second).channel_binding
    );
}

#[test]
fn messages_wait_for_the_handshake() {
    let (controller_key, target_key) = (key(), key());
    let mut controller =
        SecureChannel::controller(&controller_key, pinned_to(&target_key), limit())
            .expect("controller");
    assert_eq!(controller.send(b"{}"), Err(ChannelError::NotEstablished));
}

#[test]
fn a_pinned_channel_refuses_any_other_peer_key() {
    let (controller_key, target_key, other) = (key(), key(), key());
    let (controller, target) = connect(
        &controller_key,
        pinned_to(&other),
        &target_key,
        pinned_to(&controller_key),
    );
    assert_eq!(controller.failure(), Some(&ChannelError::PeerKeyChanged));
    assert_eq!(
        target.failure(),
        Some(&alert(AlertDescription::CertificateUnknown))
    );

    let (controller, target) = connect(
        &controller_key,
        pinned_to(&target_key),
        &target_key,
        pinned_to(&other),
    );
    assert_eq!(target.failure(), Some(&ChannelError::PeerKeyChanged));
    assert_eq!(
        controller.failure(),
        Some(&alert(AlertDescription::CertificateUnknown))
    );
}

#[test]
fn a_relay_that_terminates_tls_cannot_pass_pinned_channels() {
    let (controller_key, target_key, relay_key) = (key(), key(), key());
    let (controller, relay_as_target) = connect(
        &controller_key,
        pinned_to(&target_key),
        &relay_key,
        PeerKeyPolicy::ObserveForPairing,
    );
    assert_eq!(controller.failure(), Some(&ChannelError::PeerKeyChanged));
    assert!(relay_as_target.endpoints().is_none());

    let (relay_as_controller, target) = connect(
        &relay_key,
        PeerKeyPolicy::ObserveForPairing,
        &target_key,
        pinned_to(&controller_key),
    );
    assert_eq!(target.failure(), Some(&ChannelError::PeerKeyChanged));
    assert!(relay_as_controller.endpoints().is_none());
}

#[test]
fn a_forwarding_relay_carries_only_ciphertext_in_frame_order() {
    const MARKER: &[u8] = b"PLAINTEXT-MARKER-relay";
    let (controller_key, target_key) = (key(), key());
    let mut controller =
        SecureChannel::controller(&controller_key, pinned_to(&target_key), limit())
            .expect("controller");
    let mut target =
        SecureChannel::target(&target_key, pinned_to(&controller_key), limit()).expect("target");
    let (mut up_out, mut up_in) = (Outbound::new(), Inbound::new());
    let (mut down_out, mut down_in) = (Outbound::new(), Inbound::new());
    let mut wire = Vec::new();
    let mut relay = |bytes: Vec<u8>, outbound: &mut Outbound, inbound: &mut Inbound| -> Vec<u8> {
        let text = serde_json::to_string(&outbound.frame(&bytes).expect("frame")).expect("json");
        let frame: RelayFrameV1 = serde_json::from_str(&text).expect("parse");
        wire.push(text);
        inbound.accept(&frame).expect("in order")
    };
    let mut sent = false;
    loop {
        if controller.endpoints().is_some() && !sent {
            controller.send(MARKER).expect("send");
            sent = true;
        }
        let up = controller.transmit();
        let down = target.transmit();
        if up.is_empty() && down.is_empty() {
            break;
        }
        if !up.is_empty() {
            target
                .receive(&relay(up, &mut up_out, &mut up_in))
                .expect("target");
        }
        if !down.is_empty() {
            controller
                .receive(&relay(down, &mut down_out, &mut down_in))
                .expect("controller");
        }
    }
    assert_eq!(target.recv().as_deref(), Some(MARKER));
    let encoded = b64::encode(MARKER);
    for text in &wire {
        assert!(!text.contains("PLAINTEXT-MARKER") && !text.contains(&encoded));
    }
}

#[test]
fn a_relay_sequence_violation_ends_the_channel_until_a_new_handshake() {
    let (controller_key, target_key) = (key(), key());
    let channels = || {
        (
            SecureChannel::controller(&controller_key, pinned_to(&target_key), limit())
                .expect("controller"),
            SecureChannel::target(&target_key, pinned_to(&controller_key), limit())
                .expect("target"),
        )
    };
    // The relay repeats the controller's first flight: the target refuses
    // it, and every later frame of that channel.
    let (mut controller, _) = channels();
    let (mut up, mut target_in) = (Outbound::new(), Inbound::new());
    let hello = up.frame(&controller.transmit()).expect("frame");
    assert!(target_in.accept(&hello).is_ok());
    assert!(target_in.accept(&hello).is_err());
    let next = up.frame(b"x").expect("frame");
    assert!(
        target_in.accept(&next).is_err(),
        "the channel continued after a repeated frame"
    );
    // Recovery: new channels, a full handshake and new frame numbers.
    let (mut controller, mut target) = channels();
    let (mut up, mut target_in) = (Outbound::new(), Inbound::new());
    let (mut down, mut controller_in) = (Outbound::new(), Inbound::new());
    loop {
        let to_target = controller.transmit();
        let to_controller = target.transmit();
        if to_target.is_empty() && to_controller.is_empty() {
            break;
        }
        if !to_target.is_empty() {
            let frame = up.frame(&to_target).expect("frame");
            let bytes = target_in.accept(&frame).expect("in order");
            target.receive(&bytes).expect("target");
        }
        if !to_controller.is_empty() {
            let frame = down.frame(&to_controller).expect("frame");
            let bytes = controller_in.accept(&frame).expect("in order");
            controller.receive(&bytes).expect("controller");
        }
    }
    assert_eq!(endpoints(&controller).peer_key, PeerKeyStatus::Pinned);
    controller.send(b"{}").expect("send");
    let frame = up.frame(&controller.transmit()).expect("frame");
    let bytes = target_in.accept(&frame).expect("in order");
    target.receive(&bytes).expect("target");
    assert_eq!(target.recv().as_deref(), Some(&b"{}"[..]));
}

#[derive(Debug)]
struct NoClientKey;

impl ResolvesClientCert for NoClientKey {
    fn resolve(&self, _hints: &[&[u8]], _schemes: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        None
    }

    fn only_raw_public_keys(&self) -> bool {
        true
    }

    fn has_certs(&self) -> bool {
        false
    }
}

#[test]
fn a_client_without_a_key_is_refused() {
    let (controller_key, target_key) = (key(), key());

    // A raw-key client that presents an empty certificate.
    let mut config = controller_config_for(&controller_key, pinned_to(&target_key));
    config.client_auth_cert_resolver = Arc::new(NoClientKey);
    let mut controller = controller_with(
        config,
        controller_key.spki(),
        pinned_to(&target_key),
        limit(),
    );
    let mut target =
        SecureChannel::target(&target_key, pinned_to(&controller_key), limit()).expect("target");
    pump(&mut controller, &mut target);
    assert_eq!(target.failure(), Some(&ChannelError::PeerKeyMissing));
    assert_eq!(
        controller.failure(),
        Some(&alert(AlertDescription::CertificateRequired))
    );

    // A client without any client authentication.
    let mut config = tls13_client()
        .dangerous()
        .with_custom_certificate_verifier(server_verifier(pinned_to(&target_key)))
        .with_no_client_auth();
    config.alpn_protocols = vec![ALPN.to_vec()];
    config.enable_sni = false;
    config.resumption = Resumption::disabled();
    let mut controller = controller_with(
        config,
        controller_key.spki(),
        pinned_to(&target_key),
        limit(),
    );
    let mut target =
        SecureChannel::target(&target_key, pinned_to(&controller_key), limit()).expect("target");
    pump(&mut controller, &mut target);
    // It offers no raw client key type, so rustls ends the handshake early.
    assert_eq!(
        target.failure(),
        Some(&ChannelError::Tls(rustls::Error::PeerIncompatible(
            PeerIncompatible::IncorrectCertificateTypeExtension
        )))
    );
    assert_eq!(
        controller.failure(),
        Some(&alert(AlertDescription::HandshakeFailure))
    );
}

#[test]
fn a_channel_without_nano_host_1_is_refused() {
    let (controller_key, target_key) = (key(), key());
    for offered in [vec![], vec![b"h2".to_vec()], vec![b"nano-host/2".to_vec()]] {
        let mut config = controller_config_for(&controller_key, pinned_to(&target_key));
        config.alpn_protocols = offered.clone();
        let mut controller = controller_with(
            config,
            controller_key.spki(),
            pinned_to(&target_key),
            limit(),
        );
        let mut target = SecureChannel::target(&target_key, pinned_to(&controller_key), limit())
            .expect("target");
        pump(&mut controller, &mut target);
        assert_eq!(
            target.failure(),
            Some(&ChannelError::WrongAlpn),
            "{offered:?}"
        );
        assert_eq!(
            controller.failure(),
            Some(&ChannelError::WrongAlpn),
            "{offered:?}"
        );
    }

    // A target that speaks another protocol.
    let mut config = target_config_for(&target_key, pinned_to(&controller_key));
    config.alpn_protocols = vec![b"h2".to_vec()];
    let mut target = target_with(
        Arc::new(config),
        target_key.spki(),
        pinned_to(&controller_key),
        limit(),
    );
    let mut controller =
        SecureChannel::controller(&controller_key, pinned_to(&target_key), limit())
            .expect("controller");
    pump(&mut controller, &mut target);
    assert_eq!(controller.failure(), Some(&ChannelError::WrongAlpn));
    assert_eq!(target.failure(), Some(&ChannelError::WrongAlpn));
}

#[test]
fn a_handshake_signature_by_another_key_is_refused() {
    let (controller_key, target_key, signer) = (key(), key(), key());

    // The controller presents its key but signs with another one.
    let mut config = controller_config_for(&controller_key, pinned_to(&target_key));
    config.client_auth_cert_resolver = Arc::new(AlwaysResolvesClientRawPublicKeys::new(certified(
        controller_key.spki(),
        signer.signer_for_tests(),
    )));
    let mut controller = controller_with(
        config,
        controller_key.spki(),
        pinned_to(&target_key),
        limit(),
    );
    let mut target =
        SecureChannel::target(&target_key, pinned_to(&controller_key), limit()).expect("target");
    pump(&mut controller, &mut target);
    assert_eq!(target.failure(), Some(&ChannelError::BadSignature));
    assert_eq!(
        controller.failure(),
        Some(&alert(AlertDescription::DecryptError))
    );

    // The target presents its key but signs with another one.
    let mut config = target_config_for(&target_key, pinned_to(&controller_key));
    config.cert_resolver = Arc::new(AlwaysResolvesServerRawPublicKeys::new(certified(
        target_key.spki(),
        signer.signer_for_tests(),
    )));
    let mut target = target_with(
        Arc::new(config),
        target_key.spki(),
        pinned_to(&controller_key),
        limit(),
    );
    let mut controller =
        SecureChannel::controller(&controller_key, pinned_to(&target_key), limit())
            .expect("controller");
    pump(&mut controller, &mut target);
    assert_eq!(controller.failure(), Some(&ChannelError::BadSignature));
    assert_eq!(
        target.failure(),
        Some(&alert(AlertDescription::DecryptError))
    );
}

#[test]
fn reordered_or_replayed_tls_records_end_the_channel() {
    let (controller_key, target_key) = (key(), key());
    let (mut controller, mut target) = pinned(&controller_key, &target_key);
    controller.send(br#"{"n":1}"#).expect("send");
    let first = controller.transmit();
    controller.send(br#"{"n":2}"#).expect("send");
    let second = controller.transmit();
    assert!(target.receive(&second).is_err());
    assert_eq!(
        target.failure(),
        Some(&ChannelError::Tls(rustls::Error::DecryptError))
    );
    assert_eq!(target.recv(), None);

    let (mut controller, mut target) = pinned(&controller_key, &target_key);
    controller.send(br#"{"n":1}"#).expect("send");
    let first_again = controller.transmit();
    target.receive(&first_again).expect("first");
    assert_eq!(target.recv().as_deref(), Some(&br#"{"n":1}"#[..]));
    assert!(target.receive(&first_again).is_err(), "a replayed record");
    assert_eq!(
        target.failure(),
        Some(&ChannelError::Tls(rustls::Error::DecryptError))
    );
    drop(first);
}

#[test]
fn a_client_that_sends_a_server_name_is_refused() {
    let (controller_key, target_key) = (key(), key());
    let mut config = controller_config_for(&controller_key, pinned_to(&target_key));
    config.enable_sni = true;
    let mut controller = controller_with(
        config,
        controller_key.spki(),
        pinned_to(&target_key),
        limit(),
    );
    let mut target =
        SecureChannel::target(&target_key, pinned_to(&controller_key), limit()).expect("target");
    pump(&mut controller, &mut target);
    assert_eq!(target.failure(), Some(&ChannelError::UnexpectedServerName));
    // The target refuses after its handshake completed: it can only close.
    assert!(controller.is_closed(), "{:?}", controller.failure());
    assert!(controller.endpoints().is_none());
}

#[test]
fn the_target_never_lets_a_client_resume() {
    let (controller_key, target_key) = (key(), key());
    // A client that would resume and send early data if it could, with
    // rustls' default session store: `ClientSessionMemoryCache::new` keeps
    // nothing for a single server below nine sessions (rustls 0.23.45
    // `client/handy.rs`), which would make this test pass vacuously. With
    // tickets enabled on the target, this client resumes and `establish`
    // refuses both ends (mutation check in the evidence).
    let mut client = controller_config_for(&controller_key, pinned_to(&target_key));
    client.resumption = Resumption::default();
    client.enable_early_data = true;
    let server = Arc::new(target_config_for(&target_key, pinned_to(&controller_key)));
    for attempt in 0..3 {
        let mut controller = controller_with(
            client.clone(),
            controller_key.spki(),
            pinned_to(&target_key),
            limit(),
        );
        let mut target = target_with(
            Arc::clone(&server),
            target_key.spki(),
            pinned_to(&controller_key),
            limit(),
        );
        pump(&mut controller, &mut target);
        // `establish` refuses anything but a full handshake.
        assert!(
            controller.endpoints().is_some(),
            "attempt {attempt}: {:?}",
            controller.failure()
        );
        assert!(
            target.endpoints().is_some(),
            "attempt {attempt}: {:?}",
            target.failure()
        );
    }
}

// ---------------------------------------------------------------- pairing

/// Runs pairing up to the code: the controller shows it, the target waits
/// for the owner to type it.
fn until_code(
    at_controller: &ChannelEndpoints,
    at_target: &ChannelEndpoints,
) -> (ControllerPairing, TargetPairing, SasCode) {
    let (mut controller, start) =
        ControllerPairing::start(at_controller, identity()).expect("start");
    let mut target = TargetPairing::new(at_target, identity()).expect("target");
    let Ok(TargetStep::Send(accept)) = target.receive(&start) else {
        panic!("accept");
    };
    let Ok(ControllerStep::Send(controller_key)) = controller.receive(&accept) else {
        panic!("controller key");
    };
    let Ok(TargetStep::SendAndAskForCode(target_key)) = target.receive(&controller_key) else {
        panic!("target key");
    };
    let Ok(ControllerStep::ShowCode(code)) = controller.receive(&target_key) else {
        panic!("code");
    };
    (controller, target, code)
}

fn observing_endpoints() -> (ChannelEndpoints, ChannelEndpoints) {
    let (controller, target) = observing(&key(), &key());
    (endpoints(&controller), endpoints(&target))
}

fn local_abort(code: CancelCode) -> impl Fn(&PairingError) -> bool {
    move |error| {
        matches!(error, PairingError::Aborted { code: found, by: Party::Local, notify_peer: Some(notice) }
            if *found == code && PairingMessage::decode(notice) == Ok(PairingMessage::Cancel { code }))
    }
}

fn assert_local_abort<T: std::fmt::Debug>(result: Result<T, PairingError>, code: CancelCode) {
    match result {
        Err(error) if local_abort(code)(&error) => {}
        other => panic!("expected a local {code:?} abort, got {other:?}"),
    }
}

#[test]
fn pairing_pins_both_keys_only_after_both_owners_confirm() {
    let (controller_key, target_key) = (key(), key());
    let (mut controller_channel, mut target_channel) = observing(&controller_key, &target_key);
    let at_controller = endpoints(&controller_channel);
    let at_target = endpoints(&target_channel);
    assert_eq!(at_controller.peer_key, PeerKeyStatus::Observed);

    let (mut controller, start) =
        ControllerPairing::start(&at_controller, identity()).expect("start");
    let mut target = TargetPairing::new(&at_target, identity()).expect("target");
    let up = |from: &mut SecureChannel, to: &mut SecureChannel, message: &[u8]| {
        deliver(from, to, message)
    };

    let received = up(&mut controller_channel, &mut target_channel, &start);
    let Ok(TargetStep::Send(accept)) = target.receive(&received) else {
        panic!("accept");
    };
    let received = up(&mut target_channel, &mut controller_channel, &accept);
    let Ok(ControllerStep::Send(controller_ephemeral)) = controller.receive(&received) else {
        panic!("controller key");
    };
    let received = up(
        &mut controller_channel,
        &mut target_channel,
        &controller_ephemeral,
    );
    let Ok(TargetStep::SendAndAskForCode(target_ephemeral)) = target.receive(&received) else {
        panic!("target key");
    };
    let received = up(
        &mut target_channel,
        &mut controller_channel,
        &target_ephemeral,
    );
    let Ok(ControllerStep::ShowCode(code)) = controller.receive(&received) else {
        panic!("code");
    };
    assert!(
        code.numbers()
            .iter()
            .all(|number| (1000..=9191).contains(number))
    );

    // The owner types the controller's code on the target.
    let target_mac = target.enter_code(&code.to_string()).expect("codes match");
    let received = up(&mut target_channel, &mut controller_channel, &target_mac);
    assert_eq!(controller.receive(&received), Ok(ControllerStep::AskOwner));
    assert_eq!(
        controller.pin_stored(),
        Err(PairingError::OutOfTurn),
        "no pin before the owner answers"
    );

    // The owner confirms on the controller that the target showed a match.
    let pin = controller.confirm_target(true).expect("pin");
    assert_eq!(&pin.target_spki, target_key.spki());
    assert_eq!(pin.identity, identity());
    let controller_mac = controller.pin_stored().expect("controller mac");
    let received = up(
        &mut controller_channel,
        &mut target_channel,
        &controller_mac,
    );
    let Ok(TargetStep::RegisterGrant(verified)) = target.receive(&received) else {
        panic!("grant");
    };
    assert_eq!(&verified.controller_spki, controller_key.spki());
    assert_eq!(&verified.target_spki, target_key.spki());
    let record = GrantRecord::pending(&verified);
    assert_eq!(record.state, GrantState::PendingRegistration);
    let paired = target.grant_registered().expect("paired");
    let received = up(&mut target_channel, &mut controller_channel, &paired);
    assert_eq!(
        controller.receive(&received),
        Ok(ControllerStep::Paired(verified.grant_id.clone()))
    );

    // Ordinary channels now pin exactly these keys.
    let (controller_channel, target_channel) = connect(
        &controller_key,
        PeerKeyPolicy::Pinned(pin.target_spki.clone()),
        &target_key,
        PeerKeyPolicy::Pinned(record.controller_spki.clone()),
    );
    assert_eq!(
        endpoints(&controller_channel).peer_key,
        PeerKeyStatus::Pinned
    );
    assert_eq!(endpoints(&target_channel).peer_key, PeerKeyStatus::Pinned);
}

#[test]
fn pairing_needs_an_observing_channel_of_its_own_role() {
    let (at_controller, at_target) = observing_endpoints();
    assert_eq!(
        ControllerPairing::start(&at_target, identity()).err(),
        Some(PairingError::NotAPairingChannel)
    );
    assert_eq!(
        TargetPairing::new(&at_controller, identity()).err(),
        Some(PairingError::NotAPairingChannel)
    );
    let (controller, target) = pinned(&key(), &key());
    let (controller_key, target_key) = (key(), key());
    let (other_controller, other_target) = pinned(&controller_key, &target_key);
    for at in [endpoints(&controller), endpoints(&other_controller)] {
        assert_eq!(
            ControllerPairing::start(&at, identity()).err(),
            Some(PairingError::NotAPairingChannel)
        );
    }
    for at in [endpoints(&target), endpoints(&other_target)] {
        assert_eq!(
            TargetPairing::new(&at, identity()).err(),
            Some(PairingError::NotAPairingChannel)
        );
    }
}

#[test]
fn a_relay_that_terminates_tls_and_forwards_cannot_complete_pairing() {
    let (controller_key, target_key, relay_key) = (key(), key(), key());
    let (controller_side, _) = observing(&controller_key, &relay_key);
    let (_, target_side) = observing(&relay_key, &target_key);
    // The relay forwards every pairing message verbatim, so both ends even
    // agree on the X25519 secret; their transcripts still differ.
    let (_controller, mut target, code) =
        until_code(&endpoints(&controller_side), &endpoints(&target_side));
    assert_local_abort(
        target.enter_code(&code.to_string()),
        CancelCode::MismatchedSas,
    );
}

#[test]
fn a_relay_running_its_own_exchanges_is_stopped_by_the_controller_owner() {
    let (controller_key, target_key, relay_key) = (key(), key(), key());
    let (controller_side, relay_as_target) = observing(&controller_key, &relay_key);
    let (relay_as_controller, target_side) = observing(&relay_key, &target_key);

    let (mut controller, mut relay_target, controller_code) =
        until_code(&endpoints(&controller_side), &endpoints(&relay_as_target));
    let (_relay_controller, mut target, relay_code) =
        until_code(&endpoints(&relay_as_controller), &endpoints(&target_side));
    assert_ne!(controller_code, relay_code);

    // The owner types the controller's code on the real target: refused.
    assert_local_abort(
        target.enter_code(&controller_code.to_string()),
        CancelCode::MismatchedSas,
    );

    // The relay saw that code too and completes its own exchange with the
    // controller, so the controller receives a valid MAC.
    let forged = relay_target
        .enter_code(&controller_code.to_string())
        .expect("the relay's own exchange");
    assert_eq!(controller.receive(&forged), Ok(ControllerStep::AskOwner));

    // The real target showed the mismatch, so the owner answers "no".
    assert_local_abort(controller.confirm_target(false), CancelCode::User);
    assert_eq!(controller.pin_stored(), Err(PairingError::OutOfTurn));
}

#[test]
fn the_revealed_target_key_must_match_its_commitment_to_the_exact_start() {
    let (at_controller, _) = observing_endpoints();
    let committed = Sas::new().public_key().to_bytes();
    let other = Sas::new().public_key().to_bytes();

    // Committed to one key, revealed another one after seeing the
    // controller's key: the grinding a commitment exists to prevent.
    let (mut controller, start) =
        ControllerPairing::start(&at_controller, identity()).expect("start");
    let accept = PairingMessage::Accept {
        commitment: b64::encode(&commitment(&committed, &start)),
    }
    .encode();
    assert!(matches!(
        controller.receive(&accept),
        Ok(ControllerStep::Send(_))
    ));
    let reveal = PairingMessage::Key {
        key: b64::encode(&other),
    }
    .encode();
    assert_local_abort(
        controller.receive(&reveal),
        CancelCode::MismatchedCommitment,
    );

    // Committed over other start bytes, as after a rewritten start.
    let (mut controller, _) = ControllerPairing::start(&at_controller, identity()).expect("start");
    let mut rewritten_identity = identity();
    rewritten_identity.account_id = AccountId::parse("usr_other").expect("account");
    let (_, rewritten) =
        ControllerPairing::start(&at_controller, rewritten_identity).expect("start");
    let accept = PairingMessage::Accept {
        commitment: b64::encode(&commitment(&committed, &rewritten)),
    }
    .encode();
    assert!(matches!(
        controller.receive(&accept),
        Ok(ControllerStep::Send(_))
    ));
    let reveal = PairingMessage::Key {
        key: b64::encode(&committed),
    }
    .encode();
    assert_local_abort(
        controller.receive(&reveal),
        CancelCode::MismatchedCommitment,
    );
}

#[test]
fn keys_are_revealed_only_in_commitment_order() {
    let (at_controller, at_target) = observing_endpoints();
    let early_key = PairingMessage::Key {
        key: b64::encode(&Sas::new().public_key().to_bytes()),
    }
    .encode();

    // The start reveals no key, and the controller refuses a key before the
    // commitment.
    let (mut controller, start) =
        ControllerPairing::start(&at_controller, identity()).expect("start");
    assert!(matches!(
        PairingMessage::decode(&start),
        Ok(PairingMessage::Start { .. })
    ));
    assert_local_abort(
        controller.receive(&early_key),
        CancelCode::UnexpectedMessage,
    );

    // The target answers the start with only a commitment, and refuses a key
    // before the start and a repeated start.
    let mut target = TargetPairing::new(&at_target, identity()).expect("target");
    assert_local_abort(target.receive(&early_key), CancelCode::UnexpectedMessage);
    let (_, start) = ControllerPairing::start(&at_controller, identity()).expect("start");
    let mut target = TargetPairing::new(&at_target, identity()).expect("target");
    let Ok(TargetStep::Send(accept)) = target.receive(&start) else {
        panic!("accept");
    };
    assert!(matches!(
        PairingMessage::decode(&accept),
        Ok(PairingMessage::Accept { .. })
    ));
    assert_local_abort(target.receive(&start), CancelCode::UnexpectedMessage);

    // A replayed commitment ends pairing at the controller.
    let (mut controller, start) =
        ControllerPairing::start(&at_controller, identity()).expect("start");
    let mut target = TargetPairing::new(&at_target, identity()).expect("target");
    let Ok(TargetStep::Send(accept)) = target.receive(&start) else {
        panic!("accept");
    };
    assert!(matches!(
        controller.receive(&accept),
        Ok(ControllerStep::Send(_))
    ));
    assert_local_abort(controller.receive(&accept), CancelCode::UnexpectedMessage);

    // Messages of the other role.
    let (mut controller, start) =
        ControllerPairing::start(&at_controller, identity()).expect("start");
    assert_local_abort(controller.receive(&start), CancelCode::UnexpectedMessage);
    let mut target = TargetPairing::new(&at_target, identity()).expect("target");
    let paired = PairingMessage::Paired {
        grant_id: GrantId::generate().expect("grant"),
    }
    .encode();
    assert_local_abort(target.receive(&paired), CancelCode::UnexpectedMessage);
}

#[test]
fn identities_algorithms_and_encodings_must_match_exactly() {
    let (at_controller, at_target) = observing_endpoints();
    let (_, start) = ControllerPairing::start(&at_controller, identity()).expect("start");
    let variants: [fn(&mut PairingIdentity); 3] = [
        |seen| seen.account_id = AccountId::parse("usr_other").expect("account"),
        |seen| seen.host_id = HostId::parse("hst_EBESExQVFhcYGRobHB0eHw").expect("host"),
        |seen| {
            seen.controller_device_id =
                DeviceId::parse("dev_AAECAwQFBgcICQoLDA0ODw").expect("device")
        },
    ];
    for change in variants {
        let mut seen = identity();
        change(&mut seen);
        let mut target = TargetPairing::new(&at_target, seen).expect("target");
        assert_local_abort(target.receive(&start), CancelCode::IdentityMismatch);
    }

    let start_with = |key_agreement: &str, mac: &str, sas: &str| {
        PairingMessage::Start {
            key_agreement: key_agreement.to_owned(),
            hash: String::from("sha256"),
            mac: mac.to_owned(),
            sas: sas.to_owned(),
            account_id: identity().account_id,
            host_id: identity().host_id,
            controller_device_id: identity().controller_device_id,
        }
        .encode()
    };
    for (key_agreement, mac, sas) in [
        ("curve25519", "hkdf-hmac-sha256.v2", "decimal"),
        ("curve25519-hkdf-sha256", "hkdf-hmac-sha256", "decimal"),
        ("curve25519-hkdf-sha256", "hmac-sha256", "decimal"),
        ("curve25519-hkdf-sha256", "hkdf-hmac-sha256.v2", "emoji"),
    ] {
        let mut target = TargetPairing::new(&at_target, identity()).expect("target");
        assert_local_abort(
            target.receive(&start_with(key_agreement, mac, sas)),
            CancelCode::UnknownMethod,
        );
    }

    let spaced = String::from_utf8(start.clone())
        .expect("utf-8")
        .replacen(',', ", ", 1);
    let mut target = TargetPairing::new(&at_target, identity()).expect("target");
    assert_local_abort(
        target.receive(spaced.as_bytes()),
        CancelCode::InvalidMessage,
    );
}

fn hex32(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).expect("hex");
    }
    out
}

#[test]
fn weak_malformed_or_reflected_ephemeral_keys_end_pairing() {
    // Points of small order (libsodium's X25519 blocklist) and encodings at
    // or above the field prime or with the top bit set.
    let mut zero_high_bit = [0u8; 32];
    zero_high_bit[31] = 0x80;
    let mut one = [0u8; 32];
    one[0] = 1;
    let weak = [
        [0u8; 32],
        one,
        hex32("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
        hex32("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"),
        hex32("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
        hex32("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
        hex32("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
        hex32("efffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
        zero_high_bit,
    ];
    let (at_controller, at_target) = observing_endpoints();
    for key in weak {
        let message = PairingMessage::Key {
            key: b64::encode(&key),
        }
        .encode();

        let (_, start) = ControllerPairing::start(&at_controller, identity()).expect("start");
        let mut target = TargetPairing::new(&at_target, identity()).expect("target");
        assert!(matches!(target.receive(&start), Ok(TargetStep::Send(_))));
        assert_local_abort(target.receive(&message), CancelCode::InvalidKey);

        // A target that commits to the weak key.
        let (mut controller, start) =
            ControllerPairing::start(&at_controller, identity()).expect("start");
        let accept = PairingMessage::Accept {
            commitment: b64::encode(&commitment(&key, &start)),
        }
        .encode();
        assert!(matches!(
            controller.receive(&accept),
            Ok(ControllerStep::Send(_))
        ));
        assert_local_abort(controller.receive(&message), CancelCode::InvalidKey);
    }

    // A reflected key: the peer's key equals this side's own.
    let sas = Sas::new();
    let own = sas.public_key().to_bytes();
    assert_eq!(
        crate::pairing::establish(sas, &own, &own).err(),
        Some(CancelCode::InvalidKey)
    );
    // A key of the wrong length.
    assert_eq!(
        crate::pairing::parse_ephemeral(&b64::encode(&[9u8; 31])),
        Err(CancelCode::InvalidKey)
    );
}

#[test]
fn a_reflected_or_altered_mac_is_refused() {
    let (at_controller, at_target) = observing_endpoints();
    let (mut controller, mut target, code) = until_code(&at_controller, &at_target);
    let target_mac = target.enter_code(&code.to_string()).expect("mac");
    // The target's own MAC reflected back as the controller's.
    assert_local_abort(target.receive(&target_mac), CancelCode::KeyMismatch);

    let Ok(PairingMessage::Mac { mac }) = PairingMessage::decode(&target_mac) else {
        panic!("mac");
    };
    let mut altered = b64::decode_array::<32>(&mac).expect("mac bytes");
    altered[0] ^= 1;
    let altered = PairingMessage::Mac {
        mac: b64::encode(&altered),
    }
    .encode();
    assert_local_abort(controller.receive(&altered), CancelCode::KeyMismatch);

    let (mut controller, mut target, code) = until_code(&at_controller, &at_target);
    target.enter_code(&code.to_string()).expect("mac");
    let short = PairingMessage::Mac {
        mac: b64::encode(&[0u8; 16]),
    }
    .encode();
    assert_local_abort(controller.receive(&short), CancelCode::InvalidMessage);
}

#[test]
fn a_typing_error_can_be_corrected_but_a_wrong_code_ends_the_attempt() {
    let (at_controller, at_target) = observing_endpoints();
    let (_, mut target, code) = until_code(&at_controller, &at_target);
    assert_eq!(target.enter_code("12 34"), Err(PairingError::InvalidCode));
    assert_eq!(
        target.enter_code("0000 0000 0000"),
        Err(PairingError::InvalidCode)
    );
    assert!(target.enter_code(&code.to_string()).is_ok());

    let (_, mut target, code) = until_code(&at_controller, &at_target);
    let [first, second, third] = code.numbers();
    let wrong = format!(
        "{first} {second} {}",
        if third == 9191 { 1000 } else { third + 1 }
    );
    assert_local_abort(target.enter_code(&wrong), CancelCode::MismatchedSas);
    assert_eq!(
        target.enter_code(&code.to_string()),
        Err(PairingError::OutOfTurn)
    );
}

#[test]
fn either_owner_can_decline_and_nothing_is_stored() {
    let (at_controller, at_target) = observing_endpoints();

    // The target's owner closes the pairing window.
    let (mut controller, mut target, _) = until_code(&at_controller, &at_target);
    let cancel = target.cancel().expect("cancel");
    assert_eq!(
        controller.receive(&cancel),
        Err(PairingError::Aborted {
            code: CancelCode::User,
            by: Party::Peer,
            notify_peer: None,
        })
    );
    assert_eq!(
        controller.confirm_target(true),
        Err(PairingError::OutOfTurn)
    );

    // The controller's owner answers "no".
    let (mut controller, mut target, code) = until_code(&at_controller, &at_target);
    let target_mac = target.enter_code(&code.to_string()).expect("mac");
    assert_eq!(
        controller.receive(&target_mac),
        Ok(ControllerStep::AskOwner)
    );
    let Err(PairingError::Aborted {
        notify_peer: Some(cancel),
        ..
    }) = controller.confirm_target(false)
    else {
        panic!("declined");
    };
    assert_eq!(
        target.receive(&cancel),
        Err(PairingError::Aborted {
            code: CancelCode::User,
            by: Party::Peer,
            notify_peer: None,
        })
    );
    assert_eq!(target.grant_registered(), Err(PairingError::OutOfTurn));

    // Once the controller's MAC is out, the target decides alone.
    let (mut controller, mut target, code) = until_code(&at_controller, &at_target);
    let target_mac = target.enter_code(&code.to_string()).expect("mac");
    assert_eq!(
        controller.receive(&target_mac),
        Ok(ControllerStep::AskOwner)
    );
    controller.confirm_target(true).expect("pin");
    let controller_mac = controller.pin_stored().expect("mac");
    assert_eq!(controller.cancel(), None);
    assert!(matches!(
        target.receive(&controller_mac),
        Ok(TargetStep::RegisterGrant(_))
    ));
    assert_eq!(target.cancel(), None);
    assert_eq!(
        target.receive(&controller_mac),
        Err(PairingError::OutOfTurn)
    );
    assert!(target.grant_registered().is_ok());
}

// ---------------------------------------------------------------- policy

#[test]
fn only_an_active_grant_over_its_pinned_channel_authorizes() {
    let (controller_key, target_key) = (key(), key());
    let (controller_channel, target_channel) = pinned(&controller_key, &target_key);
    let at_target = endpoints(&target_channel);
    let grant = GrantRecord {
        grant_id: GrantId::generate().expect("grant"),
        state: GrantState::Active,
        account_id: identity().account_id,
        host_id: identity().host_id,
        controller_device_id: identity().controller_device_id,
        controller_spki: controller_key.spki().clone(),
    };
    let binding = LocalBinding {
        account_id: identity().account_id,
        host_id: identity().host_id,
    };
    let project = ProjectId::new("prj-synthetic").expect("project");
    let codex = HarnessId::new("codex").expect("harness");
    let policy = HostPolicy {
        enabled: true,
        allowed_projects: [project.clone()].into(),
        ceilings: [(
            codex.clone(),
            Permissions {
                permission_mode: PermissionMode::WorkspaceWrite,
                network_access: false,
            },
        )]
        .into(),
    };

    let authorized = authorize(&binding, &policy, &grant, &at_target).expect("authorized");
    assert_eq!(authorized.grant_id(), &grant.grant_id);
    assert_eq!(
        authorized.admit_project(&policy, &project, ProjectTrust::Trusted),
        Ok(())
    );
    assert_eq!(
        authorized.admit_project(&policy, &project, ProjectTrust::NotTrusted),
        Err(PolicyRefusal::ProjectNotTrusted)
    );
    let other_project = ProjectId::new("prj-other").expect("project");
    assert_eq!(
        authorized.admit_project(&policy, &other_project, ProjectTrust::Trusted),
        Err(PolicyRefusal::ProjectNotAllowed)
    );
    let ask = |permission_mode, network_access| Permissions {
        permission_mode,
        network_access,
    };
    assert_eq!(
        authorized.admit_permissions(&policy, &codex, ask(PermissionMode::ReadOnly, false)),
        Ok(())
    );
    assert_eq!(
        authorized.admit_permissions(&policy, &codex, ask(PermissionMode::FullAccess, false)),
        Err(PolicyRefusal::CeilingExceeded)
    );
    assert_eq!(
        authorized.admit_permissions(&policy, &codex, ask(PermissionMode::ReadOnly, true)),
        Err(PolicyRefusal::CeilingExceeded)
    );
    assert_eq!(
        authorized.admit_permissions(&policy, &codex, ask(PermissionMode::Native, false)),
        Err(PolicyRefusal::CeilingIncomparable)
    );
    let pi = HarnessId::new("pi").expect("harness");
    assert_eq!(
        authorized.admit_permissions(&policy, &pi, ask(PermissionMode::ReadOnly, false)),
        Err(PolicyRefusal::HarnessNotAllowed)
    );

    let disabled = HostPolicy {
        enabled: false,
        ..policy.clone()
    };
    assert_eq!(
        authorize(&binding, &disabled, &grant, &at_target).err(),
        Some(PolicyRefusal::HostDisabled)
    );
    let (pairing_controller, pairing_target) = observing(&controller_key, &target_key);
    for channel in [
        endpoints(&pairing_target),
        endpoints(&controller_channel),
        endpoints(&pairing_controller),
    ] {
        assert_eq!(
            authorize(&binding, &policy, &grant, &channel).err(),
            Some(PolicyRefusal::ChannelNotPinned)
        );
    }
    let mut other_key = grant.clone();
    other_key.controller_spki = key().spki().clone();
    assert_eq!(
        authorize(&binding, &policy, &other_key, &at_target).err(),
        Some(PolicyRefusal::PeerKeyChanged)
    );
    for state in [GrantState::PendingRegistration, GrantState::Revoking] {
        let inactive = GrantRecord {
            state,
            ..grant.clone()
        };
        assert_eq!(
            authorize(&binding, &policy, &inactive, &at_target).err(),
            Some(PolicyRefusal::GrantInactive)
        );
    }
    let other_account = LocalBinding {
        account_id: AccountId::parse("usr_other").expect("account"),
        ..binding.clone()
    };
    assert_eq!(
        authorize(&other_account, &policy, &grant, &at_target).err(),
        Some(PolicyRefusal::AccountMismatch)
    );
    let other_host = LocalBinding {
        host_id: HostId::parse("hst_EBESExQVFhcYGRobHB0eHw").expect("host"),
        ..binding
    };
    assert_eq!(
        authorize(&other_host, &policy, &grant, &at_target).err(),
        Some(PolicyRefusal::HostMismatch)
    );
}
