# PiUI — release readiness checklist

This checklist blocks public 1.0. An item may be checked only with a link to an automated test, CI artifact, ADR, or signed manual-test report.

## 1. Product scope

- [ ] Only features included in `docs/01_PRODUCT.md` are implemented; scope creep is moved to extensions or the backlog.
- [ ] A user can add an existing folder, create and continue a Pi session, close PiUI, and open the same history in the Pi CLI.
- [ ] Projects and sessions do not depend on a cloud account or network.
- [ ] Empty, loading, offline, permission-denied, missing-runtime, crashed-runtime, and corrupted-index states have explicit UX.
- [ ] Every irreversible action has a warning or recoverable trash flow.

## 2. Pi runtime and compatibility

- [ ] All Phase 0 spikes from `docs/09_ROADMAP_AND_TASKS.md` are complete.
- [ ] Minimum, recommended, and maximum verified Pi versions are recorded.
- [ ] Capability negotiation is verified by integration tests; version is not used as the only source of capabilities.
- [ ] RPC stdout is parsed only as a protocol; stderr is kept separate and does not break the parser.
- [ ] Partial lines, invalid JSON, unknown event types, and out-of-order completion are handled without crashing the shell.
- [ ] Stop, steer, follow-up, compaction, retry, and runtime crash pass recovery tests.
- [ ] Simultaneously opening one session in the CLI and PiUI is either safely supported or explicitly blocked by a lock mechanism.
- [ ] Exiting PiUI leaves no orphaned Pi/tool processes on Windows, Linux, or macOS.

## 3. Data and sessions

- [ ] Pi JSONL remains the source of truth; PiUI does not rewrite it directly.
- [ ] Deleting the PiUI SQLite database does not delete or corrupt Pi sessions.
- [ ] The index is fully rebuildable from the project registry and session files.
- [ ] Atomic writes, migrations, backups, and rollback migrations are covered by tests.
- [ ] Symlink/junction/case-sensitivity/path-length/Unicode edge cases are verified across platforms.
- [ ] Rename, archive/trash, export, and import have unambiguous semantics and do not create ghost sessions.
- [ ] Secrets, prompts, tool results, and user paths do not enter telemetry by default.

## 4. Attachments and rendering

- [ ] Images follow the official Pi RPC path and render correctly in history.
- [ ] Ordinary files are passed as explicit path/resource references; the UI does not falsely imply that Pi received a binary upload.
- [ ] Managed-copy mode, when enabled, shows the destination path, size, and deletion rules.
- [ ] Large images, SVG, malformed media, missing files, and external paths are handled safely.
- [ ] Markdown, code blocks, links, tool cards, and extension output are protected against script injection and unsafe URL schemes.
- [ ] An unknown custom entry/renderer has a universal raw-data fallback.

## 5. Extension SDK

- [ ] A backend-only Pi extension works without `piui.manifest.json`.
- [ ] The manifest is schema-validated before loading; an incompatible version is rejected with a clear diagnostic.
- [ ] Declarative contributions pass deterministic ordering, collision handling, and lifecycle tests.
- [ ] Rich views run in isolation and do not receive the Tauri/shell/filesystem API directly.
- [ ] Every host capability is granted separately, visible to the user, and revocable.
- [ ] A project-local UI package does not execute before a trust decision.
- [ ] Full-shell replacement is available only to a trusted global package.
- [ ] Safe mode starts before extension UI loads and cannot be hidden or overridden by an extension.
- [ ] An extension crash loop, timeout, memory abuse, or invalid messages do not crash the core shell.
- [ ] The reference package from `examples/minimal-piui-package/` passes contract tests.

## 6. Security and privacy

- [ ] The threat model in `docs/07_SECURITY.md` is reviewed before the release candidate.
- [ ] Frontend CSP prohibits inline/eval and arbitrary remote origins.
- [ ] Tauri commands are allowlisted; argument validation and path authorization reside in the Rust host.
- [ ] The WebView has no general shell API, unrestricted filesystem, or raw process spawning.
- [ ] Remote content receives no privileged origin.
- [ ] The OAuth/login flow does not pass credentials through the DOM, logs, or extension messages.
- [ ] Logs have redaction, a retention policy, and an explicit export flow.
- [ ] Dependency/SBOM/license/audit checks pass in CI.
- [ ] Update artifacts are signed; downgrade and compromised-update scenarios are tested.
- [ ] The security contact, vulnerability policy, and supported-version policy are published.
- [ ] A clean clone passes `pnpm repo:check`; the source tree and Git history contain no credentials, Pi sessions, agent artifacts, private paths, or generated local state, and `LICENSE`/NOTICE/package metadata are aligned.

## 7. Performance and resilience

- [ ] First-frame and usable-shell budgets from `docs/08_TESTING_AND_PERFORMANCE.md` pass on minimum reference machines.
- [ ] Shell RSS, each Pi runtime, extension hosts, and tool child processes are measured separately.
- [ ] Idle core-shell RSS does not exceed the release gate; any variance is documented only by an ADR and a new baseline.
- [ ] Idle CPU, token-to-paint p95, input latency, and scroll jank meet budgets.
- [ ] 10,000 message blocks are not rendered simultaneously; virtualization is confirmed by a profile.
- [ ] Startup and opening existing history do not require the network.
- [ ] Memory-leak soak testing, rapid session switching, long streaming, and repeated extension reload pass.
- [ ] Crash recovery neither loses confirmed Pi entries nor duplicates user prompts.

## 8. Accessibility and UX quality

- [ ] The complete primary flow is accessible by keyboard.
- [ ] Focus order, focus restoration, dialogs, menus, and screen-reader labels are verified.
- [ ] Contrast, reduced motion, 200% zoom, high-DPI, and narrow-window modes pass.
- [ ] Streaming updates do not create uncontrolled live-region announcements.
- [ ] Errors include a recovery action and diagnostic identifier but do not disclose secrets.
- [ ] The default UI remains minimal: optional panels do not open automatically.

## 9. Platform matrix

- [ ] Windows 10/11: WebView2 bootstrap, installer, paths, Job Object, process termination, updates.
- [ ] Linux: supported distro/WebKitGTK versions, Wayland/X11, packaging, permissions, child cleanup.
- [ ] macOS: Intel/Apple Silicon where support is claimed, signing/notarization, sandbox/permissions, updates.
- [ ] On every platform, clean install, upgrade, downgrade rejection, uninstall, and user-data preservation pass.
- [ ] Runtime discovery is verified for managed Pi, system Pi, and a custom executable.
- [ ] The managed Pi artifact has pinned upstream origin/version/checksum, target triple, SBOM/provenance, and verified rollback; the application does not run npm install/update.
- [ ] The diagnostics bundle reports Pi/PiUI/WebView/OS versions without leaking chat content.

## 10. Release engineering and documentation

- [ ] A reproducible build or documented degree of reproducibility is confirmed.
- [ ] Schema, host API, and runtime protocol versions are synchronized.
- [ ] The changelog lists breaking changes and the migration path.
- [ ] Public SDK docs contain permissions, lifecycle, limits, fallback, and compatibility examples.
- [ ] `AGENTS.md`, ADRs, open risks, and the source list are current.
- [ ] The user guide explains project trust, file semantics, safe mode, backups, and CLI interoperability.
- [ ] The release candidate has undergone dogfooding with real Pi extensions and existing session trees.
- [ ] Go/no-go review is signed by the runtime, security, frontend, and release-engineering owners.
