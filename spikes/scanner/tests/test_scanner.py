from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scanner import _lf_frames, scan_path  # noqa: E402


class ScannerTests(unittest.TestCase):
    def fixture(self, name: str) -> Path:
        return ROOT / "fixtures" / name

    def test_v3_projection_is_deterministic_and_covers_metadata(self) -> None:
        first = scan_path(self.fixture("v3-normal.jsonl")).as_dict()
        second = scan_path(self.fixture("v3-normal.jsonl")).as_dict()
        self.assertEqual(first, second)
        self.assertEqual(first["parse_state"], "healthy")
        self.assertEqual(first["session_id"], "sess-v3")
        self.assertEqual(first["project_cwd"], "/synthetic/π-project")
        self.assertEqual(first["entry_count"], 6)
        self.assertEqual(first["image_entry_count"], 1)
        self.assertEqual(first["compaction_entry_count"], 1)
        self.assertEqual(first["branch_count"], 2)
        self.assertEqual(first["roots"], ["root-user"])
        self.assertEqual(first["current_leaf_id"], "branch-assistant")
        self.assertIn("Hello world 👋", first["first_user_preview"])

    def test_v3_known_entry_types_are_not_reported_unknown(self) -> None:
        report = scan_path(self.fixture("v3-known-types.jsonl"))
        self.assertEqual(report.parse_state, "healthy")
        self.assertEqual(report.session_name, "Updated title")
        self.assertEqual(report.entry_count, 6)
        self.assertEqual(report.model_ref, "synthetic/model")
        self.assertEqual(report.unknown_entries, [])
        self.assertEqual(
            [entry.entry_type for entry in report.entries],
            [
                "session_info",
                "message",
                "thinking_level_change",
                "model_change",
                "custom_message",
                "label",
            ],
        )

    def test_duplicate_entry_ids_are_corrupt_and_tree_keeps_first_node(self) -> None:
        report = scan_path(self.fixture("duplicate-entry-id.jsonl"))
        serialized = json.dumps(report.as_dict(), ensure_ascii=False)
        self.assertEqual(report.parse_state, "corrupt")
        self.assertEqual([item.code for item in report.diagnostics], ["duplicate-entry-id"])
        self.assertEqual(report.diagnostics[0].detail, "first seen at line 2")
        self.assertEqual([entry.entry_id for entry in report.entries], ["duplicate-id", "duplicate-id"])
        self.assertEqual([(node.entry_id, node.parent_id) for node in report.tree], [("duplicate-id", None)])
        self.assertNotIn("RAW DUPLICATE PAYLOAD", serialized)

    def test_unknown_only_file_is_unsupported_and_payload_safe(self) -> None:
        report = scan_path(self.fixture("unknown-only.jsonl"))
        serialized = json.dumps(report.as_dict(), ensure_ascii=False)
        self.assertEqual(report.parse_state, "unsupported")
        self.assertEqual(
            [item.entry_type for item in report.unknown_entries],
            ["future_session_header", "future_entry"],
        )
        self.assertEqual([entry.preview for entry in report.entries], [None, None])
        self.assertNotIn("UNKNOWN HEADER PROMPT", serialized)
        self.assertNotIn("UNKNOWN ENTRY CONTENT", serialized)
        self.assertNotIn("opaque", serialized)

    def test_cli_emits_utf8_with_cp1251_text_stdout(self) -> None:
        environment = os.environ | {"PYTHONIOENCODING": "cp1251"}
        result = subprocess.run(
            [sys.executable, str(ROOT / "scanner.py"), str(self.fixture("v3-normal.jsonl"))],
            capture_output=True,
            check=False,
            env=environment,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        report = json.loads(result.stdout.decode("utf-8"))
        self.assertIn("👋", report["first_user_preview"])

    def test_lf_parser_does_not_split_unicode_line_separator(self) -> None:
        frames, tail, complete = _lf_frames("a\u2028b\nc".encode("utf-8"))
        self.assertEqual(frames, [(1, "a\u2028b".encode("utf-8"))])
        self.assertEqual(tail, b"c")
        self.assertEqual(complete, len("a\u2028b\n".encode("utf-8")))

    def test_partial_tail_is_not_indexed(self) -> None:
        report = scan_path(self.fixture("partial-tail.jsonl"))
        self.assertEqual(report.parse_state, "partial")
        self.assertEqual(report.entry_count, 1)
        self.assertEqual([entry.entry_id for entry in report.entries], ["complete"])
        self.assertGreater(report.partial_tail_bytes, 0)
        self.assertNotIn("partial", [entry.entry_id for entry in report.entries])

    def test_corruption_unknown_summary_and_tree_repair(self) -> None:
        report = scan_path(self.fixture("corrupt-tree.jsonl"))
        serialized = json.dumps(report.as_dict(), ensure_ascii=False)
        self.assertEqual(report.parse_state, "corrupt")
        self.assertEqual([item.code for item in report.diagnostics], ["malformed-json"])
        self.assertEqual(report.orphan_ids, ["orphan"])
        self.assertEqual(report.cycle_ids, ["cycle-a", "cycle-b"])
        self.assertIn("cycle-a", report.roots)
        self.assertEqual(report.branch_count, 1)
        self.assertEqual(len(report.unknown_entries), 1)
        unknown = report.unknown_entries[0]
        self.assertEqual(unknown.entry_type, "future-widget")
        self.assertEqual(len(unknown.sha256), 64)
        self.assertNotIn("MUST NOT APPEAR", serialized)
        self.assertNotIn("opaque", serialized)


if __name__ == "__main__":
    unittest.main()
