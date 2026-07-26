//! Safe Windows link-count inspection for already-open files.
//!
//! This exposes no path, process, shell, or filesystem traversal API. It is
//! used by the managed-runtime verifier to reject an executable bundle entry
//! that is writable through an alias outside the managed bundle.

use std::fs::File;
use std::mem::MaybeUninit;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
};

/// Reads the native hard-link count for an already-open file handle.
///
/// The caller owns the handle and must fail closed if this query fails.
pub fn windows_file_link_count(file: &File) -> std::io::Result<u32> {
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe {
        GetFileInformationByHandle(file.as_raw_handle() as HANDLE, information.as_mut_ptr())
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    Ok(information.nNumberOfLinks)
}
