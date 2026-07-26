# 11. Review of Existing Applications and Reuse Strategy

## 1. Conclusion

PiUI should be created in a separate clean repository. Do not fork Codex App, Hermes Desktop, or OpenCovibe wholesale. Reuse is permitted selectively: small isolated modules/patterns after license and architecture review, with attribution, dedicated tests, and adaptation to Pi semantics.

The main reason is not visual uniqueness, but a mismatch in the source of truth, protocol, and extension philosophy. PiUI must share sessions/config/extensions with Pi, rather than inherit someone else’s storage/runtime abstraction.

## 2. Evaluation Criteria

Each candidate is evaluated by:

1. license and NOTICE obligations;
2. Tauri/Svelte/Rust compatibility;
3. process/session model;
4. ability to preserve Pi JSONL as the source of truth;
5. extension/security boundary;
6. Windows/Linux maturity;
7. performance/accessibility tests;
8. amount of unnecessary feature scope;
9. code activity/quality at the time of actual reuse;
10. cost of ongoing ownership.

Popularity/stars are not an architectural criterion.

## 3. Codex App

Source: [official Codex App description](https://openai.com/index/introducing-the-codex-app/).

### What is useful as a product reference

- threads grouped by projects;
- fast switching between tasks without losing context;
- desktop shell over existing CLI history/config;
- focus on supervision rather than IDE chrome;
- inline progress and actions around the current thread;
- the “sidebar projects/threads + main conversation” model.

### What not to bring into the PiUI core

- worktrees;
- built-in diff/review;
- orchestration of multiple agents as a required concept;
- Codex-specific sandbox/model/account semantics;
- the assumption that a task/thread equals a Pi session branch.

### Decision

Use only as UX/reference behavior. Do not treat it as an available source base and do not reproduce the visuals 1:1. PiUI must look independent and follow its own contracts.

## 4. Official Hermes Desktop

Source: [Hermes Agent Desktop guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/desktop.md).

### Useful product patterns

- CLI and desktop share state: a session can be started in one interface and continued in the other;
- chat-first layout;
- session list, search, and hygiene as the number of sessions grows;
- model control next to the active chat/session;
- queue editing and visible running state;
- settings GUI over agent configuration;
- uninstalling the app without requiring deletion of the agent/config/chats;
- local shell and backend remain conceptually separate.

### Do not transfer automatically

- Hermes-specific profiles, YOLO, gateway, memory, schedules, and toolsets;
- remote backend API architecture;
- broad dashboard scope;
- settings fields that Pi does not provide;
- Hermes security/approval semantics as a replacement for the Pi trust model.

### Decision

Use for UX flows and CLI↔desktop compatibility. The official Hermes Desktop code was not selected as an implementation base within this research; a separate repository/license/code audit is required first.

## 5. OpenCovibe

Source: [AnyiWang/OpenCovibe](https://github.com/AnyiWang/OpenCovibe).

At the time of research, the repository declares Tauri v2 + Svelte 5, a long-lived per-session process model, and Apache License 2.0. It is conceptually close: a local desktop shell over coding-agent CLIs.

### Best candidate for selective code study

Study, but do not copy blindly:

- Tauri process/session actor lifecycle;
- bidirectional stream decoding and event normalization;
- app/window lifecycle;
- drag-and-drop attachments;
- long-session rendering/virtualization;
- platform packaging scripts;
- diagnostics/testing patterns;
- handling of multiple transports/capabilities.

### What not to use as a PiUI foundation

- its own run/event storage model;
- Claude/Codex protocol abstractions as the canonical Pi adapter;
- terminal/diff/provider-specific feature scope;
- SvelteKit/Tailwind merely because they already exist;
- assumptions tested primarily on macOS;
- a full repository fork followed by removal of unnecessary features.

OpenCovibe explicitly notes that Windows/Linux are functional but less thoroughly tested; PiUI cannot inherit this as a sufficient guarantee.

### License procedure

When copying Apache-2.0 code:

- preserve copyright/license headers;
- include the required LICENSE/NOTICE;
- document the source commit/path;
- list changes;
- do not mix a copied module with PiUI-specific code without clear provenance;
- conduct security/performance review independently of upstream.

### Decision

**Selectively reuse after audit.** This is the only considered candidate from which it is reasonable to borrow small implementation patterns in the selected stack.

## 6. Community Hermes Desktop / Hermes One

Source: [fathah/hermes-desktop](https://github.com/fathah/hermes-desktop).

The repository uses Electron and covers a significantly broader set of screens: providers, profiles, memory, skills, schedules, gateways, office, and so on.

### Useful

- visual ideas for chat/session/settings;
- examples of full-text session search;
- onboarding/provider setup edge cases;
- UX for large configuration surfaces;
- tests around streaming/IPC can provide checklist ideas.

### Why it is not a foundation

- Electron conflicts with the low-footprint requirement;
- different backend protocol and storage;
- very broad scope;
- the community project is not equivalent to the official Hermes Desktop;
- a significant portion of the UI is unrelated to minimal PiUI.

### Decision

Visual/flow research only. Individual framework-independent algorithms can be considered after MIT attribution review, but a fork is prohibited by ADR-020.

## 7. Alma

Presumably, “Alama” in the voice transcription referred to [Alma](https://alma.now/) — a desktop interface for multiple AI providers. This is an assumption, not an established fact.

### Useful

- minimal polished chat shell;
- model/provider switching;
- local-first positioning;
- careful presentation of tool use.

### Why it is not a foundation

- provider orchestration is not equivalent to a Pi agent/session harness;
- no confirmed compatibility with Pi JSONL/extensions/RPC;
- extension security and the project/session model differ;
- the code/license were not researched as a suitable source base.

### Decision

Visual reference only. Do not make architectural decisions based on Alma.

## 8. Tauri, Svelte, and Bits UI

Official sources:

- [Tauri 2](https://v2.tauri.app/)
- [Tauri sidecars](https://v2.tauri.app/develop/sidecar/)
- [Svelte documentation](https://svelte.dev/docs/svelte/overview)
- [Bits UI](https://www.bits-ui.com/)

### What to use

- Tauri native/system WebView host and Rust commands;
- sidecar packaging, but process lifecycle in a dedicated Rust supervisor;
- Svelte compiler/runtime and TypeScript;
- selective headless accessible primitives for dialogs, listboxes, menus, and tooltips.

### What not to do

- exposing the Tauri shell plugin to extension/content UI;
- importing an entire component kit/theme;
- turning Bits UI internals into a public PiUI extension contract;
- making core UX depend on unstable private framework APIs.

## 9. Decision Matrix

| Candidate | UX inspiration | Code study | Selective code reuse | Fork/base |
|---|---:|---:|---:|---:|
| Codex App | Yes | No confirmed base | No | No |
| Official Hermes Desktop | Yes | After separate audit | Possibly | No |
| OpenCovibe | Yes | Yes | Yes, after audit/NOTICE | No |
| Community Hermes Desktop | Yes | Limited | Only small framework-independent parts | No |
| Alma | Yes | No | No | No |
| Tauri/Svelte/Bits UI | Yes | Yes | Through normal dependencies | Yes, as a platform stack, not an app fork |

## 10. Code Reuse Process

For each candidate module, create `REUSE-REVIEW-<id>.md`:

```text
Upstream repository/commit/path:
License/NOTICE:
Purpose:
Lines/modules proposed:
Why rewrite is worse:
Security review:
Performance review:
Platform assumptions:
Changes required for Pi semantics:
Tests added:
Ongoing update strategy:
Decision: copy/adapt/reimplement/reject
```

Rules:

- pin the exact commit; do not copy from a moving main branch without pinning;
- prefer reimplementing a small generic pattern over importing a large dependency tree;
- no copied session schema/protocol as the source of truth;
- no dependency solely for one trivial helper;
- preserve attribution;
- upstream updates are not applied automatically;
- copied code passes PiUI lint/tests/security.

## 11. Candidates for an Open-Source Release of Our Own

To allow the ecosystem to evolve without forking the core, publish separately:

- `@piui/contracts`;
- `@piui/extension-sdk`;
- manifest JSON Schema;
- UI node schema/rendering reference;
- fake Pi RPC test harness;
- example dual Pi/PiUI packages.

The desktop host can be opened in full, but the SDK/fixtures are more important for extensibility. The PiUI license should be chosen before the first external code import; Apache-2.0 simplifies compatibility with OpenCovibe reuse, MIT is simpler but does not carry upstream NOTICE obligations. The license decision is a separate legal/project action and is not made by this specification.
