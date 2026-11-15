//! The end-to-end channel: TLS 1.3 with mutual raw public keys (RFC 7250)
//! over an abstract, ordered byte transport.
//!
//! The target host is the TLS server and the controller is the TLS client.
//! Both always present their identity key and always require the other's.
//! Configuration, all fail-closed:
//!
//! - TLS 1.3 only, rustls with the ring provider; Ed25519 handshake
//!   signatures only, verified by rustls' `verify_tls13_signature_with_raw_key`.
//! - ALPN `nano-host/1` offered and required: rustls lets a TLS server go on
//!   without ALPN when the client offered none, so both sides check the
//!   negotiated protocol after the handshake.
//! - No resumption, no session tickets, no early data, no SNI. A resumed
//!   handshake or a client that sends a server name is refused.
//! - Exactly one presented key and no chain; the key must be a valid
//!   Ed25519 [`Spki`]. In [`PeerKeyPolicy::Pinned`] it must equal the pin
//!   byte for byte, otherwise the channel fails with
//!   [`ChannelError::PeerKeyChanged`]. [`PeerKeyPolicy::ObserveForPairing`]
//!   only reports the key: it authorizes nothing.
//!
//! The channel is sans-IO: [`SecureChannel::receive`] takes bytes from the
//! transport in order, [`SecureChannel::transmit`] returns bytes for it, and
//! messages are framed with [`crate::framing`]. Any error is terminal: the
//! channel keeps returning it and delivers nothing more, while
//! [`SecureChannel::transmit`] still drains the alert rustls queued for the
//! peer.

use std::collections::VecDeque;
use std::io::{ErrorKind, Read as _, Write as _};
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::{AlwaysResolvesClientRawPublicKeys, Resumption};
use rustls::crypto::{
    CryptoProvider, WebPkiSupportedAlgorithms, verify_tls13_signature_with_raw_key,
};
use rustls::pki_types::{CertificateDer, ServerName, SubjectPublicKeyInfoDer, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::{AlwaysResolvesServerRawPublicKeys, NoServerSessionStorage};
use rustls::{
    AlertDescription, CertificateError, ClientConfig, ClientConnection, Connection,
    DigitallySignedStruct, DistinguishedName, HandshakeKind, OtherError, PeerMisbehaved,
    ProtocolVersion, ServerConfig, ServerConnection, SignatureScheme,
};
use thiserror::Error;

use crate::framing::{self, Decoder, FramingError, MessageLimit};
use crate::identity::{IdentityKey, Spki, SpkiError};

/// The ALPN identifier of the channel.
pub const ALPN: &[u8] = crate::PROTOCOL.as_bytes();

/// The RFC 9266 `tls-exporter` channel binding label.
pub const CHANNEL_BINDING_LABEL: &[u8] = b"EXPORTER-Channel-Binding";

/// The RFC 9266 channel binding length.
pub const CHANNEL_BINDING_LEN: usize = 32;

/// The client's server name. SNI is disabled, so it is never sent, and the
/// verifiers do not use it.
const SERVER_NAME: &str = "nano-host.invalid";

/// Plaintext read from rustls per step.
const READ_CHUNK: usize = 16 * 1024;

/// Which end of the channel this is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChannelRole {
    /// The execution host: the TLS server.
    Target,
    /// The controlling Desktop: the TLS client.
    Controller,
}

impl ChannelRole {
    /// The role text inside transcripts.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Target => "target",
            Self::Controller => "controller",
        }
    }
}

/// How the peer's key is authenticated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerKeyPolicy {
    /// Pairing only: any valid Ed25519 key is accepted and reported. It is
    /// verified later by SAS and authorizes nothing by itself.
    ObserveForPairing,
    /// An ordinary channel: exactly this pinned key.
    Pinned(Spki),
}

/// How the established peer key was accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerKeyStatus {
    /// Observed during pairing; not yet verified.
    Observed,
    /// Equal to the pin.
    Pinned,
}

/// What an established channel proves.
#[derive(Clone, PartialEq, Eq)]
pub struct ChannelEndpoints {
    /// This side's role.
    pub role: ChannelRole,
    /// This side's key.
    pub own_spki: Spki,
    /// The key the peer authenticated with in this handshake.
    pub peer_spki: Spki,
    /// Whether the peer key was pinned or only observed.
    pub peer_key: PeerKeyStatus,
    /// The RFC 9266 `tls-exporter` value of this TLS session. Not secret
    /// outside the endpoints, but never sent on the wire.
    pub channel_binding: [u8; CHANNEL_BINDING_LEN],
}

