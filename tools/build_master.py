#!/usr/bin/env python3
"""Build PiUI_MASTER_SPEC.md from the modular specification files."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "PiUI_MASTER_SPEC.md"

SECTIONS = [
    ("overview", "Обзор и инварианты", ROOT / "README.md"),
    ("agents", "Правила для coding agents", ROOT / "AGENTS.md"),
    ("product", "01. Продуктовая спецификация", ROOT / "docs/01_PRODUCT.md"),
    ("ux", "02. UX и информационная архитектура", ROOT / "docs/02_UX.md"),
    ("architecture", "03. Архитектура", ROOT / "docs/03_ARCHITECTURE.md"),
    ("pi-integration", "04. Интеграция с Pi", ROOT / "docs/04_PI_INTEGRATION.md"),
    ("extension-sdk", "05. PiUI Extension SDK", ROOT / "docs/05_EXTENSION_SDK.md"),
    ("data", "06. Данные и сессии", ROOT / "docs/06_DATA_AND_SESSIONS.md"),
    ("security", "07. Безопасность", ROOT / "docs/07_SECURITY.md"),
    ("testing", "08. Тестирование и производительность", ROOT / "docs/08_TESTING_AND_PERFORMANCE.md"),
    ("roadmap", "09. Roadmap и инженерные задачи", ROOT / "docs/09_ROADMAP_AND_TASKS.md"),
    ("adr", "10. Архитектурные решения", ROOT / "docs/10_ADR.md"),
    ("reuse", "11. Анализ повторного использования", ROOT / "docs/11_REUSE_REVIEW.md"),
    ("risks", "12. Открытые риски и spikes", ROOT / "docs/12_OPEN_RISKS.md"),
    ("release-checklist", "Release readiness checklist", ROOT / "CHECKLIST_RELEASE.md"),
    ("handoff", "Prompt передачи новой команде", ROOT / "HANDOFF_PROMPT.md"),
    ("contracts-readme", "Контракты: руководство", ROOT / "contracts/README.md"),
    ("sources", "Источники", ROOT / "sources/SOURCES.md"),
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
        "# PiUI — единая продуктовая и техническая спецификация\n\n",
        "**Статус:** developer preview; production release gates остаются открытыми.\n\n",
        "**Назначение:** единый self-contained документ для product, UX, runtime, frontend, security, QA и release agents. Машиночитаемые файлы из каталога `contracts/` остаются нормативными при расхождении с текстовыми примерами.\n\n",
        "> Этот файл сгенерирован из модульных документов. Изменения следует вносить в исходные файлы и затем пересобирать master spec командой `python tools/build_master.py`.\n\n",
        "## Содержание\n\n",
    ]

    for anchor, title, _ in SECTIONS:
        parts.append(f"- [{title}](#{anchor})\n")
    parts.extend(
        [
            "- [Manifest schema](#manifest-schema)\n",
            "- [Runtime protocol](#runtime-protocol)\n",
            "- [PiUI Host API](#host-api)\n",
            "- [Эталонный dual package](#reference-package)\n",
        ]
    )

    for anchor, title, path in SECTIONS:
        if not path.exists():
            raise FileNotFoundError(path)
        parts.append(f'\n---\n\n<a id="{anchor}"></a>\n\n## {title}\n\n')
        parts.append(f"_Исходный файл: `{path.relative_to(ROOT).as_posix()}`._\n\n")
        parts.append(transform_markdown(path.read_text(encoding="utf-8")))

    contracts = [
        ("manifest-schema", "Manifest schema", ROOT / "contracts/piui-extension-manifest.schema.json", "json"),
        ("runtime-protocol", "Runtime protocol", ROOT / "contracts/runtime-protocol.ts", "ts"),
        ("host-api", "PiUI Host API", ROOT / "contracts/piui-host-api.d.ts", "ts"),
    ]
    for anchor, title, path, language in contracts:
        parts.append(f'\n---\n\n<a id="{anchor}"></a>\n\n## {title}\n\n')
        parts.append(f"_Нормативный файл: `{path.relative_to(ROOT).as_posix()}`._\n\n")
        parts.append(f"```{language}\n{path.read_text(encoding='utf-8').rstrip()}\n```\n")

    parts.append('\n---\n\n<a id="reference-package"></a>\n\n## Эталонный dual package\n\n')
    parts.append(
        "Пакет ниже иллюстрирует совместное размещение обычного Pi extension и необязательных PiUI contributions. "
        "Файлы в каталоге `examples/minimal-piui-package/` являются нормативным исполняемым примером.\n\n"
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
