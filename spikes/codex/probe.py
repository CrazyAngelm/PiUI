#!/usr/bin/env python3
"""Codex app-server 0.147.0 native protocol spike.

The live path is deliberately prompt-free. It uses an isolated disposable
CODEX_HOME, disables startup features that attempted remote plugin warmup in the
control run, and never reads a user's Codex config, sessions, or auth files.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SPIKE_ROOT = Path(__file__).resolve().parent
FIXTURE_PATH = SPIKE_ROOT / "fixtures" / "protocol-contract-0.147.0.json"
STREAM_FIXTURE_PATH = SPIKE_ROOT / "fixtures" / "stream-and-approval.synthetic.jsonl"
WORKSPACE_PATH = SPIKE_ROOT / "fixtures" / "workspace"
BRIDGE_MANIFEST = SPIKE_ROOT / "native-bridge" / "Cargo.toml"
TARGET_DIRECTORY = SPIKE_ROOT / ".target"
# Bounded execution is required by the repository platform contract. The app
# bound matches the existing Windows E2E runner's 15-second bound. Cold Rust
# builds and generators receive larger bounds because they may update/compile a
# dependency index; the checked-in verification measured 8s and <1s respectively.
APP_BOUND_SECONDS = 15.0
GENERATOR_BOUND_SECONDS = 30.0
BUILD_BOUND_SECONDS = 120.0
MAX_FRAME_BYTES = 4 * 1024 * 1024
VERSION_PATTERN = re.compile(r"codex-cli (\d+\.\d+\.\d+)")
NETWORK_MARKERS = ("http://", "https://", "unauthorized", "remote featured plugin")
DISABLED_STARTUP_FEATURES = (
    "apps",
    "plugins",
    "remote_plugin",
    "recommended_plugins",
    "shell_snapshot",
)
SAFE_ENV_KEYS = (
    "PATH",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "USERNAME",
    "HOMEDRIVE",
    "HOMEPATH",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
)


class ProbeFailure(RuntimeError):
    """Expected, redacted probe failure."""


class LfJsonlDecoder:
    """Incremental UTF-8 JSON decoder with byte 0x0A as the only delimiter."""

    def __init__(self, max_frame_bytes: int = MAX_FRAME_BYTES) -> None:
        self.buffer = bytearray()
        self.max_frame_bytes = max_frame_bytes

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        self.buffer.extend(chunk)
        frames: list[dict[str, Any]] = []
        while True:
            newline = self.buffer.find(b"\n")
            if newline < 0:
                if len(self.buffer) > self.max_frame_bytes:
                    raise ProbeFailure("protocol_frame_limit_exceeded")
                return frames
            raw = bytes(self.buffer[:newline])
            del self.buffer[: newline + 1]
            if raw.endswith(b"\r"):
                raw = raw[:-1]
            if not raw:
                continue
            if len(raw) > self.max_frame_bytes:
                raise ProbeFailure("protocol_frame_limit_exceeded")
            try:
                value = json.loads(raw.decode("utf-8", errors="strict"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ProbeFailure("invalid_protocol_frame") from error
            if not isinstance(value, dict):
                raise ProbeFailure("protocol_frame_is_not_object")
            frames.append(value)

    def finish(self) -> None:
        if self.buffer:
            raise ProbeFailure("incomplete_protocol_frame")


@dataclass
class Capture:
    returncode: int
    stdout: bytes
    stderr: bytes


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def capture_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_fixture() -> dict[str, Any]:
    value = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ProbeFailure("contract_fixture_is_not_object")
    return value


def sanitized_environment(codex_home: Path) -> dict[str, str]:
    env = {key: os.environ[key] for key in SAFE_ENV_KEYS if key in os.environ}
    env.update(
        {
            "CODEX_HOME": str(codex_home),
            "RUST_LOG": "warn",
            "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9",
            "ALL_PROXY": "http://127.0.0.1:9",
            "NO_PROXY": "",
        }
    )
    return env


def has_sensitive_environment_key(env: dict[str, str]) -> bool:
    allowed_proxy_keys = {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
    for key in env:
        upper = key.upper()
        if key in allowed_proxy_keys:
            continue
        if any(marker in upper for marker in ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "AUTH")):
            return True
    return False


def resolve_native_codex(explicit: Path | None) -> Path:
    if explicit is not None:
        candidate = explicit.resolve()
        if candidate.is_file():
            return candidate
        raise ProbeFailure("explicit_codex_executable_not_found")

    command = shutil.which("codex")
    if command is None:
        raise ProbeFailure("codex_not_found")
    command_path = Path(command).resolve()
    if command_path.suffix.lower() == ".exe":
        return command_path

    npm_root = command_path.parent / "node_modules" / "@openai" / "codex"
    platform_patterns = (
        "node_modules/@openai/codex-*/vendor/*/bin/codex.exe",
        "node_modules/@openai/codex-*/vendor/*/bin/codex",
        "vendor/*/bin/codex.exe",
        "vendor/*/bin/codex",
    )
    candidates: list[Path] = []
    for pattern in platform_patterns:
        candidates.extend(npm_root.glob(pattern))
    files = sorted({path.resolve() for path in candidates if path.is_file()})
    if len(files) != 1:
        raise ProbeFailure("native_codex_executable_not_uniquely_resolved")
    return files[0]


def package_provenance(native: Path) -> dict[str, Any]:
    manifest = native.parent.parent / "codex-package.json"
    if not manifest.is_file():
        raise ProbeFailure("native_codex_package_manifest_not_found")
    value = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ProbeFailure("native_codex_package_manifest_invalid")
    return {
        "version": value.get("version"),
        "target": value.get("target"),
        "entrypoint": value.get("entrypoint"),
        "executableSha256": sha256_file(native),
    }


async def terminate_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.kill()
    try:
        await asyncio.wait_for(process.wait(), 5.0)
    except asyncio.TimeoutError as error:
        raise ProbeFailure("process_cleanup_timeout") from error


async def capture_command(
    arguments: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    bound: float,
) -> Capture:
    process = await asyncio.create_subprocess_exec(
        *arguments,
        cwd=str(cwd),
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), bound)
    except asyncio.TimeoutError as error:
        await terminate_process(process)
        raise ProbeFailure("bounded_command_timeout") from error
    return Capture(process.returncode or 0, stdout, stderr)


async def build_bridge(env: dict[str, str]) -> Path:
    cargo = shutil.which("cargo")
    if cargo is None:
        raise ProbeFailure("cargo_not_found")
    result = await capture_command(
        [
            cargo,
            "build",
            "--quiet",
            "--manifest-path",
            str(BRIDGE_MANIFEST),
            "--target-dir",
            str(TARGET_DIRECTORY),
        ],
        cwd=SPIKE_ROOT,
        env=env,
        bound=BUILD_BOUND_SECONDS,
    )
    if result.returncode != 0:
        raise ProbeFailure("native_bridge_build_failed")
    suffix = ".exe" if os.name == "nt" else ""
    bridge = TARGET_DIRECTORY / "debug" / f"piui-codex-native-bridge{suffix}"
    if not bridge.is_file():
        raise ProbeFailure("native_bridge_output_missing")
    return bridge


async def generate_protocol(native: Path, root: Path, env: dict[str, str]) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    ts_dir = root / "typescript"
    schema_dir = root / "schema"
    ts_dir.mkdir()
    schema_dir.mkdir()
    commands = (
        [str(native), "app-server", "generate-ts", "--experimental", "--out", str(ts_dir)],
        [str(native), "app-server", "generate-json-schema", "--experimental", "--out", str(schema_dir)],
    )
    results = await asyncio.gather(
        *(capture_command(command, cwd=WORKSPACE_PATH, env=env, bound=GENERATOR_BOUND_SECONDS) for command in commands)
    )
    if any(result.returncode != 0 for result in results):
        raise ProbeFailure("protocol_generation_failed")
    validation = validate_generated_protocol(ts_dir, schema_dir, load_fixture())
    bundle = schema_dir / "codex_app_server_protocol.v2.schemas.json"
    validation["v2SchemaSha256"] = sha256_file(bundle)
    validation["typescriptFileCount"] = sum(1 for path in ts_dir.rglob("*.ts") if path.is_file())
    validation["jsonSchemaFileCount"] = sum(1 for path in schema_dir.rglob("*.json") if path.is_file())
    return validation


def validate_generated_protocol(
    ts_dir: Path, schema_dir: Path, fixture: dict[str, Any]
) -> dict[str, Any]:
    client_requests = (ts_dir / "ClientRequest.ts").read_text(encoding="utf-8")
    client_notifications = (ts_dir / "ClientNotification.ts").read_text(encoding="utf-8")
    server_requests = (ts_dir / "ServerRequest.ts").read_text(encoding="utf-8")
    server_notifications = (ts_dir / "ServerNotification.ts").read_text(encoding="utf-8")
    texts = {
        "clientRequests": client_requests,
        "serverRequests": server_requests,
        "streamNotifications": server_notifications,
    }
    for fixture_key, text in texts.items():
        for method in fixture[fixture_key]:
            if f'"method": "{method}"' not in text:
                raise ProbeFailure(f"generated_method_missing:{method}")
    if '"method": "initialized"' not in client_notifications:
        raise ProbeFailure("generated_initialized_notification_missing")

    jsonrpc_request = json.loads((schema_dir / "JSONRPCRequest.json").read_text(encoding="utf-8"))
    properties = jsonrpc_request.get("properties", {})
    if "jsonrpc" in properties or sorted(jsonrpc_request.get("required", [])) != ["id", "method"]:
        raise ProbeFailure("wire_envelope_changed")

    required_files = {
        "InitializeCapabilities.ts": fixture["handshake"]["capabilitiesRequired"],
        "v2/TurnStartParams.ts": fixture["turnStartRequired"],
        "v2/TurnInterruptParams.ts": fixture["turnInterruptRequired"],
    }
    for relative, fields in required_files.items():
        text = (ts_dir / relative).read_text(encoding="utf-8")
        for field in fields:
            if re.search(rf"\b{re.escape(field)}\??:", text) is None:
                raise ProbeFailure(f"generated_field_missing:{relative}:{field}")

    for relative, decisions in (
        ("v2/CommandExecutionApprovalDecision.ts", fixture["approvalDecisions"]["commandExecution"]),
        ("v2/FileChangeApprovalDecision.ts", fixture["approvalDecisions"]["fileChange"]),
        ("ReviewDecision.ts", fixture["approvalDecisions"]["legacyReview"]),
    ):
        text = (ts_dir / relative).read_text(encoding="utf-8")
        for decision in decisions:
            if f'"{decision}"' not in text:
                raise ProbeFailure(f"approval_decision_missing:{decision}")

    return {
        "fixtureMatched": True,
        "requestMethodCount": len(set(re.findall(r'"method": "([^"]+)"', client_requests))),
        "serverRequestMethodCount": len(set(re.findall(r'"method": "([^"]+)"', server_requests))),
        "notificationMethodCount": len(set(re.findall(r'"method": "([^"]+)"', server_notifications))),
        "jsonrpcMemberAbsent": True,
    }


def validate_synthetic_fixture() -> dict[str, Any]:
    decoder = LfJsonlDecoder()
    frames: list[dict[str, Any]] = []
    content = STREAM_FIXTURE_PATH.read_bytes()
    # Deliberately split across arbitrary byte boundaries to prove incremental LF framing.
    for offset in range(0, len(content), 17):
        frames.extend(decoder.feed(content[offset : offset + 17]))
    decoder.finish()
    fixture = load_fixture()
    stream_methods = set(fixture["streamNotifications"])
    server_methods = set(fixture["serverRequests"])
    outstanding: dict[str, str] = {}
    resolved: list[str] = []
    for frame in frames:
        method = frame.get("method")
        request_id = frame.get("id")
        if method in server_methods and request_id is not None:
            outstanding[str(request_id)] = str(method)
        elif method is not None and method not in stream_methods:
            raise ProbeFailure(f"unknown_synthetic_notification:{method}")
        if method is None and request_id is not None and "result" in frame:
            key = str(request_id)
            if key not in outstanding:
                raise ProbeFailure("synthetic_response_without_request")
            decision = frame["result"].get("decision")
            family = "commandExecution" if outstanding[key].startswith("item/command") else "fileChange"
            if decision not in fixture["approvalDecisions"][family]:
                raise ProbeFailure("synthetic_approval_decision_invalid")
            resolved.append(key)
    if sorted(outstanding) != sorted(resolved):
        raise ProbeFailure("synthetic_approval_request_unresolved")
    return {"frameCount": len(frames), "approvalRoundTrips": len(resolved), "fixtureMatched": True}


class AppServerClient:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self.process = process
        self.notifications: list[dict[str, Any]] = []

    async def send(self, value: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise ProbeFailure("app_server_stdin_missing")
        self.process.stdin.write(json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n")
        await self.process.stdin.drain()

    async def call(self, request_id: int, method: str, params: Any) -> dict[str, Any]:
        await self.send({"method": method, "id": request_id, "params": params})
        loop = asyncio.get_running_loop()
        deadline = loop.time() + APP_BOUND_SECONDS
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise ProbeFailure(f"app_server_response_timeout:{method}")
            message = await self.read_message(remaining)
            if (
                message.get("id") == request_id
                and "method" not in message
                and ("result" in message or "error" in message)
            ):
                return message
            self.notifications.append(message)

    async def read_message(self, remaining: float) -> dict[str, Any]:
        if self.process.stdout is None:
            raise ProbeFailure("app_server_stdout_missing")
        try:
            raw = await asyncio.wait_for(self.process.stdout.readuntil(b"\n"), remaining)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            raise ProbeFailure("app_server_frame_read_failed") from error
        if len(raw) > MAX_FRAME_BYTES:
            raise ProbeFailure("app_server_frame_limit_exceeded")
        frames = LfJsonlDecoder().feed(raw)
        if len(frames) != 1:
            raise ProbeFailure("app_server_frame_count_invalid")
        return frames[0]


async def drain_stderr(reader: asyncio.StreamReader) -> dict[str, Any]:
    line_count = 0
    remote_attempt_observed = False
    carry = ""
    while True:
        chunk = await reader.read(4096)
        if not chunk:
            break
        line_count += chunk.count(b"\n")
        text = (carry + chunk.decode("utf-8", errors="replace")).lower()
        remote_attempt_observed = remote_attempt_observed or any(
            marker in text for marker in NETWORK_MARKERS
        )
        carry = text[-128:]
    return {"lineCount": line_count, "remoteAttemptObserved": remote_attempt_observed}


async def wait_for_fixture_pid(path: Path) -> int:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 10.0  # Existing PiUI containment readiness bound.
    while loop.time() < deadline:
        if path.is_file():
            try:
                return int(path.read_text(encoding="ascii").strip())
            except (OSError, ValueError) as error:
                raise ProbeFailure("process_fixture_pid_invalid") from error
        await asyncio.sleep(0.02)  # Existing PiUI containment poll interval.
    raise ProbeFailure("process_fixture_readiness_timeout")


def windows_process_is_alive(process_id: int) -> bool:
    if os.name != "nt":
        raise ProbeFailure("windows_process_check_on_non_windows")
    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(process_query_limited_information, False, process_id)
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


async def live_probe(native: Path, bridge: Path, root: Path, env: dict[str, str]) -> dict[str, Any]:
    home = root / "codex-home"
    home.mkdir()
    live_env = sanitized_environment(home)
    if has_sensitive_environment_key(live_env):
        raise ProbeFailure("sensitive_environment_key_in_allowlist")
    arguments = [str(bridge), "--max-runtime-ms", "30000", "--", str(native), "app-server", "--stdio", "-c", "analytics.enabled=false"]
    for feature in DISABLED_STARTUP_FEATURES:
        arguments.extend(("--disable", feature))
    process = await asyncio.create_subprocess_exec(
        *arguments,
        cwd=str(WORKSPACE_PATH),
        env=live_env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=MAX_FRAME_BYTES,
    )
    stderr_task = asyncio.create_task(drain_stderr(process.stderr)) if process.stderr is not None else None
    client = AppServerClient(process)
    try:
        initialized = await client.call(
            1,
            "initialize",
            {
                "clientInfo": {"name": "piui-codex-spike", "title": "PiUI Codex spike", "version": "0.1.0"},
                "capabilities": {
                    "experimentalApi": True,
                    "requestAttestation": False,
                    "optOutNotificationMethods": ["remoteControl/status/changed"],
                },
            },
        )
        if "result" not in initialized:
            raise ProbeFailure("initialize_failed")
        await client.send({"method": "initialized"})
        started = await client.call(
            2,
            "thread/start",
            {
                "cwd": str(WORKSPACE_PATH.resolve()),
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "ephemeral": False,
            },
        )
        thread = started.get("result", {}).get("thread", {})
        thread_id = thread.get("id")
        if not isinstance(thread_id, str):
            raise ProbeFailure("thread_start_missing_id")
        injected = await client.call(
            3,
            "thread/inject_items",
            {
                "threadId": thread_id,
                "items": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "synthetic fixture; no model turn"}],
                    }
                ],
            },
        )
        read = await client.call(4, "thread/read", {"threadId": thread_id, "includeTurns": True})
        resumed = await client.call(5, "thread/resume", {"threadId": thread_id, "excludeTurns": False})
        listed = await client.call(
            6,
            "thread/list",
            {"limit": 10, "cwd": str(WORKSPACE_PATH.resolve()), "sourceKinds": ["vscode", "appServer"]},
        )
        interrupted = await client.call(
            7,
            "turn/interrupt",
            {"threadId": thread_id, "turnId": "00000000-0000-0000-0000-000000000000"},
        )
        unknown = await client.call(
            8,
            "thread/read",
            {"threadId": "00000000-0000-0000-0000-000000000000", "includeTurns": True},
        )
        process_fixture_root = root / "process-tree"
        spawned = await client.call(
            9,
            "process/spawn",
            {
                "command": [
                    sys.executable,
                    str((SPIKE_ROOT / "fixtures" / "process_tree_fixture.py").resolve()),
                    str(process_fixture_root),
                    "root",
                ],
                "processHandle": "piui-containment-fixture",
                "cwd": str(WORKSPACE_PATH.resolve()),
                "streamStdin": False,
                "streamStdoutStderr": False,
                "outputBytesCap": 4096,
                "timeoutMs": 30000,
                "env": {},
            },
        )
        if spawned.get("result") != {}:
            raise ProbeFailure("process_fixture_spawn_failed")
        fixture_root_pid = await wait_for_fixture_pid(process_fixture_root / "root.pid")
        expected_descendant_pid = await wait_for_fixture_pid(process_fixture_root / "descendant.expected.pid")
        fixture_descendant_pid = await wait_for_fixture_pid(process_fixture_root / "descendant.pid")
        if fixture_descendant_pid != expected_descendant_pid:
            raise ProbeFailure("process_fixture_descendant_identity_mismatch")
        if not windows_process_is_alive(fixture_root_pid) or not windows_process_is_alive(fixture_descendant_pid):
            raise ProbeFailure("process_fixture_not_alive_before_teardown")
        if process.stdin is None:
            raise ProbeFailure("app_server_stdin_missing")
        process.stdin.close()
        await process.stdin.wait_closed()
        try:
            returncode = await asyncio.wait_for(process.wait(), APP_BOUND_SECONDS)
        except asyncio.TimeoutError as error:
            await terminate_process(process)
            raise ProbeFailure("app_server_eof_shutdown_timeout") from error
        stderr_summary = await stderr_task if stderr_task is not None else {"lineCount": 0, "remoteAttemptObserved": False}
    finally:
        if process.returncode is None:
            await terminate_process(process)
        if stderr_task is not None and not stderr_task.done():
            stderr_task.cancel()

    result = initialized["result"]
    list_data = listed.get("result", {}).get("data")
    fixture_root_alive_after = windows_process_is_alive(fixture_root_pid)
    fixture_descendant_alive_after = windows_process_is_alive(fixture_descendant_pid)
    return {
        "containedByPiuiWindowsJob": os.name == "nt",
        "processTreeFixture": {
            "rootAliveBeforeTeardown": True,
            "descendantAliveBeforeTeardown": True,
            "rootAliveAfterTeardown": fixture_root_alive_after,
            "descendantAliveAfterTeardown": fixture_descendant_alive_after,
        },
        "returncode": returncode,
        "initialize": {
            "codexHomeIsIsolated": Path(result.get("codexHome", "")).resolve() == home.resolve(),
            "platformFamily": result.get("platformFamily"),
            "platformOs": result.get("platformOs"),
        },
        "threadStart": {
            "ok": "result" in started,
            "status": thread.get("status", {}).get("type"),
            "turnCount": len(thread.get("turns", [])),
        },
        "syntheticMaterialization": {"ok": injected.get("result") == {}, "modelTurnStarted": False},
        "threadRead": {"ok": read.get("result", {}).get("thread", {}).get("id") == thread_id},
        "threadResume": {"ok": resumed.get("result", {}).get("thread", {}).get("id") == thread_id},
        "threadList": {
            "ok": isinstance(list_data, list),
            "createdZeroTurnThreadVisible": any(item.get("id") == thread_id for item in list_data or []),
        },
        "interruptFailure": {
            "code": interrupted.get("error", {}).get("code"),
            "messageClass": "no_active_turn" if "no active turn" in interrupted.get("error", {}).get("message", "").lower() else "other",
        },
        "unknownThreadFailure": {"code": unknown.get("error", {}).get("code")},
        "observedNotifications": sorted(
            {str(message["method"]) for message in client.notifications if "method" in message}
        ),
        "startupRemoteAttemptObserved": stderr_summary["remoteAttemptObserved"],
        "stderrLineCount": stderr_summary["lineCount"],
        "environmentAllowlistKeys": sorted(live_env),
        "sensitiveEnvironmentInherited": False,
        "disabledStartupFeatures": list(DISABLED_STARTUP_FEATURES),
    }


async def run_probe(explicit_codex: Path | None) -> dict[str, Any]:
    fixture = load_fixture()
    native = resolve_native_codex(explicit_codex)
    with tempfile.TemporaryDirectory(prefix="run-", dir=SPIKE_ROOT / ".probe-work") as raw_root:
        work = Path(raw_root)
        env = sanitized_environment(work / "generation-home")
        version_result = await capture_command(
            [str(native), "--version"], cwd=WORKSPACE_PATH, env=env, bound=GENERATOR_BOUND_SECONDS
        )
        match = VERSION_PATTERN.fullmatch(version_result.stdout.decode("utf-8", errors="strict").strip())
        if version_result.returncode != 0 or match is None:
            raise ProbeFailure("codex_version_probe_failed")
        cli_version = match.group(1)
        if cli_version != fixture["codexCliVersion"]:
            raise ProbeFailure("codex_version_does_not_match_fixture")
        provenance = package_provenance(native)
        if provenance["version"] != cli_version:
            raise ProbeFailure("native_package_version_mismatch")
        generated = await generate_protocol(native, work / "generated", env)
        bridge = await build_bridge(env)
        live = await live_probe(native, bridge, work, env)
    return {
        "schemaVersion": 1,
        "capturedAtUtc": capture_timestamp(),
        "passed": all(
            (
                generated["fixtureMatched"],
                live["returncode"] == 0,
                live["initialize"]["codexHomeIsIsolated"],
                live["threadStart"]["ok"],
                live["threadRead"]["ok"],
                live["threadResume"]["ok"],
                live["threadList"]["ok"],
                live["processTreeFixture"]["rootAliveBeforeTeardown"],
                live["processTreeFixture"]["descendantAliveBeforeTeardown"],
                not live["processTreeFixture"]["rootAliveAfterTeardown"],
                not live["processTreeFixture"]["descendantAliveAfterTeardown"],
                live["interruptFailure"]["code"] == -32600,
                live["unknownThreadFailure"]["code"] == -32600,
                not live["startupRemoteAttemptObserved"],
                not live["sensitiveEnvironmentInherited"],
            )
        ),
        "codex": {"cliVersion": cli_version, **provenance},
        "generatedProtocol": generated,
        "syntheticFixture": validate_synthetic_fixture(),
        "livePromptFreeProbe": live,
        "limitations": [
            "No turn/start was sent and no model/auth/approval lifecycle was exercised.",
            "The synthetic zero-turn thread was readable/resumable but absent from thread/list.",
            "No reconnect, replay, interrupt race, or approval timeout ordering was tested.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", type=Path, help="Explicit native codex executable")
    parser.add_argument(
        "--report", type=Path, default=SPIKE_ROOT / "reports" / "latest.json", help="Redacted JSON report"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    (SPIKE_ROOT / ".probe-work").mkdir(exist_ok=True)
    try:
        report = asyncio.run(run_probe(args.codex))
    except (OSError, ProbeFailure, UnicodeError, json.JSONDecodeError) as error:
        failure = {"schemaVersion": 1, "capturedAtUtc": capture_timestamp(), "passed": False, "error": str(error)}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(failure, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(failure, separators=(",", ":")))
        return 1
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, separators=(",", ":")))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
