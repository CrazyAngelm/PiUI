# Execution workbench

Approved 2026-09-07. Outcome: configure, execute, inspect and resume a mixed-harness
agent system in one desktop workbench. Native harnesses retain their own loops,
credentials, approvals and authoritative histories.

## Acceptance and order

- [x] Separate scheduled steps from callable-only agents. Preserve old graph semantics.
- [x] Explicit, validated input/result contracts and artifact references across harnesses.
- [x] Conditions, joins, acceptance, human decisions and revision cycles with explicit completion criteria.
- [x] Execution graph, selectable instances, resizable inspector and event history.
- [x] Native activity, conversations, tool history and non-duplicated usage per attempt/agent/run; unknown is not zero.
- [x] Pause new admissions, cancellation and safe recovery with retained attempts.
- [x] Adapter-specific preflight and actionable capability diagnostics.
- [x] Versioned JSON compatibility, shared validator, examples, skill and architecture/style documentation.
- [ ] Unit/contract/native WebView verification, scoped commits and installed release verification.

Do not install a second coordinator. Do not execute code from imported documents.
No inferred token prices, fabricated progress, silent retries or arbitrary iteration
limits. User-defined spending/iteration policies require authoritative usage and
explicit configuration. A native turn completing does not prove task acceptance.

## Evidence

- Core: coordinator tests cover callable admission, ACL denial, typed result validation,
  selected field projection, approvals, false conditions, revision retention, pause
  on identical feedback, cancellation of one task and uncertain recovery.
- Joins retain all-predecessors-successful semantics. A skipped predecessor skips
  downstream tasks; alternative-branch merge is not advertised. Artifact references
  validate existing in-project files, not immutable contents or semantic test success.
- IPC v6 and portable v4 preserve earlier version imports. The skill and example
  use the shared CSP-safe validator. Native workspace protocol remains v15.
- `pnpm check`, UI tests, contract tests, bridge adapter tests, `cargo test --workspace`
  and `cargo clippy --workspace --all-targets -- -D warnings` passed. Explicit paid
  provider tests remain opt-in; ordinary workspace tests do not imply paid coverage.
- Native Windows WebView evidence: `target/piui-evidence/23924-1788754579853/report.json`.
  Graph selection, failed-run truth, unavailable usage, keyboard resize, v4 import
  and save, reload, native Codex lifecycle, safe mode and existing settings passed.
- Real installed Pi/Codex/Prime with isolated local deterministic provider:
  `target/native-settings-eRlNVM/report.json`; native reasoning/Fast where supported,
  result handoff and exact native token receipts passed. Prime used a unique daemon
  socket. Hermes ACP receipt vs context-window distinction passed adapter fixtures.
  This is integration evidence, not model-quality or hundreds-of-agents evidence.
- Frontend production startup assets: 236117 bytes (previous repository ceiling
  266240). Run inspector code is deferred. WebView dev shell observed at 352 ms;
  execution-screen owned process-tree working set 889413632 bytes. This is one
  dev sample, not a production memory target or a benchmark claim.
- Release build and installed-artifact verification pending.
