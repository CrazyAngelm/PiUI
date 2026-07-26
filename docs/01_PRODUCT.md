# 01. Product Requirements Document

## 1. Purpose

PiUI is a local desktop shell on top of the Pi agent harness. It organizes existing working folders as projects, shows their associated Pi sessions, and provides a chat-first interface for continuing work. The product core is deliberately small: project and session management, chat, agent activity display, basic settings, and an extension point.

PiUI does not compete with Pi and does not create an alternative ecosystem. A single Pi package can contain standard Pi extensions/skills/prompts/themes and an additional UI description for PiUI.

## 2. Product formula

> **Existing Pi + existing user files + a minimal graphical shell + versioned UI contributions.**

### 2.1 Why this aligns with the Pi philosophy

Pi explicitly positions itself as a set of primitives rather than a predefined workflow. Sessions have a tree-based history, and extensions can register tools, commands, events, and TUI components. Therefore, PiUI must add interface primitives rather than build specific methodologies such as plan mode, subagents, worktrees, or an approval framework into the core.

### 2.2 Product principles

1. **Local first.** Sessions, settings, and projects remain local. Model providers may be remote, but PiUI has no cloud backend of its own.
2. **Same Pi everywhere.** The CLI and PiUI share configuration and sessions.
3. **Progressive disclosure.** Only actions for the current work are visible on the main screen; complex information is revealed on demand.
4. **Fast path first.** Add a folder → open a chat → send a message must take the fewest possible actions.
5. **Extension over accumulation.** A specialized capability is designed first as an extension contribution.
6. **Honest security.** Trust is not called a sandbox; the user sees that Pi and backend extensions run with their OS permissions.
7. **Graceful degradation.** Unknown tool calls, custom messages, and disabled UI extensions remain readable.
8. **Keyboard and mouse parity.** Primary flows are fully accessible by keyboard but do not require memorizing commands.

## 3. Target users

### 3.1 Primary: developer already using Pi

Needs a visual manager for multiple projects and sessions without losing CLI configuration, tools, extensions, or history.

### 3.2 Secondary: user who prefers a GUI

Wants to use Pi without constantly navigating the terminal TUI, see images and structured tool activity, and easily return to chats.

### 3.3 Extension author

Wants to extend Pi behavior and add UI with one package: a renderer for their tool, a composer button, settings, a sidebar view, or even an alternative shell.

### 3.4 Maintainer

Needs a narrow core, stable contracts, reproducible bugs, safe mode, and the ability to update Pi independently of the UI.

## 4. Jobs to be done

- When I have several working folders, I want to quickly see active Pi sessions and their status.
- When I continue a session from the CLI, I want to find it in PiUI without import or conversion.
- When the agent runs for a long time, I want to switch to another chat and see the result later.
- When an extension requests confirmation or input, I want to respond through a normal GUI dialog.
- When a tool returns a complex result, I want to see a convenient renderer without losing raw data.
- When a project is unfamiliar, I want to explicitly decide whether to load its extensions/settings.
- When a UI extension crashes, I want to continue the chat without losing the session.

## 5. Terms

- **Project** — a canonical path to an existing folder registered in PiUI.
- **Session** — the original Pi JSONL file and its tree of entries.
- **Active branch** — the path from the session tree root to the current `leafId`.
- **Runtime** — a running Pi RPC process serving one open/running session.
- **Dormant session** — a session without a running process; its metadata is available from the index.
- **Pi extension** — a TypeScript module loaded by Pi itself.
- **PiUI extension** — a UI contribution from the same or a separate package, loaded by PiUI.
- **Package** — a Pi package distributed through npm/git/local sources with `pi` and, optionally, `piui` keys.
- **Generic fallback** — a safe standard display for an unknown payload.
- **Managed Pi** — a pinned compatible Pi distribution shipped with PiUI or its runtime installer.
- **System Pi** — the user-installed `pi` command.

## 6. Product scope

### 6.1 Core 1.0

- A registry of project folders.
- Pi session list by project.
- New chat; open and continue an existing chat.
- Simultaneous work in several sessions with a concurrency limit.
- Streaming text/thinking/tool activity.
- Stop, steer, follow-up, and queue.
- Provider/model and thinking-level selection from Pi data.
- Image input and inline image display.
- A file-attachment adapter without inventing a binary protocol.
- Session rename, export, fork/clone; branch tree — read-only, navigation after the RPC gap is closed.
- Settings and runtime diagnostics.
- Project trust.
- Tier 0 and Tier 1/Tier 2 PiUI extensions.
- Search over a local rebuildable index.
- Safe mode and crash recovery.
- Windows/Linux packaging; a macOS-ready codebase.

### 6.2 Intentionally outside core 1.0

