# SPIKE-09 decision note — scanner compatibility boundary

**Status:** provisional Phase 0 evidence, based only on synthetic fixtures.

## Decision

A PiUI session scanner can safely use a byte-level LF (`0x0A`) framing pass before strict UTF-8 and JSON decoding. A non-LF-terminated final byte sequence must remain an unindexed tail. The scanner is read-only: it neither repairs malformed JSONL nor changes branch links.

The projection is deliberately tolerant:

- known v3-shaped session metadata, message, `session_info`, `thinking_level_change`, `model_change`, `custom`, `custom_message`, `label`, compaction, and image-bearing content produce a deterministic summary;
- unknown session headers or top-level record types are retained as safe summaries (`type`, line, byte length, SHA-256), not rendered raw, and make an otherwise healthy file `unsupported`;
- malformed complete records and duplicate entry IDs produce diagnostics and make the projection `corrupt`; duplicate entries remain listed while the tree deterministically retains the first file-order ID occurrence;
- orphan records remain visible as diagnostic roots;
- cycles are reported and broken solely in the in-memory tree projection at the earliest file-order member of each cycle.

`branch_count` means the number of projected nodes with more than one child. `current_leaf_id` is the last file-order leaf heuristic, not an authoritative Pi current-path claim.

## Evidence

`run_tests.py` validates normal v3-shaped metadata/tree/custom/compaction/image coverage, known Pi v3 entry types, Unicode LF framing, partial-tail exclusion, malformed and duplicate-ID records, unknown/unsupported payload-safe reports, orphan preservation, and cycle handling.

## Limits / remaining risk

This harness does **not** resolve Pi roots/configuration, watch files, incrementally append, define the exact upstream v3 schema, or prove compatibility with real user sessions. It intentionally never reads user sessions by default. Before DATA-02/G1, run the same report and fixtures against an approved, anonymized real Pi corpus across supported Pi versions and record any new types as fixtures or unsupported states.
