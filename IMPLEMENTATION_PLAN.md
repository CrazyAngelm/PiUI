# PiUI implementation plan

This plan turns the completed specification and Phase 0 evidence into executable vertical slices. It deliberately does not treat a passing synthetic spike as a cross-platform product guarantee.

## Current gate

See [`spikes/PHASE0_GATE.md`](spikes/PHASE0_GATE.md).

The first implementation slice is **Trusted History + Contained Runtime**:

1. Register an existing folder, initially restricted.
2. Explicitly trust it before any project-aware runtime launch.
3. Discover and render Pi session files read-only.
4. Render a read-only tree and a generic safe timeline fallback.
5. Run deterministic fake RPC scenarios (stream, abort, crash, malformed frame).
6. Classify system-runtime eligibility without executing an unverified `PATH` candidate.
7. Never modify, merge, rename, export, or trash a user session in this slice.

## Repository structure

```text
apps/desktop/                 Svelte 5/Vite frontend and thin Tauri composition root
crates/piui-contracts/        Host DTOs, errors and JSON fixtures
crates/piui-platform/         Path identity and process containment abstractions
crates/piui-index/            Read-only SQLite registry and LF session scanner
crates/piui-runtime/          RPC framing, fake runtime and lifecycle state machine
crates/piui-extensions/       Read-only schema + semantic validation for PiUI package manifests
contracts/                    Versioned TypeScript/public contract sources
fixtures/                     Synthetic, credential-free session and runtime fixtures
spikes/                       Phase 0 evidence; never production dependencies
```

Dependency direction is one-way: desktop composition → application adapters → contracts; index/runtime use contracts but never invoke each other. The frontend only calls a generated/typed host API, never Tauri, filesystem, or shell APIs directly.

## Delivery slices

### Slice A — foundation (complete)

- workspace/toolchain and quality commands;
- typed contract DTOs and compatibility fixtures;
- project registry with canonical-path validation;
- read-only LF scanner with partial/corrupt/unknown projections;
- transport-faithful fake runtime: simulated stdout is fragmented and replayed through the bounded LF codec, normalized/validated before UI projection, and must pass EOF completion;
- accessible Svelte shell for restricted projects, trust, history, tree, runtime diagnostics, bounded timeline paging, and PiUI-only appearance/reduced-motion preferences;
- Windows containment interface and explicit unsupported Unix status;
- disabled managed-runtime provenance/authorization infrastructure: exact-byte signed test fixtures are verified internally, but production has no trusted key, no containment capability, and no launcher; plus a checked-in locally authored npm `0.81.1` summary whose crate-private intake structurally validates bounded local files, is permanently `NonAuthorizing`, and cannot enter that infrastructure.

See [`docs/13_FOUNDATION_STATUS.md`](docs/13_FOUNDATION_STATUS.md) for the precise completed boundary and external evidence still required.

### Temporary local live-RPC preview (implemented; not a production Slice B/C completion)

- explicit user action in a trusted project resolves a locally installed Pi CLI, launches `pi --mode rpc`, and uses the LF codec plus typed command correlation/event projection;
- existing indexed sessions launch through `--session`; a new runtime starts a Pi-owned session and the scanner discovers its JSONL after stop;
- prompt, steer, follow-up, abort, model and thinking controls use Pi RPC only; PiUI never hand-writes JSONL or reads `auth.json`;
- this preview intentionally bypasses managed-runtime provenance and release containment claims. It is developer-only, retains the fake/read-only route, and does not close any gate below.

### Slice B — protected real-runtime adapter

- production system-Pi eligibility and managed-runtime policy: the temporary preview must not become a `PATH` authorization precedent. Production still requires verified managed provenance. The foundation also contains a non-spawning fixed-whitelist LF JSONL probe coordinator (fixed getter frames, bounded stdout chunks/traffic, correlation, and clean-EOF readiness);
- production signed-key rollout, trusted directory/file-handle bundle verification, anti-rollback/channel policy, and a handle-bound platform launcher. The foundation now has a test-only complete-tree signed bundle verifier, but its production keyring is empty and it intentionally does not satisfy acquisition, handle-binding, or release-policy requirements;
- Windows Job Object / Unix process-group supervisor in the production host, enabled only after that provenance and platform-containment evidence;
- snapshot/reconnect/crash UX;
- external revision conflict detection; the foundation now has a host-private admission baseline/re-observation seam, but it is detection only (not locking or merge safety); no heuristic merge;
- explicit terminal-auth guidance without credential or `auth.json` access.

### Slice C — controlled session continuation

The preview implements a narrow start/continue/chat surface for local development. A production continuation flow still requires the `spikes/PHASE0_GATE.md` continuation gate and must add:

- create/open/continue session using documented Pi RPC paths with the final supervisor;
- streaming timeline, stop/steer/follow-up, model/thinking controls with reconnect/recovery semantics;
- runtime recovery and cross-CLI session round-trip tests under the supported platform matrix.

### Slice D — local data and attachments

- watcher-backed incremental indexing, paging, drafts, optional FTS;
- image/file reference UX and managed-copy policy;
- rename/export/trash/fork only through Pi/system APIs with recoverability.

### Slice E — extensions, packaging, release

- Tier 0 standard UI protocol and generic fallback;
- manifest validation (foundation implemented) and declarative Tier 1 contributions; project-local packages stay fully blocked until an atomic directory-handle loader can bind reads to the trusted directory identity;
- isolated Tier 2 rich views; safe mode;
- managed-runtime acquisition, signed updates, platform matrix, physical performance measurements.

## Non-negotiable constraints

- Pi owns agent behavior and session semantics.
- Pi JSONL is read-only for PiUI; PiUI's database is rebuildable metadata/index only.
- A WebView never receives a general filesystem, shell, process, or credential API.
- Project-local resources require explicit trust; trust is not a sandbox.
- Unknown content remains visible through a bounded generic fallback.
- EOF alone is never treated as child-process cleanup.
