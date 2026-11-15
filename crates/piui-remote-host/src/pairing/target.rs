//! The target's side of pairing.

use std::fmt;

use vodozemac::sas::{EstablishedSas, Sas};

use super::transcript::{EphemeralKeys, Transcript, commitment};
use super::{
    CancelCode, HASH, KEY_AGREEMENT, MAC_METHOD, PairingError, PairingIdentity, PairingMessage,
    Party, SAS_METHOD, SasCode, establish, mac_message, parse_ephemeral, sas_code, verify_mac,
};
use crate::b64;
use crate::identity::Spki;
use crate::ids::GrantId;
use crate::tls::{ChannelEndpoints, ChannelRole, PeerKeyStatus};

/// What the target's caller does next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TargetStep {
    /// Send this message.
    Send(Vec<u8>),
    /// Send this message, then ask the owner to type the code the controller
    /// shows and pass it to [`TargetPairing::enter_code`].
    SendAndAskForCode(Vec<u8>),
    /// The controller's MAC verified. Store the grant durably, register it,
    /// then call [`TargetPairing::grant_registered`].
    RegisterGrant(VerifiedController),
}

/// The grant to record for the verified controller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedController {
    /// The new grant identifier.
    pub grant_id: GrantId,
    /// The account, this host and the controller's device.
    pub identity: PairingIdentity,
    /// The controller's TLS key, verified by SAS and MAC: the grant's pin.
    pub controller_spki: Spki,
    /// This host's TLS key at pairing.
    pub target_spki: Spki,
}

enum State {
    AwaitStart,
    AwaitKey { sas: Sas },
    AwaitCode { sas: EstablishedSas, code: SasCode },
    AwaitControllerMac { sas: EstablishedSas },
    AwaitGrant,
    Done,
    Ended,
}

impl State {
    fn name(&self) -> &'static str {
        match self {
            Self::AwaitStart => "await-start",
            Self::AwaitKey { .. } => "await-key",
            Self::AwaitCode { .. } => "await-code",
            Self::AwaitControllerMac { .. } => "await-controller-mac",
            Self::AwaitGrant => "await-grant",
            Self::Done => "done",
            Self::Ended => "ended",
        }
    }
}

/// The target's pairing state machine for one pairing channel. Create it
/// only while the owner keeps the pairing window open on this computer.
pub struct TargetPairing {
    transcript: Transcript,
    grant_id: GrantId,
    keys: EphemeralKeys,
    state: State,
}

impl fmt::Debug for TargetPairing {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TargetPairing")
            .field("transcript", &self.transcript)
            .field("grant_id", &self.grant_id)
            .field("state", &self.state.name())
            .finish_non_exhaustive()
    }
}

impl TargetPairing {
    /// Pairing on an established observing channel. `identity` is this
    /// side's knowledge: its account, its host registration and the
    /// controller device the relay announced for the channel.
    ///
    /// The grant identifier is drawn here and sent only in `pairing.paired`.
    ///
    /// # Errors
    /// [`PairingError::NotAPairingChannel`] unless `endpoints` are the
    /// target end of a channel that only observed the peer key, and
    /// [`PairingError::Random`] when the system random generator fails.
    pub fn new(
        endpoints: &ChannelEndpoints,
        identity: PairingIdentity,
    ) -> Result<Self, PairingError> {
        if endpoints.role != ChannelRole::Target || endpoints.peer_key != PeerKeyStatus::Observed {
            return Err(PairingError::NotAPairingChannel);
        }
        Ok(Self {
            transcript: Transcript::new(identity, endpoints),
            grant_id: GrantId::generate().map_err(|_| PairingError::Random)?,
            keys: EphemeralKeys {
                target: [0; 32],
                controller: [0; 32],
            },
            state: State::AwaitStart,
        })
    }

    /// The transcript this side derives from.
    #[must_use]
    pub fn transcript(&self) -> &Transcript {
        &self.transcript
    }

    fn abort(&mut self, code: CancelCode) -> PairingError {
        self.state = State::Ended;
        PairingError::Aborted {
            code,
            by: Party::Local,
            notify_peer: Some(PairingMessage::Cancel { code }.encode()),
        }
    }

