#!/usr/bin/env python3
"""Build PiUI_MASTER_SPEC.md from the modular specification files."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "PiUI_MASTER_SPEC.md"

SECTIONS = [
    ("overview", "Overview and invariants", ROOT / "README.md"),
    ("agents", "Rules for coding agents", ROOT / "AGENTS.md"),
    ("product", "01. Product specification", ROOT / "docs/01_PRODUCT.md"),
    ("ux", "02. UX and information architecture", ROOT / "docs/02_UX.md"),
    ("architecture", "03. Architecture", ROOT / "docs/03_ARCHITECTURE.md"),
    ("pi-integration", "04. Pi integration", ROOT / "docs/04_PI_INTEGRATION.md"),
    ("extension-sdk", "05. PiUI Extension SDK", ROOT / "docs/05_EXTENSION_SDK.md"),
    ("data", "06. Data and sessions", ROOT / "docs/06_DATA_AND_SESSIONS.md"),
    ("security", "07. Security", ROOT / "docs/07_SECURITY.md"),
    ("testing", "08. Testing and performance", ROOT / "docs/08_TESTING_AND_PERFORMANCE.md"),
    ("roadmap", "09. Roadmap and engineering tasks", ROOT / "docs/09_ROADMAP_AND_TASKS.md"),
    ("adr", "10. Architecture decisions", ROOT / "docs/10_ADR.md"),
    ("reuse", "11. Reuse analysis", ROOT / "docs/11_REUSE_REVIEW.md"),
    ("risks", "12. Open risks and spikes", ROOT / "docs/12_OPEN_RISKS.md"),
    ("release-checklist", "Release readiness checklist", ROOT / "CHECKLIST_RELEASE.md"),
    ("handoff", "Handoff prompt for a new team", ROOT / "HANDOFF_PROMPT.md"),
    ("contracts-readme", "Contracts: guide", ROOT / "contracts/README.md"),
    ("sources", "Sources", ROOT / "sources/SOURCES.md"),
]

LINK_REWRITES = {
    "PiUI_MASTER_SPEC.md": "#overview",
    "AGENTS.md": "#agents",
    "HANDOFF_PROMPT.md": "#handoff",
    "CHECKLIST_RELEASE.md": "#release-checklist",
    "docs/01_PRODUCT.md": "#product",
    "docs/02_UX.md": "#ux",
    "docs/03_ARCHITECTURE.md": "#architecture",
    "docs/04_PI_INTEGRATION.md": "#pi-integration",
    "docs/05_EXTENSION_SDK.md": "#extension-sdk",
    "docs/06_DATA_AND_SESSIONS.md": "#data",
    "docs/07_SECURITY.md": "#security",
    "docs/08_TESTING_AND_PERFORMANCE.md": "#testing",
    "docs/09_ROADMAP_AND_TASKS.md": "#roadmap",
    "docs/10_ADR.md": "#adr",
    "docs/11_REUSE_REVIEW.md": "#reuse",
    "docs/12_OPEN_RISKS.md": "#risks",
    "sources/SOURCES.md": "#sources",
    "contracts/": "#contracts-readme",
    "examples/minimal-piui-package/": "#reference-package",
}


def transform_markdown(text: str) -> str:
    """Demote headings and rewrite package-local links outside code fences."""
    lines: list[str] = []
    in_fence = False
    fence_token: str | None = None

    for original in text.splitlines():
        line = original
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            token = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_token = token
            elif token == fence_token:
                in_fence = False
                fence_token = None
            lines.append(line)
            continue

        if not in_fence:
            if line.startswith("#"):
                line = "#" + line
            for old, new in LINK_REWRITES.items():
                line = line.replace(f"]({old})", f"]({new})")

        lines.append(line)

    return "\n".join(lines).rstrip() + "\n"


def build() -> str:
    parts: list[str] = [
        "# PiUI — unified product and technical specification\n\n",
        "**Status:** developer preview; production release gates remain open.\n\n",
        "**Purpose:** a single self-contained document for product, UX, runtime, frontend, security, QA, and release agents. Machine-readable files in `contracts/` remain normative where they differ from textual examples.\n\n",
        "> This file is generated from modular documents. Make changes in the source files, then rebuild the master specification with `python tools/build_master.py`.\n\n",
        "## Contents\n\n",
    ]

    for anchor, title, _ in SECTIONS:
        parts.append(f"- [{title}](#{anchor})\n")
    parts.extend(
        [
            "- [Manifest schema](#manifest-schema)\n",
            "- [Runtime protocol](#runtime-protocol)\n",
            "- [PiUI Host API](#host-api)\n",
            "- [Reference dual package](#reference-package)\n",
        ]
    )

    for anchor, title, path in SECTIONS:
        if not path.exists():
            raise FileNotFoundError(path)
        parts.append(f'\n---\n\n<a id="{anchor}"></a>\n\n## {title}\n\n')
        parts.append(f"_Source file: `{path.relative_to(ROOT).as_posix()}`._\n\n")
        parts.append(transform_markdown(path.read_text(encoding="utf-8")))

    contracts = [
        ("manifest-schema", "Manifest schema", ROOT / "contracts/piui-extension-manifest.schema.json", "json"),
        ("runtime-protocol", "Runtime protocol", ROOT / "contracts/runtime-protocol.ts", "ts"),
        ("host-api", "PiUI Host API", ROOT / "contracts/piui-host-api.d.ts", "ts"),
    ]
    for anchor, title, path, language in contracts:
        parts.append(f'\n---\n\n<a id="{anchor}"></a>\n\n## {title}\n\n')
        parts.append(f"_Normative file: `{path.relative_to(ROOT).as_posix()}`._\n\n")
        parts.append(f"```{language}\n{path.read_text(encoding='utf-8').rstrip()}\n```\n")

    parts.append('\n---\n\n<a id="reference-package"></a>\n\n## Reference dual package\n\n')
    parts.append(
        "The package below illustrates colocating a standard Pi extension and optional PiUI contributions. "
        "Files in `examples/minimal-piui-package/` are the normative executable example.\n\n"
    )
    language_by_suffix = {".md": "md", ".json": "json", ".ts": "ts", ".js": "js"}
    example_dir = ROOT / "examples/minimal-piui-package"
    for path in sorted(candidate for candidate in example_dir.rglob("*") if candidate.is_file()):
        relative = path.relative_to(ROOT).as_posix()
        language = language_by_suffix.get(path.suffix, "")
        parts.append(f"### `{relative}`\n\n")
        parts.append(f"```{language}\n{path.read_text(encoding='utf-8').rstrip()}\n```\n\n")

    return "".join(parts).rstrip() + "\n"


if __name__ == "__main__":
    OUT.write_text(build(), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size:,} bytes)")
