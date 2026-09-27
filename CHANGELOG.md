# Changelog

All notable changes to PiUI are documented here.

PiUI is currently a developer preview. Versions before 1.0 may change without a stable migration promise; changes to typed host contracts remain versioned under `contracts/`.

## [Unreleased]

### Added

- Plugin manifest version 2 (version 1 still works unchanged): status-bar items and keyboard shortcuts for a plugin's own commands. PiUI's shortcuts always win, and Settings → Plugins shows every conflict. New example `status-tools`; `pnpm create-plugin` writes version 2.
- MCP tool servers from plugins: once you offer one in Settings → Plugins, new Claude Code, Hermes and ACP agent chats get it for that chat only, started under the same Node.js limits as plugin backends. Your harness settings are never changed; Codex, Pi, Prime Agent and pipeline runs never get plugin servers.
- Chat renderers from plugins: a plugin can show chosen tool calls in its own sandboxed view inside the chat. The plain view is always one click away and takes over when the plugin is off or its view fails. New example `tool-cards`.
- A dialog whose content scrolls can now be scrolled with the keyboard.

### Fixed

- `pnpm contract:test` in the desktop app runs every contract test again: a duplicated script entry had dropped five of them.

### Security

- The guard against the app window showing the plugin panel origin now also covers macOS and Linux: such a page is sent back to the app as soon as it starts loading (Windows still refuses the navigation before it starts), PiUI's own commands refuse calls from it on every platform, and plugin files other than panel pages are served with a sandbox policy.
- Plugin backends run under Node's permission model: a backend reads its own package, reads and writes its data folder, reaches a project folder only with `project.read` / `project.write`, and never starts other programs or worker threads; network access is blocked without `network` when the Node.js in use can block it. Node.js older than 22.13 no longer starts plugin backends. The trust review shows the exact flags and what is enforced, and still says that plugins are trusted code, not a sandbox.

## [0.2.2] - 2026-09-27

### Security

- On Windows the app window refuses to navigate to the plugin panel origin, so a top-level document there can never receive the app's IPC bridge. Panel frames are unaffected.

## [0.2.1] - 2026-09-27

### Added

- Composer attachments: images go to Codex, Claude Code, Pi and Hermes when the harness and model accept them; other files are inserted as path references after a confirmation, never copied into the project. `@` mentions list project files (respecting `.gitignore`), `$` mentions list Codex skills, and the `/` menu shows each harness's own commands.
- Session tools: a git review panel (stage, unstage and revert per hunk or file with the exact reviewed patch; untracked files go to the system trash), chats in their own git worktree, "Continue in another harness" with an editable handoff, and "Continue in PiUI" for a Pi session started in the terminal.
- Plugins v1: installable packages with a trust review, contained Node backends, sandboxed chat panels, palette commands and composer actions, plugin pipeline nodes (orchestration v6.5), themes, templates and ACP agents; a plugin SDK, `pnpm create-plugin` and four examples. Pi Tier 1A commands now appear in the new interface.

### Fixed

- The new-chat composer keeps the chosen harness and model when the catalog refreshes.

## [0.2.0] - 2026-09-27

PiUI is now a desktop workbench for native agent harnesses and multi-agent pipelines, not only a shell for Pi sessions. Harnesses still own inference, tools, credentials and history; PiUI never adds its own agent loop or provider client.

### Harnesses and chat

- New default interface: a sidebar with projects and their chats, Inbox, Pipelines, Runs, Automations and Settings; a composer-first home; a Ctrl+K command palette; dark and light themes; English and Russian copy (Russian loads on demand).
- One chat surface for Codex (app-server 0.147.x–0.157.x), Claude Code (2.1 or a later 2.x release), Pi, Hermes (0.21.0) and Prime Agent (0.9.2–0.9.3), with a harness → model → reasoning picker that uses each harness's own catalog.
- Claude Code runs only on the user's Claude subscription: PiUI starts the installed `claude`, removes API-key and cloud-provider variables, refuses other sign-in methods, keeps fast mode off and stops a session that reports paid extra usage. The composer shows the sign-in status before the first message.
- Codex-style transcript: activity summaries, typed tool rows, unified diffs, inline approvals, Codex MCP form requests as approval cards, a message queue with steer and follow-up, slash commands and in-chat search (Ctrl+F).
- Settings sections for General, Harnesses, Extensions (separate Pi and Prime Agent inventories), Projects (rename, pin, remove, trust), Shortcuts and About. Read-only Pi and Prime history from the index keeps paging, cross-folder search and a branch summary.

### Pipelines, runs and automations

