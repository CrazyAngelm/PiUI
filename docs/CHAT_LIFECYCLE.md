# Chat lifecycle

Closing a native process does not end the conversation. A restored ordinary
chat opens automatically through the existing trusted `openSession`
route and the persisted native resume binding. Safe-mode and managed history remain process-free. Managed graph runs retain their coordinator-owned lifecycle.

An empty ordinary chat is a durable PiUI draft even before Codex writes native
history. After a host restart, a known unmaterialized draft whose reserved file
is absent starts a new native draft under the same PiUI ID and title. Missing
previously materialized history is not automatically replaced with an empty chat.
The installed-Codex regression `native_codex_empty_chat_reopens_after_host_restart`
exercises open, close, registry reload, reopen and reclose without a model request.
Run it explicitly with `PIUI_DRAFT_REOPEN_TEST_ROOT` set to a disposable directory
and `CODEX_HOME` set to its `codex-home` child.

The composer model picker shows the current native model even when discovery
omits it. Codex app-server versions inside the verified range (0.147.0 up to,
not including, 0.158.0; see `crates/piui-runtime/bridge/CONTRACT.md`) are
supported; newer versions are reported as unverified until audited. Hidden
current models retain their native reasoning metadata;
an absent model remains visible without invented effort levels. Model changes,
effort and Fast use `workspace_settings_v16` and the native adapter.

The compact picker opens an effort panel and a separate model list with the
current selection checked. The native range control supports arrow keys, Home
and End. Its chaos-energy fill increases with the model's supported effort
levels; the highest level adds a dark crimson absorbing vortex and lightning.
Reduced motion keeps the effect static. Errors retain the previous confirmed settings, and
Escape returns focus to the composer control.

Codex `account/rateLimits/updated` notifications are account metadata, not
transcript entries. They never create compatibility-view blocks. Actual turn
errors (including quota failures) and unknown conversation events remain visible.

**Session details → Delete chat** opens a keyboard-accessible confirmation.
Deletion removes the PiUI catalog entry and local UI draft; harness-owned history
is retained, as the confirmation states. The additive `workspace_lifecycle_v13`
route accepts only an opaque session ID. It rejects safe mode, managed run
sessions and busy runtimes. It closes an idle runtime before atomically removing
the registry entry. A failed registry write leaves the entry available. Late
runtime events cannot reinsert a successfully deleted entry in the current UI.
The v11 commands and native history formats are unchanged.

Windows release builds use the GUI subsystem so launching the desktop app does
not create a console. Debug builds retain their console for development.

Verification: lifecycle client response/error tests, registry reload/failure
tests, and native WebView reload → continue the same session → close → cancel
deletion → delete → reload, including keyboard focus and safe-mode rejection.

### Skill context overrides

Codex passes per-thread `skills.config` rules and Prime filters the native
resource loader with `skillsOverride`. `scripts/native-skills-matrix.mjs
--daemon-socket <explicit-piui-test-socket>` checks actual native requests against
an isolated local Responses endpoint: the enabled control skill is listed and
the disabled skill is absent, with existing Codex disabled settings preserved.
These are synthetic provider requests through installed native harnesses, not
paid model turns. Pi RPC and Hermes ACP currently do not expose per-session skill
filtering: their controls are managed by the harness and unsupported rules fail
before execution. Disabling a skill controls automatic context loading; it does
not erase earlier messages or revoke filesystem access to the skill file.

### Model catalog loading

Catalog reads use isolated native probes independently of the active-session
operation gate. Completed probes retire their owned process trees without waiting
for native session shutdown hooks; a shutdown timeout must not discard a catalog
that was already returned. The host-api client shares in-flight reads and keeps
successful results by workspace and harness for the current UI lifetime. Errors
are retryable and are not cached. Refresh models and launch preflight bypass the
completed cache. No TTL or guessed model capabilities are introduced. Cold reads
still follow native inventory discovery, including Hermes provider discovery.
The ignored `installed_four_harness_catalogs` test exercises all four installed
harnesses without inference or changes to native configuration.


