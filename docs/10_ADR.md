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
shell stayed reachable at `?view=legacy` until parity and was removed after the
0.2.2 test release ([CLASSIC_PARITY.md](CLASSIC_PARITY.md)).

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

## ADR-032 — Plugins run outside the WebView with explicit trust

**Status:** Accepted and implemented as plugins v1 on 2026-09-27 (plan phase
8); plugin node steps are orchestration v6.5.

**Decision:** third-party plugins may contribute harnesses, node types, MCP
tools, commands, settings, renderers, panels, themes and templates. Backend
code runs in a host-owned contained process (like harness bridges); UI runs
only in sandboxed iframes or as declarative forms rendered by PiUI. Install is
an explicit trust decision with a permission list; safe mode disables plugins;
every renderer has a generic fallback. This supersedes the earlier "arbitrary
runtime-loaded JS is not a plugin API" rule for harnesses, not the isolation
principles of ADR-009/010/016.

**Implemented as (v1):**

- **Package format.** A folder or `.zip` with `piui-plugin.json` at its top
  (`contracts/piui-plugin-v1.schema.json`, `contracts/piui-plugin-v1.ts`).
  `crates/piui-plugins` is the authority; the UI mirror
  (`host-api/pluginManifest.ts`), the SDK check (`pnpm plugin:check`) and
  both test suites share `contracts/fixtures/plugins/`. Unknown fields and
  permissions are rejected, never dropped, and validation never runs plugin
  code. Limits: 20 MiB, 8 MiB per file, 2000 files, depth 16; no links,
  junctions, reserved Windows names or case-only duplicates; a `.zip` is read
  by PiUI's own reader (stored/deflate, CRC-checked, no ZIP64, encryption or
  symlinks). The code hash is SHA-256 over every file (path, NUL, length,
  content hash, sorted), shown in the review and re-checked at every start.
- **Trust and install.** The WebView never sends a path: `plugins_v1` `pick`
  opens the host's native picker, the host validates and stages the package
  under application data and returns a review — publisher, version, every
  permission in plain words, the exact backend command line, contributions
  and, for an update, added/removed permissions and whether the code changed.
  `install` names the reviewed staging id and code hash; the host copies
  exactly that package to `plugins-v1/packages/<uuid>` (never into a
  project) and records the hash, permissions and backend entry in a
  create-only registry generation with revision checks. An update is a new
  review. "Load unpacked…" runs a development folder in place: code changes
  load with Reload, a permission or backend change needs a new review. At
  start-up every package is verified off the first-paint path; a changed
  installed package, a changed development trust or an incompatible
  `engines.piui` leaves the plugin listed with its problem and inactive.
  Safe mode lists plugins read-only: nothing is active and every change is
  refused.
