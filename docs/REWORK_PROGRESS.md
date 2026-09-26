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

## In progress

- Host wiring for the `claude-code` harness (identity, launch resolver with
  version range, env scrubbing, capabilities, native history projection,
  presentation manifest, lab catalog) — separate worktree branch.

## Known issues found on the way

- Installed Codex is 0.157.1 but the adapter accepts only 0.147.0 / 0.153.4 —
  version ranges are the first Ф3 task.
- Codex command output is unbounded in the bridge; a non-string Pi input
  placeholder would break Rust parsing.
- The standalone `claude` CLI on this machine is signed out; PiUI shows a
  sign-in hint instead of a model list until the user runs `claude` → `/login`.
- Review loops have no iteration limit yet (Ф4 must add `maxIterations`).

## Next

- Ф3: open harness registry, version ranges, generic ACP adapter.
- Ф4: run inputs (manual trigger form), loop limits, LLM and script nodes,
  pipeline document v5.
- Ф6: chat assistant that builds and tests pipelines (PiUI Builder MCP).
- Replace legacy E2E/smoke targets with the new shell; remove classic UI.
