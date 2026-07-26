use std::error::Error;
use std::fmt;
use std::num::NonZeroU32;

#[cfg(unix)]
use std::num::NonZeroI32;

#[cfg(unix)]
mod unix_process_group;
#[cfg(windows)]
mod windows_job;

#[cfg(unix)]
pub use unix_process_group::UnixProcessGroup;
#[cfg(windows)]
pub use windows_job::WindowsJob;

/// A validated operating-system process identifier.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash)]
pub struct ProcessId(NonZeroU32);

impl ProcessId {
    /// Construct a process identifier. PID zero is not a process that `PiUI` owns.
    ///
    /// # Errors
    ///
    /// Returns [`ContainmentError::InvalidProcessId`] for PID zero.
    pub fn new(value: u32) -> Result<Self, ContainmentError> {
        NonZeroU32::new(value)
            .map(Self)
            .ok_or(ContainmentError::InvalidProcessId)
    }

    /// The native process identifier.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0.get()
    }
}

/// A process group identifier for the Unix containment design branch.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash)]
pub struct ProcessGroupId(NonZeroI32);

#[cfg(unix)]
impl ProcessGroupId {
    /// Construct a positive process-group identifier.
    ///
    /// # Errors
    ///
    /// Returns [`ContainmentError::InvalidProcessGroupId`] for a non-positive ID.
    pub fn new(value: i32) -> Result<Self, ContainmentError> {
        if value <= 0 {
            return Err(ContainmentError::InvalidProcessGroupId);
        }
        NonZeroI32::new(value)
            .map(Self)
            .ok_or(ContainmentError::InvalidProcessGroupId)
    }

    /// The native process-group identifier.
    #[must_use]
    pub const fn get(self) -> i32 {
        self.0.get()
    }
}

/// The OS primitive responsible for forceful descendant cleanup.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ContainmentKind {
    /// Windows Job Object with `KILL_ON_JOB_CLOSE`.
    WindowsJobObject,
    /// Unix process-group design branch.
    UnixProcessGroup,
}

/// Lifecycle state of a containment primitive.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ContainmentState {
    /// The primitive is configured but has not accepted an owned process/group.
    Prepared,
    /// A Windows process was assigned while its primary thread is still suspended.
    AssignedBeforeResume,
    /// The process or process group is running under the primitive.
    Running,
    /// A forceful tree termination was requested.
    TreeTerminated,
    /// The containment handle was closed or the stub was discarded.
    Closed,
}

/// Shutdown events deliberately distinguish graceful EOF from containment.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ShutdownAction {
    /// Stdin was closed to request graceful runtime shutdown. This owns no process tree.
    GracefulEofRequested,
    /// A containment handle was closed, such as a Windows Job Object handle.
    ContainmentClosed,
    /// A host force-terminated an owned tree/group.
    TreeTerminationRequested,
}

impl ShutdownAction {
    /// Whether the action is a host-side descendant-containment operation.
    #[must_use]
    pub const fn is_containment(self) -> bool {
        matches!(
            self,
            Self::ContainmentClosed | Self::TreeTerminationRequested
        )
    }
}

