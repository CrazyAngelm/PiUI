# 09. Implementation Order and Engineering Tasks

## 1. Execution Rule

Implementation proceeds through vertically testable slices. You must not first build the entire attractive frontend and then “connect Pi.” The earliest working slice must open a real session, send a prompt, display streaming, and survive a process crash.

The first mandatory gate is the spikes from Phase 0. Their results may refine the transport, but do not invalidate the invariant: Pi remains the owner of agent/session semantics.

## 2. Workstreams

- **W0 Contracts:** schemas, DTOs, fixtures, compatibility.
- **W1 Runtime:** Rust supervisor, RPC codec, Pi adapter, process tree.
- **W2 Data:** project registry, scanner, SQLite index, attachments.
- **W3 UI:** shell, sidebar, timeline, composer, settings, accessibility.
- **W4 Extensions:** discovery, standard RPC UI, declarative SDK, sandbox.
- **W5 Platform/Release:** packaging, updater, diagnostics, performance/security matrices.

After Phase 0, workstreams may proceed in parallel through frozen contracts. A contract change requires a synchronized update of W0 and dependent fixtures.

## 3. Phase 0 — mandatory technical spikes

Each spike ends with a small executable harness, captured fixtures, and a decision note. A screenshot/oral description is not considered a result.

### SPIKE-01 — Opening an existing session without a ghost file

**Question:** how can RPC be started correctly and a specific Pi session opened without creating an extra empty session?

**Actions:**

- verify supported CLI startup arguments and `switch_session`;
- record the file list before/after each variant;
- test paths with spaces/Unicode;
- verify a new and an existing session;
- capture startup events/state.

**Pass:** deterministic procedure with stable session identity and no ghost file.

**Fail/decision:** design a minimal Pi bridge/upstream request; do not bypass this through direct JSONL writes.

### SPIKE-02 — Graceful shutdown and process tree

**Question:** how does the RPC process terminate the current session and descendants?

- EOF stdin;
- signal/terminate;
- documented shutdown command, if one exists;
- running/idle states;
- Unix process group and Windows Job Object;
- child tool process fixture.

**Output:** state diagram, timeout values, platform implementation test.

### SPIKE-03 — Tree navigation

**Question:** is it possible to navigate to an arbitrary existing tree node through an official RPC/SDK mechanism?

**Output:** supported command/capability or bridge API proposal. Until answered, the UI tree is read-only.

### SPIKE-04 — Provider auth

**Question:** can login/status/logout be implemented without a full terminal emulator?

- OAuth/provider interactive flows;
- API key flow;
- model refresh after auth;
- secret visibility/logging.

**Output:** selected MVP flow and a list of upstream gaps.

### SPIKE-05 — Extension UI Protocol parity

Create a Pi extension fixture that invokes every documented `ctx.ui` operation. Capture RPC events, cancellation, and unsupported APIs.

**Output:** golden event corpus + mapping table + timeout/cancel behavior.

### SPIKE-06 — Concurrent access

Open one session in the CLI and PiUI harness simultaneously, perform appends/turns, and study locking/state behavior.

**Output:** conflict detector criteria and safe UX. Multi-writer safety must not be assumed.

### SPIKE-07 — Managed Pi packaging

Package the Pi runtime as a Tauri sidecar/app-managed artifact on Windows/Linux test builds. First verify ready-made official standalone Pi release artifacts; then, only if necessary, use a reproducible Bun executable build from versioned upstream release source:

- asset inventory, target triples, and bundled runtime assets;
- upstream `SHA256SUMS`/provenance verification;
- executable naming/architecture;
- launch permissions, quarantine, and antivirus behavior;
- version/capability probe;
- signed PiUI runtime manifest;
- update/rollback layout;
- package size and cold-start/RSS overhead;
- identical reading of `~/.pi/agent` config/packages/sessions in managed and system modes.

**Output:** packaging ADR amendment, reproducible acquisition/build script, SBOM/provenance record, and test artifacts.

### SPIKE-08 — WebView baseline

Minimal Tauri+Svelte shell on reference machines:

- cold/warm startup;
- idle RSS/CPU;
- 10k virtualized blocks;
- iframe/worker isolation capability;
- platform rendering differences.

