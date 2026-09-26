# Scheduled and event orchestration runs

Status: implemented host, desktop UI and local operator API contract. Event
triggers, the pause switch, run-from-chat and background mode are host v7.2
(additive); run trigger identity is orchestration v6.3; background mode is
`contracts/background-v1.ts`.

PiUI can start a saved launch command once at an absolute time, repeatedly on
a fixed elapsed interval in minutes or hours, at a local wall-clock time on
chosen days of the week, when another pipeline finishes, or when project files
change. A person can also start one from a chat. A launch command identifies the
team and pipeline; every occurrence snapshots their latest saved definitions into
an ordinary orchestration run. Native harnesses still own inference, tools,
credentials, approvals, processes and history.

Scheduled and manual runs use the same frozen profile and native launch path. A
Codex profile that must call a public HTTP API explicitly sets
`networkAccess: true` together with `permissionMode: "read-only"` or
`"workspace-write"`; omission remains network-denied. This grants native
outbound access for that profile, not credentials or a domain allowlist, and a
schedule never adds or widens capabilities.

## Safety and persistence

- Creating or saving a schedule does not run anything. New schedules are disabled.
- Enabling is a separate revision-bound action and rechecks project trust.
- Changing timing, target, missed-run policy, overlap policy or input values
  disables the record.
- A schedule stores `inputs`: values for the run inputs its pipeline declares.
  Save and enable resolve them against the launch target's current pipeline
  exactly as a run start does; a missing required value, an undeclared name or
  a value of the wrong kind is refused (`invalid`) and nothing is stored. Each
  occurrence passes the values to its run, which freezes them with the defaults.
  If the pipeline later gains a required input, occurrences fail (`invalid`)
  until the schedule is updated; re-enabling rechecks the values.
- An occurrence claim, deterministic occurrence/run identity, frozen run snapshot
  and next due time commit in one fsynced orchestration generation.
- A committed run that has not crossed the native boundary is resumed with the
  same run ID after restart, whether it was started manually or by a schedule.
  Native work with an unknown outcome (a running or leased task) remains
  uncertain and is never resumed or replayed automatically.
- If the durable journal cannot commit a due claim, the worker logs one paused
  state and waits for an explicit schedule mutation or host restart. It neither
  spins on the failed write nor starts native work without the commit.
- Journal writers are serialized and each commit is still one complete fsynced
  generation, checked against the latest committed revisions. Readers (catalog,
  definitions, runs, schedules, usage) are served the last committed generation
  without waiting for a writer's copy, serialization or fsync, and these read
  commands run on the blocking pool instead of the WebView main thread.
- Safe mode is read-only and never starts the schedule worker.
- Disable or delete before a claim prevents that occurrence. It does not cancel a
  run already created; use the ordinary run cancellation flow for that.

Schedules are authoritative user-authored orchestration data in the existing
atomic application journal. They are deliberately not stored only in
`piui-foundation.sqlite`, because that database is a rebuildable session index and
UI metadata cache under ADR-023.

## Timing semantics

- `once` stores an absolute UTC instant plus its IANA display time zone.
- The editor formats and parses wall time in that recorded IANA zone, including
  when it differs from the computer zone, and rejects skipped or repeated DST time.
- `interval` stores a positive integer, `minutes` or `hours`, an absolute anchor,
  and a display time zone. Occurrences stay anchored and do not drift with task
  completion time.
- `calendar` (additive in host v7.1) stores a local `time` (`HH:MM`), ISO
  weekdays `days` (1 = Monday ... 7 = Sunday, distinct, at least one), an IANA
  `timeZone` and `startsAt`. Occurrences follow the zone's wall clock across
  daylight-saving changes: a skipped local time fires at the first valid minute
  after the gap, and a repeated local time fires once, at its first occurrence.
  No occurrence precedes `startsAt`. The desktop sets `startsAt` to the save
  time whenever the time, days or zone change, so an edit never claims an
  occurrence that already passed; an unchanged rule keeps its start. The host
  (`CalendarRule`, chrono-tz) is authoritative; `host-api/scheduleCalendar.ts`
  mirrors it with the same fixtures for previews and the UI Lab.
