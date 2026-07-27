# Changelog

All notable changes to PiUI are documented here.

PiUI is currently a developer preview. Versions before 1.0 may change without a stable migration promise; changes to typed host contracts remain versioned under `contracts/`.

## [Unreleased]

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
