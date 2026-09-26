# Classic parity (release 0.2.0)

Status: 2026-09-27, branch `feat/classic-port`. Plan item P2.7, first half
([PLAN_REMAINING_2026-09-26_RU.md](PLAN_REMAINING_2026-09-26_RU.md)).

Decision: the new shell (`src/app/shell`, the default view) reaches parity now.
The previous interfaces stay reachable in 0.2.0 and are deleted in the next
release:

- `?view=legacy` — the previous multi-harness workspace shell
  (`features/workspace/WorkspaceShell.svelte`).
- `?view=classic` — the older Pi-only view (`app/App.svelte` with
  `features/projects`, `features/runtime`, `features/sessions`,
  `features/settings`, `features/tree`, `features/navigation`).

Settings → About has one row that opens either view and says it goes away in
the next release; both classic settings pages have a "New interface" button
that returns to the default view.

Statuses: **Ported** — added to the new shell by this change. **Present** — the
new shell already had it. **Dropped** — intentionally not carried over (reason
given). **Gap** — not ported yet; must be resolved before the classic code is
deleted.

## Summary

| Status | Count |
| --- | --- |
| Ported | 17 |
| Present | 27 |
| Dropped | 9 |
| Gap | 2 |

## Pi-only classic view (`?view=classic`)

