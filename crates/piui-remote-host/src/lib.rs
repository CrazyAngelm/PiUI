//! Security core of connected execution hosts (Stage 9A, ADR-080).
//!
//! A connected execution host is another Nano Desktop of the same account
//! that its owner explicitly enabled and paired at both computers. This crate
//! holds the parts of that feature that must be correct independently of the
//! relay, the Tauri host and the user interface:
//!
//! - [`identity`]: the Ed25519 identity key, its exact SubjectPublicKeyInfo
//!   and a typed custody abstraction that refuses anything but a durable OS
//!   credential store. No private key is ever written to a file here.
//! - [`tls`]: a sans-IO TLS 1.3 channel with mutual raw public keys
//!   (RFC 7250) over an abstract byte transport, the fixed ALPN
//!   `nano-host/1`, no resumption, tickets, early data or SNI, and strict
//!   pinned peer keys for every ordinary channel.
//! - [`pairing`]: commitment-first SAS verification with bilateral human
//!   confirmation, built on the vodozemac SAS building blocks. It binds the
//!   account, the target host, the controller device, both exact TLS keys,
//!   the TLS channel binding and the protocol into its transcript.
//! - [`framing`] and [`relay`]: typed message framing bounded by a limit the
//!   caller takes from the authoritative protocol, and the strict frame
//!   sequence of the outer relay.
//! - [`journal`]: durable command identity, intent before effect and
//!   settlement, with no automatic replay after an ambiguous outcome.
//! - [`policy`]: the grant a target keeps for one paired controller, with its
//!   trusted projects and comparable permission ceilings.
//!
//! What this crate is not: it has no listener, no HTTP client, no scheduler,
//! no agent loop, no provider client and no generic remote procedure call.
//! An OAuth device is never execution authority here: execution needs a
//! verified local grant and a channel authenticated by its pinned key.

pub mod framing;
pub mod identity;
pub mod ids;
pub mod journal;
pub mod pairing;
pub mod policy;
pub mod relay;
pub mod tls;

mod b64;

#[cfg(test)]
mod tests;

/// The protocol of the end-to-end channel. It is the TLS ALPN identifier and
/// the protocol label of every transcript in this crate.
pub const PROTOCOL: &str = "nano-host/1";