- Git status, diffs, commits, worktrees.
- An IDE or full file explorer.
- Embedded terminal.
- Subagent orchestration dashboard.
- Plan mode.
- Permissions framework for model actions.
- MCP registry.
- Remote SSH/containers UI.
- Cloud sync/accounts/teams.
- Extension marketplace and automatic package publishing.
- Voice mode.

These capabilities are allowed as extensions; the core provides slots and host capabilities.

## 7. Functional requirements

### 7.1 Project registry

| ID | Requirement | Priority |
|---|---|---|
| PRJ-001 | The user adds an existing folder through the system folder picker. | Must |
| PRJ-002 | The path is canonicalized with platform symlink/case rules; duplicates are not created. | Must |
| PRJ-003 | A project can be renamed only in the UI registry; the folder name on disk is not changed. | Must |
| PRJ-004 | A project can be pinned/unpinned and hidden from the registry without deleting the folder or Pi sessions. | Must |
| PRJ-005 | An unavailable path is shown as offline/missing; the record is not removed automatically. | Must |
| PRJ-006 | Dragging a folder onto the sidebar offers to add it as a project. | Should |
| PRJ-007 | Project-level Pi resources are loaded only after trust resolution. | Must |
| PRJ-008 | The user can open the folder in the system file manager and copy its path. | Should |
| PRJ-009 | Nested projects are allowed as separate entries; PiUI warns about overlapping trust scope. | Should |

### 7.2 Session discovery and lifecycle

| ID | Requirement | Priority |
|---|---|---|
| SES-001 | PiUI discovers existing Pi session JSONL files for the canonical project path. | Must |
| SES-002 | A session created/modified by the CLI appears after a filesystem event or manual refresh without import. | Must |
| SES-003 | The list contains display name, fallback title, last activity, runtime status, and branch indicator. | Must |
| SES-004 | A new chat is created through the Pi runtime, not by manually creating JSONL. | Must |
| SES-005 | Opening a dormant session starts the runtime on demand and loads the required session file. | Must |
| SES-006 | Switching the UI does not stop a running session; an idle inactive runtime can be unloaded by TTL. | Must |
| SES-007 | Session rename uses Pi RPC `set_session_name`. | Must |
| SES-008 | Delete uses the OS trash, after confirmation and only for the selected `.jsonl`; permanent delete is hidden under Advanced. | Must |
| SES-009 | Export uses Pi `export_html`; raw JSONL copy is available as a separate action. | Must |
| SES-010 | Fork/clone use Pi RPC and are reflected in the sidebar. | Must |
| SES-011 | Full tree view displays all branches and labels; navigation to an arbitrary node is enabled only with a supported runtime capability. | Should/blocked |
| SES-012 | A runtime crash does not corrupt the session file; the user sees restart/resume. | Must |
| SES-013 | Header-only/empty sessions do not clutter the list: they are grouped or removed only by a provable ownership rule. | Should |
| SES-014 | The session list does not require starting a runtime for every session. | Must |

### 7.3 Chat timeline

| ID | Requirement | Priority |
|---|---|---|
| CHT-001 | User, assistant, thinking, tool call/result, bash, compaction, retry, error, and custom messages are displayed. | Must |
| CHT-002 | Streaming updates are batched; the UI does not rebuild all Markdown for every token delta. | Must |
| CHT-003 | Thinking is collapsed by default; the user can expand a specific block. | Must |
| CHT-004 | Tool call and result are visually combined into one card with running/success/error/cancelled state. | Must |
| CHT-005 | The generic tool card shows tool name, arguments, result summary, and raw JSON/text on expansion. | Must |
| CHT-006 | Tool output does not execute HTML/JS or open links automatically. | Must |
| CHT-007 | A custom renderer cannot hide access to the raw payload. | Must |
| CHT-008 | The user can copy message text, a code block, tool output, and a permalink/entry ID. | Should |
| CHT-009 | Long conversations virtualize off-screen content without jumping the scroll anchor. | Must |
| CHT-010 | While reading history, new streaming events do not forcibly scroll down; “New activity” is shown. | Must |
| CHT-011 | A provider/retry error is displayed inline with clear state, not as a disappearing toast. | Must |
| CHT-012 | Compaction is shown as an unobtrusive divider; details are available on expansion. | Should |
| CHT-013 | Images from message content render inline with fit/zoom/open/copy path where applicable. | Must |
| CHT-014 | An unknown message/entry type is shown in a generic inspector rather than lost. | Must |

### 7.4 Composer and queues

