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

### Shared web graph

Implemented, reviewed and verified for the stage commit.
The shared package mounts Desktop's actual graph canvas and v1-v5 portable
parser in a scoped browser island. Blazor owns authentication, workspace/profile
lifetime and storage. Import creates a new unsaved identity; save atomically
stores the entire portable v5 document with compare-and-swap revision checks.
Identical retries after a lost acknowledgement return the same saved revision.
There is no execution endpoint in this stage.

Four independent read-only reviews used `gpt-6.1-sol` with `max`, all against
the same frozen trees (`f879282718090884ed65c4b4c413969edefb35b1` in PIUI and
`4b84cfb2116ddf72fdb15ce8ed223067b45cd6b5` in NanoAgentProject):
`stage2_review_1` (Gauss), `stage2_review_2` (Heisenberg),
`stage2_review_3` (Dewey), `stage2_review_4` (Schrodinger).

Confirmed corrections:

- Pending raw JSON owns editing until applied/discarded; it cannot overwrite a
  later canvas edit. Focused text input immediately marks the draft dirty.
- Lost-create acknowledgements allow guarded Reload; conflict actions survive
  subsequent validation. Forks preserve pending document edits.
- Portable IDs cannot collide with synthetic canvas nodes or concatenated edge
  IDs. Keyboard node selection opens the inspector.
- Each mount has its own locale context and tooltip portal. Production resolves
  one locale module and replaces the dependency's NODE_ENV expression at build.
- Only actual workspace/profile/navigation changes prompt for dirty drafts.
  Same-scope agent changes and transient refresh errors retain the editor.
  Accepted navigation freezes and retires even a previously clean editor before
  awaiting a mutation, preventing newly typed text from being discarded later.
- Scope rejection bypasses the generic session-recovery throttle. A stable mount
  token and shared retirement task remove callbacks/beforeunload before forced
  navigation, including detached elements and late module loading.
- The existing Hermes back-stack remains the sole owner of browser history.
  A competing NavigationLock caused repeated chat fragments and a blank page in
  the actual browser; explicit scope/logout guards and beforeunload protect the
  draft without a second history owner.
- The server parser accepts recursive predicates beyond the .NET JSON default;
  depth derives from input length, and the locally registered schema evaluator
  refuses insufficient CLR stack capacity safely. Escaped NUL is preserved in
  the document and escaped only in its PostgreSQL listing label.

Validation:

- 134 focused controller/parser/render-identity/Desktop-editor tests passed;
  the faithful lost-ack fixture correction passed eight controller tests again.
- Whole Desktop and shared package Svelte/TypeScript: zero errors and warnings.
- Static published-module browser suite: 3/3 passed with clean teardown; the
  corrected changed-after-lost-ack case passed again (1/1). It serves dist bytes
  directly, without Vite rewriting or a process shim, and checks independent
  English/Russian mounts while preserving the outer French host document.
- All 105 source hashes match staged Git UTF-8/LF objects; all three artifact
  hashes verify. Source tree SHA-256:
  `3e154fbb62146336c2a87887cbe6be6fce24b995ce5b9d1d6d7f2dc5a4e7b1a8`.
- 17/17 focused .NET tests passed, zero skipped, including actual PostgreSQL
  migration/CAS/ownership, exact deep-predicate/NUL round trips, controlled stack
  refusal and distinct API error codes. Future-stage source is excluded.
- The actual Blazor WASM host and published Svelte module passed all 15 lifecycle
  checks with clean exit: save, conflict/reload, invalid import, dirty navigation,
  transient failure retention, scope retirement, delayed logout, held request
  cancellation and delayed CSS/module completion. HTTP responses in this browser
  proof are synthetic; PostgreSQL behavior is proven separately above.
- The final WebApp build passed with one pre-existing unused-field warning;
  the imported artifact check passed. Proof logs and screenshots are kept in the
  task-owned D: scratch directory, outside source and release deliverables.
- A focused happy-path Blazor probe imported the existing two-agent fixture,
  proved all four cards inside the canvas before manual Fit, edited a task,
  connected Research to Review and saved through the actual .NET bridge. The
  parent inspected the resulting screenshot; the populated graph is visible.

Boundary retained deliberately: direct PUT validates the fixed embedded schema;
portable semantic validation belongs to the shared import parser and execution
admission. A schema-valid direct API document can therefore be refused by the
editor's semantic parser. Storage never evaluates scripts or grants execution.
The initial Vite-hosted browser run masked production module defects and ended
with a teardown timeout; the static artifact tests above replace that evidence.
No production database, real-provider turn or installed application was changed.