| Capability | Classic location | New shell location | Status |
| --- | --- | --- | --- |
| Browse the Pi sessions the index found in a project folder (sessions run in the Pi terminal app) | `ProjectSidebar` session list, `App.svelte` catalog logic | Sidebar project menu → "Pi session history" (route `history`), `app/history/HistoryView.svelte` | Ported |
| Browse projectless Pi chats (personal scope) | `ProjectSidebar` "Chats" group | Sidebar "Personal chats" menu → session history (personal catalog) | Ported |
| Cache-first catalog, reconcile on open, refresh, degraded state, watcher hints, catalog events | `App.svelte` (`applyProjectCatalog`, root hints, 15 s poll) | `app/history/historyStore.svelte.ts` (cached → refresh, `piui://session-catalog`, `piui://session-root-hint`, Refresh button) | Ported (15 s poll dropped: watcher hints, refresh on open and the Refresh button cover it for a read-only view) |
| Prime Agent project history (projects added as Prime Agent) | same, `agentKind` marker | Same history view, titled "Prime Agent session history" | Ported |
| Read-only transcript from Pi JSONL, latest page first, older pages by cursor, bounded window, stale-cursor recovery | `App.svelte` + `features/sessions/Timeline.svelte` | Shared `app/chat/transcript/Transcript.svelte` ("Load earlier history"), `mergeOlderPage` in `app/history/piHistory.ts` | Ported (no second chat format) |
| Generic fallback for extension, unknown and damaged entries | `Timeline.svelte` fallback renderer | `Transcript.svelte` fallback (`<details>` + compatibility tag) | Present |
| Session tree (branches, current path, index issues, diagnostics); read only | `features/tree/ReadOnlyTree.svelte` (never opened in the classic UI) | History details inspector → "Branches" (`SessionBranches.svelte`): branch summary, split points, bounded entry list | Ported |
| Tree navigation (switch the active branch) | Not available (`navigationSupported: false`) | Not available; the panel says to switch branches in the Pi terminal app | Dropped (risk R-03 open: no verified Pi RPC navigate command; nothing may rewrite JSONL) |
| Search indexed session titles and previews across projects | `CommandPalette` (`search_sessions`) | History view filter (this folder) + "In other folders" results (`search_sessions`); palette action "Open session history" | Ported |
| Extension dialogs: select, confirm, input, editor | `ExtensionUiDialog.svelte` via `respond_extension_ui` | Chat approval cards (`ApprovalCard.svelte`) through the workspace v15 approval route | Present |
| Editor dialog prefill and timeout notice | `ExtensionUiDialog.svelte` | `ApprovalCard.svelte` (additive v15 `prefill`, `timeoutMs`; the bridge retires a timed dialog) | Ported |
| Extension notices (`notify`) | `ChatPanel` toasts | Chat: dismissible notices above the message box (`app/chat/extensions/ExtensionSurface.svelte`) | Ported |
| Extension statuses (`setStatus`) and widgets (`setWidget`, above/below the editor) | `ChatPanel` | Chat: status chips and panels above/below the message box | Ported |
| Window title (`setTitle`) | `ChatPanel` → `document.title` | Chat: `document.title` while the chat is open | Ported |
| Prepared composer text (`set_editor_text`) without overwriting a draft | `ChatPanel` suggestion bar | Chat: fills an empty composer, otherwise "Replace draft" / "Discard" | Ported |
| Unsupported extension UI request notice | `ChatPanel` warning notification | Chat notice (host projects unknown methods to a fixed summary) | Ported |
| Global extension inventories for Pi and Prime Agent, turn on/off | `features/settings/SettingsView.svelte` → Extensions | Settings → Extensions (`app/settings/ExtensionsSettings.svelte`) | Ported (stays usable in safe mode to turn a broken extension off) |
| Project-local extensions only after project trust | Settings note, host trust gate | Settings → Extensions note; host trust gate unchanged | Present |
| Project rename, pin/unpin, remove from PiUI | `features/projects/ProjectSettingsDialog.svelte` | Sidebar project menu → Rename…, Pin to top/Unpin, Remove from PiUI… (`app/projects/ProjectDialogs.svelte`) | Ported (removal waits until no agent runs in the folder; unavailable in safe mode) |
| Pinned marker and pinned-first order | `ProjectSidebar` | Registry order (pinned first); menu shows Pin/Unpin | Ported (no separate pin icon, per UI_STYLE "remove status noise") |
| Trust a folder | `features/projects/TrustDialog.svelte` | `AppShell` trust dialog, sidebar and Settings → Projects | Present |
| Add a folder with the native picker | Add project dialog | Sidebar "Add project…", Settings → Projects | Present |
| Choose Pi or Prime Agent when adding a folder | Add project dialog radio | Not offered: the harness is chosen per chat; existing Prime Agent folders keep their Prime history in the history view | Dropped (harness-neutral folders, ADR-026) |
| Add a folder by typed path (browser preview only) | Add project dialog without native picker | UI Lab folder picker fake | Dropped (development-only path) |
| Live Pi chat: send, steer, follow-up queue, stop, model and thinking pickers, compaction | `features/runtime/ChatPanel.svelte` (classic RPC path) | Workspace Pi chats: `ChatComposer`, `RuntimeChip`, queue, `/compact`, `/stop` | Present |
| New chat in a project or as a personal chat | Sidebar "New chat" / "New session" | Home composer, sidebar "New chat in …" | Present |
| Continue a session found in the index (started in the Pi terminal app) live in PiUI | `ChatPanel` with `start_runtime(projectId, sessionId)` | History reader → "Continue in PiUI" (`app/history/ContinueInPiui.svelte`) → `workspace_adopt_v1`, then the ordinary `openSession` ([SESSION_TOOLS.md](SESSION_TOOLS.md)) | Ported (`feat/session-tools`; classic admission checks, never writes or renames the file; concurrent writers stay R-06) |
| Pi runtime slash-command discovery (`get_commands`, provenance) in the composer and palette | `ChatPanel` slash menu, `CommandPalette` | Composer `/` menu: PiUI commands plus Pi extension commands, prompt templates and `skill:` commands from `get_commands` (source badge, inserted as text for Pi to run; paths never cross) | Ported in the composer; the palette does not list them yet |
| PiUI "Tier 1A" contributions: composer action buttons and palette commands from `piui.manifest.json` | `ChatPanel`, `CommandPalette` (`list_piui_contributions`) | Not available | **Gap** — superseded by the plugin registry (plan Ф8, ADR-032) or a small port on top of the dynamic slash commands |
| Prime Agent live chat | Disabled (fail-closed) | Workspace Prime harness chats | Present (the new shell is ahead) |
| Persistence feedback ("Finishing history sync…", retry discovery) | `ChatPanel` + `App.svelte` catalog resolution | Not needed: workspace chats are registered at creation; native history is read through `workspace_history_v1` | Dropped (the classic-only new-session discovery race does not exist in the workspace path) |
| Appearance: theme, density, motion, chat text size, conversation width | Settings → Appearance | Settings → General | Present |
| Safe mode banner, read-only history in safe mode | `App.svelte` banner | Shell banner; history view and extension list stay readable | Present |
| Unavailable folder banner | `App.svelte` | Sidebar "Missing" tag; history view notice | Present |
| Keyboard: new chat, search, settings | `App.svelte` shortcuts | `Mod+N`, `Mod+K`, `Mod+,` | Present |
| Fake runtime scenarios (`run_fake_scenario`, `start_fake_runtime`) | `FakeScenarioComposer.svelte` (not mounted) | UI Lab (`?lab=`) | Dropped (dead development surface) |
| Prime activity panel, runtime bar | `PrimeActivityPanel.svelte`, `RuntimeBar.svelte` (not mounted) | — | Dropped (unused) |

