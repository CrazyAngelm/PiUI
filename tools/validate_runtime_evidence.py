#!/usr/bin/env python3
"""Offline structural validation for the checked-in observed npm evidence packet.

The validator reads only a fixed, regular-file set beneath the directory given
with ``--check``. It does not invoke npm, install software, contact a registry,
or make any network request. It validates local structure and consistency only;
it cannot cryptographically authenticate upstream statements.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

MAX_RECEIPT_BYTES = 16 * 1024
MAX_ATTACHMENTS = 4
MAX_ATTACHMENT_BYTES = 32 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 96 * 1024
READ_CHUNK_BYTES = 64 * 1024
MAX_JSON_INTEGER_DIGITS = 128

PACKAGE = "@earendil-works/pi-coding-agent"
VERSION = "0.81.1"
SRI = (
    "sha512-r6ovAsZOgAqbC/aU6s+/dPnv/sGZBuWyZNvi3pXjpbuX5wvp3XvGkQI7/"
    "VLvX2o9XpmpFaPUxKNym1WfkN/P8A=="
)
SIGNATURE_KEY_ID = "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U"
REPOSITORY = "https://github.com/earendil-works/pi"
TAG = "refs/tags/v0.81.1"
COMMIT = "20be4b18d4c57487f8993d2762bace129f0cf7c6"
WORKFLOW = ".github/workflows/build-binaries.yml"
SANITIZED_LOCAL_SUMMARY = "sanitized-local-summary"
UPSTREAM_CRYPTOGRAPHIC_VERIFICATION = "not-retained"
OBSERVED_AUDIT_SIGNATURES = "observed-success"
ATTACHMENTS = (
    "isolated-graph.json",
    "npm-audit-signatures.json",
    "registry-version.json",
    "slsa-provenance.json",
)
EXPECTED_FILES = {"README.md", "receipt-v1.json", *ATTACHMENTS}
MAX_DIRECTORY_ENTRIES = len(EXPECTED_FILES)
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.json$")
WINDOWS_ABSOLUTE_PATH = re.compile(r"^[A-Za-z]:[\\/]")
SENSITIVE_KEY_PARTS = ("auth", "token", "credential", "password", "secret")


class ValidationError(ValueError):
    """A path-free, content-free packet validation failure."""


@dataclass(frozen=True)
class PacketSummary:
    package: str
    version: str
    attachment_count: int


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int
    size: int
    mtime_ns: int


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError("duplicate JSON key")
        result[key] = value
    return result


def reject_json_constant(_: str) -> None:
    raise ValidationError("non-finite JSON number")


def bounded_json_integer(value: str) -> int:
    if len(value.removeprefix("-")) > MAX_JSON_INTEGER_DIGITS:
        raise ValueError("JSON integer exceeds the safe digit limit")
    return int(value)


def load_json_bytes(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_json_constant,
            parse_int=bounded_json_integer,
        )
        if not isinstance(value, dict):
            raise ValidationError("top-level JSON value must be an object")
        reject_sensitive_content(value)
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        OverflowError,
        RecursionError,
        ValidationError,
        ValueError,
    ) as exc:
        raise ValidationError("malformed JSON") from exc
    return value


def reject_sensitive_content(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or any(part in key.lower() for part in SENSITIVE_KEY_PARTS):
                raise ValidationError("sensitive-looking JSON field")
            reject_sensitive_content(child)
        return
    if isinstance(value, list):
        for child in value:
            reject_sensitive_content(child)
        return
    if isinstance(value, str):
        if value.startswith(("/", "\\\\")) or WINDOWS_ABSOLUTE_PATH.match(value):
            raise ValidationError("absolute path-like value")
        if "://" in value:
            try:
                split = urlsplit(value)
            except ValueError as exc:
                raise ValidationError("malformed URL") from exc
            if split.username is not None or split.password is not None:
                raise ValidationError("URL userinfo is not allowed")


def require_exact_keys(value: dict[str, Any], expected: set[str]) -> None:
    if set(value) != expected:
        raise ValidationError("unknown or missing JSON field")


def require_string(value: Any) -> str:
    if not isinstance(value, str):
        raise ValidationError("expected JSON string")
    return value


def require_bool(value: Any) -> bool:
    if type(value) is not bool:
        raise ValidationError("expected JSON boolean")
    return value


def require_int(value: Any) -> int:
    if type(value) is not int:
        raise ValidationError("expected JSON integer")
    return value


def require_equal(value: Any, expected: Any) -> None:
    if value != expected:
        raise ValidationError("unexpected observed subject")


def is_reparse_point(metadata: os.stat_result) -> bool:
    attribute = getattr(metadata, "st_file_attributes", 0)
    reparse_point = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return bool(attribute & reparse_point)


def file_identity(metadata: os.stat_result) -> FileIdentity:
    if metadata.st_dev < 0 or metadata.st_ino <= 0:
        raise ValidationError("local evidence identity is unavailable")
    return FileIdentity(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        size=metadata.st_size,
        mtime_ns=metadata.st_mtime_ns,
    )


def lstat_local(path: Path) -> os.stat_result:
    try:
        return os.lstat(path)
    except (OSError, ValueError) as exc:
        raise ValidationError("required local evidence entry is unavailable") from exc


def require_packet_directory(directory: Path) -> FileIdentity:
    metadata = lstat_local(directory)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or is_reparse_point(metadata):
        raise ValidationError("evidence directory is unsafe")
    return file_identity(metadata)


def require_unchanged_directory(directory: Path, expected: FileIdentity) -> None:
    if require_packet_directory(directory) != expected:
        raise ValidationError("evidence directory identity changed")


def require_regular_file(metadata: os.stat_result) -> FileIdentity:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or is_reparse_point(metadata)
        or metadata.st_nlink != 1
        or metadata.st_size < 0
    ):
        raise ValidationError("local evidence entry is unsafe")
    return file_identity(metadata)


def scan_packet_entries(directory: Path, directory_identity: FileIdentity) -> None:
    names: set[str] = set()
    try:
        with os.scandir(directory) as scanner:
            for entry in scanner:
                if len(names) >= MAX_DIRECTORY_ENTRIES:
                    raise ValidationError("evidence directory has too many entries")
                if entry.name not in EXPECTED_FILES or entry.name in names:
                    raise ValidationError("evidence directory has an unexpected file set")
                metadata = lstat_local(directory / entry.name)
                require_regular_file(metadata)
                names.add(entry.name)
    except ValidationError:
        raise
    except (OSError, ValueError) as exc:
        raise ValidationError("evidence directory is unreadable") from exc
    require_unchanged_directory(directory, directory_identity)
    if names != EXPECTED_FILES:
        raise ValidationError("evidence directory has an unexpected file set")


def read_limited_descriptor(descriptor: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    remaining = limit + 1
    try:
        while remaining:
            chunk = os.read(descriptor, min(READ_CHUNK_BYTES, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    except OSError as exc:
        raise ValidationError("required local evidence file is unreadable") from exc
    raw = b"".join(chunks)
    if len(raw) > limit:
        raise ValidationError("local evidence file exceeds size limit")
    return raw


def read_bounded_regular(
    directory: Path,
    name: str,
    limit: int,
    directory_identity: FileIdentity,
) -> bytes:
    require_unchanged_directory(directory, directory_identity)
    entry_path = directory / name
    before = lstat_local(entry_path)
    before_identity = require_regular_file(before)
    if before.st_size > limit:
        raise ValidationError("local evidence file exceeds size limit")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = -1
    try:
        descriptor = os.open(entry_path, flags)
        opened = os.fstat(descriptor)
        if require_regular_file(opened) != before_identity:
            raise ValidationError("local evidence file identity changed")
        raw = read_limited_descriptor(descriptor, limit)
    except ValidationError:
        raise
    except (OSError, ValueError) as exc:
        raise ValidationError("required local evidence file is unreadable") from exc
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass

    after = lstat_local(entry_path)
    if require_regular_file(after) != before_identity:
        raise ValidationError("local evidence file identity changed")
    require_unchanged_directory(directory, directory_identity)
    return raw


def validate_packet(directory: Path) -> PacketSummary:
    try:
        packet_directory = Path(directory)
    except (TypeError, ValueError) as exc:
        raise ValidationError("evidence directory is unavailable") from exc
    directory_identity = require_packet_directory(packet_directory)
    scan_packet_entries(packet_directory, directory_identity)

    readme = read_bounded_regular(packet_directory, "README.md", MAX_RECEIPT_BYTES, directory_identity)
    try:
        readme.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError("README is not UTF-8") from exc

    receipt = load_json_bytes(
        read_bounded_regular(packet_directory, "receipt-v1.json", MAX_RECEIPT_BYTES, directory_identity)
    )
    validate_receipt(receipt)

    attachment_manifest = receipt["attachments"]
    if not isinstance(attachment_manifest, list):
        raise ValidationError("attachment manifest must be an array")
    total = 0
    supplied: dict[str, dict[str, Any]] = {}
    for entry, expected_name in zip(attachment_manifest, ATTACHMENTS, strict=True):
        if not isinstance(entry, dict):
            raise ValidationError("attachment manifest entry must be an object")
        require_exact_keys(entry, {"name", "bytes", "sha256"})
        name = require_string(entry["name"])
        if name != expected_name or not SAFE_NAME.fullmatch(name):
            raise ValidationError("unsafe or reordered attachment name")
        byte_count = require_int(entry["bytes"])
        digest = require_string(entry["sha256"])
        if byte_count < 0 or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValidationError("invalid attachment manifest value")

        raw = read_bounded_regular(packet_directory, name, MAX_ATTACHMENT_BYTES, directory_identity)
        total += len(raw)
        if total > MAX_TOTAL_ATTACHMENT_BYTES:
            raise ValidationError("attachment aggregate exceeds size limit")
        if byte_count != len(raw) or digest != hashlib.sha256(raw).hexdigest():
            raise ValidationError("attachment size or digest mismatch")
        supplied[name] = load_json_bytes(raw)

    validate_isolated_graph(supplied["isolated-graph.json"])
    validate_npm_audit(supplied["npm-audit-signatures.json"])
    validate_registry(supplied["registry-version.json"])
    validate_slsa(supplied["slsa-provenance.json"])
    return PacketSummary(PACKAGE, VERSION, len(ATTACHMENTS))


def validate_receipt(receipt: dict[str, Any]) -> None:
    require_exact_keys(receipt, {"schema", "version", "collection", "subject", "attachments"})
    require_equal(receipt["schema"], "piui-observed-upstream-evidence")
    require_equal(require_int(receipt["version"]), 1)

    collection = receipt["collection"]
    if not isinstance(collection, dict):
        raise ValidationError("collection must be an object")
    require_exact_keys(
        collection,
        {
            "method",
            "record_kind",
            "upstream_cryptographic_verification",
            "isolated_graph",
            "ignore_scripts",
            "npm_audit_signatures",
        },
    )
    require_equal(collection["method"], "isolated-npm-audit-signatures")
    require_equal(collection["record_kind"], SANITIZED_LOCAL_SUMMARY)
    require_equal(collection["upstream_cryptographic_verification"], UPSTREAM_CRYPTOGRAPHIC_VERIFICATION)
    require_equal(require_bool(collection["isolated_graph"]), True)
    require_equal(require_bool(collection["ignore_scripts"]), True)
    require_equal(collection["npm_audit_signatures"], OBSERVED_AUDIT_SIGNATURES)

    subject = receipt["subject"]
    if not isinstance(subject, dict):
        raise ValidationError("subject must be an object")
    require_exact_keys(
        subject,
        {"package", "package_version", "integrity", "signature_key_id", "repository", "tag", "commit", "workflow"},
    )
    validate_subject(subject)

    attachments = receipt["attachments"]
    if not isinstance(attachments, list) or len(attachments) != MAX_ATTACHMENTS:
        raise ValidationError("attachment manifest count mismatch")


def validate_subject(subject: dict[str, Any]) -> None:
    require_equal(subject["package"], PACKAGE)
    require_equal(subject["package_version"], VERSION)
    require_equal(subject["integrity"], SRI)
    require_equal(subject["signature_key_id"], SIGNATURE_KEY_ID)
    require_equal(subject["repository"], REPOSITORY)
    require_equal(subject["tag"], TAG)
    require_equal(subject["commit"], COMMIT)
    require_equal(subject["workflow"], WORKFLOW)


def require_local_summary(value: dict[str, Any]) -> None:
    require_equal(value["record_kind"], SANITIZED_LOCAL_SUMMARY)


def validate_isolated_graph(graph: dict[str, Any]) -> None:
    require_exact_keys(
        graph,
        {
            "schema",
            "version",
            "record_kind",
            "package",
            "package_version",
            "lockfile_version",
            "isolated_graph",
            "ignore_scripts",
        },
    )
    require_equal(graph["schema"], "piui-isolated-npm-graph-observation")
    require_equal(require_int(graph["version"]), 1)
    require_local_summary(graph)
    require_equal(graph["package"], PACKAGE)
    require_equal(graph["package_version"], VERSION)
    require_equal(require_int(graph["lockfile_version"]), 3)
    require_equal(require_bool(graph["isolated_graph"]), True)
    require_equal(require_bool(graph["ignore_scripts"]), True)


def validate_npm_audit(audit: dict[str, Any]) -> None:
    require_exact_keys(
        audit,
        {
            "schema",
            "version",
            "record_kind",
            "package",
            "package_version",
            "integrity",
            "signature_key_id",
            "npm_audit_signatures",
        },
    )
    require_equal(audit["schema"], "piui-npm-audit-signatures-observation")
    require_equal(require_int(audit["version"]), 1)
    require_local_summary(audit)
    require_equal(audit["package"], PACKAGE)
    require_equal(audit["package_version"], VERSION)
    require_equal(audit["integrity"], SRI)
    require_equal(audit["signature_key_id"], SIGNATURE_KEY_ID)
    require_equal(audit["npm_audit_signatures"], OBSERVED_AUDIT_SIGNATURES)


def validate_registry(registry: dict[str, Any]) -> None:
    require_exact_keys(
        registry,
        {
            "schema",
            "version",
            "record_kind",
            "package",
            "package_version",
            "integrity",
            "signature_key_id",
            "repository",
            "git_head",
        },
    )
    require_equal(registry["schema"], "piui-npm-registry-version-observation")
    require_equal(require_int(registry["version"]), 1)
    require_local_summary(registry)
    require_equal(registry["package"], PACKAGE)
    require_equal(registry["package_version"], VERSION)
    require_equal(registry["integrity"], SRI)
    require_equal(registry["signature_key_id"], SIGNATURE_KEY_ID)
    require_equal(registry["repository"], REPOSITORY)
    require_equal(registry["git_head"], COMMIT)


def validate_slsa(slsa: dict[str, Any]) -> None:
    require_exact_keys(slsa, {"schema", "version", "record_kind", "subject", "source"})
    require_equal(slsa["schema"], "piui-slsa-provenance-observation")
    require_equal(require_int(slsa["version"]), 1)
    require_local_summary(slsa)
    subject = slsa["subject"]
    source = slsa["source"]
    if not isinstance(subject, dict) or not isinstance(source, dict):
        raise ValidationError("SLSA subject/source must be objects")
    require_exact_keys(subject, {"package", "package_version", "sha512"})
    require_exact_keys(source, {"repository", "tag", "commit", "workflow"})
    require_equal(subject["package"], PACKAGE)
    require_equal(subject["package_version"], VERSION)
    sha512 = require_string(subject["sha512"])
    if not re.fullmatch(r"[0-9a-f]{128}", sha512):
        raise ValidationError("invalid SLSA SHA-512 subject")
    try:
        integrity_digest = base64.b64decode(SRI.removeprefix("sha512-"), validate=True)
    except (ValueError, binascii.Error) as exc:  # pragma: no cover - fixed constant
        raise ValidationError("invalid fixed SRI") from exc
    if integrity_digest.hex() != sha512:
        raise ValidationError("SRI and SLSA subject digest differ")
    require_equal(source["repository"], REPOSITORY)
    require_equal(source["tag"], TAG)
    require_equal(source["commit"], COMMIT)
    require_equal(source["workflow"], WORKFLOW)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", type=Path, required=True, metavar="DIRECTORY")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        validate_packet(args.check)
    except ValidationError as exc:
        print(f"runtime evidence validation failed: {exc}", file=sys.stderr)
        return 1
    print("runtime evidence packet structurally valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
