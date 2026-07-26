# AGENTS.md — mandatory PiUI development rules

This file is intended for coding agents and engineers working on the PiUI repository. The requirements below take precedence over the local convenience of any particular task.

## Goal

Create a minimal, fast, and extensible desktop shell on top of Pi. Do not create another agent harness.

## Non-negotiable rules

- Do not implement an agent loop, provider clients, compaction, tools, or session branching inside PiUI when Pi already provides them.
- Send every active-session command through the typed runtime adapter. Do not write to session JSONL directly.
- Treat Pi JSONL as the source of truth. The PiUI database is only cache/index/UI metadata and must be fully rebuildable.
- Do not read or modify `auth.json` in the frontend. Do not emit keys, OAuth tokens, the full environment, or prompt content in ordinary logs.
- Do not give the WebView general shell/filesystem access. The frontend invokes only allowlisted Tauri commands with validated arguments.
- Do not load project-local PiUI JavaScript before an explicit trust decision.
- Evaluate every new core feature against this principle first: “could this be an extension contribution?” If so, keep it out of core.
- Every custom renderer must have a generic fallback. The session must remain readable when its extension is disabled.
- Do not use Electron. Do not add SSR, a cloud backend, telemetry, or an account system without a separate ADR.
- Do not introduce a second chat format.
- Do not block first paint on network checks, model-catalog checks, or package updates.

## Architectural layers

1. `ui` — Svelte components and local presentation state.
2. `host-api` — generated TypeScript bindings to Rust commands/events.
3. `application` — use cases: projects, sessions, attachments, extensions.
4. `runtime` — Pi process supervisor and RPC adapter.
5. `index` — read-only session scanner and rebuildable SQLite index.
6. `platform` — process groups, filesystem watch, trash, notifications, updates.

The UI does not access the `runtime`, `index`, or OS layers directly.

## Coding conventions

- Rust: stable toolchain, edition 2024, `cargo fmt`, `clippy -D warnings`, errors through typed enums; `unwrap()` is prohibited outside tests and provable startup invariants.
- TypeScript: `strict: true`, no `any` in public contracts; discriminated unions for events; exhaustive `switch` with `never`.
- Svelte: local state in the component, cross-screen state in small domain stores; do not create a global store “for the whole application”.
- CSS: design tokens through custom properties, component-scoped CSS; no utility-class DSL in core UI.
- IPC: schema-first. Changing an event/command contract requires a version bump, compatibility test, and an update to `contracts/`.
- Logs: structured fields; no messages such as `console.log(object)` for RPC payloads in production.

## Definition of Done for every task

- A happy path and at least one failure path are implemented.
- Unit tests are added; a user flow has an integration/E2E test.
- No regression in safe mode or the generic fallback.
- Keyboard-only operation and screen-reader labels are verified for each new interactive element.
- The impact on startup/RSS/rendering is measured if a hot path is affected.
- The specification or ADR is updated if behavior changes.
- No platform-specific assumption is made on Windows or Linux without a separate branch and test.

## Prohibited shortcuts

- Parse stdout with a normal general-purpose line reader that splits on Unicode line separators. Pi RPC requires LF-only framing.
- Kill only the parent PID while leaving child tool processes.
- Hide project trust behind a generic “Continue” button.
- Automatically copy external files into a project without a user-visible decision.
- Render raw HTML from Markdown, tool output, or an extension payload.
- Load an extension bundle into the main DOM with full permissions by default.
- Treat `ctx.hasUI === true` as evidence of full TUI support in RPC.
- Rename or move session files for UI sorting.

## Priorities when requirements conflict

1. Preservation of user files and sessions.
2. An explicit trust model and no false promise of a sandbox.
3. Compatibility with the Pi CLI.
4. Correctness of the runtime protocol.
5. UI responsiveness.
6. Extensibility.
7. Visual polish.

## Quality commands the repository must provide

```bash
pnpm check          # TypeScript/Svelte formatting, lint, typecheck
pnpm test           # unit tests
pnpm test:e2e       # Playwright against packaged/dev Tauri harness
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm contract:test  # schema fixtures and backward compatibility
pnpm perf:smoke     # startup, idle RSS, long-session scroll, stream batching
```

## Before implementation begins

The first task is to complete the spikes in `docs/12_OPEN_RISKS.md`. Do not build UI on assumptions about RPC-process termination, initial session creation, OAuth, or tree navigation.