/// Errors returned by containment primitives.
#[derive(Debug)]
pub enum ContainmentError {
    /// PID zero is invalid for an owned process.
    InvalidProcessId,
    /// A Unix process-group ID must be positive.
    #[cfg(unix)]
    InvalidProcessGroupId,
    /// A process has already been assigned to this single-runtime primitive.
    AlreadyAssigned,
    /// An operation is impossible from the current containment state.
    InvalidState {
        operation: &'static str,
        state: ContainmentState,
    },
    /// A resume token was produced by a different Job Object.
    AssignmentTokenMismatch,
    /// An operating-system API failed without exposing command, environment, or payload data.
    Os { operation: &'static str, code: u32 },
    /// The platform branch intentionally has no implementation for this operation yet.
    Unsupported {
        kind: ContainmentKind,
        operation: &'static str,
    },
    /// An API structure cannot be represented in a Windows `u32` byte length.
    StructureTooLarge,
    /// A required containment invariant was not confirmed by the operating system.
    InvariantViolation(&'static str),
}

impl fmt::Display for ContainmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProcessId => formatter.write_str("owned process ID must be non-zero"),
            #[cfg(unix)]
            Self::InvalidProcessGroupId => {
                formatter.write_str("Unix process-group ID must be positive")
            }
            Self::AlreadyAssigned => {
                formatter.write_str("containment already has an assigned process")
            }
            Self::InvalidState { operation, state } => {
                write!(
                    formatter,
                    "cannot {operation} while containment is {state:?}"
                )
            }
            Self::AssignmentTokenMismatch => {
                formatter.write_str("assignment token belongs to a different containment instance")
            }
            Self::Os { operation, code } => {
                write!(formatter, "OS operation {operation} failed ({code})")
            }
            Self::Unsupported { kind, operation } => {
                write!(formatter, "{operation} is unsupported for {kind:?}")
            }
            Self::StructureTooLarge => formatter.write_str("OS structure length exceeds u32"),
            Self::InvariantViolation(invariant) => {
                write!(formatter, "containment invariant failed: {invariant}")
            }
        }
    }
}

impl Error for ContainmentError {}

/// The narrow host-side interface used by a future process supervisor.
///
/// There is intentionally no shell, command string, stdout, stdin, or EOF API
/// here. EOF is a graceful runtime request represented by `ShutdownAction` and
/// cannot be mistaken for descendant containment.
pub trait ProcessContainment {
    /// The platform primitive backing this containment instance.
    fn kind(&self) -> ContainmentKind;

    /// Current lifecycle state.
    fn state(&self) -> ContainmentState;

    /// Forcefully terminate only descendants owned by this primitive.
    ///
    /// # Errors
    ///
    /// Returns an OS error, invalid-state error, or an explicit unsupported error
    /// when the platform branch has no verified force-termination implementation.
    fn force_terminate_tree(&mut self) -> Result<(), ContainmentError>;
}

/// A process that a future Windows supervisor created with `CREATE_SUSPENDED`.
///
/// This type is a typestate declaration, not a process launcher. The caller must
/// not resume the primary thread until `WindowsJob::assign_before_resume` returns
/// an `AssignedBeforeResume` token.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct SuspendedProcess {
    process_id: ProcessId,
}

#[cfg(windows)]
impl SuspendedProcess {
    /// Record a process created suspended by trusted host code.
    #[must_use]
    pub const fn from_created_suspended(process_id: ProcessId) -> Self {
        Self { process_id }
    }

    /// The process that must be assigned before its primary thread resumes.
    #[must_use]
    pub const fn process_id(self) -> ProcessId {
        self.process_id
    }
}

/// Capability proving that a Windows Job accepted the process before resume.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct AssignedBeforeResume {
    process_id: ProcessId,
    job_instance: u64,
}

/// A process recorded as running after an `AssignedBeforeResume` capability.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct ContainedProcess {
    process_id: ProcessId,
}

#[cfg(windows)]
impl ContainedProcess {
    /// The process known to be in the Job before it was resumed.
    #[must_use]
    pub const fn process_id(self) -> ProcessId {
        self.process_id
    }
}

#[cfg(test)]
mod tests {
    use super::{ContainmentError, ProcessId, ShutdownAction};

    #[test]
    fn eof_is_not_containment() {
        assert!(!ShutdownAction::GracefulEofRequested.is_containment());
        assert!(ShutdownAction::ContainmentClosed.is_containment());
        assert!(ShutdownAction::TreeTerminationRequested.is_containment());
    }

    #[test]
    fn rejects_process_zero() {
        assert!(matches!(
            ProcessId::new(0),
            Err(ContainmentError::InvalidProcessId)
        ));
    }
}
