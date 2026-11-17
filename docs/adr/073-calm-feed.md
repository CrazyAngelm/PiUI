# ADR-073 — A calm chat feed: one process control per answer

Status: accepted, 2026-11-17. Revises the fold rules of ADR-071.

## Context

Feedback on 0.3.1 said the feed was overloaded in some chats and bare in
others. Two things caused it. ADR-071 kept every reply visible, so a turn that
alternated "let me check X" with tool calls read as a column of one-line
group rows between short messages: a finished turn showed a fold control and
its replies, a running turn showed everything. And every message carried a
time and a row of icons that were always in view, while a lone "Used 1 tool"
row said little.

The reference was how ChatGPT and the Nano web chat lay out a turn: the person's
message in a bubble, then a single quiet line for the work, then the answer as
plain text. Message actions appear when the reader reaches for them, and stay
on the last answer. The web folds the agent's interim narration into that line.

## Decision

- **One control per stretch of work.** On every turn the tool and reasoning
  groups, and the replies the agent wrote between them, sit behind one
  `turn-process` control. What follows the last group is the answer and stays in
  the chat. A turn with one group has the same control; opening it lists the
  calls with no second header.
- **A finished turn keeps its last reply visible,** even when a tool call was
  logged after it. A reply that cannot be folded (failed or stopped, carries a
  file, has an author or a note from a pipeline or team chat) stays in the chat
  and ends the stretch, so such a turn has more than one control.
- **A working turn is one line.** The control shows a spinner and what happens
  now ("Running a command · pnpm test"), and the person's last message shows
  "Working" until anything arrives. The control stays closed; opened, it lists
  the groups so far, the replies between them and the live group.
- **A turn that ended badly opens its control.** The last process of a turn
  whose last block is an error, a failed or a stopped call or reply opens by
  default, so the person sees where it stopped. A failed call inside a turn that
  ended well is counted on the closed control ("1 failed").
- **The control reads quietly.** 13px muted text, no rule, the chevron next to
  the label: how long the turn took, what it did, diff totals, failed calls.
- **Message actions wait.** The time and the actions of a message appear on hover
  or keyboard focus, and always on the chat's last answer and on devices with no
  hover. Errors of an action stay in view.
- **Presentation only.** No block is dropped, reordered or changed. Search,
  print and history paging are unchanged; print shows every block. Where the
  owner cannot tell whether the agent works (the embedded and remote view), only
  a streaming block makes the control live.

`ConversationTranscript` is also the Nano web's shared feed, so the web gets the
same rules when it turns the shared transcript on.

## Consequences

A turn reads as the person's message, one line of work and the answer. The
replies the agent writes before its last tool call are one click away instead of
in the chat; a harness that writes its real answer before a closing tool call
still shows it, because the last reply of a finished turn is never folded. While
a turn works, a reply disappears into the control once more work follows it; this
is the price of a feed that does not alternate rows and messages.

## Evidence

Synthetic: unit tests of the grouping, the control and the group view, the Lab
end-to-end specs, and screenshots of the UI Lab in dark and light themes. No
provider turn is part of this evidence.
