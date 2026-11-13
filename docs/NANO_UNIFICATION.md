# Nano Web / Desktop unification

Implementation contract, authorized 2026-11-13. Work is isolated in the
`codex/nano-unification` worktrees of PIUI and NanoAgentProject. This is not
authorization to merge, deploy, replace the installed application or migrate
production data.

## Product outcome

Nano has two work locations: **This computer** and **Nano Cloud**. A location
owns its histories, files and execution. Changing location does not transfer
data, switch a session's model source or grant cloud access to local files.
The desktop remains useful without a Nano account. Signed-out and safe-mode
desktop paths make no Nano network request.

Shared interface code is developed as completed user flows with separate
transports. Native harnesses retain inference, tools, approvals and native
history ownership. Nano's existing .NET services retain accounts, membership,
entitlements, credits and cloud runtime ownership. Rust graph semantics are
reused, not reimplemented as a second C# coordinator.

Nano's emerald design is the built-in default. Chaos remains selectable.
Design style is independent of light/dark/system appearance, accessibility
preferences and plugin palette contributions. Account-only avatar UI does
not reserve space or make requests when unavailable. Avatar assets originate
from the server, with temporary authorized display rather than a bundled
offline avatar library.

The existing isolated Cloud window stays available while shared web modules
are introduced. It receives no IPC. Full replacement of every Blazor screen
is conditional on the graph and conversation integration experiments; it
is not a prerequisite for the first useful releases.

## Key stages and proof

| Stage | Deliverable | Necessary proof |
|---|---|---|
| Visual foundation | Nano default, selectable Chaos, persistent independent appearance, compatible plugin themes and a shared token boundary | Unit checks, keyboard and label checks in the browser/native WebView, light/dark/system and safe-mode paths, no signed-out Nano network |
| Shared web graph | Reusable graph surface in existing Blazor navigation, real authenticated draft storage, portable import/export | Same document semantics, invalid import preserves draft, revision conflict/reload, no implicit launch or unsupported-field loss |
| Cloud execution | Durable .NET execution host using the Rust transition core and verified native runtime references | Successful run, cancellation, duplicate command, restart/unknown outcome, tenant denial and unsupported-capability refusal |
| Server avatars | Server-owned manifest/assets, host-only authenticated fetch, ephemeral display and entitlement-driven UI for supported sessions | Allowed/denied paths, account generation/revocation, no offline bundled library, no avatar request in signed-out/safe mode, failed media does not break chat |
| Shared conversation boundary | Prove reusable conversation presentation with native and cloud data owners | Streaming, attachments, approvals, reconnect and generic fallback; record remaining legacy scenarios before replacing any existing screen |

After each key stage, **four independent GPT-6.1 Sol reviewers configured with
max reasoning** inspect read-only. They do not edit files or create commits.
The requester specified the reviewer count and model. The harness permits
three child agents concurrently, so reviewers may run in successive groups;
all four inspect the same frozen stage. Findings become work only when they
reproduce a violation of this contract. Required corrections are checked
before the stage commit. Review and validation results are recorded below.

## Prerequisites and evidence boundaries

The historical `spikes/PHASE0_GATE.md` and `docs/12_OPEN_RISKS.md` include open
release/native-session risks. This work does not declare those risks closed,
change existing native session startup/authentication/tree semantics, or
claim new platform release readiness. Before implementation, the existing
LF codec/redaction self-test, process-tree unit suite (15 checks) and scanner
suite (8 checks) passed on this Windows checkout. These are synthetic/unit
evidence, not a real-provider or Linux containment claim. New cloud execution
and host media paths must have their own focused evidence.

Windows browser checks must use persistent profiles, following AGENTS.md.
Test output goes to ignored temporary paths. Heavy dependencies are linked
or reused from existing caches on D:, not copied into each checkout.

## Stage ledger

### Visual foundation

Completed and verified for the stage commit. Later stages remain in progress.

Four independent read-only reviews inspected the same staged candidate against
`b872807d285c1bc38e39a2c8febf5746d635ad30`, all using `gpt-6.1-sol` with `max`:
`stage1_review_1` (Faraday), `stage1_review_2` (Maxwell),
`stage1_review_3` (Nash), and `stage1_review_4` (Archimedes).

Confirmed findings and corrections:

- Segmented controls expose radio roles; browser tests now use those roles,
  checked state and arrow-key focus traversal.
- Persisted teammate identity colors retain their original values. Actual
  ornaments use separate decoration tokens.
- Active v1 plugin palettes retain their previous fallback colors, including
  ornaments, so partial overrides do not lose existing contrast. Style shapes
  remain independent.
- Selected teammate role text and status badges use readable semantic
  foreground/background pairs instead of translucent accent combinations.
- Persistent Windows test profiles are namespaced by stable workspace and
  endpoint identity, keeping retry reuse without parallel-run collisions.
- Native proof now observes keyboard traversal and computed palette changes.
  Browser request observation is explicitly WebView-only; it does not claim
  to observe Rust-host network traffic.

Validation:

- Stage 1 Svelte/TypeScript: zero errors and warnings; E2E TypeScript passed.
  The isolated Svelte check excludes only the uncommitted Stage 2 graph files.
- Focused style/plugin unit suites: 38/38 passed. The earlier full unit run
  had 1,237 passes and two failures during concurrent builds; both
  affected suites passed separately (16 tests). This is not claimed as a clean
  repeat of the whole suite.
- UI Lab: all five style scenarios passed; the partial-plugin scenario passed
  again after adding the dark accent/capability-glyph regression case.
- Real Tauri/WebView2: the normal scenario completed its keyboard, computed
  palette and reload assertions, with captured Nano/Chaos/light/dark windows.
  A separate `--safe-only` clean start passed the safe-mode banner, disabled
  composer, readable catalog and style-keyboard checks. The controller proved
  an empty Job Object before removing its fixture. WebView2: `157.0.0.0`.
- Rust account checks passed for restoring without a token and safe-mode local
  sign-out without a network revocation. These complement the unchanged host
  command guards and the local-only style setter; browser request observation
  alone is not host-network instrumentation.
- Production builds succeeded for both the candidate and clean baseline
  `b872807d285c1bc38e39a2c8febf5746d635ad30`. First-screen assets were 164,847
  gzip bytes / 558,211 raw bytes on baseline, and 165,843 / 564,363 on the
  candidate: +996 gzip bytes / +6,152 raw bytes. The existing 163,840-byte gzip
  budget fails on both; its value is unchanged. This asset smoke is not a
  release startup benchmark.
- Native dev-window process-tree snapshots measured 692,908,032 working-set
  bytes / 436,785,152 private bytes for Nano Settings, and 597,581,824 /
  353,488,896 for safe mode (all nine owned processes measured). These are
  candidate dev measurements, not a baseline delta or release RSS promise.

Verification limits: the combined native scenario failed to announce a new
WebView automation page after its forced normal-to-safe restart. The normal
scenario and an independent clean safe start passed; the restart issue is not
claimed fixed. Linux/native release gates remain separate. No real-provider
turn, production change or installed-app replacement was performed.

Test-harness correction: an isolated controlled-process probe found that
`cmd -> pnpm -> Vite` missed the existing 30-second startup bound, whereas
launching the same Vite CLI directly with Node was ready in 8,244 ms. The
harness now uses that direct launch. Native process startup uses the existing
startup bound rather than the shorter UI-command bound. No new bound was
introduced.
