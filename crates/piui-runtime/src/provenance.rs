//! Verification of app-managed Pi runtime bundles.
//!
//! This module never launches an executable. Production verification has an
//! intentionally empty keyring until a signed release pipeline supplies pinned
//! keys. A manifest signature is checked over the exact bytes supplied by the
//! packager before its JSON is parsed.
//!
//! Deliberately unimplemented: complete cross-platform native-handle tree
//! verification and spawning, release-policy/key-role enforcement, and process
//! containment. Windows retains test-covered leases for signed regular files,
//! but that partial defense is not a handle-bound namespace or launch path.

#![allow(
    dead_code,
    reason = "Phase 0 keeps this verification path crate-private until a handle-based launcher can bind verification to spawn."
)]

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MANIFEST_SCHEMA_ID: &str = "piui-managed-runtime";
const MANIFEST_SCHEMA_VERSION: u32 = 2;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_MANAGED_BUNDLE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_BUNDLE_FILES: usize = 256;
const MAX_BUNDLE_PATH_CHARS: usize = 512;
const MAX_BUNDLE_PATH_DEPTH: usize = 16;
const MAX_TREE_ENTRIES: usize = MAX_BUNDLE_FILES * (MAX_BUNDLE_PATH_DEPTH + 1);
const MAX_IDENTIFIER_CHARS: usize = 128;
/// Prevent a signature issued for another PiUI data format from authorizing a
/// runtime bundle manifest with identical bytes.
const MANIFEST_SIGNATURE_DOMAIN: &[u8] = b"piui-managed-runtime-manifest-v2\0";
const PRODUCTION_KEYRING: &[VerifyingKey] = &[];
const CURRENT_PIUI_COMPATIBILITY: &str = concat!("piui-", env!("CARGO_PKG_VERSION"));
const CURRENT_CAPABILITY_CONTRACT: &str = "pi-rpc-v1";
const CURRENT_CAPABILITY_FIXTURE_SHA256: &str =
    "f093612cd970d2c329e0b736e429fbf4deecf49b0219489b7f3de1be3f91f225";

/// Exact platform tuple accepted by a managed runtime manifest.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ManagedRuntimeTarget {
    os: ManagedRuntimeOs,
    arch: ManagedRuntimeArch,
}

impl ManagedRuntimeTarget {
    #[must_use]
    pub const fn new(os: ManagedRuntimeOs, arch: ManagedRuntimeArch) -> Self {
        Self { os, arch }
    }

    #[must_use]
    pub const fn current() -> Self {
        Self {
            os: ManagedRuntimeOs::current(),
            arch: ManagedRuntimeArch::current(),
        }
    }

    fn os_label(self) -> &'static str {
        self.os.label()
    }

    fn arch_label(self) -> &'static str {
        self.arch.label()
    }

    const fn is_supported(self) -> bool {
        !matches!(self.os, ManagedRuntimeOs::Other)
            && !matches!(self.arch, ManagedRuntimeArch::Other)
    }
}

/// Supported managed-runtime operating systems.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedRuntimeOs {
    Windows,
    Linux,
    Macos,
    Other,
}

impl ManagedRuntimeOs {
    const fn current() -> Self {
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
        #[cfg(target_os = "linux")]
        {
            Self::Linux
        }
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        {
            Self::Other
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Linux => "linux",
            Self::Macos => "macos",
            Self::Other => "other",
        }
    }
}

/// Supported managed-runtime CPU architectures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedRuntimeArch {
    X86_64,
    Aarch64,
    Other,
}

impl ManagedRuntimeArch {
    const fn current() -> Self {
        #[cfg(target_arch = "x86_64")]
        {
            Self::X86_64
        }
        #[cfg(target_arch = "aarch64")]
        {
            Self::Aarch64
        }
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        {
            Self::Other
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
            Self::Other => "other",
        }
    }
}

/// Immutable compatibility binding expected by this PiUI build.
#[derive(Clone, Eq, PartialEq)]
pub struct RuntimeBinding {
    piui_compatibility: String,
    capability_contract: String,
    capability_fixture_sha256: [u8; 32],
}

impl fmt::Debug for RuntimeBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RuntimeBinding(<redacted>)")
    }
}

impl RuntimeBinding {
    /// Creates a bounded, non-secret binding used to reject a manifest meant
    /// for another PiUI/protocol fixture.
    pub fn new(
        piui_compatibility: &str,
        capability_contract: &str,
        capability_fixture_sha256: &str,
    ) -> Result<Self, ProvenanceError> {
        if !safe_identifier(piui_compatibility) || !safe_identifier(capability_contract) {
            return Err(ProvenanceError::InvalidBinding);
        }
        let capability_fixture_sha256 =
            parse_sha256(capability_fixture_sha256).ok_or(ProvenanceError::InvalidBinding)?;
        Ok(Self {
            piui_compatibility: piui_compatibility.to_owned(),
            capability_contract: capability_contract.to_owned(),
            capability_fixture_sha256,
        })
    }

    fn current_build() -> Self {
        // Constants above are build-owned protocol binding identifiers, not
        // user configuration. Parsing cannot fail because they are literals.
        Self::new(
            CURRENT_PIUI_COMPATIBILITY,
            CURRENT_CAPABILITY_CONTRACT,
            CURRENT_CAPABILITY_FIXTURE_SHA256,
        )
        .expect("embedded managed-runtime binding is valid")
    }
}

/// Path-free categories for managed-runtime bundle verification failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProvenanceError {
    NoTrustedKeys,
    InvalidSignature,
    ManifestTooLarge,
    ManifestMalformed,
    ManifestInvalid,
    InvalidBinding,
    TargetMismatch,
    BindingMismatch,
    RootUnavailable,
    BundleMissing,
    BundleUnsafe,
    BundleTooLarge,
    BundleSizeMismatch,
    BundleDigestMismatch,
    BundleReadFailed,
}

impl fmt::Display for ProvenanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::NoTrustedKeys => "managed runtime provenance has no trusted production keys",
            Self::InvalidSignature => "managed runtime bundle manifest signature is invalid",
            Self::ManifestTooLarge => "managed runtime bundle manifest exceeds the safe size limit",
            Self::ManifestMalformed => "managed runtime bundle manifest is malformed",
            Self::ManifestInvalid => "managed runtime bundle manifest is invalid",
            Self::InvalidBinding => "managed runtime compatibility binding is invalid",
            Self::TargetMismatch => "managed runtime target does not match this host",
            Self::BindingMismatch => "managed runtime compatibility binding does not match",
            Self::RootUnavailable => "managed runtime bundle root is unavailable",
            Self::BundleMissing => "managed runtime bundle entry is unavailable",
            Self::BundleUnsafe => "managed runtime bundle tree is unsafe",
            Self::BundleTooLarge => "managed runtime bundle exceeds the safe size limit",
            Self::BundleSizeMismatch => {
                "managed runtime bundle entry size does not match provenance"
            }
            Self::BundleDigestMismatch => {
                "managed runtime bundle entry digest does not match provenance"
            }
            Self::BundleReadFailed => "managed runtime bundle entry cannot be read",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ProvenanceError {}

