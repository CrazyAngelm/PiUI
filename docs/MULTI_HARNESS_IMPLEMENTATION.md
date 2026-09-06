# Multi-harness PiUI implementation

## Authorized outcome
The user authorized implementing the previously recommended PiUI product: normal project/session chats for Prime Agent and Codex alongside Pi, plus configurable agent profiles, mixed-harness teams, pipelines and reusable launch commands, with a polished desktop UX. Execution remains in native harnesses. No new provider client or agent loop belongs in PiUI.

## Acceptance contract
- A trusted workspace can create, stream, stop and reopen native Prime Agent and Codex sessions. Model selection, visible tool activity, errors and native approval requests are routed through typed adapters. Pi continues to work.
- Workspace identity is independent of a session/member harness. Switching views never replaces or corrupts another active native session.
- Named agent profiles define harness/model/instructions and supported tool/spawn policy. Unsupported mandatory restrictions reject launch; advisory restrictions are labelled, never advertised as an OS sandbox.
- Team definitions support explicit participants and directed message permissions; runs snapshot definitions and record task/message state separately from native transcripts. Dynamic spawning is policy-checked and cannot widen authority.
- Pipelines execute dependency-ordered tasks, expose results/failures/cancellation and a reusable named launch action. Uncertain side effects are not replayed blindly after restart.
- UI offers Sessions, Agents, Teams, Pipelines and Runs with progressive disclosure, clear harness identity and approvals, keyboard support, accessible labels, loading/empty/error states, light/dark themes and safe-mode/generic fallbacks.
- Native session history remains authoritative. PiUI catalog remains rebuildable; user-authored orchestration definitions/run journal are separate durable data. No direct JSONL mutation, frontend credentials, arbitrary WebView shell/FS access or implicit project-code trust.
- Unit/contract tests, Windows native E2E, runtime probes and perf smoke prove actual paths. Windows/Linux lifecycle behavior is tested in appropriate environments; an unavailable environment is reported as an open verification blocker, not a pass.

## Latest verified status
- Windows workspace-v11 native E2E PASS, including zero-turn same-ID reopen/reclose, graceful disposal, persisted definitions, rejected-policy runs, forged boundaries, safe mode, and empty owned Job before fixture removal. Evidence: `target/piui-evidence/21760-1788691641684/report.json` and seven PNGs.
- Real Prime default-provider marker turn and same-native-ID history resume PASS. Real two-task managed Prime dependency DAG PASS with native tools disabled: predecessor content hash, downstream native input and copied assistant output verified. The integration uses Tauri MockRuntime only for state/events; native host, scheduler, provider and histories are real. Source-controlled Windows integration-test manifest preserves the production manifest and default Cargo tests.
- Latest completed UI checks: 148 tests, Svelte/TypeScript 0 errors/0 warnings, contract tests 22, build and asset-size smoke PASS. Final default Rust verification after the opt-in native-test seam: 318 passed, 11 ignored; workspace clippy/all-targets with `-D warnings` and fmt check PASS.
- Remaining external validation blockers: Pi native turn authentication failure; Codex native turn error without a structured category; no Linux lifecycle/containment evidence. These are not a full release-readiness pass.

## Existing state and preservation
The worktree already contains extensive uncommitted Pi/Prime history, E2E and containment work. Preserve it. Starting source has Prime 0.8.1 read-only live denial, a single live slot, Pi/Prime v10 contract, no Codex lane, and mostly planned richer extension surfaces. Installed Prime is 0.9.2. Prior research is static, not runtime proof.

## Initial plan and ownership (historical)
1. In progress: isolated Prime 0.9.2 lifecycle/compatibility spike (`prime-live-spike`, owns `spikes/prime-agent-092/`). Never use the default daemon endpoint.
2. In progress: installed Codex app-server native protocol/lifecycle spike (`codex-live-spike`, owns `spikes/codex/`). No credential inspection or global config changes.
3. In progress: concrete workspace UX design (`workspace-ux`, owns `docs/MULTI_HARNESS_UX.md`). No UI implementation on unproven runtime assumptions.
4. Root: versioned host-neutral execution/coordinator contract and ADR; bind adapter implementation after spike evidence. Introduce small separate module, not another harness.
5. Implement native adapters, multi-session host integration and durable coordination vertical slices with tests.
6. Implement polished desktop flows against real host commands; extend native E2E fixtures.
7. Run quality, runtime, packaged flow and performance checks; fix contract-breaking failures and report remaining concrete blockers accurately.

