# PiUI — handoff for coding agents and contributors

PiUI is a minimal desktop shell on top of Pi, with a separate Prime Agent 0.8.1 lane: read-only session history plus runtime-scoped configurable global extension settings. It does not replace either runtime's agent loop, provider clients, tools, compaction, session storage, or authentication.

## Before any task

Read in this order:

1. `README.md`, `CONTRIBUTING.md`, and `AGENTS.md`.
2. `docs/13_FOUNDATION_STATUS.md` and `docs/12_OPEN_RISKS.md`.
3. The document for the affected subsystem and related ADRs in `docs/`.
4. `contracts/README.md` and machine-readable contracts if IPC/UI DTOs change.

## Non-negotiable boundaries

- Do not write to Pi JSONL directly or create a second chat format.
- Do not give the WebView a general shell/filesystem/process API.
- Do not read or pass through `auth.json`, credentials, the full environment, or raw prompts.
- Do not run project-local UI/JavaScript before a separate trust decision.
- Do not represent the local Pi live-RPC preview as a managed runtime, sandbox, containment guarantee, or release-ready feature.
- Keep Pi and Prime Agent project kinds, session roots, extension inventories, and opaque IDs separate. Prime live control must remain fail-closed until PiUI owns a non-default daemon lifecycle and proves containment on Windows and Linux; do not claim launch, attach, resident sessions, replay, or multi-client support.
- Do not add a cloud backend, telemetry, an account system, or Electron without an ADR.
- For every new core feature, evaluate the extension-first alternative first.

## Current status

The foundation and temporary local Pi live-RPC preview are implemented, but public-release gates remain open. Host protocol v10 adds an explicit Prime project kind, separate read-only session discovery, and runtime-scoped global extension inventory; Prime live control is gated because 0.8.1 uses a shared detached daemon. Legacy v9 remains Pi-only. Actual runtime and platform claims must correspond only to accepted evidence.

## Work format

At the start of a task, record:

- scope and affected acceptance criteria;
- changed public contracts and migration/compatibility impact;
- data/security/performance/platform risks;
- automated and manual validation plan.

At the end, state:

- what was implemented and intentionally not implemented;
- verification commands and results;
- new assumptions/open risks;
- whether an ADR, schema bump, or upstream issue is needed;
- rollback if the change affects user-visible state.

## Definition of done

A change is not ready merely because it works visually. It needs typed boundaries, happy/failure-path tests, preservation of Pi/CLI compatibility, safe-mode/generic fallback coverage, accessible keyboard/screen-reader labels, and updated documentation.

Never add session JSONL, prompts, tool output, screenshots of real sessions, credentials, local paths, usernames, `.env`, `.pi/` state, or mutation/build artifacts to the repository.
