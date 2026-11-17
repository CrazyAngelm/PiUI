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

Authority never grows (ADR-076). Each adapter preset has an effective
capability snapshot derived from what its bridge launches
(`fusion/capability.rs`): writes, reads, shell, network and MCP. Claude Code
read-only (`plan`) and workspace-write (`acceptEdits`) run no command, MCP
tool or outside read, because PiUI lets their approvals only be denied; Codex
read-only / workspace-write run any command inside the sandbox and read the
whole disk; for a sidekick the bridge switches every configured MCP server off
(their processes run outside the sandbox; an unreadable configuration refuses);
Nano `native` asks the person before bash, write and edit; full access is
unrestricted everywhere. Every dimension of the sidekick must be at most the
lead's, except reads: by the owner's decision (2026-11-18, "Разрешить чтение
вне проекта") a sidekick may read outside the project folder even when the lead
cannot. It is a deliberate exception to same-or-less, made because restricting
Codex reads on Windows needs the elevated sandbox backend (FUSION_EVIDENCE S12)
and the Claude Code + Codex pair is the main use case; the allowance line still
shows "reads outside the project". With reads exempt, a sandboxed command is
covered by a lead that may make the sandbox's writes; a person-approved command
is covered only by the same or an unrestricted shell; another harness's MCP
servers only by a lead with unrestricted shell. When the requested sidekick
preset exceeds the lead, the host narrows it to the strongest preset of that
harness that fits and launches with that; it refuses only when no preset fits
and names the dimension (`sidekick-exceeds-lead` + `dimension`). A read-only
lead gets a read-only sidekick (Claude Code, Codex or Nano); a Claude Code
workspace-write lead gets a Codex workspace-write sidekick; Pi still needs a
full-access lead. Native modes stay comparable only within one harness. The
picker shows the sidekick's allowance from the same matrix (`pairCheck`
`sidekickMode` + `capabilities`) before launch. The picker's
defaults come from the same matrix and are always admissible (a Codex
sidekick still needs the sandbox check), and the picker remembers each role's
model, reasoning and Fast; a remembered model is checked against the fresh
catalog (`checkRoleAgainstCatalog`) and never silently replaced.

A sidekick session must prove at launch that it cannot delegate or keep
working after its turn (ADR-076): Claude Code gets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and `--disallowed-tools Agent`, and
the first `system/init` tool list must not contain `Agent` or `Task` (else the
session is stopped); Codex needs a successful `features list` that registers
`multi_agent` and `multi_agent_v2`, and a second listing with both passed as
`--disable` must read them `false` (verified on 0.165.0 and 0.169.0, where
`multi_agent` is `deprecated`), else the launch is refused with
`unsupported-native-subagent-policy`. `unified_exec` (background terminals)
is passed as `--disable` when registered; Codex 0.169.0 keeps it on despite
the flag, so there the sidekick instructions and the broker's turn end bound
the work. Pi and Nano run
every command inside the turn. A brief whose `scope` or `leaveAlone` points
outside the project folder is refused, and its file facts are read from the
sidekick's own folder.
`checkPair` answers with the refusal code and the role it concerns; a refused
`createChat` starts nothing.

Each role may also include `serviceTier: "fast"` when its selected native model
advertises fast-mode support. An absent tier uses the harness default. This is
an additive Fusion v1 field, so existing saved pairs without it still load.

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

### Lead behaviour (2026-11-16)

Real sessions showed leads that rarely delegated: they guessed tool fields,
polled `wait` dozens of times and ran builds and tests themselves. The lead
instructions now make the sidekick the **default executor** (not a subagent):
implementation, multi-file or mechanical edits, builds, test runs,
reproductions, log digging, fixes and verification go to it; the lead keeps
understanding, exploration that shapes the plan, design, review, commits and
releases. A report is closed or corrected and the next brief sent in the same
turn, so the sidekick does not sit idle. When the option allows the lead's
native subagents, they are for work outside the sidekick's scope or read-only
research and review, and only while the sidekick is busy. Waiting is done once;
a result that says the report will be delivered ends the turn. The text still
names no harness or model, so the lead's cached prefix does not depend on the
sidekick. The idle nudges and the `wait` selectors above support this at the
point of use.

