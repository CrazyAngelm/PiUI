from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SPIKE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SPIKE_DIR))
import harness  # noqa: E402


class LfJsonlDecoderTests(unittest.TestCase):
    def test_fragmented_records_split_only_at_byte_lf(self) -> None:
        decoder = harness.LfJsonlDecoder()
        first = '{"type":"one","text":"before\u2028after"}'.encode("utf-8")
        self.assertEqual(decoder.feed(first), [])
        rows = decoder.feed(b"\n{\"type\":\"two\"")
        rows.extend(decoder.feed(b"}\r\n"))
        decoder.finish()
        self.assertEqual([row["type"] for row in rows], ["one", "two"])
        self.assertEqual(rows[0]["text"], "before\u2028after")

    def test_rejects_partial_eof_and_oversize_frame(self) -> None:
        decoder = harness.LfJsonlDecoder(2)
        with self.assertRaisesRegex(ValueError, "frame_limit_exceeded"):
            decoder.feed(b"abc")
        partial = harness.LfJsonlDecoder()
        partial.feed(b'{"type":"unfinished"')
        with self.assertRaisesRegex(ValueError, "incomplete_frame_at_eof"):
            partial.finish()

    def test_rejects_invalid_utf8_without_replacement(self) -> None:
        decoder = harness.LfJsonlDecoder()
        with self.assertRaisesRegex(ValueError, "invalid_jsonl_frame"):
            decoder.feed(b'{"type":"\xff"}\n')


class IsolationTests(unittest.TestCase):
    def test_isolated_environment_does_not_copy_provider_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(
                os.environ,
                {"OPENAI_API_KEY": "not-allowed", "ANTHROPIC_API_KEY": "not-allowed"},
                clear=False,
            ):
                environment = harness.isolated_environment(Path(directory))
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("ANTHROPIC_API_KEY", environment)
        self.assertEqual(environment["PI_OFFLINE"], "1")
        self.assertEqual(environment["PI_TELEMETRY"], "0")
        self.assertEqual(environment["PI_SKIP_VERSION_CHECK"], "1")

    def test_direct_command_has_no_caller_input_channel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = harness.direct_bash_command(
                SPIKE_DIR / "fixtures" / "sleeping_child.py", root / "ready"
            )
        self.assertTrue(command)
        self.assertNotIn("OPENAI_API_KEY", command)
        if os.name == "nt":
            self.assertIn("-EncodedCommand", command)
        else:
            self.assertTrue(command.startswith("exec "))


class ReportContractTests(unittest.TestCase):
    def test_valid_windows_fixture_is_accepted(self) -> None:
        harness.assert_report_contract(harness.example_windows_pass_report())

    def test_windows_pass_cannot_hide_live_child_or_fallback(self) -> None:
        report = harness.example_windows_pass_report()
        report["evidence"]["alive_owned_member_count_after_job_close"] = 1
        with self.assertRaisesRegex(ValueError, "live_owned_member"):
            harness.assert_report_contract(report)
        report = harness.example_windows_pass_report()
        report["evidence"]["emergency_fixture_cleanup_used"] = True
        with self.assertRaisesRegex(ValueError, "emergency_cleanup"):
            harness.assert_report_contract(report)

    def test_windows_report_cannot_claim_unrun_unix_branch(self) -> None:
        report = harness.example_windows_pass_report()
        report["unix_process_group"] = "passed"
        with self.assertRaisesRegex(ValueError, "must_not_claim_unix"):
            harness.assert_report_contract(report)


class CaptureBindingTests(unittest.TestCase):
    def test_windows_pass_has_safe_capture_identity(self) -> None:
        report = harness.example_windows_pass_report()
        capture = report["capture"]
        self.assertRegex(capture["timestamp_utc"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(capture["harness"]["id"], harness.HARNESS_ID)
        self.assertEqual(capture["harness"]["version"], harness.HARNESS_VERSION)
        self.assertEqual(capture["harness"]["source_sha256"], harness.harness_source_sha256())
        self.assertTrue(harness.is_sha256(capture["runtime"]["launcher_sha256"]))
        self.assertTrue(harness.is_safe_pi_version(capture["runtime"]["pi_version"]))

    def test_windows_pass_rejects_missing_or_tampered_capture_identity(self) -> None:
        cases = (
            ("runtime", None, "pass_missing_runtime_identity"),
            ("timestamp_utc", "not-utc", "invalid_capture_timestamp_utc"),
            ("source_sha256", "f" * 64, "harness_source_hash_mismatch"),
            ("launcher_sha256", "not-a-hash", "invalid_runtime_launcher_hash"),
            ("pi_version", "C:\\\\not-safe", "invalid_runtime_version"),
        )
        for field, value, expected_error in cases:
            with self.subTest(field=field):
                report = harness.example_windows_pass_report()
                if field == "runtime":
                    report["capture"].pop("runtime")
                elif field in {"timestamp_utc"}:
                    report["capture"][field] = value
                elif field == "source_sha256":
                    report["capture"]["harness"][field] = value
                else:
                    report["capture"]["runtime"][field] = value
                with self.assertRaisesRegex(ValueError, expected_error):
                    harness.assert_report_contract(report)

    def test_safe_version_parser_drops_untrusted_output(self) -> None:
        self.assertEqual(harness.safe_pi_version(b"0.81.1\r\n"), "0.81.1")
        self.assertIsNone(harness.safe_pi_version(b"C:\\\\private\\\\pi\n0.81.1\n"))
        self.assertIsNone(harness.safe_pi_version(b"not a version\n"))


class UnixReportContractTests(unittest.TestCase):
    def test_valid_unix_fixture_is_accepted(self) -> None:
        harness.assert_report_contract(harness.example_unix_pass_report())

    def test_unix_pass_requires_complete_containment_evidence(self) -> None:
        for field in (
            "runtime_created_new_session",
            "direct_bash_rpc_sent",
            "child_ready",
            "fixture_child_pid_observed",
            "graceful_eof_sent",
            "fixture_child_in_runtime_group_before_eof",
            "runtime_dead_after_group_escalation",
            "known_child_dead_after_group_escalation",
        ):
            with self.subTest(field=field):
                report = harness.example_unix_pass_report()
                report["evidence"][field] = False
                with self.assertRaisesRegex(ValueError, "complete_containment_evidence"):
                    harness.assert_report_contract(report)

    def test_unix_pass_rejects_cleanup_or_protocol_failure(self) -> None:
        report = harness.example_unix_pass_report()
        report["evidence"]["emergency_fixture_cleanup_used"] = True
        with self.assertRaisesRegex(ValueError, "emergency_cleanup"):
            harness.assert_report_contract(report)
        report = harness.example_unix_pass_report()
        report["evidence"]["lf_protocol_error"] = True
        with self.assertRaisesRegex(ValueError, "protocol_error"):
            harness.assert_report_contract(report)


@unittest.skipUnless(os.name == "nt", "Windows Job Object test")
class WindowsJobTests(unittest.TestCase):
    def test_real_job_has_kill_on_close_flag(self) -> None:
        job = harness.WindowsJob()
        try:
            self.assertTrue(job.kill_on_close_enabled)
            self.assertTrue(
                job.limit_flags() & harness.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            )
        finally:
            job.close()


if __name__ == "__main__":
    unittest.main()
