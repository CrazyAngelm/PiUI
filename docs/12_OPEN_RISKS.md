# 12. Open Risks, Unknowns, and Required Checks

## 1. Document Status

The risks below are not disguised as implemented capabilities. Until Phase 0 is completed, many technical details are reasoned design decisions, not confirmed behavior of a specific Pi/OS version.

Scale:

- **Probability:** Low / Medium / High.
- **Impact:** Medium / High / Critical.
- **Gate:** the stage by which the risk must be closed or formally accepted.

## 2. Critical Risk Register

| ID | Risk | Probability | Impact | Gate |
|---|---|---:|---:|---|
| R-01 | RPC startup creates a ghost session when opening an existing chat | Medium | High | G0 |
| R-02 | No correct graceful shutdown; child tools remain | Medium | Critical | G0/G2 |
| R-03 | Cannot navigate to an arbitrary branch node through RPC | High | Medium/High | G0/G4 |
| R-04 | Provider OAuth/login requires a full TTY | High | High | G0/G3 |
| R-05 | RPC/TUI extension UI parity is more limited than expected | High | High | G0/G3 |
| R-06 | Concurrent CLI/PiUI writers corrupt/desynchronize a session | Medium | Critical | G0/G2 |
| R-07 | Session format/root changes between Pi versions | Medium | High | G1/G4 |
| R-08 | System WebView footprint/behavior violates budgets on Linux/Windows | Medium | High | G0/G6 |
| R-09 | Tauri sidecar Pi packaging is complex/unstable on mandatory platforms | Medium | High | G0/G6 |
| R-10 | Rich view isolation has a platform-specific escape/IPC exposure | Medium | Critical | G5 |
| R-11 | Trusted shell makes recovery inaccessible | Low/Medium | Critical | G5 |
| R-12 | A full-featured UI extension SDK bloats the core and delays stable v1 | High | High | G4/G5 |
| R-13 | Pi executable/backend extensions have user permissions; users mistake this for a sandbox | High | Critical | G1/G6 |
| R-14 | Large sessions/tool outputs cause memory leaks/jank | High | High | G2/G6 |
| R-15 | Windows process/path semantics produce orphan/traversal bugs | Medium | Critical | G2/G6 |
| R-16 | The Linux WebKitGTK/distro matrix is too fragmented | High | High | G6 |
| R-17 | Reused external code introduces license/security/architecture debt | Medium | High | Before merge |
| R-18 | Managed runtime and system Pi diverge in packages/config behavior | Medium | High | G2/G6 |
| R-19 | Generic file references are not sufficiently understandable to models/tools | Medium | Medium | G3 |
| R-20 | Scope creep turns PiUI into an IDE/dashboard | High | High | All gates |

## 3. Details and Exit Criteria

### R-01 — Ghost sessions

**Signal:** starting RPC without an explicit selector creates a new JSONL before `switch_session`.

**Mitigation:** supported launch option; deferred session creation; minimal bridge.

**Prohibited workaround:** delete the ghost file after startup without ownership confirmation.

**Exit:** automated test proves zero extra files across new/open/crash paths.

### R-02 — Shutdown/process tree

**Signal:** EOF/abort does not terminate Pi or descendants; Windows leaves a process.

**Mitigation:** graceful command/EOF, timeout escalation, Unix process groups, Windows Job Object.

**Residual:** descendants daemonized outside the group may survive; document the limits.

**Exit:** child-process fixture leaves zero owned descendants on Windows/Linux.

### R-03 — Branch navigation

**Signal:** `get_tree` exists, but a navigate command is absent.

**Mitigation:** read-only tree; only fork/clone; upstream/bridge capability.

**Exit:** official/bridge operation with a round-trip CLI test, or an explicit 1.0 product limitation is accepted.

### R-04 — Authentication

**Signal:** `/login` requires terminal interaction not exposed via RPC/get_commands.

**Mitigation:** dedicated allowlisted auth subprocess or external terminal instructions; never a generic terminal.