## The `sidekick` tool

Operations (`SidekickToolOperationV1`; the bridge validates key sets and
limits before the host sees them):

| op | Does |
|---|---|
| `brief` | Starts a new brief and its first round. Needs `title`, `goal`, at least one `doneWhen`; optional `context`, `scope`, `leaveAlone`, `constraints`, `verify`, `stopIf`. Waits a portion unless `wait:false`. |
| `wait` | Collects a round's report, or returns progress when the portion ends. Optional `roundId` or `briefId` (not both), optional `waitSeconds`. `briefId`: that brief's open round, else its newest round. Neither: the open round, else the newest uncollected report. |
| `status` | The sidekick's state, the active round, recent briefs and the briefing policy. |
| `message` | A correction round for a brief (same sidekick session only). |
| `steer` | Text into the running round (native steer). Needs `text`; optional `roundId` or `briefId` (not both). `briefId`: that brief's open round only (`round-finished` naming the brief when it has none). Neither: the open round, else `unknown-round` ("No sidekick round is running."). |
| `stop` | Stop barrier for a round; `takeOver:true` marks the brief stopped and counts a take-over. Optional `roundId` or `briefId` (not both), resolved like `steer`. |
| `diff` | Working-tree diff of the chat folder in pages of about 16 KiB, with a fingerprint of the file list and each shown file's content; a changed tree answers `diff-stale`. A file larger than a page continues on the next pages (cut at line ends, always on character boundaries); a file list or file diff cut upstream is named in the page header. |
| `report` | The full report body in 8 KiB pages (while PiUI holds it). Optional `roundId` or `briefId` (not both), optional `page`. `briefId`: that brief's newest finished round (a running correction does not hide the report before it), else its open or newest round. Neither: the newest round that has a report, else `unknown-round`. |
| `close` | Closes a brief as accepted, rejected or superseded. |
| `reset` | Stops any open round and retires the sidekick session. |

`roundId` and `briefId` are additive optional fields of Fusion v1 (no version
bump; a call with only `roundId` behaves as before). Both together are refused
with `unknown-round` ("Give roundId or briefId, not both."), the code the host
also uses for any other invalid non-`brief` call; an unknown `briefId` is
`unknown-brief`. The host resolves the selector under the journal lock with
the same helpers as a plain `roundId`, so call identity and replay (the
operation hash is computed by the bridge over the operation as sent) are
unchanged.

A wait portion (`waitSeconds`, default 240, at most 540) counts from the
moment the call reaches the host, not from the end of the sidekick's start:
`brief` and `message` start the round first and wait only for what is left of
the portion, so a slow start cannot push the call past the lead's tool
transport limit. A portion that is already used up answers with progress at
once, like `waitSeconds: 0`.

Refusals are ordinary results (`ok:false`, a kebab-case code, a message and
the text the model reads). Codes: `invalid-brief`, `brief-active`,
`round-active`, `unknown-brief`, `unknown-round`, `round-finished`,
`steer-unsupported`, `sidekick-unavailable`, `sidekick-sign-in-required`,
`pair-stopping`, `diff-unavailable`, `diff-stale`, `identity-conflict`,
`uncertain`.

### Rounds

A round is one admitted sidekick turn. Before sending, the broker records the
round, subscribes to the session's turn completions and writes the last
assistant block (the baseline) to the journal. A stop that reaches a round
before its prompt is sent cancels it (`interrupted`, nothing runs); prompt
admission and the stop share one gate, so a stop either interrupts an
accepted prompt or prevents it. A send error before the harness accepted the
prompt fails the round; once accepted, the round holds admission until its
turn is observed to end. The round ends when the turn generation advances
(or the session closes or fails):

- outcome `completed` with the new final answer; `no-answer` when the turn
  succeeded without a new final assistant block; `interrupted`, `failed`;
