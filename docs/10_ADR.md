# 10. Architecture Decision Records

Baseline adoption date: July 23, 2026. All decisions have **Accepted** status unless explicitly stated otherwise. A change requires a new ADR, not a silent deviation in code.

---

## ADR-001 — PiUI is a shell over Pi, not a new harness

**Context:** Pi already owns providers, agent loop, tools, extensions, compaction, and sessions.

**Decision:** PiUI delegates all agent behavior to Pi and adds GUI/process/data adapters.

**Rejected:** its own model/provider layer; importing Pi sessions into a new format; forking Pi core within the UI.

**Consequences:** dependency on RPC/SDK capabilities and a need for honest fallbacks. In return, CLI/PiUI use one history and ecosystem.

**Reconsideration:** only if Pi stops providing a usable embedding/API and upstream collaboration is impossible.

---

## ADR-002 — Tauri 2 + Rust + Svelte 5

**Context:** Windows/Linux, a low footprint, TypeScript-friendly extension UI, and reliable process management are required.

**Decision:** Tauri host in Rust, Svelte 5 frontend, Vite static build.

**Rejected:** Electron (bundled Chromium/Node footprint), Flutter/Qt (worse web-extension fit), browser-only localhost app (lifecycle/security/distribution), native per-platform UIs (cost of parity).

**Consequences:** platform WebView differences become part of the test matrix; the Rust boundary requires typed contracts.

**Reconsideration:** if SPIKE-08 shows a hard budget/platform blocker that cannot be resolved.

---

## ADR-003 — Pi RPC is the primary runtime adapter

**Context:** RPC is officially intended for custom UIs and provides process isolation.

**Decision:** launch `pi --mode rpc`, read/write JSONL through the Rust supervisor.

**Rejected:** embed SDK in desktop host by default; screen-scraping TUI; pseudo-terminal automation.

**Consequences:** several TUI APIs are unavailable; PiUI SDK/bridge gaps are needed. A Pi crash does not have to crash the shell with it.

**Reconsideration:** if G0 discovers unresolvable startup/shutdown/session-selection problems. An SDK adapter is permitted behind the same interface after a separate ADR.

---

## ADR-004 — One process per live session, dormant history without a process

**Context:** a project can have hundreds of sessions; parallel turns require independent state.

**Decision:** a process slot only for active/running sessions, capped pool, and idle eviction.

**Rejected:** one global Pi process for the entire app; one process for every session in the sidebar; process per turn.

**Consequences:** supervisor complexity and resource budgets; good fault isolation and multi-session readiness.

**Reconsideration:** if Pi offers an official multi-session server with equivalent isolation/semantics.

---

## ADR-005 — Pi JSONL is the source of truth

**Context:** CLI and PiUI must continue the same sessions.

**Decision:** read JSONL for discovery/indexing, change active state only through Pi.

**Rejected:** import/export into a PiUI chat DB; direct editing of entries; copies of sessions as authoritative.

**Consequences:** the scanner must withstand external writes/format evolution. Deleting the PiUI DB is safe for history.

**Reconsideration:** not planned without changing the product philosophy.

---

## ADR-006 — SQLite only for registry/UI metadata/rebuildable index

**Context:** fast sidebar/search/drafts must not require starting Pi or fully parsing everything each time.

**Decision:** local SQLite, FTS optional; session projection rebuildable.

**Rejected:** JSON settings-only for all indexes; storing the full authoritative conversation; remote DB.

**Consequences:** migrations and a reindex flow, but fast queries and corruption isolation.

**Reconsideration:** if measurements show that the scanner without a DB satisfies every scale; the metadata DB will likely remain anyway.

---

## ADR-007 — Managed, system, and custom Pi runtime profiles

**Context:** the public app needs reproducibility; developers need current/forked Pi.

**Decision:** one adapter with three runtime modes; managed is recommended for public release. The managed runtime primarily uses an official standalone Pi release artifact with a verified checksum, or a reproducible build from versioned upstream source; the application does not run npm install/update.

**Rejected:** bundled runtime only; PATH only; npm install mutation by PiUI.

**Consequences:** compatibility probe, separate update/rollback, clear diagnostics.

**Reconsideration:** if Pi is distributed as a stable embeddable library/server with better lifecycle.

---

## ADR-008 — Frontend receives no direct shell/filesystem access

**Context:** WebView displays untrusted model/tool/extension content.