**Pass:** a realistic path to hard budgets. Otherwise, reconsider the UI stack before product implementation.

### SPIKE-09 — Session scanner compatibility

Run a real corpus of Pi sessions:

- format versions;
- partial lines;
- branches/custom entries/compaction/images;
- external appends;
- file roots/config resolution.

**Output:** parser fixtures and unsupported-state behavior.

### SPIKE-10 — Pi version/capability probe

Determine a reliable way to learn the executable version and available RPC commands, including unknown/new fields.

**Output:** initial `RuntimeCapabilities` contract.

## 4. Gate G0 — authorization for product development

G0 passes if:

- SPIKE-01/02 have a safe path;
- the RPC codec/fixtures are confirmed;
- auth has an honest MVP fallback;
- the scanner does not require writing session files;
- the Tauri baseline does not violate hard memory/startup budgets without a path forward;
- bridge gaps are formally described and bounded.

On failure, transport may move to an in-process Pi SDK adapter, but only after a new ADR analyzing isolation, extension loading, and packaging. Frontend contracts remain intact.

## 5. Phase 1 — foundation and contracts

### FOUNDATION-01 — Monorepo

Create the workspace layout from `03_ARCHITECTURE.md`, pinned toolchains, and formatting/lint/typecheck/test commands.

**Acceptance:** a clean clone runs all empty quality commands on Windows/Linux CI.

### CONTRACT-01 — Runtime protocol v1

Implement schema/source types for commands/events/errors/capabilities.

**Acceptance:** Rust↔TS compatibility tests and generated API docs.

### CONTRACT-02 — Fake Pi runtime

Scriptable binary with scenarios: stream, tool, UI request, malformed, hang, crash.

**Acceptance:** deterministic integration tests without network.

### RUNTIME-01 — LF JSONL codec

Chunk parser, max frame, correlation, unknown event.

**Acceptance:** unit/fuzz corpus, no panic/OOM.

### RUNTIME-02 — Supervisor skeleton

Spawn/ready/stop/crash state machine, stderr ring buffer, process group abstraction.

### UI-01 — Core shell

Window, design tokens, sidebar/main layout, error boundary, safe-mode boot state.

### UI-02 — Host API client

Generated typed bindings, reconnect/snapshot/revision handling.

### QUALITY-01 — Test/fixture harness

Vitest, Rust integration, Playwright/Tauri harness, performance result format.

## 6. Phase 2 — read-only projects and history

### PROJECT-01 — Registry

Add/remove/locate/reorder projects, canonical path handling, missing state.

### TRUST-01 — Restricted/trust flow

Trust record, literal warning, no runtime/project code before trust.

### DATA-01 — Session root resolution

Runtime/config probe, roots watcher setup, diagnostics.

### DATA-02 — Incremental scanner

Header/entries parser, partial tail, revisions, watcher coalescing.

### DATA-03 — SQLite projection

Migrations, projects, sessions index, rebuild command.

### UI-03 — Project/session sidebar

Loading/empty/missing/parse-state, recent sorting, new chat disabled in restricted mode.

### UI-04 — Read-only timeline

Normalized blocks, Markdown sanitizer, tool/custom generic cards, images, pagination.

### UI-05 — Timeline virtualization

10k-block fixture, scroll anchor, lazy code highlighting.

### SEARCH-01 — Session search

Name/preview search; FTS body can be deferred to public 1.0.

**Gate G1:** the user adds a folder, sees existing Pi sessions, and safely reads them without starting Pi.

## 7. Phase 3 — live Pi chat MVP

### RUNTIME-03 — Real Pi adapter

Managed/system/custom profiles, capability probe, open existing/new session.

### RUNTIME-04 — Command mapping

Prompt/steer/follow-up/abort/state/models/thinking/queue commands.

### RUNTIME-05 — Live normalization

Pi events → `SessionDelta`, revision/snapshot/idempotence.

### UI-06 — Composer

Draft, Send/Steer/Queue next/Stop, shortcuts, pending/error states.

### UI-07 — Streaming timeline

Batch 16–33 ms, interrupted blocks, autoscroll policy, screen-reader throttling.