impl ChannelEndpoints {
    /// The target's key, whichever side this is.
    #[must_use]
    pub fn target_spki(&self) -> &Spki {
        match self.role {
            ChannelRole::Target => &self.own_spki,
            ChannelRole::Controller => &self.peer_spki,
        }
    }

    /// The controller's key, whichever side this is.
    #[must_use]
    pub fn controller_spki(&self) -> &Spki {
        match self.role {
            ChannelRole::Target => &self.peer_spki,
            ChannelRole::Controller => &self.own_spki,
        }
    }
}

impl std::fmt::Debug for ChannelEndpoints {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChannelEndpoints")
            .field("role", &self.role)
            .field("own_spki", &self.own_spki)
            .field("peer_spki", &self.peer_spki)
            .field("peer_key", &self.peer_key)
            .finish_non_exhaustive()
    }
}

/// Why a channel failed. Every variant is terminal.
#[derive(Clone, Debug, PartialEq, Error)]
pub enum ChannelError {
    #[error("the peer presented a key other than the pinned one")]
    PeerKeyChanged,
    #[error("the peer's key is not a valid identity: {0}")]
    PeerKeyInvalid(SpkiError),
    #[error("the peer presented a certificate chain instead of one raw key")]
    PeerKeyChain,
    #[error("the peer presented no key")]
    PeerKeyMissing,
    #[error("the peer's handshake signature is invalid")]
    BadSignature,
    #[error("the peer did not negotiate nano-host/1")]
    WrongAlpn,
    #[error("the channel is not TLS 1.3")]
    NotTls13,
    #[error("the handshake was a resumption")]
    Resumed,
    #[error("the controller sent a server name")]
    UnexpectedServerName,
    #[error("framing: {0}")]
    Framing(FramingError),
    #[error("the peer ended the handshake with alert {0:?}")]
    PeerAlert(AlertDescription),
    #[error("TLS: {0}")]
    Tls(rustls::Error),
    #[error("the transport failed: {0:?}")]
    Transport(ErrorKind),
    #[error("the channel is not established")]
    NotEstablished,
    #[error("the channel is closed")]
    Closed,
}

/// A peer key refusal carried through rustls as `CertificateError::Other`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
enum PeerKeyRefusal {
    #[error("the peer key changed")]
    Changed,
    #[error("the peer key is invalid: {0}")]
    Invalid(SpkiError),
    #[error("the peer presented a chain")]
    Chain,
}

fn refusal(reason: PeerKeyRefusal) -> rustls::Error {
    rustls::Error::InvalidCertificate(CertificateError::Other(OtherError(Arc::new(reason))))
}

#[derive(Debug)]
struct RawKeyVerifier {
    policy: PeerKeyPolicy,
    algorithms: WebPkiSupportedAlgorithms,
}

impl RawKeyVerifier {
    fn check_key(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
    ) -> Result<(), rustls::Error> {
        if !intermediates.is_empty() {
            return Err(refusal(PeerKeyRefusal::Chain));
        }
        let spki = Spki::from_der(end_entity.as_ref())
            .map_err(|error| refusal(PeerKeyRefusal::Invalid(error)))?;
        match &self.policy {
            PeerKeyPolicy::ObserveForPairing => Ok(()),
            PeerKeyPolicy::Pinned(pin) if *pin == spki => Ok(()),
            PeerKeyPolicy::Pinned(_) => Err(refusal(PeerKeyRefusal::Changed)),
        }
    }

    fn check_signature(
        &self,
        message: &[u8],
        key: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        if signature.scheme != SignatureScheme::ED25519 {
            return Err(PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme.into());
        }
        verify_tls13_signature_with_raw_key(
            message,
            &SubjectPublicKeyInfoDer::from(key.as_ref()),
            signature,
            &self.algorithms,
        )
    }

    fn tls12() -> rustls::Error {
        rustls::Error::General(String::from("nano-host/1 uses TLS 1.3 only"))
    }
}

