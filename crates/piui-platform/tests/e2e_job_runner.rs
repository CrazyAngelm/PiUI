#![cfg(all(windows, feature = "e2e-harness"))]

use std::fs::{self, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::windows::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const ROLE_ENV: &str = "PIUI_E2E_JOB_TEST_ROLE";
const ROOT_ENV: &str = "PIUI_E2E_JOB_TEST_ROOT";
const STAY_ENV: &str = "PIUI_E2E_JOB_TEST_STAY";
const ROOT_ROLE: &str = "root";
const DESCENDANT_ROLE: &str = "descendant";
const ROOT_TEST: &str = "synthetic_root_fixture";
const DESCENDANT_TEST: &str = "synthetic_descendant_fixture";
// These bounds match the existing Windows synthetic-containment proof: the
// child cannot self-expire before the runner's bounded close/proof completes.
const READY_BOUND: Duration = Duration::from_secs(10);
const RUNNER_BOUND: Duration = Duration::from_secs(15);
const FIXTURE_MAX_LIFETIME: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(20);

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct FixtureDirectory(PathBuf);

impl FixtureDirectory {
    fn new() -> Self {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let root = repository.join("target").join("piui-e2e").join(format!(
            "job-runner-test-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("creates the owned Job-runner fixture");
        Self(fs::canonicalize(root).expect("canonicalizes the owned Job-runner fixture"))
    }
}

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.0);
            return;
        }
        fs::remove_dir_all(&self.0).expect("removes the owned Job-runner fixture");
        assert!(
            !self.0.exists(),
            "the Job-runner fixture must be absent after cleanup"
        );
    }
}

#[test]
fn missing_arguments_report_the_arguments_phase() {
    let output = run_runner_bounded(["--cleanup-bound-ms", "5000"]);
    assert!(!output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("runner control output is UTF-8"),
        "{\"type\":\"runner_error\",\"phase\":\"arguments\"}\n"
    );
}

#[test]
fn missing_target_reports_spawn_error() {
    let output = run_runner_bounded([
        "--cleanup-bound-ms",
        "5000",
        "--",
        "piui-e2e-definitely-missing.exe",
    ]);
    assert!(!output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("runner control output is UTF-8"),
        "{\"type\":\"spawn_error\"}\n"
    );
}