### UI-08 — Model/thinking controls

Dynamic model list, recent models, capability-based thinking picker.

### DATA-04 — Draft persistence

Debounced drafts, rekey new session, optional disable.

### RECOVERY-01 — Runtime crash/reopen

Read-only recovery, no prompt repeat, force-stop escalation.

### SESSION-01 — New/open/rename

Only official Pi operations; pending confirmation; no fake session IDs.

### SESSION-02 — Tree/fork/clone

Enable only supported operations; read-only branch panel fallback.

### SESSION-03 — Export/trash

Pi export where supported, system trash, active-runtime close.

**Gate G2 (internal alpha):** real CLI session round-trip, streaming, stop/steer/follow-up, model switch, crash recovery, no JSONL writes.

## 8. Phase 4 — attachments and standard extensions

### ATTACH-01 — Images

Paste/drop/picker, MIME/size validation, preview, RPC encoding, model support error.

### ATTACH-02 — Project path references

Structured relative refs, composer chips, stable prompt convention.

### ATTACH-03 — External files

Reference original vs managed copy, hash/provenance/quota/cleanup.

### EXT-01 — Package discovery

Global/project package locations, manifest discovery as data, conflicts, trust.

### EXT-02 — Standard RPC UI dialogs

Select/confirm/input/editor/cancel/timeout/modal queue.

### EXT-03 — Standard status/widgets/title/editor effects

Native core surfaces and generic fallback.

### UI-09 — Commands palette/slash autocomplete

Core + `get_commands`, collision rules, keyboard navigation.

### SETTINGS-01 — Settings shell

General/runtime/models-auth/extensions/appearance/keybindings/security/advanced.

### AUTH-01 — Approved MVP auth flow

SPIKE-04 result, secret-safe diagnostics.

**Gate G3 (feature-complete MVP):** images/files, standard extension UX, settings/auth path, trust and recovery complete.

## 9. Phase 5 — declarative PiUI SDK

### SDK-01 — Manifest schema/parser

JSON Schema v1, path/engine validation, invalid/incompatible backend-only fallback.

### SDK-02 — Context expression engine

No eval, namespace/limits, tests.

### SDK-03 — UiNode schema/renderer

All v1 nodes, size/depth limits, sanitization, accessibility.

### SDK-04 — Commands/actions/status

Command broker, composer/status/context contributions, ordering/collisions.

### SDK-05 — Settings contribution

Schema controls, namespaced storage, secret references.

### SDK-06 — Tool/custom renderers

Matcher/priority/raw fallback/independent disable.

### SDK-07 — Sidebar/right-panel/preview/theme

Semantic slots, lifecycle, contrast validation.

### SDK-08 — Worker host

Isolated module worker, handler registry, permissions, timeout/crash loop.

### SDK-09 — Extension author tooling

Validate/dev/pack/inspect permissions, example packages, docs.

### SDK-10 — Compatibility suite

Previous fixtures, optional unknown contribution, API deprecation checks.

**Gate G4:** backend-only and dual Pi/PiUI packages demonstrably work; declarative v1 is frozen for public beta.

## 10. Phase 6 — rich views and trusted shell

### SANDBOX-01 — View broker

Opaque channel, handshake, request/response/subscriptions, lifecycle.

### SANDBOX-02 — CSP/origin/navigation policy

No direct Tauri, blocked links/download/popups, resource scheme.

### SANDBOX-03 — Permission broker

Once/project/global scopes, origin/resource checks, revoke/update invalidation.

### SANDBOX-04 — Network proxy

HTTPS origins, redirect/private-network policy, limits.

### SANDBOX-05 — Crash/rate/memory containment

Timeout, dispose/suspend, crash fallback and diagnostics.

### SHELL-01 — Trusted shell surface

Global-only activation, same broker, full application model, no raw host.

### SHELL-02 — Immutable recovery layer

Native safe-mode/startup modifier/menu, core fallback and crash-loop detection.

### SHELL-03 — Reference alternate shell

Minimal example proving complete layout replacement and recovery.

**Gate G5:** security tests confirm isolation; the shell cannot disable recovery.

## 11. Phase 7 — public 1.0 hardening

