# ADR-071 — A turn's work folds behind one control

Status: accepted, 2026-11-16.

## Context

A long turn rendered as a column of one-line rows of equal weight. Every
reasoning block was its own "Thought" row and cut the tool calls around it
into separate count rows, so twenty rows said little about what the agent
did or was doing. The person named the DeepSeek Harness web UI as the
reference. Its rules (`packages/client/ui-chat/src/client/conversation-nodes/README.md`
in `deepseek-ai/deepseek-harness`) were read; no code was copied.

## Decision

- **One group per stretch of work.** Every adjacent reasoning and tool block
  belongs to one group. Only a reply (assistant text), a person's message, an
  error, a compaction mark or a compatibility block ends it. An assistant
  block without text does not.
- **A working group says what happens now.** Its header names the current
  action and its detail: the running command or the latest line of reasoning.
  A finished group names what was done, with counts and diff totals.
- **A finished turn folds.** A turn that ended normally and has two or more
  groups shows one control above its work with the activity of the whole turn
  and, when the history carries times, how long it took. Its groups stay
  hidden until the control is opened. Replies always stay visible. A turn
  that is running, failed or was stopped keeps its groups in view. A turn
  with one group shows that group as its own control. The control also
  carries the number of failed calls, so a failure inside a turn that ended
  well is not hidden. Where a conversation's owner cannot tell whether its
  agent still works (the embedded and remote conversation view), the last
  turn stays open. If history paging cuts a turn's control off, its groups
  show.
- **Reasoning is a row in its group** with a one-line preview. It opens on
  request, also while it streams. A group that holds a single call or a
  single reasoning block opens that row with it.
- **An opened group is capped in height** and scrolls inside the transcript.
- **Keyboard focus keeps its place.** The transcript follows new content
  until the reader moves away from the latest message. Focus that lands on a
  control inside it counts as such a move, as a wheel, a touch or a key
  already did: a control reached with Tab stays in view instead of being
  pulled back to the latest message.
- **Presentation only.** No block is dropped, reordered or changed. Search,
  print, history paging, message actions and the generic compatibility row
  are unchanged. A compatibility block stays visible as its own row.
- **Codex agent items are tool blocks.** `collabAgentToolCall`,
  `subAgentActivity` and `imageView` are projected by the Codex bridge as
  ordinary tool blocks without thread ids. Other unrecognised items keep the
  generic fallback.

## Consequences

A turn reads as replies with one line of work between them, and a finished
turn as its replies under one line. The duration appears only where the
native history has timestamps; other harnesses show the activity alone.
There is no setting for the amount of detail yet: DeepSeek Harness has four
levels, and one can be added here without changing the grouping.

## Evidence

Synthetic: unit tests of the grouping and the views, the Codex bridge fixture
and the Lab end-to-end tests. No provider turn is part of this evidence.