/// Verifies signed raw manifests and complete app-managed runtime bundles.
///
/// [`Self::production`] deliberately has no keys until release engineering
/// embeds a real keyring. It therefore cannot verify or authorize a bundle.
pub struct ManagedRuntimeVerifier {
    target: ManagedRuntimeTarget,
    binding: RuntimeBinding,
    keyring: Vec<VerifyingKey>,
}

impl ManagedRuntimeVerifier {
    /// Constructs the only production verifier. Its expected target and
    /// compatibility binding are immutable build constants; callers cannot
    /// select a legacy/foreign policy. The embedded keyring is intentionally
    /// empty until release engineering supplies a reviewed key rollout.
    #[must_use]
    pub fn production() -> Self {
        Self {
            target: ManagedRuntimeTarget::current(),
            binding: RuntimeBinding::current_build(),
            keyring: PRODUCTION_KEYRING.to_vec(),
        }
    }

    /// Verifies exact signed manifest bytes and every tree entry below
    /// `app_managed_root`. No process is created as part of verification.
    pub(crate) fn verify_app_managed_bundle(
        &self,
        app_managed_root: impl AsRef<Path>,
        raw_manifest: &[u8],
        signature: &[u8],
    ) -> Result<VerifiedManagedRuntimeBundle, ProvenanceError> {
        let manifest = self.verify_manifest(raw_manifest, signature)?;
        let root = canonical_runtime_root(app_managed_root.as_ref())?;
        verify_bundle(&root, &manifest, BundleVerification::none())?;
        // Acquire every signed regular-file lease only after the initial
        // complete-tree scan. Collection is deliberately in manifest order;
        // if one acquisition fails, the local Vec drops all earlier leases.
        #[cfg(windows)]
        let file_leases = acquire_windows_bundle_file_leases(&root, &manifest)?;
        // Recheck the entire tree while every declared file denies later
        // write/delete sharing, binding each independently opened file to its
        // corresponding retained native identity before rehashing.
        #[cfg(not(windows))]
        let verification = BundleVerification::none();
        #[cfg(windows)]
        let verification = BundleVerification::with_windows_file_leases(&file_leases);
        verify_bundle(&root, &manifest, verification)?;
        #[cfg(windows)]
        revalidate_windows_bundle_file_leases(&file_leases, &manifest)?;
        Ok(VerifiedManagedRuntimeBundle {
            canonical_root: root,
            manifest,
            #[cfg(windows)]
            file_leases,
        })
    }

    fn verify_manifest(
        &self,
        raw_manifest: &[u8],
        signature: &[u8],
    ) -> Result<VerifiedBundleManifest, ProvenanceError> {
        if self.keyring.is_empty() {
            return Err(ProvenanceError::NoTrustedKeys);
        }
        if !self.target.is_supported() {
            return Err(ProvenanceError::TargetMismatch);
        }
        if raw_manifest.len() > MAX_MANIFEST_BYTES {
            return Err(ProvenanceError::ManifestTooLarge);
        }
        let signature =
            Signature::from_slice(signature).map_err(|_| ProvenanceError::InvalidSignature)?;
        let signed_message = manifest_signature_message(raw_manifest);
        if !self
            .keyring
            .iter()
            .any(|key| key.verify_strict(&signed_message, &signature).is_ok())
        {
            return Err(ProvenanceError::InvalidSignature);
        }
        reject_duplicate_json_keys(raw_manifest).map_err(|_| ProvenanceError::ManifestMalformed)?;
        let manifest: ManifestWire =
            serde_json::from_slice(raw_manifest).map_err(|_| ProvenanceError::ManifestMalformed)?;
        validate_manifest(manifest, self.target, &self.binding)
    }

    #[cfg(test)]
    pub(crate) fn with_test_key(
        target: ManagedRuntimeTarget,
        binding: RuntimeBinding,
        key: VerifyingKey,
    ) -> Self {
        Self {
            target,
            binding,
            keyring: vec![key],
        }
    }
}

/// Opaque host-only evidence that a signed declaration matched a complete
/// bundle at a point in time. It has no serde implementation and its debug
/// form hides paths, entrypoint, hashes, and release metadata. It is not a
/// launch capability: a future platform launcher must bind open native handles
/// across its own verify-to-spawn boundary.
pub struct VerifiedManagedRuntimeBundle {
    canonical_root: PathBuf,
    manifest: VerifiedBundleManifest,
    // Retained solely for non-launching Windows provenance revalidation. The
    // manifest-order collection exports neither paths nor native handles.
    #[cfg(windows)]
    file_leases: Vec<piui_platform::WindowsStableFileLease>,
}

impl PartialEq for VerifiedManagedRuntimeBundle {
    fn eq(&self, other: &Self) -> bool {
        // Lease identity deliberately has no equality surface. Equality retains
        // the prior provenance-evidence semantics and never exposes the handle.
        self.canonical_root == other.canonical_root && self.manifest == other.manifest
    }
}

impl Eq for VerifiedManagedRuntimeBundle {}

impl fmt::Debug for VerifiedManagedRuntimeBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("VerifiedManagedRuntimeBundle(<redacted>)")
    }
}

impl VerifiedManagedRuntimeBundle {
    /// Rechecks root safety and the complete declared tree. This detects stale,
    /// added, removed, or substituted bundle entries, but cannot make a later
    /// path-based spawn atomic; a future launcher must instead hold native
    /// handles across its verify-to-spawn boundary.
    pub(crate) fn revalidate(&self) -> Result<(), ProvenanceError> {
        #[cfg(not(windows))]
        let verification = BundleVerification::none();
        #[cfg(windows)]
        let verification = BundleVerification::with_windows_file_leases(&self.file_leases);
        verify_bundle(&self.canonical_root, &self.manifest, verification)?;
        #[cfg(windows)]
        revalidate_windows_bundle_file_leases(&self.file_leases, &self.manifest)?;
        Ok(())
    }
}

