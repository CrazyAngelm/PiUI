# ADR-069 — Linked chats and the sessions host tool

Status: accepted, 2026-11-16.

## Context

Agents need to hand a separable task to another native chat and exchange results
without turning the desktop shell into a harness. People also need to connect
existing chats. Fusion remains a separate lead/sidekick workflow.

## Decision

The host brokers links and ordinary typed runtime messages. Each native harness
continues to own its history, inference, approvals and tools. Link metadata lives
in create-only generations under `session-links-v1`; the newest three survive,
and a damaged generation is skipped. No native history is rewritten.

- A link is **agent** (started by a chat's agent), **branch** (adopted by a
  later person-facing branch flow), or **peer** (two existing chats linked by
  the person). Agent/branch links have a parent and child; peer links are
  symmetric. Depth is one. A parent has at most five open agent children.
- The `sessions` tool supports start, list, message, read, wait and stop. Only
  linked chats can be addressed. Stop applies only to the caller's children.
  Waits are bounded by the requested 0–240 seconds. Replies returned by a
  waiting tool call are not also delivered as a follow-up.
- **Authority never increases.** A same-harness child inherits the parent's
  permission mode, model, reasoning and network choice when no permission
  override is given. Explicit modes must compare at or below the parent's:
  read-only < workspace-write < full-access. Native modes across different
  harnesses are incomparable and refused. A read-only parent can start only
  read-only children. Existing per-harness sidekick restrictions also apply.
  Children use their parent's folder and worktree placement.
- **Cross-chat text is framed as data.** Agent messages identify another agent,
  reports explicitly say they are information rather than instructions, and
  person-originated messages identify the person. Titles have control
  characters removed and are cut to 80 characters. Prompts and message bodies
  are 1–16,000 Unicode scalar characters. Automatic reports contain at most
  4,000 characters and name the read operation when cut; list excerpts use
  400 characters. Full answers are available in 16 KiB pages.
- **Delivery and loops.** Idle targets receive a prompt; running targets receive
  a follow-up through the existing outbox. Each requested child turn produces
  one report, claimed by a waiting tool call or delivered to its asker. An
  agent-originated delivery may wake an idle target at most eight times in a
  row. A person's message in the chat or in its parent chat resets its counter;
  a person-facing send or deliver also resets that target's counter. Beyond
  the limit, the newest twenty pending texts stay on the incoming link and
  remain visible. Pending texts, counters and reports survive restart.
- **Coverage and preference.** Claude Code, Codex, Prime Agent, Hermes and ACP
  receive the opt-in host tool through their existing board-tool plumbing.
  Pi and Nano receive neither tool nor notice. The preference defaults on and
  is stored as `linked-chats` in the index. Fusion sidekicks, run-owned and
  coordinator-owned sessions do not receive the tool. A linked child can use
  list, message, read and wait, but cannot start another child.
  Codex records dynamic tools when a native thread is created. An older thread
  without the recorded `sessions` tool starts without it and emits a nonfatal
  resume notice. Other unsupported tool registrations also emit a notice.
- **Safe mode and lifecycle.** Safe mode supplies no tool and refuses metadata
  mutations or cross-chat delivery. Existing links remain readable. Deleting
  a chat removes its links. Changes publish `piui://session-links-v1` for each
  affected chat without changing workspace IPC or native session formats.

## Consequences

Linked chats provide no additional isolation: each chat has only its harness's
own permission mode and enforcement. Another agent's message is information,
not a command from the person. Unsupported capabilities and incomparable
authority are refused before a child starts. The host adds no agent loop and
no provider client. Tests use fake hosts and fixture bridges; they establish
broker and transport behavior without a real provider turn. UI is separate.
