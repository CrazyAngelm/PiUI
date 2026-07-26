#!/usr/bin/env python3
"""SPIKE-02 host-side process-tree containment harness.

The harness is deliberately narrow: it opens an isolated Pi RPC process, sends one
trusted direct ``bash`` RPC command that starts the bundled sleeping fixture, then
closes stdin and tears down the host containment boundary.  It never submits a
prompt or reads a real Pi configuration/session/credential.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from ctypes import wintypes
from pathlib import Path
from typing import Any

PYTHON_MINIMUM = (3, 13)
REPORT_SCHEMA_VERSION = 2
HARNESS_ID = "piui-spike-02-process-tree-python-3.13"
HARNESS_VERSION = "2"
MAX_FRAME_BYTES = 32 * 1024 * 1024
VERSION_PROBE_SECONDS = 5.0
CHILD_READY_SECONDS = 8.0
EOF_GRACE_SECONDS = 2.0
POST_CLOSE_SECONDS = 5.0
UNIX_TERM_GRACE_SECONDS = 2.0
UNIX_KILL_GRACE_SECONDS = 2.0
CHILD_SLEEP_SECONDS = 30.0

# Windows Job Object constants from winnt.h / jobapi2.h.
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
ERROR_MORE_DATA = 234
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
CREATE_SUSPENDED = 0x00000004
TH32CS_SNAPTHREAD = 0x00000004
THREAD_SUSPEND_RESUME = 0x0002
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
SAFE_PI_VERSION_PATTERN = re.compile(
    r"v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]{0,63})?"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def harness_source_sha256() -> str:
    return sha256_file(Path(__file__))


def capture_timestamp_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def is_sha256(value: object) -> bool:
    return isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None


def is_safe_pi_version(value: object) -> bool:
    return isinstance(value, str) and SAFE_PI_VERSION_PATTERN.fullmatch(value) is not None


class HarnessFailure(RuntimeError):
    """Expected harness setup/containment failure without sensitive detail."""


class LfJsonlDecoder:
    """Incremental RPC decoder that treats only byte 0x0A as a delimiter."""

    def __init__(self, max_frame_bytes: int = MAX_FRAME_BYTES) -> None:
        self._buffer = bytearray()
        self._max_frame_bytes = max_frame_bytes
        self.empty_frames = 0

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        self._buffer.extend(chunk)
        frames: list[dict[str, Any]] = []
        while True:
            newline = self._buffer.find(b"\n")
            if newline < 0:
                if len(self._buffer) > self._max_frame_bytes:
                    raise ValueError("frame_limit_exceeded")
                return frames
            raw = bytes(self._buffer[:newline])
            del self._buffer[: newline + 1]
            if raw.endswith(b"\r"):
                raw = raw[:-1]
            if not raw:
                self.empty_frames += 1
                continue
            if len(raw) > self._max_frame_bytes:
                raise ValueError("frame_limit_exceeded")
            try:
                decoded = json.loads(raw.decode("utf-8", errors="strict"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(f"invalid_jsonl_frame:{type(error).__name__}") from error
            if not isinstance(decoded, dict):
                raise ValueError("jsonl_frame_is_not_object")
            frames.append(decoded)

    def finish(self) -> None:
        if self._buffer:
            raise ValueError("incomplete_frame_at_eof")


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class THREADENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ThreadID", wintypes.DWORD),
        ("th32OwnerProcessID", wintypes.DWORD),
        ("tpBasePri", wintypes.LONG),
        ("tpDeltaPri", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
    ]


class WindowsApi:
    """Small typed ctypes boundary for exactly the Job/process APIs this spike needs."""

    def __init__(self) -> None:
        if os.name != "nt":
            raise HarnessFailure("windows_api_requested_on_non_windows")
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.QueryInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
        kernel32.Thread32First.restype = wintypes.BOOL
        kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
        kernel32.Thread32Next.restype = wintypes.BOOL
        kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenThread.restype = wintypes.HANDLE
        kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
        kernel32.ResumeThread.restype = wintypes.DWORD
        kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateProcess.restype = wintypes.BOOL
        self.kernel32 = kernel32

    @staticmethod
    def _handle_value(handle: wintypes.HANDLE) -> int | None:
        return ctypes.cast(handle, ctypes.c_void_p).value

    def check(self, result: int, operation: str) -> None:
        if not result:
            code = ctypes.get_last_error()
            raise OSError(code, f"{operation}_failed")

    def close_handle(self, handle: wintypes.HANDLE) -> None:
        self.check(self.kernel32.CloseHandle(handle), "close_handle")


_windows_api: WindowsApi | None = None


def windows_api() -> WindowsApi:
    global _windows_api
    if _windows_api is None:
        _windows_api = WindowsApi()
    return _windows_api


class WindowsJob:
    """A real Job Object configured with KILL_ON_JOB_CLOSE before any child runs."""

    def __init__(self) -> None:
        api = windows_api()
        handle = api.kernel32.CreateJobObjectW(None, None)
        if not handle:
            api.check(0, "create_job_object")
        self._api = api
        self._handle: wintypes.HANDLE | None = handle
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        try:
            api.check(
                api.kernel32.SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    ctypes.byref(info),
                    ctypes.sizeof(info),
                ),
                "set_job_kill_on_close",
            )
            self.kill_on_close_enabled = bool(
                self.limit_flags() & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            )
            if not self.kill_on_close_enabled:
                raise HarnessFailure("job_kill_on_close_not_confirmed")
        except Exception:
            try:
                api.close_handle(handle)
            except OSError:
                pass
            self._handle = None
            raise

    @property
    def handle(self) -> wintypes.HANDLE:
        if self._handle is None:
            raise HarnessFailure("job_already_closed")
        return self._handle

    def limit_flags(self) -> int:
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        returned = wintypes.DWORD()
        self._api.check(
            self._api.kernel32.QueryInformationJobObject(
                self.handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(info),
                ctypes.sizeof(info),
                ctypes.byref(returned),
            ),
            "query_job_limits",
        )
        return int(info.BasicLimitInformation.LimitFlags)

    def assign_process(self, pid: int) -> None:
        process = self._api.kernel32.OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            False,
            pid,
        )
        if not process:
            self._api.check(0, "open_process_for_job_assignment")
        try:
            self._api.check(
                self._api.kernel32.AssignProcessToJobObject(self.handle, process),
                "assign_process_to_job",
            )
        finally:
            self._api.close_handle(process)

    def members(self) -> set[int]:
        """Return the live PID snapshot exposed by JobObjectBasicProcessIdList."""
        capacity = 16
        header_bytes = ctypes.sizeof(wintypes.DWORD) * 2
        while capacity <= 4096:
            size = header_bytes + ctypes.sizeof(ctypes.c_size_t) * capacity
            buffer = ctypes.create_string_buffer(size)
            returned = wintypes.DWORD()
            success = self._api.kernel32.QueryInformationJobObject(
                self.handle,
                JOB_OBJECT_BASIC_PROCESS_ID_LIST,
                buffer,
                size,
                ctypes.byref(returned),
            )
            if not success:
                error = ctypes.get_last_error()
                if error == ERROR_MORE_DATA:
                    capacity *= 2
                    continue
                raise OSError(error, "query_job_processes_failed")
            counts = (wintypes.DWORD * 2).from_buffer(buffer)
            listed = int(counts[1])
            if listed > capacity:
                capacity = listed
                continue
            if listed == 0:
                return set()
            values = (ctypes.c_size_t * listed).from_buffer(buffer, header_bytes)
            return {int(value) for value in values if value}
        raise HarnessFailure("job_member_snapshot_too_large")

    def close(self) -> None:
        if self._handle is None:
            return
        handle = self._handle
        self._api.close_handle(handle)
        self._handle = None

    def terminate_then_close(self) -> None:
        """Emergency cleanup only; a passing result must use close(), not this path."""
        if self._handle is None:
            return
        try:
            self._api.kernel32.TerminateJobObject(self._handle, 1)
        finally:
            self.close()


def resume_suspended_primary_thread(pid: int) -> None:
    """Resume the one initial thread created with CREATE_SUSPENDED after Job assignment."""
    api = windows_api()
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        snapshot = api.kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
        if WindowsApi._handle_value(snapshot) == INVALID_HANDLE_VALUE:
            api.check(0, "create_thread_snapshot")
        thread_id: int | None = None
        try:
            entry = THREADENTRY32()
            entry.dwSize = ctypes.sizeof(entry)
            found = api.kernel32.Thread32First(snapshot, ctypes.byref(entry))
            while found:
                if int(entry.th32OwnerProcessID) == pid:
                    thread_id = int(entry.th32ThreadID)
                    break
                found = api.kernel32.Thread32Next(snapshot, ctypes.byref(entry))
        finally:
            api.close_handle(snapshot)
        if thread_id is not None:
            thread = api.kernel32.OpenThread(THREAD_SUSPEND_RESUME, False, thread_id)
            if not thread:
                api.check(0, "open_suspended_primary_thread")
            try:
                previous_suspend_count = api.kernel32.ResumeThread(thread)
                if previous_suspend_count == 0xFFFFFFFF:
                    api.check(0, "resume_suspended_primary_thread")
                return
            finally:
                api.close_handle(thread)
        time.sleep(0.01)
    raise HarnessFailure("suspended_primary_thread_not_found")


def process_alive(pid: int) -> bool:
    """Check liveness without a Windows-invalid os.kill(pid, 0) probe."""
    if os.name == "nt":
        api = windows_api()
        handle = api.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = wintypes.DWORD()
            if not api.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return True
            return int(exit_code.value) == STILL_ACTIVE
        finally:
            try:
                api.close_handle(handle)
            except OSError:
                pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    if sys.platform.startswith("linux"):
        try:
            state = Path(f"/proc/{pid}/stat").read_text(encoding="ascii").split(") ", 1)[1]
            return not state.startswith("Z")
        except (IndexError, OSError):
            pass
    return True


def wait_for_dead(pids: set[int], timeout: float) -> set[int]:
    deadline = time.monotonic() + timeout
    remaining = {pid for pid in pids if process_alive(pid)}
    while remaining and time.monotonic() < deadline:
        time.sleep(0.05)
        remaining = {pid for pid in remaining if process_alive(pid)}
    return remaining


def terminate_owned_marker(pid: int) -> bool:
    """Last-resort cleanup for the known fixture PID only, never arbitrary descendants."""
    if not process_alive(pid):
        return False
    if os.name == "nt":
        api = windows_api()
        handle = api.kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if not handle:
            return False
        try:
            return bool(api.kernel32.TerminateProcess(handle, 1))
        finally:
            try:
                api.close_handle(handle)
            except OSError:
                pass
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return False
    deadline = time.monotonic() + 1.0
    while process_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    if process_alive(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return True


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def direct_bash_command(child: Path, ready_file: Path) -> str:
    """Build a command from harness-owned paths only; no input is user-controlled."""
    if os.name == "nt":
        script = "& {python} {child} '--ready' {ready} '--seconds' '{seconds}'".format(
            python=powershell_quote(str(sys.executable)),
            child=powershell_quote(str(child)),
            ready=powershell_quote(str(ready_file)),
            seconds=CHILD_SLEEP_SECONDS,
        )
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        return "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded
    return (
        f"exec {shell_quote(sys.executable)} {shell_quote(str(child))} "
        f"--ready {shell_quote(str(ready_file))} --seconds {CHILD_SLEEP_SECONDS}"
    )


def resolve_pi_launcher(pi: str) -> str:
    """Resolve the exact launcher once so the hash and spawned runtime cannot drift."""
    if os.name != "nt":
        candidate = shutil.which(pi) or pi
        if not Path(candidate).is_file():
            raise HarnessFailure("pi_launcher_not_readable")
        return candidate
    candidate = pi
    if not Path(candidate).suffix:
        candidate = shutil.which(f"{pi}.cmd") or shutil.which(pi) or pi
    if not candidate.lower().endswith((".cmd", ".bat")) or not Path(candidate).is_file():
        raise HarnessFailure("windows_pi_is_not_an_npm_cmd_shim")
    return candidate


def pi_argv(pi: str, arguments: list[str], *, launcher: str | None = None) -> list[str]:
    """Use npm's Windows .cmd shim without shell-string argument interpolation."""
    candidate = launcher or resolve_pi_launcher(pi)
    if os.name != "nt":
        return [candidate, *arguments]
    return [
        os.environ.get("COMSPEC", r"C:\\Windows\\System32\\cmd.exe"),
        "/d",
        "/c",
        "call",
        candidate,
        *arguments,
    ]


