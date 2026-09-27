//! PiUI's RPC/runtime adapters.
//!
//! This crate owns byte framing, deterministic test doubles, static runtime
//! eligibility, a non-spawning LF JSONL read-only capability-probe
//! coordinator/parser, and a disabled-by-default managed-runtime bundle
//! provenance gate. It also contains the temporary local [`real_rpc`] adapter:
//! after an explicit host action it resolves a locally installed Pi CLI, starts
//! `pi --mode rpc`, frames stdout with the LF codec, and projects only a typed
//! safe event surface. It never reads Pi auth files or exposes process handles,
//! raw stderr, host paths, or raw RPC frames to a WebView.
//!
//! The real adapter is not a release-ready managed-runtime path: its launch is
//! intentionally separate from the provenance/containment supervisor, which
//! remains fail-closed until the production evidence gate is met. Unknown/future
//! RPC events are reduced to payload-free metadata where they are not part of
//! the explicitly supported stream surface.
//!
//! Host-facing DTOs remain owned by [`contracts`] so this crate does not
//! introduce a second application protocol.

pub use piui_contracts as contracts;

pub mod acp;
pub mod codec;
mod extension_manager;
pub mod extension_ui;
pub mod fake;
pub mod git;
mod native_version;
pub mod plugin_backend;
pub mod provenance;
pub mod read_only_probe;
pub mod real_rpc;
pub mod script_runner;
pub mod supervisor;
pub mod workspace_runtime;

// Deliberately crate-private: bytes-only upstream observation cannot authorize
// a runtime and is not host/application API.
mod upstream_evidence;

pub use codec::{
    JsonValueKind, NormalizedRpcEvent, OpaqueRpcEvent, RpcCodec, RpcCodecConfig, RpcCodecCounters,
    RpcCodecError, RpcEventNormalizer, UnknownEventTypeCategory,
};
pub use extension_manager::{
    AgentExtensionOrigin, AgentExtensionResource, ExtensionManagerError,
    list_global_extensions_for_agent, set_global_extension_enabled_for_agent,
};
pub use extension_ui::{
    ExtensionDialogOption, ExtensionDialogRequest, ExtensionUiAction, ExtensionUiResponse,
};
pub use fake::{
    FakeCommand, FakeEmission, FakeRuntime, FakeRuntimeError, FakeScenario, FakeTransportError,
    FakeTransportEvent, FakeTransportReplay, LifecycleState,
};
pub use provenance::{
    ManagedRuntimeArch, ManagedRuntimeOs, ManagedRuntimeTarget, ManagedRuntimeVerifier,
    ProvenanceError, RuntimeBinding, VerifiedManagedRuntimeBundle,
};
pub use read_only_probe::{
    ProbeCommandOutcome, ProbeThinkingLevel, ReadOnlyProbeSnapshot, ReadOnlyProbeTransport,
    ReadOnlyProbeTransportError,
};
pub use real_rpc::{
    LOCAL_RUNTIME_EVENT_PROTOCOL, ModelLite, PiLaunch, RealPiConfig, RealPiRuntime,
    RealRuntimeError, RuntimeCommandLite, RuntimeEventEnvelope, SessionStateLite, SurfaceEvent,
    resolve_pi_launch,
};
pub use supervisor::{
    ManagedRuntimePurpose, ProbeAuthorization, ProductionRuntimePolicy,
    ProductionRuntimeSupervisor, SupervisorError,
};
pub mod workspace_usage;