**Decision:** only allowlisted typed Tauri IPC; Rust validates paths/permissions.

**Rejected:** Tauri shell plugin exposed to UI; generic read/write/exec commands; Node integration.

**Consequences:** more host API work, substantially smaller attack surface.

**Reconsideration:** not planned; new capabilities are added through narrow APIs.

---

## ADR-009 — Four tiers of extensibility

**Context:** existing Pi extensions, a simple GUI extension path, and full interface replacement must all be supported simultaneously.

**Decision:** Tier 0 backend-only; Tier 1 declarative; Tier 2 sandboxed rich views; Tier 3 trusted global shell.

**Rejected:** arbitrary JS in the core DOM; requiring a UI manifest from every Pi extension; prohibiting full customization.

**Consequences:** a capability broker, schema/versioning, and safe mode are mandatory.

**Reconsideration:** tiers may be extended in a major SDK version, but isolation principles remain.

---

## ADR-010 — Semantic slots instead of coordinates/DOM selectors

**Context:** extensions must survive responsive layout and redesign.

**Decision:** the manifest specifies semantic contribution slot/order/when.

**Rejected:** CSS selectors, pixel coordinates, React/Svelte component injection into the core tree.

**Consequences:** not every experimental layout is possible in Tier 1; Tier 2/3 cover complex cases.

**Reconsideration:** slots are added compatibly based on usage, without exposing the internal DOM.

---

## ADR-011 — Generic fallback and raw inspectability are mandatory

**Context:** a session may contain entries from a disabled/incompatible extension.

**Decision:** every custom tool/message/view renderer falls back to a safe generic card; raw payload is available by action.

**Rejected:** hide unknown entries; error the whole timeline; hard dependency on renderer package.

**Consequences:** the session remains readable; the raw inspector must be protected and sensitive content redacted.

**Reconsideration:** not planned.

---

## ADR-012 — Generic files are passed as references, images through RPC

**Context:** Pi RPC directly supports image input, but has no general binary attachment abstraction.

**Decision:** images encoded through Pi RPC; project/external docs represented as explicit path/resource references, optional managed copy.

**Rejected:** read every file into the prompt; promise native PDF understanding; automatically copy into the repository.

**Consequences:** honest UX and small payloads; tools/extensions are responsible for reading/processing documents.

**Reconsideration:** when Pi provides a typed general attachment API.

---

## ADR-013 — Capability negotiation is more important than version checks

**Context:** Pi RPC evolves; forks/custom builds may have different features.

**Decision:** probe the runtime and expose named capabilities; version is used for diagnostics/known compatibility, not as the sole branch logic.

**Rejected:** `if version >= x` everywhere; optimistic UI with runtime errors.

**Consequences:** initial probe complexity, but forward/fork compatibility.

**Reconsideration:** if Pi introduces a stable formal capability endpoint — the adapter is simplified, while the principle remains.

---

## ADR-014 — Svelte/Vite without SvelteKit and without Tailwind in the core

**Context:** there are no SSR/web routes; a small, controlled design system is required.

**Decision:** Svelte 5 + Vite, CSS custom properties/scoped CSS, selective headless primitives.

**Rejected:** SvelteKit adapter-static without need; full component kit; utility DSL as a public extension contract.

**Consequences:** more custom component styles, less framework surface, and stable semantic tokens.

**Reconsideration:** only if an actual routing/build need justifies a framework layer.

---

## ADR-015 — Git, terminal, worktrees, and IDE features are outside the 1.0 core

**Context:** Codex App inspiration can easily turn PiUI into a heavy IDE.

**Decision:** the core is limited to projects/sessions/chat/runtime/extensions. Everything else is packages.

**Rejected:** embed diff/file explorer/terminal “immediately, since this is a coding app.”

**Consequences:** a minimal product; the Extension SDK must have enough slots/APIs for future features.

**Reconsideration:** after 1.0 based on usage, through a separate ADR and performance budget.

---

## ADR-016 — Safe mode and immutable recovery layer

**Context:** a trusted shell can completely alter the UI and can fail/be malicious.

**Decision:** host-owned startup shortcut/menu, core shell fallback, permission/integrity dialogs outside extension control.

**Rejected:** shell extension replaces the entire trusted app; recovery only through settings inside the shell.

**Consequences:** a small immutable host surface is mandatory even with “complete” UI replacement.