- Pipeline editor on Svelte Flow: agent and router nodes, typed result, route, message, observation and delegation connections, templates (chain, parallel, orchestrator, review loop, router), undo/redo, automatic layout, checks, save and run.
- Run inputs (`{{input.name}}` with a typed start form) and review-loop limits that wait for a person at the limit.
- One-shot model-call nodes and host-run script nodes (Node.js, Python, PowerShell) with a code editor, a "Test script" action and a visible "not a sandbox" warning; a node changes between agent, model call and script in one undoable step.
- A read-only pipeline assistant proposes whole-graph changes that are checked before they apply.
- Runs view: a run canvas with recorded step states, live activity, a step panel (result, conversation, inputs, attempts, usage) and operator actions (approve, reject, run again from a step, cancel, retry, record an outcome).
- Automations: one-time, interval and day-of-week schedules (DST-safe) that start pipelines while PiUI is open; each schedule is turned on separately.

### Reliability

- Native starts no longer hold a global gate, event bursts apply backpressure instead of failing the queue, orchestration reads run off the UI thread and manual runs resume after a restart.
- The browser UI Lab (`pnpm --filter @piui/desktop dev`) answers every host command with a deterministic in-memory fake, with `demo`, `empty`, `safe` and `long` scenarios.
- The previous interface stays reachable from Settings → About (`?view=legacy`) for this release and is removed in the next one.

### Release engineering

- Signed automatic updates are built in but stay off until a release is built with an updater public key and endpoint. Settings → About then shows the version, "Check for updates", release notes and "Download and restart" with a confirmation. The Tauri updater verifies every download against the built-in public key before installing, and background checks happen only after the user turns on "Check for updates automatically" (off by default).
- The release workflow builds Windows (NSIS installer and portable executable), Linux (`.deb` and AppImage) and experimental macOS (universal `.dmg`) packages with SHA-256 checksums, Authenticode signing when a certificate is provided, and a signed update feed when the updater key is provided. Releases stay GitHub pre-releases until the Windows build is code-signed.
- `pnpm repo:check` now fails when the declared PiUI versions disagree or the changelog has no entry for the current version.

### Foundation work since 0.1.1

- Added Host Protocol v10 with explicit Pi versus Prime Agent 0.8.1 project kinds, separate session roots and global extension inventories, bounded future Prime activity contracts, and a Pi-only v9 compatibility surface.
- Added read-only Prime root-session catalogs with multiple distinct sessions per project. Prime live start/continue/prompt/stop now fails closed because 0.8.1 uses a shared detached daemon that the per-runtime supervisor cannot safely own without risking other clients.
- Bounded Prime activity snapshots and UI helper retention to the established 256-event runtime queue, and drop raw `bash_output` chunks before event-channel backpressure while retaining typed terminal summaries.
- Added the missing v10 folder-picker contract, replaced Prime native handshake IDs with opaque catalog IDs at start/event DTO boundaries, and made global extension toggles await and verify runtime settings persistence for both managers.
- Upgraded the static Prime spike to hash the actual `dist/bundle/cli.js` literal local import closure (40 files in the measured 0.8.1 install) and record shared-daemon live control as unauthorized.
- Added a passing repository-target-only Windows Tauri E2E harness. A feature-gated debug-only exact-origin loopback driver replaces unavailable WebView2 CDP, and an outside-Job controller proves an empty Job before bounded fixture removal. The Linux WebKit E2E gate remains open.
- Re-baselined the emitted frontend asset smoke gate to 260 KiB and recorded the current v10 build at 259,817 bytes (6,423 bytes headroom); public 1.0 performance gates remain open.

## [0.1.1] - 2026-07-27

- Added typed Extension UI Protocol v9, a bounded host-side dialog mailbox, declarative contribution discovery, and safe contribution projection for Pi extensions.
- Added runtime command discovery, keyboard slash-command completion, provenance-aware command palette entries, and composer command actions that only draft invocations.
- Replaced the native model control with an accessible, theme-owned searchable picker grouped by provider; unavailable current models remain visible rather than silently changing selection.
- Fixed personal new-chat reconciliation: a selected transient row now resolves to the first durable Pi session without a false persistence error or manual sidebar navigation.
- Added explicit extension fallback, compatibility, command-collision, and new-chat regression coverage; documented the measured frontend asset-budget re-baseline.

## [0.1.0] - 2026-07-26

- Published the initial MIT-licensed public source repository with contribution, security, conduct, issue, and pull-request policies.
- Added an English-first README, a complete Russian README, and English product, architecture, security, testing, and release documentation.
- Added the first unsigned Windows x64 developer-preview release path: an NSIS installer, portable executable, and SHA-256 checksums.
- Replaced the placeholder desktop icon with the PiUI application icon and generated desktop platform assets.
- Added repository privacy auditing, CI, Dependabot, and tag-driven GitHub release automation.
- Added persistent appearance preferences for theme, density, reduced motion, chat text size, and conversation width.
- Added cache-first session discovery, bounded transcript rendering, explicit project trust, personal chats, and typed local Pi RPC streaming.
- Added safe rebuildable indexing, versioned host contracts, extension manifest validation, fake runtime scenarios, and platform/security foundations.

[Unreleased]: https://github.com/CrazyAngelm/PiUI/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/CrazyAngelm/PiUI/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/CrazyAngelm/PiUI/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/CrazyAngelm/PiUI/releases/tag/v0.1.0
