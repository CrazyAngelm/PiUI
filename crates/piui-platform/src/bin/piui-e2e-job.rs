//! Debug-only Windows Job Object runner for the Tauri WebView2 E2E harness.
//!
//! The `e2e-harness` feature is required to build this binary, so normal PiUI
//! packages do not contain a general process launcher. The runner creates its
//! target suspended, assigns it to PiUI's verified Job Object primitive, then
//! resumes it. A controlled runner treats stdin EOF as a teardown request.

#[cfg(not(windows))]
fn main() {
    eprintln!("piui-e2e-job is Windows-only");
    std::process::exit(2);
}

#[cfg(windows)]
mod windows {
    use piui_platform::{ProcessContainment, ProcessId, SuspendedProcess, WindowsJob};
    use std::ffi::OsString;
    use std::fs::{File, OpenOptions};
    use std::io::{Read as _, Write as _};
    use std::os::windows::process::CommandExt as _;
    use std::path::PathBuf;
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const RUNNER_PATH_ENV: &str = "PIUI_E2E_JOB_RUNNER";
    const ACTIVE_POLL_INTERVAL: Duration = Duration::from_millis(20);

    #[derive(Clone, Copy)]
    pub(crate) enum FailurePhase {
        Arguments,
        Launch,
        Observe,
        Cleanup,
        Control,
    }

