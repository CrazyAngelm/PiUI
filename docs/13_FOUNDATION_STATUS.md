# 13. Foundation status and activation prerequisites

## Honest current status

PiUI's **Trusted History + Contained Runtime foundation is complete**. The current branch exposes a temporary local Pi live-RPC preview for explicit actions in trusted projects and a separate Prime Agent 0.8.1 lane with read-only session history and runtime-scoped configurable global extension settings. The Pi preview is not a managed-runtime or public-release claim; provenance, containment, authentication, concurrent-writer, and platform gates remain open.

Implemented and verified in-repo:

- Tauri 2 + Svelte 5 desktop shell with safe mode, keyboard-accessible project/session navigation, local appearance/reduced-motion preferences, and a bounded rendered timeline window;
- read-only LF JSONL discovery/indexing, generic safe timeline/tree projection, cursor paging, malformed/partial input handling, bounded indexed search, and rebuildable SQLite metadata;
- explicit project trust bound to host-native directory identity; identity replacement resets trust and purges cached session associations; a host-private session-revision admission baseline is re-observed before PiUI's first mutation of a continued session and fails as `CONFLICT` rather than merging JSONL; an async operation gate serializes that mutation authorization with trust revocation.
- deterministic fake runtime scenarios for stream, abort, crash, and malformed RPC paths; every simulated stdout frame now passes through a bounded, fragmented LF JSONL codec, strict known-event validator, and EOF check before safe UI output is retained;
- static-only system-Pi diagnostic classification: no `PATH` candidate is executed; plus a documentation-derived, fixed-whitelist LF JSONL capability-probe coordinator that emits only four future getter frames, bounds fragmented stdout traffic, requires clean EOF before a sanitized result is usable, and cannot spawn a process;
- a **disabled-by-default** managed-runtime provenance/supervisor foundation: production has an empty keyring and no process launcher; on Windows only, a crate-private path can prepare a real empty Job Object after policy, safe-mode, purpose, and provenance gates, then transfer that live owner once with redacted bundle evidence; non-Windows fails closed rather than accepting the Unix stub;
- a crate-private, bytes-only **Observed Upstream Evidence Intake v1** for a checked-in npm `0.81.1` locally authored sanitized summary. It strictly bounds and structurally cross-checks receipt attachments, returns only `NonAuthorizing`, has no filesystem/network/process/supervisor conversion, and regression-tests that a successful intake leaves the production verifier at `NoTrustedKeys`;
- project-local extension package inspection/loading remains disabled pending an atomic directory-handle loader;
- **runtime-scoped global extension settings (v10):** the Settings screen lists and toggles only user-scoped resources through the selected runtime's own manager. PiUI does not parse settings files itself, execute extension code for inventory, or install missing packages; it sends only opaque ids/display metadata to the WebView. Pi and Prime inventories, IDs, enablement, commands, and contributions are separate. Legacy v9 routes and PiUI declarative contributions remain Pi-only;
- **temporary local live-RPC preview:** resolves a locally installed Pi CLI only after an explicit runtime start, launches `pi --mode rpc` in a trusted project cwd, continues an indexed session with `--session` or starts a new one, uses `get_state`/models plus prompt/steer/follow-up/abort RPC, and streams a bounded typed UI projection. Prompt delivery uses Pi's atomic `streamingBehavior`; terminal RPC failures retire the slot and terminate its child. Session discovery honors Pi's documented `PI_CODING_AGENT_SESSION_DIR` override before the default agent `sessions` tree and recognizes an existing conventional project-local `.pi/agent-sessions` mapping; it intentionally does not parse Pi settings files. The host never writes JSONL directly; Pi remains its sole writer. It does **not** establish safe concurrent CLI/PiUI writer semantics; users must close other writers for the same preview session.
- **Prime Agent 0.8.1 read-only lane (v10):** a project records exactly one kind. Prime roots resolve independently (`PRIME_AGENT_SESSION_DIR`, legacy overrides, agent-directory `sessions`, then `~/.prime/agent/sessions`) and must not overlap Pi roots. The flat catalog excludes positive-`rlmDepth` children and can show multiple distinct root sessions through the generic safe timeline. Global extension inventory stays runtime-scoped. Live start/continue/prompt/stop returns `NOT_SUPPORTED`: the 0.8.1 CLI reaches a shared detached daemon, so a per-runtime Job/process group can either miss its workers or own unrelated Prime clients. Exact binding, leases, and activity projection remain non-authorizing adapter/fixture code.
- **personal Chats preview:** New chat can use a host-owned neutral CWD without adding a user project. The backing directory and its opaque index id stay host-private; it is not shown as a trusted user folder and generic project mutation commands reject it. Pi owns the same JSONL format and may keep an empty new chat in memory until its first assistant response, so PiUI never fabricates an empty session file merely for UI persistence. A presentation-only selected draft row is replaced by the real indexed session automatically after the first durable turn.
- **semantic transcript projection v2:** discovery keeps bounded 120-character previews, while an explicit render rescan projects known Pi v3 messages up to separate message/detail/total budgets. Tool calls/results are correlated host-side, hidden custom state is suppressed, unknown payload remains generic, Markdown renders through escaped AST nodes, and live runtime blocks share the persisted timeline scroll.
- **cache-first session catalog v7:** sidebar reads last-indexed SQLite rows immediately, then uses an opaque sequence-stamped refresh event to reconcile JSONL in the background. Discovery has per-project gates, no-follow identity/fingerprint evidence, a bounded streaming metadata parser (no entries/tree/timeline allocation), one transactional batch commit and complete-only sweep. `notify` root changes carry no paths to the WebView and only schedule reconciliation; selected transcript reuse re-hashes its bound source revision before serving cached cursor pages. Catalog freshness is never a runtime mutation permit.

