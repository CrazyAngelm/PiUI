//! The controller's side of pairing.

use std::fmt;

use vodozemac::sas::{EstablishedSas, Sas};

use super::transcript::{EphemeralKeys, Transcript, commitment};
use super::{
    CancelCode, HASH, KEY_AGREEMENT, MAC_METHOD, PairingError, PairingIdentity, PairingMessage,
    SAS_METHOD, SasCode, establish, mac_message, parse_digest, parse_ephemeral, sas_code,
    verify_mac,
};
use crate::b64;
use crate::identity::Spki;
use crate::ids::GrantId;
use crate::tls::{ChannelEndpoints, ChannelRole, PeerKeyStatus};

/// What the controller's caller does next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControllerStep {
    /// Send this message.
    Send(Vec<u8>),
    /// Show this code. The owner types it on the target.
    ShowCode(SasCode),
    /// The target's MAC verified. Ask the owner whether the target showed
    /// that the codes matched, then call [`ControllerPairing::confirm_target`].
    AskOwner,
    /// The target recorded the grant. Store this identifier with the pin.
    Paired(GrantId),
}

/// The pin to store durably before the controller's MAC is sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedTarget {
    /// The account, the target host and this controller's device.
    pub identity: PairingIdentity,
    /// The target's TLS key, verified by SAS and MAC.
    pub target_spki: Spki,
}

enum State {
    AwaitAccept {
        sas: Sas,
        start: Vec<u8>,
    },
    AwaitKey {
        sas: Sas,
        start: Vec<u8>,
        commitment: [u8; 32],
    },
    AwaitTargetMac {
        sas: EstablishedSas,
    },
    AwaitOwner {
        sas: EstablishedSas,
    },
    AwaitPin {
        sas: EstablishedSas,
    },
    AwaitPaired,
    Done,
    Ended,
}

impl State {
    fn name(&self) -> &'static str {
        match self {
            Self::AwaitAccept { .. } => "await-accept",
            Self::AwaitKey { .. } => "await-key",
            Self::AwaitTargetMac { .. } => "await-target-mac",
            Self::AwaitOwner { .. } => "await-owner",
            Self::AwaitPin { .. } => "await-pin",
            Self::AwaitPaired => "await-paired",
            Self::Done => "done",
            Self::Ended => "ended",
        }
    }
}

/// The controller's pairing state machine for one pairing channel.
pub struct ControllerPairing {
    transcript: Transcript,
    keys: EphemeralKeys,
    state: State,
}

impl fmt::Debug for ControllerPairing {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControllerPairing")
            .field("transcript", &self.transcript)
            .field("state", &self.state.name())
            .finish_non_exhaustive()
    }
}

