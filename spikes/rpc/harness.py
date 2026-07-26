#!/usr/bin/env python3
"""PiUI Phase 0 RPC spike harness. Uses only synthetic data and byte-level JSONL."""
from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
from urllib.parse import parse_qsl, urlsplit, urlunsplit
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MAX_FRAME = 32 * 1024 * 1024
EXACT_REDACTED_KEYS = frozenset({"message", "content", "text", "prefill", "prompt", "path", "sessionfile", "sessionpath", "cwd"})
SENSITIVE_KEY_PARTS = frozenset({"token", "password", "passwd", "secret", "credential", "authorization", "apikey", "accesskey", "privatekey", "clientsecret", "cookie"})
SENSITIVE_VALUE_PATTERN = re.compile(r"(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer)\s*[:=]\s*\S+|\b(?:sk-[a-z0-9_-]{8,}|gh[pous]_[a-z0-9]{12,}|github_pat_[a-z0-9_]{16,}|aiza[a-z0-9_-]{12,})\b|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b")
ABSOLUTE_PATH_PATTERN = re.compile(r"^(?:[a-zA-Z]:[\\/]|\\\\|/|~[\\/])")
SENSITIVE_QUERY_NAMES = frozenset({"key", "sig", "signature", "credential", "credentials", "token", "access_token", "refresh_token", "api_key", "apikey", "password", "secret"})
REQUIRED_G0_SPIKES = frozenset({"SPIKE-01", "SPIKE-02", "SPIKE-03", "SPIKE-04", "SPIKE-05", "SPIKE-06", "SPIKE-10"})


class LfJsonlDecoder:
    """Incremental JSONL decoder: only byte 0x0A ends a record."""
    def __init__(self, max_frame: int = MAX_FRAME) -> None:
        self._buf = bytearray()
        self.max_frame = max_frame
        self.empty_frames = 0

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        self._buf.extend(chunk)
        result: list[dict[str, Any]] = []
        while True:
            at = self._buf.find(b"\n")
            if at < 0:
                if len(self._buf) > self.max_frame:
                    raise ValueError("frame_limit_exceeded")
                return result
            frame = bytes(self._buf[:at])
            del self._buf[: at + 1]
            if frame.endswith(b"\r"):
                frame = frame[:-1]
            if not frame:
                self.empty_frames += 1
                continue
            if len(frame) > self.max_frame:
                raise ValueError("frame_limit_exceeded")
            try:
                value = json.loads(frame.decode("utf-8", errors="strict"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(f"invalid_jsonl_frame:{type(error).__name__}") from error
            if not isinstance(value, dict):
                raise ValueError("jsonl_frame_is_not_object")
            result.append(value)

    def finish(self) -> None:
        if self._buf:
            raise ValueError("incomplete_frame_at_eof")


def is_sensitive_key(key: str) -> bool:
    normalized = "".join(character for character in key.casefold() if character.isalnum())
    return normalized in EXACT_REDACTED_KEYS or any(part in normalized for part in SENSITIVE_KEY_PARTS)


def sanitize_string(value: str) -> str:
    """Redact secret/path-shaped values even when upstream uses an unfamiliar key."""
    if ABSOLUTE_PATH_PATTERN.match(value):
        return "<redacted>"
    parsed = urlsplit(value)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        query = parse_qsl(parsed.query, keep_blank_values=True)
        if parsed.username is not None or parsed.password is not None or any(name.casefold() in SENSITIVE_QUERY_NAMES or is_sensitive_key(name) for name, _ in query) or any(SENSITIVE_VALUE_PATTERN.search(item) for _, item in query):
            return "<redacted-url>"
        # A safe endpoint remains useful capability metadata; fragments are never needed.
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))[:200]
    if SENSITIVE_VALUE_PATTERN.search(value):
        return "<redacted>"
    return value[:200]


def sanitize(value: Any, key: str = "") -> Any:
    """Keep protocol shape while ensuring reports contain no prompts, secrets, or absolute paths."""
    if is_sensitive_key(key):
        return "<redacted>"
    if isinstance(value, dict):
        return {str(k): sanitize(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(item) for item in value[:32]]
    if isinstance(value, str):
        return sanitize_string(value)
    return value


def status(ok: bool | None) -> str:
    return "pass" if ok is True else "fail" if ok is False else "inconclusive"


def fixture_session(path: Path, cwd: Path) -> tuple[str, str]:
    """Create only a known harmless v3 session with ordinary UUIDv4 IDs."""
    session_id, entry_id = str(uuid.uuid4()), str(uuid.uuid4())
    header = {"type": "session", "version": 3, "id": session_id, "timestamp": "2025-01-01T00:00:00.000Z", "cwd": str(cwd)}
    entry = {"type": "message", "id": entry_id, "parentId": None, "timestamp": "2025-01-01T00:00:01.000Z", "message": {"role": "user", "content": "PiUI synthetic fixture; no user data."}}
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in (header, entry)) + "\n", encoding="utf-8", newline="\n")
    return session_id, entry_id