| ID | Requirement | Priority |
|---|---|---|
| CMP-001 | The multiline composer supports regular text, slash commands, path suggestions, and attachments. | Must |
| CMP-002 | In idle state, `Enter` sends and `Shift+Enter` creates a line; hotkeys are configurable. | Must |
| CMP-003 | During a run, the user explicitly chooses `Steer` or `Follow up`; the selected behavior is visible before sending. | Must |
| CMP-004 | The Send button becomes Stop only for an active run; the queued composer remains available. | Must |
| CMP-005 | The pending queue is shown as chips/list; items can be removed before delivery if Pi capability permits it; otherwise the UI honestly reports the limitation. | Should |
| CMP-006 | `get_commands` powers autocomplete for extension commands, prompts, and skills. | Must |
| CMP-007 | Built-in TUI commands unavailable through RPC are not offered as executable. | Must |
| CMP-008 | `set_editor_text` from an extension replaces/inserts composer content with protection against accidental loss of unsaved text. | Must |
| CMP-009 | A draft is saved locally per session and cleared only after an accepted prompt. | Must |
| CMP-010 | The composer does not send an empty prompt without an attachment/command. | Must |

### 7.5 Models and thinking

| ID | Requirement | Priority |
|---|---|---|
| MOD-001 | The model picker is populated through `get_available_models`, not from a hardcoded list. | Must |
| MOD-002 | Current model/thinking state is taken from `get_state`. | Must |
| MOD-003 | Switching uses `set_model`; errors are shown next to the picker. | Must |
| MOD-004 | Thinking options are taken through `get_available_thinking_levels`. | Must |
| MOD-005 | The picker shows provider, display name, input modalities, and context window when available. | Should |
| MOD-006 | Changing model during an incompatible state is blocked or queued according to Pi's actual response. | Must |
| MOD-007 | PiUI does not create its own price list; it shows only cost metadata received from Pi, marked as an estimate. | Must |
| MOD-008 | An unauthorized provider leads to the Settings/Auth flow, not manual JSON editing in the main UI. | Must |

### 7.6 Attachments

| ID | Requirement | Priority |
|---|---|---|
| ATT-001 | PNG/JPEG/WebP/GIF, when supported by the selected model, are encoded and passed through RPC `images`. | Must |
| ATT-002 | An image has preview, MIME/size validation, and a remove action before sending. | Must |
| ATT-003 | A file inside the project root is passed to the agent as a canonical relative path in a structured text preamble; its content is not duplicated automatically. | Must |
| ATT-004 | An external file requires an explicit choice: reference the original path or copy into the managed project attachment area. | Must |
| ATT-005 | Copy uses a content hash, collision-safe filename, and provenance metadata; the source is not removed. | Must |
| ATT-006 | PDF/doc/archive files are not promised as “understood” by the model: PiUI passes the path and allows Pi/tool/extension to read or convert the file. | Must |
| ATT-007 | Directories are not attached as binary objects; a path reference is inserted. | Must |
| ATT-008 | Attachment size limits are configurable; an oversized image offers downscale/cancel without silently changing the original. | Should |
| ATT-009 | For a model without image input, Send is blocked for an image-only prompt and offers changing the model or using a path reference. | Must |
| ATT-010 | Attachment history in the UI is restored from message image blocks and PiUI metadata, but session validity does not depend on metadata. | Must |

### 7.7 Extension compatibility

| ID | Requirement | Priority |
|---|---|---|
| EXT-001 | A standard Pi extension is loaded by Pi itself without rewriting it for PiUI. | Must |
| EXT-002 | `select/confirm/input/editor` are displayed as modal UI and return a matching response. | Must |
| EXT-003 | `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text` have defined displays. | Must |
| EXT-004 | TUI-only APIs are not simulated with false promises; extension diagnostics indicate degradation. | Must |
| EXT-005 | A Pi package can declare `piui.manifest.json` with contributions and permissions. | Must for 1.0 |
| EXT-006 | An unknown/missing UI extension does not break a backend Pi extension. | Must |
| EXT-007 | Declarative contributions do not execute arbitrary JS. | Must |
| EXT-008 | Rich views run in a sandboxed frame/worker and communicate only through the capability host API. | Must |
| EXT-009 | Full shell replacement is allowed only for an explicitly trusted global package after restart. | Should for 1.0 |
| EXT-010 | Safe mode disables all PiUI packages and project-local Pi resources. | Must |
| EXT-011 | The extension API has semantic version/capability negotiation and compatibility errors. | Must |
| EXT-012 | An extension can contribute settings, commands, status items, composer actions, sidebar/panel views, tool/message/preview renderers, and an optional shell. | Must |
| EXT-013 | A project UI package never receives network/workspace-write/session-command capability without manifest permission and user grant. | Must |
| EXT-014 | Development mode supports reloading a UI package without restarting the entire app, except shell replacement. | Should |

### 7.8 Settings and authentication

