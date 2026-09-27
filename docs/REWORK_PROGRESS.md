# PiUI rework progress log

Branch: `rework/piui-2`. Plan: [PLAN_2026-09-26_RU.md](PLAN_2026-09-26_RU.md).
Decisions: §13 of the plan (owner delegated all decisions on 2026-09-26).
Hard requirement from the owner: **Claude Code runs only on the user's Claude
subscription** (never API keys / Bedrock / Vertex), see plan §8.4.

## Done

- `c77dd2d` — pending UX-audit fixes committed.
- `fb50cef` — host clients go through `host-api/transport.ts`; browser runs use the
  lazily loaded UI Lab host (`host-api/lab/`).
- `3ad1eb0` — design tokens v2 + accessible primitives (`src/lib/ui`, bits-ui,
  Lucide); dev gallery at `?view=gallery`.
- `0fff8f7` — new default shell (`src/app/shell`): sidebar (projects → chats,
  Inbox, Pipelines, Runs, Automations, Settings), composer-first Home, chat view
  with details panel and inline approvals, Inbox, sectioned Settings, Ctrl+K
  palette; runes store with per-frame event batching; lazy views; gzip asset
  budget. Old shell at `?view=legacy`.
- `ce2176c` — rebuilt chat composer (outbox, steer/follow-up, slash commands,
  model/reasoning/fast chip) + Russian dictionary `features/locale/shellRu.ts`.
- `3bb7b5f` — merged bridge fixes: Pi tool output/select dialogs/compaction,
  Hermes follow-up queue and failed-turn recovery, Codex MCP/dynamic tools.
- `3f6c6c6` — Codex-style transcript: activity summaries with RU plurals, typed
  tool rows, unified diff viewer, answer actions, paging + content-visibility,
  in-chat history search (Ctrl+F).
- `05f45f2`, `3df6019` — pipeline editor rebuilt on Svelte Flow (`src/app/pipelines`):
  agent/router cards, typed edges (result/route/messages/observe/delegate),
  inspector tabs, templates (chain, parallel, orchestrator, review loop, router),
  undo/redo, dagre auto-layout, check/save/run; Russian copy.
- `76864aa` — stateful deterministic UI Lab host (`?lab=demo|empty|safe|long`):
  workspace sessions, composer, orchestration run engine, schedules.
- `b5fab9f`, `86305bb`, `eaff6ea`, `455ea4f`, `dbdd42e` (merge `e945a63`) — host
  stability: native starts outside the global gate, event backpressure instead
  of fatal queue overflow, batched usage writes, orchestration reads off the main
  thread, manual runs resume after restart.
- `139572b`, `13d236c` — browser QA fixes: epoch timestamps, trust via transport,
  transcript follow logic, compact tool narration, GitHub tables in safe
  Markdown, palette focus, sidebar overflow.
- `08a9778` — n8n-style run view (`src/app/runs`): run list, read-only run canvas
  with recorded step states, live activity, loop attempts and spawned helpers;
  step panel with result, conversation, inputs, attempts, usage and operator
  actions (approve/reject, run again from here, cancel, retry, record outcome).
  Svelte upgraded to 5.57.1 (5.38 emitted invalid JS for optional TS params).
- `15824b6` (merge `15e9d74`) — Claude Code bridge adapter (`bridge/claude.mjs`):
  headless stream-json + control protocol, subscription-only verification,
  approvals, AskUserQuestion, steer, resume from native JSONL; 28 tests.

- `ab5bc58`, `d5c571c` — orchestration v6.1 (additive): run inputs
  (`{{input.name}}`, typed start form) and review loop limits
  (`maxIterations`; at the limit the task waits for a person).
- `9d041fd` — pipeline assistant in the editor: read-only builder chat that
  proposes whole-graph changes, validated and applied in place.
