//! Static eligibility for protected system-Pi diagnostics.
//!
//! `PATH` is not executable provenance. This module does not read `PATH`,
//! inspect a candidate, or touch the filesystem. A future managed runtime must
//! provide separately verified provenance before any diagnostic execution is
//! considered.

use serde::Serialize;

/// Sanitized static eligibility for system-Pi diagnostics.
///
/// This deliberately contains no executable path, file hash, authentication
/// state, environment value, stderr, session data, or RPC payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemPiDiagnosticEligibility {
    /// Reserved for a future separately verified managed-runtime provenance
    /// flow. The current reachable diagnostic flow never returns this variant.
    CandidateUnverified,
    /// No verified managed runtime provenance exists for diagnostic execution.
    ManagedRuntimeRequired,
}

impl SystemPiDiagnosticEligibility {
    /// Whether a future verified managed-runtime flow is required before Pi can
    /// be launched for diagnostics.
    #[must_use]
    pub const fn requires_managed_runtime(self) -> bool {
        true
    }
}

/// Performs static, non-executing system-Pi eligibility classification.
///
/// The historical name is retained temporarily for host integration, but this
/// function does not probe a Pi process, read `PATH`, or inspect the filesystem.
/// It always returns [`SystemPiDiagnosticEligibility::ManagedRuntimeRequired`]
/// until a separately verified managed-runtime provenance flow exists.
#[must_use]
pub fn probe_system_pi() -> SystemPiDiagnosticEligibility {
    platform_eligibility()
}

#[cfg(windows)]
fn platform_eligibility() -> SystemPiDiagnosticEligibility {
    platform_eligibility_from(piui_platform::classify_system_pi_candidate_from_path())
}

#[cfg(not(windows))]
const fn platform_eligibility() -> SystemPiDiagnosticEligibility {
    SystemPiDiagnosticEligibility::ManagedRuntimeRequired
}

#[cfg(windows)]
fn platform_eligibility_from(
    eligibility: piui_platform::SystemPiPathEligibility,
) -> SystemPiDiagnosticEligibility {
    // Do not surface a candidate state through the reachable diagnostic path,
    // even if a future platform enum gains another source of classification.
    match eligibility {
        piui_platform::SystemPiPathEligibility::CandidateUnverified
        | piui_platform::SystemPiPathEligibility::ManagedRuntimeRequired => {
            SystemPiDiagnosticEligibility::ManagedRuntimeRequired
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SystemPiDiagnosticEligibility;

    #[test]
    fn eligibility_is_payload_free_in_public_views() {
        const SECRET: &str = "PATH_CANDIDATE_SECRET_3b4e4e7c";
        for eligibility in [
            SystemPiDiagnosticEligibility::CandidateUnverified,
            SystemPiDiagnosticEligibility::ManagedRuntimeRequired,
        ] {
            let debug = format!("{eligibility:?}");
            let serialized = serde_json::to_string(&eligibility).expect("serializable eligibility");
            assert!(!debug.contains(SECRET));
            assert!(!serialized.contains(SECRET));
            assert!(!debug.contains("path"));
            assert!(!serialized.contains("path"));
            assert!(eligibility.requires_managed_runtime());
        }
    }

    #[cfg(windows)]
    #[test]
    fn unverified_platform_state_is_normalized_to_managed_runtime_required() {
        assert_eq!(
            super::platform_eligibility_from(
                piui_platform::SystemPiPathEligibility::CandidateUnverified
            ),
            SystemPiDiagnosticEligibility::ManagedRuntimeRequired
        );
    }

    #[cfg(windows)]
    #[test]
    fn current_windows_flow_never_returns_candidate_unverified() {
        assert_eq!(
            super::probe_system_pi(),
            SystemPiDiagnosticEligibility::ManagedRuntimeRequired
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_always_requires_a_managed_runtime() {
        assert_eq!(
            super::probe_system_pi(),
            SystemPiDiagnosticEligibility::ManagedRuntimeRequired
        );
    }

    /// Replaces the former ignored live-Pi test: the reachable runtime module
    /// must not retain any process-launch or RPC execution surface.
    #[test]
    fn probe_module_has_no_live_execution_surface() {
        let source = include_str!("system_probe.rs");
        let forbidden = [
            ["Command", "::new"].concat(),
            [".sp", "awn("].concat(),
            ["FixedSystemPi", "ProbeProcess"].concat(),
            ["Rpc", "Codec"].concat(),
            ["std::pro", "cess::"].concat(),
        ];
        for forbidden in forbidden {
            assert!(
                !source.contains(&forbidden),
                "static eligibility module must not contain {forbidden}"
            );
        }
    }
}
