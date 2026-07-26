use super::{
    ContainmentError, ContainmentKind, ContainmentState, ProcessContainment, ProcessGroupId,
};

/// Unix process-group containment design boundary.
///
/// A future supervisor must create a dedicated process group before the runtime
/// can execute tools, then register that group here. This foundation crate does
/// not spawn processes or send signals yet; returning `Unsupported` is safer than
/// pretending that EOF or a parent PID controls descendants.
pub struct UnixProcessGroup {
    group_id: ProcessGroupId,
    state: ContainmentState,
}

impl UnixProcessGroup {
    /// Register a dedicated process group created by trusted supervisor code.
    #[must_use]
    pub const fn from_spawned_group(group_id: ProcessGroupId) -> Self {
        Self {
            group_id,
            state: ContainmentState::Running,
        }
    }

    /// The dedicated process group intended to own the runtime descendants.
    #[must_use]
    pub const fn group_id(&self) -> ProcessGroupId {
        self.group_id
    }

    /// Mark this non-owning design stub as discarded after supervisor cleanup.
    ///
    /// This does not signal the group and therefore is not containment.
    pub fn discard_after_supervisor_cleanup(&mut self) {
        self.state = ContainmentState::Closed;
    }
}

impl ProcessContainment for UnixProcessGroup {
    fn kind(&self) -> ContainmentKind {
        ContainmentKind::UnixProcessGroup
    }

    fn state(&self) -> ContainmentState {
        self.state
    }

    fn force_terminate_tree(&mut self) -> Result<(), ContainmentError> {
        Err(ContainmentError::Unsupported {
            kind: self.kind(),
            operation: "force terminate Unix process group",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::UnixProcessGroup;
    use crate::{ContainmentKind, ContainmentState, ProcessContainment, ProcessGroupId};

    #[test]
    fn unix_stub_never_claims_to_terminate_a_group() {
        let group = ProcessGroupId::new(42).expect("positive group ID");
        let mut containment = UnixProcessGroup::from_spawned_group(group);

        assert_eq!(containment.kind(), ContainmentKind::UnixProcessGroup);
        assert_eq!(containment.state(), ContainmentState::Running);
        assert!(containment.force_terminate_tree().is_err());
        assert_eq!(containment.state(), ContainmentState::Running);
        containment.discard_after_supervisor_cleanup();
        assert_eq!(containment.state(), ContainmentState::Closed);
    }
}
