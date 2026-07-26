#!/usr/bin/env python3
"""SPIKE-07 offline Pi runtime inventory.

This tool never downloads, installs, updates, or executes package-manager commands.
It reads exactly one selected executable (an explicit --pi path, or PATH's `pi`) and,
optionally, one explicitly named runtime manifest. Reports deliberately omit paths,
environment values, command output, prompts, and credentials.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

MANIFEST_SCHEMA_VERSION = 1
REPORT_SCHEMA_VERSION = 2
MAX_VERSION_OUTPUT = 4096
SAFE_PROBE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
VERSION_RE = re.compile(r"\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b")
ABSOLUTE_PATH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|/|\\\\)")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def host_target() -> tuple[str, str]:
    system = platform.system().lower()
    os_name = {"windows": "windows", "linux": "linux", "darwin": "macos"}.get(system, system)
    machine = platform.machine().lower()
    arch = {
        "amd64": "x86_64", "x86_64": "x86_64", "x64": "x86_64",
        "arm64": "aarch64", "aarch64": "aarch64",
    }.get(machine, machine)
    return os_name, arch


def is_probable_wrapper(path: Path) -> bool:
    if path.suffix.lower() in {".cmd", ".bat", ".ps1", ".sh"}:
        return True
    try:
        prefix = path.read_bytes()[:8192]
    except OSError:
        return False
    lower = prefix.lower()
    return (prefix.startswith(b"#!") or b"npm" in lower and b"node" in lower or
            b"basedir=" in lower and b"node" in lower)


def opt_in_version_probe(path: Path) -> dict[str, Any]:
    """Run untrusted local code only after explicit user opt-in; never retain raw output."""
    try:
        completed = subprocess.run(
            [str(path), "--version"], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=5,
            check=False, cwd=None, env={"PATH": os.environ.get("PATH", "")},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"status": "unavailable", "reason": type(error).__name__}
    output = completed.stdout[:MAX_VERSION_OUTPUT].decode("utf-8", errors="replace")
    found = VERSION_RE.search(output)
    return {
        "status": "ok" if completed.returncode == 0 and found else "unavailable",
        "version": found.group(0).removeprefix("v") if found else None,
        "exit_code": completed.returncode,
        "output_truncated": len(completed.stdout) > MAX_VERSION_OUTPUT,
    }


def is_https_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def validate_manifest(data: Any) -> bool:
    """Validate the complete local v1 manifest structure, not provenance truth."""
    if not isinstance(data, dict) or set(data) != {
        "schema_version", "piui_compatibility", "artifact", "provenance", "capability_probe"
    }:
        return False
    if type(data["schema_version"]) is not int or data["schema_version"] != MANIFEST_SCHEMA_VERSION:
        return False
    if not is_nonempty_string(data["piui_compatibility"]):
        return False
    artifact = data["artifact"]
    provenance = data["provenance"]
    capability_probe = data["capability_probe"]
    if not isinstance(artifact, dict) or not isinstance(provenance, dict) or not isinstance(capability_probe, dict):
        return False
    if set(artifact) != {"pi_version", "distribution", "os", "arch", "filename", "sha256"}:
        return False
    if set(provenance) not in ({"upstream_release_url", "upstream_checksum_url", "upstream_verification"},
                               {"upstream_release_url", "upstream_checksum_url", "upstream_verification", "source_revision"}):
        return False
    if set(capability_probe) != {"probe_contract", "probe_fixture_sha256"}:
        return False
    return (
        is_nonempty_string(artifact["pi_version"])
        and artifact["distribution"] == "official-standalone"
        and artifact["os"] in {"windows", "linux", "macos"}
        and artifact["arch"] in {"x86_64", "aarch64"}
        and isinstance(artifact["filename"], str) and bool(FILENAME_RE.fullmatch(artifact["filename"]))
        and isinstance(artifact["sha256"], str) and bool(SHA256_RE.fullmatch(artifact["sha256"]))
        and is_https_url(provenance["upstream_release_url"])
        and is_https_url(provenance["upstream_checksum_url"])
        and provenance["upstream_verification"] == "sha256-verified"
        and ("source_revision" not in provenance or is_nonempty_string(provenance["source_revision"]))
        and is_nonempty_string(capability_probe["probe_contract"])
        and isinstance(capability_probe["probe_fixture_sha256"], str)
        and bool(SHA256_RE.fullmatch(capability_probe["probe_fixture_sha256"]))
    )


def load_manifest(path: Path | None) -> tuple[dict[str, Any] | None, str | None]:
    if path is None:
        return None, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, "manifest_unreadable"
    if not validate_manifest(data):
        return None, "manifest_invalid"
    return data, None


def manifest_binding_candidate(manifest: dict[str, Any] | None, digest: str, os_name: str, arch: str) -> tuple[bool, str | None]:
    if manifest is None:
        return False, "manifest_not_supplied"
    if not validate_manifest(manifest):
        return False, "manifest_invalid"
    artifact = manifest["artifact"]
    provenance = manifest["provenance"]
    if artifact.get("sha256") != digest:
        return False, "artifact_hash_mismatch"
    if artifact.get("os") != os_name or artifact.get("arch") != arch:
        return False, "target_mismatch"
    if artifact.get("distribution") != "official-standalone":
        return False, "not_official_standalone"
    if provenance.get("upstream_verification") != "sha256-verified":
        return False, "upstream_hash_not_verified"
    return True, None


def assert_sanitized_report(report: dict[str, Any]) -> None:
    """Reject report data that could expose an absolute path or unsafe raw field."""
    forbidden_keys = {"path", "paths", "cwd", "environment", "env", "output", "raw_output", "command"}

    def check(value: Any, key: str | None = None) -> None:
        if key in forbidden_keys:
            raise ValueError(f"unsafe report field: {key}")
        if isinstance(value, dict):
            for child_key, child_value in value.items():
                check(child_value, child_key)
        elif isinstance(value, list):
            for item in value:
                check(item)
        elif isinstance(value, str) and ABSOLUTE_PATH_RE.match(value):
            raise ValueError("unsafe absolute path in report")

    if not isinstance(report, dict):
        raise ValueError("report must be an object")
    check(report)
    if report.get("report_schema_version") != REPORT_SCHEMA_VERSION:
        raise ValueError("unsupported report schema version")
    if report.get("status") == "ok":
        runtime = report.get("runtime")
        mode = report.get("collection_mode")
        if mode not in {"static-no-execution", "untrusted-version-execution"}:
            raise ValueError("unknown collection mode")
        if not isinstance(runtime, dict) or not isinstance(runtime.get("managed_verification"), dict):
            raise ValueError("successful report lacks managed-verification state")
        if runtime["managed_verification"].get("verified") is not False:
            raise ValueError("this spike cannot export managed verification")
        version_probe = runtime.get("version_probe")
        if not isinstance(version_probe, dict):
            raise ValueError("successful report lacks version-probe state")
        if mode == "static-no-execution" and version_probe != {"status": "not_requested"}:
            raise ValueError("static inventory must not contain execution results")
        if mode == "untrusted-version-execution" and version_probe.get("status") == "not_requested":
            raise ValueError("execution mode must be explicitly labeled as untrusted")


def inventory(
    pi_argument: str | None, manifest_path: str | None, probe_id: str | None,
    *, allow_version_execution: bool = False,
) -> dict[str, Any]:
    if probe_id is not None and not SAFE_PROBE_ID.fullmatch(probe_id):
        raise ValueError("capability probe ID may contain only safe identifier characters")
    selection = "explicit" if pi_argument else "path"
    selected = Path(pi_argument).expanduser() if pi_argument else (Path(shutil.which("pi")) if shutil.which("pi") else None)
    os_name, arch = host_target()
    base: dict[str, Any] = {
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "collection_mode": "untrusted-version-execution" if allow_version_execution else "static-no-execution",
        "generated_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "host": {"os": os_name, "arch": arch, "python": platform.python_version()},
        "selection": selection,
        "capability_probe": {"linked": probe_id is not None, "probe_id": probe_id},
    }
    if selected is None:
        base.update({"status": "not_found", "runtime": None})
        return base
    try:
        resolved = selected.resolve(strict=True)
        digest = sha256_file(resolved)
    except OSError as error:
        base.update({"status": "unreadable", "runtime": {"reason": type(error).__name__}})
        return base
    manifest, manifest_error = load_manifest(Path(manifest_path).expanduser() if manifest_path else None)
    wrapper = is_probable_wrapper(resolved)
    binding_candidate, reason = manifest_binding_candidate(manifest, digest, os_name, arch)
    # A local manifest is only a self-declared binding: it never verifies managed provenance.
    if selection == "path":
        binding_candidate, reason = False, "path_selected_runtime"
    if binding_candidate and wrapper:
        binding_candidate, reason = False, "manifest_artifact_is_wrapper"
    kind = ("manifest-bound-standalone-candidate" if binding_candidate else
            ("system-or-npm-shim" if selection == "path" or wrapper else "custom-unverified"))
    base.update({
        "status": "ok",
        "runtime": {
            "classification": kind,
            "wrapper_detected": wrapper,
            "wrapper_sha256": digest if wrapper else None,
            "artifact_sha256": digest if not wrapper else None,
            "managed_verification": {
                "verified": False,
                "reason": "unproven_no_signed_acquisition_pipeline",
                "manifest_binding_candidate": binding_candidate,
                "binding_reason": reason,
                "manifest_sha256": sha256_file(Path(manifest_path).expanduser()) if manifest_path and manifest_error is None else None,
            },
            "version_probe": (opt_in_version_probe(resolved) if allow_version_execution
                              else {"status": "not_requested"}),
        },
        "manifest": {"supplied": manifest_path is not None, "status": manifest_error or ("read" if manifest else "not_supplied")},
    })
    return base


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline, sanitized SPIKE-07 Pi runtime inventory")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--pi", help="explicit Pi executable or launcher; never recorded in output")
    group.add_argument("--system-pi", action="store_true", help="resolve only installed `pi` from PATH (default)")
    parser.add_argument("--runtime-manifest", help="explicit manifest used only for local candidate binding")
    parser.add_argument("--capability-probe-id", help="opaque ID/hash linking a separately captured capability probe")
    parser.add_argument("--allow-version-execution", action="store_true", help="DANGEROUS: execute the untrusted candidate with --version; marks report untrusted")
    parser.add_argument("--output", help="report destination; use '-' for stdout")
    args = parser.parse_args()
    try:
        report = inventory(
            args.pi, args.runtime_manifest, args.capability_probe_id,
            allow_version_execution=args.allow_version_execution,
        )
    except ValueError as error:
        parser.error(str(error))
    assert_sanitized_report(report)
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output and args.output != "-":
        Path(args.output).write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0 if report["status"] == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
