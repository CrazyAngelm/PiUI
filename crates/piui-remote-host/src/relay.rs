//! The frames of the outer relay (nano-hosts-v1.ts).
//!
//! The relay carries opaque TLS bytes: `{seq, data}` where `data` is the
//! unpadded base64url of the bytes. It cannot read or change them, but it can
//! drop, repeat or reorder frames. Each channel direction numbers its frames
//! from 1 in steps of 1, up to `Number.MAX_SAFE_INTEGER` (the JSON number
//! bound of the Desktop API cursors). The receiver accepts exactly the next
//! number; a repeated, missing or reordered frame, or data that is not
//! canonical, ends the channel. [`Inbound`] enforces that itself: after its
//! first violation it refuses every later frame. There is no retransmission
//! at this layer: recovery is a new channel with a full handshake and a new
//! [`Inbound`] from frame 1, and a command is repeated with its own
//! identifier.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::b64;

/// The largest frame number: JavaScript's `Number.MAX_SAFE_INTEGER`.
pub const MAX_SEQ: u64 = 9_007_199_254_740_991;

/// One relay frame on the wire.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelayFrameV1 {
    /// The frame number in its channel direction.
    pub seq: u64,
    /// Unpadded base64url of the TLS bytes.
    pub data: String,
}

/// A violation of the frame sequence or encoding. Each one ends the channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum SequenceError {
    #[error("frame {seq} arrived where {expected} was expected")]
    OutOfOrder { seq: u64, expected: u64 },
    #[error("the frame numbers of this channel are exhausted")]
    Exhausted,
    #[error("the frame data is not canonical non-empty unpadded base64url")]
    Data,
}

/// Numbers outgoing frames.
#[derive(Debug)]
pub struct Outbound {
    next: u64,
}

impl Default for Outbound {
    fn default() -> Self {
        Self::new()
    }
}

impl Outbound {
    /// Starts at frame 1.
    #[must_use]
    pub fn new() -> Self {
        Self { next: 1 }
    }

    /// The frame for `bytes`.
    ///
    /// # Errors
    /// [`SequenceError::Exhausted`] after [`MAX_SEQ`], or
    /// [`SequenceError::Data`] for empty bytes.
    pub fn frame(&mut self, bytes: &[u8]) -> Result<RelayFrameV1, SequenceError> {
        if bytes.is_empty() {
            return Err(SequenceError::Data);
        }
        if self.next > MAX_SEQ {
            return Err(SequenceError::Exhausted);
        }
        let seq = self.next;
        self.next += 1;
        Ok(RelayFrameV1 {
            seq,
            data: b64::encode(bytes),
        })
    }
}

/// Checks incoming frames. Its first violation ends this direction of the
/// channel for good.
#[derive(Debug)]
pub struct Inbound {
    expected: u64,
    /// The violation that ended the direction.
    failed: Option<SequenceError>,
}

impl Default for Inbound {
    fn default() -> Self {
        Self::new()
    }
}

impl Inbound {
    /// Expects frame 1.
    #[must_use]
    pub fn new() -> Self {
        Self {
            expected: 1,
            failed: None,
        }
    }