def safe_pi_version(raw: bytes) -> str | None:
    """Keep only one bounded semver-like line; never report raw launcher stdout."""
    try:
        value = raw.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        return None
    if len(value) > 80 or "\n" in value or "\r" in value or not is_safe_pi_version(value):
        return None
    return value


def probe_runtime_identity(
    pi: str, cwd: Path, environment: dict[str, str]
) -> tuple[str, dict[str, str]]:
    """Bind a run to a safe launcher hash and a sanitized Pi version only."""
    launcher = resolve_pi_launcher(pi)
    try:
        launcher_sha256 = sha256_file(Path(launcher))
    except OSError as error:
        raise HarnessFailure("pi_launcher_hash_unavailable") from error
    completed = subprocess.run(
        pi_argv(pi, ["--version"], launcher=launcher),
        cwd=cwd,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=VERSION_PROBE_SECONDS,
    )
    version = safe_pi_version(completed.stdout)
    if completed.returncode != 0 or version is None:
        raise HarnessFailure("safe_pi_version_probe_failed")
    return launcher, {
        "launcher_kind": "npm-cmd-shim" if os.name == "nt" else "pi-launcher",
        "launcher_sha256": launcher_sha256,
        "pi_version": version,
    }


def isolated_environment(root: Path) -> dict[str, str]:
    """Allow only runtime essentials; omit auth, provider, Pi, and project environment."""
    home = root / "home"
    agent_dir = root / "pi-agent"
    session_dir = root / "sessions"
    app_data = root / "appdata"
    local_app_data = root / "local-appdata"
    temp_dir = root / "temp"
    for directory in (home, agent_dir, session_dir, app_data, local_app_data, temp_dir):
        directory.mkdir(parents=True, exist_ok=True)
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "PI_CODING_AGENT_DIR": str(agent_dir),
        "PI_CODING_AGENT_SESSION_DIR": str(session_dir),
        "PI_OFFLINE": "1",
        "PI_TELEMETRY": "0",
        "PI_SKIP_VERSION_CHECK": "1",
        "NO_PROXY": "*",
        "HOME": str(home),
        "TEMP": str(temp_dir),
        "TMP": str(temp_dir),
        "PYTHONNOUSERSITE": "1",
    }
    if os.name == "nt":
        environment.update(
            {
                "SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\\Windows"),
                "WINDIR": os.environ.get("WINDIR", r"C:\\Windows"),
                "COMSPEC": os.environ.get("COMSPEC", r"C:\\Windows\\System32\\cmd.exe"),
                "PATHEXT": os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
                "USERPROFILE": str(home),
                "APPDATA": str(app_data),
                "LOCALAPPDATA": str(local_app_data),
                "ProgramFiles": os.environ.get("ProgramFiles", r"C:\\Program Files"),
            }
        )
    else:
        environment.update(
            {
                "XDG_CONFIG_HOME": str(app_data),
                "XDG_DATA_HOME": str(local_app_data),
                "XDG_CACHE_HOME": str(temp_dir),
            }
        )
    return environment


