use super::{
    AssignedBeforeResume, ContainedProcess, ContainmentError, ContainmentKind, ContainmentState,
    ProcessContainment, ShutdownAction, SuspendedProcess,
};
use std::ffi::c_void;
use std::mem;
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, PROCESS_SET_QUOTA, PROCESS_TERMINATE, ResumeThread,
    THREAD_SUSPEND_RESUME,
};

static NEXT_JOB_INSTANCE: AtomicU64 = AtomicU64::new(1);

/// A real Windows Job Object configured with `KILL_ON_JOB_CLOSE`.
///
/// This type intentionally does not launch a process or expose a shell. A future
/// supervisor launches a trusted executable with `CREATE_SUSPENDED`, converts its
/// PID to `SuspendedProcess`, assigns it here, resumes it externally, then records
/// the resume with the returned capability token.
pub struct WindowsJob {
    handle: Option<OwnedHandle>,
    instance: u64,
    state: ContainmentState,
    kill_on_close_confirmed: bool,
}

impl WindowsJob {
    /// Create a Job Object and verify that `KILL_ON_JOB_CLOSE` is active.
    ///
    /// # Errors
    ///
    /// Returns an OS error if creation/configuration/querying fails, or an
    /// invariant error if Windows does not retain `KILL_ON_JOB_CLOSE`.
    pub fn new() -> Result<Self, ContainmentError> {
        let limit_information_size = structure_size::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()?;
        let handle = unsafe {
            // Null security attributes and name create an unnamed, non-inheritable Job Object.
            CreateJobObjectW(ptr::null(), ptr::null())
        };
        if handle.is_null() {
            return Err(last_os_error("CreateJobObjectW"));
        }
        // CreateJobObjectW returned a non-null owned handle. Store it immediately
        // so every configuration failure closes it through OwnedHandle::drop.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };

        let mut limit_information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limit_information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_result = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limit_information).cast::<c_void>(),
                limit_information_size,
            )
        };
        if set_result == 0 {
            return Err(last_os_error("SetInformationJobObject"));
        }

        let mut confirmed_information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let query_result = unsafe {
            QueryInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw mut confirmed_information).cast::<c_void>(),
                limit_information_size,
                ptr::null_mut(),
            )
        };
        if query_result == 0 {
            return Err(last_os_error("QueryInformationJobObject"));
        }

        let kill_on_close_confirmed = (confirmed_information.BasicLimitInformation.LimitFlags
            & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
            != 0;
        if !kill_on_close_confirmed {
            return Err(ContainmentError::InvariantViolation(
                "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
            ));
        }

        Ok(Self {
            handle: Some(handle),
            instance: next_instance(),
            state: ContainmentState::Prepared,
            kill_on_close_confirmed,
        })
    }

    /// Whether the Job Object configuration was read back from Windows.
    #[must_use]
    pub const fn kill_on_close_confirmed(&self) -> bool {
        self.kill_on_close_confirmed
    }

    /// Assign a suspended process to this Job before its primary thread resumes.
    ///
    /// The process must have been created with `CREATE_SUSPENDED` by trusted host
    /// code. The returned token is required to record the later resume, making
    /// assignment-before-resume explicit in the supervisor-facing API.
    ///
    /// # Errors
    ///
    /// Returns an invalid-state error for a reused/closed Job, or an OS error if
    /// the process cannot be opened or assigned.
    pub fn assign_before_resume(
        &mut self,
        process: SuspendedProcess,
    ) -> Result<AssignedBeforeResume, ContainmentError> {
        if self.state != ContainmentState::Prepared {
            return Err(
                if self.state == ContainmentState::AssignedBeforeResume
                    || self.state == ContainmentState::Running
                {
                    ContainmentError::AlreadyAssigned
                } else {
                    ContainmentError::InvalidState {
                        operation: "assign a suspended process",
                        state: self.state,
                    }
                },
            );
        }

        let process_handle = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                0,
                process.process_id().get(),
            )
        };
        if process_handle.is_null() {
            return Err(last_os_error("OpenProcess"));
        }
        let process_handle = unsafe { OwnedHandle::from_raw_handle(process_handle) };
        let assignment_result = unsafe {
            AssignProcessToJobObject(
                self.require_handle("assign a suspended process")?,
                process_handle.as_raw_handle(),
            )
        };
        if assignment_result == 0 {
            return Err(last_os_error("AssignProcessToJobObject"));
        }

        self.state = ContainmentState::AssignedBeforeResume;
        Ok(AssignedBeforeResume {
            process_id: process.process_id(),
            job_instance: self.instance,
        })
    }

    /// Resume the assigned process's initial thread after Job assignment.
    ///
    /// The token can only be obtained from [`Self::assign_before_resume`], so
    /// `AssignProcessToJobObject` necessarily happens before `ResumeThread`.
    ///
    /// # Errors
    ///
    /// Returns an error when the token belongs to another Job, the state is not
    /// assigned-before-resume, or Windows cannot locate/resume the initial thread.
    pub fn resume_assigned(
        &mut self,
        assignment: AssignedBeforeResume,
    ) -> Result<ContainedProcess, ContainmentError> {
        self.validate_assignment(&assignment, "resume assigned process")?;
        let thread_id = suspended_thread_id(assignment.process_id.get())?;
        let thread_handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
        if thread_handle.is_null() {
            return Err(last_os_error("OpenThread"));
        }
        let thread_handle = unsafe { OwnedHandle::from_raw_handle(thread_handle) };
        let previous_suspend_count = unsafe { ResumeThread(thread_handle.as_raw_handle()) };
        if previous_suspend_count == u32::MAX {
            return Err(last_os_error("ResumeThread"));
        }

        self.state = ContainmentState::Running;
        Ok(ContainedProcess {
            process_id: assignment.process_id,
        })
    }

    /// Record that the caller resumed the primary thread after successful assignment.
    ///
    /// This is reserved for a future supervisor that owns a primary thread handle.
    /// Prefer [`Self::resume_assigned`] when only a process ID is available.
    ///
    /// # Errors
    ///
    /// Returns an error when the token belongs to another Job or assignment was
    /// not recorded before the external resume.
    pub fn record_resumed_after_external_resume(
        &mut self,
        assignment: AssignedBeforeResume,
    ) -> Result<ContainedProcess, ContainmentError> {
        self.validate_assignment(&assignment, "record process resume")?;
        self.state = ContainmentState::Running;
        Ok(ContainedProcess {
            process_id: assignment.process_id,
        })
    }

    /// Close the final host Job handle, causing Windows to terminate its owned tree.
    ///
    /// This is containment. It is intentionally distinct from a graceful EOF
    /// request, which owns no descendants and is not represented by this method.
    ///
    /// # Errors
    ///
    /// Returns an invalid-state error when already closed, or an OS error when
    /// Windows rejects the handle close.
    pub fn close(&mut self) -> Result<ShutdownAction, ContainmentError> {
        let handle = self.take_handle("close Job Object")?;
        // IntoRawHandle prevents OwnedHandle from attempting a second close. If
        // CloseHandle fails, reconstruct ownership so Drop can still clean up.
        let raw_handle = handle.into_raw_handle();
        let close_result = unsafe { CloseHandle(raw_handle) };
        if close_result == 0 {
            self.handle = Some(unsafe { OwnedHandle::from_raw_handle(raw_handle) });
            return Err(last_os_error("CloseHandle"));
        }
        self.state = ContainmentState::Closed;
        Ok(ShutdownAction::ContainmentClosed)
    }

    fn validate_assignment(
        &self,
        assignment: &AssignedBeforeResume,
        operation: &'static str,
    ) -> Result<(), ContainmentError> {
        if assignment.job_instance != self.instance {
            return Err(ContainmentError::AssignmentTokenMismatch);
        }
        if self.state != ContainmentState::AssignedBeforeResume {
            return Err(ContainmentError::InvalidState {
                operation,
                state: self.state,
            });
        }
        Ok(())
    }

    fn require_handle(&self, operation: &'static str) -> Result<HANDLE, ContainmentError> {
        self.handle
            .as_ref()
            .map(AsRawHandle::as_raw_handle)
            .ok_or(ContainmentError::InvalidState {
                operation,
                state: self.state,
            })
    }

    fn take_handle(&mut self, operation: &'static str) -> Result<OwnedHandle, ContainmentError> {
        self.handle.take().ok_or(ContainmentError::InvalidState {
            operation,
            state: self.state,
        })
    }
}