**Exit:** provider matrix flow works without secret logs and refreshes models.

### R-05 — Extension parity

**Signal:** `ctx.ui.custom`, header/footer/editor/theme are no-ops; custom entries lack renderer metadata.

**Mitigation:** Tier 0 generic fallback + PiUI manifest/SDK; extension UI fixture corpus.

**Exit:** documented compatibility matrix and dual-package example; no claim of full automatic TUI parity.

### R-06 — Concurrent writers

**Signal:** CLI and PiUI append divergent turns to the same session/current leaf.

**Mitigation:** external-write revision detection, conflict state, read-only/fork choice.

**Exit:** stress fixture never silently merges or loses entries.

### R-07 — Session format drift

**Signal:** unknown headers/entry types/root paths break the scanner.

**Mitigation:** tolerant decoder, raw preservation, version/capability probe, pinned managed runtime, fixtures.

**Exit:** oldest/current supported Pi corpus and unknown-event tests pass.

### R-08 — WebView performance/variance

**Signal:** baseline RSS/startup exceeds the hard gate; the long timeline differs across WebKitGTK/WebView2.

**Mitigation:** early SPIKE-08, minimal dependencies, virtualization, platform-specific fixes.

**Fallback:** reconsider Qt/another stack before product coupling, not after 1.0.

**Exit:** physical reference measurements are within hard budgets.

### R-09 — Managed runtime packaging

**Signal:** executable naming, architecture, permissions, updates, or package assets fail.

**Mitigation:** first use official standalone Pi release artifacts; verify upstream checksum/provenance; keep separate sidecar artifacts/manifests; system/custom modes remain fallback; never run npm install/update at startup.

**Exit:** signed/tested install-update-rollback on Windows/Linux.

### R-10 — Rich view isolation

**Signal:** iframe/view can call core Tauri IPC, navigate, fetch secrets, or spoof a host prompt.

**Mitigation:** separate capability/origin, broker tokens, immutable prompts, CSP, adversarial tests.

**Exit:** security review and platform tests; otherwise ship declarative SDK only and defer Tier 2.

### R-11 — Shell recovery

**Signal:** a broken shell blocks settings/safe mode.

**Mitigation:** native startup modifier/menu, crash-loop counter, core fallback outside the shell.

**Exit:** a malicious/broken reference shell cannot suppress recovery.

### R-12 — SDK scope

**Signal:** v1 tries to support arbitrary layout/CSS/DOM in the declarative tier.

**Mitigation:** frozen small node vocabulary/slots; complex cases go to Tier 2/3; usage-driven additions.

**Exit:** schema v1 is implementable/testable; unknown contributions degrade gracefully.

### R-13 — False sandbox perception

**Signal:** users trust a project because the desktop app looks managed/safe.

**Mitigation:** literal trust wording, restricted mode, extension source visibility, no misleading shields.

**Exit:** security/UX review validates comprehension; documentation repeats the limitation.

### R-14 — Long-session performance

**Signal:** the entire timeline/Markdown/tool output stays in the DOM/memory.

**Mitigation:** virtualization, paging, lazy parsing, output truncation/collapse, leak tests.

**Exit:** 10k-block fixture meets hard budgets after repeated open/close.

### R-15 — Windows semantics

**Signal:** UNC/junction/ADS/long-path/process-cleanup bugs.

**Mitigation:** Rust platform adapter and Windows-specific corpus/physical CI.

**Exit:** mandatory tests, with no POSIX-only assumptions.

### R-16 — Linux distribution variance

**Signal:** WebKitGTK is missing/incompatible; Wayland dialogs/tray; AppImage issues.

**Mitigation:** narrow declared support matrix, dependency preflight, deb/AppImage choice based on tests.

**Exit:** smoke testing on two distro families and Wayland/X11; unsupported cases are stated.

### R-17 — External reuse