- `waitingApproval` while the sidekick waits for the person.

One writer: no brief or message starts while a round is open or uncertain,
or while a reset, abandon or reconcile runs (they hold admission until they
end; a reset until the old session is closed). An admitted round starts in a
task the broker owns, so closing the lead while the round starts cancels only
the tool call's wait: the round still gets its watcher and its report.

### Reports

The report envelope keeps the sidekick's text and PiUI's facts apart:

```
[PiUI sidekick report b1 · r1 · STATUS done · completed · 1m01s · truncated: no]
body (sidekick text, untrusted):
  | STATUS: done
  | …
facts (PiUI, not from the sidekick):
  files: src/a.rs +3 -1 (against HEAD; may include earlier uncommitted edits)
  command: cargo test -p app -> ok
  command: pnpm check -> failed
  approvals requested: 0
  tokens: unknown
[/PiUI sidekick report b1 r1]
```

- `command:` lines are the shell commands the sidekick ran in this round, read
  by the host from the sidekick's own session (Codex `commandExecution`,
  Claude Code `Bash`/`PowerShell`, Pi `bash`, Nano `bash` or Windows
  `nano_powershell`). The round is bounded by its own prompt header, not by
  an answer: it runs from after the last user block that starts with
  `[PiUI brief <id> · round <id>]` (or the `[PiUI feedback on brief …]`
  header of a correction) up to the next round's header. A steer has no
  header and stays inside its round, so a round that was stopped without an
  answer is never attributed to the next one. The result is the block's
  status only (`ok` settled, `failed`, `unknown` for an interrupted or still
  running one); blocks carry no exit code, so none is shown, and a command's
  output never enters a fact. A command is sidekick-authored text under the
  PiUI heading, so envelope markers in it are broken the same way as in the
  body (`[PiUI` becomes `[ PiUI`, `[/PiUI` becomes `[/ PiUI`) and obvious
  inline secrets are replaced by `***` before the cut: the value of an
  assignment or header whose name contains `api_key`, `token`, `secret`,
  `password`, `passwd` or `authorization` (`name=value`, `name: value`, also
  in a query string), the argument after a flag with such a name
  (`--password value`) and the token after `Bearer`. A key word that is only
  a word of the command (`grep token src`) stays. This is conservative, not a
  guarantee. Each
  command is one line of at most 200 characters. At most 30 are listed:
  every failed command stays, the newest successful ones fill the rest, in
  execution order, and `commands: N more not shown` counts the others.
  `commands: none run` means the transcript holds no shell block for the
  round. When the transcript does not hold the round's header (a reloaded
  history that dropped it, an unreadable transcript, a read that takes more
  than 3 s) or the harness has no shell blocks, the line is `commands:
  unknown (no typed receipts from this harness)`. In the wire contract the
  fact is `source: native` with an optional `omitted` count (additive within
  `fusion/1`).

- `STATUS` is the strict first non-empty line `STATUS: done|partial|blocked|needs-decision`;
  anything else is `unknown`. `OPEN` and `DEVIATIONS` are kept outside the
  truncated body.
- Every body line is indented and envelope markers inside it are broken, so
  the body can neither close the envelope nor forge a facts section.
- The body is cut at 8 KiB; `report` pages the full text.
- After two rounds of one brief that did not end `done`, the result adds a
  hint to dictate the change or take over.
- Idle nudges (texts the lead reads, outside the envelope): a report handed to
  the lead as a tool result of `brief`, `message`, `wait` or `stop` is
  followed by "The sidekick is idle now. Close or correct this brief, then
  send the next brief before doing the work yourself." It is not added to
  `report` pages, to an "already delivered" repeat, to a `stop` with
  `takeOver` or to a result that carries the take-over hint. The follow-up of
  an idle lead ends with "The sidekick finished and is idle. Review the report,
  close or correct the brief, and send the next brief before doing the work
  yourself."
