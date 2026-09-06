from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

SPIKE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SPIKE_ROOT))

import probe


VALID_TEXT: dict[str, str] = {
    "README.md": "Sessions auto-save as flat JSONL files under `~/.prime/agent/sessions/`. Each session header records its working directory.\n",
    "docs/daemon.md": """# Daemon
## Client-Owned Workers
RPC keeps LF-delimited JSONL framing and accepts prompts until EOF;
normal completion explicitly removes the worker without archiving it;
unexpected client loss starts a bounded cleanup grace period;
## Session Ownership and Leases
Concurrent opens return `session_already_active` with the owner.
""",
    "docs/extensions.md": """# Extensions
Create `~/.prime/agent/extensions/my-extension.ts` for global use.
Put project-local extensions in `.prime/agent/extensions/`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
""",
    "docs/rpc.md": "Built-in TUI commands are not included in get_commands.\n",
    "docs/sessions.md": "prime-agent --resume <path|id> resumes a specific session.\n",
    "dist/cli/args.js": """
if (mode === "rpc") result.mode = mode;
else if (arg === "--resume" || arg === "-r") result.resume = true;
else if (arg.startsWith("--resume=")) result.resume = arg;
""",
    "dist/config.js": """
const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".prime/agent";
// PRIME_AGENT_CODING_AGENT_DIR
function getSessionsDir(agentDir) { return join(agentDir, "sessions"); }
""",
    "dist/core/agent-session.js": """
this._emit({ type: "goal_update", goal: this.goalState });
this._emit({ type: "rlm_child_update", child: {} });
this._emit({ type: "refine_complete", result });
this._emit({ type: "refine_failed", error });
""",
    "dist/core/extensions/bundled-modules.js": """
export const VIRTUAL_MODULES = {
  "@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
  "@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};
""",
    "dist/core/extensions/loader.js": """
const _aliases = {
  "@earendil-works/pi-coding-agent": piCodingAgentEntry,
  "@mariozechner/pi-coding-agent": piCodingAgentEntry,
};
""",
    "dist/core/extensions/types.d.ts": """
interface ExtensionAPI {
  on(event: "session_before_refine", handler: unknown): void;
  on(event: "refine_complete", handler: unknown): void;
}
""",
    "dist/core/session-manager.js": """
const files = readdirSync(sessionDir)
 .filter((f) => f.endsWith(".jsonl"));
sessionHeaderMatchesCwd(header, cwd);
typeof header.cwd === "string";
const header = { type: "session", cwd: this.cwd };
""",
    "dist/core/slash-commands.js": '{ name: "login", description: "Configure provider authentication" };\n',
    "dist/main.js": """
const resumeSelector = getResumeSelector(parsed);
resolveSessionPath(resumeSelector, cwd, sessionDir);
SessionManager.open(resolved.path, sessionDir, explicitCwdOverride);
console.error("--resume without a session selector requires an interactive terminal");
""",
    "dist/migrations.js": """
/** Migrate legacy per-cwd session directories into the flat session root.
 * move any existing nested JSONL session files up one level.
 */
""",
    "dist/modes/rpc/jsonl.js": r"""
import { StringDecoder } from "node:string_decoder";
function serializeJsonLine(value) { return `${JSON.stringify(value)}\n`; }
const decoder = new StringDecoder("utf8");
let newlineIndex = text.indexOf("\n");
if (line.endsWith("\r")) line = line.slice(0, -1);
""",
    "dist/modes/rpc/rpc-mode.js": """
const outputConnectionEvent = () => {};
if (event.type === "session_event") { outputConnectionEvent(event.event); }
const handleCommand = async (command) => {
 switch (command.type) {
  case "prompt": break;
  case "abort": break;
  case "get_state": { const rpcState = { goal: state.goal }; break; }
  case "refine": break;
  case "get_session_stats": break;
  case "send_message": break;
  case "list_schedules": break;
  case "list_heartbeats": break;
  case "observe": break;
 }
};
const handleInputLine = async () => {};
process.stdin.on("end", onInputEnd);
Promise.resolve().then(() => connection.waitForIdle()).then(() => shutdown(), () => shutdown(1));
""",
}


VALID_BUNDLE_TEXT: dict[str, str] = {
    "dist/bundle/cli.js": """#!/usr/bin/env node
import "./chunk-entry.js";
await import("./cli-main.js");
""",
    "dist/bundle/chunk-entry.js": """import "./chunk-daemon.js";
export const entry = true;
""",
    "dist/bundle/cli-main.js": """import {
  only
} from "./chunk-only.js";
import { daemon } from "./chunk-daemon.js";
export function runCli() { return { daemon, only }; }
""",
    "dist/bundle/chunk-only.js": """export const only = true;
""",
    "dist/bundle/chunk-daemon.js": """export const daemon = {
  option: "--daemon-socket",
  conflict: "session_already_active",
  idle: "waitForIdle",
  state: "get_state",
  goal: "goal_update",
  child: "rlm_child_update",
};
""",
}


