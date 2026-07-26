//! Read-only validation for declarative PiUI extension manifests.
//!
//! Validation parses JSON and inspects package paths only. It never loads a
//! JavaScript module, runs a package script, resolves dependencies, or grants
//! a requested permission.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use thiserror::Error;

const MANIFEST_FILE: &str = "piui.manifest.json";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const CONTRIBUTION_COLLECTIONS: &[&str] = &[
    "commands",
    "composerActions",
    "statusItems",
    "settings",
    "renderers",
    "views",
    "previewProviders",
    "themes",
];

/// Trust/source context used for policy decisions. Manifest validity never
/// makes a package trusted or grants any requested permission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageSource {
    TrustedInstalled,
    ProjectLocal,
    Local,
    Untrusted,
}

/// Stable, payload-safe validation code suitable for host diagnostics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticCode {
    ManifestReadFailed,
    ManifestTooLarge,
    ManifestJsonInvalid,
    SchemaUnavailable,
    SchemaInvalid,
    PackageRootUnavailable,
    ContributionIdNamespace,
    ContributionIdDuplicate,
    EntrypointPathInvalid,
    EntrypointAdsComponent,
    EntrypointReservedDevice,
    EntrypointMissing,
    EntrypointEscapesPackage,
    RichViewPermissionRequired,
    RichViewEntrypointRequired,
    ShellSourceRejected,
}

impl DiagnosticCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ManifestReadFailed => "MANIFEST_READ_FAILED",
            Self::ManifestTooLarge => "MANIFEST_TOO_LARGE",
            Self::ManifestJsonInvalid => "MANIFEST_JSON_INVALID",
            Self::SchemaUnavailable => "SCHEMA_UNAVAILABLE",
            Self::SchemaInvalid => "SCHEMA_INVALID",
            Self::PackageRootUnavailable => "PACKAGE_ROOT_UNAVAILABLE",
            Self::ContributionIdNamespace => "CONTRIBUTION_ID_NAMESPACE",
            Self::ContributionIdDuplicate => "CONTRIBUTION_ID_DUPLICATE",
            Self::EntrypointPathInvalid => "ENTRYPOINT_PATH_INVALID",
            Self::EntrypointAdsComponent => "ENTRYPOINT_ADS_COMPONENT",
            Self::EntrypointReservedDevice => "ENTRYPOINT_RESERVED_DEVICE",
            Self::EntrypointMissing => "ENTRYPOINT_MISSING",
            Self::EntrypointEscapesPackage => "ENTRYPOINT_ESCAPES_PACKAGE",
            Self::RichViewPermissionRequired => "RICH_VIEW_PERMISSION_REQUIRED",
            Self::RichViewEntrypointRequired => "RICH_VIEW_ENTRYPOINT_REQUIRED",
            Self::ShellSourceRejected => "SHELL_SOURCE_REJECTED",
        }
    }
}

/// Does not contain a manifest value, entrypoint name, or filesystem path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestDiagnostic {
    pub code: DiagnosticCode,
    pub message: &'static str,
}

/// Validity records requested permissions only. A caller must evaluate grants
/// separately; this type intentionally has no `granted_permissions` field.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedManifest {
    pub id: String,
    pub requested_permissions: BTreeSet<String>,
    pub source: PackageSource,
}

#[derive(Clone, Debug, Default)]
pub struct ValidationReport {
    pub manifest: Option<ValidatedManifest>,
    pub diagnostics: Vec<ManifestDiagnostic>,
}

impl ValidationReport {
    #[must_use]
    pub fn is_valid(&self) -> bool {
        self.manifest.is_some() && self.diagnostics.is_empty()
    }
}

#[derive(Debug, Error)]
pub enum ValidatorInitError {
    #[error("bundled manifest schema is unavailable")]
    SchemaUnavailable,
}

/// Schema-first validator backed by the checked-in contract schema.
pub struct ManifestValidator {
    schema: Value,
}