**Reconsideration:** not planned.

---

## ADR-017 — No remote telemetry/account/cloud backend in 1.0

**Context:** local-first tool, sensitive prompts/code/secrets, minimalism.

**Decision:** local structured logs and a user-exported diagnostic bundle; no automatic telemetry.

**Rejected:** default analytics/crash upload; required PiUI account; cloud sync.

**Consequences:** less production observability; high-quality local diagnostics and an opt-in future ADR are important.

**Reconsideration:** only with an explicit privacy model, user control, and a separate product decision.

---

## ADR-018 — Signed UI/runtime updates are separate

**Context:** PiUI and Pi can update at different cadences; runtime compatibility is critical.

**Decision:** signed desktop updater and separate signed managed Pi manifest/artifact with rollback; the manifest records upstream origin/version/hash, target, and compatibility range.

**Rejected:** silently run the latest PATH Pi; bundle runtime forever with the app; npm update on startup.

**Consequences:** release infrastructure is more complex, but reproducibility and rollback are better.

**Reconsideration:** if upstream provides a signed stable runtime channel/API that can be safely delegated.

---

## ADR-019 — Performance budgets are release gates

**Context:** “lightweight” cannot be guaranteed by an architectural slogan.

**Decision:** measure packaged builds on fixed hardware; hard budgets block release; PiUI and Pi memory are separated and totaled.

**Rejected:** bundle size only; dev-mode impressions; hide child processes.

**Consequences:** the performance harness evolves from early phases; dependency additions require cost awareness.

**Reconsideration:** budgets are calibrated only using documented evidence/reference hardware, not to make the current build pass.

---

## ADR-020 — Do not directly fork an existing desktop agent UI

**Context:** OpenCovibe/Hermes provide useful patterns, but have different session/runtime semantics and feature scope.

**Decision:** a clean PiUI repository; selectively port small licensed patterns/components with attribution and tests.

**Rejected:** fork Electron Hermes; relabel Codex UI; reuse another app’s session DB/protocol as the core.

**Consequences:** more initial work, less inherited complexity and semantic mismatch.

**Reconsideration:** if a project is found that already uses Pi RPC, has a compatible license/architecture, and confirmed quality budgets.

---

## ADR-021 — External ecosystem evidence is observational until PiUI-signed release policy is selected

**Context:** the public npm registry may provide SRI, registry signature, and SLSA source facts, but those facts apply to a specific upstream tarball and do not determine the PiUI runtime/channel policy.

**Decision:** PiUI may retain a limited, exact-byte, locally authored observed summary and verify its internal consistency offline. Until raw registry signature/key, Sigstore DSSE/certificate, and Rekor inclusion material are retained, this verification is structural rather than cryptographic upstream verification. Such a packet is always non-authorizing: the npm identity/key is not added to the production keyring and is not converted into a bundle, supervisor, or launch capability. Only a future PiUI-signed policy with signer roles, key roll/revocation, channel/sequence, acquisition, SBOM, and rollback can select independently authenticated external evidence as one of its inputs.

**Rejected:** use the npm key as a PiUI production key; treat `npm audit signatures` as a trust root; authorize a global install, archive, or executable by version/SRI/attestation; run npm from the runtime.

**Consequences:** the packet is useful as durable review input and a regression fixture, but does not close any Phase 0 or managed-runtime activation gate.

**Reconsideration:** only together with an approved signed release policy and handle-bound installation/launch design.

---

## ADR-022 — Cache-first catalog with incremental JSONL reconciliation

**Context:** synchronous full discovery blocked the sidebar for tens of seconds and repeatedly created parser/tree/timeline allocations for already known sessions. At the same time, Pi JSONL must remain the source of truth, and a stale catalog must not authorize mutation.

**Decision:** the sidebar receives the last-indexed SQLite catalog immediately through a versioned v7 snapshot. The host starts bounded per-project reconciliation separately: no-follow identity and metadata/prefix-tail evidence allow an unchanged source to be skipped; a changed source undergoes streaming LF metadata parsing and a strong full revision hash. The scanner commits one generation-stamped batch; deletion is permitted only after a complete sweep. The watcher sends the UI only an opaque lossy hint, not a path/event payload. The selected timeline and runtime admission use a separate strong identity-bound observation, not catalog freshness.

**Rejected:** block the list API on a full scan; treat mtime/tail hash as revision proof; store the authoritative transcript in SQLite; expose raw filesystem watcher events to the WebView; global refresh lock for all projects.