def write_valid_package(root: Path) -> None:
    manifest = {
        "name": "prime-agent",
        "version": "0.8.1",
        "bin": {"prime-agent": "dist/bundle/cli.js"},
    }
    for relative in probe.ALLOWLIST:
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if relative == "package.json":
            destination.write_text(json.dumps(manifest), encoding="utf-8")
        else:
            destination.write_text(VALID_TEXT[relative], encoding="utf-8")
    for relative, source in VALID_BUNDLE_TEXT.items():
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(source, encoding="utf-8")


class StaticProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "prime-agent"
        write_valid_package(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_checked_in_report_binds_bundle_and_denies_live_control(self) -> None:
        report = json.loads((SPIKE_ROOT / "reports/latest.json").read_text(encoding="utf-8"))
        probe.assert_safe_report(report)
        self.assertEqual(report["schema_version"], 2)
        self.assertEqual(report["package"], {"name": "prime-agent", "version": "0.8.1"})
        closure = report["checks"]["launched_bundle_closure"]
        self.assertEqual(closure["status"], "pass")
        self.assertEqual(closure["facts"]["closure_file_count"], len(closure["evidence"]))
        self.assertEqual(closure["facts"]["closure_file_count"], 40)
        self.assertFalse(closure["facts"]["live_control_authorized"])
        self.assertIn(probe.BUNDLE_ENTRYPOINT, {item["file"] for item in closure["evidence"]})
        ownership = report["checks"]["shutdown_and_ownership"]["facts"]
        self.assertEqual(ownership["supervisor_lifecycle_from_launched_bundle"], "shared-detached-daemon")
        self.assertFalse(ownership["piui_owns_supervisor"])

    def test_valid_static_package_passes_without_user_data_fields(self) -> None:
        report = probe.inspect_package(self.root)
        self.assertEqual(report["overall_status"], "pass")
        self.assertEqual(report["package"], {"name": "prime-agent", "version": "0.8.1"})
        self.assertEqual(report["collection"]["mode"], "static-bundle-closure-no-execution")
        bundle = report["checks"]["launched_bundle_closure"]
        self.assertEqual(bundle["status"], "pass")
        self.assertEqual(bundle["facts"]["entrypoint"], probe.BUNDLE_ENTRYPOINT)
        self.assertEqual(bundle["facts"]["closure_file_count"], len(VALID_BUNDLE_TEXT))
        self.assertFalse(bundle["facts"]["live_control_authorized"])
        self.assertEqual(
            {item["file"] for item in bundle["evidence"]},
            set(VALID_BUNDLE_TEXT),
        )
        self.assertFalse(report["collection"]["user_session_files_read"])
        self.assertFalse(report["collection"]["auth_json_read"])
        self.assertNotIn(str(self.root.resolve()), json.dumps(report))
        self.assertNotIn("auth.json", probe.ALLOWLIST)
        self.assertFalse(any("sessions" in Path(item).parts for item in probe.ALLOWLIST))

    def test_report_is_deterministic_for_unchanged_package(self) -> None:
        first = probe.inspect_package(self.root)
        second = probe.inspect_package(self.root)
        self.assertEqual(first, second)

    def test_version_mismatch_fails_closed(self) -> None:
        manifest_path = self.root / "package.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["version"] = "0.8.2"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        report = probe.inspect_package(self.root)
        self.assertEqual(report["overall_status"], "fail")
        self.assertEqual(report["checks"]["package_identity"]["status"], "fail")

    def test_missing_goal_projection_fails_prime_surface(self) -> None:
        path = self.root / "dist/modes/rpc/rpc-mode.js"
        path.write_text(path.read_text(encoding="utf-8").replace("goal: state.goal", "goal: null"), encoding="utf-8")
        report = probe.inspect_package(self.root)
        self.assertEqual(report["checks"]["prime_rpc_surface"]["status"], "fail")

    def test_typed_login_case_invalidates_auth_limitation(self) -> None:
        path = self.root / "dist/modes/rpc/rpc-mode.js"
        source = path.read_text(encoding="utf-8").replace('case "observe": break;', 'case "observe": break;\n  case "login": break;')
        path.write_text(source, encoding="utf-8")
        report = probe.inspect_package(self.root)
        self.assertEqual(report["checks"]["auth_limitation"]["status"], "fail")
        self.assertEqual(report["checks"]["auth_limitation"]["facts"]["typed_rpc_auth_commands"], ["login"])

    def test_missing_prime_extension_root_invalidates_extension_boundary(self) -> None:
        path = self.root / "docs/extensions.md"
        path.write_text(
            path.read_text(encoding="utf-8").replace(".prime/agent/extensions/", ".other/extensions/"),
            encoding="utf-8",
        )
        report = probe.inspect_package(self.root)
        self.assertEqual(report["checks"]["extension_boundary"]["status"], "fail")

    def test_missing_bundle_directory_is_rejected(self) -> None:
        import shutil

        shutil.rmtree(self.root / "dist/bundle")
        with self.assertRaises(probe.ProbeFailure):
            probe.inspect_package(self.root)

    def test_missing_imported_bundle_chunk_is_rejected(self) -> None:
        (self.root / "dist/bundle/chunk-daemon.js").unlink()
        with self.assertRaises(probe.ProbeFailure):
            probe.inspect_package(self.root)

    def test_missing_shared_daemon_marker_fails_launched_bundle_check(self) -> None:
        chunk = self.root / "dist/bundle/chunk-daemon.js"
        chunk.write_text(
            chunk.read_text(encoding="utf-8").replace("--daemon-socket", "--isolated-only"),
            encoding="utf-8",
        )
        report = probe.inspect_package(self.root)
        self.assertEqual(report["checks"]["launched_bundle_closure"]["status"], "fail")
        self.assertEqual(report["overall_status"], "fail")

    def test_bundle_chunk_mutation_changes_launched_closure_digest(self) -> None:
        first = probe.inspect_package(self.root)
        chunk = self.root / "dist/bundle/chunk-daemon.js"
        chunk.write_text(chunk.read_text(encoding="utf-8") + "// changed\n", encoding="utf-8")
        second = probe.inspect_package(self.root)
        self.assertNotEqual(
            first["checks"]["launched_bundle_closure"]["facts"]["closure_sha256"],
            second["checks"]["launched_bundle_closure"]["facts"]["closure_sha256"],
        )

    def test_bundle_import_escape_is_rejected(self) -> None:
        entry = self.root / probe.BUNDLE_ENTRYPOINT
        entry.write_text(entry.read_text(encoding="utf-8") + 'import "./../escape.js";\n', encoding="utf-8")
        with self.assertRaises(probe.ProbeFailure):
            probe.inspect_package(self.root)

    def test_missing_allowlisted_file_is_rejected(self) -> None:
        (self.root / "docs/sessions.md").unlink()
        with self.assertRaises(probe.ProbeFailure):
            probe.inspect_package(self.root)

    def test_package_identity_cannot_disclose_windows_root(self) -> None:
        manifest_path = self.root / "package.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["name"] = str(self.root.resolve())
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(probe.ProbeFailure):
            probe.inspect_package(self.root)

    def test_safe_report_rejects_raw_cwd_or_absolute_path(self) -> None:
        with self.assertRaises(probe.ProbeFailure):
            probe.assert_safe_report({"collection": {"allowlisted_package_files": []}, "cwd": "synthetic"})
        with self.assertRaises(probe.ProbeFailure):
            probe.assert_safe_report({"collection": {"allowlisted_package_files": []}, "value": r"C:\private\prime-agent"})


class JsonlFixtureTests(unittest.TestCase):
    def test_fixture_uses_lf_and_preserves_unicode_separator(self) -> None:
        data = (SPIKE_ROOT / "fixtures/prime-rpc-events.synthetic.jsonl").read_bytes()
        self.assertIn("alpha\u2028beta".encode("utf-8"), data)
        self.assertEqual(data.count(b"\n"), 5)
        decoder = probe.StrictLfJsonlDecoder()
        values: list[object] = []
        for byte in data:
            values.extend(decoder.feed(bytes([byte])))
        decoder.finish()
        self.assertEqual([value["type"] for value in values], [
            "goal_update", "rlm_child_update", "refine_complete", "refine_failed", "message_update"
        ])
        self.assertEqual(values[-1]["assistantMessageEvent"]["delta"], "alpha\u2028beta")

    def test_decoder_accepts_crlf_but_not_unterminated_record(self) -> None:
        decoder = probe.StrictLfJsonlDecoder()
        self.assertEqual(decoder.feed(b'{"type":"goal_update"}\r\n'), [{"type": "goal_update"}])
        decoder.finish()
        incomplete = probe.StrictLfJsonlDecoder()
        self.assertEqual(incomplete.feed(b'{"type":"goal_update"}'), [])
        with self.assertRaises(ValueError):
            incomplete.finish()


class SyntheticFlatSessionTests(unittest.TestCase):
    def test_flat_root_is_filtered_by_header_cwd_without_recursing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "sessions"
            root.mkdir()
            project = base / "project"
            other = base / "other"
            project.mkdir()
            other.mkdir()

            def write_session(path: Path, session_id: str, cwd: Path) -> None:
                path.parent.mkdir(parents=True, exist_ok=True)
                header = {"type": "session", "version": 3, "id": session_id, "cwd": str(cwd)}
                path.write_text(json.dumps(header) + "\n", encoding="utf-8")

            write_session(root / "matching.jsonl", "matching", project)
            write_session(root / "other.jsonl", "other", other)
            write_session(root / "legacy-nested" / "hidden.jsonl", "nested", project)
            (root / "malformed.jsonl").write_text("not-json\n", encoding="utf-8")
            self.assertEqual(probe.discover_synthetic_flat_sessions(root, project), ["matching"])


if __name__ == "__main__":
    unittest.main()
