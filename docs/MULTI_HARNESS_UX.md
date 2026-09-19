# Multi-harness desktop UX

## Contract and status

Design the authorized PiUI redesign without implementing UI on unproven runtime behavior. The result must specify ordinary Pi, Prime Agent and Codex sessions; an optional Agents/Teams/Pipelines/Runs workspace; shared approvals and activity; mixed-harness identity; profile and relationship editing; and a concrete Svelte execution and verification plan.

**Status: target UX specification, not a claim of implemented capabilities.** This document follows [the implementation contract](MULTI_HARNESS_IMPLEMENTATION.md) and **ADR-023** in [10_ADR.md](10_ADR.md). It updates the target interaction model in [02_UX.md](02_UX.md) only where multi-harness identity and optional orchestration require it. Existing safety, native-history, keyboard and performance rules still apply.

- Keep Tauri 2, Svelte 5, strict TypeScript and component-scoped CSS with semantic custom properties. No React, Tailwind, Electron, SSR or new UI framework.
- Native harnesses own model/tool loops, authentication, compaction, branching and transcripts. A model hosted inside Prime is not a native Codex session.
- The host-owned orchestration module may schedule native work and route permitted messages under ADR-023. The WebView never implements a scheduler, agent loop or tool runner.
- Ordinary chat remains the default. The workspace is an optional, lazy-loaded first-party contribution with a narrow host contract. Core approvals, provenance, recovery and generic history remain outside its control.
- A control becomes executable only when the owning adapter and host use case are verified. Unknown capability is not permission. Do not remove the Prime live guard merely to populate a new screen.
- The original design slice changed only this document. The later editor-only implementation handoff below records its narrower shipped surface. Neither design nor editor code activates an unproven native runtime.

## 1. What the current app establishes

### Source audit

The existing UI is already a useful foundation, not a disposable mockup. Retain its document-style assistant messages, single history scroller, bounded generic projection, collapsed activity groups, cache-first session list, searchable model picker, local appearance settings and explicit trust copy.

| Observed source | Design consequence |
|---|---|
| `app/App.svelte` composes the sidebar, history, composer, settings and dialogs. Project creation requires one `agentKind`. | Move harness choice from folder identity to a new session/profile. Extract screen composition as new routes are added; do not rewrite established history logic just for visual consistency. |
| `features/projects/ProjectSidebar.svelte` shows personal Chats and one expanded project's sessions. Only Prime projects have a harness mark. | Keep the familiar project tree. Add immutable session-origin labels and harness-aware filtering without three copies of the same project. |
| `features/runtime/ChatPanel.svelte` owns live RPC state and calls `teardown(true)` when destroyed. `App.svelte` keys it by navigation epochs. | Background execution surviving navigation is **not currently established**. Host-owned lifecycle and resident-session evidence are prerequisites; moving CSS cannot satisfy them. |
| `Timeline.svelte`, `ActivityGroup.svelte` and `MarkdownContent.svelte` share safe projected blocks. Unknown events remain readable. | Reuse these surfaces for all native adapters. A common display projection is not a new persisted transcript format. |
| `styles/tokens.css` tints most surfaces green. Several components hardcode hover/danger colors. Many secondary labels use very small uppercase text. | Neutralize the surfaces, keep sage as a restrained action accent, move semantic colors into tokens, and raise information hierarchy through readable type rather than uppercase microcopy. |
| `SettingsView.svelte` repeats large page/section headings and substantial vertical padding; `EmptyState.svelte` uses display-sized headings. | Use compact desktop section headings and task-specific empty states. No welcome hero or showcase dashboard. |
| `App.svelte` hides the sidebar at its narrow breakpoint without rendering a corresponding visible drawer trigger. | A narrow window must retain a named navigation button. Do not make Settings, Approvals or project switching disappear. |
| Dialog behavior is duplicated across trust, project settings, commands and extension requests. | Consolidate tested focus behavior in a small native-dialog wrapper while keeping security-owned request content separate from extension content. |
| `RuntimeBar.svelte` and `FakeScenarioComposer.svelte` are development fixtures; `PrimeActivityPanel.svelte` is not proof of live Prime support. | Do not expose fake-runtime controls, synthetic activities or fixture metrics in product screens. |

The redesign skill's scan and targeted-upgrade approach applies. Its marketing prescriptions do not: no font downloads, stock imagery, grain overlay, glassmorphism, oversized headlines, scroll hijacking, animated gradients or perpetual motion. Keep the installed system-font stack and handwritten SVG vocabulary unless a measured accessibility problem requires a change.

### Runtime evidence boundary

At the audited v10 baseline:

| Lane | Observed UI/host boundary | What the redesign must not imply |
|---|---|---|
| Pi | Read-only native history plus an explicitly invoked local live preview. Managed/public-release gates remain open. | Browsing starts a process; the preview proves managed runtime readiness; concurrent writers are safe. |
| Prime Agent | Root history and separate global extension inventory. Production live control is fail-closed for the previously tested shared-daemon model. The new 0.9.2 spike is separate work. | An existing activity type or installed newer version proves isolated create/send/stop/reopen. |
| Codex | No native lane in the audited frontend contract. Its app-server spike is separate work. | Codex is interchangeable with Pi RPC, uses Pi JSONL or shares Prime's authentication/configuration. |

[12_OPEN_RISKS.md](12_OPEN_RISKS.md), [13_FOUNDATION_STATUS.md](13_FOUNDATION_STATUS.md) and [PHASE0_GATE.md](../spikes/PHASE0_GATE.md) remain evidence sources. Attach the new native probe results to the implementation contract before implementation uses them. An unavailable Linux test environment stays an explicit verification blocker.

## 2. User-facing domain model

| Term | Meaning in the interface | Never means |
|---|---|---|
| Project | One registered working folder with host-validated identity and a display name. | A Pi/Prime/Codex installation or three duplicate folder records. |
| Harness | Pi, Prime Agent or Codex, shown by name. | Provider/model choice, theme or execution permission. |
| Session | A native conversation with an immutable harness/source reference. | A stitched conversation made by converting another harness's history. |
| Agent profile | A saved, versioned definition of how an agent should start: harness, model, instructions and supported policies. The navigation label is **Agents**; the create action is **Create profile**. | A running process, human account or already-spawned child. |
| Team | Named member slots referencing profiles, with separate message, observation and spawn policies. | An implicit all-to-all network or a cloud collaboration account. |
| Pipeline | A saved task/dependency definition executed by the host coordinator using native sessions. | A frontend prompt loop or a session branch tree. |
| Run | One execution with an immutable definition snapshot, task/delivery journal and links to native sessions. | Another copy of every conversation or an inferred success based on silence. |
| Approval | A native runtime request requiring a supported user decision. The shared inbox also includes clearly labelled extension questions. | PiUI claiming to enforce every model action or translating every `confirm` into a security permission. |
| Workspace | The optional management view for agents, teams, pipelines and runs in the selected project scope. | A replacement for project identity or a prerequisite to send a normal prompt. |

Native transcripts remain authoritative. Catalogs and render projections are rebuildable. Per ADR-023, user-authored definitions, immutable run snapshots and task/delivery journals are separate durable application data, **not index cache**. Rebuilding the session index must not delete them. Display drafts, panel state and filter preferences are UI metadata. Native paths, handles and credentials remain host-private; the UI receives only approved display labels and opaque references.

## 3. Information architecture

### Ordinary Sessions view

The visible mode switch uses **Sessions / Workspace**. It changes navigation, not the selected harness, process state or project trust. Sessions opens on first use and remains sufficient for ordinary work.

