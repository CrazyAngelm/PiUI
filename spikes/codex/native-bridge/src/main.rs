//! Spike-only contained native launcher.
//!
//! On Windows, the target starts suspended, enters PiUI's verified Job Object,
//! and only then resumes. Stdio is inherited unchanged so the probe can speak
//! Codex app-server JSONL directly. This is evidence, not a production adapter.

#[cfg(not(windows))]
fn main() {
    eprintln!("piui-codex-native-bridge: Windows-only spike fixture");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    match windows::run() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("piui-codex-native-bridge: {message}");
            std::process::exit(2);
        }
    }
}

#[cfg(windows)]
mod windows {
    use piui_platform::{ProcessContainment as _, ProcessId, SuspendedProcess, WindowsJob};
    use std::ffi::OsString;
    use std::os::windows::process::CommandExt as _;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const POLL_INTERVAL: Duration = Duration::from_millis(20);
    const CLEANUP_BOUND: Duration = Duration::from_secs(5);

    pub(crate) fn run() -> Result<i32, &'static str> {
        let (max_runtime, program, arguments) = parse_arguments()?;
        let mut job = WindowsJob::new().map_err(|_| "could not create verified Job Object")?;
        let mut child = Command::new(program)
            .args(arguments)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .spawn()
            .map_err(|_| "could not start native target suspended")?;

        let process_id = ProcessId::new(child.id()).map_err(|_| "native target has invalid PID")?;
        let assignment =
            match job.assign_before_resume(SuspendedProcess::from_created_suspended(process_id)) {
                Ok(assignment) => assignment,
                Err(_) => {
                    terminate_unassigned(&mut child);
                    return Err("could not assign native target before resume");
                }
            };
        if job.resume_assigned(assignment).is_err() {
            let _ = job.force_terminate_tree();
            let _ = prove_empty_and_reaped(&job, &mut child);
            let _ = job.close();
            return Err("could not resume contained native target");
        }

        let deadline = Instant::now() + max_runtime;
        let (status, timed_out) = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "could not observe native target")?
            {
                break (Some(status), false);
            }
            if Instant::now() >= deadline {
                break (None, true);
            }
            std::thread::sleep(POLL_INTERVAL);
        };

        // The root may have left descendants. Terminating the still-open Job is
        // idempotent for an empty Job and force-cleans every remaining process.
        job.force_terminate_tree()
            .map_err(|_| "could not terminate remaining native descendants")?;
        prove_empty_and_reaped(&job, &mut child)?;
        job.close()
            .map_err(|_| "could not close native Job Object")?;
        if timed_out {
            return Ok(124);
        }
        Ok(status.and_then(|value| value.code()).unwrap_or(1))
    }

    fn parse_arguments() -> Result<(Duration, OsString, Vec<OsString>), &'static str> {
        let mut values = std::env::args_os().skip(1);
        if values.next().as_deref() != Some(std::ffi::OsStr::new("--max-runtime-ms")) {
            return Err("expected `--max-runtime-ms <milliseconds>`");
        }
        let raw_bound = values.next().ok_or("maximum runtime is required")?;
        let milliseconds = raw_bound
            .to_str()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .ok_or("maximum runtime must be a positive integer")?;
        if values.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
            return Err("expected `-- <native-program> [args...]`");
        }
        let program = values.next().ok_or("native program is required")?;
        Ok((
            Duration::from_millis(milliseconds),
            program,
            values.collect(),
        ))
    }

    fn prove_empty_and_reaped(job: &WindowsJob, child: &mut Child) -> Result<(), &'static str> {
        let deadline = Instant::now() + CLEANUP_BOUND;
        let mut root_reaped = false;
        loop {
            if !root_reaped {
                root_reaped = child
                    .try_wait()
                    .map_err(|_| "could not reap terminated native target")?
                    .is_some();
            }
            let empty = job
                .active_process_count()
                .map_err(|_| "could not query contained native processes")?
                == 0;
            if root_reaped && empty {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("contained native tree did not become empty");
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn terminate_unassigned(child: &mut Child) {
        let _ = child.kill();
        let deadline = Instant::now() + CLEANUP_BOUND;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}
