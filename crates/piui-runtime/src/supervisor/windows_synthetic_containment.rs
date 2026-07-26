//! Windows-only synthetic containment regression proof.
//!
//! This test never executes Pi or a managed-bundle entrypoint. It starts this
//! test executable directly with fixed argv. The fixture protocol authenticates
//! a parent-created temporary root before deriving its own ready/alive witnesses.
//! Only an explicit Job close is asserted to terminate the synthetic tree.

use super::{ManagedRuntimePurpose, ProductionRuntimePolicy, ProductionRuntimeSupervisor};
use crate::provenance::{
    ManagedRuntimeArch, ManagedRuntimeOs, ManagedRuntimeTarget, ManagedRuntimeVerifier,
    RuntimeBinding, VerifiedManagedRuntimeBundle,
};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const CREATE_SUSPENDED: u32 = 0x0000_0004;
const FIXTURE_TEST_NAME: &str =
    "supervisor::windows_synthetic_containment::synthetic_fixture_entrypoint";
const ROLE_ENV: &str = "PIUI_SYNTHETIC_CONTAINMENT_ROLE";
const FIXTURE_ROOT_ENV: &str = "PIUI_SYNTHETIC_CONTAINMENT_ROOT";
const FIXTURE_TOKEN_ENV: &str = "PIUI_SYNTHETIC_CONTAINMENT_TOKEN";
const ROOT_ROLE: &str = "root";
const DESCENDANT_ROLE: &str = "descendant";
const FIXTURE_DIRECTORY_PREFIX: &str = "piui-windows-synthetic-contained-probe-";
const FIXTURE_AUTH_PREFIX: &str = "fixture-auth-";
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINATION_TIMEOUT: Duration = Duration::from_secs(10);
const FAILURE_ROOT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const FIXTURE_MAX_LIFETIME: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const ERROR_SHARING_VIOLATION: i32 = 32;

static FAILURE_CLEANUP_USED: AtomicBool = AtomicBool::new(false);

struct SyntheticFixture {
    root: PathBuf,
    token: String,
    bundle_root: PathBuf,
}

impl SyntheticFixture {
    fn new() -> Self {
        let token = Uuid::new_v4().to_string();
        let temp = fs::canonicalize(std::env::temp_dir())
            .expect("canonicalizes the parent synthetic fixture temp root");
        let root = temp.join(fixture_directory_name(&token));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("creates synthetic containment fixture root");
        fs::write(
            auth_path(&root, &token),
            format!("{token}\n{}", temp.display()),
        )
        .expect("writes synthetic fixture authentication token and temp root");
        Self {
            bundle_root: root.join("bundle"),
            root,
            token,
        }
    }

    fn paths(&self) -> FixturePaths {
        FixturePaths::derive(self.root.clone(), self.token.clone())
    }
}

impl Drop for SyntheticFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct FixturePaths {
    root: PathBuf,
    token: String,
    root_lock: PathBuf,
    descendant_lock: PathBuf,
    descendant_pid_marker: PathBuf,
    stop_marker: PathBuf,
}

impl FixturePaths {
    fn derive(root: PathBuf, token: String) -> Self {
        Self {
            root_lock: root.join(format!("synthetic-root-{token}.lock")),
            descendant_lock: root.join(format!("synthetic-descendant-{token}.lock")),
            descendant_pid_marker: root.join(format!("synthetic-descendant-{token}.pid")),
            stop_marker: root.join(format!("synthetic-stop-{token}")),
            root,
            token,
        }
    }
}

/// This is only a fixed-argv child-process entrypoint. Normal proof tests do
/// not dispatch on ambient environment state. Running this ignored test without
/// a fixture role is an intentional no-op.
#[test]
#[ignore = "only the fixed-argv synthetic child process may run this fixture entrypoint"]
fn synthetic_fixture_entrypoint() {
    match std::env::var(ROLE_ENV).ok().as_deref() {
        Some(ROOT_ROLE) => synthetic_root_fixture(),
        Some(DESCENDANT_ROLE) => synthetic_descendant_fixture(),
        Some(role) => panic!("unexpected synthetic containment fixture role: {role}"),
        None => {}
    }
}