```text
+------------------------+----------------------------------------------+
| Settings               | [Navigation/context row only when needed]   |
| New chat               |                                              |
| Add project            | Native session timeline                      |
| Search                 |                                              |
| View: Sessions v       | Assistant content reads as a document.       |
|                        | Tools and thinking use compact disclosures.  |
| Chats                  |                                              |
|   <personal session> Pi|                                              |
| Projects               |                                              |
| v <project>            |                                              |
|   <session>         Pi |                                              |
|   <session>      Prime |                                              |
|   <session>      Codex |----------------------------------------------|
|                        | <current harness> · <actual state>           |
| Approvals              | Message...                                   |
| Activity               | Project / Harness / Model / Thinking  Send   |
+------------------------+----------------------------------------------+
```

Angle-bracket text denotes layout fields, not seeded product content. Do not render illustrative counts, names, avatars, tasks or activity events in production.

- Keep Settings in the upper-left and preserve the existing New chat, Add project and Search actions. Mode selection is a quiet labelled control, not three harness-colored application skins.
- The sidebar contains personal **Chats** and **Projects**. Personal chats remain distinct from folders and never acquire project trust/rename/remove controls.
- A project expands without replacing the open timeline. Background catalog refresh does not reopen a collapsed project, reorder the focused row or steal selection.
- Session rows use title first, a compact text harness label second, and actual attention state where present. Use `Prime` as a compact visual label with accessible name `Prime Agent`. No per-row model, token or cost dashboard.
- Harness filters are available in the expanded project's session controls and search. `All harnesses` means one mixed list sorted by the existing session policy, not a merged transcript. Preserve the existing pagination behavior rather than inventing a new page-size setting.
- Keep the current no-persistent-header policy while an ordinary session is identifiable in the visible sidebar. Harness and actual run state remain beside the composer; a read-only session uses the same provenance strip above its read-only notice. Session actions and **Session details** are accessible from the row menu and command palette.
- When the sidebar is collapsed or becomes a drawer, render a compact context row with **Open navigation**, session title, harness and **Session details**. This supplies missing context, not a second permanent toolbar.
- The optional right inspector hosts session details, native branch history, approvals or activity. Closing it restores focus to its trigger and never changes a session or stops work.

### Optional Workspace view

The sidebar and shared utilities remain. A compact workspace header carries the project scope and the section navigation; do not add another permanent icon rail or another project sidebar.

```text
+------------------------+----------------------------------------------+
| Same navigation        | Workspace · <project scope>                  |
| View: Workspace v      | Agents  Teams  Pipelines  Runs                |
|                        |----------------------------------------------|
| Chats / Projects       | <section title>              <real action>   |
|                        | Search / filters                             |
|                        | Definition or run list                       |
|                        |                                              |
|                        | Selected detail / editor                     |
| Approvals              |                                              |
| Activity               |                                              |
+------------------------+----------------------------------------------+
```

- **Open in workspace** in a project menu selects that project's scope. Switching back restores the previous session, draft, scroll anchor and open inspector.
- Project scope is always labelled. Agents may additionally show explicitly global profiles. Teams and pipeline runs show their working project before launch. `All projects` is a browsing filter, not an execution CWD.
- **Agents** lists saved profiles. **Teams** lists reusable member/topology definitions. **Pipelines** lists reusable task/dependency definitions. **Runs** lists actual executions from the coordinator, including linked native sessions.
- Use table/list rows for comparable records. Do not turn every item into a large bordered card. On selection, use the workspace detail area; profile, team and pipeline editing gets a full main view instead of a stack of modals.
- Unknown or unavailable contributions show a plain explanation in their section. Do not fill them with sample agents or actionable-looking dead buttons. Core history, approvals, diagnostics and navigation remain available.
- Run badges, section counts and attention markers come from the host. If no count is known, show a label or `Unknown`, not zero.

### Shared utilities

**Approvals** and **Activity** are persistent sidebar utilities in both modes. Their active state and actual pending count appear only from host data. The collapsed-navigation context row must expose pending attention too. A background request does not force navigation or open a modal over a different task.

Open either utility in the inspector with explicit scope: current session, current run, current project or all projects. The initial context is labelled and can be changed; it must never silently hide requests from a background run. An all-project pending summary remains visible when the current scope has none.

Settings still replaces the main workspace and keeps the global navigation. Closing Settings returns to the precise previous view, not an arbitrary first session.

## 4. Mixed-harness project and session identity

### Add a folder

1. **Add project** opens the native folder picker. Do not ask the user to assign a permanent harness before choosing a folder.
2. The host canonicalizes the directory and either registers it or opens the already-registered project. No duplicate record is created for another harness.
3. Show cached/discovered native sessions under that project, each with origin. Source-specific scan failure leaves other harness results visible.
4. A new session chooses its harness at the composer. Changing the preferred harness for future sessions never relabels existing sessions or alters their files.

**Migration requirement:** map an existing single-kind project to one folder plus its existing harness binding, preserving selection, display name, pins, native sessions and current trust scope. Adding another harness must not silently extend an old executable-resource grant. Ambiguous roots or conflicting directory identities require a host error, not title/path-string deduplication in Svelte.

### Trust and resource boundaries

- Folder identity and trust are host concerns. Show the selected harness and the actual resources/permissions affected by a new grant.
- Preserve separate Pi, Prime and Codex config roots, model catalogs, extension inventories and authentication flows. A trusted folder is not authorization to copy or auto-enable code across harnesses.
- Adding a team member or switching a profile cannot broaden a project grant. Show a separate **Review trust** action for missing required scope.
- Trust text names OS privileges and says **Trust is not a sandbox**. Restrictions labelled advisory are not presented as security boundaries.
- Keep the current restricted read-only history path. Do not offer **Open without project resources**, trust-once or persistent choices unless the selected adapter actually supports their stated semantics.
- Project-local JS never loads just to preview a profile, inspect a team or compute a graph. Treat definitions as validated data.

### Native permission mode

The v11 create-session command requires an explicit `permissionMode`. Show its current value in new-session options and keep a concise permission summary visible before Send/Launch. Do not equate the permission mode with project trust or a generic sandbox switch.

| Wire value | UI label and meaning |
|---|---|
| `native` | **Native permissions** — preserve the selected harness's configured native policy. This makes no extra OS isolation guarantee. Use this exact meaning for Prime. |
| `read-only` | **Read-only** — a requested strict policy. Enable launch only when the native factory can enforce it; otherwise show the reason and reject the request. |
| `workspace-write` | **Workspace write** — a requested strict policy whose exact native enforcement is described by the adapter. It is not a synonym for sandboxing; reject when it cannot be enforced. |
| `full-access` | **Full access** — explicit native policy bypass where supported. It requires a deliberate user selection and clear scope; never select it to repair an unsupported strict mode. |

Do not silently downgrade a required `read-only` or `workspace-write` request to `native` or `full-access`. Preserve the saved/user-selected mode and show incompatible profiles as blocked. A full-access selection does not grant project trust, message/spawn/read authority or unrelated harness access. The host validates the field at launch; UI copy is not enforcement.

### New and existing sessions