impl ManifestValidator {
    /// Parses and compiles the checked-in JSON Schema without accessing a
    /// package or a network location.
    pub fn bundled() -> Result<Self, ValidatorInitError> {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../contracts/piui-extension-manifest.schema.json"
        ))
        .map_err(|_| ValidatorInitError::SchemaUnavailable)?;
        jsonschema::validator_for(&schema).map_err(|_| ValidatorInitError::SchemaUnavailable)?;
        Ok(Self { schema })
    }

    /// Reads exactly the manifest file under an explicit package root. No
    /// package entrypoint is loaded or executed.
    #[must_use]
    pub fn validate_package(
        &self,
        package_root: impl AsRef<Path>,
        source: PackageSource,
    ) -> ValidationReport {
        let root = match canonical_package_root(package_root.as_ref()) {
            Ok(root) => root,
            Err(()) => return report(DiagnosticCode::PackageRootUnavailable),
        };
        let manifest_path = root.join(MANIFEST_FILE);
        let bytes = match read_limited_regular_file(&manifest_path, MAX_MANIFEST_BYTES) {
            Ok(bytes) => bytes,
            Err(ReadManifestError::TooLarge) => return report(DiagnosticCode::ManifestTooLarge),
            Err(ReadManifestError::Other) => return report(DiagnosticCode::ManifestReadFailed),
        };
        self.validate_bytes_at_root(&root, &bytes, source)
    }

    /// Validates supplied manifest bytes relative to an already trusted host
    /// package root. The root is canonicalized and all entrypoints are checked
    /// read-only; no entrypoint contents are evaluated.
    #[must_use]
    pub fn validate_bytes(
        &self,
        package_root: impl AsRef<Path>,
        manifest_bytes: &[u8],
        source: PackageSource,
    ) -> ValidationReport {
        let root = match canonical_package_root(package_root.as_ref()) {
            Ok(root) => root,
            Err(()) => return report(DiagnosticCode::PackageRootUnavailable),
        };
        if manifest_bytes.len() > MAX_MANIFEST_BYTES {
            return report(DiagnosticCode::ManifestTooLarge);
        }
        self.validate_bytes_at_root(&root, manifest_bytes, source)
    }

    fn validate_bytes_at_root(
        &self,
        root: &Path,
        manifest_bytes: &[u8],
        source: PackageSource,
    ) -> ValidationReport {
        let value: Value = match serde_json::from_slice(manifest_bytes) {
            Ok(value) => value,
            Err(_) => return report(DiagnosticCode::ManifestJsonInvalid),
        };
        let validator = match jsonschema::validator_for(&self.schema) {
            Ok(validator) => validator,
            Err(_) => return report(DiagnosticCode::SchemaUnavailable),
        };
        if !validator.is_valid(&value) {
            return report(DiagnosticCode::SchemaInvalid);
        }

        let mut diagnostics = Vec::new();
        let Some(object) = value.as_object() else {
            return report(DiagnosticCode::SchemaInvalid);
        };
        let Some(manifest_id) = object.get("id").and_then(Value::as_str) else {
            return report(DiagnosticCode::SchemaInvalid);
        };
        let permissions = string_set(object.get("permissions"));
        let entrypoints = object.get("entrypoints").and_then(Value::as_object);
        validate_contribution_ids(object.get("contributes"), manifest_id, &mut diagnostics);
        validate_entrypoints(root, entrypoints, &mut diagnostics);
        validate_rich_views(
            object.get("contributes"),
            entrypoints,
            &permissions,
            &mut diagnostics,
        );
        if permissions.contains("ui.shell") && source != PackageSource::TrustedInstalled {
            push(&mut diagnostics, DiagnosticCode::ShellSourceRejected);
        }

        if diagnostics.is_empty() {
            ValidationReport {
                manifest: Some(ValidatedManifest {
                    id: manifest_id.to_owned(),
                    requested_permissions: permissions,
                    source,
                }),
                diagnostics,
            }
        } else {
            ValidationReport {
                manifest: None,
                diagnostics,
            }
        }
    }
}

