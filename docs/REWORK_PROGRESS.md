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

## In progress

- Host stability fixes (operation gate, event backpressure, registry fsync,
  async orchestration commands, manual-run resume) — separate worktree branch.
- UI Lab fake backend with demo/empty/safe/long scenarios — separate branch.

## Known issues found on the way

- Installed Codex is 0.157.1 but the adapter accepts only 0.147.0 / 0.153.4 —
  version ranges are the first Ф3 task.
- Codex command output is unbounded in the bridge; a non-string Pi input
  placeholder would break Rust parsing.
- Svelte 5.38 native TS stripping does not remove optional parameters
  (`fn(a?: T)`) in component scripts; use `a: T | undefined = undefined`.

## Next

- Ф3: open harness registry, version ranges, generic ACP adapter, Claude Code
  adapter over the user's own `claude` CLI (stream-json + control protocol,
  subscription only).
- Ф4: pipeline document v5 and the Svelte Flow editor.
- Replace legacy E2E/smoke targets with the new shell; remove classic UI.
