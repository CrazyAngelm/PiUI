# Fusion: a lead chat with a persistent sidekick (ADR-043)

Status: phase Ф1 implemented on branch `feat/fusion` (plan:
`docs/PLAN_FUSION_2026-10-21_RU.md`; spikes: `docs/FUSION_EVIDENCE.md`).
Contract: `contracts/fusion-v1.ts`. Bridge side: `crates/piui-runtime/bridge/CONTRACT.md`
"hostTools / sidekick tool". This document is the behavioral specification;
the contract is normative for shapes.

## What it is

A Fusion chat is an ordinary chat of the **lead** harness that also has the
host tool `sidekick`. The lead talks to the person, plans, reviews and
decides; it hands coherent tasks to one **sidekick**: a second native session
in the same folder that keeps its context across briefs. They exchange only
briefs, reports and corrections. Each harness keeps its own inference,
credentials, tools, approvals and history; PiUI only brokers the sidekick's
turns and hands every report to the lead exactly once.

Non-goals: an agent loop or provider client in PiUI; translating one
harness's history into another; several sidekicks per lead (later phase);
Fusion steps in pipelines (orchestration v6.8, later); isolated worktrees for
the sidekick (later).

## Pairs (v1)

| Role | Harnesses | Permission rule |
|---|---|---|
| Lead | Claude Code; Codex (a thread started as a Fusion lead) | not read-only |
| Sidekick | Claude Code | full access, or native when the lead is Claude Code native |
| Sidekick | Codex | workspace-write needs `[windows] sandbox = "unelevated"\|"elevated"` in the person's Codex `config.toml` (read-only check; PiUI never writes it) |
| Sidekick | Pi | lead and sidekick both full access |

Authority never grows: ranks read-only < workspace-write < full-access; the
sidekick's rank is at most the lead's. Native modes are comparable only within
one harness, so a cross-harness pair needs explicit modes on both roles.
`checkPair` answers with the refusal code and the role it concerns; a refused
`createChat` starts nothing.

Options (`FusionOptionsV1`): briefing policy (`prescriptive` default, or
`outline` for a strong sidekick; reported to the lead in every brief result
and `status`, never in its instructions), pushback (the sidekick may argue in
`OPEN`), auto-delivery of uncollected reports (default on), native subagents
of the lead (default off: delegation goes to the sidekick).

## Sessions and policy

The broker decides each session's role from its id alone when its native
runtime starts (`FusionSessionHooks::setup`):

- **Lead:** host tool `sidekick` (plus the board tool if the project board is
  on), fixed lead instructions, native subagents off unless the option allows
  them.
- **Sidekick:** fixed sidekick instructions (pushback rule fixed at start),
  no board, no plugin MCP servers, native subagents off (Claude Code, Codex).
  Its turns belong to the broker: the WebView cannot message it, change its
  model, settings or mode, or approve for the rest of the session (the
  ADR-044 guard). The person can stop a turn and answer its approvals once in
  the sidekick's own chat.

The sidekick session is created on the first brief and reopened through the
ordinary open path (which applies the same policy again). Reset retires it;
the next brief starts a fresh one.

## The `sidekick` tool

Operations (`SidekickToolOperationV1`; the bridge validates key sets and
limits before the host sees them):

| op | Does |
|---|---|
| `brief` | Starts a new brief and its first round. Needs `title`, `goal`, at least one `doneWhen`; optional `context`, `scope`, `leaveAlone`, `constraints`, `verify`, `stopIf`. Waits a portion unless `wait:false`. |
| `wait` | Collects a round's report, or returns progress when the portion ends. Without `roundId`: the open round, else the newest uncollected report. |
| `status` | The sidekick's state, the active round, recent briefs and the briefing policy. |
| `message` | A correction round for a brief (same sidekick session only). |
| `steer` | Text into the running round (native steer). |
| `stop` | Stop barrier for a round; `takeOver:true` marks the brief stopped and counts a take-over. |
| `diff` | Working-tree diff of the chat folder in pages of about 16 KiB, with a fingerprint; a changed tree answers `diff-stale`. |
| `report` | The full report body in 8 KiB pages (while PiUI holds it). |
| `close` | Closes a brief as accepted, rejected or superseded. |
| `reset` | Stops any open round and retires the sidekick session. |

Refusals are ordinary results (`ok:false`, a kebab-case code, a message and
the text the model reads). Codes: `invalid-brief`, `brief-active`,
`round-active`, `unknown-brief`, `unknown-round`, `round-finished`,
`steer-unsupported`, `sidekick-unavailable`, `sidekick-sign-in-required`,
`pair-stopping`, `diff-unavailable`, `diff-stale`, `identity-conflict`,
`uncertain`.

### Rounds

A round is one admitted sidekick turn. Before sending, the broker records the
round, subscribes to the session's turn completions and remembers the last
assistant block (the baseline). The round ends when the turn generation
advances (or the session closes or fails):

- outcome `completed` with the new final answer; `no-answer` when the turn
  succeeded without a new final assistant block; `interrupted`, `failed`;