**Consequences:** the SQLite migration stores host-private fingerprint evidence; legacy rows are shown cache-first and backfilled during the next reconciliation. Cold rebuild remains read-only and bounded; a same-stat rewrite requires full integrity reconciliation/strong observation. IPC v7 has a snapshot watermark for recovery after missed/reordered events.

**Reconsideration:** if Pi provides official session-change/revision/lock capabilities with equivalent cross-platform semantics.


---

## ADR-023 — Native multi-harness workspaces and optional orchestration

**Status:** Accepted product direction on September 6, 2026; runtime activation remains conditional on version-specific evidence.

**Context:** The user explicitly requested Prime Agent and Codex as distinct native harnesses in normal project/session flows, configurable mixed-harness teams and pipelines, reusable commands, and a redesigned desktop UX. A model-provider switch is not a harness adapter. The previous Pi-only product scope cannot express that request.

**Decision:** Keep Tauri/Svelte and the thin-shell rule. Generalize workspace identity independently of immutable native session/member harness identity. Add explicit versioned native adapters for Prime Agent and Codex; preserve the existing Pi adapter and history. Native runtimes own model/provider clients, agent/tool loops, authentication, compaction, branching and transcripts. Any SDK bridge runs in an owned host-side process, never the WebView, and must pass lifecycle tests before activation. Do not assume shared Prime daemon ownership; an isolated non-default endpoint or a proven in-process SDK execution boundary is required.

Agent definitions, team topology, pipeline definitions, reusable launch commands and durable run state belong to a separate harness-neutral orchestration module. It schedules native work and checks spawn/send/read authority; it does not execute model tools or reproduce a harness agent loop. The optional desktop contribution is lazy-loaded and retains a plain session mode. Until generic rich extension views ship, the first-party contribution uses the same narrow host contract, with safe mode and immutable approval/recovery UI outside its control.

Native histories remain authoritative in their native formats. PiUI's index stays rebuildable. User-authored definitions, immutable run snapshots, delivery state and task journals are separately persisted application data, not cache and not a second chat transcript. A native session reference is opaque to the UI. Credentials, native paths and process handles stay host-private.

Permissions distinguish native-enforced, coordinator-enforced, advisory and unsupported. Unsupported mandatory requests fail before execution; prompt text/tool visibility is not an OS sandbox. Spawn hierarchy, messaging edges and observation permissions are separate policies. Delegation cannot widen authority. Recovery marks uncertain side effects for reconciliation rather than blindly replaying them. Closing a window, stopping a turn, stopping a run and stopping an owned runtime are separate operations.

**Supersedes narrowly:** the Pi-only routing wording of ADR-001/003/005, the exclusion of first-party optional team/pipeline surfaces in ADR-015, and the assumption in ADR-006 that every PiUI-owned datum is rebuildable. All no-loop/no-provider, trust, source-of-truth, containment and extension-isolation invariants remain in force. Existing v1-v10 wire formats remain frozen; new contracts require compatibility fixtures.

**Rejected:** putting an agent loop in Svelte/Rust; a privileged mandatory Prime/DSH parent for all harnesses; treating Codex-in-Prime model selection as Codex execution; converting Codex history to Pi JSONL; enabling Prime by removing its guard before evidence; shell strings or credentials in frontend contracts; advertising advisory file/message policies as hard isolation.

**Proof required:** isolated native Prime and Codex lifecycle/protocol evidence; normal create/send/stop/reopen/approval flows; independently active sessions; mixed-harness delegation and denied routing; persisted definition/run recovery; keyboard/safe-mode/generic fallbacks; Windows native E2E plus Linux platform evidence where available; startup/rendering/RSS smoke without invented performance claims.


**Implemented lifecycle semantics (workspace v11):** A native ID or reserved path is not persistence proof. Only a known-absent, never-materialized empty draft may reopen through a fresh native session while keeping its opaque PiUI identity. Existing, corrupt, inaccessible or previously materialized history must not become an empty replacement. Materialization truth is monotonic; native history remains authoritative. Cached observed model metadata is display state, not an ordinary-open override; explicit create/profile configuration stays explicit. Graceful close requires both the native disposal acknowledgement and owned containment cleanup. UI error recovery reconciles host state while retaining the failure warning, never fabricating a successful acknowledgement.