#[test]
fn prepared_probe_explicit_close_kills_synthetic_tree_before_releasing_bundle_leases() {
    FAILURE_CLEANUP_USED.store(false, Ordering::SeqCst);

    let fixture = SyntheticFixture::new();
    let paths = fixture.paths();
    let bundle_file = fixture.bundle_root.join("bin/pi-runtime.exe");
    let mut supervisor =
        ProductionRuntimeSupervisor::new(ProductionRuntimePolicy::ContainedProbeOnly);
    let authorization = supervisor
        .authorize(
            verified_runtime(&fixture.bundle_root),
            ManagedRuntimePurpose::ContainedProbeOnly,
            false,
        )
        .expect("authorizes a synthetic contained probe after provenance revalidation");
    let mut prepared = supervisor
        .take_authorized_prepared_probe(&authorization, false)
        .expect("transfers the live Job and verified bundle into PreparedProbe");

    let pending_root = PendingSuspendedRoot::spawn(ROOT_ROLE, &paths)
        .expect("starts the fixed test executable suspended");
    let assignment = prepared
        .containment
        .assign_before_resume(piui_platform::SuspendedProcess::from_created_suspended(
            pending_root
                .process_id()
                .expect("test child PID is non-zero"),
        ))
        .expect("assigns synthetic root before it resumes");
    // From this point the Job owns normal cleanup. Before this successful
    // assignment, `PendingSuspendedRoot::drop` terminates and waits the child.
    let root = pending_root.into_assigned_child();
    let mut failure_cleanup = SyntheticTreeFailureCleanup::new(
        root,
        paths.stop_marker.clone(),
        paths.descendant_lock.clone(),
        paths.descendant_pid_marker.clone(),
    );
    prepared
        .containment
        .resume_assigned(assignment)
        .expect("resumes only after Job assignment");

    wait_until_locked(&paths.root_lock, "synthetic root");
    wait_until_locked(&paths.descendant_lock, "synthetic descendant");
    assert!(
        failure_cleanup
            .root_mut()
            .try_wait()
            .expect("queries synthetic root liveness")
            .is_none(),
        "ready root remains alive before the Job closes"
    );
    assert_sharing_violation(
        OpenOptions::new().write(true).open(&bundle_file),
        "PreparedProbe retains the verified bundle's non-writable lease while its Job is live",
    );

    prepared
        .containment
        .close()
        .expect("closes the Job without an emergency process cleanup path");
    wait_for_root_termination(failure_cleanup.root_mut());
    wait_until_unlocked(&paths.descendant_lock, "synthetic descendant");
    assert_sharing_violation(
        OpenOptions::new().write(true).open(&bundle_file),
        "closing the Job does not release bundle leases before PreparedProbe drops",
    );

    // The explicit close has already terminated and reaped the witnessed tree.
    // Dropping PreparedProbe now releases its retained bundle lease.
    drop(prepared);
    OpenOptions::new()
        .write(true)
        .open(&bundle_file)
        .expect("bundle lease releases after PreparedProbe drops");
    failure_cleanup.finish_success();
}

/// Owns a just-created suspended root until the Job accepts it. This makes an
/// assignment failure or panic unable to leave an unassigned suspended process.
struct PendingSuspendedRoot {
    child: Option<Child>,
}

impl PendingSuspendedRoot {
    fn spawn(role: &str, fixture: &FixturePaths) -> io::Result<Self> {
        spawn_fixture(role, fixture).map(|child| Self { child: Some(child) })
    }

    fn process_id(&self) -> Result<piui_platform::ProcessId, piui_platform::ContainmentError> {
        let child = self
            .child
            .as_ref()
            .expect("pending suspended root still owns its child");
        piui_platform::ProcessId::new(child.id())
    }

    fn into_assigned_child(mut self) -> Child {
        self.child
            .take()
            .expect("successful Job assignment transfers root cleanup to the Job")
    }
}

impl Drop for PendingSuspendedRoot {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            best_effort_terminate_and_wait_bounded(&mut child);
        }
    }
}

/// Failure-only cleanup for a root that the Job has accepted. It never runs on
/// the passing proof: the explicit close reaps the root and `finish_success`
/// consumes it. Its derived stop marker and retained descendant witnesses bound
/// an escaped descendant's life before the fixture directory may be deleted.
struct SyntheticTreeFailureCleanup {
    root: Option<Child>,
    stop_marker: PathBuf,
    descendant_lock: PathBuf,
    descendant_pid_marker: PathBuf,
}

impl SyntheticTreeFailureCleanup {
    fn new(
        root: Child,
        stop_marker: PathBuf,
        descendant_lock: PathBuf,
        descendant_pid_marker: PathBuf,
    ) -> Self {
        Self {
            root: Some(root),
            stop_marker,
            descendant_lock,
            descendant_pid_marker,
        }
    }

    fn root_mut(&mut self) -> &mut Child {
        self.root
            .as_mut()
            .expect("failure cleanup retains the synthetic root until success")
    }

    fn finish_success(mut self) {
        let mut root = self
            .root
            .take()
            .expect("successful containment proof retains its root child");
        root.wait()
            .expect("explicit Job close already terminated the synthetic root");
        assert!(
            !FAILURE_CLEANUP_USED.swap(false, Ordering::SeqCst),
            "passing synthetic proof must not use failure cleanup"
        );
    }
}

