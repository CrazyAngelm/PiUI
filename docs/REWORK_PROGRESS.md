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
  [RUN_DEBUGGING.md](RUN_DEBUGGING.md), ADR-034). Pinned data (orchestration
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

## Next

See [PLAN_REMAINING_2026-09-26_RU.md](PLAN_REMAINING_2026-09-26_RU.md).
