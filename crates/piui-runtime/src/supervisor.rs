//! Disabled-by-default managed-runtime authorization state machine.
//!
//! This module deliberately has no process spawning, shell, `PATH`, Tokio
//! process, session mutation, or Pi configuration/auth access. On Windows it
//! can prepare a real, empty Job Object only after every probe gate passes. It
//! never launches a binary.

#![allow(
    dead_code,
    reason = "Phase 0 deliberately keeps the non-launching authorization path crate-private until a handle-owning platform supervisor exists."
)]

use crate::provenance::{ProvenanceError, VerifiedManagedRuntimeBundle};
#[cfg(windows)]
use piui_platform::WindowsJob;
#[cfg(windows)]
use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_SUPERVISOR_INSTANCE: AtomicU64 = AtomicU64::new(1);
#[cfg(windows)]
const MAX_OUTSTANDING_PROBE_AUTHORIZATIONS: usize = 1;

/// Production runtime policy. The safe default cannot authorize any launch.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProductionRuntimePolicy {
    #[default]
    Disabled,
    /// Explicit host-only opt-in for a future containment-only capability
    /// probe. This is not session continuation permission.
    ContainedProbeOnly,
}

/// Requested purpose for a theoretical managed runtime launch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedRuntimePurpose {
    ContainedProbeOnly,
    /// Always denied until the Phase 0 continuation gate is independently
    /// closed; this supervisor intentionally cannot start session execution.
    SessionExecution,
}

/// Path-free authorization failures for the disabled production supervisor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorError {
    DisabledByPolicy,
    SafeMode,
    SessionContinuationGateClosed,
    ContainmentUnavailable,
    ProvenanceRejected,
    AuthorizationCapacityExceeded,
    AuthorizationConsumed,
}

impl fmt::Display for SupervisorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::DisabledByPolicy => "managed runtime supervisor is disabled by policy",
            Self::SafeMode => "managed runtime supervisor is disabled in safe mode",
            Self::SessionContinuationGateClosed => {
                "managed runtime session continuation gate is closed"
            }
            Self::ContainmentUnavailable => "managed runtime containment is unavailable",
            Self::ProvenanceRejected => "managed runtime provenance revalidation failed",
            Self::AuthorizationCapacityExceeded => {
                "managed runtime probe authorization capacity is exhausted"
            }
            Self::AuthorizationConsumed => "managed runtime probe authorization is no longer valid",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SupervisorError {}

/// Opaque, single-use authorization for a future platform launcher. It has no
/// serde implementation, exposes no executable path, and is useless outside
/// the originating supervisor instance.
#[derive(Eq, PartialEq)]
pub struct ProbeAuthorization {
    supervisor_instance: u64,
    nonce: u64,
}

impl fmt::Debug for ProbeAuthorization {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProbeAuthorization(<redacted>)")
    }
}

/// Host-private, affine probe preparation evidence.
///
/// This owns both the revalidated bundle evidence and the real, empty Windows
/// Job Object configured with `KILL_ON_JOB_CLOSE`. It has no API exposing the
/// bundle, Job, raw handle, or a process-launch surface.
#[cfg(windows)]
pub(crate) struct PreparedProbe {
    // Keep containment first: Rust drops fields in declaration order, so the
    // Job handle's best-effort teardown precedes release of retained bundle
    // leases. PreparedProbe normally owns an empty Job and has no child handles
    // to observe or wait; it must not be treated as a running-tree guarantee.
    containment: WindowsJob,
    runtime: VerifiedManagedRuntimeBundle,
}

#[cfg(windows)]
impl fmt::Debug for PreparedProbe {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PreparedProbe(<redacted>)")
    }
}

#[cfg(windows)]
struct OutstandingProbeAuthorization {
    runtime: VerifiedManagedRuntimeBundle,
    containment: WindowsJob,
}

/// The sole Windows containment owner may be transferred once. A transferred
/// owner is intentionally terminal for this non-launching supervisor instance.
#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ContainmentSlot {
    Available,
    Transferred,
}

#[cfg(windows)]
fn assert_send<T: Send>() {}

#[cfg(windows)]
const _: fn() = assert_send::<PreparedProbe>;
#[cfg(windows)]
const _: fn() = assert_send::<ProductionRuntimeSupervisor>;