- The progress text of a still-running round depends on the pair's
  auto-delivery: on, it says the lead may end its turn because the report is
  delivered when it is ready; off, it says to plan or review meanwhile and
  call `wait` again to collect the report. The `brief-active` / `round-active`
  refusal gives the matching advice (on: wait once, steer, stop or end the
  turn; off: wait to collect it, or steer or stop it).

### Delivery

A finished report reaches the lead once:

1. As the result of a `brief`, `message`, `wait` or `stop` call that is
   waiting for it (delivery `tool`/`sending`, then `tool`/`sent` once the
   answer was written back to the lead). A repeated `wait` gets it again
   marked "already delivered". A retried call whose first answer went back
   to the queue takes the queued report back instead of leaving a duplicate.
   A waiting call that is cancelled (the lead closed) hands an unclaimed
   report to the queue.
2. Otherwise, with auto-delivery on, a durable record `queued` is created and
   the report is sent as one follow-up when the lead is idle
   (`queued → sending → sent`; three failed attempts: `uncertain`). A tool
   call can still take a `queued` report, never a `sending` one.

Every finished report gets its pending record in the same journal write that
finishes the round: `tool/queued` while a call (including the lead's `stop`)
waits for it or when auto-delivery is off, else `followUp/queued`. A waiting
call that ends without taking it moves it to the follow-up queue; on start,
a `tool/queued` report (and, from an older journal, a finished answer without
any record) is queued as a follow-up. Old briefs are folded out of the
journal only when none of their deliveries is still `queued` or `sending`.
3. A tool answer that the bridge rejected before consuming it (a stale or
   invalid request) puts the report back in the queue. An acknowledgement
   timeout or a transport failure may follow a consumed answer: the delivery
   becomes `uncertain` and the report is never handed over a second time.

A stop by the person withdraws the delivery of the stopped round: a waiting
call ends with `pair-stopping` and no report, and neither `wait` nor
`report` hands it over later. The withdrawal is final: a reconcile that
later finishes the round from history does not queue it. `stopSidekick` on
an uncertain round interrupts again and is refused (`uncertain`) unless the
turn's end is now proven.

### Identity and restarts

The bridge adds `{epoch, seq, callRef, opHash}` to every call. A retry with
the same call id and operation gets the same answer; the same id with another
operation is refused (`identity-conflict`). Call records survive restarts; a
call recorded before a restart answers `uncertain` instead of running again.
The newest 4000 calls keep full records; older ones keep a compact tombstone
(digests of the call key and operation hash) for the pair's lifetime, so an
evicted call is still refused (`uncertain` or `identity-conflict`), never run
again.

On start, every open round and every `sending` delivery (tool or follow-up)
becomes `uncertain`. Nothing is replayed. The person reconciles a round (PiUI
reads the sidekick's native history; an answer after the journaled baseline
finishes the round; a round without a journaled baseline, e.g. from an older
journal, stays unprovable) or abandons it; until then no new round starts.
The baseline is journaled as its block id and the SHA-256 of its text: a
reloaded history may give the same answer another id, so an answer whose
text equals the baseline's is not new (a baseline journaled without its hash
is unprovable). Abandoning releases admission only when the turn is proven
over: the session runs no turn, or PiUI closed it (its runtime is gone) and
retires it, so the next brief starts a fresh sidekick; otherwise the round
stays `uncertain`.
A report still `queued` is read back by its saved answer block and hash, or
by the newest answer with that hash when the id changed, before it is sent;
when that fails, the delivery becomes `uncertain` instead of sending a
placeholder. `wait` and `report` read it back the same way.

## Person's commands (`fusion_command_v1`)