    /// Handles one message from the controller.
    ///
    /// # Errors
    /// [`PairingError::Aborted`] for anything but the expected message, and
    /// [`PairingError::OutOfTurn`] once the grant is decided or pairing
    /// ended: no further message is processed.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<TargetStep, PairingError> {
        if matches!(self.state, State::AwaitGrant | State::Done | State::Ended) {
            return Err(PairingError::OutOfTurn);
        }
        let message = match PairingMessage::decode(bytes) {
            Ok(message) => message,
            Err(code) => return Err(self.abort(code)),
        };
        if let PairingMessage::Cancel { code } = message {
            self.state = State::Ended;
            return Err(PairingError::Aborted {
                code,
                by: Party::Peer,
                notify_peer: None,
            });
        }
        match (std::mem::replace(&mut self.state, State::Ended), message) {
            (
                State::AwaitStart,
                PairingMessage::Start {
                    key_agreement,
                    hash,
                    mac,
                    sas,
                    account_id,
                    host_id,
                    controller_device_id,
                },
            ) => {
                if [key_agreement.as_str(), &hash, &mac, &sas]
                    != [KEY_AGREEMENT, HASH, MAC_METHOD, SAS_METHOD]
                {
                    return Err(self.abort(CancelCode::UnknownMethod));
                }
                let identity = &self.transcript.identity;
                if account_id != identity.account_id
                    || host_id != identity.host_id
                    || controller_device_id != identity.controller_device_id
                {
                    return Err(self.abort(CancelCode::IdentityMismatch));
                }
                let sas = Sas::new();
                self.keys.target = sas.public_key().to_bytes();
                let commitment = commitment(&self.keys.target, bytes);
                self.state = State::AwaitKey { sas };
                Ok(TargetStep::Send(
                    PairingMessage::Accept {
                        commitment: b64::encode(&commitment),
                    }
                    .encode(),
                ))
            }
            (State::AwaitKey { sas }, PairingMessage::Key { key }) => {
                let controller = match parse_ephemeral(&key) {
                    Ok(controller) => controller,
                    Err(code) => return Err(self.abort(code)),
                };
                let sas = match establish(sas, &self.keys.target, &controller) {
                    Ok(sas) => sas,
                    Err(code) => return Err(self.abort(code)),
                };
                self.keys.controller = controller;
                let code = sas_code(&sas, &self.transcript, &self.keys);
                self.state = State::AwaitCode { sas, code };
                Ok(TargetStep::SendAndAskForCode(
                    PairingMessage::Key {
                        key: b64::encode(&self.keys.target),
                    }
                    .encode(),
                ))
            }
            (State::AwaitControllerMac { sas }, PairingMessage::Mac { mac }) => {
                if let Err(code) = verify_mac(&sas, &self.transcript, ChannelRole::Controller, &mac)
                {
                    return Err(self.abort(code));
                }
                self.state = State::AwaitGrant;
                Ok(TargetStep::RegisterGrant(VerifiedController {
                    grant_id: self.grant_id.clone(),
                    identity: self.transcript.identity.clone(),
                    controller_spki: self.transcript.controller_spki.clone(),
                    target_spki: self.transcript.target_spki.clone(),
                }))
            }
            _ => Err(self.abort(CancelCode::UnexpectedMessage)),
        }
    }

    /// The code the owner typed. A typing error ([`PairingError::InvalidCode`])
    /// leaves the attempt open; a well-formed wrong code ends it. On a match
    /// it returns the target's MAC message to send.
    ///
    /// # Errors
    /// [`PairingError::InvalidCode`], [`PairingError::Aborted`] with
    /// [`CancelCode::MismatchedSas`], or [`PairingError::OutOfTurn`].
    pub fn enter_code(&mut self, typed: &str) -> Result<Vec<u8>, PairingError> {
        if !matches!(self.state, State::AwaitCode { .. }) {
            return Err(PairingError::OutOfTurn);
        }
        let Some(typed) = SasCode::parse(typed) else {
            return Err(PairingError::InvalidCode);
        };
        match std::mem::replace(&mut self.state, State::Ended) {
            State::AwaitCode { sas, code } if code.matches(&typed) => {
                let message = mac_message(&sas, &self.transcript, ChannelRole::Target);
                self.state = State::AwaitControllerMac { sas };
                Ok(message)
            }
            _ => Err(self.abort(CancelCode::MismatchedSas)),
        }
    }

    /// Called after the grant is stored and registered. Returns the
    /// `pairing.paired` message.
    ///
    /// # Errors
    /// [`PairingError::OutOfTurn`] unless the controller's MAC verified.
    pub fn grant_registered(&mut self) -> Result<Vec<u8>, PairingError> {
        match std::mem::replace(&mut self.state, State::Ended) {
            State::AwaitGrant => {
                self.state = State::Done;
                Ok(PairingMessage::Paired {
                    grant_id: self.grant_id.clone(),
                }
                .encode())
            }
            other => {
                self.state = other;
                Err(PairingError::OutOfTurn)
            }
        }
    }

    /// The owner closed the pairing window. Returns the `pairing.cancel` to
    /// send until the grant is decided.
    pub fn cancel(&mut self) -> Option<Vec<u8>> {
        match self.state {
            State::AwaitGrant | State::Done | State::Ended => None,
            _ => {
                self.state = State::Ended;
                Some(
                    PairingMessage::Cancel {
                        code: CancelCode::User,
                    }
                    .encode(),
                )
            }
        }
    }
}