## Validation log
- Baseline `pnpm test` and `pnpm check` both passed (managed jobs completed 2026-09-06).
- Workspace v11 typed frontend client: red test confirmed missing implementation; green check running.
- `native-supervisor` owns new Rust native transport and bridge runner/Pi adapter; `prime-live-spike` and `codex-live-spike` own their native bridge factories after probes.
- `workspace-host` owns new Tauri workspace session map/registry/commands; root wires existing state/lib/legacy trust changes.
- `coordination-domain` owns separate orchestration crate and TS v1 schema. Root owns v11 workspace schema, frontend client and later integration.
- `workspace-ux` owns target UX and forthcoming new workspace surfaces, not legacy App state.
- No model prompts or runtime probes from the research phase are counted as execution evidence.

## Current design decisions
- Existing Tauri/Svelte/component-scoped CSS stack remains. No framework migration or cloud/account system.
- Keep ordinary chat as the default. Team/pipeline functionality is optional and lazily loaded.
- Separate workspace, agent definition, team definition, pipeline definition, run and native session identities.
- Separate spawning hierarchy, message edges and observation permissions.
- Cross-harness orchestration is host-owned deterministic scheduling/routing. Each native runtime still owns model/tool loop, auth, compaction and transcript persistence.
- No invented agent quotas, retry counts, spend budgets or performance promises. Runtime-specific limits remain labelled; resource choices requiring owner input are not silently manufactured.


## Implementation checkpoint (2026-09-06)
- User authorized full implementation, not another research report. Continue until implemented/verified or concrete blocker, no extra approval gate for ordinary work. No /goal was requested/started.
- ADR-023 appended to docs/10_ADR.md. New workspace v11 contracts in contracts/workspace-v11.ts; old v1-v10 untouched. PermissionMode includes native (preserve native policy; no extra sandbox), read-only, workspace-write, full-access (explicit bypass only).
- Root wrote host-api/workspaceClient.ts and tests. Red missing-module proof then 4 green tests. Baseline pnpm check/test passed. Root exposed api::verified_project_directory pub(crate).
- Root added crates/piui-orchestration workspace member. Domain worker created crate and TS orchestration-v1.ts; 8 Rust tests/clippy/fmt + strict TS pass. It is now extending profile permissionMode/modelProvider and writing real Tauri orchestration API/store plus orchestration-host-v1.ts; runtime scheduling must bind real terminal events.
- Codex spike COMPLETE: spikes/codex/DECISION.md + reports/verification.json; installed CLI 0.147.0 schemas generated; isolated prompt-free handshake/start/inject/read/resume/list verified, root+grandchild Job cleanup verified Windows. 6 unit+native passed, clippy passed. No real model/auth turn yet. Native zero-turn thread not list-visible; do not assume persisted on thread/start. Per-process app/plugin/shell snapshot warmup must be disabled (avoid first paint/network). Production adapter INHERITS normal CODEX_HOME without reading/copying credentials; normal threads not ephemeral. sessionDir is not CODEX_HOME.
- Prime spike IN PROGRESS: installed 0.9.2, exported in-process SDK avoids daemon entirely; wraps InProcessAgentConnection. Need real synthetic-provider ipython/RLM+descendant cleanup evidence and native agent_message/observe compatibility. Probe launcher explicit inert nondefault --daemon-socket per repo guard. Production must preserve normal native auth/global resources via SDK APIs and avoid default daemon; strict requested OS policies unsupported if cannot enforce. Existing legacy Prime fail-closed guard untouched.
- Native supervisor design: Rust-owned per-session bridge child inside Windows Job BEFORE resume/Unix group; native factories+common runner embedded at compile time, no writable temp scripts. Windows 32767 UTF-16 command-line ceiling: parent requested small -e bootstrap reading exact length-prefixed trusted source from stdin then data-URL import; normal LF JSON requests follow untouched. Native-supervisor implementing this and allowed to update bridge CONTRACT embedding paragraph. Factories only unique exported create*Adapter, imports/helpers inside.
- Old research children were deleted via rlm.delete_subagent(handle.rlm_child_id); spawn-handle objects are NOT accepted by delete_subagent.