- `35dafa6` — Automations screen in the new shell (cards, on/off, edit, delete).
- `db7870a`, `5b8004c` — run inputs and review limits across the editor (Start
  node, inputs editor, run form), Runs (inputs, "accept last result" / "one more
  round") and Automations (inputs for every run); lab assistant proposals.
- `1db2a11` — day-of-week schedules (host v7.1 `calendar` trigger on chrono-tz,
  DST-safe) with "On days" mode, presets and next-run preview.
- `32b1a65` — Codex verified range 0.147.0–0.158.0 instead of exact pins,
  app-server protocol audit fixes (settings, warnings, `currentTime/read`).
- `86b8e98` — Claude Code as a first-class harness on the subscription only:
  launcher/version range, wide env scrub, Fast pinned off, extra-usage guard,
  sign-in status, pipeline delegation through PiUI, native history projection.
- `d45f7c3` — one-shot model calls and host-run scripts (orchestration v6.2,
  additive) in the engine and the new shell: Add menu, node cards, inspector
  (read-only model call; script runtime, code, time limit, result fields, "not
  a sandbox" warning), run panel (stdout, stderr tail, failure texts). Claude
  Code runs a model call with `--tools "" --strict-mcp-config`.
- `feat/triggers` (`752499d`…) — triggers (plan P2 item 8; host v7.2,
  orchestration v6.3, background v1, all additive): event automations "when a
  pipeline finishes" and "when files change" (platform project watcher,
  include/exclude patterns, quiet period), loop protection (own-run
  suppression, chain depth ≤ 3, 30 s cooldown, typed skip outcomes), durable
  "pause all automations", run trigger identity shown in Runs, `/run` and
  Ctrl+K "Run pipeline…" with a chat trigger, and background mode (tray with
  Open/Pause/Quit, keep-in-tray and start-at-sign-in, both off by default, in
  Settings -> Background). UI Lab parity; golden JSON shared by Rust and TS.
- `feat/triggers-2` — one PiUI per user session (`tauri-plugin-single-instance`;
  a second launch shows the running window, restoring it from the tray; E2E
  hosts stay outside) and a quoted Windows sign-in `Run` value written by the
  host itself, with legacy unquoted entries rewritten at startup.
- `main` fast-forwarded to `rework/piui-2` (local only, not pushed).
- `feat/step-editing` (`ed824b2`…`9e72213`) — executor tails. A node's type
  changes between agent, model call and script from a chip in the inspector
  (id, name, position, result/route edges and result contract kept; removed
  connections/settings and discarded data are confirmed first; one undo
  step; checks re-run). Script code uses CodeMirror 6 (Node.js, Python,
  PowerShell), loaded on demand in its own shadow root so it works under the
  `style-src 'self'` CSP, with a plain-field fallback; the run panel shows the
  code read-only. "Test script" (`orchestration_script_test_v1` /
  `orchestration_cancel_script_test_v1`, contract `orchestration-script-test-v1`)
  runs the draft once through the host script runner with an editable sample
  stdin and shows what a run would record; it never starts an agent or model.
- `feat/run-debugging` (`96cd87a`…) — run observability+ (P3 item 10,
  [RUN_DEBUGGING.md](RUN_DEBUGGING.md), ADR-035). Pinned data (orchestration
  v6.4, additive): "Pin output" in a finished run's step panel (the host reads
  the recorded output, hash-verified for native answers, and pins it at the
  saved pipeline's revision); pin chip and inspector section (view, unpin) in
  the editor; the Start dialog's "Use pinned data (pinned steps don't run)";
  the coordinator admits pinned steps as succeeded without a session or
  process, checks them against the result contract and hands them downstream;
  runs mark those tasks `pinned`; script test samples use pinned upstream
  outputs. "Debug in editor" opens a run's frozen pipeline as a new unsaved
  draft with a checklist of outputs to pin. Runs archive/unarchive ("Show
  archived runs") and delete finished runs through `orchestration_delete_run_v1`
  (PiUI's journal entry and verified script working copies only; running and
  uncertain runs refused; read-only in safe mode). Commands:
  `orchestration-run-debugging-v1`. Pins stay out of system files.

- `feat/classic-port` (P2.7, first half) — classic parity in the new shell
  ([CLASSIC_PARITY.md](CLASSIC_PARITY.md)): read-only Pi/Prime session history
  from the index with paging, cross-folder search and a branch summary
  (tree navigation stays unavailable, R-03); Pi extension notices, statuses,
  widgets, window title and prepared text in chats over the additive
  `workspace-extension-ui-v1` channel, editor dialog prefill and timeout;
  Settings → Extensions; project rename, pin and remove; Settings → About
  entry for `?view=legacy` / `?view=classic` with a way back. UI Lab: demo
  index history (branched, long, damaged, personal) and a "Pi extension
  playground" chat (`/extension-demo`). Gaps before deleting classic:
  continue an indexed Pi session live, Pi slash-command discovery, Tier 1A.

- `feat/harness-polish` (plan §3 P1 items 2–3): Codex MCP elicitations become
  approval cards (MCP server name, message, typed primitive fields, Accept /
  Decline / Dismiss mapped to accept / decline / cancel; unsupported shapes are
  declined at once; interrupt and turn end dismiss them); additive workspace
  v15 `WorkspaceApproval.form`. Claude Code: new-chat composer sign-in status
  with Check again (catalog-only check, never a model turn); a signed-out managed step
  fails with `harness-sign-in-required` before any task text instead of
  "outcome uncertain", and runs again after `/login`; the node inspector lists
  every harness's manifest limitations. UI Lab: demo chat "File an issue for
  the broken docs link" is paused on an MCP form request; `&claude=signed-out`
  shows the sign-in status and a "Claude check" system whose run fails typed.

- `feat/e2e-ci` — E2E and regression (P1 item 4), see [TESTING.md](TESTING.md):
  - `5beca65`, `f07e7c9` — Playwright against the browser UI Lab
    (`pnpm test:lab`): shell, palette, theme, Russian; chat harness → model →
    reasoning → streamed answer, approvals, queue/steer; pipeline template →
    Start inputs → Check → Run → run canvas → step tabs → review-limit
    actions; model call and script nodes; weekday automations; keyboard-only;
    axe on 12 screens in light and dark with screenshots. A `prod-csp`
    project serves `vite build` under the shipped CSP.
  - `7b23d64` — the WebView2 E2E drives the new shell by default (debug app,
    isolated data, safe mode); classic is opt-in (`--classic`), the workspace
    proof opens `?view=legacy`; cargo output honours a private target dir.
  - `59aa9c9` — CI: lab E2E (Chromium) with report upload on failure,
    contracts, example system files, bridge tests, full-workspace Rust on
    Ubuntu and Windows.
  - Fixes found by the new tests: `bbf78dc` a model chosen on Home broke chat
    start (catalog-only fields hit `deny_unknown_fields`); `c22ab34` under the
    shipped CSP the page stopped taking clicks after the first dialog or menu
    (bits-ui scroll-lock reset blocked), now three exact style hashes;
    `5a07a69` timestamp contrast, palette search label and matching, named
    canvas nodes and connections.

- `7db21ac`, `ad53173`, `f3aac6b`, `915a650`, `e972703`, `3afc50a` (branch
  `feat/acp-registry`, ADR-034) — ACP agents and Settings → Harnesses: harness
  identity `acp:<descriptor id>` (additive in workspace v15, orchestration
  v6.3, system files v4); versioned ACP descriptors with a shipped Gemini CLI
  descriptor; no-shell resolution (PATH, npm/pnpm shims), contained version
  probes and tested ranges; generic ACP v1 bridge (`bridge/acp.mjs`: streaming,
  permissions, cancel, modes/models, sign-in hint, resume, generic fallback);
  host registry with trust of the exact command line, version and secret-name
  confirmations (`harness_registry_v1`, `workspace_session_mode_v1`);
  Settings → Harnesses for every harness (status, location, version vs tested
  range, sign-in guidance, check again, add/trust/remove ACP agents) and agent
  modes in chat details; UI Lab fakes (ready Gemini, missing and untrusted
  descriptors). No real ACP model turn was run.

- `feat/e2e-2` — E2E for the merged harness polish, step editing, classic port
  and triggers (MCP forms, node type change, Test script, Pi history,
  `/extension-demo`, `/run`, event automations and pause, Settings →
  Background and Extensions); the run header wraps with the step panel open.
  Fixes found by the tests: the automation form reset itself when the pipeline
  changed (name no longer followed it); the run dialog's "Next…" stayed a
  disabled "Start run"; CodeMirror scroll area, optional-label contrast and
  popover role (axe).

- `feat/release-0.2` (plan §3 P3 item 12, release readiness): version 0.2.0
  everywhere it is declared, checked by `scripts/check-version.mjs` in
  `pnpm repo:check`. Signed updates (app update v1,
  `contracts/app-update-v1.ts`): `tauri-plugin-updater` is registered only when
  the build config carries a minisign key and HTTPS endpoints; Settings → About
  shows the version, Check for updates, plain-text notes, a confirmed Download
  and restart and an opt-in automatic check (off by default); UI Lab
  `&updates=`. `pnpm release:windows|linux|macos` add Authenticode (certificate
  thumbprint or Azure Artifact Signing) and update signing only from
  environment variables; the tag workflow builds Windows, Linux (deb, AppImage)
  and experimental macOS, publishes one pre-release with combined checksums and
  a `latest.json` feed on a rolling `updater` release when keys exist. Owner
  steps: [RELEASING.md](RELEASING.md).

- `feat/composer-inputs` (plan P3 item 11, first half) — composer inputs, see
  [contracts/README.md](../contracts/README.md) and the bridge
  [CONTRACT.md](../crates/piui-runtime/bridge/CONTRACT.md):
  - Attachments in both composers: paperclip (native dialog), paste and drag
    and drop (the host keeps OS drop paths and hands the WebView a single-use
    id). Images are sniffed (PNG/JPEG/GIF/WebP, 5 MB), held in PiUI's app
    data until their message is delivered or removed and sent natively where
    the harness takes them: Codex data-URL input items (models whose
    `inputModalities` include image), Claude Code base64 image blocks, Pi RPC
    `images` (models declaring image input), Hermes ACP image blocks
    (`promptCapabilities.image`); Prime refuses them. The paperclip is
    aria-disabled with the reason where images are unsupported; a refused
    image is explained, never dropped. Other files become `@path` references
    after a confirmation; nothing is copied into a project. Previews are drawn
    on a canvas, so the CSP is unchanged. Sent images show as chips in the
    transcript (bridges and the closed-session history list `[image]` lines).
  - `@` project file picker (name-only, `.gitignore`-aware host listing of a
    trusted project, fuzzy ranking in the UI) in both composers; `/` lists
    harness-native commands next to PiUI's (Pi `get_commands`, Claude Code
    `initialize`/`commands_changed`, Hermes `available_commands_update`),
    badged and inserted as text; `$` inserts Codex skill mentions (the bridge
    adds the documented `skill` input item). Additive composer v19 fields,
    new `workspace_composer_inputs_v1` route; UI Lab parity.
  - Fix: the new-chat composer no longer puts the remembered harness and
    model back over the user's pick when the host catalog refreshes.

