# SPIKE-09 — read-only session scanner

Portable Python 3.13+ harness for validating the minimum PiUI scanner behavior against **synthetic, non-sensitive** JSONL only. It is a Phase 0 compatibility spike, not a production indexer and not a Pi runtime adapter.

## Safety boundary

- Reads exactly one file supplied on the command line.
- Does not discover Pi roots, read configuration, enumerate home directories, or read user sessions by default.
- Opens input with `Path.read_bytes()` and never writes, renames, repairs, or truncates it.
- Unknown records become type/line/length/SHA-256 summaries; their payload, including a possible `prompt` field, is never emitted in the report.

## Run

```bash
python3.13 spikes/scanner/run_tests.py
python3.13 spikes/scanner/scanner.py spikes/scanner/fixtures/v3-normal.jsonl
```

The second command always writes a deterministic UTF-8 JSON report to stdout; it has no `--json` flag. The supplied path must be an existing regular file.

## Fixtures

- `v3-normal.jsonl`: synthetic v3 session metadata, Unicode, normal tree, custom entry, compaction, and image metadata.
- `corrupt-tree.jsonl`: malformed complete record, unknown future record, orphan, and cycle.
- `partial-tail.jsonl`: valid complete records followed by a non-LF-terminated partial record.
- `v3-known-types.jsonl`: Pi v3 `session_info`, `thinking_level_change`, `model_change`, `custom_message`, and `label` records.
- `duplicate-entry-id.jsonl`: duplicate entry IDs; both records remain listed while the tree retains the first file-order node.
- `unknown-only.jsonl`: forward-incompatible header and entry types with payload-safe summaries.

## Scanner contract demonstrated

1. Frames are split on byte `0x0A` only. Unicode separators never delimit frames.
2. A final byte sequence without LF is reported as `partial_tail_bytes` and is excluded from entries.
3. Invalid UTF-8, malformed JSON, non-object complete frames, and duplicate entry IDs are diagnostics; later complete frames continue to scan. Duplicate entries remain listed, while the tree uses the first file-order ID occurrence.
4. Unknown headers or top-level entry types produce safe type summaries and `unsupported` parse state unless the file is already `corrupt` or `partial`.
5. Tree output maintains file order, preserves orphans as roots, and breaks cycles only in the projection. Session input is untouched.
6. `file_revision` is SHA-256 of the exact input bytes. All lists are sorted or file-order stable, so the same bytes yield the same report.

See [DECISION_NOTE.md](DECISION_NOTE.md) for the compatibility conclusions and limits.