### Active ownership
- prime-live-spike: spikes/prime-agent-092/, then bridge/prime.mjs + tests.
- codex-live-spike: spikes/codex/, then bridge/codex.mjs + tests.
- native-supervisor: crates/piui-runtime/src/workspace_runtime.rs, bridge/runner.mjs + pi.mjs/tests; root wires lib.rs exports. Early API NativeRuntime::spawn(NativeRuntimeConfig)->(handle,mpsc NativeEvent receiver); snapshot,prompt,interrupt,models,set_model,respond,rename,dispose. Native host-private DTOs mirror bridge CONTRACT.
- workspace-host: NEW apps/desktop/src-tauri/src/workspace_api.rs (+workspace_store.rs), WorkspaceHost::open(app_data_dir), runtime map/registry, workspace_command_v11, piui://workspace-event. Root adds HostState.workspace and module/command wiring. Must call shutdown_workspace(project_id) on trust revoke/remove under existing operation gate, shutdown_all on app exit. Helper api::verified_project_directory already pub(crate). Coordinate with orchestration worker launch profile/run/member and completion seam.
- coordination-domain: crates/piui-orchestration, contracts/orchestration-v1.ts; now NEW contracts/orchestration-host-v1.ts, orchestration_api.rs (+store). Parent wires fields/deps/commands. Needs actual native completion not first idle; immutable run snapshots, no replay uncertain work. Broker native tool interface not yet designed/implemented.
- workspace-ux: docs/MULTI_HARNESS_UX.md COMPLETE; now NEW features/orchestration/ panels and host-api/orchestrationClient.ts/tests. No legacy/root/global tokens edits.
- session-workspace-ui: NEW features/workspace/ WorkspaceShell.svelte + helpers/tests. Normal sessions default with project/harness selection, permissions/approvals/events/navigation; lazy OrchestrationPanel; callback onOpenLegacyHistory. Root wires App/main and tokens. Existing App remains legacy history accessible. UI unmount MUST NOT dispose host runtime.
- Root: docs/ADR/plan, workspace-v11.ts, workspaceClient.ts/tests, existing state.rs/lib.rs/api.rs/root Cargo/package wiring, global tokens, E2E/perf and integration fixes. Never overwrite dirty baseline.

### Next root actions
- Finish frontend client status in plan; wire new modules only after files appear and APIs confirmed (no stubs enabling runtimes).
- Add piui-orchestration dependency to desktop Cargo; export workspace_runtime module in runtime lib when created.
- Wire HostState workspace + orchestration open, Tauri routes, trust revoke/remove/identity failure shutdown, explicit app-exit cleanup. Existing old routes unchanged.
- Need actual managed agent send/spawn/observe tool bridge with authenticated caller channel; not just buttons/domain ACL tests. Coordinate factories/supervisor/coordinator. No arbitrary shell or spoofable from parameter; native unrestricted shell/Python bypass labelled advisory unless isolated.
- Need mixed native session history discovery (not only newly created session registry), real model turn proof after safe bridge adapter built, credentials stay native. Small actual test task in isolated temp cwd permitted by user implementation intent but do not inspect auth files or probe default Prime daemon.
- Validate/new UI through actual Tauri WebView2 E2E, safe mode and existing legacy flows; measure perf baseline/new. Existing E2E harness feature-gated loopback driver and external Job runner; Linux missing environment remains unverified not pass.
- Current root managed jobs baseline passed; workspace client green job log passes 4. No wait/poll loops; background_job completion wakes session.