- New chat shows Project, Harness, Model and adapter-supported thinking/reasoning options. No project is valid only where that native adapter proves a personal-session CWD/lifecycle. Otherwise explain the required project; never silently run in a user's arbitrary folder.
- Harness selection is explicit for the draft. Its options show readiness: `Available`, `Setup required`, `Read-only` or `Unavailable`, with a safe reason and setup/details action. Installed is not the same as usable.
- Once a native session exists, its harness is immutable. **New chat with another harness** creates a new draft; it does not convert, rename or append to the old session. Transferring content is a separate explicit user action with a visible preview, never automatic.
- A new-session row may be presentation-only until the native adapter returns an exact durable binding. Preserve the existing Pi delayed-persistence behavior. Never fabricate a JSONL file, pick the newest session by guess or report `Saved` before binding.
- Model catalogs, defaults and drafts are scoped by harness and native session/profile. A matching model name does not authorize reusing another harness's selection. Refresh preserves the current value as unavailable when it disappears; do not silently choose a different model.
- Browsing history does not start a runtime. If loading a first model catalog requires a start, the action says so. First paint never waits for model/auth/network checks.

## 5. Chat, composer and session details

### Conversation surface

Retain the single persisted-plus-live timeline, anchor-preserving history paging, batched streaming and generic AST-based Markdown renderer. Keep completed tools/thinking collapsed unless the user opened them. A failed or active group may surface according to the existing activity policy without undoing an explicit manual collapse.

A native session title, harness and capability context must be recoverable without hover. Timestamps and supplementary metadata may appear on focus/hover; important error or truncation information may not. Unknown events retain a display-safe generic disclosure. No raw HTML, arbitrary extension DOM, full RPC object or secret-bearing payload is rendered.

**Session details** shows the harness, native runtime version/source label when available, current model, supported actions, history freshness and links to a run/member/step where applicable. Native branch history is named **Session branches**, not Team graph. Continue, rename, export, fork and tree navigation appear only with their actual supported semantics. Unsupported navigation stays read-only; never emulate it by editing parents.

### Composer semantics

| Situation | Visible action and behavior |
|---|---|
| Idle, valid draft | **Send** targets the named harness and native session. Clear the draft only after accepted delivery. |
| Starting | **Starting <harness>…** with draft preserved. Navigation remains usable. Duplicate Send is disabled for that operation. |
| Running, native follow-up/steer supported | Keep **Stop turn** distinct from a labelled **Follow up / Steer** send mode. The chosen mode is visible before Enter; Pi's existing follow-up behavior remains labelled. |
| Running, no native queue mode | Keep the draft editable; explain `Wait for this turn or stop it before sending`. Do not pretend a UI-only draft is a native queued message. |
| Rejected/failed send | Inline error next to the composer, preserved text/attachments and a supported recovery action. Do not erase newer edits with an older request's failure. |
| Delivery outcome uncertain | `Delivery not confirmed` with **Check status**. Reconcile by host operation/native identity before exposing retry; do not blindly repeat possible side effects. |
| Read-only / missing adapter | Timeline stays readable. Replace Send with concise native-lane reason and **Runtime details** or **Set up <harness>**. |
| Safe mode | No executable composer. Preserve any draft and show that runtime actions are disabled. |

- **Stop turn**, **Cancel run**, **Stop owned runtime** and **Close window** are distinct actions with distinct copy. A turn interrupt does not claim to cancel queued tasks or a whole team.
- **Stop turn** reports `Stopping…` until the host confirms an outcome. A failed interrupt leaves an unresolved state visible; an icon swap is not proof that tools stopped.
- Normal sends never open a confirmation just for polish. Preflight or trust is shown only when a real boundary requires it.
- Slash commands come from the selected harness. Named pipeline launches appear in a separate **Workspace launches** palette group and cannot collide with native slash commands. An extension command that bypasses native queue semantics says so before submission.
- No attachment, recording or browser button is shown without an implemented host action. Preserve explicit external-file reference/copy decisions when attachments are available.

## 6. Agents and profile editor

### List and entry

Agents uses rows with **Name**, **Harness**, **Model**, **Scope/source** and **Readiness**. A profile is not labelled running; linked active instances belong to Runs/Sessions. Actions are **Create profile**, **Edit**, and supported duplicate/archive operations. Show source ownership for a runtime-native, extension-provided or PiUI-authored definition; read-only sources cannot masquerade as editable copies.

Creating a profile opens a full-view editor. Select the harness before harness-specific fields. Changing the harness of an existing profile uses **Create a copy for another harness** and highlights unsupported settings rather than silently translating them.

### Editor sections

| Section | Fields and interaction |
|---|---|
| Identity | Name, optional description, explicit scope/project, source and saved revision. |
| Runtime | Native harness, model picker, supported thinking/reasoning values, configuration source. No API key or environment editor. |
| Instructions | Labelled multiline plain-text editor with exact saved content and clear scope. Content stays out of ordinary logs, activity summaries and search snippets. Saving is not sending. |
| Tools and resources | Adapter-supported tool/skill/extension references with source and enablement. Unsupported inventory is explicitly unavailable, not an empty list that implies no tools exist. No auto-install or cross-harness copying. |
| Policy | Requested tool/spawn/observation restrictions with enforcement labels. Distinguish the profile's requested scope from the host's actual effective capabilities. |
| Validation | Effective configuration, inherited values, blocked requirements and safe diagnostic details. **Check configuration** may probe only through a labelled permitted host operation; it does not send a hidden model prompt. |

Use a calm main form plus an effective-configuration summary when space permits; stack the summary below the form at narrow width. Required fields have persistent labels, not placeholders alone. Long instructions get their own scrollable editor, not an enormous page-height textarea.

### Saving and enforcement

- Footer: **Cancel** and **Save profile**, plus an explicit unsaved/saving/saved state. Return to the initiating list/detail after success. Leaving a dirty editor offers **Save**, **Discard changes** and **Keep editing**. A failure retains all input and focuses the error summary or affected field.
- Saving a definition never starts a runtime, installs an extension or grants project trust. A saved but unlaunchable profile remains visible as **Needs configuration**.
- Every restriction shows one of **Native-enforced**, **Coordinator-enforced**, **Advisory**, **Unsupported** or **Not verified**, using both text and a status mark. Show who enforces it and what it covers. A tool allowlist or prompt instruction is not an OS sandbox.
- Unsupported mandatory requirements reject launch. Do not silently weaken them. An advisory instruction must be deliberately authored as advisory; the UI cannot downgrade a mandatory rule to make a launch succeed.
- For reusable profiles, unset model/policy values show their native or inherited source. Do not manufacture agent quotas, recursion limits, budgets, retry counts or timeout defaults. Surface native/owner-specified values only.
- Editing a profile creates a new definition revision for future runs. Existing run snapshots remain unchanged. Live model/instruction changes, if supported, are explicit native-session operations rather than side effects of **Save profile**.
- Deleting/archiving a referenced profile shows affected definitions. Past snapshots and native histories remain readable. Index rebuild and “reset appearance” do not delete authored definitions.

## 7. Teams: three different relationship policies

A team editor opens with **Members**. Each row names a stable member slot, profile reference, harness and project binding. The start initiator/coordinator is explicit if the definition requires one; Pi or Prime is not silently installed as a privileged parent of every Codex member.

Relationship editing is **list-first**, with a selectable **Diagram** view. Every edit is possible through labelled fields and buttons without dragging. The diagram summarizes the same data; it is not another storage model.

| Relationship | Direction means | Does not grant |
|---|---|---|
| **Messaging**: Sender → Recipient | The sender may request delivery to that recipient through the coordinator. Reverse direction is a separate permission. | Spawn rights, transcript read access, OS access or membership-wide broadcast. |
| **Observation**: Observer → Subject | The observer may read the explicitly allowed state/output scope of the subject. Show the scope in the row. | Permission to send, edit the subject, read arbitrary files or see all hidden/native reasoning. |
| **Spawning**: Parent → Allowed child profile | The parent may request creation using that permitted child profile and inherited/narrowed authority. | Automatic child creation, reciprocal messaging or a bidirectional relationship. |

