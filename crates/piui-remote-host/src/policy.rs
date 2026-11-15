//! What a paired controller may do on this target.
//!
//! Authority comes only from a grant this target recorded after pairing,
//! used on a channel authenticated by the grant's pinned controller key, for
//! the account and host the target is signed in and registered as, while the
//! owner keeps remote execution enabled. An OAuth device identifier, a server
//! record or an observing (pairing) channel is never enough.
//! [`authorize`] checks all of that and is the only way to obtain an
//! [`AuthorizedController`]; the command journal admits nothing without one.
//!
//! The owner's remote policy is a set of selected projects, each still
//! trusted at the moment of admission, and a permission ceiling per harness.
//! A ceiling compares with a request exactly as `spawn_permissions_subset`
//! of `piui-orchestration` compares a child profile with its parent's file
//! permissions and network access (`validation.rs`, the `files` and network
//! checks). Native permissions compare only with Native of the same harness;
//! everything else involving Native is incomparable. A ceiling is a request
//! to the native harness, not a sandbox.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

use crate::identity::Spki;
use crate::ids::{AccountId, DeviceId, GrantId, HostId};
use crate::pairing::VerifiedController;
use crate::tls::{ChannelEndpoints, ChannelRole, PeerKeyStatus};

/// A native bridge permission preset, with the serialized names of
/// `piui_orchestration::PermissionMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Native,
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}

/// File permissions and network access, as a ceiling or as a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    pub permission_mode: PermissionMode,
    pub network_access: bool,
}

macro_rules! opaque_text {
    ($(#[$meta:meta])* $name:ident, $what:literal) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            /// # Errors
            /// [`PolicyError::Text`] for an empty value or a control character.
            pub fn new(value: &str) -> Result<Self, PolicyError> {
                if value.is_empty() || value.chars().any(char::is_control) {
                    return Err(PolicyError::Text { what: $what });
                }
                Ok(Self(value.to_owned()))
            }

            /// The text.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                Self::new(&value).map_err(serde::de::Error::custom)
            }
        }
    };
}

opaque_text!(
    /// A harness identity as the host's typed harness prints it (`codex`,
    /// `acp:gemini-cli`, ...). Compared exactly; the grammar belongs to the
    /// host.
    HarnessId,
    "harness"
);

opaque_text!(
    /// A local project identifier, compared exactly.
    ProjectId,
    "project"
);

/// A malformed policy value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum PolicyError {
    #[error("the {what} identifier is empty or contains a control character")]
    Text { what: &'static str },
}

/// Why a ceiling does not cover a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum CeilingRefusal {
    /// Native on one side only, or Native of another harness.
    #[error("the permissions are not comparable with the ceiling")]
    Incomparable,
    /// More file permission or network access than the ceiling.
    #[error("the permissions exceed the ceiling")]
    Exceeded,
}

/// Whether `requested` for `harness` stays within `ceiling` for
/// `ceiling_harness`: the file and network rule of
/// `spawn_permissions_subset`.
///
/// # Errors
/// [`CeilingRefusal`] when it does not.
pub fn within_ceiling(
    ceiling_harness: &HarnessId,
    ceiling: Permissions,
    harness: &HarnessId,
    requested: Permissions,
) -> Result<(), CeilingRefusal> {
    use PermissionMode::{FullAccess, Native, ReadOnly, WorkspaceWrite};
    let files = match (ceiling.permission_mode, requested.permission_mode) {
        (Native, Native) if ceiling_harness == harness => true,
        (Native, _) | (_, Native) => return Err(CeilingRefusal::Incomparable),
        (FullAccess, ReadOnly | WorkspaceWrite | FullAccess)
        | (WorkspaceWrite, ReadOnly | WorkspaceWrite)
        | (ReadOnly, ReadOnly) => true,
        _ => false,
    };
    if !files || (requested.network_access && !ceiling.network_access) {
        return Err(CeilingRefusal::Exceeded);
    }
    Ok(())
}

/// The lifecycle of a grant on the target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GrantState {
    /// Stored after pairing; the server registration is not confirmed yet.
    PendingRegistration,
    /// Registered and usable.
    Active,
    /// Revocation started; it completes even after a restart.
    Revoking,
}