- **Backend.** An optional Node.js entry that the supervisor starts lazily
  (`node <entry>` from the package folder, Node resolved like the bridges),
  contained like scripts (Windows Job Object assigned before resume, or a
  process group), with an allowlisted environment (no API keys, tokens,
  `NODE_OPTIONS` or PiUI variables) and a private data folder. JSON-RPC 2.0
  over stdio with LF-only framing and 1 MiB frames
  (`contracts/plugin-backend-v1.ts`): `initialize` (15 s), `command/execute`
  (30 s), `node/run` (the node type's timeout), `settings/changed`,
  `shutdown` (2 s grace, then the tree is killed). A backend never sends
  requests in v1; any other frame is a protocol violation that stops it. A
  timeout stops it; a crash restarts on next use after 1, 2, 4 … 60 s, and
  five crashes in ten minutes stop it until the user restarts it. Disable,
  remove, reload and quit stop the whole tree. Logs are metadata only. In v1
  a backend had the user's file and network access; plugins v2 limits it
  with Node's permission model (below).
- **Panels and the CSP change.** A panel is the plugin's static `ui.entry`
  page served by the `piui-plugin` custom protocol
  (`http://piui-plugin.localhost/<id>/…` on Windows,
  `piui-plugin://localhost/<id>/…` elsewhere) from the entry's folder only,
  and framed with `sandbox="allow-scripts"`, so it has an opaque origin, no
  same-origin access, navigation, forms or popups. It has no Tauri API
  either: Tauri treats an app-registered protocol as a local origin, but it
  injects its IPC script and invoke key into the main frame only, and the
  panel policy forbids every connection (including `ipc.localhost`). The main
  frame must therefore never show the plugin origin: panels cannot navigate
  the top window and PiUI renders links as text. On Windows the host also
  refuses every main-frame navigation to that origin (WebView2 reports
  top-level navigations only); WebKit reports frame navigations to the
  same hook, so macOS and Linux need their own guard (plugins v2, below).
  The response
  carries a per-plugin policy (`default-src 'none'`; scripts, styles, images
  and fonts only from the plugin's UI folder; no connections, frames,
  workers, forms or base URI; `sandbox allow-scripts`), shared with the UI
  and E2E stand-ins through `contracts/fixtures/plugin-panel-csp.json`. The
  app policy changes only from `frame-src 'none'` to
  `frame-src http://piui-plugin.localhost piui-plugin:` — the two spellings of
  that one origin (WebView2 maps custom schemes to `http://<scheme>.localhost`)
  — so PiUI can frame plugin panels and nothing else; `script-src`,
  `connect-src` and `style-src` are unchanged. The frame talks to PiUI only
  through the bridge (`contracts/plugin-panel-v1.ts`): a `ready`/`init`
  handshake with a per-mount channel, messages checked for source window,
  channel, 64 KiB size, 20 requests per second, method, parameters and
  permission (`context.get` needs `chat.read`, `commands.run` `commands`,
  `settings.*` `ui.settings`, `notice.show` `notifications`). A panel that
  does not say `ready` within 10 s is replaced with a generic fallback.
- **Declarative contributions.** Commands (palette and composer; declared
  text or a backend command) prepare text in the chat's message box for
  review and never send it; the same registry projects the Tier 1A
  `piui.manifest.json` commands and composer actions of Pi packages in Pi
  chats. Settings are forms PiUI renders and validates like the host.
  Themes override only the documented color tokens with checked colors and
  WCAG contrast pairs, applied through the CSSOM while PiUI shows their
  appearance. Templates are portable system files (v4) checked at install
  and opened through the normal import as a new unsaved draft.
- **Node types (orchestration v6.5).** A `plugin` step executor
  (`pluginId`, `nodeType`, flat `config`) is host work like a script: no team
  member, no input mappings, the coordinator's lease and dispatch, admitted
  only in trusted, live projects outside safe mode while the plugin is
  active with `node.run` and the configuration passes the node type's
  fields. The backend receives the script stdin document plus the
  configuration and returns text or one JSON object, recorded exactly like a
  script's stdout. Codes: `plugin-unavailable`, `plugin-config-invalid`,
  `plugin-input-unavailable`, `plugin-start-failed` (nothing ran),
  `plugin-node-failed` (plugin message as detail), `plugin-node-timeout`; a
  backend lost mid-run leaves the step uncertain and it is never replayed.
- **ACP agents.** A plugin's ACP descriptors join Settings → Harnesses as
  `source: plugin` (`harness-registry-v1`, additive) and still need the
  user's exact command-line trust (ADR-034) before they run; an id another
  agent uses is not added, and the agent leaves with its plugin
  (`PLUGIN_OWNED`).

**Contracts:** new `plugins_v1`, `plugin_command_v1`, `plugin_template_v1`
and the `piui://plugins-v1` event (`contracts/plugins-v1.ts`); the backend
and panel protocols above; additive `harness-registry-v1` fields; the
orchestration v6.5 `plugin` executor, also accepted by system file v4.

**Not in v1:** MCP tool, renderer, status-item, keybinding and sidebar or
right-panel contributions; harness adapters other than ACP descriptors;
project-local plugins; backend requests to the host; signed packages or a
catalog; any enforcement of `network` or project-folder permissions.

**Plugins v2 (2026-09-27):**

- **Backends under Node's permission model.** Every backend starts as
  `node --permission --allow-fs-read=<package> --allow-fs-read=<data folder>
  --allow-fs-write=<data folder> [--allow-net] <entry>`. `project.read` adds
  `--allow-fs-read` and `project.write` also `--allow-fs-write` for the
  project folder of a request, exactly as the request spells it; a backend
  started for other projects restarts with the new folder added only while
  it is idle, and a busy one refuses the request before anything is sent.
  `--allow-child-process`, `--allow-worker`, `--allow-addons`,
  `--allow-wasi` and the inspector are never passed. `--allow-net` exists
  only in newer Node.js: PiUI probes the flags the Node.js in use accepts
  (`process.allowedNodeEnvironmentFlags`, cached per executable, never on
  the first-paint path) and, without `--allow-net`, the review says that an
  undeclared network access cannot be blocked. A Node.js without the
  permission model (older than 22.13) does not start backends at all
  (backend state `unsupported`). The review and Settings show the exact
  flags (the data folder is named before the review) and what is enforced;
  they also say that Node documents its model as a guard against mistakes,
  not against deliberately malicious code — plugins remain trusted code and
  PiUI still does not call this a sandbox. Verified with real Node.js
  22.17, 22.23 and 24.13 (reads, writes and `child_process` denied;
  `--allow-net` was not available to test). `plugins-v1` v1.1 (additive):
  `limits` on the backend and the review, state `unsupported`.
- **Manifest version 2.** `piui-plugin-v2.schema.json` / `piui-plugin-v2.ts`
  add `statusItems`, `keybindings` and `renderers` and the permissions
  `ui.status` and `ui.renderer`; the host validates each manifest with the
  schema of its declared version, so a v1 manifest keeps its exact meaning
  and cannot use v2 fields. One typed manifest serves both (v2 fields are
  empty for v1). New problem code `unknown-command`. `create-plugin` writes
  version 2.
- **Status items and keybindings.** Declarative only: static text (1–24
  characters) with an optional command, and `Mod(+Alt)?(+Shift)?+key`
  bindings for the plugin's own commands. `plugin_command_v1` accepts the
  origins `status` and `keybinding` only for a command a status item (with
  `ui.status`) or keybinding names. PiUI's own shortcuts
  (`PLUGIN_RESERVED_SHORTCUTS`, kept in step with the app by a test that
  scans its handlers) always win and a key two active plugins share runs
  neither; Settings shows every conflict instead of resolving it silently.
  A binding is not a manifest error even on a reserved key, because PiUI's
  shortcuts change between versions and must not deactivate an installed
  plugin. The status bar and the key handler load after first paint and
  appear only while an active plugin contributes something.
- **Chat renderers.** A renderer is the plugin's `ui.entry` page in the same
  sandboxed frame, policy and bridge as a panel (`plugin-panel-v1` v1.1,
  additive: `init.renderer`, the `activity` event and `frame.resize` with
  `ui.renderer`), shown inside an opened tool row whose native tool name it
  declares. The activity is bounded plain data (48 KiB of text, marked when
  cut), never markup; the frame gets no chat context. The generic view is
  always one click away and replaces the frame when the plugin is inactive,
  in safe mode, or when the frame is not ready within 10 s, so a chat stays
  readable without the plugin (AGENTS.md generic-fallback rule). The host
  serves the UI folder to `ui.renderer` as it does to `ui.panel`; the frame
  code is its own chunk, loaded only for an open matching row.
- **MCP tool servers.** `mcpServers` (permission `mcp.tools`) are Node.js
  stdio servers in the package. The person offers each one to new chats in
  Settings → Plugins (`plugins_v1` `setMcpOffered`, stored per plugin; off
  by default). At a runtime start the workspace host asks the plugin host
  only for an ordinary chat — no run, coordinator, tool allowlist or
  resource rules — of a harness that takes an MCP server for one session
  (`HarnessKind::accepts_session_mcp`: Claude Code via its session
  `--mcp-config`, Hermes and ACP agents via `mcpServers` of `session/new` and
  `session/load`). `NativeRuntimeConfig.plugin_mcp_servers` carries them;
  the runtime refuses them for any other harness, with the coordinator or an
  allowlist, and the Codex, Pi and Prime bridges refuse them too (Codex's
  dotted `mcp_servers.*` overrides were not verified to stay per thread in
  its shared app-server pool). The command line is Node with the backend's
  permission flags (the chat's folder only with a project permission in a
  trusted project) plus the entry and its arguments; without the permission
  model nothing is offered. Pipeline profiles are untouched, so delegation
  authority checks stay exact. Verified with the bridge fixtures and a real
  Node run of the example server under `--permission`; not verified against
  a real Claude Code, Hermes or ACP agent session (that needs a signed-in
  harness and model turns).
- **Downgrade.** A registry that stores a v2-only permission or an MCP offer
  cannot be read by PiUI 0.2.2 and earlier (they refuse unknown values);
  such a version starts with an empty plugin list and the installed copies
  stay on disk.
- **Plugin origin guard on every platform** (`navigation_guard.rs`). wry
  0.55 hands the navigation hook only a URL, and on WebKit it calls the hook
  for sub-frame navigations too (`decidePolicyForNavigationAction` and
  WebKitGTK `decide-policy` never look at the target frame), so the
  Windows-only refusal cannot move to macOS and Linux without breaking every
  panel. Instead, on all platforms: (1) a page load of the main document on
  the plugin origin is sent back to the last app page — wry reports page
  loads for the main frame only (WebView2 `NavigationCompleted`, WKWebView
  `didCommitNavigation`/`didFinishNavigation`, WebKitGTK `load-changed`), so
  frames are never touched, but it acts after the load started; (2) every
  app command refuses a call from a webview whose URL is on the plugin
  origin, which closes that window for PiUI's own commands; (3) every file
  the plugin protocol serves other than a panel page carries
  `Content-Security-Policy: sandbox`, so a file opened as a document of its
  own (an SVG, say) runs no script. Residual on macOS and Linux: during the
  moment before the redirect a top-level plugin page could still use the
  core event listener the default capability grants; closing it needs wry
  to report whether a navigation is for the main frame (or a native
  navigation delegate), and no path to such a navigation is known (links
  are text, panel frames cannot navigate the top window). Only the Windows
  build was compiled and run here; macOS and Linux need a build and a manual
  check that panels still load.

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

## ADR-036 — Session tools run git on the host with exact, confirmed changes

**Context:** ADR-026 made diff review and worktrees core chat features. They
need git in the user's project, which is a program PiUI executes in a trusted
folder, and they change user files: staging, reverting and deleting worktrees
must never lose more than the person saw.

**Decision:**

- **Git on the host, never in the WebView.** Three allowlisted, versioned
  commands (`workspace_review_v1`, `workspace_placement_v1`,
  `workspace_adopt_v1`) run git through one contained runner: PATH resolution
  without a shell, fixed argument vectors, literal pathspecs, repository hooks
  and fsmonitor off, no `GIT_*` redirection, bounded output and timeouts, the
  process tree in a Job Object or process group. Reads need the project's
  trust and work in safe mode; every change is refused in safe mode.
- **Exact changes.** A diff carries the SHA-256 of git's exact output; an
  action repeats it and replays exactly those bytes (or one hunk of them)
  through `git apply`. A change in between is refused, never merged.
- **Nothing is deleted without its preview.** Reverts show the lines that will
  be lost; untracked files go to the system trash through the platform layer
  (never a permanent delete; unsupported platforms refuse). Removing a
  worktree lists its uncommitted changes and needs an explicit acknowledgement
  of exactly those changes; its branch is never deleted.
- **Worktrees outside the project.** PiUI-managed worktrees live under app
  data on a new branch the person confirms (branch, folder and base commit);
  nothing is copied from the project folder. A worktree chat inherits the
  project's trust only while git confirms the same common git directory.
- **Placement beside the registry.** Worktree bindings, handoff links and
  adopted sessions are per-session sidecar files; the v11 session registry
  keeps its format. A damaged placement fails that chat's start closed.
- **Terminal sessions are adopted, not converted.** Continuing a terminal Pi
  session registers the same file with the classic admission checks, refuses
  recent writes and never passes a title Pi would write into the file.
  Handoffs between harnesses are a new chat with an editable draft built from
  visible text; no history is translated.

- **Parts and renames stay exact (v1.1).** A split hunk part is rebuilt by
  the host from the fingerprinted diff and applied with exact positions; a
  staged rename is one change applied as a whole. Orphan worktrees (all
  chats deleted) are removed from Settings → Worktrees under the same dirty
  confirmation; a worktree a chat still uses is removed from that chat.

**Consequences:** repository filters configured by the user still run during
reads. macOS cannot trash files yet. Concurrent terminal and PiUI writers
remain risk R-06; the adoption check catches active turns only. Worktrees
without a readable placement file are not managed. See
`docs/SESSION_TOOLS.md`.

## ADR-038 — Composer attachments stay host-owned and native-only

**Decision:** the chat composers send images to a harness only through its
own image input, keep attachment bytes in PiUI's application data, and never
copy a file into a project. Any other file is a path reference the person
confirms. The WebView never names a path for the host to read.

**Implemented as** composer inputs v1 (`workspace_composer_inputs_v1`) and
additive composer v19 fields. The host reads a file only when the person
picked it in the native dialog or dropped it on the window; for a drop the
host keeps the paths and gives the WebView a single-use id. Pasted bytes come
from the clipboard. Image type is sniffed from the bytes (PNG, JPEG, GIF,
WebP), bounded (5 MB, 6 per message), stored under `composer-attachments-v1`
until the message is delivered or removed, and deleted at startup when no
queued message needs it. A harness takes images only where its protocol does
(Codex input items, Claude Code content blocks, Pi RPC `images`, ACP
`promptCapabilities.image`) and the current model accepts them; otherwise the
send is refused before anything is queued and the paperclip explains why. A
bridge refuses an image it cannot deliver (`unsupported-input`) instead of
dropping it. Previews are decoded in memory and drawn on a canvas, so the
desktop CSP (`img-src 'self' asset:`) needs no `blob:`/`data:` source and the
asset protocol stays off. `@` lists names of a trusted project's files only
(no contents, `.gitignore` respected, links not followed). Native `/` commands
and `$` skills are text the harness interprets; PiUI never runs them.

## ADR-039 — Signed updates are compiled in but off until a release configures them

**Status:** Accepted 2026-09-27 (release 0.2.0; decisions delegated by the owner).

**Decision:** every build contains `tauri-plugin-updater`, but the host registers
it only when the build's Tauri configuration carries `plugins.updater` with a
minisign public key and one to eight HTTPS endpoints and no insecure or
downgrade switch. Release tooling adds that section (`scripts/release-config.mjs`)
only when the updater private key, public key and endpoint are all provided;
local and CI builds never have it. The WebView gets typed host commands
(app update v1) and no `updater:*` permission. Automatic checks are opt-in in
Settings → About (off by default), wait well past first paint, skip safe mode
and never install; an install names the exact version the person confirmed,
the plugin verifies its signature, and native runtimes stop as on quit first.
Releases stay GitHub pre-releases until Windows builds are code-signed, so the
feed (`latest.json`) lives on a rolling `updater` release instead of
`releases/latest`.

**Consequences:** a local-first build makes no update request unless the person
asks or opts in. A release without the key cannot update itself later. The feed
is unsigned; until the Tauri CLI records signed versions, `requireSignedVersion`
stays off and a tampered feed could replay an older signed build under a newer
number. Key handling, rotation and compromise response: `docs/RELEASING.md`.

## ADR-040 — Chat pipelines: a chat's message can start a saved pipeline

**Status:** Accepted 2026-09-28 (decisions delegated by the owner).

**Context:** runs started only from the editor, an automation or `/run`, and a
chat never showed them. The owner wants a chat to act as a pipeline's start,
per chat or by project default, and pipeline templates in and outside a
project, without crowding the composer further.

**Decision:**

- *Who answers* is one composer chip: a harness directly, a saved pipeline of
  the project, or (new chats) a template. Choosing a pipeline hides the model
  chip; project, permissions and worktree share one context chip.
- A pipeline accepts chat messages when it declares a text input named
  `message`, or has exactly one text input (templates' `task`). The message
  fills it; the run has the `chat` trigger with the chat's session id. Every
  step already receives run inputs as labelled, untrusted task data. The
  editor's Start block offers "Accept chat messages" (adds `message`) and
  "Start new chats of this project with this pipeline". New chats talk
  directly unless the project sets that default.
- The chat is an ordinary workspace session on the harness and model of the
  pipeline's answering step (the last final agent step), so follow-ups talk
  to that agent directly (owner's choice "b"). Run sessions stay closed to
  user messages. Only the first message goes through the pipeline; picking a
  pipeline again (or "Run again" on a run card) starts another run.
- A finished run's answer reaches the chat's agent only inside the person's
  next message, as a labelled `[PiUI pipeline result …]` block that the
  transcript shows collapsed. No native history is written or converted.
- Pipeline library v1 (`pipeline_library_v1`, `contracts/pipeline-library-v1.ts`)
  stores templates (`piui-system` documents, global or per project), the
  project chat default and each chat's run list, in generation files under
  app data. It is UI metadata: runs keep `trigger.sessionId`. Using a
  template opens it in the editor as a new draft; nothing is saved silently.

**Consequences:** orchestration v6, the system file format and workspace v15
are unchanged. The answering agent sees upstream results only through the
handed-on text, not as a verified native history reference; a pipeline whose
final step is a script continues on the composer's harness. Chat entries of
deleted chats stay in the library until a cleanup exists. Images cannot be
sent through a pipeline (run inputs are text).