### Interaction and visual rules

- Separate relationship tabs or sections by their names. Messaging, Observation and Spawning have distinct legends. Do not place all lines on one unlabeled canvas or use line color as the only distinction.
- **Add message permission** opens Sender and Recipient selectors. **Add observation permission** additionally names the permitted read scope. **Allow child profile** selects parent, child profile and effective inherited policy.
- Show a textual sentence before saving each relation, such as `<sender> may send messages to <recipient>`. A reverse relation requires its own explicit edit.
- Diagram nodes show slot/profile name and harness, not fake people/avatars. Use deterministic layout and stable selection. Arrows have direction and accessible descriptions. Dragging a node changes presentation only.
- A relation editor is an inspector or inline form. Keyboard users can add, inspect and remove every relation from its list. Diagram focus never traps navigation; no giant canvas must load to edit a team.
- Capability validation covers the source **and** destination adapter plus coordinator routing. Same-harness support does not prove cross-harness interoperability.
- Communication cycles are not spawning cycles and are not pipeline dependencies. Validate each according to the owning host policy; do not ban or allow cycles by visual intuition. Native recursion/resource limits remain labelled and authority-backed.
- A requested workspace child template cannot widen the parent's effective coordinator authority. A denied workspace spawn/send/read appears as a specific host result; the interface does not suggest bypassing it by embedding a command in prompt text. `allowedSpawnProfileIds` restricts coordinator Workspace tool template launches, not all native Python/RLM/process capabilities. An empty list forbids workspace template launches but does not promise no native subprocesses or OS isolation. Prime cannot disable native RLM while keeping normal `ipython`; a mandatory native RLM denial is unsupported and must reject launch. Keep these limits distinct from coordinator-enforced workspace routing.

### Definition versus observed execution

The team editor shows **Allowed spawning**. A run's Relationships view shows **Actual spawn lineage**, derived only from acknowledged native/coordinator events. Keep them separate. A team membership edge does not imply a parent-child process relationship; a permission arrow does not prove that a message was sent.

In a run, **Send message** names the exact sender identity and recipient before submission. User-authored messages are attributed to the user, not spoofed as an agent. Distinguish `Requested`, `Accepted`, `Delivered`, `Replied`, `Denied`, `Failed` and `Unknown` only where those states are evidenced. Accepted by the coordinator is not proof that the recipient read or acted on it. No automatic “all members” recipient.

## 8. Pipelines and reusable launches

### Pipeline editor

Use a task list as the primary editor and an optional dependency diagram. Each step shows its label, member/profile binding, native harness, task input, dependency conditions and explicit output references. Message permissions and spawn relationships are edited in the team, not inferred from task dependency arrows.

- Reorder controls and dependency selectors provide a keyboard alternative to drag/drop.
- The host validates missing references, incompatible profiles, unsupported mandatory policy and dependency errors. Surface all relevant errors beside the owning fields and in the launch preflight.
- Parallel execution follows actual independent dependencies and the coordinator's supported policy. Do not bake in a UI agent-count cap or time budget.
- Model/tool execution remains native. UI expressions, a field preview or graph layout never execute user-supplied code.
- Show native outputs through linked sessions or explicitly projected artifacts. Do not copy all transcripts into a pipeline result document. Artifact opening remains a validated host action.
- Failure handling is explicit in the saved definition when supported. Do not invent a default retry loop. Cancellation and uncertain side effects must remain visible in run state.

### Named launch actions

A saved pipeline can expose a reusable named launch action. Its form captures a display name and explicit input parameters; this is not a general shell-command field.

**Launch** opens a compact preflight with project, definition revision, members/harnesses, effective policies, requested input and any unresolved setup/approval/trust needs. It does not ask the user to reapprove harmless navigation. A user-selected fully specified launch proceeds through the typed host start operation.

- Palette group: **Workspace launches**, separate from **Navigation** and **<Harness> commands**. Search result names the pipeline and scope.
- Parameters keep labels, validation and safe input handling. Never concatenate them into an executable shell string.
- Host acknowledgement creates/selects the run. While start is pending, prevent duplicate submission for that operation. Lost acknowledgement enters reconciliation, not a second automatic launch.
- A launch refers to a saved revision. If a definition changed, show the new effective snapshot in preflight. Editing it does not mutate an already-running pipeline.
- An unavailable named action remains diagnosable where the user configured it; do not silently substitute another harness or drop a mandatory step.

## 9. Runs and shared activity

### Run list and details

Runs lists actual execution records with **Name**, **Project**, **Harnesses**, **State**, **Started/last activity** and **Needs input** where known. Filters cover state, project, harness and definition. Use tabular figures for recorded times/counts; no decorative KPI strip, invented progress percentage or estimated completion time.

Opening a run presents:

- a concise title, actual status, project and source definition revision;
- current task/member states and explicit pending requests;
- **Activity**, **Sessions** and **Relationships** views;
- **Definition used** as a read-only snapshot disclosure;
- a supported **Cancel run** action, separate from each session's **Stop turn**.

A completed run shows recorded results and native-session links. Failed or partially completed runs retain successful outputs and identify the failed or uncertain task. **Retry task** appears only when the coordinator proves it safe or after an explicit, correctly scoped user decision. `Unknown after restart` is not relabelled `Failed` or `Complete`.

### Activity stream

Shared Activity is a scoped chronological event list, not a chat room. Each row identifies project, harness, run/member/session, action, result and source time when known. A detail opens the corresponding native session/event or a display-safe journal record.

- Keep original native ordering within a source. Do not claim a precise total causal order between harnesses from wall-clock timestamps alone.
- A connection gap is marked `Activity may be incomplete` with reconciliation state. Do not drop unknown event types; show generic metadata and a safe summary.
- Filtering does not acknowledge approvals. Dismissing a toast does not remove the recorded error or answer a runtime question.
- Streaming text stays in the session timeline. Activity records meaningful task, delivery, lifecycle and approval changes, not every token or prompt body.
- While reading older activity, new events do not jump focus or scroll position. A **New activity** affordance follows the existing timeline behavior.
- Native harness schedules/goals may contribute display-safe status, but they remain distinct from PiUI launch schedules. PiUI v7 schedules target saved launch commands and always execute through the host coordinator; do not present adapter-native status as a PiUI-controllable schedule.

## 10. Shared approvals and input requests

The core-owned request surface displays a host-validated origin header that extension content cannot replace:

**Harness · Project · Session · Run/member/step (when applicable)**

Then show the actual request kind, safe action/resource summary, requested scope, supported decisions and any authoritative expiry. A Pi extension yes/no question is labelled **Extension question**, not **File permission**. Native execution approvals and questions may share the inbox without sharing semantics.

- Pending requests are bound to their exact runtime/session generation and opaque request identity. Reordering, reconnecting or selecting another session cannot retarget a response.
- The list remains available while a request is inspected. Opening a request is deliberate. Background requests create attention and an optional OS notification; they do not steal focus.
- A request that genuinely needs a modal uses the same core origin frame and focus rules. Escape closes inspection without granting permission. It sends cancellation only if the host/native contract explicitly says so and the UI names that outcome.
- Show only native-supported choices and their true scope. No universal **Always allow**, no default-checked authorization, no ambiguous **Continue**, no bulk **Approve all**.
- During response, show **Sending decision…** and prevent duplicate action. Keep content visible. Success requires the host's acknowledged resolution, not an optimistic local deletion.
- Expired, already-resolved, runtime-stopped and connection-lost requests become non-actionable records with their exact state. A stale click is rejected by the host and does not affect another pending request.
- Response failure retains the request and typed input. A retry follows the host's replay/idempotency contract; uncertain resolution first checks status.
- Approval/input content is treated as potentially sensitive. Ordinary notifications/logs contain safe metadata, not full commands, secrets, prompt bodies or filesystem paths.
- A successful approval is not proof that execution succeeded. Follow the resulting native task state separately.