/// The target's durable record of one paired controller.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantRecord {
    pub grant_id: GrantId,
    pub state: GrantState,
    pub account_id: AccountId,
    pub host_id: HostId,
    pub controller_device_id: DeviceId,
    /// The controller key verified at pairing: the pin of every channel.
    pub controller_spki: Spki,
}

impl GrantRecord {
    /// The record to store before registering the grant.
    #[must_use]
    pub fn pending(verified: &VerifiedController) -> Self {
        Self {
            grant_id: verified.grant_id.clone(),
            state: GrantState::PendingRegistration,
            account_id: verified.identity.account_id.clone(),
            host_id: verified.identity.host_id.clone(),
            controller_device_id: verified.identity.controller_device_id.clone(),
            controller_spki: verified.controller_spki.clone(),
        }
    }
}

/// Who this target is now: its signed-in account and its host registration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalBinding {
    pub account_id: AccountId,
    pub host_id: HostId,
}

/// The owner's remote policy on this target.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPolicy {
    /// Remote execution is enabled on this computer.
    pub enabled: bool,
    /// The projects a controller may use; each must still be trusted.
    pub allowed_projects: BTreeSet<ProjectId>,
    /// The ceiling of each harness a controller may use.
    pub ceilings: BTreeMap<HarnessId, Permissions>,
}

/// Whether a project is trusted right now, from the host's own live check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectTrust {
    Trusted,
    NotTrusted,
}

/// Why a controller's request is refused. Nothing is journaled for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Error)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyRefusal {
    #[error("remote execution is disabled on this computer")]
    HostDisabled,
    #[error("the channel is not a pinned target channel")]
    ChannelNotPinned,
    #[error("the channel key differs from the grant's pin")]
    PeerKeyChanged,
    #[error("the grant is not active")]
    GrantInactive,
    #[error("the grant belongs to another account")]
    AccountMismatch,
    #[error("the grant belongs to another host registration")]
    HostMismatch,
    #[error("the project is not selected for remote use")]
    ProjectNotAllowed,
    #[error("the project is no longer trusted")]
    ProjectNotTrusted,
    #[error("the harness has no remote ceiling")]
    HarnessNotAllowed,
    #[error("the permissions are not comparable with the ceiling")]
    CeilingIncomparable,
    #[error("the permissions exceed the ceiling")]
    CeilingExceeded,
}

/// Proof that one request comes from an active grant over its pinned
/// channel. Obtain a new one for every command: it is neither `Clone` nor
/// stored, and the journal consumes it.
#[derive(Debug, PartialEq, Eq)]
pub struct AuthorizedController {
    grant_id: GrantId,
    controller_device_id: DeviceId,
}

impl AuthorizedController {
    /// The grant the request came through.
    #[must_use]
    pub fn grant_id(&self) -> &GrantId {
        &self.grant_id
    }

    /// The controller's device, for display only.
    #[must_use]
    pub fn controller_device_id(&self) -> &DeviceId {
        &self.controller_device_id
    }

    /// Admits a project: selected by the owner and trusted right now.
    ///
    /// # Errors
    /// [`PolicyRefusal::ProjectNotAllowed`] or
    /// [`PolicyRefusal::ProjectNotTrusted`].
    pub fn admit_project(
        &self,
        policy: &HostPolicy,
        project: &ProjectId,
        trust: ProjectTrust,
    ) -> Result<(), PolicyRefusal> {
        if !policy.allowed_projects.contains(project) {
            return Err(PolicyRefusal::ProjectNotAllowed);
        }
        if trust != ProjectTrust::Trusted {
            return Err(PolicyRefusal::ProjectNotTrusted);
        }
        Ok(())
    }

    /// Admits the permissions of a session or a pipeline profile.
    ///
    /// # Errors
    /// [`PolicyRefusal::HarnessNotAllowed`],
    /// [`PolicyRefusal::CeilingIncomparable`] or
    /// [`PolicyRefusal::CeilingExceeded`].
    pub fn admit_permissions(
        &self,
        policy: &HostPolicy,
        harness: &HarnessId,
        requested: Permissions,
    ) -> Result<(), PolicyRefusal> {
        let ceiling = policy
            .ceilings
            .get(harness)
            .ok_or(PolicyRefusal::HarnessNotAllowed)?;
        within_ceiling(harness, *ceiling, harness, requested).map_err(|refusal| match refusal {
            CeilingRefusal::Incomparable => PolicyRefusal::CeilingIncomparable,
            CeilingRefusal::Exceeded => PolicyRefusal::CeilingExceeded,
        })
    }
}

