# PiUI contracts

- `orchestration-v2.ts` and `orchestration-host-v2.ts` — current orchestration DTOs, `_v2` commands and invalidations (`protocol: 2`). Adds explicit Codex base instructions, dynamic tasks with an original launch snapshot, and opt-in spawned-peer messaging. Missing base instructions retain the native base; an empty string replaces it. Missing peer permission means parent-only. Run schema v1 migrates on read. The existing `orchestration-v1` storage directory and store envelope remain to preserve saved data; this is not the public API version.

- `piui-extension-manifest.schema.json` — normative JSON Schema for manifest v1.
- `piui-host-api.d.ts` — author-facing API for declarative workers and rich views.
- `runtime-protocol.ts` — internal typed IPC between the Rust host and core Svelte UI; v3 introduced the local live-runtime surface, v4 added Pi thinking-level discovery, v5 added host-owned personal Chats, v6 versioned semantic timeline projection v2, v7 added cache-first catalogs and watcher hints, v8 versioned PiUI-only appearance preferences, v9 added bounded extension UI/runtime commands, and v10 adds an explicit `pi | prime-agent` project kind, separate session discovery, runtime-scoped global extension commands, and a bounded non-authorizing Prime activity contract. A project has one kind; Pi and Prime roots, inventories, and opaque IDs remain separate. Prime 0.8.1 live start/continue/prompt/stop is fail-closed because its shared detached daemon is not contained by the current supervisor. Catalog freshness never authorizes a JSONL mutation.

## Rules

1. These files are versioned and undergo compatibility tests.
2. Raw Pi RPC types must not leak into the public PiUI Extension API.
3. Changing a required field or union value requires a protocol/schema major bump.
4. A new optional field within a major version must be safely ignored by an older consumer where specified.
5. Rust DTOs are generated from the same schema source or verified by golden JSON fixtures.
6. The example manifest must validate against this schema in CI; negative fixtures must prove incompatible permission/entrypoint combinations are rejected.
7. JSON Schema validates structural and some security invariants: `ui.shell` ↔ shell entrypoint, `network` ↔ allowlist origin, `ui.richView` ↔ views entrypoint, rich contribution → `ui.richView`.
8. The host performs a second, semantic pass: namespace uniqueness and ownership, existence of `viewId`/command/handler targets, dependency cycles, slot conflicts, trust level, actual Host API calls conforming to granted permissions, and prohibition of `ui.shell` for project-local/untrusted packages.
9. The API described here is the target implementation contract; it does not claim that the SDK already exists.

Orchestration v3 adds optional profile `reasoning`, `serviceTier`, `resourceRules`
and the atomic `orchestration_save_graph_v3` command. v1/v2 declarations remain
historical contracts; the active desktop uses v3. Recorded v1/v2 runs migrate
without native history mutation. Missing profile fields retain native defaults.
# Portable system files

`system-file-v1.schema.json` is the versioned JSON exchange contract for the
unified graph. It is not a native session format or a store generation dump.
Unknown fields and versions are rejected. The UI and `pnpm system:check` share
schema/semantic checks; the existing typed host remains authoritative for
save and execution. See `docs/SYSTEM_FILES.md`.

Workspace runtime settings use the additive `workspace_settings_v12` route and `workspace-settings-v12.ts`. The v11 command/event route remains frozen. Get/set are live trusted-session actions, blocked in safe mode. See `docs/RUNTIME_SETTINGS.md`.

# Step executors (orchestration v6.2)

`PipelineStep.executor` is additive within orchestration v6 and portable system
files v4: absent (or `{type:"agent"}`) keeps the native agent step, `llm` is one
read-only native turn without tools, collaboration or delegation, and `script`
(`runtime`, `source` up to 64 KiB, `timeoutSeconds` 1-3600) runs trusted user
code on the host in the project folder under process containment. A script is
not a sandbox. `TaskRecord.output`, `FailureRecord.detail` and
`LaunchRequest.dependencyOutputs` are additive record fields written by the
host. Older builds reject a document with an executor instead of running it as
an agent. See `crates/piui-orchestration/src/executors.rs`.

# Harness identities (ADR-028)

A harness value is an open registry identity, not a protocol revision. Rule 3
above applies to command, event and field shapes; adding a harness identity is
additive within the current versions: `claude-code` extends workspace v15
(`HarnessKind`, and so settings v16, lifecycle v17 and catalogs v18),
orchestration v6 (`Harness`) and portable system files v4. No command, event or
field changed, earlier documents keep their exact meaning, and v1-v3 system
files stay closed (their schemas never accept it). Older builds reject the new
value with an explicit validation error instead of misreading it. Round-trip and
compatibility tests cover every extended contract.

# Pinned data (orchestration v6.3) and run debugging v1

`PipelineStep.pinnedOutput` (`text` up to 256 KiB with `truncated`, `data` a
JSON object up to 256 KiB, `pinnedAt`, `sourceRunId`; at most 1 MiB of pins per
pipeline; refused on callable roles, program routers and reviewing steps),
`StartRunRequest.usePinnedData`, `OrchestrationRunV6.usePinnedData`,
`TaskRecord.pinned` and `RunSummary.archived` are additive within orchestration
v6 (v6.3). A run started with pinned data admits ready pinned steps as
succeeded with their pinned output (checked against their result fields; no
session or process) and hands it downstream like a recorded script result; a
run without it freezes no pins, and asking for it without pins is `conflict`.
The review code `review-retry-pinned` holds a rejection whose correction step
is pinned. Older runs and definitions decode and re-encode unchanged; older
builds reject a document with the new fields instead of misreading it.
Portable system files (v4) never carry pinned data.

`orchestration-run-debugging-v1.ts` is an independently versioned set of four
commands with opaque ids only: `orchestration_run_outputs_v1` (recorded outputs
of succeeded steps, native text verified by hash, read-only),
`orchestration_pin_step_output_v1` (the host reads the output and pins it into
the saved pipeline at an expected revision), `orchestration_set_run_archived_v1`
(UI metadata beside the runs) and `orchestration_delete_run_v1` (a finished
run's PiUI journal entry and verified script working copies; never native
sessions or project files; running and uncertain runs are `run-active`).
Writes are refused in safe mode. Refusals are typed `{code}` values; requests
reject unknown fields. `fixtures/orchestration-run-debugging-v1.json` is checked
by the Rust host and the TypeScript client. See `docs/RUN_DEBUGGING.md`.

# Script step test v1

`orchestration-script-test-v1.ts` is an independently versioned pair of
commands for the editor's "Test script": `orchestration_script_test_v1` runs
one script step's draft (`runtime`, `source`, `timeoutSeconds`, `resultFields`)
once with a caller-supplied sample stdin object (at most 256 KiB) and resolves
when it ended, timed out or was cancelled; `orchestration_cancel_script_test_v1`
stops it by the caller's `testId`. The host uses the run's script runner,
admission (trusted, live project outside safe mode, re-checked while it runs),
process-tree containment, environment allowlist, bounds and result checks, and
reports exactly what a run would record (`failure`), the parsed JSON object and
per-field issues. Nothing is written to a run; the request can only name a
script runtime, so a test never starts an agent or a model call. Refusals are
typed `{code}` values (`safe-mode`, `not-trusted`, `script-runtime-unavailable`,
…). Orchestration v6/v7 commands and records are unchanged. Both DTOs reject
unknown fields; `fixtures/orchestration-script-test-v1.json` is checked by the
Rust host and the TypeScript client.
