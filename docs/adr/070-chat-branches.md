# ADR-070 — Chat branches through native forks and linked-chat metadata

Status: accepted, 2026-11-16.

## Context

A person can continue a chat with another harness without converting its native
history. Branching also needs a way to keep the original harness's context up to
a chosen user message. PiUI remains a host for native harnesses, not a history
writer or a second chat format.

## Decision

`createChat.branch` in `contracts/workspace-placement-v1.ts` has three shapes:
`{ mode: 'native', at: 'end' }`, `{ mode: 'native', at: 'before', blockId }`, and
`{ mode: 'linked' }`. All require `continuedFrom`.

- **Native branches** use Claude Code's or Codex's own fork. The harness and
  model source must match the source chat, which must have native history and
  must not belong to a run. The chat runs in the source's folder and inherits
  its verified worktree binding. A separate worktree request is refused.
- **Settings follow the source on the same harness.** Both branch modes take
  the source's permission mode; native branches also take its model and
  reasoning level, ignoring the request's permission mode and model. Linked
  branches use the requested model when present or the source's otherwise;
  branches on a different harness keep the request's settings.
- **The cut is before a user message.** Claude resumes at that prompt's parent
  entry, including a system or attachment parent. Codex keeps the preceding
  turn through the stable `lastTurnId` parameter. Cutting before the first
  prompt starts a fresh native session. An unknown cut is refused rather than
  replaced with an empty chat. A branch taken while the source runs holds
  finished turns only; it is not a snapshot of an unfinished generation.
- **Linked branches** create an ordinary chat on any supported harness and
  record its origin. No history is translated or imported. Pi, Prime Agent,
  Hermes and ACP agents support linked branches only.
- **Branch origins live in the linked-chat store.** Each child's optional
  origin stores its source, native/linked mode and optional cut block id.
  Documents without an origin remain readable, and an origin without any link
  survives cleanup. The existing placement file, version and strict unknown
  field handling are unchanged. Placement views add the branch mode from the
  origin hook. Deleting a chat removes its origin.
- **Forking happens at spawn.** An unbound native branch resolves its source
  through the origin hook and supplies a host-private `fork` configuration to
  the bridge. Once the branch has its own binding, reopening resumes it. An
  unsent Claude fork whose transcript does not exist forks again, including
  after a settings restart. A missing source or native id fails the start.
- **Both modes are linked children of kind `branch`.** Origin recording and
  adoption are independent of the linked-chats tool preference. Native mode
  requires durable origin recording. Linked mode records it best effort. A
  refused link, including the linked-chat depth limit, does not undo a
  successful chat creation. A failed creation forgets its origin and placement
  and removes the new registry record.
- **Codex dynamic tools follow resume rules.** `thread/fork` cannot register
  dynamic tools. The bridge checks the fork's own rollout and emits the
  existing nonfatal resume notices when board, sidekick or sessions is absent.
- **Safe mode refuses creation**, just as it does every other `createChat`.
  Unsupported native branches and missing cuts have fixed placement errors:
  `BRANCH_UNSUPPORTED` and `BRANCH_POINT_NOT_FOUND`.

## Evidence

The real-provider spike of **2026-11-16**, using Claude Code **2.1.325** and
Codex **0.165.0** on Windows, used **eight Claude turns and five Codex turns**.
It established that Claude's stream-json launch accepts
`--resume <source> --fork-session --session-id <child>` and an optional
`--resume-session-at <parent entry>`. The source remained byte-identical,
including while another process held it open. The child transcript appeared
only after its first user message and preserved inherited entry UUIDs.

The same spike established that Codex `thread/fork` creates a new native id,
preserves inherited turn and item ids, accepts stable `lastTurnId`, and returns
the same permission and working-folder fields as resume. A missing turn was
refused. The child's rollout is a pointer to the parent's history file; the
branch keeps reading that file. PiUI deletion removes metadata, never native
history, so it does not break that reference.

The tests added with this decision are **synthetic**: fake bridge processes and
host spawners verify arguments, cuts, inherited display blocks, permission and
folder checks, origin persistence and refusal cleanup. No new provider turns
are part of this implementation's verification.

## Consequences

Native histories are never copied, edited or deleted by PiUI. Inherited blocks
use the bridges' existing history readers and keep stable native block ids.
Only Claude Code and Codex promise native branching; other harnesses retain a
useful linked branch. No extra isolation is promised beyond each chat's native
permission mode. Older builds can still read the unchanged placement files.
