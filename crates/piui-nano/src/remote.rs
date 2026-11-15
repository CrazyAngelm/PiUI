//! Remote access to Nano Desktop from Nano Web (ADR-062,
//! `contracts/nano-remote-v1.ts`).
//!
//! A signed-in host whose owner switched remote access on keeps one outbound
//! WebSocket to the Nano server ([`link`]). A browser of the same account,
//! paired on this computer, drives an allowlisted part of the host API through
//! that link; the server only relays frames. This crate holds the protocol
//! pieces; the state machine, the allowlist and the commands live in the
//! application crate (`nano/remote*.rs`).
//!
//! # Trust model
//!
//! - Runs only in the Rust host. The link is opened by the host alone, only
//!   while the person's toggle is on, the account is signed in and the
//!   application is not in safe mode. There is no local listener: the
//!   loopback relay stays the only one.
//! - The access token is fetched from [`crate::NanoAccount`] for each attempt
//!   and sent as the `Authorization` header of the upgrade request through the
//!   account's own HTTP client (issuer pin, platform verifier, proxy rules,
//!   `X-Nano-Client`). It is never put in a URL, a frame or a log.
//! - A browser is trusted by a non-extractable ECDSA P-256 key it holds, not
//!   by the Nano account alone: [`pairing`] verifies a signature that binds
//!   the proof to this device and to one relay session, and [`grants`]
//!   remembers only public keys the person approved on this computer.
//! - The server is a relay, not a verifier. Frames are not encrypted end to
//!   end in v1.
//! - The crate logs nothing: no header, frame, key, label or URL query.

pub mod frames;
pub mod grants;
pub mod link;
pub mod pairing;

#[cfg(test)]
mod tests;
