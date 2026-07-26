# PiUI — handoff for coding agents and contributors

PiUI is a minimal desktop shell on top of the Pi agent harness. It does not replace the Pi agent loop, provider clients, tools, compaction, session storage, or authentication.

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
- Do not represent the local live-RPC preview as a managed runtime, sandbox, or release-ready feature.
- Do not add a cloud backend, telemetry, an account system, or Electron without an ADR.
- For every new core feature, evaluate the extension-first alternative first.

## Current status

The foundation and temporary local live-RPC preview are implemented, but public-release gates remain open. Actual Pi/runtime/packaging/platform claims must correspond only to evidence in `docs/13_FOUNDATION_STATUS.md`, `spikes/PHASE0_GATE.md`, and `CHECKLIST_RELEASE.md`.

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