## ADR-024 — Shared native Codex transport and orchestration v2

**Status:** Accepted and implemented September 6, 2026, following the user's
explicit request for Rust-backed multi-agent execution and customizable prompts.

**Decision:** Managed Codex sessions in the same canonical workspace and Codex
home share an owned Rust app-server. Native threads retain separate adapters,
request IDs, event streams and approvals. Control admission is serialized after
an observed native overload response; model turns remain concurrent. Normal
session retirement interrupts its active turn, unsubscribes its thread and
leaves other sessions alive. A shared native failure invalidates all owners;
emergency trust/protocol retirement terminates the contained workspace process.
Prime remains a separate native SDK adapter. No global CLI installation changes.

Profiles may replace the Codex base prompt, including empty text, independently
of additive instructions. This does not remove project/tool/permission context.
Dynamic spawning may only select an already authorized snapshotted profile.
The original launch graph is retained separately from its evolving effective
graph. New agents get parent messaging by default; team-wide messaging requires
an explicit saved option. Event-driven wait requires observation permission and
returns the child's native result. No new provider client or agent loop is added.

Orchestration commands/events and run schema are v2. Version-one runs migrate
on read; absent options preserve native prompts and parent-only communication.
The existing storage directory/envelope remain stable. Historical native
transcripts are neither deleted nor converted. The Legacy history navigation
and alternate page are removed at the user's request; the classic development
compatibility entry remains outside normal navigation.

**Evidence and limits:** See [research and runtime evidence](AGENT_SYSTEM_REVIEW.md).
The local 200-request test is transport evidence, not a production throughput
or model-quality guarantee. No public fork was verified as the author's paid
fork. Arbitrary channels and model-authored security profiles are outside the
implemented surface; Linux lifecycle remains unverified.

## ADR-025 — One graph, adapter-owned capabilities and monotonic delegation

Accepted 2026-09-06. The Systems view edits profiles, a team, a dependency DAG and
its saved launch reference in one place. Result edges order tasks and deliver
native result references. Messaging, observation and delegation are separate
permissions; a message cycle does not imply an execution cycle. Profiles retain
native harness selection, so a result edge can connect Codex and Prime.

Orchestration IPC/run schema is v3. The host saves graph definitions in one
revision-checked durable transaction. v1/v2 recorded runs migrate in memory to
v3 without rewriting native histories. Existing advanced definitions remain
editable using their original editors; the graph refuses shapes it cannot
round-trip rather than losing assignments or external child templates.

Reasoning, explicit Standard/Fast and resource overrides are snapshotted per
profile and forwarded to the native launch adapter. Codex Standard sends native
`default`, avoiding inheritance of a global Fast setting. Codex skills use native
`skills.config`; MCP overrides use the configured server's `enabled` field.
Prime skill filtering uses the SDK resource loader. Prime MCP isolation and
Codex arbitrary strict tool allowlists remain unsupported and fail closed.
Resource availability is not OS confinement.

The coordinator rejects children with higher file privileges, removed denials,
wider native tool allowlists, removed disabled resources, or wider child-profile
grants. Same-harness native defaults are comparable; cross-harness defaults are
not. This applies to dynamic profile spawns and predefined controlled spawns.

Sources and represented patterns:
- AutoGen Teams: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
  Round-robin, selector and handoff teams differ in who selects the next speaker.
- LangGraph Swarm: https://github.com/langchain-ai/langgraph-swarm-py
  Handoff is an explicit transfer of control, not just a dependency edge.
- Codex speed: https://learn.chatgpt.com/docs/agent-configuration/speed
- Codex configuration schema: https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json
- Video analysis and timestamps remain in AGENT_SYSTEM_REVIEW.md.

The implemented presets are sequential tasks, parallel independent tasks,
workers followed by a supervisor, and peer messaging. They configure actual
edges, not labels that change hidden scheduler behavior. Autonomous selector
loops, dynamic channels/groups, durable handoff and persistent round-robin teams
are not represented as completed features. Implementing them requires explicit
native event/lifecycle contracts and termination semantics, not another LLM loop
inside PiUI. No arbitrary round or agent cap is introduced.

English/Russian selection is local UI metadata, defaults to English and survives
restart. User text and native outputs retain their original language. Layout
positions are also rebuildable local UI metadata, separate from durable tasks.

---

## ADR-026 — PiUI is a workbench for agent harnesses and multi-agent pipelines

