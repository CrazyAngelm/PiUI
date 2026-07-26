# 13. Foundation status and activation prerequisites

## Honest current status

PiUI's **Trusted History + Contained Runtime foundation is complete**. In addition, the current branch exposes a temporary local live-RPC preview for explicit user actions in trusted projects. It is not a managed-runtime or public-release claim: provenance, containment, concurrent-writer and platform gates below remain open.

Implemented and verified in-repo:

- Tauri 2 + Svelte 5 desktop shell with safe mode, keyboard-accessible project/session navigation, local appearance/reduced-motion preferences, and a bounded rendered timeline window;
- read-only LF JSONL discovery/indexing, generic safe timeline/tree projection, cursor paging, malformed/partial input handling, bounded indexed search, and rebuildable SQLite metadata;
- explicit project trust bound to host-native directory identity; identity replacement resets trust and purges cached session associations; a host-private session-revision admission baseline is re-observed before PiUI's first mutation of a continued session and fails as `CONFLICT` rather than merging JSONL; an async operation gate serializes that mutation authorization with trust revocation.
- deterministic fake runtime scenarios for stream, abort, crash, and malformed RPC paths; every simulated stdout frame now passes through a bounded, fragmented LF JSONL codec, strict known-event validator, and EOF check before safe UI output is retained;
- static-only system-Pi diagnostic classification: no `PATH` candidate is executed; plus a documentation-derived, fixed-whitelist LF JSONL capability-probe coordinator that emits only four future getter frames, bounds fragmented stdout traffic, requires clean EOF before a sanitized result is usable, and cannot spawn a process;
- a **disabled-by-default** managed-runtime provenance/supervisor foundation: production has an empty keyring and no process launcher; on Windows only, a crate-private path can prepare a real empty Job Object after policy, safe-mode, purpose, and provenance gates, then transfer that live owner once with redacted bundle evidence; non-Windows fails closed rather than accepting the Unix stub;
- a crate-private, bytes-only **Observed Upstream Evidence Intake v1** for a checked-in npm `0.81.1` locally authored sanitized summary. It strictly bounds and structurally cross-checks receipt attachments, returns only `NonAuthorizing`, has no filesystem/network/process/supervisor conversion, and regression-tests that a successful intake leaves the production verifier at `NoTrustedKeys`;
- project-local extension package inspection/loading remains disabled pending an atomic directory-handle loader;
- **global Pi extension settings:** a full-workspace Settings screen lists and toggles only user-scoped extension resources through upstream Pi `SettingsManager`/`DefaultPackageManager` in offline mode. PiUI does not parse settings files itself, does not execute extension code for inventory, skips missing package installation, and sends only opaque ids/display metadata to the WebView;
- **temporary local live-RPC preview:** resolves a locally installed Pi CLI only after an explicit runtime start, launches `pi --mode rpc` in a trusted project cwd, continues an indexed session with `--session` or starts a new one, uses `get_state`/models plus prompt/steer/follow-up/abort RPC, and streams a bounded typed UI projection. Prompt delivery uses Pi's atomic `streamingBehavior`; terminal RPC failures retire the slot and terminate its child. Session discovery honors Pi's documented `PI_CODING_AGENT_SESSION_DIR` override before the default agent `sessions` tree and recognizes an existing conventional project-local `.pi/agent-sessions` mapping; it intentionally does not parse Pi settings files. The host never writes JSONL directly; Pi remains its sole writer. It does **not** establish safe concurrent CLI/PiUI writer semantics; users must close other writers for the same preview session.
- **personal Chats preview:** New chat can use a host-owned neutral CWD without adding a user project. The backing directory and its opaque index id stay host-private; it is not shown as a trusted user folder and generic project mutation commands reject it. Pi owns the same JSONL format and may keep an empty new chat in memory until its first assistant response, so PiUI never fabricates an empty session file merely for UI persistence.
- **semantic transcript projection v2:** discovery keeps bounded 120-character previews, while an explicit render rescan projects known Pi v3 messages up to separate message/detail/total budgets. Tool calls/results are correlated host-side, hidden custom state is suppressed, unknown payload remains generic, Markdown renders through escaped AST nodes, and live runtime blocks share the persisted timeline scroll.
- **cache-first session catalog v7:** sidebar reads last-indexed SQLite rows immediately, then uses an opaque sequence-stamped refresh event to reconcile JSONL in the background. Discovery has per-project gates, no-follow identity/fingerprint evidence, a bounded streaming metadata parser (no entries/tree/timeline allocation), one transactional batch commit and complete-only sweep. `notify` root changes carry no paths to the WebView and only schedule reconciliation; selected transcript reuse re-hashes its bound source revision before serving cached cursor pages. Catalog freshness is never a runtime mutation permit.

The preview starts a real Pi executable and can send a real prompt only through the typed host adapter. It still does not read `auth.json`, expose host paths/process handles/raw stderr/raw RPC frames to the WebView, or load project-local package code. Its local launch path deliberately bypasses managed provenance/containment release requirements at the user's current development request.

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
7. physical performance, accessibility, packaging, installer/update, and platform-matrix evidence required by [`../CHECKLIST_RELEASE.md`](../CHECKLIST_RELEASE.md).

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

These checks validate source, contracts, deterministic fixtures, and static UI smoke behavior. They do not substitute for the external release evidence above.