## Message outbox and commands

The idle composer has one Send action. While running it defaults to Follow up,
which records a separate next turn. Steer is an explicit choice only when the
native adapter supports it; it never silently becomes a later turn. PiUI owns
admission of user messages, while native harnesses own inference and history.

Pending messages appear above the composer. Editing updates the same request;
promotion sends that request as Steer under the same admission lock as draining.
Delivered and dismissed IDs remain tombstones with their text cleared, preventing
replay after a lost response. Definitive refusal preserves queued text with a
reason. Ambiguous delivery pauses the queue and requires checking native history.
Stop, failure, close and host restart pause pending work. Restart converts an
in-flight request to uncertain; it never retries an unknown outcome automatically.

Queue generations live in `workspace-registry-v11/composer-v19/<session-id>/`,
separate from the unchanged session registry format and all native transcripts.
The additive `workspace_composer_v19` command and `piui://composer-v19` event
carry revisioned snapshots. Safe mode and managed run sessions deny these actions.

Slash suggestions expose typed operations only: `/stop`, and `/compact` where
supported. Unsupported slash input remains a draft and is not a model prompt.
Pi uses RPC compact/steer; Codex uses thread/compact/start and turn/steer; Prime
checks the installed SDK methods. Hermes ACP currently exposes neither compact
nor active steering, but uses the same host Follow up queue.

## Native session start and the operation gate

The global operation gate serializes trust/identity authorization with the
native command it authorizes and with trust revocation. Native initialization
can take 20-50 seconds (Hermes MCP discovery), so an ordinary `createSession`
or `openSession` holds the gate only for its short phases:

1. Under the gate: verify workspace trust, reserve the session's start and, for
   a new chat, record its catalog row.
2. Without the gate: spawn the native runtime and read its first snapshot.
3. Under the gate again: verify trust once more and publish the live runtime.

The reservation is the per-session lifecycle gate. A second open of the same
session waits for it and then returns the same live runtime; commands for a
session that is still starting wait for that start; no session is ever started
twice. Operations on other sessions never wait for a start.

Trust revocation, project removal and app exit withdraw unfinished starts of
the affected workspaces before closing live sessions: a start that is still
initializing drops its spawn, which terminates the partially started process
tree, and a started runtime waiting to be published is retired without the
gate. An explicit close withdraws an unfinished start of that session; delete
reports a conflict while the session is starting. A start whose workspace lost
trust while it initialized is never published. A withdrawn or failed new chat
without a native binding leaves no catalog row. Managed-run launches still run
their whole start under the gate held by the run scheduler.

## Native event delivery

Each native runtime delivers events through a bounded queue of 256 events. A
full queue is backpressure, not a protocol failure: the bridge reader stops
reading the bridge's stdout until the host forwarder drains, so a slow WebView
or a large burst throttles the native process instead of killing it. In the
shared Codex pool one slow session delays the pool's other sessions but never
fails them. An unexpectedly closed queue during active operation still fails
closed.

Code that owns an undrained queue never awaits a response from the same
runtime. Events that arrive while PiUI awaits `initialize`, the pooled
`openSession`, the first snapshot or the operation gate for publication are
retained in arrival order; Hermes `session/load` and resumed Codex pages may
replay long histories there.
Retirement stops command admission and closes the queue before disposal.

A forwarder that fell behind sends the already-queued consecutive text deltas of
one block as a single `textDelta` of at most 64 KiB. It never waits for more
input, so content, order and contiguous revisions are unchanged; the workspace
IPC contract is unchanged.

Native bindings, catalog metadata and lifecycle changes are written to the
session registry immediately, each as one fsynced generation; a repeated
unchanged binding needs no write. Usage receipts are cached in memory at once
(readers and `Session` notifications see them) and written in batches: when the
turn completes and before its outcome is observed, at most two seconds after
the first unsaved receipt while a turn runs, with any other registry write, and
when the runtime closes or stops. A host crash can lose at most that last
window of usage receipts, never a binding.