- `feat/session-tools` (plan P3.11 second half, classic parity gap 1,
  ADR-036, [SESSION_TOOLS.md](SESSION_TOOLS.md)): a contained host git runner
  (hooks and fsmonitor off, literal pathspecs, bounded output) and three
  versioned commands. **Review panel** (`workspace_review_v1`, `Mod+Shift+G`):
  staged/unstaged/untracked files of the chat's folder, the transcript diff
  viewer with stage, unstage, revert and comment per hunk; every action
  repeats the reviewed diff's SHA-256 and replays exactly those bytes through
  `git apply` (a change in between is `STALE`); revert previews what is lost;
  untracked files go to the system trash through the platform layer; line
  comments go into the draft, never sent; read-only in safe mode.
  **Worktree chats** (`workspace_placement_v1`): "New worktree…" in the new
  chat composer with a confirmed branch, folder under app data and base
  commit; trust through the project's common git dir; details with copy,
  review and remove (dirty changes listed and acknowledged, branch kept);
  sidebar marker. **Continue in another harness**: an editable draft from the
  visible chat, the new chat links back. **Continue in PiUI** for terminal Pi
  sessions (`workspace_adopt_v1`, gap 1 closed). Placement lives in
  per-session sidecar files; the v11 registry format is unchanged. UI Lab
  fakes (in-memory git, worktree chat, adoptable session), Rust tests on real
  temporary repositories, Vitest and Playwright flows with failure paths and
  axe audits. First paint (`perf:smoke` graph): 408,833 → 417,164 B raw,
  117,872 → 120,596 B gzip (the worktree chip, placement store and sidebar
  marker; the review panel, dialogs, clients and handoff are lazy).

