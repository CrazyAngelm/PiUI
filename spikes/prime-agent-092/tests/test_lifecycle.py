from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

SPIKE_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = Path(os.environ["PIUI_PRIME_092_PACKAGE_ROOT"]).resolve()
KERNEL_PYTHON = Path(os.environ["PIUI_PRIME_092_KERNEL_PYTHON"]).resolve()
HOST = SPIKE_ROOT / "sdk-host.mjs"


def sanitized_environment(workspace: Path) -> dict[str, str]:
    home = workspace / "home"
    home.mkdir(parents=True, exist_ok=True)
    allowed = ("PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LANG")
    env = {name: os.environ[name] for name in allowed if name in os.environ}
    env.update({
        "HOME": str(home),
        "USERPROFILE": str(home),
        "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "PRIME_AGENT_TELEMETRY": "0",
        "DO_NOT_TRACK": "1",
    })
    return env


def daemon_guard() -> str:
    unique = f"piui-prime-sdk-{uuid.uuid4()}"
    return rf"\\.\pipe\{unique}" if os.name == "nt" else f"/tmp/{unique}.sock"


def process_table() -> dict[int, int]:
    if os.name != "nt":
        result: dict[int, int] = {}
        for item in Path("/proc").iterdir():
            if not item.name.isdigit():
                continue
            try:
                fields = (item / "stat").read_text(encoding="utf-8").split()
                result[int(item.name)] = int(fields[3])
            except (OSError, ValueError, IndexError):
                continue
        return result

    TH32CS_SNAPPROCESS = 0x00000002
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", ctypes.c_ulong), ("cntUsage", ctypes.c_ulong), ("th32ProcessID", ctypes.c_ulong),
            ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", ctypes.c_ulong), ("cntThreads", ctypes.c_ulong),
            ("th32ParentProcessID", ctypes.c_ulong), ("pcPriClassBase", ctypes.c_long), ("dwFlags", ctypes.c_ulong),
            ("szExeFile", ctypes.c_wchar * 260),
        ]
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == INVALID_HANDLE_VALUE:
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot failed")
    result = {}
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    try:
        ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            result[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return result


def descendant_pids(parent: int) -> set[int]:
    table = process_table()
    found: set[int] = set()
    changed = True
    while changed:
        changed = False
        for pid, ppid in table.items():
            if pid not in found and (ppid == parent or ppid in found):
                found.add(pid)
                changed = True
    return found


def pid_alive(pid: int) -> bool:
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        code = ctypes.c_ulong()
        try:
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def wait_dead(pids: set[int], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        alive = {pid for pid in pids if pid_alive(pid)}
        if not alive:
            return
        threading.Event().wait(0.05)
    raise AssertionError(f"processes remained alive: {sorted(pid for pid in pids if pid_alive(pid))}")


class HostClient:
    def __init__(self, workspace: Path):
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        self.daemon_socket = daemon_guard()
        self.process = subprocess.Popen(
            ["node", str(HOST), "--package-root", str(PACKAGE_ROOT), "--workspace", str(workspace), "--daemon-socket", self.daemon_socket, "--kernel-python", str(KERNEL_PYTHON)],
            cwd=str(SPIKE_ROOT), env=sanitized_environment(workspace), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, creationflags=flags, start_new_session=os.name != "nt",
        )
        self.records: queue.Queue[dict[str, object]] = queue.Queue()
        self.responses: dict[str, queue.Queue[dict[str, object]]] = {}
        self.stderr = bytearray()
        self._stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()
        ready = self.records.get(timeout=20)
        if ready.get("type") != "ready":
            raise AssertionError(f"expected ready, got {ready}")
        self.ready = ready

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        pending = bytearray()
        while True:
            chunk = self.process.stdout.read1(4096)
            if not chunk:
                return
            pending.extend(chunk)
            while True:
                try:
                    index = pending.index(0x0A)
                except ValueError:
                    break
                raw = bytes(pending[:index])
                del pending[:index + 1]
                if raw.endswith(b"\r"):
                    raw = raw[:-1]
                if not raw.strip():
                    continue
                record = json.loads(raw.decode("utf-8"))
                identifier = record.get("id")
                if isinstance(identifier, str) and identifier in self.responses:
                    self.responses[identifier].put(record)
                else:
                    self.records.put(record)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        while True:
            chunk = self.process.stderr.read1(4096)
            if not chunk:
                return
            self.stderr.extend(chunk)

    def request(self, kind: str, **fields: object) -> dict[str, object]:
        identifier = str(uuid.uuid4())
        response_queue: queue.Queue[dict[str, object]] = queue.Queue()
        self.responses[identifier] = response_queue
        payload = {"id": identifier, "type": kind, **fields}
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n")
        self.process.stdin.flush()
        try:
            return response_queue.get(timeout=90)
        except queue.Empty as error:
            raise AssertionError(f"host response timeout; returncode={self.process.poll()}; stderr={self.stderr.decode('utf-8', 'replace')}") from error
        finally:
            self.responses.pop(identifier, None)

    def eof(self) -> int:
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        return self.process.wait(timeout=30)

    def terminate_tree(self) -> None:
        if self.process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False,
            )
        else:
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=15)


