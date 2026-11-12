//! Nano account custody and the loopback model relay of Nano Desktop
//! (ADR-047, ADR-048).
//!
//! # Trust model
//!
//! - This crate runs only in the Rust host. Access tokens, refresh tokens,
//!   authorization codes, PKCE verifiers and relay keys never leave it: they
//!   are absent from [`status::NanoAccountStatusV1`], every `Debug` output is
//!   redacted, and the crate logs nothing.
//! - The refresh token is kept in the OS credential store (memory only where
//!   that fails or does not exist); there is no plaintext file. The access
//!   token lives in memory.
//! - Signed out, nothing contacts a Nano server.
//! - The [`relay::Relay`] is a policy-enforcing byte forwarder on
//!   `127.0.0.1`, not a sandbox: it limits which local caller can spend the
//!   account (per-session key, `Host` and browser-header checks, entitled
//!   modes, size and concurrency caps). The Nano agent itself runs as the
//!   user with the user's permissions.
//! - The Pi agent directory ([`agent_dir`]) holds configuration only; the
//!   relay key reaches Pi through its environment.
//!
//! The wire types mirror `contracts/nano-account-v1.ts` ([`status`]) and
//! `contracts/nano-server-v1.ts` ([`wire`]).

pub mod account;
pub mod agent_dir;
pub mod config;
pub mod discovery;
pub mod error;
pub mod external_providers;
pub mod loopback;
pub mod oauth;
pub mod openai_subscription;
pub mod pkce;
pub mod relay;
pub mod secret;
pub mod status;
pub mod store;
pub mod wire;

mod fsutil;
mod net;

#[cfg(test)]
mod testing;

pub use account::{AccountGeneration, NanoAccount, OpenBrowser};
pub use agent_dir::{AgentDirError, PreparedAgentDir, prepare_pi_agent_dir};
pub use config::NanoConfig;
pub use error::NanoError;
pub use relay::{Relay, RelaySession};
pub use secret::SecretString;
pub use status::{
    NANO_ACCOUNT_EVENT_V1, NanoAccountEventV1, NanoAccountStateV1, NanoAccountStatusV1,
    NanoCredentialStoreV1, NanoLinkV1, NanoOpenLinkRequestV1, NanoSelectWorkspaceRequestV1,
};
pub use store::{CredentialStore, MemoryStore, NanoPrefs, PrefsFile};
pub use wire::{NanoEntitlementsV1, NanoModeIdV1, NanoModeV1};