#[cfg(windows)]
fn acquire_windows_bundle_file_leases(
    root: &Path,
    manifest: &VerifiedBundleManifest,
) -> Result<Vec<piui_platform::WindowsStableFileLease>, ProvenanceError> {
    let leases = manifest
        .files
        .iter()
        .map(|file| {
            piui_platform::WindowsStableFileLease::acquire(root.join(&file.path))
                .map_err(map_windows_lease_error)
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_windows_file_lease_bijection(&leases)?;
    Ok(leases)
}

/// Requires one distinct opaque native identity for every retained manifest
/// slot. This runs immediately after all leases are acquired and again before
/// every lease-bound tree verification.
#[cfg(windows)]
fn validate_windows_file_lease_bijection(
    leases: &[piui_platform::WindowsStableFileLease],
) -> Result<(), ProvenanceError> {
    for (index, lease) in leases.iter().enumerate() {
        if leases[..index]
            .iter()
            .any(|previous| lease.has_same_native_identity(previous))
        {
            return Err(ProvenanceError::BundleUnsafe);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn revalidate_windows_bundle_file_leases(
    leases: &[piui_platform::WindowsStableFileLease],
    manifest: &VerifiedBundleManifest,
) -> Result<(), ProvenanceError> {
    if leases.len() != manifest.files.len() {
        return Err(ProvenanceError::ManifestInvalid);
    }
    for (lease, file) in leases.iter().zip(&manifest.files) {
        lease
            .revalidate_sha256(file.size, file.sha256, MAX_MANAGED_BUNDLE_BYTES)
            .map_err(map_windows_lease_error)?;
    }
    Ok(())
}

#[cfg(windows)]
fn map_windows_lease_error(error: piui_platform::WindowsStableFileLeaseError) -> ProvenanceError {
    match error {
        piui_platform::WindowsStableFileLeaseError::TooLarge => ProvenanceError::BundleTooLarge,
        piui_platform::WindowsStableFileLeaseError::SizeMismatch => {
            ProvenanceError::BundleSizeMismatch
        }
        piui_platform::WindowsStableFileLeaseError::DigestMismatch => {
            ProvenanceError::BundleDigestMismatch
        }
        piui_platform::WindowsStableFileLeaseError::OpenFailed
        | piui_platform::WindowsStableFileLeaseError::UnsafeFile
        | piui_platform::WindowsStableFileLeaseError::IdentityChanged => {
            ProvenanceError::BundleUnsafe
        }
        piui_platform::WindowsStableFileLeaseError::ReadFailed => ProvenanceError::BundleReadFailed,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestWire {
    schema_id: String,
    schema_version: u32,
    release_id: String,
    piui_compatibility: String,
    bundle: BundleWire,
    capability_binding: CapabilityBindingWire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleWire {
    target_os: String,
    target_arch: String,
    distribution: String,
    entrypoint: String,
    files: Vec<BundleFileWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleFileWire {
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CapabilityBindingWire {
    contract: String,
    fixture_sha256: String,
}

#[derive(Eq, PartialEq)]
struct VerifiedBundleManifest {
    // Preserved from signed input for a future handle-owning launcher; neither
    // value is exposed by this non-launching verification surface.
    release_id: String,
    entrypoint: String,
    files: Vec<VerifiedBundleFile>,
    expected_directories: BTreeSet<String>,
}

#[derive(Eq, PartialEq)]
struct VerifiedBundleFile {
    path: String,
    size: u64,
    sha256: [u8; 32],
    // The manifest is validated as an ordered declaration. Preserve that
    // position to bind a second tree scan to the same ordered lease collection.
    manifest_order: usize,
}

pub(crate) fn manifest_signature_message(raw_manifest: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(MANIFEST_SIGNATURE_DOMAIN.len() + raw_manifest.len());
    message.extend_from_slice(MANIFEST_SIGNATURE_DOMAIN);
    message.extend_from_slice(raw_manifest);
    message
}

/// `serde_json` intentionally uses last-key-wins semantics. Signed release
/// manifests instead reject duplicate object keys at every nesting depth so
/// different consumers cannot interpret the same authenticated bytes
/// differently.
fn reject_duplicate_json_keys(raw_manifest: &[u8]) -> Result<(), ()> {
    let mut deserializer = serde_json::Deserializer::from_slice(raw_manifest);
    DuplicateFreeJson::deserialize(&mut deserializer).map_err(|_| ())?;
    deserializer.end().map_err(|_| ())
}

struct DuplicateFreeJson;

impl<'de> Deserialize<'de> for DuplicateFreeJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(DuplicateFreeJsonVisitor)
    }
}

struct DuplicateFreeJsonVisitor;

impl<'de> Visitor<'de> for DuplicateFreeJsonVisitor {
    type Value = DuplicateFreeJson;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateFreeJson)
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateFreeJson)
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateFreeJson)
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateFreeJson)
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateFreeJson)
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateFreeJson)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateFreeJson)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateFreeJson)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<DuplicateFreeJson>()?.is_some() {}
        Ok(DuplicateFreeJson)
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
            let _: DuplicateFreeJson = map.next_value()?;
        }
        Ok(DuplicateFreeJson)
    }
}

fn validate_manifest(
    manifest: ManifestWire,
    target: ManagedRuntimeTarget,
    binding: &RuntimeBinding,
) -> Result<VerifiedBundleManifest, ProvenanceError> {
    if manifest.schema_id != MANIFEST_SCHEMA_ID
        || manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || !safe_release_id(&manifest.release_id)
    {
        return Err(ProvenanceError::ManifestInvalid);
    }
    if manifest.bundle.target_os != target.os_label()
        || manifest.bundle.target_arch != target.arch_label()
    {
        return Err(ProvenanceError::TargetMismatch);
    }
    if manifest.bundle.distribution != "official-standalone" {
        return Err(ProvenanceError::ManifestInvalid);
    }
    let fixture_sha256 = parse_sha256(&manifest.capability_binding.fixture_sha256)
        .ok_or(ProvenanceError::ManifestInvalid)?;
    if manifest.piui_compatibility != binding.piui_compatibility
        || manifest.capability_binding.contract != binding.capability_contract
        || fixture_sha256 != binding.capability_fixture_sha256
    {
        return Err(ProvenanceError::BindingMismatch);
    }
    if manifest.bundle.files.is_empty() || manifest.bundle.files.len() > MAX_BUNDLE_FILES {
        return Err(ProvenanceError::ManifestInvalid);
    }

    let mut files = Vec::with_capacity(manifest.bundle.files.len());
    let mut expected_directories = BTreeSet::new();
    let mut total_size = 0_u64;
    let mut previous_path: Option<String> = None;
    let mut declared_paths = BTreeSet::new();
    let mut case_folded_paths = HashSet::new();
    // Maps every required directory's case-folded spelling to its one allowed
    // manifest spelling, preventing `A/x` plus `a/y` ambiguity on Windows.
    let mut case_folded_directories = BTreeMap::new();
    let mut has_entrypoint = false;

    for (manifest_order, file) in manifest.bundle.files.into_iter().enumerate() {
        if !safe_relative_slash_path(&file.path) || file.size_bytes == 0 {
            return Err(ProvenanceError::ManifestInvalid);
        }
        if previous_path
            .as_deref()
            .is_some_and(|previous| previous >= file.path.as_str())
        {
            return Err(ProvenanceError::ManifestInvalid);
        }
        if has_file_directory_prefix_conflict(&file.path, &declared_paths) {
            return Err(ProvenanceError::ManifestInvalid);
        }
        let case_folded = file.path.to_ascii_lowercase();
        if case_folded_paths.contains(&case_folded)
            || has_case_folded_ancestor_conflict(&case_folded, &case_folded_paths)
        {
            return Err(ProvenanceError::ManifestInvalid);
        }
        let sha256 = parse_sha256(&file.sha256).ok_or(ProvenanceError::ManifestInvalid)?;
        total_size = total_size
            .checked_add(file.size_bytes)
            .ok_or(ProvenanceError::BundleTooLarge)?;
        if total_size > MAX_MANAGED_BUNDLE_BYTES {
            return Err(ProvenanceError::BundleTooLarge);
        }
        for directory in parent_directories(&file.path) {
            let folded_directory = directory.to_ascii_lowercase();
            if let Some(existing) = case_folded_directories.get(&folded_directory) {
                if existing != directory {
                    return Err(ProvenanceError::ManifestInvalid);
                }
            } else {
                case_folded_directories.insert(folded_directory, directory.to_owned());
            }
            expected_directories.insert(directory.to_owned());
        }
        has_entrypoint |= file.path == manifest.bundle.entrypoint;
        previous_path = Some(file.path.clone());
        declared_paths.insert(file.path.clone());
        case_folded_paths.insert(case_folded);
        files.push(VerifiedBundleFile {
            path: file.path,
            size: file.size_bytes,
            sha256,
            manifest_order,
        });
    }
    if !safe_relative_slash_path(&manifest.bundle.entrypoint) || !has_entrypoint {
        return Err(ProvenanceError::ManifestInvalid);
    }

    Ok(VerifiedBundleManifest {
        release_id: manifest.release_id,
        entrypoint: manifest.bundle.entrypoint,
        files,
        expected_directories,
    })
}

