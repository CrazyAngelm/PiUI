from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codex_spike_probe", ROOT / "probe.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Codex spike probe")
probe = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = probe
SPEC.loader.exec_module(probe)


class LfJsonlDecoderTests(unittest.TestCase):
    def test_splits_only_on_lf(self) -> None:
        decoder = probe.LfJsonlDecoder()
        frames = decoder.feed(b'{"value":"a\\u2028b"}\n{"ok":true}\n')
        decoder.finish()
        self.assertEqual(frames, [{"value": "a\u2028b"}, {"ok": True}])

    def test_rejects_partial_tail(self) -> None:
        decoder = probe.LfJsonlDecoder()
        self.assertEqual(decoder.feed(b'{"partial":true}'), [])
        with self.assertRaises(probe.ProbeFailure):
            decoder.finish()


class ContractFixtureTests(unittest.TestCase):
    def test_contract_is_pinned_to_installed_spike_version(self) -> None:
        fixture = probe.load_fixture()
        self.assertEqual(fixture["codexCliVersion"], "0.147.0")
        self.assertFalse(fixture["wire"]["jsonrpcMember"])
        self.assertIn("turn/interrupt", fixture["clientRequests"])
        self.assertIn("item/commandExecution/requestApproval", fixture["serverRequests"])

    def test_stream_and_approval_fixture_round_trips(self) -> None:
        result = probe.validate_synthetic_fixture()
        self.assertTrue(result["fixtureMatched"])
        self.assertEqual(result["approvalRoundTrips"], 2)

    def test_sanitized_environment_excludes_credentials(self) -> None:
        env = probe.sanitized_environment(ROOT / ".probe-work" / "test-home")
        self.assertFalse(probe.has_sensitive_environment_key(env))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("CODEX_API_KEY", env)

    def test_checked_in_report_never_contains_protocol_payloads(self) -> None:
        report_path = ROOT / "reports" / "verification.json"
        if not report_path.is_file():
            self.skipTest("verification report is created by integration probe")
        report = report_path.read_text(encoding="utf-8")
        self.assertNotIn("instructionSources", report)
        self.assertNotIn("baseInstructions", report)
        self.assertNotIn("developerInstructions", report)
        self.assertNotIn("synthetic fixture; no model turn", report)
        json.loads(report)


if __name__ == "__main__":
    unittest.main()
