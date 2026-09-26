//! OS-facing primitives used by trusted host code only.
//!
//! This crate deliberately has no shell launcher, frontend API, session format,
//! or session-writing capability. It exposes only canonical project-directory,
//! static eligibility, process-containment, project-watch and project file
//! name listing building blocks.

#![forbid(unsafe_op_in_unsafe_fn)]

mod containment;
#[cfg(windows)]
mod file_links;
mod project_directory;
mod project_files;
mod project_watch;
#[cfg(windows)]
mod system_pi_probe;
#[cfg(windows)]
mod windows_stable_file_lease;

pub use containment::{
    ContainmentError, ContainmentKind, ContainmentState, ProcessContainment, ProcessId,
    ShutdownAction,
};
pub use project_directory::{
    ProjectDirectory, ProjectDirectoryError, ProjectDirectoryIdentity,
    ProjectDirectoryIdentityToken,
};
pub use project_files::{
    MAX_FILE_QUERY_CHARS, MAX_PROJECT_FILES, ProjectFileListing, ProjectFilesError,
    list_project_files,
};
pub use project_watch::{
    ChangeBatch, IGNORED_DIRECTORY_NAMES, MAX_BATCH_PATHS, ProjectWatch, ProjectWatchError,
    is_ignored_path, relative_change_path, watch_project,
};

#[cfg(unix)]
pub use containment::{ProcessGroupId, UnixProcessGroup};

#[cfg(windows)]
pub use containment::{AssignedBeforeResume, ContainedProcess, SuspendedProcess, WindowsJob};
#[cfg(windows)]
pub use file_links::windows_file_link_count;
#[cfg(windows)]
pub use system_pi_probe::{SystemPiPathEligibility, classify_system_pi_candidate_from_path};
#[cfg(windows)]
pub use windows_stable_file_lease::{WindowsStableFileLease, WindowsStableFileLeaseError};