- Branch `feat/plugins` (plan phase 8 / P3 item 9, ADR-032 accepted,
  [PLUGINS.md](PLUGINS.md)) — plugins v1:
  - `af35f4c` — package format v1 (`piui-plugin.json` schema, host validator
    in `crates/piui-plugins` with a TS mirror and shared fixtures, package
    reader with limits, a `.zip` reader, code hash, themes with contrast
    checks, templates checked as system files v4), `@piui/plugin-sdk`
    (backend helper, panel client, types), `pnpm create-plugin`,
    `pnpm plugin:check` and four examples.
  - `b2ce510` — contained Node backend (Job Object / process group,
    allowlisted environment, LF JSON-RPC with 1 MiB frames, timeouts).
  - `c4ca7a6` — orchestration v6.5 `plugin` step executor with host leases,
    failure codes and uncertainty like scripts; system files v4 accept it.
  - `1eb2a8b` — host: registry generations with revision checks, native
    pickers and staging, trust review, install/update/remove/reload,
    start-up verification off first paint, safe mode read-only, supervisor
    (lazy start, crash backoff and crash loop, stop on disable/quit),
    `piui-plugin` protocol with per-plugin CSP, plugin nodes in the
    scheduler, plugin ACP agents in the harness registry; app CSP
    `frame-src` now names only the plugin origin.
  - `9c56ee9`, `8d6dc54`, `bef7ddb` — Settings → Plugins with the trust review
    and plugin themes; palette commands and composer actions (also the Pi
    Tier 1A contributions: CLASSIC_PARITY gap 3 closed) that only prepare
    text; sandboxed chat panels with a checked `postMessage` bridge and a
    fallback; plugin nodes and templates in the pipeline editor and runs.
  - `39b5e65`, `ff511c0`, `c99ea62` — UI Lab plugin host (examples plus a
    crash-looping "Broken sample", plugin nodes in lab runs, panels served on
    the plugin origin by the dev server), Russian copy, Playwright specs
    (trust review, enable/disable, commands, sandboxed panel isolation,
    plugin node, safe mode; a panel, the review and a theme under the
    production CSP).