**Status:** Accepted 2026-09-26 (owner delegated product decisions; see
`docs/PLAN_2026-09-26_RU.md`).

**Decision:** PiUI is the everyday desktop workbench for native agent harnesses
(Codex, Claude Code, Pi, Hermes, Prime Agent and ACP agents) and the place to
design, run and observe multi-agent pipelines. It is no longer "a minimal shell on
top of Pi". The core invariants stay: harnesses own inference, tools,
credentials and history; PiUI never adds a provider client or its own agent
loop; no general shell/filesystem API in the WebView; explicit project trust;
safe mode; generic fallbacks.

**Consequences:** product docs, README and AGENTS.md describe the multi-harness
workbench. Features are still evaluated as "could this be a plugin?", but the
chat workbench (diff review, worktrees, inbox) and the pipeline editor are core.

## ADR-027 — UI stack: Svelte 5 runes, headless primitives, Svelte Flow

**Decision:** new UI code uses Svelte 5 runes, the shared design tokens and the
primitives in `src/lib/ui` (built on bits-ui, MIT), Lucide icons (ISC) bundled
locally, and Svelte Flow (MIT) with dagre for graph editing. No Tailwind or
utility-class DSL (ADR-014 stands). The first-paint asset budget is measured in
gzip (the WebView loads local files); raw bytes are still reported.

**Consequences:** legacy components migrate as screens are rebuilt; the previous
shell stays reachable at `?view=legacy` until parity and then is removed.

## ADR-028 — Open harness registry and version ranges

**Decision:** a harness id is a string validated by a host-side registry of
descriptors (transport, discovery, version range, capability manifest, policy
table, history format). Closed enums across Rust/TS contracts are replaced by
registry lookups. Harness versions are accepted by tested ranges with capability
checks at start and explicit degradation instead of exact pins. A generic ACP
adapter covers ACP agents; richer native adapters remain for Pi, Codex, Prime,
Hermes and Claude Code.

## ADR-029 — Claude Code runs only on the user's Claude subscription

**Decision (owner requirement):** the Claude Code adapter drives the user's own
installed, unmodified `claude` executable in headless stream-json mode with the
control protocol. PiUI scrubs API-key and cloud-provider variables from the
child environment, never passes `--bare`, and refuses sessions whose reported
auth is not the first-party subscription login. Sign-in happens only in Claude
Code's own flow; PiUI never reads, copies or stores credentials. Pipeline agents
on Claude Code run under the same subscription.

**Consequences (2026-09-26):** paid extra usage is never used either: fast mode
is unsupported (refused before launch, pinned off per session with
`CLAUDE_CODE_DISABLE_FAST_MODE=1` and an inline `--settings` layer) and a session
that reports extra-usage billing is stopped. A refused login is the typed
`SIGN_IN_REQUIRED` status with fixed guidance to run `claude` and `/login`. The
host accepts Claude Code by version range (`>=2.1.0 <3.0.0`) and adds
`claude-code` as an additive harness identity (ADR-028).

## ADR-030 — Pipeline document v5 (planned)

**Decision:** the pipeline becomes a first-class stored document (nodes, edges,
inputs, triggers, positions, limits) with migration from system-file v1–v4.
The node catalog adds one-shot LLM calls through the harness, scripts, loops
with explicit limits, map/fan-out, merge, sub-pipelines and human input. Data
mapping uses a small expression language evaluated in Rust without `eval`.
Until then the Svelte Flow editor edits the existing agent-graph model.

**Status (orchestration v6.2):** the first two node kinds ship ahead of the
document as an additive step `executor` on the existing graph. An `llm` step is
exactly one native turn of its profile through the harness adapter (no PiUI
provider client): no follow-up, no messages, observation or delegation, a
read-only, network-denied profile without allowed tools or enabled resources,
and an empty native tool allowlist where the adapter enforces one. Where it
cannot (Codex), the read-only sandbox is the only boundary and the manifest
says so; harnesses without a read-only mode refuse the step. Scripts: ADR-033.
An existing node changes between agent, model call and script in the editor
(one undo step): it keeps its id, name, position, result/route connections,
result fields, condition, review and approval; what the new type cannot keep
(messages, observation, delegation, on-call mode, input mappings for a script,
least-authority profile changes) and data it discards (code, task/prompt,
instructions, harness and model) are listed and confirmed first.

