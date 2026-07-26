from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_runtime_evidence as evidence  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
PACKET = ROOT / "evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1"


class RuntimeEvidenceValidatorTests(unittest.TestCase):
    def copied_packet(self) -> Path:
        temporary = Path(tempfile.mkdtemp(prefix="piui-runtime-evidence-test-"))
        self.addCleanup(shutil.rmtree, temporary, True)
        destination = temporary / "packet"
        shutil.copytree(PACKET, destination)
        return destination

    @staticmethod
    def rewrite_json(path: Path, mutate) -> None:  # type: ignore[no-untyped-def]
        document = json.loads(path.read_text(encoding="utf-8"))
        mutate(document)
        path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def refresh_manifest(packet: Path) -> None:
        receipt_path = packet / "receipt-v1.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        for entry in receipt["attachments"]:
            raw = (packet / entry["name"]).read_bytes()
            entry["bytes"] = len(raw)
            entry["sha256"] = hashlib.sha256(raw).hexdigest()
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")

    def test_checked_in_packet_is_valid_and_deterministic(self) -> None:
        self.assertEqual(
            evidence.validate_packet(PACKET),
            evidence.PacketSummary(
                package="@earendil-works/pi-coding-agent",
                version="0.81.1",
                attachment_count=4,
            ),
        )
        self.assertEqual(evidence.validate_packet(PACKET), evidence.validate_packet(PACKET))

    def test_wrong_package_or_observed_outcome_is_rejected(self) -> None:
        packet = self.copied_packet()
        self.rewrite_json(packet / "receipt-v1.json", lambda value: value["subject"].__setitem__("package", "wrong"))
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

        packet = self.copied_packet()
        self.rewrite_json(
            packet / "npm-audit-signatures.json",
            lambda value: value.__setitem__("npm_audit_signatures", "observed-failure"),
        )
        self.refresh_manifest(packet)
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

    def test_isolation_sri_and_attestation_mismatches_are_rejected(self) -> None:
        packet = self.copied_packet()
        self.rewrite_json(packet / "receipt-v1.json", lambda value: value["collection"].__setitem__("ignore_scripts", False))
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

        packet = self.copied_packet()
        self.rewrite_json(
            packet / "slsa-provenance.json",
            lambda value: value["subject"].__setitem__("sha512", "0" * 128),
        )
        self.refresh_manifest(packet)
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

    def test_schema_and_lockfile_numbers_require_actual_json_integers(self) -> None:
        for value in (True, 1.0):
            packet = self.copied_packet()
            self.rewrite_json(packet / "receipt-v1.json", lambda document: document.__setitem__("version", value))
            with self.assertRaises(evidence.ValidationError):
                evidence.validate_packet(packet)

            packet = self.copied_packet()
            self.rewrite_json(packet / "isolated-graph.json", lambda document: document.__setitem__("version", value))
            self.refresh_manifest(packet)
            with self.assertRaises(evidence.ValidationError):
                evidence.validate_packet(packet)

            packet = self.copied_packet()
            self.rewrite_json(
                packet / "isolated-graph.json",
                lambda document: document.__setitem__("lockfile_version", value),
            )
            self.refresh_manifest(packet)
            with self.assertRaises(evidence.ValidationError):
                evidence.validate_packet(packet)

    def test_bounded_regular_file_only_packet_access(self) -> None:
        packet = self.copied_packet()
        for index in range(evidence.MAX_DIRECTORY_ENTRIES + 1):
            (packet / f"extra-{index}").write_text("x", encoding="utf-8")
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

        packet = self.copied_packet()
        (packet / "README.md").write_bytes(b"x" * (evidence.MAX_RECEIPT_BYTES + 1))
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

        packet = self.copied_packet()
        (packet / "slsa-provenance.json").unlink()
        (packet / "slsa-provenance.json").mkdir()
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

        packet = self.copied_packet()
        outside = packet.parent / "outside-receipt.json"
        outside.write_bytes((packet / "receipt-v1.json").read_bytes())
        (packet / "receipt-v1.json").unlink()
        try:
            os.link(outside, packet / "receipt-v1.json")
        except OSError as exc:  # pragma: no cover - unsupported filesystem
            self.skipTest(f"hard links unavailable: {exc}")
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

    def test_sensitive_fields_and_malformed_input_are_normalized(self) -> None:
        packet = self.copied_packet()
        self.rewrite_json(packet / "receipt-v1.json", lambda value: value.__setitem__("auth_token", "sentinel"))
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

        packet = self.copied_packet()
        self.rewrite_json(
            packet / "registry-version.json",
            lambda value: value.__setitem__("repository", "https://[malformed"),
        )
        self.refresh_manifest(packet)
        with self.assertRaises(evidence.ValidationError):
            evidence.validate_packet(packet)

        oversized_integer = b'{"version":' + (b"9" * 5_000) + b"}"
        with self.assertRaises(evidence.ValidationError):
            evidence.load_json_bytes(oversized_integer)

        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(evidence.main(["--check", str(packet)]), 1)
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_validator_has_no_command_network_or_unbounded_read_surface(self) -> None:
        source = (ROOT / "tools/validate_runtime_evidence.py").read_text(encoding="utf-8")
        for forbidden in (
            "subprocess",
            "socket",
            "urlopen",
            "urllib.request",
            "requests",
            "Popen",
            "npm install",
            ".read_bytes(",
            "list(directory.iterdir())",
        ):
            self.assertNotIn(forbidden, source)
        for required in ("os.scandir", "os.lstat", "os.open", "os.fstat", "O_NOFOLLOW"):
            self.assertIn(required, source)


if __name__ == "__main__":
    unittest.main()