## Previous workspace shell (`?view=legacy`)

| Capability | Legacy location | New shell location | Status |
| --- | --- | --- | --- |
| Projects with their chats, status per chat | `WorkspaceShell` sidebar | Sidebar project tree with status dots | Present |
| Filter chats by text | "Search this project" | `Mod+K` palette (titles, projects) | Present |
| Filter chats by harness | Harness select | Palette search | Dropped (the palette and harness marks cover it) |
| Add project, refresh projects, review trust | Sidebar | Sidebar menus, Settings → Projects | Present |
| New chat: project, harness, model, permission mode, refresh models, harness readiness | "New chat" form | Home composer pickers; Settings → Harnesses | Present |
| Conversation search over saved native history, full answers | `ConversationViewport.svelte` | `Transcript.svelte` (`Mod+F`, "Show full answer") | Present |
| Model and thinking for a running chat | `RuntimePicker.svelte` | `RuntimeChip.svelte` | Present |
| Approvals from every project | Approvals inspector | Inbox, chat approval cards | Present |
| Active and failed chats | Activity inspector | Inbox ("Working now", "Failed"), sidebar dots | Present |
| Session details: harness, status, model, capabilities | Details inspector | Chat details panel | Present |
| "History revision" field | Details inspector | — | Dropped (internal jargon, UI_STYLE) |
| Rename, close native session, delete chat | Details inspector, delete dialog | Chat title (double-click), chat menu, details panel, delete dialog | Present |
| Systems, runs, schedules and the library (agents, teams, pipelines) | Workspace view (`OrchestrationPanel`) | Pipelines, Runs, Automations, Library menu | Present |
| Unsaved editor guard | Discard dialog | Pipeline editor guard dialog | Present |
| Settings: language and appearance | `WorkspaceSettings.svelte` | Settings → General | Present |
| Keyboard: new chat, settings, search, stop, Escape | Global handler | Same shortcuts (`Mod+.` stops) | Present |
| `Mod+B` toggles the navigation | Global handler | Narrow layout drawer button | Dropped (the new shell keeps the sidebar visible on desktop widths) |
| Skip link, narrow layout | Shell | Shell | Present |

## Gaps before deleting the classic code

1. ~~**Continue an indexed Pi session live.**~~ Closed on `feat/session-tools`:
   the versioned `workspace_adopt_v1` command `{ projectId?, sessionId }`
   (absent `projectId` = personal) resolves the index session to its
   host-private JSONL in a trusted folder outside safe mode with the classic
   admission checks (`admit_session_revision` plus revalidation, root
   overlap), refuses Prime Agent folders, a session the classic live runtime
   holds and one written in the last 10 s (`SESSION_ALREADY_ACTIVE`), returns
   the existing workspace session bound to that file or registers a Pi
   workspace session bound to it, and the ordinary `openSession` resumes it
   without `--name`. The history reader has "Continue in PiUI". Concurrent CLI
   and PiUI writers stay risk R-06.