#[test]
fn root_exit_still_reaps_its_job_descendant() {
    let fixture = FixtureDirectory::new();
    let test_executable = std::env::current_exe().expect("resolves the test executable");
    let mut child = Command::new(env!("CARGO_BIN_EXE_piui-e2e-job"))
        .args(["--cleanup-bound-ms", "5000", "--"])
        .arg(test_executable)
        .args(["--exact", ROOT_TEST, "--nocapture"])
        .env(ROLE_ENV, ROOT_ROLE)
        .env(ROOT_ENV, &fixture.0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("starts the Job runner");
    let output = wait_with_output_bounded(&mut child, RUNNER_BOUND);
    assert!(
        output.status.success(),
        "runner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let control = String::from_utf8(output.stdout).expect("runner control output is UTF-8");
    assert!(control.contains("{\"type\":\"started\"}\n"));
    assert!(
        control.contains("{\"type\":\"terminated\",\"activeProcesses\":0,\"jobClosed\":true}\n")
    );
    OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(fixture.0.join("descendant.lock"))
        .expect("the descendant's exclusive witness releases before runner success");
}

#[test]
fn stdin_eof_reaps_a_running_root_and_descendant() {
    let fixture = FixtureDirectory::new();
    let test_executable = std::env::current_exe().expect("resolves the test executable");
    let runner = env!("CARGO_BIN_EXE_piui-e2e-job");
    let mut child = Command::new(runner)
        .args(["--controlled", "--cleanup-bound-ms", "5000", "--log"])
        .arg(fixture.0.join("target.log"))
        .arg("--")
        .arg(test_executable)
        .args(["--exact", ROOT_TEST, "--nocapture"])
        .env(ROLE_ENV, ROOT_ROLE)
        .env(ROOT_ENV, &fixture.0)
        .env(STAY_ENV, "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("starts the controlled Job runner");
    wait_until(fixture.0.join("descendant.ready").as_path(), READY_BOUND);
    drop(child.stdin.take());
    let output = wait_with_output_bounded(&mut child, RUNNER_BOUND);
    assert!(
        output.status.success(),
        "controlled runner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let control = String::from_utf8(output.stdout).expect("runner control output is UTF-8");
    assert_eq!(
        control,
        concat!(
            "{\"type\":\"started\"}\n",
            "{\"type\":\"terminated\",\"activeProcesses\":0,\"jobClosed\":true}\n"
        )
    );
    OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(fixture.0.join("descendant.lock"))
        .expect("controlled teardown releases the descendant witness before success");
}

#[test]
fn controlled_runner_ignores_data_until_stdin_reaches_eof() {
    let fixture = FixtureDirectory::new();
    let test_executable = std::env::current_exe().expect("resolves the test executable");
    let runner = env!("CARGO_BIN_EXE_piui-e2e-job");
    let mut child = Command::new(runner)
        .args(["--controlled", "--cleanup-bound-ms", "5000", "--log"])
        .arg(fixture.0.join("target.log"))
        .arg("--")
        .arg(test_executable)
        .args(["--exact", ROOT_TEST, "--nocapture"])
        .env(ROLE_ENV, ROOT_ROLE)
        .env(ROOT_ENV, &fixture.0)
        .env(STAY_ENV, "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("starts the controlled Job runner");
    wait_until(fixture.0.join("descendant.ready").as_path(), READY_BOUND);
    child
        .stdin
        .as_mut()
        .expect("keeps runner control stdin open")
        .write_all(b"x")
        .expect("writes non-EOF control data");
    // Ten runner poll intervals are enough to observe the prior one-byte bug
    // while staying far below the fixture's authoritative lifetime bound.
    std::thread::sleep(POLL_INTERVAL * 10);
    assert!(
        child
            .try_wait()
            .expect("observes controlled runner")
            .is_none(),
        "non-EOF stdin data must not request teardown"
    );
    assert!(
        OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(fixture.0.join("descendant.lock"))
            .is_err(),
        "the descendant witness must remain held before EOF"
    );

    drop(child.stdin.take());
    let output = wait_with_output_bounded(&mut child, RUNNER_BOUND);
    assert!(
        output.status.success(),
        "controlled runner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn nested_job_runners_reap_a_naturally_exited_tree() {
    let fixture = FixtureDirectory::new();
    let test_executable = std::env::current_exe().expect("resolves the test executable");
    let runner = env!("CARGO_BIN_EXE_piui-e2e-job");
    let mut child = Command::new(runner)
        .args(["--cleanup-bound-ms", "5000", "--"])
        .arg(runner)
        .args(["--cleanup-bound-ms", "5000", "--"])
        .arg(test_executable)
        .args(["--exact", ROOT_TEST, "--nocapture"])
        .env(ROLE_ENV, ROOT_ROLE)
        .env(ROOT_ENV, &fixture.0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("starts nested Job runners");
    let output = wait_with_output_bounded(&mut child, RUNNER_BOUND);
    assert!(
        output.status.success(),
        "nested runner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let control = String::from_utf8(output.stdout).expect("runner control output is UTF-8");
    assert_eq!(control.matches("{\"type\":\"started\"}\n").count(), 2);
    assert_eq!(
        control
            .matches("{\"type\":\"terminated\",\"activeProcesses\":0,\"jobClosed\":true}\n")
            .count(),
        2
    );
    OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(fixture.0.join("descendant.lock"))
        .expect("nested teardown releases the descendant witness before success");
}

#[test]
#[allow(
    clippy::zombie_processes,
    reason = "the outer test's Job runner owns and proves descendant cleanup after this synthetic root exits"
)]
fn synthetic_root_fixture() {
    if std::env::var(ROLE_ENV).ok().as_deref() != Some(ROOT_ROLE) {
        return;
    }
    let root = fixture_root();
    let executable = std::env::current_exe().expect("resolves the synthetic test executable");
    let _descendant = Command::new(executable)
        .args(["--exact", DESCENDANT_TEST, "--nocapture"])
        .env(ROLE_ENV, DESCENDANT_ROLE)
        .env(ROOT_ENV, &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("starts exactly one synthetic descendant");
    wait_until(root.join("descendant.ready").as_path(), READY_BOUND);
    if std::env::var(STAY_ENV).ok().as_deref() == Some("true") {
        std::thread::sleep(FIXTURE_MAX_LIFETIME);
    }
    // Returning is deliberate in the root-exit case: the Job runner must still
    // close the Job and remove the descendant before it can report success.
}

#[test]
fn synthetic_descendant_fixture() {
    if std::env::var(ROLE_ENV).ok().as_deref() != Some(DESCENDANT_ROLE) {
        return;
    }
    let root = fixture_root();
    let _witness = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(0)
        .open(root.join("descendant.lock"))
        .expect("holds the synthetic descendant witness exclusively");
    fs::write(root.join("descendant.ready"), b"ready")
        .expect("publishes synthetic descendant readiness");
    std::thread::sleep(FIXTURE_MAX_LIFETIME);
}

fn fixture_root() -> PathBuf {
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("fixture receives its root"));
    fs::canonicalize(root).expect("canonicalizes the fixture root")
}

fn wait_until(path: &Path, bound: Duration) {
    let deadline = Instant::now() + bound;
    while Instant::now() < deadline {
        if path.is_file() {
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    panic!("synthetic fixture did not become ready");
}

fn run_runner_bounded<const N: usize>(arguments: [&str; N]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_piui-e2e-job"))
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("starts the Job runner");
    wait_with_output_bounded(&mut child, RUNNER_BOUND)
}

fn wait_with_output_bounded(child: &mut Child, bound: Duration) -> Output {
    let deadline = Instant::now() + bound;
    loop {
        if child.try_wait().expect("observes the Job runner").is_some() {
            let status = child.wait().expect("reaps the Job runner");
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            child
                .stdout
                .take()
                .expect("captures runner stdout")
                .read_to_end(&mut stdout)
                .expect("reads runner stdout");
            child
                .stderr
                .take()
                .expect("captures runner stderr")
                .read_to_end(&mut stderr)
                .expect("reads runner stderr");
            return Output {
                status,
                stdout,
                stderr,
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Job runner exceeded its test bound");
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