### Integration checkpoint (2026-09-06, after native spikes)
- Prime 0.9.2 Windows SDK spike now PASS: 5 tests, native ipython/RLM, abort/EOF/forced descendant cleanup, no default daemon. Factory landed; 4 unit tests and prompt-free native factory smoke passed. Native family message/observe controller not available by default; do not claim full daemon capabilities.
- Codex factory landed; initial 3 tests passed, coordinator dynamic tool integration in progress. Codex 0.147.0 thread/resume has no dynamicTools parameter: managed coordinator-enabled resume fails closed until proven; ordinary resume remains supported, native history preserved.
- Root exported runtime workspace_runtime module; wired WorkspaceHost in HostState and v11 command; wired separate managed OrchestrationApiState, modules and 19 v1 commands; desktop orchestration dependency added.
- Root trust/remove/identity failure retirement now stops workspace native sessions. Explicit app exit prevents duplicate close bypass, sets closing before operation gate, awaits all native + legacy runtime shutdown. verified_project_directory(...,true) rejects while shutting down. Need compile/lifecycle tests; not yet proven packaged.
- Root applied neutral palette and static skeleton. New palette tests pass WCAG 2.2 AA text/control contrast across neutral surfaces; light accent corrected to #436732, danger #963f36, warning #785714. 4 palette tests + 4 workspace client tests pass.
- NEW orchestration-scheduler worker owns only orchestration_scheduler.rs: actual ready-task native execution/completion/cancel, dependency refs, reverse tool side effects, tests. Domain worker owns API/store and wires command calls; workspace-host owns reverse event actor binding/forwarder. Root wires module/state/shutdown upon requested API.
- Reverse coordinator tool strict intents and trusted response protocol appended to bridge CONTRACT. NativeEvent coordinatorRequest actor derived from runtime/run/member; roster, send(recipientMemberId/body), observe(targetMemberId), spawn(stepId). Spawn only ready predefined step/exact snapshotted profile; no arbitrary dynamic members/overrides. Persist reservation before side effect; restore uncertain, no replay.
- Spawn profile allowlists constrain WORKSPACE tool only, not OS/native Python/RLM. Do not force unsupported nativeSubagents=false on all Prime runs; explicit mandatory deny still rejects. Editors must label enforcement honestly.

- First integrated production build passed (171 modules). Indexed legacy App and orchestration editors are lazy chunks; default Sessions static graph contains only index JS/CSS. `perf:smoke` now uses the Vite manifest static graph with the UNCHANGED existing 260 KiB startup asset ceiling instead of summing deferred chunks. It reports initial AND total/deferred bytes; no increased budget, and no claim this measures native startup/RSS/scroll. Root E2E compatibility suite explicitly uses ?view=classic; new default route tested separately.


### Queued notifications reconciled (user screenshot, 2026-09-06)
User asked to absorb all queued agent/background notifications. All visible agent messages were already integrated: scheduler shutdown wired; history module exported once file landed; closed/safe read-only history delegated and integrating; screenshot capture+resize helper uses owned Job-runner parent PID, not guessed app PID; forged profileId removed from ordinary create and rejected; Codex zero-turn durable binding fix in workspace-host work.
Completed root jobs reconciled from their logs:
- Workspace client RED failed as expected before implementation; GREEN passed 4.
- Palette first check failed light accent contrast; corrected palette passed 4.
- Integrated frontend check passed with one subsequently removed editor CSS warning.
- Root entry/client/palette regression job passed 10.
- Production frontend build passed: initial static assets 165063 bytes, total 449209, deferred 284146. Existing initial budget 266240 unchanged; native perf not yet measured.
- v1-v11/orchestration frontend contract suite passed 19.
- Screenshot helper initial Python syntax check passed; actual capture/resize still needs E2E.
No need for user to resend notifications. Their visible queue removal is a harness UI function, not a repository change.


