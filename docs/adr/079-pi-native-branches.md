# ADR-079 — Pi chats branch natively

Status: accepted, 2026-11-20. Amends ADR-070 (chat branches), which promised
native branches only for Claude Code and Codex.

## Context

A tester compared the two builds. Branching a Claude Code or Codex chat opens a
copy that shows the whole earlier conversation, and the person simply carries
on. Branching a Pi chat opened an empty chat whose composer held a text digest
("I am continuing work from a Pi chat…", the last request and the start of the
last answer) for the agent to go and find its context. That is ADR-070's linked
branch, and it is the wrong default for Pi: Pi itself can fork a session.

## Decision

Pi joins Claude Code and Codex in `HarnessKind::supports_native_branch`. The
placement contract (`branch: { mode: 'native', … }`), the origin hook, the
`fork` initialize reference and the fixed errors do not change. Pi's own forks
do the copying; the adapter never writes a session file.

- **Whole chat.** `pi --fork <source file> --session-id <new uuid>` with the
  child's own `--session-dir`. Pi copies the source's entries into a new JSONL
  whose header names the source as `parentSession`. The id is allocated by the
  adapter, so the child's binding is known before the first prompt.
- **Cut before a user message.** The adapter starts Pi on the source with
  `--session <source file> --session-dir <child directory>`, reads
  `get_entries`, finds the user entry on the active branch whose opaque block id
  (`pi-entry-…`) equals the cut, and sends the RPC `fork { entryId }`. Pi writes
  the copy into the child directory and swaps its session to it; the adapter
  then reports that session as the binding and reads its history. A cut before
  the first message therefore inherits nothing, and the copy is not written
  until the first answer, exactly like a new Pi chat. While the source is open
  for the cut, no flag that writes (`--name`, `--model`, `--provider`,
  `--thinking`) is passed; the title is set on the copy afterwards with
  `set_session_name`, and the copy keeps the model and reasoning level recorded
  in the history it inherits. Opening an existing Pi session appends nothing
  (the one exception, a missing reasoning-level entry in a session older than
  the first time PiUI opened it, was already written when this chat started).
- **The source must name its file.** Pi finds a source by path. The host refuses
  a native Pi branch with `BRANCH_UNSUPPORTED` before any start when the source
  chat has no recorded session file, and the interface then falls back to the
  linked branch of ADR-070. The runtime configuration check refuses a Pi fork
  without an absolute source path, and the adapter refuses a missing file.
- **Refusals reuse ADR-070's codes.** A cut that is gone, is an answer rather
  than a message, or is not on the active branch fails with
  `branch-point-not-found`. A fork that Pi or one of its extensions declines, or
  a source that cannot be listed, fails with `branch-unsupported`. Native error
  text stays private. A refusal kills the Pi process that was opened on the
  source and leaves the source file as it was.
- **Nano keeps linked branches.** Nano is Pi underneath but owns a private agent
  directory and relay; a Nano fork is refused (`branch-unsupported`) and falls
  back to the linked branch. Prime Agent, Hermes and ACP agents are unchanged.
- **Reopening.** The child has its own binding after its first start, so it
  resumes like any Pi chat. A child that was never written (a cut before the
  first message) forks again on restart, as an unsent Claude Code fork does.

## Evidence

Pi 1.4.0 on Windows, hand-built source sessions, no provider call. Through the
real bridge: a whole-chat fork showed all four source blocks in a file of its
own with a header naming the source; a cut before the second message showed the
first two; a cut before the first message showed none and wrote no file; a gone
cut and an answer both failed with `branch-point-not-found`. The source file's
hash was identical before and after every case. These are synthetic runs of the
installed Pi; no model turn was made in a branch.

The tests added with this decision are the bridge tests in
`crates/piui-runtime/bridge/pi-branch.test.mjs` (fake Pi RPC fixture), the Rust
validation and placement tests, and the Lab fake. They are synthetic.

## Consequences

A Pi branch looks like a Claude Code or Codex branch: the earlier messages are
there and the person writes on. Pi stores a full copy of the history per branch,
as it does for its own `/fork`; deleting a branch in PiUI removes metadata only,
never the copy. Pi 1.4.0's `--fork`, `--session-id` and RPC `fork` are required;
an older Pi that lacks them fails the start of the branch, not the source chat.
