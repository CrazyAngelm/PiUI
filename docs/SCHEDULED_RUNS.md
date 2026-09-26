# Scheduled orchestration runs

Status: implemented host, desktop UI and local operator API contract.

PiUI can start a saved launch command once at an absolute time or repeatedly on
a fixed elapsed interval in minutes or hours. A launch command identifies the
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
- Missed `skip` records one skipped outcome and advances to the first future
  nominal occurrence. `coalesce` creates one run for the latest elapsed occurrence.
- Overlap `skip` treats running and uncertain prior runs as active. `allow` creates
  another independent run.
- PiUI evaluates schedules only while its host process is running. OS startup,
  background services, machine wake and calendar/cron expressions are outside
  this contract.

The desktop uses orchestration host v7 schedule commands and scalar invalidation
events while retaining every v6 definition/run command. The opt-in loopback API
keeps protocol v1 and requires protocol v2 for schedule methods.
