#!/usr/bin/env python3
"""SPIKE-09 read-only, LF-framed Pi session JSONL scanner.

This harness intentionally accepts an explicit fixture/session path only.  It never
looks up Pi configuration, home directories, or user session roots.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

# Pi v3 session entry types represented by the compatibility fixtures. Unknown
# remains the forward-compatible fallback rather than a parse failure.
KNOWN_TYPES = frozenset({
    "session", "session_meta", "session_info", "message", "custom", "custom_message",
    "compaction", "model_change", "thinking_level_change", "label", "branch_summary",
    "tool", "tool_result",
})
METADATA_TYPES = frozenset({"session", "session_meta"})
SESSION_INFO_TYPES = frozenset({"session", "session_meta", "session_info"})


@dataclass(frozen=True)
class Diagnostic:
    code: str
    line: int
    detail: str


@dataclass(frozen=True)
class UnknownSummary:
    line: int
    entry_type: str
    byte_length: int
    sha256: str


@dataclass
class IndexedEntry:
    line: int
    order: int
    entry_id: str | None
    parent_id: str | None
    entry_type: str
    role: str | None
    preview: str | None
    created_at: str | None
    has_image: bool
    model_ref: str | None


@dataclass
class TreeNode:
    entry_id: str
    parent_id: str | None
    children: list[str] = field(default_factory=list)


@dataclass
class ScanReport:
    scanner: str
    source_name: str
    file_revision: str
    complete_bytes: int
    partial_tail_bytes: int
    parse_state: str
    session_id: str | None
    session_name: str | None
    project_cwd: str | None
    created_at: str | None
    updated_at: str | None
    first_user_preview: str | None
    last_message_preview: str | None
    model_ref: str | None
    entry_count: int
    image_entry_count: int
    compaction_entry_count: int
    branch_count: int
    current_leaf_id: str | None
    roots: list[str]
    orphan_ids: list[str]
    cycle_ids: list[str]
    unknown_entries: list[UnknownSummary]
    diagnostics: list[Diagnostic]
    entries: list[IndexedEntry]
    tree: list[TreeNode]

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def _lf_frames(data: bytes) -> tuple[list[tuple[int, bytes]], bytes, int]:
    """Return complete byte frames split exclusively on byte 0x0A.

    A Unicode line separator and CR are ordinary bytes here.  CR is not silently
    normalized, so JSON decoding decides whether it is valid whitespace.
    """
    frames: list[tuple[int, bytes]] = []
    start = 0
    line = 1
    while True:
        end = data.find(b"\n", start)
        if end < 0:
            return frames, data[start:], start
        frames.append((line, data[start:end]))
        line += 1
        start = end + 1


def _text(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        pieces: list[str] = []
        for item in value:
            if isinstance(item, str):
                pieces.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                pieces.append(item["text"])
        return "".join(pieces) or None
    if isinstance(value, dict) and isinstance(value.get("text"), str):
        return value["text"]
    return None


def _preview(value: object, limit: int = 120) -> str | None:
    text = _text(value)
    if not text:
        return None
    normalized = " ".join(text.split())
    return normalized[:limit]


def _string(mapping: dict[str, object], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _content_has_image(value: object) -> bool:
    if isinstance(value, dict):
        kind = value.get("type")
        if kind in {"image", "image_url", "input_image"}:
            return True
        return any(_content_has_image(child) for child in value.values())
    if isinstance(value, list):
        return any(_content_has_image(child) for child in value)
    return False


def _entry_from(value: dict[str, object], line: int, order: int, *, known_type: bool) -> IndexedEntry:
    message = value.get("message")
    message_map = message if isinstance(message, dict) else {}
    entry_type = _string(value, "type", "entryType") or "missing-type"
    # Unknown entries keep only structural projection fields. Their content must
    # not become a preview merely because a future format calls it `content`.
    content = message_map.get("content", value.get("content", value.get("text"))) if known_type else None
    return IndexedEntry(
        line=line,
        order=order,
        entry_id=_string(value, "entryId", "id"),
        parent_id=_string(value, "parentId", "parent_id"),
        entry_type=entry_type,
        role=(_string(message_map, "role") or _string(value, "role")) if known_type else None,
        preview=_preview(content),
        created_at=_string(value, "timestamp", "createdAt", "created_at"),
        has_image=(_content_has_image(content) or _content_has_image(value.get("images"))) if known_type else False,
        model_ref=_string(value, "model", "modelId", "model_id") if known_type else None,
    )


def _tree(entries: Iterable[IndexedEntry]) -> tuple[list[TreeNode], list[str], list[str], list[str], int, str | None]:
    identified = [entry for entry in entries if entry.entry_id]
    # Duplicate IDs are diagnosed before projection. Retain every entry in the
    # report but choose the first file-order occurrence for the ID-keyed tree.
    nodes: dict[str, TreeNode] = {}
    order: dict[str, int] = {}
    for entry in identified:
        if entry.entry_id not in nodes:
            nodes[entry.entry_id] = TreeNode(entry.entry_id, entry.parent_id)
            order[entry.entry_id] = entry.order
    orphan_ids = sorted(node.entry_id for node in nodes.values() if node.parent_id and node.parent_id not in nodes)

    # Find every cyclic component by walking parent links; then break each at the
    # earliest file-order node. This is a projection-only repair.
    cycle_ids: set[str] = set()
    for node_id in nodes:
        seen: list[str] = []
        cursor: str | None = node_id
        while cursor in nodes and cursor not in seen:
            seen.append(cursor)
            cursor = nodes[cursor].parent_id
        if cursor in seen:
            cycle_ids.update(seen[seen.index(cursor):])
    if cycle_ids:
        # A single deterministic break per component is enough; repeat traversal
        # because unrelated cycles may coexist.
        remaining = set(cycle_ids)
        while remaining:
            start = next(iter(remaining))
            component: list[str] = []
            cursor: str | None = start
            while cursor in remaining and cursor not in component:
                component.append(cursor)
                cursor = nodes[cursor].parent_id
            breaker = min(component, key=lambda item: (order[item], item))
            nodes[breaker].parent_id = None
            remaining.difference_update(component)

    for node in nodes.values():
        if node.parent_id in nodes:
            nodes[node.parent_id].children.append(node.entry_id)
    for node in nodes.values():
        node.children.sort(key=lambda item: (order[item], item))
    roots = [node.entry_id for node in nodes.values() if node.parent_id is None or node.entry_id in orphan_ids]
    roots.sort(key=lambda item: (order[item], item))
    leaves = [node.entry_id for node in nodes.values() if not node.children]
    leaves.sort(key=lambda item: (order[item], item))
    branch_count = sum(1 for node in nodes.values() if len(node.children) > 1)
    tree = sorted(nodes.values(), key=lambda node: (order[node.entry_id], node.entry_id))
    return tree, roots, orphan_ids, sorted(cycle_ids), branch_count, (leaves[-1] if leaves else None)


def scan_path(path: Path) -> ScanReport:
    """Read a single explicitly supplied file without modifying it."""
    data = path.read_bytes()
    frames, tail, complete_bytes = _lf_frames(data)
    diagnostics: list[Diagnostic] = []
    entries: list[IndexedEntry] = []
    unknown: list[UnknownSummary] = []
    session_id = session_name = project_cwd = created_at = None
    last_model: str | None = None
    seen_entry_ids: dict[str, int] = {}

    for line, frame in frames:
        if not frame:
            diagnostics.append(Diagnostic("empty-frame", line, "ignored"))
            continue
        try:
            decoded = frame.decode("utf-8", "strict")
        except UnicodeDecodeError as error:
            diagnostics.append(Diagnostic("invalid-utf8", line, f"byte {error.start}"))
            continue
        try:
            value = json.loads(decoded)
        except json.JSONDecodeError as error:
            diagnostics.append(Diagnostic("malformed-json", line, f"column {error.colno}"))
            continue
        if not isinstance(value, dict):
            diagnostics.append(Diagnostic("non-object-entry", line, "ignored"))
            continue
        entry_type = _string(value, "type", "entryType") or "missing-type"
        known_type = entry_type in KNOWN_TYPES
        if not known_type:
            unknown.append(UnknownSummary(line, entry_type, len(frame), hashlib.sha256(frame).hexdigest()))
        if entry_type in SESSION_INFO_TYPES:
            id_keys = ("sessionId", "session_id", "id") if entry_type in METADATA_TYPES else ("sessionId", "session_id")
            session_id = _string(value, *id_keys) or session_id
            session_name = _string(value, "name", "sessionName", "title") or session_name
            project_cwd = _string(value, "cwd", "projectCwd", "project_cwd") or project_cwd
            created_at = _string(value, "createdAt", "created_at", "timestamp") or created_at
            last_model = _string(value, "model", "modelId", "model_id") or last_model
        if entry_type in METADATA_TYPES:
            continue
        entry = _entry_from(value, line, len(entries), known_type=known_type)
        if entry.entry_id:
            first_line = seen_entry_ids.setdefault(entry.entry_id, line)
            if first_line != line:
                diagnostics.append(Diagnostic("duplicate-entry-id", line, f"first seen at line {first_line}"))
        entries.append(entry)
        last_model = entry.model_ref or last_model

    tree, roots, orphans, cycles, branch_count, leaf = _tree(entries)
    user_previews = [entry.preview for entry in entries if entry.role == "user" and entry.preview]
    message_previews = [entry.preview for entry in entries if entry.role in {"user", "assistant"} and entry.preview]
    parse_state = "corrupt" if diagnostics else ("partial" if tail else ("unsupported" if unknown else "healthy"))
    return ScanReport(
        scanner="piui-spike-09-scanner-v1",
        source_name=path.name,
        file_revision=hashlib.sha256(data).hexdigest(),
        complete_bytes=complete_bytes,
        partial_tail_bytes=len(tail),
        parse_state=parse_state,
        session_id=session_id,
        session_name=session_name,
        project_cwd=project_cwd,
        created_at=created_at,
        updated_at=next((entry.created_at for entry in reversed(entries) if entry.created_at), created_at),
        first_user_preview=user_previews[0] if user_previews else None,
        last_message_preview=message_previews[-1] if message_previews else None,
        model_ref=last_model,
        entry_count=len(entries),
        image_entry_count=sum(entry.has_image for entry in entries),
        compaction_entry_count=sum(entry.entry_type == "compaction" for entry in entries),
        branch_count=branch_count,
        current_leaf_id=leaf,
        roots=roots,
        orphan_ids=orphans,
        cycle_ids=cycles,
        unknown_entries=unknown,
        diagnostics=diagnostics,
        entries=entries,
        tree=tree,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only SPIKE-09 JSONL scanner")
    parser.add_argument("path", type=Path, help="explicit JSONL file; no session roots are searched")
    args = parser.parse_args()
    if not args.path.is_file():
        parser.error("path must name an existing regular file")
    payload = json.dumps(scan_path(args.path).as_dict(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    # Bypass the locale-configured TextIO wrapper (for example cp1251 on a
    # Windows console). WindowsConsoleIO accepts UTF-8 bytes, as do redirected
    # byte streams, so emitted JSON is always UTF-8 without escaping Unicode.
    sys.stdout.buffer.write(payload.encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