/// A non-spawning production supervisor gate.
pub struct ProductionRuntimeSupervisor {
    policy: ProductionRuntimePolicy,
    instance: u64,
    #[cfg(windows)]
    next_nonce: u64,
    #[cfg(windows)]
    outstanding: BTreeMap<u64, OutstandingProbeAuthorization>,
    #[cfg(windows)]
    containment_slot: ContainmentSlot,
}

impl ProductionRuntimeSupervisor {
    #[must_use]
    pub fn new(policy: ProductionRuntimePolicy) -> Self {
        Self {
            policy,
            instance: next_supervisor_instance(),
            #[cfg(windows)]
            next_nonce: 1,
            #[cfg(windows)]
            outstanding: BTreeMap::new(),
            #[cfg(windows)]
            containment_slot: ContainmentSlot::Available,
        }
    }

    #[must_use]
    pub const fn policy(&self) -> ProductionRuntimePolicy {
        self.policy
    }

    /// Attempts to issue a containment-only probe authorization. The verified
    /// bundle is revalidated before a Windows Job Object is created. This
    /// method never launches a binary. Non-Windows platforms deliberately have
    /// no substitute containment implementation and fail closed.
    pub(crate) fn authorize(
        &mut self,
        runtime: VerifiedManagedRuntimeBundle,
        purpose: ManagedRuntimePurpose,
        safe_mode: bool,
    ) -> Result<ProbeAuthorization, SupervisorError> {
        if self.policy != ProductionRuntimePolicy::ContainedProbeOnly {
            return Err(SupervisorError::DisabledByPolicy);
        }
        if safe_mode {
            return Err(SupervisorError::SafeMode);
        }
        if purpose != ManagedRuntimePurpose::ContainedProbeOnly {
            return Err(SupervisorError::SessionContinuationGateClosed);
        }
        #[cfg(windows)]
        {
            if self.containment_slot == ContainmentSlot::Transferred {
                // Ownership of the only containment Job escaped successfully.
                // Do not create a second independent Job for this supervisor.
                return Err(SupervisorError::ContainmentUnavailable);
            }
            runtime
                .revalidate()
                .map_err(map_provenance_error_to_supervisor)?;
            if self.outstanding.len() >= MAX_OUTSTANDING_PROBE_AUTHORIZATIONS {
                return Err(SupervisorError::AuthorizationCapacityExceeded);
            }
            let containment =
                WindowsJob::new().map_err(|_| SupervisorError::ContainmentUnavailable)?;
            let nonce = self.next_nonce;
            self.next_nonce = self.next_nonce.checked_add(1).unwrap_or(1);
            // Extremely long-running hosts can wrap. Avoid replacing a live permit.
            let nonce = if self.outstanding.contains_key(&nonce) {
                self.next_available_nonce()
            } else {
                nonce
            };
            self.outstanding.insert(
                nonce,
                OutstandingProbeAuthorization {
                    runtime,
                    containment,
                },
            );
            Ok(ProbeAuthorization {
                supervisor_instance: self.instance,
                nonce,
            })
        }

        #[cfg(not(windows))]
        {
            // Do not inspect a bundle on a platform that cannot prepare the
            // required containment primitive.
            let _ = runtime;
            Err(SupervisorError::ContainmentUnavailable)
        }
    }

    /// Transfer an authorization exactly once into host-private prepared probe
    /// evidence. Precondition failures borrow and retain the authorization;
    /// removal happens only after they pass. Revalidation happens after removal,
    /// so stale evidence still consumes its authorization. This remains
    /// crate-private because no approved launcher can consume the ownership.
    #[cfg(windows)]
    pub(crate) fn take_authorized_prepared_probe(
        &mut self,
        authorization: &ProbeAuthorization,
        safe_mode: bool,
    ) -> Result<PreparedProbe, SupervisorError> {
        if authorization.supervisor_instance != self.instance {
            return Err(SupervisorError::AuthorizationConsumed);
        }
        if self.policy != ProductionRuntimePolicy::ContainedProbeOnly {
            return Err(SupervisorError::DisabledByPolicy);
        }
        if safe_mode {
            return Err(SupervisorError::SafeMode);
        }
        // Remove before revalidation: every actual handoff attempt is single-use.
        // If revalidation fails, `outstanding` drops here and the available slot
        // remains reusable. Only a successful ownership transfer is terminal.
        let outstanding = self
            .outstanding
            .remove(&authorization.nonce)
            .ok_or(SupervisorError::AuthorizationConsumed)?;
        outstanding
            .runtime
            .revalidate()
            .map_err(map_provenance_error_to_supervisor)?;
        self.containment_slot = ContainmentSlot::Transferred;
        Ok(PreparedProbe {
            containment: outstanding.containment,
            runtime: outstanding.runtime,
        })
    }

