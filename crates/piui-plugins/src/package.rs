//! Reading and checking a whole plugin package: a folder or a `.zip`.
//!
//! Every file is read into memory within the package limits, every path is
//! checked (no links or reparse points, no `..`, no reserved Windows names,
//! no case-insensitive duplicates), the manifest and every file it names are
//! validated, templates must be portable system files v4, and the package
//! gets a code hash over all paths and contents. Nothing here executes a
//! file; writing is limited to a fresh destination folder.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::manifest::{MANIFEST_FILE, Problem, ProblemCode, ValidatedManifest, parse_manifest};
use crate::zip::{ZipLimits, read_zip};

/// Package limits (`PLUGIN_LIMITS` in `contracts/piui-plugin-v1.ts`).
pub const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_FILES: usize = 2000;
pub const MAX_PATH_DEPTH: usize = 16;
pub const MAX_TEMPLATE_BYTES: usize = 1024 * 1024;
/// A `.zip` larger than this is refused before it is read.
pub const MAX_ARCHIVE_BYTES: u64 = 24 * 1024 * 1024;
const MAX_PATH_CHARS: usize = 400;
/// Version-control folders are never part of a package.
const SKIPPED_DIRECTORIES: &[&str] = &[".git", ".hg", ".svn"];

/// One file of a package, by its `/`-separated path inside the package.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// A package whose manifest and files passed every rule.
#[derive(Clone, Debug)]
pub struct ValidatedPackage {
    pub manifest: ValidatedManifest,
    pub files: Vec<PackageFile>,
    /// SHA-256 (hex) over every path and content, see [`code_hash`].
    pub code_hash: String,
    pub bytes: u64,
}

impl ValidatedPackage {
    #[must_use]
    pub fn file(&self, path: &str) -> Option<&[u8]> {
        self.files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.bytes.as_slice())
    }
}

fn problem(code: ProblemCode, message: &'static str) -> Vec<Problem> {
    vec![Problem::new(code, message)]
}