## 11. Visual system

### Character and hierarchy

A quiet desktop tool: neutral backgrounds, clear reading surfaces, one restrained sage accent and visible state. Use space and alignment before borders. Assistant messages are documents; user input gets one modest surface; errors and approvals receive attention because they need action, not because everything is a card.

Retain the local system font stack in `tokens.css`: Segoe UI Variable/Segoe UI with system fallbacks, and Cascadia Code/SFMono/Consolas for code. Do not download a typeface during startup. Use regular body, medium controls and semibold section titles. Sentence case replaces decorative uppercase eyebrows. Use tabular numerals for recorded counts, IDs and timings, with monospace reserved for code/path/IDs.

Use the existing token scale and appearance choices as the starting geometry: sidebar width, spacing, compact/comfortable density, chat text size and Wide/Centered/Focused lanes are already documented. Do not introduce a new content-width gate or silently reset a user's preference. New desktop headings use existing small section-heading sizes, not the empty state's display scale. Align composer and transcript lanes. Give wide code/tool data room without stretching form labels across the whole window.

### Proposed semantic palette

These are design token choices, not performance measurements. Preserve semantic token names so extensions do not depend on internal CSS classes. Values must still be checked in rendered light, dark, system and forced-colors states.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--piui-bg` | `#171717` | `#f4f4f4` | Main canvas |
| `--piui-bg-raised` | `#1c1c1c` | `#fafafa` | Sidebar and inspector |
| `--piui-surface-1` | `#242424` | `#eeeeee` | Quiet inset area |
| `--piui-surface-2` | `#2e2e2e` | `#e4e4e4` | Hover/selected neutral surface |
| `--piui-surface-3` | `#383838` | `#d8d8d8` | Stronger inset/disabled shape |
| `--piui-text` | `#ededed` | `#202020` | Primary copy |
| `--piui-text-muted` | `#b6b6b6` | `#545454` | Labels and secondary content |
| `--piui-text-faint` | `#a4a4a4` | `#5b5b5b` | Supporting content, never disabled-opacity critical text |
| `--piui-border` | `#3e3e3e` | `#c5c5c5` | Decorative separation |
| `--piui-border-subtle` | `#303030` | `#dedede` | Low-emphasis dividers |
| `--piui-border-strong` | `#858585` | `#767676` | Required control contours, not every row |
| `--piui-accent` | `#a6c590` | `#436732` | Primary action, selected mark, text link |
| `--piui-accent-ink` | `#1a2514` | `#f8faf6` | Text/icon on accent |
| `--piui-accent-soft` | `#2b3825` | `#e0ead9` | Selected accent surface |
| `--piui-focus` | `#c7dcb5` | `#436732` | Visible focus indication |

Keep danger/warning/success as semantic status families with existing text/surface/border tokens. Root contrast verification set light accent/focus/success to `#436732`, danger to `#963f36` and warning to `#785714` so status text also clears AA on the stronger neutral surface. `styles/tokens.test.ts` checks these combinations; rendered verification still applies. Status has an icon and label. Do not encode harness identity in red/green/purple skins, reuse danger styling for normal Stop, or use faint text plus reduced opacity for a critical disabled explanation.

### Component treatment

- Use `--piui-radius-sm` for fields/compact controls, `--piui-radius-md` for grouped surfaces and the existing larger token for dialogs/composer. Replace the composer's independent oversized radius with the shared scale.
- A selected session has surface + persistent selection mark; hover is quieter and visibly different. Keyboard focus is distinct from both.
- Keep the existing SVG stroke language and give every icon-only action a visible tooltip plus accessible name. Do not add an icon library solely for differentiation.
- Forms use aligned labels, controls and field errors. Tables reserve a predictable action area and align shared baselines. At narrow widths, wrap metadata rather than hiding the harness or pending state.
- Shadows belong to overlays that overlap content, not each session row or task card. Use a semantic overlay/backdrop token; light mode must not inherit dark-only hardcoded hover values.
- Replace the perpetual shimmer in `app.css` with static skeleton shapes and a meaningful loading label. Status does not pulse indefinitely. No entry cascades, typing ornament, graph physics or ambient animation.
- Retain short existing interaction transitions only where they clarify a state change. Reduced motion removes them. Never animate layout dimensions, force smooth scrolling while reading, delay task output or make approval controls move under a pointer.

## 12. Empty, loading, error and recovery states

Use a state heading, one factual explanation and the relevant supported action. Do not show both “empty” and “failed to load” as if they meant the same thing. Refresh normally keeps the last known rows with a freshness label; first-load placeholders match the actual layout.

| Surface/condition | Required behavior and copy direction |
|---|---|
| No projects or chats | `Start a new chat`; offer a supported native harness or **Set up a harness**. Keep **Add project** visible. No sample conversations. |
| Project with no sessions | `No sessions found`; show current harness filter and scan freshness. **New chat** only for available lanes. A filter-empty state offers **Clear filter**. |
| New unsent chat | Quiet empty transcript and bottom-anchored composer. `New chat` sidebar draft row; no claim that a native session was saved. |
| Catalog refreshing | Retain cached rows; announce `Refreshing local sessions…`. A source failure says which harness could not refresh and retains other results. |
| Model catalog offline/unavailable | Preserve selection and draft. **Refresh models** or native setup guidance; do not choose a fallback model without the user. |
| No agents/teams/pipelines | Explain the definition type and show its real create action. If unavailable, explain the missing capability instead of inventing a starter configuration. |
| No runs/activity | `No runs yet` / `No activity in this scope`. Link to an available launch or change scope; no fake zero-cost/performance statistics. |
| No pending approvals | `No pending requests in this scope`, with all-project attention if relevant. This is not a claim that a runtime cannot request approval later. |
| Invalid profile/topology/pipeline | Inline field errors plus an error summary with focus links. Keep the complete draft. Show effective enforcement and incompatible member/step. |
| Failed save | `Could not save <definition>` plus safe detail/retry. Keep the dirty editor; do not show a success toast. |
| Missing folder | Retain project and cached history with freshness limits. **Refresh**, and **Locate folder** only with a validated host identity flow. **Remove from PiUI** never deletes files. |
| External writer/source changed | Read-only conflict state; preserve draft. **Reload history** and supported separate fork/open-native guidance. Never merge or overwrite JSONL. |
| Runtime crashed/disconnected | Preserve native history and known live state; show **Reconnect/check status** before restart when execution may still exist. Restart is not resubmit. |
| Cancel requested | `Cancellation requested` until host/native outcomes settle. Show partial completion and any unknown descendants; do not immediately mark all members stopped. |
| App reload/restart | Restore selection, draft and view. Rebind/reconcile native sessions and run journal. Uncertain work stays **Needs reconciliation**; do not replay side effects. |
| Unsupported or broken renderer | Core generic safe disclosure, source label and diagnostic detail. A disabled contribution cannot hide its native session. |
| Safe mode | Persistent core banner: `Safe mode. Runtime actions and extensions are disabled. Local history remains read-only.` Keep Sessions, Settings, provenance and recovery usable. |