    #[cfg(windows)]
    fn next_available_nonce(&mut self) -> u64 {
        loop {
            let nonce = self.next_nonce;
            self.next_nonce = self.next_nonce.checked_add(1).unwrap_or(1);
            if !self.outstanding.contains_key(&nonce) {
                return nonce;
            }
        }
    }

    #[cfg(test)]
    fn authorize_with_test_sink(
        &mut self,
        runtime: VerifiedManagedRuntimeBundle,
        purpose: ManagedRuntimePurpose,
        safe_mode: bool,
        sink: &mut dyn TestProbeSink,
    ) -> Result<ProbeAuthorization, SupervisorError> {
        let authorization = self.authorize(runtime, purpose, safe_mode)?;
        sink.authorization_issued();
        Ok(authorization)
    }
}

// This synthetic process-tree proof is deliberately test-only and kept out of
// this non-spawning supervisor source. It never exercises a Pi artifact.
#[cfg(all(test, windows))]
#[path = "supervisor/windows_synthetic_containment.rs"]
mod windows_synthetic_containment;

fn next_supervisor_instance() -> u64 {
    // Zero is reserved as an invalid/non-issued marker. On theoretical wrap,
    // skip it; a collision remains impractical and permits are crate-private.
    let instance = NEXT_SUPERVISOR_INSTANCE.fetch_add(1, Ordering::Relaxed);
    if instance == 0 {
        NEXT_SUPERVISOR_INSTANCE.fetch_add(1, Ordering::Relaxed)
    } else {
        instance
    }
}

fn map_provenance_error_to_supervisor(_error: ProvenanceError) -> SupervisorError {
    // Keep bundle paths, hashes, manifest, and filesystem details out of this
    // public supervisor result. Host diagnostics can count this category only.
    SupervisorError::ProvenanceRejected
}

#[cfg(test)]
trait TestProbeSink {
    fn authorization_issued(&mut self);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provenance::{
        ManagedRuntimeArch, ManagedRuntimeOs, ManagedRuntimeTarget, RuntimeBinding,
    };
    use ed25519_dalek::{Signer, SigningKey};
    #[cfg(windows)]
    use piui_platform::{ContainmentState, ProcessContainment};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TemporaryDirectory {
        path: PathBuf,
    }

    impl TemporaryDirectory {
        fn new() -> Self {
            let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("piui-runtime-supervisor-{sequence}"));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("creates fixture root");
            Self { path }
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[derive(Default)]
    struct CounterSink(usize);

    impl TestProbeSink for CounterSink {
        fn authorization_issued(&mut self) {
            self.0 += 1;
        }
    }

    fn target() -> ManagedRuntimeTarget {
        ManagedRuntimeTarget::new(ManagedRuntimeOs::Linux, ManagedRuntimeArch::X86_64)
    }

