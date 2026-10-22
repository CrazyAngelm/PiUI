# Agent systems as files

Current export: **version 5** ([schema](../contracts/system-file-v5.schema.json)).
Versions 1–4 remain importable unchanged and are exported as version 5. See
[execution contracts](../skills/piui-systems/references/execution.md) for callable
nodes, mappings, typed results, artifacts, conditions, approvals, review cycles
(including the optional `maxIterations` bound) and top-level run `inputs`.
Both additions are optional v4 fields; files without them are unchanged.
Version 5 adds sub-pipelines (below); a file without them differs from
version 4 only in its `version` number.
The active orchestration IPC is v6; native history formats are unchanged.

Optional `agents[].executor` (orchestration v6.2) makes a node a single
read-only model call (`{"type": "llm"}`) or a host-run script
(`{"type": "script", "runtime", "source", "timeoutSeconds"}`); a node without it
stays a native agent. Scripts are trusted user code that the host runs in the
project folder under process containment — not a sandbox — and importing a
file never runs one. `pnpm system:check` checks the executor rules and which
harnesses can run a model call read-only. Example:
[agent → script → model call](../examples/systems/agent-script-llm.piui.json).

`{"type": "plugin", "pluginId", "nodeType", "config"}` (orchestration v6.5,
ADR-032) names a node type of a PiUI plugin the user installed and trusted; its
`config` is a flat object of at most 30 string, number or boolean values. The
file only names the plugin: importing it never installs, enables or trusts
one, and the host checks the plugin and the node type's declared fields at
launch. Plugins can also ship pipeline templates, which are version 4 files
opened through this same import; the example
[collect-and-reshape](../examples/plugins/pipeline-pack/templates/collect-and-reshape.piui.json)
uses the pipeline pack's JSON transform node. See [PLUGINS.md](PLUGINS.md).
Plugin templates stay version 4 (the plugin package check and the host
validate the v4 schema), so a plugin cannot ship sub-pipeline templates yet.

## Sub-pipelines (version 5, orchestration v6.7, ADR-042)

A node with `{"type": "pipeline", "pipeline": "<name>", "inputs": {…}}` runs a
saved pipeline of the project the file is imported into as one step: an
ordinary child run with its own team, approvals and history. Launch command
ids are local to a project, so the file names the pipeline by its **name**:

- `inputs` maps each input name of the child pipeline to `{"kind": "value",
  "value": …}` (a fixed string, number or boolean), `{"kind": "input", "name":
  "<run input of this file>"}` or `{"kind": "step", "agent": "<local id of a
  direct upstream agent>", "field": "<its result field>"}` (without `field`,
  that agent's whole result text). At most 64 entries.
- Like a script, the node's `profile` only names the step; it has no model,
  input mappings, collaboration edges or callable mode, and it cannot be the
  orchestrator. Its `resultFields` usually repeat the child's outputs.
- Top-level `outputs: [{"name", "kind", "agent", "field"?}]` (at most 32)
  declare what this pipeline returns when another pipeline runs it; `agent` is
  a scheduled agent of this file and an output without `field` is its whole
  result text (`kind: "text"`).

Import resolves each name against the project's saved pipelines: the exact
name, else a unique case-insensitive match. A missing or ambiguous name stays
on the node, unresolved; the editor shows “Pipeline “X” is not in this project”
on it and refuses to save until the person picks a saved pipeline. Import
never creates, saves or runs a pipeline. `pnpm system:check` cannot know the
target project: it reports such names as resolved at import. The agent API
`prepare` command refuses a file with sub-pipelines for the same reason.
Export writes the chosen pipeline's current name (or the unresolved name it
was imported with). Examples: [Testing](../examples/systems/testing.piui.json)
declares outputs, and [development with testing](../examples/systems/development-with-testing.piui.json)
runs it as a sub-pipeline — import Testing first.


Pinned data (orchestration v6.4, [RUN_DEBUGGING.md](RUN_DEBUGGING.md)) is never
part of a system file: pins are copies of run results, which exports exclude
like native history. Export omits them and says so; import creates no pins; the
format is unchanged. The assistant keeps the pins of nodes that survive a
proposal.

Use UTF-8 `*.piui.json`. JSON Schemas are in `contracts/system-file-v1…v5.schema.json` (current: [v5](../contracts/system-file-v5.schema.json)); [examples](../examples/systems) cover a single agent, Codex → Prime review, and parallel work followed by synthesis. Replace example model placeholders with actual available native model IDs before execution.

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