    impl FailurePhase {
        pub(crate) const fn as_str(self) -> &'static str {
            match self {
                Self::Arguments => "arguments",
                Self::Launch => "launch",
                Self::Observe => "observe",
                Self::Cleanup => "cleanup",
                Self::Control => "control",
            }
        }
    }

    pub(crate) struct RunnerError {
        pub(crate) phase: FailurePhase,
        pub(crate) message: &'static str,
    }

    impl RunnerError {
        const fn new(phase: FailurePhase, message: &'static str) -> Self {
            Self { phase, message }
        }
    }

    struct Arguments {
        controlled: bool,
        cleanup_bound: Duration,
        log_path: Option<PathBuf>,
        program: OsString,
        program_args: Vec<OsString>,
    }

    struct AssignedChild {
        child: Child,
        job: WindowsJob,
    }

    impl AssignedChild {
        fn spawn(arguments: &Arguments) -> Result<Self, &'static str> {
            let mut job = WindowsJob::new().map_err(|_| "could not create the E2E Job Object")?;
            let runner =
                std::env::current_exe().map_err(|_| "could not resolve the E2E Job runner")?;
            let mut command = Command::new(&arguments.program);
            command
                .args(&arguments.program_args)
                .env(RUNNER_PATH_ENV, runner)
                .stdin(Stdio::null())
                .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
            if let Some(log_path) = &arguments.log_path {
                let stdout = create_log(log_path)?;
                let stderr = stdout
                    .try_clone()
                    .map_err(|_| "could not duplicate the contained E2E log")?;
                command
                    .stdout(Stdio::from(stdout))
                    .stderr(Stdio::from(stderr));
            }

            let mut child = command
                .spawn()
                .map_err(|_| "could not start the contained E2E process")?;
            let process_id = ProcessId::new(child.id())
                .map_err(|_| "the contained E2E process had no valid ID")?;
            let assignment = match job
                .assign_before_resume(SuspendedProcess::from_created_suspended(process_id))
            {
                Ok(assignment) => assignment,
                Err(_) => {
                    terminate_unassigned_child(&mut child);
                    return Err("the E2E process could not enter its Job Object");
                }
            };
            if job.resume_assigned(assignment).is_err() {
                let _ = job.force_terminate_tree();
                let _ = child.wait();
                let _ = job.close();
                return Err("the contained E2E process could not resume");
            }
            emit_control(r#"{"type":"started"}"#)?;
            Ok(Self { child, job })
        }

        fn wait_or_control(
            &mut self,
            controlled: bool,
        ) -> Result<(Option<ExitStatus>, bool), &'static str> {
            let control = controlled.then(spawn_control_waiter);
            loop {
                if let Some(status) = self
                    .child
                    .try_wait()
                    .map_err(|_| "could not observe the contained E2E process")?
                {
                    return Ok((Some(status), false));
                }
                if let Some(receiver) = &control {
                    match receiver.try_recv() {
                        Ok(Ok(())) => return Ok((None, true)),
                        Ok(Err(())) | Err(mpsc::TryRecvError::Disconnected) => {
                            return Err("could not read the controlled E2E stdin to EOF");
                        }
                        Err(mpsc::TryRecvError::Empty) => {}
                    }
                }
                std::thread::sleep(ACTIVE_POLL_INTERVAL);
            }
        }

        fn terminate_and_prove_empty(
            &mut self,
            cleanup_bound: Duration,
        ) -> Result<(), &'static str> {
            let terminate_error = self.job.force_terminate_tree().err();
            let deadline = Instant::now() + cleanup_bound;
            let mut empty = false;
            loop {
                match self.job.active_process_count() {
                    Ok(0) => {
                        empty = true;
                        break;
                    }
                    Ok(_) if Instant::now() < deadline => {
                        std::thread::sleep(ACTIVE_POLL_INTERVAL);
                    }
                    Ok(_) | Err(_) => break,
                }
            }
            let close_error = self.job.close().err();
            let wait_error = self.child.wait().err();
            if terminate_error.is_some() || close_error.is_some() || wait_error.is_some() || !empty
            {
                return Err("the E2E Job tree did not reach a proven empty state");
            }
            Ok(())
        }
    }

    fn emit_control(record: &str) -> Result<(), &'static str> {
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(record.as_bytes())
            .and_then(|_| stdout.write_all(b"\n"))
            .and_then(|_| stdout.flush())
            .map_err(|_| "could not write the E2E Job control record")
    }

    fn create_log(path: &PathBuf) -> Result<File, &'static str> {
        if !path.is_absolute() {
            return Err("the contained E2E log path must be absolute");
        }
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| "could not create the contained E2E log")
    }

    fn terminate_unassigned_child(child: &mut Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    fn spawn_control_waiter() -> mpsc::Receiver<Result<(), ()>> {
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut byte = [0_u8; 1];
            loop {
                match stdin.read(&mut byte) {
                    Ok(0) => {
                        let _ = sender.send(Ok(()));
                        return;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        let _ = sender.send(Err(()));
                        return;
                    }
                }
            }
        });
        receiver
    }

    fn parse_arguments() -> Result<Arguments, &'static str> {
        let mut values = std::env::args_os().skip(1).peekable();
        let mut controlled = false;
        let mut cleanup_bound_ms = None;
        let mut log_path = None;
        while let Some(value) = values.peek() {
            if value == "--" {
                values.next();
                break;
            }
            if value == "--controlled" {
                controlled = true;
                values.next();
                continue;
            }
            if value == "--cleanup-bound-ms" {
                values.next();
                let raw = values.next().ok_or("--cleanup-bound-ms requires a value")?;
                let raw = raw
                    .to_str()
                    .ok_or("the cleanup bound must be UTF-8 digits")?;
                let parsed = raw
                    .parse::<u64>()
                    .ok()
                    .filter(|value| *value > 0)
                    .ok_or("the cleanup bound must be a positive integer")?;
                cleanup_bound_ms = Some(parsed);
                continue;
            }
            if value == "--log" {
                values.next();
                let raw = values.next().ok_or("--log requires a path")?;
                log_path = Some(PathBuf::from(raw));
                continue;
            }
            break;
        }
        let program = values.next().ok_or("an E2E program is required")?;
        let cleanup_bound_ms = cleanup_bound_ms.ok_or("--cleanup-bound-ms is required")?;
        if controlled && log_path.is_none() {
            return Err("--controlled requires --log");
        }
        Ok(Arguments {
            controlled,
            cleanup_bound: Duration::from_millis(cleanup_bound_ms),
            log_path,
            program,
            program_args: values.collect(),
        })
    }

    pub fn run() -> Result<i32, RunnerError> {
        let arguments = parse_arguments()
            .map_err(|message| RunnerError::new(FailurePhase::Arguments, message))?;
        let mut owned = AssignedChild::spawn(&arguments)
            .map_err(|message| RunnerError::new(FailurePhase::Launch, message))?;
        let outcome = owned.wait_or_control(arguments.controlled);
        owned
            .terminate_and_prove_empty(arguments.cleanup_bound)
            .map_err(|message| RunnerError::new(FailurePhase::Cleanup, message))?;
        let (status, controlled_stop) =
            outcome.map_err(|message| RunnerError::new(FailurePhase::Observe, message))?;
        emit_control(r#"{"type":"terminated","activeProcesses":0,"jobClosed":true}"#)
            .map_err(|message| RunnerError::new(FailurePhase::Control, message))?;
        if controlled_stop {
            Ok(0)
        } else {
            Ok(status.and_then(|status| status.code()).unwrap_or(1))
        }
    }
}

#[cfg(windows)]
fn main() {
    match windows::run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            if matches!(error.phase, windows::FailurePhase::Launch) {
                println!("{{\"type\":\"spawn_error\"}}");
            } else {
                println!(
                    "{{\"type\":\"runner_error\",\"phase\":\"{}\"}}",
                    error.phase.as_str()
                );
            }
            eprintln!("piui-e2e-job: {}", error.message);
            std::process::exit(2);
        }
    }
}