    fn binding() -> RuntimeBinding {
        RuntimeBinding::new(
            "piui-0.1",
            "pi-rpc-v1",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("creates binding")
    }

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn verified_runtime(root: &Path) -> VerifiedManagedRuntimeBundle {
        let bytes = b"supervisor-runtime-fixture";
        fs::create_dir_all(root.join("bin")).expect("creates runtime directory");
        fs::write(root.join("bin/pi-runtime"), bytes).expect("writes runtime fixture");
        let signing_key = SigningKey::from_bytes(&[19_u8; 32]);
        let verifier = crate::provenance::ManagedRuntimeVerifier::with_test_key(
            target(),
            binding(),
            signing_key.verifying_key(),
        );
        let raw = format!(
            "{{\"schema_id\":\"piui-managed-runtime\",\"schema_version\":2,\"release_id\":\"release-1\",\"piui_compatibility\":\"piui-0.1\",\"bundle\":{{\"target_os\":\"linux\",\"target_arch\":\"x86_64\",\"distribution\":\"official-standalone\",\"entrypoint\":\"bin/pi-runtime\",\"files\":[{{\"path\":\"bin/pi-runtime\",\"size_bytes\":{},\"sha256\":\"{}\"}}]}},\"capability_binding\":{{\"contract\":\"pi-rpc-v1\",\"fixture_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}}}",
            bytes.len(),
            digest(bytes),
        )
        .into_bytes();
        let signature = signing_key
            .sign(&crate::provenance::manifest_signature_message(&raw))
            .to_bytes();
        verifier
            .verify_app_managed_bundle(root, &raw, &signature)
            .expect("verifies test runtime")
    }

    #[test]
    fn default_and_invalid_states_never_invoke_probe_sink() {
        let root = TemporaryDirectory::new();
        let mut sink = CounterSink::default();
        let mut disabled = ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::Disabled);
        assert_eq!(
            disabled.authorize_with_test_sink(
                verified_runtime(&root.path),
                ManagedRuntimePurpose::ContainedProbeOnly,
                false,
                &mut sink,
            ),
            Err(SupervisorError::DisabledByPolicy)
        );
        assert_eq!(sink.0, 0);

        let mut enabled =
            ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::ContainedProbeOnly);
        assert_eq!(
            enabled.authorize_with_test_sink(
                verified_runtime(&root.path),
                ManagedRuntimePurpose::SessionExecution,
                false,
                &mut sink,
            ),
            Err(SupervisorError::SessionContinuationGateClosed)
        );
        assert_eq!(sink.0, 0);
        assert_eq!(
            enabled.authorize_with_test_sink(
                verified_runtime(&root.path),
                ManagedRuntimePurpose::ContainedProbeOnly,
                true,
                &mut sink,
            ),
            Err(SupervisorError::SafeMode)
        );
        assert_eq!(sink.0, 0);
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_rejects_containment_before_bundle_revalidation() {
        let root = TemporaryDirectory::new();
        let runtime = verified_runtime(&root.path);
        fs::write(root.path.join("unexpected"), b"tampered")
            .expect("makes revalidation fail if it runs");
        let mut supervisor =
            ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::ContainedProbeOnly);
        assert_eq!(
            supervisor.authorize(runtime, ManagedRuntimePurpose::ContainedProbeOnly, false),
            Err(SupervisorError::ContainmentUnavailable)
        );
    }

