//! Static, non-inspecting eligibility for protected system-Pi diagnostics.
//!
//! The current flow deliberately does not read `PATH`, inspect candidates, or
//! touch the filesystem. A future managed-runtime provenance verifier must be a
//! separate, explicitly reviewed path before any candidate can be classified.

/// Sanitized static classification of a potential system Pi installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemPiPathEligibility {
    /// Reserved for a future separately verified managed-runtime provenance
    /// flow. The current static eligibility flow never returns this variant.
    CandidateUnverified,
    /// No verified managed runtime provenance exists for diagnostic execution.
    ManagedRuntimeRequired,
}

/// Returns the current static system-Pi eligibility.
///
/// Despite its historical name, this function does not read or iterate `PATH`,
/// resolve a candidate, or access the filesystem. It always requires a verified
/// managed runtime.
#[must_use]
pub const fn classify_system_pi_candidate_from_path() -> SystemPiPathEligibility {
    SystemPiPathEligibility::ManagedRuntimeRequired
}

#[cfg(test)]
mod tests {
    use super::{SystemPiPathEligibility, classify_system_pi_candidate_from_path};

    #[test]
    fn current_static_flow_always_requires_a_managed_runtime() {
        assert_eq!(
            classify_system_pi_candidate_from_path(),
            SystemPiPathEligibility::ManagedRuntimeRequired
        );
    }

    #[test]
    fn current_static_flow_never_classifies_a_path_candidate() {
        assert_ne!(
            classify_system_pi_candidate_from_path(),
            SystemPiPathEligibility::CandidateUnverified
        );
    }

    #[test]
    fn eligibility_module_has_no_path_or_filesystem_inspection_surface() {
        let source = include_str!("system_pi_probe.rs");
        let forbidden = [
            ["std::en", "v"].concat(),
            ["std::f", "s"].concat(),
            ["split_", "paths"].concat(),
            ["symlink_", "metadata"].concat(),
            ["vars_", "os"].concat(),
            ["Path", "Buf"].concat(),
            ["Os", "String"].concat(),
            ["Os", "Str"].concat(),
        ];
        for forbidden in forbidden {
            assert!(
                !source.contains(&forbidden),
                "static eligibility module must not contain {forbidden}"
            );
        }
    }
}