**Signal:** copied OpenCovibe/Hermes code retains unrelated storage/protocol or misses NOTICE.

**Mitigation:** per-module reuse review, exact commit, dedicated tests.

**Exit:** legal/provenance checklist in the PR.

### R-18 — Runtime profile divergence

**Signal:** managed Pi loads packages/config differently from system Pi.

**Mitigation:** use the same resolved home/config semantics where intended, visible paths, compatibility tests.

**Exit:** fixture package/session works in all supported profiles or differences are documented.

### R-19 — File references

**Signal:** the model ignores the textual attachment convention; the tool cannot resolve the managed URI.

**Mitigation:** stable human-readable path refs, optional bridge/tool resolver, user-visible semantics.

**Exit:** real workflows validate project/external file use; typed Pi API replaces the convention when available.

### R-20 — Scope creep

**Signal:** core PRs add Git/terminal/diff/subagents before stable chat/extensions.

**Mitigation:** ADR-015, extension-first review, release gates, explicit non-goals.

**Exit:** ongoing; each new core feature requires an ADR.

## 4. Secondary Risks

- system WebView updates can regress rendering between PiUI releases;
- model/provider list can be slow/offline;
- clipboard/image decoder behavior differs by platform;
- FTS may expose sensitive local text to other local processes with the same user rights;
- a project moved through a symlink can invalidate trust identity;
- permission fatigue may lead users to allow everything;
- extension package updates can change behavior without publisher signatures;
- session trash undo differs by OS;
- full diagnostics may accidentally include a prompt/path through third-party error strings;
- screen readers may announce streaming too aggressively;
- update signing infrastructure itself becomes a critical secret;
- managed attachment cache can grow silently;
- an app crash during DB migration can lose UI metadata, though not sessions;
- custom Pi forks may claim a version but diverge in semantics;
- anti-virus may quarantine the sidecar on Windows;
- WSL/project paths bridge Windows/Linux identity ambiguously.

Each must have an issue/test before the corresponding feature release.

## 5. Upstream Requests to Pi

Recommended minimum list, without requiring Pi to become a GUI framework:

1. explicit capability/protocol version endpoint;
2. open an existing session at RPC startup without creating another;
3. graceful shutdown RPC command/ack;
4. navigate the current branch/tree node;
5. headless auth status/start flow or structured interactive channel;
6. typed generic attachment/resource references;
7. richer metadata for custom entries/tool renderers;
8. documented concurrent access/locking semantics;
9. complete list of config operations suitable for external UI.

Each request must be small, generic, and useful to any custom UI, not PiUI-specific pixel behavior.

## 6. Bridge Extension Fallback

If the upstream API is unavailable, `@piui/pi-bridge` may:

- register minimal Pi commands/events;
- expose tree navigation/session selection/auth metadata through supported extension/SDK primitives;
- translate typed resource references;
- advertise bridge version/capabilities.

The bridge must not:

- implement an agent loop;
- introduce a second session file;
- write JSONL outside Pi APIs;
- render desktop UI;
- become mandatory for basic prompt/streaming;
- hide version incompatibility.

## 7. Go/No-Go Rules

- **No-go public rich views:** R-10 unresolved.
- **No-go trusted shell:** R-11 unresolved.
- **No-go Windows/Linux release:** R-02/R-08/R-09/R-15/R-16 unresolved.
- **No-go session mutation features:** R-01/R-06/R-07 unresolved.
- **No-go “full extension compatibility” claim:** R-05 unresolved or wording not narrowed.
- **No-go low-memory claim:** physical hard budgets not measured.
- **No-go public auto-update:** signing/rollback not verified.

A partial release is allowed only with the unsupported feature disabled/hidden, not with an optimistic broken action.

## 8. Risk Review Cadence

At each gate:

- update probability/impact;
- attach test/fixture/decision evidence;
- move a closed risk to an ADR/known limitation;
- do not close a risk by citing code review without runtime evidence;
- add new risks before merging an architectural change.