Safe mode additionally renders durable run summaries/definition snapshots through core generic read-only views, without loading the workspace contribution or project code. It cannot start, resume, send, spawn or approve. Previously pending requests show snapshot freshness and are non-actionable until the host establishes their current status outside safe mode. Entering safe mode must not silently kill or adopt unknown native workers; lifecycle resolution belongs to the proven host policy.

Window close uses the host's actual capabilities: stay open, explicitly stop owned work, or leave background work only when that lifecycle is supported. Name the affected sessions/runs. No “keep running” option before containment/resident-session evidence, and no claim that closing the WebView alone stops every tool.

## 13. Keyboard, screen reader and narrow-window contract

Inherit the shortcut map and platform conflict rules from [02_UX.md](02_UX.md); do not introduce a second competing keymap. In particular: Ctrl/Cmd+K for palette, Ctrl/Cmd+N for new chat, Ctrl/Cmd+, for Settings, Enter/Shift+Enter for composer, and the documented Stop binding. Do not intercept IME composition. New workspace actions remain accessible from labelled controls and the palette without requiring new memorized shortcuts.

| Surface | Keyboard and focus behavior |
|---|---|
| Shell | First focusable skip link targets main content. Named navigation and main/inspector landmarks. A collapsed/drawer sidebar always has an open/close control. |
| Project/session navigation | Roving focus with documented tree semantics; arrows expand/collapse and move, Home/End traverse visible rows, Enter opens. Context actions work through a menu button or keyboard context menu, not right-click only. |
| View/section navigation | Sessions/Workspace and Agents/Teams/Pipelines/Runs expose selected state. Use real tabs only for tab panels with matching arrow-key behavior; otherwise use navigation buttons with `aria-current`. |
| Pickers/search | Existing searchable model picker behavior: arrows, Enter, Escape and focus return. Announce loading/no results/current unavailable value without reading every catalog refresh. |
| Editor | Labels and descriptions associated with fields; Tab follows visual order. Validation points to fields. Dirty-exit decision traps focus only while open and restores it on cancel. |
| Relationship/dependency editing | Full list/form alternative to diagram gestures. Selecting a row exposes direction, scope and source/destination names. Removing a relation returns focus to a stable neighbor or Add action. |
| Approvals | Pending summary announces once per meaningful change. Explicit inspection moves focus to origin/title, not the grant button. Tab reaches native decisions. Escape never grants. Resolution restores focus to the request list/trigger. |
| Timeline/activity | One readable stream per surface; no token-by-token announcements. Announce completed messages and important blocked/failed states. Focused rows and scroll anchors remain stable across refresh. |
| Inspector/dialog | Docked inspector is not a modal and does not trap focus. Narrow overlay inspector uses modal focus/return rules. A native modal makes the background inert and restores the invoker or a logical surviving fallback. |

Use WCAG 2.2 AA and existing [08_TESTING_AND_PERFORMANCE.md](08_TESTING_AND_PERFORMANCE.md) accessibility criteria. Preserve sufficient target hit areas under compact density; applicable touch target guidance already lives in [01_PRODUCT.md](01_PRODUCT.md). Verify visible focus, forced colors, reduced motion, zoom/reflow and NVDA/Orca on their actual platform matrix. Tooltips are supplementary, never the only disabled reason or provenance.

For responsive layout, use the established desktop/drawer/overlay policy from `02_UX.md` and verify against actual Tauri window resizing. Preserve a readable main lane before adding a side panel; stack long editor fields; keep actions reachable in overflow menus. The current CSS breakpoints are implementation starting points, not proof of reflow. Do not invent a new minimum supported window size. No mobile product promise is added.

## 14. Concrete component and file map

Paths below are relative to `apps/desktop/src/` unless specified. **Existing** means reuse/refine after gates; **New** means planned, not created by this document. Split components by semantic ownership, not an arbitrary line-count target.

### Core shell and existing surfaces

| File | Action and responsibility |
|---|---|
| `app/App.svelte` | Existing: compose screen state and core recovery/request overlays. Remove navigation-driven ownership of runtimes only with the host lifecycle slice; keep established history reconciliation behavior. |
| `app/state.ts`, `app/state.test.ts` | Existing: keep small shell selection state; add discriminated screen/inspector routes and restoration tests. Do not store all runtime, graph and transcript data here. |
| `app/AppShell.svelte` | New: sidebar/main/optional-inspector grid, narrow navigation trigger, landmarks and core safe-mode banner. |
| `features/navigation/ViewSwitcher.svelte` | New: Sessions/Workspace presentation switch with preserved selection. |
| `features/navigation/CommandPalette.svelte` | Existing: separate Navigation, native Commands and Workspace launches; show immutable origin and launch scope. |
| `features/projects/ProjectSidebar.svelte` | Existing: folder-neutral project tree; shared utility entry points; mixed origin-aware rows and freshness. |
| `features/projects/AddProjectDialog.svelte` | New extraction from App: folder registration only, no permanent harness radio choice. Native picker errors stay local. |
| `features/projects/ProjectSettingsDialog.svelte` | Existing: registry actions, binding/trust details and migration-safe copy. Remove does not delete authored files or native sessions. |
| `features/projects/TrustDialog.svelte` | Existing: host-derived resource scope and harness context; core-owned explicit decisions and focus handling. |
| `features/sessions/SessionRow.svelte` | New: shared title/origin/state/selection/menu presentation for project, personal and search results. |
| `features/sessions/SessionView.svelte` | New extraction: one timeline scroller, empty/read-only state, provenance strip and composer slot. |
| `features/sessions/SessionDetails.svelte` | New: native origin/capabilities/freshness and run/member links; no process handles or raw paths. |
| `features/sessions/Timeline.svelte`, `ActivityGroup.svelte`, `timelineView.ts` | Existing: retain safe generic projected blocks, group state and scroll-anchor hooks. Style only through tokens/component CSS. |
| `components/MarkdownContent.svelte`, `components/markdown.ts` | Existing: preserve AST rendering and escaped HTML. Copy failure must be visible when refining the action. |
| `features/runtime/ChatPanel.svelte` | Existing: shrink to native chat composition/controller wiring, not process teardown ownership. |
| `features/runtime/SessionComposer.svelte` | New extraction: draft, send-mode choice, runtime options and typed request callbacks. No direct native transport. |
| `features/runtime/HarnessPicker.svelte` | New: current draft's harness choice, capability readiness and setup link. |
| `features/runtime/ModelPicker.svelte`, `modelPicker.ts`, `runtimeSelection.ts` | Existing: retain accessible search; scope cache/preferences by harness/session and handle unsupported thinking values honestly. |
| `features/tree/ReadOnlyTree.svelte` | Existing: Session branches inspector, distinct from relationship/dependency views; read-only until native navigation is proven. |
| `features/settings/SettingsView.svelte` | Existing: compact settings shell; retain Appearance/Extensions and add only backed Harnesses, Workspace, Keybindings and Diagnostics sections as their actions exist. Native setup/auth instructions never expose secrets. |
| `features/runtime/RuntimeBar.svelte`, `FakeScenarioComposer.svelte` | Existing: remain fixture/developer-only. Do not reuse fake content as product state. |

### Optional workspace contribution