impl ProcessContainment for WindowsJob {
    fn kind(&self) -> ContainmentKind {
        ContainmentKind::WindowsJobObject
    }

    fn state(&self) -> ContainmentState {
        self.state
    }

    fn force_terminate_tree(&mut self) -> Result<(), ContainmentError> {
        let handle = self.require_handle("force terminate Job tree")?;
        let terminate_result = unsafe { TerminateJobObject(handle, 1) };
        if terminate_result == 0 {
            return Err(last_os_error("TerminateJobObject"));
        }
        self.state = ContainmentState::TreeTerminated;
        Ok(())
    }
}

fn suspended_thread_id(process_id: u32) -> Result<u32, ContainmentError> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(last_os_error("CreateToolhelp32Snapshot"));
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };

    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(mem::size_of::<THREADENTRY32>())
            .map_err(|_| ContainmentError::StructureTooLarge)?,
        ..THREADENTRY32::default()
    };
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == process_id {
            return Ok(entry.th32ThreadID);
        }
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }

    Err(ContainmentError::InvariantViolation(
        "suspended process must expose an initial thread",
    ))
}

fn structure_size<T>() -> Result<u32, ContainmentError> {
    u32::try_from(mem::size_of::<T>()).map_err(|_| ContainmentError::StructureTooLarge)
}

fn last_os_error(operation: &'static str) -> ContainmentError {
    let code = unsafe { GetLastError() };
    ContainmentError::Os { operation, code }
}

fn assert_send<T: Send>() {}

const _: fn() = assert_send::<WindowsJob>;

fn next_instance() -> u64 {
    let instance = NEXT_JOB_INSTANCE.fetch_add(1, Ordering::Relaxed);
    if instance == 0 {
        NEXT_JOB_INSTANCE.fetch_add(1, Ordering::Relaxed)
    } else {
        instance
    }
}

#[cfg(test)]
mod tests {
    use super::WindowsJob;
    use crate::{ContainmentKind, ContainmentState, ProcessContainment, ShutdownAction};

    #[test]
    fn creates_a_real_job_with_kill_on_close_confirmed() {
        let mut job = WindowsJob::new().expect("Job Object can be created");
        assert!(job.kill_on_close_confirmed());
        assert_eq!(job.kind(), ContainmentKind::WindowsJobObject);
        assert_eq!(job.state(), ContainmentState::Prepared);
        assert_eq!(
            job.close().expect("empty Job Object can be closed"),
            ShutdownAction::ContainmentClosed
        );
        assert_eq!(job.state(), ContainmentState::Closed);
    }

    #[test]
    fn refuses_force_termination_after_job_close() {
        let mut job = WindowsJob::new().expect("Job Object can be created");
        let _ = job.close().expect("empty Job Object can be closed");
        assert!(job.force_terminate_tree().is_err());
    }
}