The live preview starts only a real Pi executable and can send a real prompt only through the typed host adapter. It does not start Prime Agent. It still does not read `auth.json`, expose host paths/process handles/raw stderr/raw RPC frames to the WebView, or load project-local package code. The Pi launch path deliberately bypasses managed provenance/containment release requirements at the user's current development request.

## What the managed-runtime gate does — and does not — establish

The internal gate verifies test-only complete-bundle fixtures with exact-byte, domain-separated Ed25519 signatures; rejects duplicate manifest keys, unsafe/ambiguous paths, zero-size or unexpected tree entries, symlink/reparse-point entries, native hardlinks where the platform can inspect them, target/binding/hash mismatches, and stale bundle content; and keeps evidence/path data opaque. On Windows it additionally retains strict opaque handles for every declared regular file during revalidation, using fail-closed full `FileIdInfo` identities (64-bit volume serial plus 128-bit file ID) and rejecting duplicate retained native identities across manifest slots, but does not freeze the directory namespace. Production activation still requires physical ReFS evidence for that identity boundary. In production its keyring is intentionally empty and its verifier/authorization path is crate-private.

This is **not** evidence that a managed Pi artifact, release channel, updater, rollback, or executable launch is ready. The observed npm packet is a locally authored sanitized summary that reports one isolated `npm audit signatures` success. Its offline checks establish only local file safety, digest binding, and fixed-field consistency: raw registry signature/key material and Sigstore DSSE/Rekor evidence are not retained, so no upstream cryptographic claim is independently authenticated here. It does not make the npm key a PiUI production key, authenticate an installed tree, or create a release authorization. Before any launcher is added, it must use a trusted directory/file-handle design that binds artifact verification to native spawn, retains live containment ownership, verifies a signed production keyring with signer roles/revocation policy, authenticates the acquired archive and complete bundle, and proves release sequencing, rollback, and channel policy. The concrete handle-bound boundary is recorded in [`15_HANDLE_BOUND_RUNTIME.md`](15_HANDLE_BOUND_RUNTIME.md).

## Blocking external evidence before real Pi execution

The Phase 0 decision in [`../spikes/PHASE0_GATE.md`](../spikes/PHASE0_GATE.md) remains controlling. At minimum, capture and review:

1. signed managed-runtime acquisition, provenance, SBOM, update, downgrade rejection, and rollback evidence for every supported target;
2. actual production-supervisor containment reports for Windows and Linux (including descendant cleanup after graceful and forced shutdown);
3. a controlled real Pi CLI/PiUI concurrent-writer matrix with explicit conflict semantics — no heuristic merge;
4. real-session start/continue/reopen/crash-recovery round trips without ghost files;
5. an external authentication/capability-refresh flow that never reads or transmits credentials;
6. scanner compatibility results from real, supported-version Pi session corpora;
7. physical performance, accessibility, packaging, installer/update, and platform-matrix evidence required by [`../CHECKLIST_RELEASE.md`](../CHECKLIST_RELEASE.md);
8. for any future Prime live lane, authenticated acquisition/provenance for the launched bundle plus an owned non-default daemon lifecycle and first-launch/pre-existing-daemon containment on Windows and Linux.

Until those items are accepted, the local preview must not be presented as release-ready or used to satisfy public managed-runtime claims. The fake runtime and read-only history route remain the recovery-safe path; safe mode disables the live preview. The current public upstream inventory and the missing provenance chain are recorded in [`14_PI_RUNTIME_EVIDENCE.md`](14_PI_RUNTIME_EVIDENCE.md).

## Reproducible local verification

From repository root:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm check
pnpm test
pnpm build
pnpm test:smoke
# Required real user-flow gate; currently open/red as described below:
pnpm test:e2e
pnpm perf:smoke
pnpm contract:test
pnpm mutation:test  # targeted cargo-mutants gate for catalog/reconciler paths
# Requires a locally installed Pi; explicit synthetic session, no provider prompt:
cargo test -p piui-runtime live_pi_existing_session_handshake -- --ignored --nocapture
python tools/validate_spec.py
python tools/validate_runtime_evidence.py --check evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1
python -m unittest tools/test_validate_runtime_evidence.py -v
```

The emitted frontend asset smoke gate is **260 KiB** (266,240 bytes). The current protocol-v10 read-only Prime lane and project-session UI build measures **259,817 bytes**, leaving 6,423 bytes of measured headroom. This build-size result does not close a public performance or 1.0 release gate.

The passing checks above validate source, contracts, deterministic fixtures, static UI smoke behavior, and the real Windows Tauri/WebView2 user flow. `pnpm test:e2e` now passes on Windows through a feature-gated debug-only exact-origin loopback driver; its outside-Job controller proves zero Job processes before bounded fixture removal. Linux still has no WebKit harness, so the cross-platform E2E gate remains open. No static smoke or Windows-only run substitutes for that Linux or external release evidence.