fn has_file_directory_prefix_conflict(path: &str, declared_paths: &BTreeSet<String>) -> bool {
    parent_directories(path).any(|parent| declared_paths.contains(parent))
        || declared_paths
            .iter()
            .any(|declared| is_ancestor_path(path, declared))
}

fn has_case_folded_ancestor_conflict(path: &str, case_folded_paths: &HashSet<String>) -> bool {
    parent_directories(path).any(|parent| case_folded_paths.contains(&parent.to_ascii_lowercase()))
        || case_folded_paths
            .iter()
            .any(|declared| is_ancestor_path(path, declared))
}

fn is_ancestor_path(ancestor: &str, descendant: &str) -> bool {
    descendant
        .strip_prefix(ancestor)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn parent_directories(path: &str) -> impl Iterator<Item = &str> {
    let mut end = path.len();
    std::iter::from_fn(move || {
        let separator = path[..end].rfind('/')?;
        end = separator;
        Some(&path[..separator])
    })
}

fn canonical_runtime_root(root: &Path) -> Result<PathBuf, ProvenanceError> {
    let lexical_metadata =
        fs::symlink_metadata(root).map_err(|_| ProvenanceError::RootUnavailable)?;
    if is_link_or_reparse_point(&lexical_metadata) || !lexical_metadata.is_dir() {
        return Err(ProvenanceError::RootUnavailable);
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| ProvenanceError::RootUnavailable)?;
    let metadata = fs::metadata(&canonical_root).map_err(|_| ProvenanceError::RootUnavailable)?;
    if !metadata.is_dir() {
        return Err(ProvenanceError::RootUnavailable);
    }
    Ok(canonical_root)
}

struct BundleVerification<'a> {
    #[cfg(windows)]
    file_leases: Option<&'a [piui_platform::WindowsStableFileLease]>,
    #[cfg(not(windows))]
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> BundleVerification<'a> {
    const fn none() -> Self {
        Self {
            #[cfg(windows)]
            file_leases: None,
            #[cfg(not(windows))]
            _marker: std::marker::PhantomData,
        }
    }

    #[cfg(windows)]
    const fn with_windows_file_leases(
        file_leases: &'a [piui_platform::WindowsStableFileLease],
    ) -> Self {
        Self {
            file_leases: Some(file_leases),
        }
    }

    #[cfg(windows)]
    fn validate_windows_file_leases(&self, file_count: usize) -> Result<(), ProvenanceError> {
        let Some(leases) = self.file_leases else {
            return Ok(());
        };
        if leases.len() != file_count {
            return Err(ProvenanceError::ManifestInvalid);
        }
        validate_windows_file_lease_bijection(leases)
    }

    #[cfg(windows)]
    fn windows_file_lease(
        &self,
        manifest_order: usize,
    ) -> Result<Option<&piui_platform::WindowsStableFileLease>, ProvenanceError> {
        self.file_leases
            .map(|leases| {
                leases
                    .get(manifest_order)
                    .ok_or(ProvenanceError::ManifestInvalid)
            })
            .transpose()
    }
}

fn verify_bundle(
    root: &Path,
    manifest: &VerifiedBundleManifest,
    verification: BundleVerification<'_>,
) -> Result<(), ProvenanceError> {
    #[cfg(windows)]
    verification.validate_windows_file_leases(manifest.files.len())?;
    validate_stored_root(root)?;
    let files: BTreeMap<&str, &VerifiedBundleFile> = manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut seen_files = HashSet::with_capacity(files.len());
    let mut observed_entries = 0_usize;
    let mut verified_total = 0_u64;
    verify_directory(
        root,
        "",
        0,
        &files,
        &manifest.expected_directories,
        &verification,
        &mut seen_files,
        &mut observed_entries,
        &mut verified_total,
    )?;
    if seen_files.len() != files.len() {
        return Err(ProvenanceError::BundleMissing);
    }
    if verified_total > MAX_MANAGED_BUNDLE_BYTES {
        return Err(ProvenanceError::BundleTooLarge);
    }
    // Detect replacement of the root itself while the tree was inspected.
    validate_stored_root(root)
}

#[allow(clippy::too_many_arguments)]
fn verify_directory(
    root: &Path,
    relative_directory: &str,
    depth: usize,
    files: &BTreeMap<&str, &VerifiedBundleFile>,
    expected_directories: &BTreeSet<String>,
    verification: &BundleVerification<'_>,
    seen_files: &mut HashSet<String>,
    observed_entries: &mut usize,
    verified_total: &mut u64,
) -> Result<(), ProvenanceError> {
    if depth > MAX_BUNDLE_PATH_DEPTH {
        return Err(ProvenanceError::BundleUnsafe);
    }
    let directory = if relative_directory.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative_directory)
    };
    let entries = fs::read_dir(&directory).map_err(map_bundle_open_error)?;
    for entry in entries {
        let entry = entry.map_err(map_bundle_open_error)?;
        *observed_entries = observed_entries
            .checked_add(1)
            .ok_or(ProvenanceError::BundleUnsafe)?;
        if *observed_entries > MAX_TREE_ENTRIES {
            return Err(ProvenanceError::BundleUnsafe);
        }
        let name = entry.file_name();
        let name = name.to_str().ok_or(ProvenanceError::BundleUnsafe)?;
        if !safe_path_component(name) {
            return Err(ProvenanceError::BundleUnsafe);
        }
        let relative_path = if relative_directory.is_empty() {
            name.to_owned()
        } else {
            format!("{relative_directory}/{name}")
        };
        let metadata = fs::symlink_metadata(entry.path()).map_err(map_bundle_open_error)?;
        if is_link_or_reparse_point(&metadata) {
            return Err(ProvenanceError::BundleUnsafe);
        }
        if metadata.is_dir() {
            if !expected_directories.contains(&relative_path) {
                return Err(ProvenanceError::BundleUnsafe);
            }
            verify_directory(
                root,
                &relative_path,
                depth + 1,
                files,
                expected_directories,
                verification,
                seen_files,
                observed_entries,
                verified_total,
            )?;
        } else if metadata.is_file() {
            let file = files
                .get(relative_path.as_str())
                .ok_or(ProvenanceError::BundleUnsafe)?;
            verify_bundle_file(root, &relative_path, file, verification, verified_total)?;
            seen_files.insert(relative_path);
        } else {
            return Err(ProvenanceError::BundleUnsafe);
        }
    }
    Ok(())
}