### PERF-01 — Instrumentation and baseline

Startup/RSS/CPU/stream/scroll/index harness, fixed physical-machine reports.

### PERF-02 — Optimization pass

Bundle audit, virtualization, memory leak cleanup, scanner throttling.

### A11Y-01 — Core accessibility audit

Keyboard, screen readers, zoom, contrast, reduced motion.

### SECURITY-01 — Threat-model verification

Fuzz corpus, capabilities audit, hostile content, grants, paths.

### SECURITY-02 — External review

Extension broker, updater, process/path boundary.

### RELEASE-01 — Windows packaging/signing/update

Installer, WebView2 policy, Job Object, upgrade/rollback.

### RELEASE-02 — Linux packaging/signing/update

Chosen formats, WebKitGTK matrix, Wayland/X11, process/trash/watch.

### RELEASE-03 — macOS candidate

Build/sign/notarize/test; release only if matrix green.

### RELEASE-04 — Managed Pi matrix

Pinned runtime artifact, hash, compatibility, rollback.

### DOCS-01 — User docs

Trust, runtime choice, projects/sessions, attachments, extensions, diagnostics.

### DOCS-02 — Developer SDK docs

Manifest, host API, examples, compatibility/versioning.

### QA-01 — Full release matrix

All gates from `08_TESTING_AND_PERFORMANCE.md`.

## 12. Do not include in the 1.0 critical path

The following initiatives receive separate extensions/ADRs after the core release:

- Git status/diff/review;
- worktree management;
- terminal emulator;
- file explorer/editor;
- subagent orchestration dashboard;
- plan mode;
- MCP management;
- SSH/remote Pi;
- cloud sync/account;
- extension marketplace;
- collaboration/team policies;
- mobile/web clients.

Core contracts must not block them, but implementation must not make 1.0 more complex.

## 13. Parallelization after G0

Recommended independent lanes:

- Agent A: `piui-runtime` + fake runtime + process lifecycle.
- Agent B: session scanner/index + fixtures.
- Agent C: Svelte shell/sidebar/read-only timeline.
- Agent D: contracts/generation/test harness.
- Agent E: trust/security/path policy.
- Agent F after stable normalized blocks: composer/live timeline.
- Agent G after manifest schema: declarative SDK.
- Agent H after host API permissions: sandboxed views.
- Platform agents: Windows and Linux packaging/tests from early phases, not at the end.

Merge dependency:

```text
G0 -> Contracts/Fake Runtime
   -> Runtime Adapter -> Live Chat -> Recovery
   -> Scanner/Index  -> Sidebar/History
   -> Trust/Path     -> Attachments/Extensions
   -> Manifest       -> Declarative SDK -> Sandbox -> Shell
   -> Perf harness across all phases
```

## 14. Coding agent task format

Each task must contain:

```text
Task ID:
Goal:
Relevant specs/contracts:
Allowed files/modules:
Dependencies/assumptions:
Required happy path:
Required failure path:
Tests/fixtures:
Performance/security constraints:
Out of scope:
Expected artifacts:
```

The agent must:

1. read `AGENTS.md` and related docs;
2. verify assumptions against fixtures/capabilities;
3. not expand scope implicitly;
4. add tests with the code;
5. report contract/ADR impact;
6. not replace unknown Pi behavior with direct JSONL editing.

## 15. Pull request gates

- linked Task ID and acceptance criteria;
- tests green;
- contract diff reviewed;
- no new unrestricted Tauri capability;
- performance report for hot path;
- Windows/Linux consideration;
- screenshots are only a supplement to semantic tests;
- docs/ADR updated;
- extension generic fallback verified where relevant;
- safe mode remains bootable.

## 16. Definition of product completion

PiUI 1.0 is complete not by the number of screens, but when:

- user history is unified with CLI Pi;
- the mandatory MVP workflow is resilient;
- an extension can add backend behavior and GUI without a core patch;
- complete trusted shell replacement is demonstrated by a reference package;
- Windows/Linux pass security/performance/recovery gates;
- absence of a UI extension does not break a Pi extension;
- known upstream gaps are either closed or honestly constrain the visible feature;
- the core remains minimal and does not include a second IDE.
