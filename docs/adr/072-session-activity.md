# ADR-072 — The chat inspector shows what the session is running

Status: accepted, 2026-11-17.

## Context

The chat's right-hand inspector ("Details") listed static facts: agent, model,
status, project, update time and a long check list of what the agent can do.
The person called it useless. The useful question about a chat that works is
what it is doing right now: which subagents and which shell commands run,
including the ones that keep running after the tool call that started them
returned. Claude Code has a view of exactly that (its background tasks), and
a chat that runs a dev server or a long review agent in the background gave
no sign of it in the transcript.

## Decision

- **The inspector leads with the running work.** Its first section lists the
  session's subagents, shell commands and other tasks, running ones first,
  with how long each has run, what a running one is doing now and how a
  finished one ended. Linked chats and a Fusion sidekick follow it: they are
  this chat's agents too. Then come the chat's origin, the agent mode, the
  pipeline run and plugin panels.
- **The list is an additive field.** `SessionSnapshot.tasks` and the workspace
  event `{ type: 'tasks', tasks }` (both additive v15, contract
  `workspace-session-tasks-v1`) carry it; the event replaces the whole list. The
  Claude Code bridge fills it from Claude Code's own task frames, verified on
  2.1.325: `task_started`, `task_progress`, `task_updated`,
  `task_notification` and `background_tasks_changed`. The list is bounded to 32
  entries, running ones first, every text one line. It carries no native task,
  process or agent id, no prompt, no output and no file path. A text that names
  the native task, such as Claude Code's hand-back notice, is dropped. Unknown kinds
  read as a generic task and an entry that cannot be read is skipped.
- **Harnesses that report nothing still show something.** Every other
  harness sends no tasks. The interface then lists the tool calls of the
  timeline that are still streaming (a running command or delegation), taken
  from the blocks it already has. A block that a native task names is not
  listed twice. A live timeline block carries no start instant, so such a row
  shows a time only when this window saw the call start.
- **Stopping one task is a host action.** `workspace_task_stop_v1` asks the
  harness to stop one running task of one live session: Claude Code's
  `stop_task` control request. It is a trusted action of this computer's
  window, refused in safe mode, for a member of a managed run (ADR-044) and
  for a Fusion sidekick, and it is not in the remote allowlist. Rows of such
  a chat, and the rows a remote viewer sees, have no stop control. The list itself changes only through the `tasks`
  event; the window never edits it locally. The stop control is always
  visible on a stoppable row, never hover-only.
- **Tasks belong to the live native process.** They are not persisted, not
  rebuilt from history and not part of a saved system. A closed, failed or
  reopened session has none.
- **No second runner.** Nano Desktop adds no agent loop, task runner or
  process supervision of its own. It reports and stops what the native
  harness already runs.
- **A running mark on the toolbar.** While the details panel is closed, a
  small dot sits on its button and a status text says how many native tasks
  and agents run in the chat. The quick tool calls of a turn do not count:
  the mark is for work that outlives one. The button keeps its name.
- **No block of facts or capabilities.** The first version kept the agent,
  model, project, status, update time and the list "What this agent can do
  here" behind a closed disclosure "About this chat". It was removed on
  2026-11-17 at the person's request: the model is on the composer, the project
  and status are in the sidebar, and the list gave nothing to act on.
  Capability enforcement is unchanged; the host and the adapters still decide
  it, the panel only stopped listing it.

Alternatives rejected:

- **Tasks as timeline blocks.** Transport noise in the conversation, and
  history would then claim what only a live process knows.
- **Keeping a tool call "running" while its background task lives.** It
  falsifies the transcript: the call returned.
- **A separate panel.** One contextual inspector is the rule; chat details
  belong to chats.

## Consequences

Claude Code chats show their background agents and commands with elapsed time
and a stop control. Pi, Codex, Prime Agent, Hermes, Nano and ACP chats show
only the calls that are running in the transcript and offer no stop. Elapsed
times use this computer's clock: the instants the harness reports, or the
moment this window saw a call start. A call that was already running when
its chat was loaded shows no time. Because
the list is bounded and one line per entry, a very busy session shows its
newest and running work, not all of it. A native task type a later Claude
Code release adds appears as a generic task until it is mapped.

## Evidence

Real provider: `evidence/session-activity-20261117/claude-code-task-frames.md`
records the frame shapes of Claude Code 2.1.325 for a background shell and two
subagents. `evidence/session-activity-20261117/claude-bridge-tasks-probe.md`
is one run of `scripts/claude-tasks-probe.mjs`: real Claude Code 2.1.325, driven
through the bridge, listed a background command and a subagent, linked the
command to its tool block and stopped it with `stopTask`. Claude Code did not
report the foreground command as a task. Neither run exercised the Nano Desktop
window.

Synthetic: unit tests of the reducer, the host client, the activity model and
the Russian copy; the Lab fake of `workspace_task_stop_v1` and its tests; Lab
end-to-end and accessibility tests of the panel and the toolbar; the Claude
Code bridge fixture and the host DTO tests. No provider turn is part of this
evidence.