fn validate_contribution_ids(
    contributes: Option<&Value>,
    manifest_id: &str,
    diagnostics: &mut Vec<ManifestDiagnostic>,
) {
    let Some(contributes) = contributes.and_then(Value::as_object) else {
        return;
    };
    let mut seen = HashSet::new();
    let dot_namespace = format!("{manifest_id}.");
    let colon_namespace = format!("{manifest_id}:");
    for collection in CONTRIBUTION_COLLECTIONS {
        let Some(items) = contributes.get(*collection).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !id.starts_with(&dot_namespace) && !id.starts_with(&colon_namespace) {
                push(diagnostics, DiagnosticCode::ContributionIdNamespace);
            }
            if !seen.insert(id) {
                push(diagnostics, DiagnosticCode::ContributionIdDuplicate);
            }
        }
    }
}

fn validate_entrypoints(
    root: &Path,
    entrypoints: Option<&serde_json::Map<String, Value>>,
    diagnostics: &mut Vec<ManifestDiagnostic>,
) {
    let Some(entrypoints) = entrypoints else {
        return;
    };
    for key in ["worker", "shell"] {
        if let Some(path) = entrypoints.get(key).and_then(Value::as_str) {
            validate_entrypoint(root, path, diagnostics);
        }
    }
    if let Some(views) = entrypoints.get("views").and_then(Value::as_object) {
        for path in views.values().filter_map(Value::as_str) {
            validate_entrypoint(root, path, diagnostics);
        }
    }
}

fn validate_entrypoint(root: &Path, path: &str, diagnostics: &mut Vec<ManifestDiagnostic>) {
    if !is_lexically_relative(path) {
        push(diagnostics, DiagnosticCode::EntrypointPathInvalid);
        return;
    }
    if has_ads_component(path) {
        push(diagnostics, DiagnosticCode::EntrypointAdsComponent);
        return;
    }
    if has_windows_reserved_device_component(path) {
        push(diagnostics, DiagnosticCode::EntrypointReservedDevice);
        return;
    }
    let candidate = root.join(path);
    let resolved = match fs::canonicalize(&candidate) {
        Ok(resolved) => resolved,
        Err(_) => {
            push(diagnostics, DiagnosticCode::EntrypointMissing);
            return;
        }
    };
    if !resolved.starts_with(root) {
        push(diagnostics, DiagnosticCode::EntrypointEscapesPackage);
        return;
    }
    match fs::symlink_metadata(&resolved) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        _ => push(diagnostics, DiagnosticCode::EntrypointMissing),
    }
}

fn validate_rich_views(
    contributes: Option<&Value>,
    entrypoints: Option<&serde_json::Map<String, Value>>,
    permissions: &BTreeSet<String>,
    diagnostics: &mut Vec<ManifestDiagnostic>,
) {
    let view_entrypoints: BTreeSet<&str> = entrypoints
        .and_then(|entrypoints| entrypoints.get("views"))
        .and_then(Value::as_object)
        .map(|views| views.keys().map(String::as_str).collect())
        .unwrap_or_default();
    if !view_entrypoints.is_empty() && !permissions.contains("ui.richView") {
        push(diagnostics, DiagnosticCode::RichViewPermissionRequired);
    }

    let Some(contributes) = contributes.and_then(Value::as_object) else {
        return;
    };
    for collection in ["renderers", "views", "previewProviders"] {
        let Some(items) = contributes.get(collection).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if item.get("kind").and_then(Value::as_str) != Some("rich") {
                continue;
            }
            if !permissions.contains("ui.richView") {
                push(diagnostics, DiagnosticCode::RichViewPermissionRequired);
            }
            let known_view = item
                .get("viewId")
                .and_then(Value::as_str)
                .is_some_and(|view_id| view_entrypoints.contains(view_id));
            if !known_view {
                push(diagnostics, DiagnosticCode::RichViewEntrypointRequired);
            }
        }
    }
}

fn string_set(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn is_lexically_relative(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::CurDir | Component::Normal(_)))
}

/// Portable package manifests use `/`, but reject both separator styles so a
/// manifest cannot become an ADS/device escape after being copied to Windows.
fn portable_path_components(path: &str) -> impl Iterator<Item = &str> {
    path.split(['/', '\\'])
        .filter(|component| !component.is_empty())
}