| File | Responsibility |
|---|---|
| `features/workspace/WorkspaceView.svelte` | New lazy-loaded entry with project scope and Agents/Teams/Pipelines/Runs navigation. Uses narrow host use cases. |
| `features/agents/AgentProfilesView.svelte` | New profile list and source/readiness state. |
| `features/agents/AgentProfileEditor.svelte` | New versioned form and effective configuration; save/dirty/error behavior. |
| `features/teams/TeamsView.svelte`, `TeamEditor.svelte` | New saved definitions and member slots. |
| `features/teams/RelationshipEditor.svelte` | New separate messaging/observation/spawn forms and accessible relation lists. |
| `features/teams/RelationshipDiagram.svelte` | New optional deterministic SVG summary of the same relation model; not the only editor. |
| `features/pipelines/PipelinesView.svelte`, `PipelineEditor.svelte` | New saved task/dependency definitions, field validation and optional diagram. No scheduler. |
| `features/pipelines/LaunchActionEditor.svelte`, `LaunchPreflight.svelte` | New reusable named actions, parameter form, effective snapshot and typed start intent. |
| `features/runs/RunsView.svelte`, `RunDetail.svelte` | New actual journal-backed runs, task states, sessions, results and actual lineage. |
| `features/runs/RunRecovery.svelte` | New reconciliation/uncertain-delivery display. Recovery decisions use the host; no automatic replay. |

### Core shared surfaces and small domain state

| File | Responsibility |
|---|---|
| `features/approvals/ApprovalInbox.svelte`, `ApprovalDetail.svelte`, `approvalState.ts` | New core origin-bound pending/resolved projection and decision handling. Available independently of workspace rendering. |
| `features/runtime/ExtensionUiDialog.svelte`, `extensionUiState.ts` | Existing: retain native question/input semantics while integrating shared request identity. Never relabel all questions security approvals. |
| `features/activity/ActivityPanel.svelte`, `activityView.ts` | New cross-harness safe event list, scope/filter state and source links. |
| `features/runtime/PrimeActivityPanel.svelte`, `primeActivityView.ts` | Existing: reuse safe Prime label mapping as adapter-specific presentation input when supported; do not make it the shared event authority. |
| `features/workspace/WorkspaceFallback.svelte` | New **core-loaded** read-only definition/run summary for safe mode and contribution failure. Must not import executable workspace entry. |
| `components/EmptyState.svelte` | Existing: compact variants for first-load, empty, filtered-empty and unavailable states. |
| `components/HarnessLabel.svelte`, `StatusLabel.svelte`, `CapabilityStatus.svelte`, `InlineNotice.svelte` | New semantic presentation primitives. No data fetching or policy decisions. |
| `components/DialogFrame.svelte`, `ContextPanel.svelte` | New tested focus/overlay wrappers with component CSS; native dialog first, no dependency added by assumption. |
| `features/sessions/sessionState.ts`, `features/runtime/runtimeCatalogState.ts` | New domain-scoped selection/projection and harness-keyed catalogs; event sequencing handled explicitly. |
| `features/agents/profileState.ts`, `features/teams/teamState.ts`, `features/pipelines/pipelineState.ts`, `features/runs/runState.ts` | New small reducers/form controllers colocated with tests. Definitions and execution authority stay in the host; no whole-app mutable store. |
| `styles/tokens.css`, `styles/app.css`, `styles/reset.css` | Existing: neutral themes, semantic contours/statuses, shared accessibility resets and motion preferences. Layout and component appearance stay scoped; do not create a utility-class DSL. |
| `host-api/workspaceClient.ts`, repository `contracts/workspace-v11.ts` | New integration boundary now provided by the root implementation: `workspaceHost.request`, `catalog`, `snapshot` and `listen`. All new native-session actions use this typed client; browser preview fails closed, never fakes execution. |
| `host-api/types.ts`, `host-api/client.ts`, `host-api/*.test.ts` | Preserve legacy history/add-folder/trust/preferences APIs and compatibility tests. Extend contracts schema-first when later orchestration operations land; do not hand-invent wire payloads. |

## 15. Host contract required by this UX

The root implementation has now provided `contracts/workspace-v11.ts` and `host-api/workspaceClient.ts`. Bind the new mode to **`workspaceHost.request`**, using its typed catalog, snapshot and event subscription. The new Rust `WorkspaceHost` owns independent native sessions; view unmount must only unsubscribe. Keep legacy `App.svelte` history accessible. Existing add-folder/trust/appearance host methods can be reused; the legacy `pi` registration hint is transitional host compatibility, not a permanent choice for every new session. Select the harness per session through v11. Browser preview must show desktop-required/unavailable states, never successful mock execution.

The following are **semantic requirements** for that boundary and subsequent orchestration contracts. Presence of a v11 field is not native lifecycle evidence. Profile/team/pipeline/run operations that are not yet in the schema stay unwired until their typed host use cases exist.

- Harness readiness and per-operation capabilities with enforcement level, safe reason and source/version. Model/thinking/command catalogs remain harness-scoped and can be stale without becoming an execution permit.
- One host project identity with per-harness bindings; immutable opaque native session references on catalog rows, runtime events and run/member links. Stable revisions/sequences allow stale-response rejection.
- Native create/open/reopen, explicit send mode, interrupt and owned-runtime lifecycle. Snapshot/resubscribe/reconcile must not create a new session. Component unmount/navigation only releases view subscriptions.
- Independent live sessions where supported, including background completion/input. Native concurrency/resource restrictions are returned honestly, not guessed by the UI.
- Origin-bound input/approval requests, supported decisions, expiry/resolution state and replay semantics. Responding to a stale generation fails closed.
- Versioned profile/team/pipeline/named-action CRUD, validation and effective enforcement. Save is separate from launch and trust. Durable definition storage is separate from the session index.
- Run start acknowledgement, immutable snapshot, task/delivery journal, native-session links, typed send/read/spawn policy results, cancellation and uncertain-operation reconciliation.
- Display-safe activity ordering/freshness and generic unknown-event fallbacks. Prompt bodies, credentials, raw stderr/RPC and unrestricted filesystem/process APIs are not part of ordinary activity contracts.

## 16. Visual redesign execution plan

Do the work as user-visible vertical slices. Preserve the pre-existing dirty worktree. No gate closes because a Svelte component compiles or a fixture type exists.

| Slice | Implementation after required evidence | Minimum proof that closes the slice |
|---|---|---|
| Evidence and contracts | Record new Prime/Codex native probe outcomes and operation gaps; freeze versioned capabilities, native identity, event/request schemas and ADR-023 ownership. Keep unsupported production paths disabled. | Actual start/send/interrupt/reopen/input/containment evidence for each activated lane and appropriate OS; compatibility fixtures reject cross-origin/stale identity. A missing result stays a blocker. |
| Core visual primitives | Apply neutral semantic tokens, compact type/spacing, state labels, dialog focus wrapper, static loading and visible narrow navigation. No behavioral shortcuts. | Native screenshots in existing theme/density/scale matrix; contrast/focus/keyboard checks; existing safe-mode and generic history flows still pass. |
| Mixed ordinary sessions | Migrate project identity through host use cases; update add-folder, session origin, harness/model choice, details and composer. Keep non-available lanes read-only with reasons. | One folder contains distinct Pi/Prime/Codex native sessions; create/send/stop/reopen use the correct harness; failed launch and external-writer conflict preserve files/draft; delayed Pi persistence still binds exactly. |
| Independent lifecycle and requests | Transfer runtime ownership away from keyed ChatPanel lifecycle; add request inbox and shared activity with snapshots/reconciliation. | Start work, switch project/view, receive background input, respond to the exact origin, return to its session; no navigation-triggered stop or accidental approval. Disconnect/reload/stale-response path is verified. |
| Agent profiles | Build list/editor/validation against durable host definitions and capability enforcement. | Save/reload an actual profile; rejected mandatory capability retains fields and cannot launch; model catalogs do not bleed across harnesses; save does not start work or change trust. |
| Teams and relations | Add member editor, separate send/read/spawn lists and optional diagram. Launch only through host policy. | Mixed native member run plus denied direction/read/spawn; reverse permission is not implied; child cannot widen authority; all edits work without pointer gestures. |
| Pipelines, launches and runs | Add task/dependency editor, reusable parameterized action, preflight, journal-backed detail and recovery. | Dependency-ordered native run; task failure/cancel and uncertain-delivery recovery; a named launch reuses a definition revision without shell-string execution or duplicated side effects. |
| Integrated desktop finish | Refine route restoration, inspector layout, typography and safe-mode fallback using the actual flows above. | Windows native E2E, required Linux evidence or explicit blocker, accessibility/reflow, bundle/startup/RSS/render measurements and public evidence wording agree. |

