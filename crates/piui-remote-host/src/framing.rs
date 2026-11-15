//! Message framing inside the TLS channel.
//!
//! TLS carries a byte stream; nano-host/1 carries messages in it. A message
//! is a 4-byte big-endian payload length followed by the payload, a UTF-8
//! JSON document. Empty payloads are invalid.
//!
//! The largest payload is not chosen here. The caller passes a
//! [`MessageLimit`] taken from the authoritative protocol: nano-host-v1.ts
//! sets it to the Desktop API document cap (`MAX_API_BODY` of `piui-nano`,
//! the same cap the cloud stream applies per event). The decoder checks each
//! length prefix as soon as it is complete and copies payload bytes only for
//! a length it accepted, so an empty or oversized message fails before any
//! byte of its payload is buffered. Every framing error is final: the
//! decoder refuses all later input, and the channel closes.

use std::collections::VecDeque;
use std::num::NonZeroU32;

use thiserror::Error;

/// Length of the payload length prefix.
pub const LENGTH_PREFIX: usize = 4;

/// The largest payload in bytes, from the authoritative protocol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageLimit(NonZeroU32);

impl MessageLimit {
    /// A limit of `max_payload` bytes.
    #[must_use]
    pub const fn new(max_payload: NonZeroU32) -> Self {
        Self(max_payload)
    }

    /// The limit in bytes.
    #[must_use]
    pub fn bytes(self) -> usize {
        usize::try_from(self.0.get()).unwrap_or(usize::MAX)
    }
}

/// A framing violation. Each one ends the channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum FramingError {
    #[error("an empty message")]
    Empty,
    #[error("a message of {declared} bytes exceeds the limit of {limit}")]
    TooLarge { declared: usize, limit: usize },
    #[error("the stream ended inside a message")]
    Truncated,
}

/// Frames `payload`.
///
/// # Errors
/// [`FramingError::Empty`] or [`FramingError::TooLarge`].
pub fn encode(payload: &[u8], limit: MessageLimit) -> Result<Vec<u8>, FramingError> {
    if payload.is_empty() {
        return Err(FramingError::Empty);
    }
    if payload.len() > limit.bytes() {
        return Err(FramingError::TooLarge {
            declared: payload.len(),
            limit: limit.bytes(),
        });
    }
    let length = u32::try_from(payload.len()).map_err(|_| FramingError::TooLarge {
        declared: payload.len(),
        limit: limit.bytes(),
    })?;
    let mut framed = Vec::with_capacity(LENGTH_PREFIX + payload.len());
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(payload);
    Ok(framed)
}

/// Incremental decoder of the message stream. It copies a payload byte only
/// after its length prefix was accepted, and its first error is final.
#[derive(Debug)]
pub struct Decoder {
    limit: MessageLimit,
    /// The length prefix received so far.
    prefix: [u8; LENGTH_PREFIX],
    prefix_len: usize,
    /// The accepted length of the message being received.
    declared: Option<usize>,
    /// Its payload so far.
    payload: Vec<u8>,
    /// The error that ended the stream.
    failed: Option<FramingError>,
}

impl Decoder {
    /// A decoder with `limit`.
    #[must_use]
    pub fn new(limit: MessageLimit) -> Self {
        Self {
            limit,
            prefix: [0; LENGTH_PREFIX],
            prefix_len: 0,
            declared: None,
            payload: Vec::new(),
            failed: None,
        }
    }