class Prime092LifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="piui-prime-092-")
        self.workspace = Path(self.temporary.name)
        self.clients: list[HostClient] = []

    def tearDown(self) -> None:
        for client in self.clients:
            client.terminate_tree()
        self.temporary.cleanup()

    def host(self) -> HostClient:
        client = HostClient(self.workspace)
        self.clients.append(client)
        self.assertEqual(client.ready["package"], "prime-agent@0.9.2")
        self.assertEqual(client.ready["transport"], "sdk-in-process-child")
        self.assertEqual(client.ready["daemonContact"], "none")
        self.assertEqual(client.ready["daemonSocketGuard"], "accepted-not-used")
        if os.name != "nt":
            self.assertFalse(Path(client.daemon_socket).exists(), "in-process route must not bind the inert daemon guard")
        return client

    def test_prompt_free_start_new_resume_and_failure_path(self) -> None:
        client = self.host()
        sessions = self.workspace / "sessions"
        self.assertEqual(list(sessions.glob("*.jsonl")), [])
        initial = client.request("get_state")
        self.assertTrue(initial["success"])
        initial_data = initial["data"]
        self.assertFalse(initial_data["isStreaming"])
        self.assertEqual(list(sessions.glob("*.jsonl")), [], "startup must not materialize a ghost session")

        first = client.request("flush_session")["data"]
        files = list(sessions.glob("*.jsonl"))
        self.assertEqual(len(files), 1)
        header = json.loads(files[0].read_text(encoding="utf-8").split("\n", 1)[0])
        self.assertEqual(header["type"], "session")
        self.assertEqual(header["id"], first["sessionId"])
        self.assertEqual(Path(header["cwd"]), self.workspace / "project")

        second_response = client.request("new_session")
        self.assertTrue(second_response["success"])
        second = second_response["data"]
        self.assertNotEqual(first["sessionId"], second["sessionId"])
        self.assertEqual(len(list(sessions.glob("*.jsonl"))), 2)

        resumed = client.request("switch_session", session=first["sessionFile"])
        self.assertTrue(resumed["success"])
        self.assertEqual(resumed["data"]["sessionId"], first["sessionId"])
        rejected = client.request("switch_session", session="../outside.jsonl")
        self.assertFalse(rejected["success"])
        self.assertIn("basename", rejected["error"])
        self.assertTrue(client.request("get_state")["success"], "a rejected resume must not kill the host")
        self.assertEqual(client.eof(), 0)

    def test_native_ipython_rlm_and_eof_cleanup(self) -> None:
        client = self.host()
        self.assertTrue(client.request("flush_session")["success"])
        ipython = client.request("run_ipython_fixture")
        self.assertTrue(ipython["success"], ipython)
        self.assertIn("tool_execution_start", ipython["data"]["toolEvents"])
        self.assertIn("tool_execution_end", ipython["data"]["toolEvents"])
        self.assertEqual(ipython["data"]["lastAssistantText"], "synthetic native tool completed")
        kernel_descendants = descendant_pids(client.process.pid)
        self.assertTrue(kernel_descendants, "native ipython must create at least one owned descendant")

        rlm = client.request("run_rlm_fixture")
        self.assertTrue(rlm["success"], rlm)
        children = rlm["data"]["children"]
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]["status"], "done")
        coordination = client.request("get_coordination_capability")["data"]
        self.assertIn("requires daemon mode", coordination["agentMessage"])
        self.assertIn("require daemon mode", coordination["heartbeat"])
        all_owned = descendant_pids(client.process.pid)
        self.assertTrue(kernel_descendants.issubset(all_owned))
        self.assertEqual(client.eof(), 0)
        wait_dead(all_owned | {client.process.pid})

    def test_abort_reaps_native_bash_descendants(self) -> None:
        client = self.host()
        started = client.request("start_descendant_fixture")
        self.assertTrue(started["success"], started)
        pids = {int(started["data"]["parent"]), int(started["data"]["grandchild"])}
        self.assertTrue(all(pid_alive(pid) for pid in pids))
        aborted = client.request("abort")
        self.assertTrue(aborted["success"], aborted)
        self.assertTrue(aborted["data"]["idle"])
        wait_dead(pids)
        self.assertEqual(client.eof(), 0)

    def test_owner_tree_kill_contains_forced_failure(self) -> None:
        client = self.host()
        started = client.request("start_descendant_fixture")
        self.assertTrue(started["success"], started)
        pids = {client.process.pid, int(started["data"]["parent"]), int(started["data"]["grandchild"])}
        self.assertTrue(all(pid_alive(pid) for pid in pids))
        client.terminate_tree()
        wait_dead(pids)


class Prime092StaticProbeTests(unittest.TestCase):
    def test_static_probe_passes_and_never_authorizes_daemon(self) -> None:
        sys.path.insert(0, str(SPIKE_ROOT))
        import probe
        report = probe.inspect_package(PACKAGE_ROOT, SPIKE_ROOT)
        self.assertEqual(report["overall_status"], "pass")
        self.assertEqual(report["package"], {"name": "prime-agent", "version": "0.9.2"})
        self.assertEqual(report["route"]["daemon_contact"], "none")
        self.assertFalse(report["route"]["default_daemon_created_connected_or_stopped"])
        self.assertFalse(report["route"]["credential_files_read_by_probe"])
        self.assertFalse(report["route"]["user_sessions_read_by_probe"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