### Native integration checkpoint (2026-09-06)
- Full frontend suite now PASS: 134 tests in 27 files. Old queued red-client/palette failures are resolved; do not reopen them.
- Scheduler module and managed state are wired; begin_shutdown is called synchronously before native teardown. Domain start/cancel/retry commands now call scheduler and include HostState scope/trust/safe/closing guards; all CRUD rejects unknown workspace namespaces.
- Ordinary createSession no longer accepts decorative profileId. Exact saved-profile bindings only come from scheduler; forged profileId negative tests added.
- workspace_history file exists and `pub mod workspace_history` is CURRENTLY exported in index lib.rs. Repeated child messages saying missing export were stale; inspect disk before editing. Workspace-host integrating closed/safe snapshots and content-hash refs.
- All native adapters now emit explicit turnCompleted. Prime only stop/length succeed; error fails, aborted interrupts, toolUse/unknown remain uncertain. Idle is never success. Prime tests 8 passed; combined bridge tests have passed 25 before newest additions.
- Opt-in actual NativeRuntime default-model turns FAILED for Pi/Codex. Prime actual native resource initialization timed out at existing20s watchdog. No real live-readiness claim. Prime author diagnosing initialization phases with safe timing; Codex author classifying structured native errors; supervisor owns native ignored tests. Do not read/copy/log auth or change user settings.
- Root wrote scripts/capture-webview.py (Win32 exact owned child/title, PrintWindow client capture, DPI-aware resize; no desktop fallback); initial syntax passed, native visual proof pending.
- New --workspace mode is wired through existing outer+inner WebView2 E2E runners and package script test:e2e:workspace. Workspace mode uses code-only installed package junctions, empty native homes and credential-free environment, never synthetic production CLI. Existing classic-v10 suite uses ?view=classic.
- First actual E2E failed cargo build101 before UI, but old harness destroyed diagnostics. Root fixed controller to preserve ONLY generated logs/PNGs in target/piui-evidence before native fixture deletion. Nonzero target with proven empty closed Job no longer doubles as cleanup failure. Retry `workspace_e2e_retry` running; result awaited by managed wake, no polling loops.
- UX worker now implementing real launch/cancel/retry controls plus run invalidation events (not permanently read-only). Native environment failures must show honest errors; safe-mode disables actions.


### Verified Windows milestone (2026-09-06)
- Full `cargo test --workspace` PASS: 311 passed, 11 intentionally ignored native/live tests. `cargo fmt --all -- --check` PASS. Full workspace/all-target clippy running separately.
- Actual workspace WebView2 E2E retry compiled Rust successfully, launched native Prime zero-turn lifecycle with empty native homes and no provider credentials, and produced real owned-window PNGs. Root visually inspected light/settings, dark/narrow sidebar, and pipeline/launch definition UI. Evidence retained in `target/piui-evidence/3896-1788686799228`.
- E2E incomplete: failed operating `Delete WebView Agent Updated` while deleting CRUD fixtures. Scenario worker diagnosing route/list synchronization; do not claim safe-mode/negative-boundary completion from this run.
- Visual defect found: `.primary-actions .accent` specificity overrides foreground with accent background color, hiding New chat text. UX worker assigned fix + regression, and final run controls now explicitly authorized after desktop scheduler tests passed.
- Capture helper now records actual owned-process-tree memory samples per PNG. Reports sum working sets (shared pages included), private bytes, discovered/measured process counts and completeness. No threshold was added; this is a dev WebView sample, not a packaged cold-start/RSS guarantee. Syntax check passed; real metric sample pending next E2E.
- Actual Pi failed turn safely classified through native RPC as inability to authenticate selected model. Credentials/settings not inspected or changed. Prime user-resource initialization timeout differs from successful empty-home E2E initialization; native author investigating stages. Codex tests have an unresolved reported native-fixture regression and safe cause classification work; its owner is investigating before any unchanged rerun.


