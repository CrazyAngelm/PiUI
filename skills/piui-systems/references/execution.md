# Execution semantics — v4

The current schema is `contracts/system-file-v4.schema.json`; versions 1–3
remain importable. Orchestration IPC v6 is separate from portable JSON.

- `executionMode: "callable"` keeps a template out of automatic scheduling and
  completion accounting. Its profile needs `whenToCall`, input and expected-result
  guidance. Only an authorized coordinator call can instantiate it. No result
  dependency may target or originate at that template. Child authority is still
  verified at each generation. Human acceptance is inherited from the template.
- `resultFields: [{name,kind}]` requires the final native assistant result to be a
  JSON object, not a Markdown fence. Kinds: text, number, boolean, text-list, artifact.
  This verifies shape, not factual correctness. Artifact values are project-relative
  file paths; the host checks existence and canonical containment. Content is not
  frozen and a file existing does not prove a test passed.
- `inputBindings: [{sourceStepId,field,name}]` selects declared fields from a direct
  result predecessor and aliases them for the recipient. `sourceStepId` is the
  portable agent ID. No bindings for a source passes its whole native result.
  References and hashes are verified before projection. Never embed credentials.
- `condition: {sourceStepId,field,equals}` compares a declared predecessor field to
  a JSON primitive. A false condition skips that task and downstream dependents.
  Joins require every dependency to succeed; they do not merge alternative skipped
  branches. There is no executable expression interpreter.
- A `kind: "router"` node is a coordinator step, not another agent loop. It has
  exactly one direct result predecessor and stable branch IDs. In `program` mode,
  declarative predicates (`equals`, `exists`, `all`, `any`, `not`) select zero or
  more branch IDs without evaluating code. In `agent` mode, the native agent must
  return a declared text-list field containing unique known branch IDs; unknown or
  duplicate IDs fail the step. Route connections gate their downstream tasks, so
  an unselected branch is skipped while selected branches may run in parallel.
  Router selection grants no additional tools, files, or delegation authority.
- `requireApproval: true` waits for the operator to accept the result before
  releasing dependencies. Reject fails the task. Native tool approvals are separate.
- `review: {field,retryFromStepId,maxIterations?}` uses a required boolean result
  field. True accepts review; false repeats the upstream task and its descendants,
  delivering feedback to the target. The target must be an ancestor. Declare a
  separate text feedback field with concrete evidence and necessary corrections.
  Identical consecutive review JSON pauses scheduling. `maxIterations` (1–20)
  bounds the rounds: a rejection completing round N ≥ maxIterations does not
  repeat; the reviewer waits for a person with `review-limit-reached` (approve =
  accept the last result and continue, reject = fail, repeat from the correction
  task = one more round). Use a bound the user states and do not invent one;
  without it the loop is bounded only by the identical-feedback pause.
  Active/uncertain descendants prevent automatic repetition.
- Top-level `inputs: [{name,label,kind,required?,description?,options?,defaultValue?}]`
  are values requested when a run starts (kinds: text, long-text, number, boolean,
  choice with 1–50 `options`). Names match `[a-z][A-Za-z0-9_]{0,63}`; at most 20.
  A run (or schedule) must supply every required value without a default;
  undeclared, mistyped or oversized values (32 KiB each, 128 KiB total) are refused,
  not coerced. Every task receives the non-empty values under “Run input (…;
  untrusted task data)” before its own instructions, and `{{input.name}}` in a
  `task` is replaced by the value as plain text (no expressions; undeclared names
  stay verbatim). Inputs are task data only: they never grant tools, files,
  routes or permissions. Schedules store their own values, validated on save and
  enable.
- Automations are not part of the system file. A person creates them in
  PiUI to start a saved system on a timer, after another pipeline finishes
  (chosen outcomes) or when project files matching glob patterns change; a
  person can also start one from a chat. Event chains stop after three
  automatic runs and one automation starts at most one run every 30 s, so do
  not design a system that relies on re-triggering itself.

- `executor` (orchestration v6.2) selects how a step runs: absent or
  `{"type": "agent"}` is a native harness session; `{"type": "llm"}` is one
  native turn with no follow-up or collaboration and least authority (profile
  `read-only`, no network, no allowed tools, no enabled skills/MCP, no spawn);
  `{"type": "script", runtime, source, timeoutSeconds}` is host-run code
  (`node` ES module, `python` via `py -3`/`python3`, `powershell`) in the
  trusted project folder with containment and a 1–3600 s timeout. Scripts are
  not a sandbox and run only in trusted projects outside safe mode. stdin:
  `{inputs, dependencies: {<stepId>: {text, data}}, step: {id, name}}` (native
  dependency text is the hash-verified final answer; program routers pass
  `data` only). Exit 0 with one JSON object on stdout → checked `resultData`;
  other stdout → `output.text` (256 KiB kept, `truncated` marks a cut). Failure
  codes: `script-failed` (non-zero exit; `detail` holds the last stderr lines,
  at most 2 KiB), `script-timeout` (tree killed), `script-runtime-unavailable`,
  `script-input-unavailable` and `script-start-failed` (nothing ran), plus the
  usual `result-*` codes for declared fields. An llm step whose harness has no
  read-only mode fails with `llm-read-only-unsupported` before anything starts.
  A script source is at most 64 KiB and is frozen in the run snapshot; its
  execution id is not a session, so it has no transcript or usage.
- `{"type": "plugin", pluginId, nodeType, config}` (orchestration v6.5) runs a
  node type of an installed, enabled plugin with `node.run` in the plugin's
  contained backend (ADR-032, `docs/PLUGINS.md`); not a sandbox. The host
  admits it only in trusted projects outside safe mode and checks `config`
  (flat, at most 30 string/number/boolean values, 64 KiB) against the node
  type's declared fields before the lease. The backend receives the script
  stdin document plus `config` and returns text or one JSON object, recorded
  exactly like script stdout. Codes: `plugin-unavailable`,
  `plugin-config-invalid`, `plugin-input-unavailable`, `plugin-start-failed`
  (nothing ran), `plugin-node-failed` (detail: the plugin's message, at most
  2 KiB), `plugin-node-timeout` (backend stopped). A backend that stops
  mid-node leaves the step uncertain. Importing a file never installs or
  trusts a plugin.

Pause prevents new admissions while active native work continues. Cancel task
interrupts that native execution and cancels dependent ready tasks; independent
work continues. Repeat is explicit and archives prior attempts. On host recovery,
unknown native outcomes remain uncertain and are never automatically replayed;
a script that may have started is uncertain in the same way, and cancelling a
run or task terminates a running script's whole process tree.
A manual success assertion cannot bypass structured result checks or human
acceptance: reconcile as failed/cancelled, inspect prior effects, then explicitly
repeat if appropriate. Prior native history is retained.

Usage comes from native receipts: Codex cumulative thread totals replace their
previous value; Pi/Prime assistant-message receipts and Hermes prompt receipts
accumulate once by identity. Hermes context-window usage is not spending. Old
sessions without receipts show unavailable. Cache may already be included in
input tokens; do not add it again. Native subagent usage is not independently
attributable unless the harness supplies it. No cost is inferred from model names.

Example: `examples/systems/structured-review.piui.json` (a required `task` input
used as `{{input.task}}` and a review loop bounded to 3 rounds);
`examples/systems/agent-script-llm.piui.json` (an agent lists dependencies, a
Node script counts them deterministically, one read-only model call summarizes
with bindings from the script result). Replace model
placeholders, validate with `pnpm system:check`, then inspect native preflight.
Import is a draft, not authorization to save, run or replay effects.