def rpc_arguments(root: Path) -> list[str]:
    return [
        "--mode",
        "rpc",
        "--no-session",
        "--session-dir",
        str(root / "sessions"),
        "--offline",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
    ]


class RpcProcess:
    """Binary stdin/stdout process wrapper with LF-only stdout validation."""

    def __init__(
        self,
        argv: list[str],
        cwd: Path,
        environment: dict[str, str],
        *,
        creationflags: int = 0,
        start_new_session: bool = False,
    ) -> None:
        self.process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            close_fds=True,
            creationflags=creationflags,
            start_new_session=start_new_session,
        )
        self.frames_seen = 0
        self.protocol_error: str | None = None
        self._readers_started = False
        self._threads: list[threading.Thread] = []

    @property
    def pid(self) -> int:
        return int(self.process.pid)

    def start_readers(self) -> None:
        if self._readers_started:
            return
        self._readers_started = True
        stdout = threading.Thread(target=self._drain_stdout, daemon=True)
        stderr = threading.Thread(target=self._drain_stderr, daemon=True)
        self._threads = [stdout, stderr]
        for thread in self._threads:
            thread.start()

    def _drain_stdout(self) -> None:
        assert self.process.stdout is not None
        decoder = LfJsonlDecoder()
        try:
            while chunk := os.read(self.process.stdout.fileno(), 4096):
                self.frames_seen += len(decoder.feed(chunk))
            decoder.finish()
        except (OSError, ValueError) as error:
            self.protocol_error = type(error).__name__

    def _drain_stderr(self) -> None:
        assert self.process.stderr is not None
        try:
            while os.read(self.process.stderr.fileno(), 4096):
                pass
        except OSError:
            pass

    def send(self, value: dict[str, Any]) -> None:
        if self.process.stdin is None or self.process.stdin.closed:
            raise HarnessFailure("rpc_stdin_unavailable")
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.process.stdin.write(encoded + b"\n")
        self.process.stdin.flush()

    def close_stdin(self) -> None:
        if self.process.stdin is None or self.process.stdin.closed:
            return
        try:
            self.process.stdin.close()
        except OSError:
            pass

    def wait(self, timeout: float) -> bool:
        try:
            self.process.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    def kill_root(self) -> None:
        if self.process.poll() is None:
            try:
                self.process.kill()
            except OSError:
                pass

    def dispose(self) -> None:
        self.close_stdin()
        for stream in (self.process.stdout, self.process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        for thread in self._threads:
            thread.join(timeout=0.2)


def wait_for_file(path: Path, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            return True
        time.sleep(0.05)
    return path.is_file()


def marker_pid(path: Path) -> int | None:
    try:
        payload = path.read_bytes().strip()
    except OSError:
        return None
    if not payload.isdigit():
        return None
    return int(payload)


def remove_sandbox(root: Path, timeout: float = 2.0) -> bool:
    """Retry deletion briefly while closed Windows process handles finish unwinding."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            shutil.rmtree(root)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            if time.monotonic() >= deadline:
                return not root.exists()
            time.sleep(0.05)


def base_report(platform: str) -> dict[str, Any]:
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "harness": HARNESS_ID,
        "capture": {
            "run_id": str(uuid.uuid4()),
            "timestamp_utc": capture_timestamp_utc(),
            "harness": {
                "id": HARNESS_ID,
                "version": HARNESS_VERSION,
                "source_sha256": harness_source_sha256(),
            },
        },
        "platform": platform,
        "status": "fail",
        "timeouts_seconds": {
            "runtime_version_probe": VERSION_PROBE_SECONDS,
            "child_ready": CHILD_READY_SECONDS,
            "eof_grace": EOF_GRACE_SECONDS,
            "post_containment_close": POST_CLOSE_SECONDS,
            "unix_term_grace": UNIX_TERM_GRACE_SECONDS,
            "unix_kill_grace": UNIX_KILL_GRACE_SECONDS,
        },
        "isolation": {
            "temporary_config_session_and_cwd": True,
            "no_session": True,
            "offline": True,
            "project_resources_disabled": True,
            "credentials_inherited": False,
            "provider_prompt_sent": False,
            "only_fixture_direct_bash_command": True,
        },
        "evidence": {},
        "limitations": [],
    }


def run_windows(pi: str) -> dict[str, Any]:
    report = base_report("windows")
    report["containment_backend"] = "windows-job-object-kill-on-close"
    report["unix_process_group"] = "not_run_on_windows"
    evidence: dict[str, Any] = report["evidence"]
    root = Path(tempfile.mkdtemp(prefix="piui-process-tree-"))
    project = root / "empty-project"
    project.mkdir()
    ready_file = root / "fixture-ready"
    child = Path(__file__).parent / "fixtures" / "sleeping_child.py"
    job: WindowsJob | None = None
    rpc: RpcProcess | None = None
    child_pid: int | None = None
    known_owned: set[int] = set()
    fallback_cleanup_used = False
    launcher: str | None = None
    try:
        environment = isolated_environment(root)
        launcher, runtime_identity = probe_runtime_identity(pi, project, environment)
        report["capture"]["runtime"] = runtime_identity
        job = WindowsJob()
        evidence["job_created"] = True
        evidence["kill_on_job_close_enabled"] = job.kill_on_close_enabled

        rpc = RpcProcess(
            pi_argv(pi, rpc_arguments(root), launcher=launcher),
            project,
            environment,
            creationflags=CREATE_SUSPENDED,
        )
        evidence["runtime_created_suspended"] = True
        job.assign_process(rpc.pid)
        evidence["runtime_assigned_before_resume"] = True
        resume_suspended_primary_thread(rpc.pid)
        evidence["runtime_resumed_after_assignment"] = True
        rpc.start_readers()

        rpc.send(
            {
                "id": f"spike-02-{uuid.uuid4()}",
                "type": "bash",
                "command": direct_bash_command(child, ready_file),
                "excludeFromContext": True,
            }
        )
        evidence["direct_bash_rpc_sent"] = True
        evidence["child_ready"] = wait_for_file(ready_file, CHILD_READY_SECONDS)
        child_pid = marker_pid(ready_file)
        evidence["fixture_child_pid_observed"] = child_pid is not None

        members_after_start = job.members()
        evidence["job_member_snapshot_available"] = True
        evidence["fixture_child_in_job_before_eof"] = (
            child_pid is not None and child_pid in members_after_start
        )

        rpc.close_stdin()
        evidence["graceful_eof_sent"] = True
        evidence["runtime_exited_within_eof_grace"] = rpc.wait(EOF_GRACE_SECONDS)
        evidence["eof_timeout_escalated_to_job_close"] = not evidence[
            "runtime_exited_within_eof_grace"
        ]

        members_before_close = job.members()
        known_owned = set(members_before_close)
        known_owned.add(rpc.pid)
        if child_pid is not None:
            known_owned.add(child_pid)
        evidence["owned_member_count_before_job_close"] = len(known_owned)
        evidence["fixture_child_in_job_before_close"] = (
            child_pid is not None and child_pid in members_before_close
        )

        evidence["job_close_called"] = True
        job.close()
        job = None
        evidence["job_closed"] = True

        evidence["runtime_dead_after_job_close"] = rpc.wait(POST_CLOSE_SECONDS)
        remaining = wait_for_dead(known_owned, POST_CLOSE_SECONDS)
        evidence["known_child_dead_after_job_close"] = (
            child_pid is not None and not process_alive(child_pid)
        )
        evidence["alive_owned_member_count_after_job_close"] = len(remaining)
        evidence["lf_protocol_error"] = rpc.protocol_error is not None
    except Exception as error:
        # Record only the exception category; no path, command, stderr, or RPC payload enters a report.
        evidence["failure_category"] = type(error).__name__
    finally:
        # Every cleanup action is independently guarded so a reporting/marker bug cannot strand a process.
        if job is not None:
            try:
                evidence["job_close_called"] = True
                job.close()
                evidence["job_closed"] = True
            except Exception as error:
                evidence["job_closed"] = False
                evidence.setdefault("cleanup_failure_category", type(error).__name__)
                try:
                    job.terminate_then_close()
                except Exception as terminate_error:
                    evidence.setdefault("cleanup_failure_category", type(terminate_error).__name__)
                fallback_cleanup_used = True
        if rpc is not None:
            try:
                rpc.close_stdin()
            except Exception as error:
                evidence.setdefault("cleanup_failure_category", type(error).__name__)
                fallback_cleanup_used = True
        # This is only an emergency cleanup after the evidence snapshot. A pass never uses it.
        try:
            if child_pid is None and wait_for_file(ready_file, 0.25):
                child_pid = marker_pid(ready_file)
            if child_pid is not None and process_alive(child_pid):
                fallback_cleanup_used = terminate_owned_marker(child_pid) or fallback_cleanup_used
        except Exception as error:
            evidence.setdefault("cleanup_failure_category", type(error).__name__)
            fallback_cleanup_used = True
        try:
            if rpc is not None and process_alive(rpc.pid):
                rpc.kill_root()
                rpc.wait(1.0)
                fallback_cleanup_used = True
        except Exception as error:
            evidence.setdefault("cleanup_failure_category", type(error).__name__)
            fallback_cleanup_used = True
        if rpc is not None:
            try:
                rpc.dispose()
            except Exception as error:
                evidence.setdefault("cleanup_failure_category", type(error).__name__)
                fallback_cleanup_used = True
        evidence["sandbox_removed"] = remove_sandbox(root)

    evidence["emergency_fixture_cleanup_used"] = fallback_cleanup_used
    required = (
        evidence.get("job_created") is True,
        evidence.get("kill_on_job_close_enabled") is True,
        evidence.get("runtime_created_suspended") is True,
        evidence.get("runtime_assigned_before_resume") is True,
        evidence.get("runtime_resumed_after_assignment") is True,
        evidence.get("direct_bash_rpc_sent") is True,
        evidence.get("child_ready") is True,
        evidence.get("fixture_child_pid_observed") is True,
        evidence.get("fixture_child_in_job_before_close") is True,
        evidence.get("graceful_eof_sent") is True,
        evidence.get("job_closed") is True,
        evidence.get("known_child_dead_after_job_close") is True,
        evidence.get("alive_owned_member_count_after_job_close") == 0,
        evidence.get("emergency_fixture_cleanup_used") is False,
    )
    report["status"] = "pass" if all(required) else "fail"
    report["limitations"] = [
        "The proof covers the live Job membership snapshot and the bundled fixture PID only.",
        "A process that deliberately breaks away from the Job before closure is outside this host containment boundary.",
        "This is not an OS sandbox; Pi tools still run with the invoking user's permissions.",
        "The Unix process-group branch is implemented separately and was not run by this Windows report.",
    ]
    return report


def signal_process_group(pgid: int, signum: int) -> bool:
    try:
        os.killpg(pgid, signum)
        return True
    except ProcessLookupError:
        return False


def run_unix(pi: str) -> dict[str, Any]:
    """Unix implementation branch: dedicated session/process group plus TERM/KILL escalation.

    It is intentionally separate from the Windows report. Pi's current direct-bash
    implementation may itself detach a shell on Unix, so the fixture check remains
    authoritative rather than assuming process-group membership.
    """
    report = base_report("unix")
    report["containment_backend"] = "unix-process-group"
    evidence: dict[str, Any] = report["evidence"]
    root = Path(tempfile.mkdtemp(prefix="piui-process-tree-"))
    project = root / "empty-project"
    project.mkdir()
    ready_file = root / "fixture-ready"
    child = Path(__file__).parent / "fixtures" / "sleeping_child.py"
    rpc: RpcProcess | None = None
    child_pid: int | None = None
    fallback_cleanup_used = False
    launcher: str | None = None
    try:
        environment = isolated_environment(root)
        launcher, runtime_identity = probe_runtime_identity(pi, project, environment)
        report["capture"]["runtime"] = runtime_identity
        rpc = RpcProcess(
            pi_argv(pi, rpc_arguments(root), launcher=launcher),
            project,
            environment,
            start_new_session=True,
        )
        pgid = os.getpgid(rpc.pid)
        evidence["runtime_created_new_session"] = pgid == rpc.pid
        rpc.start_readers()
        rpc.send(
            {
                "id": f"spike-02-{uuid.uuid4()}",
                "type": "bash",
                "command": direct_bash_command(child, ready_file),
                "excludeFromContext": True,
            }
        )
        evidence["direct_bash_rpc_sent"] = True
        evidence["child_ready"] = wait_for_file(ready_file, CHILD_READY_SECONDS)
        child_pid = marker_pid(ready_file)
        evidence["fixture_child_pid_observed"] = child_pid is not None
        evidence["fixture_child_in_runtime_group_before_eof"] = (
            child_pid is not None and os.getpgid(child_pid) == pgid
        )
        rpc.close_stdin()
        evidence["graceful_eof_sent"] = True
        evidence["runtime_exited_within_eof_grace"] = rpc.wait(EOF_GRACE_SECONDS)
        evidence["term_sent_to_runtime_group"] = signal_process_group(pgid, signal.SIGTERM)
        time.sleep(UNIX_TERM_GRACE_SECONDS)
        if (child_pid is not None and process_alive(child_pid)) or process_alive(rpc.pid):
            evidence["kill_sent_to_runtime_group"] = signal_process_group(pgid, signal.SIGKILL)
            time.sleep(UNIX_KILL_GRACE_SECONDS)
        else:
            evidence["kill_sent_to_runtime_group"] = False
        evidence["runtime_dead_after_group_escalation"] = rpc.wait(0.1)
        evidence["known_child_dead_after_group_escalation"] = (
            child_pid is not None and not process_alive(child_pid)
        )
        evidence["lf_protocol_error"] = rpc.protocol_error is not None
    except Exception as error:
        evidence["failure_category"] = type(error).__name__
    finally:
        try:
            if child_pid is not None and process_alive(child_pid):
                fallback_cleanup_used = terminate_owned_marker(child_pid) or fallback_cleanup_used
        except Exception as error:
            evidence.setdefault("cleanup_failure_category", type(error).__name__)
            fallback_cleanup_used = True
        try:
            if rpc is not None and process_alive(rpc.pid):
                try:
                    signal_process_group(os.getpgid(rpc.pid), signal.SIGKILL)
                except OSError:
                    rpc.kill_root()
                rpc.wait(1.0)
                fallback_cleanup_used = True
        except Exception as error:
            evidence.setdefault("cleanup_failure_category", type(error).__name__)
            fallback_cleanup_used = True
        if rpc is not None:
            try:
                rpc.dispose()
            except Exception as error:
                evidence.setdefault("cleanup_failure_category", type(error).__name__)
                fallback_cleanup_used = True
        evidence["sandbox_removed"] = remove_sandbox(root)

    evidence["emergency_fixture_cleanup_used"] = fallback_cleanup_used
    required = (
        evidence.get("runtime_created_new_session") is True,
        evidence.get("direct_bash_rpc_sent") is True,
        evidence.get("child_ready") is True,
        evidence.get("fixture_child_pid_observed") is True,
        evidence.get("fixture_child_in_runtime_group_before_eof") is True,
        evidence.get("graceful_eof_sent") is True,
        evidence.get("runtime_dead_after_group_escalation") is True,
        evidence.get("known_child_dead_after_group_escalation") is True,
        evidence.get("lf_protocol_error") is False,
        evidence.get("emergency_fixture_cleanup_used") is False,
    )
    report["status"] = "pass" if all(required) else "fail"
    report["limitations"] = [
        "Unix process groups do not contain a descendant that calls setsid/escapes into another group.",
        "Pi's direct-bash implementation must be physically tested on each Unix target; this branch has not been validated by the Windows run.",
        "The fixture PID check is intentionally retained so a false process-group assumption cannot produce a pass.",
    ]
    return report


def run(pi: str) -> dict[str, Any]:
    if os.name == "nt":
        return run_windows(pi)
    return run_unix(pi)


def assert_capture_binding(report: dict[str, Any], platform: str) -> None:
    """Require a pass to identify the exact capture, harness source, and safe launcher."""
    capture = report.get("capture")
    if not isinstance(capture, dict):
        raise ValueError("pass_missing_capture")
    run_id = capture.get("run_id")
    try:
        parsed_run_id = uuid.UUID(run_id) if isinstance(run_id, str) else None
    except ValueError as error:
        raise ValueError("invalid_capture_run_id") from error
    if parsed_run_id is None or parsed_run_id.version != 4 or str(parsed_run_id) != run_id:
        raise ValueError("invalid_capture_run_id")
    timestamp = capture.get("timestamp_utc")
    if not isinstance(timestamp, str) or re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", timestamp
    ) is None:
        raise ValueError("invalid_capture_timestamp_utc")
    try:
        parsed_timestamp = datetime.fromisoformat(timestamp[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError("invalid_capture_timestamp_utc") from error
    if parsed_timestamp.tzinfo != timezone.utc:
        raise ValueError("invalid_capture_timestamp_utc")

    harness_identity = capture.get("harness")
    if not isinstance(harness_identity, dict):
        raise ValueError("pass_missing_harness_identity")
    if harness_identity.get("id") != HARNESS_ID or harness_identity.get("version") != HARNESS_VERSION:
        raise ValueError("invalid_harness_identity")
    if harness_identity.get("source_sha256") != harness_source_sha256():
        raise ValueError("harness_source_hash_mismatch")

    runtime_identity = capture.get("runtime")
    if not isinstance(runtime_identity, dict):
        raise ValueError("pass_missing_runtime_identity")
    expected_launcher_kind = "npm-cmd-shim" if platform == "windows" else "pi-launcher"
    if runtime_identity.get("launcher_kind") != expected_launcher_kind:
        raise ValueError("invalid_runtime_launcher_kind")
    if not is_sha256(runtime_identity.get("launcher_sha256")):
        raise ValueError("invalid_runtime_launcher_hash")
    if not is_safe_pi_version(runtime_identity.get("pi_version")):
        raise ValueError("invalid_runtime_version")


def assert_report_contract(report: dict[str, Any]) -> None:
    """Reject a report that would overstate containment evidence."""
    if report.get("schema_version") != REPORT_SCHEMA_VERSION:
        raise ValueError("invalid_schema_version")
    if report.get("harness") != HARNESS_ID:
        raise ValueError("invalid_harness_id")
    if report.get("status") not in {"pass", "fail"}:
        raise ValueError("invalid_status")
    platform = report.get("platform")
    evidence = report.get("evidence")
    if platform not in {"windows", "unix"} or not isinstance(evidence, dict):
        raise ValueError("invalid_platform_or_evidence")
    if report["status"] == "pass":
        assert_capture_binding(report, platform)
    if platform == "windows":
        if report.get("containment_backend") != "windows-job-object-kill-on-close":
            raise ValueError("invalid_windows_backend")
        if report.get("unix_process_group") != "not_run_on_windows":
            raise ValueError("windows_report_must_not_claim_unix_execution")
        required = (
            "job_created",
            "kill_on_job_close_enabled",
            "runtime_created_suspended",
            "runtime_assigned_before_resume",
            "runtime_resumed_after_assignment",
            "direct_bash_rpc_sent",
            "child_ready",
            "fixture_child_pid_observed",
            "job_member_snapshot_available",
            "fixture_child_in_job_before_eof",
            "fixture_child_in_job_before_close",
            "graceful_eof_sent",
            "job_close_called",
            "job_closed",
            "runtime_dead_after_job_close",
            "known_child_dead_after_job_close",
            "alive_owned_member_count_after_job_close",
            "emergency_fixture_cleanup_used",
        )
        if report["status"] == "pass":
            if any(name not in evidence for name in required):
                raise ValueError("windows_pass_missing_evidence")
            if not all(
                evidence[name] is True
                for name in (
                    "job_created",
                    "kill_on_job_close_enabled",
                    "runtime_created_suspended",
                    "runtime_assigned_before_resume",
                    "runtime_resumed_after_assignment",
                    "direct_bash_rpc_sent",
                    "child_ready",
                    "fixture_child_pid_observed",
                    "job_member_snapshot_available",
                    "fixture_child_in_job_before_eof",
                    "fixture_child_in_job_before_close",
                    "graceful_eof_sent",
                    "job_close_called",
                    "job_closed",
                    "runtime_dead_after_job_close",
                    "known_child_dead_after_job_close",
                )
            ):
                raise ValueError("windows_pass_without_required_true_evidence")
            if evidence["alive_owned_member_count_after_job_close"] != 0:
                raise ValueError("windows_pass_with_live_owned_member")
            if evidence["emergency_fixture_cleanup_used"] is not False:
                raise ValueError("windows_pass_used_emergency_cleanup")
    else:
        if report.get("containment_backend") != "unix-process-group":
            raise ValueError("invalid_unix_backend")
        required = (
            "runtime_created_new_session",
            "direct_bash_rpc_sent",
            "child_ready",
            "fixture_child_pid_observed",
            "fixture_child_in_runtime_group_before_eof",
            "graceful_eof_sent",
            "runtime_dead_after_group_escalation",
            "known_child_dead_after_group_escalation",
            "lf_protocol_error",
            "emergency_fixture_cleanup_used",
        )
        if report["status"] == "pass":
            if any(name not in evidence for name in required):
                raise ValueError("unix_pass_missing_evidence")
            if not all(
                evidence[name] is True
                for name in (
                    "runtime_created_new_session",
                    "direct_bash_rpc_sent",
                    "child_ready",
                    "fixture_child_pid_observed",
                    "fixture_child_in_runtime_group_before_eof",
                    "graceful_eof_sent",
                    "runtime_dead_after_group_escalation",
                    "known_child_dead_after_group_escalation",
                )
            ):
                raise ValueError("unix_pass_without_complete_containment_evidence")
            if evidence["lf_protocol_error"] is not False:
                raise ValueError("unix_pass_with_protocol_error")
            if evidence["emergency_fixture_cleanup_used"] is not False:
                raise ValueError("unix_pass_used_emergency_cleanup")


def example_windows_pass_report() -> dict[str, Any]:
    """Pure-data fixture for self/unit tests; never emitted as runtime evidence."""
    report = base_report("windows")
    report["containment_backend"] = "windows-job-object-kill-on-close"
    report["unix_process_group"] = "not_run_on_windows"
    report["capture"]["runtime"] = {
        "launcher_kind": "npm-cmd-shim",
        "launcher_sha256": "0" * 64,
        "pi_version": "0.0.0",
    }
    report["status"] = "pass"
    report["evidence"] = {
        "job_created": True,
        "kill_on_job_close_enabled": True,
        "runtime_created_suspended": True,
        "runtime_assigned_before_resume": True,
        "runtime_resumed_after_assignment": True,
        "direct_bash_rpc_sent": True,
        "child_ready": True,
        "fixture_child_pid_observed": True,
        "job_member_snapshot_available": True,
        "fixture_child_in_job_before_eof": True,
        "fixture_child_in_job_before_close": True,
        "graceful_eof_sent": True,
        "job_close_called": True,
        "job_closed": True,
        "runtime_dead_after_job_close": True,
        "known_child_dead_after_job_close": True,
        "alive_owned_member_count_after_job_close": 0,
        "emergency_fixture_cleanup_used": False,
    }
    return report


def example_unix_pass_report() -> dict[str, Any]:
    """Pure-data Unix fixture proving every required containment field is present."""
    report = base_report("unix")
    report["containment_backend"] = "unix-process-group"
    report["capture"]["runtime"] = {
        "launcher_kind": "pi-launcher",
        "launcher_sha256": "1" * 64,
        "pi_version": "0.0.0",
    }
    report["status"] = "pass"
    report["evidence"] = {
        "runtime_created_new_session": True,
        "direct_bash_rpc_sent": True,
        "child_ready": True,
        "fixture_child_pid_observed": True,
        "fixture_child_in_runtime_group_before_eof": True,
        "graceful_eof_sent": True,
        "runtime_dead_after_group_escalation": True,
        "known_child_dead_after_group_escalation": True,
        "lf_protocol_error": False,
        "emergency_fixture_cleanup_used": False,
    }
    return report


def self_test() -> int:
    if sys.version_info < PYTHON_MINIMUM:
        return 1
    decoder = LfJsonlDecoder()
    rows = decoder.feed(b'{"type":"one","text":"a\\u2028b"}\n{"type":"two"')
    rows.extend(decoder.feed(b"}\r\n"))
    decoder.finish()
    if [row["type"] for row in rows] != ["one", "two"]:
        return 1
    try:
        LfJsonlDecoder(2).feed(b"abc")
    except ValueError:
        pass
    else:
        return 1
    assert_report_contract(example_windows_pass_report())
    assert_report_contract(example_unix_pass_report())
    invalid_windows = example_windows_pass_report()
    invalid_windows["capture"]["runtime"]["pi_version"] = "unsafe version output"
    try:
        assert_report_contract(invalid_windows)
    except ValueError:
        pass
    else:
        return 1
    invalid_unix = example_unix_pass_report()
    invalid_unix["evidence"]["known_child_dead_after_group_escalation"] = False
    try:
        assert_report_contract(invalid_unix)
    except ValueError:
        return 0
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", default="pi", help="installed Pi npm shim (default: pi)")
    parser.add_argument(
        "--report",
        type=Path,
        default=Path(__file__).parent / "reports" / "latest.json",
        help="sanitized report destination",
    )
    parser.add_argument("--self-test", action="store_true", help="run no-process codec/report checks")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if sys.version_info < PYTHON_MINIMUM:
        raise SystemExit("Python 3.13 or newer is required")
    report = run(args.pi)
    assert_report_contract(report)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"SPIKE-02 {report['status']} ({report['platform']})")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