fn has_ads_component(path: &str) -> bool {
    portable_path_components(path).any(|component| component.contains(':'))
}

fn has_windows_reserved_device_component(path: &str) -> bool {
    portable_path_components(path).any(|component| {
        let trimmed = component.trim_end_matches(['.', ' ']);
        let stem = trimmed.split('.').next().unwrap_or_default();
        let upper = stem.to_ascii_uppercase();
        matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || is_numbered_windows_device(&upper, "COM")
            || is_numbered_windows_device(&upper, "LPT")
    })
}

fn is_numbered_windows_device(component: &str, prefix: &str) -> bool {
    component.strip_prefix(prefix).is_some_and(|suffix| {
        matches!(
            suffix,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    })
}

fn canonical_package_root(path: &Path) -> Result<PathBuf, ()> {
    let root = fs::canonicalize(path).map_err(|_| ())?;
    root.is_dir().then_some(root).ok_or(())
}

enum ReadManifestError {
    TooLarge,
    Other,
}

/// Reads only through a verified no-follow/reparse-safe handle. The `limit+1`
/// read is the allocation boundary even if a writer grows the file after the
/// handle is opened.
fn read_limited_regular_file(path: &Path, limit: usize) -> Result<Vec<u8>, ReadManifestError> {
    if limit == usize::MAX {
        return Err(ReadManifestError::TooLarge);
    }
    let file = open_regular_no_follow(path)?;
    let metadata = file.metadata().map_err(|_| ReadManifestError::Other)?;
    if metadata.len() > limit as u64 {
        return Err(ReadManifestError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ReadManifestError::Other)?;
    if bytes.len() > limit {
        return Err(ReadManifestError::TooLarge);
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_regular_no_follow(path: &Path) -> Result<fs::File, ReadManifestError> {
    use std::os::unix::fs::OpenOptionsExt;

    let metadata = fs::symlink_metadata(path).map_err(|_| ReadManifestError::Other)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ReadManifestError::Other);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| ReadManifestError::Other)?;
    let opened = file.metadata().map_err(|_| ReadManifestError::Other)?;
    opened
        .is_file()
        .then_some(file)
        .ok_or(ReadManifestError::Other)
}

#[cfg(windows)]
fn open_regular_no_follow(path: &Path) -> Result<fs::File, ReadManifestError> {
    use std::mem::MaybeUninit;
    use std::os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, RawHandle},
    };
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
        OPEN_EXISTING,
    };

    let path_wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // Open the reparse object itself, inspect it, then transfer the verified
    // read-only handle to `File` so no second path-based open occurs.
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(ReadManifestError::Other);
    }
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) };
    if ok == 0 {
        unsafe { CloseHandle(handle) };
        return Err(ReadManifestError::Other);
    }
    let information = unsafe { information.assume_init() };
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        unsafe { CloseHandle(handle) };
        return Err(ReadManifestError::Other);
    }
    let file = unsafe { fs::File::from_raw_handle(handle as RawHandle) };
    let metadata = file.metadata().map_err(|_| ReadManifestError::Other)?;
    metadata
        .is_file()
        .then_some(file)
        .ok_or(ReadManifestError::Other)
}

#[cfg(not(any(unix, windows)))]
fn open_regular_no_follow(_path: &Path) -> Result<fs::File, ReadManifestError> {
    Err(ReadManifestError::Other)
}

fn report(code: DiagnosticCode) -> ValidationReport {
    ValidationReport {
        manifest: None,
        diagnostics: vec![diagnostic(code)],
    }
}

fn push(diagnostics: &mut Vec<ManifestDiagnostic>, code: DiagnosticCode) {
    if !diagnostics.iter().any(|existing| existing.code == code) {
        diagnostics.push(diagnostic(code));
    }
}