### Verification locations and commands

- Extend existing unit suites beside `app/state.ts`, session catalog/pagination/projection, model/runtime selection and extension request reducers. Add colocated tests for new profiles, relations, run state and approval origin/replay states.
- Extend `host-api/client.test.ts`, `types.test.ts` and `contracts/` compatibility fixtures when the IPC contract changes. Assert host state, not just labels or a mocked successful response.
- Extend the existing Windows native harness in `apps/desktop/scripts/tauri-webview2-dialog-e2e.mjs` and its controller. Keep fixture data clearly test-only. A static source smoke is not native E2E evidence. Do not call a Windows result a Linux pass.
- Capture stable UI surfaces through the native harness: ordinary mixed-session view, profile editor, separate relation views, pipeline/run detail, pending/stale request, and empty/loading/error/safe-mode fallback in both themes. Normalize test clocks only in fixtures; never alter product records for screenshots.
- Run the repository's applicable quality commands: `pnpm check`, `pnpm test`, `pnpm contract:test`, `pnpm test:e2e`, `pnpm perf:smoke`, `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`. Follow existing formatting/build checks too.
- Reuse the budgets, datasets, reference machines and reporting rules in [08_TESTING_AND_PERFORMANCE.md](08_TESTING_AND_PERFORMANCE.md). Record startup, idle RSS, long-history scrolling, stream batching and workspace-load impact before/after the affected hot-path slice. Lazy loading does not excuse total-bundle growth; use the actual build report. No new arbitrary asset cap, agent quota, retry budget or performance promise is introduced here.
- No real Prime probe/test uses the default daemon endpoint. Native runtime evidence belongs to isolated, owned spike/E2E execution, not opportunistic launches while styling.

## Completion criteria for the redesign

The UI is done when the authorized ordinary and optional workspace flows work through proven typed host operations, their failure/uncertain states are honest, and keyboard/screen-reader/safe-mode/generic history remain usable. A polished unavailable state is valid for a recorded adapter blocker; it is not completion evidence for a requested live operation.

Do not delay functional completion for decorative motion, a new font/icon library, a marketing empty state or a broader extension marketplace. These do not prove the requested multi-harness desktop outcome.

## Definition and execution implementation handoff

The authorized follow-on slice implements `features/orchestration/OrchestrationPanel.svelte`, `AgentProfileEditor.svelte`, `TeamEditor.svelte`, `PipelineEditor.svelte`, `LaunchCommandEditor.svelte` and `RunInspector.svelte`. These are a consolidated first implementation of the planned optional feature map above, not a second UI framework. `host-api/orchestrationClient.ts` uses the exact request envelopes in `contracts/orchestration-host-v1.ts`. Browser preview refuses both fake persistence and fake native execution.

The reusable panel accepts `workspaceId`, `section` (`agents`, `teams`, `pipelines`, `runs`), `safeMode`, optional `onOpenSession` and `onDirtyChange`. The owning workspace shell must guard dirty route changes and lazy-load this optional contribution. Existing App/history and global tokens are owned by the root integration slice.

This slice provides real catalog/get/save/delete definition operations with compare-and-swap revisions, failure-preserved editor input, separate directed message/observation editors, workspace child-template scope, DAG dependency editing, named team/pipeline references, and an event-updated run inspector with typed execution actions. The coordinator contract binds `TaskRecord.execution.id` to a safe PiUI workspace session ID for session navigation. No native path/process identity is guessed by the UI.

The registered scheduler milestone now enables start, cancellation, uncertain-task retry and operator reconciliation through the exact v1 host API. Safe mode disables execution actions. The host remains authoritative for readiness, trust and native policy; model/provider failures are shown, never converted to success. Launch-command parameters and effective runtime model catalogs are not in this editor contract. A saved declaration is not proof of native enforcement. Prime strict policies remain visible as blocked requirements rather than being rewritten.

Colocated helper tests cover profiles, team direction/validation, DAG validation and run-state projection. Client tests cover workspace-scoped real-command request construction, CRUD revision conflicts, safe error copy and unavailable-browser refusal. Svelte render integration tests check labelled/read-only/error surfaces and escaped instructions. Native interactive proof now passes in the separate WebView2 E2E integration slice: `target/piui-evidence/21760-1788691641684/report.json` reports real definition CRUD/readback/delete, saved-command launch, an actual unsupported-policy Failed run/task with no new native session, and safe-mode disabled execution controls. Prime Agent 0.9.2 and WebView2 152.0.0.0 were used. The normal scenario took 18,911 ms and safe mode 591 ms; these are observations, not new performance gates. First-paint fields are null and are not claimed as measured. Seven native PNGs are retained. This proves failure-aware native integration, not a successful provider/model pipeline. Server rendering is not counted as native E2E evidence.

### Durable run updates and execution controls

`orchestrationClient.listen` accepts only `piui://orchestration-event` payloads shaped as `{ protocol: 1, type: 'runChanged', workspaceId, runId, revision }`. The scheduler and API emit them only after a durable commit. Unknown versions, incomplete identities and non-integer revisions are ignored. The client exposes only these scalar invalidation fields, never arbitrary native event payloads.

The panel subscribes before its first local read and unsubscribes on disposal. It coalesces received invalidations by run, reads only affected real snapshots, and merges monotonically by revision. An older list read cannot drop a newly committed run. Scope-generation, workspace, selected-run and revision checks reject stale responses. Events do not reload, remount or reset definition editors. There is no polling timer, automatic retry loop or fabricated run event. If event subscription or a snapshot read fails, the last loaded state stays readable with a visible notice and an explicit Refresh action.

The inspector now binds cancellation, uncertain-task retry and operator reconciliation callbacks outside safe mode. Cancellation stays requested until the host returns a recorded outcome; uncertainty is not labelled cancelled. An uncertain retry requires explicit review of the linked native session and acknowledgement that it creates a new attempt while previous side effects may already exist. Failed tasks do not gain an invented retry command. Reconciliation records an operator assertion, not native completion proof; success may unblock dependents, and recording cancellation does not stop a process.

`RunLauncher.svelte` selects real saved references or a named launch command. The host snapshots the latest saved definitions. A pending or unconfirmed launch keeps its opaque run ID and selected references for an explicit same-request recovery; it never automatically replays a task. `runActions.ts` sends one typed command with exact run/task CAS, then performs read-only run recovery if that command fails. An existing durable record is shown with its original action error, not as a fabricated success. A read after opening the resulting inspector closes the event-subscription transition gap. Native requests do not block unrelated workspace navigation.