const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A package path every platform can store and serve unchanged.
#[must_use]
pub fn safe_package_path(path: &str) -> bool {
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS || path.starts_with('/') {
        return false;
    }
    let segments = path.split('/').collect::<Vec<_>>();
    segments.len() <= MAX_PATH_DEPTH
        && segments.iter().all(|segment| {
            let stem = segment
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && segment.len() <= 255
                && !segment.ends_with('.')
                && !segment.ends_with(' ')
                && !segment.chars().any(|character| {
                    character.is_control()
                        || matches!(character, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                })
                && !WINDOWS_RESERVED.contains(&stem.as_str())
        })
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

/// Reads every file under `root` within the package limits. Links and
/// reparse points are refused, never followed.
pub fn read_folder(root: &Path) -> Result<Vec<PackageFile>, Vec<Problem>> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| problem(ProblemCode::NotAPackage, "The folder could not be read."))?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err(problem(
            ProblemCode::NotAPackage,
            "Choose the plugin's folder itself, not a link to it.",
        ));
    }
    let mut files = Vec::new();
    let mut total = 0_u64;
    let mut pending = vec![(root.to_path_buf(), String::new(), 0_usize)];
    while let Some((directory, prefix, depth)) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|_| problem(ProblemCode::NotAPackage, "The folder could not be read."))?;
        let mut names = entries
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| problem(ProblemCode::NotAPackage, "The folder could not be read."))?;
        names.sort();
        for name in names {
            let Some(name) = name.to_str().map(str::to_owned) else {
                return Err(vec![Problem::about(
                    ProblemCode::Path,
                    "The package path “{0}” is not allowed.",
                    format!("{prefix}{}", name.to_string_lossy()),
                )]);
            };
            let relative = format!("{prefix}{name}");
            let path = directory.join(&name);
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| problem(ProblemCode::NotAPackage, "The folder could not be read."))?;
            if is_link(&metadata) {
                return Err(vec![Problem::about(
                    ProblemCode::Path,
                    "The package contains a link or junction: {0}.",
                    relative,
                )]);
            }
            if metadata.is_dir() {
                if SKIPPED_DIRECTORIES.contains(&name.as_str()) {
                    continue;
                }
                if depth + 1 >= MAX_PATH_DEPTH {
                    return Err(vec![Problem::about(
                        ProblemCode::Path,
                        "The package path “{0}” is not allowed.",
                        relative,
                    )]);
                }
                pending.push((path, format!("{relative}/"), depth + 1));
                continue;
            }
            if !metadata.is_file() {
                return Err(vec![Problem::about(
                    ProblemCode::Path,
                    "The package path “{0}” is not allowed.",
                    relative,
                )]);
            }
            if files.len() >= MAX_FILES {
                return Err(problem(
                    ProblemCode::PackageTooLarge,
                    "The package has more than 2000 files.",
                ));
            }
            if metadata.len() > MAX_FILE_BYTES {
                return Err(problem(
                    ProblemCode::PackageTooLarge,
                    "The package is larger than 20 MiB or a file is larger than 8 MiB.",
                ));
            }
            total = total.saturating_add(metadata.len());
            if total > MAX_PACKAGE_BYTES {
                return Err(problem(
                    ProblemCode::PackageTooLarge,
                    "The package is larger than 20 MiB or a file is larger than 8 MiB.",
                ));
            }
            let bytes = read_bounded(&path, MAX_FILE_BYTES)
                .map_err(|_| problem(ProblemCode::NotAPackage, "The folder could not be read."))?;
            files.push(PackageFile {
                path: relative,
                bytes,
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn read_bounded(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    use std::io::Read as _;
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(io::Error::other("file grew beyond the limit"));
    }
    Ok(bytes)
}

/// Reads a `.zip` package from `path`.
pub fn read_archive(path: &Path) -> Result<Vec<PackageFile>, Vec<Problem>> {
    let metadata = fs::metadata(path).map_err(|_| {
        problem(
            ProblemCode::Archive,
            "The file is not a readable .zip archive.",
        )
    })?;
    if !metadata.is_file() {
        return Err(problem(
            ProblemCode::Archive,
            "The file is not a readable .zip archive.",
        ));
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(problem(
            ProblemCode::PackageTooLarge,
            "The package is larger than 20 MiB or a file is larger than 8 MiB.",
        ));
    }
    let bytes = read_bounded(path, MAX_ARCHIVE_BYTES).map_err(|_| {
        problem(
            ProblemCode::Archive,
            "The file is not a readable .zip archive.",
        )
    })?;
    archive_files(&bytes)
}

/// The files of an in-memory `.zip` package, with its single top-level
/// folder removed when the manifest is inside one.
pub fn archive_files(bytes: &[u8]) -> Result<Vec<PackageFile>, Vec<Problem>> {
    let limits = ZipLimits {
        entries: MAX_FILES,
        file_bytes: MAX_FILE_BYTES,
        total_bytes: MAX_PACKAGE_BYTES,
    };
    let entries = read_zip(bytes, limits).map_err(|error| {
        let code = match error {
            crate::zip::ZipError::TooLarge => ProblemCode::PackageTooLarge,
            crate::zip::ZipError::TooManyFiles => ProblemCode::PackageTooLarge,
            crate::zip::ZipError::Link => ProblemCode::Path,
            _ => ProblemCode::Archive,
        };
        problem(code, error.message())
    })?;
    let mut files = entries
        .into_iter()
        .map(|entry| PackageFile {
            path: entry.name,
            bytes: entry.bytes,
        })
        .collect::<Vec<_>>();
    strip_single_folder(&mut files);
    files.retain(|file| {
        !file
            .path
            .split('/')
            .any(|segment| SKIPPED_DIRECTORIES.contains(&segment))
    });
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn strip_single_folder(files: &mut [PackageFile]) {
    if files.iter().any(|file| file.path == MANIFEST_FILE) {
        return;
    }
    let Some(first) = files.first().and_then(|file| file.path.split_once('/')) else {
        return;
    };
    let prefix = format!("{}/", first.0);
    let wrapped = files.iter().all(|file| file.path.starts_with(&prefix))
        && files
            .iter()
            .any(|file| file.path == format!("{prefix}{MANIFEST_FILE}"));
    if wrapped {
        for file in files.iter_mut() {
            file.path = file.path[prefix.len()..].to_owned();
        }
    }
}

/// SHA-256 over every file, in path order: a domain tag, then per file its
/// path, a NUL, its length (u64, little endian) and the SHA-256 of its bytes.
#[must_use]
pub fn code_hash(files: &[PackageFile]) -> String {
    let mut ordered = files.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.path.cmp(&right.path));
    let mut hasher = Sha256::new();
    hasher.update(b"piui-plugin-package-v1\n");
    for file in ordered {
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        hasher.update(
            u64::try_from(file.bytes.len())
                .unwrap_or(u64::MAX)
                .to_le_bytes(),
        );
        hasher.update(Sha256::digest(&file.bytes));
    }
    format!("{:x}", hasher.finalize())
}

fn system_file_validator() -> Option<&'static jsonschema::Validator> {
    static VALIDATOR: OnceLock<Option<jsonschema::Validator>> = OnceLock::new();
    VALIDATOR
        .get_or_init(|| {
            let schema: Value = serde_json::from_str(include_str!(
                "../../../contracts/system-file-v4.schema.json"
            ))
            .ok()?;
            jsonschema::validator_for(&schema).ok()
        })
        .as_ref()
}