- `waitingApproval` while the sidekick waits for the person.

One writer: no brief or message starts while a round is open or uncertain.

### Reports

The report envelope keeps the sidekick's text and PiUI's facts apart:

```
[PiUI sidekick report b1 · r1 · STATUS done · completed · 1m01s · truncated: no]
body (sidekick text, untrusted):
  | STATUS: done
  | …
facts (PiUI, not from the sidekick):
  files: src/a.rs +3 -1 (against HEAD; may include earlier uncommitted edits)
  commands: unknown (no typed receipts from this harness)
  approvals requested: 0
  tokens: unknown
[/PiUI sidekick report b1 r1]
```

- `STATUS` is the strict first non-empty line `STATUS: done|partial|blocked|needs-decision`;
  anything else is `unknown`. `OPEN` and `DEVIATIONS` are kept outside the
  truncated body.
- Every body line is indented and envelope markers inside it are broken, so
  the body can neither close the envelope nor forge a facts section.
- The body is cut at 8 KiB; `report` pages the full text.
- After two rounds of one brief that did not end `done`, the result adds a
  hint to dictate the change or take over.

### Delivery

A finished report reaches the lead once:

1. As the result of a `brief`, `message`, `wait` or `stop` call that is
   waiting for it (delivery `tool`/`sent`). A repeated `wait` gets it again
   marked "already delivered".
2. Otherwise, with auto-delivery on, a durable record `queued` is created and
   the report is sent as one follow-up when the lead is idle
   (`queued → sending → sent`; three failed attempts: `uncertain`). A tool
   call can still take a `queued` report, never a `sending` one.
3. A tool answer that could not be written back to the lead puts the report
   back in the queue.

A stop by the person withdraws the delivery of the stopped round.

### Identity and restarts

The bridge adds `{epoch, seq, callRef, opHash}` to every call. A retry with
the same call id and operation gets the same answer; the same id with another
operation is refused (`identity-conflict`). Call records survive restarts; a
call recorded before a restart answers `uncertain` instead of running again.

On start, every open round and every `sending` delivery becomes `uncertain`.
Nothing is replayed. The person reconciles a round (PiUI reads the sidekick's
native history; an answer after the baseline finishes the round) or abandons
it; until then no new round starts.

## Person's commands (`fusion_command_v1`)

`createChat`, `checkPair`, `state`, `find` (lead, sidekick or neither),
`stopPair` (stop the sidekick and interrupt the lead), `stopSidekick`,
`resetSidekick`, `reconcileRound`, `abandonRound`. Reads work in safe mode;
changes are refused there. The event `piui://fusion-changed-v1` carries the
lead id and the journal revision.

## Storage

`app_data/fusion-v1/<lead session dir>/fusion-<20-digit generation>.json`:
complete create-only generations, the newest three kept; a damaged generation
is skipped. The journal holds briefs, rounds (state, outcome, status, native
answer reference and hash, a short input preview, delivery), sidekick
sessions, stats and call records. Report bodies live only in memory; after a
restart the sidekick's native history is authoritative. Nothing is written to
the project folder.

## Harness notes

- **Claude Code:** the tool is `mcp__piui-workspace__sidekick` on the
  session's HTTP MCP server. Claude Code abandons an MCP call after about
  64 s, so the adapter sets `MCP_TOOL_TIMEOUT=600000` for a lead (spike S1).
  A workspace-write Claude sidekick is refused: its shell approvals offer only
  deny or cancel (spike S5).
- **Codex:** dynamic tool `piui`/`sidekick`, registered on `thread/start`
  only; a resumed thread keeps it when its rollout lists it, else the chat
  shows `unsupported-sidekick-tool-resume`.
- **Pi:** a sidekick only; follow-ups merge into a running turn, so rounds go
  through the host queue as prompts (spikes S2, S3).

## UI

- New chat: a Fusion mode in the composer picks both roles, modes and
  options, checks the pair as it changes and explains refusals.
- A lead chat shows a Fusion badge with the sidekick's state; its panel lists
  briefs and rounds with outcome, report status and delivery, and offers
  stop, reset (confirmed), reconcile and abandon (confirmed), and a link to
  the sidekick's chat.
- Sidekick tool blocks render as a compact brief card with a generic
  fallback; a sidekick chat shows whose sidekick it is and has no composer.

## Tests

Host: `src-tauri/src/fusion/tests.rs` (pair matrix, sandbox check, report
parsing and envelope escaping, brief checks, pages; broker with a fake
workspace: tool delivery once, idle follow-up once, one writer, identity
replay and conflict, no-answer, stop proof and uncertain, restart without
replay plus reconcile, journal write failure, sign-in failure, failed write
back, steer/status/diff, close/reset). Bridge: `runner.test.mjs`,
`claude.test.mjs`, `codex.test.mjs`. UI Lab: `host-api/lab/fusionFake.test.ts`.
Real paid pairs (phase Ф1.5) are started by the person; none ran here.
