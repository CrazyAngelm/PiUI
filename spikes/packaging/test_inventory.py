from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess
from unittest import mock

import inventory


class InventoryTests(unittest.TestCase):
    @staticmethod
    def valid_manifest(executable: Path) -> dict[str, object]:
        os_name, arch = inventory.host_target()
        return {
            "schema_version": 1,
            "piui_compatibility": ">=0.0.0 <1.0.0",
            "artifact": {"pi_version": "0.81.1", "sha256": inventory.sha256_file(executable),
                         "os": os_name, "arch": arch, "filename": "pi", "distribution": "official-standalone"},
            "provenance": {"upstream_release_url": "https://example.invalid/release",
                           "upstream_checksum_url": "https://example.invalid/SHA256SUMS",
                           "upstream_verification": "sha256-verified"},
            "capability_probe": {"probe_contract": "pi-rpc-v1",
                                 "probe_fixture_sha256": "0" * 64},
        }

    def test_explicit_executable_is_sanitized_and_unverified_without_manifest(self) -> None:
        report = inventory.inventory(sys.executable, None, "pi-rpc-v1:fixture")
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["selection"], "explicit")
        self.assertEqual(report["runtime"]["classification"], "custom-unverified")
        self.assertNotIn(str(Path(sys.executable).resolve()), json.dumps(report))
        self.assertTrue(report["capability_probe"]["linked"])
        self.assertEqual(report["collection_mode"], "static-no-execution")
        self.assertEqual(report["runtime"]["version_probe"], {"status": "not_requested"})

    def test_default_inventory_never_executes_candidate(self) -> None:
        with mock.patch.object(inventory.subprocess, "run", side_effect=AssertionError("must not execute")) as run:
            report = inventory.inventory(sys.executable, None, None)
        run.assert_not_called()
        self.assertEqual(report["collection_mode"], "static-no-execution")
        self.assertEqual(report["runtime"]["version_probe"], {"status": "not_requested"})

    def test_opt_in_version_execution_is_explicitly_untrusted(self) -> None:
        completed = subprocess.CompletedProcess([sys.executable, "--version"], 0, b"Python 3.13.0")
        with mock.patch.object(inventory.subprocess, "run", return_value=completed) as run:
            report = inventory.inventory(sys.executable, None, None, allow_version_execution=True)
        run.assert_called_once()
        self.assertEqual(report["collection_mode"], "untrusted-version-execution")
        self.assertEqual(report["runtime"]["version_probe"]["version"], "3.13.0")
        inventory.assert_sanitized_report(report)

    def test_matching_manifest_is_candidate_but_never_managed_verified(self) -> None:
        executable = Path(sys.executable).resolve()
        manifest = self.valid_manifest(executable)
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "runtime.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            report = inventory.inventory(str(executable), str(manifest_path), None)
        self.assertEqual(report["runtime"]["classification"], "manifest-bound-standalone-candidate")
        self.assertFalse(report["runtime"]["managed_verification"]["verified"])
        self.assertTrue(report["runtime"]["managed_verification"]["manifest_binding_candidate"])
        self.assertEqual(report["runtime"]["managed_verification"]["reason"], "unproven_no_signed_acquisition_pipeline")

    def test_wrapper_detection_and_hash_mismatch_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            wrapper = Path(directory) / "pi-wrapper.sh"
            wrapper.write_text("#!/bin/sh\nexec node pi.js \"$@\"\n", encoding="utf-8")
            self.assertTrue(inventory.is_probable_wrapper(wrapper))
            os_name, arch = inventory.host_target()
            manifest = self.valid_manifest(wrapper)
            manifest["artifact"]["sha256"] = "0" * 64  # type: ignore[index]
            candidate, reason = inventory.manifest_binding_candidate(manifest, inventory.sha256_file(wrapper), os_name, arch)
            self.assertFalse(candidate)
            self.assertEqual(reason, "artifact_hash_mismatch")

    def test_incomplete_or_malformed_manifest_cannot_be_candidate(self) -> None:
        executable = Path(sys.executable).resolve()
        valid = self.valid_manifest(executable)
        mutations = [
            ("piui_compatibility", ""), ("artifact.pi_version", ""),
            ("artifact.distribution", "npm"), ("artifact.os", "plan9"),
            ("artifact.arch", "x86"), ("artifact.filename", "../pi"),
            ("artifact.sha256", "not-a-sha"),
            ("provenance.upstream_release_url", "http://example.invalid/release"),
            ("provenance.upstream_checksum_url", "not-a-url"),
            ("provenance.upstream_verification", "claimed"),
            ("capability_probe.probe_contract", ""),
            ("capability_probe.probe_fixture_sha256", "bad"),
        ]
        cases: list[dict[str, object]] = [{"schema_version": 1}]
        for dotted_key, invalid_value in mutations:
            candidate = json.loads(json.dumps(valid))
            container: dict[str, object] = candidate
            parts = dotted_key.split(".")
            for part in parts[:-1]:
                container = container[part]  # type: ignore[assignment]
            container[parts[-1]] = invalid_value
            cases.append(candidate)
        with tempfile.TemporaryDirectory() as directory:
            for number, value in enumerate(cases):
                self.assertFalse(inventory.validate_manifest(value))
                manifest_path = Path(directory) / f"invalid-{number}.json"
                manifest_path.write_text(json.dumps(value), encoding="utf-8")
                report = inventory.inventory(str(executable), str(manifest_path), None)
                self.assertEqual(report["manifest"]["status"], "manifest_invalid")
                self.assertNotEqual(report["runtime"]["classification"], "manifest-bound-standalone-candidate")
                self.assertFalse(report["runtime"]["managed_verification"]["manifest_binding_candidate"])

    def test_assert_sanitized_report_accepts_inventory_and_rejects_path(self) -> None:
        report = inventory.inventory(sys.executable, None, None)
        inventory.assert_sanitized_report(report)
        with self.assertRaises(ValueError):
            inventory.assert_sanitized_report({"runtime": {"path": "C:\\\\secret\\\\pi.exe"}})
        with self.assertRaises(ValueError):
            inventory.assert_sanitized_report({"runtime": {"value": "/secret/pi"}})
        with self.assertRaises(ValueError):
            inventory.assert_sanitized_report({"status": "ok", "runtime": {"managed_verification": {"verified": True}}})

    def test_invalid_probe_identifier_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            inventory.inventory(sys.executable, None, "probe id with spaces")


if __name__ == "__main__":
    unittest.main()