## In progress

- Nothing; next steps wait for the owner's review of the remaining-work plan.

## Known issues found on the way

- A node's type changes only from the inspector (the canvas has no node
  context menu); routers are not converted. A script test shows its output
  when it ends, not while it runs.
- Served with the desktop CSP, some library markup sets inline `style`
  attributes that the policy refuses (xyflow MiniMap's `display: contents`
  wrapper, bits-ui Command item wrappers, bits-ui's scroll-lock restore of
  `body` style). Found while checking the script editor, which has none.
- A Codex model call keeps its native tools (read-only sandbox only); the
  inspector says so. Pi and Claude Code run model calls without tools.
- The standalone `claude` CLI on this machine is signed out; PiUI shows a
  sign-in hint until the user runs `claude` → `/login`.
- MCP elicitations: `url` mode (open a page) and OpenAI user verification are
  declined, not shown; an MCP tool approval is for one call (no session or
  always scope). The live Codex shapes were checked against 0.157.1 bindings
  only; 0.147/0.153 are covered by the fixture, not a rerun binary.
- `perf:smoke` initial-asset budget: at `84f6021` the first-paint graph was
  572,580 B raw / 163,548 B gzip (budget 573,440 / 163,840). Every Russian
  feature catalog is loaded eagerly, so `feat/harness-polish` (+6.3 KB raw,
  +1.8 KB gzip, all from `ru/harnesses.ts`; its UI code is lazy) exceeds it.
  Lazy-load the Russian catalogs or raise the budget.
- Codex command output is unbounded in the bridge; a non-string Pi input
  placeholder would break Rust parsing.
- Extension text is path-redacted by the shared sanitizer, so prepared
  composer text that starts with a slash command shows `<external-path>/…`
  (same in the classic view).
- `perf:smoke` first-paint budget: the base (`84f6021`) was at 163 556 of
  163 840 gzip bytes; the classic port brings it to 166 657 (Russian copy in
  the statically bundled locale catalogs +1 454, sidebar/store +1 647). Any
  further visible copy exceeds it until per-language catalogs load lazily or
  the budget is revised.