def fixture_persistence_source(path: Path, cwd: Path) -> str:
    """Create a safe source tree with a synthetic assistant, without a provider call."""
    session_id, user_id = fixture_session(path, cwd)
    assistant = {"type": "message", "id": str(uuid.uuid4()), "parentId": user_id, "timestamp": "2025-01-01T00:00:02.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "PiUI synthetic assistant fixture."}], "provider": "synthetic", "model": "synthetic", "stopReason": "stop"}}
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(assistant, ensure_ascii=False, separators=(",", ":")) + "\n")
    return session_id


def pi_argv(pi: str, arguments: list[str]) -> list[str]:
    """Run npm's Windows .cmd shim without relying on shell lookup elsewhere."""
    if os.name != "nt":
        return [pi, *arguments]
    resolved = shutil.which(pi) or pi
    if resolved.lower().endswith((".cmd", ".bat")):
        # `call` preserves argv boundaries for npm's .cmd shim. A single /s /c
        # command string misquotes paths with spaces and produced false probes.
        return [os.environ.get("COMSPEC", r"C:\\Windows\\System32\\cmd.exe"), "/d", "/c", "call", resolved, *arguments]
    return [resolved, *arguments]


def isolated_env(agent_dir: Path, session_dir: Path) -> dict[str, str]:
    env = {"PATH": os.environ.get("PATH", ""), "PI_CODING_AGENT_DIR": str(agent_dir), "PI_CODING_AGENT_SESSION_DIR": str(session_dir), "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "NO_PROXY": "*"}
    # Deliberately omit all provider credentials and inherited Pi configuration.
    if os.name == "nt":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\\Windows")
        env["COMSPEC"] = os.environ.get("COMSPEC", r"C:\\Windows\\System32\\cmd.exe")
    return env


@dataclass
class RpcProcess:
    args: list[str]
    cwd: Path
    env: dict[str, str]
    events: queue.Queue[dict[str, Any]] = field(default_factory=queue.Queue)
    errors: queue.Queue[str] = field(default_factory=queue.Queue)

    def __post_init__(self) -> None:
        self.proc = subprocess.Popen(self.args, cwd=self.cwd, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=False)
        self._stdout = threading.Thread(target=self._drain_stdout, daemon=True)
        self._stderr = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stdout.start(); self._stderr.start()

    def _drain_stdout(self) -> None:
        assert self.proc.stdout is not None
        decoder = LfJsonlDecoder()
        try:
            while chunk := os.read(self.proc.stdout.fileno(), 4096):
                for item in decoder.feed(chunk): self.events.put(item)
            decoder.finish()
        except Exception as error:
            self.errors.put(f"stdout:{error}")

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        # Do not persist stderr: it can include user-controlled extension errors.
        while os.read(self.proc.stderr.fileno(), 4096):
            pass

    def send(self, command: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(command, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
        self.proc.stdin.flush()

    def response(self, request_id: str, timeout: float = 5.0) -> dict[str, Any] | None:
        end = time.monotonic() + timeout
        backlog: list[dict[str, Any]] = []
        while time.monotonic() < end:
            try: event = self.events.get(timeout=max(0.01, end - time.monotonic()))
            except queue.Empty: break
            if event.get("type") == "response" and event.get("id") == request_id:
                for item in backlog: self.events.put(item)
                return event
            backlog.append(event)
        for item in backlog: self.events.put(item)
        return None

    def close_stdin(self) -> None:
        if self.proc.stdin and not self.proc.stdin.closed: self.proc.stdin.close()

    def wait_for_exit(self, timeout: float = 3.0) -> bool:
        try:
            self.proc.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    def stop(self) -> bool:
        self.close_stdin()
        try:
            self.proc.wait(timeout=3)
            return True
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try: self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired: self.proc.kill(); self.proc.wait(timeout=2)
            return False


def command(proc: RpcProcess, kind: str, **fields: Any) -> dict[str, Any] | None:
    ident = f"probe-{uuid.uuid4()}"
    proc.send({"id": ident, "type": kind, **fields})
    return proc.response(ident)


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\\"'\\\"'") + "'"


def child_command(child: Path, ready: Path) -> str:
    """Run the sleeping child in the direct-bash command foreground, not detached."""
    if os.name == "nt":
        script = ("& '" + str(sys.executable).replace("'", "''") + "' '" + str(child).replace("'", "''") + "' "
                  "'--ready' '" + str(ready).replace("'", "''") + "' '--seconds' '30'")
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        return f"powershell.exe -NoProfile -NonInteractive -EncodedCommand {encoded}"
    return f"exec {shell_quote(sys.executable)} {shell_quote(str(child))} --ready {shell_quote(str(ready))} --seconds 30"


def ready_child_pid(path: Path) -> int | None:
    try:
        value = path.read_text(encoding="ascii").strip()
    except OSError:
        return None
    return int(value) if value.isdecimal() else None


def process_alive(pid: int) -> bool:
    """Avoid os.kill(pid, 0) on Windows, where it can yield WinError 87."""
    if os.name == "nt":
        completed = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True, check=False, timeout=5)
        return bool(re.search(rf'^"[^"].*","{pid}",', completed.stdout, re.MULTILINE))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    if sys.platform.startswith("linux"):
        try:
            # A zombie has a PID but is no longer a running child.
            if Path(f"/proc/{pid}/stat").read_text(encoding="ascii").split(") ", 1)[1].startswith("Z"):
                return False
        except (OSError, IndexError):
            pass
    return True


def terminate_child(pid: int) -> bool:
    if not process_alive(pid):
        return False
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True, check=False, timeout=5)
    else:
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and process_alive(pid): time.sleep(0.05)
        if process_alive(pid): os.kill(pid, signal.SIGKILL)
    return True