### Server avatars

Implemented, independently reviewed and verified for the stage commit. This
independent stage commits before cloud execution; it adds no graph/runtime dependency.
The bundled offline atlas is removed. Rust owns authenticated catalog,
manifest and media requests; the main WebView receives temporary checked
pixels and a versioned descriptor. Account/workspace/capability/entitlement
custody revokes in-flight work and releases decoded bitmaps. Signed-out and
safe-mode applications expose neither an avatar slot nor its setting.

Four independent read-only reviews used `gpt-6.1-sol` with `max`, against the
same immutable PIUI tree `94cc9c8ad4cd2824347f748c96c9bab860da14fc` and server
tree `7236ed57aa53e3c2d288478fabb394ea860d9958`:
`stage4_review_1` (Parfit), `stage4_review_2` (Dirac),
`stage4_review_3` (Mill), `stage4_review_4` (Epicurus).

Confirmed corrections:

- Desktop uses the shared descriptor's normal first pass, subsequent hold
  sequence, reduced-motion `still` frame and return to idle after finite repeats.
- An authoritative feature/workspace refusal clears only the requesting avatar custody's
  cached entitlement. A late request cannot revoke a new account/workspace.
- Server post-read access checks include the authoritative user token cutoff,
  including password reset before the device row is lazily marked revoked.
- Custom avatar readiness is checked again after the descriptor/access reads,
  refusing media deleted while those reads were in flight.
- Existing Settings assertions now require no avatar switch for signed-out,
  expired, free-plan, unavailable-server and safe-mode states; the entitled
  setting retains its accessible name.

Validation already completed:

- Focused renderer/client/state units: 18/18 passed after animation corrections;
  Settings: 17/17 passed. E2E TypeScript passed, so the proposed missing ambient
  declaration error did not reproduce. The earlier whole Desktop Svelte check
  had zero errors and warnings.
- Final Rust avatar HTTP/custody suite: 9/9 passed, including typed entitlement
  and workspace denials, no repeated load after denial, stale scope fencing,
  held-body cancellation and ordinary media errors preserving entitlement.
  All-target `piui-nano` clippy with `-D warnings` passed. The original whole
  account suite had 119 passes before the additional avatar cases.
- UI Lab avatar flow passed for entitled Pi/Hermes chats, keyboard preference,
  sign-out, free-plan and safe-mode absence, with no Nano or old-atlas browser
  request. Host network isolation is established separately by Rust checks.
- Initial actual Tauri/WebView2 normal and fresh safe-start proofs passed with
  empty owned Job trees and removed fixtures. Normal proof decoded and painted
  generated synthetic WebP, refused corrupt media, released its bitmap, and
  refused a signed-out host load. Safe mode refused the host load without a
  network request. The final normal proof also passed actual pixel comparison
  against the descriptor's error `still` frame, with clean owned-job teardown.
  WebView2 was `157.0.0.0`; executable SHA-256:
  `3dd2f6bdfde54c64559aafb9569c7f4f7497a7c7709cdf60668c513862a1e4a5`.
  Synthetic decode took 69.1 ms and mount/paint 69.2 ms on this loaded machine;
  these are fixture measurements, not a release startup benchmark.
- Server remediation build: zero errors; avatar tests: 34/34 passed, no skips,
  including actual checked-in stock media, device/account cutoff, custom
  deletion during reads and conditional/range header refusal. The first pass
  exposed a test assertion's null `StringValues` conversion; checking the absent
  header's count corrected the test.
- Actual Blazor loaded `/pets/atlas-v1.json` successfully and initialized
  `window.hermesPets`. That fixture has no selected pet, so this proves shared
  descriptor initialization, not stock sprite animation in the browser.

No paid account, real provider, deployment or installed executable
replacement is implied by these synthetic HTTP and rendering fixtures.

### Cloud execution

Implemented, independently reviewed and verified for the stage commit.
The server freezes an explicitly selected saved draft, uses the packaged Rust
transition core, and persists exact native-effect identities before dispatch.
Hermes retains native history and agent execution. Unsupported cloud profiles
remain intact in the draft and are refused before execution.

