#!/usr/bin/env python3
"""Static, non-executing Prime Agent 0.8.1 integration evidence probe.

The probe reads only an explicit allowlist of files below an explicitly supplied
installed package root. It never starts Prime Agent and never discovers or opens
user sessions, auth.json, harness artifacts, logs, or project files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import posixpath
import re
import sys
from typing import Any, Iterable

EXPECTED_PACKAGE_NAME = "prime-agent"
EXPECTED_VERSION = "0.8.1"
REPORT_SCHEMA_VERSION = 2
BUNDLE_ENTRYPOINT = "dist/bundle/cli.js"

ALLOWLIST = (
    "package.json",
    "README.md",
    "docs/daemon.md",
    "docs/extensions.md",
    "docs/rpc.md",
    "docs/sessions.md",
    "dist/cli/args.js",
    "dist/config.js",
    "dist/core/agent-session.js",
    "dist/core/extensions/bundled-modules.js",
    "dist/core/extensions/loader.js",
    "dist/core/extensions/types.d.ts",
    "dist/core/session-manager.js",
    "dist/core/slash-commands.js",
    "dist/main.js",
    "dist/migrations.js",
    "dist/modes/rpc/jsonl.js",
    "dist/modes/rpc/rpc-mode.js",
)


class ProbeFailure(ValueError):
    """The explicit package does not satisfy the bounded probe contract."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_allowlisted_sources(package_root: Path) -> tuple[dict[str, str], dict[str, str]]:
    try:
        root = package_root.resolve(strict=True)
    except OSError as error:
        raise ProbeFailure("the explicit package root is unavailable") from error
    if not root.is_dir():
        raise ProbeFailure("the explicit package root is not a directory")

    text: dict[str, str] = {}
    hashes: dict[str, str] = {}
    for relative in ALLOWLIST:
        try:
            candidate = (root / relative).resolve(strict=True)
            candidate.relative_to(root)
        except (OSError, ValueError) as error:
            raise ProbeFailure(f"allowlisted package file is unavailable: {relative}") from error
        if not candidate.is_file():
            raise ProbeFailure(f"allowlisted package file is not regular: {relative}")
        data = candidate.read_bytes()
        try:
            text[relative] = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ProbeFailure(f"allowlisted package file is not UTF-8: {relative}") from error
        hashes[relative] = _sha256(data)
    return text, hashes


_BUNDLE_IMPORT_PATTERNS = (
    re.compile(r"\bimport\s+[\"'](\./[^\"']+\.js)[\"']"),
    re.compile(r"\b(?:import|export)\s+[^;]*?\sfrom\s+[\"'](\./[^\"']+\.js)[\"']"),
    re.compile(r"\bimport\(\s*[\"'](\./[^\"']+\.js)[\"']\s*\)"),
)


def _literal_local_bundle_imports(source: str) -> set[str]:
    imports: set[str] = set()
    for pattern in _BUNDLE_IMPORT_PATTERNS:
        imports.update(pattern.findall(source))
    return imports