impl ServerCertVerifier for RawKeyVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.check_key(end_entity, intermediates)
            .map(|()| ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(Self::tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.check_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

impl ClientCertVerifier for RawKeyVerifier {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        self.check_key(end_entity, intermediates)
            .map(|()| ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(Self::tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.check_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn verifier(provider: &CryptoProvider, policy: PeerKeyPolicy) -> Arc<RawKeyVerifier> {
    Arc::new(RawKeyVerifier {
        policy,
        algorithms: provider.signature_verification_algorithms,
    })
}

/// The controller's TLS configuration.
fn controller_config(
    identity: &IdentityKey,
    policy: PeerKeyPolicy,
) -> Result<ClientConfig, rustls::Error> {
    let provider = provider();
    let verifier = verifier(&provider, policy);
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_cert_resolver(Arc::new(AlwaysResolvesClientRawPublicKeys::new(
            identity.certified_key(),
        )));
    config.alpn_protocols = vec![ALPN.to_vec()];
    config.resumption = Resumption::disabled();
    config.enable_sni = false;
    config.enable_early_data = false;
    Ok(config)
}

/// The target's TLS configuration.
fn target_config(
    identity: &IdentityKey,
    policy: PeerKeyPolicy,
) -> Result<ServerConfig, rustls::Error> {
    let provider = provider();
    let verifier = verifier(&provider, policy);
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(verifier)
        .with_cert_resolver(Arc::new(AlwaysResolvesServerRawPublicKeys::new(
            identity.certified_key(),
        )));
    config.alpn_protocols = vec![ALPN.to_vec()];
    config.session_storage = Arc::new(NoServerSessionStorage {});
    config.send_tls13_tickets = 0;
    config.max_tls13_tickets = 0;
    config.max_early_data_size = 0;
    config.send_half_rtt_data = false;
    Ok(config)
}

enum State {
    Handshaking,
    Established(ChannelEndpoints),
    Failed(ChannelError),
    Closed,
}

/// One end of the end-to-end channel.
pub struct SecureChannel {
    role: ChannelRole,
    policy: PeerKeyPolicy,
    own_spki: Spki,
    connection: Connection,
    state: State,
    limit: MessageLimit,
    decoder: Decoder,
    inbound: VecDeque<Vec<u8>>,
}

impl SecureChannel {
    /// The target (TLS server) end.
    ///
    /// # Errors
    /// [`ChannelError::Tls`] when rustls refuses the configuration.
    pub fn target(
        identity: &IdentityKey,
        policy: PeerKeyPolicy,
        limit: MessageLimit,
    ) -> Result<Self, ChannelError> {
        let config = target_config(identity, policy.clone()).map_err(ChannelError::Tls)?;
        let connection = ServerConnection::new(Arc::new(config)).map_err(ChannelError::Tls)?;
        Ok(Self::new(
            ChannelRole::Target,
            policy,
            identity.spki().clone(),
            connection.into(),
            limit,
        ))
    }

    /// The controller (TLS client) end. Its first flight is ready in
    /// [`SecureChannel::transmit`].
    ///
    /// # Errors
    /// [`ChannelError::Tls`] when rustls refuses the configuration.
    pub fn controller(
        identity: &IdentityKey,
        policy: PeerKeyPolicy,
        limit: MessageLimit,
    ) -> Result<Self, ChannelError> {
        let config = controller_config(identity, policy.clone()).map_err(ChannelError::Tls)?;
        let name = ServerName::try_from(SERVER_NAME)
            .map_err(|_| ChannelError::Tls(rustls::Error::General(String::from("server name"))))?;
        let connection =
            ClientConnection::new(Arc::new(config), name).map_err(ChannelError::Tls)?;
        Ok(Self::new(
            ChannelRole::Controller,
            policy,
            identity.spki().clone(),
            connection.into(),
            limit,
        ))
    }

    fn new(
        role: ChannelRole,
        policy: PeerKeyPolicy,
        own_spki: Spki,
        mut connection: Connection,
        limit: MessageLimit,
    ) -> Self {
        // A whole message (at most `limit`) is encrypted at once and handed to
        // the transport by `transmit`, so rustls' own 64 KiB send buffer limit
        // would only split what the protocol already bounds.
        connection.set_buffer_limit(None);
        Self {
            role,
            policy,
            own_spki,
            connection,
            state: State::Handshaking,
            limit,
            decoder: Decoder::new(limit),
            inbound: VecDeque::new(),
        }
    }

    /// This side's role.
    #[must_use]
    pub fn role(&self) -> ChannelRole {
        self.role
    }

    /// What the handshake proved, once established.
    #[must_use]
    pub fn endpoints(&self) -> Option<&ChannelEndpoints> {
        match &self.state {
            State::Established(endpoints) => Some(endpoints),
            _ => None,
        }
    }

    /// The terminal error, if the channel failed.
    #[must_use]
    pub fn failure(&self) -> Option<&ChannelError> {
        match &self.state {
            State::Failed(error) => Some(error),
            _ => None,
        }
    }

    /// Whether the peer closed the channel cleanly.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        matches!(self.state, State::Closed)
    }

    fn usable(&self) -> Result<(), ChannelError> {
        match &self.state {
            State::Failed(error) => Err(error.clone()),
            State::Closed => Err(ChannelError::Closed),
            State::Handshaking | State::Established(_) => Ok(()),
        }
    }

    fn fail(&mut self, error: ChannelError) -> ChannelError {
        self.state = State::Failed(error.clone());
        self.inbound.clear();
        error
    }

    /// Takes bytes the transport delivered, in order.
    ///
    /// # Errors
    /// The terminal [`ChannelError`] of this channel.
    pub fn receive(&mut self, mut bytes: &[u8]) -> Result<(), ChannelError> {
        self.usable()?;
        while !bytes.is_empty() {
            match self.connection.read_tls(&mut bytes) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) => return Err(self.fail(ChannelError::Transport(error.kind()))),
            }
            self.process()?;
        }
        Ok(())
    }

    fn process(&mut self) -> Result<(), ChannelError> {
        loop {
            let io = match self.connection.process_new_packets() {
                Ok(io) => io,
                Err(error) => return Err(self.fail(map_tls_error(error))),
            };
            if matches!(self.state, State::Handshaking) && !self.connection.is_handshaking() {
                match self.establish() {
                    Ok(endpoints) => self.state = State::Established(endpoints),
                    Err(error) => {
                        self.connection.send_close_notify();
                        return Err(self.fail(error));
                    }
                }
            }
            let established = matches!(self.state, State::Established(_));
            if established && io.plaintext_bytes_to_read() > 0 {
                let mut chunk = vec![0u8; io.plaintext_bytes_to_read().min(READ_CHUNK)];
                match self.connection.reader().read(&mut chunk) {
                    Ok(0) => return Ok(()),
                    Ok(read) => {
                        if let Err(error) = self.decoder.push(&chunk[..read], &mut self.inbound) {
                            return Err(self.fail(ChannelError::Framing(error)));
                        }
                        continue;
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
                    Err(error) => return Err(self.fail(ChannelError::Transport(error.kind()))),
                }
            }
            if io.peer_has_closed() {
                if !established {
                    return Err(self.fail(ChannelError::NotEstablished));
                }
                if let Err(error) = self.decoder.finish() {
                    return Err(self.fail(ChannelError::Framing(error)));
                }
                self.state = State::Closed;
            }
            return Ok(());
        }
    }

    fn establish(&self) -> Result<ChannelEndpoints, ChannelError> {
        if self.connection.protocol_version() != Some(ProtocolVersion::TLSv1_3) {
            return Err(ChannelError::NotTls13);
        }
        match self.connection.handshake_kind() {
            Some(HandshakeKind::Full | HandshakeKind::FullWithHelloRetryRequest) => {}
            Some(HandshakeKind::Resumed) | None => return Err(ChannelError::Resumed),
        }
        if self.connection.alpn_protocol() != Some(ALPN) {
            return Err(ChannelError::WrongAlpn);
        }
        if let Connection::Server(server) = &self.connection
            && server.server_name().is_some()
        {
            return Err(ChannelError::UnexpectedServerName);
        }
        let presented = self
            .connection
            .peer_certificates()
            .ok_or(ChannelError::PeerKeyMissing)?;
        let [key] = presented else {
            return Err(ChannelError::PeerKeyChain);
        };
        let peer_spki = Spki::from_der(key.as_ref()).map_err(ChannelError::PeerKeyInvalid)?;
        let peer_key = match &self.policy {
            PeerKeyPolicy::ObserveForPairing => PeerKeyStatus::Observed,
            PeerKeyPolicy::Pinned(pin) if *pin == peer_spki => PeerKeyStatus::Pinned,
            PeerKeyPolicy::Pinned(_) => return Err(ChannelError::PeerKeyChanged),
        };
        // RFC 9266: the label, a zero-length context and 32 bytes. TLS 1.3
        // gives no context and an empty one the same value (RFC 8446 7.5).
        let channel_binding = self
            .connection
            .export_keying_material([0u8; CHANNEL_BINDING_LEN], CHANNEL_BINDING_LABEL, Some(&[]))
            .map_err(ChannelError::Tls)?;
        Ok(ChannelEndpoints {
            role: self.role,
            own_spki: self.own_spki.clone(),
            peer_spki,
            peer_key,
            channel_binding,
        })
    }

    /// Bytes for the transport, in order. After a failure this still returns
    /// the alert rustls queued for the peer.
    pub fn transmit(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while self.connection.wants_write() {
            match self.connection.write_tls(&mut out) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        out
    }

    /// Sends one message.
    ///
    /// # Errors
    /// [`ChannelError::NotEstablished`] before the handshake, the terminal
    /// error, or a framing error (which does not end the channel: nothing was
    /// written).
    pub fn send(&mut self, payload: &[u8]) -> Result<(), ChannelError> {
        self.usable()?;
        if !matches!(self.state, State::Established(_)) {
            return Err(ChannelError::NotEstablished);
        }
        let framed = framing::encode(payload, self.limit).map_err(ChannelError::Framing)?;
        self.connection
            .writer()
            .write_all(&framed)
            .map_err(|error| ChannelError::Transport(error.kind()))
    }

    /// The next received message.
    pub fn recv(&mut self) -> Option<Vec<u8>> {
        if matches!(self.state, State::Failed(_)) {
            return None;
        }
        self.inbound.pop_front()
    }

    /// Ends the channel with `close_notify`; send [`SecureChannel::transmit`]
    /// afterwards.
    pub fn close(&mut self) {
        self.connection.send_close_notify();
        if !matches!(self.state, State::Failed(_)) {
            self.state = State::Closed;
        }
    }
}

fn map_tls_error(error: rustls::Error) -> ChannelError {
    match &error {
        rustls::Error::InvalidCertificate(CertificateError::Other(other)) => {
            match other.0.downcast_ref::<PeerKeyRefusal>() {
                Some(PeerKeyRefusal::Changed) => ChannelError::PeerKeyChanged,
                Some(PeerKeyRefusal::Invalid(reason)) => ChannelError::PeerKeyInvalid(*reason),
                Some(PeerKeyRefusal::Chain) => ChannelError::PeerKeyChain,
                None => ChannelError::Tls(error),
            }
        }
        rustls::Error::InvalidCertificate(CertificateError::BadSignature) => {
            ChannelError::BadSignature
        }
        rustls::Error::NoCertificatesPresented => ChannelError::PeerKeyMissing,
        rustls::Error::NoApplicationProtocol
        | rustls::Error::AlertReceived(AlertDescription::NoApplicationProtocol) => {
            ChannelError::WrongAlpn
        }
        rustls::Error::AlertReceived(alert) => ChannelError::PeerAlert(*alert),
        _ => ChannelError::Tls(error),
    }
}

/// Hooks for tests that need a deliberately wrong configuration.
#[cfg(test)]
pub(crate) mod testing {
    use rustls::sign::{CertifiedKey, SigningKey};

    use super::*;

    pub(crate) fn controller_config_for(
        identity: &IdentityKey,
        policy: PeerKeyPolicy,
    ) -> ClientConfig {
        controller_config(identity, policy).expect("controller config")
    }

    pub(crate) fn target_config_for(identity: &IdentityKey, policy: PeerKeyPolicy) -> ServerConfig {
        target_config(identity, policy).expect("target config")
    }

    pub(crate) fn server_verifier(policy: PeerKeyPolicy) -> Arc<dyn ServerCertVerifier> {
        verifier(&provider(), policy)
    }

    pub(crate) fn tls13_client() -> rustls::ConfigBuilder<ClientConfig, rustls::WantsVerifier> {
        ClientConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .expect("tls 1.3")
    }

    pub(crate) fn certified(presented: &Spki, signer: Arc<dyn SigningKey>) -> Arc<CertifiedKey> {
        Arc::new(CertifiedKey::new(
            vec![CertificateDer::from(presented.as_der().to_vec())],
            signer,
        ))
    }

    pub(crate) fn controller_with(
        config: ClientConfig,
        own_spki: &Spki,
        policy: PeerKeyPolicy,
        limit: MessageLimit,
    ) -> SecureChannel {
        let name = ServerName::try_from(SERVER_NAME).expect("name");
        let connection = ClientConnection::new(Arc::new(config), name).expect("client");
        SecureChannel::new(
            ChannelRole::Controller,
            policy,
            own_spki.clone(),
            connection.into(),
            limit,
        )
    }

    pub(crate) fn target_with(
        config: Arc<ServerConfig>,
        own_spki: &Spki,
        policy: PeerKeyPolicy,
        limit: MessageLimit,
    ) -> SecureChannel {
        let connection = ServerConnection::new(config).expect("server");
        SecureChannel::new(
            ChannelRole::Target,
            policy,
            own_spki.clone(),
            connection.into(),
            limit,
        )
    }
}