## ADR-031 — Transactional orchestration storage (planned)

**Decision:** orchestration definitions and runs move from whole-document JSON
rewrites under one mutex to a transactional store (SQLite WAL) with per-run
locking, run archival/deletion and incremental run events. This data is
authoritative, not cache (ADR-006/023 distinction kept).

**Status:** run archival and deletion ship ahead of the new store on the
existing journal (run debugging v1, ADR-035); each is one journal generation.

## ADR-032 — Plugins run outside the WebView with explicit trust (planned)

**Decision:** third-party plugins may contribute harnesses, node types, MCP
tools, commands, settings, renderers, panels, themes and templates. Backend
code runs in a host-owned contained process (like harness bridges); UI runs
only in sandboxed iframes or as declarative forms rendered by PiUI. Install is
an explicit trust decision with a permission list; safe mode disables plugins;
every renderer has a generic fallback. This supersedes the earlier "arbitrary
runtime-loaded JS is not a plugin API" rule for harnesses, not the isolation
principles of ADR-009/010/016.

## ADR-033 — Script nodes are trusted user code (orchestration v6.2)

**Decision:** script nodes (Node/TS, Python, shell) run in the project folder
under process containment with timeouts, only after an explicit trust decision
for the pipeline. Importing a pipeline never runs code. Script nodes are not a
sandbox and the UI says so.

**Implemented as** the `script` step executor (runtimes `node`, `python`,
`powershell`; source at most 64 KiB, frozen in the run snapshot; timeout
1–3600 s). The trust decision is the project's trust plus an explicit Save and
Run: the host admits scripts only for trusted, live projects outside safe mode
and re-checks while one runs. The host — never a harness or the WebView —
resolves the interpreter (Node as the bridges do, honouring `PIUI_NODE`;
`py -3`/`python3`; Windows PowerShell/`pwsh`), writes the source to a fresh
private folder under application data, runs it with the project as working
directory, a minimal allowlisted environment and one JSON document on stdin,
and contains the tree (Job Object assigned before resume, or a process group)
so the end, a timeout, a cancellation, shutdown or lost trust kills it.
Outputs are bounded (stdout 256 KiB, stderr tail 64 KiB, failure detail 2 KiB)
and never logged. Scripts use the coordinator's lease/dispatch machinery;
restart marks a started script uncertain and never replays it.

**Test script (script test v1).** The editor can run one script node's current
draft once, without a pipeline run, when the person clicks Test: an explicit
action with the same admission (trusted, live project outside safe mode,
re-checked every 500 ms), the same runner, containment, environment, timeout,
bounds and result checks, and a user-editable sample stdin (default: the run
inputs' defaults, each direct dependency's pinned data (ADR-035) or
`{text: null, data: null}`, and the step). The result shows exactly what a run would record. Nothing is
recorded in a run, cancellation stops the tree, and the command can only name a
script runtime, so it never starts an agent or a paid model call. This grants
no authority a saved script step lacks: whoever can edit a trusted project's
pipeline can already save and run it.

**Code editor.** Script code is edited with CodeMirror 6, loaded only when a
script is shown (never in the main bundle). The desktop CSP allows
`style-src 'self'` only; CodeMirror's style-mod writes a `<style>` element into
a document, which that policy refuses, but uses constructable stylesheets in a
shadow root, so the editor always mounts in its own shadow root. If it cannot
load, the plain text field remains.

## ADR-034 — ACP agents from descriptors, trusted by exact command line

**Context:** ADR-028 opened the harness registry and promised a generic Agent
Client Protocol adapter. Agents such as Gemini CLI speak ACP over stdio, so one
bridge can drive all of them without code in core, but a descriptor is a
command PiUI will execute, and agents keep their own tools and credentials.

**Decision:** an ACP agent is data: a versioned JSON descriptor
(`contracts/acp-agent-descriptor-v1.schema.json`) with a slug `id`, a display
name, the `program` (a file name on PATH or an absolute path) with fixed `args`
(never a shell string), version `args` with an optional pattern and tested
range (`minimum <= v < ceiling`), environment variable **names**, a sign-in
hint, a docs link and restriction-only capability overrides. Its harness
identity is `acp:<id>` (identity grammar v2, additive in workspace v15,
orchestration v6.3 and system files v4; v1–v3 files stay closed). PiUI ships a
Gemini CLI descriptor; users add theirs in Settings → Harnesses. One bridge
(`bridge/acp.mjs`) speaks ACP v1 for every agent.

