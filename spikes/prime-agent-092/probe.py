#!/usr/bin/env python3
"""Static Prime Agent 0.9.2 SDK compatibility evidence.

Reads only the explicit installed package root and this spike's own artifacts.
It never starts Prime, opens sessions, or reads credentials.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

EXPECTED_NAME = "prime-agent"
EXPECTED_VERSION = "0.9.2"
SCHEMA_VERSION = 1
PACKAGE_ARTIFACTS = (
    "package.json",
    "docs/sdk.md",
    "docs/daemon.md",
    "dist/index.d.ts",
    "dist/core/agent-session-runtime.js",
    "dist/core/agent-session-services.js",
    "dist/core/auth-storage.d.ts",
    "dist/core/session-lease.js",
    "dist/modes/agent-connection/in-process-agent-connection.js",
    "dist/modes/agent-connection/in-process-agent-connection.d.ts",
    "node_modules/@earendil-works/pi-ai/package.json",
    "node_modules/@earendil-works/pi-ai/dist/index.js",
)
SPIKE_ARTIFACTS = (
    "DECISION.md",
    "README.md",
    "sdk-host.mjs",
    "descendant-fixture.mjs",
    "probe.py",
    "run_tests.py",
    "tests/__init__.py",
    "tests/test_lifecycle.py",
    "reports/.gitignore",
    "reports/test-results.txt",
)

class ProbeFailure(ValueError):
    pass

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def read_under(root: Path, relative: str) -> tuple[str, str]:
    try:
        candidate = (root / relative).resolve(strict=True)
        candidate.relative_to(root)
    except (OSError, ValueError) as error:
        raise ProbeFailure(f"artifact unavailable: {relative}") from error
    if not candidate.is_file():
        raise ProbeFailure(f"artifact is not a file: {relative}")
    data = candidate.read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ProbeFailure(f"artifact is not UTF-8: {relative}") from error
    return text, sha256(data)

def inspect_package(package_root: Path, spike_root: Path | None = None) -> dict[str, object]:
    root = package_root.resolve(strict=True)
    if not root.is_dir():
        raise ProbeFailure("package root is not a directory")
    sources: dict[str, str] = {}
    hashes: dict[str, str] = {}
    for relative in PACKAGE_ARTIFACTS:
        sources[relative], hashes[relative] = read_under(root, relative)
    manifest = json.loads(sources["package.json"])
    identity = (
        manifest.get("name") == EXPECTED_NAME
        and manifest.get("version") == EXPECTED_VERSION
        and manifest.get("exports", {}).get(".", {}).get("import") == "./dist/index.js"
        and manifest.get("engines", {}).get("node") == ">=22.8.0"
    )
    index = sources["dist/index.d.ts"]
    runtime = sources["dist/core/agent-session-runtime.js"]
    services = sources["dist/core/agent-session-services.js"]
    connection = sources["dist/modes/agent-connection/in-process-agent-connection.js"]
    connection_types = sources["dist/modes/agent-connection/in-process-agent-connection.d.ts"]
    sdk_docs = sources["docs/sdk.md"]
    daemon_docs = sources["docs/daemon.md"]
    lease = sources["dist/core/session-lease.js"]

    sdk_route = all(fragment in index for fragment in (
        "createAgentSessionRuntime", "createAgentSessionServices", "createAgentSessionFromServices",
        "InProcessAgentConnection", "SessionManager", "AuthStorage", "ModelRegistry", "SettingsManager",
    )) and all(fragment in sdk_docs for fragment in (
        "Build a custom UI", "createAgentSessionRuntime()", "AgentSessionRuntime",
        "newSession()", "switchSession()", "importFromJsonl()",
    ))
    lifecycle = all(fragment in runtime for fragment in (
        "async switchSession(", "async newSession(", "async fork(", "async importFromJsonl(",
        "async dispose(", "acquireReplacementLease", "releaseSessionLease",
    )) and all(fragment in lease for fragment in (
        "export function acquireSessionLease", "session_already_active", "canonicalSessionPath",
    ))
    isolated_services = all(fragment in services for fragment in (
        "options.authStorage ??", "options.settingsManager ??", "options.modelRegistry ??",
        "options.resourceLoaderOptions", "options.telemetryDisabled",
    ))
    daemon_only = [
        "manageHeartbeat", "addCronJob", "cancelCronJob", "setHeartbeat", "updateHeartbeat",
        "sendAgentMessage", "getAgentMessageStatus", "pauseAgentMessages", "resumeAgentMessages", "clearAgentMessages",
    ]
    daemon_only_rejected = all(
        f"async {name}(" in connection and "daemon mode" in connection[connection.index(f"async {name}("):connection.index(f"async {name}(") + 500].lower()
        for name in daemon_only
    )
    operations = [
        "getState", "getInitialSnapshot", "getRlmChildSnapshots", "getMessages", "getSessionHeader",
        "getCommands", "getResourceSnapshot", "getAvailableModels", "getModelCatalog", "getSessionStats",
        "getContextTree", "getSessionContext", "getSessionTree", "listSavedSessions", "getQueue",
        "mutateQueuedMessage", "clearQueue", "abortAndClearQueue", "prompt", "promptAndWait", "steer",
        "followUp", "abort", "cancelRlmChild", "waitForIdle", "executeBash", "executeBashAndWait",
        "abortBash", "setModel", "cycleModel", "setScopedModels", "setThinkingLevel", "setServiceTier",
        "cycleThinkingLevel", "setTransport", "setSteeringMode", "setFollowUpMode",
        "setAutoCompactionEnabled", "setAutoRetryEnabled", "compact", "refine", "abortCompaction",
        "abortBranchSummary", "abortRetry", "reload", "newSession", "switchSession", "fork",
        "navigateTree", "importFromJsonl", "exportToHtml", "exportToJsonl", "setSessionName",
        "getRlmMaxDepthStatus", "setRlmMaxDepth", "renameSavedSession", "deleteSavedSession", "watchSession", "dispose",
    ]
    operation_surface = all(f"{name}(" in connection_types for name in operations)
    direct_sdk_no_daemon = "Direct SDK calls to print and RPC modes remain in-process" in daemon_docs
    inert_daemon_guard = True
    if spike_root is not None:
        host_source, _ = read_under(spike_root.resolve(strict=True), "sdk-host.mjs")
        inert_daemon_guard = (
            'args["daemon-socket"]' in host_source
            and 'daemonContact: "none"' in host_source
            and "DaemonClient" not in host_source
            and "defaultDaemonSocketPath" not in host_source
            and "runRpcMode" not in host_source
        )

    checks = {
        "package_identity": identity,
        "documented_custom_ui_sdk_route": sdk_route,
        "runtime_lifecycle_and_leases": lifecycle,
        "injectable_isolated_services": isolated_services,
        "in_process_operation_surface": operation_surface,
        "daemon_only_operations_fail_explicitly": daemon_only_rejected,
        "direct_sdk_does_not_require_daemon": direct_sdk_no_daemon,
        "nondefault_daemon_socket_is_inert_guard_only": inert_daemon_guard,
    }
    evidence: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "package": {"name": manifest.get("name"), "version": manifest.get("version")},
        "overall_status": "pass" if all(checks.values()) else "fail",
        "checks": {name: {"status": "pass" if status else "fail"} for name, status in checks.items()},
        "route": {
            "transport": "documented-sdk-in-piui-owned-isolated-child",
            "daemon_contact": "none",
            "default_daemon_created_connected_or_stopped": False,
            "credential_files_read_by_probe": False,
            "user_sessions_read_by_probe": False,
            "operation_surface": operations,
            "daemon_only_rejections": daemon_only,
        },
        "package_artifacts": [{"file": name, "sha256": hashes[name]} for name in PACKAGE_ARTIFACTS],
    }
    if spike_root is not None:
        own_hashes = []
        own_root = spike_root.resolve(strict=True)
        for relative in SPIKE_ARTIFACTS:
            _, digest = read_under(own_root, relative)
            own_hashes.append({"file": relative, "sha256": digest})
        evidence["spike_artifacts"] = own_hashes
    return evidence

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        report = inspect_package(args.package_root, Path(__file__).resolve().parent)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"probe failed: {error}")
        return 2
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded, encoding="utf-8")
    else:
        print(encoded, end="")
    return 0 if report["overall_status"] == "pass" else 2

if __name__ == "__main__":
    raise SystemExit(main())
