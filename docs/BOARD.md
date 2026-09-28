# Project board and teammates (ADR-041)

Status: in implementation (branch `feat/project-board`). Contracts:
`contracts/board-v1.ts`, `contracts/teammates-v1.ts`. This document is the
behavioral specification; the contracts are normative for shapes.

## What it solves

Each project gets one durable, person-owned list of intent (cards) visible to
the person and to every agent in that project:

- hand work to an agent without a chat (assign a card to a teammate);
- an agent in an ordinary chat leaves a trace on the board (create / update /
  move / comment) and keeps updating the same card on follow-up messages
  instead of creating duplicates;
- run results land back on the card;
- the person sees and can undo agent changes; attention items go to the Inbox.

Non-goals: Jira/Linear clone (sprints, estimates, custom fields/workflows);
autonomous zero-human loops; polling "heartbeat" agents; semantic AI dedup
service; cross-project boards; external tracker sync in core (plugin
territory). Card comments are board data, never a second chat format.

Extension test (AGENTS.md): a board cannot be a plugin today (no main-view or
sidebar slot, no host storage API for plugins) and its authority checks sit
beside the coordinator. Core owns store + tool + views; sync/import/export are
left to plugins.

## Teammates

A teammate (`@handle`) is a project-scoped address that resolves to exactly
one saved launch command. `simple` teammates generate an ordinary one-step
graph (profile, one-member team, one-step pipeline with a `card` long-text
input, launch command) in the same atomic save; the generated launch command
carries `managedByTeammateId`. `pipeline` teammates wrap any existing launch
command, including large multi-step pipelines. Runs always go through the
existing orchestration run path (`RunDefinitionSnapshot` frozen by value).

Storage: `WorkspaceOrchestration.teammates` (additive `#[serde(default)]`),
saved and deleted in the same generation as the definitions they manage.
Deleting a teammate deletes its managed definitions and clears a chat default
that pointed at its launch command. Handles are unique per project.

Card input resolution (`cardInput.auto`): input named `card`, else `message`,
else the single `text`/`long-text` input; otherwise the teammate is saved but
reported `notAssignableReason`. The card text given to the run is labelled
untrusted task data: `#N title`, description, labels, last 5 comments.

Availability: `working` when a live run has `trigger.kind == 'board'` with its
`teammateId`; `queued` when pending starts or the concurrency queue hold work;
else `idle`.

Surfaces: Team screen (route `team`), quick-create dialog, executor picker in
chat lists teammates first (raw launch commands under "More pipelines…"),
`@handle` autocomplete in chat and card comments, board assign picker.

## Board storage

`app_data/boards-v1/<workspaceId>/board-<20-digit generation>.json`, one
document per project, copied from the `pipeline_library.rs` pattern:
create-only generation writes with fsync, revision check, damaged generation
skipped (previous kept), safe-mode refusal of writes, older generations pruned
(keep last 3). Behind a `BoardStore` trait so ADR-031 can replace it. Limits
from `board-v1.ts`. Never written into the project folder.

A board that was never saved reads as disabled with default settings.
Disabling keeps all data, hides the Board sidebar item, and removes the
`board` tool from new agent sessions.

## Statuses and automation

`backlog, todo` (unstarted) · `inProgress, inReview` (active) · `blocked` ·
`done, cancelled` (closed). Backlog never starts a run.

Starting a run for a card (person `startRun`, accepted pending start, or a
wake rule) is one board generation plus one orchestration run creation:
claim the card (run holds the claim), move to `inProgress`, add a `run` link
and `runStarted` activity, create the run with
`RunTrigger::Board { cardId, teammateId, cause, chainDepth }` and the card
text in the resolved input. If run creation fails, the board change is rolled
back (claim released, status restored) and an activity comment explains why.

Run end: `succeeded` → comment with the truncated final result (≤ 4 KiB) +
run link, move to `inReview`; `failed` → comment with the failure, move to
`blocked`; `cancelled` → release claim, status unchanged. Agents never move a
card to `done`/`cancelled` directly: such a move becomes a proposal.

Wake rules (host events, never polling):

- assign: the teammate's `wake.onAssign` (`ask` → pending start in Inbox,
  `always` → start, `never` → only assign), unless the command says
  `start: now|later`. Only when the card is `todo`/`inProgress`/`blocked` or
  was created in `todo`; assigning a `backlog` card never starts.
- a person's `@handle` comment with `wake.onMention` → same rule, cause
  `mention`, the comment appended to the input. A mention on a card already
  claimed by a live run is only a comment.
- blockers: when all `blockedBy` cards are closed, a `blocked` card moves to
  `todo` (activity `unblocked`) and wakes its assignee by its rule.
- moved to `todo` by a person with an assignee → rule, cause `movedToTodo`.