    /// The TLS bytes of the next frame.
    ///
    /// # Errors
    /// [`SequenceError`] for anything but the next frame with canonical data.
    /// The first error is final: every later frame gets it as well.
    pub fn accept(&mut self, frame: &RelayFrameV1) -> Result<Vec<u8>, SequenceError> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        let accepted = self.next(frame);
        if let Err(error) = &accepted {
            self.failed = Some(*error);
        }
        accepted
    }

    fn next(&mut self, frame: &RelayFrameV1) -> Result<Vec<u8>, SequenceError> {
        if self.expected > MAX_SEQ {
            return Err(SequenceError::Exhausted);
        }
        if frame.seq != self.expected {
            return Err(SequenceError::OutOfOrder {
                seq: frame.seq,
                expected: self.expected,
            });
        }
        let bytes = b64::decode(&frame.data)
            .filter(|bytes| !bytes.is_empty())
            .ok_or(SequenceError::Data)?;
        self.expected += 1;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_accepted_exactly_in_order() {
        let mut outbound = Outbound::new();
        let first = outbound.frame(b"one").expect("frame");
        let second = outbound.frame(b"two").expect("frame");
        assert_eq!((first.seq, second.seq), (1, 2));
        let mut inbound = Inbound::new();
        assert_eq!(
            inbound.accept(&second),
            Err(SequenceError::OutOfOrder {
                seq: 2,
                expected: 1
            })
        );
        let mut inbound = Inbound::new();
        assert_eq!(inbound.accept(&first).as_deref(), Ok(&b"one"[..]));
        assert_eq!(
            inbound.accept(&first),
            Err(SequenceError::OutOfOrder {
                seq: 1,
                expected: 2
            }),
            "a repeated frame ends the channel"
        );
    }

    #[test]
    fn frame_data_must_be_canonical_and_non_empty() {
        for data in ["", "b25l=", "b25", "b2+l"] {
            let frame = RelayFrameV1 {
                seq: 1,
                data: data.to_owned(),
            };
            assert_eq!(
                Inbound::new().accept(&frame),
                Err(SequenceError::Data),
                "{data:?}"
            );
        }
        assert_eq!(Outbound::new().frame(b""), Err(SequenceError::Data));
    }

    #[test]
    fn numbering_stops_at_the_json_safe_integer_bound() {
        let mut outbound = Outbound { next: MAX_SEQ };
        assert_eq!(outbound.frame(b"x").map(|frame| frame.seq), Ok(MAX_SEQ));
        assert_eq!(outbound.frame(b"x"), Err(SequenceError::Exhausted));
        let mut inbound = Inbound {
            expected: MAX_SEQ + 1,
            ..Inbound::new()
        };
        let frame = RelayFrameV1 {
            seq: MAX_SEQ + 1,
            data: "eA".to_owned(),
        };
        assert_eq!(inbound.accept(&frame), Err(SequenceError::Exhausted));
    }

    fn frame(seq: u64, data: &str) -> RelayFrameV1 {
        RelayFrameV1 {
            seq,
            data: data.to_owned(),
        }
    }

    #[test]
    fn a_gap_ends_the_direction() {
        let mut inbound = Inbound::new();
        let ahead = Err(SequenceError::OutOfOrder {
            seq: 2,
            expected: 1,
        });
        assert_eq!(inbound.accept(&frame(2, "dHdv")), ahead);
        assert_eq!(
            inbound.accept(&frame(1, "b25l")),
            ahead,
            "the expected frame after a gap"
        );
    }

    #[test]
    fn a_repeat_ends_the_direction() {
        let mut inbound = Inbound::new();
        assert_eq!(
            inbound.accept(&frame(1, "b25l")).as_deref(),
            Ok(&b"one"[..])
        );
        let repeated = Err(SequenceError::OutOfOrder {
            seq: 1,
            expected: 2,
        });
        assert_eq!(inbound.accept(&frame(1, "b25l")), repeated);
        assert_eq!(
            inbound.accept(&frame(2, "dHdv")),
            repeated,
            "the next frame after a repeat"
        );
    }

    #[test]
    fn non_canonical_data_ends_the_direction() {
        for data in ["", "b25l=", "b25", "b2+l"] {
            let mut inbound = Inbound::new();
            assert_eq!(inbound.accept(&frame(1, data)), Err(SequenceError::Data));
            assert_eq!(
                inbound.accept(&frame(1, "b25l")),
                Err(SequenceError::Data),
                "a valid frame after {data:?}"
            );
        }
    }

    #[test]
    fn exhaustion_stays_and_recovery_starts_again_at_frame_one() {
        let mut inbound = Inbound {
            expected: MAX_SEQ + 1,
            ..Inbound::new()
        };
        assert_eq!(
            inbound.accept(&frame(MAX_SEQ + 1, "eA")),
            Err(SequenceError::Exhausted)
        );
        assert_eq!(
            inbound.accept(&frame(1, "b25l")),
            Err(SequenceError::Exhausted)
        );
        // Recovery is a new channel: its receiver starts again at frame 1 and
        // is just as strict.
        let mut fresh = Inbound::new();
        assert_eq!(fresh.accept(&frame(1, "b25l")).as_deref(), Ok(&b"one"[..]));
        assert_eq!(
            fresh.accept(&frame(3, "eA")),
            Err(SequenceError::OutOfOrder {
                seq: 3,
                expected: 2
            })
        );
    }

    #[test]
    fn unknown_fields_are_refused_on_the_wire() {
        let parsed: Result<RelayFrameV1, _> =
            serde_json::from_str(r#"{"seq":1,"data":"eA","x":0}"#);
        assert!(parsed.is_err());
    }
}