def synthetic_session_files(root: Path) -> list[str]:
    """List JSONL only under the temporary sandbox; never inspect a user root."""
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*.jsonl"))


def tree_has_synthetic_custom_entry(tree_response: dict[str, Any] | None) -> bool:
    def visit(nodes: Any) -> bool:
        if not isinstance(nodes, list):
            return False
        for node in nodes:
            if not isinstance(node, dict):
                continue
            entry = node.get("entry")
            if isinstance(entry, dict) and entry.get("type") == "custom" and entry.get("customType") == "piui-spike-persistence" and entry.get("data") == {"fixture": "synthetic", "version": 1}:
                return True
            if visit(node.get("children")):
                return True
        return False
    data = tree_response.get("data") if isinstance(tree_response, dict) else None
    return visit(data.get("tree") if isinstance(data, dict) else None)


def has_synthetic_custom_entry(path: Path, session_id: str) -> bool:
    """Validate only the harness-created JSONL file and its safe custom entry."""
    try:
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    except (OSError, json.JSONDecodeError):
        return False
    if not rows or rows[0].get("type") != "session" or rows[0].get("id") != session_id:
        return False
    return any(row.get("type") == "custom" and row.get("customType") == "piui-spike-persistence" and row.get("data") == {"fixture": "synthetic", "version": 1} for row in rows[1:] if isinstance(row, dict))


def parse_lf_jsonl_file(path: Path) -> list[dict[str, Any]]:
    decoder = LfJsonlDecoder()
    rows = decoder.feed(path.read_bytes())
    decoder.finish()
    return rows


def matches_golden_corpus(corpus: list[dict[str, Any]], fixture: Path) -> bool:
    try:
        expected = json.loads(fixture.read_text(encoding="utf-8")).get("events")
    except (OSError, json.JSONDecodeError, AttributeError):
        return False
    return corpus == expected


def force_crash(proc: RpcProcess) -> bool:
    """Terminate the synthetic runtime tree; this intentionally bypasses graceful EOF."""
    if proc.proc.poll() is not None:
        return True
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.proc.pid), "/T", "/F"], capture_output=True, text=True, check=False, timeout=5)
    else:
        proc.proc.kill()
    try:
        proc.proc.wait(timeout=3)
        return True
    except subprocess.TimeoutExpired:
        return False