impl Drop for SyntheticTreeFailureCleanup {
    fn drop(&mut self) {
        if let Some(mut root) = self.root.take() {
            FAILURE_CLEANUP_USED.store(true, Ordering::SeqCst);
            let _ = fs::write(&self.stop_marker, b"stop");
            wait_for_descendant_witness_unlock(&self.descendant_lock, &self.descendant_pid_marker);
            best_effort_terminate_and_wait_bounded(&mut root);
        }
    }
}

#[allow(
    clippy::zombie_processes,
    reason = "the parent test's Job Object, rather than this fixture root, owns descendant cleanup on the passing path"
)]
fn synthetic_root_fixture() {
    let fixture = authenticated_fixture_paths();
    let _descendant = spawn_fixture(DESCENDANT_ROLE, &fixture)
        .expect("root starts exactly one synthetic descendant directly");
    let _root_witness =
        create_exclusive_witness(&fixture.root_lock).expect("root becomes ready/alive");
    sleep_until_stopped_or_expired(&fixture.stop_marker);
}

fn synthetic_descendant_fixture() {
    let fixture = authenticated_fixture_paths();
    fs::write(
        &fixture.descendant_pid_marker,
        std::process::id().to_string(),
    )
    .expect("descendant records its derived process marker");
    let _descendant_witness =
        create_exclusive_witness(&fixture.descendant_lock).expect("descendant becomes ready/alive");
    sleep_until_stopped_or_expired(&fixture.stop_marker);
}

fn spawn_fixture(role: &str, fixture: &FixturePaths) -> io::Result<Child> {
    let executable = std::env::current_exe()?;
    assert!(
        executable.is_absolute(),
        "synthetic fixture must use the test executable's full path"
    );
    let mut command = Command::new(executable);
    command
        .args(["--ignored", "--exact", FIXTURE_TEST_NAME, "--nocapture"])
        .env_clear()
        // The fixed allowlist accepts only a parent-created fixture root,
        // authentication token, and role. Fixtures derive all marker paths
        // only after authenticating that root; no witness path is ambient.
        .env(ROLE_ENV, role)
        .env(FIXTURE_ROOT_ENV, &fixture.root)
        .env(FIXTURE_TOKEN_ENV, &fixture.token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if role == ROOT_ROLE {
        command.creation_flags(CREATE_SUSPENDED);
    }
    command.spawn()
}

fn authenticated_fixture_paths() -> FixturePaths {
    let root = PathBuf::from(
        std::env::var_os(FIXTURE_ROOT_ENV).expect("synthetic fixture receives its root"),
    );
    let token = std::env::var(FIXTURE_TOKEN_ENV).expect("synthetic fixture receives its token");
    assert!(
        valid_fixture_token(&token),
        "synthetic fixture token is safe"
    );

    let root = fs::canonicalize(root).expect("canonicalizes the parent-created fixture root");
    let authentication = fs::read_to_string(auth_path(&root, &token))
        .expect("reads fixture authentication token and temporary root");
    let (authenticated_token, authenticated_temp) = authentication
        .split_once('\n')
        .expect("fixture authentication record has token and temporary root");
    assert_eq!(
        authenticated_token, token,
        "fixture authentication token must match the environment token"
    );
    assert!(
        !authenticated_temp.contains('\n'),
        "fixture authentication temporary root is a single path"
    );
    let temp = fs::canonicalize(authenticated_temp)
        .expect("canonicalizes the parent-recorded fixture temporary root");
    assert_eq!(
        root.parent(),
        Some(temp.as_path()),
        "fixture root must be directly beneath the parent-recorded temporary root"
    );
    let expected_name = fixture_directory_name(&token);
    assert_eq!(
        root.file_name().and_then(|name| name.to_str()),
        Some(expected_name.as_str()),
        "fixture root must have the expected tokenized name"
    );
    FixturePaths::derive(root, token)
}

fn fixture_directory_name(token: &str) -> String {
    format!("{FIXTURE_DIRECTORY_PREFIX}{token}")
}

fn auth_path(root: &Path, token: &str) -> PathBuf {
    root.join(format!("{FIXTURE_AUTH_PREFIX}{token}"))
}

fn valid_fixture_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn create_exclusive_witness(path: &Path) -> io::Result<File> {
    // `create_new` and the exclusive open happen in one operation. A parent
    // polling for the witness cannot transiently acquire the newly created
    // path before this fixture retains its own exclusive handle.
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(0)
        .open(path)
}

fn wait_until_locked(path: &Path, label: &str) {
    wait_until(
        READY_TIMEOUT,
        || path.exists() && is_sharing_violation(exclusive_open(path)),
        label,
    );
}

fn wait_until_unlocked(path: &Path, label: &str) {
    wait_until(TERMINATION_TIMEOUT, || exclusive_open(path).is_ok(), label);
}

fn wait_for_descendant_witness_unlock(lock_path: &Path, pid_marker: &Path) {
    let deadline = Instant::now() + TERMINATION_TIMEOUT;
    let mut descendant_started = false;
    loop {
        if !descendant_started {
            if let Ok(pid) = fs::read_to_string(pid_marker) {
                descendant_started = pid.trim().parse::<u32>().is_ok_and(|value| value != 0);
            }
        }
        if descendant_started && lock_path.exists() && exclusive_open(lock_path).is_ok() {
            return;
        }
        if Instant::now() >= deadline {
            // A child that never recorded its derived PID marker never reached
            // the descendant fixture. Its bounded fixture lifetime and the
            // subsequent root cleanup still prevent indefinite retention.
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Failure-path cleanup must never make `Drop` wait indefinitely. A failed
/// kill can mean the child already exited, so poll `try_wait` regardless.
fn best_effort_terminate_and_wait_bounded(child: &mut Child) {
    let _ = child.kill();
    let deadline = Instant::now() + FAILURE_ROOT_CLEANUP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if Instant::now() >= deadline => return,
            Ok(None) => thread::sleep(POLL_INTERVAL),
        }
    }
}

fn wait_for_root_termination(root: &mut Child) {
    let deadline = Instant::now() + TERMINATION_TIMEOUT;
    loop {
        if root
            .try_wait()
            .expect("queries synthetic root termination")
            .is_some()
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "synthetic root did not terminate within {TERMINATION_TIMEOUT:?} after Job close"
        );
        thread::sleep(POLL_INTERVAL);
    }
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool, label: &str) {
    let deadline = Instant::now() + timeout;
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "{label} did not reach its bounded expected state within {timeout:?}"
        );
        thread::sleep(POLL_INTERVAL);
    }
}