/// Authorizes one request that arrived on `channel` for `grant`.
///
/// # Errors
/// The first failing [`PolicyRefusal`].
pub fn authorize(
    binding: &LocalBinding,
    policy: &HostPolicy,
    grant: &GrantRecord,
    channel: &ChannelEndpoints,
) -> Result<AuthorizedController, PolicyRefusal> {
    if !policy.enabled {
        return Err(PolicyRefusal::HostDisabled);
    }
    if channel.role != ChannelRole::Target || channel.peer_key != PeerKeyStatus::Pinned {
        return Err(PolicyRefusal::ChannelNotPinned);
    }
    if channel.peer_spki != grant.controller_spki {
        return Err(PolicyRefusal::PeerKeyChanged);
    }
    if grant.state != GrantState::Active {
        return Err(PolicyRefusal::GrantInactive);
    }
    if grant.account_id != binding.account_id {
        return Err(PolicyRefusal::AccountMismatch);
    }
    if grant.host_id != binding.host_id {
        return Err(PolicyRefusal::HostMismatch);
    }
    Ok(AuthorizedController {
        grant_id: grant.grant_id.clone(),
        controller_device_id: grant.controller_device_id.clone(),
    })
}

#[cfg(test)]
pub(crate) fn authorized_for_tests(grant_id: GrantId) -> AuthorizedController {
    AuthorizedController {
        grant_id,
        controller_device_id: DeviceId::parse("dev_AAECAwQFBgcICQoLDA0ODw").expect("device"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use PermissionMode::{FullAccess, Native, ReadOnly, WorkspaceWrite};

    fn harness(name: &str) -> HarnessId {
        HarnessId::new(name).expect("harness")
    }

    fn permissions(permission_mode: PermissionMode, network_access: bool) -> Permissions {
        Permissions {
            permission_mode,
            network_access,
        }
    }

    /// The `files` match and the network check of `spawn_permissions_subset`
    /// as a truth table (the parent is the ceiling, the child the request).
    #[test]
    fn ceilings_compare_like_the_orchestration_subset_rule() {
        let modes = [Native, ReadOnly, WorkspaceWrite, FullAccess];
        let codex = harness("codex");
        let pi = harness("pi");
        for ceiling in modes {
            for requested in modes {
                for (ceiling_network, requested_network) in
                    [(false, false), (false, true), (true, false), (true, true)]
                {
                    for other in [&codex, &pi] {
                        let files = match (ceiling, requested) {
                            (Native, Native) => other == &codex,
                            (FullAccess, ReadOnly | WorkspaceWrite | FullAccess) => true,
                            (WorkspaceWrite, ReadOnly | WorkspaceWrite) => true,
                            (ReadOnly, ReadOnly) => true,
                            _ => false,
                        };
                        let expected = files && (ceiling_network || !requested_network);
                        let result = within_ceiling(
                            &codex,
                            permissions(ceiling, ceiling_network),
                            other,
                            permissions(requested, requested_network),
                        );
                        assert_eq!(
                            result.is_ok(),
                            expected,
                            "{ceiling:?}/{requested:?}/{ceiling_network}/{requested_network}/{other:?}"
                        );
                        if matches!(ceiling, Native) != matches!(requested, Native) {
                            assert_eq!(result, Err(CeilingRefusal::Incomparable));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn permission_modes_use_the_orchestration_names() {
        let encoded =
            serde_json::to_string(&[Native, ReadOnly, WorkspaceWrite, FullAccess]).expect("json");
        assert_eq!(
            encoded,
            r#"["native","read-only","workspace-write","full-access"]"#
        );
    }

    #[test]
    fn opaque_identifiers_refuse_empty_and_control_text() {
        assert!(ProjectId::new("prj-1").is_ok());
        assert_eq!(
            ProjectId::new(""),
            Err(PolicyError::Text { what: "project" })
        );
        assert_eq!(
            HarnessId::new("co\u{7}dex"),
            Err(PolicyError::Text { what: "harness" })
        );
    }
}