- Release readiness: `pnpm repo:check` failed at `a2b53a6` on a local user
  folder in evidence scripts/records and on test values outside the audit
  allowlist (redacted in `feat/release-0.2`). The update feed is unsigned and
  `requireSignedVersion` stays off because Tauri CLI 2.11 does not record the
  signed version. A Linux `cargo clippy --workspace --all-targets -- -D
  warnings` (Docker, rust:1.94.1-bookworm with the Tauri packages) passes after
  three Unix-only lint fixes; `ci.yml` still never compiles the desktop crate
  for Linux (only the release workflow's `tauri build` does). `PiUI_MASTER_SPEC.md` is generated
  (`tools/build_master.py`) and still quotes the 0.1.1 README; rebuild it after
  the release branches merge.

- bits-ui Command points `aria-controls` at its viewport, so axe flags the
  palette list (`scrollable-region-focusable`, reviewed exception). Approval
  cards use an h3 under the chat's h1 (axe heading-order, moderate). The Ubuntu
  full-workspace Rust job has not run yet.

- Triggers: tray, sign-in start, the single-instance hand-off and file
  watching are verified by unit tests and fakes only; the native tray, the
  real quoted `Run` value, a second launch restoring the window from the tray
  and Linux/macOS paths still need a manual check. The UI Lab never fires
  "files changed" rules (no project folders) and fires no timed schedules.
  With the opt-in local API configured (`PIUI_AGENT_API_PORT`), a second
  launch fails on the taken port before the single-instance hand-off. Linux
  still gets the plugin's unquoted `.desktop` `Exec` line.

- ACP agents (ADR-034): Gemini CLI has no tested version range yet, so every
  version needs the user's confirmation; the bridge is verified only against
  the fake agent fixture. Coordinated (managed) runs need an agent with HTTP
  MCP support. Pickers learn an agent's models only after one of its sessions
  started in this host process. Mode changes the agent makes by itself appear
  on the next snapshot. A crash mid-turn is recorded as uncertain.

- The orchestration journal is one document rewritten per transaction, and an
  older build discards a generation it cannot parse: once pins, pinned runs or
  archived runs exist, rolling back to a build without v6.4 loses that data
  (ADR-031 would fix both). Fields are omitted while unused, so a journal
  without them stays readable by the previous build.
- Pinned artifact paths are not re-checked when a run uses them. An automation's
  history still names a deleted run; opening it says the run is gone.

- Session tools: reverting an untracked file is refused on macOS (no trash
  support yet); repository clean/smudge filters still run during reads; hunks
  cannot be split; a worktree left by a deleted chat has no management screen;
  an older PiUI build ignores placement files (a worktree chat would start in
  the project folder). The native Windows Recycle Bin path was probed once;
  the WebView2 E2E does not cover the review panel yet.

- Plugins (ADR-032): panels, the trust review and themes were verified in the
  browser UI Lab and under the production CSP, where a Playwright route and
  the Vite dev server stand in for the `piui-plugin` protocol; the native
  protocol, picker and supervisor are covered by Rust tests with real Node
  backends but no plugin has been run in the packaged WebView2 app yet.
  `network`, `project.read` and `project.write` are declarations, not
  enforcement. Tauri counts the plugin protocol as a local origin, so a
  main-frame navigation to it would get the IPC script; nothing navigates
  there today (sandboxed frames, links rendered as text), and a host-side
  main-frame navigation guard is a follow-up once it is verified on every
  platform. Not in v1: MCP tool, renderer, status-item, keybinding and
  sidebar contributions, other harness adapters, project-local plugins,
  backend-to-host requests, signed packages.
- UI Lab E2E drift already present at `5375419` (unrelated to plugins): the
  two automations dialog specs (empty default name), the Inbox approval spec
  (the count stays at "2 waiting"), the script-node editor spec and prod-csp
  "main screens" (the CodeMirror field is not an input for `toHaveValue`),
  and the axe audits of `inbox` (low-contrast "optional" field labels) and
  `pipeline-script` (CodeMirror scroller not focusable) in both themes.

## 2026-09-27 — 0.2.2

- Windows main-frame navigation guard for the plugin origin
  (`piui_plugins::csp::is_plugin_location`, a Tauri `on_navigation` hook).
  WebView2 `NavigationStarting` fires for the top-level document only, so
  panel frames still load. On macOS and Linux wry forwards frame navigations
  to the same hook, so the guard is not enabled there yet.

## 2026-09-27 — classic views removed

- P2.7 second half, owner approved after the 0.2.2 test release: deleted
  `?view=legacy` (the previous workspace shell) and `?view=classic` (the
  Pi-only view), the About entry, the classic frontend modules, 30
  classic-only Tauri commands with the classic live/fake runtime slots and
  DTOs, the `system_probe` module, the WebView2 `--classic`/`--workspace`
  proofs and the Russian copy only they used. The two parity gaps were
  already closed (Tier 1A by plugins v1) or dropped (palette listing of Pi
  runtime commands; the composer `/` menu has them). `add_project_v10` stays
  for the native harness and the agent API; surviving IPC versions are
  unchanged. Details: [CLASSIC_PARITY.md](CLASSIC_PARITY.md).

## 2026-09-27 — session tools follow-ups

- Review v1.1 and placement v1.1 (additive, same routes; `docs/SESSION_TOOLS.md`,
  ADR-036): staged renames with `renamedFrom`, hunk parts (`part`) rebuilt and
  applied exactly by the host, `worktrees` and `removeOrphanWorktree` with the
  dirty confirmation. Shared split fixture checked by Rust and TypeScript.
- Ctrl+K lists the open chat's native `/` commands from the composer catalog
  and inserts the chosen one; Settings → Worktrees; handoffs read changed
  files from git on demand.
- Plugin panel E2E flake: under the full `pnpm test:lab` run (four headless
  Edge workers) the panel frame, hidden with `visibility: hidden` while
  loading, is an invisible out-of-process frame whose renderer Chromium
  deprioritizes; server logs showed every file answered within milliseconds
  while the frame requested its scripts up to 8 s later, missing the 10 s
  ready deadline. The loading frame is now `opacity: 0` (inert); the product
  deadline is unchanged. 40/40 repeated panel runs passed (1/16 and 1/20
  failed before).
- `apps/desktop/package.json` had duplicate `contract:test` and e2e script
  keys; the later ones silently dropped the session-tools and trigger
  contract tests. Merged.
- Not done: macOS trash (cannot be verified on Windows); visual check of the
  split review and Settings → Worktrees in the packaged WebView2 app.

## 2026-09-27 — plugins v2 (unreleased)

- **Backend limits.** Backends start under Node's permission model
  (`--permission`, reads of the package, reads and writes of the data
  folder, a request's project folder only with `project.read` /
  `project.write`; no child processes, workers, add-ons or WASI;
  `--allow-net` only with `network` where Node.js has it). Node.js without
  the model does not start backends (state `unsupported`). Verified with
  real Node.js 22.17, 22.23 and 24.13 in Rust tests (denied reads, writes and
  `child_process`, a restart for a new project, a busy backend refusing
  another project); `--allow-net` could not be tested (no Node.js 25 here).
- **Manifest version 2** (`piui-plugin-v2.schema.json`), v1 unchanged:
  status-bar items and keybindings (PiUI wins, conflicts shown), chat
  renderers in the panel frame with the generic view always one click away
  (`plugin-panel-v1` v1.1), and MCP tool servers offered to ordinary new
  chats of Claude Code, Hermes and ACP agents only (never Codex, Pi, Prime
  or pipeline runs; the user's harness config untouched). Examples
  `status-tools` and `tool-cards`; `create-plugin` writes version 2.
- **Plugin origin guard everywhere:** main-document page loads on the plugin
  origin are sent back (all platforms), app commands refuse that origin, and
  non-page plugin files carry `CSP: sandbox`. The Windows pre-navigation
  refusal stays; WebKit's residual window is documented in ADR-032.
- The desktop `contract:test` script was defined twice and skipped five
  contract suites; merged.
- Needs a real-app check: the status bar and renderer frames in the packaged
  WebView2 app, a real Claude Code / Hermes / ACP chat with an offered MCP
  server, and a macOS and Linux build with panels still loading and the
  page-load guard active. Registries that store v2 permissions or MCP offers
  are not readable by 0.2.2 (downgrade shows an empty plugin list).

## 2026-09-28 — chat pipelines and templates (unreleased)

- **A chat can start a pipeline** (ADR-040). The composer's *who answers*
  chip lists harnesses, the project's pipelines and templates; the model chip
  shows only for direct chats; project, permissions and worktree moved into
  one context chip. A pipeline's first message starts a run with the `chat`
  trigger; the chat lives on the answering step's harness, shows run cards
  (steps, answer, stop, run again, open run) among its messages, and hands a
  finished answer to its agent inside the next message.
- **Project default:** Start block → "Start new chats of this project with
  this pipeline"; new chats talk directly otherwise.
- **Templates:** "Save as template…" in the editor (every project or this
  one), listed on the editor's start screen and in the composer; a template
  opens as an unsaved draft with the harness's first model filled in.
- **Pipeline library v1** host command with generation-file storage, UI Lab
  fake and tests (12 Rust, 5 lab, client, store, locale).
- Checked in the browser UI Lab: new pipeline chat, run card, handed-on
  result, context chip, Start default, save template, template → editor.
  Needs a real-app check: a real harness run started from a chat, and the
  packaged WebView2 app.

## Next

See [PLAN_REMAINING_2026-09-26_RU.md](PLAN_REMAINING_2026-09-26_RU.md).