/// Checks paths, the manifest, every file it names and each template.
pub fn validate_files(
    files: Vec<PackageFile>,
    piui_version: &str,
) -> Result<ValidatedPackage, Vec<Problem>> {
    let mut problems = Vec::new();
    let mut seen = BTreeMap::new();
    for file in &files {
        if !safe_package_path(&file.path) {
            problems.push(Problem::about(
                ProblemCode::Path,
                "The package path “{0}” is not allowed.",
                file.path.clone(),
            ));
        } else if let Some(previous) = seen.insert(file.path.to_lowercase(), file.path.clone()) {
            problems.push(Problem::about(
                ProblemCode::Path,
                "Two package paths differ only in letter case: {0}.",
                format!("{previous}, {}", file.path),
            ));
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let Some(manifest_bytes) = files
        .iter()
        .find(|file| file.path == MANIFEST_FILE)
        .map(|file| file.bytes.clone())
    else {
        return Err(problem(
            ProblemCode::NotAPackage,
            "There is no piui-plugin.json at the top of the package.",
        ));
    };
    let manifest = parse_manifest(&manifest_bytes, piui_version)?;
    let has = |path: &str| files.iter().any(|file| file.path == path);
    let named = manifest
        .manifest
        .backend
        .iter()
        .chain(manifest.manifest.ui.iter())
        .map(|entry| entry.entry.clone())
        .chain(
            manifest
                .manifest
                .contributes
                .templates
                .iter()
                .map(|template| template.file.clone()),
        )
        .chain(
            manifest
                .manifest
                .contributes
                .mcp_servers
                .iter()
                .map(|server| server.entry.clone()),
        );
    for path in named {
        if !has(&path) {
            problems.push(Problem::about(
                ProblemCode::FileMissing,
                "The manifest names a file the package does not contain: {0}.",
                path,
            ));
        }
    }
    for template in &manifest.manifest.contributes.templates {
        let Some(bytes) = files
            .iter()
            .find(|file| file.path == template.file)
            .map(|file| &file.bytes)
        else {
            continue;
        };
        if let Err(problem) = check_template(bytes) {
            problems.push(Problem::about(
                ProblemCode::Template,
                problem,
                template.id.clone(),
            ));
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let bytes = files
        .iter()
        .map(|file| u64::try_from(file.bytes.len()).unwrap_or(u64::MAX))
        .sum();
    Ok(ValidatedPackage {
        code_hash: code_hash(&files),
        manifest,
        files,
        bytes,
    })
}

/// A template is at most 1 MiB of JSON that matches the portable system
/// file v4 schema. The UI applies the full parser before importing it.
fn check_template(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() > MAX_TEMPLATE_BYTES {
        return Err("Template “{0}” is larger than 1 MiB.");
    }
    let value =
        serde_json::from_slice::<Value>(bytes).map_err(|_| "Template “{0}” is not valid JSON.")?;
    if value.get("format") != Some(&Value::String("piui-system".into()))
        || value.get("version") != Some(&Value::from(4))
    {
        return Err("Template “{0}” is not a PiUI system file (version 4).");
    }
    let validator =
        system_file_validator().ok_or("Template “{0}” could not be checked in this build.")?;
    if !validator.is_valid(&value) {
        return Err("Template “{0}” does not match the system file v4 schema.");
    }
    Ok(())
}

/// Reads and validates a package folder (install from a folder, a
/// development folder, or an installed copy).
pub fn load_folder(root: &Path, piui_version: &str) -> Result<ValidatedPackage, Vec<Problem>> {
    validate_files(read_folder(root)?, piui_version)
}

/// Reads and validates a `.zip` package.
pub fn load_archive(path: &Path, piui_version: &str) -> Result<ValidatedPackage, Vec<Problem>> {
    validate_files(read_archive(path)?, piui_version)
}

/// Writes `files` into `destination`, which must not exist yet.
pub fn write_package(destination: &Path, files: &[PackageFile]) -> io::Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(destination)?;
    for file in files {
        if !safe_package_path(&file.path) {
            return Err(io::Error::other("unsafe package path"));
        }
        let target = file
            .path
            .split('/')
            .fold(destination.to_path_buf(), |path, segment| {
                path.join(segment)
            });
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        output.write_all(&file.bytes)?;
        output.flush()?;
    }
    Ok(())
}

/// Resolves a `/`-separated package path inside `root` without following
/// anything outside it. The caller serves or starts only what this returns.
#[must_use]
pub fn resolve_inside(root: &Path, relative: &str) -> Option<PathBuf> {
    if !safe_package_path(relative) {
        return None;
    }
    let path = relative
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    let inside = path
        .components()
        .all(|component| !matches!(component, Component::ParentDir | Component::CurDir));
    inside.then_some(path)
}