def wait_for_file(path: Path, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file(): return True
        time.sleep(0.05)
    return path.is_file()


def run(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(tempfile.mkdtemp(prefix="piui-rpc-spike-"))
    project = root / "project with spaces Ω"; project.mkdir()
    agent_dir = root / "agent"; agent_dir.mkdir()
    session_dir = root / "sessions"; session_dir.mkdir()
    session = session_dir / "existing session ünicode.jsonl"; expected_session_id, expected_entry_id = fixture_session(session, project)
    switch_session = session_dir / "switch target 日本語.jsonl"; switch_session_id, switch_entry_id = fixture_session(switch_session, project)
    crash_session = session_dir / "crash target ünicode.jsonl"; crash_session_id, crash_entry_id = fixture_session(crash_session, project)
    persistence_source = session_dir / "new-session source synthetic.jsonl"; persistence_source_id = fixture_persistence_source(persistence_source, project)
    concurrent_session = session_dir / "concurrent synthetic source.jsonl"; concurrent_session_id = fixture_persistence_source(concurrent_session, project)
    before = synthetic_session_files(root)
    env = isolated_env(agent_dir, session_dir)
    common = ["--mode", "rpc", "--offline", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session-dir", str(session_dir)]
    results: dict[str, Any] = {}
    try:
        # SPIKE-01 and SPIKE-10: official session operations, no prompt/provider call.
        proc = RpcProcess(pi_argv(args.pi, common + ["--session", str(session)]), project, env)
        state = command(proc, "get_state")
        tree = command(proc, "get_tree")
        commands = command(proc, "get_commands")
        models = command(proc, "get_available_models")
        explicit_after = synthetic_session_files(root)
        observed_session_id = state.get("data", {}).get("sessionId") if isinstance(state, dict) and isinstance(state.get("data"), dict) else None
        message_count = state.get("data", {}).get("messageCount") if isinstance(state, dict) and isinstance(state.get("data"), dict) else None
        explicit_ok = bool(state and state.get("success") is True and explicit_after == before and observed_session_id == expected_session_id and message_count == 1)

        files_before_new = synthetic_session_files(root)
        expected_new_id = str(uuid.uuid4())
        persistence_extension = Path(__file__).parent / "fixtures" / "persist_session_fixture.ts"
        new_proc = RpcProcess(pi_argv(args.pi, common + ["--extension", str(persistence_extension), "--fork", str(persistence_source), "--session-id", expected_new_id]), project, env)
        new_state = command(new_proc, "get_state")
        # Slash commands run extension handlers immediately; this is no provider/model turn.
        new_persist_response = command(new_proc, "prompt", message="/piui-persist-synthetic")
        new_tree = command(new_proc, "get_tree")
        in_memory_custom_entry = tree_has_synthetic_custom_entry(new_tree)
        new_runtime_exited = new_proc.stop()
        files_after_new = synthetic_session_files(root)
        new_files = sorted(set(files_after_new) - set(files_before_new))
        new_custom_entry_valid = len(new_files) == 1 and has_synthetic_custom_entry(root / new_files[0], expected_new_id)
        new_data = new_state.get("data", {}) if isinstance(new_state, dict) and isinstance(new_state.get("data"), dict) else {}
        new_identity = new_data.get("sessionId")
        new_ok = bool(new_state and new_state.get("success") is True and new_persist_response and new_persist_response.get("success") is True and new_runtime_exited and new_identity == expected_new_id and len(files_after_new) == len(files_before_new) + 1 and new_custom_entry_valid)

        files_before_switch = synthetic_session_files(root)
        switch_response = command(proc, "switch_session", sessionPath=str(switch_session))
        switched_state = command(proc, "get_state")
        files_after_switch = synthetic_session_files(root)
        switched_data = switched_state.get("data", {}) if isinstance(switched_state, dict) and isinstance(switched_state.get("data"), dict) else {}
        switch_ok = bool(switch_response and switch_response.get("success") is True and switch_response.get("data", {}).get("cancelled") is False and switched_data.get("sessionId") == switch_session_id and switched_data.get("messageCount") == 1 and files_before_switch == files_after_switch)
        exited_by_eof = proc.stop()

        crash_before = synthetic_session_files(root)
        crash_proc = RpcProcess(pi_argv(args.pi, common + ["--session", str(crash_session)]), project, env)
        crash_state = command(crash_proc, "get_state")
        crash_data = crash_state.get("data", {}) if isinstance(crash_state, dict) and isinstance(crash_state.get("data"), dict) else {}
        crash_identity_ok = bool(crash_state and crash_state.get("success") is True and crash_data.get("sessionId") == crash_session_id and crash_data.get("messageCount") == 1)
        crash_exited = force_crash(crash_proc)
        crash_after = synthetic_session_files(root)
        crash_ok = crash_identity_ok and crash_exited and crash_before == crash_after
        results["SPIKE-01"] = {"status": status(explicit_ok and new_ok and switch_ok and crash_ok), "evidence": {"explicit_existing_launch": {"files_before": before, "files_after": explicit_after, "expected_session_id": expected_session_id, "observed_session_id": observed_session_id, "expected_entry_id": expected_entry_id, "identity_matches": observed_session_id == expected_session_id, "existing_entry_loaded": message_count == 1}, "expected_new_session": {"files_before": files_before_new, "files_after": files_after_new, "creation_method": "--fork <synthetic source> --session-id <generated id>", "source_session_id": persistence_source_id, "expected_session_id": expected_new_id, "observed_session_id": new_identity, "identity_matches": new_identity == expected_new_id, "extension_command_response_success": bool(new_persist_response and new_persist_response.get("success") is True), "runtime_exited": new_runtime_exited, "exactly_one_expected_file_created": len(files_after_new) == len(files_before_new) + 1, "new_files": new_files, "in_memory_synthetic_custom_entry": in_memory_custom_entry, "valid_synthetic_custom_entry": new_custom_entry_valid}, "switch_to_existing": {"files_before": files_before_switch, "files_after": files_after_switch, "expected_session_id": switch_session_id, "observed_session_id": switched_data.get("sessionId"), "expected_entry_id": switch_entry_id, "identity_matches": switched_data.get("sessionId") == switch_session_id, "existing_entry_loaded": switched_data.get("messageCount") == 1, "no_ghost_file": files_before_switch == files_after_switch}, "forced_crash": {"files_before": crash_before, "files_after": crash_after, "expected_session_id": crash_session_id, "observed_session_id": crash_data.get("sessionId"), "expected_entry_id": crash_entry_id, "identity_matches": crash_data.get("sessionId") == crash_session_id, "existing_entry_loaded": crash_data.get("messageCount") == 1, "runtime_exited": crash_exited, "no_ghost_file": crash_before == crash_after}, "state": sanitize(state)}}
        # SPIKE-02 direct-bash child: no prompt/provider request; cleanup is mandatory.
        child = Path(__file__).parent / "fixtures" / "child_fixture.py"
        ready = root / "child-ready"
        child_proc = RpcProcess(pi_argv(args.pi, common + ["--no-session"]), project, env)
        started_pid: int | None = None
        ready_seen = False
        child_exited = False
        cleanup_invoked = False
        child_runtime_exited = False
        dispatched = False
        try:
            child_proc.send({"id": "direct-bash-child", "type": "bash", "command": child_command(child, ready)})
            dispatched = True
            ready_seen = wait_for_file(ready)
            started_pid = ready_child_pid(ready) if ready_seen else None
            child_runtime_exited = child_proc.stop()
            if started_pid is not None:
                child_exited = not process_alive(started_pid)
        finally:
            if started_pid is not None and process_alive(started_pid):
                cleanup_invoked = terminate_child(started_pid)
            if child_proc.proc.poll() is None:
                child_proc.stop()
        direct_bash_ok = dispatched and ready_seen and child_runtime_exited and child_exited
        results["SPIKE-02"] = {"status": status(exited_by_eof and direct_bash_ok), "evidence": {"idle_eof_exited_within_seconds": 3 if exited_by_eof else None, "direct_bash_child": {"command_dispatched": dispatched, "child_ready": ready_seen, "pi_exited_after_stdin_close": child_runtime_exited, "child_alive_after_pi_exit": None if started_pid is None else not child_exited, "cleanup_invoked_after_failure": cleanup_invoked}, "limitations": ["Current-platform direct-bash result only; it does not establish cross-platform behavior.", "This does not cover model-initiated tools, arbitrary descendants, or detached processes."]}}
        results["SPIKE-03"] = {"status": status(tree is not None and tree.get("success") is True), "evidence": {"get_tree": sanitize(tree), "direct_navigate_rpc": "not documented by installed RPC schema", "bridge_feasibility": "SDK exposes navigateTree; a narrow extension/bridge command is feasible but unverified here."}}
        probes = {"get_state": state, "get_tree": tree, "get_commands": commands, "get_available_models": models}
        probes_succeeded = all(isinstance(response, dict) and response.get("success") is True for response in probes.values())
        results["SPIKE-10"] = {"status": status(probes_succeeded), "evidence": {"version": pi_version(args.pi), "probes": {name: sanitize(response) for name, response in probes.items()}, "all_required_probes_succeeded": probes_succeeded, "unknown_fields_policy": "Preserve unknown objects as opaque runtime data."}}

        # SPIKE-05: explicit trusted-in-harness extension; command only, responses cancelled.
        extension = Path(__file__).parent / "fixtures" / "rpc_ui_fixture.ts"
        ui = RpcProcess(pi_argv(args.pi, common + ["--no-session", "--extension", str(extension)]), project, env)
        ui.send({"id": "ui-command", "type": "prompt", "message": "/piui-rpc-ui-fixture"})
        requested: list[str] = []
        corpus: list[dict[str, Any]] = []
        cancelled_dialogs: list[str] = []
        completion_notify_seen = False
        dialog_methods = {"select", "input", "editor", "confirm"}
        end = time.monotonic() + 8
        while time.monotonic() < end:
            try: event = ui.events.get(timeout=0.2)
            except queue.Empty: continue
            if event.get("type") == "extension_ui_request":
                method = str(event.get("method")); requested.append(method)
                corpus.append({"type": "extension_ui_request", "method": method, "shape": sorted(str(key) for key in event), "dialog": method in dialog_methods})
                if method in dialog_methods:
                    ui.send({"type": "extension_ui_response", "id": event.get("id"), "cancelled": True})
                    cancelled_dialogs.append(method)
                if method == "notify" and event.get("message") == "Synthetic fixture completed":
                    completion_notify_seen = True
        ui_ok = ui.stop()
        expected = {"select", "confirm", "input", "editor", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text"}
        cancellation_resumed = set(dialog_methods).issubset(cancelled_dialogs) and completion_notify_seen
        golden_matches = matches_golden_corpus(corpus, Path(__file__).parent / "fixtures" / "extension_ui.golden.json")
        results["SPIKE-05"] = {"status": status(ui_ok and expected.issubset(requested) and cancellation_resumed and golden_matches), "evidence": {"golden_fixture": "fixtures/extension_ui.golden.json", "golden_matches": golden_matches, "golden_event_corpus": corpus, "requested_methods": sorted(set(requested)), "cancellation_resume": {"cancelled_dialogs": cancelled_dialogs, "completion_notify_seen": completion_notify_seen, "resumed_after_cancellation": cancellation_resumed}, "timeout_behavior": {"status": "inconclusive", "reason": "Fixture sends no timeout-bearing dialog request; timeout auto-resolution was not exercised."}, "unsupported_tui_apis": ["custom", "header/footer", "editor component", "themes"]}}

        # SPIKE-06: synchronized startup-lifecycle appendEntry race on one disposable session.
        concurrent_extension = Path(__file__).parent / "fixtures" / "concurrent_append_fixture.ts"
        spawn_barrier = threading.Barrier(3)
        spawned: dict[str, RpcProcess] = {}
        spawn_errors: list[str] = []

        def spawn_writer(tag: str) -> None:
            writer_env = dict(env)
            writer_env["PIUI_SPIKE_CONCURRENT_TAG"] = tag
            try:
                spawn_barrier.wait(timeout=5)
                spawned[tag] = RpcProcess(pi_argv(args.pi, common + ["--extension", str(concurrent_extension), "--session", str(concurrent_session)]), project, writer_env)
            except (threading.BrokenBarrierError, OSError, subprocess.SubprocessError) as error:
                spawn_errors.append(type(error).__name__)

        writer_threads = [threading.Thread(target=spawn_writer, args=(tag,)) for tag in ("writer-a", "writer-b")]
        for worker in writer_threads: worker.start()
        try:
            spawn_barrier.wait(timeout=5)
        except threading.BrokenBarrierError:
            spawn_errors.append("BrokenBarrierError")
        for worker in writer_threads: worker.join(timeout=10)
        writer_responses: dict[str, dict[str, bool]] = {}
        writer_identity_matches: dict[str, bool] = {}
        for tag, writer in spawned.items():
            state_response = command(writer, "get_state")
            tree_response = command(writer, "get_tree")
            state_data = state_response.get("data", {}) if isinstance(state_response, dict) and isinstance(state_response.get("data"), dict) else {}
            writer_identity_matches[tag] = state_data.get("sessionId") == concurrent_session_id
            # Both acknowledgements arrive after lifecycle append dispatch.
            writer_responses[tag] = {"get_state": bool(state_response and state_response.get("success") is True), "get_tree": bool(tree_response and tree_response.get("success") is True)}
        writer_exits = {tag: writer.stop() for tag, writer in spawned.items()}
        parsed_rows: list[dict[str, Any]] = []
        parse_error: str | None = None
        try:
            parsed_rows = parse_lf_jsonl_file(concurrent_session)
        except (OSError, ValueError):
            parse_error = "invalid_lf_jsonl"
        persisted_tags = sorted(row.get("data", {}).get("tag") for row in parsed_rows if isinstance(row.get("data"), dict) and row.get("type") == "custom" and row.get("customType") == "piui-spike-concurrent" and row.get("data", {}).get("tag") in {"writer-a", "writer-b"})
        both_tags_once = persisted_tags == ["writer-a", "writer-b"]
        concurrent_ok = not spawn_errors and set(spawned) == {"writer-a", "writer-b"} and all(all(writer_responses.get(tag, {}).values()) for tag in ("writer-a", "writer-b")) and all(writer_identity_matches.get(tag) is True for tag in ("writer-a", "writer-b")) and all(writer_exits.values()) and parse_error is None and both_tags_once
        results["SPIKE-06"] = {"status": status(concurrent_ok), "evidence": {"session_identity_expected": concurrent_session_id, "startup_dispatch": "thread barrier releases both harness-owned session_start appendEntry actions", "writer_command_responses": writer_responses, "writer_identity_matches": writer_identity_matches, "writer_runtime_exits": writer_exits, "spawn_errors": spawn_errors, "jsonl_lf_parseable": parse_error is None, "persisted_unique_tags": persisted_tags, "both_unique_entries_persisted_once": both_tags_once, "limitation": "This is a bounded custom-entry append race only; it does not establish multi-turn, tool, branch, merge, or general multi-writer safety."}}
        results["SPIKE-04"] = {"status": "inconclusive", "evidence": {"headless_auth_rpc": "No documented auth status/login RPC probe in installed schema.", "safe_test_boundary": "Harness deliberately has no credentials and does not launch interactive login."}}
    except (OSError, subprocess.SubprocessError) as error:
        results["HARNESS"] = {"status": "fail", "evidence": {"error": type(error).__name__}}
    finally:
        if not args.keep_sandbox: shutil.rmtree(root, ignore_errors=True)
    return {"schema_version": 1, "harness": "piui-phase0-rpc-python-3.13", "status_values": ["pass", "fail", "inconclusive"], "isolation": {"synthetic_sessions_only": True, "pi_coding_agent_dir": "temporary", "session_dir": "temporary", "cwd": "temporary", "offline": True, "project_resources_disabled_by_flags": True, "credentials_inherited": False}, "results": results}


def assert_spike10_contract(evidence: Any, spike_status: Any) -> None:
    if not isinstance(evidence, dict) or not isinstance(evidence.get("probes"), dict):
        raise ValueError("spike_10_missing_probe_evidence")
    probes = evidence["probes"]
    required = {"get_state", "get_tree", "get_commands", "get_available_models"}
    succeeded = required.issubset(probes) and all(isinstance(probes[name], dict) and probes[name].get("success") is True for name in required)
    if evidence.get("all_required_probes_succeeded") is not succeeded:
        raise ValueError("spike_10_inconsistent_probe_summary")
    if spike_status == "pass" and not succeeded:
        raise ValueError("spike_10_pass_without_successful_required_probes")


def assert_report_contract(report: dict[str, Any]) -> None:
    """Reject malformed or internally contradictory sanitized reports."""
    required = {"SPIKE-01", "SPIKE-02", "SPIKE-03", "SPIKE-04", "SPIKE-05", "SPIKE-06", "SPIKE-10"}
    results = report.get("results")
    if not isinstance(results, dict) or not required.issubset(results):
        raise ValueError("report_missing_required_spikes")
    allowed = {"pass", "fail", "inconclusive"}
    if any(not isinstance(results[name], dict) or results[name].get("status") not in allowed for name in required):
        raise ValueError("report_has_invalid_status")
    evidence = results["SPIKE-01"].get("evidence")
    if not isinstance(evidence, dict):
        raise ValueError("spike_01_missing_evidence")
    explicit = evidence.get("explicit_existing_launch")
    switched = evidence.get("switch_to_existing")
    crashed = evidence.get("forced_crash")
    created = evidence.get("expected_new_session")
    if not all(isinstance(item, dict) for item in (explicit, switched, crashed, created)):
        raise ValueError("spike_01_missing_operation_evidence")
    if results["SPIKE-01"]["status"] == "pass" and not (explicit["identity_matches"] and explicit["existing_entry_loaded"] and switched["identity_matches"] and switched["existing_entry_loaded"] and switched["no_ghost_file"] and crashed["identity_matches"] and crashed["existing_entry_loaded"] and crashed["runtime_exited"] and crashed["no_ghost_file"] and created["identity_matches"] and created["extension_command_response_success"] and created["runtime_exited"] and created["exactly_one_expected_file_created"] and created["in_memory_synthetic_custom_entry"] and created["valid_synthetic_custom_entry"]):
        raise ValueError("spike_01_pass_without_all_identity_and_file_checks")
    shutdown = results["SPIKE-02"].get("evidence")
    direct = shutdown.get("direct_bash_child") if isinstance(shutdown, dict) else None
    if not isinstance(direct, dict) or not all(isinstance(direct.get(name), bool) for name in ("command_dispatched", "child_ready", "pi_exited_after_stdin_close", "cleanup_invoked_after_failure")) or not (isinstance(direct.get("child_alive_after_pi_exit"), bool) or direct.get("child_alive_after_pi_exit") is None):
        raise ValueError("spike_02_missing_direct_bash_evidence")
    if results["SPIKE-02"]["status"] == "pass" and (not direct["command_dispatched"] or not direct["child_ready"] or not direct["pi_exited_after_stdin_close"] or direct["child_alive_after_pi_exit"] is not False):
        raise ValueError("spike_02_pass_without_child_cleanup")
    ui = results["SPIKE-05"].get("evidence")
    timeout_behavior = ui.get("timeout_behavior") if isinstance(ui, dict) else None
    if not isinstance(ui, dict) or not isinstance(ui.get("golden_event_corpus"), list) or not isinstance(ui.get("cancellation_resume"), dict) or not isinstance(timeout_behavior, dict) or timeout_behavior.get("status") != "inconclusive":
        raise ValueError("spike_05_missing_sanitized_golden_corpus")
    if results["SPIKE-05"]["status"] == "pass" and ui.get("golden_matches") is not True:
        raise ValueError("spike_05_pass_without_golden_match")
    assert_spike10_contract(results["SPIKE-10"].get("evidence"), results["SPIKE-10"].get("status"))
    concurrent = results["SPIKE-06"].get("evidence")
    if not isinstance(concurrent, dict) or not isinstance(concurrent.get("writer_command_responses"), dict) or not isinstance(concurrent.get("writer_identity_matches"), dict) or not isinstance(concurrent.get("writer_runtime_exits"), dict) or not isinstance(concurrent.get("spawn_errors"), list) or not isinstance(concurrent.get("jsonl_lf_parseable"), bool) or not isinstance(concurrent.get("both_unique_entries_persisted_once"), bool):
        raise ValueError("spike_06_missing_concurrent_append_evidence")
    if results["SPIKE-06"]["status"] == "pass" and not (set(concurrent["writer_command_responses"]) == {"writer-a", "writer-b"} and set(concurrent["writer_identity_matches"]) == {"writer-a", "writer-b"} and set(concurrent["writer_runtime_exits"]) == {"writer-a", "writer-b"} and not concurrent["spawn_errors"] and all(all(result.get(command_name) is True for command_name in ("get_state", "get_tree")) for result in concurrent["writer_command_responses"].values()) and all(value is True for value in concurrent["writer_identity_matches"].values()) and all(value is True for value in concurrent["writer_runtime_exits"].values()) and concurrent["jsonl_lf_parseable"] and concurrent["both_unique_entries_persisted_once"]):
        raise ValueError("spike_06_pass_without_bounded_concurrent_append_proof")


def g0_approved(report: dict[str, Any]) -> bool:
    results = report.get("results")
    return isinstance(results, dict) and all(isinstance(results.get(name), dict) and results[name].get("status") == "pass" for name in REQUIRED_G0_SPIKES)


def parse_pi_version(output: str) -> str | None:
    """Keep only a strict version token; never place executable output in reports."""
    first_line = output.splitlines()[0].strip() if output else ""
    return first_line if re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", first_line) else None


def pi_version(pi: str) -> str | None:
    try:
        completed = subprocess.run(pi_argv(pi, ["--version"]), capture_output=True, text=True, timeout=5, check=False)
        return parse_pi_version(completed.stdout)
    except (OSError, subprocess.SubprocessError):
        return None


def redaction_self_test() -> None:
    source = {"accessToken": "access-value", "refresh_token": "refresh-value", "password": "password-value", "credentials": {"clientSecret": "client-secret"}, "safe": {"status": "ok", "messageCount": 1, "nested": {"apiKey": "api-key", "refreshToken": "nested-refresh", "secretValue": "nested-secret"}}}
    sanitized = sanitize(source)
    assert sanitized["accessToken"] == "<redacted>"
    assert sanitized["refresh_token"] == "<redacted>"
    assert sanitized["password"] == "<redacted>"
    assert sanitized["credentials"] == "<redacted>"
    assert sanitized["safe"]["nested"]["apiKey"] == "<redacted>"
    assert sanitized["safe"]["nested"]["refreshToken"] == "<redacted>"
    assert sanitized["safe"]["nested"]["secretValue"] == "<redacted>"
    assert sanitized["safe"]["status"] == "ok"
    assert sanitized["safe"]["messageCount"] == 1
    assert sanitize({"unknown": r"C:\\synthetic\\secret.txt", "url": "https://user:pass@example.test/x", "query": "https://example.test/x?api_key=secret", "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue"}) == {"unknown": "<redacted>", "url": "<redacted-url>", "query": "<redacted-url>", "jwt": "<redacted>"}
    assert sanitize("https://example.test/safe?mode=offline#fragment") == "https://example.test/safe?mode=offline"
    assert parse_pi_version("1.2.3\n") == "1.2.3"
    assert parse_pi_version("1.2.3 token=secret") is None
    try:
        assert_spike10_contract({"probes": {"get_state": {"success": True}, "get_tree": {"success": False}, "get_commands": {"success": True}, "get_available_models": {"success": True}}, "all_required_probes_succeeded": False}, "pass")
    except ValueError:
        pass
    else:
        raise AssertionError("SPIKE-10 negative contract accepted a failed probe")


def codec_self_test() -> int:
    decoder = LfJsonlDecoder(); rows = decoder.feed(b'{"type":"x","text":"a\\u2028b"}\n{"type":"y"') + decoder.feed(b'}\r\n')
    decoder.finish()
    assert [row["type"] for row in rows] == ["x", "y"] and rows[0]["text"] == "a\u2028b"
    try: LfJsonlDecoder(2).feed(b"abc")
    except ValueError:
        redaction_self_test()
        return 0
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", default="pi", help="Pi executable (default: pi)")
    parser.add_argument("--report", type=Path, default=Path("report.json"))
    parser.add_argument("--keep-sandbox", action="store_true")
    parser.add_argument("--codec-self-test", action="store_true")
    parser.add_argument("--require-g0", action="store_true", help="Exit nonzero unless every required RPC spike passes.")
    args = parser.parse_args()
    if args.codec_self_test: return codec_self_test()
    report = run(args); assert_report_contract(report); args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    if "HARNESS" in report["results"]:
        return 1
    return 0 if not args.require_g0 or g0_approved(report) else 2

if __name__ == "__main__": raise SystemExit(main())