def _read_bundle_closure(package_root: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Read and hash the literal local ESM closure launched by the manifest bin."""
    try:
        root = package_root.resolve(strict=True)
    except OSError as error:
        raise ProbeFailure("the explicit package root is unavailable") from error
    try:
        bundle_root = (root / "dist" / "bundle").resolve(strict=True)
        bundle_root.relative_to(root)
    except OSError as error:
        raise ProbeFailure("the launched bundle directory is unavailable") from error
    except ValueError as error:
        raise ProbeFailure("the launched bundle directory escapes the package root") from error
    if not bundle_root.is_dir():
        raise ProbeFailure("the launched bundle directory is unavailable")

    text: dict[str, str] = {}
    hashes: dict[str, str] = {}
    pending = [BUNDLE_ENTRYPOINT]
    while pending:
        relative = pending.pop()
        if relative in text:
            continue
        normalized = posixpath.normpath(relative)
        if normalized != relative or not normalized.startswith("dist/bundle/"):
            raise ProbeFailure("a launched bundle import escapes its bundle directory")
        candidate = root.joinpath(*PurePosixPath(normalized).parts)
        try:
            candidate = candidate.resolve(strict=True)
            candidate.relative_to(bundle_root)
        except (OSError, ValueError) as error:
            raise ProbeFailure(f"launched bundle file is unavailable: {relative}") from error
        if not candidate.is_file():
            raise ProbeFailure(f"launched bundle file is not regular: {relative}")
        data = candidate.read_bytes()
        try:
            source = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ProbeFailure(f"launched bundle file is not UTF-8: {relative}") from error
        text[relative] = source
        hashes[relative] = _sha256(data)
        parent = posixpath.dirname(relative)
        for specifier in sorted(_literal_local_bundle_imports(source), reverse=True):
            imported = posixpath.normpath(posixpath.join(parent, specifier))
            if not imported.startswith("dist/bundle/"):
                raise ProbeFailure("a launched bundle import escapes its bundle directory")
            pending.append(imported)

    entry_imports = _literal_local_bundle_imports(text[BUNDLE_ENTRYPOINT])
    if not entry_imports:
        raise ProbeFailure("the launched bundle entrypoint has no literal local import")
    return text, hashes


def _bundle_closure_digest(hashes: dict[str, str], files: Iterable[str]) -> str:
    digest = hashlib.sha256()
    for relative in sorted(files):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(hashes[relative]))
    return digest.hexdigest()


def _contains_all(source: str, fragments: Iterable[str]) -> bool:
    return all(fragment in source for fragment in fragments)


def _rpc_command_names(source: str) -> set[str]:
    try:
        start = source.index("const handleCommand = async")
        end = source.index("const handleInputLine =", start)
    except ValueError as error:
        raise ProbeFailure("RPC command dispatcher shape is unavailable") from error
    return set(re.findall(r'case\s+"([a-z0-9_]+)"\s*:', source[start:end]))


def _check(status: bool, files: Iterable[str], hashes: dict[str, str], **facts: Any) -> dict[str, Any]:
    return {
        "status": "pass" if status else "fail",
        "evidence": [
            {"file": relative, "sha256": hashes[relative]}
            for relative in sorted(set(files))
        ],
        "facts": facts,
    }


def inspect_package(package_root: Path, expected_version: str = EXPECTED_VERSION) -> dict[str, Any]:
    sources, hashes = _read_allowlisted_sources(package_root)
    bundle_sources, bundle_hashes = _read_bundle_closure(package_root)
    sources.update(bundle_sources)
    hashes.update(bundle_hashes)
    bundle_files = tuple(sorted(bundle_sources))
    bundle_source = "\n".join(bundle_sources[relative] for relative in bundle_files)
    launched_bundle_ok = (
        BUNDLE_ENTRYPOINT in bundle_sources
        and bundle_sources[BUNDLE_ENTRYPOINT].startswith("#!/usr/bin/env node")
        and _contains_all(
            bundle_source,
            (
                "--daemon-socket",
                "session_already_active",
                "waitForIdle",
                "get_state",
                "goal_update",
                "rlm_child_update",
            ),
        )
    )
    try:
        manifest = json.loads(sources["package.json"])
    except json.JSONDecodeError as error:
        raise ProbeFailure("package.json is not valid JSON") from error
    if not isinstance(manifest, dict):
        raise ProbeFailure("package.json root is not an object")

    package_identity_ok = (
        manifest.get("name") == EXPECTED_PACKAGE_NAME
        and manifest.get("version") == expected_version
        and isinstance(manifest.get("bin"), dict)
        and manifest["bin"].get("prime-agent") == "dist/bundle/cli.js"
    )

    jsonl_source = sources["dist/modes/rpc/jsonl.js"]
    lf_jsonl_ok = _contains_all(
        jsonl_source,
        (
            'from "node:string_decoder"',
            "serializeJsonLine(value)",
            "JSON.stringify(value)",
            'text.indexOf("\\n")',
            'line.endsWith("\\r")',
            'new StringDecoder("utf8")',
        ),
    ) and 'from "node:readline"' not in jsonl_source

    args_source = sources["dist/cli/args.js"]
    main_source = sources["dist/main.js"]
    resume_rpc_ok = (
        _contains_all(
            args_source,
            (
                'mode === "rpc"',
                'arg === "--resume" || arg === "-r"',
                'arg.startsWith("--resume=")',
            ),
        )
        and _contains_all(
            main_source,
            (
                "const resumeSelector = getResumeSelector(parsed);",
                "resolveSessionPath(resumeSelector, cwd, sessionDir)",
                "SessionManager.open(resolved.path, sessionDir, explicitCwdOverride)",
                "--resume without a session selector requires an interactive terminal",
            ),
        )
        and "prime-agent --resume <path|id>" in sources["docs/sessions.md"]
    )

    storage_ok = (
        'return join(agentDir, "sessions");' in sources["dist/config.js"]
        and _contains_all(
            sources["dist/migrations.js"],
            (
                "Migrate legacy per-cwd session directories into the flat session root.",
                "existing nested JSONL session files up one level.",
            ),
        )
        and _contains_all(
            sources["dist/core/session-manager.js"],
            (
                "const files = readdirSync(sessionDir)",
                '.filter((f) => f.endsWith(".jsonl"))',
                "sessionHeaderMatchesCwd(header, cwd)",
                'typeof header.cwd === "string"',
                'type: "session"',
                "cwd: this.cwd",
            ),
        )
        and "Sessions auto-save as flat JSONL files under `~/.prime/agent/sessions/`." in sources["README.md"]
    )

    rpc_mode_source = sources["dist/modes/rpc/rpc-mode.js"]
    agent_session_source = sources["dist/core/agent-session.js"]
    commands = _rpc_command_names(rpc_mode_source)
    expected_prime_commands = {
        "abort",
        "get_session_stats",
        "get_state",
        "list_heartbeats",
        "list_schedules",
        "observe",
        "prompt",
        "refine",
        "send_message",
    }
    prime_surface_ok = (
        expected_prime_commands.issubset(commands)
        and _contains_all(
            rpc_mode_source,
            (
                'if (event.type === "session_event")',
                "outputConnectionEvent(event.event);",
                "goal: state.goal",
            ),
        )
        and _contains_all(
            agent_session_source,
            (
                'type: "goal_update"',
                'type: "rlm_child_update"',
                'type: "refine_complete"',
                'type: "refine_failed"',
            ),
        )
    )

    daemon_docs = sources["docs/daemon.md"]
    lifecycle_ok = (
        _contains_all(
            rpc_mode_source,
            (
                'process.stdin.on("end", onInputEnd);',
                ".then(() => connection.waitForIdle())",
                ".then(() => shutdown(), () => shutdown(1));",
            ),
        )
        and _contains_all(
            daemon_docs,
            (
                "## Client-Owned Workers",
                "RPC keeps LF-delimited JSONL framing and accepts prompts until EOF;",
                "normal completion explicitly removes the worker without archiving it;",
                "unexpected client loss starts a bounded cleanup grace period;",
                "## Session Ownership and Leases",
                "Concurrent opens return `session_already_active`",
            ),
        )
    )

    auth_case_names = {"auth", "authenticate", "login", "oauth", "provider_login"}
    auth_rpc_cases = sorted(commands & auth_case_names)
    auth_limitation_ok = (
        not auth_rpc_cases
        and '{ name: "login", description: "Configure provider authentication" }'
        in sources["dist/core/slash-commands.js"]
        and "Built-in TUI commands" in sources["docs/rpc.md"]
        and "are not included" in sources["docs/rpc.md"]
    )

    extension_docs = sources["docs/extensions.md"]
    extension_loader = sources["dist/core/extensions/loader.js"]
    extension_modules = sources["dist/core/extensions/bundled-modules.js"]
    extension_types = sources["dist/core/extensions/types.d.ts"]
    extension_boundary_ok = (
        _contains_all(
            sources["dist/config.js"],
            (
                'CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".prime/agent"',
                "PRIME_AGENT_CODING_AGENT_DIR",
            ),
        )
        and _contains_all(
            extension_docs,
            (
                "~/.prime/agent/extensions/",
                ".prime/agent/extensions/",
                'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"',
            ),
        )
        and _contains_all(
            extension_loader,
            (
                '"@earendil-works/pi-coding-agent": piCodingAgentEntry',
                '"@mariozechner/pi-coding-agent": piCodingAgentEntry',
            ),
        )
        and _contains_all(
            extension_modules,
            (
                '"@earendil-works/pi-coding-agent": _bundledPiCodingAgent',
                '"@mariozechner/pi-coding-agent": _bundledPiCodingAgent',
            ),
        )
        and _contains_all(
            extension_types,
            (
                'on(event: "session_before_refine"',
                'on(event: "refine_complete"',
            ),
        )
    )

    checks = {
        "package_identity": _check(
            package_identity_ok,
            ("package.json",),
            hashes,
            name_matches=manifest.get("name") == EXPECTED_PACKAGE_NAME,
            version_matches=manifest.get("version") == expected_version,
            bin_matches=isinstance(manifest.get("bin"), dict)
            and manifest["bin"].get("prime-agent") == BUNDLE_ENTRYPOINT,
        ),
        "launched_bundle_closure": _check(
            launched_bundle_ok,
            bundle_files,
            hashes,
            entrypoint=BUNDLE_ENTRYPOINT,
            literal_local_js_import_closure_complete=True,
            closure_file_count=len(bundle_files),
            closure_sha256=_bundle_closure_digest(hashes, bundle_files),
            shared_daemon_markers_present=launched_bundle_ok,
            live_control_authorized=False,
        ),
        "lf_jsonl": _check(
            lf_jsonl_ok,
            ("dist/modes/rpc/jsonl.js",),
            hashes,
            delimiter="LF",
            crlf_input_accepted=True,
            unicode_line_separators_are_payload=True,
            node_readline_used=False,
        ),
        "rpc_resume": _check(
            resume_rpc_ok,
            ("dist/cli/args.js", "dist/main.js", "docs/sessions.md"),
            hashes,
            explicit_selector_required_headlessly=True,
            selector_forms=["path", "id"],
        ),
        "flat_sessions_by_cwd": _check(
            storage_ok,
            (
                "README.md",
                "dist/config.js",
                "dist/core/session-manager.js",
                "dist/migrations.js",
            ),
            hashes,
            default_root="~/.prime/agent/sessions/",
            layout="flat-jsonl",
            project_key="session-header-cwd",
        ),
        "prime_rpc_surface": _check(
            prime_surface_ok,
            ("dist/core/agent-session.js", "dist/modes/rpc/rpc-mode.js"),
            hashes,
            get_state_includes_goal=True,
            raw_session_events_forwarded=True,
            event_types=["goal_update", "rlm_child_update", "refine_complete", "refine_failed"],
            expected_commands_present=sorted(expected_prime_commands & commands),
        ),
        "shutdown_and_ownership": _check(
            lifecycle_ok,
            ("dist/modes/rpc/rpc-mode.js", "docs/daemon.md"),
            hashes,
            stdin_eof_waits_for_idle=True,
            worker_lease_from_docs="client-owned",
            supervisor_lifecycle_from_launched_bundle="shared-detached-daemon",
            piui_owns_supervisor=False,
            active_session_lease=True,
            live_control_authorized=False,
        ),
        "auth_limitation": _check(
            auth_limitation_ok,
            ("dist/core/slash-commands.js", "dist/modes/rpc/rpc-mode.js", "docs/rpc.md"),
            hashes,
            typed_rpc_auth_command_present=bool(auth_rpc_cases),
            typed_rpc_auth_commands=auth_rpc_cases,
            interactive_login_is_builtin=True,
        ),
        "extension_boundary": _check(
            extension_boundary_ok,
            (
                "dist/config.js",
                "docs/extensions.md",
                "dist/core/extensions/bundled-modules.js",
                "dist/core/extensions/loader.js",
                "dist/core/extensions/types.d.ts",
            ),
            hashes,
            global_root="~/.prime/agent/extensions/",
            project_root=".prime/agent/extensions/",
            pi_import_aliases_present=True,
            prime_specific_refinement_hooks_present=True,
            universal_pi_abi_compatibility_proven=False,
        ),
    }
    overall_status = "pass" if all(check["status"] == "pass" for check in checks.values()) else "fail"
    report: dict[str, Any] = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "probe": "prime-agent-static-bundle-contract",
        "overall_status": overall_status,
        "package": {
            "name": manifest.get("name") if isinstance(manifest.get("name"), str) else "invalid",
            "version": manifest.get("version") if isinstance(manifest.get("version"), str) else "invalid",
        },
        "collection": {
            "mode": "static-bundle-closure-no-execution",
            "allowlisted_package_files": list(ALLOWLIST),
            "launched_bundle_entrypoint": BUNDLE_ENTRYPOINT,
            "launched_bundle_files": list(bundle_files),
            "user_session_files_read": False,
            "auth_json_read": False,
            "prompt_content_read": False,
            "environment_dumped": False,
        },
        "checks": checks,
    }
    assert_safe_report(report, package_root)
    return report


def assert_safe_report(report: dict[str, Any], package_root: Path | None = None) -> None:
    """Reject path disclosure or a report shape capable of carrying raw user data."""
    root_variants: tuple[str, ...] = ()
    if package_root is not None:
        resolved_root = package_root.resolve()
        root_variants = (str(resolved_root).casefold(), resolved_root.as_posix().casefold())
    collection = report.get("collection", {})
    for field in ("allowlisted_package_files", "launched_bundle_files"):
        for entry in collection.get(field, []):
            path = Path(entry)
            if path.is_absolute() or ".." in path.parts:
                raise ProbeFailure("report contains a non-relative evidence file")
    forbidden_keys = {"session_file", "session_path", "cwd", "prompt", "content", "auth", "token", "secret"}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key.casefold() in forbidden_keys:
                    raise ProbeFailure("report contains a forbidden raw-data field")
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
        elif isinstance(value, str):
            folded = value.casefold()
            if any(root and root in folded for root in root_variants):
                raise ProbeFailure("report disclosed the explicit package root")
            if PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute():
                raise ProbeFailure("report contains an absolute path")

    visit(report)


def write_report(report: dict[str, Any], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


class StrictLfJsonlDecoder:
    """Small fixture decoder that treats only byte 0x0A as a record delimiter."""

    def __init__(self) -> None:
        self._pending = bytearray()

    def feed(self, chunk: bytes) -> list[Any]:
        if not isinstance(chunk, bytes):
            raise TypeError("chunk must be bytes")
        self._pending.extend(chunk)
        values: list[Any] = []
        while True:
            newline = self._pending.find(b"\n")
            if newline < 0:
                break
            record = bytes(self._pending[:newline])
            del self._pending[: newline + 1]
            if record.endswith(b"\r"):
                record = record[:-1]
            if not record:
                raise ValueError("blank JSONL record")
            values.append(json.loads(record.decode("utf-8")))
        return values

    def finish(self) -> None:
        if self._pending:
            raise ValueError("unterminated JSONL record")


def discover_synthetic_flat_sessions(session_root: Path, cwd: Path) -> list[str]:
    """Fixture-only flat-root selector; it never discovers the real Prime root."""
    expected_cwd = os.path.normcase(str(cwd.resolve()))
    session_ids: list[str] = []
    for candidate in sorted(session_root.iterdir(), key=lambda path: path.name):
        if not candidate.is_file() or candidate.suffix != ".jsonl":
            continue
        try:
            first_record = candidate.read_bytes().split(b"\n", 1)[0]
            header = json.loads(first_record.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(header, dict) or header.get("type") != "session":
            continue
        session_id = header.get("id")
        header_cwd = header.get("cwd")
        if not isinstance(session_id, str) or not session_id or not isinstance(header_cwd, str):
            continue
        if os.path.normcase(str(Path(header_cwd).resolve())) == expected_cwd:
            session_ids.append(session_id)
    return session_ids


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", required=True, type=Path, help="Explicit installed prime-agent package root")
    parser.add_argument("--expected-version", default=EXPECTED_VERSION)
    parser.add_argument("--report", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = inspect_package(args.package_root, args.expected_version)
        if args.report is not None:
            write_report(report, args.report)
        print(json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True))
        return 0 if report["overall_status"] == "pass" else 2
    except ProbeFailure as error:
        print(f"probe failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