Four independent read-only `gpt-6.1-sol` / `max` reviews inspected the same
PIUI tree `38ef1167a59158126cc6e68be5ed995ea54f6ad7` and server tree
`43f2e585319d51d498a3ff563034ab4139fa292d`:
`stage3_review_1` (Hubble), `stage3_review_2` (Kepler),
`stage3_review_3` (Bacon), `stage3_review_4` (Sagan).

Confirmed corrections cover pending-versus-started cancellation, checked
recovery after a durable native acknowledgement, exact unmodified native
message reads, repeated stream deltas and foreign stop frames, authoritative
free-plan modes, empty prelaunch tasks, portable NUL identifiers, immutable
rejected-command receipts, paused pending reservations and progress after
approval while another branch remains active. Program routers now obey human
approval, pass declared selection fields, and explicitly refuse boolean review
semantics. Team work and graph effects share the existing native concurrency
policy. The web controls support pause/resume and deliberate repeat; retry
confirmation is scoped to its run, and stale/unverifiable result text is evicted.

Final kernel checks passed: orchestration 99/99, kernel 13/13, all-target clippy
with warnings denied, portable routed example validation, and Windows/Linux
packaged executable probes. Source fingerprint:
`73fc416766319b87e1863ba1526787d00ab6dc4835537844256e860d43f06df6`.
The Linux artifact ran in the actual server base image as non-root with a
read-only filesystem and no network, without source or a Rust toolchain.
Native runtime patch tests passed 6/6 using real SQLite and synthetic delivery.

The final integrated server build succeeded. All 59 selected .NET tests passed
without skips: 56 graph/native-proxy/shared-work-capacity cases and three
conversation projections. The graph cases use the packaged Windows kernel and
real isolated PostgreSQL; native delivery remains synthetic. The first
remediation run exposed a scoped EF identity-map stale ACK and a blank-prompt
fixture that still requested nonempty structured-result instructions. Commands
now refresh tracked state before their new transaction; the blank-prompt fixture
removes those instructions. The passing rerun covers both corrections.

Actual compiled Blazor with the published graph bundle passed all 19 integration
checks, including explicit profile conversion, typed inputs, lost-ACK identity,
pause/resume, deliberate repeat, fresh verified results, cross-run retry guards,
reconciliation, cancellation and older optional-port editing. The parent inspected
the final screenshot. Browser execution HTTP is synthetic; this complements the
real PostgreSQL/kernel proof rather than claiming a real-provider run. The first
expanded smoke invocation supplied a v2 example while adding v5 fields; the parser
correctly refused it. The harness now checks its fixture version and uses the
existing v5 example. Graph source fingerprint for this stage:
`a6b2467518d4ec1cf36fc916a6a7d6e7b496f42cd6141d21025b52d6c1c014eb`.

Two proposed scope expansions were rejected: a later draft save does not
invalidate an already verified frozen revision, and graph delegation refusal
does not claim to disable normal tools inside the admitted native harness.
Those ownership boundaries are explicit in the server contract.

### Shared conversation boundary

Implemented, reviewed and verified for the stage commit.
Desktop's real transcript and approval wrappers now use the shared presentation.
Native plugins, history, composer and dispatch retain their owners. Blazor offers
an explicit preview and return to its ordinary transcript; Home retains transport,
uploads, streaming, paging, approval, notifications and PDF export. This is the
verified boundary for incremental migration, not full legacy-screen parity.
The eligible Desktop sidebar exposes This computer and Open Nano Cloud without
moving local sessions; the existing cloud window remains isolated from IPC.

Four read-only `gpt-6.1-sol` / `max` reviews inspected the same immutable PIUI
tree `26cc554265e03ca87f0184982d5aa90cceb29ad1` and server tree
`e9647e76e9be250e9fdaadac11262591749575c5`:
`stage5_review_1` (Aquinas), `stage5_review_2` (Nietzsche),
`stage5_review_3` (Einstein), `stage5_review_4` (Chandrasekhar).

Confirmed corrections:

- Home fences stale history, reconnect continuations and approval notifications
  at the actual state owner, including A-to-B-to-A selection, late failures and
  a same-session history response arriving after a new streamed turn.
- A destroyed native approval card cannot send a global toast into another chat.
- Loaded-window search follows current streaming/paged blocks, reconciles its
  selected match and returns keyboard focus after Escape.
- Cloud text does not decode native pipeline envelopes or the literal `[image]`
  marker. Only the native owner enables that interpretation.