fn exclusive_open(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
}

fn assert_sharing_violation(result: io::Result<File>, message: &str) {
    assert!(is_sharing_violation(result), "{message}");
}

fn is_sharing_violation(result: io::Result<File>) -> bool {
    matches!(result, Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION))
}

fn sleep_until_stopped_or_expired(stop_marker: &Path) {
    let deadline = Instant::now() + FIXTURE_MAX_LIFETIME;
    while !stop_marker.exists() && Instant::now() < deadline {
        thread::sleep(POLL_INTERVAL);
    }
}

fn verified_runtime(root: &Path) -> VerifiedManagedRuntimeBundle {
    let bytes = b"synthetic containment fixture only";
    let entrypoint = "bin/pi-runtime.exe";
    fs::create_dir_all(root.join("bin")).expect("creates synthetic bundle directory");
    fs::write(root.join(entrypoint), bytes).expect("writes synthetic non-executable bundle file");
    let signing_key = SigningKey::from_bytes(&[29_u8; 32]);
    let verifier = ManagedRuntimeVerifier::with_test_key(
        ManagedRuntimeTarget::new(ManagedRuntimeOs::Windows, current_arch()),
        RuntimeBinding::new(
            "piui-0.1",
            "pi-rpc-v1",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("creates synthetic runtime binding"),
        signing_key.verifying_key(),
    );
    let digest = format!("{:x}", Sha256::digest(bytes));
    let raw = format!(
        "{{\"schema_id\":\"piui-managed-runtime\",\"schema_version\":2,\"release_id\":\"synthetic-containment\",\"piui_compatibility\":\"piui-0.1\",\"bundle\":{{\"target_os\":\"windows\",\"target_arch\":\"{}\",\"distribution\":\"official-standalone\",\"entrypoint\":\"{entrypoint}\",\"files\":[{{\"path\":\"{entrypoint}\",\"size_bytes\":{},\"sha256\":\"{digest}\"}}]}},\"capability_binding\":{{\"contract\":\"pi-rpc-v1\",\"fixture_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}}}",
        current_arch_label(),
        bytes.len(),
    )
    .into_bytes();
    let signature = signing_key
        .sign(&crate::provenance::manifest_signature_message(&raw))
        .to_bytes();
    verifier
        .verify_app_managed_bundle(root, &raw, &signature)
        .expect("verifies synthetic signed bundle and retains its lease")
}

#[cfg(target_arch = "x86_64")]
const fn current_arch() -> ManagedRuntimeArch {
    ManagedRuntimeArch::X86_64
}

#[cfg(target_arch = "aarch64")]
const fn current_arch() -> ManagedRuntimeArch {
    ManagedRuntimeArch::Aarch64
}

#[cfg(target_arch = "x86_64")]
const fn current_arch_label() -> &'static str {
    "x86_64"
}

#[cfg(target_arch = "aarch64")]
const fn current_arch_label() -> &'static str {
    "aarch64"
}