impl ControllerPairing {
    /// Starts pairing on an established observing channel and returns the
    /// `pairing.start` message to send.
    ///
    /// # Errors
    /// [`PairingError::NotAPairingChannel`] unless `endpoints` are the
    /// controller end of a channel that only observed the peer key.
    pub fn start(
        endpoints: &ChannelEndpoints,
        identity: PairingIdentity,
    ) -> Result<(Self, Vec<u8>), PairingError> {
        if endpoints.role != ChannelRole::Controller
            || endpoints.peer_key != PeerKeyStatus::Observed
        {
            return Err(PairingError::NotAPairingChannel);
        }
        let start = PairingMessage::Start {
            key_agreement: KEY_AGREEMENT.to_owned(),
            hash: HASH.to_owned(),
            mac: MAC_METHOD.to_owned(),
            sas: SAS_METHOD.to_owned(),
            account_id: identity.account_id.clone(),
            host_id: identity.host_id.clone(),
            controller_device_id: identity.controller_device_id.clone(),
        }
        .encode();
        let sas = Sas::new();
        let keys = EphemeralKeys {
            target: [0; 32],
            controller: sas.public_key().to_bytes(),
        };
        let pairing = Self {
            transcript: Transcript::new(identity, endpoints),
            keys,
            state: State::AwaitAccept {
                sas,
                start: start.clone(),
            },
        };
        Ok((pairing, start))
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
            by: super::Party::Local,
            notify_peer: Some(PairingMessage::Cancel { code }.encode()),
        }
    }

    /// Handles one message from the target.
    ///
    /// # Errors
    /// [`PairingError::Aborted`] for anything but the expected message, and
    /// [`PairingError::OutOfTurn`] after the end.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<ControllerStep, PairingError> {
        if matches!(self.state, State::Done | State::Ended) {
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
                by: super::Party::Peer,
                notify_peer: None,
            });
        }
        match (std::mem::replace(&mut self.state, State::Ended), message) {
            (State::AwaitAccept { sas, start }, PairingMessage::Accept { commitment }) => {
                let Some(commitment) = parse_digest(&commitment) else {
                    return Err(self.abort(CancelCode::InvalidMessage));
                };
                self.state = State::AwaitKey {
                    sas,
                    start,
                    commitment,
                };
                Ok(ControllerStep::Send(
                    PairingMessage::Key {
                        key: b64::encode(&self.keys.controller),
                    }
                    .encode(),
                ))
            }
            (
                State::AwaitKey {
                    sas,
                    start,
                    commitment: expected,
                },
                PairingMessage::Key { key },
            ) => {
                let target = match parse_ephemeral(&key) {
                    Ok(target) => target,
                    Err(code) => return Err(self.abort(code)),
                };
                if !super::digests_equal(&commitment(&target, &start), &expected) {
                    return Err(self.abort(CancelCode::MismatchedCommitment));
                }
                let sas = match establish(sas, &self.keys.controller, &target) {
                    Ok(sas) => sas,
                    Err(code) => return Err(self.abort(code)),
                };
                self.keys.target = target;
                let code = sas_code(&sas, &self.transcript, &self.keys);
                self.state = State::AwaitTargetMac { sas };
                Ok(ControllerStep::ShowCode(code))
            }
            (State::AwaitTargetMac { sas }, PairingMessage::Mac { mac }) => {
                if let Err(code) = verify_mac(&sas, &self.transcript, ChannelRole::Target, &mac) {
                    return Err(self.abort(code));
                }
                self.state = State::AwaitOwner { sas };
                Ok(ControllerStep::AskOwner)
            }
            (State::AwaitPaired, PairingMessage::Paired { grant_id }) => {
                self.state = State::Done;
                Ok(ControllerStep::Paired(grant_id))
            }
            _ => Err(self.abort(CancelCode::UnexpectedMessage)),
        }
    }

    /// The owner's answer to [`ControllerStep::AskOwner`]. On "yes" it
    /// returns the pin to store durably; then call
    /// [`ControllerPairing::pin_stored`].
    ///
    /// # Errors
    /// [`PairingError::Aborted`] with [`CancelCode::User`] on "no", and
    /// [`PairingError::OutOfTurn`] before the target's MAC verified.
    pub fn confirm_target(
        &mut self,
        target_showed_match: bool,
    ) -> Result<VerifiedTarget, PairingError> {
        match std::mem::replace(&mut self.state, State::Ended) {
            State::AwaitOwner { sas } if target_showed_match => {
                self.state = State::AwaitPin { sas };
                Ok(VerifiedTarget {
                    identity: self.transcript.identity.clone(),
                    target_spki: self.transcript.target_spki.clone(),
                })
            }
            State::AwaitOwner { .. } => Err(self.abort(CancelCode::User)),
            other => {
                self.state = other;
                Err(PairingError::OutOfTurn)
            }
        }
    }

    /// Called after the pin is stored durably. Returns the controller's MAC
    /// message; the target records the grant only after verifying it.
    ///
    /// # Errors
    /// [`PairingError::OutOfTurn`] unless the owner confirmed.
    pub fn pin_stored(&mut self) -> Result<Vec<u8>, PairingError> {
        match std::mem::replace(&mut self.state, State::Ended) {
            State::AwaitPin { sas } => {
                self.state = State::AwaitPaired;
                Ok(mac_message(&sas, &self.transcript, ChannelRole::Controller))
            }
            other => {
                self.state = other;
                Err(PairingError::OutOfTurn)
            }
        }
    }

    /// The owner closed the pairing dialog. Returns the `pairing.cancel` to
    /// send while the controller's MAC is unsent. Once it was sent, the
    /// target decides alone and nothing is sent: the stored pin is kept only
    /// if the server then lists a grant of the target for this controller.
    pub fn cancel(&mut self) -> Option<Vec<u8>> {
        match self.state {
            State::Done | State::Ended => None,
            State::AwaitPaired => {
                self.state = State::Ended;
                None
            }
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