Loop protection: `chainDepth` is 0 when the cause actor is the person; +1 when
it is a chat agent or run member (from the causing run's depth); stops at
`MAX_TRIGGER_CHAIN_DEPTH` (pending start instead). A run's own board writes
never wake the same card. Per-card cooldown 60 s between automatic starts. One
live run per card (claim). Concurrency: per teammate `maxConcurrentRuns`, per
board `settings.maxConcurrentRuns`; excess starts queue in priority then age
order and start when a slot frees.

Claims: lease `CLAIM_LEASE_SECONDS`, renewed by holder activity, held by runs
until run end; host sweeps expired claims. `claim` on a claimed card →
`ALREADY_CLAIMED` (tool text: do not retry, pick other work).

## Agent access: the `board` host tool

A second host tool beside the coordinator `workspace` tool, enabled by
`NativeRuntimeConfig.host_tools: ["board"]`, independent of `coordination`
(it must not disable native subagents). Bridges:

| Harness | Mechanism |
|---|---|
| Claude Code | same local HTTP MCP server as coordination (bearer token), tool `board`, `--allowed-tools` gains `mcp__piui__board` (exact name follows the existing server name) |
| Hermes / ACP | same HTTP MCP in `session/new`/`session/load` `mcpServers`; ACP needs `mcpCapabilities.http`, otherwise `unsupported-board-tool` |
| Prime | second SDK custom tool |
| Codex | second dynamic tool on fresh threads; resumed threads get none |
| Pi | none (no custom tools) |

`runner.mjs` validates `BoardToolOperationV1` with exact key sets and emits
`NativeEvent::BoardRequest { request_id, operation }`; the host answers
through the same response path as coordinator requests. Where the tool is
unavailable the chat shows "Board tools unavailable in this chat" and the
instruction block tells the agent to ask the person to update the card.

Actor and scope come from the session binding (`BoardBinding { workspace_id,
session_id, run_id?, member_id?, profile_id?, teammate_id? }`), never from
arguments. An agent only touches its session's project board. Permissions:
ordinary chats use `settings.chatAgentPermissions`; managed runs started for
a teammate use `teammate.board`; other runs get read+comment. Agent-written
card text shown to another agent is wrapped as untrusted task data.

Mode: `auto` (default) applies writes immediately with an undoable activity;
`proposal` turns writes into proposals (Inbox + inline chat card). Closing is
always a proposal. Rate limit `MAX_AGENT_WRITES_PER_TURN` per turn.

Dedup: `create` without `confirmNew` returns `possibleDuplicates` when open
cards overlap by title/label tokens (lowercased word + trigram Jaccard ≥
0.45). `context` returns the chat's active card and up to 5 similar open
cards. Creating from a chat links the card to that chat and makes it active.

## Chat ↔ card

`CardLink::session`. The most recently linked open card is the chat's active
card: chip in the chat header (open / unlink / change). Set by the person
("Link to card"), the agent (`link`), or `create`/`handoff` from that chat.

Instruction block for ordinary chats when the board is enabled and the tool
is available (≈150 tokens, injected through the existing per-harness
instructions path):

> This project has a PiUI board (tool `board`). Active card: #42 "Fix login"
> (inProgress) | none. Keep the board truthful: when this conversation starts
> a distinct piece of work the person wants tracked, call board context
> first, prefer updating/commenting/moving the active or a similar card, and
> create a card only for a distinct deliverable. Do not create cards for
> questions or small talk. Hand work to teammates with `roster` + `handoff`.
> Never move cards to done/cancelled; move to inReview when you finish.

## UI

- Route `{ name: 'board'; workspaceId; cardId? }`, sidebar per-project item
  "Board" (shown when enabled; project menu offers "Enable board" otherwise).
- Columns = statuses; `done`/`cancelled` collapsible. Card: `#N`, title,
  priority mark, labels, teammate avatar, run/claim dot, link count.
- Card drawer: fields, assignee picker (availability, notAssignable reason),
  blockers, parent, linked chats/runs, timeline (comments, activity with Undo,
  proposals with Accept/Reject), Start/Stop run, comment box with `@`.
- Keyboard: columns `role="list"`, cards `role="listitem"` with roving
  tabindex; arrows move focus, `Shift+←/→` moves status, `Enter` opens, `n` new
  card, `/` filter, `Esc` closes; `aria-live="polite"` announcements. Drag and
  drop is an enhancement over the keyboard path.
- Route `{ name: 'team'; workspaceId; teammateId? }`: list with status pills,
  quick-create (3 steps: identity; simple agent chips or existing pipeline;
  rules), detail with assigned cards and run history.
- Inbox: sections "Board proposals" and "Runs waiting to start".
- Settings: per-project board toggle, agent mode, chat agent permissions,
  concurrency.
- UI Lab: `boardFake.ts` and `teammatesFake.ts` with seeded data; every flow
  works there.

## Roadmap

0. Spikes: Codex `thread/resume` MCP/dynamic tools override; ACP two tools;
   generation write latency at 2000 cards; save-teammate transaction.
1. Board for people + teammates (store, contracts, Team screen, picker).
2. Agents in chats (`board` tool, active card, dedup, auto+undo, roster,
   handoff, mentions).
3. Board-driven runs (`RunTrigger::Board`, wake rules, claims, results,
   blockers, concurrency, loop protection).
4. CLI fallback for Pi/Codex-resume, steering comments into live runs,
   archive, teammate-pack and markdown export.
