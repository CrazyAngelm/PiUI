# Changelog

All notable changes to PiUI are documented here.

PiUI is currently a developer preview. Versions before 1.0 may change without a stable migration promise; changes to typed host contracts remain versioned under `contracts/`.

## [Unreleased]

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

[Unreleased]: https://github.com/CrazyAngelm/PiUI/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/CrazyAngelm/PiUI/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/CrazyAngelm/PiUI/releases/tag/v0.1.0