- Durable reading position is supplied only by the existing native wrapper.
  Cloud mounts leave no account/session position identifiers in localStorage,
  including temporary conversations and teardown.
- Long approvals have a labelled, keyboard-scrollable region so their buttons
  remain reachable in the owner's constrained viewport.
- Opaque attachment IDs bind resource identity rather than array position.
  Reordering cannot redirect an existing button; removed resources are refused.
- Existing completion notifications remain visible in preview. PDF export
  deliberately restores and awaits the ordinary transcript before printing.

Validation:

- Final whole Desktop, graph and conversation Svelte checks have zero errors
  and warnings; E2E TypeScript passes. A new native fixture initially imported
  the UI barrel, exposing Svelte-only type exports to plain TypeScript; importing
  the same toast singleton directly fixes that test-only dependency.
- Focused native/shared units passed 23/23; the changed controller passed 6/6.
  Existing Lab scenarios have six passes in the first seven-case invocation and
  one passing focused renderer rerun. The renderer failure resolved its fixture
  hostname to a foreign IPv6 server; a process-local IPv4 rule corrected the
  harness. The passing scenarios cover streaming, safe mode, form validation,
  damaged history, plugin renderer success/fallback and work-location navigation.
- The final static published conversation artifact has passing evidence for all
  five browser scenarios: four passed together, followed by one focused search
  rerun after its replacement fixture stopped retaining an attachment for a removed
  block. Checks include live search/focus, long approval scrolling/keyboard,
  native/cloud literal handling, no cloud persistence, owner fences, streaming,
  attachments, approvals, reconnect, generic fallback and scoped locale/styles.
- Actual Tauri/WebView2 passed native/shared rendering, generic fallback,
  streaming, focused owner attachment/approval actions, reconnect/disposal and
  suppression of a late destroyed-card failure. The parent inspected its capture.
  WebView2 was `157.0.0.0`; executable SHA-256:
  `312c3a3380eb8a962688d3e61542b7becf2d90a9668344ae429b4785bb5164e4`.
  Owned Job teardown was empty and the fixture removed. Native actions use DOM
  focus/click; OS keyboard delivery is not claimed. Keyboard interaction is
  independently covered by the browser scenarios. The process snapshot measured
  nine of eleven owned processes: 530,620,416 working-set bytes and 287,866,880
  private bytes, explicitly incomplete and not a release startup benchmark.
- The separate conversation production build passes its native/Lab import
  boundary. All 80 normalized source hashes and both artifact hashes match the
  imported dependency, source fingerprint
  `e82d5592e5c6b0b952b7663e939930d92531b895d40e0b92952b12605d851bba`.
- The graph artifact was independently rebuilt/imported after the shared Russian
  catalog additions. All four static graph integration scenarios passed on those
  exact bytes. Its final source fingerprint is
  `566e69c624953712b8757b8f974c2aa2e070c2356f4899ccb5d027ea6a9b7e44`;
  the Stage 3 actual Blazor proof above records its pre-catalog artifact separately.
- Final Blazor incremental compilation succeeds. All four projection tests pass,
  including stable IDs across reordered/duplicate/removed attachments. Earlier
  integrated graph/native tests are recorded under Cloud execution above.
- Actual compiled Blazor and the published conversation bytes passed the extended
  owner integration flow: ordinary default, keyboard opt-in, loaded/generic
  history, search, file preview, partial SSE and cursor reconnection, notifications,
  keyboard approval, retry without another send, A/B and A/B/A held history,
  same-chat history versus a new stream, stale approval/older-page failures,
  populated PDF fallback, return to ordinary view and late CSS disposal/remount.
  There were no page or fixture errors. The parent inspected the final capture.
  First opt-in mount measured 402 ms on this machine. The fixture records two
  deliberate sends, two approval requests and two resume streams; it is synthetic
  HTTP/SSE integration, not paid-provider usage. Its first run incorrectly omitted
  CompletedAtUtc from a completed turn; correcting the fixture's existing DTO
  semantics resolved that failure without changing product behavior.

A proposed per-session preview consent gate was rejected: the explicit tab-level
presentation choice intentionally follows ordinary navigation and grants no new
authority. A fresh panel defaults to the ordinary transcript. Full composer,
branch/edit/copy, cost, custom renderer, media and other legacy parity remains
documented in `SHARED_CONVERSATION.md` and the server's shared-conversation guide;
this stage does not claim those migrations, real provider use or deployment.