`createChat`, `checkPair`, `state`, `find` (lead, sidekick or neither),
`stopPair` (refused unless the id is a Fusion lead; waits for the lead's
pending start and prompt admission, pauses its queued input, interrupts it
if a turn is active, then stops the sidekick; either failure is returned,
never acknowledged), `stopSidekick`,
`resetSidekick`, `reconcileRound`, `abandonRound`, and (ADR-076)
`resumePair`, `checkDelivery`, `deliverAgain`, `dismissReport`,
`steerSidekick`. Stop pair first **pauses** the pair (journaled `paused`):
no brief is admitted and no follow-up is sent; a follow-up already past its
pause check finishes its send before the pause returns, so the lead interrupt
that follows reaches it, and the delivery worker re-checks the pause right
before it claims `sending`. The pair resumes only with `resumePair` or when
the person starts a new lead turn (a lead tool call from a turn newer than the
stopped one). A send that was written but never confirmed (timeout, lost
acknowledgement, dead runtime) is `acceptance-unknown`: a round becomes
`uncertain` and keeps the writer lock until it is reconciled or abandoned; a
follow-up becomes `followUp/uncertain` and is never resent blindly. Only a
refusal before the write fails a round. A report whose delivery is uncertain
is listed by `status`, shown as "report needs checking" on the badge, and the
panel offers Check lead chat (searches the lead's native history for the
report's stable id `[PiUI sidekick report <brief> · <round> ·`), Deliver
again and Dismiss; `wait(roundId)` says "delivery unknown", never "already
delivered". A tool handoff is given to the lead only after `tool/sending` is
journaled. `steerSidekick` sends the person's correction into the running
round as a steer marked `[PiUI: the person adds to round …]` and counts it in
`personSteers`; it changes no authority. Reads work in safe mode;
changes are refused there. The event `piui://fusion-changed-v1` carries the
lead id and the journal revision. Deleting a lead chat is refused while a
sidekick round of its pair is open or uncertain; otherwise the pair goes with
it (journal removed, idle sidekick closed; the sidekick's chat stays). A
retired sidekick's chat may be deleted, the current one may not. The
WebView's "close session" on a current sidekick first runs the same broker
stop (withdrawing the round's delivery) and then disposes the process as the
safety fallback.

## Storage

`app_data/fusion-v1/<lead session dir>/fusion-<20-digit generation>.json`:
complete create-only generations, the newest three kept; a damaged generation
is skipped. The journal holds briefs, rounds (state, outcome, status, native
answer reference and hash, a short input preview, delivery), sidekick
sessions, stats, call records and tombstones, and host-private round facts
(baseline block and text hash, start time) that never reach the WebView. Report bodies live only in memory; after a
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
- The chat list nests a sidekick's chat under its lead. A lead opens itself
  when one of its sidekick chats is current, and once when its pair starts
  working, so the sidekick's chat is in view without being opened first.
  After that the person's choice to open or close the lead stands.

## Tests

Host: `src-tauri/src/fusion/tests.rs` (pair matrix, sandbox check, report
parsing and envelope escaping, brief checks, pages; broker with a fake
workspace: tool delivery once, idle follow-up once, one writer, identity
replay and conflict, no-answer, stop proof and uncertain, restart without
replay plus reconcile, journaled baseline across rounds and older journals,
stop before send, refused correction on a journal failure, tool handoff
`sending` across a restart, queued report read back or uncertain, cancelled
waiter, withdrawn report, replay reclaim, content-bound diff fingerprint,
lead deletion, journal write failure, sign-in failure, failed write back,
steer/status/diff, close/reset; review round 2: abandon closes and retires
a session whose turn may still run, round start survives a cancelled call,
reset holds admission, a withdrawal survives reconcile, a repeated stop of an
uncertain round, no write-back after deletion, pending records on start and
without auto-delivery, cancelled lead stop, folding keeps pending reports,
evicted call identities, large-file diff pages, reloaded block ids for
reconcile and queued reports, ambiguous tool handoff; lead behaviour
2026-11-16: `wait`/`steer`/`stop`/`report` by `briefId` or without an id and
both ids refused, the wait portion counted from call entry, idle nudges and
the auto-delivery-dependent texts, lead instructions name no harness).
Bridge: `runner.test.mjs`,
`claude.test.mjs`, `codex.test.mjs`. UI Lab: `host-api/lab/fusionFake.test.ts`.
Real paid pairs (phase Ф1.5) are started by the person; none ran here.