fn verify_bundle_file(
    root: &Path,
    relative_path: &str,
    expected: &VerifiedBundleFile,
    verification: &BundleVerification<'_>,
    verified_total: &mut u64,
) -> Result<(), ProvenanceError> {
    let candidate = root.join(relative_path);
    let path_metadata = fs::symlink_metadata(&candidate).map_err(map_bundle_open_error)?;
    if is_link_or_reparse_point(&path_metadata) || !path_metadata.is_file() {
        return Err(ProvenanceError::BundleUnsafe);
    }
    let canonical_file = fs::canonicalize(&candidate).map_err(map_bundle_open_error)?;
    if canonical_file != candidate {
        return Err(ProvenanceError::BundleUnsafe);
    }
    let file = fs::File::open(&canonical_file).map_err(map_bundle_open_error)?;
    #[cfg(windows)]
    if let Some(lease) = verification.windows_file_lease(expected.manifest_order)? {
        lease
            .matches_open_file_identity(&file)
            .map_err(map_windows_lease_error)?;
    }
    #[cfg(not(windows))]
    let _ = verification;
    let metadata = file
        .metadata()
        .map_err(|_| ProvenanceError::BundleReadFailed)?;
    if !metadata.is_file() || has_multiple_links(&file, &metadata) {
        return Err(ProvenanceError::BundleUnsafe);
    }
    if metadata.len() != expected.size {
        return Err(ProvenanceError::BundleSizeMismatch);
    }
    let digest = hash_bounded_file(file, expected.size)?;
    if digest != expected.sha256 {
        return Err(ProvenanceError::BundleDigestMismatch);
    }
    *verified_total = verified_total
        .checked_add(expected.size)
        .ok_or(ProvenanceError::BundleTooLarge)?;
    if *verified_total > MAX_MANAGED_BUNDLE_BYTES {
        return Err(ProvenanceError::BundleTooLarge);
    }

    // Reject a path changed to a link or another object during the read. The
    // later full `revalidate` is still required before any future launch.
    let final_metadata = fs::symlink_metadata(&candidate).map_err(map_bundle_open_error)?;
    if is_link_or_reparse_point(&final_metadata) || !final_metadata.is_file() {
        return Err(ProvenanceError::BundleUnsafe);
    }
    if fs::canonicalize(&candidate).map_err(map_bundle_open_error)? != canonical_file {
        return Err(ProvenanceError::BundleUnsafe);
    }
    Ok(())
}

fn validate_stored_root(root: &Path) -> Result<(), ProvenanceError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| ProvenanceError::RootUnavailable)?;
    if is_link_or_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(ProvenanceError::RootUnavailable);
    }
    let canonical = fs::canonicalize(root).map_err(|_| ProvenanceError::RootUnavailable)?;
    if canonical != root {
        return Err(ProvenanceError::RootUnavailable);
    }
    Ok(())
}

#[cfg(unix)]
fn has_multiple_links(_file: &fs::File, metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    metadata.nlink() != 1
}

#[cfg(windows)]
fn has_multiple_links(file: &fs::File, _metadata: &fs::Metadata) -> bool {
    // No link-count query is safe to ignore: a failed native inspection is
    // rejected rather than treating a potentially aliased inode as exclusive.
    piui_platform::windows_file_link_count(file).map_or(true, |count| count != 1)
}

#[cfg(not(any(unix, windows)))]
fn has_multiple_links(_file: &fs::File, _metadata: &fs::Metadata) -> bool {
    // Unsupported platform metadata cannot establish exclusive ownership.
    true
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || (metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn map_bundle_open_error(error: std::io::Error) -> ProvenanceError {
    if error.kind() == std::io::ErrorKind::NotFound {
        ProvenanceError::BundleMissing
    } else {
        ProvenanceError::BundleReadFailed
    }
}

fn hash_bounded_file(mut file: fs::File, expected_size: u64) -> Result<[u8; 32], ProvenanceError> {
    let mut hasher = Sha256::new();
    let mut read_total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ProvenanceError::BundleReadFailed)?;
        if read == 0 {
            break;
        }
        read_total = read_total
            .checked_add(u64::try_from(read).map_err(|_| ProvenanceError::BundleReadFailed)?)
            .ok_or(ProvenanceError::BundleTooLarge)?;
        if read_total > expected_size || read_total > MAX_MANAGED_BUNDLE_BYTES {
            return Err(ProvenanceError::BundleSizeMismatch);
        }
        hasher.update(&buffer[..read]);
    }
    if read_total != expected_size {
        return Err(ProvenanceError::BundleSizeMismatch);
    }
    Ok(hasher.finalize().into())
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_IDENTIFIER_CHARS
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'.' | b'_' | b'-' | b'>' | b'<' | b'=' | b'^' | b',' | b' '
                )
        })
}

fn safe_release_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_IDENTIFIER_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn safe_relative_slash_path(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_BUNDLE_PATH_CHARS
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
        && value.split('/').count() <= MAX_BUNDLE_PATH_DEPTH
        && value.split('/').all(safe_path_component)
}

fn safe_path_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= MAX_IDENTIFIER_CHARS
        && !value.ends_with(['.', ' '])
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !windows_reserved_name(value)
}

fn windows_reserved_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn parse_sha256(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let mut output = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        output[index] = (high << 4) | low;
    }
    (!output.iter().all(|byte| *byte == 0)).then_some(output)
}

const fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    #[cfg(windows)]
    use std::env;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TemporaryDirectory {
        path: PathBuf,
    }

    impl TemporaryDirectory {
        fn new(label: &str) -> Self {
            let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("piui-runtime-provenance-{label}-{sequence}"));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("creates fixture root");
            Self { path }
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn binding() -> RuntimeBinding {
        RuntimeBinding::new(
            "piui-0.1",
            "pi-rpc-v1",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("creates test binding")
    }

    fn target() -> ManagedRuntimeTarget {
        ManagedRuntimeTarget::new(ManagedRuntimeOs::Linux, ManagedRuntimeArch::X86_64)
    }

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn manifest(files: &[(&str, &[u8])], entrypoint: &str) -> Vec<u8> {
        let files = files
            .iter()
            .map(|(path, contents)| {
                format!(
                    "{{\"path\":\"{}\",\"size_bytes\":{},\"sha256\":\"{}\"}}",
                    json_string(path),
                    contents.len(),
                    digest(contents)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"schema_id\":\"piui-managed-runtime\",\"schema_version\":2,\"release_id\":\"release-1\",\"piui_compatibility\":\"piui-0.1\",\"bundle\":{{\"target_os\":\"{}\",\"target_arch\":\"{}\",\"distribution\":\"official-standalone\",\"entrypoint\":\"{}\",\"files\":[{files}]}},\"capability_binding\":{{\"contract\":\"pi-rpc-v1\",\"fixture_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}}}",
            target().os_label(),
            target().arch_label(),
            json_string(entrypoint),
        )
        .into_bytes()
    }

    fn json_string(value: &str) -> String {
        value.replace('\\', "\\\\").replace('"', "\\\"")
    }

    fn signed_verifier() -> (SigningKey, ManagedRuntimeVerifier) {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let verifier =
            ManagedRuntimeVerifier::with_test_key(target(), binding(), signing_key.verifying_key());
        (signing_key, verifier)
    }

    fn sign(key: &SigningKey, raw: &[u8]) -> [u8; 64] {
        key.sign(&manifest_signature_message(raw)).to_bytes()
    }

    fn write_verified_fixture(
        root: &Path,
    ) -> (Vec<u8>, [u8; 64], SigningKey, ManagedRuntimeVerifier) {
        let files: [(&str, &[u8]); 2] = [
            ("assets/runtime.json", b"{\"version\":2}"),
            ("bin/pi-runtime", b"managed-runtime-fixture"),
        ];
        for (path, contents) in files {
            let destination = root.join(path);
            fs::create_dir_all(destination.parent().expect("fixture parent"))
                .expect("creates fixture parent");
            fs::write(destination, contents).expect("writes bundle file");
        }
        let (key, verifier) = signed_verifier();
        let raw = manifest(&files, "bin/pi-runtime");
        let signature = sign(&key, &raw);
        (raw, signature, key, verifier)
    }

    #[test]
    fn provenance_gate_retains_no_launch_shell_network_or_tauri_surface() {
        let source = include_str!("provenance.rs");
        let forbidden = [
            ["Command", "::new"].concat(),
            ["std", "::process::Command"].concat(),
            ["tokio", "::process"].concat(),
            ["std", "::env::var"].concat(),
            ["tauri", "::"].concat(),
            ["reqwest", "::"].concat(),
        ];
        for forbidden in forbidden {
            assert!(
                !source.contains(&forbidden),
                "provenance gate must not contain {forbidden}"
            );
        }
    }

    #[test]
    fn production_keyring_fails_closed_without_parsing_or_authorizing() {
        let verifier = ManagedRuntimeVerifier::production();
        let root = TemporaryDirectory::new("production");
        let error = verifier
            .verify_app_managed_bundle(&root.path, b"not even json", &[0_u8; 64])
            .expect_err("empty production keyring cannot verify");
        assert_eq!(error, ProvenanceError::NoTrustedKeys);
    }

    #[test]
    fn verifies_complete_nested_bundle_and_revalidates_tree_tampering() {
        let root = TemporaryDirectory::new("success");
        let (raw, signature, _key, verifier) = write_verified_fixture(&root.path);
        let verified = verifier
            .verify_app_managed_bundle(&root.path, &raw, &signature)
            .expect("verifies complete managed bundle");
        assert_eq!(verified.manifest.release_id, "release-1");
        assert_eq!(verified.manifest.entrypoint, "bin/pi-runtime");
        verified.revalidate().expect("revalidates unchanged bundle");
        #[cfg(not(windows))]
        {
            fs::write(root.path.join("assets/runtime.json"), b"{\"version\":3}")
                .expect("externally tampers non-entrypoint fixture");
            assert_eq!(
                verified.revalidate(),
                Err(ProvenanceError::BundleDigestMismatch)
            );
            fs::write(root.path.join("assets/runtime.json"), b"{\"version\":2}")
                .expect("restores fixture");
        }
        #[cfg(windows)]
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .open(root.path.join("assets/runtime.json"))
                .is_err(),
            "the retained non-entrypoint lease denies tampering"
        );
        fs::write(root.path.join("unlisted"), b"extra").expect("adds unlisted entry");
        assert_eq!(verified.revalidate(), Err(ProvenanceError::BundleUnsafe));
        let debug = format!("{verified:?}");
        assert!(!debug.contains(root.path.to_string_lossy().as_ref()));
        assert!(!debug.contains("pi-runtime"));
    }

    #[test]
    fn rejects_added_missing_and_empty_tree_entries() {
        let root = TemporaryDirectory::new("tree-entries");
        let (raw, signature, _key, verifier) = write_verified_fixture(&root.path);
        fs::write(root.path.join("unexpected"), b"extra").expect("adds unexpected file");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &signature),
            Err(ProvenanceError::BundleUnsafe)
        );
        fs::remove_file(root.path.join("unexpected")).expect("removes unexpected file");
        fs::create_dir(root.path.join("empty")).expect("creates unexpected directory");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &signature),
            Err(ProvenanceError::BundleUnsafe)
        );
        fs::remove_dir(root.path.join("empty")).expect("removes unexpected directory");
        fs::remove_file(root.path.join("assets/runtime.json")).expect("removes declared file");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &signature),
            Err(ProvenanceError::BundleMissing)
        );
    }

    #[test]
    fn signature_domain_and_v1_schema_cannot_authorize_a_bundle() {
        let root = TemporaryDirectory::new("signature-domain");
        let (raw, _signature, key, verifier) = write_verified_fixture(&root.path);
        let unsigned_domain_signature = key.sign(&raw).to_bytes();
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &unsigned_domain_signature),
            Err(ProvenanceError::InvalidSignature)
        );
        let v1 = String::from_utf8(raw)
            .expect("fixture manifest utf8")
            .replace("\"schema_version\":2", "\"schema_version\":1")
            .into_bytes();
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &v1, &sign(&key, &v1)),
            Err(ProvenanceError::ManifestInvalid)
        );
    }

    #[test]
    fn rejects_target_binding_duplicate_key_and_unknown_field_failures() {
        let root = TemporaryDirectory::new("manifest-errors");
        let (raw, _signature, key, verifier) = write_verified_fixture(&root.path);
        let target_raw = String::from_utf8(raw.clone())
            .expect("fixture manifest utf8")
            .replace("\"target_os\":\"linux\"", "\"target_os\":\"windows\"")
            .into_bytes();
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &target_raw, &sign(&key, &target_raw)),
            Err(ProvenanceError::TargetMismatch)
        );
        let binding_raw = String::from_utf8(raw.clone())
            .expect("fixture manifest utf8")
            .replace("pi-rpc-v1", "other-contract")
            .into_bytes();
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &binding_raw, &sign(&key, &binding_raw)),
            Err(ProvenanceError::BindingMismatch)
        );
        let duplicate_raw = String::from_utf8(raw.clone())
            .expect("fixture manifest utf8")
            .replacen(
                "\"schema_version\":2",
                "\"schema_version\":2,\"schema_version\":2",
                1,
            )
            .into_bytes();
        assert_eq!(
            verifier.verify_app_managed_bundle(
                &root.path,
                &duplicate_raw,
                &sign(&key, &duplicate_raw)
            ),
            Err(ProvenanceError::ManifestMalformed)
        );
        let unknown_raw = String::from_utf8(raw)
            .expect("fixture manifest utf8")
            .replacen("\"bundle\":{", "\"unexpected\":true,\"bundle\":{", 1)
            .into_bytes();
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &unknown_raw, &sign(&key, &unknown_raw)),
            Err(ProvenanceError::ManifestMalformed)
        );
    }

    #[test]
    fn rejects_unlisted_entrypoint_unsafe_paths_unsorted_and_case_folded_duplicates() {
        let root = TemporaryDirectory::new("path-policy");
        let (key, verifier) = signed_verifier();
        for entrypoint in ["missing", "../pi-runtime", "bin\\pi-runtime", "/pi-runtime"] {
            let raw = manifest(&[("bin/pi-runtime", b"x")], entrypoint);
            assert_eq!(
                verifier.verify_app_managed_bundle(&root.path, &raw, &sign(&key, &raw)),
                Err(ProvenanceError::ManifestInvalid)
            );
        }
        let unsorted = manifest(&[("z", b"z"), ("a", b"a")], "z");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &unsorted, &sign(&key, &unsorted)),
            Err(ProvenanceError::ManifestInvalid)
        );
        let case_duplicate = manifest(&[("Bin/pi", b"a"), ("bin/pi", b"b")], "Bin/pi");
        assert_eq!(
            verifier.verify_app_managed_bundle(
                &root.path,
                &case_duplicate,
                &sign(&key, &case_duplicate)
            ),
            Err(ProvenanceError::ManifestInvalid)
        );
        let traversal = manifest(&[("bin/../pi", b"x")], "bin/../pi");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &traversal, &sign(&key, &traversal)),
            Err(ProvenanceError::ManifestInvalid)
        );
        let zero_sized = manifest(&[("empty", b"")], "empty");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &zero_sized, &sign(&key, &zero_sized)),
            Err(ProvenanceError::ManifestInvalid)
        );
        let file_directory_conflict = manifest(&[("bin", b"x"), ("bin/pi", b"x")], "bin");
        assert_eq!(
            verifier.verify_app_managed_bundle(
                &root.path,
                &file_directory_conflict,
                &sign(&key, &file_directory_conflict)
            ),
            Err(ProvenanceError::ManifestInvalid)
        );
        let case_folded_ancestor = manifest(&[("Bin", b"x"), ("bin/pi", b"x")], "Bin");
        assert_eq!(
            verifier.verify_app_managed_bundle(
                &root.path,
                &case_folded_ancestor,
                &sign(&key, &case_folded_ancestor)
            ),
            Err(ProvenanceError::ManifestInvalid)
        );
        let case_variant_directory = manifest(&[("A/x", b"x"), ("a/y", b"y")], "A/x");
        assert_eq!(
            verifier.verify_app_managed_bundle(
                &root.path,
                &case_variant_directory,
                &sign(&key, &case_variant_directory)
            ),
            Err(ProvenanceError::ManifestInvalid)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hardlinked_declared_entries() {
        let root = TemporaryDirectory::new("hardlink");
        let files: [(&str, &[u8]); 2] = [
            ("bin/pi-runtime", b"hardlinked-runtime"),
            ("copy", b"hardlinked-runtime"),
        ];
        fs::create_dir(root.path.join("bin")).expect("creates fixture directory");
        fs::write(root.path.join("bin/pi-runtime"), files[0].1).expect("writes fixture file");
        fs::hard_link(root.path.join("bin/pi-runtime"), root.path.join("copy"))
            .expect("creates hardlink");
        let (key, verifier) = signed_verifier();
        let raw = manifest(&files, "bin/pi-runtime");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &sign(&key, &raw)),
            Err(ProvenanceError::BundleUnsafe)
        );
    }

    #[cfg(windows)]
    #[test]
    fn verified_windows_bundle_retains_nonwritable_nondelete_leases_for_all_declared_files() {
        let root = TemporaryDirectory::new("windows-all-file-leases");
        let (raw, signature, _key, verifier) = write_verified_fixture(&root.path);
        let verified = verifier
            .verify_app_managed_bundle(&root.path, &raw, &signature)
            .expect("verifies and leases every managed bundle file");

        for relative_path in ["assets/runtime.json", "bin/pi-runtime"] {
            let file = root.path.join(relative_path);
            assert!(fs::OpenOptions::new().write(true).open(&file).is_err());
            assert!(fs::remove_file(&file).is_err());
        }
        verified
            .revalidate()
            .expect("revalidates every retained managed file handle");
    }

    #[cfg(windows)]
    #[test]
    fn preexisting_non_entrypoint_writer_rejects_verification_and_releases_prior_leases() {
        let root = TemporaryDirectory::new("windows-prior-lease-release");
        let files: [(&str, &[u8]); 3] = [
            ("assets/00-prior.json", b"prior"),
            ("assets/01-blocked.json", b"blocked"),
            ("bin/pi-runtime", b"managed-runtime-fixture"),
        ];
        for (relative_path, contents) in files {
            let destination = root.path.join(relative_path);
            fs::create_dir_all(destination.parent().expect("fixture parent"))
                .expect("creates fixture parent");
            fs::write(destination, contents).expect("writes bundle file");
        }
        let (key, verifier) = signed_verifier();
        let raw = manifest(&files, "bin/pi-runtime");
        let signature = sign(&key, &raw);
        let blocked = root.path.join("assets/01-blocked.json");
        let writer = fs::OpenOptions::new()
            .write(true)
            .open(&blocked)
            .expect("opens non-entrypoint writer before verification");

        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &signature),
            Err(ProvenanceError::BundleUnsafe)
        );
        drop(writer);

        let prior = root.path.join("assets/00-prior.json");
        let writer_after_failure = fs::OpenOptions::new()
            .write(true)
            .open(&prior)
            .expect("failed verification releases the previously acquired lease");
        drop(writer_after_failure);
        fs::remove_file(&prior).expect("failed verification releases prior delete sharing");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_duplicate_retained_native_identity_across_manifest_slots() {
        let root = TemporaryDirectory::new("windows-duplicate-lease-identity");
        let entrypoint = root.path.join("pi-runtime");
        fs::write(&entrypoint, b"managed-runtime-fixture").expect("writes fixture file");
        let leases = [
            piui_platform::WindowsStableFileLease::acquire(&entrypoint)
                .expect("leases first manifest slot"),
            piui_platform::WindowsStableFileLease::acquire(&entrypoint)
                .expect("leases duplicate manifest slot"),
        ];

        assert_eq!(
            BundleVerification::with_windows_file_leases(&leases)
                .validate_windows_file_leases(leases.len()),
            Err(ProvenanceError::BundleUnsafe)
        );
    }

    #[cfg(windows)]
    #[test]
    fn complete_tree_rejects_a_non_entrypoint_opened_with_a_different_lease_identity() {
        let root = TemporaryDirectory::new("windows-non-entrypoint-identity-binding");
        let (raw, signature, _key, verifier) = write_verified_fixture(&root.path);
        let manifest = verifier
            .verify_manifest(&raw, &signature)
            .expect("parses signed fixture manifest");
        // The second lease still belongs to the entrypoint. The entrypoint
        // would match its manifest position, but the first non-entrypoint
        // position must reject the different retained identity.
        let entrypoint = root.path.join("bin/pi-runtime");
        let leases = [
            piui_platform::WindowsStableFileLease::acquire(&entrypoint)
                .expect("leases a different file for the non-entrypoint slot"),
            piui_platform::WindowsStableFileLease::acquire(&entrypoint)
                .expect("leases the entrypoint for its own slot"),
        ];
        let canonical_root =
            canonical_runtime_root(&root.path).expect("canonicalizes fixture root");

        assert_eq!(
            verify_bundle(
                &canonical_root,
                &manifest,
                BundleVerification::with_windows_file_leases(&leases),
            ),
            Err(ProvenanceError::BundleUnsafe)
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_ancestor_directory_reparse_alias_during_lease_acquisition() {
        let root = TemporaryDirectory::new("windows-ancestor-reparse");
        let files: [(&str, &[u8]); 2] = [
            ("a/runtime", b"managed-runtime-fixture"),
            ("b/runtime", b"managed-runtime-fixture"),
        ];
        fs::create_dir(root.path.join("a")).expect("creates regular runtime directory");
        fs::write(root.path.join("a/runtime"), files[0].1).expect("writes runtime fixture");
        if let Err(error) =
            std::os::windows::fs::symlink_dir(root.path.join("a"), root.path.join("b"))
        {
            if env::var_os("PIUI_REQUIRE_WINDOWS_REPARSE_TEST").as_deref()
                == Some(std::ffi::OsStr::new("1"))
            {
                panic!("required Windows reparse test could not create directory symlink: {error}");
            }
            eprintln!(
                "SKIP: Windows reparse test could not create a directory symlink ({error}); \
                 set PIUI_REQUIRE_WINDOWS_REPARSE_TEST=1 to require this capability"
            );
            return;
        }
        let (key, verifier) = signed_verifier();
        let raw = manifest(&files, "a/runtime");
        let manifest = verifier
            .verify_manifest(&raw, &sign(&key, &raw))
            .expect("parses signed alias fixture manifest");

        assert!(matches!(
            acquire_windows_bundle_file_leases(&root.path, &manifest),
            Err(ProvenanceError::BundleUnsafe)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_hardlinked_declared_entries_on_windows() {
        let root = TemporaryDirectory::new("windows-hardlink");
        let outside = TemporaryDirectory::new("windows-hardlink-outside");
        let files: [(&str, &[u8]); 1] = [("pi-runtime", b"hardlinked-runtime")];
        fs::write(root.path.join("pi-runtime"), files[0].1).expect("writes fixture file");
        fs::hard_link(root.path.join("pi-runtime"), outside.path.join("alias"))
            .expect("creates external hardlink");
        let (key, verifier) = signed_verifier();
        let raw = manifest(&files, "pi-runtime");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &sign(&key, &raw)),
            Err(ProvenanceError::BundleUnsafe)
        );
    }

    #[test]
    fn rejects_manifest_file_count_and_bundle_size_overages() {
        let root = TemporaryDirectory::new("limits");
        let (key, verifier) = signed_verifier();
        let entries = (0..=MAX_BUNDLE_FILES)
            .map(|index| (format!("f{index:03}"), vec![b'x']))
            .collect::<Vec<_>>();
        let references = entries
            .iter()
            .map(|(path, contents)| (path.as_str(), contents.as_slice()))
            .collect::<Vec<_>>();
        let too_many = manifest(&references, "f000");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &too_many, &sign(&key, &too_many)),
            Err(ProvenanceError::ManifestInvalid)
        );
        let oversized = String::from_utf8(manifest(&[("pi-runtime", b"x")], "pi-runtime"))
            .expect("fixture manifest utf8")
            .replace("\"size_bytes\":1", "\"size_bytes\":536870913")
            .into_bytes();
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &oversized, &sign(&key, &oversized)),
            Err(ProvenanceError::BundleTooLarge)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nonregular_socket_entries() {
        use std::os::unix::net::UnixListener;

        let root = TemporaryDirectory::new("nonregular");
        let (raw, signature, _key, verifier) = write_verified_fixture(&root.path);
        let _socket = UnixListener::bind(root.path.join("socket")).expect("creates socket entry");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &signature),
            Err(ProvenanceError::BundleUnsafe)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_expected_and_unexpected_symlinks_and_symlinked_root() {
        use std::os::unix::fs::symlink;

        let root = TemporaryDirectory::new("symlink");
        let outside = TemporaryDirectory::new("outside");
        let (raw, signature, _key, verifier) = write_verified_fixture(&root.path);
        fs::remove_file(root.path.join("bin/pi-runtime")).expect("removes fixture runtime");
        symlink(
            outside.path.join("runtime"),
            root.path.join("bin/pi-runtime"),
        )
        .expect("creates expected-entry symlink");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &signature),
            Err(ProvenanceError::BundleUnsafe)
        );
        fs::remove_file(root.path.join("bin/pi-runtime")).expect("removes symlink");
        fs::write(root.path.join("bin/pi-runtime"), b"managed-runtime-fixture")
            .expect("restores fixture runtime");
        symlink(outside.path.join("runtime"), root.path.join("link")).expect("creates extra link");
        assert_eq!(
            verifier.verify_app_managed_bundle(&root.path, &raw, &signature),
            Err(ProvenanceError::BundleUnsafe)
        );
        fs::remove_file(root.path.join("link")).expect("removes link");
        let parent = TemporaryDirectory::new("root-link-parent");
        let linked_root = parent.path.join("linked-root");
        symlink(&root.path, &linked_root).expect("creates root link");
        assert_eq!(
            verifier.verify_app_managed_bundle(&linked_root, &raw, &signature),
            Err(ProvenanceError::RootUnavailable)
        );
    }
}