    #[cfg(windows)]
    #[test]
    fn live_prepared_job_transfers_once_and_consumes_the_containment_slot() {
        let root = TemporaryDirectory::new();
        let second_root = TemporaryDirectory::new();
        let mut supervisor =
            ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::ContainedProbeOnly);
        let authorization = supervisor
            .authorize(
                verified_runtime(&root.path),
                ManagedRuntimePurpose::ContainedProbeOnly,
                false,
            )
            .expect("creates a live empty Job Object after all gates pass");
        let prepared = supervisor
            .take_authorized_prepared_probe(&authorization, false)
            .expect("transfers the only authorization");
        assert_eq!(prepared.containment.state(), ContainmentState::Prepared);
        assert!(prepared.containment.kill_on_close_confirmed());
        assert_eq!(format!("{prepared:?}"), "PreparedProbe(<redacted>)");
        assert!(matches!(
            supervisor.take_authorized_prepared_probe(&authorization, false),
            Err(SupervisorError::AuthorizationConsumed)
        ));
        assert_eq!(
            supervisor.authorize(
                verified_runtime(&second_root.path),
                ManagedRuntimePurpose::ContainedProbeOnly,
                false,
            ),
            Err(SupervisorError::ContainmentUnavailable)
        );
        drop(prepared);
    }

    #[cfg(windows)]
    #[test]
    fn rejected_handoff_preconditions_retain_the_live_authorization() {
        let root = TemporaryDirectory::new();
        let mut supervisor =
            ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::ContainedProbeOnly);
        let mut foreign =
            ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::ContainedProbeOnly);
        let authorization = supervisor
            .authorize(
                verified_runtime(&root.path),
                ManagedRuntimePurpose::ContainedProbeOnly,
                false,
            )
            .expect("issues one permit");

        assert!(matches!(
            foreign.take_authorized_prepared_probe(&authorization, false),
            Err(SupervisorError::AuthorizationConsumed)
        ));
        assert!(matches!(
            supervisor.take_authorized_prepared_probe(&authorization, true),
            Err(SupervisorError::SafeMode)
        ));
        let prepared = supervisor
            .take_authorized_prepared_probe(&authorization, false)
            .expect("precondition failures retained the live authorization");
        assert_eq!(prepared.containment.state(), ContainmentState::Prepared);
        drop(prepared);
    }

    #[cfg(windows)]
    #[test]
    fn provenance_failure_prevents_probe_authorization() {
        let root = TemporaryDirectory::new();
        let runtime = verified_runtime(&root.path);
        fs::write(root.path.join("unexpected"), b"tampered").expect("adds unlisted bundle entry");
        let mut supervisor =
            ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::ContainedProbeOnly);
        assert_eq!(
            supervisor.authorize(runtime, ManagedRuntimePurpose::ContainedProbeOnly, false),
            Err(SupervisorError::ProvenanceRejected)
        );
    }

    #[cfg(windows)]
    #[test]
    fn stale_handoff_drops_its_job_and_reopens_the_containment_slot() {
        let root = TemporaryDirectory::new();
        let second_root = TemporaryDirectory::new();
        let mut supervisor =
            ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::ContainedProbeOnly);
        let authorization = supervisor
            .authorize(
                verified_runtime(&root.path),
                ManagedRuntimePurpose::ContainedProbeOnly,
                false,
            )
            .expect("issues one permit");
        assert_eq!(
            supervisor.authorize(
                verified_runtime(&second_root.path),
                ManagedRuntimePurpose::ContainedProbeOnly,
                false,
            ),
            Err(SupervisorError::AuthorizationCapacityExceeded)
        );

        fs::write(root.path.join("unexpected"), b"tampered").expect("adds unlisted bundle entry");
        assert!(matches!(
            supervisor.take_authorized_prepared_probe(&authorization, false),
            Err(SupervisorError::ProvenanceRejected)
        ));
        assert!(matches!(
            supervisor.take_authorized_prepared_probe(&authorization, false),
            Err(SupervisorError::AuthorizationConsumed)
        ));
        assert!(
            supervisor
                .authorize(
                    verified_runtime(&second_root.path),
                    ManagedRuntimePurpose::ContainedProbeOnly,
                    false,
                )
                .is_ok()
        );
    }

    #[test]
    fn production_supervisor_retains_no_process_or_handle_surface() {
        let source = include_str!("supervisor.rs");
        let forbidden = [
            ["Command", "::new"].concat(),
            ["sp", "awn("].concat(),
            ["sp", "awn ("].concat(),
            ["sp", "awn_"].concat(),
            ["sp", "awn::"].concat(),
            ["tokio", "::process"].concat(),
            ["std", "::process"].concat(),
            ["std", "::env::var"].concat(),
            ["As", "RawHandle"].concat(),
            ["Into", "RawHandle"].concat(),
            ["Owned", "Handle"].concat(),
            ["Create", "Process"].concat(),
            ["Shell", "Execute"].concat(),
            ["Win", "Exec"].concat(),
            ["Assign", "ProcessToJobObject"].concat(),
            ["Open", "Process"].concat(),
            ["Resume", "Thread"].concat(),
            ["Terminate", "Process"].concat(),
            ["PROCESS", "_INFORMATION"].concat(),
            ["STARTUP", "INFO"].concat(),
            ["WindowsJob", "::assign"].concat(),
            ["WindowsJob", "::resume"].concat(),
            ["WindowsJob", "::force"].concat(),
        ];
        for forbidden in forbidden {
            assert!(
                !source.contains(&forbidden),
                "disabled supervisor must not contain {forbidden}"
            );
        }
    }

    #[test]
    fn public_debug_and_errors_do_not_expose_runtime_paths_or_manifest_content() {
        let root = TemporaryDirectory::new();
        let secret = root.path.to_string_lossy().to_string();
        let runtime = verified_runtime(&root.path);
        assert!(!format!("{runtime:?}").contains(&secret));
        let error = SupervisorError::ProvenanceRejected;
        assert!(!error.to_string().contains(&secret));
        assert!(!format!("{error:?}").contains(&secret));
    }
}
