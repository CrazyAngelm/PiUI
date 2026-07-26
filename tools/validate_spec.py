#!/usr/bin/env python3
"""Validate PiUI specification structure, links, JSON contracts and TS syntax."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    "README.md",
    "AGENTS.md",
    "HANDOFF_PROMPT.md",
    "CHECKLIST_RELEASE.md",
    "PiUI_MASTER_SPEC.md",
    *[f"docs/{index:02d}_{name}.md" for index, name in [
        (1, "PRODUCT"), (2, "UX"), (3, "ARCHITECTURE"), (4, "PI_INTEGRATION"),
        (5, "EXTENSION_SDK"), (6, "DATA_AND_SESSIONS"), (7, "SECURITY"),
        (8, "TESTING_AND_PERFORMANCE"), (9, "ROADMAP_AND_TASKS"), (10, "ADR"),
        (11, "REUSE_REVIEW"), (12, "OPEN_RISKS"),
    ]],
    "contracts/piui-extension-manifest.schema.json",
    "contracts/runtime-protocol.ts",
    "contracts/piui-host-api.d.ts",
    "examples/minimal-piui-package/piui.manifest.json",
    "examples/minimal-piui-package/pi/extension.ts",
    "examples/minimal-piui-package/piui/worker.js",
    "sources/SOURCES.md",
]
LINK_PATTERN = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
IGNORED_DIRECTORIES = {
    ".git",
    ".pnpm-store",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
}


def project_files(pattern: str) -> list[Path]:
    """Return authored project files without dependency or generated trees."""
    return [
        path
        for path in ROOT.rglob(pattern)
        if not any(part in IGNORED_DIRECTORIES for part in path.relative_to(ROOT).parts)
    ]


def fail(message: str, errors: list[str]) -> None:
    errors.append(message)


def check_required(errors: list[str]) -> None:
    for relative in REQUIRED:
        if not (ROOT / relative).exists():
            fail(f"Missing required file: {relative}", errors)


def check_json(errors: list[str]) -> None:
    json_files = sorted(project_files("*.json"))
    parsed: dict[Path, object] = {}
    for path in json_files:
        try:
            parsed[path] = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            fail(f"Invalid JSON {path.relative_to(ROOT)}: {exc}", errors)

    schema_path = ROOT / "contracts/piui-extension-manifest.schema.json"
    example_path = ROOT / "examples/minimal-piui-package/piui.manifest.json"
    if schema_path in parsed and example_path in parsed:
        try:
            import jsonschema  # type: ignore
        except ImportError:
            print("WARN: jsonschema is unavailable; semantic manifest validation skipped")
        else:
            try:
                jsonschema.Draft202012Validator.check_schema(parsed[schema_path])
            except Exception as exc:  # noqa: BLE001
                fail(f"Manifest JSON Schema itself is invalid: {exc}", errors)
                return

            validator = jsonschema.Draft202012Validator(parsed[schema_path])
            try:
                validator.validate(parsed[example_path])
            except Exception as exc:  # noqa: BLE001
                fail(f"Example manifest does not satisfy schema: {exc}", errors)

            # Security-sensitive structural invariants must fail closed. These
            # generated fixtures prevent a future schema edit from silently
            # weakening permission/entrypoint coupling.
            base = parsed[example_path]
            assert isinstance(base, dict)

            import copy

            invalid_cases: list[tuple[str, dict[str, object]]] = []

            missing_permissions = copy.deepcopy(base)
            missing_permissions.pop("permissions", None)
            invalid_cases.append(("missing explicit permissions array", missing_permissions))

            shell_without_permission = copy.deepcopy(base)
            shell_without_permission.setdefault("entrypoints", {})["shell"] = "./piui/shell.js"
            invalid_cases.append(("shell entrypoint without ui.shell", shell_without_permission))

            shell_permission_without_entrypoint = copy.deepcopy(base)
            shell_permission_without_entrypoint.setdefault("permissions", []).append("ui.shell")
            invalid_cases.append(("ui.shell without shell entrypoint", shell_permission_without_entrypoint))

            network_without_details = copy.deepcopy(base)
            network_without_details.setdefault("permissions", []).append("network")
            invalid_cases.append(("network permission without origin allowlist", network_without_details))

            details_without_network = copy.deepcopy(base)
            details_without_network["permissionDetails"] = {
                "network": {"origins": ["https://api.example.test"]}
            }
            invalid_cases.append(("network details without network permission", details_without_network))

            rich_without_permission = copy.deepcopy(base)
            rich_without_permission.setdefault("entrypoints", {})["views"] = {
                "details": "./piui/details.js"
            }
            rich_without_permission.setdefault("contributes", {}).setdefault("views", []).append({
                "id": "example.project-health.details",
                "title": "Details",
                "slot": "rightPanel.primary",
                "kind": "rich",
                "viewId": "details"
            })
            invalid_cases.append(("rich contribution without ui.richView", rich_without_permission))

            rich_permission_without_views = copy.deepcopy(base)
            rich_permission_without_views.setdefault("permissions", []).append("ui.richView")
            invalid_cases.append(("ui.richView without views entrypoint", rich_permission_without_views))

            for label, fixture in invalid_cases:
                if validator.is_valid(fixture):
                    fail(f"Schema accepted invalid manifest case: {label}", errors)

            valid_rich = copy.deepcopy(base)
            valid_rich.setdefault("permissions", []).append("ui.richView")
            valid_rich.setdefault("entrypoints", {})["views"] = {
                "details": "./piui/details.js"
            }
            valid_rich.setdefault("contributes", {}).setdefault("views", []).append({
                "id": "example.project-health.details",
                "title": "Details",
                "slot": "rightPanel.primary",
                "kind": "rich",
                "viewId": "details"
            })
            try:
                validator.validate(valid_rich)
            except Exception as exc:  # noqa: BLE001
                fail(f"Schema rejected valid rich-view manifest fixture: {exc}", errors)


def normalized_target(raw: str) -> str:
    target = raw.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    # Optional Markdown title after a quoted URL is outside the supported local format.
    return unquote(target.split("#", 1)[0].split("?", 1)[0])


def check_links(errors: list[str]) -> None:
    for path in sorted(project_files("*.md")):
        text = path.read_text(encoding="utf-8")
        in_fence = False
        fence_token: str | None = None
        visible_lines: list[str] = []
        for line in text.splitlines():
            stripped = line.lstrip()
            if stripped.startswith("```") or stripped.startswith("~~~"):
                token = stripped[:3]
                if not in_fence:
                    in_fence = True
                    fence_token = token
                elif token == fence_token:
                    in_fence = False
                    fence_token = None
                continue
            if not in_fence:
                visible_lines.append(line)
        visible = "\n".join(visible_lines)
        for match in LINK_PATTERN.finditer(visible):
            raw = match.group(1).strip()
            if raw.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target = normalized_target(raw)
            if not target:
                continue
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(ROOT.resolve())
            except ValueError:
                fail(f"Local link escapes package in {path.relative_to(ROOT)}: {raw}", errors)
                continue
            if not resolved.exists():
                fail(f"Broken local link in {path.relative_to(ROOT)}: {raw}", errors)


def check_typescript(errors: list[str]) -> None:
    pnpm = shutil.which("pnpm")
    tsc = shutil.which("tsc")
    if pnpm:
        # TypeScript is intentionally a desktop workspace dev dependency, not
        # a root dependency. Use its pinned compiler rather than a global one.
        command = [pnpm, "--filter", "@piui/desktop", "exec", "tsc"]
    elif tsc:
        command = [tsc]
    else:
        print("WARN: pnpm/tsc is unavailable; TypeScript contract check skipped")
        return
    command.extend([
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target", "ES2022",
        "--module", "ESNext",
        str(ROOT / "contracts/runtime-protocol.ts"),
        str(ROOT / "contracts/piui-host-api.d.ts"),
    ])
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    if result.returncode:
        fail(f"TypeScript contract check failed:\n{result.stdout}{result.stderr}", errors)


def check_javascript(errors: list[str]) -> None:
    node = shutil.which("node")
    if not node:
        print("WARN: node is unavailable; worker syntax check skipped")
        return
    worker = ROOT / "examples/minimal-piui-package/piui/worker.js"
    result = subprocess.run([node, "--check", str(worker)], text=True, capture_output=True, check=False)
    if result.returncode:
        fail(f"Reference worker syntax check failed:\n{result.stdout}{result.stderr}", errors)


def main() -> int:
    errors: list[str] = []
    check_required(errors)
    check_json(errors)
    check_links(errors)
    check_typescript(errors)
    check_javascript(errors)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        print(f"FAILED: {len(errors)} error(s)", file=sys.stderr)
        return 1
    print("OK: required files, JSON/schema, local links, TypeScript contracts and reference worker")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