2. **Pi slash-command discovery** — done in the composer
   (`workspace_composer_inputs_v1` `catalog` over the bridge's
   `get_commands`, merged with PiUI's commands); the palette still lacks it.
3. ~~**Tier 1A contributions**~~ — closed by plugins v1 (ADR-032): the new
   shell reads `list_piui_contributions` lazily for Pi chats and projects its
   commands into Ctrl+K and its composer actions above the message box
   through the plugin command registry (`app/plugins/pluginRegistry.svelte.ts`);
   choosing one prepares `/<command> ` for review and never sends it.

Known limitation (shared with the classic view): the host redacts anything
that looks like an absolute path in extension text, so prepared composer text
that starts with a slash command (`/review …`) shows as `<external-path>/review …`.

## What the deletion must keep

Shared modules used by the new shell: `features/runtime/extensionUiState.ts`
(extension surface reducer), `features/sessions/timelineView.ts` and
`catalogView.ts`, `features/workspace/workspaceState.ts`,
`components/MarkdownContent.svelte`, `host-api/types.ts` (index DTOs).

Host routes the new shell calls (all existing, unchanged): `bootstrap_v10`,
`update_preferences_v8`, `pick_and_add_project_v10`, `set_project_trust`,
`rename_project`, `set_project_pinned`, `remove_project`,
`get_session_catalog`, `get_personal_session_catalog`,
`refresh_session_catalog`, `refresh_personal_session_catalog`,
`get_timeline_page`, `get_personal_timeline_page`, `search_sessions`,
`list_extensions_v10`, `set_extension_enabled_v10`, and the
`piui://session-catalog` / `piui://session-root-hint` events. New in this
change: the `piui://workspace-extension-ui` event
([contracts/workspace-extension-ui-v1.ts](../contracts/workspace-extension-ui-v1.ts)).
Gap 1 added `workspace_adopt_v1`
([contracts/workspace-adopt-v1.ts](../contracts/workspace-adopt-v1.ts)).

Classic-only routes that can go with the classic code once the gaps are
closed: the classic live runtime (`start_runtime`, `start_personal_chat`,
`send_*`, `abort_runtime`, `stop_live_runtime`, `get_runtime_*`,
`set_runtime_*`, `respond_extension_ui`, `piui://runtime-event`), fake
runtimes (`run_fake_scenario`, `start_fake_runtime`, `stop_runtime`), legacy
v8/v9 duplicates (`bootstrap`, `update_preferences`, `list_extensions`,
`set_extension_enabled`, `add_project`, `pick_and_add_project`), cache-only
lists (`list_sessions`, `list_personal_sessions`, `get_timeline`), `get_tree`
and `get_personal_tree` (the new shell reads the tree from the timeline page),
and `probe_system_runtime`. `list_piui_contributions` stays: the new shell
uses it for Tier 1A (gap 3).

## UI Lab walkthrough

Run the lab (`pnpm --filter @piui/desktop dev`, `?lab=demo`):

1. Sidebar → `piui` → "…" → "Pi session history": "Make the session index
   incremental" has three branches (details → Branches), "Walk through the
   orchestration store migration" pages older history, "Rename the catalog
   watcher" is partly readable, "Draft release notes" shows extension,
   compaction and unknown entries. Type "migration" in the filter while
   `video-studio` history is open to see "In other folders". Personal chats
   history lives under the "Personal chats" row menu.
2. Chat "Pi extension playground" (`piui`): send `/extension-demo`. Expect a
   notice, two status chips, a checklist panel above and a tip panel below
   the message box, the window title "Extension demo — PiUI", an unsupported
   notice, prepared text, and four approval cards in turn: confirm, choose,
   short answer, and an editor with prefilled text and a timeout note.
3. Settings → Extensions: Pi and Prime Agent inventories with switches.
4. Sidebar project menu: Rename…, Pin to top, Remove from PiUI… (blocked while
   `piui` has running chats).
5. Settings → About → "Classic view": opens `?view=legacy` or `?view=classic`;
   their Settings → "New interface" returns.
6. `?lab=safe`: history and the extension list stay readable; project removal
   is unavailable.
7. `piui` history → "Make the session index incremental" → "Continue in PiUI":
   the chat opens in the sidebar and resumes; "Draft release notes for 0.2.0"
   is refused as still open in the terminal.