| ID | Requirement | Priority |
|---|---|---|
| SET-001 | Settings are available via a button at the top of the sidebar and the command palette. | Must |
| SET-002 | Sections: General, Runtime, Models & Auth, Extensions, Appearance, Keybindings, Security, Advanced/Diagnostics. | Must |
| SET-003 | PiUI settings are stored separately; Pi settings are changed only through a supported adapter with atomic write/validation. | Must |
| SET-004 | OAuth/subscription login, until a headless API exists, is launched through a controlled interactive Pi flow; the result remains in the standard Pi auth store. | Must |
| SET-005 | The API key field masks the value, never reads an existing secret back into the UI, and writes it through a trusted backend flow. | Must |
| SET-006 | The Runtime page shows selected mode, path, version, capabilities, stderr diagnostics, and “Test runtime”. | Must |
| SET-007 | The Extensions page distinguishes global/project, Pi backend/PiUI frontend, trusted/disabled/error states. | Must |
| SET-008 | Advanced settings are hidden by default and include reset-to-default. | Must |
| SET-009 | The default theme follows the OS; light/dark and density are available without restart. | Should |
| SET-010 | Keybindings detect conflicts before saving. | Should |

### 7.9 Search and navigation

| ID | Requirement | Priority |
|---|---|---|
| NAV-001 | Search finds projects, session names, first user text, and message text from the local index. | Must for 1.0 |
| NAV-002 | A search result opens the session and scrolls to the entry if the entry is available on the active branch; otherwise it opens tree context. | Should |
| NAV-003 | The command palette opens project/session/settings/actions. | Must |
| NAV-004 | Back/forward navigation restores project/session/panel state but does not control runtime history. | Should |

### 7.10 Notifications and lifecycle

| ID | Requirement | Priority |
|---|---|---|
| LIF-001 | Background session completion is marked with a badge; OS notification is optional. | Must |
| LIF-002 | Closing the window with running sessions offers leaving the app in the tray, stopping tasks, or cancelling close. | Should |
| LIF-003 | App exit correctly terminates owned idle runtimes; running processes do not remain orphaned without an explicit policy. | Must |
| LIF-004 | After a PiUI crash, project/session selection is restored and the session source of truth is reread. | Must |
| LIF-005 | An app update never starts during an unfinished write/migration without a safe restart flow. | Must |

## 8. Non-functional requirements

### 8.1 Performance

Target budgets are given in the testing document. Key requirements:

- first paint does not wait for network/auth/model refresh;
- dormant sessions have no processes;
- idle app CPU is close to zero;
- timeline is virtualized;
- streaming is batched;
- extension sandbox is lazy-loaded;
- the search index updates incrementally and has backpressure.

### 8.2 Reliability

- append-only Pi sessions are not modified by the indexer;
- a partial JSONL line is not considered corruption;
- process crash and extension crash are isolated from the WebView;
- IPC requests have IDs, timeout, and cancellation;
- migrations are transactional, rollbackable, and backed up;
- capability mismatch yields an actionable error.

### 8.3 Accessibility

- WCAG 2.2 AA as the target level;
- full keyboard flow;
- semantic landmarks, focus management, reduced motion, screen-reader live regions for streaming without spam;
- minimum 44×44 CSS px for touch targets where applicable, while desktop density permits compact visual sizes with a sufficient hit area;
- status is not conveyed by color alone.

### 8.4 Privacy

- telemetry is off and absent by default;
- a crash report is created locally and sent only after preview/consent;
- logs are redacted;
- extensions declare network domains;
- external links open in the system browser.

### 8.5 Compatibility

- Windows and Linux are release blockers;
- macOS code path is in CI from an early stage;
- Pi protocol compatibility matrix, not “latest only” without verification;
- unknown RPC events are retained in diagnostics and do not crash the parser.

## 9. Success metrics

A public release is successful when:

1. 95% of CLI→PiUI→CLI test fixtures retain the same active branch and readable history.
2. Crash-free sessions are >99.5% in opt-in aggregate, or equivalent local test telemetry for pre-release.
3. Median time from add project → first accepted prompt is less than 60 seconds for a new user and less than 15 seconds for configured Pi.
4. Idle RSS and startup meet budgets on both Tier-1 platforms.
5. At least three fixture packages demonstrate: a generic Pi extension, a declarative UI package, and a sandboxed rich renderer.
6. Safe mode opens after an intentionally broken shell extension.
7. No test requires conversion of session JSONL into a proprietary chat file.

## 10. Release gates

- All Must requirements have a test or a documented manual acceptance procedure.
- No open P0/P1 data-loss/security bugs.
- Runtime compatibility tested with minimum, pinned, and latest-supported Pi versions.
- Windows/Linux installers are signed where infrastructure permits and verified for clean-machine install/update/uninstall.
- Third-party licenses/NOTICE are collected automatically.
- Threat model reviewed after implementing the extension host.
- Accessibility audit performed keyboard-only and with at least one screen reader on each Tier-1 OS family.
