# Agent systems as files

Current export: **version 4**. Versions 1–3 remain importable. See
[execution contracts](../skills/piui-systems/references/execution.md) for callable
nodes, mappings, typed results, artifacts, conditions, approvals, review cycles
(including the optional `maxIterations` bound) and top-level run `inputs`.
Both additions are optional v4 fields; files without them are unchanged.
The active orchestration IPC is v6; native history formats are unchanged.


Use UTF-8 `*.piui.json`. JSON Schema is in [system-file-v1.schema.json](../contracts/system-file-v1.schema.json); [examples](../examples/systems) cover a single agent, Codex → Prime review, and parallel work followed by synthesis. Replace example model placeholders with actual available native model IDs before execution.

```powershell
pnpm system:check examples/systems/mixed-review.piui.json
```

The command accepts multiple paths, checks every input, exits nonzero if any fails, and launches no agents. It shares the application parser and adapter manifests. Syntax, structure, graph references, result cycles and monotonic child authority are checked locally; installed models, authentication, actual resource availability and native enforcement are checked by the host at launch.

In the application: **Workspace → Systems → File → Import JSON**. Choose the file, inspect the draft, and Save. Import does not automatically save, overwrite another system, or execute instructions. A malformed/unsupported file leaves the current graph unchanged; save an existing dirty draft first. Import is disabled in safe mode. **Export JSON** downloads the current draft as `system.piui.json`; prompts and resource paths are included, while credentials, native history and internal revisions are not. No executable includes or shell interpolation are supported. There is no automatic synchronization with an external file.

The v1 exchange format describes the unified graph: one agent profile and initial pipeline task per node, with distinct result/send/observe/spawn edges. Older advanced definitions with reusable members or external profile references still need their original editors; exporting them as this graph would be lossy and is not supported. Configuration IDs are local references, and import allocates new durable system/profile IDs. Export/import preserves task text, explicit empty versus omitted base prompt, reasoning, speed, resource rules, permissions, direction and positions. Save uses the existing atomic v3 host command; the file format version is independent of IPC and native history versions.

For an agent to create a file from plain language, use `$piui-systems`. Source: [SKILL.md](../skills/piui-systems/SKILL.md). The installed copy lives in the user's Codex skills folder. Example request:

> Use $piui-systems. Build a system for reviewing this repository: Codex inspects the architecture, an independent Codex agent inspects tests, then a final agent combines their evidence. Do not modify project files or run the system. Use the models available on this machine. Save and validate the configuration.

The skill uses **outcome → evidence → roles → dependencies → communication → authority → completion**. It explains native limitations, absent features and stop conditions instead of manufacturing permissions, model IDs, agent counts or retry limits. [Research and video comparison](../skills/piui-systems/references/research.md) records the reasoning and primary sources.

The schema validator is generated ahead of time (`pnpm system:schema`) so production CSP does not need `unsafe-eval`. `pnpm contract:test` rejects a stale generated validator. Ajv is a development dependency and is not bundled into the application.


## Verification — 2026-09-06

165 UI/unit tests and 31 contract tests passed, including schema generation
freshness, mixed-harness round trips, empty/omitted prompt distinction, bad
versions/fields/references, dependency cycles and denied privilege escalation.
CLI passed all example files; malformed/unsupported input returned nonzero.
The standalone validator passed Node's prohibition on string code generation.
Skill source and installed copy passed the skill validator.

Native Windows WebView2 import/export flow passed:
`target/piui-evidence/29100-1788709106242/report.json`. It exercised actual UI
serialization to Blob bytes, imported those bytes as a new draft, saved through
the real host, preserved the original system, and rejected bad JSON without
changing the graph. The test intercepted the final browser download click to
avoid writing to the user's Downloads folder; OS download UI was not automated.
Safe mode and native Codex lifecycle also passed. No paid model workload ran.

Production frontend initial assets: 209,752 bytes; the file validator is a
separate deferred chunk. A dev shell observation was 256 ms; these are not
production startup/RSS guarantees. No Rust/native protocol changed.