- Missed `skip` records one skipped outcome and advances to the first future
  nominal occurrence. `coalesce` creates one run for the latest elapsed occurrence.
- Overlap `skip` treats running and uncertain prior runs as active. `allow` creates
  another independent run.
- PiUI evaluates schedules only while its host process is running (window open
  or, with background mode on, in the tray). Background services, machine wake
  and cron expressions are outside this contract.
- While all automations are paused, due occurrences wait. Resuming treats the
  occurrences that came due during the pause like ones missed while PiUI was
  closed: `skip` records them as `skippedMissed`, `coalesce` runs once.

The desktop uses orchestration host v7 schedule commands and scalar invalidation
events while retaining every v6 definition/run command. The opt-in loopback API
keeps protocol v1 and requires protocol v2 for schedule methods; the same
schedule methods accept event triggers, with the same checks.

## Event triggers (host v7.2)

An automation's trigger may be `{ "type": "event", "event": ... }`:

- `{ "kind": "run-finished", "launchCommandId", "outcomes" }` fires when a run of
  that launch command ends with one of `outcomes` (`succeeded`, `failed`,
  `cancelled`; at least one, no repeats). The watched launch command must be
  saved in the same project and cannot be deleted while a rule waits for it.
  A run counts as "of" a launch command when it was started through it (the
  editor's Run, a schedule, a chat or another automation).
- `{ "kind": "files-changed", "include", "exclude"?, "debounceSeconds" }` fires
  when files matching `include` and not `exclude` change in the project folder
  and then stay quiet for `debounceSeconds` (2-3600). Patterns are relative to
  the project folder with `/` separators: `*` and `?` stay inside one name,
  `**` spans folders, `[a-z]`/`[!a]` and `{ts,svelte}` are allowed. A pattern
  without a slash matches a file or folder name at any depth (`*.md`); one
  with a slash is anchored (`src/**/*.ts`); a matching folder covers everything
  inside it. At most 32 patterns per list, 256 bytes each. Matching folds ASCII
  case on Windows and macOS. `.git`, `node_modules`, `target`, `dist`, `.pi`,
  `.piui` and PiUI's own data folder are never watched. The host
  (`automation_paths.rs`) and the editor (`host-api/triggerPatterns.ts`) share
  `contracts/fixtures/trigger-patterns-v7.json`.

Event rules have no due time (`nextDueAt` stays null) and must use
`missedRunPolicy: "skip"`: nothing is replayed after a restart or a pause.
Saving never runs anything; enabling is the same revision-bound, trust-checked
request as for timed rules. Only trusted, present project folders are watched.

The host observes every committed orchestration generation and fires a
"pipeline finished" rule once per finished run; a firing's occurrence and run
identity derive from the rule, its trigger revision and the source run, so a
repeated observation cannot start a second run. File changes arrive from the
platform watcher (`piui_platform::watch_project`) in coalesced batches; a burst
fires once after the quiet period, or at the latest after ten quiet periods
(bounded to an hour) while the folder keeps changing. A batch that only
reports lost events is ignored, never guessed at. The firing, its outcome and
the new run commit in one fsynced generation (`claim_event_occurrence`).

A run that finishes, or a file that changes, while PiUI is not running is not
observed. A run finishing in the moment PiUI exits may not fire.

## Loop protection

- A files-changed rule ignores changes while a run it started works, and for
  three seconds after it ends (late watcher events).
- Every run records its chain depth: runs started by a person, a clock or a
  chat have depth 0; a "pipeline finished" run has the finished run's depth
  plus one; a "files changed" run has one more than the deepest run that was
  active during the burst or ended up to ten seconds before it (1 when none).
  A firing deeper than 3 is recorded as `skippedChainLimit` and starts nothing.
- One rule starts at most one run every 30 seconds. A "pipeline finished"
  firing inside that window is recorded as `skippedCooldown`; a file burst is
  deferred to the end of the window instead, so changes coalesce into one run.
- Order of checks for a firing: paused (`skippedPaused`), chain limit
  (`skippedChainLimit`), launch command changed (`failed`, the rule is turned
  off), project not trusted or safe mode (`failed` with the admission code),
  cooldown (`skippedCooldown`), overlap policy (`skippedOverlap`), then start.
- Each rule keeps its last 200 occurrence records; an older record whose run
  is still active is never dropped.

## Pause all automations

`orchestration_set_automations_paused_v7` pauses or resumes every automation
of every project; the tray menu flips the same durable switch (a top-level
journal field, absent until first used). While paused no timed occurrence is
claimed, file changes are dropped and watchers stop, and a finished run records
`skippedPaused` for the rules waiting for it. Runs already working continue.
`piui://orchestration-automations-event` (`automationsChanged`) tells the UI.
Safe mode refuses the switch (`runtime-unavailable`).

## Trigger identity

`OrchestrationRunV6.trigger` records what started a run, frozen at creation:
`schedule` (automation id, name and occurrence id), `event` (also the event
kind, the source run for "pipeline finished" and the chain depth) or `chat`
(the chat's session id). Runs a person starts in the editor have none. The
Runs header shows it. The start command accepts only `{ "kind": "chat" }` from
a caller; automation identities are written by the host alone.

## Run a pipeline from a chat

`/run` in the composer and "Run pipeline…" in Ctrl+K list the saved pipelines
of the chat's project, ask for run inputs with the editor's run form, and
start the run through `orchestration_start_run_v6` with a `chat` trigger. A
notice links to the run. Nothing is written into the chat's native history.
Trust and safe mode apply exactly as for any start; a retry keeps its run id
until the start is confirmed.

## Background mode (background-v1)

Settings -> Background offers, all off by default:

- **Keep running in the tray when the window is closed.** A tray icon exists
  only while this is on; closing the main window then hides it. The tray menu
  has Open PiUI, Pause all automations / Resume automations and Quit PiUI.
  Quit takes the ordinary exit path that stops every harness process tree.
- **Start PiUI when I sign in.** On Windows PiUI writes one value named
  `PiUI` in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` itself
  (`autostart.rs`): the executable path in double quotes, then `--autostart`,
  for example `"C:\Users\John Smith\AppData\Local\PiUI\piui-desktop.exe"
  --autostart`. An unquoted path with spaces would let Windows try
  `C:\Users\John.exe` first. Turning it on also marks the entry enabled in
  Task Manager's `StartupApproved\Run` record when that key exists; turning
  it off removes the value. At startup an unquoted value an earlier build
  wrote for the same executable is rewritten quoted; another installation's
  value is left alone. Linux and macOS use `tauri-plugin-autostart`. A start
  at sign-in stays hidden in the tray only when the tray is on. The
  registration is the OS's record; only "keep in tray" is stored (in the
  PiUI preferences of the index database). E2E hosts never register.
- **Pause all automations** (the switch above).

The WebView holds no tray, autostart-plugin or OS permission; it calls
`background_settings_v1`, `background_update_v1` and `background_tray_labels_v1`
(tray copy from the locale catalog). Safe mode shows the settings read-only
and never creates a tray. Windows is the target; the Linux and macOS code paths
compile but are not verified.

One PiUI runs per user session (`tauri-plugin-single-instance`). A second
launch (Start menu, double-click, a shortcut) hands its arguments to the
running PiUI and exits before it opens any window, journal or runtime; the
running PiUI then shows and focuses its window, restoring it from the tray.
A second start at sign-in (`--autostart`) changes nothing. A development
build shares the installed build's identifier and data folder, so it is the
same instance too. E2E hosts in isolated data folders stay outside the guard,
so parallel E2E runs keep working.