    /// Adds stream bytes and moves every complete message to `messages`.
    ///
    /// # Errors
    /// [`FramingError::Empty`] or [`FramingError::TooLarge`] as soon as a
    /// length prefix is complete, before any byte of its payload is copied.
    /// The messages completed before it are still moved to `messages`. The
    /// error is final: the decoder then holds nothing, and every later call
    /// returns the same error.
    pub fn push(
        &mut self,
        mut bytes: &[u8],
        messages: &mut VecDeque<Vec<u8>>,
    ) -> Result<(), FramingError> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        while !bytes.is_empty() {
            if let Some(declared) = self.declared {
                let wanted = declared - self.payload.len();
                let (part, rest) = bytes.split_at(wanted.min(bytes.len()));
                self.payload.extend_from_slice(part);
                bytes = rest;
                if part.len() == wanted {
                    messages.push_back(std::mem::take(&mut self.payload));
                    self.declared = None;
                }
                continue;
            }
            let wanted = LENGTH_PREFIX - self.prefix_len;
            let (part, rest) = bytes.split_at(wanted.min(bytes.len()));
            self.prefix[self.prefix_len..self.prefix_len + part.len()].copy_from_slice(part);
            self.prefix_len += part.len();
            bytes = rest;
            if self.prefix_len < LENGTH_PREFIX {
                // `bytes` is used up; the rest of the prefix comes later.
                break;
            }
            self.prefix_len = 0;
            let declared = usize::try_from(u32::from_be_bytes(self.prefix)).unwrap_or(usize::MAX);
            let refusal = if declared == 0 {
                Some(FramingError::Empty)
            } else if declared > self.limit.bytes() {
                Some(FramingError::TooLarge {
                    declared,
                    limit: self.limit.bytes(),
                })
            } else {
                None
            };
            if let Some(error) = refusal {
                self.failed = Some(error);
                return Err(error);
            }
            self.declared = Some(declared);
        }
        Ok(())
    }

    /// Whether the decoder has not failed and holds no partial message.
    #[must_use]
    pub fn is_idle(&self) -> bool {
        self.failed.is_none() && self.prefix_len == 0 && self.declared.is_none()
    }

    /// Tests only: the stream bytes this decoder holds.
    #[cfg(test)]
    fn buffered(&self) -> usize {
        self.prefix_len + self.payload.len()
    }

    /// Called when the stream ends.
    ///
    /// # Errors
    /// The decoder's final error, or [`FramingError::Truncated`] when a
    /// message is incomplete.
    pub fn finish(&self) -> Result<(), FramingError> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        if self.is_idle() {
            Ok(())
        } else {
            Err(FramingError::Truncated)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limit(bytes: u32) -> MessageLimit {
        MessageLimit::new(NonZeroU32::new(bytes).expect("non-zero"))
    }

    #[test]
    fn messages_survive_any_split_of_the_stream() {
        let mut stream = encode(b"{\"a\":1}", limit(16)).expect("frame");
        stream.extend(encode(b"{}", limit(16)).expect("frame"));
        for split in 0..=stream.len() {
            let mut decoder = Decoder::new(limit(16));
            let mut messages = VecDeque::new();
            decoder
                .push(&stream[..split], &mut messages)
                .expect("first part");
            decoder
                .push(&stream[split..], &mut messages)
                .expect("second part");
            assert_eq!(messages, [b"{\"a\":1}".to_vec(), b"{}".to_vec()]);
            assert!(decoder.finish().is_ok());
        }
    }

    #[test]
    fn the_limit_is_exact_and_checked_before_the_payload_arrives() {
        assert!(encode(&[b'x'; 16], limit(16)).is_ok());
        assert_eq!(
            encode(&[b'x'; 17], limit(16)),
            Err(FramingError::TooLarge {
                declared: 17,
                limit: 16
            })
        );
        let mut decoder = Decoder::new(limit(16));
        let mut messages = VecDeque::new();
        // Only the length prefix of an oversized message has arrived.
        assert_eq!(
            decoder.push(&17u32.to_be_bytes(), &mut messages),
            Err(FramingError::TooLarge {
                declared: 17,
                limit: 16
            })
        );
        let mut huge = Decoder::new(limit(16));
        assert_eq!(
            huge.push(&u32::MAX.to_be_bytes(), &mut messages),
            Err(FramingError::TooLarge {
                declared: usize::try_from(u32::MAX).unwrap_or(usize::MAX),
                limit: 16
            })
        );
        assert!(messages.is_empty());
    }

    #[test]
    fn empty_and_truncated_messages_are_errors() {
        assert_eq!(encode(b"", limit(16)), Err(FramingError::Empty));
        let mut decoder = Decoder::new(limit(16));
        let mut messages = VecDeque::new();
        assert_eq!(
            decoder.push(&0u32.to_be_bytes(), &mut messages),
            Err(FramingError::Empty)
        );
        let mut partial = Decoder::new(limit(16));
        partial
            .push(&[0, 0, 0, 3, b'{'], &mut messages)
            .expect("partial");
        assert_eq!(partial.finish(), Err(FramingError::Truncated));
    }

    /// A length prefix declaring `declared` bytes, then `payload`.
    fn frame(declared: u32, payload: &[u8]) -> Vec<u8> {
        let mut bytes = declared.to_be_bytes().to_vec();
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn a_refused_prefix_copies_none_of_its_payload() {
        let oversized = frame(17, &[b'x'; 17]);
        let refused = FramingError::TooLarge {
            declared: 17,
            limit: 16,
        };
        let mut messages = VecDeque::new();
        // The prefix and its payload in one call.
        let mut decoder = Decoder::new(limit(16));
        assert_eq!(decoder.push(&oversized, &mut messages), Err(refused));
        assert!(
            decoder.buffered() <= LENGTH_PREFIX,
            "{} bytes buffered",
            decoder.buffered()
        );
        // The prefix split, its last part arriving with the payload.
        for split in 1..LENGTH_PREFIX {
            let mut decoder = Decoder::new(limit(16));
            decoder
                .push(&oversized[..split], &mut messages)
                .expect("part of a prefix");
            assert_eq!(
                decoder.push(&oversized[split..], &mut messages),
                Err(refused)
            );
            assert!(
                decoder.buffered() <= LENGTH_PREFIX,
                "split {split}: {} bytes buffered",
                decoder.buffered()
            );
        }
        assert!(messages.is_empty());
        // A whole message before the refused one is still delivered.
        let mut stream = encode(b"{}", limit(16)).expect("frame");
        stream.extend_from_slice(&oversized);
        let mut decoder = Decoder::new(limit(16));
        assert_eq!(decoder.push(&stream, &mut messages), Err(refused));
        assert_eq!(messages, [b"{}".to_vec()]);
        assert!(
            decoder.buffered() <= LENGTH_PREFIX,
            "{} bytes buffered",
            decoder.buffered()
        );
        // An empty message is refused the same way.
        let mut decoder = Decoder::new(limit(16));
        assert_eq!(
            decoder.push(&frame(0, b"{}"), &mut VecDeque::new()),
            Err(FramingError::Empty)
        );
        assert!(decoder.buffered() <= LENGTH_PREFIX);
    }

    #[test]
    fn many_messages_in_one_call_are_all_delivered() {
        let payloads: [&[u8]; 3] = [b"{\"a\":1}", b"{}", &[b'y'; 16]];
        let stream: Vec<u8> = payloads
            .iter()
            .flat_map(|payload| encode(payload, limit(16)).expect("frame"))
            .collect();
        let mut decoder = Decoder::new(limit(16));
        let mut messages = VecDeque::new();
        decoder.push(&stream, &mut messages).expect("stream");
        assert_eq!(messages, payloads.map(<[u8]>::to_vec));
        assert!(decoder.is_idle());
        assert_eq!(decoder.buffered(), 0);
        // One byte at a time: every prefix is split at every point.
        let mut decoder = Decoder::new(limit(16));
        let mut one_by_one = VecDeque::new();
        for byte in &stream {
            decoder
                .push(std::slice::from_ref(byte), &mut one_by_one)
                .expect("byte");
        }
        assert_eq!(one_by_one, messages);
        assert!(decoder.finish().is_ok());
    }

    #[test]
    fn a_failed_decoder_refuses_everything_after() {
        let valid = encode(b"{}", limit(16)).expect("frame");
        let too_large = FramingError::TooLarge {
            declared: 17,
            limit: 16,
        };
        for (first, error) in [
            (frame(17, b""), too_large),
            (frame(0, b""), FramingError::Empty),
        ] {
            let mut decoder = Decoder::new(limit(16));
            let mut messages = VecDeque::new();
            assert_eq!(decoder.push(&first, &mut messages), Err(error));
            assert_eq!(decoder.push(&valid, &mut messages), Err(error));
            assert!(messages.is_empty(), "{error:?}");
            assert_eq!(decoder.buffered(), 0, "{error:?}");
            assert!(!decoder.is_idle());
            assert_eq!(decoder.finish(), Err(error));
        }
    }
}