### Latest integrated checks (2026-09-06)
- Frontend final suite: 145 tests/30 files PASS; svelte-check 0 errors/0 warnings. Production bundle PASS; contract suite22 PASS. Initial graph166196 bytes under unchanged266240 budget, deferred312673, total478869.
- Full workspace clippy/all-targets -D warnings PASS. Root full Rust suite311 PASS before last focused scheduler additions; latest desktop68 PASS, scheduler8 PASS. Final exact-tool-policy bypass fix still pending owner regression.
- Existing classic Tauri WebView2 compatibility E2E PASS including safe mode, focus trap, Escape/focus restore, generic fallback and no real Prime launch. Evidence `target/piui-evidence/6432-1788688700361`.
- Second workspace visual run revalidated actual native Prime zero-turn startup, fixed visible New chat, light/dark and closed narrow drawer; root inspected screenshots. Eight owned app/WebView processes measured, all accessible. Example unavailable-screen sum working sets473804800 bytes/private252411904 bytes (dev build; shared working-set pages counted per process). Evidence `target/piui-evidence/30944-1788688397901`.
- That run failed Create profile due same async control-readiness race as previous Delete. Root moved bounded enabled-control waiting into clickButton itself; no fixed sleeps and no repeated click after success. Scenario now includes saved-command real UI launch rejected by mandatory policy, persisted Failed run, unchanged native sessions, safe-mode Start run disabled. `workspace_e2e_complete` now running full combined flow.
- Codex full bridge suite36 PASS after exact cwd, strict envelopes, startup cleanup, and valid NativeEvent error on unsupported structured/secret input. Actual changed default native turn still failed, no structured error category: do not label it auth or request shape. No unchanged retries.
- Prime adapter removes only redundant initialization catalog refresh; explicit models refresh preserved. Native SDK initial model semantics unchanged. First paint is not blocked by native session creation (it is user-requested later). Native supervisor asked for ONE changed Prime runtime proof after this fix with same watchdog/nondefault daemon.
- Exact tool-policy defect found: scheduler self-attested native rule names, allowing Pi comma-separated alias to grant explicitly denied tools. Scheduler owner fixing literal supported-tool inventory and regression; must close before final readiness report.


### Real Prime provider proof and remaining UI closure (2026-09-06)
- Changed real Prime supervisor test PASS (26.59s whole test across unchanged per-operation watchdogs): initialized with cached native registry, explicit native models nonempty, exact marker prompt admitted, explicit Succeeded, final marker present/no tool block, clean disposal, same native ID/history resume, resumed runtime disposed. Native auth resolution only; PiUI did not inspect/copy/log/change credentials/settings. Nondefault daemon guard supplied; SDK used no daemon. Earlier generic Prime-readiness blocker is superseded by this proof; precise prior transient stage remains unknown.
- Full bridge suite36 PASS after Codex input-event test waited for its actual later error frame. All Pi literal-tool defense tests pass; scheduler compiler policy fix still in progress.
- Latest actual E2E passed CRUD, real saved-command rejected-run flow, strict forged-field/workspace/approval boundaries, and screenshots; failed final closed-session display before safe restart. Root hypothesis handed to host owner: zero-turn Prime path reserved but JSONL not materialized, closed history snapshot fails and UI keeps stale Idle. Need reproduce/fix, not a larger wait. Scenario owner adding safe status-only diagnostic + real failure screenshot. Evidence `target/piui-evidence/22288-1788688852437`.