const fn diagnostic(code: DiagnosticCode) -> ManifestDiagnostic {
    ManifestDiagnostic {
        code,
        message: match code {
            DiagnosticCode::ManifestReadFailed => "The manifest could not be read.",
            DiagnosticCode::ManifestTooLarge => "The manifest exceeds the safe size limit.",
            DiagnosticCode::ManifestJsonInvalid => "The manifest is not valid JSON.",
            DiagnosticCode::SchemaUnavailable => "The manifest schema is unavailable.",
            DiagnosticCode::SchemaInvalid => "The manifest does not match the PiUI schema.",
            DiagnosticCode::PackageRootUnavailable => "The package root is unavailable.",
            DiagnosticCode::ContributionIdNamespace => {
                "A contribution ID is outside the extension namespace."
            }
            DiagnosticCode::ContributionIdDuplicate => "A contribution ID is duplicated.",
            DiagnosticCode::EntrypointPathInvalid => "An entrypoint path is not package-relative.",
            DiagnosticCode::EntrypointAdsComponent => {
                "An entrypoint path contains an alternate data stream component."
            }
            DiagnosticCode::EntrypointReservedDevice => {
                "An entrypoint path contains a reserved device name."
            }
            DiagnosticCode::EntrypointMissing => "A declared entrypoint is unavailable.",
            DiagnosticCode::EntrypointEscapesPackage => {
                "A declared entrypoint escapes the package root."
            }
            DiagnosticCode::RichViewPermissionRequired => {
                "Rich views require the ui.richView permission request."
            }
            DiagnosticCode::RichViewEntrypointRequired => {
                "A rich contribution requires a declared view entrypoint."
            }
            DiagnosticCode::ShellSourceRejected => {
                "Shell contributions are not allowed for this package source."
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs::remove_file;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_package() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("piui-extension-{nonce}"));
        create_dir_all(root.join("piui")).expect("create package");
        write(root.join("piui/worker.js"), b"not executed").expect("write worker");
        root
    }

    fn base_manifest() -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "id": "test.example",
            "name": "Test",
            "version": "1.0.0",
            "engines": { "piui": ">=1" },
            "permissions": ["session.read"],
            "entrypoints": { "worker": "./piui/worker.js" },
            "contributes": {
                "commands": [{
                    "id": "test.example.run",
                    "title": "Run",
                    "handler": "worker:run"
                }]
            }
        })
    }

    fn validator() -> ManifestValidator {
        ManifestValidator::bundled().expect("bundled schema compiles")
    }

    #[test]
    fn supplied_example_is_schema_and_semantic_valid_without_grants() {
        let root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/minimal-piui-package");
        let report = validator().validate_package(&root, PackageSource::TrustedInstalled);
        assert!(report.is_valid(), "{:?}", report.diagnostics);
        let manifest = report.manifest.expect("validated manifest");
        assert!(manifest.requested_permissions.contains("project.read"));
        assert!(!manifest.requested_permissions.contains("ui.shell"));
    }

    #[test]
    fn schema_and_semantic_failures_are_payload_safe() {
        let root = temp_package();
        let mut invalid = base_manifest();
        invalid["id"] = Value::String("not valid".into());
        let bytes = serde_json::to_vec(&invalid).expect("encode invalid");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
        assert_eq!(report.diagnostics[0].code, DiagnosticCode::SchemaInvalid);

        let mut semantic = base_manifest();
        semantic["contributes"]["commands"][0]["id"] = Value::String("other.run".into());
        let bytes = serde_json::to_vec(&semantic).expect("encode semantic invalid");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == DiagnosticCode::ContributionIdNamespace)
        );
        let encoded = format!("{:?}", report.diagnostics);
        assert!(!encoded.contains("other.run"));
        remove_dir_all(root).expect("remove package");
    }

    #[test]
    fn rejects_duplicate_ids_missing_rich_view_and_local_shell() {
        let root = temp_package();
        let mut duplicate = base_manifest();
        duplicate["contributes"]["composerActions"] = serde_json::json!([{
            "id": "test.example.run",
            "title": "Again",
            "command": "test.example.run"
        }]);
        let bytes = serde_json::to_vec(&duplicate).expect("encode duplicate");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == DiagnosticCode::ContributionIdDuplicate)
        );

        let mut rich = base_manifest();
        rich["permissions"] = serde_json::json!(["ui.richView"]);
        rich["entrypoints"]["views"] = serde_json::json!({ "panel": "./piui/worker.js" });
        rich["contributes"]["views"] = serde_json::json!([{
            "id": "test.example.rich",
            "title": "Rich",
            "slot": "rightPanel.primary",
            "kind": "rich",
            "viewId": "missing-panel"
        }]);
        let bytes = serde_json::to_vec(&rich).expect("encode rich");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
        assert!(
            report.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == DiagnosticCode::RichViewEntrypointRequired
            })
        );

        let mut shell = base_manifest();
        shell["permissions"] = serde_json::json!(["ui.shell"]);
        shell["entrypoints"]["shell"] = Value::String("./piui/worker.js".into());
        let bytes = serde_json::to_vec(&shell).expect("encode shell");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::ProjectLocal);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == DiagnosticCode::ShellSourceRejected)
        );
        remove_dir_all(root).expect("remove package");
    }

    #[test]
    fn rejects_lexical_and_symlink_entrypoint_escape() {
        let root = temp_package();
        let outside = root
            .parent()
            .expect("temp parent")
            .join("piui-extension-outside.js");
        write(&outside, b"not executed").expect("write outside");
        let mut lexical = base_manifest();
        lexical["entrypoints"]["worker"] = Value::String("../piui-extension-outside.js".into());
        let bytes = serde_json::to_vec(&lexical).expect("encode lexical escape");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == DiagnosticCode::SchemaInvalid)
        );

        let mut ads = base_manifest();
        ads["entrypoints"]["worker"] = Value::String("./piui/worker.js:secret".into());
        let bytes = serde_json::to_vec(&ads).expect("encode ADS path");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == DiagnosticCode::EntrypointAdsComponent)
        );

        let mut device = base_manifest();
        device["entrypoints"]["worker"] = Value::String("./piui/CON.txt. ".into());
        let bytes = serde_json::to_vec(&device).expect("encode reserved device path");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == DiagnosticCode::EntrypointReservedDevice })
        );

        let mut unicode_device = base_manifest();
        unicode_device["entrypoints"]["worker"] = Value::String("./piui/LPT².log. ".into());
        let bytes = serde_json::to_vec(&unicode_device).expect("encode Unicode device path");
        let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == DiagnosticCode::EntrypointReservedDevice })
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = root.join("piui/escape.js");
            symlink(&outside, &link).expect("create escape link");
            let mut escaped = base_manifest();
            escaped["entrypoints"]["worker"] = Value::String("./piui/escape.js".into());
            let bytes = serde_json::to_vec(&escaped).expect("encode symlink escape");
            let report = validator().validate_bytes(&root, &bytes, PackageSource::TrustedInstalled);
            assert!(
                report.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == DiagnosticCode::EntrypointEscapesPackage
                })
            );
        }

        remove_dir_all(root).expect("remove package");
        let _ = fs::remove_file(outside);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_swap_to_symlink_is_rejected_without_reading_target() {
        use std::os::unix::fs::symlink;

        let root = temp_package();
        let manifest = root.join(MANIFEST_FILE);
        let target = root
            .parent()
            .expect("temp parent")
            .join("piui-extension-manifest-target.json");
        let target_manifest = serde_json::to_vec(&base_manifest()).expect("encodes target");
        write(&manifest, &target_manifest).expect("writes original manifest");
        write(&target, &target_manifest).expect("writes target manifest");
        remove_file(&manifest).expect("removes original before validation");
        symlink(&target, &manifest).expect("swaps manifest for symlink");

        let report = validator().validate_package(&root, PackageSource::TrustedInstalled);
        assert_eq!(
            report.diagnostics[0].code,
            DiagnosticCode::ManifestReadFailed
        );
        assert!(!format!("{:?}", report.diagnostics).contains("piui-extension-manifest-target"));

        remove_dir_all(root).expect("removes package");
        let _ = fs::remove_file(target);
    }
}
