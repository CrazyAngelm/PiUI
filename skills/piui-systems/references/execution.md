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
- `review: {field,retryFromStepId}` uses a required boolean result field. True
  accepts review; false repeats the upstream task and its descendants, delivering
  feedback to the target. The target must be an ancestor. Declare a separate text
  feedback field with concrete evidence and necessary corrections. Identical
  consecutive review JSON pauses scheduling; there is no invented retry limit.
  Active/uncertain descendants prevent automatic repetition.

Pause prevents new admissions while active native work continues. Cancel task
interrupts that native execution and cancels dependent ready tasks; independent
work continues. Repeat is explicit and archives prior attempts. On host recovery,
unknown native outcomes remain uncertain and are never automatically replayed.
A manual success assertion cannot bypass structured result checks or human
acceptance: reconcile as failed/cancelled, inspect prior effects, then explicitly
repeat if appropriate. Prior native history is retained.

Usage comes from native receipts: Codex cumulative thread totals replace their
previous value; Pi/Prime assistant-message receipts and Hermes prompt receipts
accumulate once by identity. Hermes context-window usage is not spending. Old
sessions without receipts show unavailable. Cache may already be included in
input tokens; do not add it again. Native subagent usage is not independently
attributable unless the harness supplies it. No cost is inferred from model names.

Example: `examples/systems/structured-review.piui.json`. Replace model placeholders,
validate with `pnpm system:check`, then inspect native preflight. Import is a draft,
not authorization to save, run or replay effects.