### Retirement fixed; current proof checkpoint (2026-09-06)
- Actual first graceful Prime zero-turn close PASS in `target/piui-evidence/18012-1788690298029`: host Closed, rendered Closed, no error banner. Root cause was closed event receiver incorrectly becoming a protocol error before graceful disposal reply. Final runtime adds begin_retirement (stops admission only), accepts an explicitly retired Closed event sink, still rejects active Closed/full sinks, and still requires BOTH native dispose acknowledgement and contained cleanup. Host orders retirement before forwarder abort/join and advances final close watermark. Focused regressions pass; earlier “swallow dispose error” proposal was NOT retained.
- Final completed Rust batch after these fixes: 317 passed, 11 intentionally ignored; full clippy/all-target -D warnings and fmt check PASS. Frontend after close-error recovery:148 passed, check0/0, buildPASS, contracts22PASS. Latest initial graph167623 bytes under unchanged266240 budget (total480296, deferred312673).
- Remaining workspace E2E failed explicit zero-turn reopen before Idle. Cached observed model metadata was being supplied as a requested override despite empty fixture auth/model inventory; host owner separating initial/managed explicit overrides from ordinary native-resume semantics. Root requested safe reopen diagnostic/actual PNG and no timeout increase. Normal close and prior CRUD/run-rejection/forged boundaries already passed; reclose/safe-restart not yet proven.
- Codex0.147 prompt-free existing probe confirms reserved thread.path IS present before first turn but file absent; native fresh-process resume fails until materialized. No ID-only new-thread assumption needed. Current draft handling re-stats paths and never masks existing corrupt/inaccessible history; legacy/unknown remains conservative.
- All adapters now emit materialized bool; Rust private snapshot accepts optional bool for codec compatibility. Host persists monotonic positive fact and checks current path before empty-draft fallback/ref discard. Binding is identity, not durability proof.
- Prime SDK absent model is mapped to absence by adapter; explicit invalid model still fails closed (Prime10/fullbridge37 tests pass). Screenshot unknown was native-observed metadata, not a reason to manufacture a new model override.
- Since real Prime provider works, scheduler owner is now adding minimal OPT-IN real managed Prime dependency-DAG proof (two tasks; no fake provider/executor, no native tool actions). It must retain native auth resolution/nondefault daemon/contained cleanup and prove actual predecessor reference use; may report concrete Wry test-interface blocker instead of pretending success.


### Final integrated evidence (2026-09-06)
- Full Windows WebView2 workspace proof: `target/piui-evidence/21760-1788691641684/report.json`; normal 18911ms, safe 591ms. Seven actual owned-window PNGs retained. Root inspected final safe-mode image: persisted closed native session, read-only definitions and disabled saved Launch are visible. Paint entries were unavailable (`null`), not invented startup/FCP measurements. Owned process-tree memory samples are dev-build snapshots, not unique RSS or release performance guarantees.
- Final default quality batch: 318 Rust tests PASS, 11 opt-in/native tests ignored; full workspace clippy/all-targets `-D warnings` and fmt PASS. Frontend148/check0/0/build PASS; contracts22 PASS; asset smoke initial167623 under existing266240-byte budget. Existing classic native compatibility E2E remains PASS.
- Additional real Prime managed dependency-DAG integration PASS (61.05s test body, 29.90s compilation). Run via `cargo test -p piui-desktop --features native-prime-scheduler-test --test native-prime-scheduler -- --ignored --nocapture`. Tauri MockRuntime supplies state/event plumbing only; WorkspaceHost, scheduler, native Prime/default provider, containment and transcripts are actual. Both task snapshots have no Tool blocks; mandatory native denies compile to an empty tool allowlist. Model-only preflight also disables tools/subagents and uses native model=None defaults. No credentials/settings were inspected or copied by PiUI; daemon guard remains nondefault.
- DAG success requires explicit Succeeded, predecessor output hash, predecessor marker in downstream native User history and copied downstream Assistant output. Shutdown was awaited before result assertions. Later test-only ownership/removal assertions were compile/clippy checked without repeating provider turns; production behavior did not change.
- Windows TaskDialogIndirect loader failure was a test harness manifest issue, not a native/provider result. The reproducible fix is a required-feature integration target with test-scoped manifest link arguments, not a patched production binary. Default Cargo tests and production manifest remain intact.
- Limits of evidence remain explicit: Pi actual native turn failed authentication; Codex actual turn returned an unclassified native error; Linux containment/lifecycle unverified. Prime proof does not establish every native tool/controller/configuration or mixed-harness provider readiness. Ordinary full-tool Prime initialization remains configuration-sensitive; do not infer universal readiness from the no-tool model/DAG proof.

Root directly read the successful native DAG and final feature build/clippy terminal logs. Copies are retained under `target/piui-evidence/native-prime-scheduler/`; no provider rerun was used for fan-in.