- **Trust:** a user descriptor never runs, not even `--version`, until the user
  trusts the exact resolved command line (program and each argument after PATH
  and npm/pnpm shim resolution) in a review that says trust is not a sandbox.
  Trust, version confirmations and secret choices bind to the descriptor
  fingerprint (SHA-256 of the canonical JSON); any change needs a new review.
  Shipped descriptors are trusted by PiUI.
- **No shell:** absolute PATH entries only; Windows `.exe`/`.com`, npm/pnpm
  `.cmd` shims parsed to `node <script>`, `.js`/`.mjs`/`.cjs` through Node; any
  other batch or PowerShell launcher is refused.
- **Versions:** the probe runs contained (Job Object before resume or a
  process group) with the base environment, bounded output and a 20 s timeout;
  results are cached per program identity. Older than the tested range is
  unsupported; newer or without a range needs an explicit confirmation of that
  exact version.
- **Environment:** bridge and agent start from a cleared environment: fixed
  locations, locale and PATH plus the descriptor's names. Secret-like names
  (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH, COOKIE, SESSION, PRIVATE)
  pass only after a per-name confirmation; loader, Node and `PIUI_*` variables
  are refused. Values are never read, stored or shown by PiUI.
- **Sign-in:** PiUI never authenticates. `auth_required` becomes the typed
  `ACP_SIGN_IN_REQUIRED` status with the agent's advertised method names.
- **Storage and discovery:** the registry is create-only generations under app
  data with revision checks; a failed validation stores nothing. Discovery runs
  once in the background after start-up (never in safe mode, never on the
  first-paint path) and on "Check again"; `harness_registry_v1` and its event
  carry the result to the UI.
- **Protocol mapping:** `initialize` with fs/terminal client capabilities off;
  `session/new` (cwd, no MCP servers except PiUI's coordinator as a loopback
  HTTP MCP server when the agent supports it; otherwise coordinated runs are
  refused); `session/load` only when advertised; updates map to timeline blocks
  with a generic fallback; permission requests become approvals with the
  agent's own options; `session/cancel`; model, mode and reasoning from config
  options before the legacy `set_model`/`set_mode`. Instructions go with the
  first prompt. A crash mid-turn leaves the outcome uncertain.

**Consequences:** ACP agents keep their own tools, permissions and MCP
servers: PiUI offers native permissions only and no tool, resource, speed or
network settings, and delegation across different harnesses stays rejected
because native defaults are incomparable. Dependency results of a closed ACP
chat come from its own `session/load` replay, verified by content hash. Model
pickers offer "Agent default" plus the models an earlier session advertised;
no probe conversation is started. Gemini CLI has no tested range until a
release is verified with real turns, so every version needs the user's
confirmation.

## ADR-035 — Run debugging: pinned data, debug in editor, archive and delete (orchestration v6.4)

**Decision:** pinned data is saved definition data, not a run cache. A
pipeline step may hold a person's pinned output (text and/or a result, 256 KiB
each, 1 MiB per pipeline), usually pinned from a finished run by the host,
which reads the recorded output itself (hash-verified native history or the run
record) and writes it at the pipeline revision the person saw. A run uses pins
only when the person starts it with the explicit *Use pinned data* option; the
coordinator then admits each ready pinned step as succeeded with its pinned
output, checked against its result contract, before any launch, and marks the
task `pinned`. Downstream steps receive it through the recorded-output
dependency path. Without the option a run freezes no pins; asking for pinned
data on a pipeline without pins is refused rather than running every step.
Pins never apply to callable roles, program routers or reviewing steps, and a
review whose correction step is pinned waits for a person instead of looping.
Portable system files never carry pins (they are copies of run results).

*Debug in editor* opens a run's original definitions as a new unsaved draft
with new ids (saving creates a copy; the saved pipeline is never changed) and
the outputs the person checks as pins. Archiving a finished run is UI metadata
beside the runs. Deleting a finished run removes only PiUI's records — its
journal entry and script working copies verified as plain direct children of
PiUI's script folder, never following links or reparse points — never native
sessions or project files; running and uncertain runs are refused and safe
mode is read-only. Additive within orchestration v6 (v6.4) plus the
independent run debugging v1 commands. See [RUN_DEBUGGING.md](RUN_DEBUGGING.md).
