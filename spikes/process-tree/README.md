# SPIKE-02 — host-side process-tree containment

A Python 3.13-only, synthetic harness for the Phase 0 shutdown/process-tree gate. It tests the host boundary, not a model turn: it launches the installed Pi **npm shim** in RPC mode, sends exactly one direct `bash` RPC command for the bundled sleeping fixture, closes RPC stdin, and verifies that host containment removes the fixture.

This directory is intentionally self-contained. It does not read, alter, or report a real Pi session, project resource, `auth.json`, prompt, provider configuration, credential, or tool output.

## Run on Windows

```powershell
py -3.13 spikes/process-tree/harness.py --self-test
py -3.13 spikes/process-tree/run_tests.py
py -3.13 spikes/process-tree/harness.py --pi pi --report spikes/process-tree/reports/latest.json
```

The Windows launcher resolves `pi` to an npm `.cmd`/`.bat` shim and invokes it as an argument array through `cmd /d /c call`; it does not build a shell command string. A non-shim candidate fails before the runtime starts.

Exit `0` means this bounded fixture passed. Exit `1` means the report is a failure and must not be converted into a process-cleanup claim. Reports use schema v2; a v1 capture is deliberately not accepted as current pass evidence.

## Capture binding without paths or secrets

At capture start the harness creates an opaque UUID run ID and UTC timestamp. It hashes its own `harness.py` source with SHA-256 and records the fixed harness ID/version. Before containment launch it resolves the npm shim **once**, records only its SHA-256 and a strictly sanitized one-line Pi semver from `--version`, then uses that same resolved shim for the RPC process. The version probe uses the same temporary cwd/config/environment, disconnected stdin, discarded stderr, and a five-second bound.

A passing report must contain a valid UTC timestamp, run ID, current source hash/version identity, `npm-cmd-shim` hash, and safe Pi version. No launcher path, package path, raw version output, stderr, command, environment value, prompt, credential, or process ID is emitted. If the version cannot be parsed as a bounded semver-like value, the run fails rather than storing untrusted output.

## Isolation and test boundary

Every run creates and deletes a fresh temporary root containing its cwd, home, Pi agent directory, session directory, app-data directories, and temp directory. The process receives a small allowlisted environment with `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`, and no inherited provider/auth/Pi/project variables. It starts with:

```text
--mode rpc --no-session --offline --no-tools --no-extensions --no-skills
--no-prompt-templates --no-themes --no-context-files --no-approve
```

The sole deliberate exception to `--no-tools` is Pi's documented direct `bash` RPC. Its command is constructed solely from harness-owned paths and starts `fixtures/sleeping_child.py`; it writes its own PID to a temporary ready file and sleeps for 30 seconds. No `prompt` RPC is sent, so no provider request can occur. Pi may create files inside the disposable temporary agent directory; none are read as credentials or retained after cleanup.

RPC stdin/stdout are binary. The decoder splits stdout only on byte `0x0A`, permits an immediately preceding `0x0D`, and rejects invalid UTF-8, invalid JSON, oversized frames, and incomplete EOF frames. Stderr is drained separately and never included in the report.

## Windows containment flow

```text
[Create Job Object]
        |
        v
[Set + query KILL_ON_JOB_CLOSE]
        |
        v
[Create npm-shim cmd.exe suspended]
        |
        v
[Assign cmd.exe to Job] -- failure --> [kill suspended root / fail]
        |
        v
[Resume primary thread] -> [Pi RPC] -> [direct bash fixture ready]
        |
        v
[Close stdin / graceful EOF]
        |
        +-- Pi still alive after EOF grace --> [timeout escalation: close Job]
        |
        +-- Pi exits within EOF grace -------> [still close Job]
                                                |
                                                v
                                  [KILL_ON_JOB_CLOSE terminates Job tree]
                                                |
                                                v
                           [check fixture PID + pre-close Job PID snapshot]
                                                |
                         +----------------------+---------------------+
                         |                                            |
                       all dead                                  any survives
                         |                                            |
                       [PASS]                   [emergency fixture cleanup / FAIL]
```

The launch suspension is important: `AssignProcessToJobObject` happens before `ResumeThread`, so Pi cannot create a descendant in the gap. The job handle is not inherited. Closing the final host handle is therefore the tested hard-stop operation. The harness closes the Job **even when EOF already made the Pi wrapper exit**: parent exit alone is not evidence that a direct-bash descendant exited.

### Timeout values

| Phase | Value | Action on expiry |
|---|---:|---|
| Safe Pi version probe | 5 s | fail; never record raw launcher output |
| Fixture ready | 8 s | fail, close containment, clean temporary root |
| Graceful EOF | 2 s | close Job Object on Windows |
| Post-Job proof | 5 s | fail and emergency-clean the known fixture only |
| Unix `SIGTERM` grace | 2 s | send `SIGKILL` to the runtime process group |
| Unix `SIGKILL` observation | 2 s | fail and emergency-clean the known fixture only |

A normal Windows pass can have either EOF outcome. In both cases the Job closes afterward to enforce descendant cleanup.

## What a Windows pass proves

The report contract permits `status: "pass"` only when it records all of the following:

- a real Job Object was created and its `KILL_ON_JOB_CLOSE` flag was queried as enabled;
- the shim root was assigned before it was resumed;
- the fixture wrote a PID and that PID appeared in a live `JobObjectBasicProcessIdList` snapshot before closure;
- stdin was closed for the graceful path, the Job was then closed, and the known fixture PID was dead afterward;
- every PID in the pre-close live Job snapshot was dead afterward;
- no emergency cleanup was used; and
- the capture binding identifies the UTC run, exact current harness source/hash/version, and safe hashed/versioned Pi launcher.

`reports/latest.json` is the sanitized captured Windows result. It records containment booleans/counts plus the safe capture timestamp/run ID/harness hash/version/runtime hash/version; it never records temporary paths, process IDs, environment values, raw version output, command text, stderr, RPC output, prompts, or credentials.

## Unix design and implementation branch

`harness.py` also implements a Unix branch. It launches Pi with `start_new_session=True`, verifies that the runtime is its own process-group leader, applies EOF, then sends `SIGTERM` and (if needed) `SIGKILL` to that process group. It separately checks the known fixture PID and marks the run failed if the fixture survives or emergency cleanup is needed.

This is a **design/implementation branch, not a result of the Windows run**. Current Pi direct-bash internals may create a detached shell on Unix, which can escape the runtime process group. Consequently the Unix branch intentionally does not infer containment from `killpg` alone. A Unix `pass` requires: new-session/group-leader proof, direct-bash dispatch, fixture readiness/PID, fixture membership in that runtime group before EOF, EOF sent, runtime death after escalation, fixture death after escalation, no protocol error, and no emergency cleanup. Run it on each supported Unix target and retain that platform's report before claiming Unix cleanup support.

## Limits

- A child that deliberately breaks away from the Windows Job or Unix process group is outside the respective primitive; the harness reports failure if the known fixture survives.
- The Job Object test covers live Job members and the one owned fixture, not arbitrary daemonization, model-initiated tools, or a malicious process that escapes containment.
- A Job assignment failure (for example, incompatible pre-existing job policy) fails before Pi is resumed; it is not silently downgraded to parent-PID termination.
- Job/process-group containment is lifecycle management, **not** a sandbox. Pi and tools still have the local user's permissions.
- The Windows report does not test Linux/macOS behavior. The Unix branch must be run separately.

See [DECISION.md](DECISION.md) for the Phase 0 decision and remaining R-02 limitations.
